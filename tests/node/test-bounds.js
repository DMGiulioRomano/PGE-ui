/* =============================================================================
 * test-bounds.js — tests for the engine→UI bounds mapping in bounds.js
 * (window.PGEBounds). The bridge's /bounds endpoint returns the engine's raw
 * GRANULAR_PARAMETERS + pitch records; mergeEngineBounds folds them into the
 * UI's window.PGE_BOUNDS (static fallback), and apply() installs the result.
 *
 * Run: node test-bounds.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// yaml-bridge.js publishes window.PGE_BOUNDS (the static fallback); bounds.js
// publishes window.PGEBounds. js-yaml is required by yaml-bridge at load.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/bounds.js"), "utf8"));

const B = window.PGEBounds;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

console.log("\n── module surface ──");
assert("PGEBounds exposes mergeEngineBounds + apply + ENGINE_PARAM_MAP",
  typeof B.mergeEngineBounds === "function" &&
  typeof B.apply === "function" &&
  B.ENGINE_PARAM_MAP && typeof B.ENGINE_PARAM_MAP === "object");

console.log("\n── static fallback keys present in PGE_BOUNDS ──");
const NEEDED = ["volume","volumeRange","pan","panRange","fillFactor","offsetRange",
  "density","distribution","speedRatio","grainDur","durationRange",
  "loopStart","loopDur","loopEnd","voicesNum","scatter",
  "voicePitchOffset","voicePointerOffset","voicePointerRange"];
assert("all mapped UI keys have a static fallback",
  NEEDED.every(k => window.PGE_BOUNDS[k] && typeof window.PGE_BOUNDS[k].min === "number"),
  NEEDED.filter(k => !window.PGE_BOUNDS[k]).join(", "));
assert("pitch fallback present (semitones/cents/ratio)",
  window.PGE_BOUNDS.pitch && window.PGE_BOUNDS.pitch.semitones &&
  window.PGE_BOUNDS.pitch.cents && window.PGE_BOUNDS.pitch.ratio);
assert("every ENGINE_PARAM_MAP key has a fallback in PGE_BOUNDS",
  Object.keys(B.ENGINE_PARAM_MAP).every(k => window.PGE_BOUNDS[k]),
  Object.keys(B.ENGINE_PARAM_MAP).filter(k => !window.PGE_BOUNDS[k]).join(", "));

console.log("\n── mergeEngineBounds (value vs range fields) ──");
const raw = {
  params: {
    density:           { min_val: 0.5,  max_val: 2000, min_range: 0, max_range: 0,   default_jitter: 0,    variation_mode: "additive" },
    volume:            { min_val: -90,  max_val: 6,    min_range: 0, max_range: 18,  default_jitter: 3,    variation_mode: "additive" },
    grain_duration:    { min_val: 0.002,max_val: 5,    min_range: 0, max_range: 0.8, default_jitter: 0.01, variation_mode: "additive" },
    pointer_deviation: { min_val: -1,   max_val: 1,    min_range: 0, max_range: 1,   default_jitter: 0.05, variation_mode: "additive" },
    loop_dur:          { min_val: 0.01, max_val: null, min_range: 0, max_range: 0,   default_jitter: 0,    variation_mode: "additive" },
  },
  pitch: {
    semitones: { min: -24, max: 24, rangeMax: 24 },
    ratio:     { min: 0.002, max: 7, rangeMax: 3 },
    edoFactor: 4,
  },
};

const baseDensityMax = window.PGE_BOUNDS.density.max;     // capture fallback before merge
const baseLoopDurMax = window.PGE_BOUNDS.loopDur.max;
const baseScatterMax = window.PGE_BOUNDS.scatter.max;
const baseCentsMax   = window.PGE_BOUNDS.pitch.cents.max;
const out = B.mergeEngineBounds(window.PGE_BOUNDS, raw);

assert("density ← density.value (min/max)", out.density.min === 0.5 && out.density.max === 2000);
assert("volume ← volume.value",             out.volume.min === -90 && out.volume.max === 6);
assert("volumeRange ← volume.RANGE",        out.volumeRange.min === 0 && out.volumeRange.max === 18);
assert("grainDur ← grain_duration.value",   out.grainDur.max === 5);
assert("durationRange ← grain_duration.RANGE (0..0.8)", out.durationRange.min === 0 && out.durationRange.max === 0.8);
assert("offsetRange ← pointer_deviation.RANGE (0..1)",  out.offsetRange.min === 0 && out.offsetRange.max === 1);
assert("loopDur.min ← loop_dur.value",      out.loopDur.min === 0.01);
assert("loopDur.max null → keeps fallback (sample-driven)", out.loopDur.max === baseLoopDurMax);

console.log("\n── mergeEngineBounds (pitch) ──");
assert("pitch.semitones ← engine", out.pitch.semitones.max === 24 && out.pitch.semitones.min === -24);
assert("pitch.ratio ← engine (rangeMax)", out.pitch.ratio.rangeMax === 3);
assert("pitch.edoFactor ← engine", out.pitch.edoFactor === 4);
assert("pitch unit absent from raw keeps fallback (cents)", out.pitch.cents.max === baseCentsMax);

console.log("\n── fallback preserved, base not mutated ──");
assert("key without engine data keeps fallback (scatter)", out.scatter.max === baseScatterMax);
assert("mergeEngineBounds does NOT mutate base", window.PGE_BOUNDS.density.max === baseDensityMax);
assert("empty raw → clone equal to base", B.mergeEngineBounds(window.PGE_BOUNDS, {}).density.max === baseDensityMax);
assert("null raw → no crash, clone of base", B.mergeEngineBounds(window.PGE_BOUNDS, null).density.max === baseDensityMax);

console.log("\n── apply() installs onto window.PGE_BOUNDS ──");
B.apply(raw);
assert("apply mutates window.PGE_BOUNDS.density", window.PGE_BOUNDS.density.max === 2000);
assert("apply mutates window.PGE_BOUNDS.pitch.edoFactor", window.PGE_BOUNDS.pitch.edoFactor === 4);
assert("apply keeps unmapped fallback (scatter)", window.PGE_BOUNDS.scatter.max === baseScatterMax);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
