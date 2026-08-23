/* =============================================================================
 * test-envelope-utils.js — tests for envelope-utils.js (window.PGEEnvUtils),
 * the freeze-on-resize rescale/truncate math extracted from app.jsx (#44).
 *
 * Run: node test-envelope-utils.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// envelope-loops.js (window.PGEEnv) must load first; envelope-utils.js captures
// window.PGEEnv at IIFE time and reads window.PGEDeviationProb (deviation-probability.js) at call
// time. js-yaml is provided in case envelope-loops needs it.
// yaml-bridge.js viene prima di tutti come nell'editor: è lui a pubblicare
// window.PGE_OUTPUT_SR, il sample rate del motore che envelope-utils legge a
// chiamata per il fattore di 'samples'.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/deviation-probability.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-utils.js"), "utf8"));

const U = window.PGEEnvUtils;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n── module surface ──");
assert("PGEEnvUtils exposes the 16 helpers",
  ["rescaleEnvArray", "truncateEnvArray", "envArrayWouldTruncate", "_applyEnvFields",
   "rescaleStreamEnvelopes", "truncateStreamEnvelopes", "streamWouldTruncate", "nudgeBreakpoint",
   "computeYFit", "loopEnvMax", "loopUnitInfo", "loopBoundsError", "grainDurationUnitError",
   "snapDirection", "snapForDomain", "readDirectionError"]
    .every(k => typeof U[k] === "function"),
  JSON.stringify(Object.keys(U)));

console.log("\n── rescaleEnvArray ──");
assert("breakpoints scaled by ratio",
  eq(U.rescaleEnvArray([[0, 1], [1, 0.5]], 0.5), [[0, 1], [0.5, 0.5]]));
assert("breakpoint times clamp at 1.0",
  eq(U.rescaleEnvArray([[0, 0], [1, 1]], 2), [[0, 0], [1, 1]]));
assert("object-form {type,points} scaled",
  eq(U.rescaleEnvArray({ type: "exp", points: [[0, 0], [1, 1]] }, 0.5),
     { type: "exp", points: [[0, 0], [0.5, 1]] }));
assert("compact block end_time scaled, pattern untouched",
  eq(U.rescaleEnvArray([[[[0, 0], [1, 1]], 0.8, 2]], 0.5), [[[[0, 0], [1, 1]], 0.4, 2]]));
assert("non-array passthrough", U.rescaleEnvArray(5, 0.5) === 5);

console.log("\n── truncateEnvArray ──");
assert("interpolates a closing BP at x=1.0",
  eq(U.truncateEnvArray([[0, 0], [1.5, 1]]), [[0, 0], [1, 0.6667]]));
assert("within-bounds envelope unchanged",
  eq(U.truncateEnvArray([[0, 0], [1, 1]]), [[0, 0], [1, 1]]));
assert("object-form truncated recursively",
  eq(U.truncateEnvArray({ type: "exp", points: [[0, 0], [1.5, 1]] }),
     { type: "exp", points: [[0, 0], [1, 0.6667]] }));

console.log("\n── envArrayWouldTruncate ──");
assert("true when a breakpoint would cross 1.0", U.envArrayWouldTruncate([[0, 0], [1, 1]], 1.5) === true);
assert("false at ratio 1.0", U.envArrayWouldTruncate([[0, 0], [1, 1]], 1) === false);
assert("compact block end_time considered", U.envArrayWouldTruncate([[[[0, 0], [1, 1]], 0.8, 2]], 1.5) === true);
assert("object-form considered", U.envArrayWouldTruncate({ type: "exp", points: [[0, 0], [0.9, 1]] }, 1.2) === true);

console.log("\n── stream-level helpers ──");
{
  const stream = {
    id: "s1", volume: 0,
    densityEnv: [[0, 0], [1, 1]],
    grain:   { durationEnv: [[0, 0], [1, 1]], duration: null },
    pointer: { loopDurEnv: [[0, 0], [1, 1]] },
  };
  assert("streamWouldTruncate true when scaling up", U.streamWouldTruncate(stream, 2) === true);
  assert("streamWouldTruncate false at ratio 1", U.streamWouldTruncate(stream, 1) === false);

  const r = U.rescaleStreamEnvelopes(stream, 10, 20);   // ratio 0.5
  assert("rescaleStreamEnvelopes scales top-level env", eq(r.densityEnv, [[0, 0], [0.5, 1]]));
  assert("rescaleStreamEnvelopes scales nested grain env", eq(r.grain.durationEnv, [[0, 0], [0.5, 1]]));
  assert("rescaleStreamEnvelopes scales nested pointer env", eq(r.pointer.loopDurEnv, [[0, 0], [0.5, 1]]));
  assert("rescaleStreamEnvelopes preserves scalar fields", r.id === "s1" && r.volume === 0 && r.grain.duration === null);
  assert("rescaleStreamEnvelopes does not mutate input", eq(stream.densityEnv, [[0, 0], [1, 1]]));
}
{
  const stream = { id: "s2", panEnv: [[0, 0], [1.5, 1]] };
  const t = U.truncateStreamEnvelopes(stream);
  assert("truncateStreamEnvelopes truncates env field", eq(t.panEnv, [[0, 0], [1, 0.6667]]));
  assert("truncateStreamEnvelopes leaves a stream without over-long env alone",
    eq(U.truncateStreamEnvelopes({ id: "s3", volumeEnv: [[0, 0], [1, 1]] }).volumeEnv, [[0, 0], [1, 1]]));
}

console.log("\n── nudgeBreakpoint — value axis ──");
{
  const bps = [[0, 0], [0.5, 0.5], [1, 1]];
  assert("value up by step",
    eq(U.nudgeBreakpoint(bps, 1, "value", 0.1, { hardMin: 0, hardMax: 1, yPrec: 2 }),
       [[0, 0], [0.5, 0.6], [1, 1]]));
  assert("value down by step",
    eq(U.nudgeBreakpoint(bps, 1, "value", -0.1, { hardMin: 0, hardMax: 1, yPrec: 2 }),
       [[0, 0], [0.5, 0.4], [1, 1]]));
  assert("value clamps at hardMax",
    eq(U.nudgeBreakpoint([[0, 0.95]], 0, "value", 0.1, { hardMin: 0, hardMax: 1, yPrec: 2 }),
       [[0, 1]]));
  assert("value clamps at hardMin",
    eq(U.nudgeBreakpoint([[0, 0.05]], 0, "value", -0.1, { hardMin: 0, hardMax: 1, yPrec: 2 }),
       [[0, 0]]));
  assert("value leaves time untouched",
    eq(U.nudgeBreakpoint([[0.3, 0.5]], 0, "value", 0.1, { hardMin: 0, hardMax: 1, yPrec: 2 }),
       [[0.3, 0.6]]));
  assert("value preserves per-point interp (3-tuple)",
    eq(U.nudgeBreakpoint([[0, 0], [0.5, 0.5, "exp"], [1, 1]], 1, "value", 0.1, { hardMin: 0, hardMax: 1, yPrec: 2 }),
       [[0, 0], [0.5, 0.6, "exp"], [1, 1]]));
  assert("integer param (yPrec 0): coarse step moves by 1",
    eq(U.nudgeBreakpoint([[0, 5]], 0, "value", 1, { hardMin: 0, hardMax: 10, yPrec: 0 }),
       [[0, 6]]));
}

console.log("\n── nudgeBreakpoint — time axis ──");
{
  assert("time right by step",
    eq(U.nudgeBreakpoint([[0, 0], [0.3, 0.5], [1, 1]], 1, "time", 0.1, { yPrec: 2 }),
       [[0, 0], [0.4, 0.5], [1, 1]]));
  assert("time clamps just before next neighbour",
    eq(U.nudgeBreakpoint([[0, 0], [0.3, 0.5], [0.35, 0.7], [1, 1]], 1, "time", 0.1, { yPrec: 2 }),
       [[0, 0], [0.349, 0.5], [0.35, 0.7], [1, 1]]));
  assert("time clamps just after prev neighbour",
    eq(U.nudgeBreakpoint([[0, 0], [0.28, 0.3], [0.3, 0.5], [1, 1]], 2, "time", -0.1, { yPrec: 2 }),
       [[0, 0], [0.28, 0.3], [0.281, 0.5], [1, 1]]));
  assert("time clamps at envelope start (no prev)",
    eq(U.nudgeBreakpoint([[0.05, 0.2], [1, 1]], 0, "time", -0.1, { yPrec: 2 }),
       [[0, 0.2], [1, 1]]));
  assert("time clamps at envelope end (no next)",
    eq(U.nudgeBreakpoint([[0, 0], [0.95, 0.8]], 1, "time", 0.1, { yPrec: 2 }),
       [[0, 0], [1, 0.8]]));
  assert("neighbour clamp skips loop blocks",
    eq(U.nudgeBreakpoint([[0, 0.2], [[[0, 0], [100, 1]], 0.4, 2], [0.6, 0.8]], 2, "time", -0.1, { yPrec: 2 }),
       [[0, 0.2], [[[0, 0], [100, 1]], 0.4, 2], [0.5, 0.8]]));
}

console.log("\n── nudgeBreakpoint — guards & purity ──");
{
  const items = [[0, 0], [[[0, 0], [100, 1]], 0.4, 2], [1, 1]];
  assert("index pointing at a loop block → unchanged (same ref)",
    U.nudgeBreakpoint(items, 1, "value", 0.1, { hardMin: 0, hardMax: 1 }) === items);
  const noMove = [[0, 1]];
  assert("clamped-to-no-movement returns the input array (same ref)",
    U.nudgeBreakpoint(noMove, 0, "value", 0.1, { hardMin: 0, hardMax: 1, yPrec: 2 }) === noMove);
  assert("integer sub-unit step returns same ref (no movement)",
    (() => { const a = [[0, 5]]; return U.nudgeBreakpoint(a, 0, "value", 0.1, { hardMin: 0, hardMax: 10, yPrec: 0 }) === a; })());
  assert("non-array input passthrough", U.nudgeBreakpoint(5, 0, "value", 0.1, {}) === 5);
  const src = [[0, 0], [0.5, 0.5], [1, 1]];
  const out = U.nudgeBreakpoint(src, 1, "value", 0.1, { hardMin: 0, hardMax: 1, yPrec: 2 });
  assert("does not mutate input", eq(src, [[0, 0], [0.5, 0.5], [1, 1]]) && out !== src);
}

console.log("\n── range / curve envelopes (issue #61) ──");
{
  const stream = {
    id: "s4",
    volumeRangeEnv: [[0, 0], [1, 1]],
    panRangeEnv:    [[0, 0], [1, 1]],
    grain:   { durationRangeEnv: [[0, 0], [1, 1]],
               envelope: { states: ["hann", "gauss"], curve: [[0, 0], [1, 1]] } },
    pointer: { offsetRangeEnv: [[0, 0], [1, 1]] },
    pitch:   { rangeEnv: [[0, 0], [1, 1]] },
  };
  const r = U.rescaleStreamEnvelopes(stream, 10, 20); // ratio 0.5
  assert("rescale top-level volumeRangeEnv",   eq(r.volumeRangeEnv,         [[0, 0], [0.5, 1]]));
  assert("rescale top-level panRangeEnv",      eq(r.panRangeEnv,            [[0, 0], [0.5, 1]]));
  assert("rescale grain.durationRangeEnv",     eq(r.grain.durationRangeEnv, [[0, 0], [0.5, 1]]));
  assert("rescale pointer.offsetRangeEnv",     eq(r.pointer.offsetRangeEnv, [[0, 0], [0.5, 1]]));
  assert("rescale pitch.rangeEnv",             eq(r.pitch.rangeEnv,         [[0, 0], [0.5, 1]]));
  assert("rescale grain.envelope.curve",       eq(r.grain.envelope.curve,   [[0, 0], [0.5, 1]]));
  assert("grain.envelope keeps sibling keys",  eq(r.grain.envelope.states,  ["hann", "gauss"]));

  assert("streamWouldTruncate true on volumeRangeEnv",
    U.streamWouldTruncate({ volumeRangeEnv: [[0, 0], [1, 1]] }, 2) === true);
  assert("streamWouldTruncate true on pitch.rangeEnv",
    U.streamWouldTruncate({ pitch: { rangeEnv: [[0, 0], [1, 1]] } }, 2) === true);
  assert("streamWouldTruncate true on pointer.offsetRangeEnv",
    U.streamWouldTruncate({ pointer: { offsetRangeEnv: [[0, 0], [1, 1]] } }, 2) === true);
  assert("streamWouldTruncate true on grain.durationRangeEnv",
    U.streamWouldTruncate({ grain: { durationRangeEnv: [[0, 0], [1, 1]] } }, 2) === true);
  assert("streamWouldTruncate true on grain.envelope.curve",
    U.streamWouldTruncate({ grain: { envelope: { curve: [[0, 0], [1, 1]] } } }, 2) === true);
  assert("streamWouldTruncate false on range env at ratio 1",
    U.streamWouldTruncate({ volumeRangeEnv: [[0, 0], [1, 1]] }, 1) === false);
}

console.log("\n── deviationProbability envelopes (issue #61) ──");
{
  // global probability envelope (array form)
  const arrStream = { id: "s5", deviationProbability: [[0, 0], [1, 1]] };
  const ra = U.rescaleStreamEnvelopes(arrStream, 10, 20);
  assert("rescale deviationProbability array form", eq(ra.deviationProbability, [[0, 0], [0.5, 1]]));
  assert("streamWouldTruncate true on deviationProbability array", U.streamWouldTruncate(arrStream, 2) === true);

  // per-param object: array params rescaled, scalar/null params preserved verbatim
  const objStream = { id: "s6", deviationProbability: { volume: [[0, 0], [1, 1]], pan: 0.5, pitch: null } };
  const ro = U.rescaleStreamEnvelopes(objStream, 10, 20);
  assert("rescale deviationProbability.volume (array param)", eq(ro.deviationProbability.volume, [[0, 0], [0.5, 1]]));
  assert("deviationProbability.pan scalar param preserved",   ro.deviationProbability.pan === 0.5);
  assert("deviationProbability.pitch null param preserved",   ro.deviationProbability.pitch === null);
  assert("streamWouldTruncate true on deviationProbability.volume env", U.streamWouldTruncate(objStream, 2) === true);
  assert("rescaleStreamEnvelopes does not mutate deviationProbability input", eq(objStream.deviationProbability.volume, [[0, 0], [1, 1]]));

  // scalar / false deviationProbability left untouched (not a time-domain envelope)
  assert("deviationProbability scalar untouched", U.rescaleStreamEnvelopes({ deviationProbability: 0.01 }, 10, 20).deviationProbability === 0.01);
  assert("deviationProbability false untouched",  U.rescaleStreamEnvelopes({ deviationProbability: false }, 10, 20).deviationProbability === false);
}

// ---------------------------------------------------------------------------
// computeYFit — auto-fit the envelope Y window to the actual point values
// (readability), clamped into [hardMin, hardMax]. Unlike the old behaviour it
// fits the POINTS, not the static [visMin,visMax]; visMin/visMax are only the
// no-points fallback window.
// ---------------------------------------------------------------------------
function near(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

console.log("\n── computeYFit ──");
{
  // density-like: points small, vis window wide → window must hug the points,
  // NOT stretch to visMax (the bug this fixes).
  const r = U.computeYFit([0, 8], { visMin: 0, visMax: 50, hardMin: 0.01, hardMax: 4000, unit: "g/s" });
  assert("fits points (ymax≈8.8), ignores wide visMax", near(r.ymax, 8.8), JSON.stringify(r));
  assert("clamps ymin to hardMin (0.01, not -0.8)", r.ymin === 0.01, JSON.stringify(r));

  // points blow past hardMax → window capped at hardMax.
  const r2 = U.computeYFit([0, 5000], { visMin: 0, visMax: 50, hardMin: 0.01, hardMax: 4000, unit: "g/s" });
  assert("clamps ymax to hardMax", r2.ymax === 4000, JSON.stringify(r2));

  // no points → fall back to the default [visMin,visMax] window (+pad, clamped).
  const r3 = U.computeYFit([], { visMin: 0, visMax: 50, hardMin: 0, hardMax: 4000, unit: "" });
  assert("no points → uses visMin/visMax window", r3.ymin === 0 && near(r3.ymax, 55), JSON.stringify(r3));

  // constant envelope (all equal) → open a minimal window around the value.
  const r4 = U.computeYFit([3, 3, 3], { visMin: 0, visMax: 10, hardMin: 0, hardMax: 100, unit: "" });
  assert("constant value → window straddles it", r4.ymin < 3 && r4.ymax > 3, JSON.stringify(r4));

  // constant in seconds uses the finer 0.01 minimum span.
  const r5 = U.computeYFit([0.5, 0.5], { visMin: 0, visMax: 1, hardMin: 0, hardMax: 10, fine: true });
  assert("constant (fine) opens a fine window", r5.ymax > 0.5 && r5.ymin < 0.5 && (r5.ymax - r5.ymin) < 0.1, JSON.stringify(r5));
  // La finestra minima segue `fine`, non il suffisso: una curva del loop in
  // normalized non ha unità ma resta a grana fine (issue #126).
  const r5b = U.computeYFit([0.5, 0.5], { visMin: 0, visMax: 1, hardMin: 0, hardMax: 1, unit: "s" });
  assert("unit \"s\" da solo non basta più a stringere la finestra",
    (r5b.ymax - r5b.ymin) > 0.5, JSON.stringify(r5b));
  const r5c = U.computeYFit([0.5, 0.5], { visMin: 0, visMax: 1, hardMin: 0, hardMax: 1, fine: true, unit: "" });
  assert("senza unità ma fine → finestra stretta lo stesso",
    (r5c.ymax - r5c.ymin) < 0.1, JSON.stringify(r5c));

  // signed values (pan-like): window hugs [-30,40], not the ±360 vis window.
  const r6 = U.computeYFit([-30, 40], { visMin: -360, visMax: 360, hardMin: -3600, hardMax: 3600, unit: "°" });
  assert("signed points fit tightly (≈[-37,47])", near(r6.ymin, -37) && near(r6.ymax, 47), JSON.stringify(r6));

  // result is always a proper interval.
  assert("ymax strictly above ymin in every case",
    [r, r2, r3, r4, r5, r6].every(x => x.ymax > x.ymin));
}

console.log("\n── deviationProbability typed {type,points} envelopes (cubic global interp) ──");
{
  // GLOBAL typed envelope (what wrapEnv emits for cubic) must be treated as a
  // single global env: its points rescale, and it counts for truncation.
  const typedStream = { id: "s7", deviationProbability: { type: "cubic", points: [[0, 0], [1, 1]] } };
  const rt = U.rescaleStreamEnvelopes(typedStream, 10, 20);
  assert("rescale deviationProbability typed global env (points scaled)",
    eq(rt.deviationProbability, { type: "cubic", points: [[0, 0], [0.5, 1]] }));
  assert("streamWouldTruncate true on typed global deviationProbability env",
    U.streamWouldTruncate(typedStream, 2) === true);
  assert("rescale does not mutate typed deviationProbability input",
    eq(typedStream.deviationProbability, { type: "cubic", points: [[0, 0], [1, 1]] }));

  // truncate clips a typed global env past x=1.0 (object-form path).
  const tt = U.truncateStreamEnvelopes({ id: "s7b", deviationProbability: { type: "cubic", points: [[0, 0], [2, 1]] } });
  assert("truncate typed global deviationProbability env clips past 1.0",
    eq(tt.deviationProbability, { type: "cubic", points: [[0, 0], [1, 0.5]] }), JSON.stringify(tt.deviationProbability));

  // PER-PARAM with a typed envelope value: that param rescales too.
  const ppStream = { id: "s8", deviationProbability: { volume: { type: "cubic", points: [[0, 0], [1, 1]] }, pan: 0.5 } };
  const rp = U.rescaleStreamEnvelopes(ppStream, 10, 20);
  assert("rescale deviationProbability.volume typed env param",
    eq(rp.deviationProbability.volume, { type: "cubic", points: [[0, 0], [0.5, 1]] }));
  assert("deviationProbability.pan scalar preserved alongside typed param", rp.deviationProbability.pan === 0.5);
  assert("streamWouldTruncate true on typed per-param deviationProbability env",
    U.streamWouldTruncate(ppStream, 2) === true);
}

// ---------------------------------------------------------------------------
// loopEnvMax — sample-driven upper bound for loop_start/end/dur. The engine's
// max_val for these is None (the real cap is sample_dur_sec, injected at render
// time); the editor mirrors that. Unit follows PointerController:
// pointer.loopUnit || stream.timeMode (engine default "absolute").
// ---------------------------------------------------------------------------
console.log("\n── loopEnvMax (sample-driven loop bound) ──");
{
  const ptr = (extra) => ({ pointer: Object.assign({ loopStartEnv: [[0, 0], [1, 1]] }, extra || {}) });

  // absolute/seconds (default): cap is the sample duration
  assert("absolute (no unit/timeMode) → cap = sampleDur",
    U.loopEnvMax(ptr(), 12.5) === 12.5);
  assert("explicit timeMode absolute → cap = sampleDur",
    U.loopEnvMax(Object.assign({ timeMode: "absolute" }, ptr()), 8) === 8);

  // normalized: loop coords live in [0,1] → cap 1, regardless of sampleDur
  assert("loopUnit normalized → cap = 1",
    U.loopEnvMax(ptr({ loopUnit: "normalized" }), 30) === 1);
  assert("timeMode normalized (no loopUnit) → cap = 1",
    U.loopEnvMax(Object.assign({ timeMode: "normalized" }, ptr()), 30) === 1);
  assert("loopUnit overrides timeMode (absolute unit wins over normalized stream)",
    U.loopEnvMax(Object.assign({ timeMode: "normalized" }, ptr({ loopUnit: "absolute" })), 9) === 9);

  // unknown / invalid sample duration → null so callers keep the static cap
  assert("undefined sampleDur → null (keep static fallback)",
    U.loopEnvMax(ptr(), undefined) === null);
  assert("zero sampleDur → null", U.loopEnvMax(ptr(), 0) === null);
  assert("non-finite sampleDur → null", U.loopEnvMax(ptr(), Infinity) === null);
  assert("negative sampleDur → null", U.loopEnvMax(ptr(), -3) === null);
  // ...but normalized still caps at 1 even with an unknown duration
  assert("normalized + unknown sampleDur → still 1",
    U.loopEnvMax(ptr({ loopUnit: "normalized" }), undefined) === 1);

  // null/empty stream is tolerated (no throw); absolute with no duration → null
  assert("null stream → null", U.loopEnvMax(null, undefined) === null);
}

// ---------------------------------------------------------------------------
// loopUnitInfo — which unit the loop window is written in, and where that unit
// comes from. Same resolution as the engine (loop_unit or time_mode), plus the
// provenance the Inspector needs to label the control as inherited and to drop
// a redundant key instead of materializing it (issue #126).
// ---------------------------------------------------------------------------
console.log("\n── loopUnitInfo (unit + provenance) ──");
{
  const info = (stream) => U.loopUnitInfo(stream);

  assert("no keys → absolute from the engine default",
    eq(info({}), { unit: "absolute", source: "default" }));
  assert("null stream tolerated → absolute/default",
    eq(info(null), { unit: "absolute", source: "default" }));

  assert("timeMode normalized → normalized, inherited",
    eq(info({ timeMode: "normalized" }), { unit: "normalized", source: "time_mode" }));
  assert("timeMode absolute → absolute, inherited",
    eq(info({ timeMode: "absolute" }), { unit: "absolute", source: "time_mode" }));

  assert("explicit loop_unit normalized wins over an absolute stream",
    eq(info({ timeMode: "absolute", pointer: { loopUnit: "normalized" } }),
       { unit: "normalized", source: "loop_unit" }));
  assert("explicit loop_unit absolute wins over a normalized stream (the #126 escape)",
    eq(info({ timeMode: "normalized", pointer: { loopUnit: "absolute" } }),
       { unit: "absolute", source: "loop_unit" }));

  // The engine only ever tests `!= 'normalized'`, so anything else is seconds.
  assert("unknown loop_unit string → absolute (engine tests != normalized)",
    eq(info({ pointer: { loopUnit: "seconds" } }), { unit: "absolute", source: "loop_unit" }));
  assert("unknown time_mode string → absolute",
    eq(info({ timeMode: "weird" }), { unit: "absolute", source: "time_mode" }));

  // loopEnvMax must agree with it — one resolution, two readers.
  assert("loopEnvMax agrees: inherited normalized still caps at 1",
    U.loopEnvMax({ timeMode: "normalized" }, 30) === 1);
  assert("loopEnvMax agrees: explicit absolute on a normalized stream caps at sampleDur",
    U.loopEnvMax({ timeMode: "normalized", pointer: { loopUnit: "absolute" } }, 30) === 30);
}

// loopBoundsError — mirrors the engine's static loop-window validation (PGE
// issue #97 / engine ec61242): with a loop active the read position is confined
// to [loop_start, loop_end) via modular wrap, so a degenerate window is rejected
// at parse time (loop_end <= loop_start → InvalidFieldValueError). Only the
// SCALAR form is checked; an envelope on either endpoint is dynamic → exempt.
// loop_dur mode is intentionally unconstrained (the way to straddle the file end).
console.log("\n── loopBoundsError ──");
{
  const LB = U.loopBoundsError;
  // valid windows → null
  assert("loop_end > loop_start → null", LB({ loopStart: 0, loopEnd: 1 }) === null);
  assert("loop_end > loop_start (non-zero start) → null",
    LB({ loopStart: 0.5, loopEnd: 2 }) === null);
  // degenerate windows → { loopStart, loopEnd }
  assert("loop_end == loop_start → error",
    eq(LB({ loopStart: 1, loopEnd: 1 }), { loopStart: 1, loopEnd: 1 }));
  assert("loop_end < loop_start → error",
    eq(LB({ loopStart: 2, loopEnd: 0.5 }), { loopStart: 2, loopEnd: 0.5 }));
  // loop_start absent → engine default 0
  assert("loop_end > 0, loop_start absent → null", LB({ loopEnd: 1 }) === null);
  assert("loop_end == 0, loop_start absent → error (default start 0)",
    eq(LB({ loopEnd: 0 }), { loopStart: 0, loopEnd: 0 }));
  assert("loop_end < 0, loop_start absent → error",
    eq(LB({ loopEnd: -1 }), { loopStart: 0, loopEnd: -1 }));
  // loop_dur mode (no loop_end) is unconstrained
  assert("loop_dur mode (no loop_end) → null", LB({ loopStart: 2, loopDur: 1 }) === null);
  assert("loop_start only, no end/dur → null", LB({ loopStart: 0 }) === null);
  // envelope endpoints are dynamic → exempt from the static check
  assert("loop_end envelope → exempt even if first bp <= start",
    LB({ loopStart: 2, loopEndEnv: [[0, 0], [1, 0]] }) === null);
  assert("loop_start envelope → exempt",
    LB({ loopStartEnv: [[0, 3], [1, 3]], loopEnd: 1 }) === null);
  // robustness
  assert("null pointer → null", LB(null) === null);
  assert("empty pointer → null", LB({}) === null);
  assert("non-numeric loop_end (dash placeholder) → null",
    LB({ loopStart: 0, loopEnd: "—" }) === null);
}

// grainDurationUnitError — mirror della validazione PGE #158, estesa alle tre
// unità di PGE v5.2.0 (#171): con grain.duration_unit diverso da 'seconds',
// grain.duration deve essere esplicita (il default 0.05 è in secondi e non
// verrebbe convertito). Il vincolo non è più solo di 'samples'.
console.log("\n── grainDurationUnitError ──");
{
  const GE = U.grainDurationUnitError;
  // seconds / assente → nessun errore, qualunque cosa manchi
  assert("unit assente → null", GE({}) === null);
  assert("seconds senza duration → null", GE({ durationUnit: "seconds" }) === null);
  // samples SENZA duration (scalare o env) → errore
  assert("samples senza duration → errore", GE({ durationUnit: "samples" }) != null);
  assert("samples con solo durationRange → errore",
    GE({ durationUnit: "samples", durationRange: 96 }) != null);
  // samples CON duration → null
  assert("samples con duration scalare → null",
    GE({ durationUnit: "samples", duration: 480 }) === null);
  assert("samples con durationEnv → null",
    GE({ durationUnit: "samples", durationEnv: [[0, 48], [1, 4800]] }) === null);
  // milliseconds: stesso vincolo di samples — il motore lo applica a ogni
  // unità non-secondi (Stream._pre_normalize_grain_params), non solo ai campioni
  assert("milliseconds senza duration → errore",
    GE({ durationUnit: "milliseconds" }) != null);
  assert("milliseconds con solo durationRange → errore",
    GE({ durationUnit: "milliseconds", durationRange: 5 }) != null);
  assert("milliseconds con duration scalare → null",
    GE({ durationUnit: "milliseconds", duration: 12 }) === null);
  assert("milliseconds con durationEnv → null",
    GE({ durationUnit: "milliseconds", durationEnv: [[0, 1], [1, 200]] }) === null);
  // l'unità torna al chiamante: il messaggio nomina quella scelta, non 'samples'
  assert("l'errore nomina l'unità selezionata",
    GE({ durationUnit: "milliseconds" }).unit === "milliseconds"
    && GE({ durationUnit: "samples" }).unit === "samples");
  assert("la duration mancante si distingue dall'unità ignota",
    GE({ durationUnit: "milliseconds" }).kind === "missing-duration");
  // unità fuori dall'insieme: il motore alza InvalidFieldValueError prima di
  // guardare la duration, quindi l'errore resta anche con duration esplicita
  assert("unità ignota → errore anche con duration",
    GE({ durationUnit: "ms", duration: 12 }) != null);
  assert("unità ignota → kind 'unknown' e unità riportata",
    GE({ durationUnit: "ms", duration: 12 }).kind === "unknown"
    && GE({ durationUnit: "ms", duration: 12 }).unit === "ms");
  // robustezza
  assert("null grain → null", GE(null) === null);
  assert("duration 0 conta come presente (grano da 0? gestito dai bound) ",
    GE({ durationUnit: "samples", duration: 0 }) === null);
  // `duration_unit:` vuota → durationUnit null lato bridge. La UI la tratta
  // come assente (il serializer la lascia cadere), quindi niente errore qui.
  assert("chiave vuota (durationUnit null) → null",
    GE({ durationUnit: null }) === null);
  // Stessa cosa per la stringa vuota esplicita: `serialize` fa
  // `grain.durationUnit || undefined`, quindi quel valore al motore non arriva
  // mai — segnalarlo sarebbe un errore fantasma, per giunta con l'unità
  // mancante dalla frase.
  assert("stringa vuota → null (il serializer la lascia cadere)",
    GE({ durationUnit: "" }) === null);
}

// Il suffisso delle righe duration / duration_range. Sta qui e non nel JSX
// perché lo condividono Inspector ed EnvelopeEditor, e perché l'unica risposta
// giusta per un'unità che il motore non riconosce è "nessun suffisso": scrivere
// «s» accanto a una riga d'errore che dice «unità non riconosciuta» sono due
// affermazioni opposte nello stesso pannello.
console.log("\n── grainUnitSuffix ──");
{
  const S = U.grainUnitSuffix;
  assert("seconds → s", S("seconds") === "s");
  assert("unità assente → s (la chiave assente È seconds)",
    S(null) === "s" && S(undefined) === "s" && S("") === "s");
  assert("samples → smp", S("samples") === "smp");
  assert("milliseconds → ms", S("milliseconds") === "ms");
  assert("unità ignota → nessun suffisso",
    S("ms") === "" && S("secondi") === "");
}

// L'insieme delle unità è uno solo, esportato: il Seg dell'Inspector ci
// costruisce sopra le opzioni invece di ricablarle a mano ad ogni unità nuova.
console.log("\n── GRAIN_DURATION_UNITS ──");
{
  assert("le tre unità del motore, in ordine",
    eq(U.GRAIN_DURATION_UNITS, ["seconds", "samples", "milliseconds"]),
    JSON.stringify(U.GRAIN_DURATION_UNITS));
}


/* ===========================================================================
 * grain.read_direction — un dominio di due elementi (PGE #207)
 * ===========================================================================
 * Il verso di lettura vale -1 o +1 e basta: il motore rifiuta gli intermedi al
 * parse invece di clamparli. Ogni y che la UI CALCOLA invece di sceglierlo va
 * quindi snappato al segno, altrimenti un'operazione che l'utente non collega
 * al verso — ridimensionare uno stream — produce YAML che non renderizza.
 * =========================================================================== */

console.log("\n── read_direction · snapDirection ──");
assert("+1 resta +1", U.snapDirection(1) === 1);
assert("-1 resta -1", U.snapDirection(-1) === -1);
assert("un intermedio positivo va a +1", U.snapDirection(0.3) === 1);
assert("un intermedio negativo va a -1", U.snapDirection(-0.3) === -1);
assert("lo zero non ha segno: va a +1 come il motore non fa",
  U.snapDirection(0) === 1);
assert("snapForDomain('direction') ritorna lo snap",
  U.snapForDomain("direction") === U.snapDirection);
assert("snapForDomain di un continuo non ritorna niente",
  !U.snapForDomain(null) && !U.snapForDomain("continuous"));

console.log("\n── read_direction · truncateEnvArray non interpola ──");
assert("senza snap il punto di chiusura è interpolato (comportamento storico)",
  eq(U.truncateEnvArray([[0, 1], [1.5, -1]]), [[0, 1], [1, -0.3333]]),
  JSON.stringify(U.truncateEnvArray([[0, 1], [1.5, -1]])));
assert("con lo snap il punto di chiusura è un verso",
  eq(U.truncateEnvArray([[0, 1], [1.5, -1]], U.snapDirection), [[0, 1], [1, -1]]));
// t = (1-0)/(1.1-0) = 0.909 → y = 1 + (-2)(0.909) = -0.818, negativo.
assert("snap: un'interpolazione negativa va a -1",
  eq(U.truncateEnvArray([[0, 1], [1.1, -1]], U.snapDirection), [[0, 1], [1, -1]]));
// Qui il bordo cade presto nel segmento: t = 0.2, y = 1 - 0.4 = 0.6, positivo.
assert("snap: un'interpolazione positiva va a +1",
  eq(U.truncateEnvArray([[0, 1], [5, -1]], U.snapDirection), [[0, 1], [1, 1]]),
  JSON.stringify(U.truncateEnvArray([[0, 1], [5, -1]], U.snapDirection)));
// t = (1-0.8)/(1.5-0.8) = 0.2857 → y = 1 - 0.571 = 0.43, positivo.
assert("snap dentro un BP group",
  eq(U.truncateEnvArray([[[[0, 1], [0.8, 1], [1.5, -1]], "step"]], U.snapDirection),
     [[[[0, 1], [0.8, 1], [1, 1]], "step"]]),
  JSON.stringify(U.truncateEnvArray([[[[0, 1], [0.8, 1], [1.5, -1]], "step"]], U.snapDirection)));
assert("i punti SCELTI dall'utente passano intatti (snap solo sul calcolato)",
  eq(U.truncateEnvArray([[0, 1], [0.5, -1]], U.snapDirection), [[0, 1], [0.5, -1]]));

console.log("\n── read_direction · truncateStreamEnvelopes instrada per campo ──");
{
  const s = {
    grain: { durationEnv: [[0, 0.05], [1.5, 0.2]],
             readDirectionEnv: [[0, 1], [1.5, -1]] },
  };
  const out = U.truncateStreamEnvelopes(s);
  assert("il campo continuo resta interpolato",
    eq(out.grain.durationEnv, [[0, 0.05], [1, 0.15]]),
    JSON.stringify(out.grain.durationEnv));
  assert("il campo direction è snappato",
    eq(out.grain.readDirectionEnv, [[0, 1], [1, -1]]),
    JSON.stringify(out.grain.readDirectionEnv));
}
assert("streamWouldTruncate vede readDirectionEnv",
  U.streamWouldTruncate({ grain: { readDirectionEnv: [[0, 1], [1, -1]] } }, 2));

console.log("\n── read_direction · nudgeBreakpoint sull'asse valore ──");
{
  const items = [[0, 1], [0.5, -1]];
  const opts = { snapYFromDelta: U.snapDirection };
  // Freccia su sul punto a -1 → +1, con QUALUNQUE passo: su due stati l'asse
  // ha un verso, non una distanza.
  const su = U.nudgeBreakpoint(items, 1, "value", 0.1, opts);
  assert("freccia su → lo stato in alto, anche col passo più piccolo",
    eq(su, [[0, 1], [0.5, 1]]), JSON.stringify(su));
  const giu = U.nudgeBreakpoint(items, 0, "value", -0.1, opts);
  assert("freccia giù → lo stato in basso",
    eq(giu, [[0, -1], [0.5, -1]]), JSON.stringify(giu));
  assert("una freccia che non cambia stato non produce un commit",
    U.nudgeBreakpoint(items, 0, "value", 0.1, opts) === items);
  const clamp = U.nudgeBreakpoint(items, 1, "value", 0.1, { hardMin: -1, hardMax: 1 });
  assert("senza snap il clamp produce l'intermedio che il motore rifiuta",
    eq(clamp, [[0, 1], [0.5, -0.9]]), JSON.stringify(clamp));
}

console.log("\n── read_direction · readDirectionError ──");
assert("chiave assente → nessun errore", U.readDirectionError({}) === null);
assert("solo reverse → nessun errore (è l'altra chiave del gruppo)",
  U.readDirectionError({ reverse: null }) === null);
assert("+1 valido", U.readDirectionError({ readDirection: 1 }) === null);
assert("-1 valido", U.readDirectionError({ readDirection: -1 }) === null);
assert("0 fuori dominio",
  (U.readDirectionError({ readDirection: 0 }) || {}).kind === "domain");
assert("0.5 fuori dominio",
  (U.readDirectionError({ readDirection: 0.5 }) || {}).kind === "domain");
assert("il messaggio può nominare il colpevole",
  U.readDirectionError({ readDirection: 0.5 }).value === 0.5);
assert("chiave presente e vuota → errore (a differenza di reverse:)",
  (U.readDirectionError({ readDirection: null }) || {}).kind === "empty");
assert("reverse + read_direction → conflitto",
  (U.readDirectionError({ reverse: null, readDirection: 1 }) || {}).kind === "conflict");
assert("il conflitto ha la precedenza sul dominio, come nel motore",
  (U.readDirectionError({ reverse: null, readDirection: 0.5 }) || {}).kind === "conflict");
assert("envelope di soli versi → valido",
  U.readDirectionError({ readDirectionEnv: [[0, 1], [0.5, -1]] }) === null);
assert("envelope con un intermedio → dominio",
  (U.readDirectionError({ readDirectionEnv: [[0, 1], [0.5, 0.3]] }) || {}).kind === "domain");
assert("envelope: intermedio dentro un BP group",
  (U.readDirectionError({ readDirectionEnv: [[[[0, 1], [0.5, 0.3]], "step"]] }) || {}).kind === "domain");
assert("envelope: intermedio dentro il pattern di un ciclo",
  (U.readDirectionError({ readDirectionEnv: [[[[0, 1], [50, 0.3]], 2.0, 2]] }) || {}).kind === "domain");
assert("envelope: forma dict {points}",
  (U.readDirectionError({ readDirectionEnv: { points: [[0, 1], [0.5, 0.3]] } }) || {}).kind === "domain");

/* ============================================================
 * Cablaggio nella UI — la parte JSX non ha test di componente
 * (CLAUDE.md), quindi si asserisce sul sorgente come fa
 * test-magnify-spec.js.
 * ============================================================ */

console.log("\n── cablaggio loop_unit (issue #126) ──");
{
  const inspSrc = fs.readFileSync(path.join(__dirname, "../../src/components/Inspector.jsx"), "utf8");

  assert("l'Inspector risolve unità e provenienza con loopUnitInfo",
    /window\.PGEEnvUtils\.loopUnitInfo\(stream\)/.test(inspSrc));
  assert("calcola anche l'unità ereditata (per sapere quando togliere la chiave)",
    /loopUnitInherited/.test(inspSrc));
  assert("loop_unit è un controllo, non più una riga di sola lettura",
    /options=\{\[\{label:"absolute",value:"absolute"\},\{label:"normalized",value:"normalized"\}\]\}/.test(inspSrc));
  assert("scegliere l'unità già in vigore cancella la chiave invece di scriverla",
    /u === loopUnitInherited\) delete np\.loopUnit; else np\.loopUnit = u/.test(inspSrc));
  assert("una riga dichiara il cap effettivo del loop",
    /durata del sample/.test(inspSrc));
  assert("loop_unit non è più nell'AddParamMenu (il controllo lo rimpiazza)",
    !/key: "loopUnit"/.test(inspSrc));
  assert("in normalized le righe del loop non mostrano il suffisso in secondi",
    /const loopUnitSuffix = loopUnit\.unit === "normalized" \? "" : "s"/.test(inspSrc)
    && (inspSrc.match(/unit=\{stream\.pointer\.loop\w+Env \? "" : loopUnitSuffix\}/g) || []).length === 3);
  assert("anche pointer.start segue l'unità (il motore scala pure quello)",
    /name="start"[\s\S]{0,160}unit=\{loopUnitSuffix\}/.test(inspSrc)
    && /pointer\.start è scalato per sample_dur ma resta un valore raw/.test(inspSrc));
  assert("un loop_unit ignoto scritto a mano si mostra per quello che dice lo YAML",
    /"esplicito: " \+ stream\.pointer\.loopUnit/.test(inspSrc));
  assert("senza blocco loop una riga spiega perché start ha perso il suffisso",
    /loopUnit\.unit === "normalized" && !loopBlockShown/.test(inspSrc)
    && /pointer\.start è scalato per sample_dur dal motore/.test(inspSrc));
  // start è is_smart=False lato motore (valore raw, nessun bound): clamparlo
  // qui sarebbe la UI a inventarsi un vincolo che il render non ha.
  assert("il ri-clamp resta sui tre estremi del loop, start fuori",
    /for \(const k of \["loopStart", "loopEnd", "loopDur"\]\)/.test(inspSrc)
    && !/start: clampLoop/.test(inspSrc));
  assert("cambiare unità ri-clampa gli estremi scalari col cap della nuova unità",
    /const cap = window\.PGEEnvUtils\.loopEnvMax\(\{ \.\.\.stream, pointer: np \}, sampleDur\)/.test(inspSrc)
    && /np\[k\] = clampLoop\(k, np\[k\], cap\)/.test(inspSrc));
}

console.log("\n── cablaggio unità/precisione dell'EnvelopeEditor (issue #126) ──");
{
  const eeSrc = fs.readFileSync(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"), "utf8");
  const inspSrc = fs.readFileSync(path.join(__dirname, "../../src/components/Inspector.jsx"), "utf8");

  assert("le curve del loop non hardcodano più il suffisso in secondi",
    /const loopUnitSuffix = window\.PGEEnvUtils\.loopUnitInfo\(stream\)\.unit === "normalized" \? "" : "s"/.test(eeSrc)
    && (eeSrc.match(/path: \["pointer", "loop\w+Env"\], unit: loopUnitSuffix, fine: true,/g) || []).length === 3);
  assert("nessun consumatore deduce più la precisione dal suffisso",
    !/unit === "s"/.test(eeSrc));
  assert("la precisione viaggia su `fine` (formato, nudge, editing)",
    /if \(env\.fine\) return v\.toFixed\(3\)/.test(eeSrc)
    && (eeSrc.match(/integer \? 0 : \(\w+\.fine \? 4 : 2\)/g) || []).length === 2);
  assert("computeYFit riceve `fine`, non l'unità",
    /hardMax: env\.hardMax, fine: env\.fine,/.test(eeSrc));
  // Due delle quattro voci "in secondi" sono passate all'unità dichiarata di
  // grain.duration (issue #114): restano le due di voices.onset_offset.
  assert("le altre grandezze a grana fine dichiarano `fine`",
    (eeSrc.match(/unit: "s", fine: true,/g) || []).length === 2);
}

/* ===========================================================================
 * Cambio di unità di grain.duration — la conversione dei valori già scritti
 * ===========================================================================
 * Cambiare unità senza convertire lascia il numero vecchio reinterpretato nella
 * nuova scala: 0.05 (secondi) letto come 0.05 ms sono 5e-5 s, cioè grani da due
 * campioni e mezzo. E non lo segnala nessuno — la duration è esplicita, quindi
 * grainDurationUnitError tace, e con output_sr il min_val di grain_duration
 * scende a 1/sr, quindi passa anche i bound. Il precedente è il Seg di
 * loop_unit, che ri-clampa gli estremi quando l'unità cambia sotto ai valori.
 */
console.log("\n── grainUnitFactor ──");
{
  const F = U.grainUnitFactor;
  assert("seconds → 1", F("seconds") === 1);
  assert("unità assente → 1", F(null) === 1 && F("") === 1);
  assert("samples → 1/output_sr (48000 di default)", F("samples") === 1 / 48000);
  // Il sample rate non è un parametro di questa funzione: è una config globale
  // del motore, pubblicata da yaml-bridge e letta a chiamata. Una manopola qui
  // sarebbe un contratto che nessuno può onorare — la CLI del motore fissa
  // output_sr a DEFAULT_OUTPUT_SR, quindi la strada del render è sempre quella.
  assert("il sample rate viene dalla costante condivisa", (() => {
    const prev = window.PGE_OUTPUT_SR;
    window.PGE_OUTPUT_SR = 44100;
    const got = F("samples");
    window.PGE_OUTPUT_SR = prev;
    return got === 1 / 44100;
  })());
  assert("milliseconds → 1e-3, indipendente dal sample rate", (() => {
    const prev = window.PGE_OUTPUT_SR;
    window.PGE_OUTPUT_SR = 44100;
    const got = F("milliseconds");
    window.PGE_OUTPUT_SR = prev;
    return F("milliseconds") === 1e-3 && got === 1e-3;
  })());
  assert("la costante è quella del motore (48000)", window.PGE_OUTPUT_SR === 48000);
  assert("unità ignota → 1 (non si inventa una scala)", F("ms") === 1);
}

console.log("\n── grainUnitBounds ──");
{
  const B = U.grainUnitBounds;
  const sec = { min: 1 / 48000, max: 10 };
  assert("in secondi restano i bound del motore", eq(B(sec, "seconds"), sec));
  assert("in campioni: 1 campione .. 480000",
    eq(B(sec, "samples"), { min: 1, max: 480000 }), JSON.stringify(B(sec, "samples")));
  assert("in millisecondi: il cap è 10000 ms, non 10",
    B(sec, "milliseconds").max === 10000
    && Math.abs(B(sec, "milliseconds").min - 0.0208333333) < 1e-9,
    JSON.stringify(B(sec, "milliseconds")));
  assert("bound assenti → oggetto vuoto", eq(B(null, "milliseconds"), {}));
}

console.log("\n── grainSecondsToUnit ──");
{
  const T = U.grainSecondsToUnit;
  assert("in secondi il valore non si tocca", T(0.01, "seconds") === 0.01);
  assert("0.01 s sono 10 ms", T(0.01, "milliseconds") === 10);
  assert("0.01 s sono 480 campioni a 48000 Hz", T(0.01, "samples") === 480);
  assert("unità ignota → valore invariato", T(0.01, "ms") === 0.01);
  assert("non numerico → invariato", T(null, "milliseconds") === null);
}

console.log("\n── isEngineEnvelopeLike (la porta del motore) ──");
{
  const P = U.isEngineEnvelopeLike;
  // Mirror di Envelope.is_envelope_like: per una lista serve almeno un item
  // lista di ESATTAMENTE due elementi (o un compatto, o un BP group).
  assert("breakpoint nudi → sì", P([[0, 0.05], [1, 0.1]]) === true);
  assert("solo 3-tuple → no", P([[0, 0.05, "exp"], [1, 0.1, "lin"]]) === false);
  assert("solo dict {t, v} → no", P([{ t: 0, v: 0.05 }, { t: 1, v: 0.1 }]) === false);
  assert("un dict in mezzo a un nudo → sì (basta un item)", P([{ t: 0, v: 0.05 }, [1, 0.1]]) === true);
  assert("BP group → sì", P([[[0, 0.05], [1, 0.1]], "exp"]) === true);
  assert("blocco compatto → sì", P([[[0, 0.05], [50, 0.1]], 1, 4]) === true);
  assert("dict con points → sì (regola verbatim)", P({ type: "linear", points: [] }) === true);
  assert("dict senza points → no", P({ type: "linear" }) === false);
  assert("lista vuota → no", P([]) === false);
  assert("scalare → no", P(0.05) === false && P(null) === false);
}

console.log("\n── grainDefaultDuration ──");
{
  const D = U.grainDefaultDuration;
  assert("il default del motore è 0.05 s", D("seconds") === 0.05);
  assert("in millisecondi sono 50, non 0.05", D("milliseconds") === 50);
  assert("in campioni sono 2400 a 48000 Hz", D("samples") === 2400);
  assert("unità ignota → il default in secondi", D("ms") === 0.05);
}

console.log("\n── convertGrainDurationUnit ──");
{
  const C = U.convertGrainDurationUnit;
  const BOUNDS = { grainDur: { min: 1 / 48000, max: 10 }, durationRange: { min: 0, max: 10 } };

  // seconds → milliseconds: il numero cambia, la durata reale no
  const ms = C({ duration: 0.05, durationRange: 0.01 }, "milliseconds");
  assert("0.05 s diventano 50 ms", ms.duration === 50, JSON.stringify(ms));
  assert("anche duration_range è convertita", ms.durationRange === 10);
  assert("la chiave viene scritta", ms.durationUnit === "milliseconds");
  // niente rumore di virgola mobile: 0.05/1e-3 in binario non fa 50 tondo
  assert("il valore convertito non porta strascichi binari",
    String(ms.duration) === "50" && String(ms.durationRange) === "10");

  // milliseconds → seconds: giro di ritorno esatto, e la chiave sparisce
  const back = C(ms, "seconds");
  assert("il giro di ritorno rende il valore di partenza", back.duration === 0.05);
  assert("tornando a seconds la chiave viene cancellata",
    !("durationUnit" in back), JSON.stringify(back));

  // samples
  const smp = C({ duration: 0.05 }, "samples");
  assert("0.05 s sono 2400 campioni", smp.duration === 2400);
  assert("anche samples scrive la chiave", smp.durationUnit === "samples");
  assert("il sample rate governa i campioni", (() => {
    const prev = window.PGE_OUTPUT_SR;
    window.PGE_OUTPUT_SR = 44100;
    const got = C({ duration: 0.05 }, "samples").duration;
    window.PGE_OUTPUT_SR = prev;
    return got === 2205;
  })());

  // envelope: si convertono i valori Y, i tempi restano
  const env = C({ durationEnv: [[0, 0.001], [1, 0.1]] }, "milliseconds");
  assert("l'envelope scala i suoi y e non i suoi x",
    eq(env.durationEnv, [[0, 1], [1, 100]]), JSON.stringify(env.durationEnv));
  const env3 = C({ durationEnv: [[0, 0.001, "exp"], [1, 0.1]] }, "milliseconds");
  assert("il tipo per-punto sopravvive",
    eq(env3.durationEnv, [[0, 1, "exp"], [1, 100]]), JSON.stringify(env3.durationEnv));
  const typed = C({ durationEnv: { type: "exp", points: [[0, 0.001], [1, 0.1]] } }, "milliseconds");
  assert("forma tipata {type, points}",
    eq(typed.durationEnv, { type: "exp", points: [[0, 1], [1, 100]] }),
    JSON.stringify(typed.durationEnv));
  const group = C({ durationEnv: [[[[0, 0.001], [0.5, 0.1]], "exp"]] }, "milliseconds");
  assert("BP group [points, interp]",
    eq(group.durationEnv, [[[[0, 1], [0.5, 100]], "exp"]]), JSON.stringify(group.durationEnv));
  const block = C({ durationEnv: [[[[0, 0.001], [0.5, 0.1]], 1, 4]] }, "milliseconds");
  assert("blocco compatto: scala il pattern, non end_time né n_reps",
    eq(block.durationEnv, [[[[0, 1], [0.5, 100]], 1, 4]]), JSON.stringify(block.durationEnv));
  const dictBp = C({ durationEnv: [{ t: 0, v: 0.001 }, [1, 0.1]] }, "milliseconds");
  assert("breakpoint dict {t, v} IN MEZZO a un breakpoint nudo: convertito",
    eq(dictBp.durationEnv, [{ t: 0, v: 1 }, [1, 100]]), JSON.stringify(dictBp.durationEnv));
  const typedDictPts = C({ durationEnv: { type: "linear", points: [{ t: 0, v: 0.001 }, { t: 1, v: 0.1 }] } }, "milliseconds");
  assert("punti dict dentro la forma tipata: convertiti (il dict con 'points' è envelope-like)",
    eq(typedDictPts.durationEnv, { type: "linear", points: [{ t: 0, v: 1 }, { t: 1, v: 100 }] }),
    JSON.stringify(typedDictPts.durationEnv));

  /* Le forme che il MOTORE non scala — e che quindi la UI non deve toccare.
   * scale_raw_param_values passa da Envelope.is_envelope_like, che per una
   * lista pretende almeno un item lista di DUE elementi (o compatto, o BP
   * group). Una lista di soli breakpoint dict, o di soli 3-tuple, non lo
   * soddisfa e torna indietro invariata — verificato eseguendo
   * _pre_normalize_grain_params. Non è un rifiuto: Envelope() quelle liste le
   * costruisce. Le legge sempre in secondi, unità dichiarata o no.
   * Convertirle qui significherebbe riscrivere numeri che il motore poi
   * interpreta nella scala vecchia: `[{t:0,v:0.01},{t:1,v:0.1}]` diventerebbe
   * `[{t:0,v:10},{t:1,v:100}]`, cioè grani mille volte più lunghi, per un
   * gesto il cui senso è «il numero cambia, la durata reale no». */
  const dictOnly = [{ t: 0, v: 0.001 }, { t: 1, v: 0.1 }];
  assert("lista di soli breakpoint dict: NON convertita (il motore non la scala)",
    eq(C({ durationEnv: dictOnly }, "milliseconds").durationEnv, dictOnly),
    JSON.stringify(C({ durationEnv: dictOnly }, "milliseconds").durationEnv));
  const tuple3Only = [[0, 0.001, "exp"], [1, 0.1, "lin"]];
  assert("lista di soli 3-tuple: NON convertita",
    eq(C({ durationEnv: tuple3Only }, "milliseconds").durationEnv, tuple3Only),
    JSON.stringify(C({ durationEnv: tuple3Only }, "milliseconds").durationEnv));
  const singleDict = [{ t: 0, v: 0.001 }];
  assert("un solo breakpoint dict: NON convertito",
    eq(C({ durationEnv: singleDict }, "milliseconds").durationEnv, singleDict));
  assert("lista vuota: NON convertita (per il motore non è envelope-like)",
    eq(C({ durationEnv: [] }, "milliseconds").durationEnv, []));
  assert("la porta non tocca le forme che il motore scala davvero",
    eq(C({ durationEnv: [[0, 0.001], [1, 0.1]] }, "milliseconds").durationEnv, [[0, 1], [1, 100]]));
  const rangeEnv = C({ durationRangeEnv: [[0, 0.01], [1, 0.02]] }, "milliseconds");
  assert("anche l'envelope di duration_range",
    eq(rangeEnv.durationRangeEnv, [[0, 10], [1, 20]]), JSON.stringify(rangeEnv.durationRangeEnv));

  // clamp: un valore fuori bound resta fuori bound anche convertito, e va riportato dentro
  const over = C({ duration: 100 }, "milliseconds", { bounds: BOUNDS });
  assert("uno scalare oltre il cap viene riportato dentro i bound della nuova unità",
    over.duration === 10000, JSON.stringify(over));
  assert("senza bound non si clampa nulla",
    C({ duration: 100 }, "milliseconds").duration === 100000);
  // la conversione è esatta: un valore dentro i bound ci resta, il clamp non morde
  assert("un valore valido non viene toccato dal clamp",
    C({ duration: 0.05 }, "milliseconds", { bounds: BOUNDS }).duration === 50);

  // stessa unità, unità ignote, immutabilità
  const same = C({ duration: 50, durationUnit: "milliseconds" }, "milliseconds");
  assert("unità invariata → valore invariato", same.duration === 50);
  const fromUnknown = C({ duration: 12, durationUnit: "ms" }, "seconds");
  assert("da un'unità ignota non si converte (non se ne conosce la scala)",
    fromUnknown.duration === 12 && !("durationUnit" in fromUnknown),
    JSON.stringify(fromUnknown));
  const toUnknown = C({ duration: 0.05 }, "ms");
  assert("verso un'unità ignota nemmeno, ma la chiave si scrive",
    toUnknown.duration === 0.05 && toUnknown.durationUnit === "ms");
  const src = { duration: 0.05, durationEnv: null, durationUnit: null };
  C(src, "milliseconds");
  assert("il grain di partenza non viene mutato", src.duration === 0.05);
  assert("le altre chiavi del grain sopravvivono",
    C({ duration: 0.05, envelope: "hanning", reverse: null }, "milliseconds").envelope === "hanning");
}

console.log("\n── cablaggio grain.duration_unit (issue #114) ──");
{
  const inspSrc = fs.readFileSync(path.join(__dirname, "../../src/components/Inspector.jsx"), "utf8");

  assert("il Seg elenca le unità del motore, non una coppia cablata a mano",
    /options=\{window\.PGEEnvUtils\.GRAIN_DURATION_UNITS\.map\(/.test(inspSrc)
    && !/options=\{\[\{label:"seconds",value:"seconds"\},\{label:"samples",value:"samples"\}\]\}/.test(inspSrc));
  // Il ramo di cancellazione vale per `seconds` e basta — con tre unità, "tutto
  // ciò che non è samples torna al default" cancellava milliseconds. La regola
  // ora sta in convertGrainDurationUnit (testata sopra: verso seconds cancella,
  // verso ogni altra unità scrive), e il controllo ci passa attraverso invece
  // di riscriverla nel JSX.
  assert("cambiare unità passa dal convertitore, chiave compresa",
    /onChange\(\{ grain: window\.PGEEnvUtils\.convertGrainDurationUnit\(/.test(inspSrc)
    && /stream\.grain, v, \{ bounds: window\.PGE_BOUNDS \}\)/.test(inspSrc));
  assert("nel JSX non è rimasto un ramo che cancella la chiave a mano",
    !/delete ng\.durationUnit/.test(inspSrc)
    && !/if \(v === "samples"\) \{/.test(inspSrc));
  assert("l'unità in vigore è calcolata una volta sola",
    /const grainUnit = \(stream\.grain && stream\.grain\.durationUnit\) \|\| "seconds"/.test(inspSrc));
  // "s" su valori scritti in campioni o millisecondi direbbe il falso.
  assert("duration e duration_range portano il suffisso dell'unità dichiarata",
    /const grainUnitSuffix = window\.PGEEnvUtils\.grainUnitSuffix\(grainUnit\)/.test(inspSrc)
    && (inspSrc.match(/Env \? "" : grainUnitSuffix\}/g) || []).length === 2
    && !/unit=\{stream\.grain\.durationEnv \? "" : "s"\}/.test(inspSrc));
  assert("il messaggio d'errore nomina l'unità scelta invece di dire 'samples'",
    /grainUnitError\.unit\} richiede una grain\.duration esplicita/.test(inspSrc)
    && !/duration_unit: samples richiede una grain\.duration esplicita/.test(inspSrc));
  assert("un'unità ignota ha un messaggio suo",
    /grainUnitError\.kind === "unknown"/.test(inspSrc));
  // Il fattore di milliseconds è fisso (1e-3): citare il sample rate nel suo
  // hint sarebbe la riga sbagliata copiata da quella dei campioni.
  {
    const msHint = /grainUnit === "milliseconds" \? \([\s\S]{0,600}?\) : null\}/.exec(inspSrc);
    assert("milliseconds ha un hint proprio", !!msHint);
    assert("l'hint dei millisecondi non cita il sample rate",
      !!msHint && !/48000|sample rate di output/.test(msHint[0]) && /millisecond/.test(msHint[0]));
  }
  // Il sample rate nelle due frasi viene dalla costante condivisa: scritto a
  // mano sarebbe l'ennesima copia da inseguire se il motore lo muove.
  assert("l'hint dei campioni resta sul ramo samples, col sample rate interpolato",
    /grainUnit === "samples" \? \([\s\S]{0,400}?campioni a \$\{window\.PGE_OUTPUT_SR\} Hz/.test(inspSrc));
  assert("nessun sample rate scritto a mano nelle frasi dell'unità",
    !/campioni a 48000 Hz/.test(inspSrc));
  // Il seme del passaggio a envelope (e il ritorno a scalare) è il default del
  // motore, 0.05 s: scritto nudo con milliseconds selezionato sono 50
  // microsecondi — e succederebbe proprio nello stato in cui l'errore invita a
  // mettere una duration esplicita, che così sparirebbe peggiorando il valore.
  assert("il seme di grainDur è il default convertito nell'unità in vigore",
    /const grainDurSeed = window\.PGEEnvUtils\.grainDefaultDuration\(/.test(inspSrc)
    && (inspSrc.match(/grainDurSeed/g) || []).length >= 3);
  // Il menu "aggiungi chiave" è l'altro punto che semina un valore: 0.01 è un
  // numero in secondi, e scritto tale e quale con milliseconds in vigore vale
  // 1e-5 s — mille volte meno di quel che l'etichetta promette, e in silenzio
  // (duration esplicita → validazione muta, bound larghi → passa).
  assert("anche il seme di duration_range è convertito nell'unità in vigore",
    /def: window\.PGEEnvUtils\.grainSecondsToUnit\(0\.01, grainUnit\)/.test(inspSrc)
    && !/exists: stream\.grain\.durationRange[^}]*def: 0\.01/.test(inspSrc));
  assert("nessun 0.05 nudo rimasto nei rami di grain.duration",
    !/durationEnv: \[\[0, v\], \[1, v\]\][\s\S]{0,80}0\.05/.test(inspSrc)
    && !/grainDur: 0\.05/.test(inspSrc)
    && !/cur\.durationEnv\[0\]\[1\]\) \|\| 0\.05/.test(inspSrc));
  assert("il tooltip della chiave elenca le tre unità",
    /title=\{`unità di grain\.duration e duration_range[^`]*milliseconds/.test(inspSrc));
}

console.log("\n── cablaggio unità di grain.duration nell'EnvelopeEditor (issue #114) ──");
{
  const eeSrc = fs.readFileSync(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"), "utf8");
  const inspSrc = fs.readFileSync(path.join(__dirname, "../../src/components/Inspector.jsx"), "utf8");

  // I bound statici di grain_duration sono in secondi (max 10); i valori di un
  // envelope sono nell'unità dichiarata. Presi come sono, un envelope in
  // millisecondi finisce tappato a 10 ms invece che a 10 s — e clampY riscrive
  // il punto al primo drag, che è perdita di dati, non solo una vista storta.
  assert("i bound delle curve di durata seguono l'unità dichiarata",
    /const grainDurBounds = window\.PGEEnvUtils\.grainUnitBounds\(PB\.grainDur, grainDurUnit\)/.test(eeSrc)
    && /const grainRangeBounds = window\.PGEEnvUtils\.grainUnitBounds\(PB\.durationRange, grainRangeUnit\)/.test(eeSrc)
    && !/hardMin: PB\.grainDur\.min, hardMax: PB\.grainDur\.max/.test(eeSrc)
    && !/hardMin: PB\.durationRange\.min, hardMax: PB\.durationRange\.max/.test(eeSrc));
  assert("anche la finestra di partenza è espressa nell'unità",
    !/visMin: 0\.001, visMax: 0\.1/.test(eeSrc)
    && !/visMin: 0, visMax: 0\.5,/.test(eeSrc)
    && /grainDurVis/.test(eeSrc) && /grainRangeVis/.test(eeSrc));
  assert("il suffisso è quello condiviso con l'Inspector",
    /window\.PGEEnvUtils\.grainUnitSuffix\(grainDurUnit\)/.test(eeSrc)
    && /window\.PGEEnvUtils\.grainUnitSuffix\(grainRangeUnit\)/.test(eeSrc)
    && /unit: grainDurSuffix, fine: true,/.test(eeSrc)
    && /unit: grainRangeSuffix, fine: true,/.test(eeSrc));
  // L'unità vale PER CURVA: una forma che il motore non scala resta in secondi
  // qualunque unità sia dichiarata, e l'asse deve dirlo — altrimenti il primo
  // drag legge "ms" e scrive secondi (50 sull'asse -> 50 s per il motore).
  assert("l'unità della curva passa dalla porta del motore, non solo dallo stream",
    /isEngineEnvelopeLike\(env\) \? grainUnit : "seconds"/.test(eeSrc)
    && /const grainDurUnit = curveUnit\(stream\.grain && stream\.grain\.durationEnv\)/.test(eeSrc)
    && /const grainRangeUnit = curveUnit\(stream\.grain && stream\.grain\.durationRangeEnv\)/.test(eeSrc));
  assert("l'Inspector dice perché quella curva resta in secondi",
    /isEngineEnvelopeLike\(stream\.grain\[k\]\)/.test(inspSrc)
    && /legge questo envelope in SECONDI/.test(inspSrc));
}

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
