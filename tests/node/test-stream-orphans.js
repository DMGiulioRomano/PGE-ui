/* =============================================================================
 * test-stream-orphans.js — cancellare o rinominare uno stream importato
 * (PGE-ui #208, dalla review del piano "stream come file" di mare-nostrum#2).
 *
 * Uno stream importato con `- file: streams/risacca.yml` e' un file, e il
 * nome del file e' il suo id (lo `stream_id` di default, e quello con cui il
 * laboratorio lo apre). Due gesti dell'editor lasciavano il brano incoerente:
 *
 *   - CANCELLARE toglieva la voce dal master e lasciava il file in
 *     `configs/streams/` senza che nessuno lo nominasse: uno stream che non
 *     suona da nessuna parte;
 *   - RINOMINARE scriveva `stream_id: <nuovo>` nella voce del master e
 *     lasciava il file col suo nome: il brano suonava la realizzazione del
 *     nome nuovo, il file aperto da solo nel laboratorio quella del vecchio.
 *
 * Adesso la rinomina SPOSTA il file (`streams/<nuovo>.yml`, creato come la
 * copia di #186, la voce del master senza `stream_id`), e un file che il
 * master non nomina piu' — lo stream cancellato, il nome vecchio di uno
 * rinominato, la copia incollata e poi annullata — si cancella al salvataggio,
 * deciso contro il disco ricordato come `importCreates`. Un undo riporta lo
 * stream, e il salvataggio dopo riscrive il suo file.
 *
 * Qui si pretende:
 *
 *   1. il modello (`yaml-bridge.js`): quali file sono orfani
 *      (`importOrphans`), quando la rinomina sposta il file e quando no
 *      (`importRenameFile`) e cosa scrive (`renameImport`);
 *   2. il backend (`backend.js`) contro un bridge finto: `deleteImports` con
 *      le firme lette, e cosa resta delle firme dopo la risposta;
 *   3. il cablaggio in app.jsx e Inspector.jsx, con guardie sorgente.
 *
 * Il giro intero (rinomina, salvataggio, cancellazione, undo) gira nel browser
 * vero: tests/e2e/test-boot.js. Cosa il bridge cancella davvero, e cosa no:
 * tests/python/test_stream_orphans.py.
 *
 * Run: node test-stream-orphans.js (from tests/node/ after npm install)
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

const SAVES = [];
let ANSWER = null;             // cosa risponde POST /save oltre a ok/written/firma
function jsonRes(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}
global.fetch = (url, init = {}) => {
  const u = new URL(String(url));
  if (u.pathname === "/import") {
    const f = u.searchParams.get("file");
    return jsonRes(200, { ok: true, file: f, text: "streams: []\n", signature: `sha256:${f}` });
  }
  if (u.pathname === "/save") {
    const body = JSON.parse(init.body);
    SAVES.push(body);
    return jsonRes(200, { ok: true, written: [`${body.basename}.yml`], signature: "sha256:m",
                          importSignatures: {}, ...(ANSWER || {}) });
  }
  return Promise.reject(new Error("unexpected fetch " + u));
};

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

const Y = window.PGEYaml;
const jsyaml = window.jsyaml;

/* Un master che importa due documenti del laboratorio e ha uno stream scritto
 * dentro. `onda.yml` lo importa una voce sola; `riva` e' nel master. */
const MASTER = `seed: 1441
streams:
  - file: streams/risacca.yml
    onset: 2.5
  - file: streams/onda.yml
  - stream_id: riva
    onset: 0
    duration: 3
    sample: onda.wav
    density: 40
`;
const lab = (id, extra = "") => `seed: 1441
duration: 4
streams:
- stream_id: ${id}
  onset: 0
  duration: 4
  sample: onda.wav
  volume: -6
${extra}`;
const DOCS = { "streams/risacca.yml": lab("risacca"), "streams/onda.yml": lab("onda") };
const open = (master = MASTER, docs = DOCS) => Y.parse(master, { project: "brano", samples: [],
  imports: Object.fromEntries(Object.entries(docs).map(([f, t]) => [f, { text: t }])) });
// Il disco ricordato all'apertura, come lo riempie onProjectSelect.
const diskOf = (d) => Y.serializeImports(d).files;
const masterDoc = (d) => jsyaml.load(Y.serialize(d));
const fileDoc = (d, f) => jsyaml.load(Y.serializeImports(d).files[f]);
const without = (d, id) => ({ ...d, streams: d.streams.filter(s => s.id !== id) });
const renamed = (d, oldId, newId) =>
  ({ ...d, streams: d.streams.map(s => (s.id === oldId ? Y.renameImport(s, newId, d.streams) : s)) });

(async () => {

/* ===========================================================================
 * 1. Il modello
 * ======================================================================== */
console.log("\n── importOrphans: i file su disco che il documento non nomina piu' ──");
{
  const d0 = open(), disk = diskOf(d0);
  assert("appena aperto, nessun orfano", eq(Y.importOrphans(d0, disk), []), JSON.stringify(Y.importOrphans(d0, disk)));
  const d1 = without(d0, "risacca");
  assert("cancellato lo stream importato, il suo file e' orfano",
    eq(Y.importOrphans(d1, disk), ["streams/risacca.yml"]), JSON.stringify(Y.importOrphans(d1, disk)));
  assert("...e solo il suo: lo stream scritto nel master non ha file",
    eq(Y.importOrphans(without(d0, "riva"), disk), []));
  assert("un undo (lo stato di prima) non ha orfani", eq(Y.importOrphans(d0, disk), []));
  assert("senza disco ricordato non ci sono orfani: si cancella solo cio' che si sa su disco",
    eq(Y.importOrphans(d1, {}), []) && eq(Y.importOrphans(d1, null), []));

  // Lo stesso file importato da due voci e' UN file: finche' una voce resta,
  // il file e' nominato.
  const shared = open(MASTER.replace("  - file: streams/onda.yml\n",
    "  - file: streams/onda.yml\n  - file: streams/onda.yml\n    stream_id: onda-bis\n"));
  assert("un file importato da due voci, cancellata una, non e' orfano",
    eq(Y.importOrphans(without(shared, "onda"), diskOf(shared)), []));
  assert("...cancellate tutte e due, lo e'",
    eq(Y.importOrphans(without(without(shared, "onda"), "onda-bis"), diskOf(shared)), ["streams/onda.yml"]));

  // Una voce `file:` che non si e' risolta (file rotto) e' ancora una voce:
  // il file che nomina non e' di nessun altro, e non si tocca.
  const broken = open(MASTER, { ...DOCS, "streams/onda.yml": "streams: [a, b\n" });
  assert("una voce irrisolta tiene nominato il suo file",
    eq(Y.importOrphans(broken, { ...diskOf(broken), "streams/onda.yml": "x" }), []),
    JSON.stringify(Y.importOrphans(broken, { ...diskOf(broken), "streams/onda.yml": "x" })));

  // La copia incollata (#186) e poi annullata: prima del salvataggio non e'
  // su disco e non e' orfana; dopo, si.
  const src = d0.streams.find(s => s.id === "risacca");
  const pasted = { ...d0, streams: [...d0.streams, Y.copyImport(JSON.parse(JSON.stringify(src)), "stream7")] };
  assert("una copia non salvata e annullata non lascia orfani", eq(Y.importOrphans(d0, disk), []));
  const diskAfterSave = { ...disk, ...diskOf(pasted) };
  assert("salvata e poi annullata, il suo file e' orfano",
    eq(Y.importOrphans(d0, diskAfterSave), ["streams/stream7.yml"]));
  assert("gli orfani sono in ordine di disco, una volta sola",
    eq(Y.importOrphans(without(d0, "onda"), diskAfterSave), ["streams/onda.yml", "streams/stream7.yml"]),
    JSON.stringify(Y.importOrphans(without(d0, "onda"), diskAfterSave)));
}

console.log("\n── la rinomina sposta il file: streams/<nuovo>.yml, la voce senza stream_id ──");
{
  const d0 = open(), disk = diskOf(d0);
  const src = d0.streams.find(s => s.id === "risacca");
  assert("importRenameFile: il file nuovo e' accanto al vecchio, col nome nuovo",
    Y.importRenameFile(src, "marea", d0.streams) === "streams/marea.yml",
    Y.importRenameFile(src, "marea", d0.streams));
  const d1 = renamed(d0, "risacca", "marea");
  const s1 = d1.streams.find(s => s.id === "marea");
  assert("lo stream rinominato ha l'id nuovo e il file nuovo",
    !!s1 && s1._import.file === "streams/marea.yml", JSON.stringify(s1 && s1._import));
  const entry = masterDoc(d1).streams[0];
  assert("la voce del master e' il file nuovo col suo piazzamento, senza stream_id (e' il default)",
    eq(entry, { file: "streams/marea.yml", onset: 2.5 }), JSON.stringify(entry));
  const doc = fileDoc(d1, "streams/marea.yml");
  const was = jsyaml.load(DOCS["streams/risacca.yml"]);
  assert("il file nuovo dice cio' che diceva il vecchio, con lo stream_id del suo nome",
    doc.streams[0].stream_id === "marea"
      && eq({ ...doc, streams: [{ ...doc.streams[0], stream_id: null }] },
            { ...was, streams: [{ ...was.streams[0], stream_id: null }] }), JSON.stringify(doc));
  assert("...e' un file da CREARE, come la copia: il bridge non sovrascrive un file che c'e' gia'",
    eq(Y.importCreates(d1, disk), ["streams/marea.yml"]), JSON.stringify(Y.importCreates(d1, disk)));
  assert("...e il vecchio e' orfano: si cancella al salvataggio",
    eq(Y.importOrphans(d1, disk), ["streams/risacca.yml"]), JSON.stringify(Y.importOrphans(d1, disk)));
  assert("il resto del documento non cambia",
    eq(masterDoc(d1).streams.slice(1), masterDoc(d0).streams.slice(1))
      && Y.serializeImports(d1).files["streams/onda.yml"] === disk["streams/onda.yml"]);

  // Un file che non scrive lo `stream_id` non se lo vede aggiungere: il
  // default e' il nome del file, e il file ha il nome giusto.
  const noId = open(MASTER, { ...DOCS, "streams/risacca.yml": lab("risacca").replace("- stream_id: risacca\n  ", "- ") });
  const n1 = renamed(noId, "risacca", "marea");
  assert("uno stream_id che il file non scriveva non si aggiunge",
    !("stream_id" in fileDoc(n1, "streams/marea.yml").streams[0]), JSON.stringify(fileDoc(n1, "streams/marea.yml")));

  // L'estensione e' quella del file.
  const yaml = open(MASTER.replace("streams/risacca.yml", "streams/risacca.yaml"),
                    { ...DOCS, "streams/risacca.yaml": DOCS["streams/risacca.yml"] });
  assert("l'estensione resta quella del file",
    renamed(yaml, "risacca", "marea").streams[0]._import.file === "streams/marea.yaml");

  // Le chiavi della voce restano come erano scritte: un onset in forma di
  // espressione, un `mute: false` (presente = muto, per il motore), una
  // chiave estranea che l'errore deve continuare a mostrare.
  const written = open(MASTER.replace("    onset: 2.5\n", "    onset: (5/2)\n    mute: false\n    colore: rosso\n"));
  const w1 = renamed(written, "risacca", "marea");
  const we = masterDoc(w1).streams[0];
  assert("la voce tiene le sue chiavi come erano scritte, col file nuovo",
    eq(we, { file: "streams/marea.yml", onset: "(5/2)", mute: false, colore: "rosso" }), JSON.stringify(we));
}

console.log("\n── quando la rinomina NON sposta il file ──");
{
  // Il nome nuovo E' il nome del file: la voce con `stream_id: alto` torna
  // al default, e il file resta dov'e'.
  const alto = open(MASTER.replace("    onset: 2.5\n", "    onset: 2.5\n    stream_id: alto\n"));
  const disk = diskOf(alto);
  assert("la voce che rinominava lo stream (alto) si apre con quell'id", alto.streams[0].id === "alto");
  const a1 = renamed(alto, "alto", "risacca");
  assert("rinominato col nome del suo file, il file resta",
    Y.importRenameFile(alto.streams[0], "risacca", alto.streams) === null
      && a1.streams[0]._import.file === "streams/risacca.yml" && !a1.streams[0]._import.fresh);
  assert("...e la voce perde lo stream_id, che e' il default",
    eq(masterDoc(a1).streams[0], { file: "streams/risacca.yml", onset: 2.5 }), JSON.stringify(masterDoc(a1).streams[0]));
  assert("...niente da creare, niente di orfano",
    eq(Y.importCreates(a1, disk), []) && eq(Y.importOrphans(a1, disk), []));

  // La voce che rinominava lo stream, rinominata con un terzo nome: il file
  // si sposta, e da li' nome del file e id coincidono.
  const a2 = renamed(alto, "alto", "basso");
  assert("rinominata con un altro nome, la voce che divergeva torna a coincidere col file",
    a2.streams[0]._import.file === "streams/basso.yml"
      && eq(masterDoc(a2).streams[0], { file: "streams/basso.yml", onset: 2.5 }),
    JSON.stringify(masterDoc(a2).streams[0]));

  // Lo stesso file importato da due voci: e' UN documento, che l'altra voce
  // continua a importare. Spostarlo lo toglierebbe all'altra: la rinomina
  // resta nella voce del master, come prima di #208.
  const shared = open(MASTER.replace("  - file: streams/onda.yml\n",
    "  - file: streams/onda.yml\n  - file: streams/onda.yml\n    stream_id: onda-bis\n"));
  const sd = diskOf(shared);
  const src = shared.streams.find(s => s.id === "onda");
  assert("un file importato da due voci non si sposta", Y.importRenameFile(src, "mareggiata", shared.streams) === null);
  const s1 = renamed(shared, "onda", "mareggiata");
  const entries = masterDoc(s1).streams;
  assert("...la voce prende lo stream_id nuovo, l'altra non cambia",
    eq(entries[1], { file: "streams/onda.yml", stream_id: "mareggiata" })
      && eq(entries[2], { file: "streams/onda.yml", stream_id: "onda-bis" }), JSON.stringify(entries));
  assert("...niente da creare, niente di orfano, nessun conflitto",
    eq(Y.importCreates(s1, sd), []) && eq(Y.importOrphans(s1, sd), [])
      && eq(Y.serializeImports(s1).conflicts, []));

  // Uno stream scritto nel master cambia solo l'id.
  const d0 = open();
  const r = Y.renameImport(d0.streams.find(s => s.id === "riva"), "spiaggia", d0.streams);
  assert("uno stream scritto nel master cambia solo l'id", r.id === "spiaggia" && !r._import);
}

console.log("\n── avanti e indietro: il disco ricordato decide, non la storia ──");
{
  const d0 = open(), disk = diskOf(d0);
  // Rinominato e riportato al nome di prima, senza salvare: niente su disco.
  const back = renamed(renamed(d0, "risacca", "marea"), "marea", "risacca");
  assert("rinominato e riportato indietro prima del salvataggio: niente da creare, niente da cancellare",
    eq(Y.importCreates(back, disk), []) && eq(Y.importOrphans(back, disk), [])
      && eq(Y.changedImports(Y.serializeImports(back).files, disk), {}),
    JSON.stringify([Y.importCreates(back, disk), Y.importOrphans(back, disk)]));
  assert("...e il master e' quello di prima", eq(masterDoc(back).streams, masterDoc(d0).streams),
    JSON.stringify(masterDoc(back).streams));

  // Salvato (marea creato, risacca cancellato), poi undo: lo stato torna a
  // risacca, che su disco non c'e' piu' — si riscrive — e marea e' orfano.
  const d1 = renamed(d0, "risacca", "marea");
  const saved = { ...diskOf(d1) };          // cio' che il salvataggio lascia ricordato
  assert("dopo il salvataggio il disco ricordato non ha piu' il file vecchio",
    !("streams/risacca.yml" in saved) && "streams/marea.yml" in saved);
  const bodies = Y.changedImports(Y.serializeImports(d0).files, saved);
  assert("undo dopo il salvataggio: il file di prima si riscrive (non si crea: non e' nuovo)",
    "streams/risacca.yml" in bodies && eq(Y.importCreates(d0, saved), []), JSON.stringify(Object.keys(bodies)));
  assert("...e quello rinominato e' orfano", eq(Y.importOrphans(d0, saved), ["streams/marea.yml"]));
  assert("redo: il file rinominato c'e' gia' su disco, non si ricrea",
    eq(Y.importCreates(d1, saved), []) && eq(Y.importOrphans(d1, saved), []));

  // La copia incollata e non ancora salvata, rinominata: il file nuovo e'
  // ancora da creare, e quello del nome di prima non e' mai esistito.
  const src = d0.streams.find(s => s.id === "risacca");
  const pasted = { ...d0, streams: [...d0.streams, Y.copyImport(JSON.parse(JSON.stringify(src)), "stream7")] };
  const p1 = renamed(pasted, "stream7", "eco");
  assert("una copia non salvata, rinominata, e' un file da creare col nome nuovo e basta",
    eq(Y.importCreates(p1, disk), ["streams/eco.yml"]) && eq(Y.importOrphans(p1, disk), []),
    JSON.stringify([Y.importCreates(p1, disk), Y.importOrphans(p1, disk)]));
}

console.log("\n── la rinomina ricorda da quale file viene: la guardia segue lo spostamento ──");
{
  /* Rinominare sposta lo stream in un file nuovo, e il vecchio diventa un
   * orfano da cancellare. Ma il vecchio e' anche cio' che il laboratorio puo'
   * avere aperto: se lo salva fra la rinomina e il salvataggio qui, il file
   * nuovo nasceva dalla versione di PGE-ui e il lavoro del laboratorio restava
   * nell'orfano (`kept`, cambiato). La rinomina ricorda la sua provenienza
   * (`_import.from`): finche' il file vecchio e' nel disco ricordato, e' una
   * lettura che le scritture rispettano come quella di ogni file importato —
   * si manda la sua firma, e se e' cambiato si rilegge DENTRO lo stream
   * rinominato, o si chiede. */
  const d0 = open(), disk = diskOf(d0);
  const d1 = { ...d0, streams: d0.streams.map(s => (s.id === "risacca" ? Y.renameImport(s, "marea", d0.streams, disk) : s)) };
  const s1 = d1.streams.find(s => s.id === "marea");
  assert("renameImport col disco ricordato: lo stream rinominato sa da quale file viene",
    !!s1 && !!s1._import.from && s1._import.from.file === "streams/risacca.yml",
    JSON.stringify(s1 && s1._import.from));
  assert("...e col piazzamento che aveva DENTRO quel file (lo stream_id vecchio)",
    !!s1 && s1._import.from && s1._import.from.place.stream_id === "risacca"
      && s1._import.place.stream_id === "marea", JSON.stringify(s1 && s1._import));

  // Il file vecchio come l'editor lo scriverebbe adesso: senza modifiche
  // proprie e' quello che si sa su disco.
  const src1 = Y.importMoveSources(d1, disk);
  assert("importMoveSources: il file vecchio, com'era — la rinomina da sola non e' lavoro su quel file",
    eq(Object.keys(src1), ["streams/risacca.yml"]) && src1["streams/risacca.yml"] === disk["streams/risacca.yml"],
    JSON.stringify(Object.keys(src1)));
  const edited = { ...d1, streams: d1.streams.map(s => (s.id === "marea" ? { ...s, volume: -1 } : s)) };
  assert("...un volume toccato dopo la rinomina e' lavoro proprio anche sul file vecchio",
    Object.keys(Y.changedImports(Y.importMoveSources(edited, disk), disk)).length === 1);
  assert("importReadFiles col disco: le letture da rispettare comprendono il file vecchio",
    eq(Y.importReadFiles(d1, disk), ["streams/marea.yml", "streams/onda.yml", "streams/risacca.yml"]),
    JSON.stringify(Y.importReadFiles(d1, disk)));
  assert("...senza disco, sono i file degli stream e basta (com'era)",
    eq(Y.importReadFiles(d1), ["streams/marea.yml", "streams/onda.yml"]));
  assert("il file vecchio resta orfano: la provenienza non lo nomina",
    eq(Y.importOrphans(d1, disk), ["streams/risacca.yml"]));

  // Finche' il file vecchio e' su disco, anche dopo un render che ha gia'
  // scritto quello nuovo: il render non cancella, il laboratorio puo' ancora
  // salvare il vecchio, e la prossima scrittura deve vederlo.
  const afterRender = { ...disk, ...diskOf(d1) };
  assert("dopo un render (il file nuovo scritto, il vecchio no), il vecchio e' ancora una provenienza",
    eq(Object.keys(Y.importMoveSources(d1, afterRender)), ["streams/risacca.yml"]));
  // Cancellato dal salvataggio, il file vecchio esce dal disco ricordato e
  // con lui la provenienza.
  const afterSave = { ...diskOf(d1) };
  assert("cancellato il file vecchio, niente piu' provenienza",
    eq(Y.importMoveSources(d1, afterSave), {}) && eq(Y.importReadFiles(d1, afterSave), ["streams/marea.yml", "streams/onda.yml"]));
  // Un salvataggio che chiude lo spostamento (il file vecchio cancellato o
  // rimasto) lo dice allo stato: `settleImportMoves`.
  const settled = Y.settleImportMoves(d1, ["streams/risacca.yml"]);
  assert("settleImportMoves toglie la provenienza dei file chiusi",
    !settled.streams.find(s => s.id === "marea")._import.from
      && eq(Y.importMoveSources(settled, afterRender), {}));
  assert("...e lascia lo stesso oggetto quando non c'e' niente da chiudere",
    Y.settleImportMoves(d0, ["streams/risacca.yml"]) === d0
      && Y.settleImportMoves(d1, ["streams/onda.yml"]) === d1);

  // Una copia mai salvata, rinominata: il nome di prima non e' mai stato su
  // disco, e non c'e' una lettura da rispettare.
  const src = d0.streams.find(s => s.id === "risacca");
  const pasted = { ...d0, streams: [...d0.streams, Y.copyImport(JSON.parse(JSON.stringify(src)), "stream7")] };
  const p1 = { ...pasted, streams: pasted.streams.map(s => (s.id === "stream7" ? Y.renameImport(s, "eco", pasted.streams, disk) : s)) };
  assert("una copia mai salvata, rinominata, non ha provenienza",
    !p1.streams.find(s => s.id === "eco")._import.from && eq(Y.importMoveSources(p1, disk), {}));
  // Rinominata due volte prima di salvare: la provenienza e' il file che c'e'
  // su disco, non il nome di passaggio.
  const twice = { ...d1, streams: d1.streams.map(s => (s.id === "marea" ? Y.renameImport(s, "bonaccia", d1.streams, disk) : s)) };
  const tw = twice.streams.find(s => s.id === "bonaccia");
  assert("rinominata due volte: la provenienza resta il file su disco",
    tw._import.file === "streams/bonaccia.yml" && tw._import.from.file === "streams/risacca.yml"
      && tw._import.from.place.stream_id === "risacca", JSON.stringify(tw._import.from));
  // ...e riportata al nome di prima: il file e' di nuovo il suo, niente da
  // seguire.
  const backAgain = { ...d1, streams: d1.streams.map(s => (s.id === "marea" ? Y.renameImport(s, "risacca", d1.streams, disk) : s)) };
  assert("riportata al nome di prima, la provenienza se ne va: il file e' di nuovo il suo",
    !backAgain.streams.find(s => s.id === "risacca")._import.from && eq(Y.importMoveSources(backAgain, disk), {}));
  // Senza disco (un chiamante di prima), conta come su disco un file letto
  // all'apertura: non `fresh`.
  assert("renameImport senza disco: un file letto all'apertura e' una provenienza",
    Y.renameImport(src, "marea", d0.streams)._import.from.file === "streams/risacca.yml");
}

console.log("\n── la rilettura del file vecchio entra nello stream rinominato ──");
{
  const d0 = open(), disk = diskOf(d0);
  const d1 = { ...d0, streams: d0.streams.map(s => (s.id === "risacca" ? Y.renameImport(s, "marea", d0.streams, disk) : s)) };
  // Il laboratorio salva il file vecchio: il volume cambia.
  const labText = lab("risacca").replace("volume: -6", "volume: -3");
  const out = Y.rereadImport(d1, "streams/risacca.yml", labText, { project: "brano" });
  assert("rereadImport sul file vecchio: torna un documento", !!out.data && !out.error, out.error);
  const s = out.data.streams.find(x => x.id === "marea");
  assert("...lo stream rinominato prende il contenuto del laboratorio", !!s && s.volume === -3, JSON.stringify(s && s.volume));
  assert("...e resta rinominato: l'id, il file nuovo da creare, la voce del master",
    s.id === "marea" && s._import.file === "streams/marea.yml" && s._import.fresh === true
      && eq(masterDoc(out.data).streams[0], { file: "streams/marea.yml", onset: 2.5 }),
    JSON.stringify(s._import));
  const doc = fileDoc(out.data, "streams/marea.yml");
  assert("...il file nuovo dice cio' che dice quello del laboratorio, con lo stream_id del suo nome",
    doc.streams[0].stream_id === "marea" && doc.streams[0].volume === -3, JSON.stringify(doc));
  const src = Y.importMoveSources(out.data, disk);
  assert("...e il file vecchio, come l'editor lo scriverebbe adesso, e' quello del laboratorio",
    !!src["streams/risacca.yml"] && jsyaml.load(src["streams/risacca.yml"]).streams[0].volume === -3
      && jsyaml.load(src["streams/risacca.yml"]).streams[0].stream_id === "risacca",
    src["streams/risacca.yml"]);
  assert("...gli altri stream sono gli stessi oggetti",
    out.data.streams.filter(x => x.id !== "marea").every((x, i) => x === d1.streams.filter(y => y.id !== "marea")[i]));
}

/* ===========================================================================
 * 2. Il backend
 * ======================================================================== */
console.log("\n── backend: deleteImports con le firme lette, e cosa resta dopo ──");
{
  const be = window.PGEBackend.create({ baseUrl: "http://bridge" });
  await be.fs.readImport("streams/risacca.yml");
  await be.fs.readImport("streams/onda.yml");
  ANSWER = { deleted: ["streams/risacca.yml"], absent: [], kept: [] };
  const r = await be.fs.save("brano", "streams: []\n", {}, { remove: ["streams/risacca.yml", "streams/mai-letto.yml"] });
  const body = SAVES[SAVES.length - 1];
  assert("i file da cancellare vanno al bridge con la firma con cui sono stati letti",
    eq(body.deleteImports, { "streams/risacca.yml": "sha256:streams/risacca.yml", "streams/mai-letto.yml": "" }),
    JSON.stringify(body.deleteImports));
  assert("la risposta dice cosa e' stato cancellato",
    eq(r.deleted, ["streams/risacca.yml"]) && eq(r.absent, []) && eq(r.kept, []), JSON.stringify(r));
  assert("la firma di un file cancellato si dimentica",
    be.fs.signature("import", "streams/risacca.yml") === null
      && be.fs.signature("import", "streams/onda.yml") === "sha256:streams/onda.yml");

  await be.fs.readImport("streams/risacca.yml");
  ANSWER = { deleted: [], absent: ["streams/risacca.yml"],
             kept: [{ file: "streams/onda.yml", reason: "imported", detail: "lo importa ancora b.yml", by: ["b.yml"] }] };
  const r2 = await be.fs.save("brano", "streams: []\n", {}, { remove: ["streams/risacca.yml", "streams/onda.yml"] });
  assert("un file che non c'era gia' piu' perde la firma; uno rimasto la tiene",
    be.fs.signature("import", "streams/risacca.yml") === null
      && be.fs.signature("import", "streams/onda.yml") === "sha256:streams/onda.yml");
  assert("...e i rimasti tornano con la ragione", r2.kept.length === 1 && r2.kept[0].reason === "imported",
    JSON.stringify(r2.kept));

  ANSWER = {};
  const r3 = await be.fs.save("brano", "streams: []\n", {}, {});
  assert("senza niente da cancellare il campo non parte", !("deleteImports" in SAVES[SAVES.length - 1]));
  assert("...e la risposta ha liste vuote", eq([r3.deleted, r3.absent, r3.kept], [[], [], []]), JSON.stringify(r3));

  // Un bridge piu' vecchio di #208 non conosce il campo e non risponde: la
  // risposta lo dice (`deleted: null`), e nessuna firma si dimentica.
  ANSWER = null;
  const r4 = await be.fs.save("brano", "streams: []\n", {}, { remove: ["streams/onda.yml"] });
  assert("un bridge che non risponde sulle cancellazioni torna deleted: null",
    r4.deleted === null && eq(r4.kept, []) && be.fs.signature("import", "streams/onda.yml") === "sha256:streams/onda.yml",
    JSON.stringify(r4));
}

/* ===========================================================================
 * 3. Il cablaggio in app.jsx e Inspector.jsx (guardie sorgente)
 * ======================================================================== */
console.log("\n── app.jsx: la rinomina sposta il file, il salvataggio cancella gli orfani ──");
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

  const rn = fnBody("async function renameStream(");
  assert("renameStream e' asincrona: chiede la cartella prima di scegliere il file nuovo", !!rn);
  const list = rn.indexOf("listImportNames(");
  const taken = rn.indexOf("importIdTaken(");
  const upd = rn.indexOf("setData(");
  assert("...elenca la cartella e controlla il nome PRIMA di scrivere lo stato",
    list > 0 && taken > list && upd > taken, `list@${list} taken@${taken} setData@${upd}`);
  assert("...con i file su disco ricordati e quelli del documento, non solo l'elenco",
    /importDiskRef\.current/.test(rn) && /importFilesOf\(/.test(rn));
  assert("...e la provenienza nuova la da' renameImport, dentro l'updater, sullo stato di ADESSO",
    /setData\(d => \{[\s\S]*?renameImport\(s, newId, d\.streams[,)]/.test(rn));
  assert("...col disco ricordato: e' lui a dire se il file vecchio e' una lettura da seguire",
    /setData\(d => \{[\s\S]*?renameImport\(s, newId, d\.streams, importDiskRef\.current\)/.test(rn));
  assert("...l'elenco solo quando il file si sposta (uno stream nel master non fa giri di rete)",
    /importRenameFile\(/.test(rn) && rn.indexOf("importRenameFile(") < list);
  // Dopo l'await lo stato puo' essere un altro (lo stream cancellato, un undo,
  // il nome preso da un incolla o da un'altra rinomina): l'updater qui sotto
  // non scriverebbe niente, ma la funzione andava avanti lo stesso — il log di
  // uno spostamento mai avvenuto, il progetto sporco, i disegni della clip
  // buttati, e null all'Inspector, che lasciava nel campo un nome che lo
  // stream non ha. La regola dello split (#187): dopo l'await si rilegge lo
  // stato di ADESSO (`dataRef.current`), e se non regge si rinuncia con un
  // messaggio, prima di setData.
  const after = rn.slice(list, upd);
  assert("...e dopo l'elenco rilegge lo stato di ADESSO: lo stream c'e' ancora, il nome e' ancora libero",
    /dataRef\.current\.streams\.some\(s => s\.id === oldId\)/.test(after)
      && /dataRef\.current\.streams\.some\(s => s\.id === newId\)/.test(after), after.slice(0, 400));
  assert("...e se non regge risponde un messaggio all'Inspector, prima di scrivere lo stato",
    /return\s*`/.test(after.slice(after.indexOf("dataRef.current.streams.some(s => s.id === oldId)"))));

  const save = fnBody("async function saveProject(");
  assert("il salvataggio manda al bridge i file orfani (importOrphans contro il disco ricordato)",
    /remove:\s*\w+/.test(save) && /importOrphans\(/.test(app));
  const orphans = fnBody("function importRemovals(");
  assert("...decisi contro importDiskRef, non contro la storia",
    /importOrphans\([^)]*importDiskRef\.current\)/.test(orphans), orphans.slice(0, 200));
  const settle = fnBody("function settleRemovals(");
  assert("...e dopo la risposta il disco ricordato dimentica cio' che non c'e' piu' (cancellato o assente)",
    /settleRemovals\(rem, res\)/.test(save)
      && /forgetImports\(\[\.\.\.res\.deleted, \.\.\.res\.absent\]\)/.test(settle));
  assert("...ma non quando il bridge non ha risposto sul campo (piu' vecchio di #208): li' non e' cambiato niente",
    settle.indexOf("res.deleted === null") > 0
      && settle.indexOf("res.deleted === null") < settle.indexOf("forgetImports("));
  assert("...e solo dopo un salvataggio riuscito: dopo markImportsWritten, mai su un rifiuto",
    save.indexOf("settleRemovals(") > save.indexOf("markImportsWritten(")
      && save.indexOf("settleRemovals(") > save.indexOf('out.outcome !== "done"'));
  const saveAs = fnBody("async function saveProjectAs(");
  assert("Save As non cancella: il master di prima importa ancora tutto",
    !!saveAs && !/remove:/.test(saveAs) && !/importRemovals\(/.test(saveAs));
  const rr = fnBody("async function runRender(");
  assert("il render non cancella: scrive cio' che il motore rilegge e basta",
    !!rr && !/remove:/.test(rr) && !/importRemovals\(/.test(rr) && !/deleteImports/.test(rr));

  const del = fnBody("function deleteStream(id)");
  assert("deleteStream resta una mutazione di soli dati: niente rete, niente disco",
    !!del && !/backend\./.test(del) && !/fetch\(/.test(del));

  // La grafia morta `dephase`: il file resta nel disco ricordato col testo
  // letto (che non e' mai la serializzazione), cosi' si riscrive al primo
  // salvataggio E, se lo stream si cancella prima, e' un orfano come gli altri.
  const sel = fnBody("async function onProjectSelect(");
  assert("all'apertura un file con `dephase` resta nel disco ricordato, col testo letto",
    /deviationProbabilityLegacy\)\s*disk\[st\._import\.file\]\s*=\s*imports\[st\._import\.file\]\.text/.test(sel)
      && !/deviationProbabilityLegacy\)\s*delete disk\[/.test(sel), "");
  const rri = fnBody("async function rereadImportFile(");
  assert("...anche alla rilettura di quel file (#185)",
    /deviationProbabilityLegacy\)\)\s*\{\s*disk\[file\]\s*=\s*r\.text/.test(rri), "");

  // La guardia segue lo spostamento: il file vecchio di uno stream rinominato
  // e' una lettura da rispettare finche' e' nel disco ricordato.
  const guard = fnBody("function importGuard(");
  assert("importGuard manda anche la firma del file vecchio: importReadFiles col disco ricordato",
    /importReadFiles\(doc, importDiskRef\.current\)/.test(guard), guard.slice(0, 300));
  const own = fnBody("function fileHasOwnChanges(");
  const ownImp = own.slice(own.indexOf("if (name !== master)"));
  assert("fileHasOwnChanges: un file che nessuno stream importa ma da cui uno e' venuto si confronta com'e' adesso",
    /importMoveSources\(d, importDiskRef\.current\)/.test(ownImp.slice(0, ownImp.indexOf("FG.ownChanges("))),
    ownImp.slice(0, 600));
  assert("rereadImportFile: il disco ricordato del file vecchio e' quello appena letto, nella forma dell'editor",
    /importMoveSources\(out\.data, importDiskRef\.current\)/.test(rri), "");
  const saveOk = save.slice(save.indexOf('out.outcome !== "done"'));
  assert("il salvataggio chiude gli spostamenti dei file che ha chiesto di cancellare",
    /settleImportMoves\([^)]*rem\)/.test(saveOk), "");
  assert("...Save As e il render no: il file vecchio non l'hanno toccato",
    !/settleImportMoves\(/.test(saveAs) && !/settleImportMoves\(/.test(rr));

  const insp = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));
  assert("l'Inspector aspetta la risposta della rinomina (ora una Promise)",
    /Promise\.resolve\(onRename\(/.test(insp));
}

})().catch(e => {
  fail++;
  console.error("FAIL  il corpo della suite e' morto a meta'\n      " + (e && e.stack ? e.stack : String(e)));
});
