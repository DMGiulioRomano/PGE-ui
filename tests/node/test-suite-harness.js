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
const SG   = require("./source-guard.js");

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
 * 1b — e harness.js lo rispetta DAVVERO, non solo per guardia sorgente
 *
 * Il punto 1 verifica l'idioma su uno script sintetico; questo fa girare il
 * runner vero. Serve perche' harness.js ha un ramo in piu' di una suite di
 * tests/node/: "morta prima della fine", cioe' entrata nei casi e non arrivata
 * al riepilogo. Quel ramo alzava l'uscita solo se aveva GIA' contato un
 * fallimento, quindi una suite in cui il primo caso passa e il secondo si
 * appende — node resta senza lavoro ed esce da se' — stampava "1 passed, 0
 * failed" e usciva 0. Un caso su due non aveva girato: la tesi di questa PR
 * applicata al suo runner.
 *
 * L'oracolo e' iniettato nella require cache e il motore e' una directory vuota
 * con src/pge dentro: la sonda non ha bisogno del repo fratello, quindi gira
 * anche nel job che il motore non ce l'ha.
 * ============================================================ */

const HARNESS_JS = path.join(__dirname, "..", "parity", "harness.js");
const ORACLE_JS  = path.join(__dirname, "..", "parity", "oracle.js");

if (fs.existsSync(HARNESS_JS) && fs.existsSync(ORACLE_JS)) {
  console.log("\n── harness.js: una suite morta a meta' non e' un pass ──");

  const probe = [
    'const fs = require("fs"), os = require("os"), path = require("path");',
    // motore finto: engineRoot() guarda solo l'esistenza di src/pge
    'const fake = fs.mkdtempSync(path.join(os.tmpdir(), "pge-fake-engine-"));',
    'fs.mkdirSync(path.join(fake, "src", "pge"), { recursive: true });',
    "process.env.PGE_ENGINE_ROOT = fake;",
    "delete process.env.PGE_PARITY_STRICT;",
    // oracolo finto, prima che harness.js lo chieda
    `const id = require.resolve(${JSON.stringify(ORACLE_JS)});`,
    "require.cache[id] = { id, filename: id, loaded: true, exports: {",
    "  openOracle: async () => ({",
    '    hello: { engine_commit: null, python: "3.x", ops: [], unavailable: {} },',
    "    ask: async () => ({}), close() {},",
    "  }) } };",
    `const { parity } = require(${JSON.stringify(HARNESS_JS)});`,
    "parity({",
    '  suite: "sonda", why: "il secondo caso non arriva mai in fondo",',
    "  cases: [",
    '    { label: "un assert che passa", run: async (ask, assert) => { assert("passa", true); } },',
    // Il caso che uccide il runner FRA un caso e l'altro: il `console.log`
    // dell'etichetta sta fuori dal try, quindi il rigetto esce dal ciclo e
    // `parity()` non arriva mai al verdetto. E' il ramo "morta a meta'"
    // riprodotto senza appendersi — la versione appesa la copre la sonda 1c,
    // e con il tetto per caso non sarebbe piu' questo ramo.
    "  ],",
    "});",
  ].join("\n").replace("  ],", [
    '    { get label() { if (++reads > 2) throw new Error("il runner muore qui");',
    '                    return "e poi il runner muore fra un caso e l\'altro"; },',
    "      run: async () => {} },",
    "  ],",
  ].join("\n"));

  const r = runScript("let reads = 0;\n" + probe);
  const out = (r.stdout || "") + (r.stderr || "");
  assert("una suite che muore a meta' esce 1", r.status === 1,
    `status ${r.status}\n${out}`);
  assert("...dicendo che il riepilogo e' parziale",
    /interrotto prima della fine/.test(out), out);
  assert("...ed elencando il caso che non ha girato",
    /e poi il runner muore fra un caso e l'altro/.test(out.slice(out.indexOf("interrotto prima della fine"))),
    out);
  assert("il caso che ha girato e' comunque contato", /1 passed/.test(out), out);
}

/* ============================================================
 * 1c — un caso che si appende NON e' un job in timeout
 *
 * La sonda 1b prova il ramo "morta a meta'", che si raggiunge quando node
 * resta senza lavoro. Con l'oracolo VERO quella condizione non si verifica
 * mai: il processo python tiene su il loop, quindi un caso appeso non fa
 * uscire node e il ramo non arriva — il job va in timeout invece di dare un
 * verdetto. Il tetto per caso lo trasforma in un caso che non ha girato, col
 * suo nome, e la suite prosegue fino al riepilogo.
 *
 * L'oracolo finto qui tiene un handle aperto (un `setInterval`), cosi' la
 * sonda riproduce la configurazione vera invece di quella comoda.
 * ============================================================ */

if (fs.existsSync(HARNESS_JS) && fs.existsSync(ORACLE_JS)) {
  console.log("\n── harness.js: un caso appeso non appende la suite ──");

  const probe = [
    'const fs = require("fs"), os = require("os"), path = require("path");',
    'const fake = fs.mkdtempSync(path.join(os.tmpdir(), "pge-fake-engine-"));',
    'fs.mkdirSync(path.join(fake, "src", "pge"), { recursive: true });',
    "process.env.PGE_ENGINE_ROOT = fake;",
    "delete process.env.PGE_PARITY_STRICT;",
    "process.env.PGE_PARITY_CASE_TIMEOUT_MS = \"1500\";",
    // L'handle che l'oracolo vero terrebbe aperto: senza, node uscirebbe da
    // se' e la sonda proverebbe di nuovo il ramo 1b.
    "const keepAlive = setInterval(() => {}, 1000);",
    `const id = require.resolve(${JSON.stringify(ORACLE_JS)});`,
    "require.cache[id] = { id, filename: id, loaded: true, exports: {",
    "  openOracle: async () => ({",
    '    hello: { engine_commit: null, python: "3.x", ops: [], unavailable: {} },',
    "    ask: async () => ({}), close() { clearInterval(keepAlive); },",
    "  }) } };",
    `const { parity } = require(${JSON.stringify(HARNESS_JS)});`,
    "parity({",
    '  suite: "sonda", why: "il primo caso non si chiude mai",',
    "  cases: [",
    '    { label: "un caso che non si chiude mai", run: async () => new Promise(() => {}) },',
    '    { label: "il caso dopo gira lo stesso", run: async (ask, assert) => { assert("gira", true); } },',
    "  ],",
    "});",
  ].join("\n");

  const t0 = Date.now();
  const r = runScript(probe);
  const out = (r.stdout || "") + (r.stderr || "");
  const dt = Date.now() - t0;
  assert("un caso appeso diventa un fallimento, non un timeout del job",
    r.status === 1, `status ${r.status}\n${out}`);
  assert("...con il suo nome, invece del silenzio",
    /un caso che non si chiude mai/.test(out), out);
  assert("...e la suite arriva comunque al riepilogo",
    /1 passed, 1 failed/.test(out),
    "il caso dopo deve girare: un caso appeso non e' la fine della suite\n" + out);
  assert("...entro il tetto dichiarato, non dopo",
    dt < 30000, `${dt} ms`);
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
  const src = SG.codeOf(path.join(PARITY_DIR, f));
  assert(`parity/${f} — nessuna uscita brutale`, !src.includes(HARD_EXIT),
    "il verdetto e' di harness.js: uscire di qui lo salta, riepilogo compreso");
}

for (const { label, file } of suiteFiles) {
  const src = SG.codeOf(file);
  assert(`${label} — nessun gate di uscita posizionale`, !src.includes(HARD_EXIT),
    "usa l'handler `exit` invece di uscire in una riga in fondo al file");
  assert(`${label} — registra il verdetto in un handler exit`,
    /process\.on\("exit", \(code\)/.test(src) && /process\.exitCode\s*=\s*1/.test(src));
  assert(`${label} — un crash a meta' non passa per un riepilogo pulito`,
    /code && !fail/.test(src),
    "l'handler deve dire che il riepilogo e' parziale quando il processo muore prima della fine");
  /* ...e la registrazione deve stare a LIVELLO DI MODULO.
   *
   * Il controllo testuale qui sopra non distingue un handler registrato dal
   * file da uno registrato dentro il corpo asincrono che dovrebbe sorvegliare:
   * se quel corpo muore prima di arrivarci, l'handler non esiste, e il
   * processo esce senza ne' riepilogo ne' "interrotto prima della fine" — le
   * due righe che sono l'intero contratto. Nel caso peggiore non esce affatto:
   * con dei figli vivi il loop resta pieno e il job va in timeout.
   *
   * E' esattamente la forma che questa guardia condanna, un piano piu' su, e
   * l'unica differenza fra un file sano e uno rotto e' la profondita' di
   * parentesi in cui la riga sta. Percio' si conta, invece di cercarla. */
  assert(`${label} — l'handler exit e' registrato a livello di modulo`,
    SG.topLevelOccurrences(src, 'process.on("exit"').length >= 1,
    "registrato dentro l'IIFE asincrona: se il corpo muore prima di arrivarci " +
    "non c'e' nessun handler, e il file esce muto");
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
  const src = SG.codeOf(PARITY_HARNESS);
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

/* ============================================================
 * 4 — un verdetto stampato e mai consegnato
 *
 * L'altra meta' del contratto d'uscita: non basta pronunciare il verdetto, il
 * processo deve poi USCIRE. Misurato: con un interprete vivo e muto al posto
 * di python, harness.js stampava "PARITA' NON VERIFICATA" e i casi non
 * eseguiti, e restava vivo oltre i 75 s — `close()` chiedeva (`stdin.end()` +
 * `unref()`) senza poter uccidere, e funzionava solo perche' l'oracolo vero
 * esce sull'EOF di stdin. Stessa causa, seconda faccia: un caso che si appende
 * con l'oracolo VERO non fa mai arrivare il ramo "morta a meta'", perche' quel
 * ramo e' nell'handler `exit` e node non esce.
 *
 * Sono guardie sorgente perche' riprodurle qui vorrebbe dire far partire un
 * python muto e aspettarne il non ritorno; le due riproduzioni stanno nel
 * commit che le chiude.
 * ============================================================ */

console.log("\n── il verdetto viene anche consegnato ──");
{
  const oracleSrc = fs.readFileSync(
    path.join(__dirname, "..", "parity", "oracle.js"), "utf8");
  const oracleCode = SG.stripComments(oracleSrc);
  assert("parity/oracle.js — close() puo' uccidere, non solo chiedere",
    /close\([^)]*\)\s*\{[\s\S]{0,900}?\.kill\(/.test(oracleCode),
    "`stdin.end()` + `unref()` e' una richiesta: un interprete che non esce " +
    "resta vivo, e `unref()` non stacca stdout/stderr");
  assert("...e l'apertura fallita chiude il processo che ha aperto",
    /catch \(err\) \{\s*o\.close\(\);\s*throw err;/.test(oracleCode),
    "in harness.js `oracle` e' ancora undefined li', quindi il suo " +
    "`if (oracle) oracle.close()` non scatta");

  const harnessCode = SG.stripComments(
    SG.codeOf(PARITY_HARNESS));
  assert("parity/harness.js — ogni caso gira sotto un tetto di tempo",
    /withTimeout\(c\.run\(/.test(harnessCode) &&
    /caseTimeoutMs/.test(harnessCode),
    "un caso che si appende con l'oracolo vivo non fa mai uscire node, " +
    "e il ramo `morta a meta'` sta in un handler exit");

  const ci = path.join(__dirname, "..", "..", ".github", "workflows", "ci.yml");
  if (fs.existsSync(ci)) {
    // I job, non le chiavi di `on:`: si parte dal blocco `jobs:` e si taglia
    // sulle sue chiavi di primo livello.
    const ciSrc = fs.readFileSync(ci, "utf8");
    const jobsAt = ciSrc.search(/^jobs:$/m);
    const jobs = jobsAt < 0 ? []
      : ciSrc.slice(jobsAt).split(/^  (?=[\w-]+:$)/m).slice(1);
    assert("ci.yml — la CI ha i due job attesi", jobs.length === 2,
      `trovati ${jobs.length}: se sono cambiati, e' questa guardia a essere ` +
      `diventata muta`);
    for (const job of jobs) {
      const name = job.slice(0, job.indexOf(":"));
      assert(`ci.yml — il job ${name} ha un timeout-minutes`,
        /^\s*timeout-minutes:\s*\d+/m.test(job),
        "col default di 360 minuti una suite appesa e' sei ore di runner e " +
        "un job 'cancelled' al posto del rosso pulito");
    }
  }
}

/* ============================================================
 * 5 — la radice del motore e' UNA convenzione, non tre
 *
 * Le tre meta' della suite cercano il motore, e per un giro l'hanno cercato in
 * modi diversi: `tests/parity/harness.js` e `tests/python/engine_corpus.py`
 * leggevano `PGE_ENGINE_ROOT`, `tests/node/test-yaml-bridge.js` no — e il
 * Makefile la passava a due target su tre. Il sintomo non era un rosso: era
 * `make tests-node ROOT=/path/to/engine` che salta le sette fixture nominate e
 * stampa verde, cioe' lo skip silenzioso che la #132 esiste per rendere
 * impossibile, rientrato dalla porta di servizio.
 *
 * Guardia sorgente sui tre lettori e sui tre target, piu' una verifica
 * ESEGUENDO: che il nome compaia nel file non dice che il valore arrivi fino
 * al messaggio di skip, ed e' quello il pezzo che mancava.
 * ============================================================ */

console.log("\n── la radice del motore: una convenzione per tre meta' ──");
{
  const repo = path.join(__dirname, "..", "..");

  const readers = [
    ["node/test-yaml-bridge.js", path.join(repo, "tests/node/test-yaml-bridge.js"), true],
    ["parity/harness.js",        PARITY_HARNESS,                                    true],
    ["python/engine_corpus.py",  path.join(repo, "tests/python/engine_corpus.py"),  false],
  ];
  for (const [label, file, isJs] of readers) {
    if (!fs.existsSync(file)) continue;
    // Il .py non passa da source-guard (e' uno scanner JS): li' vale il testo
    // grezzo, e un `#` che citasse il nome starebbe comunque accanto alla
    // lettura vera, non al posto suo.
    const src = isJs ? SG.codeOf(file) : fs.readFileSync(file, "utf8");
    assert(`${label} — legge PGE_ENGINE_ROOT`, /PGE_ENGINE_ROOT/.test(src),
      "cerca il motore solo come repo fratello: ROOT= non ci arriva");
  }

  const mk = path.join(repo, "Makefile");
  if (fs.existsSync(mk)) {
    const mkSrc = fs.readFileSync(mk, "utf8");
    for (const target of ["tests-node", "tests-python", "tests-parity"]) {
      // Il corpo della ricetta, non il file intero: `PGE_ENGINE_ROOT` compare
      // anche nei commenti che spiegano la precedenza, e li' non passa a
      // nessuno.
      const at = mkSrc.search(new RegExp("^" + target + ":", "m"));
      const body = at < 0 ? "" : mkSrc.slice(at).split(/\n(?=\S)/)[0];
      assert(`Makefile — ${target} passa PGE_ENGINE_ROOT`,
        /PGE_ENGINE_ROOT="\$\(ENGINE_ROOT\)"/.test(body),
        `il ROOT= che l'help suggerisce non arriva a ${target}`);
    }
  }

  /* Eseguendo: una root inventata, e il file deve dichiarare di aver saltato
     QUELLA. Con la lettura assente nominerebbe il fratello, ed e' il modo in
     cui il difetto e' rimasto invisibile per un giro.

     Condizionato a js-yaml perche' test-yaml-bridge.js lo richiede in cima,
     cioe' prima di risolvere la root: senza `npm install` il figlio muore al
     require e la misura non e' possibile. Non e' un buco come lo skip delle
     fixture — li' a mancare era la verifica, qui restano le guardie sorgente
     qui sopra, che girano sempre — e `make tests-node` (la via documentata, e
     quella della CI) fa `npm install` prima del ciclo, quindi questo ramo non
     e' mai quello di CI. */
  if (!fs.existsSync(path.join(repo, "tests", "node", "node_modules", "js-yaml"))) {
    console.log("  SKIP la verifica eseguendo (js-yaml assente: `npm install` " +
                "in tests/node, o `make tests-node`)");
  } else {
    const fake = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pge-root-")));
    try {
      const r = spawnSync(process.execPath, ["test-yaml-bridge.js"], {
        cwd: path.join(repo, "tests", "node"),
        env: { ...process.env, PGE_ENGINE_ROOT: fake, PGE_REQUIRE_ENGINE_FIXTURES: "" },
        encoding: "utf8",
      });
      const out = (r.stdout || "") + (r.stderr || "");
      assert("test-yaml-bridge.js — PGE_ENGINE_ROOT arriva fino allo skip",
        out.includes(fake), `nessuna riga nomina ${fake}`);
      assert("...e un motore assente resta uno skip legittimo, non un rosso",
        r.status === 0, `exit ${r.status}`);
    } finally {
      fs.rmSync(fake, { recursive: true, force: true });
    }
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
