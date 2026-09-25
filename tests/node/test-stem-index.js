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
    assert("la durata arriva da /stems", backend.render.stemDur("p2", "stream1", "wav") === 4.25);
    assert("il formato mancante ricade sull'altro, come fa il disegno",
           backend.render.stemDur("p2", "stream2", "wav") === null);
    assert("id sconosciuto → null", backend.render.stemDur("p2", "stream9", "wav") === null);
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

  /* ------------------------------------------------------------------
   * #153 — il disegno legge il file che il playback suona.
   *
   * `peaksUrl`/`spectrogramUrl` cablavano `.aif` e il bridge risolveva
   * l'`.aif` per primo: col default `wav`, uno stem lasciato da un render
   * precedente in aiff faceva sentire l'audio nuovo e vedere il disegno
   * vecchio, senza che nessun render successivo lo sbloccasse. `stemDur` sta
   * dalla stessa parte: regge `span`, cioe' su che larghezza il waveform va
   * disegnato, quindi deve descrivere lo stesso file.
   * ------------------------------------------------------------------ */
  console.log("\n── peaks, spettrogramma e durata seguono il formato di output ──");
  {
    const r = backend.render;
    assert("peaksUrl chiede l'estensione del formato",
           r.peaksUrl("proj", "s1", "wav").endsWith("/peaks/proj__s1.wav")
           && r.peaksUrl("proj", "s1", "aiff").endsWith("/peaks/proj__s1.aif")
           && r.peaksUrl("proj", "s1", "flac").endsWith("/peaks/proj__s1.flac"),
           r.peaksUrl("proj", "s1", "wav"));
    assert("spectrogramUrl idem, con lo scale dopo",
           r.spectrogramUrl("proj", "s1", "linear", "wav")
             .endsWith("/spectrogram/proj__s1.wav")
           && r.spectrogramUrl("proj", "s1", "log", "aiff")
             .endsWith("/spectrogram/proj__s1.aif?scale=log"),
           r.spectrogramUrl("proj", "s1", "log", "aiff"));
    assert("un id con . e - resta un segmento solo",
           r.peaksUrl("proj", "bass-1.a", "wav").endsWith("/peaks/proj__bass-1.a.wav"));

    DISK = ["p3__s1.wav", "p3__s1.aif"];
    DUR  = { "p3__s1.wav": 4.0, "p3__s1.aif": 9.0 };
    await backend.render.loadCache("p3");
    assert("stemDur preferisce il formato chiesto",
           backend.render.stemDur("p3", "s1", "wav") === 4.0
           && backend.render.stemDur("p3", "s1", "aiff") === 9.0,
           "iterando EXT_OF `span` poteva descrivere un file diverso da " +
           "quello disegnato");
    DISK = ["p4__s1.aif"];
    DUR  = { "p4__s1.aif": 9.0 };
    await backend.render.loadCache("p4");
    assert("...e ricade sugli altri quando quello chiesto non c'e'",
           backend.render.stemDur("p4", "s1", "wav") === 9.0,
           "il disegno stesso ricade li': la route serve l'unico file che c'e'");
  }

  console.log("\n── il cablaggio del formato (source guard) ──");
  {
    const beSrc  = SG.codeOf(path.join(__dirname, "../../src/lib/backend.js"));
    const appSrc = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
    assert("nessuna estensione cablata nei due costruttori di URL",
           !/\/peaks\/\$\{[^`]*\}\.aif/.test(beSrc)
           && !/\/spectrogram\/\$\{[^`]*\}\.aif/.test(beSrc),
           "un'estensione fissa qui e' esattamente la #153");
    assert("app.jsx passa il formato a peaksUrl",
           /peaksUrl\(basename, s\.id, tweaks\.outputFormat \|\| "wav"\)/.test(appSrc));
    assert("app.jsx passa il formato a spectrogramUrl",
           /spectrogramUrl\(\s*basename, s\.id, tweaks\.spectrogramScale \|\| "linear",\s*tweaks\.outputFormat \|\| "wav"\)/.test(appSrc));
    assert("app.jsx passa il formato a stemDur",
           /stemDur\(activeProject\.replace\(\/\\\.yml\$\/, ""\), id,\s*tweaks\.outputFormat \|\| "wav"\)/.test(appSrc));
    assert("i due effetti rigirano quando il formato cambia",
           (appSrc.match(/backendKind, tweaks\.outputFormat\]/g) || []).length === 1
           && /tweaks\.spectrogramScale, tweaks\.outputFormat\]/.test(appSrc),
           "l'URL e' costruito dal formato: senza la dipendenza il disegno " +
           "resta quello di prima finche' non si tocca altro");
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
   * render in poi il fallback era morto. Ed e' la rete di ogni stream DIRTY
   * del giro, che si chiude solo sulla sua riga di path (render_pipeline.py,
   * #151) — e senza `--cache`, dove righe `[CACHE]` non ce ne sono, e' la
   * sola sorgente di `stream-done`.
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

  /* ------------------------------------------------------------------
   * Un giro FALLITO non reclama niente (#151) — ma la durata non e' un
   * record di provenienza, e' una misura del file.
   *
   * Senza `--cache` il motore non stampa righe `[CACHE]`, quindi TUTTI gli
   * `stream-done` vengono dal fallback, e un giro che muore dopo l'audio
   * (grain JSON, partitura, export Reaper: vengono dopo gli stem in cli.py)
   * ha riscritto ogni stem senza che il browser ne reclami uno. Giusto per
   * impronta, semantica e backend: chi ha scritto cosa non si sa, e l'ignoto
   * vale giallo. Ma la durata la sa il disco, e senza `localFps` il
   * `loadCache` in fondo a `run()` — l'unico che la rilegge — non partiva:
   * il waveform restava ritagliato sulla misura di prima dello stem nuovo.
   * Lasciarla cadere non era la cura: sul fallimento piu' comune (il motore
   * muore al parse, non scrive niente) toglieva una misura giusta.
   * ------------------------------------------------------------------ */
  console.log("\n── un giro fallito non reclama, ma la durata la chiede al disco ──");
  {
    DISK = ["proj__bass-1.wav"];
    DUR  = { "proj__bass-1.wav": 2.0 };
    const be = mkBackendWithRender([
      { type: "done", ok: false, returncode: 1, generated: ["output/proj__bass-1.wav"] },
    ]);
    await be.render.loadCache("proj");
    RENDER_WRITES = { "proj__bass-1.wav": 1.0 };   // morto DOPO aver scritto l'audio
    const seen = [];
    await be.render.run(
      { yamlBasename: "proj", streams: [{ id: "bass-1" }], outputFormat: "wav" },
      (e) => seen.push(e));
    assert("nessuno `stream-done` sintetico su un giro fallito",
           !seen.some(e => e.type === "stream-done"),
           JSON.stringify(seen.filter(e => e.type === "stream-done")));
    assert("...ma la durata e' quella del file che il disco ha adesso",
           be.render.stemDur("proj", "bass-1") === 1.0,
           `stemDur = ${be.render.stemDur("proj", "bass-1")} contro 1.0 sul disco`);

    // E il caso piu' comune: il motore muore al parse e non tocca niente. La
    // misura che c'era era giusta, e deve restare.
    const be2 = mkBackendWithRender([
      { type: "done", ok: false, returncode: 1, generated: ["output/proj__bass-1.wav"] },
    ]);
    await be2.render.loadCache("proj");
    await be2.render.run(
      { yamlBasename: "proj", streams: [{ id: "bass-1" }], outputFormat: "wav" },
      () => {});
    assert("...e su un file non toccato la misura giusta non si perde",
           be2.render.stemDur("proj", "bass-1") === 1.0,
           `stemDur = ${be2.render.stemDur("proj", "bass-1")}: senza misura il ` +
           "waveform torna stirato sulla clip");
  }

  /* ------------------------------------------------------------------
   * ...e il DISEGNO nemmeno e' provenienza: peaks, spettrogramma e grani
   * sono misure del file come la durata, e vanno riletti insieme a lei.
   *
   * Lo `stream-done` sintetico portava due cose insieme: i record di
   * provenienza (impronta, semantica, backend) e la rilettura del disegno —
   * in app.jsx e' lui che alza `stemRevRef` e `grainRegenRef`, e cambiando
   * `lastRenderedFps` fa ripartire i tre effetti che caricano i media. Un
   * giro fallito rinuncia al primo, giustamente, e con lui perdeva il
   * secondo: sul giro che muore dopo l'audio la durata si rileggeva, il
   * disegno no, e la clip suonava lo stem nuovo mostrando i peaks del
   * vecchio distesi sulla misura nuova — "l'audio nuovo e il disegno
   * vecchio", cioe' #153 da un'altra porta.
   *
   * Quindi un evento suo, emesso DOPO la rilettura delle durate (chi lo
   * riceve ridisegna, e il ridisegno deve trovare la misura nuova), e solo
   * per gli stream che il motore puo' aver riscritto: un muto o un id che
   * lo YAML non ha piu' il motore certamente non li ha toccati.
   * ------------------------------------------------------------------ */
  console.log("\n── un giro fallito rilegge dal disco anche il disegno, non solo la durata ──");
  {
    DISK = ["proj__bass-1.wav", "proj__muto.wav", "proj__gone.wav"];
    DUR  = { "proj__bass-1.wav": 2.0, "proj__muto.wav": 3.0, "proj__gone.wav": 4.0 };
    const be = mkBackendWithRender([
      { type: "done", ok: false, returncode: 1,
        generated: ["output/proj__bass-1.wav", "output/proj__muto.wav", "output/proj__gone.wav"] },
    ]);
    await be.render.loadCache("proj");
    RENDER_WRITES = { "proj__bass-1.wav": 1.0 };   // morto DOPO aver scritto l'audio
    const seen = [];
    let durAtResync = null;
    await be.render.run(
      { yamlBasename: "proj", outputFormat: "wav",
        streams: [{ id: "bass-1" }, { id: "muto", mute: true }] },
      (e) => {
        seen.push(e);
        if (e.type === "stems-resync") durAtResync = be.render.stemDur("proj", "bass-1");
      });
    const resync = seen.filter(e => e.type === "stems-resync");
    assert("un evento solo, `stems-resync`", resync.length === 1,
           JSON.stringify(seen.map(e => e.type)));
    assert("...con lo stream che il motore puo' aver riscritto, e solo lui",
           resync.length === 1 && JSON.stringify(resync[0].streamIds) === JSON.stringify(["bass-1"]),
           JSON.stringify(resync[0] && resync[0].streamIds) +
           " — il muto e il cancellato il motore non li ha toccati");
    assert("...emesso quando la durata e' gia' quella nuova",
           durAtResync === 1.0,
           `stemDur al momento dell'evento = ${durAtResync}: chi ridisegna ` +
           "troverebbe la misura vecchia");
    assert("...e sempre nessun reclamo", !seen.some(e => e.type === "stream-done"),
           JSON.stringify(seen.filter(e => e.type === "stream-done")));
  }
  {
    // Un giro RIUSCITO non lo emette: li' il disegno lo rilegge lo
    // `stream-done`, e un secondo segnale sarebbe una seconda rilettura.
    DISK = ["proj__bass-1.wav"];
    DUR  = { "proj__bass-1.wav": 2.0 };
    const be = mkBackendWithRender([
      { type: "done", ok: true, generated: ["output/proj__bass-1.wav"] },
    ]);
    const seen = [];
    await be.render.run(
      { yamlBasename: "proj", outputFormat: "wav", streams: [{ id: "bass-1" }] },
      (e) => seen.push(e));
    assert("un giro riuscito non emette `stems-resync`",
           !seen.some(e => e.type === "stems-resync"), JSON.stringify(seen.map(e => e.type)));

    // ...e nemmeno uno fallito che non ha trovato niente su disco.
    const be2 = mkBackendWithRender([{ type: "done", ok: false, returncode: 1, generated: [] }]);
    const seen2 = [];
    await be2.render.run(
      { yamlBasename: "proj", outputFormat: "wav", streams: [{ id: "bass-1" }] },
      (e) => seen2.push(e));
    assert("un giro fallito senza file non lo emette",
           !seen2.some(e => e.type === "stems-resync"), JSON.stringify(seen2.map(e => e.type)));
  }

  /* L'altra meta' non gira in node: e' React. Sono tre anelli, e ognuno,
   * saltando, rimette il disegno vecchio in silenzio. */
  console.log("\n── `stems-resync` arriva ai tre effetti dei media (source guard) ──");
  {
    const appSrc = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
    // Il ramo fino alla chiusura della callback di `run()`, non una finestra a
    // lunghezza fissa: `codeOf` tiene la lunghezza del file (i commenti
    // diventano spazi), quindi un commento piu' lungo spostava il codice fuori
    // dalla finestra e la guardia diventava rossa su un ramo sano.
    const at = appSrc.indexOf('e.type === "stems-resync"');
    const end = at < 0 ? -1 : appSrc.indexOf("\n    });", at);
    const branch = at < 0 ? "" : appSrc.slice(at, end < 0 ? undefined : end);
    assert("app.jsx gestisce `stems-resync`", at >= 0);
    assert("...alzando la revisione dei peaks e il rifetch dei grani per ogni id",
           /stemRevRef\.current\[id\]/.test(branch) && /grainRegenRef\.current\.add\(id\)/.test(branch),
           "senza, gli effetti ripartono e rileggono la cache per la chiave di prima");
    assert("...e facendo ripartire gli effetti",
           /setStemResync\(/.test(branch),
           "senza, la revisione alzata resta nel ref e nessuno la legge");
    const deps = appSrc.match(/\}, \[streamMediaKey, lastRenderedFps, stemResync,/g) || [];
    assert("i tre effetti dei media (peaks, spettrogrammi, grani) dipendono dal segnale",
           deps.length === 3, `${deps.length} effetti su 3`);

    // ...e l'evento sta nel contratto in testa a backend.js, con la chiave
    // che app.jsx ne legge. E' un evento che `run()` fabbrica da se', non una
    // riga del bridge: chi scrive un altro backend lo conosce solo da li', e
    // un backend che non lo emette rimette il disegno vecchio in silenzio.
    // Sorgente GREZZO, come la guardia gemella di test-workspace.js: il
    // contratto E' un commento, e `codeOf` lo cancellerebbe.
    const be = fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8");
    const at0 = be.indexOf("Contract (every backend implements)");
    const contratto = at0 < 0 ? "" : be.slice(at0, be.indexOf("=====*/", at0));
    assert("il contratto di backend.js elenca `stems-resync` e i suoi `streamIds`",
           /stems-resync/.test(contratto) && /streamIds/.test(contratto),
           "un evento che app.jsx consuma e il contratto non nomina e' quello " +
           "che il prossimo backend dimentica");
    // Lo stesso per i due record di provenienza che app.jsx carica al cambio
    // progetto: sono metodi del contratto quanto `loadCache`.
    assert("...e i due record di provenienza, `loadSemantics` e `loadRenderers`",
           /loadSemantics\(/.test(contratto) && /loadRenderers\(/.test(contratto),
           contratto.length ? "mancano dal contratto" : "contratto non trovato");
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
