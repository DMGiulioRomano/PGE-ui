/* =============================================================================
 * test-history-core.js — pins the undo/redo stack mechanics extracted from
 * app.jsx to history-core.js (window.PGEHistoryCore, #58).
 *
 * Covers the invariants the editor relies on: the 200-cap drops the oldest entry,
 * a gesture collapses to a single undo step, a new mutation clears the redo stack,
 * and undo/redo move one entry without clearing the opposite stack.
 *
 * Run: node test-history-core.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = {};
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/history-core.js"), "utf8"));

const H = window.PGEHistoryCore;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n── create() / CAP ──");
assert("CAP is 200", H.CAP === 200);
{
  const h = H.create();
  assert("fresh shape", eq(h, { past: [], future: [], snapshotBeforeGesture: null, inGesture: false }));
}

console.log("\n── record() outside a gesture ──");
{
  const h = H.create();
  const bumped = H.record(h, "A");
  assert("returns true (a push happened)", bumped === true);
  assert("pushes prev to past", eq(h.past, ["A"]));
}
{
  const h = H.create();
  h.future = ["redo-me"];
  H.record(h, "A");
  assert("a new mutation clears future", eq(h.future, []));
}
{
  // 250 mutations, cap 200, drops oldest (Array.shift): retains indices 50..249.
  const h = H.create();
  for (let i = 0; i < 250; i++) H.record(h, i);
  assert("caps past at 200", h.past.length === 200);
  assert("drops the oldest (past[0] === 50)", h.past[0] === 50);
  assert("keeps the newest (past[199] === 249)", h.past[199] === 249);
}

console.log("\n── record() inside a gesture (collapse) ──");
{
  const h = H.create();
  H.beginGesture(h);
  assert("beginGesture sets inGesture", h.inGesture === true);
  const b1 = H.record(h, "S0");
  assert("first in-gesture record returns false", b1 === false);
  assert("snapshots the pre-gesture state once", h.snapshotBeforeGesture === "S0");
  assert("does not push to past during gesture", eq(h.past, []));
  const b2 = H.record(h, "S1");
  assert("second in-gesture record returns false", b2 === false);
  assert("snapshot unchanged (collapses)", h.snapshotBeforeGesture === "S0");
  assert("still no push", eq(h.past, []));
}

console.log("\n── commitGesture() ──");
{
  const h = H.create();
  H.beginGesture(h);
  H.record(h, "S0");
  H.record(h, "S1");
  const bumped = H.commitGesture(h);
  assert("returns true when a snapshot was pending", bumped === true);
  assert("pushes the single pre-gesture snapshot", eq(h.past, ["S0"]));
  assert("clears inGesture", h.inGesture === false);
  assert("clears snapshot", h.snapshotBeforeGesture === null);
}
{
  const h = H.create();
  H.beginGesture(h);
  const bumped = H.commitGesture(h);
  assert("returns false when nothing mutated", bumped === false);
  assert("past untouched", eq(h.past, []));
  assert("still clears inGesture", h.inGesture === false);
}

console.log("\n── undo() / redo() ──");
{
  const h = H.create();
  const r = H.undo(h, "CUR");
  assert("undo on empty past returns current unchanged", eq(r, { data: "CUR", bumped: false }));
}
{
  const h = H.create();
  const r = H.redo(h, "CUR");
  assert("redo on empty future returns current unchanged", eq(r, { data: "CUR", bumped: false }));
}
{
  const h = H.create();
  H.record(h, "A");              // past: ["A"]
  const u = H.undo(h, "B");      // pop A, push B to future
  assert("undo returns popped past entry", eq(u, { data: "A", bumped: true }));
  assert("undo moved current to future", eq(h.future, ["B"]));
  assert("undo emptied past", eq(h.past, []));
  const r = H.redo(h, "A");      // pop B from future, push A to past
  assert("redo returns popped future entry", eq(r, { data: "B", bumped: true }));
  assert("redo moved current to past", eq(h.past, ["A"]));
  assert("redo emptied future", eq(h.future, []));
}

console.log("\n── undo()/redo() do not clear the opposite stack ──");
{
  const h = H.create();
  h.past = ["A"]; h.future = ["X"];
  H.undo(h, "CUR");
  assert("undo appends to existing future without clearing", eq(h.future, ["X", "CUR"]));
}
{
  const h = H.create();
  h.past = ["P"]; h.future = ["F"];
  H.redo(h, "CUR");
  assert("redo appends to existing past without clearing", eq(h.past, ["P", "CUR"]));
}

console.log("\n── reset() / canUndo() / canRedo() ──");
{
  const h = H.create();
  h.past = ["A", "B"]; h.future = ["C"]; h.snapshotBeforeGesture = "S"; h.inGesture = true;
  assert("canUndo true when past non-empty", H.canUndo(h) === true);
  assert("canRedo true when future non-empty", H.canRedo(h) === true);
  assert("isInGesture true mid-gesture", H.isInGesture(h) === true);
  H.reset(h);
  assert("reset clears everything", eq(h, { past: [], future: [], snapshotBeforeGesture: null, inGesture: false }));
  assert("canUndo false after reset", H.canUndo(h) === false);
  assert("canRedo false after reset", H.canRedo(h) === false);
  assert("isInGesture false after reset", H.isInGesture(h) === false);
}

console.log("\n── isInGesture() ──");
{
  const h = H.create();
  assert("false on fresh history", H.isInGesture(h) === false);
  H.beginGesture(h);
  assert("true after beginGesture", H.isInGesture(h) === true);
  H.commitGesture(h);
  assert("false after commitGesture", H.isInGesture(h) === false);
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", () => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
});
