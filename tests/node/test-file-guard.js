/* =============================================================================
 * test-file-guard.js — due editor, un file (#185), dal lato del browser.
 *
 * Lo stesso `configs/<brano>.yml` puo' stare aperto in PGE-ui e nel
 * laboratorio di mare-nostrum. Il bridge rifiuta di scrivere un file che su
 * disco non e' piu' quello che l'editor ha letto (tests/python/
 * test_file_signature.py); qui si verifica cio' che il browser fa di quel
 * rifiuto, in tre strati:
 *
 *   1. la DECISIONE, file per file (`window.PGEFileGuard`, puro): senza
 *      modifiche proprie su quel file si rilegge e si riprova, una volta
 *      sola; con modifiche proprie si chiede. Su N file (il master e, da #184,
 *      gli stream importati) ognuno ha la sua risposta.
 *   2. il GIRO (`PGEFileGuard.attempt`): scrittura → rifiuto → rilettura →
 *      riprova, con le scritture, le riletture e "ci sono modifiche proprie?"
 *      iniettati. E' la stessa funzione che app.jsx chiama per il salvataggio
 *      e per il render.
 *   3. il REGISTRO delle firme in backend.js, guidato con un `fetch` finto su
 *      un disco finto: lettura, rifiuto, sovrascrittura, la firma di cio' che
 *      si e' scritto che prende il posto di quella letta.
 *
 * Il bridge finto qui sotto NON riscrive la regola in tre passi (documento gia'
 * su disco → firma → scrittura): quella e' python e la verifica l'altra suite.
 * Risponde solo cio' che il browser puo' osservare.
 *
 * Run: node test-file-guard.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const SG     = require("./source-guard.js");

let pass = 0, fail = 0;
let bodyDone = false;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* --- localStorage finto ---------------------------------------------------- */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

/* --- il disco e il bridge finti ------------------------------------------- */
const DISK = {};               // configs/: nome → testo
let HEADER_ON = true;          // un bridge piu' vecchio di #185 non manda la firma
let SIG_IN_PUT = true;         // ...ne' la rimanda dopo una scrittura
const PUTS = [];               // le richieste PUT /file viste
const RENDERS = [];            // i corpi di POST /render visti
const sigOf = (t) => "sha256:" + crypto.createHash("sha256").update(Buffer.from(t, "utf8")).digest("hex");

function jsonRes(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}
function ndjsonBody(lines) {
  const enc = new TextEncoder();
  let i = 0;
  return { getReader: () => ({ read: async () => (i >= lines.length
    ? { done: true, value: undefined }
    : { done: false, value: enc.encode(JSON.stringify(lines[i++]) + "\n") }) }) };
}
// La guardia, come il browser la vede: firma mandata e diversa da quella su
// disco, file presente, niente sovrascrittura → 409.
function refused(name, sig, overwrite) {
  return !!sig && name in DISK && sigOf(DISK[name]) !== sig && !overwrite;
}

global.fetch = (url, init = {}) => {
  const u = new URL(String(url));
  const method = (init.method || "GET").toUpperCase();
  if (u.pathname === "/file") {
    const name = u.searchParams.get("name");
    if (method === "GET" || method === "HEAD") {
      if (!(name in DISK)) return jsonRes(404, {});
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (h) => (HEADER_ON && h.toLowerCase() === "x-pge-signature" ? sigOf(DISK[name]) : null) },
        text: () => Promise.resolve(DISK[name]),
      });
    }
    if (method === "PUT") {
      const sig = u.searchParams.get("signature");
      const overwrite = u.searchParams.get("overwrite");
      PUTS.push({ name, sig, overwrite });
      if (refused(name, sig, overwrite === "1"))
        return jsonRes(409, { ok: false, changed: true, name, error: `${name} e' cambiato su disco` });
      DISK[name] = init.body;
      return jsonRes(200, { ok: true, written: true, bytes: init.body.length,
                            ...(SIG_IN_PUT ? { signature: sigOf(init.body) } : {}) });
    }
  }
  if (u.pathname === "/render") {
    const body = JSON.parse(init.body);
    RENDERS.push(body);
    const name = `${body.yamlBasename}.yml`;
    if (refused(name, body.signature, body.overwrite === true))
      return jsonRes(409, { ok: false, changed: true, name, error: `${name} e' cambiato su disco` });
    DISK[name] = body.yamlContent;
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body: ndjsonBody([
      { type: "file-signature", kind: "projects", name, signature: sigOf(body.yamlContent), written: true },
      { type: "done", ok: true, generated: [] },
    ]) });
  }
  if (u.pathname === "/workspace") {
    const body = JSON.parse(init.body);
    if (body.path === "/no") return jsonRes(400, { ok: false, error: "non esiste" });
    return jsonRes(200, { ok: true, workspace: body.path, projects: [] });
  }
  if (u.pathname.startsWith("/stems/")) return jsonRes(200, { basename: "x", stems: [] });
  if (u.pathname === "/semantics-version") return jsonRes(200, { ok: true, version: 3 });
  return Promise.reject(new Error("unexpected fetch " + u));
};

global.window = { jsyaml: require("js-yaml") };
const LIB = path.join(__dirname, "../../src/lib");
const GUARD_PATH = path.join(LIB, "file-guard.js");
eval(fs.readFileSync(path.join(LIB, "yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(LIB, "backend.js"), "utf8"));
eval(fs.readFileSync(GUARD_PATH, "utf8"));
const FG = window.PGEFileGuard;

const APP_SRC     = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
const BACKEND_SRC = SG.codeOf(path.join(LIB, "backend.js"));
const TOAST_SRC   = SG.codeOf(path.join(__dirname, "../../src/components/Terminal.jsx"));

(async () => {

/* ===========================================================================
 * 1. La decisione, file per file.
 * ======================================================================== */
console.log("\n── decide: rilegge, chiede, si ferma ──");
{
  assert("una rilettura sola (il numero del laboratorio)", FG.MAX_REREADS === 1);
  assert("senza modifiche proprie si rilegge",
    FG.decide({ ownChanges: false, rereads: 0 }) === "reread");
  assert("con modifiche proprie si chiede",
    FG.decide({ ownChanges: true, rereads: 0 }) === "ask");
  /* Il verso sicuro di "non lo so" e' la domanda: un chiamante che si
     dimentica di dirlo, letto come "nessuna modifica", perderebbe lavoro senza
     un errore da nessuna parte. */
  assert("modifiche proprie ignote valgono come modifiche: si chiede",
    FG.decide({ rereads: 0 }) === "ask" && FG.decide({ ownChanges: null }) === "ask");
  /* Riletto e rifiutato di nuovo: il file cambia mentre lo si rilegge, cioe'
     qualcuno sta scrivendo adesso. Rincorrerlo non finisce mai. */
  assert("dopo una rilettura un nuovo rifiuto si ferma",
    FG.decide({ ownChanges: false, rereads: 1 }) === "stop");
  assert("...anche con modifiche proprie: la rilettura viene prima",
    FG.decide({ ownChanges: true, rereads: 1 }) === "stop");
}

console.log("\n── plan: N file, una risposta per file ──");
{
  const p1 = FG.plan([{ name: "master.yml", ownChanges: false, rereads: 0 }]);
  assert("il master senza modifiche: si rilegge e si riprova",
    p1.action === "retry" && eq(p1.reread, ["master.yml"]) && !p1.ask.length, JSON.stringify(p1));

  const p2 = FG.plan([{ name: "master.yml", ownChanges: true, rereads: 0 }]);
  assert("il master con modifiche: si chiede",
    p2.action === "ask" && eq(p2.ask, ["master.yml"]) && !p2.reread.length, JSON.stringify(p2));

  /* Il criterio "file per file": un importato pulito si rilegge anche se il
     master ha da chiedere — la sua rilettura non perde niente — e la domanda
     riguarda solo il master. */
  const p3 = FG.plan([
    { name: "master.yml", ownChanges: true,  rereads: 0 },
    { name: "risacca.yml", ownChanges: false, rereads: 0 },
  ]);
  assert("master con modifiche, importato pulito: si rilegge l'importato e si chiede del master",
    p3.action === "ask" && eq(p3.ask, ["master.yml"]) && eq(p3.reread, ["risacca.yml"]),
    JSON.stringify(p3));

  const p4 = FG.plan([
    { name: "master.yml", ownChanges: false, rereads: 0 },
    { name: "risacca.yml", ownChanges: false, rereads: 0 },
    { name: "onda.yml", ownChanges: false, rereads: 0 },
  ]);
  assert("tre file puliti: si rileggono tutti e si riprova",
    p4.action === "retry" && eq(p4.reread, ["master.yml", "risacca.yml", "onda.yml"]), JSON.stringify(p4));

  /* "Si ferma" batte "chiede": un file che cambia mentre lo si rilegge rende
     inutile la risposta — sovrascrivi o ricarica, il giro dopo torna sul suo
     rifiuto. Si dice quale e si lascia riprovare. E non si rilegge niente:
     una rilettura e' una modifica dello stato, e nessuna scrittura la segue. */
  const p5 = FG.plan([
    { name: "master.yml", ownChanges: true,  rereads: 0 },
    { name: "risacca.yml", ownChanges: false, rereads: 1 },
    { name: "onda.yml", ownChanges: false, rereads: 0 },
  ]);
  assert("un file che cambia ancora ferma il giro, senza domande e senza riletture",
    p5.action === "stop" && eq(p5.stop, ["risacca.yml"]) && !p5.reread.length && !p5.ask.length,
    JSON.stringify(p5));

  /* Un rifiuto che non nomina file non dice cosa rileggere ne' di cosa
     chiedere: non c'e' una decisione da prendere al posto di nessuno. */
  const p6 = FG.plan([]);
  assert("un rifiuto senza file si ferma", p6.action === "stop", JSON.stringify(p6));
}

console.log("\n── ownChanges: il documento, non l'intestazione ──");
{
  const head = (t) => `# project: x\n# saved:   ${t}\n# editor:  PGE-ui\n\n`;
  const body = "title: x\nstreams: []\n";
  /* `serialize()` scrive un `# saved: <ISO>` in testa: due serializzazioni
     dello stesso documento non sono mai byte per byte uguali. */
  assert("stesso documento, timestamp diverso: nessuna modifica propria",
    FG.ownChanges(head("2026-10-07T10:00:00Z") + body, head("2026-10-07T11:00:00Z") + body) === false);
  assert("documento diverso: modifiche proprie",
    FG.ownChanges(head("a") + body, head("a") + body.replace("x", "y")) === true);
  assert("un commento DENTRO il documento conta",
    FG.ownChanges(head("a") + body, head("a") + "title: x\n# nota\nstreams: []\n") === true);
  assert("niente da confrontare (mai letto, o letto e non capito): modifiche proprie",
    FG.ownChanges(body, null) === true && FG.ownChanges(body, undefined) === true);
  assert("documentBody toglie solo la testa di commenti",
    FG.documentBody(head("z") + body) === body && FG.documentBody(body) === body);
}

console.log("\n── stato del giro: rilettura e sovrascrittura ──");
{
  const s0 = FG.initialState();
  assert("lo stato iniziale non ha riletture ne' sovrascritture",
    eq(s0.rereads, {}) && eq(s0.overwrite, []) && s0.doc === null);
  const doc = { project: "x", streams: [] };
  const s1 = FG.afterReread(s0, "master.yml", doc);
  assert("una rilettura conta e porta il documento riletto",
    s1.rereads["master.yml"] === 1 && s1.doc === doc && s0.rereads["master.yml"] === undefined);
  const s2 = FG.afterOverwrite(s1, "master.yml");
  /* La sovrascrittura scrive cio' che l'utente ha davanti ADESSO: la domanda
     non ferma la tastiera, e un documento tenuto da prima della domanda
     butterebbe le modifiche fatte nel frattempo. */
  assert("una sovrascrittura si segna e lascia il documento al chiamante",
    eq(s2.overwrite, ["master.yml"]) && s2.doc === null);
  assert("...una volta sola", eq(FG.afterOverwrite(s2, "master.yml").overwrite, ["master.yml"]));
  assert("overwrites(): la sovrascrittura chiesta per quel file, e per nessun altro",
    FG.overwrites(s2, "master.yml") === true && FG.overwrites(s2, "altro.yml") === false);
}

/* ===========================================================================
 * 2. Il giro: scrittura → rifiuto → rilettura → riprova.
 * ======================================================================== */
console.log("\n── attempt: il giro, con le scritture iniettate ──");
{
  // Un disco di un file, e la firma che l'editor ha letto. `writes` registra
  // lo stato con cui ogni tentativo e' partito.
  function harness({ own = false, changes = 1, rereadOk = true } = {}) {
    const h = { disk: 1, read: 1, writes: [], rereads: 0, changesLeft: changes };
    h.hooks = {
      write: async (st) => {
        h.writes.push(st);
        if (h.changesLeft > 0) { h.changesLeft--; h.disk++; }   // l'altro editor salva
        if (h.read !== h.disk && !FG.overwrites(st, "m.yml")) return { ok: false, changed: true, files: ["m.yml"] };
        h.disk++; h.read = h.disk;
        return { ok: true, written: true };
      },
      ownChanges: () => own,
      reread: async (name) => { h.rereads++; if (!rereadOk) return null; h.read = h.disk; return { name, v: h.disk }; },
    };
    return h;
  }

  const a = harness({ own: false });
  const r1 = await FG.attempt(a.hooks, FG.initialState());
  assert("senza modifiche proprie: rilegge, riprova, scrive", r1.outcome === "done" &&
    a.rereads === 1 && a.writes.length === 2, JSON.stringify({ r1, w: a.writes.length }));
  assert("...e il secondo tentativo scrive il documento riletto",
    a.writes[1].doc && a.writes[1].doc.name === "m.yml" && a.writes[1].rereads["m.yml"] === 1);
  assert("...senza sovrascrivere niente", !FG.overwrites(a.writes[1], "m.yml"));

  const b = harness({ own: true });
  const r2 = await FG.attempt(b.hooks, FG.initialState());
  assert("con modifiche proprie: chiede, e non rilegge ne' scrive",
    r2.outcome === "asked" && eq(r2.files, ["m.yml"]) && b.rereads === 0 && b.writes.length === 1,
    JSON.stringify(r2));

  /* La risposta "sovrascrivi" riprende il giro dallo stato che `attempt` ha
     restituito, con la sovrascrittura segnata. */
  b.hooks.ownChanges = () => true;
  const r3 = await FG.attempt(b.hooks, FG.afterOverwrite(r2.state, "m.yml"));
  assert("sovrascrivi: scrive al primo colpo", r3.outcome === "done" && b.writes.length === 2);

  /* "ricarica" e' una rilettura fatta su risposta: lo stesso conto. */
  const c = harness({ own: true });
  const r4 = await FG.attempt(c.hooks, FG.initialState());
  const doc = await c.hooks.reread("m.yml");
  c.hooks.ownChanges = () => false;      // dopo la rilettura le modifiche non ci sono piu'
  const r5 = await FG.attempt(c.hooks, FG.afterReread(r4.state, "m.yml", doc));
  assert("ricarica: rilegge e riprova col documento riletto", r5.outcome === "done" &&
    c.writes[1].doc === doc, JSON.stringify(r5));

  /* Il file cambia ancora fra la rilettura e la scrittura. */
  const d = harness({ own: false, changes: 2 });
  const r6 = await FG.attempt(d.hooks, FG.initialState());
  assert("cambia mentre lo si rilegge: una rilettura sola, poi si ferma e lo dice",
    r6.outcome === "stopped" && eq(r6.files, ["m.yml"]) && d.rereads === 1 && d.writes.length === 2,
    JSON.stringify(r6));

  /* Una rilettura che non riesce (file vuoto o illeggibile) non si riprova:
     riprovare scriverebbe il progetto di ripiego sopra quello dell'altro
     editor. */
  const e = harness({ own: false, rereadOk: false });
  const r7 = await FG.attempt(e.hooks, FG.initialState());
  assert("rilettura fallita: ci si ferma senza riscrivere",
    r7.outcome === "reread-failed" && e.writes.length === 1, JSON.stringify(r7));

  const f = harness({ own: false, changes: 0 });
  const r8 = await FG.attempt(f.hooks, FG.initialState());
  assert("niente di cambiato: un tentativo, nessuna rilettura",
    r8.outcome === "done" && f.writes.length === 1 && f.rereads === 0);

  const g = { hooks: { write: async () => ({ ok: false, error: "boom" }),
                       ownChanges: () => false, reread: async () => ({}) } };
  const r9 = await FG.attempt(g.hooks, FG.initialState());
  assert("un fallimento che non e' un rifiuto passa com'e'",
    r9.outcome === "failed" && r9.result.error === "boom");
}

/* ===========================================================================
 * 3. Il registro delle firme in backend.js.
 * ======================================================================== */
console.log("\n── backend: la firma letta, mandata, rimpiazzata ──");
{
  const be = window.PGEBackend.create({ baseUrl: "http://bridge" });
  DISK["a.yml"] = "title: a\n";

  assert("prima di leggere non c'e' firma", be.fs.signature("projects", "a.yml") === null);
  const text = await be.fs.readFile("projects", "a.yml");
  assert("readFile restituisce il testo come prima", text === "title: a\n");
  assert("...e ricorda la firma dell'header",
    be.fs.signature("projects", "a.yml") === sigOf("title: a\n"));

  // Si salva sopra un file che nessuno ha toccato.
  const w1 = await be.fs.writeFile("projects", "a.yml", "title: b\n");
  assert("la scrittura manda la firma letta", PUTS.at(-1).sig === sigOf("title: a\n"), JSON.stringify(PUTS.at(-1)));
  assert("...senza chiedere di sovrascrivere", PUTS.at(-1).overwrite === null);
  assert("...scrive", w1.ok === true && DISK["a.yml"] === "title: b\n", JSON.stringify(w1));
  assert("...e la firma di cio' che ha scritto prende il posto di quella letta",
    be.fs.signature("projects", "a.yml") === sigOf("title: b\n"));

  // Il laboratorio salva.
  DISK["a.yml"] = "title: dal laboratorio\n";
  const w2 = await be.fs.writeFile("projects", "a.yml", "title: c\n");
  assert("un file cambiato sotto: rifiuto, che e' una risposta e non un'eccezione",
    w2.ok === false && w2.changed === true && eq(w2.files, ["a.yml"]), JSON.stringify(w2));
  assert("...il file dell'altro editor resta", DISK["a.yml"] === "title: dal laboratorio\n");
  /* La firma che il rifiuto avrebbe potuto portare e' quella del documento
     dell'altro editor: adottarla sarebbe averlo letto senza averlo caricato. */
  assert("...e la firma letta NON cambia", be.fs.signature("projects", "a.yml") === sigOf("title: b\n"));

  const w3 = await be.fs.writeFile("projects", "a.yml", "title: c\n", { overwrite: true });
  assert("sovrascrivi: la richiesta lo dice", PUTS.at(-1).overwrite === "1");
  assert("...e scrive", w3.ok === true && DISK["a.yml"] === "title: c\n");

  // Ricarica: una lettura, e la scrittura dopo passa.
  DISK["a.yml"] = "title: ancora il laboratorio\n";
  await be.fs.readFile("projects", "a.yml");
  const w4 = await be.fs.writeFile("projects", "a.yml", "title: d\n");
  assert("dopo una rilettura la scrittura passa", w4.ok === true && DISK["a.yml"] === "title: d\n");

  /* Un bridge piu' vecchio di #185 non firma: senza firma la guardia tace, che
     e' il comportamento di prima — e una firma vecchia non resta a far
     rifiutare scritture che quel bridge non sa nemmeno rifiutare. */
  HEADER_ON = false;
  await be.fs.readFile("projects", "a.yml");
  assert("lettura senza header: la firma si butta", be.fs.signature("projects", "a.yml") === null);
  HEADER_ON = true;
  await be.fs.readFile("projects", "a.yml");
  SIG_IN_PUT = false;
  await be.fs.writeFile("projects", "a.yml", "title: e\n");
  assert("scrittura senza firma di ritorno: quella letta si butta, non resta indietro",
    be.fs.signature("projects", "a.yml") === null);
  SIG_IN_PUT = true;

  /* Un file che non c'e' piu': nessuna firma da tenere. */
  await be.fs.readFile("projects", "a.yml");
  delete DISK["a.yml"];
  let threw = false;
  try { await be.fs.readFile("projects", "a.yml"); } catch { threw = true; }
  assert("lettura di un file sparito: lancia come prima, e la firma si butta",
    threw && be.fs.signature("projects", "a.yml") === null);

  /* Il registro e' per (kind, nome): un file non presta la sua firma a un
     altro. */
  DISK["a.yml"] = "x: 1\n"; DISK["b.yml"] = "y: 2\n";
  await be.fs.readFile("projects", "a.yml");
  assert("la firma e' del file letto e di nessun altro",
    be.fs.signature("projects", "b.yml") === null && be.fs.signature("media", "a.yml") === null);
}

console.log("\n── backend: il render porta la firma, e la riceve ──");
{
  const be = window.PGEBackend.create({ baseUrl: "http://bridge" });
  DISK["p.yml"] = "title: p\n";
  await be.fs.readFile("projects", "p.yml");
  const opts = { yamlBasename: "p", yamlContent: "title: p2\n", streams: [], outputFormat: "wav",
                 renderer: "numpy", semanticsVersion: 3 };

  const events = [];
  const r1 = await be.render.run(opts, (e) => events.push(e));
  assert("il POST porta la firma letta del config", RENDERS.at(-1).signature === sigOf("title: p\n"),
    JSON.stringify(RENDERS.at(-1).signature));
  assert("...e nessuna sovrascrittura", RENDERS.at(-1).overwrite === undefined);
  assert("il render va", r1.ok === true && DISK["p.yml"] === "title: p2\n");
  assert("l'evento file-signature rimpiazza la firma letta",
    be.fs.signature("projects", "p.yml") === sigOf("title: p2\n"));

  DISK["p.yml"] = "title: dal laboratorio\n";
  const ev2 = [];
  const r2 = await be.render.run({ ...opts, yamlContent: "title: p3\n" }, (e) => ev2.push(e));
  assert("un config cambiato sotto: il render e' rifiutato, come risposta",
    r2.ok === false && r2.changed === true && eq(r2.files, ["p.yml"]), JSON.stringify(r2));
  assert("...il config non e' stato scritto (configWritten: false)",
    r2.configWritten === false && DISK["p.yml"] === "title: dal laboratorio\n");
  /* `done` e' l'evento di un render FINITO: un rifiuto non e' un render
     fallito, il motore non e' nemmeno partito. */
  assert("...nessun evento `done`", !ev2.some(e => e.type === "done"), JSON.stringify(ev2));
  assert("...una riga di log che lo dice", ev2.some(e => e.type === "log" && /p\.yml/.test(e.line)));

  const r3 = await be.render.run({ ...opts, yamlContent: "title: p3\n", overwrite: true }, () => {});
  assert("sovrascrivi: il POST lo dice come booleano", RENDERS.at(-1).overwrite === true);
  assert("...e il render va", r3.ok === true && DISK["p.yml"] === "title: p3\n");

  /* Il rifiuto non lascia il backend "occupato": la guardia di rientro di
     run() si riabbassa anche su quel ramo. */
  DISK["p.yml"] = "title: ancora\n";
  await be.render.run({ ...opts, yamlContent: "title: p4\n" }, () => {});
  const r5 = await be.render.run({ ...opts, yamlContent: "title: p4\n", overwrite: true }, () => {});
  assert("dopo un rifiuto si puo' rendere di nuovo", r5.ok === true);
}

console.log("\n── backend: il cambio di workspace butta le firme ──");
{
  const be = window.PGEBackend.create({ baseUrl: "http://bridge" });
  DISK["w.yml"] = "w: 1\n";
  await be.fs.readFile("projects", "w.yml");
  await be.setWorkspace("/no");
  assert("un cambio rifiutato non tocca niente", be.fs.signature("projects", "w.yml") === sigOf("w: 1\n"));
  /* Due cartelle possono avere un progetto omonimo, e nel caso peggiore la
     firma ereditata COMBACIA: una scrittura passerebbe senza che la guardia
     abbia guardato il file giusto. */
  await be.setWorkspace("/altrove");
  assert("un cambio riuscito le butta", be.fs.signature("projects", "w.yml") === null);
}

/* ===========================================================================
 * 4. Le catene dentro app.jsx, che in node non girano. Lo scenario intero —
 *    il file cambiato mentre l'editor e' aperto, con e senza modifiche
 *    proprie — gira nel browser vero: tests/e2e/test-boot.js.
 * ======================================================================== */
console.log("\n── app.jsx: le catene ──");
{
  assert("file-guard.js e' caricato dalla pagina",
    fs.readFileSync(path.join(__dirname, "../../PGE Editor.html"), "utf8")
      .includes('<script src="src/lib/file-guard.js"></script>'));
  assert("il salvataggio e il render passano dallo stesso giro",
    (APP_SRC.match(/FG\.attempt\(/g) || []).length === 2,
    "attese due chiamate a FG.attempt (save, render)");
  /* Ricarica e' un "apri" dello stesso file: la storia azzerata e' il
     criterio dell'issue — un undo riporterebbe una versione che su disco non
     c'e' piu', e la scrittura dopo la riscriverebbe sopra l'altro editor. */
  const sel = APP_SRC.slice(APP_SRC.indexOf("async function onProjectSelect("),
                            APP_SRC.indexOf("async function onWorkspaceChange("));
  assert("onProjectSelect azzera la storia e torna il documento letto",
    /resetHistory\(\);[\s\S]*?return parsed;/.test(sel), sel.slice(0, 200));
  assert("...e ricorda il documento sincronizzato col file",
    /markSynced\(name,/.test(sel));
  assert("la rilettura passa da onProjectSelect, non da una seconda copia del caricamento",
    /async function rereadProject\([\s\S]{0,300}onProjectSelect\(/.test(APP_SRC));
  /* `onRender` e `onSave` vanno a `onClick`, che consegnerebbe un MouseEvent
     come primo argomento: lo stato del giro non deve poterlo diventare. */
  assert("onRender e onSave non prendono argomenti",
    /async function onRender\(\)/.test(APP_SRC) && /async function onSave\(\)/.test(APP_SRC));
  /* Save As e New project scrivono un nome appena digitato, non il file
     aperto: dietro al documento non c'e' una lettura di QUEL file. */
  assert("Save As e New project sovrascrivono per costruzione",
    (APP_SRC.match(/writeFile\([^;]*\{\s*overwrite:\s*true\s*\}\)/g) || []).length === 2);
  assert("le risposte alla domanda passano dal ref, cioe' dalle funzioni di adesso",
    /latestRef\.current\.answerFileQuestion\(/.test(APP_SRC));
  assert("ogni scrittura nuova chiude la domanda in attesa",
    (APP_SRC.match(/closeFileQuestion\(\);/g) || []).length >= 3);
  assert("il cambio di workspace dimentica i documenti sincronizzati",
    /onWorkspaceChange[\s\S]*syncedDocRef\.current = \{\}/.test(APP_SRC));
  assert("backend: le firme si buttano al cambio di workspace",
    /async function setWorkspace[\s\S]*signatures\.clear\(\)/.test(BACKEND_SRC));
}

console.log("\n── Toast: tre risposte, non due ──");
{
  /* Non un `confirm`, che ne ha due: ricarica, sovrascrivi, e non scrivere
     niente. Con `action` al singolare il toast intero e' il bottone — un clic
     qualsiasi diventerebbe una delle due che scrivono. */
  assert("Toast conosce `actions` al plurale", /t\.actions/.test(TOAST_SRC));
  assert("...e con `actions` la superficie non e' cliccabile",
    /if \(t\.action && !t\.actions\)/.test(TOAST_SRC));
  assert("...e c'e' la terza risposta, chiudere", /tt-x/.test(TOAST_SRC));
}

  bodyDone = true;
})().catch(e => {
  fail++;
  console.error("FAIL  il corpo della suite e' morto a meta'\n      " +
    (e && e.stack ? e.stack : String(e)));
});

process.on("exit", (code) => {
  if (!bodyDone) {
    fail++;
    console.error("FAIL  il corpo della suite non e' arrivato in fondo: " +
      "i suoi assert non hanno contato");
  }
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
