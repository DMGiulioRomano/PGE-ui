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
/* E la suite e2e (#139), che sta in una terza directory. Il contratto e' lo
 * stesso e le serve piu' che alle altre: e' l'unica che guida un browser e un
 * bridge, cioe' l'unica il cui corpo puo' morire per una ragione che non e' un
 * assert — un `page.click` in timeout, un python che non parte. Senza
 * l'handler quella morte esce 1 con uno stack e nessun riepilogo; con l'handler
 * dice quali assert non hanno contato. */
const E2E_BOOT = path.join(__dirname, "..", "e2e", "test-boot.js");
const suiteFiles = HERE
  .concat(fs.existsSync(PARITY_HARNESS)
    ? [{ label: "parity/harness.js", file: PARITY_HARNESS }] : [])
  .concat(fs.existsSync(E2E_BOOT)
    ? [{ label: "e2e/test-boot.js", file: E2E_BOOT }] : []);

assert("la suite ha piu' di un file da controllare", suiteFiles.length > 1,
  `trovati ${suiteFiles.length}`);
assert("il runner di tests/parity/ e' nella lista",
  suiteFiles.some(f => f.label === "parity/harness.js"),
  "harness.js governa cinque suite: il contratto d'uscita vale anche per lui");
assert("la suite e2e e' nella lista",
  suiteFiles.some(f => f.label === "e2e/test-boot.js"),
  "tests/e2e/test-boot.js e' sparita: se e' stata rinominata, aggiorna la " +
  "guardia invece di lasciarla muta");

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
    assert("ci.yml — la CI ha i tre job attesi", jobs.length === 3,
      `trovati ${jobs.length}: se sono cambiati, e' questa guardia a essere ` +
      `diventata muta`);
    // Il terzo e' `e2e` (#139), e va nominato: il tetto sotto vale per
    // qualunque job, ma se il boot headless sparisse dalla CI il conteggio
    // tornerebbe a due e questa guardia lo direbbe come "guardia muta"
    // invece che come "la suite e2e non gira piu'".
    assert("ci.yml — il boot headless e' fra i job",
      jobs.some(j => j.startsWith("e2e:")),
      "tests/e2e/ senza un job in CI e' una suite che gira solo a mano");
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
    ["node/test-yaml-bridge.js", path.join(repo, "tests/node/test-yaml-bridge.js")],
    ["parity/harness.js",        PARITY_HARNESS],
    ["python/engine_corpus.py",  path.join(repo, "tests/python/engine_corpus.py")],
  ];
  for (const [label, file] of readers) {
    if (!fs.existsSync(file)) continue;
    // Anche il .py passa da source-guard: `codeOf` sceglie lo scanner
    // dall'estensione, quindi li' a sparire sono i `#` e non i `//`. Prima non
    // era cosi' e il python veniva letto grezzo, cioe' un `#` che citasse il
    // nome bastava a tenere su la guardia.
    const src = SG.codeOf(file);
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

/* ============================================================
 * 6 — lo scanner di source-guard non deve perdere il filo
 *
 * Ogni guardia sorgente della suite — comprese quelle di questo file, che
 * misurano la profondita' dell'handler `exit` — si fida di `SG.codeOf`: il
 * sorgente SENZA commenti. Se lo scanner si desincronizza, quel contratto
 * salta in silenzio e una guardia torna verde su una riga COMMENTATA, che e'
 * esattamente il difetto per cui source-guard.js esiste.
 *
 * E' successo: un apostrofo dentro un testo JSX (`each page's densest…`) veniva
 * preso per l'apertura di una stringa, e da li' in giu' il file non veniva piu'
 * letto come codice. In RenderButton.jsx la desincronizzazione copriva tutto
 * `buildCommand`, cioe' proprio le righe che test-score-options.js e
 * test-magnify-spec.js presidiano: commentare `parts.push("--bw")` lasciava la
 * guardia verde. Fra apici un a capo non ci puo' stare, quindi un apice non
 * chiuso a fine riga e' testo, non un letterale.
 *
 * L'altra meta' e' il python: server.py e engine_introspect.py passano da
 * `codeOf` in tre guardie, e leggerli con lo scanner JS era un errore di
 * categoria — `#` non e' un commento, le virgolette triple non sono una
 * stringa. `codeOf` sceglie lo scanner dall'estensione.
 *
 * Due misure: gli esempi minimi qui sotto, e il censimento sui sorgenti veri —
 * nessuna riga che COMINCIA per il commento della sua lingua puo' sopravvivere
 * a `codeOf`. La seconda e' derivata dai file, quindi resta vera mentre i file
 * cambiano.
 * ============================================================ */

console.log("\n── source-guard: il sorgente resta leggibile come codice ──");
{
  const jsx = [
    "const a = <div>each page's densest cluster</div>;",
    "// questa riga e' un commento e deve sparire",
    'const b = "vero";',
  ].join("\n");
  const jsxCode = SG.stripComments(jsx);
  assert("un apostrofo in un testo JSX non apre una stringa",
    !/questa riga/.test(jsxCode),
    "lo scanner si desincronizza: da li' in poi i commenti non vengono piu' visti");
  assert("...e il codice dopo resta leggibile",
    /const b = "vero";/.test(jsxCode));

  // Le stringhe vere restano stringhe: `codeOf` le lascia leggibili (una
  // guardia che cerca "/semantics-version" deve trovarlo), `maskOf` le vuota.
  const str = "const r = '/render'; // via\nconst q = 1;";
  assert("una stringa su una riga sola resta un letterale",
    /'\/render'/.test(SG.stripComments(str)) && !/via/.test(SG.stripComments(str)));
  assert("...e mascherata perde il contenuto, non la lunghezza",
    !/render/.test(SG.maskLiterals(str)) &&
    SG.maskLiterals(str).length === str.length);

  // Il template literal e' l'unica grafia che un a capo lo puo' contenere:
  // la regola nuova non deve toccarlo.
  const tpl = "const t = `riga\nunaltra`; // via\nconst z = 2;";
  assert("il template literal continua a stare su piu' righe",
    !/via/.test(SG.stripComments(tpl)) && /const z = 2;/.test(SG.stripComments(tpl)));


  /* Il python ha il suo scanner, scelto dall'estensione: `#` e' un commento,
   * le virgolette triple sono UNA stringa su piu' righe. Con lo scanner JS
   * addosso — che e' come veniva letto — nessuna delle due cose e' vera, e
   * `codeOf("server.py")` restituiva un rimescolamento. */
  const py = [
    'def render():',
    '    """Docstring: cita --bw e non e\' un commento."""',
    '    # questa riga e\' un commento python',
    '    bw = bool(opts.get("bw", False))',
  ].join("\n");
  const pyCode = SG.stripPyComments(py);
  assert("nel python il commento comincia per #",
    !/questa riga/.test(pyCode),
    "il `#` non viene tolto: una riga commentata tiene su la guardia");
  assert("...e il codice accanto resta leggibile",
    /opts\.get\("bw", False\)/.test(pyCode));
  assert("le virgolette triple sono una stringa, non tre",
    /Docstring: cita --bw/.test(pyCode) && SG.stripPyComments(py).length === py.length);
  assert("...e mascherate perdono il contenuto",
    !/Docstring/.test(SG.maskPyLiterals(py)) &&
    SG.maskPyLiterals(py).length === py.length);
  assert("un `#` dentro una stringa non apre un commento",
    /"#ff0000"/.test(SG.stripPyComments('c = "#ff0000"  # colore\n')) &&
    !/colore/.test(SG.stripPyComments('c = "#ff0000"  # colore\n')));

  // Censimento sui sorgenti veri: nessun commento di riga sopravvive, e le due
  // letture conservano la lunghezza (e' la premessa di `depthAt`, che conta la
  // profondita' sulla maschera agli offset trovati sul codice).
  const repoRoot = path.join(__dirname, "..", "..");
  const srcFiles = ["src/lib", "src/components"].flatMap((d) => {
    const dir = path.join(repoRoot, d);
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /\.(js|jsx)$/.test(f)).map((f) => path.join(dir, f))
      : [];
  }).concat(
    // Il bridge: e' python, e tre guardie lo leggono da `codeOf`. La riga di
    // commento li' comincia per `#`, e la docstring e' una stringa — che
    // sopravvive, come una stringa JS: si censiscono solo le righe che
    // COMINCIANO per `#`, e una dentro una docstring non e' una di quelle.
    ["server.py", "render_pipeline.py", "audio_pipeline.py", "engine_introspect.py"]
      .map((f) => path.join(repoRoot, f)).filter((f) => fs.existsSync(f)));
  assert("ci sono sorgenti da censire", srcFiles.length > 0);
  const leaky = [];
  const skewed = [];
  for (const file of srcFiles) {
    const py = /\.py$/.test(file);
    const raw = fs.readFileSync(file, "utf8");
    const code = SG.codeOf(file);
    if (code.length !== raw.length || SG.maskOf(file).length !== raw.length) {
      skewed.push(path.basename(file));
    }
    const rawLines = raw.split("\n");
    const codeLines = code.split("\n");
    const lineComment = py ? /^\s*#/ : /^\s*\/\//;
    // Una riga di commento dentro una docstring e' contenuto di stringa, non
    // un commento: si guardano solo quelle che stanno fuori da un letterale,
    // ed e' la maschera a dirlo (li' la stringa e' vuotata).
    const maskLines = py ? SG.maskOf(file).split("\n") : codeLines;
    for (let i = 0; i < rawLines.length; i++) {
      if (!lineComment.test(rawLines[i])) continue;
      if (py && !lineComment.test(maskLines[i])) continue;   // dentro una docstring
      if (codeLines[i].trim() !== "") { leaky.push(`${path.basename(file)}:${i + 1}`); break; }
    }
  }
  assert("nessun sorgente lascia passare un commento di riga", leaky.length === 0,
    "codeOf non li toglie in: " + leaky.join(", "));
  assert("...e le due letture conservano la lunghezza del file", skewed.length === 0,
    "offset disallineati in: " + skewed.join(", "));
}

/* ============================================================
 * 7 — bin/pge-ui: un lanciatore che non puo' diventare un programma (#164)
 *
 * `bin/pge-ui` esiste per una ragione sola: dare un nome sul PATH al bridge,
 * cosi' che `cd ~/qualsiasi-brano && pge-ui` apra l'editor su quella cartella.
 * Tutto cio' che DECIDE qualcosa — dove sta il motore, quale workspace, se
 * aprire il browser — sta in server.py, dove pytest e le guardie lo vedono.
 * Uno script in /bin invece non lo guarda nessuno: la sua tentazione naturale
 * e' crescere (un default qui, un flag li'), e crescendo diventa la seconda
 * copia di quelle decisioni — quella che non ha test.
 *
 * Il presidio ha percio' due meta'. Una guardia sorgente che pretende che il
 * file resti quello che e': poche righe di codice, un solo `exec`, e nessun
 * flag di server.py scritto dentro. E una verifica ESEGUENDO, perche' la
 * proprieta' che l'issue chiede — "funziona attraverso il symlink" — e' proprio
 * quella che una lettura non puo' dare: senza `realpath`, `dirname` darebbe la
 * cartella del symlink e il comando cercherebbe server.py in ~/.local/.
 * Quella prova gira su un repo finto (uno `server.py` che stampa i suoi argv),
 * quindi non ha bisogno ne' di flask ne' del repo fratello — cioe' gira anche
 * nel job node, che il bridge non lo installa.
 * ============================================================ */

console.log("\n── bin/pge-ui: il lanciatore resta un lanciatore ──");
{
  const repo = path.join(__dirname, "..", "..");
  const BIN  = path.join(repo, "bin", "pge-ui");
  // Le due meta' del presidio hanno bisogno della stessa domanda — «dov'e'
  // questo binario» — una per costruire un PATH ridotto, l'altra per togliere
  // `realpath` di mezzo a `make install-cli`. Una copia per meta' e' una copia
  // di troppo.
  const which = (name) => {
    const w = spawnSync("/bin/sh", ["-c", "command -v " + name], { encoding: "utf8" });
    return w.status === 0 ? w.stdout.trim() : "";
  };

  assert("bin/pge-ui esiste", fs.existsSync(BIN),
    "il comando dell'issue #164 non c'e'");

  if (fs.existsSync(BIN)) {
    const raw = fs.readFileSync(BIN, "utf8");
    // source-guard sceglie lo scanner dall'estensione e di `sh` non sa niente
    // (li' `//` non e' un commento e `#` si'). Per quattro righe la regola per
    // riga e' esatta e onesta: codice = riga non vuota che non comincia per
    // `#`. Lo shebang, che comincia per `#`, si controlla sul grezzo.
    const code = raw.split("\n").map((l) => l.trim())
                    .filter((l) => l && !l.startsWith("#"));

    assert("bin/pge-ui parte da /bin/sh", raw.startsWith("#!/bin/sh\n"),
      "uno shebang su una shell che puo' non esserci e' un comando che non parte");

    assert("...e resta corto", code.length <= 4,
      `${code.length} righe di codice: se e' cresciuto, qualcosa che andava in ` +
      `server.py e' finito qui — dove nessun test lo guarda\n      ` +
      code.join(" | "));

    const execLines = code.filter((l) => /^exec\b/.test(l));
    assert("...con un solo exec, che e' l'ultima riga", execLines.length === 1 &&
      code[code.length - 1] === execLines[0], code.join(" | "));

    const execLine = execLines[0] || "";
    assert("l'exec passa la mano a server.py", /server\.py/.test(execLine), execLine);
    assert("...e gli inoltra gli argomenti", /"\$@"/.test(execLine),
      'senza "$@" (o con $@ nudo) `pge-ui --port 9000` perde i flag, o li spezza ' +
      "sugli spazi");

    assert("il path si risolve con realpath", /realpath/.test(code.join("\n")),
      "il comando si raggiunge via symlink: senza realpath, dirname da' la " +
      "cartella del symlink e server.py non si trova");

    // Nessun default del bridge scritto qui dentro: e' il modo preciso in cui
    // lo script diventa la seconda copia delle decisioni di server.py.
    //
    // L'elenco dei flag NON si trascrive qui: si legge dagli `add_argument` di
    // server.py, che e' dove vengono dichiarati. Una lista a mano e' una
    // seconda copia della verita', e tace proprio quando il bridge cresce: il
    // sesto flag aggiunto domani si potrebbe cablare nel lanciatore con la
    // guardia verde. Che non sia teoria lo dice questa PR stessa, dove la
    // stessa lista trascritta in prosa ne nominava quattro su cinque.
    const srvSrc = fs.readFileSync(path.join(repo, "server.py"), "utf8");
    const bridgeFlags = [...srvSrc.matchAll(/add_argument\(\s*"(--[\w-]+)"/g)]
      .map((m) => m[1]);
    // La lettura deve aver funzionato, o la guardia sotto e' un regex vuoto che
    // non accusa niente — il modo silenzioso di sparire che questo repo
    // conosce gia' (`backend.envelopeKeys()` che torna `[]` e il filtro si
    // nasconde). `--root` e' la canarina: e' il flag che decide dove sta il
    // motore, cioe' la prima cosa che verrebbe cablata qui.
    assert("i flag del bridge si leggono da server.py, non da una lista",
      bridgeFlags.length >= 3 && bridgeFlags.includes("--root"),
      `letti ${bridgeFlags.length}: ${bridgeFlags.join(" ") || "nessuno"} — ` +
      "se server.py ha cambiato il modo di dichiarare i flag, la lettura va " +
      "aggiornata, non aggirata");
    // Ordinati dal piu' lungo: `\b` cade anche fra `t` e `-`, quindi con
    // `--port` davanti un ipotetico `--port-range` verrebbe nominato `--port`.
    const alt = [...bridgeFlags].sort((a, b) => b.length - a.length).join("|");
    const flag = bridgeFlags.length
      ? code.join("\n").match(new RegExp("(" + alt + ")\\b"))
      : null;
    assert("nessun flag di server.py e' cablato nel lanciatore", !flag,
      flag ? `trovato ${flag[0]}: quel default va in server.py, non qui` : "");

    assert("bin/pge-ui e' eseguibile sul disco",
      (fs.statSync(BIN).mode & 0o111) !== 0,
      "chmod +x bin/pge-ui");

    // Il bit sul disco puo' essere giusto mentre git registra 100644: dopo un
    // clone il comando non parte, e il symlink di install-cli neanche. E' la
    // meta' che un `chmod` locale non dimostra.
    const ls = spawnSync("git", ["ls-files", "-s", "bin/pge-ui"],
      { cwd: repo, encoding: "utf8" });
    if (ls.status !== 0 || !ls.stdout.trim()) {
      console.log("  SKIP il bit eseguibile nell'indice git (git assente, o file non tracciato)");
    } else {
      assert("...e anche per git (100755)", /^100755\s/.test(ls.stdout.trim()),
        ls.stdout.trim());
    }
  }

  /* Eseguendo. Il repo e' finto: `bin/pge-ui` vero (copiato, bit compreso) e
     uno `server.py` che stampa chi e' e con cosa e' stato chiamato. Il comando
     si raggiunge da un PATH, attraverso un symlink, da una terza cartella —
     cioe' esattamente la forma che `make install-cli` produce. */
  const py3 = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pge-cli-")));
  try {
    const fakeRepo = path.join(tmp, "repo");
    const binDir   = path.join(tmp, "bin");
    const elsewhere = path.join(tmp, "brano");
    fs.mkdirSync(path.join(fakeRepo, "bin"), { recursive: true });
    fs.mkdirSync(binDir);
    fs.mkdirSync(elsewhere);
    fs.copyFileSync(BIN, path.join(fakeRepo, "bin", "pge-ui"));
    fs.chmodSync(path.join(fakeRepo, "bin", "pge-ui"), 0o755);
    // Lo stub stampa gli argomenti separati da ` | `, non incollati da uno
    // spazio: la somma non distingue `"$@"` da `$@` — che e' precisamente la
    // differenza che questa meta' del presidio deve vedere (sotto).
    fs.writeFileSync(path.join(fakeRepo, "server.py"), [
      "import os, sys",
      'print("STUB " + os.path.abspath(__file__))',
      'print("ARGV " + " | ".join(sys.argv[1:]))',
      'print("CWD " + os.getcwd())',
    ].join("\n") + "\n");
    fs.symlinkSync(path.join(fakeRepo, "bin", "pge-ui"), path.join(binDir, "pge-ui"));

    /* Uno degli argomenti ha uno spazio dentro, e non e' un vezzo: con
       `--port 9000 --root /altrove` soltanto, un lanciatore che scrive `$@`
       nudo stampa lo stesso identico ARGV di uno che scrive `"$@"`. La sonda
       eseguendo — quella che esiste per dimostrare cio' che una lettura non
       puo' — restava percio' verde sull'unico difetto che l'assert sorgente
       qui sopra nomina. `--workspace ~/Documents/mio brano` e' il caso vero. */
    const CLI_ARGS = "--port 9000 --root /altrove --workspace '/tmp/mio brano'";
    const WANT_ARGV =
      "ARGV --port | 9000 | --root | /altrove | --workspace | /tmp/mio brano";
    const run = (env) => spawnSync("/bin/sh", ["-c", "pge-ui " + CLI_ARGS], {
      cwd: elsewhere,
      env: { ...process.env, PATH: binDir + path.delimiter + process.env.PATH, ...env },
      encoding: "utf8",
    });

    if (py3.status !== 0) {
      console.log("  SKIP la verifica eseguendo (python3 assente)");
    } else {
      const r = run({});
      const out = (r.stdout || "") + (r.stderr || "");
      assert("attraverso il symlink trova il server.py del SUO repo",
        out.includes("STUB " + path.join(fakeRepo, "server.py")),
        out.trim() || `exit ${r.status}`);
      assert("...inoltrando gli argomenti intatti, spazi compresi",
        out.includes(WANT_ARGV), out.trim());
      // La ragione per cui il comando esiste: il bridge parte dalla cartella da
      // cui l'hai chiamato, non da quella del repo.
      assert("...e partendo dalla cartella da cui l'hai chiamato",
        out.includes("CWD " + elsewhere), out.trim());
    }

    /* L'interprete: col venv del repo presente e' quello a vincere. Senza
       questa regola `pge-ui` userebbe il python3 di sistema e morirebbe
       sull'import di flask, cioe' proprio nel setup che `make install`
       produce — il README ci manda tutti li'. La sonda non ha bisogno di un
       python vero: il "venv" e' uno script che dichiara di essere stato
       chiamato, ed e' l'unica cosa che serve sapere. */
    const venvBin = path.join(fakeRepo, ".venv", "bin");
    fs.mkdirSync(venvBin, { recursive: true });
    fs.writeFileSync(path.join(venvBin, "python"),
      '#!/bin/sh\necho "VENV-PY $*"\n');
    fs.chmodSync(path.join(venvBin, "python"), 0o755);
    const r2 = run({});
    const out2 = (r2.stdout || "") + (r2.stderr || "");
    assert("col venv nel repo, e' il suo python a girare",
      out2.includes("VENV-PY " + path.join(fakeRepo, "server.py")),
      out2.trim() || `exit ${r2.status}`);

    /* E quando `realpath` non risponde, il comando si ferma invece di tirare a
       indovinare. Non e' un caso di laboratorio: `realpath` non e' POSIX e su
       macOS arriva solo con la 12.3. `dirname` di una stringa vuota da' `.`,
       quindi REPO diventava la cartella CORRENTE — dentro il checkout il
       comando funzionava per caso, e da ogni altra cartella moriva nominando
       un server.py che non c'entra niente, che e' il genere di errore da cui
       non si torna indietro da soli.

       La sonda ha bisogno di un'ESCA per essere decisiva, e la prima versione
       non ce l'aveva: col PATH ridotto il lanciatore rotto muore comunque
       (`python3` li' non c'e'), quindi "exit != 0" restava verde anche sul
       difetto. L'esca e' un finto venv nella cartella CORRENTE: con REPO
       risolto su `.` il lanciatore esegue quella, e si vede. Il controllo e'
       lo stesso PATH ridotto con realpath dentro — deve continuare a trovare
       lo stub del repo, e non l'esca. */
    const dnPath = which("dirname"), rpPath = which("realpath");
    if (!dnPath || !rpPath) {
      console.log("  SKIP realpath assente (dirname/realpath non trovati sul PATH)");
    } else {
      const noRp = path.join(tmp, "senza-realpath");
      const withRp = path.join(tmp, "con-realpath");
      fs.mkdirSync(noRp); fs.mkdirSync(withRp);
      fs.symlinkSync(dnPath, path.join(noRp, "dirname"));
      fs.symlinkSync(dnPath, path.join(withRp, "dirname"));
      fs.symlinkSync(rpPath, path.join(withRp, "realpath"));

      fs.mkdirSync(path.join(elsewhere, ".venv", "bin"), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, ".venv", "bin", "python"),
        '#!/bin/sh\necho "ESCA-PY $*"\n');
      fs.chmodSync(path.join(elsewhere, ".venv", "bin", "python"), 0o755);
      fs.writeFileSync(path.join(elsewhere, "server.py"), "");

      const ctl = run({ PATH: binDir + path.delimiter + withRp });
      const outC = (ctl.stdout || "") + (ctl.stderr || "");
      assert("controllo: col PATH ridotto ma realpath presente, parte il repo vero",
        outC.includes("VENV-PY " + path.join(fakeRepo, "server.py")) &&
        !outC.includes("ESCA-PY"), outC.trim() || `exit ${ctl.status}`);

      const bare = run({ PATH: binDir + path.delimiter + noRp });
      const outB = (bare.stdout || "") + (bare.stderr || "");
      assert("senza realpath si ferma, invece di risolvere REPO su $PWD",
        bare.status !== 0 && !outB.includes("ESCA-PY") &&
        !outB.includes("VENV-PY ") && !outB.includes("STUB "),
        `exit ${bare.status}\n      ` + outB.trim());
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* `make install-cli`: idempotente (lanciarlo due volte non e' un errore) e
     rumoroso quando BINDIR non e' nel PATH — che e' il modo piu' comune in cui
     il comando sembra non funzionare. Misurato lanciandolo: la ricetta e'
     quattro righe di shell dentro un Makefile, cioe' proprio il genere di cosa
     che una guardia sorgente dichiara presente e non funzionante. */
  const mk = spawnSync("make", ["--version"], { encoding: "utf8" });
  // `install-cli` rifiuta di installare senza `realpath` (l'ultima sonda di
  // questa sezione, ed e' il suo oggetto), quindi su una macchina che non ce
  // l'ha qui sotto non c'e' niente da misurare: ogni probe fallirebbe per
  // quella ragione sola, e il rosso direbbe del PATH della macchina invece che
  // del target. Lo stesso SKIP dichiarato che la meta' eseguendo usa gia'.
  const rpHere = which("realpath");
  if (mk.status !== 0) {
    console.log("  SKIP make install-cli (make assente)");
  } else if (!rpHere) {
    console.log("  SKIP make install-cli (realpath assente: il target rifiuta, per progetto)");
  } else {
    const tmp2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pge-bindir-")));
    const dest = path.join(tmp2, "bin");
    const runMake = (env) => spawnSync("make", ["-C", repo, "install-cli", "BINDIR=" + dest],
      { env: { ...process.env, ...env }, encoding: "utf8" });
    try {
      const a = runMake({});
      const b = runMake({});
      assert("make install-cli va a buon fine", a.status === 0,
        (a.stdout || "") + (a.stderr || ""));
      assert("...e due volte di fila non e' un errore", b.status === 0,
        (b.stdout || "") + (b.stderr || ""));
      const link = path.join(dest, "pge-ui");
      assert("...lasciando un symlink al bin/pge-ui del repo",
        fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink() &&
        fs.realpathSync(link) === fs.realpathSync(BIN),
        fs.existsSync(link) ? fs.readlinkSync(link) : "nessun link");
      // I due versi guardano la STESSA espressione. Con `/PATH/` di qua e
      // `!/attenzione/` di la' bastava riscrivere l'avviso senza quella parola
      // — `export PATH=` sarebbe rimasto a tenere verde il verso positivo — e
      // il verso negativo diventava vero per sempre: muto proprio sul caso che
      // deve vedere, cioe' l'avviso che parla quando BINDIR e' nel PATH.
      const WARN = /attenzione: .* non e' nel PATH/;
      assert("BINDIR fuori dal PATH e' un avviso", WARN.test(a.stdout || ""),
        "senza, l'utente vede 'command not found' e nessuna spiegazione\n      " +
        ((a.stdout || "") + (a.stderr || "")));
      const quiet = runMake({ PATH: dest + path.delimiter + process.env.PATH });
      // Lo `status` fa parte dell'assert, non e' un di piu': la negazione da'
      // verde anche su una ricetta che e' morta prima di stampare, cioe'
      // proprio il "dichiarato presente e non funzionante" da cui nasce questo
      // file. Il silenzio va misurato su una install-cli riuscita.
      assert("...e dentro il PATH l'avviso tace", quiet.status === 0 &&
        !WARN.test(quiet.stdout || ""),
        `exit ${quiet.status}\n      ` + ((quiet.stdout || "") + (quiet.stderr || "")));

      /* E tace anche con la barra in fondo, che e' la grafia che la
         tab-completion della shell scrive da sola: `BINDIR=~/.local/bin/`.
         Il confronto con il PATH e' testuale, e `$PATH` elenca quella cartella
         senza barra — quindi l'avviso parlava li', consigliando di aggiungere
         al PATH una voce che c'e' gia'. Un avviso che grida dove non c'e'
         niente e' il primo che si impara a saltare, e questo e' l'unica cosa
         che spiega un `command not found` dopo l'install. Il link deve
         comunque finire nella cartella chiesta, non in una `…//` di fantasia. */
      const slashed = spawnSync("make", ["-C", repo, "install-cli", "BINDIR=" + dest + "/"],
        { env: { ...process.env, PATH: dest + path.delimiter + process.env.PATH },
          encoding: "utf8" });
      assert("una barra in fondo a BINDIR non fa gridare l'avviso",
        slashed.status === 0 && !WARN.test(slashed.stdout || "") &&
        fs.existsSync(path.join(dest, "pge-ui")),
        `exit ${slashed.status}\n      ` +
        ((slashed.stdout || "") + (slashed.stderr || "")));
      // Due barre non sono piu' esotiche di una (un path incollato a mano), e
      // `patsubst` ne toglie una per giro: e' il motivo dei due giri.
      const slashed2 = spawnSync("make", ["-C", repo, "install-cli", "BINDIR=" + dest + "//"],
        { env: { ...process.env, PATH: dest + path.delimiter + process.env.PATH },
          encoding: "utf8" });
      assert("...ne' due", slashed2.status === 0 && !WARN.test(slashed2.stdout || ""),
        (slashed2.stdout || "") + (slashed2.stderr || ""));
      // Il verso opposto della stessa espressione: con la barra e la cartella
      // FUORI dal PATH l'avviso deve continuare a parlare. Senza questo, un
      // `BINDIR := ` che normalizza troppo (o un avviso cancellato) resterebbe
      // verde su tutt'e due gli assert qui sopra.
      const slashedOut = spawnSync("make", ["-C", repo, "install-cli", "BINDIR=" + dest + "/"],
        { env: process.env, encoding: "utf8" });
      assert("...e fuori dal PATH, con la barra, l'avviso parla ancora",
        slashedOut.status === 0 && WARN.test(slashedOut.stdout || ""),
        (slashedOut.stdout || "") + (slashedOut.stderr || ""));
    } finally {
      fs.rmSync(tmp2, { recursive: true, force: true });
    }

    /* Uno spazio nel path — del checkout o del BINDIR — non e' un caso
       esotico: `~/Documents/…` e `~/Library/Mobile Documents/…` ce l'hanno, e
       il lanciatore lo regge (ogni espansione dentro bin/pge-ui e' quotata).
       A cedere era la ricetta: `mkdir -p $(BINDIR)` con uno spazio fabbricava
       una cartella relativa DENTRO il repo e poi `ln` falliva nominando la
       destinazione, che invece esisteva. */
    const tmp3 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pge-spazi-")));
    try {
      const spaced = path.join(tmp3, "mio repo");
      // Il nome della seconda parola non e' indifferente: con "dest bin" la
      // cartella spuria che `mkdir -p` non quotato fabbrica si chiamerebbe
      // `bin` e si confonderebbe con quella vera del checkout, lasciando muto
      // l'assert qui sotto.
      const dest3  = path.join(tmp3, "dest cartella");
      fs.mkdirSync(path.join(spaced, "bin"), { recursive: true });
      fs.copyFileSync(path.join(repo, "Makefile"), path.join(spaced, "Makefile"));
      fs.copyFileSync(BIN, path.join(spaced, "bin", "pge-ui"));
      fs.chmodSync(path.join(spaced, "bin", "pge-ui"), 0o755);
      const m = spawnSync("make", ["-C", spaced, "install-cli", "BINDIR=" + dest3],
        { env: process.env, encoding: "utf8" });
      assert("uno spazio nel path del checkout e del BINDIR non rompe install-cli",
        m.status === 0, (m.stdout || "") + (m.stderr || ""));
      const link3 = path.join(dest3, "pge-ui");
      assert("...e il link punta al lanciatore di quel checkout",
        fs.existsSync(link3) &&
        fs.realpathSync(link3) === fs.realpathSync(path.join(spaced, "bin", "pge-ui")),
        fs.existsSync(link3) ? fs.readlinkSync(link3) : "nessun link (o pendente)");
      assert("...senza fabbricare cartelle dentro il checkout",
        fs.readdirSync(spaced).sort().join(",") === "Makefile,bin",
        fs.readdirSync(spaced).join(", "));

      /* Due spazi di fila non sono piu' esotici di uno, e li' non cedeva la
         ricetta (che quota) ma l'espansione del `~` messa sopra di essa:
         `patsubst` lavora a PAROLE, quindi `/tmp/a  b` tornava `/tmp/a b`. Il
         link finiva in una cartella che non e' quella chiesta, sotto la riga
         di successo — cioe' esattamente la bugia che quell'espansione era
         stata aggiunta per togliere. Con uno spazio solo il difetto non si
         vede: le parole si riattaccano identiche, ed e' il motivo per cui la
         sonda qui sopra restava verde. */
      const dest3b = path.join(tmp3, "due  spazi");
      const m2 = spawnSync("make", ["-C", spaced, "install-cli", "BINDIR=" + dest3b],
        { env: process.env, encoding: "utf8" });
      assert("due spazi di fila in BINDIR: il link finisce dove l'hai chiesto",
        m2.status === 0 && fs.existsSync(path.join(dest3b, "pge-ui")),
        (m2.stdout || "") + (m2.stderr || ""));
      assert("...e non in una cartella dal nome accorciato",
        !fs.existsSync(path.join(tmp3, "due spazi")),
        fs.readdirSync(tmp3).join(", "));
    } finally {
      fs.rmSync(tmp3, { recursive: true, force: true });
    }

    /* Il sorgente del symlink e' relativo al Makefile, non a $PWD. Con
       `$(abspath bin/pge-ui)` un `make -f /path/PGE-ui/Makefile install-cli`
       lanciato da un'altra cartella linkava `$PWD/bin/pge-ui` — un file che li'
       non c'e'. `ln -s` non verifica il target: il link pendente nasceva
       annunciato come riuscito, e il primo segnale era `pge-ui` che non parte.
       Lo spazio resta fuori da questa sonda perche' `$(lastword
       $(MAKEFILE_LIST))` spezza sugli spazi — limite di make, non della
       ricetta: li' il `test -f` fa fallire l'installazione invece di fabbricare
       il link sbagliato, ed e' la seconda meta' della stessa sonda. */
    const tmp4 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pge-altrove-")));
    try {
      const copy  = path.join(tmp4, "checkout");
      const dest4 = path.join(tmp4, "bin");
      const from  = path.join(tmp4, "cwd");
      fs.mkdirSync(path.join(copy, "bin"), { recursive: true });
      fs.mkdirSync(from);
      fs.copyFileSync(path.join(repo, "Makefile"), path.join(copy, "Makefile"));
      fs.copyFileSync(BIN, path.join(copy, "bin", "pge-ui"));
      fs.chmodSync(path.join(copy, "bin", "pge-ui"), 0o755);
      const m = spawnSync("make", ["-f", path.join(copy, "Makefile"), "install-cli",
        "BINDIR=" + dest4], { cwd: from, env: process.env, encoding: "utf8" });
      assert("make -f da una terza cartella: install-cli riesce", m.status === 0,
        (m.stdout || "") + (m.stderr || ""));
      const link4 = path.join(dest4, "pge-ui");
      assert("...e il link e' vivo, non pendente su $PWD/bin",
        fs.existsSync(link4) &&
        fs.realpathSync(link4) === fs.realpathSync(path.join(copy, "bin", "pge-ui")),
        fs.lstatSync(link4, { throwIfNoEntry: false })
          ? "punta a " + fs.readlinkSync(link4)
          : "nessun link");
      assert("...senza toccare la cartella da cui hai lanciato make",
        fs.readdirSync(from).length === 0, fs.readdirSync(from).join(", "));

      // E quando il sorgente davvero non c'e', install-cli si ferma invece di
      // lasciare un nome sul PATH che non esegue niente.
      fs.rmSync(path.join(copy, "bin", "pge-ui"));
      const gone = spawnSync("make", ["-f", path.join(copy, "Makefile"), "install-cli",
        "BINDIR=" + path.join(tmp4, "bin2")], { cwd: from, env: process.env, encoding: "utf8" });
      assert("sorgente assente → install-cli fallisce invece di linkare il nulla",
        gone.status !== 0 && !fs.existsSync(path.join(tmp4, "bin2", "pge-ui")),
        `exit ${gone.status}\n      ` + ((gone.stdout || "") + (gone.stderr || "")));
    } finally {
      fs.rmSync(tmp4, { recursive: true, force: true });
    }

    /* Le altre due grafie di BINDIR che davano un `pge-ui` annunciato
       installato e irraggiungibile — la stessa famiglia dello spazio e del
       `make -f`, e le ultime due rimaste.

       Il `~`: make non fa tilde expansion, e la ricetta quota ogni espansione
       (deve, per gli spazi), quindi nemmeno la shell lo espande.
       `BINDIR=~/.local/bin` — la grafia che l'help del Makefile suggerisce —
       fabbricava una cartella chiamata `~` dentro il checkout, ci metteva il
       link e stampava la riga di successo. Ora il `~/` iniziale lo espande il
       Makefile (`override`, altrimenti l'assegnamento perde proprio contro la
       riga di comando da cui BINDIR arriva); `~utente/` non lo sa espandere
       nessuno, e li' il target si ferma invece di inventare una cartella.

       E il bit eseguibile: la guardia sorgente qui sopra difende l'indice di
       QUESTO repo, non il checkout di chi installa. Un file senza bit x
       (un download, un filesystem che non lo porta) si lasciava linkare, e il
       primo segnale era `pge-ui: Permission denied` da un nome che make aveva
       appena dichiarato installato. */
    const tmp5 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pge-tilde-")));
    try {
      const copy = path.join(tmp5, "checkout");
      const home = path.join(tmp5, "casa");
      fs.mkdirSync(path.join(copy, "bin"), { recursive: true });
      fs.mkdirSync(home);
      fs.copyFileSync(path.join(repo, "Makefile"), path.join(copy, "Makefile"));
      fs.copyFileSync(BIN, path.join(copy, "bin", "pge-ui"));
      fs.chmodSync(path.join(copy, "bin", "pge-ui"), 0o755);
      const runIn = (bindir) => spawnSync("make", ["-C", copy, "install-cli",
        "BINDIR=" + bindir], { env: { ...process.env, HOME: home }, encoding: "utf8" });

      const t = runIn("~/.local/bin");
      assert("BINDIR=~/.local/bin finisce sotto HOME, non in una cartella `~`",
        t.status === 0 &&
        fs.existsSync(path.join(home, ".local", "bin", "pge-ui")),
        (t.stdout || "") + (t.stderr || ""));
      // La ricetta gira con cwd = checkout (`make -C`): e' li' che la cartella
      // spuria nasceva.
      assert("...senza fabbricare una cartella `~` nel checkout",
        fs.readdirSync(copy).sort().join(",") === "Makefile,bin",
        fs.readdirSync(copy).join(", "));

      const u = runIn("~nessuno/bin");
      assert("un `~utente` che nessuno puo' espandere ferma l'installazione",
        u.status !== 0 && fs.readdirSync(copy).sort().join(",") === "Makefile,bin",
        `exit ${u.status}\n      ` + ((u.stdout || "") + (u.stderr || "")));

      /* Un BINDIR RELATIVO e' l'ultima grafia della famiglia, e riusciva:
         `mybin` non nomina una cartella finche' non si dice rispetto a cosa, e
         make lo risolve sulla PROPRIA cwd — che `make -C` mette nel checkout e
         `make -f` nella cartella da cui l'hai lanciato. La stessa ambiguita'
         che CLI_SRC toglie al sorgente del link, lasciata aperta sulla
         destinazione. Il link nasceva, la riga di successo lo annunciava, e
         l'avviso chiudeva consigliando `export PATH="mybin:$PATH"` — una voce
         di PATH relativa, cioe' un comando che risponde solo dalla cartella
         giusta. Le due sonde misurano i due modi di invocare make, perche' e'
         proprio la loro differenza a rendere quel path privo di significato. */
      const rel = runIn("mybin");
      assert("un BINDIR relativo ferma l'installazione, invece di sceglierne una",
        rel.status !== 0 &&
        fs.readdirSync(copy).sort().join(",") === "Makefile,bin",
        `exit ${rel.status}\n      ` + ((rel.stdout || "") + (rel.stderr || "")));
      const relF = spawnSync("make", ["-f", path.join(copy, "Makefile"), "install-cli",
        "BINDIR=mybin"], { cwd: home, env: { ...process.env, HOME: home },
        encoding: "utf8" });
      assert("...anche via `make -f`, dove si sarebbe risolto altrove ancora",
        relF.status !== 0 && !fs.existsSync(path.join(home, "mybin")),
        `exit ${relF.status}\n      ` + ((relF.stdout || "") + (relF.stderr || "")));

      /* Senza HOME il default non e' piu' un path: `$(HOME)/.local/bin`
         diventava `/.local/bin` — non comincia per `~`, quindi nessuna delle
         guardie lo vedeva, e su una macchina dove `/` e' scrivibile (un
         container, un runner di CI) l'install RIUSCIVA, annunciata sotto la
         riga di successo in una cartella che nessun PATH ha. E' la terza
         grafia della stessa famiglia, e l'unica che il commento del Makefile
         dichiarava gia' fermata.

         Si misura sul messaggio e non solo sull'uscita: dove `/` non e'
         scrivibile quel `mkdir` falliva comunque, cioe' un verde per il
         motivo sbagliato. */
      const noHomeEnv = { ...process.env };
      delete noHomeEnv.HOME;
      const nh = spawnSync("make", ["-C", copy, "install-cli"],
        { env: noHomeEnv, encoding: "utf8" });
      assert("HOME non impostato: install-cli si ferma, e nomina BINDIR",
        nh.status !== 0 && /BINDIR/.test(nh.stderr || ""),
        `exit ${nh.status}\n      ` + ((nh.stdout || "") + (nh.stderr || "")));
      assert("...senza lasciare un link sotto la radice",
        !fs.existsSync(path.join("/", ".local", "bin", "pge-ui")),
        "/.local/bin/pge-ui: annunciato installato e irraggiungibile");

      // Stessa fine per un BINDIR vuoto scritto a mano: prima era un
      // `mkdir: cannot create directory ''`, che non dice cosa fare.
      const ev = runIn("");
      assert("BINDIR vuoto: si ferma anche lui, dicendo cosa manca",
        ev.status !== 0 && /BINDIR/.test(ev.stderr || ""),
        `exit ${ev.status}\n      ` + ((ev.stdout || "") + (ev.stderr || "")));

      fs.chmodSync(path.join(copy, "bin", "pge-ui"), 0o644);
      const dest5 = path.join(tmp5, "bin");
      const nx = runIn(dest5);
      assert("sorgente senza bit x → install-cli si ferma, invece di linkarlo",
        nx.status !== 0 && !fs.existsSync(path.join(dest5, "pge-ui")),
        `exit ${nx.status}\n      ` + ((nx.stdout || "") + (nx.stderr || "")));
    } finally {
      fs.rmSync(tmp5, { recursive: true, force: true });
    }

    /* E l'ultima grafia di «annunciato installato, non parte» — l'unica che
       non nasce da un BINDIR scritto male, ma da una piattaforma intera.
       `bin/pge-ui` risolve il proprio path con `realpath`, ed e' cosi' che
       attraversa il symlink che install-cli sta per creare; senza, si ferma a
       ogni invocazione (sonda piu' sopra, ed e' la scelta giusta: l'alternativa
       era risolvere REPO su $PWD). Ma la RICETTA `realpath` non lo usa, quindi
       l'install riusciva lo stesso, stampava la riga di successo e lasciava sul
       PATH un comando che esce 1 per sempre. `realpath` non e' POSIX: su macOS
       arriva con la 12.3, cioe' e' il sistema di una parte dei destinatari di
       questo repo.

       Il PATH ridotto porta solo cio' che la ricetta adopera (`make`, `mkdir`,
       `ln` — il resto e' builtin di sh, che sta a un path assoluto). E la sonda
       ha bisogno del suo controllo: con un PATH cosi' stretto un fallimento
       qualunque terrebbe verde un assert scritto su `status !== 0`, quindi lo
       stesso PATH con dentro `realpath` deve riuscire. */
    const mkPath = which("make"), mkdirPath = which("mkdir"), lnPath = which("ln");
    if (!mkPath || !mkdirPath || !lnPath) {
      console.log("  SKIP il guardiano su realpath (make/mkdir/ln non tutti sul PATH)");
    } else {
      const tmp6 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pge-realpath-")));
      try {
        const copy  = path.join(tmp6, "checkout");
        const home6 = path.join(tmp6, "casa");
        const only  = path.join(tmp6, "path-ridotto");
        const dest6 = path.join(tmp6, "bin");
        fs.mkdirSync(path.join(copy, "bin"), { recursive: true });
        fs.mkdirSync(home6); fs.mkdirSync(only);
        fs.copyFileSync(path.join(repo, "Makefile"), path.join(copy, "Makefile"));
        fs.copyFileSync(BIN, path.join(copy, "bin", "pge-ui"));
        fs.chmodSync(path.join(copy, "bin", "pge-ui"), 0o755);
        for (const [n, t] of [["make", mkPath], ["mkdir", mkdirPath], ["ln", lnPath]]) {
          fs.symlinkSync(t, path.join(only, n));
        }
        const runBare = () => spawnSync("make", ["-C", copy, "install-cli",
          "BINDIR=" + dest6], { env: { PATH: only, HOME: home6 }, encoding: "utf8" });

        const noRp = runBare();
        assert("realpath assente → install-cli si ferma, invece di linkare un comando che non parte",
          noRp.status !== 0 && /realpath/.test(noRp.stderr || "") &&
          !fs.existsSync(path.join(dest6, "pge-ui")),
          `exit ${noRp.status}\n      ` + ((noRp.stdout || "") + (noRp.stderr || "")));

        fs.symlinkSync(rpHere, path.join(only, "realpath"));
        const withRp = runBare();
        assert("controllo: con realpath sullo stesso PATH ridotto, install-cli riesce",
          withRp.status === 0 && fs.existsSync(path.join(dest6, "pge-ui")),
          `exit ${withRp.status}\n      ` + ((withRp.stdout || "") + (withRp.stderr || "")));
      } finally {
        fs.rmSync(tmp6, { recursive: true, force: true });
      }
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
