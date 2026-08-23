/* =============================================================================
 * test-suite-harness.js — il verdetto di ogni suite non dipende da dove sta
 * scritto (#132).
 *
 * Il difetto che questo file impedisce e' successo davvero: in
 * test-yaml-bridge.js il blocco di riepilogo — quello che fa uscire il processo
 * con 1 se qualcosa e' fallito — stava a meta' file, e la sezione appesa dopo
 * (24 assert) girava a valle del gate. Un suo FAIL veniva stampato e il
 * processo usciva comunque 0, con un conteggio piu' basso di quello reale.
 *
 * La contromisura non e' "ricordarsi di scrivere in fondo": il verdetto vive in
 * un handler `exit`, che gira quando il file e' finito, ovunque sia registrato.
 * Questo test verifica le due meta' della cosa:
 *   1. l'idioma funziona davvero — un assert fallito DOPO la registrazione
 *      dell'handler porta a exit 1 (verificato eseguendo, non leggendo);
 *   2. tutti i file della suite lo usano, e nessuno e' tornato al gate
 *      posizionale.
 *
 * Run: node test-suite-harness.js (from tests/node/)
 * =========================================================================== */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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

/* ============================================================
 * 1 — l'idioma: cio' che viene dopo continua a contare
 * ============================================================ */

console.log("\n── idioma: il verdetto e' un handler, non una riga ──");

// Il token vietato non compare mai come letterale in questo file: altrimenti la
// guardia al punto 2 si accuserebbe da sola. Vale anche per gli script generati.
const HARD_EXIT = "process." + "exit(";

const HANDLER = [
  "let fail = 0;",
  'process.on("exit", () => {',
  "  console.log(`${fail} failed`);",
  "  if (fail > 0) process.exitCode = 1;",
  "});",
].join("\n");

function runScript(body) {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "pge-harness-"));
  const file = path.join(dir, "probe.js");
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

{
  // Il caso reale: un fallimento registrato DOPO l'handler.
  const r = runScript(HANDLER + "\nfail++;\n");
  assert("un fallimento dopo la registrazione fa uscire 1", r.status === 1,
    `status ${r.status}, stdout ${JSON.stringify(r.stdout)}`);
  assert("il riepilogo vede il fallimento tardivo", /1 failed/.test(r.stdout), r.stdout);
}

{
  // Nessun fallimento: verde, e l'handler non inventa un exit code.
  const r = runScript(HANDLER + "\n");
  assert("senza fallimenti esce 0", r.status === 0, `status ${r.status}`);
}

{
  // Un crash non viene mascherato: l'handler alza a 1, non abbassa a 0.
  const r = runScript(HANDLER + "\nthrow new Error('boom');\n");
  assert("un'eccezione resta un fallimento", r.status === 1, `status ${r.status}`);
}

{
  // La forma vecchia — il gate posizionale — e' proprio quella che falliva:
  // il fallimento appeso dopo non viene contato e il processo esce 0.
  const legacy = [
    "let fail = 0;",
    "console.log(`${fail} failed`);",
    "if (fail > 0) " + HARD_EXIT + "1);",
    "fail++;",
  ].join("\n");
  const r = runScript(legacy);
  assert("il gate posizionale mancherebbe il fallimento tardivo (esce 0)", r.status === 0,
    `status ${r.status}`);
}

/* ============================================================
 * 2 — la guardia: nessun file della suite e' tornato indietro
 * ============================================================ */

console.log("\n── guardia sui file della suite ──");

const suiteFiles = fs.readdirSync(__dirname)
  .filter(f => /^test-.*\.js$/.test(f))
  .sort();

assert("la suite ha piu' di un file da controllare", suiteFiles.length > 1,
  `trovati ${suiteFiles.length}`);

for (const f of suiteFiles) {
  const src = fs.readFileSync(path.join(__dirname, f), "utf8");
  assert(`${f} — nessun gate di uscita posizionale`, !src.includes(HARD_EXIT),
    "usa l'handler `exit` invece di uscire in una riga in fondo al file");
  assert(`${f} — registra il verdetto in un handler exit`,
    /process\.on\("exit"/.test(src) && /process\.exitCode\s*=\s*1/.test(src));
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", () => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
});
