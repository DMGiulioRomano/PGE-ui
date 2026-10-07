/* =============================================================================
 * test-stream-files.js — lo stream come file nel bridge YAML (#183).
 *
 * Una voce di `streams:` del master puo' essere `- file: <path>` (PGE #290):
 * lo stream sta in un altro documento, e il master ne tiene solo il
 * piazzamento (`stream_id`, `onset`, `mute`, `solo`). Qui si fissa il lato
 * puro di yaml-bridge.js:
 *
 *   - `streamFileRefs(text)`: quali file leggere prima del parse;
 *   - `parse(text, {imports})`: le regole di risoluzione del motore, specchio
 *     di `pge.engine.stream_files` (la parity le chiede al motore stesso);
 *   - `serialize(data)`: il master riscrive `- file:` piu' il piazzamento, e
 *     niente del file importato;
 *   - le voci che non si risolvono: un errore che nomina il file, e la voce
 *     che torna nel master com'era scritta;
 *   - `importEditError(prev, next)`: finche' la #184 non c'e', una modifica
 *     al CONTENUTO di uno stream importato non deve arrivare in memoria — al
 *     salvataggio sparirebbe, o finirebbe nel master.
 *
 * Run: node test-stream-files.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = { jsyaml: require("js-yaml") };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.reject(new Error("no network in test"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

const Y = window.PGEYaml;
const { parse, serialize, serializeStream, roundTripDiff } = Y;
const { fingerprintStream } = window.PGEBackend;
const jsyaml = window.jsyaml;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function section(t) { console.log("\n── " + t + " ──"); }

/* ---------- fixture ----------
 * Un master come lo scrive PGE-ui, e un documento del laboratorio: un solo
 * stream, con il suo `stream_id`, `onset: 0` e i top-level che il motore
 * ignora quando il file e' importato (regola 5 di PGE #290). */
const RISACCA = [
  "seed: 1441",
  "duration: 30",
  "bpm: 60",
  "streams:",
  "  - stream_id: stream1",
  "    onset: 0",
  "    mute: true",
  "    solo: true",
  "    duration: 30",
  "    sample: mare.wav",
  "    density: 40",
  "    grain:",
  "      duration: 0.05",
  "",
].join("\n");

const MASTER_ENTRIES = [
  { file: "streams/risacca.yml", onset: 12.5, mute: true },
  { stream_id: "stream2", onset: 0, duration: 10, sample: "pino.wav", density: 20 },
];
const MASTER = jsyaml.dump({ seed: 1441, streams: MASTER_ENTRIES });

const ok = (text) => ({ ok: true, text });
const IMPORTS = { "streams/risacca.yml": ok(RISACCA) };

function open(text, imports = IMPORTS, extra = {}) {
  return parse(text, { project: "brano", samples: [], imports, master: "brano.yml", ...extra });
}
function entriesOf(yamlText) { return jsyaml.load(yamlText).streams; }
function withoutSaved(t) { return t.replace(/^# saved: .*$/m, ""); }

/* ============================================================ */
section("streamFileRefs: cosa leggere prima del parse");
{
  assert("esportata", typeof Y.streamFileRefs === "function");
  const refs = Y.streamFileRefs ? Y.streamFileRefs(MASTER) : null;
  assert("il file della voce", eq(refs, ["streams/risacca.yml"]), JSON.stringify(refs));

  const two = jsyaml.dump({ streams: [
    { file: "a.yml" }, { file: "a.yml", stream_id: "a2" }, { file: "b.yml", onset: 1 },
  ] });
  assert("un file importato due volte si legge una volta",
    Y.streamFileRefs && eq(Y.streamFileRefs(two), ["a.yml", "b.yml"]),
    Y.streamFileRefs && JSON.stringify(Y.streamFileRefs(two)));

  // Regola 4: l'errore sta nel master e viene prima della lettura. Il motore
  // non apre il file, e nemmeno il bridge deve chiederlo.
  const bad = jsyaml.dump({ streams: [
    { file: "x.yml", density: 40 }, { file: "" }, { file: 3 }, { stream_id: "s" },
  ] });
  assert("una voce con chiavi estranee, o senza un path, non si legge",
    Y.streamFileRefs && eq(Y.streamFileRefs(bad), []),
    Y.streamFileRefs && JSON.stringify(Y.streamFileRefs(bad)));
  assert("un master senza streams non chiede niente",
    Y.streamFileRefs && eq(Y.streamFileRefs("seed: 1\n"), []) && eq(Y.streamFileRefs(""), []));
}

/* ============================================================ */
section("risoluzione: le regole del motore");
{
  const d = open(MASTER);
  const s = d.streams[0];
  assert("due stream, nell'ordine del master", d.streams.length === 2 &&
    s && d.streams[1].id === "stream2", JSON.stringify(d.streams.map(x => x.id)));
  assert("stream_id di default = nome del file senza estensione (non lo stream1 del file)",
    s.id === "risacca", s.id);
  assert("onset dal master (l'onset: 0 del file e' ignorato)", s.onset === 12.5, s.onset);
  assert("mute dal master", s.mute === true);
  assert("solo: il file lo dichiara, il master no — conta il master", s.solo === false);
  assert("il contenuto viene dal file", s.sample === "mare.wav" && s.density === 40 &&
    s.grain.duration === 0.05, JSON.stringify({ sample: s.sample, d: s.density, g: s.grain }));
  assert("la duration dello stream del file e' scritta", s.duration === 30 && !s.durationImplicit);
  assert("la provenienza e' in memoria", s.imported && s.imported.file === "streams/risacca.yml",
    JSON.stringify(s.imported));
  assert("seed e bpm restano quelli del master", d.seed === 1441 && d.bpm === 120,
    JSON.stringify({ seed: d.seed, bpm: d.bpm }));
  assert("nessuna voce irrisolta", !(d.unresolvedImports && d.unresolvedImports.length),
    JSON.stringify(d.unresolvedImports));
  assert("nessuna chiave del file importato finisce in _extra del progetto", !d._extra,
    JSON.stringify(d._extra));
}
{
  // La `duration` top-level del file non e' la durata dello stream: senza una
  // `duration` nello stream, vale quella del sample (PGE #205), come se lo
  // stream fosse scritto nel master.
  const noDur = RISACCA.replace("    duration: 30\n", "");
  const d = open(MASTER, { "streams/risacca.yml": ok(noDur) }, {
    samples: [{ name: "mare.wav", duration: 7 }] });
  const s = d.streams[0];
  assert("duration top-level del file ignorata: vale il sample", s.duration === 7 &&
    s.durationImplicit === true, JSON.stringify({ d: s.duration, i: s.durationImplicit }));
}
{
  const m = jsyaml.dump({ streams: [{ file: "streams/risacca.yml", stream_id: "onda" }] });
  const s = open(m).streams[0];
  assert("stream_id scritto accanto a file: vince sul nome del file", s.id === "onda", s.id);
  assert("onset assente nel master vale 0 (PGE #220)", s.onset === 0, s.onset);
  const n = jsyaml.dump({ streams: [{ file: "streams/risacca.yml", stream_id: null }] });
  assert("stream_id: null vale come assente", open(n).streams[0].id === "risacca",
    open(n).streams[0].id);
  const e = jsyaml.dump({ streams: [{ file: "deep/a.b.yml" }] });
  assert("il nome toglie solo l'ultima estensione (splitext)",
    open(e, { "deep/a.b.yml": ok(RISACCA) }).streams[0].id === "a.b",
    open(e, { "deep/a.b.yml": ok(RISACCA) }).streams[0].id);
}

/* ============================================================ */
section("salvataggio: il master riscrive file: e il piazzamento, niente altro");
{
  const d = open(MASTER);
  const out = serialize(d);
  const e = entriesOf(out);
  assert("la voce file: torna com'era scritta", eq(e[0], MASTER_ENTRIES[0]), JSON.stringify(e[0]));
  assert("lo stream scritto nel master resta scritto nel master",
    e[1].stream_id === "stream2" && e[1].sample === "pino.wav", JSON.stringify(e[1]));
  assert("nessuna chiave dello stream importato nel master",
    !/mare\.wav/.test(out) && !/density: 40/.test(out), out);
  assert("la duration del brano conta lo stream importato (12.5 + 30 + coda)",
    jsyaml.load(out).duration === 52.5, jsyaml.load(out).duration);
  assert("roundTripDiff con gli stessi import: nessuna differenza",
    roundTripDiff(d, { imports: IMPORTS }).length === 0,
    JSON.stringify(roundTripDiff(d, { imports: IMPORTS })));

  // Punto fisso: aperto e salvato senza toccare niente, il master scritto da
  // PGE-ui torna identico byte per byte, intestazione `# saved:` a parte.
  const again = serialize(open(out));
  assert("aprire e salvare un master con file: e' un punto fisso",
    withoutSaved(again) === withoutSaved(out), again + "\n----\n" + out);
}
{
  const m = jsyaml.dump({ streams: [{ file: "streams/risacca.yml" }] });
  const e = entriesOf(serialize(open(m)));
  assert("niente stream_id ne' onset inventati: la voce resta nuda",
    eq(e[0], { file: "streams/risacca.yml" }), JSON.stringify(e[0]));
  const ex = jsyaml.dump({ streams: [{ file: "streams/risacca.yml", stream_id: "onda", onset: 0 }] });
  assert("stream_id e onset scritti restano scritti, anche a 0",
    eq(entriesOf(serialize(open(ex)))[0], { file: "streams/risacca.yml", stream_id: "onda", onset: 0 }),
    JSON.stringify(entriesOf(serialize(open(ex)))[0]));
}
{
  // Il piazzamento si sposta dal master: onset, mute, solo, rename.
  const d = open(jsyaml.dump({ streams: [{ file: "streams/risacca.yml" }] }));
  const moved = { ...d, streams: [{ ...d.streams[0], onset: 4, mute: true, solo: true, id: "onda" }] };
  assert("onset, mute, solo e stream_id finiscono nel master",
    eq(entriesOf(serialize(moved))[0],
      { file: "streams/risacca.yml", stream_id: "onda", onset: 4, mute: true, solo: true }),
    JSON.stringify(entriesOf(serialize(moved))[0]));
  const back = { ...moved, streams: [{ ...moved.streams[0], id: "risacca", onset: 0, mute: false, solo: false }] };
  assert("tornato al nome del file, lo stream_id implicito non si scrive",
    eq(entriesOf(serialize(back))[0], { file: "streams/risacca.yml" }),
    JSON.stringify(entriesOf(serialize(back))[0]));
}
{
  // Il tab Raw mostra lo stream risolto, non la voce del master: e' cio' che
  // suona, e cio' che la #184 rendera' modificabile.
  const s = open(MASTER).streams[0];
  const raw = serializeStream(s);
  assert("serializeStream di uno stream importato mostra il contenuto del file",
    /sample: mare\.wav/.test(raw) && /density: 40/.test(raw) && !/file:/.test(raw), raw);
}

/* ============================================================ */
section("voci che non si risolvono: un errore che nomina il file, e la voce intatta");
function brokenCase(label, entries, imports, re) {
  const m = jsyaml.dump({ streams: entries });
  let d = null, threw = null;
  try { d = open(m, imports); } catch (e) { threw = e; }
  assert(`${label}: il parse non lancia`, !threw, threw && threw.stack);
  if (!d) return;
  const u = d.unresolvedImports || [];
  assert(`${label}: la voce e' irrisolta`, u.length >= 1, JSON.stringify(d.unresolvedImports));
  assert(`${label}: il messaggio nomina il master`, u.length && /brano\.yml/.test(u[0].error),
    u.length && u[0].error);
  assert(`${label}: il messaggio dice cosa non va`, u.length && re.test(u[0].error),
    u.length && u[0].error);
  const out = entriesOf(serialize(d));
  assert(`${label}: la voce torna nel master com'era`, eq(out, entries),
    JSON.stringify(out) + " vs " + JSON.stringify(entries));
  return d;
}
brokenCase("file mancante", [{ file: "streams/manca.yml", onset: 2 }],
  { "streams/manca.yml": { ok: false, error: "file importato non trovato: configs/streams/manca.yml" } },
  /streams\/manca\.yml/);
brokenCase("file non letto (nessuna risposta del bridge)", [{ file: "streams/x.yml" }], {},
  /streams\/x\.yml/);
brokenCase("YAML malformato", [{ file: "streams/rotto.yml" }],
  { "streams/rotto.yml": ok("streams: [\n  - stream_id: a\n    sample: [") },
  /streams\/rotto\.yml.*malformato|malformato.*streams\/rotto\.yml/s);
brokenCase("due stream nel file", [{ file: "streams/due.yml" }],
  { "streams/due.yml": ok("streams:\n  - {stream_id: a, sample: a.wav}\n  - {stream_id: b, sample: b.wav}\n") },
  /un solo stream[\s\S]*2 stream/);
brokenCase("nessuno stream nel file", [{ file: "streams/vuoto.yml" }],
  { "streams/vuoto.yml": ok("seed: 3\n") }, /un solo stream[\s\S]*nessuno stream/);
brokenCase("documento vuoto", [{ file: "streams/vuoto.yml" }],
  { "streams/vuoto.yml": ok("") }, /un solo stream/);
brokenCase("una voce che non e' uno stream", [{ file: "streams/s.yml" }],
  { "streams/s.yml": ok("streams: [3]\n") }, /un solo stream/);
brokenCase("catena: file: dentro il file importato", [{ file: "streams/c.yml" }],
  { "streams/c.yml": ok("streams:\n  - file: altro.yml\n") }, /a sua volta 'file:'[\s\S]*altro\.yml/);
brokenCase("file: che non e' un path", [{ file: 3 }], {}, /file:/);
{
  // Regola 4: una chiave accanto a `file:` che non e' di piazzamento. Il
  // motore rifiuta prima di leggere: qui nemmeno se il testo c'e', e la
  // chiave NON entra nello stream — la voce non si risolve affatto.
  const d = brokenCase("chiave non di piazzamento", [{ file: "streams/risacca.yml", density: 80 }],
    IMPORTS, /'density'[\s\S]*stream_id, onset, mute, solo/);
  assert("chiave estranea: nessuno stream in memoria", d && d.streams.length === 0,
    d && JSON.stringify(d.streams.map(s => s.id)));
}
{
  // Regola 7: lo stesso file importato due volte senza stream_id fa due stem
  // con lo stesso nome. Il motore rifiuta il master; qui le voci importate
  // restano scritte com'erano e non entrano in memoria, senza rinominare
  // niente — nemmeno lo stream scritto nel master, che non si tocca.
  const entries = [{ file: "streams/risacca.yml" }, { file: "streams/risacca.yml", onset: 3 },
                   { stream_id: "risacca", onset: 0, duration: 2, sample: "a.wav" }];
  const d = brokenCase("stream_id duplicato", entries, IMPORTS, /stream_id duplicato[\s\S]*'risacca'/);
  assert("duplicato: le due voci importate sono irrisolte, lo stream scritto resta",
    d && d.unresolvedImports.length === 2 && d.streams.length === 1 && d.streams[0].id === "risacca",
    d && JSON.stringify({ u: d.unresolvedImports.length, s: d.streams.map(s => s.id) }));
  const ok2 = open(jsyaml.dump({ streams: [{ file: "streams/risacca.yml" },
    { file: "streams/risacca.yml", stream_id: "risacca2" }] }));
  assert("lo stesso file due volte con due stream_id: due stream",
    ok2.streams.length === 2 && ok2.streams[1].id === "risacca2", JSON.stringify(ok2.streams.map(s => s.id)));
}
{
  // Le voci irrisolte tornano al loro posto fra le altre.
  const entries = [
    { stream_id: "a", duration: 1, sample: "a.wav", onset: 0 },
    { file: "streams/manca.yml" },
    { file: "streams/risacca.yml", onset: 1 },
    { file: "streams/manca2.yml", mute: true },
  ];
  const d = open(jsyaml.dump({ streams: entries }));
  const out = entriesOf(serialize(d));
  assert("ordine del master preservato con voci irrisolte in mezzo",
    eq(out.map(e => e.file || e.stream_id), ["a", "streams/manca.yml", "streams/risacca.yml", "streams/manca2.yml"]),
    JSON.stringify(out));
  assert("default dello stream_id e colore indicizzati come nel master",
    d.streams[1].id === "risacca", JSON.stringify(d.streams.map(s => s.id)));
}

/* ============================================================ */
section("fingerprint: importato o scritto nel master, stesso hash");
{
  // Il motore calcola il fingerprint sullo stream gia' risolto: spostare uno
  // stream dal master a un file non lo marca dirty. La UI deve dire lo stesso.
  const imp = open(MASTER).streams[0];
  const resolved = { stream_id: "risacca", onset: 12.5, mute: true, duration: 30,
                     sample: "mare.wav", density: 40, grain: { duration: 0.05 } };
  const inl = parse(jsyaml.dump({ streams: [resolved] }), { samples: [] }).streams[0];
  assert("stesso hash della UI", fingerprintStream(imp, "wav") === fingerprintStream(inl, "wav"),
    fingerprintStream(imp, "wav") + " vs " + fingerprintStream(inl, "wav"));
  const elsewhere = { ...imp, imported: { ...imp.imported, file: "altrove/risacca.yml" } };
  assert("la provenienza non entra nell'hash",
    fingerprintStream(elsewhere, "wav") === fingerprintStream(imp, "wav"));
}

/* ============================================================ */
section("importEditError: il contenuto di uno stream importato non si modifica (#184)");
{
  assert("esportata", typeof Y.importEditError === "function");
  const E = Y.importEditError || (() => "missing");
  const d = open(MASTER);
  const [imp, inl] = d.streams;
  const next = (streams) => ({ ...d, streams });

  assert("stesso stato: niente", E(d, d) === null);
  assert("onset: e' piazzamento", E(d, next([{ ...imp, onset: 3 }, inl])) === null);
  assert("mute/solo: piazzamento", E(d, next([{ ...imp, mute: false, solo: true }, inl])) === null);
  assert("rename: stream_id e' piazzamento", E(d, next([{ ...imp, id: "onda" }, inl])) === null);
  assert("togliere lo stream importato si puo' (la voce sparisce dal master)",
    E(d, next([inl])) === null);
  assert("riordinare gli stream si puo'", E(d, next([inl, imp])) === null);
  assert("color non arriva nello YAML", E(d, next([{ ...imp, color: "#000" }, inl])) === null);
  assert("lo stream scritto nel master si modifica come sempre",
    E(d, next([imp, { ...inl, density: 99 }])) === null);

  const edit = E(d, next([{ ...imp, density: 41 }, inl]));
  assert("density di uno stream importato: rifiutata", edit && edit.kind === "edit" &&
    edit.id === "risacca" && edit.file === "streams/risacca.yml", JSON.stringify(edit));
  const dur = E(d, next([{ ...imp, duration: 20 }, inl]));
  assert("duration (resize): rifiutata, sta nel file", dur && dur.kind === "edit", JSON.stringify(dur));
  const edRen = E(d, next([{ ...imp, id: "onda", density: 41 }, inl]));
  assert("rename piu' modifica nello stesso passo: rifiutata", edRen && edRen.kind === "edit",
    JSON.stringify(edRen));

  const copy = JSON.parse(JSON.stringify(imp)); copy.id = "stream3";
  const dup = E(d, next([imp, inl, copy]));
  assert("una copia (paste/duplica) di uno stream importato: rifiutata (#186)",
    dup && dup.kind === "copy", JSON.stringify(dup));

  const { imported, ...embedded } = imp;
  const emb = E(d, next([embedded, inl]));
  assert("lo stream importato che perde la provenienza (finirebbe nel master): rifiutato",
    emb && emb.kind === "embed", JSON.stringify(emb));

  const fresh = E(d, next([imp, inl, { ...inl, id: "stream9" }]));
  assert("uno stream nuovo scritto nel master si aggiunge come sempre", fresh === null);

  // Lo split: la testa cambia la durata, la coda nasce — tutto un passo.
  const split = E(d, next([{ ...imp, duration: 10 }, inl, { ...imp, id: "stream3", onset: 22.5, duration: 20 }]));
  assert("split di uno stream importato: rifiutato (#187)", split !== null, JSON.stringify(split));
}

/* ============================================================ */
section("la migrazione di dephase non si dichiara compiuta su un file non riscritto");
{
  const legacy = RISACCA.replace("    density: 40\n", "    density: 40\n    dephase: 5\n");
  const d = open(MASTER, { "streams/risacca.yml": ok(legacy) });
  assert("il flag di provenienza c'e'", d.streams[0].deviationProbabilityLegacy === true);
  const cleared = Y.clearDeviationProbabilityLegacy(d);
  assert("salvare il master non riscrive il file: il flag resta acceso",
    cleared.streams[0].deviationProbabilityLegacy === true);
}

/* ============================================================ */
section("backend.fs.readImport: GET /import, mai un'eccezione");
{
  const calls = [];
  const replies = {
    "streams/risacca.yml": { status: 200, json: { ok: true, file: "streams/risacca.yml", text: RISACCA } },
    "streams/manca.yml":   { status: 200, json: { ok: false, reason: "missing", error: "file importato non trovato: configs/streams/manca.yml" } },
    "vecchio.yml":         { status: 404, json: null },
  };
  global.fetch = async (url) => {
    if (!url.includes("/import?")) return { ok: false, status: 404, json: async () => ({}) };
    calls.push(url);
    const file = decodeURIComponent(url.split("path=")[1] || "");
    if (file === "giu.yml") throw new Error("connessione rifiutata");
    const r = replies[file];
    return { ok: r.status === 200, status: r.status,
             json: async () => { if (r.json == null) throw new Error("non JSON"); return r.json; } };
  };
  const be = window.PGEBackend.create({ baseUrl: "http://x" });
  const run = async () => {
    const a = await be.fs.readImport("streams/risacca.yml");
    assert("letto: il testo", a.ok === true && a.text === RISACCA, JSON.stringify(a));
    assert("il path va nella query, codificato",
      calls[0] === "http://x/import?path=streams%2Frisacca.yml", calls[0]);
    const b = await be.fs.readImport("streams/manca.yml");
    assert("mancante: l'errore del bridge, che nomina il file",
      b.ok === false && /streams\/manca\.yml/.test(b.error), JSON.stringify(b));
    const c = await be.fs.readImport("vecchio.yml");
    assert("un bridge senza la rotta: un errore che nomina il file",
      c.ok === false && /vecchio\.yml/.test(c.error) && /404/.test(c.error), JSON.stringify(c));
    const d = await be.fs.readImport("giu.yml");
    assert("bridge giu': un errore, non un'eccezione",
      d.ok === false && /giu\.yml/.test(d.error) && /rifiutata/.test(d.error), JSON.stringify(d));

    // Dal bridge al parse, come fa app.jsx: i file della lista, poi il parse.
    const imports = {};
    for (const f of Y.streamFileRefs(MASTER)) imports[f] = await be.fs.readImport(f);
    const data = open(MASTER, imports);
    assert("bridge -> parse: lo stream importato c'e'",
      data.streams[0] && data.streams[0].id === "risacca" && data.streams[0].sample === "mare.wav");
  };
  run().catch(e => assert("readImport non lancia", false, e.stack));
}

process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
