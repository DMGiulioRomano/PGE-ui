/* =============================================================================
 * test-stream-copy.js — duplicare uno stream importato crea un file nuovo
 * (PGE-ui #186, regola 5 del piano "stream come file" di mare-nostrum#2).
 *
 * Uno stream importato con `- file: streams/risacca.yml` non si duplica piu'
 * staccandolo dal suo file e scrivendolo per intero nel master (era cio' che
 * faceva l'incolla con #184, `detachImport`): la copia diventa un file nuovo e
 * indipendente accanto all'originale, `streams/<id>.yml`, e il master la
 * importa con una voce `file:` sua.
 *
 * Qui si pretende:
 *
 *   1. il modello (`yaml-bridge.js`): il path del file nuovo, quando un nome e'
 *      preso, la copia della provenienza (stesso contenuto tranne `stream_id`),
 *      l'indipendenza dei due file, e quali file sono NUOVI — da creare, mai da
 *      sovrascrivere — cioe' nati da una copia e non ancora scritti;
 *   2. il backend (`backend.js`) contro un bridge finto: l'elenco di una
 *      cartella, `createImports` nel corpo di `/save` e `/render`, e il rifiuto
 *      `exists` che torna come risposta e non come eccezione;
 *   3. il cablaggio in app.jsx, con guardie sorgente: l'incolla chiede la
 *      cartella prima di scegliere il nome, e salvataggio e render dicono al
 *      bridge quali file sono nuovi.
 *
 * Il giro intero (incolla, undo prima del salvataggio, salvataggio, il nome
 * che evita un file gia' su disco) gira nel browser vero: tests/e2e/test-boot.js.
 *
 * Run: node test-stream-copy.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});

/* --- localStorage e bridge finti ------------------------------------------ */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

// Come il bridge vero li elenca: solo i documenti YAML (pytest lo pretende).
const DIRS = { "streams": ["risacca.yml", "Stream4.YAML"] };
const SAVES = [], RENDERS = [], LISTS = [];
let EXISTS = [];               // i file che il bridge finto trova gia' su disco
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
function existsRefusal(body) {
  const hit = (body.createImports || []).filter(f => EXISTS.includes(f));
  return hit.length ? jsonRes(409, { ok: false, exists: true, files: hit,
                                     error: `${hit.join(", ")}: esiste gia' su disco` }) : null;
}
global.fetch = (url, init = {}) => {
  const u = new URL(String(url));
  if (u.pathname === "/import-dir") {
    const dir = u.searchParams.get("dir");
    LISTS.push(dir);
    if (dir === "rotta") return jsonRes(400, { ok: false, error: "path non valido" });
    return jsonRes(200, { ok: true, dir, files: DIRS[dir] || [] });
  }
  if (u.pathname === "/save") {
    const body = JSON.parse(init.body);
    SAVES.push(body);
    const refusal = existsRefusal(body);
    if (refusal) return refusal;
    return jsonRes(200, { ok: true, written: [...Object.keys(body.imports || {}), `${body.basename}.yml`],
                          signature: "sha256:x" });
  }
  if (u.pathname === "/render") {
    const body = JSON.parse(init.body);
    RENDERS.push(body);
    const refusal = existsRefusal(body);
    if (refusal) return refusal;
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, body: ndjsonBody([
      { type: "done", ok: true, generated: [] },
    ]) });
  }
  if (u.pathname.startsWith("/stems/")) return jsonRes(200, { basename: "x", stems: [] });
  return Promise.reject(new Error("unexpected fetch " + u));
};

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

const Y = window.PGEYaml;
const jsyaml = window.jsyaml;

/* La fixture di test-stream-files.js, ridotta: un master che importa il
 * documento del laboratorio `streams/risacca.yml` (seed dello studio,
 * stream_id = nome del file, il piazzamento dello stream da cui e' stato
 * aperto) e uno stream scritto dentro. */
const MASTER = `seed: 1441
streams:
  - file: streams/risacca.yml
    onset: 2.5
  - stream_id: riva
    onset: 0
    duration: 3
    sample: onda.wav
    density: 40
`;
const RISACCA = `seed: 1441
duration: 4
bpm: 120
streams:
- stream_id: risacca
  onset: 12.5
  mute: true
  duration: 4
  sample: onda.wav
  time_mode: normalized
  fill_factor:
    type: cubic
    points: [[0, 2], [0.5, 3], [1, 1.5]]
  grain:
    duration: [[0, 0.03], [0.5, 0.05, step], [1, 0.02]]
    envelope: hanning
  pointer:
    start: 0
    speed_ratio: 0.5
    loop_unit: normalized
  volume: -6
`;
const FILE = "streams/risacca.yml";
const open = () => Y.parse(MASTER, { project: "brano", samples: [], imports: { [FILE]: { text: RISACCA } } });
const fileDoc = (data, file) => jsyaml.load(Y.serializeImports(data).files[file]);
const masterDoc = (data) => jsyaml.load(Y.serialize(data));
// L'incolla, come lo fa app.jsx: la copia prende l'id nuovo e la provenienza
// nuova, e si mette dove dice il cursore.
const paste = (data, src, id, onset = 0) =>
  ({ ...data, streams: [...data.streams, { ...Y.copyImport(JSON.parse(JSON.stringify(src)), id), onset }] });

(async () => {

/* ===========================================================================
 * 1. Il modello
 * ======================================================================== */
console.log("\n── il path del file nuovo: accanto all'originale, col nome dell'id ──");
{
  assert("streams/risacca.yml → streams/stream7.yml",
    Y.importCopyFile("streams/risacca.yml", "stream7") === "streams/stream7.yml",
    Y.importCopyFile("streams/risacca.yml", "stream7"));
  assert("l'estensione e' quella dell'originale",
    Y.importCopyFile("risacca.yaml", "stream7") === "stream7.yaml", Y.importCopyFile("risacca.yaml", "stream7"));
  assert("un file in cima a configs/ ha la copia in cima a configs/",
    Y.importCopyFile("risacca.yml", "stream7") === "stream7.yml");
  assert("le cartelle annidate restano, e i punti nel nome non contano",
    Y.importCopyFile("a/b/c.d.yml", "s") === "a/b/s.yml", Y.importCopyFile("a/b/c.d.yml", "s"));
  assert("la cartella di un file importato",
    Y.importDirOf("streams/risacca.yml") === "streams" && Y.importDirOf("risacca.yml") === ""
      && Y.importDirOf("a/b/c.yml") === "a/b",
    [Y.importDirOf("streams/risacca.yml"), Y.importDirOf("risacca.yml"), Y.importDirOf("a/b/c.yml")].join(" | "));
}

console.log("\n── quando un id e' preso come nome di file ──");
{
  const files = ["streams/risacca.yml", "streams/stream3.yml", "streams/Stream4.YAML", "altrove/stream5.yml",
                 "stream6.yml"];
  const taken = (id, dirs) => Y.importIdTaken(id, dirs, files);
  assert("un file con quel nome nella cartella della copia: preso", taken("stream3", ["streams"]));
  assert("anche con l'altra estensione e le maiuscole (un disco di macOS non le distingue)",
    taken("stream4", ["streams"]));
  assert("lo stesso nome in un'altra cartella non e' una collisione", !taken("stream5", ["streams"]));
  assert("in cima a configs/ conta solo la cima", taken("stream6", [""]) && !taken("stream3", [""]));
  assert("un nome libero e' libero", !taken("stream7", ["streams"]));
  assert("piu' cartelle: preso se lo e' in una delle due", taken("stream5", ["streams", "altrove"]));
  assert("nessuna cartella (nessuna copia importata): niente e' preso per questo",
    !taken("stream3", []));
  assert("un file che non e' YAML non prende il nome",
    !Y.importIdTaken("note", ["streams"], ["streams/note.txt"]));

  // L'id dell'incolla: allocStreamIds con l'oracolo degli stem E dei file.
  const streams = [{ id: "stream1" }, { id: "stream2" }];
  const [id] = Y.allocStreamIds(streams, 1, (x) => Y.importIdTaken(x, ["streams"], files));
  // stream3 e Stream4 stanno in streams/, stream5 in un'altra cartella.
  assert("allocStreamIds salta i nomi presi dai file nella cartella della copia", id === "stream5", id);
}

console.log("\n── i file che il documento conosce gia' ──");
{
  const d = open();
  const withBroken = { ...d, _unresolvedImports: [{ index: 2, entry: { file: "streams/rotto.yml" } },
                                                 { index: 3, entry: { file: 7 } }] };
  assert("quelli degli stream importati e delle voci che non si sono risolte",
    eq(Y.importFilesOf(withBroken).sort(), [FILE, "streams/rotto.yml"]), JSON.stringify(Y.importFilesOf(withBroken)));
  assert("un documento senza import non ne ha", eq(Y.importFilesOf({ streams: [{ id: "a" }] }), []));
}

console.log("\n── la copia: un file nuovo, stesso contenuto tranne stream_id ──");
{
  const d = open();
  const src = d.streams[0];
  const c = Y.copyImport(JSON.parse(JSON.stringify(src)), "stream7");
  assert("prende l'id nuovo", c.id === "stream7");
  assert("e un file suo accanto all'originale", c._import && c._import.file === "streams/stream7.yml",
    JSON.stringify(c._import && c._import.file));
  assert("la voce del master e' la sola `file:` (il piazzamento viene dallo stato)",
    eq(c._import.entry, { file: "streams/stream7.yml" }), JSON.stringify(c._import.entry));
  assert("e' nuova: nata qui, mai letta da un disco", c._import.fresh === true);
  assert("dentro il file lo stream_id e' quello nuovo (la regola del laboratorio: il nome del file)",
    c._import.place.stream_id === "stream7" && src._import.place.stream_id === "risacca");
  assert("il resto del piazzamento nel file resta (onset, mute del documento del laboratorio)",
    c._import.place.onset === 12.5 && c._import.place.mute === true, JSON.stringify(c._import.place));
  assert("la testa del file e' la stessa, ma non e' lo stesso oggetto",
    eq(c._import.head, src._import.head) && c._import.head !== src._import.head);
  assert("il contenuto dello stream e' lo stesso", eq(c.fillFactorEnv, src.fillFactorEnv) && c.volume === src.volume);
  assert("l'originale non si tocca", src.id === "risacca" && src._import.file === FILE && !src._import.fresh);

  const plain = Y.copyImport({ id: "riva", density: 40 }, "stream8");
  assert("uno stream scritto nel master resta nel master: prende solo l'id",
    plain.id === "stream8" && !("_import" in plain) && plain.density === 40);
  assert("un file senza stream_id dentro non ne guadagna uno",
    !("stream_id" in Y.copyImport({ id: "x", _import: { file: "a.yml", entry: { file: "a.yml" }, head: {},
                                                         place: { onset: 0 }, dur0: null } }, "s")._import.place));

  const p = paste(d, src, "stream7", 6);
  const files = Y.serializeImports(p).files;
  assert("due file da scrivere: l'originale e la copia", eq(Object.keys(files).sort(), [FILE, "streams/stream7.yml"]),
    JSON.stringify(Object.keys(files)));
  const a = fileDoc(p, FILE), b = fileDoc(p, "streams/stream7.yml");
  const sansId = (doc) => ({ ...doc, streams: doc.streams.map(({ stream_id, ...rest }) => rest) });
  assert("il file nuovo dice cio' che dice l'originale, tranne stream_id",
    eq(sansId(a), sansId(b)) && b.streams[0].stream_id === "stream7" && a.streams[0].stream_id === "risacca",
    JSON.stringify(b));
  assert("e resta un documento del laboratorio: seed, durata, bpm del file", b.seed === 1441 && b.duration === 4 && b.bpm === 120);
  const entries = masterDoc(p).streams;
  assert("una voce `file:` nuova nel master, senza stream_id (il default e' il nome del file)",
    eq(entries[2], { file: "streams/stream7.yml", onset: 6 }), JSON.stringify(entries[2]));
  assert("...e la voce dell'originale non cambia", eq(entries[0], { file: FILE, onset: 2.5 }), JSON.stringify(entries[0]));
  assert("due file diversi non sono un conflitto", eq(Y.serializeImports(p).conflicts, []));

  // Riletto, il master trova la copia nel suo file, con l'id del nome del file.
  const back = Y.parse(Y.serialize(p), { project: "brano", samples: [],
    imports: { [FILE]: { text: files[FILE] }, "streams/stream7.yml": { text: files["streams/stream7.yml"] } } });
  const copy = back.streams.find(s => s.id === "stream7");
  assert("riletta, la copia e' lo stream del file nuovo", !!copy && copy._import.file === "streams/stream7.yml"
    && !back.importErrors, JSON.stringify(back.importErrors));
  assert("...con lo stesso contenuto", copy && eq(copy.fillFactorEnv, src.fillFactorEnv) && copy.onset === 6);
  assert("...e una copia riletta non e' piu' nuova: e' un file su disco", copy && !copy._import.fresh);
}

console.log("\n── i due file non si influenzano ──");
{
  const d = open();
  const p = paste(d, d.streams[0], "stream7");
  const before = Y.serializeImports(p).files;
  const touchCopy = { ...p, streams: p.streams.map(s => s.id === "stream7" ? { ...s, volume: -20 } : s) };
  const t1 = Y.serializeImports(touchCopy).files;
  assert("modificare la copia non tocca l'originale", t1[FILE] === before[FILE]);
  assert("...e cambia il file della copia", jsyaml.load(t1["streams/stream7.yml"]).streams[0].volume === -20);
  const touchOrig = { ...p, streams: p.streams.map(s => s.id === "risacca" ? { ...s, volume: -30 } : s) };
  const t2 = Y.serializeImports(touchOrig).files;
  assert("modificare l'originale non tocca la copia", t2["streams/stream7.yml"] === before["streams/stream7.yml"]);
  assert("...e cambia il file dell'originale", jsyaml.load(t2[FILE]).streams[0].volume === -30);
  // La copia e' fatta da un oggetto copiato: una modifica in place su uno dei
  // due (non dovrebbe esserci, ma un riferimento condiviso la renderebbe
  // invisibile) non arriva all'altro.
  p.streams[2]._import.head.seed = 99;
  assert("la testa dei due file non e' condivisa", p.streams[0]._import.head.seed === 1441);
}

console.log("\n── quali file sono nuovi: da creare, mai da sovrascrivere ──");
{
  const d = open();
  const p = paste(d, d.streams[0], "stream7");
  const disk0 = Y.serializeImports(d).files;          // il disco come l'apertura lo ricorda
  assert("la copia mai scritta e' un file da creare", eq(Y.importCreates(p, disk0), ["streams/stream7.yml"]),
    JSON.stringify(Y.importCreates(p, disk0)));
  assert("...ed e' anche fra i file cambiati, cioe' si scrive",
    "streams/stream7.yml" in Y.changedImports(Y.serializeImports(p).files, disk0));
  const disk1 = { ...disk0, ...Y.serializeImports(p).files };   // dopo il salvataggio
  assert("scritta una volta, non e' piu' nuova: e' nostra, e si riscrive", eq(Y.importCreates(p, disk1), []));
  // Un file che il disco ricordato lascia fuori apposta (la grafia `dephase`,
  // da migrare) esiste: non e' nato da una copia, quindi non e' da creare.
  assert("un file assente dal disco ricordato ma non nato da una copia non e' da creare",
    eq(Y.importCreates(d, {}), []));
  // Undo dell'incolla: la copia non c'e' piu' nello stato, quindi non si scrive
  // e non si crea niente — su disco non resta nessun file.
  assert("annullata prima del salvataggio, non c'e' niente da scrivere ne' da creare",
    !("streams/stream7.yml" in Y.serializeImports(d).files) && eq(Y.importCreates(d, disk0), []));
  const twice = paste(paste(d, d.streams[0], "stream7"), d.streams[0], "stream8");
  assert("due copie, due file nuovi, nell'ordine del master",
    eq(Y.importCreates(twice, disk0), ["streams/stream7.yml", "streams/stream8.yml"]));
  // La copia di una copia non ancora salvata e' una copia come le altre.
  const cc = paste(p, p.streams[2], "stream9");
  assert("la copia di una copia ha il suo file nuovo",
    cc.streams[3]._import.file === "streams/stream9.yml" && cc.streams[3]._import.place.stream_id === "stream9"
      && eq(Y.importCreates(cc, disk0), ["streams/stream7.yml", "streams/stream9.yml"]));
}

console.log("\n── incollare da un altro progetto: la stessa regola ──");
{
  // Il path e' relativo alla cartella del master, quindi la copia di uno
  // stream che viene da un altro brano va nella cartella di QUESTO master,
  // nella stessa sottocartella dell'originale. Il modello non ha un ramo per
  // l'altro progetto: e' la stessa funzione.
  const other = Y.parse(`streams:\n  - file: lab/vento.yml\n`, { project: "altro", samples: [],
    imports: { "lab/vento.yml": { text: `seed: 7\nstreams:\n- stream_id: vento\n  duration: 2\n  sample: x.wav\n` } } });
  const here = open();
  const p = paste(here, other.streams[0], "stream3");
  assert("file nuovo nella cartella di questo master", p.streams[2]._import.file === "lab/stream3.yml");
  assert("...con il documento dell'altro brano (il suo seed)",
    fileDoc(p, "lab/stream3.yml").seed === 7 && fileDoc(p, "lab/stream3.yml").streams[0].stream_id === "stream3");
}

/* ===========================================================================
 * 2. Il backend contro un bridge finto
 * ======================================================================== */
console.log("\n── backend: l'elenco di una cartella ──");
{
  const be = window.PGEBackend.create({ baseUrl: "http://bridge" });
  const r = await be.fs.listImportDir("streams");
  assert("GET /import-dir?dir=…", LISTS.at(-1) === "streams");
  assert("i nomi dei file YAML della cartella, col path relativo a configs/",
    r.ok === true && eq(r.files, ["streams/risacca.yml", "streams/Stream4.YAML"]), JSON.stringify(r));
  const top = await be.fs.listImportDir("");
  assert("la cima di configs/ e' la cartella vuota", top.ok === true && LISTS.at(-1) === "", JSON.stringify(top));
  const bad = await be.fs.listImportDir("rotta");
  assert("un rifiuto torna come risposta, non come eccezione", bad.ok === false && typeof bad.error === "string",
    JSON.stringify(bad));
}

console.log("\n── backend: i file nuovi viaggiano col salvataggio e col render ──");
{
  const be = window.PGEBackend.create({ baseUrl: "http://bridge" });
  const imports = { "streams/stream7.yml": "a: 1\n" };
  const s1 = await be.fs.save("brano", "streams: []\n", imports, { create: ["streams/stream7.yml"] });
  assert("POST /save porta createImports", eq(SAVES.at(-1).createImports, ["streams/stream7.yml"]),
    JSON.stringify(SAVES.at(-1)));
  assert("...e salva", s1.ok === true);
  await be.fs.save("brano", "streams: []\n", {});
  assert("senza file nuovi il campo non c'e'", !("createImports" in SAVES.at(-1)), JSON.stringify(SAVES.at(-1)));

  EXISTS = ["streams/stream7.yml"];
  const s2 = await be.fs.save("brano", "streams: []\n", imports, { create: ["streams/stream7.yml"] });
  assert("un file nuovo che esiste gia': rifiuto come risposta, coi file",
    s2.ok === false && s2.exists === true && eq(s2.files, ["streams/stream7.yml"]) && /esiste/.test(s2.error),
    JSON.stringify(s2));

  const events = [];
  const opts = { yamlBasename: "brano", yamlContent: "streams: []\n", streams: [], outputFormat: "wav",
                 renderer: "numpy", semanticsVersion: 3, imports, createImports: ["streams/stream7.yml"] };
  const r1 = await be.render.run(opts, (e) => events.push(e));
  assert("POST /render porta createImports", eq(RENDERS.at(-1).createImports, ["streams/stream7.yml"]));
  assert("il rifiuto del render e' una risposta: niente scritto, nessun `done`",
    r1.ok === false && r1.exists === true && r1.configWritten === false && eq(r1.files, ["streams/stream7.yml"])
      && !events.some(e => e.type === "done"), JSON.stringify(r1));
  assert("...e una riga di log che nomina il file", events.some(e => e.type === "log" && /stream7\.yml/.test(e.line)),
    JSON.stringify(events));
  EXISTS = [];
  const r2 = await be.render.run(opts, () => {});
  assert("dopo il rifiuto si puo' rendere di nuovo", r2.ok === true, JSON.stringify(r2));
}

/* ===========================================================================
 * 3. Il cablaggio in app.jsx (guardie sorgente)
 * ======================================================================== */
console.log("\n── app.jsx: l'incolla crea un file nuovo, salvataggio e render lo dicono ──");
{
  const app = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
  const fnBody = (name) => {
    const i = app.indexOf(name);
    if (i < 0) return "";
    const open = app.indexOf("{", i);
    let depth = 0;
    for (let j = open; j < app.length; j++) {
      if (app[j] === "{") depth++;
      else if (app[j] === "}" && --depth === 0) return app.slice(i, j + 1);
    }
    return "";
  };
  const paste = fnBody("async function pasteStreams(");
  assert("pasteStreams e' asincrona (chiede la cartella al bridge prima di scegliere il nome)", !!paste);
  assert("...la copia passa da copyImport, non si stacca piu' dal suo file",
    /copyImport\(/.test(paste) && !/detachImport\(/.test(paste));
  // L'elenco passa da `listImportNames`, che lo split condivide (#187).
  const list = paste.indexOf("listImportNames(");
  const alloc = paste.indexOf("allocStreamIds(");
  assert("...elenca la cartella PRIMA di allocare l'id", list > 0 && alloc > 0 && list < alloc,
    `list@${list} alloc@${alloc}`);
  assert("...e l'elenco e' quello del bridge (GET /import-dir)",
    /listImportDir\(/.test(fnBody("async function listImportNames(")));
  assert("...e l'oracolo dell'id guarda stem e file: ownsStemFor e importIdTaken",
    /ownsStemFor\(/.test(paste) && /importIdTaken\(/.test(paste));
  assert("...con i file su disco ricordati e quelli del documento, non solo l'elenco",
    /importDiskRef\.current/.test(paste) && /importFilesOf\(/.test(paste));
  // Da un altro progetto vale la stessa regola: nessun ramo che stacchi la
  // copia quando `_srcProject` non e' questo.
  assert("...nessun ramo diverso per l'altro progetto: `_srcProject` decide solo la corsia",
    (paste.match(/_srcProject/g) || []).length <= 2);
  // Lo split non stacca piu' la coda: ha un file suo (#187, test-stream-split.js).
  const split = fnBody("async function splitAtPlayhead(");
  assert("anche lo split da' alla coda un file suo (#187)", /copyImport\(/.test(split) && !/detachImport\(/.test(split));

  const iw = fnBody("function importWrites(");
  assert("importWrites dice quali file sono nuovi (importCreates contro il disco ricordato)",
    /importCreates\([^)]*importDiskRef\.current\)/.test(iw) && /create/.test(iw));
  assert("il salvataggio li manda al bridge", /backend\.fs\.save\([^;]*create:\s*imp\.create/.test(app));
  assert("anche Save As", (app.match(/create:\s*imp\.create/g) || []).length >= 2);
  assert("e il render, nel corpo del POST", /createImports:\s*importCreate/.test(app)
    && /optsFor\(doc, st, plan\.texts, plan\.create\)/.test(app));
  const saveAs = fnBody("async function onSaveAs(");
  assert("Save As non annuncia un salvataggio rifiutato", /\.ok\s*===\s*false|!res\.ok|!\w+\.ok/.test(saveAs));
  const save = fnBody("async function saveProject(");
  assert("un file nuovo gia' su disco e' un rifiuto detto all'utente, non un 'Save failed'",
    /\.exists/.test(save));
}

})().catch(e => {
  fail++;
  console.error("FAIL  il corpo della suite e' morto a meta'\n      " + (e && e.stack ? e.stack : String(e)));
});
