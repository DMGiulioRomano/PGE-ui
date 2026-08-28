/* =============================================================================
 * harness.js — il runner delle suite di parita' (issue #133).
 *
 * Un test di parita' non e' un test come gli altri: puo' non poter girare. Il
 * motore e' un repo fratello, e su un clone appena fatto non c'e'. Il modo in
 * cui questo file tratta quel caso E' il punto della issue.
 *
 * ## Un caso saltato non e' un caso passato
 *
 * La suite si dichiara come una LISTA di casi con l'etichetta scritta prima di
 * girare. Cosi', quando l'oracolo non c'e', il runner puo' dire quanti e quali
 * casi non hanno girato invece di stampare "0 failed" e uscire verde — che e'
 * esattamente il difetto che il canarino #131 ha gia' chiuso altrove.
 *
 * ## Quando saltare e' un fallimento
 *
 * `strict` = un caso saltato fa uscire 1, e si accende SOLO da
 * `PGE_PARITY_STRICT` (1/true/yes). In CI e' il workflow a passarla, quando il
 * passo di checkout del motore ha riportato successo — la stessa regola, e la
 * stessa riga, di `PGE_REQUIRE_ENGINE_FIXTURES`.
 *
 * Il runner non decide da se': lo faceva, con `CI && engineRoot() !== null`, e
 * quella condizione si spegneva esattamente sul caso che doveva intercettare.
 * `engineRoot()` guarda il filesystem, quindi un checkout riuscito che non
 * lascia i sorgenti dove i test li cercano faceva saltare tutte le suite col
 * job verde. Chi sa se il checkout e' riuscito e' il workflow, non il runner.
 *
 * In CI senza motore si salta e basta: il checkout nel workflow e'
 * `continue-on-error` apposta (una PR da un fork non ha il token), e trasformare
 * quella condizione in un fallimento renderebbe rosse PR che non c'entrano.
 * Il salto resta rumoroso: elenca i casi e li conta.
 *
 * ## Uso
 *
 *     const { parity } = require("./harness.js");
 *     parity({
 *       suite: "fingerprint",
 *       why: "una riga sul patto che questa suite verifica",
 *       cases: [
 *         { label: "…", run: async (ask, assert, ctx) => { … } },
 *       ],
 *     });
 *
 * `run` riceve:
 *   ask     — `oracle.ask`, in forma singola o a blocco (vedi oracle.js)
 *   assert  — `(label, cond, extra)`, come nelle suite node esistenti
 *   ctx     — { oracle, engineRoot, commit, jsyaml, note }
 *
 * `ctx.note(label, righe)` è per l'informativo: un elenco che documenta cosa è
 * successo senza discriminare niente (quali coppie cadono nella banda
 * int/float, quali corpi il motore rifiuta e la UI lascia passare). Prima
 * quella roba viaggiava come `assert(label, true, elenco)`, che ha due difetti
 * in una PR il cui punto è che un caso saltato non è un caso passato: l'`extra`
 * si stampa solo sul ramo FAIL, quindi l'elenco non compariva mai, e un assert
 * che non può fallire gonfia il conteggio con qualcosa che non parla.
 * ===========================================================================*/

const fs = require("fs");
const path = require("path");
const { openOracle } = require("./oracle.js");

/* La radice del motore. Stessa convenzione delle fixture in
 * test-yaml-bridge.js: repo fratello accanto a PGE-ui. PGE_ENGINE_ROOT la
 * scavalca (checkout altrove, o un motore vecchio da misurare apposta). */
function engineRoot() {
  const fromEnv = process.env.PGE_ENGINE_ROOT;
  const guess = fromEnv || path.join(__dirname, "../../..", "PythonGranularEngine");
  const abs = path.resolve(guess);
  return fs.existsSync(path.join(abs, "src", "pge")) ? abs : null;
}

function truthy(v) {
  return v != null && ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

/* js-yaml vive in tests/node/node_modules (l'unico package.json del repo). Le
 * suite di parita' che serializzano uno stream ne hanno bisogno; quelle che
 * non lo fanno non devono fallire per la sua assenza, quindi torna null. */
function loadJsYaml() {
  const candidates = ["js-yaml", path.join(__dirname, "../node/node_modules/js-yaml")];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* prossimo */ }
  }
  return null;
}

/* Carica i moduli `window.*` del repo dentro un `global.window` finto, come
 * fanno le suite in tests/node/. Torna il window popolato. */
function loadUiLibs(names, extraGlobals = {}) {
  const jsyaml = loadJsYaml();
  global.window = Object.assign({ jsyaml }, global.window || {});
  Object.assign(global, extraGlobals);
  for (const n of names) {
    const p = path.join(__dirname, "../../src/lib", n);
    // eslint-disable-next-line no-eval
    eval(fs.readFileSync(p, "utf8"));
  }
  return global.window;
}

function commitLine(commit) {
  if (!commit || !commit.sha) return "motore: commit sconosciuto (checkout senza .git)";
  return `motore @ ${commit.short}${commit.dirty ? " (albero sporco)" : ""} — ${commit.subject}`;
}

/* ---------------------------------------------------------------------------
 * Il verdetto e' un handler `exit`, non una riga in fondo alla funzione.
 *
 * Stessa regola di ogni file in tests/node/, e per la stessa ragione, che qui
 * si vede meglio che altrove: con un'uscita brutale alla fine di `parity`,
 * tutto cio' che si risolve DOPO la catena di await del caso viene buttato via.
 * Un `ask` senza `await` con un assert sopra stampava "1 passed, 0 failed" e
 * usciva 0, mentre quell'assert era un FAIL. Un `await` dimenticato in una
 * suite di parita' era verde — la tesi di questa PR applicata al suo runner.
 *
 * Con `process.exitCode` il microtask viene drenato prima del riepilogo, e il
 * FAIL arriva. Lo stato e' di modulo perche' l'handler deve vederlo: c'e' una
 * sola suite per processo, come in tests/node/.
 * ------------------------------------------------------------------------- */
let pass = 0, fail = 0;
const notRun = [];
let verdict = null;   // { bar, commit } una volta che la suite ha girato

process.on("exit", (code) => {
  if (verdict === null) return;   // bail: il blocco di salto ha gia' parlato
  console.log(`\n${verdict.bar}`);
  console.log(`${pass} passed, ${fail} failed  ·  ${commitLine(verdict.commit)}`);
  if (notRun.length) {
    console.error(`${notRun.length} caso/i interrotto/i: ${notRun.join(", ")}`);
  }
  if (code && !fail) {
    console.error("interrotto prima della fine: il riepilogo e' parziale");
  }
  if (fail > 0) {
    console.error(
      `\nUna parita' rotta ha due letture: il mirror JS ha sbagliato, oppure il\n` +
      `motore e' cambiato. Il commit qui sopra e' quello contro cui il confronto\n` +
      `e' stato fatto — confrontalo con quello registrato in tests/parity/README.md.`);
    process.exitCode = 1;
  }
});

/* Uscita anticipata senza `process.exit`: `bail` alza questo, `run` lo assorbe.
 * Serve perche' senza il taglio brutale il codice dopo `bail(...)` continuerebbe
 * (openOracle su una root nulla). */
class BailOut extends Error {}

async function parity({ suite, why, cases }) {
  // Strict = un caso saltato fa uscire 1, e la decisione arriva da FUORI.
  //
  // Prima era `strictEnv || (CI && root !== null)`, e quella seconda meta' si
  // spegneva esattamente sulla condizione che doveva intercettare: `root` viene
  // da `engineRoot()`, cioe' da un test sul filesystem, quindi il salto piu'
  // probabile in CI — il motore non c'e', o non e' dove lo cerchiamo — era
  // l'unico che non diventava mai rosso. Un checkout che RIPORTA successo ma non
  // lascia i sorgenti dove i test li cercano faceva saltare tutte e cinque le
  // suite col job verde: la stessa forma della trappola conclusion/outcome di
  // #132, spostata dal workflow al runner.
  //
  // Adesso l'informazione sta dove la si ha davvero: il workflow sa se il
  // checkout e' riuscito e passa PGE_PARITY_STRICT di conseguenza, come gia'
  // fa con PGE_REQUIRE_ENGINE_FIXTURES.
  const strict = truthy(process.env.PGE_PARITY_STRICT);
  const root = engineRoot();

  const bar = "─".repeat(60);
  console.log(`\n${bar}\nparita' · ${suite}`);
  if (why) console.log(why);
  console.log(bar);

  /* --- il motore non c'e', o l'oracolo non parte -------------------------
   * Due guasti diversi, due consigli diversi: `hint` arriva dal chiamante.
   * Prima la coda era una sola e parlava sempre del checkout, quindi con
   * PGE_PARITY_PYTHON=/bin/false si veniva mandati a clonare un motore che
   * c'era gia'. */
  /* Dichiarato qui, non piu' in basso, perche' `bail` deve poterlo chiudere:
     un salto che avviene dopo l'apertura dell'oracolo lascerebbe vivo il
     processo python, e node non esce finche' i suoi stdio sono aperti — la
     suite resta appesa invece di fallire. Vale per ogni bail futuro, non solo
     per quello sulle op indisponibili. */
  let oracle;

  function bail(reason, hint) {
    if (oracle) oracle.close();
    console.error(`\n  ${strict ? "PARITA' NON VERIFICATA" : "PARITA' SALTATA"}: ${reason}`);
    console.error(`  ${cases.length} cas${cases.length === 1 ? "o" : "i"} non ${cases.length === 1 ? "ha" : "hanno"} girato:`);
    for (const c of cases) console.error(`    · ${c.label}`);
    if (strict) {
      console.error(
        `\n  Con PGE_PARITY_STRICT=1 un caso saltato e' un fallimento: nessuno\n` +
        `  di questi confronti e' avvenuto, quindi il verde di questa suite non\n` +
        `  direbbe niente. In CI la variabile arriva dal workflow quando il\n` +
        `  checkout del motore ha riportato successo.`);
      process.exitCode = 1;
      throw new BailOut();
    }
    console.error(hint);
    throw new BailOut();
  }

  if (root === null) {
    bail(`nessun motore in ${process.env.PGE_ENGINE_ROOT || "../PythonGranularEngine"}`,
      `\n  Per eseguirli serve un checkout di PythonGranularEngine accanto a\n` +
      `  PGE-ui, oppure PGE_ENGINE_ROOT=/path/to/PythonGranularEngine.\n` +
      `  PGE_PARITY_STRICT=1 rende questo salto un fallimento.`);
  }

  try {
    oracle = await openOracle({ root });
  } catch (err) {
    bail(`l'oracolo non parte: ${err.message}`,
      `\n  Il motore c'e' (${root}): a mancare e' l'interprete o l'import.\n` +
      `  PGE_PARITY_PYTHON=/path/to/python sceglie quello da usare; l'errore\n` +
      `  qui sopra porta con se' lo stderr del processo.\n` +
      `  PGE_PARITY_STRICT=1 rende questo salto un fallimento.`);
  }

  console.log(`  ${commitLine(oracle.hello.engine_commit)}`);
  console.log(`  python ${oracle.hello.python} · ${oracle.hello.ops.length} op`);
  const unavailable = oracle.hello.unavailable || {};
  for (const [op, whyNot] of Object.entries(unavailable)) {
    console.log(`  ATTENZIONE op indisponibile: ${op} — ${whyNot}`);
  }
  /* Un'op che non risponde e' un buco nella parita' esattamente come un caso
     che non gira, e finora era solo una riga stampata: la suite proseguiva e
     chiudeva verde su quello che restava.
     Sotto strict e' un fallimento, e lo e' senza distinguere quali op questa
     suite usi: l'elenco arriva dall'oracolo che le prova TUTTE all'avvio, le
     cinque suite girano nello stesso `make tests-parity`, e un buco vale per
     tutte. Non e' nemmeno un caso atteso: nessuna op deve dipendere dal venv
     del motore (in CI il job node fa il checkout e basta), quindi con il motore
     presente un'op indisponibile significa che quella regola e' saltata. */
  const holes = Object.keys(unavailable);
  if (strict && holes.length) {
    bail(`${holes.length} op non risponde/rispondono: ${holes.join(", ")}`,
      `\n  Nessuna op deve richiedere il venv del motore: verifica quale import\n` +
      `  l'ha introdotta (il motivo e' stampato qui sopra, op per op).`);
  }

  /* --- esecuzione -------------------------------------------------------- */
  /* Informativo, non un'asserzione: si vede sempre e non entra nel conteggio.
     `righe` può essere una stringa, un array, o mancare del tutto. */
  function note(label, righe) {
    console.log("  ·   " + label);
    const list = Array.isArray(righe) ? righe : (righe ? [righe] : []);
    for (const r of list) console.log("        " + r);
  }
  const ctx = {
    oracle,
    engineRoot: root,
    commit: oracle.hello.engine_commit,
    jsyaml: loadJsYaml(),
    unavailable,
    note,
  };
  const ask = (a, b, c) => oracle.ask(a, b, c);

  for (const c of cases) {
    console.log(`\n── ${c.label} ──`);
    const assert = (label, cond, extra) => {
      if (cond) { pass++; console.log("  OK  " + label); }
      else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
    };
    try {
      await c.run(ask, assert, ctx);
    } catch (err) {
      // Un guasto dentro un caso non e' un assert fallito: il caso non ha
      // girato. Va contato fra i non eseguiti, o il totale mentirebbe.
      fail++;
      notRun.push(c.label);
      console.error(`FAIL  il caso non ha potuto girare: ${err.message}`);
    }
  }

  oracle.close();
  // Da qui in poi parla l'handler `exit`: cosi' un assert che si risolve dopo
  // questa riga entra ancora nel conteggio.
  verdict = { bar, commit: ctx.commit };
}

/* Le suite sono `async` in cima: senza questo un rigetto non gestito uscirebbe
 * 0 su node vecchi e il fallimento passerebbe per un successo. */
function run(spec) {
  parity(spec).catch((err) => {
    if (err instanceof BailOut) return;   // il blocco di salto ha gia' parlato
    console.error("\nharness: guasto non gestito");
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}

module.exports = { parity: run, engineRoot, loadUiLibs, loadJsYaml, commitLine };
