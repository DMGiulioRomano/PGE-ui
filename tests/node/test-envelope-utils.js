/* =============================================================================
 * test-envelope-utils.js — tests for envelope-utils.js (window.PGEEnvUtils),
 * the freeze-on-resize rescale/truncate math extracted from app.jsx (#44).
 *
 * Run: node test-envelope-utils.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

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
assert("PGEEnvUtils exposes the 21 helpers",
  ["sliceEnvArray", "sliceStreamEnvelopes", "rescaleEnvArray", "truncateEnvArray", "envArrayWouldTruncate", "_applyEnvFields",
   "rescaleStreamEnvelopes", "truncateStreamEnvelopes", "streamWouldTruncate", "nudgeBreakpoint",
   "computeYFit", "loopEnvMax", "loopUnitInfo", "loopUnitError", "loopUnitSuffix", "loopUnitRescaleKeys",
   "loopBoundsError", "grainDurationUnitError", "snapDirection", "snapForDomain", "readDirectionError"]
    .every(k => typeof U[k] === "function"),
  JSON.stringify(Object.keys(U)));
// Il vocabolario non e' una funzione: viaggia con loro perche' il selettore
// dell'Inspector ci costruisca sopra i bottoni invece di ricopiarli.
assert("espone il vocabolario del motore e il suo default",
  eq(U.LOOP_UNITS, ["seconds", "absolute", "normalized"]) && U.LOOP_UNIT_DEFAULT === "seconds");

console.log("\n── rescaleEnvArray ──");
assert("breakpoints scaled by ratio",
  eq(U.rescaleEnvArray([[0, 1], [1, 0.5]], 0.5), [[0, 1], [0.5, 0.5]]));
// Il tappo a 1.0 c'era e mangiava il dato che serve al truncate: ogni punto
// oltre la nuova fine finiva impilato sul bordo, indistinguibile da un envelope
// che li' ci finisce davvero. La x fuori scala e' uno stato transitorio fra
// rescale e truncate, non un valore da salvare.
assert("i tempi oltre la fine NON vengono tappati a 1.0",
  eq(U.rescaleEnvArray([[0, 0], [1, 1]], 2), [[0, 0], [2, 1]]));
assert("accorciare a meta' butta la coda invece di impilarla sul bordo",
  eq(U.truncateEnvArray(U.rescaleEnvArray([[0, 0], [0.5, 1], [1, 0]], 2)),
     [[0, 0], [1, 1]]),
  JSON.stringify(U.truncateEnvArray(U.rescaleEnvArray([[0, 0], [0.5, 1], [1, 0]], 2))));
assert("anche il blocco compatto conserva l'end_time fuori scala",
  eq(U.rescaleEnvArray([[[[0, 0], [1, 1]], 0.8, 2]], 2), [[[[0, 0], [1, 1]], 1.6, 2]]));
// Il tag interp sta sul punto di partenza e governa il segmento in uscita:
// su uno step il valore si tiene, e interpolarlo sarebbe un salto inventato.
assert("il punto di chiusura onora lo step del segmento tagliato",
  eq(U.truncateEnvArray([[0, 0.2, "step"], [1.5, 1]]), [[0, 0.2, "step"], [1, 0.2]]),
  JSON.stringify(U.truncateEnvArray([[0, 0.2, "step"], [1.5, 1]])));
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
// pointer.loopUnit, default "seconds" — dopo PGE #222 time_mode non c'entra.
// ---------------------------------------------------------------------------
console.log("\n── loopEnvMax (sample-driven loop bound) ──");
{
  const ptr = (extra) => ({ pointer: Object.assign({ loopStartEnv: [[0, 0], [1, 1]] }, extra || {}) });

  // absolute/seconds (default): cap is the sample duration
  assert("no loop_unit → cap = sampleDur",
    U.loopEnvMax(ptr(), 12.5) === 12.5);
  assert("loopUnit seconds → cap = sampleDur",
    U.loopEnvMax(ptr({ loopUnit: "seconds" }), 8) === 8);
  assert("loopUnit absolute (alias storico) → cap = sampleDur",
    U.loopEnvMax(ptr({ loopUnit: "absolute" }), 8) === 8);

  // normalized: loop coords live in [0,1] → cap 1, regardless of sampleDur
  assert("loopUnit normalized → cap = 1",
    U.loopEnvMax(ptr({ loopUnit: "normalized" }), 30) === 1);
  // Il caso che PGE #222 ha rovesciato: prima ereditava e tappava a 1, ora no.
  assert("timeMode normalized senza loopUnit → cap = sampleDur (niente eredita')",
    U.loopEnvMax(Object.assign({ timeMode: "normalized" }, ptr()), 30) === 30);
  assert("timeMode non tocca il cap nemmeno in absolute",
    U.loopEnvMax(Object.assign({ timeMode: "absolute" }, ptr({ loopUnit: "normalized" })), 30) === 1);

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

  // Una grafia fuori vocabolario legge come il default: e' la direzione
  // conservativa (il render muore comunque, lo dice loopUnitError).
  assert("grafia ignota → cap = sampleDur, come l'assente",
    U.loopEnvMax(ptr({ loopUnit: "normalised" }), 7) === 7);
}

// ---------------------------------------------------------------------------
// loopUnitInfo — which unit the loop window is written in, and where that unit
// comes from. Specchio del motore (PointerController): la chiave si legge dal
// blocco pointer e non eredita NIENTE — PGE #222 ha tolto il ramo
// `or self._config.time_mode` e il default e' `seconds`, una costante.
// La provenienza resta perche' l'Inspector deve sapere se materializzare la
// chiave o lasciarla assente (issue #126), ma i valori sono due, non tre.
// ---------------------------------------------------------------------------
console.log("\n── loopUnitInfo (unit + provenance) ──");
{
  const info = (stream) => U.loopUnitInfo(stream);

  assert("no keys → absolute from the engine default",
    eq(info({}), { unit: "absolute", source: "default", spelling: null }));
  assert("null stream tolerated → absolute/default",
    eq(info(null), { unit: "absolute", source: "default", spelling: null }));

  /* Le tre righe che seguono sono il cuore di #149: prima asserivano
     l'ereditarieta' — «timeMode normalized → normalized, inherited» — cioe' il
     contratto che il motore non ha piu'. Su uno YAML scritto a mano con
     `time_mode: normalized` e nessun `loop_unit`, la vecchia risposta mandava
     lo split a scrivere 0.075 dove il motore legge 0.6 s: sbagliato di 8x. */
  assert("timeMode normalized senza loop_unit → absolute, default (niente eredita')",
    eq(info({ timeMode: "normalized" }), { unit: "absolute", source: "default", spelling: null }));
  assert("timeMode absolute senza loop_unit → absolute, default",
    eq(info({ timeMode: "absolute" }), { unit: "absolute", source: "default", spelling: null }));
  assert("nessun time_mode puo' produrre la lettura normalized",
    ["normalized", "absolute", "weird", undefined]
      .every(tm => info({ timeMode: tm }).unit === "absolute"));

  assert("explicit loop_unit normalized on an absolute stream",
    eq(info({ timeMode: "absolute", pointer: { loopUnit: "normalized" } }),
       { unit: "normalized", source: "loop_unit", spelling: "normalized" }));
  assert("explicit loop_unit absolute on a normalized stream",
    eq(info({ timeMode: "normalized", pointer: { loopUnit: "absolute" } }),
       { unit: "absolute", source: "loop_unit", spelling: "absolute" }));

  /* Due grafie per la stessa lettura: `seconds` e' quella canonica del motore,
     `absolute` l'alias storico. `unit` e' la LETTURA, quindi ne ha una sola;
     `spelling` porta la stringa com'e' scritta, che e' quel che l'Inspector
     mostra accanto al selettore. Prima `seconds` compariva qui come esempio di
     «stringa ignota» — dopo #222 e' la grafia principale. */
  assert("loop_unit seconds → absolute, esplicito",
    eq(info({ pointer: { loopUnit: "seconds" } }),
       { unit: "absolute", source: "loop_unit", spelling: "seconds" }));
  assert("seconds e absolute danno la stessa lettura",
    info({ pointer: { loopUnit: "seconds" } }).unit === info({ pointer: { loopUnit: "absolute" } }).unit);
  assert("ma restano distinguibili nella grafia",
    info({ pointer: { loopUnit: "seconds" } }).spelling !== info({ pointer: { loopUnit: "absolute" } }).spelling);

  // Una grafia fuori vocabolario legge come il default — la direzione
  // conservativa — ma non e' silenzio: a dirlo e' loopUnitError, qui sotto.
  assert("grafia fuori vocabolario → absolute, ma esplicita",
    eq(info({ pointer: { loopUnit: "normalised" } }),
       { unit: "absolute", source: "loop_unit", spelling: "normalised" }));

  // loopEnvMax must agree with it — one resolution, two readers.
  assert("loopEnvMax agrees: normalized esplicito tappa a 1",
    U.loopEnvMax({ timeMode: "absolute", pointer: { loopUnit: "normalized" } }, 30) === 1);
  assert("loopEnvMax agrees: uno stream normalized senza chiave tappa a sampleDur",
    U.loopEnvMax({ timeMode: "normalized" }, 30) === 30);
}

// ---------------------------------------------------------------------------
// loopUnitError — lo specchio del rifiuto del motore, sulla forma di
// window.PGEDeviationProb.error. Prima di #222 qualunque stringa valeva
// "assoluto" per esclusione (il motore testava solo `!= 'normalized'`); ora
// e' InvalidFieldValueError e il render muore, quindi normalizzare in silenzio
// significherebbe mostrare verde uno stream che non rende.
// ---------------------------------------------------------------------------
console.log("\n── loopUnitError (vocabolario) ──");
{
  const err = (loopUnit) => U.loopUnitError({ loopUnit });

  for (const u of ["seconds", "absolute", "normalized"]) {
    assert(`${u} e' nel vocabolario → null`, err(u) === null);
  }
  assert("chiave assente → null (e' il default, non un errore)", err(undefined) === null);
  assert("pointer nullo → null", U.loopUnitError(null) === null);
  assert("pointer assente → null", U.loopUnitError(undefined) === null);

  assert("refuso normalised → errore", err("normalised") !== null);
  assert("l'errore riporta il valore scritto", err("normalised").value === "normalised");
  assert("…e il vocabolario da mostrare",
    eq(err("normalised").units, ["seconds", "absolute", "normalized"]));
  assert("il vocabolario esposto e' una copia, non l'originale",
    err("x").units !== U.LOOP_UNITS && eq(err("x").units, U.LOOP_UNITS));
  assert("maiuscole: il motore confronta stringhe esatte", err("Seconds") !== null);
  assert("secondi (italiano) → errore", err("secondi") !== null);

  /* La chiave scritta vuota e' un errore del motore ma non arriva fin qui: il
     bridge la scarta in parse (`ptr.loop_unit != null`) e non la riserializza,
     quindi in editor quel caso E' gia' la chiave assente. Asserito perche' la
     funzione non deve inventarsi un errore su uno stato che l'editor produce. */
  assert("null (loop_unit: vuoto, scartato dal bridge) → null", err(null) === null);
  assert("stringa vuota → null", err("") === null);

  /* E lo stesso vale per OGNI grafia falsy, non solo per quelle due: il parse
     lascia passare `loop_unit: 0` e `loop_unit: false` (scarta solo il null),
     ma il serializzatore emette `ptr.loopUnit || undefined`, quindi la chiave
     non arriva mai al motore — e `/render` scrive lo stato dell'editor sul
     config prima di lanciarlo. Accusarle sarebbe un rosso su un render che
     riesce, e in disaccordo con loopUnitInfo, che le da' per assenti: la riga
     di provenienza direbbe «default: seconds» accanto a una riga d'errore. */
  for (const falsy of [0, false, NaN]) {
    assert(`${String(falsy)} → null (il serializzatore toglie la chiave)`,
      err(falsy) === null);
    assert(`…e loopUnitInfo concorda: ${String(falsy)} e' la chiave assente`,
      U.loopUnitInfo({ pointer: { loopUnit: falsy } }).source === "default");
  }
}

// ---------------------------------------------------------------------------
// loopUnitSuffix — l'etichetta di pointer.start e delle tre righe del loop.
// Stessa regola di grainUnitSuffix, e per lo stesso motivo: su un'unita' che
// il motore non riconosce non c'e' suffisso, perche' una «s» accanto alla riga
// d'errore che dichiara l'unita' non riconosciuta sarebbero due affermazioni
// opposte. Vive nel modulo perche' lo leggono Inspector ed EnvelopeEditor.
// ---------------------------------------------------------------------------
console.log("\n── loopUnitSuffix (etichetta di start e del loop) ──");
{
  const suf = (loopUnit) => U.loopUnitSuffix(loopUnit === undefined ? {} : { loopUnit });

  assert("chiave assente → s (assente E' seconds)", suf(undefined) === "s");
  assert("pointer nullo → s", U.loopUnitSuffix(null) === "s");
  assert("seconds → s", suf("seconds") === "s");
  assert("absolute (alias storico) → s", suf("absolute") === "s");
  assert("normalized → nessun suffisso", suf("normalized") === "");

  /* Il caso che questa funzione esiste per coprire: prima il suffisso era un
     ternario su `unit`, e una grafia fuori vocabolario legge "absolute" —
     quindi la riga mostrava «0.4 s» sotto un rosso che diceva che l'unita' non
     e' riconosciuta. */
  assert("grafia fuori vocabolario → nessun suffisso", suf("normalised") === "");
  assert("…e per ogni grafia che loopUnitError rifiuta",
    ["Seconds", "secondi", "x"].every(u => suf(u) === "" && U.loopUnitError({ loopUnit: u }) !== null));
  assert("il suffisso tace esattamente dove parla loopUnitError, o in normalized",
    ["seconds", "absolute", "normalized", "normalised", "", undefined]
      .every(u => (suf(u) === "") === (!!U.loopUnitError({ loopUnit: u }) || u === "normalized")));

  // Il timeMode non entra piu' nemmeno qui: e' loopUnitInfo, un livello sotto.
  assert("timeMode non tocca il suffisso",
    U.loopUnitSuffix({}) === "s" && U.loopUnitInfo({ timeMode: "normalized" }).unit === "absolute");
}

// ---------------------------------------------------------------------------
// loopUnitRescaleKeys — quali chiavi cambiano DAVVERO lettura per uno stream
// che #222 ha spostato. Specchio di `_rescaling_would_change` sul giro di
// `_LOOP_UNIT_SCOPE`: e' il filtro con cui il motore decide se emettere
// l'avviso [LOOP_UNIT], e l'avviso dell'Inspector e' quello stesso avviso.
// Senza filtro l'editor parla su `start: 0` — la forma piu' comune del corpus,
// e quella con cui nasce ogni clip — dove non si muove un campione.
// ---------------------------------------------------------------------------
console.log("\n── loopUnitRescaleKeys (chi cambia davvero, PGE #222) ──");
{
  const K = (pointer) => U.loopUnitRescaleKeys(pointer);

  assert("pointer nullo → nessuna chiave", eq(K(null), []));
  assert("pointer vuoto → nessuna chiave", eq(K({}), []));

  /* Il caso che il filtro esiste per tacere: zero resta zero sotto qualunque
     fattore di scala. E' il pointer con cui l'editor crea ogni clip. */
  assert("start: 0 senza loop → nessuna chiave (zero non si muove)",
    eq(K({ start: 0, speedRatio: 1, loopStart: null, loopDur: null }), []));
  assert("loop_start: 0 esplicito → nessuna chiave", eq(K({ loopStart: 0 }), []));

  assert("start non nullo → start", eq(K({ start: 0.5 }), ["start"]));
  assert("start negativo → start", eq(K({ start: -0.25 }), ["start"]));
  assert("loop_start scalare → loop_start", eq(K({ loopStart: 0.2 }), ["loop_start"]));
  assert("loop_end scalare → loop_end", eq(K({ loopEnd: 1 }), ["loop_end"]));
  assert("loop_dur scalare → loop_dur", eq(K({ loopDur: 0.5 }), ["loop_dur"]));

  /* Un envelope si muove tutto: `scale_raw_param_values` scala i valori y, e
     `is_envelope_like` e' proprio il ramo che glielo fa fare. Nel bridge la
     forma envelope vive nel gemello `*Env`, mai nello scalare. */
  assert("loop_start envelope → loop_start",
    eq(K({ loopStart: null, loopStartEnv: [[0, 0.1], [1, 0.9]] }), ["loop_start"]));
  assert("loop_dur envelope → loop_dur",
    eq(K({ loopDurEnv: { type: "linear", points: [[0, 0.1], [1, 0.9]] } }), ["loop_dur"]));
  assert("start envelope (passa grezzo dal bridge) → start",
    eq(K({ start: [[0, 0.1], [1, 0.9]] }), ["start"]));

  /* Ordine e grafia: sono le chiavi che il messaggio del motore nomina
     (`[LOOP_UNIT] [id] start, loop_end: ora in secondi`), nell'ordine di
     `_LOOP_UNIT_SCOPE`. */
  assert("le chiavi escono in grafia YAML e nell'ordine del motore",
    eq(K({ loopEnd: 2, start: 0.5, loopDur: null, loopStart: 0 }), ["start", "loop_end"]));
  assert("tutte e quattro insieme",
    eq(K({ start: 0.1, loopStart: 0.2, loopEnd: 0.3, loopDur: 0.4 }),
       ["start", "loop_start", "loop_end", "loop_dur"]));

  /* Quel che la conversione lasciava passare invariato non si muoveva nemmeno
     prima: `_rescaling_would_change` esclude None e i bool, e una stringa non
     e' envelope-like. */
  assert("null/undefined → nessuna chiave", eq(K({ start: null, loopStart: undefined }), []));
  assert("booleano → nessuna chiave (il motore esclude bool prima dei numeri)",
    eq(K({ start: true }), []));
  assert("stringa → nessuna chiave (non e' envelope-like)", eq(K({ start: "0.5" }), []));
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

console.log("\n── cablaggio loop_unit (issue #126, poi #149) ──");
{
  const inspSrc = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));

  assert("l'Inspector risolve unità e provenienza con loopUnitInfo",
    /window\.PGEEnvUtils\.loopUnitInfo\(stream\)/.test(inspSrc));
  /* Il default non si calcola piu' dallo stream: e' la costante del modulo.
     `loopUnitInfo({ timeMode: stream.timeMode })` era la riga che rendeva
     "ridondante" una proprieta' dello stream invece che della chiave, ed e'
     quella che trasformava uno stream sano in uno esposto. */
  assert("il default arriva dal modulo, non da un secondo giro su timeMode",
    /const LOOP_UNIT_DEFAULT = window\.PGEEnvUtils\.LOOP_UNIT_DEFAULT/.test(inspSrc)
    && !/loopUnitInfo\(\{ timeMode/.test(inspSrc)
    && !/loopUnitInherited/.test(inspSrc));
  assert("il selettore scrive la grafia canonica del motore",
    /options=\{\[\{label:"seconds",value:"seconds"\},\{label:"normalized",value:"normalized"\}\]\}/.test(inspSrc));
  /* La regressione del punto 1 di #149, in forma di guardia: Seg chiama
     onChange anche sul bottone gia' acceso, quindi senza questo ritorno
     anticipato un click su "normalized" — la selezione corrente di ogni clip
     nato nell'editor — cancellava la chiave. Il comportamento e' verificato
     anche eseguendo la funzione, poco piu' sotto. */
  assert("un click che non cambia unità non tocca lo YAML",
    /if \(u === loopUnitSel\) return;/.test(inspSrc));
  assert("si cancella solo la chiave che vale il default",
    /u === LOOP_UNIT_DEFAULT\) delete np\.loopUnit; else np\.loopUnit = u/.test(inspSrc));
  assert("una riga dichiara il cap effettivo del loop",
    /durata del sample/.test(inspSrc));
  assert("loop_unit non è più nell'AddParamMenu (il controllo lo rimpiazza)",
    !/key: "loopUnit"/.test(inspSrc));
  /* Il suffisso lo decide il modulo, non un ternario nel JSX: e' l'unico modo
     perche' taccia anche su una grafia fuori vocabolario, dove una «s» starebbe
     sotto la riga rossa che dichiara l'unita' non riconosciuta. */
  assert("in normalized le righe del loop non mostrano il suffisso in secondi",
    /const loopUnitSuffix = window\.PGEEnvUtils\.loopUnitSuffix\(stream\.pointer\)/.test(inspSrc)
    && !/loopUnit\.unit === "normalized" \? "" : "s"/.test(inspSrc)
    && (inspSrc.match(/unit=\{stream\.pointer\.loop\w+Env \? "" : loopUnitSuffix\}/g) || []).length === 3);
  assert("anche pointer.start segue l'unità (il motore scala pure quello)",
    /name="start"[\s\S]{0,160}unit=\{loopUnitSuffix\}/.test(inspSrc)
    && /start e loop_start\/end\/dur ∈ \[0, 1\] × sample_dur/.test(inspSrc));
  assert("un loop_unit scritto a mano si mostra per quello che dice lo YAML",
    /"esplicito: " \+ loopUnit\.spelling/.test(inspSrc));
  /* Il blocco dell'unita' ha un flag suo: la × "Remove loop" toglie il loop,
     non l'unita' in cui e' scritto pointer.start. Finche' i flag erano uno,
     quella × portava via `loop_unit: normalized` da ogni clip nato
     nell'editor — un click, e start cambiava significato di 8x. */
  const unitDecl = (/const loopUnitShown = [\s\S]*?;/.exec(inspSrc) || [""])[0];
  assert("il controllo dell'unità sopravvive alla rimozione del loop",
    /loopWindowShown/.test(unitDecl) && /loopUnit != null/.test(unitDecl)
    && !/loopBlockShown/.test(inspSrc));
  /* E compare ovunque l'unita' governi un valore che si muove, non solo sulla
     popolazione che #222 ha spostato: la condizione dell'avviso porta dentro
     `time_mode`, e usarla anche per la visibilita' rimetteva la dipendenza
     dallo stream che #222 ha tolto. La reachability e' verificata eseguendo le
     due dichiarazioni, poco piu' sotto. */
  assert("…e compare ovunque l'unità morda, senza passare da time_mode",
    /loopUnitScaledKeys\.length > 0/.test(unitDecl)
    && !/loopUnitMigrated\b/.test(unitDecl)
    && /const loopUnitScaledKeys = window\.PGEEnvUtils\.loopUnitRescaleKeys\(stream\.pointer\)/.test(inspSrc));
  assert("la × del loop non cancella più loop_unit",
    !/delete np\.loopDur; delete np\.loopDurEnv;\s*delete np\.loopUnit/.test(inspSrc));
  /* Sulla dichiarazione, non su una finestra di caratteri: una `{0,400}` qui
     scavalcava la fine dell'istruzione e trovava il `loopUnit != null` di
     quella DOPO, cioe' passava anche col difetto. */
  const winDecl = (/const loopWindowShown = [\s\S]*?;/.exec(inspSrc) || [""])[0];
  assert("la finestra di loop guarda le sei chiavi del loop…",
    /loopStartEnv/.test(winDecl) && /loopEndEnv/.test(winDecl) && /loopDurEnv/.test(winDecl));
  assert("…e loop_unit non è fra queste",
    winDecl.length > 0 && !/loopUnit/.test(winDecl));
  /* Il refuso nel vocabolario non rende: dopo #222 e' InvalidFieldValueError,
     non piu' una stringa letta come "assoluto" per esclusione. */
  assert("una grafia fuori vocabolario ha la sua riga d'errore",
    /const loopUnitErr = window\.PGEEnvUtils\.loopUnitError\(stream\.pointer\)/.test(inspSrc)
    && /non è un'unità riconosciuta/.test(inspSrc)
    && /loopUnitErr\.units\.join/.test(inspSrc));
  assert("con una grafia rotta nessun bottone è acceso",
    /const loopUnitSel = loopUnitErr \? null/.test(inspSrc));
  /* L'avviso alla popolazione che #222 ha spostato: normalized senza chiave.
     Il motore lo dice a render (`[LOOP_UNIT] … ora in secondi`) ma quel
     messaggio e' marcato `# ponytail` e va via dopo una release. */
  /* …ma solo quella a cui i numeri si muovono davvero. Il motore filtra il suo
     avviso con `_rescaling_would_change` perche' `start: 0` e' la forma piu'
     comune del corpus — ed e' quella con cui nasce ogni clip dell'editor —
     quindi un avviso non filtrato parlerebbe dove il motore tace, e chi lo
     seguisse scriverebbe una chiave che non muove un campione: fingerprint
     mosso, un render in piu' su uno stem che era giusto. */
  assert("uno stream normalized senza loop_unit viene avvisato",
    /const loopUnitMigratedKeys = \(stream\.timeMode === "normalized" && loopUnit\.source === "default"\)/.test(inspSrc)
    && /window\.PGEEnvUtils\.loopUnitRescaleKeys\(stream\.pointer\)/.test(inspSrc)
    && /const loopUnitMigrated = loopUnitMigratedKeys\.length > 0/.test(inspSrc)
    && /non implica più loop_unit: normalized/.test(inspSrc));
  assert("…e l'avviso nomina le chiavi che cambiano, come fa il motore",
    /\{loopUnitMigratedKeys\.join\(", "\)\}: ora in secondi/.test(inspSrc));
  // start è is_smart=False lato motore (valore raw, nessun bound): clamparlo
  // qui sarebbe la UI a inventarsi un vincolo che il render non ha.
  assert("il ri-clamp resta sui tre estremi del loop, start fuori",
    /for \(const k of \["loopStart", "loopEnd", "loopDur"\]\)/.test(inspSrc)
    && !/start: clampLoop/.test(inspSrc));
  assert("cambiare unità ri-clampa gli estremi scalari col cap della nuova unità",
    /const cap = window\.PGEEnvUtils\.loopEnvMax\(\{ \.\.\.stream, pointer: np \}, sampleDur\)/.test(inspSrc)
    && /np\[k\] = clampLoop\(k, np\[k\], cap\)/.test(inspSrc));

  /* ── e ora il comportamento, non la presenza di una riga ──────────────────
     Le guardie sopra dicono che il sorgente contiene certe stringhe; questa
     ESEGUE l'onChange del selettore, estratto dal JSX per brace matching e
     istanziato con le sue variabili libere. E' il pezzo di #149 che una
     guardia testuale non copre: la catena «Seg chiama anche sul bottone
     acceso → il ramo cancella la chiave → loopUnitInfo continua a mostrare
     normalized per ereditarieta'» era invisibile a chi leggeva le tre righe
     una per una. Il JSX non gira in node, ma il corpo di questa funzione e'
     JavaScript puro: girano i byte del file, non una copia. */
  const segAt = inspSrc.indexOf('<Seg size="xs" value={loopUnitSel}');
  const onChAt = inspSrc.indexOf("onChange={(u) => {", segAt);
  let body = "";
  if (segAt >= 0 && onChAt >= 0) {
    const open = inspSrc.indexOf("{", inspSrc.indexOf("=>", onChAt));
    let depth = 0;
    for (let j = open; j < inspSrc.length; j++) {
      if (inspSrc[j] === "{") depth++;
      else if (inspSrc[j] === "}" && --depth === 0) { body = inspSrc.slice(open, j + 1); break; }
    }
  }
  assert("l'onChange del selettore è estraibile dal sorgente", body.length > 0);

  const makeHandler = (stream, sampleDur) => {
    // Le tre variabili libere che l'Inspector calcola una riga sopra il Seg,
    // ricostruite qui con le stesse funzioni del modulo: il bottone acceso e'
    // la LETTURA in vigore, e non e' acceso niente su una grafia rotta.
    const info = U.loopUnitInfo(stream);
    const sel = U.loopUnitError(stream.pointer) ? null
      : (info.unit === "normalized" ? "normalized" : U.LOOP_UNIT_DEFAULT);
    let out = null;
    const fn = new Function(
      "loopUnitSel", "stream", "LOOP_UNIT_DEFAULT", "window", "sampleDur", "clampLoop", "onChange",
      "return (u) => " + body)(
      sel, stream, U.LOOP_UNIT_DEFAULT, window, sampleDur,
      // clampLoop dell'Inspector, ridotto al suo effetto: tappare al cap
      (k, v, cap) => Math.min(cap != null ? cap : Infinity, Math.max(0, v)),
      (patch) => { out = patch; });
    return { fn, get: () => out, sel };
  };

  {
    // Il caso di regressione: clip nato nell'editor, chiave esplicita, click
    // sul bottone che e' gia' acceso. Prima cancellava `loop_unit` e lo
    // stream cominciava a leggere secondi mostrando ancora "normalized".
    const stream = { timeMode: "normalized", pointer: { start: 0.4, loopUnit: "normalized" } };
    const h = makeHandler(stream, 8);
    h.fn("normalized");
    assert("click sul bottone già acceso: nessuna modifica", h.get() === null);
  }
  {
    // Lo stesso click su uno stream che porta l'alias storico: la lettura non
    // cambia, quindi non si riscrive la grafia (e non si marca stale lo stem).
    const stream = { timeMode: "normalized", pointer: { loopUnit: "absolute" } };
    const h = makeHandler(stream, 8);
    h.fn("seconds");
    assert("absolute + click su seconds: stessa lettura, nessuna riscrittura", h.get() === null);
  }
  {
    // Cambio vero: normalized → seconds. La chiave vale il default, quindi
    // sparisce — assente E' `seconds`, e stavolta e' vero a prescindere dallo
    // stream.
    const stream = { timeMode: "normalized", pointer: { loopUnit: "normalized", loopStart: 0.5 } };
    const h = makeHandler(stream, 8);
    h.fn("seconds");
    assert("normalized → seconds: la chiave sparisce (assente = seconds)",
      h.get() !== null && !("loopUnit" in h.get().pointer));
    assert("…e gli estremi scalari si ri-clampano col cap nuovo",
      h.get().pointer.loopStart === 0.5);
  }
  {
    // Cambio vero nell'altro verso, su uno stream normalized senza chiave:
    // e' la popolazione che #222 ha spostato, e qui la chiave si materializza.
    const stream = { timeMode: "normalized", pointer: { loopStart: 3 } };
    const h = makeHandler(stream, 8);
    h.fn("normalized");
    assert("seconds → normalized: la chiave si scrive",
      h.get() !== null && h.get().pointer.loopUnit === "normalized");
    assert("…e loop_start rientra nel cap di 1", h.get().pointer.loopStart === 1);
  }
  {
    // Grafia rotta: nessun bottone acceso, quindi qualunque click scrive. E'
    // l'unica strada per uscire dal refuso dall'interfaccia.
    const stream = { timeMode: "absolute", pointer: { loopUnit: "normalised" } };
    const h = makeHandler(stream, 8);
    h.fn("seconds");
    assert("refuso + click su seconds: la chiave rotta viene rimossa",
      h.get() !== null && !("loopUnit" in h.get().pointer));
    const h2 = makeHandler(stream, 8);
    h2.fn("normalized");
    assert("refuso + click su normalized: la chiave viene corretta",
      h2.get() !== null && h2.get().pointer.loopUnit === "normalized");
  }

  /* ── il controllo non deve cancellarsi da se' ─────────────────────────────
     Stessa tecnica un livello sopra: si eseguono le DICHIARAZIONI che decidono
     se il selettore esiste, estratte dal sorgente, invece di cercarci dentro
     una stringa. La domanda e' di raggiungibilita', e una guardia testuale non
     la sa porre: `loop_unit` non e' nell'AddParamMenu, quindi il selettore e'
     l'unica via per scriverlo, e se sparisce dopo averlo usato la modifica
     resta senza ritorno. Il caso che la pone e' la coesistenza dei due assi
     che #222 ha reso legittima — `time_mode: absolute` con `loop_unit:
     normalized` — dove un click su "seconds" toglie la chiave e cambia il
     significato di `start` senza lasciare in interfaccia il modo di tornare
     indietro. */
  const declOf = (name) =>
    (new RegExp("const " + name + " = [\\s\\S]*?;").exec(inspSrc) || [""])[0];
  /* Si porta dentro anche la catena dell'avviso — `loopUnit`,
     `loopUnitMigratedKeys`, `loopUnitMigrated` — benche' la formulazione
     corrente non la usi: e' quella la scorciatoia che il caso esiste per
     escludere, e senza le sue variabili in scope una regressione morirebbe con
     un ReferenceError invece di dare un rosso che si legge. */
  const declNames = ["loopUnit", "loopWindowShown", "loopUnitScaledKeys",
                     "loopUnitMigratedKeys", "loopUnitMigrated", "loopUnitShown"];
  const decls = declNames.map(declOf);
  assert("le dichiarazioni della visibilità sono estraibili dal sorgente",
    decls.every(d => d.length > 0), declNames.filter((_, i) => !decls[i].length).join(", "));
  const shownFor = (stream) => new Function("stream", "window",
    decls.join("\n") + "\nreturn loopUnitShown;")(stream, window);

  {
    const stream = { timeMode: "absolute", pointer: { start: 0.5, loopUnit: "normalized" } };
    assert("i due assi che coesistono: il controllo c'è", shownFor(stream) === true);
    const h = makeHandler(stream, 8);
    h.fn("seconds");
    const after = { ...stream, pointer: h.get().pointer };
    assert("…e sopravvive al click che cancella la chiave", shownFor(after) === true);
    const back = makeHandler(after, 8);
    back.fn("normalized");
    assert("…quindi la modifica ha un ritorno",
      back.get() !== null && back.get().pointer.loopUnit === "normalized");
  }
  {
    // La popolazione che #222 ha spostato continua a vedere il controllo: la
    // condizione e' strettamente piu' larga di quella dell'avviso.
    assert("normalized senza chiave, con valori che si muovono: il controllo c'è",
      shownFor({ timeMode: "normalized", pointer: { start: 0.5 } }) === true);
    // …e non si e' allargata dove il motore tace: zero non si muove, e quel
    // pointer e' quello con cui nasce ogni clip dell'editor.
    assert("start: 0 senza loop né chiave: niente controllo, come niente avviso",
      shownFor({ timeMode: "normalized", pointer: { start: 0, speedRatio: 1, loopStart: null, loopDur: null } }) === false);
  }

  /* ── e il menu che crea quelle righe parla la stessa unità ────────────────
     Il selettore è metà della storia: l'altra è il menu «add parameter»,
     il punto più largo da cui loop_start/loop_end/loop_dur nascono (non
     l'unico: il blocco qui sotto conta le altre porte dello stesso 1).
     Le sue tre voci erano scritte per una sola unità — «(s)», «∈ [0, sample_dur]» — e il suo
     seme era un 1 nudo. Sotto l'ereditarietà quel seme non poteva sbagliare:
     `time_mode: normalized` rendeva la chiave normalized, dove 1 È la fine del
     file. Dopo #222 la stessa popolazione legge secondi e 1 è un secondo —
     oltre il cap su ogni sample più corto, cioè il menu che scrive un valore
     che una modifica digitata avrebbe clampato. È la stessa cura di #114 sul
     seme di duration_range, un livello più in là.
     Stessa tecnica del blocco sopra: si ESEGUONO le dichiarazioni estratte dal
     sorgente, invece di cercarci dentro una stringa. */
  {
    const seedNames = ["loopMax", "loopUnit", "loopNormalized", "loopSeedWhole",
                       "loopDomain", "loopEndDomain", "loopEndRange", "loopFileEnd"];
    const seedDecls = seedNames.map(declOf);
    assert("le dichiarazioni del seme e del dominio sono estraibili dal sorgente",
      seedDecls.every(d => d.length > 0),
      seedNames.filter((_, i) => !seedDecls[i].length).join(", "));
    const menuFor = (stream, sampleDur) => new Function("stream", "sampleDur", "window",
      seedDecls.join("\n")
      + "\nreturn { seed: loopSeedWhole, domain: loopDomain, endDomain: loopEndDomain,"
      + "         endRange: loopEndRange, fileEnd: loopFileEnd };")(stream, sampleDur, window);

    {
      // Clip nato nell'editor: `loop_unit: normalized` esplicito. «Tutto il
      // file» vale 1, come prima — qui il seme non doveva muoversi.
      const m = menuFor({ pointer: { loopUnit: "normalized" } }, 8);
      assert("normalized: il seme resta 1, la fine del file", m.seed === 1);
      assert("…e le tre frasi dichiarano il dominio normalizzato",
        m.domain === "∈ [0,1] × sample_dur" && m.endRange === "∈ [0, 1]" && m.fileEnd === "1");
    }
    {
      // La chiave assente, cioè ogni YAML che non la scrive e la popolazione
      // che #222 ha spostato: ora legge secondi, e «tutto il file» è sample_dur.
      const m = menuFor({ timeMode: "normalized", pointer: {} }, 8);
      assert("seconds: il seme è la durata del sample, non 1", m.seed === 8);
      assert("…e le frasi tornano a parlare di secondi",
        m.domain === "(s)" && m.endDomain === "(s) ∈ [0, sample_dur]" && m.fileEnd === "sample_dur");
    }
    {
      // Il caso in cui il seme fisso sbagliava davvero: un sample più corto di
      // un secondo. `loop_end: 1` lì indirizza oltre la fine del file.
      assert("sample più corto di 1 s: il seme non esce dal cap",
        menuFor({ pointer: {} }, 0.4).seed === 0.4);
      // Troncato, non arrotondato: su una durata che non sta in quattro
      // decimali l'arrotondamento supererebbe il cap che il seme insegue.
      const odd = menuFor({ pointer: {} }, 3.33335);
      assert("durata che non sta in quattro decimali: il seme resta sotto il cap",
        odd.seed === 3.3333 && odd.seed <= 3.33335);
    }
    {
      // Durata ignota (file:// / server giù / sample non trovato): loopEnvMax
      // non risponde, e resta l'unico numero disponibile — quello di prima.
      assert("durata del sample ignota: si ripiega su 1",
        menuFor({ pointer: {} }, undefined).seed === 1);
    }

    // …e il cablaggio, perché le dichiarazioni sopra servono solo se il menu le usa.
    assert("le tre voci prendono il dominio dall'unità, non da una stringa fissa",
      /desc: `loop window start \$\{loopDomain\}/.test(inspSrc)
      && /desc: `loop end \$\{loopEndDomain\}/.test(inspSrc)
      && /desc: `loop window length \$\{loopDomain\}/.test(inspSrc)
      && /loop_start\+loop_dur > \$\{loopFileEnd\}/.test(inspSrc)
      && !/desc: "loop window start \(s\)/.test(inspSrc)
      && !/desc: "loop end \(s\) ∈ \[0, sample_dur\]/.test(inspSrc));
    assert("i due semi del menu non sono più un 1 nudo",
      (inspSrc.match(/def: loopSeedWhole \}/g) || []).length === 2
      && !/loopDurEnv != null, def: 1 \}/.test(inspSrc)
      && !/loopEndEnv != null, def: 1 \}/.test(inspSrc));
    assert("la riga di hint del loop_end segue l'unità",
      /loop_end \{loopEndRange\}/.test(inspSrc)
      && !/loop_end ∈ \[0, sample_dur\] · per un loop/.test(inspSrc));
    // La terza porta dello stesso 1: il toggle loop_end ↔ loop_dur, quando
    // loop_start sta da solo e non c'è nessuna lunghezza da cui partire.
    // La catena del ripiego e' loopDur → loopDurEnv → loopSeedFrom →
    // loopSeedWhole: nessun anello e' un 1 nudo. I due estremi si guardano qui,
    // l'anello di mezzo lo misura il caso eseguito poco sotto.
    assert("anche il ripiego del toggle loop_end ↔ loop_dur è nell'unità in vigore",
      /: loopSeedFrom\(stream\.pointer\.loopDurEnv\)/.test(inspSrc)
      && /: loopSeedWhole;/.test(inspSrc)
      && !/stream\.pointer\.loopDur != null \? stream\.pointer\.loopDur : 1\)/.test(inspSrc));
    assert("…e passa dal cap, che quel ramo non applicava affatto",
      /const le = stream\.pointer\.loopEnd != null \? stream\.pointer\.loopEnd\s*\n\s*: clampLoop\("loopEnd",/.test(inspSrc));
  }

  /* ── le altre porte dello stesso 1: il menu non era l'unica ─────────────
     Il seme del menu ne chiude una. Le altre non passano da nessun menu: il
     toggle scalare↔env delle due righe — con `loop_start` da solo la riga
     loop_dur c'e' gia' e la chiave no, quindi quel ramo SEMINA — e il numero
     che la riga mostra mentre la chiave manca, che non e' solo scritto: e' il
     punto da cui parte il trascinamento del NumberField.
     E sullo stesso Seg vale la lezione di #149 un blocco piu' sotto: Seg
     chiama onChange anche sul bottone gia' acceso, e li' i due rami scrivono
     comunque lo scalare azzerando la curva — un envelope che sparisce per un
     click che non lo chiedeva.
     Stessa tecnica del blocco sopra: si ESEGUONO i rami estratti dal sorgente. */
  {
    const blockOf = (needle) => {
      const at = inspSrc.indexOf(needle);
      if (at < 0) return "";
      const open = inspSrc.indexOf("{", at + needle.length - 1);
      let d = 0;
      for (let j = open; j < inspSrc.length; j++) {
        if (inspSrc[j] === "{") d++;
        else if (inspSrc[j] === "}" && --d === 0) return inspSrc.slice(at, j + 1);
      }
      return "";
    };
    const seedFromDecl = declOf("loopSeedFrom");
    assert("i tre rami scalare↔env del loop sono estraibili dal sorgente",
      blockOf('if (k === "loopDur") {').length > 0
      && blockOf('if (k === "loopEnd") {').length > 0
      && blockOf('if (k === "loopStart") {').length > 0
      && seedFromDecl.length > 0);
    const modeFor = (key, newMode, pointer, seed) => {
      let out = null;
      new Function("k", "newMode", "stream", "onChange", "loopSeedWhole",
        seedFromDecl + "\n" + blockOf('if (k === "' + key + '") {'))(
        key, newMode, { pointer }, (p) => { out = p; }, seed);
      return out && out.pointer;
    };

    {
      // `loop_start` da solo: la chiave non c'e', e il ramo semina. Prima
      // seminava 1 — dopo #222 un secondo — su un sample di 8.
      assert("scalare→env con la chiave assente: semina tutto il file, non 1",
        eq(modeFor("loopDur", "env", { loopStart: 0 }, 8).loopDurEnv, [[0, 8], [1, 8]]));
      assert("…e lo stesso sul loop_end",
        eq(modeFor("loopEnd", "env", { loopStart: 0 }, 8).loopEndEnv, [[0, 8], [1, 8]]));
    }
    {
      // L'altro verso, su un envelope che parte da zero: con `|| 1` quello
      // zero — un loop_end legittimo — diventava un valore che la curva non
      // aveva mai avuto.
      const p = modeFor("loopEnd", "scalar", { loopEndEnv: [[0, 0], [1, 0.5]] }, 8);
      assert("env→scalare: la y del primo breakpoint si legge com'è, zero compreso",
        p.loopEnd === 0 && p.loopEndEnv === null);
      assert("env→scalare senza curva da leggere: resta il seme",
        modeFor("loopDur", "scalar", { loopStart: 0 }, 8).loopDur === 8);
    }
    {
      /* «Il primo breakpoint» non e' `env[0]`: la stessa lezione di
         wouldEmptyEnv nell'EnvelopeEditor, chi ha in mano una forma wrappata
         deve passare da unwrapEnv. E la forma wrappata qui non e' esotica —
         e' quella che l'editor SCRIVE da se' appena l'interp globale di una
         curva di soli BP non e' lineare (wrapEnv → {type, points}), quindi la
         si raggiunge senza scrivere una riga di YAML a mano. Letta con
         `env[0][1]`, una curva ferma su 6 tornava «tutto il file»: di nuovo la
         costante al posto della curva, cioe' il difetto che questo blocco
         esiste per chiudere. */
      assert("env→scalare su una curva wrappata {type, points}: la y si legge lo stesso",
        modeFor("loopEnd", "scalar", { loopEndEnv: { type: "cubic", points: [[0, 6], [1, 6]] } }, 8).loopEnd === 6);
      assert("…e sul dict con i soli points, che il motore accetta",
        modeFor("loopEnd", "scalar", { loopEndEnv: { points: [[0, 6], [1, 6]] } }, 8).loopEnd === 6);
      assert("…e su un BP group, che si desugara prima di leggere",
        modeFor("loopDur", "scalar", { loopDurEnv: [[[[0, 3], [1, 3]], "cubic"]] }, 8).loopDur === 3);
      /* La sola forma che una y davvero non ce l'ha ripiega — ed e' quel
         che il commento del sorgente dichiarava gia' mentre il codice faceva
         un'altra cosa: in un blocco compatto `env[0][1]` e' il RATIO della
         distribuzione, un numero che con una posizione nel sample non c'entra
         niente, e il `typeof … === "number"` lo lasciava passare. */
      assert("blocco compatto: ripiega sul seme, non scrive il ratio come lunghezza",
        modeFor("loopDur", "scalar", { loopDurEnv: [[[[0, 0.1], [0.5, 0.2]], 2, 4]] }, 8).loopDur === 8);
      /* Il dict `{t, v}` invece una y ce l'ha, ed e' `v`: il builder del
         motore lo normalizza in `[t, v]` prima di guardarlo
         (envelope_builder.py:132), e wouldEmptyEnv lo conta gia' come punto
         vero. Contarlo fra le forme «senza y» rimetteva su quella grafia
         esattamente la costante al posto della curva che questo blocco
         toglie. isBreakpoint da sola non lo vede e non va allargata (dice
         anche cosa il canvas sa trascinare): il predicato accanto e'
         isDictBreakpoint. */
      assert("breakpoint {t, v}: la y si legge, e' `v`",
        modeFor("loopEnd", "scalar", { loopEndEnv: [{ t: 0, v: 6 }] }, 8).loopEnd === 6);
      assert("…anche con l'interp per-punto, e anche uno zero resta zero",
        modeFor("loopEnd", "scalar", { loopEndEnv: [{ t: 0, v: 0, type: "step" }, { t: 1, v: 2 }] }, 8).loopEnd === 0);
      assert("…e un dict senza una y numerica non e' un punto: ripiega",
        modeFor("loopDur", "scalar", { loopDurEnv: [{ t: 0 }] }, 8).loopDur === 8);
    }
    {
      // La terza riga del loop legge dallo stesso posto, con il ripiego suo:
      // `loop_start` riparte da 0, come il suo seme nel menu.
      assert("loop_start: anche la sua curva wrappata si legge",
        modeFor("loopStart", "scalar", { loopStartEnv: { type: "cubic", points: [[0, 2], [1, 4]] } }, 8).loopStart === 2);
      assert("loop_start: il ratio di un blocco compatto non diventa una posizione",
        modeFor("loopStart", "scalar", { loopStartEnv: [[[[0, 0.1], [0.5, 0.2]], 2, 4]] }, 8).loopStart === 0);
      assert("loop_start: uno zero letto e' uno zero, non il ripiego",
        modeFor("loopStart", "scalar", { loopStartEnv: [[0, 0], [1, 0.5]] }, 8).loopStart === 0);
    }

    /* Il lettore non e' piu' scritto qui: la domanda «la y del primo
       breakpoint, qualunque grafia abbia» non ha niente di loop — se la fanno
       tutti i toggle env→scalare — e finche' la risposta stava in un solo
       handler le altre dodici tenevano la versione rotta. loopSeedFrom resta,
       ma come involucro che aggiunge il ripiego suo (loopSeedWhole); il corpo
       e' window.PGEEnv.firstBreakpointY, misurato in test-bp-groups.js. */
    assert("loopSeedFrom e' l'involucro del lettore del modulo, non una sua copia",
      /window\.PGEEnv\.firstBreakpointY\(env, fallback !== undefined \? fallback : loopSeedWhole\)/.test(seedFromDecl)
      && !/isBreakpoint\(bp\)/.test(inspSrc)
      && !/typeof env\[0\]\[1\] === "number"/.test(inspSrc));
    /* Il predicato del dict sta nel modulo e ha DUE lettori: wouldEmptyEnv, che
       conta i punti veri, e loopSeedFrom, che ne legge la y. Finche' ne aveva
       una copia locale per uno, le due regole erano libere di divergere — ed e'
       esattamente cosi' che il lettore del loop ha smesso di vedere una grafia
       che l'editor contava. isBreakpoint resta com'e': dice anche cosa il
       canvas sa trascinare, e un dict non lo disegna. */
    assert("isDictBreakpoint e' nel modulo e isBreakpoint non e' stata allargata",
      typeof window.PGEEnv.isDictBreakpoint === "function"
      && window.PGEEnv.isDictBreakpoint({ t: 0, v: 6 }) === true
      && window.PGEEnv.isDictBreakpoint({ t: 0 }) === false
      && window.PGEEnv.isBreakpoint({ t: 0, v: 6 }) === false);
    assert("anche loop_start legge dal lettore condiviso, non da una sua copia",
      /loopSeedFrom\(cur\.loopStartEnv, 0\)/.test(inspSrc)
      && !/cur\.loopStartEnv\[0\]\[1\]\) \|\| 0/.test(inspSrc));

    // …e il Seg che sceglie fra le due righe: il click che non chiede niente.
    const selDecls = ["loopEndMode", "loopEndSel"].map(declOf);
    assert("le dichiarazioni del bottone acceso sono estraibili dal sorgente",
      selDecls.every(d => d.length > 0));
    const selFor = (stream) => new Function("stream",
      selDecls.join("\n") + "\nreturn loopEndSel;")(stream);
    const segAt2 = inspSrc.indexOf("value={loopEndSel}");
    const onCh2 = inspSrc.indexOf("onChange={(u) => {", segAt2);
    let body2 = "";
    if (segAt2 >= 0 && onCh2 >= 0) {
      const open = inspSrc.indexOf("{", inspSrc.indexOf("=>", onCh2));
      let d = 0;
      for (let j = open; j < inspSrc.length; j++) {
        if (inspSrc[j] === "{") d++;
        else if (inspSrc[j] === "}" && --d === 0) { body2 = inspSrc.slice(open, j + 1); break; }
      }
    }
    assert("l'onChange del toggle loop_end ↔ loop_dur è estraibile dal sorgente", body2.length > 0);
    const toggleFor = (pointer, seed) => {
      const stream = { pointer };
      let out = null;
      const sel = selFor(stream);
      const fn = new Function("stream", "loopEndSel", "loopSeedWhole", "loopSeedFrom", "clampLoop", "onChange",
        "return (u) => " + body2)(
        stream, sel, seed,
        // Il vero loopSeedFrom, costruito dalla sua dichiarazione nel sorgente:
        // e' lo stesso che usa toggleMode qui sopra, e il Seg lo condivide
        // proprio perche' non ce ne siano due versioni.
        new Function("loopSeedWhole", seedFromDecl + "\nreturn loopSeedFrom;")(seed),
        // clampLoop dell'Inspector, ridotto al suo effetto: tappare al cap
        (k, v) => Math.min(seed, Math.max(0, v)),
        (p) => { out = p; });
      return { fn, sel, get: () => out };
    };

    {
      // Il caso di regressione: la curva in piedi e un click sul bottone che
      // e' gia' acceso. Prima il ramo scriveva lo scalare e azzerava l'envelope.
      const t = toggleFor({ loopStart: 0.2, loopEndEnv: [[0, 0.3], [1, 0.9]] }, 8);
      assert("in modalità envelope il bottone acceso è loop_end", t.sel === "loop_end");
      t.fn(t.sel);
      assert("click sul bottone già acceso: nessuna modifica, la curva resta", t.get() === null);
      const t2 = toggleFor({ loopStart: 0.2, loopDurEnv: [[0, 0.3], [1, 0.9]] }, 8);
      t2.fn(t2.sel);
      assert("…e lo stesso sull'altro bottone", t2.sel === "loop_dur" && t2.get() === null);
    }
    {
      // Il cambio vero, dalla forma che il menu sa scrivere: loop_start da
      // solo, nessuna lunghezza da cui partire. Il seme e poi il cap.
      const t = toggleFor({ loopStart: 3 }, 8);
      t.fn("loop_end");
      assert("loop_dur → loop_end con loop_start da solo: seme nell'unità, tappato al cap",
        t.get() !== null && t.get().pointer.loopEnd === 8);
    }

    {
      // Il cambio VERO da una curva. Le due chiavi sono mutuamente esclusive,
      // quindi l'envelope non sopravvive comunque — ma il numero che lo
      // sostituisce dev'essere quello che la curva diceva, non una costante.
      // Prima i due rami la ignoravano del tutto: `loop_endEnv` fermo su 6
      // diventava `loop_dur: 0.01` (il pavimento) e `loop_durEnv` su 3
      // diventava la fine del file. E' il `|| 1` di toggleMode, un livello
      // piu' in la', sullo stesso riquadro.
      const t = toggleFor({ loopStart: 0.2, loopEndEnv: [[0, 6], [1, 6]] }, 8);
      t.fn("loop_dur");
      assert("loop_end envelope → loop_dur: la lunghezza esce dalla curva, non dal pavimento",
        t.get() !== null && Math.abs(t.get().pointer.loopDur - 5.8) < 1e-9, JSON.stringify(t.get()));
      const t2 = toggleFor({ loopStart: 0.2, loopDurEnv: [[0, 3], [1, 3]] }, 8);
      t2.fn("loop_end");
      assert("loop_dur envelope → loop_end: la posizione esce dalla curva, non dal seme",
        t2.get() !== null && Math.abs(t2.get().pointer.loopEnd - 3.2) < 1e-9, JSON.stringify(t2.get()));
      // Il pavimento resta dov'era, per la differenza che non e' positiva.
      const t3 = toggleFor({ loopStart: 5, loopEndEnv: [[0, 1], [1, 2]] }, 8);
      t3.fn("loop_dur");
      assert("…e una differenza non positiva resta al pavimento",
        t3.get() !== null && t3.get().pointer.loopDur === 0.01, JSON.stringify(t3.get()));
      // E il cap vale anche di qua: una curva che dichiara piu' del file non
      // produce una lunghezza piu' lunga del file — lo stesso tetto che la
      // riga applica al numero digitato, e che questo ramo non aveva.
      const t4 = toggleFor({ loopStart: 0, loopEndEnv: [[0, 20], [1, 20]] }, 8);
      t4.fn("loop_dur");
      assert("loop_dur esce tappato al cap, come un valore digitato",
        t4.get() !== null && t4.get().pointer.loopDur === 8, JSON.stringify(t4.get()));
      /* E loop_start e' il terzo numero della conversione, non un contorno: la
         lunghezza e' la distanza DA li'. Letto con `|| 0` la sua curva non si
         vedeva affatto, quindi un loop_startEnv fermo su 3 con loop_end a 6
         dava 6 invece di 3 — la finestra raddoppiata da un click. */
      const t5 = toggleFor({ loopStartEnv: [[0, 3], [1, 3]], loopEndEnv: [[0, 6], [1, 6]] }, 8);
      t5.fn("loop_dur");
      assert("anche loop_start esce dalla curva quando lo scalare non c'e'",
        t5.get() !== null && Math.abs(t5.get().pointer.loopDur - 3) < 1e-9, JSON.stringify(t5.get()));
      const t6 = toggleFor({ loopStartEnv: [[0, 3], [1, 3]], loopDurEnv: [[0, 2], [1, 2]] }, 8);
      t6.fn("loop_end");
      assert("…e nell'altro verso la posizione parte da li'",
        t6.get() !== null && Math.abs(t6.get().pointer.loopEnd - 5) < 1e-9, JSON.stringify(t6.get()));
    }

    assert("i due rami del Seg leggono la curva invece di ignorarla",
      /loopSeedFrom\(stream\.pointer\.loopDurEnv\)/.test(inspSrc)
      && /loopSeedFrom\(stream\.pointer\.loopEndEnv\)/.test(inspSrc)
      && !/Math\.max\(0\.01, \(stream\.pointer\.loopEnd \|\| 0\)/.test(inspSrc));
    assert("…e il terzo numero della conversione, loop_start, dallo stesso lettore",
      /loopSeedFrom\(stream\.pointer\.loopStartEnv, 0\)/.test(inspSrc)
      && !/const ls = stream\.pointer\.loopStart \|\| 0;/.test(inspSrc));
    assert("loopSeedFrom e' dichiarato una volta sola, nel corpo del componente",
      (inspSrc.match(/const loopSeedFrom = /g) || []).length === 1);
    assert("anche la riga che segue il Seg chiede a loopEndMode, non a una terza copia",
      /\{loopEndMode \? \(/.test(inspSrc)
      && !/\{\(stream\.pointer\.loopEnd != null \|\| stream\.pointer\.loopEndEnv != null\) \? \(/.test(inspSrc));
    assert("il bottone acceso e il ritorno anticipato leggono la stessa cosa",
      /value=\{loopEndSel\}/.test(inspSrc)
      && /if \(u === loopEndSel\) return;/.test(inspSrc)
      && !/value=\{\(stream\.pointer\.loopEnd != null \|\| stream\.pointer\.loopEndEnv != null\) \? "loop_end"/.test(inspSrc));
    assert("i semi dello scalare↔env non sono più un 1 nudo",
      /cur\.loopDur != null \? cur\.loopDur : loopSeedWhole/.test(inspSrc)
      && /cur\.loopEnd != null \? cur\.loopEnd : loopSeedWhole/.test(inspSrc)
      && !/cur\.loopDurEnv\[0\]\[1\]\) \|\| 1/.test(inspSrc)
      && !/cur\.loopEndEnv\[0\]\[1\]\) \|\| 1/.test(inspSrc));
    assert("e il numero mostrato quando la chiave manca è il seme, su entrambe le righe",
      (inspSrc.match(/Env \? "—" : loopSeedWhole\)\}/g) || []).length === 2
      && !/loopEndEnv \? "—" : 1\)\}/.test(inspSrc)
      && !/loopDurEnv \? "—" : 1\)\}/.test(inspSrc));
  }
}

/* ============================================================================
 * Il Seg scalare↔env: il click che non chiede niente, e la curva sostituita
 *
 * `Seg` chiama onChange anche sul bottone GIA' ACCESO (primitives.jsx). Il Seg
 * di loop_unit l'ha imparato con #149, quello loop_end ↔ loop_dur poco fa —
 * ma il terzo, quello scalare↔env di ogni ParamRow, passa da toggleMode, e li'
 * il ramo `env` non guarda l'envelope: legge lo SCALARE, che in modalita' env
 * e' null, e semina una rampa costante sul default. Cioe' la curva dell'utente
 * sostituita da una riga piatta, su QUALUNQUE parametro, per un click che non
 * l'aveva chiesta.
 * E il verso opposto — env→scalare — leggeva `env[0][1] || default`, che e' la
 * domanda a cui firstBreakpointY risponde: qui si misura che i dodici rami la
 * facciano a lui e non ognuno per conto suo.
 * Stessa tecnica del blocco sopra: si ESEGUE toggleMode estratto dal sorgente,
 * con il getMode vero accanto — la condizione del no-op dev'essere la stessa
 * che accende il bottone, e ricostruirla nel test sarebbe la seconda copia che
 * il ritorno anticipato esiste per non avere.
 * ========================================================================== */
console.log("\n── cablaggio scalare↔env: il no-op e il lettore condiviso ──");
{
  const inspSrc = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));
  const declOf = (name) =>
    (new RegExp("const " + name + " = [\\s\\S]*?;").exec(inspSrc) || [""])[0];
  // Brace matching: getMode e toggleMode hanno corpi pieni di `;`, quindi la
  // regex di declOf non basta — si conta la profondita' come fa depthAt in
  // source-guard.js.
  const fnOf = (needle) => {
    const at = inspSrc.indexOf(needle);
    if (at < 0) return "";
    const open = inspSrc.indexOf("{", at + needle.length - 1);
    let d = 0;
    for (let j = open; j < inspSrc.length; j++) {
      if (inspSrc[j] === "{") d++;
      else if (inspSrc[j] === "}" && --d === 0) return inspSrc.slice(at, j + 1) + ";";
    }
    return "";
  };
  const getModeSrc  = fnOf("const getMode = (k, fallback) => {");
  const toggleSrc   = fnOf("function toggleMode(k, newMode) {");
  const setModeSrc  = declOf("setMode");
  assert("getMode, setMode e toggleMode sono estraibili dal sorgente",
    getModeSrc.length > 0 && toggleSrc.length > 0 && setModeSrc.length > 0);

  /* Il vero toggleMode, con il vero getMode accanto: quel che arriva a
     onChange e' quel che l'Inspector scriverebbe. `paramModes` parte vuoto —
     e' lo stato di una sessione appena aperta, dove la modalita' la dice lo
     stream — e loopSeedFrom e' costruito dalla sua dichiarazione vera. */
  const runToggle = (k, newMode, stream, seed) => {
    let out = null, modeWritten = null;
    const seedWhole = seed === undefined ? 8 : seed;
    new Function("paramModes", "setParamModes", "stream", "onChange", "window",
                 "loopSeedWhole", "loopSeedFrom", "k", "newMode",
      setModeSrc + "\n" + getModeSrc + "\n" + toggleSrc + "\ntoggleMode(k, newMode);")(
      {}, (m) => { modeWritten = m[k]; }, stream, (p) => { out = p; }, window, seedWhole,
      new Function("loopSeedWhole", declOf("loopSeedFrom") + "\nreturn loopSeedFrom;")(seedWhole),
      k, newMode);
    return { out, modeWritten };
  };

  {
    /* La regressione, su un parametro qualunque: la curva in piedi e un click
       sul bottone `env` che e' gia' acceso. Prima il ramo seminava
       [[0,0],[1,0]] — il default di pan — sopra i breakpoint dell'utente. */
    const r = runToggle("pan", "env", { pan: null, panEnv: [[0, 0.3], [1, 0.9]] });
    assert("click sul bottone env già acceso: nessuna modifica, la curva resta",
      r.out === null && r.modeWritten === null, JSON.stringify(r.out));
    /* …e non e' un caso di pan: i rami sono dodici, e tutti seminano allo
       stesso modo. Uno per famiglia — stream, grain, pointer, pitch, voices. */
    const victims = [
      ["density",       { density: null, densityEnv: [[0, 3], [1, 9]] }],
      ["grainDur",      { grain: { duration: null, durationEnv: [[0, 0.02], [1, 0.2]] } }],
      ["speedRatio",    { pointer: { speedRatio: null, speedRatioEnv: [[0, 0.5], [1, 2]] } }],
      ["pitch",         { pitch: { value: null, valueEnv: [[0, -12], [1, 12]] } }],
      ["voicesNum",     { voices: { num: null, numEnv: [[0, 2], [1, 6]] } }],
      ["loopEnd",       { pointer: { loopEnd: null, loopEndEnv: [[0, 1], [1, 6]] } }],
      ["durationRange", { grain: { durationRange: null, durationRangeEnv: [[0, 0.01], [1, 0.05]] } }],
      ["offsetRange",   { pointer: { offsetRange: null, offsetRangeEnv: [[0, 0.1], [1, 0.4]] } }],
      ["panRange",      { panRange: null, panRangeEnv: [[0, 10], [1, 90]] }],
    ];
    const survived = victims.filter(([k, st]) => runToggle(k, "env", st).out === null);
    assert("e lo stesso su ognuna delle famiglie di parametri",
      survived.length === victims.length,
      victims.filter(([k]) => !survived.some(([s]) => s === k)).map(([k]) => k).join(", "));
    /* Dal lato scalare il click era gia' a vuoto: nessuna curva da perdere, ma
       uno scalare riscritto uguale e' comunque un passo di undo e uno stem
       marcato sporco per niente. */
    const sc = runToggle("pan", "scalar", { pan: 0.5, panEnv: null });
    assert("…e sul bottone scalar già acceso non si riscrive lo scalare",
      sc.out === null && sc.modeWritten === null, JSON.stringify(sc.out));
  }
  {
    // Il click che chiede davvero continua a passare, nei due versi.
    const toEnv = runToggle("pan", "env", { pan: 0.5, panEnv: null });
    assert("scalare→env vero: semina la rampa costante sullo scalare",
      toEnv.out !== null && eq(toEnv.out.panEnv, [[0, 0.5], [1, 0.5]]) && toEnv.modeWritten === "env",
      JSON.stringify(toEnv.out));
    const toSc = runToggle("pan", "scalar", { pan: null, panEnv: [[0, 0.3], [1, 0.9]] });
    assert("env→scalare vero: la y del primo breakpoint",
      toSc.out !== null && toSc.out.pan === 0.3 && toSc.out.panEnv === null,
      JSON.stringify(toSc.out));
  }
  {
    /* L'altro verso del difetto: `env[0][1] || default`. Le tre grafie su cui
       sbagliava, misurate sui rami veri — e la prima l'editor la scrive da se',
       appena l'interp globale di una curva di soli BP non e' lineare. */
    const wrapped = runToggle("pan", "scalar", { pan: null, panEnv: { type: "cubic", points: [[0, 0.3], [1, 0.9]] } });
    assert("env→scalare su una curva wrappata {type, points}: la y si legge lo stesso",
      wrapped.out !== null && wrapped.out.pan === 0.3, JSON.stringify(wrapped.out));
    /* Un BP group come primo item: `env[0][1]` e' la STRINGA dell'interp, e
       `|| default` la lasciava passare — `pan: "cubic"` scritto nello YAML. */
    const group = runToggle("pan", "scalar", { pan: null, panEnv: [[[[0, 0.3], [1, 0.9]], "cubic"]] });
    assert("…e un BP group non scrive il nome dell'interp come valore",
      group.out !== null && group.out.pan === 0.3, JSON.stringify(group.out));
    /* Un blocco compatto e' la sola grafia senza y: li' `[1]` e' il ratio
       della distribuzione, e il ripiego e' la risposta giusta. */
    const block = runToggle("pan", "scalar", { pan: null, panEnv: [[[[0, 0.1], [0.5, 0.2]], 2, 4]] });
    assert("…e un blocco compatto ripiega sul default, non scrive il ratio",
      block.out !== null && block.out.pan === 0, JSON.stringify(block.out));
    /* E uno zero letto e' uno zero: con `|| default` un pan al centro, una
       probabilita' «mai», un loop_end a inizio file diventavano la costante. */
    const zero = runToggle("speedRatio", "scalar", { pointer: { speedRatio: null, speedRatioEnv: [[0, 0], [1, 2]] } });
    assert("…e uno zero letto non diventa il default",
      zero.out !== null && zero.out.pointer.speedRatio === 0, JSON.stringify(zero.out));
    // Il ripiego resta quello del parametro, non uno solo per tutti.
    const fb = runToggle("voicesNum", "scalar", { voices: { num: null, numEnv: [] } });
    assert("il ripiego è ancora il default del parametro",
      fb.out !== null && fb.out.voices.num === 1, JSON.stringify(fb.out));
    /* read_direction ha il suo ramo — la y si snappa al segno, perche' il
       dominio e' l'insieme {-1, +1} e uno 0 e' un errore di parse. */
    const rd = runToggle("readDirection", "scalar", { grain: { readDirection: null, readDirectionEnv: { type: "step", points: [[0, -0.4], [1, 1]] } } });
    assert("read_direction: la y wrappata si legge e si snappa al segno",
      rd.out !== null && rd.out.grain.readDirection === -1, JSON.stringify(rd.out));
  }

  // …e il cablaggio, perché i rami sopra valgono solo se sono quelli veri.
  assert("il ritorno anticipato legge la stessa domanda che accende il bottone",
    /if \(newMode === getMode\(k\)\) return;/.test(inspSrc)
    && (inspSrc.match(/mode=\{getMode\("(\w+)"\)\} onMode=\{\(m\) => toggleMode\("\1", m\)\}/g) || []).length === 16);
  assert("nessun ramo legge più la curva con env[0][1]",
    !/Env && \w+\.\w+Env\[0\] && /.test(inspSrc)
    && !/stream\[f\.ek\] && stream\[f\.ek\]\[0\]/.test(inspSrc)
    && !/\(items && items\[0\] && items\[0\]\[1\]\)/.test(inspSrc));
  /* Dodici rami piu' loopSeedFrom, che e' l'involucro con il ripiego del loop:
     tredici letture, nessuna scritta a mano. */
  assert("i dodici rami di toggleMode chiedono al lettore del modulo",
    (inspSrc.match(/window\.PGEEnv\.firstBreakpointY\(/g) || []).length === 13);
  /* I due Seg di deviation_probability sono il terzo e il quarto con lo stesso
     difetto, e non passano da toggleMode: la guardia e' loro, e la copertura
     sta in test-deviation-probability.js. Qui si guarda solo che ci sia. */
  assert("anche i due Seg di deviation_probability hanno il loro no-op",
    /if \(m === dMode\) return;/.test(inspSrc)
    && /if \(m === pMode\) return;/.test(inspSrc)
    && /const dMode = dIsEnv \? "env" : "scalar";/.test(inspSrc)
    && /const pMode = isEnv \? "env" : "scalar";/.test(inspSrc));
}

/* ============================================================================
 * Le porte dello stesso click che non stavano nell'Inspector
 *
 * Il blocco sopra chiude il no-op e il lettore per le sedici ParamRow
 * dell'Inspector e per i due Seg di deviation_probability. Ma le righe
 * scalare↔env dell'editor non sono sedici: quattordici stanno in
 * VoicesSection.jsx — num_voices, scatter e le dodici delle strategie — e
 * hanno la stessa coppia di difetti, intatta. I due rami `voicesNum` e
 * `scatter` di toggleMode non le coprono: nessuna ParamRow li chiama (il
 * blocco sopra conta sedici chiamate, e quelle due chiavi non sono fra loro),
 * quindi la riga viva e' quella di VoicesSection.
 * Da cui le due meta' di questo blocco:
 *   · la guardia sul no-op sta in ParamRow (primitives.jsx), l'unico posto
 *     dove la condizione E' il `value` del Seg per costruzione e per ogni riga
 *     dell'editor — riscriverla in ognuno dei quattordici chiamanti sarebbe la
 *     copia che, per la ragione che loopEndSel dichiara, smette di valere;
 *   · il lettore e' quello del modulo, firstBreakpointY, come nei dodici rami
 *     di toggleMode.
 * E il terzo Seg della famiglia, density ↔ fill_factor: coppia mutuamente
 * esclusiva come loop_end ↔ loop_dur, e li' il click sul bottone acceso
 * costava di piu' che altrove — i due rami scrivono la costante e azzerano
 * l'envelope.
 * Stessa tecnica dei blocchi sopra: si ESEGUONO le dichiarazioni e i rami
 * estratti dal sorgente.
 * ========================================================================== */
console.log("\n── cablaggio scalare↔env: Voices e density ↔ fill_factor ──");
{
  const primSrc = SG.codeOf(path.join(__dirname, "../../src/components/primitives.jsx"));
  const vsSrc   = SG.codeOf(path.join(__dirname, "../../src/components/VoicesSection.jsx"));
  const inspSrc = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));
  // Brace matching: i corpi hanno `;` dentro, quindi una regex fino al primo
  // punto e virgola non basta — si conta la profondita' come fa depthAt in
  // source-guard.js.
  const blockIn = (src, needle, tail) => {
    const at = src.indexOf(needle);
    if (at < 0) return "";
    const open = src.indexOf("{", at + needle.length - 1);
    let d = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") d++;
      else if (src[j] === "}" && --d === 0) return src.slice(at, j + 1) + (tail || "");
    }
    return "";
  };
  const lineIn = (src, name) =>
    (new RegExp("const " + name + " = .*").exec(src) || [""])[0];

  /* ── la guardia, dove la condizione e' il `value` del Seg ──────────────── */
  const handleModeSrc = blockIn(primSrc, "const handleMode = (m) => {", ";");
  assert("handleMode di ParamRow è estraibile dal sorgente", handleModeSrc.length > 0);
  // Sentinella: `undefined` sarebbe indistinguibile da un onMode chiamato con
  // un valore assente, e qui la domanda e' proprio se sia stato chiamato.
  const NIENTE = Symbol("mai chiamato");
  const clickMode = (mode, m) => {
    let got = NIENTE;
    new Function("mode", "onMode", "m", handleModeSrc + "\nhandleMode(m);")(
      mode, (x) => { got = x; }, m);
    return got;
  };
  assert("click sul bottone già acceso: onMode non viene nemmeno chiamato",
    clickMode("env", "env") === NIENTE && clickMode("scalar", "scalar") === NIENTE);
  assert("…e il click che chiede davvero passa, nei due versi",
    clickMode("env", "scalar") === "scalar" && clickMode("scalar", "env") === "env");
  assert("la condizione della guardia è il `value` del Seg, non una sua copia",
    /value=\{mode\} onChange=\{handleMode\}/.test(primSrc)
    && /if \(m === mode\) return;/.test(handleModeSrc));

  /* ── le quattordici righe di Voices: il lettore ────────────────────────── */
  const numSrc     = blockIn(vsSrc, "function toggleNumMode(newMode) {");
  const scatterSrc = blockIn(vsSrc, "function toggleScatterMode(newMode) {");
  const stratSrc   = blockIn(vsSrc,
    "function toggleStratParam(v, dim, paramKey, defaultVal, newMode, onChange) {");
  assert("i tre toggle di VoicesSection sono estraibili dal sorgente",
    numSrc.length > 0 && scatterSrc.length > 0 && stratSrc.length > 0);

  const runVoice = (which, voices, newMode) => {
    let patch = null;
    new Function("v", "update", "window", "newMode",
      (which === "num" ? numSrc : scatterSrc)
      + "\ntoggle" + (which === "num" ? "Num" : "Scatter") + "Mode(newMode);")(
      voices, (p) => { patch = p; }, window, newMode);
    return patch;
  };
  const runStrat = (voices, dim, key, def, newMode) => {
    let out = null;
    new Function("window", "v", "dim", "paramKey", "defaultVal", "newMode", "onChange",
      stratSrc + "\ntoggleStratParam(v, dim, paramKey, defaultVal, newMode, onChange);")(
      window, voices, dim, key, def, newMode, (p) => { out = p; });
    return out && out.voices[dim];
  };

  {
    /* Le stesse grafie del blocco sopra, sulle righe che quel blocco non
       tocca. La wrappata l'editor la scrive da se' (wrapEnv, appena l'interp
       globale di una curva di soli BP non e' lineare), quindi non serve
       scrivere YAML a mano per arrivarci. */
    assert("num_voices: la y di una curva wrappata {type, points} si legge",
      runVoice("num", { num: null, numEnv: { type: "cubic", points: [[0, 4], [1, 9]] } }, "scalar").num === 4);
    assert("…e quella di un BP group, che si desugara prima di leggere",
      runVoice("num", { num: null, numEnv: [[[[0, 4], [1, 9]], "cubic"]] }, "scalar").num === 4);
    /* Il blocco compatto e' la sola grafia senza y, e le sue due scritture
       sbagliavano ognuna a modo suo: dentro un array `env[0][1]` e' il TEMPO
       FINALE del blocco (2), nella forma diretta — `param: [pattern, end,
       n_reps]`, che il motore accetta — e' il secondo PUNTO del pattern, cioe'
       un array scritto come valore del parametro. Nessuno dei due e' un numero
       di voci, e il `|| 1` li lasciava passare entrambi perche' sono truthy. */
    const blk = runVoice("num", { num: null, numEnv: [[[[0, 0.1], [0.5, 0.2]], 2, 4]] }, "scalar");
    assert("…e un blocco compatto ripiega sul default, non scrive il tempo finale",
      blk.num === 1, JSON.stringify(blk.num));
    const bare = runVoice("num", { num: null, numEnv: [[[0, 0.1], [0.5, 0.2]], 2, 4] }, "scalar");
    assert("…e nella forma diretta non scrive un array come numero di voci",
      bare.num === 1, JSON.stringify(bare.num));
    assert("scatter: stessa lettura, e il blocco compatto ripiega sul suo default",
      runVoice("scatter", { scatter: null, scatterEnv: [[[[0, 0.1], [0.5, 0.2]], 2, 4]] }, "scalar").scatter === 0);
    assert("scatter: e uno zero letto resta zero — «nessuno sparpaglio»",
      runVoice("scatter", { scatter: null, scatterEnv: [[0, 0], [1, 0.5]] }, "scalar").scatter === 0);
    assert("scatter: il dict {t, v} è un punto, e la sua y è `v`",
      runVoice("scatter", { scatter: null, scatterEnv: [{ t: 0, v: 0.25 }] }, "scalar").scatter === 0.25);
    // Il click vero nell'altro verso continua a seminare sullo scalare.
    assert("num_voices: scalare→env semina la rampa costante sullo scalare",
      eq(runVoice("num", { num: 3 }, "env").numEnv, [[0, 3], [1, 3]]));
  }
  {
    /* Le dodici righe delle strategie passano tutte da toggleStratParam: una
       copia sola del lettore, quindi un difetto solo — e dodici righe che lo
       portavano. Su un BP group `arr[0][1]` e' la STRINGA dell'interp, e il
       `!= null` la lasciava passare: `step: "cubic"` scritto nello YAML. */
    const grp = runStrat({ pitch: { stepEnv: [[[[0, 5], [1, 9]], "cubic"]] } },
      "pitch", "step", 3.0, "scalar");
    assert("strategie: un BP group non scrive il nome dell'interp come valore",
      grp.step === 5, JSON.stringify(grp.step));
    assert("…e una curva wrappata non ripiega sul default",
      runStrat({ pointer: { stepEnv: { type: "cubic", points: [[0, 0.4], [1, 0.9]] } } },
        "pointer", "step", 0.1, "scalar").step === 0.4);
    assert("…e un blocco compatto ripiega sul default della riga",
      runStrat({ pan: { spreadEnv: [[[[0, 10], [0.5, 20]], 2, 4]] } },
        "pan", "spread", 60.0, "scalar").spread === 60.0);
    assert("…e uno zero letto resta zero",
      runStrat({ onset_offset: { stepEnv: [[0, 0], [1, 0.2]] } },
        "onset_offset", "step", 0.05, "scalar").step === 0);
  }
  {
    /* E il no-op sulle righe vere, composto come in interfaccia: il `mode` che
       accende il bottone viene dalla dichiarazione del componente, la guardia
       da ParamRow. Prima il ramo `env` leggeva lo scalare — in quella
       modalita' null — e seminava una rampa costante sul default: la curva
       dell'utente sostituita da una riga piatta su 1 (num_voices), 0
       (scatter), il default della riga (strategie). */
    const clickRow = (which, voices) => {
      let patch = null;
      const mSrc = lineIn(vsSrc, which === "num" ? "numMode" : "scatterMode");
      new Function("v", "update", "window", "m",
        mSrc + "\n" + (which === "num" ? numSrc : scatterSrc)
        + "\nconst mode = " + (which === "num" ? "numMode" : "scatterMode") + ";"
        + "\nconst onMode = toggle" + (which === "num" ? "Num" : "Scatter") + "Mode;\n"
        + handleModeSrc + "\nhandleMode(m);")(
        voices, (p) => { patch = p; }, window, which === "num" ? "env" : "env");
      return patch;
    };
    assert("num_voices: click sul bottone env già acceso, la curva resta",
      clickRow("num", { num: null, numEnv: [[0, 2], [1, 6]] }) === null);
    assert("scatter: idem",
      clickRow("scatter", { scatter: null, scatterEnv: [[0, 10], [1, 40]] }) === null);

    // …e le dodici righe delle strategie, dove il `mode` lo dichiara
    // VoiceStratParamRow.
    const clickStrat = (voices, dim, key, def, m) => {
      let out = null;
      new Function("window", "v", "dim", "paramKey", "defaultVal", "onChange", "valueEnv", "m",
        stratSrc + "\n" + lineIn(vsSrc, "mode")
        + "\nconst onMode = (mm) => toggleStratParam(v, dim, paramKey, defaultVal, mm, onChange);\n"
        + handleModeSrc + "\nhandleMode(m);")(
        window, voices, dim, key, def, (p) => { out = p; },
        (voices[dim] || {})[key + "Env"], m);
      return out;
    };
    assert("strategie: click sul bottone env già acceso, la curva resta",
      clickStrat({ pitch: { stepEnv: [[0, 3], [1, 7]] } }, "pitch", "step", 3.0, "env") === null);
    assert("strategie: e il click che chiede davvero passa",
      clickStrat({ pitch: { step: 3 } }, "pitch", "step", 3.0, "env") !== null);
  }

  // …e il cablaggio, perché i rami sopra valgono solo se sono quelli veri.
  assert("nessuna riga di Voices legge più la curva con env[0][1]",
    !/\(arr && arr\[0\] && arr\[0\]\[1\]\)/.test(vsSrc)
    && !/\w+Env && v\.\w+Env\[0\]/.test(vsSrc));
  assert("i tre toggle di Voices chiedono al lettore del modulo",
    (vsSrc.match(/window\.PGEEnv\.firstBreakpointY\(/g) || []).length === 3);
  /* VoicesSection non costruisce nessun Seg scalare↔env per conto suo: le sue
     quattordici righe passano dal ParamRow, che e' dove sta la guardia. Il
     giorno in cui una di esse si scrivesse il Seg in casa, la guardia
     smetterebbe di coprirla in silenzio. */
  assert("le righe di Voices passano tutte dal ParamRow guardato",
    !/<Seg/.test(vsSrc) && /onMode=\{onMode\}/.test(vsSrc));

  /* ── density ↔ fill_factor: la terza coppia mutuamente esclusiva ───────── */
  const densDecl = lineIn(inspSrc, "densityUnitSel");
  assert("la dichiarazione del bottone acceso di density ↔ fill_factor è estraibile",
    densDecl.length > 0 || /const densityUnitSel = /.test(inspSrc));
  // La dichiarazione sta su due righe: si prende fino al `;`.
  const densSrc = (/const densityUnitSel = [\s\S]*?;/.exec(inspSrc) || [""])[0];
  const densBody = (() => {
    const at = inspSrc.indexOf("value={densityUnitSel}");
    if (at < 0) return "";
    const on = inspSrc.indexOf("onChange={(u) => {", at);
    if (on < 0) return "";
    const open = inspSrc.indexOf("{", inspSrc.indexOf("=>", on));
    let d = 0;
    for (let j = open; j < inspSrc.length; j++) {
      if (inspSrc[j] === "{") d++;
      else if (inspSrc[j] === "}" && --d === 0) return inspSrc.slice(open, j + 1);
    }
    return "";
  })();
  assert("il Seg density ↔ fill_factor e il suo onChange sono estraibili dal sorgente",
    densSrc.length > 0 && densBody.length > 0);
  const clickDensity = (stream, u) => {
    let out = null;
    new Function("stream", "onChange", "u",
      densSrc + "\n(" + "(u) => " + densBody + ")(u);")(
      stream, (p) => { out = p; }, u);
    return out;
  };
  {
    /* Il caso di regressione: i due rami scrivono la costante e azzerano
       l'envelope, quindi il bottone gia' acceso riportava un fill_factor
       scelto dall'utente a 2.0 e sostituiva una curva di density con un 8. */
    assert("fill_factor acceso, click su fill_factor: il valore dell'utente resta",
      clickDensity({ fillFactor: 3.7 }, "fill_factor") === null);
    assert("…e una curva di fill_factor non sparisce sotto la costante",
      clickDensity({ fillFactor: null, fillFactorEnv: [[0, 1], [1, 4]] }, "fill_factor") === null);
    assert("density accesa, click su density: la curva resta",
      clickDensity({ density: null, densityEnv: [[0, 3], [1, 9]] }, "density") === null);
    assert("…e lo scalare non viene riscritto sul default",
      clickDensity({ density: 20 }, "density") === null);
  }
  {
    // Il click che chiede davvero continua a convertire, nei due versi: le due
    // costanti restano perche' density e fill_factor sono grandezze diverse.
    const toFill = clickDensity({ density: 20 }, "fill_factor");
    assert("density → fill_factor: converte, e spegne l'altra chiave",
      toFill !== null && toFill.fillFactor === 2.0 && toFill.density === null
      && toFill.densityEnv === null && toFill.fillFactorEnv === null, JSON.stringify(toFill));
    const toDens = clickDensity({ fillFactor: 3.7 }, "density");
    assert("fill_factor → density: idem nell'altro verso",
      toDens !== null && toDens.density === 8 && toDens.fillFactor === null
      && toDens.fillFactorEnv === null && toDens.densityEnv === null, JSON.stringify(toDens));
  }
  assert("il bottone acceso e il ritorno anticipato leggono la stessa cosa",
    /value=\{densityUnitSel\}/.test(inspSrc)
    && /if \(u === densityUnitSel\) return;/.test(inspSrc)
    && (inspSrc.match(/const densityUnitSel = /g) || []).length === 1
    && !/value=\{\(stream\.fillFactor != null \|\| stream\.fillFactorEnv != null\) \? "fill_factor"/.test(inspSrc));
}

console.log("\n── cablaggio unità/precisione dell'EnvelopeEditor (issue #126) ──");
{
  const eeSrc = SG.codeOf(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"));
  const inspSrc = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));

  assert("le curve del loop non hardcodano più il suffisso in secondi",
    /const loopUnitSuffix = window\.PGEEnvUtils\.loopUnitSuffix\(stream\.pointer\)/.test(eeSrc)
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

  /* Le grafie che prima di PGE #234 il motore NON scalava, e ora sì.
   * `is_envelope_like` era più stretta del costruttore: una lista di soli
   * breakpoint dict, o di sole 3-tuple, tornava indietro invariata e il motore
   * la leggeva in secondi qualunque unità fosse dichiarata. La UI aveva una
   * porta che ricalcava l'asimmetria; ora non serve più e queste grafie si
   * convertono come tutte le altre. Verificato eseguendo il motore corretto su
   * venti forme: UI e `scale_raw_param_values` coincidono su tutte. */
  const dictOnly = C({ durationEnv: [{ t: 0, v: 0.001 }, { t: 1, v: 0.1 }] }, "milliseconds");
  assert("lista di soli breakpoint dict: convertita (PGE #234)",
    eq(dictOnly.durationEnv, [{ t: 0, v: 1 }, { t: 1, v: 100 }]),
    JSON.stringify(dictOnly.durationEnv));
  const tuple3Only = C({ durationEnv: [[0, 0.001, "cubic"], [1, 0.1, "linear"]] }, "milliseconds");
  assert("lista di sole 3-tuple: convertita, interp conservato",
    eq(tuple3Only.durationEnv, [[0, 1, "cubic"], [1, 100, "linear"]]),
    JSON.stringify(tuple3Only.durationEnv));
  const singleDict = C({ durationEnv: [{ t: 0, v: 0.001 }] }, "milliseconds");
  assert("un solo breakpoint dict: convertito",
    eq(singleDict.durationEnv, [{ t: 0, v: 1 }]), JSON.stringify(singleDict.durationEnv));
  assert("lista vuota: niente da convertire, e niente si rompe",
    eq(C({ durationEnv: [] }, "milliseconds").durationEnv, []));
  // Il pattern del compatto conserva l'interp per-punto — da PGE #234 lo fa
  // anche il motore, quindi non è più una divergenza voluta ma una parità.
  const compattoInterp = C({ durationEnv: [[[0, 0.001, "cubic"], [50, 0.1]], 1, 4] }, "milliseconds");
  assert("il pattern del compatto conserva l'interp per-punto",
    eq(compattoInterp.durationEnv, [[[0, 1, "cubic"], [50, 100]], 1, 4]),
    JSON.stringify(compattoInterp.durationEnv));
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
  const inspSrc = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));

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
  // Il footer è la frase che l'utente legge senza aprire un tooltip: scritta a
  // mano, sarebbe l'unica sbagliata il giorno in cui il motore muove la costante.
  assert("nemmeno il footer scrive il sample rate a mano", (() => {
    const appSrc = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
    return /sr \$\{window\.PGE_OUTPUT_SR\} · stereo/.test(appSrc) && !/sr 48000/.test(appSrc);
  })());
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
  // La scala di step è in unità del parametro: quella di default è scritta per
  // i secondi e in campioni (valore tipico 2400) il gradino più grosso vale 10.
  assert("le manopole di durata hanno step nell'unità in vigore",
    /const grainSteps = GRAIN_STEPS\[grainUnit\] \|\| GRAIN_STEPS\.seconds/.test(inspSrc)
    && (inspSrc.match(/steps=\{grainSteps\}/g) || []).length === 2
    && /samples: \[1, 100, 1000, 10000\]/.test(inspSrc));
  assert("il tooltip della chiave elenca le tre unità",
    /title=\{`unità di grain\.duration e duration_range[^`]*milliseconds/.test(inspSrc));
}

console.log("\n── cablaggio unità di grain.duration nell'EnvelopeEditor (issue #114) ──");
{
  const eeSrc = SG.codeOf(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"));
  const inspSrc = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));

  // I bound statici di grain_duration sono in secondi (max 10); i valori di un
  // envelope sono nell'unità dichiarata. Presi come sono, un envelope in
  // millisecondi finisce tappato a 10 ms invece che a 10 s — e clampY riscrive
  // il punto al primo drag, che è perdita di dati, non solo una vista storta.
  assert("i bound delle curve di durata seguono l'unità dichiarata",
    /const grainDurBounds = window\.PGEEnvUtils\.grainUnitBounds\(PB\.grainDur, grainUnit\)/.test(eeSrc)
    && /const grainRangeBounds = window\.PGEEnvUtils\.grainUnitBounds\(PB\.durationRange, grainUnit\)/.test(eeSrc)
    && !/hardMin: PB\.grainDur\.min, hardMax: PB\.grainDur\.max/.test(eeSrc)
    && !/hardMin: PB\.durationRange\.min, hardMax: PB\.durationRange\.max/.test(eeSrc));
  assert("anche la finestra di partenza è espressa nell'unità",
    !/visMin: 0\.001, visMax: 0\.1/.test(eeSrc)
    && !/visMin: 0, visMax: 0\.5,/.test(eeSrc)
    && /grainDurVis/.test(eeSrc) && /grainRangeVis/.test(eeSrc));
  assert("il suffisso è quello condiviso con l'Inspector",
    /const grainUnitSuffix = window\.PGEEnvUtils\.grainUnitSuffix\(grainUnit\)/.test(eeSrc)
    && (eeSrc.match(/unit: grainUnitSuffix, fine: true,/g) || []).length === 2);
}


/* ── slice: la meta' dopo il taglio (split al cursore) ──
 * Il gemello di rescale+truncate: quello tiene la testa, questo la coda. La
 * regola e' una sola, x' = (x - cut)/(1 - cut), ed e' quella che tiene i
 * breakpoint fermi in tempo assoluto mentre l'origine si sposta sul taglio. */
console.log("\n── sliceEnvArray ──");
assert("l'origine si sposta sul taglio, il punto al taglio e' interpolato",
  eq(U.sliceEnvArray([[0, 0], [1, 1]], 0.5), [[0, 0.5], [1, 1]]),
  JSON.stringify(U.sliceEnvArray([[0, 0], [1, 1]], 0.5)));
assert("i breakpoint prima del taglio spariscono, quelli dopo si riscalano",
  eq(U.sliceEnvArray([[0, 0], [0.25, 1], [0.75, 1], [1, 0]], 0.5),
     [[0, 1], [0.5, 1], [1, 0]]),
  JSON.stringify(U.sliceEnvArray([[0, 0], [0.25, 1], [0.75, 1], [1, 0]], 0.5)));
assert("un breakpoint esattamente sul taglio non viene duplicato",
  eq(U.sliceEnvArray([[0, 0], [0.5, 0.3], [1, 1]], 0.5), [[0, 0.3], [1, 1]]));
assert("il punto di apertura onora lo step del segmento tagliato",
  eq(U.sliceEnvArray([[0, 0.2, "step"], [1, 1]], 0.5), [[0, 0.2, "step"], [1, 1]]),
  JSON.stringify(U.sliceEnvArray([[0, 0.2, "step"], [1, 1]], 0.5)));
// Un gruppo tutto prima del taglio esce di scena e lascia il posto al valore
// interpolato dal punto che il taglio attraversa davvero: senza questo la coda
// si apriva sull'ultimo punto del gruppo, che non e' il valore al taglio.
assert("un gruppo prima del taglio non riapre l'envelope al posto sbagliato",
  eq(U.sliceEnvArray([[[[0, 0], [0.1, 0.4]], "step"], [0.2, 0], [0.6, 1]], 0.4),
     [[0, 0.5], [0.33333, 1]]),
  JSON.stringify(U.sliceEnvArray([[[[0, 0], [0.1, 0.4]], "step"], [0.2, 0], [0.6, 1]], 0.4)));
assert("l'interp per-punto sopravvive allo spostamento",
  eq(U.sliceEnvArray([[0, 0], [1, 1, "exp"]], 0.5), [[0, 0.5], [1, 1, "exp"]]));
// Un envelope vuoto il motore non lo accetta: se dopo il taglio non resta
// nessun punto, la coda tiene l'ultimo valore invece di sparire.
assert("senza punti dopo il taglio resta il valore tenuto",
  eq(U.sliceEnvArray([[0, 0], [0.2, 0.7]], 0.5), [[0, 0.7]]));
assert("forma tipata {type,points} tagliata ricorsivamente",
  eq(U.sliceEnvArray({ type: "exp", points: [[0, 0], [1, 1]] }, 0.5),
     { type: "exp", points: [[0, 0.5], [1, 1]] }));
// read_direction vive in {-1,+1}: il punto interpolato al taglio e' un y
// CALCOLATO, e senza snap uscirebbe uno 0.3 che il motore rifiuta al parse.
assert("sul dominio direction il punto interpolato e' snappato al segno",
  eq(U.sliceEnvArray([[0, -1], [1, 1]], 0.5, U.snapDirection), [[0, 1], [1, 1]]));
// Il taglio a meta' di un blocco compatto non e' definito (n_reps e ratio
// descrivono un ciclo, non una lista di punti): l'array si dichiara intoccato.
assert("un array con un blocco compatto risponde null",
  U.sliceEnvArray([[[[0, 0], [1, 1]], 0.8, 2]], 0.5) === null);
assert("un BP group viene tagliato come i breakpoint",
  eq(U.sliceEnvArray([[[[0, 0], [1, 1]], "exp"]], 0.5), [[[[0, 0.5], [1, 1]], "exp"]]),
  JSON.stringify(U.sliceEnvArray([[[[0, 0], [1, 1]], "exp"]], 0.5)));

/* La proprieta' che il taglio deve avere, e l'unica che si vede a occhio nel
 * grafico: rimesse in tempo assoluto, le due meta' ridanno l'envelope di
 * partenza. Il punto sul taglio e' l'unico nuovo, ed e' lo stesso nelle due. */
console.log("\n── testa + coda = originale (tempi assoluti) ──");
{
  const abs = (env, dur, off) => env.map(p => [+(off + p[0] * dur).toFixed(4), p[1]]);
  const check = (label, env, dur, cut, expHead, expTail) => {
    const head = U.truncateEnvArray(U.rescaleEnvArray(env, dur / cut));
    const tail = U.sliceEnvArray(env, cut / dur);
    assert(label + " — testa", eq(abs(head, cut, 0), expHead), JSON.stringify(abs(head, cut, 0)));
    assert(label + " — coda", eq(abs(tail, dur - cut, cut), expTail), JSON.stringify(abs(tail, dur - cut, cut)));
  };
  check("taglio dentro un segmento", [[0, 0], [0.25, 1], [0.5, 0.5], [1, 0]], 4, 2.5,
        [[0, 0], [1, 1], [2, 0.5], [2.5, 0.375]],
        [[2.5, 0.375], [4, 0]]);
  check("taglio esattamente su un breakpoint", [[0, 0], [0.5, 1], [1, 0]], 4, 2,
        [[0, 0], [2, 1]],
        [[2, 1], [4, 0]]);
  check("taglio prima del primo breakpoint interno", [[0, 0.3], [0.75, 1]], 4, 1,
        [[0, 0.3], [1, 0.5333]],
        [[1, 0.5333], [3, 1]]);
}

console.log("\n── sliceStreamEnvelopes ──");
{
  const s = {
    id: "s1", onset: 0, duration: 4,
    volumeEnv: [[0, 0], [1, 1]],
    grain: { readDirectionEnv: [[0, -1], [1, 1]] },
    pointer: { speedRatioEnv: [[[[0, 0], [1, 1]], 0.8, 2]] },
  };
  const out = U.sliceStreamEnvelopes(s, 0.5);
  assert("taglia ogni campo envelope dello stream",
    eq(out.stream.volumeEnv, [[0, 0.5], [1, 1]]));
  assert("il dominio e' della chiave, non dello stream (direction snappato)",
    eq(out.stream.grain.readDirectionEnv, [[0, 1], [1, 1]]));
  assert("il campo col blocco compatto resta intatto ed e' contato in skipped",
    out.skipped === 1 && eq(out.stream.pointer.speedRatioEnv, s.pointer.speedRatioEnv));
  assert("lo stream di partenza non viene mutato",
    eq(s.volumeEnv, [[0, 0], [1, 1]]));
}

/* ── il cablaggio in app.jsx ──
 * Le tre cose che rendono il taglio un taglio, e che una riscrittura
 * distratta toglierebbe senza che nessun test le veda. */
{
  const appSrc = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
  // La testa va congelata SEMPRE, non solo col lucchetto chiuso: uno stretch
  // riproporzionerebbe le curve e il taglio non sarebbe piu' un taglio.
  assert("la testa passa per rescale+truncate, indipendentemente dal toggle freeze",
    /truncateStreamEnvelopes\(rescaleStreamEnvelopes\(s, s\.duration, cutRel\)\)/.test(appSrc));
  assert("la coda passa per sliceStreamEnvelopes",
    /sliceStreamEnvelopes\(s, cutNorm\)/.test(appSrc));
  // La posizione di lettura la calcola il motore: senza sidecar non c'e'
  // niente da ereditare e lo split si rifiuta invece di inventare uno start.
  assert("senza posizione di lettura lo split si rifiuta",
    /if \(!ptr\) \{[\s\S]{0,400}?Split rifiutato[\s\S]{0,200}?return;/.test(appSrc));
  // pointer.start segue l'unita' in vigore: ogni stream nato nell'editor e'
  // time_mode: normalized, dove start vive in [0,1] del sample.
  assert("pointer.start e' convertito nell'unita' in vigore",
    /loopUnitInfo\(s\)\.unit/.test(appSrc)
    && /unit === "normalized" \? ptr\.pos \/ sampleDur : ptr\.pos/.test(appSrc));
  assert("la coda nasce nella corsia della testa",
    /addStreamToTrackOf\(tr, x\.src, x\.stream\.id\)/.test(appSrc));
  assert("il tasto e' rimappabile, default d",
    /matchShortcut\(e, tweaks\.shortcutSplit \|\| "d"\)/.test(appSrc));
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
