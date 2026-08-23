/* =============================================================================
 * test-jsx-parse.js — every .jsx file must parse.
 *
 * This repo has no build step and no linter: `.jsx` is transpiled in the
 * browser by Babel at load time, so a syntax error is not caught by anything —
 * it surfaces as a blank editor and a console message nobody is watching in CI.
 * The suite's other guards read these files as TEXT (regex source checks), so
 * they stay green on a file that cannot run at all.
 *
 * Run: node test-jsx-parse.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs     = require("fs");
const path   = require("path");
const parser = require("@babel/parser");

const dir = path.join(__dirname, "../../src/components");
let pass = 0, fail = 0;

const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsx")).sort();
console.log(`\n── ${files.length} components parse as JSX ──`);
if (!files.length) { console.error("FAIL  no .jsx files found — wrong path?"); process.exit(1); }

for (const f of files) {
  try {
    // Same dialect the browser gets: classic scripts (window globals, no
    // modules — see "File layout & load order" in CLAUDE.md) plus JSX.
    parser.parse(fs.readFileSync(path.join(dir, f), "utf8"), {
      sourceType: "script",
      plugins: ["jsx"],
    });
    pass++; console.log("  OK  " + f);
  } catch (e) {
    fail++; console.error("FAIL  " + f + "\n      " + e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
