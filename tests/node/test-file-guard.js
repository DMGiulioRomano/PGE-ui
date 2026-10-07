/* =============================================================================
 * test-file-guard.js — due editor, un file: rilegge o chiede (#185).
 *
 * `window.PGEFileGuard` e' la meta' browser della guardia: dato il rifiuto del
 * bridge («questo file su disco non e' quello che hai letto»), decide cosa fare,
 * **file per file**. Qui si verifica quella decisione, piu' le catene che non
 * girano in node — chi manda la firma, chi la registra, e che la rilettura
 * passi dalla funzione che azzera la storia dell'undo.
 *
 * La meta' bridge sta in tests/python/test_file_signature.py.
 *
 * Run: node test-file-guard.js (from tests/node/)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

global.window = {};
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/file-guard.js"), "utf8"));
const G = window.PGEFileGuard;

const repo = path.join(__dirname, "../..");
const appSrc     = SG.codeOf(path.join(repo, "src/components/app.jsx"));
const backendSrc = SG.codeOf(path.join(repo, "src/lib/backend.js"));
const termSrc    = SG.codeOf(path.join(repo, "src/components/Terminal.jsx"));
const serverSrc  = SG.codeOf(path.join(repo, "server.py"));

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ============================================================
 * 1 — decide(): un file
 * ============================================================ */

console.log("\n── decide: un file ──");

assert("un file non cambiato si scrive e basta",
  G.decide({ changed: false, dirty: true }) === "write");

assert("cambiato senza lavoro proprio si rilegge",
  G.decide({ changed: true, dirty: false }) === "reread");

assert("cambiato con lavoro proprio si chiede",
  G.decide({ changed: true, dirty: true }) === "ask",
  "la scelta e' di chi perde il lavoro, non di chi scrive");

assert("riletto una volta e cambiato ancora: lo si dice",
  G.decide({ changed: true, dirty: false, attempts: 1 }) === "stop",
  "chi sta scrivendo dall'altra parte sta scrivendo adesso: un ciclo di " +
  "riletture non arriverebbe mai in fondo");

assert("la soglia e' MAX_REREAD, non un numero scritto a mano",
  G.MAX_REREAD === 1 &&
  G.decide({ changed: true, dirty: false, attempts: G.MAX_REREAD - 1 }) === "reread" &&
  G.decide({ changed: true, dirty: false, attempts: G.MAX_REREAD }) === "stop");

/* Il default di `dirty` e' il verso sicuro, e il verso sicuro e' la domanda:
   una domanda di troppo si chiude con un click, una rilettura di troppo porta
   via il lavoro senza un errore da nessuna parte. */
assert("`dirty` assente vale true: si chiede",
  G.decide({ changed: true }) === "ask");
assert("...e `dirty: false` esplicito e' l'unica cosa che fa rileggere",
  G.decide({ changed: true, dirty: 0 }) === "reread" &&
  G.decide({ changed: true, dirty: null }) === "reread" &&
  G.decide({ changed: true, dirty: "" }) === "reread");

assert("decide() e' totale: niente non e' un file cambiato",
  G.decide() === "write" && G.decide(null) === "write" && G.decide({}) === "write");

assert("un `attempts` che non e' un numero vale zero",
  G.decide({ changed: true, dirty: false, attempts: "x" }) === "reread" &&
  G.decide({ changed: true, dirty: false, attempts: undefined }) === "reread");

/* ============================================================
 * 2 — plan(): N file, uno per uno
 *
 * Oggi il chiamante passa un file solo (il master), ma il criterio dell'issue
 * e' per-file e con gli stream importati (#184) saranno N: la logica e' scritta
 * per loro dal primo giorno, perche' una scritta "sul file" andrebbe riscritta
 * invece di essere richiamata.
 * ============================================================ */

console.log("\n── plan: file per file ──");

assert("nessun file rifiutato: si scrive",
  eq(G.plan([{ name: "a.yml", changed: false }]),
     { action: "write", byName: { "a.yml": "write" }, reread: [], ask: [], stop: [] }));

assert("un file solo, senza lavoro proprio: si rilegge",
  G.plan([{ name: "a.yml", changed: true, dirty: false }]).action === "reread");

assert("un file solo, con lavoro proprio: si chiede",
  G.plan([{ name: "a.yml", changed: true, dirty: true }]).action === "ask");

{
  /* La decisione e' di ogni file, non dell'operazione: due file rifiutati
     possono volere due cose diverse, ed e' esattamente il caso che una logica
     "sul file" non saprebbe rappresentare. */
  const p = G.plan([
    { name: "master.yml",  changed: true, dirty: false },
    { name: "risacca.yml", changed: true, dirty: true  },
    { name: "onda.yml",    changed: false },
  ]);
  assert("due file rifiutati, due decisioni diverse",
    eq(p.byName, { "master.yml": "reread", "risacca.yml": "ask", "onda.yml": "write" }));
  assert("...e le liste dicono QUALI, non quanti",
    eq(p.reread, ["master.yml"]) && eq(p.ask, ["risacca.yml"]) && eq(p.stop, []),
    "con N file «e' cambiato un file» non dice quale");
  assert("...e l'operazione aspetta la risposta", p.action === "ask");
}

assert("`ask` batte `stop`: una domanda ha una via d'uscita, arrendersi no",
  G.plan([
    { name: "a.yml", changed: true, dirty: false, attempts: 1 },
    { name: "b.yml", changed: true, dirty: true },
  ]).action === "ask",
  "dire «mi arrendo» mentre una domanda e' in piedi toglie il `sovrascrivi` " +
  "a chi lo stava per usare");

assert("`stop` batte `reread`: rileggere ripasserebbe dal file esaurito",
  G.plan([
    { name: "a.yml", changed: true, dirty: false },
    { name: "b.yml", changed: true, dirty: false, attempts: 1 },
  ]).action === "stop",
  "lo stesso rifiuto, un giro piu' tardi");

assert("...e i file da rileggere restano elencati anche quando si chiede",
  eq(G.plan([
    { name: "a.yml", changed: true, dirty: false },
    { name: "b.yml", changed: true, dirty: true },
  ]).reread, ["a.yml"]),
  "si rileggono comunque, e la domanda resta sugli altri");

assert("plan() e' totale: niente, non-liste, righe senza nome",
  G.plan().action === "write" && G.plan(null).action === "write" &&
  G.plan([null, {}, { changed: true }]).action === "write",
  "una riga senza nome non e' un file: non c'e' niente da rileggere ne' da " +
  "nominare in una domanda");

assert("l'ordine dei nomi e' quello dato",
  eq(G.plan([
    { name: "z.yml", changed: true, dirty: true },
    { name: "a.yml", changed: true, dirty: true },
  ]).ask, ["z.yml", "a.yml"]));

/* ============================================================
 * 3 — Le catene che in node non girano
 * ============================================================ */

console.log("\n── la firma: chi la manda, chi la registra ──");

/* Il registro ha UN proprietario, backend.js: e' l'unico posto che legge e
   scrive file, quindi «la firma di cio' che si e' appena scritto prende il
   posto di quella letta» e' un'invariante del modulo invece di un patto fra
   app.jsx e il bridge tenuto dalla prosa. */
assert("readFile registra la firma dell'header",
  /_rememberSignature\(kind, name, r\.headers\.get\("X-PGE-Signature"\)\)/.test(backendSrc));
assert("writeFile manda quella registrata",
  /signature=\$\{encodeURIComponent\(fileSignature\(kind, name\)\)\}/.test(backendSrc));
assert("...e la sostituisce solo quando il bridge ha risposto ok",
  /if \(res\.ok\) _rememberSignature\(kind, name, res\.signature\)/.test(backendSrc),
  "su un rifiuto la firma che torna e' quella del file dell'altro editor: " +
  "adottarla farebbe passare la guardia alla scrittura dopo");
assert("run() manda la firma registrata del config, non una passata da fuori",
  /signature: fileSignature\("projects", cfgName\)/.test(backendSrc),
  "tenerla in due posti vorrebbe dire poterle far dire due cose");
assert("run() consuma l'evento file-signatures",
  /ev\.type === "file-signatures"/.test(backendSrc) &&
  /_rememberSignature\("projects", nm, sig\)/.test(backendSrc));
assert("un 409 torna invece di lanciare, su tutte e due le strade",
  /if \(r\.status === 409\) return await r\.json\(\)/.test(backendSrc) &&
  /if \(res\.status === 409\) \{/.test(backendSrc),
  "lanciare lo farebbe arrivare come un `Save failed`, cioe' la domanda mai " +
  "posta");
assert("...e il 409 del render dichiara di non aver scritto il config",
  /changed: true,\s*\n\s*error: msg, configWritten: false/.test(backendSrc),
  "`configWritten` spegne l'avviso di migrazione di `dephase`: senza, un " +
  "render rifiutato lo spegnerebbe su un file che nessuno ha riscritto");

/* Una firma e' un'affermazione su un file CHE SI E' LETTO. Il cambio di
   workspace la rende una coincidenza: due cartelle possono avere un progetto
   omonimo, e nel caso peggiore la firma combacia — una scrittura che passa la
   guardia senza che la guardia abbia guardato niente. Stessa regola
   dell'indice degli stem, due righe sopra. */
assert("il cambio di workspace butta le firme, come l'indice degli stem",
  /forgetFileSignature\(\);\s*\n\s*stemIndex = \{\};/.test(backendSrc));
assert("...e il registro non e' persistito",
  !/pge-local-sig|localStorage[^;]*fileSignatures|fileSignatures[^;]*localStorage/.test(backendSrc),
  "dopo un reload quella lettura non c'e' piu' stata: l'editor rilegge il " +
  "progetto e rifirma");

console.log("\n── la rilettura non lascia l'undo indietro ──");

/* «Ricarica» non deve lasciare l'undo in uno stato che riscriverebbe la
   versione vecchia. La rilettura del master E' `onProjectSelect`, che e' un
   `apri` dello stesso file: `_setDataRaw` + `resetHistory` + `setDirty(false)`.
   Non e' un effetto collaterale, e' il criterio. */
{
  const rr = appSrc.slice(appSrc.indexOf("async function rereadFiles"),
                          appSrc.indexOf("async function writeWithGuard"));
  assert("rereadFiles rilegge passando da onProjectSelect",
    /await onProjectSelect\(activeProject\)/.test(rr), rr);
  const ops = appSrc.slice(appSrc.indexOf("async function onProjectSelect"));
  assert("...e onProjectSelect azzera la storia dell'undo",
    /resetHistory\(\);/.test(ops.slice(0, ops.indexOf("async function"))) ||
    /resetHistory\(\)/.test(ops.slice(0, 4000)),
    "senza, un undo riporterebbe indietro una versione che su disco non c'e' " +
    "piu', e il salvataggio dopo la riscriverebbe sopra quella dell'altro editor");
  assert("...e torna il documento letto, che chi riprova deve ri-serializzare",
    /return parsed;/.test(appSrc),
    "lo stato React non e' sincrono: riprovare col documento di prima " +
    "rimanderebbe al bridge cio' che ha appena rifiutato");
  assert("un file che non si rilegge ferma la scrittura invece di riprovare",
    /if \(!fresh\)/.test(appSrc),
    "riprovare scriverebbe il progetto di ripiego sopra quello dell'altro editor");
}

console.log("\n── la domanda ha tre risposte ──");

/* Non e' un `confirm`, che ne ha due: `ricarica`, `sovrascrivi`, e non
   scrivere niente — che non deve costare un click ne' stare sotto la stessa
   superficie di una che perde lavoro. */
assert("la domanda e' un toast con due azioni piu' la ×",
  /actions: \[\s*\n\s*\{ label: "ricarica"/.test(appSrc) &&
  /\{ label: "sovrascrivi", kind: "danger"/.test(appSrc));
assert("...e resta in piedi finche' non ha risposta",
  /kind: "warn", persistent: true,/.test(
    appSrc.slice(appSrc.indexOf("function askChangedOnDisk"),
                 appSrc.indexOf("async function rereadFiles"))),
  "il render non riparte finche' la domanda non ha avuto risposta");
assert("con `actions` la superficie del toast non e' cliccabile",
  /onClick=\{many \? undefined :/.test(termSrc),
  "`action` al singolare fa del toast intero un bottone: qui un click " +
  "qualsiasi diventerebbe `ricarica` o `sovrascrivi`");
assert("...e la × e' la terza risposta, non una quarta azione in fila",
  /className="tt-close"/.test(termSrc) && /t\.onCancel/.test(termSrc));

console.log("\n── il render ──");

assert("il render rifiutato non si annuncia come fallito",
  appSrc.indexOf("if (result.changed) {") > 0 &&
  appSrc.indexOf("if (result.changed) {") < appSrc.indexOf('title: "Render failed"'),
  "il motore non e' nemmeno partito: «Render failed» manderebbe a cercare " +
  "nel log un errore che non c'e'");
assert("le risposte rientrano dalla funzione che ha la guardia di rientro",
  /renderAgain\(\{ reread: plan\.ask \}\)/.test(appSrc) &&
  /renderAgain\(\{ overwrite: true \}\)/.test(appSrc),
  "la domanda non ferma la tastiera: un `r` premuto nel frattempo non deve " +
  "diventare un secondo render");
assert("...e il render riparte col documento appena letto",
  /return await runRender\(\{ doc: fresh, attempts: \(opts0\.attempts \|\| 0\) \+ 1 \}\)/.test(appSrc),
  "«il render prosegue sulla versione su disco»");

/* Il toast vive piu' a lungo del render che l'ha creato: e' persistente e la
   tastiera resta libera. Una risposta che chiude sulle variabili del momento
   della domanda lavora su un editor che non c'e' piu'. */
console.log("\n── le risposte valgono per l'editor di adesso ──");
assert("lo stato di adesso e' riassegnato a ogni render, non in un effetto",
  /guardLatestRef\.current = \{ data, renderAgain \};/.test(appSrc));
assert("le due risposte del render passano dal renderAgain di adesso",
  /guardLatestRef\.current\.renderAgain\(\{ reread: plan\.ask \}\)/.test(appSrc) &&
  /guardLatestRef\.current\.renderAgain\(\{ overwrite: true \}\)/.test(appSrc),
  "quello della chiusura rendeva il documento, il backend e le opzioni di " +
  "quando la domanda era stata posta");
assert("...e il `sovrascrivi` del render non si porta dietro il documento di allora",
  !/renderAgain\(\{ overwrite: true, doc/.test(appSrc));
{
  const save = appSrc.slice(appSrc.indexOf("async function onSave("),
                            appSrc.indexOf("async function _saveWritten("));
  assert("il Salva scrive lo stato di adesso, non la `data` di quando e' stato premuto",
    /const d = doc \|\| guardLatestRef\.current\.data;/.test(save) &&
    !/const d = doc \|\| data;/.test(save),
    "il `sovrascrivi` scriveva le modifiche di prima e poi `setDirty(false)`: " +
    "«salvato» su lavoro mai scritto, e la guardia dopo l'avrebbe riletto via");
}

console.log("\n── una domanda alla volta ──");
{
  const ask = appSrc.slice(appSrc.indexOf("function askChangedOnDisk"),
                           appSrc.indexOf("async function rereadFiles"));
  assert("una domanda nuova toglie quella in attesa",
    /^\s*dropChangedQuestion\(\);/m.test(ask) &&
    ask.indexOf("dropChangedQuestion()") < ask.indexOf("pushToast("),
    "due Salva impilavano due `sovrascrivi`, e quello rimasto indietro " +
    "scriveva ancora");
  assert("...e si ricorda quale toast e' la domanda",
    /changedQuestionRef\.current = id;/.test(ask) && /return id;/.test(appSrc));
  assert("...e ogni risposta, × compresa, la chiude",
    /onClick: answered\(onReload\)/.test(ask) &&
    /onClick: answered\(onOverwrite\)/.test(ask) &&
    /onCancel: answered\(null\)/.test(ask));
  const ops = appSrc.slice(appSrc.indexOf("async function onProjectSelect"));
  assert("un `apri` rende superata la domanda, prima di ogni altra cosa",
    /^\s*dropChangedQuestion\(\);/m.test(ops.slice(0, ops.indexOf("setActiveProject(name)"))),
    "il suo `sovrascrivi` scriverebbe sopra il file appena aperto");
  const ws = appSrc.slice(appSrc.indexOf("async function onWorkspaceChange"));
  assert("...e cosi' il cambio di workspace, anche senza progetti da aprire",
    ws.indexOf("dropChangedQuestion();") > 0 &&
    ws.indexOf("dropChangedQuestion();") < ws.indexOf("if (!files.length)"));
}

console.log("\n── «modifiche proprie» e' rispetto al file, non al Salva ──");
/* `/render` SCRIVE il config e non spegne `dirty`: letto da solo, dopo il
   primo render ogni modifica del laboratorio diventava una domanda su un file
   che conteneva gia' il documento a schermo, e la rilettura — lo scenario
   dell'issue — non arrivava mai. */
assert("dirtyOfFile confronta il documento che si scrive con quello del file",
  /function dirtyOfFile\(_name, doc = data\) \{ return dirty && doc !== fileDocRef\.current; \}/.test(appSrc));
assert("...che e' quello letto, quello salvato, e quello che un render ha scritto",
  /fileDocRef\.current = parsed;/.test(appSrc) &&
  /if \(r && r\.ok\) fileDocRef\.current = d;/.test(appSrc) &&
  /e\.type === "file-signatures"[^\n]*\n\s*fileDocRef\.current = doc;/.test(appSrc));
assert("...e il render chiede del documento che ha reso, non della `data` della chiusura",
  /dirty: dirtyOfFile\(name, doc\),/.test(appSrc),
  "dopo una rilettura la chiusura ha ancora la `data` e il `dirty` di prima");

console.log("\n── le impronte sono del documento reso ──");
assert("lo stream-done registra le impronte di `doc`, non quelle della `data`",
  /setLastRenderedFps\(fps => \(\{ \.\.\.fps, \[e\.streamId\]: fpsOfThisRun\[e\.streamId\] \}\)\)/.test(appSrc) &&
  !/\[e\.streamId\]: currentFps\[e\.streamId\]/.test(appSrc),
  "dopo una rilettura `currentFps` descrive la versione di prima: giallo su " +
  "uno stem appena rifatto, verde su uno reso dall'altra versione");
assert("...e le calcola come backend.js, dagli stream di `doc` nel formato del giro",
  /const fpsOfThisRun = doc === data \? currentFps\s*\n\s*: window\.PGERenderStatus\.fingerprintAll\(doc\.streams, tweaks\.outputFormat \|\| "wav"\);/.test(appSrc));
assert("il nuovo tentativo dopo una rilettura non cancella la riga che la racconta",
  /if \(!opts0\.attempts\) setLogLines\(\[\]\);/.test(appSrc));

console.log("\n── le due route che scrivono, e una guardia sola ──");

/* La regola in tre passi sta in `file_signature.guard`, e tutte e due le route
   che scrivono ci passano. In questo repo una regola scritta due volte e' gia'
   divergita: il basename di `/render` reimplementava `safe_resolve` piu'
   debole. La meta' python di questa guardia sta in test_file_signature.py; qui
   si verifica la forma della risposta, che e' il patto col browser. */
assert("il bridge rifiuta con 409 e col campo `changed`",
  /return jsonify\(\{\*\*res, "path": str\(path\)\}\), 409/.test(serverSrc) &&
  /return jsonify\(\{\*\*res, "name": yml\.name\}\), 409/.test(serverSrc));
assert("la firma di GET /file viaggia in un header esposto da CORS",
  /"X-PGE-Signature": sig/.test(serverSrc) &&
  /expose_headers=\["X-PGE-Signature"\]/.test(serverSrc),
  "su `file://` l'editor e' cross-origin: senza expose_headers leggeva null " +
  "e la guardia restava disarmata proprio li'");
assert("il bridge emette le firme come primo evento dello stream",
  /"type": "file-signatures"/.test(serverSrc));

/* La convenzione e' condivisa col laboratorio, e il prefisso esiste perche' il
   giorno che una delle due cambia si veda che non e' il file a essere
   cambiato. Un `ALGO` dichiarato una volta e scritto anche nella chiamata e'
   l'unica cosa che impedisce una firma che mente su se stessa. */
{
  const sig = SG.codeOf(path.join(repo, "file_signature.py"));
  assert("l'algoritmo e' dichiarato una volta e usato per nome",
    /^ALGO = "sha256"$/m.test(sig) &&
    /f"\{ALGO\}:\{hashlib\.new\(ALGO, raw\)\.hexdigest\(\)\}"/.test(sig),
    "cambiarlo nel prefisso e non nell'hash darebbe una firma che mente su " +
    "se stessa");
  /* L'ago e' la CHIAMATA, non il nome: `codeOf` tiene le stringhe, e una
     docstring e' una stringa — quella di `write_signed` nomina `write_text`
     per dire che non lo usa, e un ago in forma di prosa avrebbe accusato
     proprio la riga che spiega la regola. */
  assert("si firmano i byte, e si scrive in binario",
    /path\.write_bytes\(raw\)/.test(sig) && !/\.write_text\(/.test(sig),
    "in modalita' testo una piattaforma che traduce i fine riga scriverebbe " +
    "byte diversi da quelli firmati");
}

/* ============================================================
 * 4 — Il giro vero, eseguito: il backend con un bridge finto
 *
 * Le guardie sorgente qui sopra dicono che le catene ci sono; questa sezione
 * le fa girare. Idioma di test-semantics-store.js: il backend VERO guidato con
 * un `fetch` e un `localStorage` finti.
 *
 * Il bridge finto NON riscrive la regola in tre passi — quella e' python e la
 * verifica `tests/python/test_file_signature.py`. Fa solo cio' che il browser
 * puo' osservare: manda la firma dei byte che serve, e rifiuta con 409 quando
 * la firma che gli arriva non e' quella del suo disco. E' il contratto HTTP,
 * non una seconda copia della decisione.
 * ============================================================ */

console.log("\n── il giro vero: letto, cambiato sotto, riscritto ──");

{
  const crypto = require("crypto");
  const sign = (raw) => "sha256:" + crypto.createHash("sha256").update(raw).digest("hex");

  let store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  /* Il disco del bridge finto, e il registro di cosa gli e' arrivato. */
  let DISK = {};
  const seen = [];

  function ndjsonBody(lines) {
    const enc = new TextEncoder();
    let i = 0;
    return { getReader: () => ({ read: async () => (
      i >= lines.length ? { done: true, value: undefined }
                        : { done: false, value: enc.encode(JSON.stringify(lines[i++]) + "\n") }) }) };
  }

  global.fetch = (url, init = {}) => {
    const u = new URL(String(url), "http://x");
    const q = u.searchParams;
    if (u.pathname === "/file" && (!init.method || init.method === "GET")) {
      const name = q.get("name");
      if (!(name in DISK)) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(DISK[name]),
        headers: { get: (h) => (h === "X-PGE-Signature" ? sign(DISK[name]) : null) },
      });
    }
    if (u.pathname === "/file" && init.method === "PUT") {
      const name = q.get("name");
      seen.push({ name, signature: q.get("signature"), overwrite: q.get("overwrite") });
      const onDisk = name in DISK ? sign(DISK[name]) : "";
      const stale = q.get("signature") && onDisk && q.get("signature") !== onDisk;
      if (stale && q.get("overwrite") !== "1") {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve(
          { ok: false, changed: true, signature: onDisk, error: `${name} e' cambiato su disco` }) });
      }
      DISK[name] = init.body;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
        { ok: true, written: true, signature: sign(DISK[name]) }) });
    }
    if (u.pathname === "/render") {
      const body = JSON.parse(init.body);
      seen.push({ render: true, signature: body.signature, overwrite: body.overwrite });
      const name = body.yamlBasename + ".yml";
      const onDisk = name in DISK ? sign(DISK[name]) : "";
      if (body.signature && onDisk && body.signature !== onDisk && !body.overwrite) {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve(
          { ok: false, changed: true, name, signature: onDisk,
            error: `${name} e' cambiato su disco` }) });
      }
      DISK[name] = body.yamlContent;
      return Promise.resolve({ ok: true, status: 200, body: ndjsonBody([
        { type: "file-signatures", signatures: { [name]: sign(DISK[name]) } },
        { type: "done", ok: true, generated: [] },
      ]) });
    }
    if (u.pathname.startsWith("/stems/")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ stems: [] }) });
    }
    return Promise.reject(new Error("fetch inatteso " + u.pathname + u.search));
  };

  global.window = { jsyaml: require("js-yaml"), location: { protocol: "http:", origin: "http://x" } };
  eval(fs.readFileSync(path.join(repo, "src/lib/yaml-bridge.js"), "utf8"));
  eval(fs.readFileSync(path.join(repo, "src/lib/backend.js"), "utf8"));
  const B = window.PGEBackend.create({ baseUrl: "http://x" });

  (async () => {
    DISK["a.yml"] = "streams: []\n";

    /* Letto: la firma e' registrata, ed e' quella che il bridge ha mandato con
       quei byte. Il browser non la calcola — la porta. */
    const text = await B.fs.readFile("projects", "a.yml");
    assert("readFile torna i byte e registra la firma dell'header",
      text === "streams: []\n" &&
      B.fs.fileSignature("projects", "a.yml") === sign("streams: []\n"));
    assert("...e il browser non la calcola, la porta",
      !/sha256|createHash|digest/i.test(backendSrc),
      "calcolarla di qua sarebbe una seconda convenzione, libera di " +
      "divergere da quella del laboratorio");

    /* Nessuno ha toccato il file: la scrittura passa, e la firma che torna
       prende il posto di quella letta. */
    let r = await B.fs.writeFile("projects", "a.yml", "streams: [1]\n");
    assert("una scrittura su un file intatto passa",
      r.ok === true && DISK["a.yml"] === "streams: [1]\n");
    assert("...e manda la firma letta", seen.at(-1).signature === sign("streams: []\n"));
    assert("...e registra quella di cio' che ha scritto",
      B.fs.fileSignature("projects", "a.yml") === sign("streams: [1]\n"),
      "senza, il salvataggio dopo manderebbe la firma di prima e si " +
      "rifiuterebbe da se'");

    /* ...e il salvataggio dopo infatti passa. E' il caso che la riga sopra
       esiste per: una firma non aggiornata si vede solo al secondo giro. */
    r = await B.fs.writeFile("projects", "a.yml", "streams: [2]\n");
    assert("il salvataggio dopo passa anche lui", r.ok === true);

    /* Ora scrive il laboratorio. */
    DISK["a.yml"] = "# dal laboratorio\nstreams: [99]\n";
    r = await B.fs.writeFile("projects", "a.yml", "streams: [3]\n");
    assert("un file cambiato sotto fa tornare changed, non un'eccezione",
      r.ok === false && r.changed === true,
      "lanciare lo farebbe arrivare come un `Save failed`, cioe' la domanda " +
      "mai posta");
    assert("...e il bridge non ha scritto niente",
      DISK["a.yml"] === "# dal laboratorio\nstreams: [99]\n");
    assert("...e la firma registrata resta quella letta, non quella dell'altro",
      B.fs.fileSignature("projects", "a.yml") === sign("streams: [2]\n"),
      "adottare la sua vorrebbe dire aver letto il suo documento senza " +
      "averlo caricato: la scrittura dopo passerebbe e se lo porterebbe via");

    /* `sovrascrivi`: la decisione presa. */
    r = await B.fs.writeFile("projects", "a.yml", "streams: [3]\n", { overwrite: true });
    assert("sovrascrivi passa e lo dichiara al bridge",
      r.ok === true && seen.at(-1).overwrite === "1" &&
      DISK["a.yml"] === "streams: [3]\n");

    /* `ricarica`: rileggere adotta la versione su disco, firma compresa, e da
       li' la scrittura passa senza nessuna sovrascrittura. */
    DISK["a.yml"] = "# dal laboratorio\nstreams: [7]\n";
    await B.fs.readFile("projects", "a.yml");
    r = await B.fs.writeFile("projects", "a.yml", "streams: [8]\n");
    assert("riletto, la scrittura passa senza sovrascrivere",
      r.ok === true && seen.at(-1).overwrite === null,
      "e' la via d'uscita di chi non ha lavoro proprio da perdere");

    /* Il render: la firma la manda `run()`, da quella registrata. */
    DISK["a.yml"] = "streams: [8]\n";
    await B.fs.readFile("projects", "a.yml");
    DISK["a.yml"] = "# dal laboratorio\nstreams: [11]\n";
    const res = await B.render.run({ yamlBasename: "a", yamlContent: "streams: [9]\n",
                                     outputFormat: "wav", streams: [] }, () => {});
    assert("un render su un file cambiato sotto torna changed",
      res.ok === false && res.changed === true);
    assert("...e dichiara di non aver scritto il config",
      res.configWritten === false,
      "altrimenti spegnerebbe l'avviso di migrazione di `dephase` su un file " +
      "che nessuno ha riscritto");
    assert("...e il config su disco e' ancora quello dell'altro editor",
      DISK["a.yml"] === "# dal laboratorio\nstreams: [11]\n");

    /* Con la decisione in mano il render parte, e la firma che il bridge manda
       nell'evento prende il posto di quella letta: un salvataggio subito dopo
       un render non deve rifiutarsi da se'. */
    const ok = await B.render.run({ yamlBasename: "a", yamlContent: "streams: [9]\n",
                                    overwrite: true, outputFormat: "wav", streams: [] },
                                  () => {});
    assert("col `sovrascrivi` il render parte", ok.ok === true);
    assert("...e l'evento file-signatures aggiorna il registro",
      B.fs.fileSignature("projects", "a.yml") === sign("streams: [9]\n"));
    r = await B.fs.writeFile("projects", "a.yml", "streams: [10]\n");
    assert("...quindi il salvataggio dopo un render passa", r.ok === true);
  })().catch((e) => { assert("il giro vero non lancia", false, e.stack); });
}

/* ---------- summary ---------- */

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log("\n──────────────────────────────────────────────────");
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
