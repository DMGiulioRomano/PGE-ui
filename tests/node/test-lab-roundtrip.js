/* =============================================================================
 * test-lab-roundtrip.js — un documento del laboratorio torna intatto da PGE-ui
 * (#188, passo 4 del piano di mare-nostrum "lo stream come file").
 *
 * Un file scritto dal laboratorio di mare-nostrum, importato in un master con
 * `- file:` e passato da PGE-ui — aperto, salvato, modificato in una chiave —
 * deve tornare nel laboratorio con tutto quello che aveva. I casi a rischio
 * sono le strutture che il laboratorio scrive e che il resto di PGE-ui non
 * produce da se':
 *
 *   - `grain.envelope: {states, curve}` (la finestra che cambia nel tempo),
 *     con `step` / `cubic` / `linear` sui punti della curve;
 *   - `voices.pitch.progression: [[t, accordo, rivolto?], ...]` e il suo
 *     `interp`;
 *   - `voices:` con `unit: {edo: N}`, `normalized` e una strategia per asse;
 *   - gli inviluppi col tipo sul punto (`[[0, 0.001, cubic], [1, 0.016]]`);
 *   - `seed`, `stream_id` e `onset` del file.
 *
 * Le fixture sono in tests/fixtures/lab/: documenti SCRITTI DAL LABORATORIO
 * (tests/fixtures/lab/genera/ fa girare la pagina vera), non a mano, e un
 * master che li importa tutti. La strada e' quella dell'editor, non un modello:
 * `importRefs` + `parse(text, {imports})` come `onProjectSelect`,
 * `serialize` + `serializeImports` / `changedImports` / `importedFileText` come
 * `onSave` (app.jsx, #183 e #184). "Lo stesso documento" e' lo stesso YAML una
 * volta parsato: l'ordine delle chiavi di un mapping non conta, i valori si.
 *
 * Il ritorno vero, nel laboratorio e nel motore, non si chiede da qui:
 *   - nel motore lo chiede tests/parity/test-lab-roundtrip-parity.js (stesso
 *     fingerprint e stesso piazzamento prima e dopo PGE-ui);
 *   - nel laboratorio lo si e' verificato con la sua pagina (vedi
 *     tests/fixtures/lab/README.md): mare-nostrum non e' un checkout fratello
 *     di questo repo, e in CI sarebbe uno skip permanente.
 *
 * Run: node test-lab-roundtrip.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));

const Y = window.PGEYaml;
const jsyaml = window.jsyaml;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function section(t) { console.log(`\n── ${t} ──`); }

// Il verdetto e' un handler `exit` registrato qui, a livello di modulo: un
// assert appeso in fondo conta, e un'eccezione a meta' non passa per un
// riepilogo pulito (test-suite-harness.js lo pretende da ogni suite).
process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});

/* ---------- confronto ----------
 * Lo stesso documento YAML: i mapping senza ordine, le liste in ordine, i
 * numeri ESATTI (un 0.3333333333333333 che diventa 0.33333333333333337 e' una
 * curve diversa, e la guardia del laboratorio la vede), una chiave assente
 * diversa da una presente a null. `diffDoc` dice dove, per i messaggi. */
function diffDoc(a, b, at = "", out = []) {
  if (a === b) return out;
  const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${at || "."}: lunghezza ${a.length} → ${b.length}`);
    else a.forEach((x, i) => diffDoc(x, b[i], `${at}[${i}]`, out));
    return out;
  }
  if (isMap(a) && isMap(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(k in b)) out.push(`${at}.${k}: tolta (era ${JSON.stringify(a[k])})`);
      else if (!(k in a)) out.push(`${at}.${k}: aggiunta (${JSON.stringify(b[k])})`);
      else diffDoc(a[k], b[k], `${at}.${k}`, out);
    }
    return out;
  }
  out.push(`${at || "."}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return out;
}
const sameDoc = (a, b) => diffDoc(a, b).length === 0;
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------- fixture ---------- */
const LAB      = path.join(__dirname, "../fixtures/lab");
const MASTER   = fs.readFileSync(path.join(LAB, "master.yml"), "utf8");
const STREAMS  = fs.readdirSync(path.join(LAB, "streams")).filter(f => f.endsWith(".yml")).sort();
const fileOf   = (name) => `streams/${name}`;
const DISK     = Object.fromEntries(STREAMS.map(n => [fileOf(n),
  fs.readFileSync(path.join(LAB, "streams", n), "utf8")]));
const DOC      = Object.fromEntries(Object.entries(DISK).map(([f, t]) => [f, jsyaml.load(t)]));
const MASTER_DOC = jsyaml.load(MASTER);

/* Aprire come `onProjectSelect`: i file che il master nomina, letti (qui dal
 * disco delle fixture, la' dal bridge con GET /import), poi il parse che li
 * risolve. `files` sostituisce un testo, per riaprire cio' che si e' scritto. */
function open(files = DISK) {
  const imports = {};
  for (const f of Y.importRefs(MASTER)) {
    imports[f] = Object.prototype.hasOwnProperty.call(files, f) ? { text: files[f] } : { error: "assente" };
  }
  return Y.parse(MASTER, { project: "master", samples: [], imports });
}
/* Il "disco" dei file importati subito dopo l'apertura, come lo tiene
 * `importDiskRef`: la loro riscrittura, non i byte letti. */
const diskRef = (data) => Y.serializeImports(data).files;
/* Salvare come `onSave` (`importWrites`): il master, e i soli file cambiati
 * rispetto al disco, ognuno col testo che va davvero su disco. */
function save(data, disk) {
  const imp = Y.serializeImports(data);
  const bodies = Y.changedImports(imp.files, disk);
  const texts = {};
  for (const f of Object.keys(bodies)) texts[f] = Y.importedFileText(f, bodies[f]);
  return { master: Y.serialize(data), conflicts: imp.conflicts, bodies, texts, files: imp.files };
}
const withStream = (data, id, patch) => ({
  ...data, streams: data.streams.map(s => (s.id === id ? Y.applyStreamPatch(s, patch) : s)),
});

/* ============================================================
 * 1. Le fixture: documenti del laboratorio, e ogni caso c'e'
 * ============================================================ */
section("le fixture sono documenti del laboratorio");
{
  const FILES = Object.keys(DOC);
  assert("cinque documenti in tests/fixtures/lab/streams/", FILES.length === 5, FILES.join(", "));
  for (const f of FILES) {
    const doc = DOC[f], st = doc.streams && doc.streams[0];
    const id = path.basename(f).replace(/\.ya?ml$/, "");
    assert(`${f}: un solo stream, e lo stream_id e' il nome del file (mare-nostrum #5)`,
      Array.isArray(doc.streams) && doc.streams.length === 1 && st.stream_id === id,
      JSON.stringify(st && st.stream_id));
    assert(`${f}: porta il seed, ed e' quello del master (o il motore avvisa [SEED])`,
      typeof doc.seed === "number" && doc.seed === MASTER_DOC.seed, String(doc.seed));
    assert(`${f}: testa e stream dicono la stessa durata, e l'onset e' un numero`,
      doc.duration === st.duration && typeof st.onset === "number");
  }
  // Uno scenario per ogni documento generato: rigenerarli e' compito della
  // pagina del laboratorio, non di una mano sul YAML (genera/genera.py).
  for (const f of FILES) {
    const name = path.basename(f, ".yml");
    if (name === "risacca") continue;     // la fixture di mare-nostrum, copiata
    assert(`${f}: ha il suo scenario in fixtures/lab/genera/`,
      fs.existsSync(path.join(LAB, "genera", name + ".js")));
  }
}

section("ogni caso dell'issue sta in almeno una fixture");
{
  const streams = Object.values(DOC).map(d => d.streams[0]);
  const isPt = (p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number";
  const typed = (pts) => Array.isArray(pts) && pts.some(p => isPt(p) && typeof p[2] === "string");
  const multistate = streams.map(s => s.grain && s.grain.envelope).find(e => e && e.states && e.curve);
  assert("grain.envelope a stati: {states, curve} con nomi di finestra",
    !!multistate && multistate.states.every(s => typeof s[0] === "number" && typeof s[1] === "string"));
  const tipi = multistate ? new Set(multistate.curve.slice(0, -1).map(p => p[2] || "linear")) : new Set();
  assert("…con step, cubic e linear (sottinteso) sui punti della curve",
    ["step", "cubic", "linear"].every(t => tipi.has(t)), [...tipi].join(", "));
  assert("…e una finestra che torna (uno stato nuovo, non lo stesso)",
    !!multistate && multistate.states.length > new Set(multistate.states.map(s => s[1])).size);

  const prog = streams.map(s => s.voices && s.voices.pitch).find(p => p && p.strategy === "chord_progression");
  assert("voices.pitch.progression con un rivolto (terzo elemento) e il suo interp",
    !!prog && prog.progression.some(p => p.length === 3) && typeof prog.interp === "string");

  const voci = streams.map(s => s.voices).find(v => v && v.pitch && v.pitch.unit && typeof v.pitch.unit === "object");
  assert("voices: unit {edo: N}", !!voci && Number.isInteger(voci.pitch.unit.edo));
  assert("…normalized: true sul pointer", !!voci && voci.pointer && voci.pointer.normalized === true);
  assert("…una strategia per ognuno dei quattro assi",
    !!voci && ["pitch", "onset_offset", "pointer", "pan"].every(k => voci[k] && voci[k].strategy));

  const listaTipata = streams.some(s =>
    [s.grain && s.grain.duration, s.pan, s.volume, s.fill_factor, s.pitch && s.pitch.ratio].some(typed));
  assert("un inviluppo nella lista col tipo sul punto ([t, v, cubic])", listaTipata);

  assert("onset: 0 nei documenti nati nel laboratorio",
    streams.filter(s => s.onset === 0).length >= 4);
  assert("…e uno aperto dal brano col suo piazzamento (onset e mute del file)",
    streams.some(s => s.onset > 0 && s.mute === true));
}

section("il master importa ogni fixture una volta");
{
  const refs = Y.importRefs(MASTER);
  assert("importRefs elenca i cinque file, nessuno due volte",
    refs.length === 5 && new Set(refs).size === 5 && refs.every(f => f in DOC), refs.join(", "));
  const voci = MASTER_DOC.streams.filter(e => "file" in e);
  assert("accanto a file: solo chiavi di piazzamento",
    voci.every(e => Object.keys(e).every(k => k === "file" || Y.PLACEMENT_KEYS.includes(k))));
  assert("e uno stream scritto dentro, accanto agli importati",
    MASTER_DOC.streams.some(e => !("file" in e)));
}

/* ============================================================
 * 2. Aperto e salvato senza toccare niente
 * ============================================================ */
const D0 = open();
const DISK0 = diskRef(D0);

section("aperto: gli import si risolvono");
{
  assert("nessun errore di import", !D0.importErrors, JSON.stringify(D0.importErrors));
  assert("niente voci irrisolte", !D0._unresolvedImports);
  assert("sei stream, cinque importati",
    D0.streams.length === 6 && D0.streams.filter(s => s._import).length === 5,
    D0.streams.map(s => s.id).join(", "));
  assert("il controllo di round-trip del caricamento non trova niente",
    Y.roundTripDiff(D0).length === 0, JSON.stringify(Y.roundTripDiff(D0)));
}

section("salvato senza toccare niente");
{
  const out = save(D0, DISK0);
  assert("nessun file importato da riscrivere", Object.keys(out.bodies).length === 0,
    Object.keys(out.bodies).join(", "));
  assert("nessun conflitto", out.conflicts.length === 0);
  const m = jsyaml.load(out.master);
  assert("il master e' lo stesso YAML", sameDoc(MASTER_DOC, m), diffDoc(MASTER_DOC, m).join("\n      "));
}

/* Il caso che conta davvero: un salvataggio senza modifiche non scrive i file,
 * ma il primo tocco a uno stream importato riscrive il SUO file per intero,
 * dallo stato. Quello che PGE-ui scriverebbe, file per file, deve essere gia'
 * adesso il documento che il laboratorio ha scritto. */
section("cio' che PGE-ui scriverebbe e' il documento del laboratorio");
for (const f of Object.keys(DOC)) {
  const text = Y.importedFileText(f, DISK0[f]);
  const back = jsyaml.load(text);
  assert(`${f}: lo stesso YAML, testa e stream`, sameDoc(DOC[f], back),
    diffDoc(DOC[f], back).join("\n      "));
}

/* Le stesse cose, nominate: se il confronto generico qui sopra si rompe, queste
 * dicono quale delle strutture dell'issue e' andata persa. */
section("struttura per struttura");
{
  const w = (f) => jsyaml.load(DISK0[f]).streams[0];
  const o = (f) => DOC[f].streams[0];
  const F = fileOf("finestra.yml"), P = fileOf("progressione.yml"), V = fileOf("voci.yml"),
        T = fileOf("tipo-sul-punto.yml"), R = fileOf("risacca.yml");
  assert("grain.envelope {states, curve}: stati e curve identici, tipi sui punti compresi",
    sameDoc(o(F).grain.envelope, w(F).grain.envelope),
    diffDoc(o(F).grain.envelope, w(F).grain.envelope).join("; "));
  assert("progression e interp identici", sameDoc(o(P).voices.pitch, w(P).voices.pitch),
    diffDoc(o(P).voices.pitch, w(P).voices.pitch).join("; "));
  assert("voices: unit {edo}, normalized e le quattro strategie",
    sameDoc(o(V).voices, w(V).voices), diffDoc(o(V).voices, w(V).voices).join("; "));
  for (const k of ["fill_factor", "pan", "volume"]) {
    assert(`${k}: il tipo resta sul suo punto`, sameDoc(o(T)[k], w(T)[k]), diffDoc(o(T)[k], w(T)[k]).join("; "));
  }
  assert("grain.duration e pitch.ratio: il tipo resta sul suo punto",
    sameDoc(o(T).grain.duration, w(T).grain.duration) && sameDoc(o(T).pitch.ratio, w(T).pitch.ratio));
  assert("un {type, points} resta un {type, points}", sameDoc(o(R).fill_factor, w(R).fill_factor));
  for (const f of Object.keys(DOC)) {
    const doc = jsyaml.load(DISK0[f]);
    const ident = (d) => ({ seed: d.seed, stream_id: d.streams[0].stream_id,
                            onset: d.streams[0].onset, mute: d.streams[0].mute });
    assert(`${f}: seed, stream_id, onset e mute del file restano quelli del file`,
      sameDoc(ident(DOC[f]), ident(doc)), diffDoc(ident(DOC[f]), ident(doc)).join("; "));
  }
  const coro = D0.streams.find(s => s.id === "coro");
  assert("…mentre nel brano vale il piazzamento del master (coro a 3, risacca a 2.5 e non muta)",
    !!coro && coro.onset === 3 && D0.streams.find(s => s.id === "risacca").onset === 2.5
      && D0.streams.find(s => s.id === "risacca").mute === false
      && D0.streams.find(s => s.id === "tipo-sul-punto").mute === true);
}

/* ============================================================
 * 3. Una chiave estranea toccata: tutto il resto resta
 * ============================================================ */
section("volume toccato, uno stream alla volta");
for (const s of D0.streams.filter(x => x._import)) {
  const f = s._import.file;
  // Il gesto dell'Inspector: `volume` scalare, l'inviluppo (se c'era) tolto.
  const d1 = withStream(D0, s.id, { volume: -3, volumeEnv: null });
  const out = save(d1, DISK0);
  assert(`${s.id}: si riscrive solo ${f}`, Object.keys(out.bodies).join() === f,
    Object.keys(out.bodies).join(", "));
  const expected = clone(DOC[f]);
  expected.streams[0].volume = -3;
  const written = jsyaml.load(out.texts[f]);
  assert(`${s.id}: nel file cambia volume e nient'altro`, sameDoc(expected, written),
    diffDoc(expected, written).join("\n      "));
  const m = jsyaml.load(out.master);
  assert(`${s.id}: il master non cambia`, sameDoc(MASTER_DOC, m), diffDoc(MASTER_DOC, m).join("\n      "));

  // Riaperto con il file appena scritto, e' gia' il disco: un secondo
  // salvataggio non riscrive niente, e lo stream ha il volume nuovo.
  const reopened = open({ ...DISK, [f]: out.texts[f] });
  const again = save(reopened, { ...DISK0, ...out.bodies });
  assert(`${s.id}: riaperto, il secondo salvataggio non riscrive niente`,
    Object.keys(again.bodies).length === 0, Object.keys(again.bodies).join(", "));
  const r = reopened.streams.find(x => x.id === s.id);
  assert(`${s.id}: riaperto, il volume e' -3 e lo stream e' ancora del suo file`,
    r && r.volume === -3 && r.volumeEnv == null && r._import && r._import.file === f);
}

/* ============================================================
 * 4. Il confronto discrimina
 * ============================================================ */
/* Un confronto che direbbe "uguale" a tutto renderebbe verde ogni sezione qui
 * sopra. Ogni perdita che l'issue teme, applicata a mano al documento scritto,
 * deve farlo parlare. */
section("il confronto vede le perdite che l'issue teme");
{
  const F = fileOf("finestra.yml"), P = fileOf("progressione.yml"), V = fileOf("voci.yml"),
        T = fileOf("tipo-sul-punto.yml");
  const losses = [
    ["il tipo tolto da un punto della curve", F, d => { d.streams[0].grain.envelope.curve[0].pop(); }],
    ["la finestra ridotta a una stringa", F, d => { d.streams[0].grain.envelope = "hanning"; }],
    ["una posizione di stato arrotondata", F, d => { d.streams[0].grain.envelope.states[1][0] = 0.3333; }],
    ["l'interp della progressione tolto", P, d => { delete d.streams[0].voices.pitch.interp; }],
    ["il rivolto tolto da un passo", P, d => { d.streams[0].voices.pitch.progression[1].pop(); }],
    ["unit {edo} diventato edo", V, d => { d.streams[0].voices.pitch.unit = "edo"; }],
    ["normalized tolto", V, d => { delete d.streams[0].voices.pointer.normalized; }],
    ["il tipo sul punto tolto", T, d => { d.streams[0].grain.duration[0].pop(); }],
    ["la lista tipata diventata {type, points}", T, d => {
      d.streams[0].grain.duration = { type: "cubic", points: [[0, 0.001], [0.4, 0.008], [1, 0.016]] }; }],
    ["il seed del file tolto", F, d => { delete d.seed; }],
    ["onset: 0 tolto (il motore legge lo stesso, il file no)", F, d => { delete d.streams[0].onset; }],
    ["lo stream_id del file sostituito da quello del master", V, d => { d.streams[0].stream_id = "coro"; }],
    ["un 2 diventato '2'", F, d => { d.streams[0].fill_factor = "2"; }],
  ];
  for (const [label, f, mut] of losses) {
    const d = jsyaml.load(DISK0[f]);
    mut(d);
    assert(`${label}: il confronto lo vede`, !sameDoc(DOC[f], d));
  }
}
