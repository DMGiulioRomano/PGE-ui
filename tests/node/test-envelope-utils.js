/* =============================================================================
 * test-envelope-utils.js — tests for envelope-utils.js (window.PGEEnvUtils),
 * the freeze-on-resize rescale/truncate math extracted from app.jsx (#44).
 *
 * Run: node test-envelope-utils.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// envelope-loops.js (window.PGEEnv) must load first; envelope-utils.js captures
// window.PGEEnv at IIFE time and reads window.PGEDephase (dephase.js) at call
// time. js-yaml is provided in case envelope-loops needs it.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/dephase.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-utils.js"), "utf8"));

const U = window.PGEEnvUtils;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n── module surface ──");
assert("PGEEnvUtils exposes the 9 helpers",
  ["rescaleEnvArray", "truncateEnvArray", "envArrayWouldTruncate", "_applyEnvFields",
   "rescaleStreamEnvelopes", "truncateStreamEnvelopes", "streamWouldTruncate", "nudgeBreakpoint",
   "computeYFit"]
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

console.log("\n── dephase envelopes (issue #61) ──");
{
  // global probability envelope (array form)
  const arrStream = { id: "s5", dephase: [[0, 0], [1, 1]] };
  const ra = U.rescaleStreamEnvelopes(arrStream, 10, 20);
  assert("rescale dephase array form", eq(ra.dephase, [[0, 0], [0.5, 1]]));
  assert("streamWouldTruncate true on dephase array", U.streamWouldTruncate(arrStream, 2) === true);

  // per-param object: array params rescaled, scalar/null params preserved verbatim
  const objStream = { id: "s6", dephase: { volume: [[0, 0], [1, 1]], pan: 0.5, pitch: null } };
  const ro = U.rescaleStreamEnvelopes(objStream, 10, 20);
  assert("rescale dephase.volume (array param)", eq(ro.dephase.volume, [[0, 0], [0.5, 1]]));
  assert("dephase.pan scalar param preserved",   ro.dephase.pan === 0.5);
  assert("dephase.pitch null param preserved",   ro.dephase.pitch === null);
  assert("streamWouldTruncate true on dephase.volume env", U.streamWouldTruncate(objStream, 2) === true);
  assert("rescaleStreamEnvelopes does not mutate dephase input", eq(objStream.dephase.volume, [[0, 0], [1, 1]]));

  // scalar / false dephase left untouched (not a time-domain envelope)
  assert("dephase scalar untouched", U.rescaleStreamEnvelopes({ dephase: 0.01 }, 10, 20).dephase === 0.01);
  assert("dephase false untouched",  U.rescaleStreamEnvelopes({ dephase: false }, 10, 20).dephase === false);
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
  const r5 = U.computeYFit([0.5, 0.5], { visMin: 0, visMax: 1, hardMin: 0, hardMax: 10, unit: "s" });
  assert("constant (s) opens a fine window", r5.ymax > 0.5 && r5.ymin < 0.5 && (r5.ymax - r5.ymin) < 0.1, JSON.stringify(r5));

  // signed values (pan-like): window hugs [-30,40], not the ±360 vis window.
  const r6 = U.computeYFit([-30, 40], { visMin: -360, visMax: 360, hardMin: -3600, hardMax: 3600, unit: "°" });
  assert("signed points fit tightly (≈[-37,47])", near(r6.ymin, -37) && near(r6.ymax, 47), JSON.stringify(r6));

  // result is always a proper interval.
  assert("ymax strictly above ymin in every case",
    [r, r2, r3, r4, r5, r6].every(x => x.ymax > x.ymin));
}

console.log("\n── dephase typed {type,points} envelopes (cubic global interp) ──");
{
  // GLOBAL typed envelope (what wrapEnv emits for cubic) must be treated as a
  // single global env: its points rescale, and it counts for truncation.
  const typedStream = { id: "s7", dephase: { type: "cubic", points: [[0, 0], [1, 1]] } };
  const rt = U.rescaleStreamEnvelopes(typedStream, 10, 20);
  assert("rescale dephase typed global env (points scaled)",
    eq(rt.dephase, { type: "cubic", points: [[0, 0], [0.5, 1]] }));
  assert("streamWouldTruncate true on typed global dephase env",
    U.streamWouldTruncate(typedStream, 2) === true);
  assert("rescale does not mutate typed dephase input",
    eq(typedStream.dephase, { type: "cubic", points: [[0, 0], [1, 1]] }));

  // truncate clips a typed global env past x=1.0 (object-form path).
  const tt = U.truncateStreamEnvelopes({ id: "s7b", dephase: { type: "cubic", points: [[0, 0], [2, 1]] } });
  assert("truncate typed global dephase env clips past 1.0",
    eq(tt.dephase, { type: "cubic", points: [[0, 0], [1, 0.5]] }), JSON.stringify(tt.dephase));

  // PER-PARAM with a typed envelope value: that param rescales too.
  const ppStream = { id: "s8", dephase: { volume: { type: "cubic", points: [[0, 0], [1, 1]] }, pan: 0.5 } };
  const rp = U.rescaleStreamEnvelopes(ppStream, 10, 20);
  assert("rescale dephase.volume typed env param",
    eq(rp.dephase.volume, { type: "cubic", points: [[0, 0], [0.5, 1]] }));
  assert("dephase.pan scalar preserved alongside typed param", rp.dephase.pan === 0.5);
  assert("streamWouldTruncate true on typed per-param dephase env",
    U.streamWouldTruncate(ppStream, 2) === true);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
