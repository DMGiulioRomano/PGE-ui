/* =============================================================================
 * test-tweaks-store.js — pure merge logic of the preferences store
 * (window.PGETweaks.applyEdit), plus a guard that the removed design-tool
 * residue (EDITMODE block / TweaksPanel / tweaks-panel.jsx) does not creep back
 * while the load-bearing window.PGE_TWEAKS publication stays.
 *
 * Run: node test-tweaks-store.js (from tests/node/)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// tweaks-store.js does `window.PGETweaks = {...}` inside an IIFE.
global.window = {};
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/tweaks-store.js"), "utf8"));

const { applyEdit } = window.PGETweaks;

/* ---------- micro test runner ---------- */

let pass = 0, fail = 0;

function assert(label, cond, extra) {
  if (cond) {
    pass++;
    console.log("  OK  " + label);
  } else {
    fail++;
    console.error("FAIL  " + label + (extra ? "\n      " + extra : ""));
  }
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ============================================================
 * SECTION 1 — applyEdit(prev, key, val): single-key form
 * ============================================================ */

console.log("\n── applyEdit: (key, val) ──");

assert("sets a new key", eq(applyEdit({ a: 1 }, "b", 2), { a: 1, b: 2 }));
assert("overwrites an existing key", eq(applyEdit({ a: 1, b: 1 }, "b", 2), { a: 1, b: 2 }));
assert("sets falsy 0", eq(applyEdit({}, "x", 0), { x: 0 }));
assert("sets falsy false", eq(applyEdit({}, "x", false), { x: false }));
assert("sets empty string", eq(applyEdit({}, "x", ""), { x: "" }));

/* ============================================================
 * SECTION 2 — applyEdit(prev, edits): object form
 * ============================================================ */

console.log("\n── applyEdit: (edits object) ──");

assert("merges multiple keys", eq(applyEdit({ a: 1 }, { b: 2, c: 3 }), { a: 1, b: 2, c: 3 }));
assert("object form ignores the 2nd arg", eq(applyEdit({ a: 1 }, { b: 2 }, 999), { a: 1, b: 2 }));
assert("object form overwrites", eq(applyEdit({ a: 1, b: 1 }, { b: 9 }), { a: 1, b: 9 }));
// Guard the original useTweaks behavior: a useState-style object call must not
// produce a literal "[object Object]" key.
assert("object form does not create an [object Object] key",
  !("[object Object]" in applyEdit({}, { k: 1 })));

/* ============================================================
 * SECTION 3 — immutability
 * ============================================================ */

console.log("\n── applyEdit: immutability ──");

const prev = { a: 1 };
const next = applyEdit(prev, "b", 2);
assert("returns a new object (does not mutate prev)", next !== prev && eq(prev, { a: 1 }));

/* ============================================================
 * SECTION 4 — design-tool residue removed, load-bearing kept
 * ============================================================ */

console.log("\n── design-tool residue removed ──");

const appSrc  = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");
const htmlSrc = fs.readFileSync(path.join(__dirname, "../../PGE Editor.html"), "utf8");

assert("app.jsx has no EDITMODE markers", !/EDITMODE-(BEGIN|END)/.test(appSrc));
assert("app.jsx no longer renders window.TweaksPanel", !/window\.TweaksPanel/.test(appSrc));
assert("HTML no longer loads tweaks-panel.jsx", !/tweaks-panel\.jsx/.test(htmlSrc));
assert("tweaks-panel.jsx file is gone",
  !fs.existsSync(path.join(__dirname, "../../src/components/tweaks-panel.jsx")));
// Load-bearing: primitives.jsx + Inspector.jsx read window.PGE_TWEAKS.
assert("app.jsx still publishes window.PGE_TWEAKS", /window\.PGE_TWEAKS\s*=/.test(appSrc));

/* ---------- summary ---------- */

console.log("\n──────────────────────────────────────────────────");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
