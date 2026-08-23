/* =============================================================================
 * test-render-status.js — pins the stale/fresh/never classification + summary
 * extracted from app.jsx to render-status.js (window.PGERenderStatus, #58).
 *
 * The fingerprint hash itself is covered by test-fingerprint.js; here we test the
 * decision built on top of it: classifyStream, summarize, statusForStream, and
 * that fingerprintAll just maps backend.fingerprintStream over the streams.
 *
 * Run: node test-render-status.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// render-status.js calls window.PGEBackend.fingerprintStream, so load backend.js
// first under the same minimal browser shims as test-fingerprint.js.
global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.reject(new Error("no network in test"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/render-status.js"), "utf8"));

const RS = window.PGERenderStatus;
const { fingerprintStream } = window.PGEBackend;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n── module surface ──");
assert("STATES present", RS.STATES && RS.STATES.FRESH === "fresh" && RS.STATES.STALE === "stale" &&
  RS.STATES.NEVER === "never" && RS.STATES.RUNNING === "running");
assert("TOOLTIPS present (4 strings)", RS.TOOLTIPS &&
  RS.TOOLTIPS.running === "rendering this stream…" &&
  RS.TOOLTIPS.never === "this stream has never been rendered" &&
  RS.TOOLTIPS.fresh === "rendered and up-to-date with the YAML" &&
  RS.TOOLTIPS.stale === "YAML changed since last render — re-render to update");
for (const fn of ["fingerprintAll", "classifyStream", "summarize", "statusForStream"])
  assert(`exports ${fn}`, typeof RS[fn] === "function");

console.log("\n── classifyStream(lastFp, currentFp, hasStem) ──");
assert("null last → never",        RS.classifyStream(null, "x", true) === "never");
assert("empty-string last → never", RS.classifyStream("", "x", true) === "never");
assert("no stem → never",          RS.classifyStream("a", "b", false) === "never");
assert("last === current → fresh", RS.classifyStream("a", "a", true) === "fresh");
assert("last !== current → stale", RS.classifyStream("a", "b", true) === "stale");

console.log("\n── fingerprintAll(streams, format) ──");
{
  const s1 = { id: "s1", duration: 10, sample: "x.wav", density: 20 };
  const s2 = { id: "s2", duration: 5,  sample: "y.wav", density: 9 };
  const all = RS.fingerprintAll([s1, s2], "wav");
  assert("maps each stream id", Object.keys(all).sort().join(",") === "s1,s2");
  assert("s1 parity with fingerprintStream", all.s1 === fingerprintStream(s1, "wav"));
  assert("s2 parity with fingerprintStream", all.s2 === fingerprintStream(s2, "wav"));
  assert("threads the format through", RS.fingerprintAll([s1], "aiff").s1 === fingerprintStream(s1, "aiff"));
  assert("format actually matters", RS.fingerprintAll([s1], "wav").s1 !== RS.fingerprintAll([s1], "aiff").s1);
}

console.log("\n── summarize(streams, currentFps, lastRenderedFps, hasStem) ──");
{
  const streams = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const currentFps      = { a: "1", b: "2", c: "3", d: "4" };
  const lastRenderedFps = { a: "1", b: "X", /* c missing */ d: "4" };
  const hasStem = (id) => id !== "d"; // d rendered (last===cur) but stem gone → never
  const sum = RS.summarize(streams, currentFps, lastRenderedFps, hasStem);
  assert("counts {fresh:1,stale:1,never:2,total:4}",
    eq(sum, { fresh: 1, stale: 1, never: 2, total: 4 }), JSON.stringify(sum));
  assert("total is streams.length", RS.summarize([], {}, {}, () => true).total === 0);
}

console.log("\n── statusForStream(streamId, ctx) ──");
{
  const base = {
    currentFps:      { a: "1", b: "2", c: "3" },
    lastRenderedFps: { a: "1", b: "9" /* c missing */ },
    hasStem: (id) => id !== "z",
    running: false, currentStreamId: null, streamProgress: {},
  };
  assert("fresh", eq(RS.statusForStream("a", base), { state: "fresh", tooltip: RS.TOOLTIPS.fresh }));
  assert("stale", eq(RS.statusForStream("b", base), { state: "stale", tooltip: RS.TOOLTIPS.stale }));
  assert("never", eq(RS.statusForStream("c", base), { state: "never", tooltip: RS.TOOLTIPS.never }));

  const running = { ...base, running: true, currentStreamId: "a", streamProgress: { a: 0.42 } };
  assert("running with progress",
    eq(RS.statusForStream("a", running), { state: "running", progress: 0.42, tooltip: RS.TOOLTIPS.running }));

  const runningNoProg = { ...base, running: true, currentStreamId: "a", streamProgress: {} };
  assert("running progress defaults to 0",
    eq(RS.statusForStream("a", runningNoProg), { state: "running", progress: 0, tooltip: RS.TOOLTIPS.running }));

  // Running, but a *different* stream is current → falls through to classify.
  assert("running for other stream falls through to classify",
    eq(RS.statusForStream("b", running), { state: "stale", tooltip: RS.TOOLTIPS.stale }));
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", () => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
});
