/* =============================================================================
 * test-stream-split.js — lo split di uno stream importato: la testa resta nel
 * suo file, la coda in un file nuovo (PGE-ui #187, regola 6 del piano "stream
 * come file" di mare-nostrum#2).
 *
 * Con #184 lo split al cursore di uno stream importato con
 * `- file: streams/risacca.yml` accorciava la testa nel suo file e staccava la
 * coda (`detachImport`), scrivendola per intero nel master. Adesso la coda e'
 * un file nuovo accanto a quello della testa, `streams/risacca-2.yml`, e il
 * master la importa con una voce `file:` sua, all'onset della coda. Il nome,
 * e con lui l'id, e' `<nome>-N`: il primo N da 2 in su che non e' gia' un
 * file della cartella, non e' l'id di uno stream vivo e non ha uno stem.
 *
 * Qui si pretende:
 *
 *   1. l'allocazione (`allocStreamIds` con le basi): `<nome>-2`, poi `-3`,
 *      `-4`..., saltando gli id vivi, quelli con uno stem e i nomi di file
 *      presi; lo stesso giro dei `streamN` quando la base non c'e';
 *   2. il modello dello split, fatto come lo fa app.jsx con le stesse funzioni
 *      della libreria: il file della testa accorciato, il file nuovo con la
 *      coda (un documento del laboratorio a se': uno stream, `stream_id` =
 *      nome del file, il seed dell'originale), il master con due voci
 *      `file:`, e niente su disco finche' non si salva;
 *   3. il cablaggio in app.jsx, con guardie sorgente: lo split chiede la
 *      cartella al bridge prima di scegliere il nome — solo se c'e' uno stream
 *      importato da tagliare — e la coda prende la provenienza nuova.
 *
 * Il giro intero (split, salvataggio, undo, il numero dopo quando il nome e'
 * su disco, un undo prima del salvataggio) gira nel browser vero:
 * tests/e2e/test-boot.js.
 *
 * Run: node test-stream-split.js (from tests/node/ after npm install)
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
for (const f of ["yaml-bridge.js", "envelope-loops.js", "deviation-probability.js", "envelope-utils.js"]) {
  eval(fs.readFileSync(path.join(__dirname, "../../src/lib", f), "utf8"));
}

const Y = window.PGEYaml;
const EU = window.PGEEnvUtils;
const jsyaml = window.jsyaml;

/* La fixture di test-stream-copy.js: un master che importa il documento del
 * laboratorio `streams/risacca.yml` e uno stream scritto dentro. */
const MASTER = `seed: 1441
streams:
  - file: streams/risacca.yml
    onset: 2.5
  - stream_id: riva
    onset: 0
    duration: 3
    sample: onda.wav
    density: 40
    pointer:
      start: 0
      loop_unit: normalized
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
const TAIL = "streams/risacca-2.yml";
const open = () => Y.parse(MASTER, { project: "brano", samples: [], imports: { [FILE]: { text: RISACCA } } });
const fileDoc = (data, file) => jsyaml.load(Y.serializeImports(data).files[file]);
const masterDoc = (data) => jsyaml.load(Y.serialize(data));

/* Lo split come lo fa splitAtPlayhead in app.jsx, sulle stesse funzioni della
 * libreria: la testa congelata (rescale + truncate), la coda tagliata
 * (slice) col `pointer.start` dove la testa si ferma, l'id dall'allocazione
 * con le basi e la provenienza nuova da `copyImport`. `taken` e' l'oracolo
 * (stem e file); `start` la posizione di lettura che app.jsx prende dal
 * sidecar dei grani. */
function split(data, id, t, start, taken = () => false) {
  const s = data.streams.find(x => x.id === id);
  const cutRel = t - s.onset;
  const head = { ...EU.truncateStreamEnvelopes(EU.rescaleStreamEnvelopes(s, s.duration, cutRel)),
                 duration: cutRel, durationImplicit: false, durationUnresolved: false };
  const sliced = EU.sliceStreamEnvelopes(s, cutRel / s.duration);
  const body = { ...sliced.stream, onset: t, duration: s.duration - cutRel,
                 durationImplicit: false, durationUnresolved: false,
                 pointer: { ...(sliced.stream.pointer || {}), start } };
  const bases = [Y.importSplitBase(s)];
  const [tailId] = Y.allocStreamIds(data.streams, bases, taken);
  const tail = Y.copyImport(body, tailId);
  return { ...data, streams: [...data.streams.map(x => (x.id === id ? head : x)), tail] };
}

/* ===========================================================================
 * 1. L'allocazione: `<nome>-N`
 * ======================================================================== */
console.log("\n── allocStreamIds con le basi: <nome>-2, poi il numero dopo ──");
{
  const live = [{ id: "risacca" }, { id: "riva" }];
  assert("la coda di risacca e' risacca-2", eq(Y.allocStreamIds(live, ["risacca"], () => false), ["risacca-2"]),
    JSON.stringify(Y.allocStreamIds(live, ["risacca"], () => false)));
  assert("un id vivo si salta: risacca-2 c'e', la coda e' risacca-3",
    eq(Y.allocStreamIds([...live, { id: "risacca-2" }], ["risacca"], () => false), ["risacca-3"]));
  assert("un id con uno stem si salta (l'oracolo di allocStreamIds)",
    eq(Y.allocStreamIds(live, ["risacca"], (id) => id === "risacca-2"), ["risacca-3"]));
  const files = ["streams/risacca.yml", "streams/Risacca-2.YAML", "streams/risacca-3.yml", "altrove/risacca-4.yml"];
  const fileTaken = (id) => Y.importIdTaken(id, ["streams"], files);
  assert("un nome di file preso nella cartella si salta, maiuscole ed estensione a parte",
    eq(Y.allocStreamIds(live, ["risacca"], fileTaken), ["risacca-4"]),
    JSON.stringify(Y.allocStreamIds(live, ["risacca"], fileTaken)));
  assert("due code dello stesso file nello stesso split: -2 e -3",
    eq(Y.allocStreamIds(live, ["risacca", "risacca"], () => false), ["risacca-2", "risacca-3"]));
  const mixed = Y.allocStreamIds(live, [null, "risacca", null], () => false);
  assert("una base null e' uno streamN, come sempre, e le due serie non si toccano",
    eq(mixed, [...Y.allocStreamIds(live, 2, () => false).slice(0, 1), "risacca-2",
               ...Y.allocStreamIds(live, 2, () => false).slice(1)]), JSON.stringify(mixed));
  assert("una lista di soli null e' il numero: stessi id",
    eq(Y.allocStreamIds(live, [null, null], (id) => id === "stream3"), Y.allocStreamIds(live, 2, (id) => id === "stream3")));
  assert("il numero resta il numero (default 1)", eq(Y.allocStreamIds(live), ["stream3"]));
}

console.log("\n── la base: il nome del file, non l'id dello stream ──");
{
  const d = open();
  assert("uno stream importato da streams/risacca.yml ha la base risacca",
    Y.importSplitBase(d.streams[0]) === "risacca", Y.importSplitBase(d.streams[0]));
  assert("uno stream scritto nel master non ne ha: la coda e' uno streamN", Y.importSplitBase(d.streams[1]) === null);
  const renamed = Y.parse(`streams:\n  - file: lab/vento.yaml\n    stream_id: alto\n`, { project: "x", samples: [],
    imports: { "lab/vento.yaml": { text: `seed: 7\nstreams:\n- stream_id: vento\n  duration: 2\n  sample: x.wav\n` } } });
  assert("con uno stream_id nel master conta il file: vento, non alto",
    renamed.streams[0].id === "alto" && Y.importSplitBase(renamed.streams[0]) === "vento",
    `${renamed.streams[0].id} / ${Y.importSplitBase(renamed.streams[0])}`);
  assert("nessuno stream, nessuna base", Y.importSplitBase(null) === null && Y.importSplitBase(undefined) === null);
}

/* ===========================================================================
 * 2. Il modello dello split
 * ======================================================================== */
console.log("\n── lo split di uno stream importato: la testa nel suo file, la coda in uno nuovo ──");
{
  const d = open();
  const disk0 = Y.serializeImports(d).files;                // il disco come l'apertura lo ricorda
  const orig0 = jsyaml.load(disk0[FILE]);
  const p = split(d, "risacca", 4.5, 0.4);                  // a meta' dei suoi 4 s
  const head = p.streams[0], tail = p.streams[2];

  assert("la testa tiene id e file", head.id === "risacca" && head._import.file === FILE && !head._import.fresh);
  assert("la coda ha l'id del suo file nuovo, accanto a quello della testa",
    tail.id === "risacca-2" && tail._import.file === TAIL, `${tail.id} · ${tail._import && tail._import.file}`);
  assert("...ed e' nuova: nata qui, mai letta da un disco", tail._import.fresh === true);
  assert("...la voce del master e' la sola `file:` (il piazzamento viene dallo stato)",
    eq(tail._import.entry, { file: TAIL }), JSON.stringify(tail._import.entry));

  const files = Y.serializeImports(p);
  assert("due file da scrivere, nessun conflitto: la testa e la coda",
    eq(Object.keys(files.files).sort(), [FILE, TAIL].sort()) && eq(files.conflicts, []), JSON.stringify(Object.keys(files.files)));

  const hd = fileDoc(p, FILE);
  assert("il file della testa e' accorciato: la durata dello stream e quella del documento",
    hd.streams[0].duration === 2 && hd.duration === 2, JSON.stringify([hd.duration, hd.streams[0].duration]));
  assert("...resta il documento di prima: seed, bpm, stream_id, piazzamento nel file",
    hd.seed === 1441 && hd.bpm === 120 && hd.streams[0].stream_id === "risacca"
      && hd.streams[0].onset === 12.5 && hd.streams[0].mute === true, JSON.stringify(hd));
  assert("...e gli inviluppi sono congelati: la seconda meta' della curva non c'e' piu'",
    !eq(hd.streams[0].grain.duration, orig0.streams[0].grain.duration), JSON.stringify(hd.streams[0].grain.duration));

  const td = fileDoc(p, TAIL);
  assert("il file nuovo e' un documento del laboratorio a se': uno stream solo",
    Array.isArray(td.streams) && td.streams.length === 1, JSON.stringify(td));
  assert("...con stream_id = nome del file", td.streams[0].stream_id === "risacca-2", td.streams[0].stream_id);
  assert("...e il seed del file originale (con bpm e la testa del documento)",
    td.seed === 1441 && td.bpm === 120, JSON.stringify([td.seed, td.bpm]));
  assert("...lunga quanto la coda, nel documento e nello stream",
    td.duration === 2 && td.streams[0].duration === 2, JSON.stringify([td.duration, td.streams[0].duration]));
  assert("...che riprende la lettura del sample dove la testa si ferma",
    td.streams[0].pointer.start === 0.4, JSON.stringify(td.streams[0].pointer));
  assert("...e tiene il resto dello stream (sample, volume, piazzamento nel file)",
    td.streams[0].sample === "onda.wav" && td.streams[0].volume === -6 && td.streams[0].onset === 12.5,
    JSON.stringify(td.streams[0]));
  // Aperto da solo — come il laboratorio apre un documento suo — e' uno
  // stream di nome risacca-2, senza nessuna voce `file:` da risolvere.
  const alone = Y.parse(files.files[TAIL], { project: "risacca-2", samples: [] });
  assert("letto da solo, e' lo stream risacca-2 e nient'altro",
    alone.streams.length === 1 && alone.streams[0].id === "risacca-2" && !alone.streams[0]._import
      && !alone.importErrors, JSON.stringify(alone.streams.map(s => s.id)));

  const entries = masterDoc(p).streams;
  assert("il master ha due voci `file:`: la testa dov'era, la coda all'onset del taglio, senza stream_id",
    entries.length === 3 && eq(entries[0], { file: FILE, onset: 2.5 }) && eq(entries[2], { file: TAIL, onset: 4.5 }),
    JSON.stringify(entries));
  assert("...e lo stream scritto dentro non si tocca", entries[1].stream_id === "riva" && entries[1].density === 40);

  // Riletto, il master trova la coda nel suo file: la provenienza e' vera.
  const back = Y.parse(Y.serialize(p), { project: "brano", samples: [],
    imports: { [FILE]: { text: files.files[FILE] }, [TAIL]: { text: files.files[TAIL] } } });
  const t2 = back.streams.find(s => s.id === "risacca-2");
  assert("riletto, il master ha la testa e la coda, ognuna nel suo file",
    !back.importErrors && back.streams.length === 3 && !!t2 && t2._import.file === TAIL && !t2._import.fresh
      && t2.onset === 4.5 && t2.duration === 2, JSON.stringify(back.importErrors || back.streams.map(s => s.id)));
  assert("...con la coda che e' la coda (stesso contenuto dello stato)",
    t2 && eq(t2.fillFactorEnv, tail.fillFactorEnv) && t2.pointer.start === 0.4);

  // Su disco: si scrive tutto al salvataggio, niente allo split.
  assert("il file nuovo e' da creare, e il file della testa da riscrivere",
    eq(Y.importCreates(p, disk0), [TAIL]) && eq(Object.keys(Y.changedImports(files.files, disk0)).sort(), [FILE, TAIL].sort()));
  assert("annullato prima del salvataggio (lo stato di prima), non c'e' niente da scrivere ne' da creare",
    eq(Y.changedImports(Y.serializeImports(d).files, disk0), {}) && eq(Y.importCreates(d, disk0), []));
  const disk1 = { ...disk0, ...files.files };               // dopo il salvataggio
  assert("salvato, il file della coda e' nostro: non e' piu' da creare", eq(Y.importCreates(p, disk1), []));
  assert("...e un undo dopo il salvataggio riscrive la testa com'era, senza creare niente",
    eq(Object.keys(Y.changedImports(Y.serializeImports(d).files, disk1)), [FILE]) && eq(Y.importCreates(d, disk1), []));
}

console.log("\n── il nome del file nuovo: il numero dopo, quando il nome e' preso ──");
{
  const d = open();
  const onDisk = [FILE, TAIL];                               // un risacca-2.yml c'e' gia'
  const oracle = (id) => Y.importIdTaken(id, ["streams"], onDisk);
  const p = split(d, "risacca", 4.5, 0.4, oracle);
  assert("risacca-2.yml esiste: la coda e' risacca-3, in risacca-3.yml",
    p.streams[2].id === "risacca-3" && p.streams[2]._import.file === "streams/risacca-3.yml",
    `${p.streams[2].id} · ${p.streams[2]._import.file}`);
  assert("...e nel suo file lo stream_id e' risacca-3",
    fileDoc(p, "streams/risacca-3.yml").streams[0].stream_id === "risacca-3");
  const q = split(d, "risacca", 4.5, 0.4, (id) => id === "risacca-2");   // risacca-2 ha uno stem
  assert("l'id risacca-2 ha uno stem: la coda e' risacca-3", q.streams[2].id === "risacca-3", q.streams[2].id);
  // Una coda gia' tagliata e non salvata: il secondo split la conta fra gli id
  // vivi, quindi non riprende il suo nome.
  const twice = split(split(d, "risacca", 4.5, 0.4), "risacca", 3.5, 0.2);
  assert("tagliare due volte la testa: risacca-2, poi risacca-3",
    eq(twice.streams.map(s => s.id), ["risacca", "riva", "risacca-2", "risacca-3"])
      && twice.streams[3]._import.file === "streams/risacca-3.yml", JSON.stringify(twice.streams.map(s => s.id)));
  assert("...due file nuovi, nell'ordine del master",
    eq(Y.importCreates(twice, Y.serializeImports(d).files), [TAIL, "streams/risacca-3.yml"]));
  // La coda di una coda: la base e' il SUO nome di file. La regola e' letterale
  // (`<nome>-2`), come la scrive il piano: nessun suffisso si toglie.
  const tt = split(split(d, "risacca", 4.5, 0.4), "risacca-2", 5.5, 0.6);
  assert("tagliare la coda: la base e' risacca-2, la sua coda risacca-2-2",
    tt.streams[3].id === "risacca-2-2" && tt.streams[3]._import.file === "streams/risacca-2-2.yml",
    `${tt.streams[3].id} · ${tt.streams[3]._import.file}`);
}

console.log("\n── lo split di uno stream scritto nel master resta com'era ──");
{
  const d = open();
  const p = split(d, "riva", 1.5, 0.25);
  const tail = p.streams[2];
  assert("la coda e' uno streamN, senza provenienza", tail.id === "stream3" && !("_import" in tail), tail.id);
  assert("...scritta per intero nel master", masterDoc(p).streams[2].stream_id === "stream3"
    && masterDoc(p).streams[2].density === 40);
  assert("...e nessun file nuovo", eq(Y.importCreates(p, Y.serializeImports(d).files), [])
    && eq(Object.keys(Y.serializeImports(p).files), [FILE]));
}

console.log("\n── la coda di una copia non ancora salvata (#186) ──");
{
  const d = open();
  const copy = { ...Y.copyImport(JSON.parse(JSON.stringify(d.streams[0])), "stream7"), onset: 10 };
  const withCopy = { ...d, streams: [...d.streams, copy] };
  const p = split(withCopy, "stream7", 12, 0.5);
  assert("la coda della copia e' stream7-2, accanto al file nuovo della copia",
    p.streams[3].id === "stream7-2" && p.streams[3]._import.file === "streams/stream7-2.yml",
    `${p.streams[3].id} · ${p.streams[3]._import && p.streams[3]._import.file}`);
  assert("...e i file nuovi sono due: la copia (accorciata) e la sua coda",
    eq(Y.importCreates(p, Y.serializeImports(d).files), ["streams/stream7.yml", "streams/stream7-2.yml"]));
}

/* Il pointer della coda e' quello TAGLIATO, con lo `start` nuovo sopra: lo
 * start e' il solo campo del pointer che lo split riscrive. Ripartire dal
 * pointer dello stream intero buttava via il taglio di speed_ratio,
 * offset_range e degli inviluppi del loop, che `sliceStreamEnvelopes` fa come
 * per ogni altro inviluppo: la coda li ripercorreva dall'inizio, compressi
 * nella sua durata, e il suono cambiava proprio al taglio. Adesso la coda e'
 * un documento del laboratorio a se', e quella curva ci resterebbe scritta. */
console.log("\n── la coda continua gli inviluppi del pointer dal taglio ──");
{
  const text = RISACCA.replace("    speed_ratio: 0.5\n",
    "    speed_ratio: [[0, 0.5], [1, 2]]\n    offset_range: [[0, 0], [1, 0.2]]\n");
  const d = Y.parse(MASTER, { project: "brano", samples: [], imports: { [FILE]: { text } } });
  const p = split(d, "risacca", 4.5, 0.4);                  // a meta' dei suoi 4 s
  const tp = fileDoc(p, TAIL).streams[0].pointer;
  assert("speed_ratio riparte da dove la testa lo lascia: 1.25 a meta' di 0.5 → 2",
    eq(tp.speed_ratio, [[0, 1.25], [1, 2]]), JSON.stringify(tp.speed_ratio));
  assert("...e cosi' offset_range: 0.1 a meta' di 0 → 0.2",
    eq(tp.offset_range, [[0, 0.1], [1, 0.2]]), JSON.stringify(tp.offset_range));
  assert("...con lo start nuovo e il resto del pointer com'era",
    tp.start === 0.4 && tp.loop_unit === "normalized", JSON.stringify(tp));
  const hp = fileDoc(p, FILE).streams[0].pointer;
  assert("la testa, congelata, si ferma su quel valore",
    eq(hp.speed_ratio, [[0, 0.5], [1, 1.25]]), JSON.stringify(hp.speed_ratio));
}

/* ===========================================================================
 * 3. Il cablaggio in app.jsx (guardie sorgente)
 * ======================================================================== */
console.log("\n── app.jsx: lo split da' alla coda un file suo ──");
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
  const sp = fnBody("async function splitAtPlayhead(");
  assert("splitAtPlayhead e' asincrona (chiede la cartella al bridge prima di scegliere il nome)", !!sp);
  assert("...la coda prende la provenienza nuova da copyImport, non si stacca piu'",
    /copyImport\(/.test(sp) && !/detachImport\(/.test(app));
  const list = sp.indexOf("listImportNames(");
  const alloc = sp.indexOf("allocStreamIds(");
  assert("...elenca la cartella PRIMA di allocare l'id", list > 0 && alloc > 0 && list < alloc, `list@${list} alloc@${alloc}`);
  /* Uno split di soli stream scritti nel master resta quello di prima: niente
     giro di rete, quindi niente await. L'await c'e' solo con una cartella da
     elencare. */
  assert("...e la elenca solo se c'e' uno stream importato da tagliare",
    /dirs\.length\s*\?\s*await listImportNames\(/.test(sp) && (sp.match(/\bawait\b/g) || []).length === 1);
  assert("...l'id viene dalle basi (il nome del file della testa)",
    /importSplitBase\(/.test(sp) && /allocStreamIds\(d\.streams,\s*bases,\s*splitIdTaken\)/.test(sp));
  assert("...con un oracolo che guarda stem e file: ownsStemFor e importIdTaken",
    /const splitIdTaken\s*=\s*\(id\)\s*=>\s*ownsStemFor\(id\)\s*\|\|\s*PY\.importIdTaken\(/.test(sp));
  assert("...coi file su disco ricordati e quelli del documento, non solo l'elenco",
    /importDiskRef\.current/.test(sp) && /importFilesOf\(/.test(sp));
  /* Fra l'elenco e il setData passa un giro di rete: se intanto lo stream da
     tagliare e' cambiato, la testa calcolata prima butterebbe via la
     modifica. Si guarda la data di ADESSO e si rinuncia. */
  assert("...e dopo l'await rinuncia se lo stream da tagliare non e' piu' quello",
    /dataRef\.current/.test(sp.slice(sp.indexOf("await listImportNames("))));
  /* Il modello qui sopra prende il pointer tagliato: app.jsx deve fare lo
     stesso, e lo stream intero non deve rientrare dalla porta del pointer. */
  assert("...e il pointer della coda e' quello tagliato, con lo start nuovo",
    /pointer:\s*\{\s*\.\.\.\(sliced\.stream\.pointer\s*\|\|\s*\{\}\),\s*start\s*\}/.test(sp)
      && !/\.\.\.\(s\.pointer\b/.test(sp), (sp.match(/pointer:\s*\{[^}]*\}/) || [""])[0]);

  const ln = fnBody("async function listImportNames(");
  assert("l'elenco delle cartelle e' un aiuto solo, condiviso con l'incolla", /listImportDir\(/.test(ln));
  const paste = fnBody("async function pasteStreams(");
  assert("...e l'incolla lo usa prima di allocare", paste.indexOf("listImportNames(") > 0
    && paste.indexOf("listImportNames(") < paste.indexOf("allocStreamIds("));
}

console.log("\n── yaml-bridge: nessuno stacca piu' la provenienza ──");
{
  assert("detachImport non c'e' piu': copia e coda hanno un file loro", !("detachImport" in Y));
}
