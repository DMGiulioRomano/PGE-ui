/* =============================================================================
 * test-semantics-store.js — l'asse "semantica del motore" di backend.js (#133).
 *
 * `render-status.js` decide il colore del pallino a partire da due numeri: la
 * `VARIATION_SEMANTICS_VERSION` del motore che il bridge ha davanti adesso, e
 * quella con cui ogni stem e' stato scritto. `test-render-status.js` verifica la
 * DECISIONE; qui si verifica da dove arriva il primo dei due, che e' la meta'
 * che nessuna esecuzione toccava:
 *
 *   - la lettura dal bridge (`semanticsVersion`), che deve poter vedere un bump
 *     avvenuto sotto un `make serve` acceso — un `git checkout` nel repo
 *     fratello e' esattamente lo scenario. Il lato bridge lo fa gia' apposta
 *     (`engine_introspect` invalida la cache sull'mtime, con
 *     `test_engine_semantics_version_sees_a_live_bump` a pretenderlo); questo
 *     e' lo stesso argomento un livello piu' in su.
 *
 * Idioma: il backend VERO guidato con `fetch` e `localStorage` finti, come in
 * test-stem-index.js.
 *
 * Run: node test-semantics-store.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

/* --- localStorage finto ---------------------------------------------------- */
let store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

/* --- bridge finto ---------------------------------------------------------- */
let SEM_VERSION = 3;     // cosa risponde GET /semantics-version
let SEM_DOWN = false;    // ...o non risponde affatto
let semFetches = 0;      // quante volte e' stato davvero interrogato
let NDJSON = [];         // le righe che POST /render restituisce

// Il body NDJSON come lo vede backend.js: `res.body.getReader()`, una riga per
// chunk. Non e' una semplificazione — il parser accumula in un buffer e taglia
// sui newline, quindi la granularita' dei chunk non cambia il risultato.
function ndjsonBody(lines) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i >= lines.length) return { done: true, value: undefined };
        return { done: false, value: enc.encode(JSON.stringify(lines[i++]) + "\n") };
      },
    }),
  };
}

global.fetch = (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/semantics-version")) {
    semFetches++;
    if (SEM_DOWN) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, version: SEM_VERSION }) });
  }
  if (u.endsWith("/render")) {
    return Promise.resolve({ ok: true, body: ndjsonBody(NDJSON) });
  }
  if (u.includes("/stems/")) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ basename: "proj", stems: [] }) });
  }
  // /config e simili: il backend le tenta al volo e le assorbe.
  return Promise.reject(new Error("unexpected fetch " + u));
};

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

const BACKEND_SRC = fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8");
const APP_SRC     = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

function sem(basename) {
  try { return (JSON.parse(store["pge-local-sem"] || "{}"))[basename] || null; }
  catch { return null; }
}

(async () => {

/* ===========================================================================
 * 1. La versione del motore si RILEGGE.
 *
 * Il numero non e' una proprieta' della sessione dell'editor: e' una proprieta'
 * del motore che sta accanto, e quello puo' cambiare sotto i piedi (un `git
 * checkout` nel repo fratello, un pull, un aggiornamento). Memorizzarlo per
 * tutta la sessione trasforma un bump in una FALSA LUCE VERDE — stem che il
 * motore rifara' diversi, mostrati verdi fino al reload della pagina — e nel
 * verso in cui l'asse esiste proprio per non sbagliare.
 * ========================================================================= */
console.log("\n── un bump del motore sotto la sessione arriva al pallino ──");
{
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  SEM_VERSION = 3; SEM_DOWN = false; semFetches = 0;

  const first = await backend.semanticsVersion();
  assert("la prima lettura prende il numero dal bridge", first === 3, `first=${first}`);
  assert("...con una fetch sola", semFetches === 1, `fetches=${semFetches}`);

  SEM_VERSION = 4;   // il motore bumpa sotto un `make serve` acceso

  const cached = await backend.semanticsVersion();
  assert("una lettura qualunque resta sulla risposta gia' avuta", cached === 3, `cached=${cached}`);
  assert("...senza ri-chiedere", semFetches === 1, `fetches=${semFetches}`);

  const fresh = await backend.semanticsVersion({ refresh: true });
  assert("una RILETTURA vede il bump", fresh === 4, `fresh=${fresh}`);
  assert("...e ha davvero interrogato il bridge", semFetches === 2, `fetches=${semFetches}`);

  /* Il vincolo che tiene in piedi i due lati: app.jsx rilegge PRIMA di partire e
     mette il numero nel ref, backend.run() lo richiede in FONDO per registrarlo
     sugli stem. Se la seconda lettura potesse cadere su un'altra risposta, i due
     lati registrerebbero versioni diverse dello stesso giro. */
  SEM_VERSION = 5;
  const during = await backend.semanticsVersion();
  assert("dentro un render il numero resta quello riletto", during === 4, `during=${during}`);
}

console.log("\n── un bridge che non risponde non condanna la sessione ──");
{
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  SEM_DOWN = true; SEM_VERSION = 3; semFetches = 0;

  const down = await backend.semanticsVersion({ refresh: true });
  assert("bridge giu' → non si sa (null, non un numero)", down === null, `down=${down}`);

  /* E il fallimento non lascia in giro il numero di prima: chi legge senza
     rilettura — `run()`, in fondo al render — deve ricevere ESATTAMENTE quello
     che la rilettura ha dato a chi l'ha chiesta, o i due lati divergono. */
  const after = await backend.semanticsVersion();
  assert("...e la lettura senza rilettura dice la stessa cosa", after === null, `after=${after}`);

  SEM_DOWN = false; SEM_VERSION = 7;
  const back = await backend.semanticsVersion({ refresh: true });
  assert("il bridge torna su e il numero arriva", back === 7, `back=${back}`);
}

console.log("\n── i tre punti di rilettura chiedono davvero una rilettura (sorgente) ──");
{
  assert("app.jsx passa refresh:true, non si accontenta della cache",
         /backend\.semanticsVersion\(\{\s*refresh:\s*true\s*\}\)/.test(APP_SRC));
  assert("run() invece NON rilegge: il numero del render e' quello gia' letto",
         /const sem = await semanticsVersion\(\);/.test(BACKEND_SRC));
  assert("refreshEngineSem e' chiamata in tre punti",
         (APP_SRC.match(/refreshEngineSem\(\)/g) || []).length >= 4);   // 1 def + 3 usi
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
