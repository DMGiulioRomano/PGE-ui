/* =============================================================================
 * test-stream-own-file.js — un file suo per uno stream importato (PGE-ui #205).
 *
 * Lo stesso file importato da piu' voci del master e' un documento solo: le
 * voci differiscono nel piazzamento e basta. Una modifica di contenuto su una
 * voce sola fa divergere le copie in memoria, e salvataggio e render si
 * rifiutano (#184). Il rimedio che mancava — il messaggio di conflitto lo
 * prometteva («stacca uno degli stream dal file») e nessun gesto lo faceva — e'
 * dare alla voce un file suo: `<cartella del file>/<id>.yml`, lo STESSO id
 * (quindi la stessa realizzazione e lo stesso fingerprint del motore), la voce
 * del master `file: <nuovo>` senza `stream_id`.
 *
 * Le due domande aperte della issue, decise:
 *   1. il nome e' preso → il gesto si rifiuta. Un `<id>-2.yml` con
 *      `stream_id: <id>` terrebbe la realizzazione nel brano, ma il
 *      laboratorio di mare-nostrum scrive l'id dal nome del file: lo
 *      aprirebbe gia' modificato, con un'altra realizzazione;
 *   2. vale anche per un file di una voce sola, se il suo nome non e' l'id:
 *      e' la rinomina del FILE che tiene l'id, e il file vecchio diventa un
 *      orfano come quello di una rinomina (#208). Dove il file ha gia' il nome
 *      dell'id e nessun altro lo importa, non c'e' niente da fare.
 *
 * Qui si pretende:
 *   1. il modello (`yaml-bridge.js`): `importOwnFile` (il piano o il perche'
 *      no) e `ownFileImport` (lo stream col file suo), e cosa ne segue per il
 *      salvataggio — il file da creare, l'orfano, il conflitto sciolto;
 *   2. il cablaggio in app.jsx e nell'Inspector, con guardie sorgente: il
 *      gesto chiede la cartella prima di scrivere lo stato e rilegge lo stato
 *      di adesso dopo l'attesa, e il messaggio di conflitto e il rifiuto dello
 *      split nominano il gesto.
 *
 * Che il motore veda lo stesso stream lo chiede
 * tests/parity/test-stream-own-file-parity.js; il giro nel browser
 * tests/e2e/test-boot.js.
 *
 * Run: node test-stream-own-file.js (from tests/node/ after npm install)
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

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
const Y = window.PGEYaml;

const VOCI = "seed: 1441\nduration: 4\nstreams:\n- stream_id: voci\n  onset: 0\n  duration: 4\n" +
             "  sample: onda.wav\n  volume: -6\n  pointer:\n    start: 0\n    loop_unit: normalized\n";
const RISACCA = "seed: 1441\nstreams:\n- stream_id: risacca\n  duration: 3\n  sample: onda.wav\n  volume: -3\n";
const SHARED =
  "streams:\n" +
  "  - file: streams/voci.yml\n    stream_id: coro\n    onset: 0\n" +
  "  - file: streams/voci.yml\n    stream_id: alto\n    onset: (2*2)\n    mute: false\n" +
  "  - file: streams/risacca.yml\n    onset: 2\n";
const open = (master, files) => Y.parse(master, { project: "brano", samples: [],
  imports: Object.fromEntries(Object.entries(files).map(([f, t]) => [f, { text: t }])) });
const FILES = { "streams/voci.yml": VOCI, "streams/risacca.yml": RISACCA };

/* ===========================================================================
 * 1. Il modello
 * ======================================================================== */
console.log("\n── importOwnFile: il piano, o il perche' no ──");
{
  const d = open(SHARED, FILES);
  const byId = (id) => d.streams.find(s => s.id === id);
  const coro = Y.importOwnFile(byId("coro"), d.streams);
  assert("il file condiviso: coro prende streams/coro.yml",
    coro.file === "streams/coro.yml" && coro.shared === true && eq(coro.others, ["alto"]), JSON.stringify(coro));
  assert("…e alto streams/alto.yml",
    Y.importOwnFile(byId("alto"), d.streams).file === "streams/alto.yml");
  const ris = Y.importOwnFile(byId("risacca"), d.streams);
  assert("un file di una voce sola che ha gia' il nome dell'id: niente da fare, e lo dice",
    !ris.file && /gia' il file di questo stream/.test(ris.reason) && eq(ris.others, []), JSON.stringify(ris));

  // Il file condiviso ha gia' il nome di una delle voci: il gesto e' dell'altra.
  const d2 = open("streams:\n  - file: streams/coro.yml\n  - file: streams/coro.yml\n    stream_id: alto\n",
                  { "streams/coro.yml": VOCI.replace("stream_id: voci", "stream_id: coro") });
  const c2 = Y.importOwnFile(d2.streams.find(s => s.id === "coro"), d2.streams);
  assert("il file condiviso ha gia' il nome di coro: il gesto su coro nomina l'altra voce",
    !c2.file && /alto/.test(c2.reason) && /all'altro stream/.test(c2.reason), JSON.stringify(c2));
  assert("…che invece un file suo lo puo' prendere",
    Y.importOwnFile(d2.streams.find(s => s.id === "alto"), d2.streams).file === "streams/alto.yml");

  // Uno stream scritto nel master non ha un file.
  const d3 = Y.parse("streams:\n  - stream_id: riva\n    duration: 2\n    sample: onda.wav\n", { project: "b", samples: [] });
  assert("uno stream scritto nel master: niente gesto", !Y.importOwnFile(d3.streams[0], d3.streams).file);

  // Un id che non e' un nome di file: lo stesso alfabeto della rinomina.
  const strano = { ...byId("coro"), id: "a/b" };
  const r = Y.importOwnFile(strano, d.streams);
  assert("un id che non e' un nome di file: il gesto si rifiuta e dice perche'",
    !r.file && /nome di file/.test(r.reason), JSON.stringify(r));
  assert("…e l'alfabeto e' quello della rinomina, una regola sola",
    Y.STREAM_ID_RE instanceof RegExp && Y.STREAM_ID_RE.test("coro-2.b_c") && !Y.STREAM_ID_RE.test(".x") &&
    !Y.STREAM_ID_RE.test("a b"));
}

console.log("\n── ownFileImport: il trasloco, sul file condiviso ──");
{
  const d = open(SHARED, FILES);
  const disk = Y.serializeImports(d).files;
  const coro0 = d.streams.find(s => s.id === "coro");
  const moved = Y.ownFileImport(coro0, d.streams, disk);
  assert("lo stream tiene il suo id, e il file nuovo e' il suo nome",
    moved.id === "coro" && moved._import.file === "streams/coro.yml");
  assert("…un file da creare, non da sovrascrivere", moved._import.fresh === true);
  assert("…e niente provenienza: il file vecchio resta di alto, e una sua rilettura non deve finire qui",
    !("from" in moved._import), JSON.stringify(moved._import.from));
  assert("la voce del master: il file nuovo, il piazzamento com'era scritto, senza stream_id",
    eq(moved._import.entry, { file: "streams/coro.yml", onset: 0 }), JSON.stringify(moved._import.entry));
  assert("il gesto non tocca l'oggetto di prima (l'undo lo ritrova com'era)",
    coro0._import.file === "streams/voci.yml" && !coro0._import.fresh);

  const data = { ...d, streams: d.streams.map(s => (s === coro0 ? moved : s)) };
  const imp = Y.serializeImports(data);
  assert("due documenti, nessun conflitto", imp.conflicts.length === 0 &&
    Object.keys(imp.files).sort().join(",") === "streams/coro.yml,streams/risacca.yml,streams/voci.yml",
    JSON.stringify(Object.keys(imp.files)));
  const doc = window.jsyaml.load(imp.files["streams/coro.yml"]);
  assert("il file nuovo e' un documento del laboratorio: la testa del file, stream_id = il suo nome",
    doc.seed === 1441 && doc.streams.length === 1 && doc.streams[0].stream_id === "coro" &&
    doc.streams[0].volume === -6, JSON.stringify(doc));
  assert("voci.yml resta com'era: lo scrive alto", imp.files["streams/voci.yml"] === disk["streams/voci.yml"]);
  assert("il file nuovo si crea al salvataggio (importCreates)",
    eq(Y.importCreates(data, disk), ["streams/coro.yml"]));
  assert("…e il vecchio non e' un orfano: lo importa ancora alto", eq(Y.importOrphans(data, disk), []));
  const master = window.jsyaml.load(Y.serialize(data));
  assert("il master: la voce di coro col file nuovo e senza stream_id, alto com'era scritto",
    eq(master.streams[0], { file: "streams/coro.yml", onset: 0 }) &&
    eq(master.streams[1], { file: "streams/voci.yml", stream_id: "alto", onset: "(2*2)", mute: false }),
    JSON.stringify(master.streams));

  // Il conflitto che il gesto scioglie: una modifica su coro sola.
  const edited = { ...d, streams: d.streams.map(s => (s.id === "coro" ? { ...s, volume: -20 } : s)) };
  assert("una modifica su coro sola: voci.yml in conflitto",
    eq(Y.serializeImports(edited).conflicts, ["streams/voci.yml"]));
  const fixed = { ...edited, streams: edited.streams.map(s => (s.id === "coro" ? Y.ownFileImport(s, edited.streams, disk) : s)) };
  const fi = Y.serializeImports(fixed);
  assert("…il file suo lo scioglie, e la modifica va nel file nuovo",
    fi.conflicts.length === 0 && window.jsyaml.load(fi.files["streams/coro.yml"]).streams[0].volume === -20 &&
    fi.files["streams/voci.yml"] === disk["streams/voci.yml"]);
  // Annullato prima del salvataggio: lo stato di prima non crea niente.
  assert("annullato prima del salvataggio, non c'e' niente da creare", eq(Y.importCreates(d, disk), []));
}

console.log("\n── ownFileImport: il file di una voce sola, col nome che non e' l'id ──");
{
  const d = open("streams:\n  - file: streams/voci.yml\n    stream_id: coro\n    onset: 3\n", FILES);
  const disk = Y.serializeImports(d).files;
  const moved = Y.ownFileImport(d.streams[0], d.streams, disk);
  assert("coro prende streams/coro.yml, con lo stesso id",
    moved.id === "coro" && moved._import.file === "streams/coro.yml" && moved._import.fresh === true);
  assert("…e segue il file che lascia, come una rinomina (#208): il laboratorio puo' salvarlo prima",
    moved._import.from && moved._import.from.file === "streams/voci.yml");
  const data = { ...d, streams: [moved] };
  assert("voci.yml, che nessuno importa piu', si cancella al salvataggio",
    eq(Y.importOrphans(data, disk), ["streams/voci.yml"]));
  assert("…ed e' una lettura che le scritture rispettano finche' non si cancella",
    Y.importReadFiles(data, disk).includes("streams/voci.yml"));
  const same = Y.ownFileImport(moved, data.streams, disk);
  assert("dato il file suo, il gesto non ha piu' niente da fare", same === moved);
}

/* ===========================================================================
 * 2. Il cablaggio (guardie sorgente)
 * ======================================================================== */
console.log("\n── app.jsx e Inspector: il gesto ──");
{
  const app = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
  const fnBody = (name) => {
    const i = app.indexOf(name);
    if (i < 0) return "";
    const open = app.indexOf("{", app.indexOf(")", i));
    let depth = 0;
    for (let j = open; j < app.length; j++) {
      if (app[j] === "{") depth++;
      else if (app[j] === "}" && --depth === 0) return app.slice(i, j + 1);
    }
    return app.slice(i);
  };
  const g = fnBody("async function giveOwnFile(");
  assert("giveOwnFile esiste, ed e' asincrono", g.length > 0);
  assert("chiede la cartella PRIMA di scrivere lo stato",
    g.indexOf("listImportNames(") > 0 && g.indexOf("listImportNames(") < g.indexOf("setData("), g.slice(0, 300));
  assert("…dopo l'attesa rilegge lo stato di adesso (dataRef), non la closure",
    /dataRef\.current\.streams/.test(g.slice(g.indexOf("listImportNames("), g.indexOf("setData("))));
  assert("…e rifiuta un nome preso con l'oracolo dell'incolla e della rinomina",
    /importIdTaken\(/.test(g) && /importDiskRef\.current/.test(g) && /importFilesOf\(/.test(g));
  assert("il trasloco si decide dentro l'updater, sugli stream di adesso",
    /setData\(d\s*=>[\s\S]*ownFileImport\(/.test(g));
  assert("la rinomina usa lo stesso alfabeto del gesto (una regola sola)",
    /STREAM_ID_RE\.test\(/.test(fnBody("async function renameStream(")));
  // L'elemento JSX intero, dagli attributi alla chiusura: le graffe contano,
  // perche' dentro un attributo `=>` ha il suo `>`.
  const elementsOf = (tag) => {
    const out = [];
    for (let i = app.indexOf(`<${tag}`); i >= 0; i = app.indexOf(`<${tag}`, i + 1)) {
      if (/\w/.test(app[i + tag.length + 1] || "")) continue;
      let depth = 0, j = i + 1;
      for (; j < app.length; j++) {
        if (app[j] === "{") depth++;
        else if (app[j] === "}") depth--;
        else if (depth === 0 && app[j] === ">") break;
      }
      out.push(app.slice(i, j + 1));
    }
    return out;
  };
  const inspectors = elementsOf("Inspector");
  assert("l'Inspector riceve il piano e il gesto, su ogni suo elemento",
    inspectors.length > 0
      && inspectors.every(e => /\bownFile=\{[\s\S]*importOwnFile\(/.test(e) && /\bonOwnFile=\{[\s\S]*giveOwnFile\(/.test(e)),
    `${inspectors.length} elementi`);
  assert("...e nessun altro componente: il gesto e' una riga dell'Inspector",
    elementsOf("EnvelopeEditor").every(e => !/\bownFile=|\bonOwnFile=/.test(e)));
  const insp = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));
  assert("l'Inspector ha il bottone «file suo» sulla riga file, e mostra il messaggio che torna",
    /onOwnFile\(/.test(insp) && /file suo/.test(insp) && /setFileError\(/.test(insp));
  /* Il bottone spento: il perche' sta in una riga, non solo nel `title`, che
     sui bottoni disabilitati Chrome e Safari non mostrano; e .pge-btn ha uno
     stile per :disabled, o il ghost spento sembrava acceso. */
  assert("il perche' del bottone spento e' scritto in una riga dell'Inspector",
    /\{ownFile\.reason\}/.test(insp));
  const css = fs.readFileSync(path.join(__dirname, "../../styles/editor.css"), "utf8");
  assert("…e .pge-btn disabilitato si legge dal bottone",
    /\.pge-btn:disabled\s*\{[^}]*opacity/.test(css) && /\.pge-btn\.ghost:hover:not\(:disabled\)/.test(css));

  const iw = fnBody("function importWrites(");
  assert("il messaggio di conflitto nomina il gesto, e non uno «stacca» che non c'e'",
    /file suo/.test(iw) && !/stacca/.test(iw), iw.slice(0, 500));
  const sp = fnBody("async function splitAtPlayhead(");
  assert("il rifiuto dello split nomina il gesto",
    /importConflictText\(/.test(sp) && /file suo/.test(sp.slice(sp.indexOf("importConflictsAdded("), sp.indexOf("await listImportNames("))));
}
