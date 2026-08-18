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
// Boundary: a bare {points} dict without `type` is NOT the UI's typed form
// (wrapEnv always emits `type`), so the editor classifier treats it as a dict.
// The engine's is_envelope_like is looser (any dict with 'points'); supporting
// that hand-authored form would also require unwrapEnv to read it — out of scope.
assert("dict with points but no type → perParam (UI form always carries type)",
  D.mode({ points: [[0, 0], [1, 100]] }) === "perParam");

console.log("\n── mode(): perParam ──");
assert("per-param dict → perParam", D.mode({ volume: 50 }) === "perParam");
assert("per-param dict with env value → perParam",
  D.mode({ volume: [[0, 0], [1, 100]] }) === "perParam");
assert("per-param dict with typed env value → perParam",
  D.mode({ pitch: { type: "cubic", points: [[0, 0], [1, 100]] } }) === "perParam");

console.log("\n── isEnvValue() ──");
assert("array → env",                    D.isEnvValue([[0, 0], [1, 1]]) === true);
assert("typed {type,points} → env",      D.isEnvValue({ type: "cubic", points: [[0, 0], [1, 1]] }) === true);
assert("{points} without type → not env (UI form always typed)",
  D.isEnvValue({ points: [[0, 0], [1, 1]] }) === false);
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
assert("blocco compatto → nessun errore",     D.error([[[[0, 0], [100, 50]], 1.0, 4]]) === null);

console.log("\n── error(): envelope globale malformato ──");
assert("lista vuota → env/empty",
  JSON.stringify(D.error([])) === JSON.stringify({ kind: "env", reason: "empty", value: [] }),
  JSON.stringify(D.error([])));
assert("lista senza breakpoint → env/shape", (D.error(["x"]) || {}).reason === "shape");
assert("points vuoti → env/empty",
  (D.error({ type: "linear", points: [] }) || {}).reason === "empty");
// Limite noto, ereditato dal classificatore: isEnvValue chiede che `points` sia
// una lista, mentre al motore basta che la chiave ci sia. Un `points` scalare
// qui non è nemmeno un envelope, quindi finisce nel ramo per-parametro e passa.
assert("points scalare → passa (il classificatore non lo legge come envelope)",
  D.error({ type: "linear", points: 5 }) === null);
assert("globale malformato → nessun param nominato",
  D.error([]).param === undefined, JSON.stringify(D.error([])));

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
