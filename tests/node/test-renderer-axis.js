/* =============================================================================
 * test-renderer-axis.js — il backend audio come scelta, e come asse (#150).
 *
 * Il motore rende con tre backend (`--renderer numpy|csound|supercollider`,
 * PGE #228) e il backend sta nel SUO fingerprint: cambiarlo rifa' ogni stem.
 * `test-render-status.js` verifica la DECISIONE (staleReason con l'asse
 * "renderer"); qui le tre cose che la tengono in piedi e che nessuna
 * esecuzione toccava:
 *
 *   1. l'elenco dei backend, che arriva dal bridge (`backend.renderers()`,
 *      GET /renderers) e diventa i bottoni del popover
 *      (`window.PGERendererChoice.choices`): nessuna copia dei nomi qui;
 *   2. la persistenza per stem (`loadStemRenderers` / `_persistStemRenderers`,
 *      `pge-local-renderer`), eseguita con un giro vero di `render.run()`:
 *      resa un no-op, l'asse non si spegne — si blocca sul GIALLO, perche' un
 *      backend mai registrato e' un backend ignoto;
 *   3. il cablaggio che dal selettore arriva all'argv e al pallino, per
 *      guardia sorgente dove non gira in node (JSX).
 *
 * Idioma: il backend VERO guidato con `fetch` e `localStorage` finti, come in
 * test-semantics-store.js.
 *
 * Run: node test-renderer-axis.js (from tests/node/ after npm install)
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
let RENDERERS = null;    // cosa risponde GET /renderers (null = route assente)
let DOWN = false;        // ...o il bridge non risponde affatto
let NDJSON = [];         // le righe che POST /render restituisce
let lastRenderBody = null;

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
  if (DOWN) return Promise.reject(new TypeError("Failed to fetch"));
  if (u.endsWith("/renderers")) {
    if (RENDERERS === null) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(RENDERERS) });
  }
  if (u.endsWith("/semantics-version")) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, version: 3 }) });
  }
  if (u.endsWith("/render")) {
    lastRenderBody = JSON.parse(init.body);
    return Promise.resolve({ ok: true, body: ndjsonBody(NDJSON) });
  }
  if (u.includes("/stems/")) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ basename: "proj", stems: [] }) });
  }
  return Promise.reject(new Error("unexpected fetch " + u));
};

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/renderer-choice.js"), "utf8"));

const RC = window.PGERendererChoice;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function recorded(basename) {
  try { return (JSON.parse(store["pge-local-renderer"] || "{}"))[basename] || null; }
  catch { return null; }
}

/* Il corpo e' asincrono; l'handler `exit` sta FUORI, a livello di modulo
 * (vedi test-suite-harness.js): registrato dentro, un'eccezione prima di
 * quella riga lo farebbe non esistere. */
let bodyDone = false;
(async () => {

/* ===========================================================================
 * 1. L'elenco viene dal bridge, e "non lo so" resta "non lo so".
 * ========================================================================= */
console.log("\n── backend.renderers(): l'elenco del motore, o niente ──");
{
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  const rows = [
    { name: "csound", available: false, detail: "csound not on PATH" },
    { name: "numpy", available: true, detail: "no external binary" },
    { name: "supercollider", available: true, detail: "scsynth: /usr/bin/scsynth" },
  ];
  RENDERERS = { ok: true, renderers: rows }; DOWN = false;
  assert("restituisce le righe del bridge, nel loro ordine",
    eq(await backend.renderers(), rows));

  RENDERERS = null;
  assert("server.py senza la route → [] (non un elenco inventato)",
    eq(await backend.renderers(), []));
  DOWN = true;
  assert("bridge giu' → []", eq(await backend.renderers(), []));
  DOWN = false;
  RENDERERS = { ok: true, renderers: "boh" };
  assert("risposta malformata → []", eq(await backend.renderers(), []));
  RENDERERS = { ok: true, renderers: [{ name: "numpy", available: true }, { available: true }, 7] };
  assert("le righe senza nome si scartano, le altre restano",
    eq((await backend.renderers()).map(r => r.name), ["numpy"]));
}

/* ===========================================================================
 * 2. I bottoni del popover: `choices(renderers, current)`.
 *
 * Pura, perche' decide cosa si puo' cliccare — e un errore qui e' silenzioso:
 * un backend acceso che non esiste manda un render che il bridge rifiuta, uno
 * spento che esiste nasconde il backend che la issue esiste per rendere
 * raggiungibile.
 * ========================================================================= */
console.log("\n── choices(): cosa offre il selettore ──");
{
  const rows = [
    { name: "csound", available: false, detail: "csound not on PATH" },
    { name: "numpy", available: true, detail: "no external binary" },
    { name: "supercollider", available: true, detail: "ok" },
  ];
  const c = RC.choices(rows, "numpy");
  assert("un bottone per backend, nell'ordine del motore",
    eq(c.map(x => x.name), ["csound", "numpy", "supercollider"]));
  assert("acceso quello scelto, e solo quello",
    eq(c.map(x => x.on), [false, true, false]));
  assert("spento chi non puo' girare, col perche' nel titolo",
    c[0].disabled === true && c[0].title === "csound not on PATH");
  assert("cliccabile chi puo'", c[1].disabled === false && c[2].disabled === false);

  const unknown = RC.choices([{ name: "futuro", available: null, detail: "?" }], "futuro");
  assert("disponibilita' ignota (None) → cliccabile: 'non lo so' non e' 'no'",
    unknown[0].disabled === false);

  // Elenco del motore illeggibile: il comportamento di prima, e detto.
  const blind = RC.choices([], "numpy");
  assert("senza elenco resta il solo backend corrente, acceso e bloccato",
    blind.length === 1 && blind[0].name === "numpy" && blind[0].on && blind[0].disabled,
    JSON.stringify(blind));
  assert("...con un titolo che dice perche'", /not available|unknown|list/i.test(blind[0].title),
    blind[0].title);

  // Il backend scelto non e' (piu') fra quelli del motore — un `git pull` che lo
  // ha tolto, una scelta di un'altra sessione. Resta visibile, acceso e marcato:
  // nasconderlo lascerebbe il selettore senza nessun bottone acceso, e il render
  // partirebbe con un nome che il bridge rifiuta senza che il popover lo dica.
  const gone = RC.choices(rows, "fantasma");
  const g = gone.find(x => x.name === "fantasma");
  assert("un backend scelto che il motore non offre resta visibile",
    !!g && g.on && g.disabled, JSON.stringify(gone));
  assert("...e non duplica gli altri", gone.length === rows.length + 1);
  assert("totalita': righe malformate non rompono niente",
    eq(RC.choices(null, "numpy").map(x => x.name), ["numpy"]) &&
    eq(RC.choices(undefined, undefined).map(x => x.name), []));
}

/* ===========================================================================
 * 3. La meta' persistente dell'asse, ESEGUITA.
 * ========================================================================= */
console.log("\n── un render registra il backend, anche a vuoto ──");
{
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  // `cached: true` e' il percorso su cui poggia "il giallo si spegne al primo
  // giro anche a vuoto": il motore salta lo stream perche' il SUO fingerprint,
  // che contiene il backend, combacia — cioe' lo stem e' di quel backend.
  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: true },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "supercollider",
      semanticsVersion: 3, streams: [{ id: "stream1" }] },
    () => {});
  assert("il corpo della POST porta il backend scelto",
    lastRenderBody && lastRenderBody.renderer === "supercollider");
  assert("pge-local-renderer porta il backend dello stem",
    eq(recorded("proj"), { stream1: "supercollider" }), store["pge-local-renderer"]);
  assert("loadStemRenderers lo rilegge",
    eq(await backend.render.loadStemRenderers("proj"), { stream1: "supercollider" }));
}

console.log("\n── un render parziale non tocca gli altri stem ──");
{
  store = { "pge-local-renderer": JSON.stringify({ proj: { stream1: "numpy", stream2: "numpy" } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "csound", semanticsVersion: 3,
      streams: [{ id: "stream1" }, { id: "stream2" }] },
    () => {});
  const now = recorded("proj");
  assert("lo stem reso prende il backend di adesso", now && now.stream1 === "csound", JSON.stringify(now));
  assert("quello non toccato tiene il suo", now && now.stream2 === "numpy", JSON.stringify(now));
}

console.log("\n── una riga di servizio del motore non registra niente ──");
{
  // `[CACHE] Manifest: …` ha la forma di uno stream (render_pipeline.py): il
  // bridge la filtra, ma se passasse il browser non deve inventarsi uno stem.
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "stream-done", streamId: "Manifest", cached: true },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3,
      streams: [{ id: "stream1" }] },
    () => {});
  assert("niente voce per un id che la richiesta non dichiara",
    recorded("proj") === null || !("Manifest" in recorded("proj")), store["pge-local-renderer"]);
}

console.log("\n── senza backend nel corpo la voce si CANCELLA ──");
{
  // Un chiamante che non dice il backend: il bridge rende col suo default, ma
  // registrarlo qui vorrebbe dire trascrivere quel default. "Non lo so" e' la
  // verita', e il giallo che ne segue si spegne al giro successivo.
  store = { "pge-local-renderer": JSON.stringify({ proj: { stream1: "csound", stream2: "csound" } }) };
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  NDJSON = [
    { type: "stream-done", streamId: "stream1", cached: false },
    { type: "done", ok: true, generated: [] },
  ];
  await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", semanticsVersion: 3,
      streams: [{ id: "stream1" }] },
    () => {});
  const now = recorded("proj");
  assert("lo stem appena reso perde il backend di prima", now && !("stream1" in now),
    JSON.stringify(now));
  assert("gli altri restano dove sono", now && now.stream2 === "csound", JSON.stringify(now));
}

console.log("\n── un rientro rifiutato non scrive ──");
{
  store = {};
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  // Il primo giro resta appeso sul reader: il secondo deve essere rifiutato
  // senza registrare niente (non ha reso niente).
  let release;
  const gate = new Promise(r => { release = r; });
  const saved = global.fetch;
  global.fetch = (url, init) => String(url).endsWith("/render")
    ? gate.then(() => ({ ok: true, body: ndjsonBody([{ type: "done", ok: true, generated: [] }]) }))
    : saved(url, init);
  const first = backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "numpy", semanticsVersion: 3,
      streams: [{ id: "stream1" }] }, () => {});
  const second = await backend.render.run(
    { yamlBasename: "proj", outputFormat: "wav", renderer: "csound", semanticsVersion: 3,
      streams: [{ id: "stream1" }] }, () => {});
  release();
  await first;
  global.fetch = saved;
  assert("il secondo ingresso e' rifiutato", second.ok === false);
  assert("...e non registra un backend che non ha reso niente",
    recorded("proj") === null, store["pge-local-renderer"]);
}

console.log("\n── loadStemRenderers regge un archivio rotto ──");
{
  const backend = window.PGEBackend.create({ baseUrl: "http://x" });
  store = { "pge-local-renderer": "{non json" };
  assert("JSON rotto → {}", eq(await backend.render.loadStemRenderers("proj"), {}));
  store = { "pge-local-renderer": JSON.stringify({ proj: "numpy" }) };
  assert("voce non oggetto → {}", eq(await backend.render.loadStemRenderers("proj"), {}));
}

/* ===========================================================================
 * 4. Il cablaggio che non gira in node (guardie sorgente).
 * ========================================================================= */
console.log("\n── dal selettore all'argv e al pallino (sorgente) ──");
{
  const rb  = SG.codeOf(path.join(__dirname, "../../src/components/RenderButton.jsx"));
  const tb  = SG.codeOf(path.join(__dirname, "../../src/components/TopBar.jsx"));
  const app = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
  const be  = SG.codeOf(path.join(__dirname, "../../src/lib/backend.js"));

  assert("il popover costruisce i bottoni con choices(), non con una lista sua",
    /PGERendererChoice\.choices\(\s*renderers\s*,\s*options\.renderer\s*\)/.test(rb) &&
    !/>\s*csound\s*</.test(rb) && !/>\s*numpy\s*</.test(rb),
    "i nomi dei backend scritti nel JSX sarebbero la copia che la issue toglie");
  assert("...rispettando disabled e on di ogni scelta",
    /disabled=\{c\.disabled\}/.test(rb) && /c\.on\b/.test(rb));
  /* Il bottone gia' acceso: la lezione di `Seg` (CLAUDE.md), qui su bottoni
     scritti a mano. Riscrivere lo stesso backend e' un setTweak per niente —
     innocuo oggi, ma e' la forma in cui una scrittura "a vuoto" diventa un
     giallo il giorno che il tweak porta con se' altro. */
  assert("il clic sul backend gia' scelto non scrive",
    /if \(name === options\.renderer\) return;/.test(rb));
  assert("l'anteprima del comando stampa il backend scelto",
    /"--renderer",\s*o\.renderer\b/.test(rb) && !/"--renderer",\s*"numpy"/.test(rb));
  assert("aprire il popover rilegge l'elenco (chi ha appena installato scsynth)",
    /onOpen\s*&&\s*onOpen\(\)/.test(rb));
  assert("TopBar passa elenco e richiamo al RenderButton",
    /renderers=\{renderers\}/.test(tb) && /onOpen=\{onRenderOptionsOpen\}/.test(tb));
  assert("app.jsx li passa a TopBar",
    /renderers=\{engineRenderers\}/.test(app) &&
    /onRenderOptionsOpen=\{refreshRenderers\}/.test(app));
  assert("l'elenco si chiede anche al boot",
    (app.match(/(?<!function )refreshRenderers\(\)/g) || []).length >= 1);

  assert("la scelta e' un tweak, letto e riscritto",
    /renderer:\s*tweaks\.renderRenderer\b/.test(app) &&
    /setTweak\("renderRenderer",\s*next\.renderer\)/.test(app));
  assert("app carica i backend registrati al cambio progetto",
    /loadStemRenderers\([\s\S]{0,120}?setRenderedRenderer/.test(app));

  assert("backend: la route e' quella del bridge", /"\/renderers"/.test(be));
  assert("backend: run() registra opts.renderer, non un default",
    /typeof opts\.renderer === "string"/.test(be) && /_persistStemRenderers\(/.test(be));
  assert("backend: col backend ignoto la voce si cancella",
    /if \(rend === null\) delete nextR\[id\];/.test(be));
}

  bodyDone = true;
})().catch(e => {
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
