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
const SG     = require("./source-guard.js");

const dir = path.join(__dirname, "../../src/components");
let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

// `readdirSync` su un path sbagliato LANCIA, e il modo realistico di avere
// zero file e' proprio quello: senza questo catch il file usciva 1 tre righe
// prima dell'assert che nomina il caso, quindi quel ramo era irraggiungibile.
let files = [];
try {
  files = fs.readdirSync(dir).filter(f => f.endsWith(".jsx")).sort();
} catch (e) {
  console.error("      " + e.message);
}
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

/* Ogni `.jsx` dev'essere anche CARICATO da `PGE Editor.html`.
 *
 * Non c'e' build step: un componente nuovo, valido, che nessuno ha aggiunto
 * all'HTML semplicemente non esiste a runtime — `window.PGE*` resta undefined e
 * l'editor si rompe dove lo usa. CLAUDE.md lo dice ("A new JSX file must be
 * added to PGE Editor.html"), e in una PR che rende eseguibili i patti quello
 * restava prosa. Il materiale c'era gia': altre due suite leggono l'HTML. */
{
  const htmlPath = path.join(__dirname, "../../PGE Editor.html");
  const html = SG.codeOf(htmlPath);     // senza <!-- --> : un commento non carica
  const missing = files.filter(f => !html.includes(f));
  if (files.length) {
    assert(`ogni .jsx e' caricato da PGE Editor.html (${files.length})`,
      missing.length === 0,
      "questi non compaiono nell'HTML, quindi a runtime non esistono: " +
      missing.join(", "));
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
