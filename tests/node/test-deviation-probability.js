/* =============================================================================
 * test-deviation-probability.js — tests for deviation-probability.js
 * (window.PGEDeviationProb), the single source of truth that classifies a
 * stream's `deviation_probability` value into off / implicit / global /
 * perParam, mirroring the engine's GateFactory._classify_deviation_probability
 * ordering (envelope-like BEFORE dict→specific).
 *
 * Regression guard for the "cubic on a global envelope" bug: wrapEnv
 * turns a [[t,v],…] envelope into the typed `{type, points}` object form for
 * non-linear global interpolation, and that object must still read as a GLOBAL
 * envelope — not be mistaken for a per-param dict (which closed the envelope and
 * flipped the Inspector to per-param).
 *
 * Run: node test-deviation-probability.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// yaml-bridge.js (window.PGEYaml.DEVIATION_PROB_IMPLICIT) and envelope-loops.js
// (window.PGEEnv.isTypedEnv) must load first — deviation-probability.js reads
// both at call time.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/deviation-probability.js"), "utf8"));

const D = window.PGEDeviationProb;
const { DEVIATION_PROB_IMPLICIT } = window.PGEYaml;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

console.log("\n── module surface ──");
assert("PGEDeviationProb exposes mode + isEnvValue",
  D && typeof D.mode === "function" && typeof D.isEnvValue === "function",
  JSON.stringify(D && Object.keys(D)));

console.log("\n── mode(): off / implicit ──");
assert("undefined → off (key absent)", D.mode(undefined) === "off");
assert("null → off",                   D.mode(null) === "off");
assert("false → off",                  D.mode(false) === "off");
// `true` non è off: bool è sottoclasse di int in Python, e il motore lo prende
// dal ramo numerico. Verificato: create_gate(True, param_key='volume') → RandomGate.
assert("true → global (il motore ne fa un RandomGate su float(True))",
  D.mode(true) === "global");
assert("DEVIATION_PROB_IMPLICIT sentinel → implicit", D.mode(DEVIATION_PROB_IMPLICIT) === "implicit");

console.log("\n── mode(): global (scalar + envelope forms) ──");
assert("number → global",              D.mode(50) === "global");
assert("0 → global (scalar 0%)",       D.mode(0) === "global");
assert("array envelope → global",      D.mode([[0, 0], [1, 100]]) === "global");
// THE FIX: typed {type, points} envelope (what wrapEnv emits for cubic) → global.
assert("typed cubic envelope → global",
  D.mode({ type: "cubic", points: [[0, 0], [1, 100]] }) === "global");
assert("typed exp envelope → global",
  D.mode({ type: "exp", points: [[0, 0], [1, 100]] }) === "global");
// Il dict con il solo `points` — forma che l'editor non emette mai (wrapEnv
// scrive il dict solo per dire un interp non lineare) ma che il motore accetta:
// `is_envelope_like` guarda che `points` ci sia, non che ci sia anche `type`.
// Verificato sul motore: GateFactory.create_gate lo costruisce come EnvelopeGate.
// Leggerlo per-parametro apriva il pannello sbagliato.
assert("dict con points ma senza type → global (come il motore)",
  D.mode({ points: [[0, 0], [1, 100]] }) === "global");
// La trappola a valle: dichiararlo envelope senza che unwrapEnv lo sappia
// leggere lo farebbe aprire VUOTO nell'editor, e un commit lì sopra lo
// svuoterebbe davvero. È lo stesso giro che fa listEnvelopes → EnvelopeEditor:
// isEnvValue decide che è un envelope globale, unwrapEnv ne prende i punti.
{
  const stream = { id: "s1", deviationProbability: { points: [[0, 0], [1, 100]] } };
  assert("giro completo: dichiarato envelope…", D.isEnvValue(stream.deviationProbability));
  const un = window.PGEEnv.unwrapEnv(stream.deviationProbability);
  assert("…e aperto con i suoi punti, non vuoto",
    un.items.length === 2 && un.interp === "linear", JSON.stringify(un));
  const typed = window.PGEEnv.unwrapEnv({ type: "cubic", points: [[0, 0], [1, 100]] });
  assert("il typed env resta letto col suo interp (il bug per cui il modulo esiste)",
    typed.items.length === 2 && typed.interp === "cubic", JSON.stringify(typed));
}

console.log("\n── mode(): perParam ──");
assert("per-param dict → perParam", D.mode({ volume: 50 }) === "perParam");
assert("per-param dict with env value → perParam",
  D.mode({ volume: [[0, 0], [1, 100]] }) === "perParam");
assert("per-param dict with typed env value → perParam",
  D.mode({ pitch: { type: "cubic", points: [[0, 0], [1, 100]] } }) === "perParam");

console.log("\n── isEnvValue() ──");
assert("array → env",                    D.isEnvValue([[0, 0], [1, 1]]) === true);
assert("typed {type,points} → env",      D.isEnvValue({ type: "cubic", points: [[0, 0], [1, 1]] }) === true);
assert("{points} senza type → env (metà dict di is_envelope_like)",
  D.isEnvValue({ points: [[0, 0], [1, 1]] }) === true);
assert("dict per-parametro senza points → non env",
  D.isEnvValue({ volume: [[0, 0], [1, 1]] }) === false);
assert("number → not env",               D.isEnvValue(50) === false);
assert("per-param dict → not env",       D.isEnvValue({ volume: 50 }) === false);
assert("null → not env",                 D.isEnvValue(null) === false);
assert("false → not env",                D.isEnvValue(false) === false);
assert("string → not env",               D.isEnvValue("cubic") === false);

console.log("\n── PARAM_KEYS ──");
assert("PARAM_KEYS è la lista che il motore consulta",
  JSON.stringify(D.PARAM_KEYS) === JSON.stringify(
    ["volume", "pan", "duration", "pitch", "pointer", "reverse", "read_direction", "envelope"]),
  JSON.stringify(D.PARAM_KEYS));

/* error() — i corpi che il motore rifiuta da PGE #209. Prima li accettava in
   silenzio e li leggeva come 100% (AlwaysGate): il render riusciva producendo
   l'opposto di quanto scritto. Ora solleva, e l'Inspector lo dice prima. */
console.log("\n── error(): i cinque stati che NON sono errori (PGE #210) ──");
assert("chiave assente → nessun errore",      D.error(undefined) === null);
assert("chiave vuota (sentinella) → nessun errore", D.error(DEVIATION_PROB_IMPLICIT) === null);
assert("dict vuoto → nessun errore",          D.error({}) === null);
assert("false → nessun errore",               D.error(false) === null);
assert("dict con sola chiave a null → nessun errore", D.error({ reverse: null }) === null);
assert("scalare → nessun errore",             D.error(50) === null);
assert("scalare 0 → nessun errore",           D.error(0) === null);
assert("true → nessun errore (per il motore è il numero 1)", D.error(true) === null);
assert("envelope valido → nessun errore",     D.error([[0, 0], [1, 100]]) === null);
assert("envelope tipizzato valido → nessun errore",
  D.error({ type: "cubic", points: [[0, 0], [1, 100]] }) === null);
assert("blocco compatto (annidato) → nessun errore",
  D.error([[[[0, 0], [100, 50]], 1.0, 4]]) === null);
// Le due forme in cui il corpo È il gruppo o il blocco, non li contiene:
// is_envelope_like le prova sull'oggetto intero prima di scorrerlo. Verificato
// sul motore: entrambe → EnvelopeGate.
assert("BP group diretto → nessun errore (PGE #64)",
  D.error([[[0, 0], [1, 100]], "cubic"]) === null);
assert("blocco compatto nudo → nessun errore",
  D.error([[[0, 0], [100, 50]], 1.0, 4]) === null);
assert("BP group diretto sotto una chiave per-parametro → nessun errore",
  D.error({ volume: [[[0, 0], [1, 100]], "cubic"] }) === null);
assert("blocco compatto nudo sotto una chiave per-parametro → nessun errore",
  D.error({ pitch: [[[0, 0], [100, 50]], 1.0, 4] }) === null);

console.log("\n── error(): envelope globale malformato ──");
assert("lista vuota → env/empty",
  JSON.stringify(D.error([])) === JSON.stringify({ kind: "env", reason: "empty", value: [] }),
  JSON.stringify(D.error([])));
assert("lista senza breakpoint → env/shape", (D.error(["x"]) || {}).reason === "shape");
assert("points vuoti → env/empty",
  (D.error({ type: "linear", points: [] }) || {}).reason === "empty");
assert("points scalare → env/shape (il motore legge la chiave, non il tipo)",
  (D.error({ type: "linear", points: 5 }) || {}).reason === "shape");
assert("globale malformato → nessun param nominato",
  D.error([]).param === undefined, JSON.stringify(D.error([])));
// Il ramo dict di _envBodyError, prima raggiungibile solo per-parametro: è la
// grafia più plausibile del terzo corpo malformato di PGE #209. Tutti e quattro
// verificati sul motore → InvalidFieldValueError.
assert("{points:} lasciata vuota → env/shape",
  (D.error({ points: null }) || {}).reason === "shape", JSON.stringify(D.error({ points: null })));
assert("{points: 'x'} → env/shape", (D.error({ points: "x" }) || {}).reason === "shape");
assert("{points: []} globale → env/empty", (D.error({ points: [] }) || {}).reason === "empty");
assert("{type: cubic, points: null} → env/shape",
  (D.error({ type: "cubic", points: null }) || {}).reason === "shape");
assert("{points: [[0,1]]} globale valido → nessun errore",
  D.error({ points: [[0, 1]] }) === null);

console.log("\n── error(): valore per-parametro malformato ──");
assert("volume: [] → env/empty su volume",
  JSON.stringify(D.error({ volume: [] })) ===
  JSON.stringify({ kind: "env", reason: "empty", param: "volume", value: [] }),
  JSON.stringify(D.error({ volume: [] })));
assert("pitch: {} (dict senza points) → env/shape su pitch",
  (D.error({ pitch: {} }) || {}).param === "pitch" &&
  (D.error({ pitch: {} }) || {}).reason === "shape");
assert("pointer: ['x'] → env/shape su pointer",
  (D.error({ pointer: ["x"] }) || {}).param === "pointer");
assert("valore di tipo estraneo → type",
  (D.error({ volume: "x" }) || {}).kind === "type");
// Il gate chiede il dict una chiave alla volta: quelle che non è mai chiamato a
// leggere non le legge nessuno, e un corpo rotto lì dentro non rompe il render.
assert("chiave che il motore non consulta → nessun errore", D.error({ foo: [] }) === null);
assert("chiave buona accanto a una ignota → nessun errore", D.error({ foo: [], volume: 50 }) === null);

console.log("\n── error(): tipo di primo livello ──");
assert("stringa → type", (D.error("ciao") || {}).kind === "type");
assert("stringa → riporta il valore", D.error("ciao").value === "ciao");

// Falso negativo dichiarato: il motore rifiuta anche la lista mista, il mirror
// no. È la direzione voluta — un avviso in meno, mai uno su uno YAML che rende.
assert("lista mista buono+rotto → passa (mirror conservativo)",
  D.error([[0, 0], "x"]) === null);

console.log(`\n${fail ? "✗" : "✓"} deviation_probability: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
