/* =============================================================================
 * test-stream-files.js — lo stream come file (PGE-ui #183, #184).
 *
 * Con PythonGranularEngine#290 una voce di `streams:` del master puo' essere
 * `- file: streams/risacca.yml`: lo stream e' scritto in un altro documento, un
 * documento del laboratorio che si apre e si rende anche da solo, e il master
 * ne tiene soltanto il piazzamento (`stream_id`, `onset`, `mute`, `solo`).
 *
 * Qui si pretende cio' che il bridge (`yaml-bridge.js`) ne fa:
 *
 *   - #183, la lettura: gli import si risolvono come li risolve il motore
 *     (piazzamento dal master, `stream_id` di default = nome del file, del file
 *     importato si ignorano la testa e le chiavi di piazzamento dello stream),
 *     e un file che manca o non e' uno stream solo produce un messaggio che lo
 *     nomina invece di un'eccezione;
 *   - #183, il salvataggio senza modifiche: il master riscrive `- file:` piu' le
 *     sole chiavi di piazzamento, e il file importato non si tocca;
 *   - #184, le modifiche: ogni chiave ha una sola casa. Il piazzamento va nel
 *     master, tutto il resto — `duration` compresa — nel file importato, che
 *     resta un documento del laboratorio (il suo `seed`, il suo `stream_id`, il
 *     suo `onset: 0` restano quelli del file);
 *   - #184, cosa si scrive: solo i file cambiati rispetto a cio' che e' su
 *     disco, e il confronto e' contro il disco, non contro la storia — cosi' un
 *     undo dopo un salvataggio riporta il file com'era.
 *
 * Il cablaggio in app.jsx (dove sta il "disco" che si confronta, chi incolla e
 * chi taglia) e' coperto da guardie sorgente in fondo, come altrove.
 *
 * Run: node test-stream-files.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

global.window = { jsyaml: require("js-yaml") };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.reject(new Error("nessuna rete nei test"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

const Y = window.PGEYaml;
const { fingerprintStream } = window.PGEBackend;
const jsyaml = window.jsyaml;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Uguaglianza profonda indifferente all'ordine delle chiavi: e' quella che
 * conta per il motore (che rilegge un dict) e per il laboratorio. */
function sameDoc(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-12;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameDoc(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (!eq(ka, kb)) return false;
    return ka.every(k => sameDoc(a[k], b[k]));
  }
  return false;
}

/* Il testo senza l'intestazione `# ...` che il bridge rigenera a ogni
 * salvataggio (`# saved:` porta l'ora): e' l'unica cosa che fra due
 * salvataggi dello stesso stato puo' cambiare. */
const body = (text) => text.split("\n").filter(l => !l.startsWith("# ")).join("\n").trim();

/* La fixture del motore e del laboratorio (mare-nostrum
 * tests/fixtures/stream_come_file/): `risacca.yml` e' scritto dalla pagina del
 * laboratorio, con il seed dello study.yml, lo stream_id = nome del file e il
 * piazzamento dello stream da cui e' stato aperto (onset 12.5, mute). */
const MASTER = `seed: 1441
streams:
  - file: streams/risacca.yml
    onset: 2.5
  - stream_id: riva
    onset: 0
    duration: 3
    sample: onda.wav
    time_mode: normalized
    density: 40
    grain:
      duration: 0.04
      envelope: hanning
    pointer:
      start: 0
      speed_ratio: 1
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
  distribution_mode: uniform
  fill_factor:
    type: cubic
    points: [[0, 2], [0.5, 3], [1, 1.5]]
  distribution: 0.7
  grain:
    duration: [[0, 0.03], [0.5, 0.05, step], [1, 0.02]]
    duration_range: 0.005
    envelope: hanning
    read_direction: [[0, 1], [0.4, -1], [0.7, 1]]
  pointer:
    start: 0
    speed_ratio: 0.5
    loop_unit: normalized
    offset_range: 0.02
  pitch:
    ratio: 0.8
    range: 0.05
  pan: 0
  pan_range: 90
  volume: -6
  voices:
    num_voices: 3
    pitch:
      strategy: stochastic
      unit: ratio
      pitch_range: 0.2
    pan:
      strategy: stochastic
      spread: 120
`;

const FILE = "streams/risacca.yml";
const open = (master = MASTER, imports = { [FILE]: { text: RISACCA } }) =>
  Y.parse(master, { project: "brano", samples: [], imports });

/* Il file come lo riscriverebbe il bridge, e come lo rileggerebbe chiunque. */
const fileDoc = (data, file = FILE) => jsyaml.load(Y.serializeImports(data).files[file]);
const masterDoc = (data) => jsyaml.load(Y.serialize(data));
const withStream = (data, id, patch) => ({
  ...data,
  streams: data.streams.map(s => s.id === id ? { ...s, ...patch } : s),
});

console.log("\n── i file che il master importa ──");
{
  assert("importRefs elenca i `file:` del master", eq(Y.importRefs(MASTER), [FILE]),
    JSON.stringify(Y.importRefs(MASTER)));
  const due = `streams:\n  - file: a.yml\n  - file: a.yml\n    stream_id: a2\n  - file: b/c.yml\n  - stream_id: x\n`;
  assert("una volta sola anche se importato due volte, in ordine di master",
    eq(Y.importRefs(due), ["a.yml", "b/c.yml"]), JSON.stringify(Y.importRefs(due)));
  assert("un master senza `file:` non ne elenca", eq(Y.importRefs("streams:\n  - stream_id: x\n"), []));
  assert("un `file:` che non e' un path non e' un file da leggere",
    eq(Y.importRefs("streams:\n  - file: 3\n  - file: ''\n"), []));
  assert("un testo che non e' YAML non lancia: non c'e' niente da leggere",
    eq(Y.importRefs("streams: [\n"), []));
  assert("le chiavi di piazzamento sono quelle del motore (CHIAVI_DI_PIAZZAMENTO)",
    eq(Y.PLACEMENT_KEYS, ["stream_id", "onset", "mute", "solo"]), JSON.stringify(Y.PLACEMENT_KEYS));
}

console.log("\n── #183 lettura: lo stream risolto come lo risolve il motore ──");
{
  const d = open();
  const s = d.streams[0];
  assert("due stream, l'importato al suo posto", d.streams.length === 2 && d.streams[1].id === "riva",
    d.streams.map(x => x.id).join(","));
  assert("stream_id di default = nome del file senza estensione", s.id === "risacca", s.id);
  assert("onset dal master, non l'onset: 12.5 del file", s.onset === 2.5, String(s.onset));
  assert("il mute del file si ignora: decide il master", s.mute === false && s.solo === false);
  assert("la duration e' quella dello stream del file", s.duration === 4 && s.durationImplicit === false);
  assert("il contenuto viene dal file", eq(s.fillFactorEnv, { type: "cubic", points: [[0, 2], [0.5, 3], [1, 1.5]] })
    && s.pitch.unit === "ratio" && s.pitch.value === 0.8 && s.voices.num === 3,
    JSON.stringify(s.fillFactorEnv));
  assert("lo stream porta la sua provenienza", s._import && s._import.file === FILE,
    JSON.stringify(s._import && s._import.file));
  assert("niente errori su un master buono", !d.importErrors, JSON.stringify(d.importErrors));
  assert("il seed del master e' quello del brano", d.seed === 1441);

  const d2 = open(`streams:\n  - file: streams/risacca.yml\n    stream_id: onda\n    mute: true\n    solo: true\n`);
  assert("uno stream_id esplicito nel master vince sul nome del file", d2.streams[0].id === "onda");
  assert("mute e solo dal master", d2.streams[0].mute === true && d2.streams[0].solo === true);
  const d3 = open(`streams:\n  - file: streams/risacca.yml\n    stream_id: null\n`);
  assert("`stream_id: null` vale come assente (regola 4)", d3.streams[0].id === "risacca", d3.streams[0].id);
  const d4 = open(`streams:\n  - file: streams/risacca.yml\n`);
  assert("senza onset nel master lo stream entra a 0 (l'onset del file non conta)", d4.streams[0].onset === 0);

  assert("nome del file: l'ultima estensione sola, e i punti in testa non sono un'estensione",
    Y.importDefaultId("a/b/c.d.yml") === "c.d" && Y.importDefaultId("x.yaml") === "x"
      && Y.importDefaultId("noext") === "noext" && Y.importDefaultId("dir/.yml") === ".yml",
    [Y.importDefaultId("a/b/c.d.yml"), Y.importDefaultId("x.yaml"), Y.importDefaultId("noext"),
     Y.importDefaultId("dir/.yml")].join(" | "));
}

console.log("\n── #183 un file importato che non si risolve e' un messaggio, non un crash ──");
{
  const cases = [
    ["mancante", { [FILE]: { error: "HTTP 404" } }, /streams\/risacca\.yml/],
    ["non letto affatto", {}, /streams\/risacca\.yml/],
    ["YAML malformato", { [FILE]: { text: "streams: [\n" } }, /streams\/risacca\.yml/],
    ["nessuno stream", { [FILE]: { text: "seed: 1\n" } }, /nessuno stream/],
    ["piu' di uno stream", { [FILE]: { text: "streams:\n- stream_id: a\n- stream_id: b\n" } }, /2 stream/],
    ["non e' una mappa", { [FILE]: { text: "- 1\n- 2\n" } }, /mappa/],
    ["una catena", { [FILE]: { text: "streams:\n- file: altro.yml\n" } }, /catena|file:/],
  ];
  for (const [label, imports, re] of cases) {
    let d = null, threw = null;
    try { d = open(MASTER, imports); } catch (e) { threw = e; }
    assert(`${label}: parse non lancia`, !threw, threw && threw.message);
    if (!d) continue;
    const errs = d.importErrors || [];
    assert(`${label}: un errore che nomina il file e la voce del master`,
      errs.length === 1 && re.test(errs[0].message) && /streams\[0\]/.test(errs[0].message)
        && /brano\.yml/.test(errs[0].message),
      JSON.stringify(errs));
    assert(`${label}: lo stream non risolto non entra nella timeline`,
      d.streams.length === 1 && d.streams[0].id === "riva", d.streams.map(x => x.id).join(","));
    // ...ma il master non lo perde: salvato, la voce torna dov'era, com'era.
    const m = masterDoc(d);
    assert(`${label}: salvando, la voce torna al suo posto e intatta`,
      eq(m.streams[0], { file: FILE, onset: 2.5 }) && m.streams[1].stream_id === "riva",
      JSON.stringify(m.streams[0]));
  }
  const nonPath = open(`streams:\n  - file: 3\n`, {});
  assert("un `file:` che non e' un path: errore, non un file letto",
    (nonPath.importErrors || []).length === 1 && /path/.test(nonPath.importErrors[0].message),
    JSON.stringify(nonPath.importErrors));
}

console.log("\n── #183 una chiave accanto a `file:` che non e' di piazzamento ──");
{
  const d = open(`streams:\n  - file: streams/risacca.yml\n    onset: 1\n    density: 99\n`);
  const s = d.streams[0];
  const errs = d.importErrors || [];
  assert("e' un errore, come nel motore (StreamFileKeyError), che nomina la chiave",
    errs.length === 1 && /density/.test(errs[0].message) && /streams\[0\]/.test(errs[0].message),
    JSON.stringify(errs));
  assert("non e' incorporata nello stream: la density e' quella del file (cioe' nessuna)",
    s.density == null && !(s._extra && "density" in s._extra), JSON.stringify([s.density, s._extra]));
  assert("ma lo stream si legge lo stesso: l'errore e' nel master, non nel file", s.id === "risacca");
  assert("salvando, la chiave resta dove l'autore l'ha scritta (l'errore resta visibile)",
    masterDoc(d).streams[0].density === 99, JSON.stringify(masterDoc(d).streams[0]));
  assert("...e il file importato non la riceve", !("density" in fileDoc(d).streams[0]));
}

console.log("\n── #183 aprire e salvare senza toccare niente ──");
{
  const d = open();
  const m = masterDoc(d);
  assert("il master riscrive `- file:` piu' le sole chiavi di piazzamento",
    eq(m.streams[0], { file: FILE, onset: 2.5 }), JSON.stringify(m.streams[0]));
  assert("il seed del brano resta", m.seed === 1441);
  const again = Y.parse(Y.serialize(d), { project: "brano", samples: [], imports: { [FILE]: { text: RISACCA } } });
  assert("salvare due volte da' lo stesso master (a parte l'intestazione)",
    body(Y.serialize(again)) === body(Y.serialize(d)));
  const files = Y.serializeImports(d).files;
  assert("il file importato e' fra quelli che il bridge sa scrivere", typeof files[FILE] === "string");
  assert("e confrontato con cio' che e' stato letto, non e' cambiato",
    eq(Y.changedImports(files, Y.serializeImports(d).files), {}));
  const roundtrip = Y.roundTripDiff(d);
  assert("il controllo di round-trip del caricamento non grida su un master con `file:`",
    roundtrip.length === 0, JSON.stringify(roundtrip));
}

console.log("\n── #184 il file riscritto resta un documento del laboratorio ──");
{
  const d = open();
  const doc = fileDoc(d);
  const orig = jsyaml.load(RISACCA);
  assert("la testa del file resta la sua: seed, duration, bpm",
    doc.seed === 1441 && doc.duration === 4 && doc.bpm === 120, JSON.stringify([doc.seed, doc.duration, doc.bpm]));
  assert("nello stesso ordine", eq(Object.keys(doc), Object.keys(orig)), JSON.stringify(Object.keys(doc)));
  const st = doc.streams[0];
  assert("lo stream_id, l'onset e il mute del file restano quelli del file",
    st.stream_id === "risacca" && st.onset === 12.5 && st.mute === true, JSON.stringify([st.stream_id, st.onset, st.mute]));
  assert("senza modifiche, lo stream riscritto e' lo stesso del file, chiave per chiave",
    sameDoc(st, orig.streams[0]), JSON.stringify(st));
  // Ed e' un documento che si rende da solo: un solo stream, nessun `file:`.
  assert("un solo stream e nessun `file:` dentro", doc.streams.length === 1 && !("file" in st));
}

console.log("\n── #184 ogni chiave ha una sola casa ──");
{
  const d0 = open();
  const m0 = body(Y.serialize(d0));
  const f0 = Y.serializeImports(d0).files;

  // Una chiave di stream: nel file, e il master non cambia.
  const ed = withStream(d0, "risacca", { volume: -12, grain: { ...d0.streams[0].grain, duration: 0.07, durationEnv: null } });
  assert("una chiave di stream finisce nel file importato",
    fileDoc(ed).streams[0].volume === -12 && fileDoc(ed).streams[0].grain.duration === 0.07,
    JSON.stringify(fileDoc(ed).streams[0].grain));
  assert("...e il master non cambia", body(Y.serialize(ed)) === m0);
  assert("changedImports la conta", eq(Object.keys(Y.changedImports(Y.serializeImports(ed).files, f0)), [FILE]));

  // Le quattro chiavi di piazzamento: nel master, e il file non cambia.
  const placements = [
    ["onset",     { onset: 7 },    (e) => e.onset === 7],
    ["mute",      { mute: true },  (e) => e.mute === true],
    ["solo",      { solo: true },  (e) => e.solo === true],
    ["stream_id", { id: "onda" },  (e) => e.stream_id === "onda"],
  ];
  for (const [k, patch, ok] of placements) {
    const p = withStream(d0, "risacca", patch);
    const entry = masterDoc(p).streams[0];
    assert(`${k} finisce nel master`, ok(entry) && entry.file === FILE, JSON.stringify(entry));
    assert(`${k}: il file importato non cambia`,
      eq(Y.changedImports(Y.serializeImports(p).files, f0), {}),
      JSON.stringify(Object.keys(Y.changedImports(Y.serializeImports(p).files, f0))));
    assert(`${k}: e nella voce del master non entra nient'altro`,
      Object.keys(entry).every(x => x === "file" || Y.PLACEMENT_KEYS.includes(x)), JSON.stringify(entry));
  }
  // Tolto il mute, la chiave sparisce dal master: la presenza e' il valore.
  const muted = Y.parse(Y.serialize(withStream(d0, "risacca", { mute: true })),
    { project: "brano", samples: [], imports: { [FILE]: { text: RISACCA } } });
  const unmuted = withStream(muted, "risacca", { mute: false });
  assert("tolto il mute, `mute` sparisce dalla voce", !("mute" in masterDoc(unmuted).streams[0]),
    JSON.stringify(masterDoc(unmuted).streams[0]));
  // Rinominato col nome del file, l'id di default basta: niente stream_id scritto.
  const renamed = Y.parse(Y.serialize(withStream(d0, "risacca", { id: "onda" })),
    { project: "brano", samples: [], imports: { [FILE]: { text: RISACCA } } });
  assert("il rename riletto e' lo stream `onda`", renamed.streams[0].id === "onda");
  const back = withStream(renamed, "onda", { id: "risacca" });
  assert("rinominato di nuovo col nome del file, il master non scrive uno stream_id che non serve",
    !("stream_id" in masterDoc(back).streams[0]), JSON.stringify(masterDoc(back).streams[0]));
}

console.log("\n── #184 resize: la duration va nel file ──");
{
  const d0 = open();
  const r = withStream(d0, "risacca", { duration: 6 });
  const doc = fileDoc(r);
  assert("la duration dello stream finisce nel file", doc.streams[0].duration === 6, String(doc.streams[0].duration));
  assert("...e la testa la segue, perche' il file si rende da solo per quella durata",
    doc.duration === 6, String(doc.duration));
  // La voce del master no. La `duration` IN TESTA al master si' — ed e' giusto:
  // non e' una chiave dello stream ma la lunghezza del brano, che il bridge
  // deriva dagli stream (computeDuration) perche' il motore la usa come
  // lunghezza del render. Allungato uno stream e ferma lei, l'audio si
  // taglierebbe.
  assert("la voce del master non cambia", eq(masterDoc(r).streams, masterDoc(d0).streams),
    JSON.stringify(masterDoc(r).streams[0]));
  assert("...e la lunghezza del brano segue lo stream, come per uno stream scritto dentro",
    masterDoc(r).duration === Y.computeDuration(r.streams), String(masterDoc(r).duration));
  assert("riportata alla durata letta, la testa torna com'era", fileDoc(withStream(r, "risacca", { duration: 4 })).duration === 4);

  // Col lucchetto chiuso gli inviluppi riscalati sono una modifica dello
  // stream come le altre: nel file.
  const env = withStream(d0, "risacca", { duration: 8,
    grain: { ...d0.streams[0].grain, durationEnv: [[0, 0.03], [0.25, 0.05, "step"], [0.5, 0.02]] } });
  assert("gli inviluppi riscalati finiscono nel file",
    eq(fileDoc(env).streams[0].grain.duration, [[0, 0.03], [0.25, 0.05, "step"], [0.5, 0.02]]),
    JSON.stringify(fileDoc(env).streams[0].grain.duration));

  // Uno stream che la durata non la scrive (PGE #205) non la riceve in testa.
  const implicitFile = RISACCA.replace("  duration: 4\n  sample", "  sample");
  const di = open(MASTER, { [FILE]: { text: implicitFile } });
  assert("durata implicita: il file non la materializza", !("duration" in fileDoc(di).streams[0]),
    JSON.stringify(Object.keys(fileDoc(di).streams[0])));
  assert("...e la testa resta la sua", fileDoc(di).duration === 4);
}

console.log("\n── #184 si scrive solo cio' che e' cambiato rispetto al disco ──");
{
  const d0 = open();
  // Il "disco" e' quello che il bridge ha letto: lo tiene app.jsx, fuori dalla
  // storia (vedi le guardie in fondo). Qui lo si tiene a mano.
  let disk = Y.serializeImports(d0).files;
  const d1 = withStream(d0, "risacca", { volume: -20 });
  let changed = Y.changedImports(Y.serializeImports(d1).files, disk);
  assert("una modifica: un file da scrivere", eq(Object.keys(changed), [FILE]));
  disk = { ...disk, ...changed };                       // salvato
  assert("salvato, non c'e' piu' niente da scrivere", eq(Y.changedImports(Y.serializeImports(d1).files, disk), {}));
  // Undo: lo stato torna d0 (lo snapshot della storia), il disco no.
  changed = Y.changedImports(Y.serializeImports(d0).files, disk);
  assert("undo dopo il salvataggio: il file va riscritto", eq(Object.keys(changed), [FILE]));
  assert("...e torna com'era", changed[FILE] === Y.serializeImports(d0).files[FILE]);
  // Undo e redo senza salvataggio in mezzo: niente da scrivere.
  const disk0 = Y.serializeImports(d0).files;
  assert("modifica e undo senza salvare: il file non si tocca",
    eq(Y.changedImports(Y.serializeImports(d0).files, disk0), {}));
  // Un file che manca dal disco noto (mai letto) e' da scrivere.
  assert("un file mai letto si scrive", eq(Object.keys(Y.changedImports({ "x.yml": "a" }, {})), ["x.yml"]));
}

console.log("\n── lo stesso file importato due volte ──");
{
  const m = `streams:\n  - file: streams/risacca.yml\n  - file: streams/risacca.yml\n    stream_id: eco\n    onset: 5\n`;
  const d = open(m);
  assert("due stream dallo stesso file", d.streams.length === 2 && d.streams[1].id === "eco",
    d.streams.map(x => x.id).join(","));
  assert("finche' dicono la stessa cosa, nessun conflitto", eq(Y.serializeImports(d).conflicts, []));
  const e = withStream(d, "eco", { volume: -30 });
  assert("modificati in modo diverso, il file e' in conflitto e si dice quale",
    eq(Y.serializeImports(e).conflicts, [FILE]), JSON.stringify(Y.serializeImports(e).conflicts));
}

console.log("\n── l'impronta di uno stream importato e' quella dello stesso stream scritto dentro ──");
{
  // Il motore calcola il fingerprint sullo stream risolto: importato o scritto
  // nel master, e' lo stesso dict. La provenienza resta fuori.
  const imported = open().streams[0];
  const inlineText = (() => {
    const st = jsyaml.load(RISACCA).streams[0];
    delete st.mute;
    st.onset = 2.5;
    return jsyaml.dump({ streams: [st] });
  })();
  const inline = Y.parse(inlineText, { project: "brano", samples: [] }).streams[0];
  assert("stessa impronta della UI", fingerprintStream(imported, "wav") === fingerprintStream(inline, "wav"),
    `${fingerprintStream(imported, "wav")} vs ${fingerprintStream(inline, "wav")}`);
  const moved = { ...imported, _import: { ...imported._import, file: "altrove/risacca.yml" } };
  assert("spostare il file non muove l'impronta", fingerprintStream(moved, "wav") === fingerprintStream(imported, "wav"));
}

/* Uno stream senza provenienza si scrive per intero nel master. Incolla e
   split la toglievano alla copia e alla coda (`detachImport`) finche' #186 e
   #187 non hanno dato a ciascuna un file suo (test-stream-copy.js,
   test-stream-split.js); la regola del serializzatore resta. */
console.log("\n── senza provenienza, lo stream sta nel master ──");
{
  const { _import, ...d } = open().streams[0];
  const inl = { ...open(), streams: [d, open().streams[1]] };
  const e = masterDoc(inl).streams[0];
  assert("staccato, lo stream si scrive per intero nel master", !("file" in e) && e.stream_id === "risacca"
    && e.fill_factor && e.fill_factor.type === "cubic", JSON.stringify(Object.keys(e)));
  assert("...e non e' piu' un file da scrivere", eq(Y.serializeImports(inl).files, {}));
}

console.log("\n── l'intestazione del file riscritto ──");
{
  const t = Y.importedFileText(FILE, Y.serializeImports(open()).files[FILE]);
  assert("porta il nome del file e chi l'ha scritto, come il master",
    /^# stream: streams\/risacca\.yml\n/.test(t) && /# editor: {2}PGE-ui/.test(t), t.slice(0, 120));
  assert("e sotto c'e' il documento intero", sameDoc(jsyaml.load(t), fileDoc(open())));
}

console.log("\n── il render reclama i file prima di partire, e li rende se non li ha scritti ──");
{
  // Il bridge scrive gli import all'arrivo del POST, non alla fine del render.
  // Segnarli "su disco" solo a render finito sovrascriveva cio' che un
  // salvataggio fatto NEL MEZZO aveva scritto: il "disco" tornava al testo del
  // render, piu' vecchio, e un undo verso quel testo non riscriveva il file.
  // Quindi si reclamano prima di `run()`, e se il bridge non ha scritto niente
  // (`configWritten === false`) `releaseImports` li rende — ma solo quelli
  // ancora al testo del render: un salvataggio nel mezzo ha l'ultima parola.
  const A = "streams: [A]\n", B = "streams: [B]\n", OLD = "streams: [old]\n";
  const before = { [FILE]: OLD, "altro.yml": "x\n" };
  const claimed = { ...before, [FILE]: A, "nuovo.yml": A };
  const bodies = { [FILE]: A, "nuovo.yml": A };
  assert("rifiutato e niente nel mezzo: il disco torna quello di prima",
    eq(Y.releaseImports(claimed, bodies, before), before),
    JSON.stringify(Y.releaseImports(claimed, bodies, before)));
  const savedMeanwhile = { ...claimed, [FILE]: B };
  const r = Y.releaseImports(savedMeanwhile, bodies, before);
  assert("un salvataggio nel mezzo non si annulla", r[FILE] === B && !("nuovo.yml" in r) && r["altro.yml"] === "x\n",
    JSON.stringify(r));
  assert("releaseImports non tocca la mappa che riceve", savedMeanwhile[FILE] === B && "nuovo.yml" in savedMeanwhile);
  // La strada intera: dopo il salvataggio nel mezzo, un undo verso il testo del
  // render e' un file da scrivere — il disco dice B.
  assert("...e dopo, tornare al testo del render e' un file da scrivere",
    FILE in Y.changedImports({ [FILE]: A }, savedMeanwhile));
}

console.log("\n── app.jsx: dove sta il disco, chi scrive, chi stacca (guardie sorgente) ──");
{
  const app = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
  // Il confronto e' contro cio' che e' su disco, e il disco NON sta in `data`:
  // uno snapshot della storia porterebbe con se' il "disco" di allora, e un
  // undo dopo un salvataggio risulterebbe "non cambiato" su un file cambiato.
  assert("il disco dei file importati e' un ref, fuori dalla storia",
    /importDiskRef\s*=\s*useRefApp\(/.test(app));
  assert("al caricamento si leggono gli import e si passano al parse",
    /importRefs\(/.test(app) && /readImport\(/.test(app) && /imports\s*[:,]/.test(app));
  assert("il salvataggio scrive master e file cambiati in un colpo (fs.save)",
    /backend\.fs\.save\(/.test(app) && /changedImports\(/.test(app));
  /* Dal merge con #185 il render passa dal giro della guardia (`FG.attempt`),
     e ogni tentativo ha il suo documento — dopo una rilettura, quello riletto —
     quindi il piano degli import (`plan`) si fa dentro il tentativo, e il
     corpo del POST lo riceve da li' (`optsFor(doc, st, plan.texts, …)`; il
     quarto argomento sono i file nuovi di #186). */
  assert("il render manda i file cambiati, cosi' sono su disco prima del motore",
    /imports:\s*importTexts/.test(app) && /optsFor\(doc, st, plan\.texts(, plan\.create)?\)/.test(app));
  {
    const rr = app.slice(app.indexOf("async function runRender("));
    const claim = rr.indexOf("markImportsWritten(plan.bodies)");
    const run = rr.indexOf(".render.run(");
    assert("il render reclama i suoi file PRIMA di run(), non a render finito",
      claim > 0 && run > 0 && claim < run, `claim@${claim} run@${run}`);
    /* ...e li rende dentro il tentativo, prima di tornare il risultato al
       giro: la domanda "modifiche proprie?" che segue un rifiuto (#185) deve
       vedere non scritti gli import che il bridge non ha scritto. */
    assert("...e li rende con releaseImports se il bridge non li ha scritti",
      /if \(r && r\.configWritten === false && window\.PGEYaml\)\s*\{\s*importDiskRef\.current\s*=\s*window\.PGEYaml\.releaseImports\([^;]*;\s*\}\s*return r;/.test(rr));
    assert("...e non li segna una seconda volta dopo run()",
      (rr.match(/markImportsWritten\(/g) || []).length === 1);
  }
  /* Ne' l'incolla ne' lo split staccano piu' la provenienza: la copia di uno
     stream importato e' un file nuovo (#186, test-stream-copy.js), e cosi' la
     coda di uno split (#187, test-stream-split.js). */
  assert("nessuno stacca piu' la provenienza di uno stream importato", !/detachImport\(/.test(app));
  assert("l'incolla e lo split danno alla copia e alla coda un file loro (#186, #187)",
    (app.match(/copyImport\(/g) || []).length === 2);
  const ye = SG.codeOf(path.join(__dirname, "../../src/components/YamlEditor.jsx"));
  assert("il tab Raw conserva la provenienza dello stream che riscrive",
    /_import:\s*stream\._import/.test(ye));
}

process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
