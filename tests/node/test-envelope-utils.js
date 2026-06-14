/* =============================================================================
 * test-envelope-utils.js — tests for envelope-utils.js (window.PGEEnvUtils),
 * the freeze-on-resize rescale/truncate math extracted from app.jsx (#44).
 *
 * Run: node test-envelope-utils.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// envelope-loops.js (window.PGEEnv) must load first; envelope-utils.js captures
// window.PGEEnv at IIFE time. js-yaml is provided in case envelope-loops needs it.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../envelope-loops.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../envelope-utils.js"), "utf8"));

const U = window.PGEEnvUtils;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n── module surface ──");
assert("PGEEnvUtils exposes the 7 helpers",
  ["rescaleEnvArray", "truncateEnvArray", "envArrayWouldTruncate", "_applyEnvFields",
   "rescaleStreamEnvelopes", "truncateStreamEnvelopes", "streamWouldTruncate"]
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

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
