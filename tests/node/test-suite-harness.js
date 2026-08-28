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
  'process.on("exit", (code) => {',
  "  console.log(`${fail} failed`);",
  '  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e\' parziale");',
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
  // E il riepilogo lo dice: senza la riga "interrotto" leggerebbe "0 failed"
  // sotto uno stack trace, cioe' un verde stampato su una run morta a meta'.
  const r = runScript(HANDLER + "\nthrow new Error('boom');\n");
  assert("un'eccezione resta un fallimento", r.status === 1, `status ${r.status}`);
  assert("il riepilogo dichiara di essere parziale", /interrotto prima della fine/.test(r.stdout),
    r.stdout);
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

/* I file da controllare: le suite di qui, piu' il runner di tests/parity/.
 *
 * `readdirSync(__dirname)` da solo si ferma a tests/node/, e per un po' e'
 * bastato — poi e' arrivato harness.js, che di suite ne governa cinque e usciva
 * con quattro uscite brutali. Non era stile: con quella alla fine di `parity`,
 * un assert che si risolveva dopo la catena di await veniva buttato via, e un
 * `await` dimenticato in una suite di parita' stampava "1 passed, 0 failed"
 * uscendo 0. Lo stesso difetto di test-yaml-bridge.js, un piano piu' in la'.
 *
 * Le suite di tests/parity/ NON sono in questa lista: il verdetto non e' loro,
 * lo tiene harness.js per tutte. E' lui che deve rispettare il contratto. */
const HERE = fs.readdirSync(__dirname)
  .filter(f => /^test-.*\.js$/.test(f))
  .sort()
  .map(f => ({ label: f, file: path.join(__dirname, f) }));

const PARITY_HARNESS = path.join(__dirname, "..", "parity", "harness.js");
const suiteFiles = HERE.concat(
  fs.existsSync(PARITY_HARNESS)
    ? [{ label: "parity/harness.js", file: PARITY_HARNESS }]
    : []);

assert("la suite ha piu' di un file da controllare", suiteFiles.length > 1,
  `trovati ${suiteFiles.length}`);
assert("il runner di tests/parity/ e' nella lista",
  suiteFiles.some(f => f.label === "parity/harness.js"),
  "harness.js governa cinque suite: il contratto d'uscita vale anche per lui");

/* Le CINQUE suite di parita' non devono rispettare l'intero contratto — il
 * verdetto non e' loro, lo tiene harness.js per tutte — ma non devono nemmeno
 * poterselo riprendere. Un'uscita brutale appesa in fondo a una di loro la
 * fa uscire 0 senza riepilogo, con un sabotaggio reale dentro, e la guardia
 * qui sopra resta verde perche' guarda solo harness.js: #132 una directory
 * piu' in la'. Quindi su di loro si controlla la sola uscita brutale. */
const PARITY_DIR = path.join(__dirname, "..", "parity");
const paritySuites = fs.existsSync(PARITY_DIR)
  ? fs.readdirSync(PARITY_DIR).filter(f => /^test-.*\.js$/.test(f)).sort()
  : [];
assert("le suite di tests/parity/ sono nel presidio",
  paritySuites.length >= 5,
  `trovate ${paritySuites.length}: se sono sparite, e' la guardia a essere ` +
  `diventata muta, non la parita' a essere finita`);
for (const f of paritySuites) {
  const src = fs.readFileSync(path.join(PARITY_DIR, f), "utf8");
  assert(`parity/${f} — nessuna uscita brutale`, !src.includes(HARD_EXIT),
    "il verdetto e' di harness.js: uscire di qui lo salta, riepilogo compreso");
}

for (const { label, file } of suiteFiles) {
  const src = fs.readFileSync(file, "utf8");
  assert(`${label} — nessun gate di uscita posizionale`, !src.includes(HARD_EXIT),
    "usa l'handler `exit` invece di uscire in una riga in fondo al file");
  assert(`${label} — registra il verdetto in un handler exit`,
    /process\.on\("exit", \(code\)/.test(src) && /process\.exitCode\s*=\s*1/.test(src));
  assert(`${label} — un crash a meta' non passa per un riepilogo pulito`,
    /code && !fail/.test(src),
    "l'handler deve dire che il riepilogo e' parziale quando il processo muore prima della fine");
}

/* Il salto della parita' deve chiudere l'oracolo.
 *
 * `bail` termina la suite lanciando, e da quando esiste un salto DOPO
 * l'apertura dell'oracolo (op indisponibili sotto strict) quel lancio scavalca
 * `oracle.close()`. Con il processo python ancora vivo node non esce: la suite
 * non fallisce, resta appesa — in CI un job che va in timeout invece di dare un
 * verdetto, cioe' il modo peggiore di rompersi. Guardia sul sorgente perche'
 * riprodurlo qui vorrebbe dire far partire un oracolo e aspettarne il non
 * ritorno. */
if (fs.existsSync(PARITY_HARNESS)) {
  const src = fs.readFileSync(PARITY_HARNESS, "utf8");
  assert("parity/harness.js — bail chiude l'oracolo prima di lanciare",
    /function bail\([^)]*\)\s*\{[\s\S]{0,80}?if \(oracle\) oracle\.close\(\);/.test(src),
    "un salto dopo l'apertura lascia vivo il processo python e la suite si appende");
  assert("parity/harness.js — `oracle` e' dichiarato prima di bail",
    src.indexOf("let oracle;") < src.indexOf("function bail("),
    "altrimenti la close dentro bail legge una TDZ e lancia al posto del salto");
  // Il salto e la morte a meta' devono restare due casi: con il solo
  // `verdict === null` a distinguerli, una suite che muore prima della fine
  // usciva 1 stampando il solo stack, senza nemmeno dire che il riepilogo
  // mancava. E' l'unico modo in cui questo file puo' tacere del tutto.
  assert("parity/harness.js — il salto ha un flag suo, distinto dal verdetto",
    /let bailed = false;/.test(src) && /bailed = true;/.test(src) &&
    /if \(bailed\) return;/.test(src),
    "senza, un crash a meta' run non stampa nessun riepilogo");
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
