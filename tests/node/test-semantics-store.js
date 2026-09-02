/* =============================================================================
 * test-semantics-store.js — l'asse "semantica del motore" di backend.js (#133).
 *
 * `render-status.js` decide il colore del pallino a partire da due numeri: la
 * `VARIATION_SEMANTICS_VERSION` del motore che il bridge ha davanti adesso, e
 * quella con cui ogni stem e' stato scritto. `test-render-status.js` verifica la
 * DECISIONE; qui si verifica da dove arrivano i due numeri, che e' la meta'
 * che nessuna esecuzione toccava:
 *
 *   - la lettura dal bridge (`semanticsVersion`), che deve poter vedere un bump
 *     avvenuto sotto un `make serve` acceso — un `git checkout` nel repo
 *     fratello e' esattamente lo scenario. Il lato bridge lo fa gia' apposta
 *     (`engine_introspect` invalida la cache sull'mtime, con
 *     `test_engine_semantics_version_sees_a_live_bump` a pretenderlo); questo
 *     e' lo stesso argomento un livello piu' in su.
 *   - la persistenza per stem (`loadSemantics` / `_persistSem`), che prima era
 *     difesa da sole guardie sorgente: `_persistSem` reso un no-op lasciava la
 *     suite verde, mentre il comportamento vero sarebbe stato GIALLO PERMANENTE
 *     su ogni stem a ogni reload (versione registrata mai presente, motore
 *     noto), cioe' l'unico esito che il design dichiara inaccettabile.
 *
 * Idioma: il backend VERO guidato con `fetch` e `localStorage` finti, come in
 * test-stem-index.js.
 *
 * Run: node test-semantics-store.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

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

const BACKEND_SRC = SG.codeOf(path.join(__dirname, "../../src/lib/backend.js"));
const APP_SRC     = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

function sem(basename) {
  try { return (JSON.parse(store["pge-local-sem"] || "{}"))[basename] || null; }
  catch { return null; }
}

/* Il corpo e' asincrono; l'handler `exit` sta FUORI, a livello di modulo.
 * Registrato dentro, un'eccezione prima di quella riga lo fa non esistere: il
 * file esce senza riepilogo E senza "interrotto prima della fine", cioe' le due
 * righe che sono l'intero contratto. Misurato rinominando un simbolo di
 * backend.js: exit 1 e nessun verdetto. */
let bodyDone = false;
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
  SEM_DOWN = false; SEM_VERSION = 3; semFetches = 0;

  // Prima una risposta buona: e' l'ordine che conta. Con la cella mai scritta il
  // ripiego su `null` e' gratis; il caso vero e' il bridge che HA risposto e poi
  // cade — li' il numero vecchio e' ancora in mano.
  assert("una risposta buona arriva e resta", await backend.semanticsVersion() === 3);

  SEM_DOWN = true;
  const down = await backend.semanticsVersion({ refresh: true });
  assert("bridge giu' → non si sa (null, non il numero di prima)", down === null, `down=${down}`);

  /* E il fallimento non lascia in giro il numero di prima: chi legge senza
     rilettura — `run()`, in fondo al render — deve ricevere ESATTAMENTE quello
     che la rilettura ha dato a chi l'ha chiesta, o i due lati registrerebbero
     versioni diverse dello stesso giro. */
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

/* ===========================================================================
 * 2. La meta' persistente dell'asse, ESEGUITA.
 *
 * `_persistSem` reso un no-op, o `loadSemantics` che torna sempre {}, non
 * spengono l'asse: lo bloccano sul giallo. Un giro completo di `render.run()`
 * e' l'unica cosa che lo dice.
 * ========================================================================= */
console.log("\n── un render registra la versione, anche a vuoto ──");
{
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  SEM_DOWN = false; SEM_VERSION = 3;
  await backend.semanticsVersion({ refresh: true });

  // Uno `stream-done` con cached:true e' il percorso su cui poggia la promessa
  // "quel giallo si spegne da solo al primo giro, anche a vuoto": il motore
  // emette l'evento anche per gli stream che SALTA (render_pipeline.py), e
  // backend.js registra la versione li' come su un render vero.
  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: true },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", streams: [{ id: "stream1" }] },
    () => {});

  assert("pge-local-sem porta la versione dello stem",
         JSON.stringify(sem("proj")) === JSON.stringify({ stream1: 3 }),
         `pge-local-sem = ${store["pge-local-sem"]}`);
  const loaded = await backend.render.loadSemantics("proj");
  assert("loadSemantics la rilegge",
         JSON.stringify(loaded) === JSON.stringify({ stream1: 3 }),
         `loadSemantics = ${JSON.stringify(loaded)}`);
}

console.log("\n── un render parziale non cancella le versioni degli altri stem ──");
{
  store = { "pge-local-sem": JSON.stringify({ proj: { stream1: 1, stream2: 1 } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  SEM_DOWN = false; SEM_VERSION = 3;
  await backend.semanticsVersion({ refresh: true });

  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", streams: [{ id: "stream1" }, { id: "stream2" }] },
    () => {});

  const now = sem("proj");
  assert("lo stem reso prende la versione di adesso", now && now.stream1 === 3, JSON.stringify(now));
  assert("quello non toccato tiene la sua", now && now.stream2 === 1, JSON.stringify(now));
}

console.log("\n── col numero ignoto la voce si CANCELLA, non resta indietro ──");
{
  store = { "pge-local-sem": JSON.stringify({ proj: { stream1: 3, stream2: 3 } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  SEM_DOWN = true;
  await backend.semanticsVersion({ refresh: true });

  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", streams: [{ id: "stream1" }] },
    () => {});

  const now = sem("proj");
  // Una versione VECCHIA su uno stem NUOVO e' peggio di nessuna versione: la
  // prima e' un'affermazione falsa, la seconda e' la verita'.
  assert("lo stem appena reso perde la versione di prima", now && !("stream1" in now),
         JSON.stringify(now));
  assert("gli altri restano dove sono", now && now.stream2 === 3, JSON.stringify(now));
  SEM_DOWN = false;
}

  bodyDone = true;
})().catch(e => {
  /* Senza questo catch e' una unhandled rejection: exit 1 con lo stack e
     nessun riepilogo. */
  fail++;
  console.error("FAIL  il corpo della suite e' morto a meta'\n      " +
    (e && e.stack ? e.stack : String(e)));
});

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file: cosi'
// una sezione appesa dopo continua a contare, invece di stampare FAIL e uscire
// 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  if (!bodyDone) {
    fail++;
    console.error("FAIL  il corpo della suite non e' arrivato in fondo: " +
      "i suoi assert non hanno contato");
  }
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
