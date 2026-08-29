/* =============================================================================
 * test-oracle-client.js — il client node dell'oracolo di parita' (#133).
 *
 * `tests/parity/oracle.js` e' codice node: parla con un processo python, ma per
 * essere provato non ha bisogno del motore. Le suite di parita' non possono
 * verificarlo — per girare devono avere un oracolo VIVO, e cio' che qui si
 * verifica e' come muore.
 *
 * Il punto e' la diagnostica, non il verdetto: un oracolo che muore fa uscire 1
 * comunque (l'handler `exit` di harness.js). Ma `_die`/`_withStderr` esistono
 * per dire CHE COSA e' morto, portandosi dietro lo stderr del python — ed e'
 * l'informazione che serve di piu' proprio nei casi in cui l'oracolo muore a
 * meta' batch (l'import del motore che esplode, un OOM). Un'eccezione non
 * gestita la sostituisce con uno stack grezzo.
 *
 * Il processo finto e' `node -e "setInterval(…)"`: nessun python, nessun
 * motore, quindi questa suite gira ovunque giri il resto di tests/node/.
 *
 * Run: node test-oracle-client.js (from tests/node/)
 * =========================================================================== */

const path = require("path");
const { spawn } = require("child_process");
const { Oracle } = require(path.join(__dirname, "..", "parity", "oracle.js"));

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

const uncaught = [];
process.on("uncaughtException", (e) => { uncaught.push(e); });

function fakeInterpreter() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
               { stdio: ["pipe", "pipe", "pipe"] });
}

(async () => {

/* La corsa: `close` ed `error` del processo sono consegnati in modo asincrono,
 * quindi il controllo `if (this._dead)` una riga sopra la write NON basta. Un
 * python ucciso subito prima lascia `_dead` a null, la write parte, e la pipe
 * emette EPIPE. Senza listener sullo stream e' un'eccezione non gestita. */
console.log("\n── un oracolo che muore fra il controllo e la write ──");
{
  const proc = fakeInterpreter();
  const o = new Oracle(proc, "finto");
  await new Promise(res => proc.on("spawn", res));

  proc.kill("SIGKILL");
  assert("il processo e' morto ma il client non lo sa ancora", o._dead === null,
         `_dead=${o._dead}`);

  let err = null;
  try {
    await o.ask("qualsiasi", {}, { timeoutMs: 3000 });
    assert("la ask non puo' risolversi su un oracolo morto", false);
  } catch (e) {
    err = e;
    assert("la ask rigetta invece di far esplodere il processo", true);
  }
  assert("...e il rigetto e' la diagnostica di _die, non uno stack grezzo",
         !!err && /oracolo/.test(err.message), err && err.message);
  assert("nessuna eccezione non gestita",
         uncaught.length === 0,
         uncaught.map(e => `${e.code}: ${e.message}`).join(" | "));

  try { proc.kill(); } catch { /* gia' morto */ }
}

/* La stessa morte, ma con la write che arriva dopo che il client se n'e'
 * accorto: qui il ramo che parla e' il controllo `_dead`, e deve dare lo stesso
 * genere di messaggio — non un TypeError su uno stream chiuso. */
console.log("\n── ...e quando invece il client l'ha gia' saputo ──");
{
  const proc = fakeInterpreter();
  const o = new Oracle(proc, "finto");
  await new Promise(res => proc.on("spawn", res));

  proc.kill("SIGKILL");
  await new Promise(res => proc.on("close", res));
  assert("il client ha registrato la morte", typeof o._dead === "string", `${o._dead}`);

  let err = null;
  try { await o.ask("qualsiasi", {}, { timeoutMs: 3000 }); }
  catch (e) { err = e; }
  assert("la ask rigetta con la ragione registrata",
         !!err && /oracolo/.test(err.message), err && err.message);
  assert("nessuna eccezione non gestita nemmeno qui",
         uncaught.length === 0,
         uncaught.map(e => `${e.code}: ${e.message}`).join(" | "));
}

/* Guardia sorgente: i listener sono TRE, e il terzo e' quello che manca a
 * chiunque agganci solo il processo. */
console.log("\n── guardia sorgente: il listener sta sullo stream ──");
{
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "parity", "oracle.js"), "utf8");
  assert("proc.stdin ha un listener error instradato in _die",
         /proc\.stdin\.on\("error",[\s\S]{0,60}?_die\(/.test(src), "senza, EPIPE e' non gestito");
  assert("la write e' protetta anche dal fallimento sincrono",
         /try \{\s*this\.proc\.stdin\.write\(/.test(src));
  assert("...che non rilancia: le attese le porta fuori l'await",
         /this\._die\(`scrittura sulla stdin[\s\S]{0,80}\}\s*\n\s*const answers = await Promise\.all\(waits\);/.test(src),
         "rilanciare qui scambierebbe un EPIPE non gestito con un rigetto non gestito");
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file: cosi'
// una sezione appesa dopo continua a contare, invece di stampare FAIL e uscire
// 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});

})();
