/* =============================================================================
 * test-semantics-store.js — i due assi di provenienza di backend.js
 * (#133 la semantica del motore, #151 il backend che ha scritto lo stem).
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
 * Il secondo asse (#151) e' la stessa forma e sta qui accanto al primo, non in
 * un file suo: i due record si scrivono nello STESSO blocco di `run()`, e
 * duplicare l'armatura (fetch e localStorage finti) vorrebbe dire due copie che
 * col tempo smettono di guidare lo stesso backend.
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

function rend(basename) {
  try { return (JSON.parse(store["pge-local-renderer"] || "{}"))[basename] || null; }
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
  // `run()` non rilegge, e non prende nemmeno la cella condivisa: il numero
  // del giro glielo passa il chiamante. Una rilettura di qualcun altro a meta'
  // render non puo' quindi cambiarlo sotto — e' la sola invariante su cui
  // poggia tutto il disegno, e stava scritta come garantita senza esserlo.
  assert("run() non rilegge la versione",
         !/const sem = await semanticsVersion\(\{/.test(BACKEND_SRC));
  assert("...e prende quella del giro da chi chiama",
         /opts\.semanticsVersion === undefined/.test(BACKEND_SRC),
         "con la cella condivisa i due lati sono due letture che si spera " +
         "coincidano, non la stessa variabile");
  assert("app.jsx passa a run() il numero che ha appena letto",
         /semOfThisRun = await refreshEngineSem\(\)/.test(APP_SRC) &&
         /semanticsVersion:\s*semOfThisRun/.test(APP_SRC),
         "passare `engineSemRef.current` sarebbe di nuovo una cella condivisa");
  assert("...e lo usa anche per gli stream-done, invece del ref",
         /setRenderedSem\([\s\S]{0,200}?semOfThisRun/.test(APP_SRC),
         "il ref lo riscrive chiunque rilegga, render in volo compreso");
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

/* Il numero deve restare lo stesso per tutto UN giro, ed e' il chiamante a
 * fissarlo: la cella `_semantics` e' unica e condivisa, e i tre punti di
 * rilettura (boot, cambio progetto, inizio render) non sono mutuamente
 * esclusivi col render in volo — l'effetto sul cambio progetto non ha una
 * guardia su `renderStatus.running`. Cliccare un altro progetto mentre il
 * render gira, con il motore mosso nel frattempo, faceva registrare la
 * versione NUOVA su stem che il motore aveva appena scritto leggendo la
 * VECCHIA: pallino verde su stem che rifara' diversi, cioe' il fallimento per
 * cui l'asse esiste. */
console.log("\n── la versione di un render la fissa il chiamante ──");
{
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  SEM_DOWN = false; SEM_VERSION = 3;
  const semOfThisRun = await backend.semanticsVersion({ refresh: true });

  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  // ...e a meta' giro qualcun altro rilegge: il motore e' stato bumpato.
  SEM_VERSION = 9;
  await backend.semanticsVersion({ refresh: true });

  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", streams: [{ id: "stream1" }],
      semanticsVersion: semOfThisRun },
    () => {});

  const now = sem("proj");
  assert("lo stem porta la versione con cui il motore l'ha scritto",
         now && now.stream1 === 3,
         `${JSON.stringify(now)} — 9 e' il numero di DOPO: quello stem e' ` +
         `stato scritto leggendo lo YAML alla 3`);
}

console.log("\n── senza il campo si ripiega sulla cella, non sul silenzio ──");
{
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  SEM_DOWN = false; SEM_VERSION = 7;
  await backend.semanticsVersion({ refresh: true });

  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", streams: [{ id: "stream1" }] },
    () => {});

  // Un chiamante che non lo passa non deve cancellare la voce: assente
  // significherebbe "non lo so", che li' sarebbe una bugia.
  assert("il campo assente non e' un numero ignoto",
         (sem("proj") || {}).stream1 === 7, JSON.stringify(sem("proj")));
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

/* ===========================================================================
 * 3. Il secondo record: il backend che ha scritto lo stem (#151).
 *
 * Mappa parallela a `pge-local-sem`, non un campo dentro l'hash — l'hash
 * risponde a "l'utente ha modificato lo YAML", e quale motore audio ha scritto
 * il file non e' una modifica dell'utente. Qui si verifica da dove arriva il
 * nome; `test-render-status.js` verifica cosa ne fa il pallino.
 * ========================================================================= */
console.log("\n── un render registra il backend, anche a vuoto ──");
{
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  SEM_DOWN = false; SEM_VERSION = 3;
  await backend.semanticsVersion({ refresh: true });

  // Come per la semantica, il percorso che regge la promessa "quel giallo si
  // spegne da solo al primo giro": lo `stream-done` di uno stream SALTATO.
  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: true },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy",
      streams: [{ id: "stream1" }] },
    () => {});

  assert("pge-local-renderer porta il backend dello stem",
         JSON.stringify(rend("proj")) === JSON.stringify({ stream1: "numpy" }),
         `pge-local-renderer = ${store["pge-local-renderer"]}`);
  const loaded = await backend.render.loadRenderers("proj");
  assert("loadRenderers lo rilegge",
         JSON.stringify(loaded) === JSON.stringify({ stream1: "numpy" }),
         `loadRenderers = ${JSON.stringify(loaded)}`);
  assert("e la semantica e' rimasta al suo posto, separata",
         (sem("proj") || {}).stream1 === 3,
         `pge-local-sem = ${store["pge-local-sem"]}`);
}

console.log("\n── il nome e' quello del GIRO, non una costante del modulo ──");
{
  // Oggi la UI cabla numpy, ma il record deve dire cosa ha girato davvero: e'
  // l'unica cosa che rende l'asse utile il giorno in cui il backend diventa
  // una scelta (#150). Un valore scritto dentro backend.js sarebbe verde su
  // qualunque cambio.
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "csound",
      streams: [{ id: "stream1" }] },
    () => {});
  assert("un render csound lascia scritto csound",
         (rend("proj") || {}).stream1 === "csound", JSON.stringify(rend("proj")));
}

console.log("\n── un render parziale non cancella il backend degli altri stem ──");
{
  store = { "pge-local-renderer": JSON.stringify({ proj: { stream1: "csound", stream2: "csound" } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy",
      streams: [{ id: "stream1" }, { id: "stream2" }] },
    () => {});

  const now = rend("proj");
  assert("lo stem reso prende il backend di adesso", now && now.stream1 === "numpy",
         JSON.stringify(now));
  assert("quello non toccato tiene il suo", now && now.stream2 === "csound",
         JSON.stringify(now));
}

console.log("\n── col backend ignoto la voce si CANCELLA, non resta indietro ──");
{
  // Stessa regola della semantica, e per la stessa ragione: un nome VECCHIO su
  // uno stem NUOVO e' un'affermazione falsa, l'assenza e' la verita'. Qui il
  // caso non e' il bridge giu' ma un chiamante che non dichiara il backend —
  // e li' non c'e' nessuna cella su cui ripiegare, perche' il nome non arriva
  // dal motore: e' la scelta di chi rende.
  store = { "pge-local-renderer": JSON.stringify({ proj: { stream1: "csound", stream2: "csound" } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", streams: [{ id: "stream1" }] },
    () => {});

  const now = rend("proj");
  assert("lo stem appena reso perde il backend di prima", now && !("stream1" in now),
         JSON.stringify(now));
  assert("gli altri restano dove sono", now && now.stream2 === "csound",
         JSON.stringify(now));
}

console.log("\n── e una stringa che non e' un nome vale come assenza ──");
{
  // `""` scritto nel record sarebbe indistinguibile da uno stem senza record
  // per chi legge, ma non per `staleReason`, che confronta i valori: il
  // risultato sarebbe uno stem eternamente giallo con un nome che nessun
  // render puo' eguagliare. Non si scrive.
  for (const bad of ["", 0, null, 7, {}]) {
    store = { "pge-local-renderer": JSON.stringify({ proj: { stream1: "csound" } }) };
    const backend = window.PGEBackend.create({ baseUrl: "http://x" });
    NDJSON = [
      { type: "stream-done", streamId: "stream1", cached: false },
      { type: "done", ok: true, generated: [] },
    ];
    await backend.render.run(
      { yamlBasename: "proj", outputFormat: "wav", renderer: bad,
        streams: [{ id: "stream1" }] },
      () => {});
    assert(`renderer=${JSON.stringify(bad)} → voce cancellata, non scritta`,
           rend("proj") && !("stream1" in rend("proj")), JSON.stringify(rend("proj")));
  }
}

console.log("\n── cosa e' un nome lo dice UNA regola, e la leggono tutti e tre i punti ──");
{
  /* «Quello che non e' un nome vale come ignoto» ha tre lettori: il record
     persistito (`run()` qui sopra), il record in memoria (l'handler degli
     `stream-done` in app.jsx) e il lato vivo dell'asse (`rendererCtx.current`).
     Scritta tre volte, le tre copie non concordavano: stringa non vuota in
     `run()`, verita' generica nell'handler, nessun filtro sul lato vivo. Oggi
     RENDERER e' "numpy" e nessuna delle differenze scatta; il giorno del
     selettore (#150) il valore arriva da una preferenza, e allora:
       - un nome vuoto sul lato vivo e' un `current` NOTO ("" != null) contro
         record che nessun render puo' scrivere, perche' `run()` non li scrive:
         giallo su ogni stem, per sempre — l'unico esito che il design dichiara
         inaccettabile;
       - un non-stringa vera (7) resta nel record in memoria e sparisce da
         quello persistito: un colore fino al reload, un altro dopo.
     Il test esegue la regola e poi pretende che i tre punti la chiamino, non
     che ne tengano una copia. */
  const name = window.PGEBackend.rendererName;
  assert("PGEBackend.rendererName esiste", typeof name === "function",
         `typeof = ${typeof name}`);
  if (typeof name === "function") {
    for (const ok of ["numpy", "csound", "supercollider"]) {
      assert(`${JSON.stringify(ok)} e' un nome`, name(ok) === ok, String(name(ok)));
    }
    for (const bad of ["", 0, null, undefined, 7, {}, [], true]) {
      assert(`${bad === undefined ? "undefined" : JSON.stringify(bad)} non e' un nome → null`,
             name(bad) === null, String(name(bad)));
    }
  }
  assert("run() chiama la regola invece di tenerne una copia",
         /rendererName\(opts\.renderer\)/.test(BACKEND_SRC) &&
         !/typeof opts\.renderer/.test(BACKEND_SRC),
         "una seconda copia e' il modo in cui i lettori smettono di concordare");
  assert("l'handler in memoria la chiama",
         /setRenderedRenderer\(m => \{[\s\S]{0,200}?rendererName\(rendererOfThisRun\)/.test(APP_SRC) &&
         !/if \(rendererOfThisRun\)/.test(APP_SRC),
         "col test di verita' un 7 resta in memoria e sparisce dal localStorage");
  assert("il lato vivo la chiama",
         /current:\s*window\.PGEBackend\.rendererName\(RENDERER\)/.test(APP_SRC),
         "un nome vuoto e' un current noto contro record mai scritti: giallo per sempre");
}

console.log("\n── i due record viaggiano insieme in un giro solo (sorgente) ──");
{
  assert("run() prende il backend da chi chiama, come la semantica",
         /opts\.renderer/.test(BACKEND_SRC),
         "un valore cablato dentro backend.js sarebbe verde su qualunque cambio");
  assert("app.jsx carica i backend registrati al cambio progetto",
         /loadRenderers\([\s\S]{0,120}?setRenderedRenderer/.test(APP_SRC));
  /* La dichiarazione unica: il nome che finisce nel corpo del POST e quello che
     finisce nell'asse devono essere LA STESSA variabile, non due copie. Due
     copie sono il modo in cui i due lati smettono di concordare — e qui il
     disaccordo non si vede, perche' produce un pallino verde. E' la lezione dei
     `Seg` di #149, sullo stesso repo. */
  assert("app.jsx dichiara il backend una volta sola",
         (APP_SRC.match(/"numpy"/g) || []).length === 1,
         "due letterali sono due dichiarazioni: la prossima modifica ne muove una");
  assert("...e il POST e l'asse leggono quella dichiarazione",
         /renderer:\s*rendererOfThisRun\b/.test(APP_SRC) &&
         /setRenderedRenderer\([\s\S]{0,300}?rendererOfThisRun\b/.test(APP_SRC),
         "se uno dei due prende un'altra strada, l'asse giudica un render che " +
         "non e' quello che e' andato in porto");
}

/* ===========================================================================
 * 4. Il fallback di `done` reclama solo cio' che il motore ha costruito.
 *
 * `generated` non e' l'elenco dei file che il render ha scritto: e' quello dei
 * file che il bridge trova su disco DOPO il render (`output/<basename>__*`,
 * server.py). Il fallback lo usa come rete per ogni stream DIRTY del giro,
 * e senza `--cache` e' l'UNICA sorgente di `stream-done` (le righe `[CACHE]`
 * non ci sono). Ma uno stream muto — o fuori dal solo — il motore non lo
 * costruisce affatto (`Generator._filter_solo_mute`): il suo file e' di un
 * giro precedente, magari di un altro backend o di un'altra semantica.
 * Reclamarlo scriveva i tre record di QUESTO giro su audio che questo giro non
 * ha toccato: tolto il muto, verde su uno stem che il motore rifara' — un
 * render di meno, l'esito che i due assi di provenienza esistono per evitare.
 * ========================================================================= */
console.log("\n── il fallback di `done` non reclama lo stem di uno stream muto ──");
{
  store = { "pge-local-renderer": JSON.stringify({ proj: { stream2: "csound" } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  // Il giro con la cache: `stream1` ha il suo `stream-done`, `stream2` e'
  // muto quindi il motore non stampa niente per lui — ma il suo file c'e'.
  NDJSON = [
    { type: "stream-start", streamId: "stream1", index: 0, total: 2 },
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true,
      generated: ["output/proj__stream1.wav", "output/proj__stream2.wav"] },
  ];
  const seen = [];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3,
      streams: [{ id: "stream1" }, { id: "stream2", mute: true }] },
    (e) => seen.push(e));

  const r = rend("proj") || {};
  assert("lo stream costruito prende il backend del giro", r.stream1 === "numpy",
         JSON.stringify(r));
  assert("quello muto tiene il record di chi l'ha scritto davvero",
         r.stream2 === "csound",
         `pge-local-renderer = ${JSON.stringify(r)}: il fallback ha scritto il ` +
         "backend di questo giro su un file che questo giro non ha toccato");
  assert("...niente semantica di questo giro sul file di un altro",
         !("stream2" in (sem("proj") || {})), JSON.stringify(sem("proj")));
  const fps = await backend.render.loadCache("proj");
  assert("...e niente impronta: un muto modificato resta giallo",
         !("stream2" in fps), JSON.stringify(fps));
  assert("nessuno `stream-done` sintetico per lui: la meta' in memoria " +
         "di app.jsx legge gli eventi, non il localStorage",
         !seen.some(e => e.type === "stream-done" && e.streamId === "stream2"),
         JSON.stringify(seen.filter(e => e.type === "stream-done")));
  assert("...ma l'indice sa che il file c'e' (ownsStem)",
         backend.render.ownsStem("proj", "stream2") === true);
}

console.log("\n── senza --cache il fallback e' l'unica sorgente, e resta tale ──");
{
  // Nessuna riga `[CACHE]`, quindi nessun `stream-done` dal bridge: tutto
  // arriva dal fallback. La correzione non deve spegnerlo sugli stream che il
  // motore ha davvero costruito — e' la sua ragione d'essere.
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "done", ok: true,
      generated: ["output/proj__a.wav", "output/proj__b.wav", "output/proj__c.wav"] },
  ];
  const seen = [];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3,
      streams: [{ id: "a" }, { id: "b", mute: true }, { id: "c" }] },
    (e) => seen.push(e));
  const done = seen.filter(e => e.type === "stream-done").map(e => e.streamId).sort();
  assert("gli stream costruiti ricevono lo `stream-done` sintetico",
         JSON.stringify(done) === JSON.stringify(["a", "c"]), JSON.stringify(done));
  assert("...e i loro record", JSON.stringify(rend("proj")) === JSON.stringify({ a: "numpy", c: "numpy" }),
         JSON.stringify(rend("proj")));
}

console.log("\n── col solo, il motore costruisce SOLO i solisti (anche se muti) ──");
{
  // `_filter_solo_mute`: con almeno un `solo` si prendono quelli e basta, e
  // il `mute` non conta piu' — un solista muto suona. La regola e' sulla
  // PRESENZA della chiave, e il serializzatore scrive `solo`/`mute` solo
  // quando veri, quindi nello stato vale la verita'.
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "done", ok: true,
      generated: ["output/proj__a.wav", "output/proj__b.wav", "output/proj__c.wav"] },
  ];
  const seen = [];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3,
      streams: [{ id: "a", solo: true }, { id: "b" }, { id: "c", solo: true, mute: true }] },
    (e) => seen.push(e));
  const done = seen.filter(e => e.type === "stream-done").map(e => e.streamId).sort();
  assert("il fallback reclama i due solisti e non il terzo",
         JSON.stringify(done) === JSON.stringify(["a", "c"]), JSON.stringify(done));
  assert("...e i record dicono lo stesso",
         JSON.stringify(rend("proj")) === JSON.stringify({ a: "numpy", c: "numpy" }),
         JSON.stringify(rend("proj")));
}

console.log("\n── un giro FALLITO non reclama niente, nemmeno gli stream costruiti ──");
{
  // L'altro modo in cui un file di `generated` non e' di questo giro. Il bridge
  // elenca il disco anche quando il motore esce con errore (`ok: false`,
  // server.py), e un motore che muore al parse — un sample che non c'e', un
  // `loop_unit` scritto male — non ha scritto niente: i file sono tutti di
  // prima. Il fallback li reclamava comunque, e senza `--cache` o con la morte
  // prima del triage e' l'unica sorgente di `stream-done`: impronta dello YAML
  // appena modificato, semantica e backend di questo giro su audio che nessuno
  // ha rifatto. Dopo un "Render failed", tutto verde.
  store = { "pge-local-renderer": JSON.stringify({ proj: { a: "csound" } }),
            "pge-local-sem": JSON.stringify({ proj: { a: 2 } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "log", line: "SampleNotFoundError: ..." },
    { type: "done", ok: false, returncode: 1, generated: ["output/proj__a.wav"] },
  ];
  const seen = [];
  const res = await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3,
      streams: [{ id: "a", density: 20 }] },
    (e) => seen.push(e));

  assert("il giro e' riportato fallito", res && res.ok === false, JSON.stringify(res));
  assert("nessuno `stream-done` sintetico: la meta' in memoria resta ferma",
         !seen.some(e => e.type === "stream-done"),
         JSON.stringify(seen.filter(e => e.type === "stream-done")));
  assert("il backend registrato resta quello che ha scritto il file",
         (rend("proj") || {}).a === "csound", JSON.stringify(rend("proj")));
  assert("...e la semantica pure", (sem("proj") || {}).a === 2, JSON.stringify(sem("proj")));
  const fps = await backend.render.loadCache("proj");
  assert("...e nessuna impronta dello YAML modificato su un file di prima",
         !("a" in fps), JSON.stringify(fps));
  assert("l'indice sa comunque che il file c'e'",
         backend.render.ownsStem("proj", "a") === true);
}

console.log("\n── lo stem di uno stream CANCELLATO non si reclama nemmeno lui ──");
{
  // Il terzo modo in cui un file di `generated` non e' di questo giro, e il piu'
  // ovvio: lo stream non e' nemmeno nello YAML che il motore ha letto. Senza
  // `--cache` la GC del motore non gira, quindi lo stem di uno stream
  // cancellato (o rinominato: il nome vecchio resta su disco) sopravvive e il
  // bridge lo elenca. Il fallback lo indicizzava — giusto, `ownsStem` deve
  // saperlo — ma lo RECLAMAVA anche: `stream-done` sintetico, e la meta' in
  // memoria di app.jsx stampava su quell'id impronta (`undefined`, lo stream
  // non c'e'), semantica e backend di questo giro. Ctrl+Z, e lo stream tornava
  // ⚪ "never rendered" con lo stem su disco, mentre il localStorage — che quel
  // ramo non toccava — al reload diceva un altro colore.
  store = { "pge-local-renderer": JSON.stringify({ proj: { gone: "csound" } }),
            "pge-local-sem": JSON.stringify({ proj: { gone: 2 } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "done", ok: true,
      generated: ["output/proj__a.wav", "output/proj__gone.wav"] },
  ];
  const seen = [];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3,
      streams: [{ id: "a" }] },
    (e) => seen.push(e));
  const done = seen.filter(e => e.type === "stream-done").map(e => e.streamId);
  assert("lo `stream-done` sintetico va solo allo stream costruito",
         JSON.stringify(done) === JSON.stringify(["a"]), JSON.stringify(done));
  assert("...l'indice sa comunque che il file del cancellato c'e' (ownsStem)",
         backend.render.ownsStem("proj", "gone") === true);
  assert("...e i suoi record restano quelli di chi l'ha scritto",
         (rend("proj") || {}).gone === "csound" && (sem("proj") || {}).gone === 2,
         `renderer ${JSON.stringify(rend("proj"))} · sem ${JSON.stringify(sem("proj"))}`);
}

console.log("\n── una richiesta che non dichiara gli stream resta al comportamento storico ──");
{
  // La stessa regola del bridge (`state["ids"]` in server.py): senza una lista
  // di stream non c'e' un insieme contro cui giudicare, e il fallback reclama
  // come ha sempre fatto. app.jsx la dichiara sempre; il ramo esiste per non
  // cambiare in silenzio il contratto di `run()` a chi non la passa.
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "done", ok: true, generated: ["output/proj__a.wav"] },
  ];
  const seen = [];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3 },
    (e) => seen.push(e));
  assert("senza `streams` il fallback emette lo `stream-done` sintetico",
         seen.some(e => e.type === "stream-done" && e.streamId === "a"),
         JSON.stringify(seen));

  /* ...ma una lista VUOTA e' una lista, e qui la regola si stacca da quella
     del bridge, deliberatamente. Per `state["ids"]` vuoto e assente sono la
     stessa cosa (nessun filtro sulle righe di log); per il fallback no: uno
     YAML senza stream il motore non lo costruisce affatto, quindi ogni file
     su disco e' di un giro precedente — uno stream cancellato, per ipotesi —
     e reclamarlo e' il caso del cancellato qui sopra. */
  store = {};
  const backend2 = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "done", ok: true, generated: ["output/proj__a.wav"] },
  ];
  const seen2 = [];
  await backend2.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3,
      streams: [] },
    (e) => seen2.push(e));
  assert("con `streams: []` il fallback non reclama niente (qui non e' la regola del bridge)",
         !seen2.some(e => e.type === "stream-done") && !rend("proj"),
         JSON.stringify(seen2.filter(e => e.type === "stream-done")));
  assert("...ma l'indice sa del file", backend2.render.ownsStem("proj", "a") === true);
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
