/* =============================================================================
 * test-audio-clock.js — tests for the pure clock math in audio-engine.js
 * (window.PGEAudioClock), the latency/lead compensation that keeps the visual
 * playhead on the audible sound instead of running ahead of it.
 *
 * Run: node test-audio-clock.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// audio-engine.js is an IIFE that only touches AudioContext lazily (inside
// _ensureContext), so it evals fine under a bare window shim — the constructor
// and the PGEAudioClock export run without a real Web Audio stack.
global.window = {};
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/audio-engine.js"), "utf8"));

const C = window.PGEAudioClock;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

console.log("\n── module surface ──");
assert("PGEAudioClock exposes audiblePosition + playAt",
  typeof C.audiblePosition === "function" && typeof C.playAt === "function");

console.log("\n── audiblePosition ──");
// Anchor at ctx=10 maps to timeline=0; no latency → position = elapsed.
assert("advances by elapsed ctx time",
  near(C.audiblePosition(11.0, 10.0, 0, 0), 1.0));
// Output latency is subtracted: the audible point lags the schedule clock.
assert("subtracts output latency",
  near(C.audiblePosition(11.0, 10.0, 0, 0.03), 0.97));
// During the lead window (ctx < anchor) the playhead holds at the start.
assert("clamps to start during the lead (ctx before anchor)",
  near(C.audiblePosition(10.05, 10.09, 0, 0), 0));
// Right at the anchor, before latency has elapsed, still clamped to start.
assert("clamps to start within the latency window after the anchor",
  near(C.audiblePosition(10.10, 10.09, 0, 0.03), 0));
// A non-zero start position offsets the whole timeline.
assert("honours startedFromTimeline offset",
  near(C.audiblePosition(12.0, 10.0, 5.0, 0), 7.0));
// Exactly one output-latency past the anchor → audible position == start.
assert("audible == start exactly one latency past the anchor",
  near(C.audiblePosition(10.12, 10.09, 0, 0.03), 0));

console.log("\n── playAt ──");
// Initial schedule: anchor in the future, clip at onset 0 → play at the anchor.
assert("immediate clip plays at the anchor (lead absorbed)",
  near(C.playAt(10.0, 10.09, 0), 10.09));
// Future clip: anchor + its onset delay.
assert("future clip plays at anchor + startDelay",
  near(C.playAt(10.0, 10.09, 2.0), 12.09));
// Reschedule mid-playback: anchor is in the past → never schedule behind now.
assert("past anchor clamps to now (reschedule mid-playback)",
  near(C.playAt(15.0, 10.0, 0), 15.0));
assert("past anchor + startDelay still clamps to now when behind",
  near(C.playAt(15.0, 10.0, 1.0), 15.0));
// Past anchor but the clip is still in the future → keep the real target.
assert("past anchor with a far-future clip keeps its target",
  near(C.playAt(15.0, 10.0, 8.0), 18.0));

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${fail ? "✗" : "✓"} audio-clock: ${pass} passed, ${fail} failed\n`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
