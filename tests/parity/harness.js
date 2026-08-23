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
 * `strict` = un caso saltato fa uscire 1. Si accende:
 *   - se `PGE_PARITY_STRICT` e' 1/true/yes — la leva manuale;
 *   - in CI **quando il motore e' presente**. Li' non c'e' nessuna ragione
 *     legittima per cui una domanda al motore non dovrebbe ricevere risposta,
 *     quindi ogni salto e' un guasto.
 *
 * In CI senza motore si salta e basta: il checkout del motore nel workflow e'
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
 *   ctx     — { oracle, engineRoot, commit, jsyaml }
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

async function parity({ suite, why, cases }) {
  const strictEnv = truthy(process.env.PGE_PARITY_STRICT);
  const root = engineRoot();
  const strict = strictEnv || (truthy(process.env.CI) && root !== null);

  const bar = "─".repeat(60);
  console.log(`\n${bar}\nparita' · ${suite}`);
  if (why) console.log(why);
  console.log(bar);

  /* --- il motore non c'e', o l'oracolo non parte ------------------------- */
  function bail(reason) {
    console.error(`\n  ${strict ? "PARITA' NON VERIFICATA" : "PARITA' SALTATA"}: ${reason}`);
    console.error(`  ${cases.length} cas${cases.length === 1 ? "o" : "i"} non ${cases.length === 1 ? "ha" : "hanno"} girato:`);
    for (const c of cases) console.error(`    · ${c.label}`);
    if (strict) {
      console.error(
        `\n  In CI con il motore presente (o con PGE_PARITY_STRICT=1) un caso\n` +
        `  saltato e' un fallimento: nessuno di questi confronti e' avvenuto,\n` +
        `  quindi il verde di questa suite non direbbe niente.`);
      process.exit(1);
    }
    console.error(
      `\n  Per eseguirli serve un checkout di PythonGranularEngine accanto a\n` +
      `  PGE-ui, oppure PGE_ENGINE_ROOT=/path/to/PythonGranularEngine.\n` +
      `  PGE_PARITY_STRICT=1 rende questo salto un fallimento.`);
    process.exit(0);
  }

  if (root === null) {
    bail(`nessun motore in ${process.env.PGE_ENGINE_ROOT || "../PythonGranularEngine"}`);
  }

  let oracle;
  try {
    oracle = await openOracle({ root });
  } catch (err) {
    bail(`l'oracolo non parte: ${err.message}`);
  }

  console.log(`  ${commitLine(oracle.hello.engine_commit)}`);
  console.log(`  python ${oracle.hello.python} · ${oracle.hello.ops.length} op`);
  const unavailable = oracle.hello.unavailable || {};
  for (const [op, whyNot] of Object.entries(unavailable)) {
    console.log(`  ATTENZIONE op indisponibile: ${op} — ${whyNot}`);
  }

  /* --- esecuzione -------------------------------------------------------- */
  let pass = 0, fail = 0;
  const notRun = [];
  const ctx = {
    oracle,
    engineRoot: root,
    commit: oracle.hello.engine_commit,
    jsyaml: loadJsYaml(),
    unavailable,
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

  console.log(`\n${bar}`);
  console.log(`${pass} passed, ${fail} failed  ·  ${commitLine(ctx.commit)}`);
  if (notRun.length) {
    console.error(`${notRun.length} caso/i interrotto/i: ${notRun.join(", ")}`);
  }
  if (fail > 0) {
    console.error(
      `\nUna parita' rotta ha due letture: il mirror JS ha sbagliato, oppure il\n` +
      `motore e' cambiato. Il commit qui sopra e' quello contro cui il confronto\n` +
      `e' stato fatto — confrontalo con quello registrato in tests/parity/README.md.`);
  }
  process.exit(fail ? 1 : 0);
}

/* Le suite sono `async` in cima: senza questo un rigetto non gestito uscirebbe
 * 0 su node vecchi e il fallimento passerebbe per un successo. */
function run(spec) {
  parity(spec).catch((err) => {
    console.error("\nharness: guasto non gestito");
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { parity: run, engineRoot, loadUiLibs, loadJsYaml, commitLine };
