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
// Zero file e' un fallimento, non un verde: significa che il path e' sbagliato.
// Registrato come assert normale, cosi' passa dall'handler come tutto il resto.
if (!files.length) { fail++; console.error("FAIL  no .jsx files found — wrong path?"); }

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

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
