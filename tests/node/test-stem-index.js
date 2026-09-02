/* =============================================================================
 * test-stem-index.js — pins the browser's stem index (backend.js).
 *
 * The index answers two *different* questions and must not conflate them:
 *
 *   hasStem(bn, sid, format)  "is there a stem I can actually play right now?"
 *                             Playback asks this. It is format-specific:
 *                             stemUrl() requests the extension of the Settings
 *                             output format, and a stem rendered only as .aif
 *                             404s when the format is wav — which the <audio>
 *                             element reports as *nothing at all* (canplay never
 *                             fires), i.e. a clip that is silently silent.
 *
 *   ownsStem(bn, sid)         "does any file on disk still claim this id?"
 *                             Id allocation asks this, and must stay
 *                             format-agnostic or it recycles an id whose stem
 *                             exists in the other format.
 *
 * Run: node test-stem-index.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

// Fake disk + the /stems shape server.py serves from it.
let DISK = [];                                   // ["proj__stream1.wav", …]
let DUR = {};                                    // {"proj__stream1.wav": 4.0}
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
// NDJSON che la fetch finta di /render restituisce, uno stream di eventi come
// quello vero: `run()` legge da `res.body.getReader()`, non da `json()`.
let RENDER_EVENTS = null;
// Cosa il motore lascia sul disco quando quel render finisce: uno stem
// riscritto ha una durata nuova, ed e' l'unico modo di misurare se il
// disegno finisce ritagliato sulla misura vecchia.
let RENDER_WRITES = null;
global.fetch = (url, init) => {
  const u = String(url);
  if (u.endsWith("/render")) {
    if (RENDER_WRITES) { Object.assign(DUR, RENDER_WRITES); RENDER_WRITES = null; }
    const body = (RENDER_EVENTS || []).map(e => JSON.stringify(e)).join("\n") + "\n";
    const chunks = [new TextEncoder().encode(body)];
    let i = 0;
    return Promise.resolve({
      ok: true,
      body: { getReader: () => ({
        read: () => Promise.resolve(i < chunks.length
          ? { value: chunks[i++], done: false }
          : { value: undefined, done: true }),
      }) },
    });
  }
  if (u.endsWith("/semantics-version")) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 3 }) });
  }
  const m = u.match(/\/stems\/([^?]+)/);
  if (!m) return Promise.reject(new Error("unexpected fetch " + u));
  const bn = decodeURIComponent(m[1]);
  const stems = DISK.filter(f => f.startsWith(bn + "__")).map(f => ({
    streamId: f.slice(bn.length + 2).replace(/\.[^.]+$/, ""),
    ext: f.slice(f.lastIndexOf(".")),
    mtime: 1700000000,
    dur: DUR[f] ?? null,
  }));
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ basename: bn, stems }) });
};
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

const backend = window.PGEBackend.create({ baseUrl: "http://x" });

// Un backend nuovo per giro: l'indice stem vive nella chiusura di create(),
// e due sezioni che se lo passassero si spiegherebbero i fantasmi a vicenda.
function mkBackendWithRender(events) {
  RENDER_EVENTS = events;
  return window.PGEBackend.create({ baseUrl: "http://x" });
}

/* Il corpo e' asincrono; l'handler `exit` sta FUORI, a livello di modulo.
 * Registrato dentro, un'eccezione prima di quella riga lo fa non esistere: il
 * file esce senza riepilogo E senza "interrotto prima della fine", cioe' le due
 * righe che sono l'intero contratto. Misurato rinominando un simbolo di
 * backend.js: exit 1 e nessun verdetto. */
let bodyDone = false;
console.log("\n── a stem present in one format only ──");
(async () => {
  DISK = ["proj__stream1.wav", "proj__stream2.aif"];
  await backend.render.loadCache("proj");

  assert("hasStem(wav) true for the .wav stem",  backend.render.hasStem("proj", "stream1", "wav") === true);
  assert("hasStem(aiff) FALSE for it — no .aif to play",
         backend.render.hasStem("proj", "stream1", "aiff") === false);
  assert("hasStem(aiff) true for the .aif stem", backend.render.hasStem("proj", "stream2", "aiff") === true);
  assert("hasStem(wav) FALSE for it — no .wav to play",
         backend.render.hasStem("proj", "stream2", "wav") === false);

  console.log("\n── id ownership stays format-agnostic ──");
  assert("ownsStem sees the .wav stem", backend.render.ownsStem("proj", "stream1") === true);
  assert("ownsStem sees the .aif stem", backend.render.ownsStem("proj", "stream2") === true);
  assert("ownsStem false for a free id", backend.render.ownsStem("proj", "stream3") === false);

  /* La durata dello stem su disco: e' quella che permette di disegnare il
   * waveform nel tempo invece di stirarlo sulla larghezza della clip. Dopo un
   * taglio la clip e' meta' dello stem, e senza questo numero il disegno
   * mostrava tutto lo stem compresso — che si legge come un aggiornamento
   * sbagliato, non come uno stem da rigenerare. */
  console.log("\n── durata dello stem su disco ──");
  {
    DISK = ["p2__stream1.wav", "p2__stream2.aif"];
    DUR = { "p2__stream1.wav": 4.25 };
    await backend.render.loadCache("p2");
    assert("la durata arriva da /stems", backend.render.stemDur("p2", "stream1") === 4.25);
    assert("format-agnostica come ownsStem",
           backend.render.stemDur("p2", "stream2") === null);
    assert("id sconosciuto → null", backend.render.stemDur("p2", "stream9") === null);
    // Un render riscrive lo stem: la durata vecchia sarebbe peggio che nessuna,
    // perche' taglierebbe il disegno sulla misura di prima. Dimenticarla
    // riporta all'ipotesi "stem lungo quanto la clip", vera appena dopo.
    const tlSrc = SG.codeOf(path.join(__dirname, "../../src/components/Timeline.jsx"));
    assert("uno stem appena scritto dimentica la durata vecchia",
           /function _markStemFresh\(key\) \{[\s\S]*?delete stemDurIndex\[key\];/.test(
             SG.codeOf(path.join(__dirname, "../../src/lib/backend.js"))));
    assert("il waveform e' mappato sul tempo, non stirato sulla clip",
           /const kOf = \(x\) => \(x \/ W\) \* sp \* n;/.test(tlSrc)
           && !/Math\.floor\(\(x \/ W\) \* n\)/.test(tlSrc));
    assert("stessa regola per lo spettrogramma",
           /drawImage\(off, 0, 0, cols, bins, 0, 0, W \/ sp, H\)/.test(tlSrc));
  }

  console.log("\n── a clip that cannot sound says so (source guard) ──");
  {
    const engSrc = SG.codeOf(path.join(__dirname, "../../src/lib/audio-engine.js"));
    const appSrc = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
    assert("play() rejections are no longer swallowed",
           !/\.play\(\)\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(engSrc));
    assert("the <audio> element's error is listened for",
           /addEventListener\("error"/.test(engSrc));
    assert("the engine reports it as pge-audio-error",
           /pge-audio-error/.test(engSrc));
    assert("app.jsx listens for it", /pge-audio-error/.test(appSrc));
  }

  /* ------------------------------------------------------------------
   * Gli eventi di un render vero non inquinano l'indice.
   *
   * `run()` scriveva nell'indice OGNI `stream-done` che leggeva, e il
   * bridge ne inventava due per giro: `[CACHE] Manifest: <path>` e
   * `[CACHE] GC: …` hanno la forma di una riga di stream. Da li'
   * `ownsStem("Manifest")` rispondeva `true` per un file mai esistito —
   * cioe' l'oracolo di cui `allocStreamIds` si fida, e il terzo rifiuto di
   * `renameStream`. Il bridge ora filtra (tests/python/test_render_pipeline),
   * ma la scrittura nell'indice deve pretendere lo stesso di cio' che
   * scrive il fingerprint due righe sotto: uno stream dichiarato dalla
   * richiesta.
   * ------------------------------------------------------------------ */
  console.log("\n── un `stream-done` fantasma non entra nell'indice ──");
  {
    const be = mkBackendWithRender([
      { type: "stream-start", streamId: "Manifest", index: 0, total: 1 },
      { type: "stream-done",  streamId: "Manifest", cached: true },
      { type: "stream-start", streamId: "stream1", index: 1, total: 1 },
      { type: "stream-done",  streamId: "stream1", cached: false },
      { type: "done", ok: true, generated: [] },
    ]);
    const seen = [];
    await be.render.run(
      { yamlBasename: "proj", streams: [{ id: "stream1" }], outputFormat: "wav" },
      (e) => seen.push(e));

    assert("lo stream dichiarato entra nell'indice",
           be.render.ownsStem("proj", "stream1") === true);
    assert("l'id che la richiesta non dichiara resta fuori",
           be.render.ownsStem("proj", "Manifest") === false,
           "ownsStem e' l'oracolo di allocStreamIds e il terzo rifiuto di " +
           "renameStream: un fantasma li' brucia un nome per sempre");
    assert("...e non finisce nemmeno in `pge-local-stems`",
           !/Manifest/.test(store["pge-local-stems"] || ""),
           store["pge-local-stems"]);
  }

  /* ------------------------------------------------------------------
   * Il fallback di `done` deve parlare del GIRO, non del disco.
   *
   * `if (stemIndex[key]) continue` leggeva "gia' gestito" da un indice che
   * `loadCache` riempie da /stems a ogni apertura di progetto: dal secondo
   * render in poi il fallback era morto. Ed e' l'unica rete dell'ultimo
   * stream DIRTY del giro, il solo che dipende dalla riga di path.
   * ------------------------------------------------------------------ */
  console.log("\n── il fallback di `done` copre anche il secondo render ──");
  {
    DISK = ["proj__bass-1.wav"];
    DUR  = { "proj__bass-1.wav": 2.0 };
    const be = mkBackendWithRender([
      // nessun `stream-done` per bass-1: e' il caso che il fallback copre
      { type: "stream-start", streamId: "bass-1", index: 0, total: 1 },
      { type: "done", ok: true, generated: ["output/proj__bass-1.wav"] },
    ]);
    RENDER_WRITES = { "proj__bass-1.wav": 1.0 };   // il render lo accorcia
    await be.render.loadCache("proj");          // secondo render: lo stem c'e' gia'
    assert("prima del render la durata su disco e' nota",
           be.render.stemDur("proj", "bass-1") === 2.0);

    const seen = [];
    await be.render.run(
      { yamlBasename: "proj", streams: [{ id: "bass-1" }], outputFormat: "wav" },
      (e) => seen.push(e));

    assert("il fallback emette lo `stream-done` sintetico anche al secondo giro",
           seen.some(e => e.type === "stream-done" && e.streamId === "bass-1"),
           "con la guardia sul disco il pallino resta giallo dopo un render " +
           "riuscito, e ogni modifica costa due render");
    assert("...e la durata disegnata e' quella dello stem appena scritto",
           be.render.stemDur("proj", "bass-1") === 1.0,
           `stemDur = ${be.render.stemDur("proj", "bass-1")} contro 1.0 sul ` +
           "disco: con un solo stream nel giro `localFps` restava vuoto, " +
           "quindi niente `loadCache` in fondo a run(), e il waveform " +
           "restava ritagliato sulla misura di prima");
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
