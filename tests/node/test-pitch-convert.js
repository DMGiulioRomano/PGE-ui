/* =============================================================================
 * test-pitch-convert.js — tests for the pitch-unit conversion + clamp helpers
 * in envelope-loops.js (window.PGEEnv). Covers the bug where switching pitch
 * unit (e.g. cents → ratio) left `range`/`rangeEnv` unconverted and/or produced
 * values outside the destination unit's bounds.
 *
 * Run: node test-pitch-convert.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// yaml-bridge.js publishes window.PGE_BOUNDS (read by pitchUnitBounds);
// envelope-loops.js publishes window.PGEEnv. js-yaml is needed by yaml-bridge.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));

const E = window.PGEEnv;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function near(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

console.log("\n── module surface ──");
assert("PGEEnv exposes the new helpers",
  ["pitchUnitBounds", "clampToBounds", "convertPitchValue", "convertPitchEnv",
   "convertPitchRange", "convertPitchRangeEnv"].every(k => typeof E[k] === "function"),
  JSON.stringify(Object.keys(E)));

console.log("\n── pitchUnitBounds ──");
// preset units return the engine bounds verbatim (source of truth =
// window.PGE_BOUNDS.pitch, so the test tracks any future bound change in
// yaml-bridge.js rather than pinning literals).
const PB = window.PGE_BOUNDS.pitch;
assert("ratio bounds === PGE_BOUNDS.pitch.ratio",
  eq(E.pitchUnitBounds("ratio"), PB.ratio), JSON.stringify(E.pitchUnitBounds("ratio")));
assert("cents bounds === PGE_BOUNDS.pitch.cents",
  eq(E.pitchUnitBounds("cents"), PB.cents));
assert("semitones bounds === PGE_BOUNDS.pitch.semitones",
  eq(E.pitchUnitBounds("semitones"), PB.semitones));
assert("ratio rangeMax is the 2× cap (drives range clamp)",
  E.pitchUnitBounds("ratio").rangeMax === 2);
assert("edo string + divisions → ±3 octaves",
  eq(E.pitchUnitBounds("edo", 31), { min: -93, max: 93, rangeMax: 93 }));
assert("edo object form → ±3 octaves",
  eq(E.pitchUnitBounds({ edo: 24 }), { min: -72, max: 72, rangeMax: 72 }));

console.log("\n── convertPitchValue (absolute pitch) ──");
assert("cents 0 → ratio 1.0 (identity)",
  near(E.convertPitchValue(0, "cents", "ratio"), 1.0));
assert("cents 1200 → ratio 2.0 (one octave up)",
  near(E.convertPitchValue(1200, "cents", "ratio"), 2.0));
assert("cents -1200 → ratio 0.5 (one octave down)",
  near(E.convertPitchValue(-1200, "cents", "ratio"), 0.5));
assert("cents 3600 → ratio 8.0 (top of cents = top of ratio)",
  near(E.convertPitchValue(3600, "cents", "ratio"), 8.0));
assert("ratio 2.0 → semitones 12 (integer rounding)",
  E.convertPitchValue(2.0, "ratio", "semitones") === 12);
assert("clamp: absurd value clamps to ratio max",
  near(E.convertPitchValue(9999, "ratio", "ratio", null, null, PB.ratio), PB.ratio.max));
assert("clamp: tiny value clamps to ratio min",
  near(E.convertPitchValue(1e-9, "ratio", "ratio", null, null, PB.ratio), PB.ratio.min));

console.log("\n── convertPitchRange (detune width) ──");
assert("range 0 → 0 in any unit (cents → ratio)",
  E.convertPitchRange(0, "cents", "ratio", null, null, { min: 0, max: 2 }) === 0);
assert("range 0 ratio → 0 cents (no -Infinity from log2(0))",
  E.convertPitchRange(0, "ratio", "cents", null, null, { min: 0, max: 3600 }) === 0);
assert("range cents 1200 → ratio 2.0 (octave width)",
  near(E.convertPitchRange(1200, "cents", "ratio", null, null, { min: 0, max: 2 }), 2.0));
assert("range cents 3600 → clamped to ratio rangeMax 2.0 (would be 8×)",
  near(E.convertPitchRange(3600, "cents", "ratio", null, null, { min: 0, max: 2 }), 2.0));
assert("range ratio 2.0 → cents 1200",
  E.convertPitchRange(2.0, "ratio", "cents", null, null, { min: 0, max: 3600 }) === 1200);

console.log("\n── convertPitchRangeEnv ──");
const rEnv = [[0, 0], [0.5, 1200], [1, 3600]];
const rOut = E.convertPitchRangeEnv(rEnv, "cents", "ratio", null, null, { min: 0, max: 2 });
assert("range env: 0→0, 1200→2.0, 3600→clamp 2.0",
  eq(rOut, [[0, 0], [0.5, 2], [1, 2]]), JSON.stringify(rOut));
assert("range env: x (time) untouched",
  rOut[1][0] === 0.5 && rOut[2][0] === 1);

console.log("\n── convertPitchEnv (value env) with clamp ──");
const vEnv = [[0, -1200], [1, 1200]];
const vOut = E.convertPitchEnv(vEnv, "cents", "ratio", null, null, { min: 0.125, max: 8 });
assert("value env: -1200→0.5, 1200→2.0",
  eq(vOut, [[0, 0.5], [1, 2]]), JSON.stringify(vOut));

console.log("\n── round-trip stability ──");
const back = E.convertPitchValue(E.convertPitchValue(700, "cents", "ratio"), "ratio", "cents");
assert("cents 700 → ratio → cents ≈ 700", near(back, 700, 1));

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", () => {
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
});
