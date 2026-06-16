/* =============================================================================
 * test-dephase.js — tests for dephase.js (window.PGEDephase), the single
 * source of truth that classifies a stream's `dephase` value into
 * off / implicit / global / perParam, mirroring the engine's
 * GateFactory._classify_dephase ordering (envelope-like BEFORE dict→specific).
 *
 * Regression guard for the "cubic on a global dephase envelope" bug: wrapEnv
 * turns a [[t,v],…] envelope into the typed `{type, points}` object form for
 * non-linear global interpolation, and that object must still read as a GLOBAL
 * envelope — not be mistaken for a per-param dict (which closed the envelope and
 * flipped the Inspector to per-param).
 *
 * Run: node test-dephase.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// yaml-bridge.js (window.PGEYaml.DEPHASE_IMPLICIT) and envelope-loops.js
// (window.PGEEnv.isTypedEnv) must load first — dephase.js reads both at call time.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/dephase.js"), "utf8"));

const D = window.PGEDephase;
const { DEPHASE_IMPLICIT } = window.PGEYaml;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

console.log("\n── module surface ──");
assert("PGEDephase exposes mode + isEnvValue",
  D && typeof D.mode === "function" && typeof D.isEnvValue === "function",
  JSON.stringify(D && Object.keys(D)));

console.log("\n── mode(): off / implicit ──");
assert("undefined → off (key absent)", D.mode(undefined) === "off");
assert("null → off",                   D.mode(null) === "off");
assert("false → off",                  D.mode(false) === "off");
assert("DEPHASE_IMPLICIT sentinel → implicit", D.mode(DEPHASE_IMPLICIT) === "implicit");

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

console.log(`\n${fail ? "✗" : "✓"} dephase: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
