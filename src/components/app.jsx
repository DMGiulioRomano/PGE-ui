/* @jsx React.createElement */
const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp, useMemo: useMemoApp, useCallback: useCallbackApp } = React;

const TWEAK_DEFAULTS = {
  "accent": "#FF8C42",
  "zoom": 36,
  "laneHeight": 56,
  "showWaveforms": true,
  "showSpectrograms": false,
  "spectrogramScale": "linear",
  "showGrains": false,
  "showClipLabels": true,
  "showEnvOverlay": true,
  "browserWidth": 240,
  "inspectorWidth": 380,
  "density": "comfortable",
  "rulerMode": "seconds",
  "snapGrid": "off",
  "gestureZoom": "wheel",
  "gestureLaneHeight": "shift+wheel",
  "gestureHScroll": "alt+wheel",
  "showFooter": true,
  "showWaveformBrowser": true,
  "showEnvelopeEditor": true,
  "envelopeHeight": 240,
  "activeProject": "PGE_test.yml",
  "backendKind": "local",
  "mediaPath": "",
  "projectsPath": "",
  "outputPath": "output",
  "renderUseCache": true,
  "renderVisualize": false,
  "renderGrainJson": true,
  "renderPageDuration": 15,
  "renderReaper": false,
  "renderPreclean": false,
  // Il backend audio (#150): la scelta del popover di render. E' l'unica
  // dichiarazione del nome in questo file — era la costante `RENDERER` di
  // #151 — e ha lo stesso default del bridge (`opts.get("renderer", "numpy")`,
  // pinnato da una guardia sorgente): numpy non chiede binari esterni, ed e'
  // quello che l'editor ha sempre mandato. I tre lettori passano da
  // `currentRenderer` dentro App, vedi li'.
  "renderRenderer": "numpy",
  "terminalOpen": false,
  "terminalHeight": 220,
  "shortcutRender": "r",
  "shortcutSettings": ",",
  "shortcutInspector": "i",
  "shortcutEnvelopeEditor": "o",
  "shortcutBackToStart": "z",
  "shortcutPlay": "x",
  "shortcutStop": "c",
  "shortcutMute": "m",
  "shortcutSolo": "s",
  "shortcutLog": "l",
  "shortcutToggleLabels": "h",
  "shortcutToggleSpectrogram": "t",
  "stepMenuTrigger": "rightClick",
  "outputFormat": "wav",
  "scopeOpen": false,
  "scopeHeight": 200,
  "shortcutScope": "v",
  "grainScoreOpen": false,
  "grainScoreHeight": 260,
  "shortcutGrainScore": "g"
};

/* ---- Envelope rescale + truncate utilities (freeze-on-resize) ----
   Pure math extracted to envelope-utils.js (window.PGEEnvUtils), loaded before
   this file. Only the stream-level helpers are used here; the per-array helpers
   (rescaleEnvArray / truncateEnvArray / envArrayWouldTruncate / _applyEnvFields)
   live in that module and are exercised by tests/node/test-envelope-utils.js. #44 */
const { rescaleStreamEnvelopes, truncateStreamEnvelopes, streamWouldTruncate, sliceStreamEnvelopes } = window.PGEEnvUtils;

// Blank in-memory project used as the editor's initial state before the real
// project is loaded from the server (server.py lists configs/*.yml on boot).
const EMPTY_PROJECT = { project: "", title: "", duration: 10, bpm: 120, streams: [], samples: [] };

// Preferences store. Was provided by the design-tool tweaks-panel (removed);
// now a thin local hook over the node-tested merge in tweaks-store.js. Keeps the
// setTweak(key, val) / setTweak({ ... }) signature used across this file.
function useTweaks(defaults) {
  const [values, setValues] = useStateApp(defaults);
  const setTweak = useCallbackApp(
    (keyOrEdits, val) => setValues((prev) => window.PGETweaks.applyEdit(prev, keyOrEdits, val)),
    []);
  return [values, setTweak];
}

// Merge di un patch nello stream. Delega al node-tested applyStreamPatch:
// una chiave con valore `undefined` viene RIMOSSA, non lasciata presente —
// il residuo sarebbe invisibile a chi legge lo stream ma non a canonicalJSON,
// che lo serializza come `null` e marca lo stem stale a vuoto (issue #112).
function mergeStreamPatch(stream, patch, samples) {
  return window.PGEYaml
    ? window.PGEYaml.applyStreamPatch(stream, patch, { samples })
    : { ...stream, ...patch };
}

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  /* Il backend che produce gli stem, letto UNA volta per render (#151, #150).
     Era una costante del modulo; col selettore del popover e' la preferenza
     `renderRenderer`, ma la regola resta la stessa: `rendererCtx` (il lato vivo
     dell'asse), `renderOptions.renderer` (l'anteprima del comando e il bottone
     acceso) e `rendererOfThisRun` in `runRender` (il corpo della POST e il
     record) leggono tutti questo nome, non il tweak tre volte. Tre letture
     sono il modo in cui il nome che va in argv, quello che l'anteprima promette
     e quello che finisce nel record smettono di concordare — un disaccordo che
     non si vede, perche' produce un pallino verde. Sta qui in cima e non
     accanto a `renderOptions` perche' `rendererCtx` e' molto piu' in alto: li'
     `renderOptions` sarebbe ancora in TDZ. */
  const currentRenderer = tweaks.renderRenderer;

  useEffectApp(() => { window.PGE_TWEAKS = tweaks; }, [tweaks]);

  useEffectApp(() => {
    document.documentElement.style.setProperty("--accent", tweaks.accent);
    document.documentElement.style.setProperty("--lane-h", tweaks.laneHeight + "px");
    document.documentElement.style.setProperty("--browser-w", tweaks.browserWidth + "px");
    document.documentElement.style.setProperty("--inspector-w", tweaks.inspectorWidth + "px");
    document.documentElement.style.setProperty("--terminal-h", (tweaks.terminalHeight || 220) + "px");
    document.documentElement.style.setProperty("--grainscore-h", (tweaks.grainScoreHeight || 260) + "px");
    document.body.dataset.density = tweaks.density;
  }, [tweaks.accent, tweaks.laneHeight, tweaks.browserWidth, tweaks.inspectorWidth, tweaks.density, tweaks.terminalHeight, tweaks.grainScoreHeight]);

  /* ============ History-aware data state ============ */
  const [data, _setDataRaw] = useStateApp(EMPTY_PROJECT);
  // Pure stack mechanics (cap 200, gesture collapse, undo/redo) live in
  // history-core.js (window.PGEHistoryCore), node-tested in test-history-core.js.
  // The React glue — _setDataRaw, the setHistVer re-render bump, the freeze-on-
  // resize confirm and window.PGEHistory — stays here and delegates to it. #58
  const HC = window.PGEHistoryCore;
  const historyRef = useRefApp(HC.create());
  const [, setHistVer] = useStateApp(0);
  const freezeOriginRef = useRefApp(null);   // {id, stream} captured at gesture start when freeze ON
  const pendingTruncateRef = useRefApp(null); // {id} set during gesture if shrink would truncate

  function setData(updater) {
    _setDataRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next === prev) return prev;
      if (HC.record(historyRef.current, prev)) setHistVer(v => v + 1);
      return next;
    });
  }
  function beginGesture() {
    HC.beginGesture(historyRef.current);
  }
  function endGesture() {
    if (HC.commitGesture(historyRef.current)) setHistVer(v => v + 1);
    freezeOriginRef.current = null;

    const pending = pendingTruncateRef.current;
    pendingTruncateRef.current = null;
    if (pending) {
      if (window.confirm(
        "Reducing duration with freeze ON truncated breakpoints beyond the new end.\n\nBreakpoint data will be lost. (Cancel to undo)"
      )) {
        setData(d => ({
          ...d,
          streams: d.streams.map(s => s.id === pending.id ? truncateStreamEnvelopes(s) : s),
        }));
      } else {
        undo();
      }
    }
  }
  function undo() {
    _setDataRaw(cur => {
      const r = HC.undo(historyRef.current, cur);
      if (r.bumped) setHistVer(v => v + 1);
      return r.data;
    });
  }
  function redo() {
    _setDataRaw(cur => {
      const r = HC.redo(historyRef.current, cur);
      if (r.bumped) setHistVer(v => v + 1);
      return r.data;
    });
  }
  function resetHistory() {
    HC.reset(historyRef.current);
    setHistVer(v => v + 1);
  }
  const canUndo = HC.canUndo(historyRef.current);
  const canRedo = HC.canRedo(historyRef.current);

  useEffectApp(() => {
    window.PGEHistory = { beginGesture, endGesture, undo, redo,
                          get canUndo() { return HC.canUndo(historyRef.current); },
                          get canRedo() { return HC.canRedo(historyRef.current); } };
    return () => { if (window.PGEHistory) delete window.PGEHistory; };
  }, []);

  useEffectApp(() => {
    function onKey(e) {
      const tg = e.target;
      if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
      else if (k === "s" && !e.shiftKey) { e.preventDefault(); onSave(); }
      else if (k === "s" && e.shiftKey)  { e.preventDefault(); onSaveAs(); }
      else if (k === "c" && selectedIds.length > 0 && !window.getSelection()?.toString()) { e.preventDefault(); copySelectedStreams(); }
      else if (k === "v" && clipboardRef.current.length > 0) { e.preventDefault(); pasteStreams(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const [selectedIds, setSelectedIds] = useStateApp([]);
  // The selected LANE, when the selection was made on a track header. Distinct
  // from `selectedIds` on purpose: it is the only handle on an empty lane (it
  // has no clip to select), and it is what Delete needs to tell "remove these
  // clips" from "remove this track".
  const [selectedTrackId, setSelectedTrackId] = useStateApp(null);
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const anchorIdRef = React.useRef(null);
  const [loopPanelOpen, setLoopPanelOpen] = useStateApp(false);
  const [inspectorOpen, setInspectorOpen] = useStateApp(false);
  const [browserOpen, setBrowserOpen] = useStateApp(true);
  const [inspectorTab, setInspectorTab] = useStateApp("preview");
  const [playing, setPlaying] = useStateApp(false);
  const [time, setTime] = useStateApp(0);
  const [loopEnabled, setLoopEnabled] = useStateApp(false);
  const [loopRegion, setLoopRegion] = useStateApp({ start: 0, end: 0 });
  const [dirty, setDirty] = useStateApp(true);
  const [activeProject, setActiveProject] = useStateApp(tweaks.activeProject || "PGE_test.yml");
  const [activeSample, setActiveSample] = useStateApp(null);
  const [previewSample, setPreviewSample] = useStateApp(null);
  const tickRef = useRefApp();
  const arrowGestureRef = useRefApp(false);
  // Shared with EnvelopeEditor: when it owns the arrow keys (a breakpoint is
  // selected and the pointer last landed inside the editor), the timeline
  // clip-nudge below defers so ←/→ moves the breakpoint, not the clip.
  const envArrowRef = useRefApp({ focused: false, singleBPSelected: false });
  const clipboardRef = React.useRef([]);
  const [mediaList, setMediaList] = useStateApp({ loading: false, path: null, files: [], error: null });
  // Copia della media list leggibile DOPO un await, dove lo stato catturato
  // nella closure del render sarebbe gia' vecchio. Serve a onProjectSelect:
  // fra `await readFile(...)` e il `parse` che risolve le durate implicite
  // (PGE #205) la lista puo' essere atterrata, e senza questo il progetto
  // verrebbe parsato con quella vuota — durate sul fallback e nessun evento
  // successivo che le ripari, perche' `mediaList` non cambia piu'.
  const mediaFilesRef = useRefApp([]);
  const [projectsList, setProjectsList] = useStateApp({ loading: false, path: null, files: [], error: null });

  /* ============ Render state ============ */
  // lastRenderedFingerprints[streamId] = "abc123…" — what was on disk at last render
  const [lastRenderedFps, setLastRenderedFps] = useStateApp({});
  /* La semantica del motore, su due lati (#133). `engineSem` e' quella del
     motore che il bridge ha davanti adesso; `renderedSem` quella con cui ogni
     stem e' stato scritto. Quando divergono lo stem e' vecchio anche a YAML
     fermo — il motore lo rifara' diverso — e il pallino deve dirlo. I due
     ignoti non sono lo stesso ignoto: `engineSem` a `null` = non si sa, e non
     si pretende niente; voce assente in `renderedSem` col motore noto = stem di
     cui non si sa la lettura, e chi classifica lo legge stale (un giro lo
     spegne, anche a vuoto). Stessa regola del backend qui sotto. */
  const [engineSem, setEngineSem] = useStateApp(null);
  const [renderedSem, setRenderedSem] = useStateApp({});
  /* Il terzo asse (#151): il backend che ha scritto ogni stem. Un solo lato in
     stato, perche' quello vivo e' la scelta del popover (`currentRenderer`,
     #150) — l'editor sa con chi renderizzerebbe adesso. Voce assente = stem
     reso prima che l'editor lo registrasse, e chi classifica la legge come
     stale. */
  const [renderedRenderer, setRenderedRenderer] = useStateApp({});
  /* Il ref accanto allo stato, per la stessa ragione di `mediaFilesRef`: gli
     eventi `stream-done` arrivano dentro un `await` gia' in volo, e leggerebbero
     l'`engineSem` catturato quando `onRender` e' stata definita — cioe' quello
     di prima della rilettura che `onRender` fa all'inizio. Il ref e' il valore
     di adesso; lo stato serve alla classificazione, che rigira da sola. */
  const engineSemRef = useRefApp(null);
  /* Guardia di rientro del render, su un REF e non sullo stato.
     `renderStatus.running` da solo non la fa: l'effetto della scorciatoia
     (`onKey`) ha dipendenze `[dirty]`, quindi chiude su un `onRender` vecchio e
     su un `renderStatus` piu' vecchio ancora — due `r` ravvicinati leggevano
     entrambi `running: false` comunque si ordinassero le setState. Un ref si
     alza nello stesso tick e vale per ogni chiusura, viva o stantia. */
  const renderingRef = useRefApp(false);

  /* La versione di semantica del motore, richiesta al bridge.
   *
   * Chiamata in tre punti — boot, cambio progetto, inizio di un render — e non
   * solo al boot, che e' il difetto che questa funzione chiude: l'effetto di
   * boot ha le dipendenze vuote e `serverDown` non torna mai a falso senza un
   * reload, quindi chi apriva l'editor PRIMA di lanciare `make serve` restava
   * senza asse semantica per tutta la sessione. E in modo asimmetrico: il
   * render REGISTRAVA comunque la versione su `pge-local-sem` (backend.js la
   * chiede per conto suo), ma il lato con cui confrontarla non arrivava mai,
   * quindi nessun pallino poteva dirlo.
   *
   * `{refresh:true}` e non la cache: il numero e' una proprieta' del MOTORE
   * accanto, e quello cambia sotto i piedi (un `git checkout` nel repo fratello,
   * un pull) mentre l'editor resta aperto. Con la cella memorizzata a vita
   * questi tre punti smettevano di essere riletture — diventavano `return`
   * immediati — e un bump non arrivava mai al pallino: verde su stem che il
   * motore rifara' diversi, fino al reload. Il bridge, un livello piu' sotto, fa
   * gia' il contrario apposta (invalidazione sull'mtime in engine_introspect).
   *
   * Costa una fetch locale su una lettura AST gia' cachata lato bridge. */
  async function refreshEngineSem() {
    const backend = window.PGEBackend.current;
    if (!backend || !backend.semanticsVersion) return null;
    let v = null;
    // Il catch e' difensivo, non atteso: `semanticsVersion` ha il proprio
    // try/catch e non lancia mai (backend.js). Resta perche' qui si chiama
    // attraverso `window.PGEBackend.current`, cioe' un'implementazione del
    // contratto e non quella funzione: un rigetto non gestito dentro un
    // effetto sarebbe peggio della riga.
    try { v = await backend.semanticsVersion({ refresh: true }); } catch { v = null; }
    const n = Number.isInteger(v) ? v : null;
    engineSemRef.current = n;
    setEngineSem(n);
    return n;
  }

  /* I clamp del motore (`GET /bounds`), richiesti al bridge.
   *
   * Tre call site come `refreshEngineSem`, e per la stessa ragione — con un
   * lettore in piu' a renderla piu' urgente, non meno. Questo payload porta
   * anche `output_sr`, e `PGEBounds.apply` lo installa su
   * `window.PGE_OUTPUT_SR`: da li' lo legge `grainUnitFactor`
   * (envelope-utils.js), cioe' il fattore con cui `convertGrainDurationUnit`
   * RISCRIVE `duration`/`duration_range` nello YAML. Un numero vecchio non
   * stringe una manopola, scrive durate sbagliate su disco.
   *
   * Col solo call site di boot — effetto a dipendenze vuote, dentro il `try`
   * del `/health` — chi apriva l'editor prima di `make serve` restava sul
   * letterale statico di yaml-bridge.js per tutta la sessione; e un
   * `git checkout` nel repo fratello sotto un `make serve` acceso non arrivava
   * mai in pagina, benche' `engine_introspect` invalidi la sua cache
   * sull'mtime apposta per farcelo arrivare.
   *
   * `apply()` e' idempotente per lo stesso payload: `mergeEngineBounds` non
   * muta `base` e riscrive ogni chiave che il motore dichiara con lo stesso
   * valore, quindi richiamarla non accumula. Best-effort: un server.py o un
   * motore senza quei file rispondono `{}` e il fallback statico resta. */
  async function refreshEngineBounds() {
    const backend = window.PGEBackend.current;
    if (!window.PGEBounds || !backend || !backend.bounds) return null;
    try {
      const raw = await backend.bounds();
      if (raw && Object.keys(raw).length) return window.PGEBounds.apply(raw);
    } catch { /* bridge giu' o route assente: il fallback statico resta */ }
    return null;
  }

  /* I backend audio del motore e cosa serve a ciascuno per girare (#150).
   *
   * Due call site: il boot, e l'apertura del popover di render. Il secondo e'
   * quello che conta: la disponibilita' e' una proprieta' della MACCHINA (scsynth
   * nel PATH, la SynthDef compilata), e chi installa SuperCollider con l'editor
   * aperto deve vederlo quando torna a scegliere, non al prossimo reload. Il
   * bridge non la mette in cache per la stessa ragione.
   *
   * Best-effort come gli altri: un server.py senza la route, un bridge giu' o un
   * motore di cui non si legge l'elenco danno [], e il popover resta sul
   * backend corrente, bloccato — il comportamento di prima. */
  async function refreshRenderers() {
    const backend = window.PGEBackend.current;
    if (!backend || !backend.renderers) return;
    let rows = [];
    try { rows = await backend.renderers(); } catch { rows = []; }
    setEngineRenderers(Array.isArray(rows) ? rows : []);
  }
  const [waveforms, setWaveforms] = useStateApp({});  // {streamId: Float32Array of peaks}
  const [spectrograms, setSpectrograms] = useStateApp({});  // {streamId: ArrayBuffer of STFT grid}
  const [grainData, setGrainData] = useStateApp({});  // {streamId: grain JSON sidecar {duration, grains:[…]}}
  // Refetch selettivo dei grani (#73): grainLoadedRef = stream con grani già in
  // grainData (mirror, evita lo stale-closure su grainData nell'effetto);
  // grainRegenRef = stream rigenerati dall'ultimo render (cached=false → JSON
  // riscritto dal motore) ancora da rifetchare. Solo questi due insiemi guidano
  // il refetch — i clean restano intatti.
  const grainLoadedRef = useRefApp(new Set());
  const grainRegenRef = useRefApp(new Set());
  // Revisione per-stream incrementata a ogni rigenerazione reale dello stem
  // (stream-done con cached=false). Il fingerprint dei peaks esclude `onset`
  // (FP_IGNORE), ma spostare un clip sulla timeline fa rigenerare lo stem dal
  // motore con audio DIVERSO: senza questo token la cache peaks (url#fingerprint
  // in audio-engine) non si invaliderebbe e il waveform resterebbe vecchio.
  // Lo includiamo nella chiave peaks così solo gli stream rigenerati rifetchano
  // (spettrogramma e grani si aggiornano già, non avendo questa cache).
  const stemRevRef = useRefApp({});
  // Il segnale che fa ripartire i tre effetti dei media quando i ref qui sopra
  // si muovono SENZA uno `stream-done` — cioe' senza che `lastRenderedFps`
  // cambi riferimento. Oggi un caso solo: `stems-resync`, il giro fallito che
  // ha trovato stem su disco (#151). Un ref alzato e nessun effetto che riparte
  // e' un ref che nessuno legge.
  const [stemResync, setStemResync] = useStateApp(0);
  const [terminalOpen, setTerminalOpen] = useStateApp(!!tweaks.terminalOpen);
  const [scopeOpen, setScopeOpen] = useStateApp(!!tweaks.scopeOpen);
  const [grainScoreOpen, setGrainScoreOpen] = useStateApp(!!tweaks.grainScoreOpen);
  const [logLines, setLogLines] = useStateApp([]);
  /* Niente campo di avanzamento dentro lo stream, ne' qui ne' nella mappa per
     stream che stava sotto (#162). Il ramo `stream-progress` di `run()` era il
     solo scrittore di entrambi, e quell'evento non lo emette nessuno: non
     server.py, non render_pipeline.py, e il motore non ha una riga da cui
     ricavarlo — l'avanzamento che stdout sa portare e' per stream intero
     (`[CACHE] <id>: …`), non dentro uno. Quindi la barra per clip disegnava
     0% per tutto il render e 100% nell'istante fra uno `stream-done` e lo
     `stream-start` successivo, che non e' informazione: e' residuo.
     Il giorno che l'evento esista davvero sara' perche' il protocollo e'
     diventato esplicito — e' la condizione 2 delle tre che PGE #178 elenca
     (`docs/explanation/contratto-stdout.md` del motore) — e allora lo stato
     torna insieme al suo emettitore, non prima. */
  const [renderStatus, setRenderStatus] = useStateApp({
    running: false, total: 0, done: 0, currentStreamId: null,
    lastOk: null, lastGenerated: 0,
  });
  const [toasts, setToasts] = useStateApp([]);
  const toastIdRef = useRefApp(0);
  const [settingsOpen, setSettingsOpen] = useStateApp(false);
  // Single backend (`local`). Kept as a value for the few places that still
  // surface it (Settings footer, diagnose label) — it never changes now.
  const backendKind = "local";
  const [serverDown, setServerDown] = useStateApp(false);
  // Valid score-envelope names for the --plot-envelopes filter, fetched from
  // the engine via server.py (issue #31). [] = feature unavailable → filter hidden.
  const [envelopeKeys, setEnvelopeKeys] = useStateApp([]);
  // I backend audio del motore, con la disponibilita' di ciascuno (#150): la
  // lista la legge il bridge dal sorgente del motore (GET /renderers), il
  // popover ne fa i bottoni. [] = non lo so → resta il backend corrente.
  const [engineRenderers, setEngineRenderers] = useStateApp([]);
  const [freezeEnvOnResize, setFreezeEnvOnResize] = useStateApp(false);
  const [envFocusKey, setEnvFocusKey] = useStateApp(null);

  async function _syncPathsFromServer(baseUrl, currentTweaks) {
    try {
      const res = await fetch(baseUrl + "/health");
      if (!res.ok) return;
      const h = await res.json();
      if (!currentTweaks.mediaPath)    setTweak("mediaPath",    h.refs);
      if (!currentTweaks.projectsPath) setTweak("projectsPath", h.configs);
      if (!currentTweaks.outputPath || currentTweaks.outputPath === "output") setTweak("outputPath", h.output);
    } catch {}
  }

  async function refreshMedia() {
    const backend = window.PGEBackend.current;
    setMediaList(l => ({ ...l, loading: true, error: null }));
    try {
      const r = await backend.fs.listDir("media");
      // Il ref si aggiorna qui, non in un effetto: fra il setState e il giro di
      // effetti puo' inserirsi la continuazione di un await gia' in volo, ed e'
      // esattamente quella che deve leggere la lista fresca.
      mediaFilesRef.current = r.files || [];
      setMediaList({ loading: false, path: r.path, files: r.files || [], error: r.error || null });
    } catch (e) {
      setMediaList(l => ({ ...l, loading: false, error: e.message }));
    }
  }
  async function refreshProjects() {
    const backend = window.PGEBackend.current;
    setProjectsList(l => ({ ...l, loading: true, error: null }));
    try {
      const r = await backend.fs.listDir("projects");
      setProjectsList({ loading: false, path: r.path, files: r.files || [], error: r.error || null });
    } catch (e) {
      setProjectsList(l => ({ ...l, loading: false, error: e.message }));
    }
  }
  // Boot: bind the backend to the configured server URL and probe /health.
  // If reachable → sync resolved paths, list media/projects, run engine setup
  // silently. If not → flag serverDown so the UI tells the user to start
  // server.py (local is the only backend).
  useEffectApp(() => {
    (async () => {
      const baseUrl = tweaks.serverUrl || window.PGEBackend.defaultServerUrl();
      window.PGEBackend.current = window.PGEBackend.create({ baseUrl });
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(baseUrl + "/health", { signal: ctrl.signal });
        clearTimeout(tid);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setServerDown(false);
        _syncPathsFromServer(baseUrl, tweaks);
        refreshMedia();
        refreshProjects();
        // Pull the valid score-envelope names so the render-options filter can
        // offer them (issue #31). Best-effort: empty list just hides the filter.
        if (window.PGEBackend.current.envelopeKeys) {
          window.PGEBackend.current.envelopeKeys()
            .then(keys => setEnvelopeKeys(Array.isArray(keys) ? keys : []))
            .catch(() => {});
        }
        // I backend audio del motore, per il selettore del popover (#150).
        // Primo dei due punti in cui si chiede — vedi refreshRenderers.
        refreshRenderers();
        // Pull the engine's parameter clamps so the UI's bounds + envelope
        // auto-fit track the engine instead of the static fallback. Best-effort:
        // an older server.py / engine returns {} and the fallback stays.
        //
        // Lo stesso payload porta `output_sr` (DEFAULT_OUTPUT_SR), e apply()
        // lo installa su window.PGE_OUTPUT_SR. Non e' un dettaglio dei bound:
        // e' il fattore con cui envelope-utils converte
        // `grain.duration_unit: samples`, e quella conversione riscrive
        // duration/duration_range nello YAML. Primo dei tre punti in cui si
        // chiede — vedi refreshEngineBounds.
        refreshEngineBounds();
        // La versione di semantica del motore, per sapere se gli stem gia' su
        // disco sono stati scritti con la lettura di adesso. Best-effort: un
        // server.py senza la route o un motore senza la costante danno null, e
        // i pallini restano quelli di prima. Questo e' il primo dei tre punti
        // in cui si chiede — vedi refreshEngineSem.
        refreshEngineSem();
        // Run setup in background so the engine venv is ready.
        setTimeout(async () => {
          const backend = window.PGEBackend.current;
          if (backend.setup) {
            logToTerminal("[auto-setup] checking engine venv…", "");
            await backend.setup(ev => {
              if (ev.type === "log" && ev.line != null) logToTerminal(ev.line, "");
            });
            logToTerminal("[auto-setup] done", "ok");
          }
        }, 100);
      } catch {
        setServerDown(true);
        logToTerminal(`[boot] server non raggiungibile su ${baseUrl} — avvia il bridge (pge-ui, o make serve)`, "err");
        pushToast({
          kind: "warn", title: "Server non raggiungibile",
          message: `avvia il bridge su ${baseUrl} (pge-ui, o make serve)`,
          persistent: true,
        });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-load a real project once the projects list arrives. Prefer the
  // persisted activeProject; fall back to the first project on disk.
  const bootLoadedRef = useRefApp(false);
  useEffectApp(() => {
    if (bootLoadedRef.current) return;
    const files = projectsList.files || [];
    if (!files.length) return;
    bootLoadedRef.current = true;
    const target = files.some(f => f.name === activeProject) ? activeProject : files[0].name;
    onProjectSelect(target);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsList.files]);

  // Le durate implicite (PGE #205) si risolvono dalla media list, che al boot
  // arriva DOPO il progetto: `GET /projects` e `GET /media` partono insieme e
  // la prima risponde per prima (l'altra apre l'header di ogni file audio).
  // Senza questa seconda passata ogni stream senza `duration` resterebbe sul
  // fallback per tutta la sessione — 5 secondi in timeline, nota di durata
  // stimata, `computeDuration` sbagliata, e stem che al reload successivo
  // risultano stale perche' il fingerprint e' stato calcolato sul numero finto.
  //
  // Il gate e' `path !== null`, non `!loading`: lo stato iniziale della lista e'
  // gia' "non in caricamento" prima ancora che il fetch parta, quindi `loading`
  // non distingue "vuota perche' non ancora chiesta" da "vuota davvero".
  //
  // _setDataRaw e non setData: l'arrivo dei media non e' una modifica
  // dell'utente. Non deve sporcare il progetto ne' diventare un passo di undo.
  useEffectApp(() => {
    if (mediaList.path === null) return;
    if (!window.PGEYaml || !window.PGEYaml.resolveImplicitDurations) return;
    _setDataRaw(d => window.PGEYaml.resolveImplicitDurations(d, mediaList.files || []));
  }, [mediaList.path, mediaList.files]);

  // Boot diagnostic — once per session, log a summary to console + terminal
  // so the first thing visible during a smoke test is a clear picture of
  // what's working. Runs after a tick so the engines have time to attach.
  const bootedRef = useRefApp(false);
  useEffectApp(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      const backend = window.PGEBackend.current;
      logToTerminal(`PGE-ui ready · backend=${backend.kind}`, "");
      if (backend.diagnose) {
        try {
          const d = await backend.diagnose();
          for (const c of d.checks) {
            logToTerminal(`  ${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}`, c.ok ? "ok" : "warn");
          }
          if (!d.ok) {
            pushToast({ kind: "warn", title: "Diagnostic issues",
                        message: "some checks failed — see terminal",
                        action: { label: "open log", onClick: () => setTerminalOpen(true) },
                        duration: 5000 });
          }
        } catch (e) {
          logToTerminal(`  ✗ diagnose threw: ${e.message}`, "err");
        }
      }
      // Expose for the user to re-run from devtools.
      window.PGEDiag = async () => {
        const b = window.PGEBackend.current;
        const r = b.diagnose ? await b.diagnose() : { ok: false, checks: [] };
        console.table(r.checks);
        return r;
      };
    })();
  }, []);

  function pushToast(toast) {
    const id = ++toastIdRef.current;
    setToasts(ts => [...ts, { ...toast, id }]);
    if (!toast.persistent) {
      setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), toast.duration || 4000);
    }
    // L'id torna a chi deve poterlo togliere da se': la domanda di #185, che
    // una domanda nuova o un `apri` rendono superata (`dropChangedQuestion`).
    return id;
  }
  function dismissToast(id) { setToasts(ts => ts.filter(x => x.id !== id)); }
  function dismissErrToasts() { setToasts(ts => ts.filter(x => x.kind !== "err")); }

  /* Load cache manifest when project changes */
  useEffectApp(() => {
    const backend = window.PGEBackend.current;
    const basename = activeProject.replace(/\.yml$/, "");
    // Cambio progetto: i grani in memoria sono del progetto precedente. Svuota la
    // cache UI e gli insiemi loaded/regen così il nuovo progetto riparte pulito e
    // il primo fetch (tutti "non loaded") non viene saltato (#73).
    setGrainData({});
    grainLoadedRef.current = new Set();
    grainRegenRef.current = new Set();
    stemRevRef.current = {};
    backend.render.loadCache(basename).then(cache => {
      setLastRenderedFps(cache || {});
    });
    // Con le versioni registrate si rilegge anche quella del motore: se al boot
    // il bridge era giu', questo e' il primo momento in cui puo' arrivare. E
    // con essa i clamp, che dallo stesso payload prendono il sample rate: le
    // due letture invecchiano insieme, per lo stesso `git pull` nel repo
    // fratello.
    refreshEngineSem();
    refreshEngineBounds();
    if (backend.render.loadSemantics) {
      backend.render.loadSemantics(basename).then(sem => setRenderedSem(sem || {}));
    } else {
      setRenderedSem({});
    }
    if (backend.render.loadRenderers) {
      backend.render.loadRenderers(basename).then(r => setRenderedRenderer(r || {}));
    } else {
      setRenderedRenderer({});
    }
  }, [activeProject]);

  /* Current fingerprint per stream — recomputed when data changes. The
     stale/fresh/never classification + summary live in render-status.js
     (window.PGERenderStatus), node-tested in test-render-status.js. #58 */
  const currentFps = useMemoApp(
    () => window.PGERenderStatus.fingerprintAll(data.streams, tweaks.outputFormat || "wav"),
    [data.streams, tweaks.outputFormat]);

  /* Composition length is derived from the streams (furthest edge + silent tail),
     not the stored data.duration which goes stale after edits. Single source of
     truth lives in yaml-bridge.computeDuration. */
  const compDuration = useMemoApp(
    () => window.PGEYaml ? window.PGEYaml.computeDuration(data.streams) : data.duration,
    [data.streams]);

  // hasStem(id): is there a stem this editor can actually *play* — i.e. one in
  // the Settings output format, which is the extension stemUrl() will request?
  // A stem rendered only in the other format is not playable: the request 404s
  // and the <audio> element says so by never firing `canplay`. Falls back to "we
  // have a last-rendered fingerprint for it" when the backend can't answer.
  // Closes over the live lastRenderedFps so the per-stream fallback stays right.
  const hasStemFor = (id) => {
    const basename = activeProject.replace(/\.yml$/, "");
    const backend = window.PGEBackend.current;
    return backend.render.hasStem
      ? backend.render.hasStem(basename, id, tweaks.outputFormat || "wav")
      : !!lastRenderedFps[id];
  };
  // ownsStem(id): does a file on disk still claim this id, in any format? Only
  // id allocation asks — it must reject an id whose stem survives in the format
  // the editor isn't currently rendering, or the new stream inherits the dead
  // one's audio as soon as the format flips back.
  const ownsStemFor = (id) => {
    const basename = activeProject.replace(/\.yml$/, "");
    const backend = window.PGEBackend.current;
    return backend.render.ownsStem ? backend.render.ownsStem(basename, id) : !!lastRenderedFps[id];
  };

  /* La coppia che render-status.js legge per l'asse "semantica". Un oggetto
     solo, cosi' summarize e statusForStream non possono ricevere versioni
     diverse dello stesso dato. */
  const semCtx = useMemoApp(() => ({ rendered: renderedSem, engine: engineSem }),
    [renderedSem, engineSem]);
  /* E la coppia dell'asse "backend", con la stessa forma e per la stessa
     ragione. `current` e' la scelta del popover (`currentRenderer`, #150): qui
     non c'e' un lato ignoto come per la semantica — il backend con cui
     l'editor renderizzerebbe adesso lo sa sempre, e' una sua scelta, non una
     lettura del motore. Cambiarla accende il giallo su ogni stem scritto da un
     altro backend, che e' il motivo per cui l'asse e' stato costruito prima
     del selettore.
     Passa comunque da `rendererName`, la regola che decide cosa si registra:
     un valore che non e' un nome sarebbe un `current` noto contro record che
     nessun render scrive, cioe' giallo per sempre — e adesso il valore arriva
     da una preferenza, cioe' proprio dal punto in cui le tre copie di prima
     avrebbero diverso. */
  const rendererCtx = useMemoApp(
    () => ({ rendered: renderedRenderer, current: window.PGEBackend.rendererName(currentRenderer) }),
    [renderedRenderer, currentRenderer]);

  /* Aggregate render summary: counts of fresh / stale / never */
  const renderSummary = useMemoApp(
    () => window.PGERenderStatus.summarize(data.streams, currentFps, lastRenderedFps, hasStemFor,
                                          semCtx, rendererCtx),
    [data.streams, currentFps, lastRenderedFps, activeProject, semCtx, rendererCtx]);

  function renderStatusForStream(streamId) {
    return window.PGERenderStatus.statusForStream(streamId, {
      currentFps, lastRenderedFps, hasStem: hasStemFor,
      running: renderStatus.running,
      currentStreamId: renderStatus.currentStreamId,
      sem: semCtx,
      rend: rendererCtx,
    });
  }

  /* ============ Playback (Web Audio driven) ============ */
  // Drive the timeline from the AudioEngine's clock when playing.
  useEffectApp(() => {
    function onTick(e) { setTime(e.detail); }
    window.addEventListener("pge-audio-tick", onTick);
    return () => window.removeEventListener("pge-audio-tick", onTick);
  }, []);

  // A clip that cannot sound must not do it quietly. The engine raises one
  // pge-audio-error per stream per schedule (a missing stem, a rejected play);
  // every one goes to the terminal, and the first of each playback raises a
  // single toast pointing there — a project with ten broken stems must not mean
  // ten toasts.
  const audioErrToastedRef = useRefApp(false);
  useEffectApp(() => {
    function onErr(e) {
      const { streamId, message } = e.detail || {};
      logToTerminal(`[audio] ${streamId}: ${message}`, "err");
      if (audioErrToastedRef.current) return;
      audioErrToastedRef.current = true;
      pushToast({
        kind: "warn", title: `${streamId} resta muto`, message, duration: 6000,
        action: { label: "open log", onClick: () => { setTerminalOpen(true); setTweak("terminalOpen", true); } },
      });
    }
    window.addEventListener("pge-audio-error", onErr);
    return () => window.removeEventListener("pge-audio-error", onErr);
  }, []);

  // Auto-stop when audio reaches duration (skip if looping)
  useEffectApp(() => {
    if (playing && time >= compDuration && !(loopEnabled && loopRegion.end > loopRegion.start)) {
      const engine = window.PGEAudio?.engine;
      if (engine) engine.stop();
      setPlaying(false);
      setTime(0);
    }
  }, [time, playing, compDuration, loopEnabled, loopRegion.start, loopRegion.end]);

  // Loop-back when playhead reaches loop region end
  useEffectApp(() => {
    if (playing && loopEnabled && loopRegion.end > loopRegion.start && time >= loopRegion.end) {
      const t = loopRegion.start;
      window.PGEAudio?.engine?.seek(t);
      setTime(t);
    }
  }, [time, playing, loopEnabled, loopRegion.start, loopRegion.end]);

  // Keep engine's mute/solo in sync with stream data
  useEffectApp(() => {
    const engine = window.PGEAudio?.engine;
    if (!engine) return;
    engine.syncMuteSoloFromStreams(data.streams);
  }, [data.streams.map(s => `${s.id}:${s.mute ? 1 : 0}:${s.solo ? 1 : 0}`).join("|")]);

  const prevStreamSchedulingRef = useRefApp({});
  useEffectApp(() => {
    const engine = window.PGEAudio?.engine;
    if (!engine || !playing) return;
    const prev = prevStreamSchedulingRef.current;
    for (const s of data.streams) {
      const key = `${s.onset}:${s.duration}`;
      if (prev[s.id] !== key) engine.rescheduleStream(s);
    }
    prevStreamSchedulingRef.current = Object.fromEntries(
      data.streams.map(s => [s.id, `${s.onset}:${s.duration}`])
    );
  }, [data.streams.map(s => `${s.id}:${s.onset}:${s.duration}`).join("|"), playing]);

  // Drop cached audio buffers only when a fresh render produced a file with
  // a different fingerprint than what we have buffered. Editing the YAML
  // (which moves `currentFps` but not `lastRenderedFps`) is NOT a reason to
  // drop the buffer — the buffered audio is still the most recent render.
  useEffectApp(() => {
    const engine = window.PGEAudio?.engine;
    if (!engine?.bufferKeys) return;
    for (const [sid, lastFp] of Object.entries(lastRenderedFps)) {
      if (!lastFp) continue;
      const key = engine.bufferKeys.get(sid);
      if (!key) continue;
      if (!key.endsWith("#" + lastFp)) {
        engine.invalidateStream(sid);
      }
    }
  }, [lastRenderedFps]);

  /* Chiave stabile per i tre effetti che caricano media per stream (peaks,
   * spettrogrammi, grani). Prima dipendevano da `data.streams`, cioe'
   * dall'IDENTITA' dell'array: e lo stato e' immutabile, quindi ogni gesto che
   * ricompone la lista ne fabbrica una nuova anche quando non cambia un dato.
   * `applyTracks` la ricompone a ogni spostamento fra corsie — stessi oggetti,
   * stesso contenuto, array nuovo — e faceva ripartire il caricamento di TUTTI
   * gli stem, ognuno con la sua setState. A questi effetti interessa quali
   * stream esistono e quanto sono lunghi, non in che ordine stanno: `onset` sta
   * deliberatamente fuori, muovere una clip nel tempo non tocca il suo audio.
   * Stesso idioma degli effetti mute/solo e onset/duration qui sopra. */
  const streamMediaKey = useMemoApp(
    () => data.streams.map(s => `${s.id}:${s.duration}:${s.sample}`).join("|"),
    [data.streams]);

  // Load waveform peaks for clips. Lazy-ish: decode each rendered stem once
  // (cached in the engine by url#fingerprint) and stash its peak array in
  // `waveforms` for the Timeline to draw. Only streams with a rendered stem
  // get peaks. Re-runs when streams or last-rendered fingerprints change, so
  // a re-render refreshes the affected waveform (engine.invalidateStream having
  // already dropped the stale peaks).
  useEffectApp(() => {
    const backend = window.PGEBackend.current;
    const engine = window.PGEAudio?.engine;
    if (!engine?.ensurePeaks) return;
    const basename = activeProject.replace(/\.yml$/, "");
    let cancelled = false;
    (async () => {
      for (const s of data.streams) {
        if (cancelled) return;
        const last = lastRenderedFps[s.id];
        const hasStem = hasStemFor(s.id);
        if (!hasStem) {
          setWaveforms(w => { if (!(s.id in w)) return w; const m = { ...w }; delete m[s.id]; return m; });
          continue;
        }
        const url = backend.render.stemUrl ? backend.render.stemUrl(basename, s.id, tweaks.outputFormat || "wav") : null;
        // Il formato va passato anche qui, non solo a stemUrl: sono lo stesso
        // file, e senza si sente l'audio nuovo mentre si vede il disegno di un
        // render precedente rimasto sul disco nell'altro formato (#153).
        const peaksUrl = backend.render.peaksUrl
          ? backend.render.peaksUrl(basename, s.id, tweaks.outputFormat || "wav") : null;
        // La revisione stem fa parte della chiave peaks così una rigenerazione
        // che non muove il fingerprint (onset escluso) rinfresca comunque il
        // waveform — l'effetto rigira a ogni stream-done (lastRenderedFps cambia
        // riferimento) e qui rilegge il valore aggiornato del ref.
        const rev = stemRevRef.current[s.id] || 0;
        const peaksFp = (last || currentFps[s.id]) + "#r" + rev;
        try {
          const peaks = await engine.ensurePeaks(s.id, { duration: s.duration, fingerprint: peaksFp, url, peaksUrl });
          // Stesso oggetto peaks -> stesso state: senza questa guardia ogni giro
          // dell'effetto produceva una mappa nuova, quindi un render, per un
          // dato identico. E' la meta' del ciclo che bloccava la pagina.
          if (!cancelled && peaks) setWaveforms(w => w[s.id] === peaks ? w : ({ ...w, [s.id]: peaks }));
        } catch (e) { /* stem missing or undecodable — leave clip flat */ }
      }
    })();
    return () => { cancelled = true; };
  }, [streamMediaKey, lastRenderedFps, stemResync, activeProject, backendKind, tweaks.outputFormat]);

  // Load STFT spectrograms for clips — only while the spectrogram view is on
  // (heavier than peaks, so don't fetch when hidden). Twin of the peaks effect:
  // fetches the server-computed grid per rendered stem and stashes the raw
  // ArrayBuffer for the Timeline to paint. Refetches on re-render (fingerprint
  // change) and when the toggle flips on.
  useEffectApp(() => {
    if (!tweaks.showSpectrograms) return;
    const backend = window.PGEBackend.current;
    if (!backend.render.spectrogramUrl) return;
    const basename = activeProject.replace(/\.yml$/, "");
    let cancelled = false;
    (async () => {
      for (const s of data.streams) {
        if (cancelled) return;
        const hasStem = hasStemFor(s.id);
        if (!hasStem) {
          setSpectrograms(m => { if (!(s.id in m)) return m; const n = { ...m }; delete n[s.id]; return n; });
          continue;
        }
        try {
          const res = await fetch(backend.render.spectrogramUrl(
            basename, s.id, tweaks.spectrogramScale || "linear",
            tweaks.outputFormat || "wav"));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          if (!cancelled && buf) setSpectrograms(m => m[s.id] === buf ? m : ({ ...m, [s.id]: buf }));
        } catch (e) { /* stem missing / numpy absent — leave clip without spectrogram */ }
      }
    })();
    return () => { cancelled = true; };
  }, [streamMediaKey, lastRenderedFps, stemResync, activeProject, backendKind, tweaks.showSpectrograms, tweaks.spectrogramScale, tweaks.outputFormat]);

  // Grain JSON sidecars (engine --grain-json) → per-stream data for the grain
  /* Caricamento MIRATO di un solo sidecar, su richiesta del readout della
   * timeline. L'effetto qui sotto carica i grani di tutti gli stream, ma solo
   * col layer grani acceso: il readout non ha motivo di dipendere da quel
   * toggle — il file e' su disco appena il motore ha renderizzato lo stream.
   * Scrive nella stessa mappa e negli stessi ref del caricamento in blocco,
   * cosi' i due non si rifanno il lavoro a vicenda; `grainRegenRef` resta la
   * fonte di verita' sullo stale, quindi un nuovo render lo fa rifetchare. */
  const grainReqRef = useRefApp(new Set());
  function ensureGrainData(id) {
    const stale = grainRegenRef.current.has(id);
    if ((grainData[id] && !stale) || grainReqRef.current.has(id)) return;
    const backend = window.PGEBackend.current;
    if (!backend.render.loadGrainData || !hasStemFor(id)) return;
    grainReqRef.current.add(id);
    const basename = activeProject.replace(/\.yml$/, "");
    backend.render.loadGrainData(basename, id).then(j => {
      grainReqRef.current.delete(id);
      if (!j) return;
      const GM = window.PGEGrainMap;
      if (GM) j._ext = GM.computeExtents(j.grains || []);
      setGrainData(m => ({ ...m, [id]: j }));
      grainLoadedRef.current.add(id);
      grainRegenRef.current.delete(id);
    }).catch(() => { grainReqRef.current.delete(id); });
  }

  // canvas inside clips and the score panel. Same lazy trigger as peaks/spectro:
  // refetches on fingerprint change (each stream-done). Gated by either the
  // in-clip toggle or the score panel being open.
  useEffectApp(() => {
    if (!tweaks.showGrains && !grainScoreOpen) return;
    const backend = window.PGEBackend.current;
    if (!backend.render.loadGrainData) return;
    const basename = activeProject.replace(/\.yml$/, "");
    let cancelled = false;
    const GM = window.PGEGrainMap;
    (async () => {
      // Streams senza stem: niente grani → rimuovili dalla mappa.
      const withStem = [], withoutStem = [];
      for (const s of data.streams) {
        const hasStem = hasStemFor(s.id);
        (hasStem ? withStem : withoutStem).push(s);
      }
      if (withoutStem.length) {
        setGrainData(m => {
          let n = null;
          for (const s of withoutStem) {
            if (s.id in m) { n = n || { ...m }; delete n[s.id]; }
          }
          return n || m;
        });
        for (const s of withoutStem) { grainLoadedRef.current.delete(s.id); grainRegenRef.current.delete(s.id); }
      }
      // Rifetcha solo gli stream rigenerati dal motore nell'ultimo render
      // (cached=false → grain JSON riscritto su disco) o mai caricati: i clean
      // tengono i dati già in grainData — niente fetch, niente computeExtents,
      // niente repaint (#73). Con cache disattivata tutti gli stream risultano
      // rigenerati, quindi tutti vengono rifetchati.
      const ids = withStem.map(s => s.id);
      const dirtyIds = GM && GM.selectGrainRefetch
        ? new Set(GM.selectGrainRefetch(ids, grainLoadedRef.current, grainRegenRef.current))
        : new Set(ids);  // fallback difensivo: senza l'helper, rifetcha tutto
      const toFetch = withStem.filter(s => dirtyIds.has(s.id));
      // Fetch dei sidecar dirty in parallelo (issue #71, bottleneck 3): con N
      // stream non si aspettano N round-trip in serie. Le extents (ptr/pitch)
      // vengono pre-calcolate qui una volta (bottleneck 4), non ad ogni repaint.
      const entries = await Promise.all(toFetch.map(async s => {
        if (cancelled) return null;
        try {
          const j = await backend.render.loadGrainData(basename, s.id);
          if (!j) return null;
          if (GM) j._ext = GM.computeExtents(j.grains || []);
          return [s.id, j];
        } catch (e) { return null; /* sidecar missing / not yet rendered */ }
      }));
      if (!cancelled) {
        const ok = entries.filter(Boolean);
        if (ok.length) {
          setGrainData(m => {
            const n = { ...m };
            for (const e of ok) n[e[0]] = e[1];
            return n;
          });
          // Aggiorna gli insiemi solo per i fetch riusciti: marca come caricato e
          // consuma il flag "rigenerato". Un fetch fallito (sidecar assente) resta
          // marcato e verrà ritentato al prossimo giro.
          for (const e of ok) { grainLoadedRef.current.add(e[0]); grainRegenRef.current.delete(e[0]); }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [streamMediaKey, lastRenderedFps, stemResync, activeProject, backendKind, tweaks.showGrains, grainScoreOpen]);

  useEffectApp(() => {
    function onSeek(e) {
      const t = Math.max(0, e.detail);
      setTime(t);
      const engine = window.PGEAudio?.engine;
      if (engine) engine.seek(t);
    }
    window.addEventListener("pge-seek", onSeek);
    return () => window.removeEventListener("pge-seek", onSeek);
  }, [compDuration]);

  useEffectApp(() => {
    function onKey(e) {
      const tg = e.target;
      if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
      if (matchShortcut(e, tweaks.shortcutInspector || "i")) {
        e.preventDefault();
        toggleInspector();
        return;
      }
      if (matchShortcut(e, tweaks.shortcutEnvelopeEditor || "o")) {
        e.preventDefault();
        setTweak("showEnvelopeEditor", tweaks.showEnvelopeEditor === false ? true : false);
        return;
      }
      if (matchShortcut(e, tweaks.shortcutSettings || ",")) { e.preventDefault(); setSettingsOpen(o => !o); return; }
      if (matchShortcut(e, tweaks.shortcutRender || "r"))    { e.preventDefault(); onRender();  return; }
      if (matchShortcut(e, tweaks.shortcutBackToStart || "z")) { e.preventDefault(); doSeekZero(); return; }
      if (matchShortcut(e, tweaks.shortcutPlay || "x"))        { e.preventDefault(); doPlay();    return; }
      if (terminalOpen && matchShortcut(e, tweaks.shortcutStop || "c")) { e.preventDefault(); setLogLines([]); return; }
      if (matchShortcut(e, tweaks.shortcutStop || "c"))        { e.preventDefault(); doStop();    return; }
      if (matchShortcut(e, tweaks.shortcutLog || "l")) { e.preventDefault(); const v = !terminalOpen; setTerminalOpen(v); setTweak("terminalOpen", v); if (v) dismissErrToasts(); return; }
      if (matchShortcut(e, tweaks.shortcutScope || "v")) { e.preventDefault(); const v = !scopeOpen; setScopeOpen(v); setTweak("scopeOpen", v); if (v && !browserOpen) { setBrowserOpen(true); } return; }
      if (matchShortcut(e, tweaks.shortcutGrainScore || "g")) { e.preventDefault(); const v = !grainScoreOpen; setGrainScoreOpen(v); setTweak("grainScoreOpen", v); return; }
      if (matchShortcut(e, tweaks.shortcutToggleLabels || "h")) { e.preventDefault(); setTweak("showClipLabels", tweaks.showClipLabels === false); return; }
      if (matchShortcut(e, tweaks.shortcutToggleSpectrogram || "t")) { e.preventDefault(); setTweak("showSpectrograms", !tweaks.showSpectrograms); return; }
      if (matchShortcut(e, tweaks.shortcutMute || "m") && selectedIds.length > 0) {
        e.preventDefault();
        const targets = data.streams.filter(s => selectedIds.includes(s.id));
        const allMuted = targets.every(s => s.mute);
        targets.forEach(s => updateStream(s.id, { mute: !allMuted }));
        return;
      }
      if (matchShortcut(e, tweaks.shortcutSolo || "s") && selectedIds.length > 0) {
        e.preventDefault();
        const targets = data.streams.filter(s => selectedIds.includes(s.id));
        const allSoloed = targets.every(s => s.solo);
        targets.forEach(s => updateStream(s.id, { solo: !allSoloed }));
        return;
      }
      if (matchShortcut(e, tweaks.shortcutSplit || "d") && selectedIds.length > 0) {
        e.preventDefault();
        splitAtPlayhead();
        return;
      }
      // Alt+↑/↓ (rebindable): move the selected clips one lane. Placed before
      // the ←/→ nudge and gated on a full shortcut match, so a rebind moves the
      // whole behaviour — including the Timeline's decision to stay out of it.
      if (selectedIds.length > 0 &&
          (matchShortcut(e, tweaks.shortcutMoveLaneUp || MOVE_LANE_UP) ||
           matchShortcut(e, tweaks.shortcutMoveLaneDown || MOVE_LANE_DOWN))) {
        e.preventDefault();
        if (!arrowGestureRef.current) {
          arrowGestureRef.current = true;
          window.PGEHistory && window.PGEHistory.beginGesture();
        }
        moveSelectionByLane(matchShortcut(e, tweaks.shortcutMoveLaneUp || MOVE_LANE_UP) ? -1 : 1);
        return;
      }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && selectedIds.length > 0) {
        // Defer to the envelope editor when it owns the arrows (a breakpoint is
        // selected and the pointer last landed inside it) — ←/→ nudges the BP.
        if (envArrowRef.current && envArrowRef.current.focused && envArrowRef.current.singleBPSelected) return;
        const targets = data.streams.filter(s => selectedIds.includes(s.id));
        if (targets.length) {
          e.preventDefault();
          if (!e.repeat && !arrowGestureRef.current) {
            arrowGestureRef.current = true;
            window.PGEHistory && window.PGEHistory.beginGesture();
          }
          const step = e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1;
          const delta = e.key === "ArrowLeft" ? -step : step;
          for (const stream of targets) {
            if (e.metaKey || e.ctrlKey) {
              updateStream(stream.id, { duration: Math.max(0.5, +(stream.duration + delta).toFixed(3)) });
            } else {
              updateStream(stream.id, { onset: Math.max(0, +(stream.onset + delta).toFixed(3)) });
            }
          }
        }
        return;
      }
      if (e.key === " ") { e.preventDefault(); doPlay(); }
      else if (e.key === "Escape") { setInspectorOpen(false); }
      else if ((e.metaKey || e.ctrlKey) && e.key === ".") { e.preventDefault(); setBrowserOpen(o => !o); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedTrackId && !e.defaultPrevented) {
        // A lane was selected from its header: Delete takes the lane and every
        // clip on it. No envelope-editor guard here — `defaultPrevented` is
        // already the one that matters (the editor preventDefaults only when a
        // breakpoint or a loop is actually selected).
        e.preventDefault();
        deleteTrack(selectedTrackId);
      }
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !e.defaultPrevented) {
        // Envelope editor is visible and showing this stream — let it handle Delete (BP deletion)
        if (tweaks.showEnvelopeEditor !== false && selected()) return;
        e.preventDefault();
        deleteStream(selectedId);
      }
    }
    function onKeyUp(e) {
      if (e.key.startsWith("Arrow") && arrowGestureRef.current) {
        arrowGestureRef.current = false;
        window.PGEHistory && window.PGEHistory.endGesture();
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  });

  useEffectApp(() => {
    function onBeforeUnload(e) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /* ============ Stream mutations ============ */
  function copySelectedStreams() {
    const toCopy = data.streams.filter(s => selectedIds.includes(s.id));
    if (!toCopy.length) return;
    // `_srcId` survives the deep copy so paste can find the lane to land in
    // even after the id has been reallocated (it is stripped on paste).
    // `_srcProject` scopes it: the clipboard outlives a project switch (on
    // purpose — copying between compositions is the point), and default ids
    // repeat across files, so pasting into another project would otherwise land
    // on whatever unrelated stream happens to be called `stream1` there.
    clipboardRef.current = JSON.parse(JSON.stringify(toCopy))
      .map(s => ({ ...s, _srcId: s.id, _srcProject: activeProject }));
  }
  function pasteStreams() {
    const copied = clipboardRef.current;
    if (!copied.length) return;
    const minOnset = Math.min(...copied.map(s => s.onset));
    const shift = Math.max(0, time) - minOnset;
    const newIds = [];
    setData(d => {
      // hasStemFor as the oracle: an id whose stem is still on disk must not be
      // recycled, or the paste inherits a deleted stream's audio (see
      // allocStreamIds in yaml-bridge.js).
      const ids = window.PGEYaml.allocStreamIds(d.streams, copied.length, ownsStemFor);
      const pasted = copied.map((s, i) => {
        newIds.push(ids[i]);
        // `_srcId` is clipboard bookkeeping, not stream data: it must not reach
        // the model, or it would sit inside the stem fingerprint.
        const { _srcId, _srcProject, ...body } = JSON.parse(JSON.stringify(s));
        return { ...body, id: ids[i], onset: Math.max(0, +(s.onset + shift).toFixed(2)) };
      });
      const withPaste = { ...d, streams: [...d.streams, ...pasted] };
      // The copy joins the lane its original sits in (#141) — no similarity
      // heuristic, just the track that already exists. `_srcId` is recorded at
      // copy time because the source may have been deleted since; when it no
      // longer resolves, `addStreamToTrackOf` opens a lane at the end, which is
      // what paste did before tracks existed. Out of its own project the id
      // means nothing, so ask for that fallback outright rather than matching a
      // namesake.
      let tr = TR.deriveTracks(withPaste);
      copied.forEach((s, i) => {
        const src = s._srcProject === activeProject ? (s._srcId || s.id) : null;
        tr = TR.addStreamToTrackOf(tr, src, ids[i]);
      });
      return TR.applyTracks(withPaste, tr);
    });
    setSelectedIds(newIds);
    setDirty(true);
  }
  /* ---- split al cursore (tasto rimappabile, default "d") ----
   * Il taglio di Reaper: la clip selezionata diventa due stream, la testa e la
   * coda, e il suono non cambia. Cambiano solo i due modi in cui una meta' puo'
   * mentire:
   *   - la testa tiene gli inviluppi in posizione ASSOLUTA (il freeze del
   *     lucchetto, imposto qui a prescindere dal toggle: uno stretch
   *     riproporzionerebbe le curve e il taglio non sarebbe piu' un taglio);
   *   - la coda deve ripartire a leggere il sample dove la testa aveva
   *     lasciato, e quel punto lo sa solo il motore — e' il `ptr` del sidecar
   *     dei grani, lo stesso numero che il riquadro sotto il cursore mostra
   *     come "Read". Senza sidecar non lo si inventa: lo split si rifiuta.
   * `pointer.start` va scritto nell'unita' in vigore, che e' `pointer.loop_unit`
   * e nient'altro: dopo PGE #222 la chiave non eredita piu' da `time_mode` e in
   * sua assenza il motore legge secondi. Ogni stream nato nell'editor dichiara
   * `loop_unit: normalized`, dove start vive in [0,1] del sample — scriverci
   * dentro dei secondi lo manderebbe fuori file; su uno YAML scritto a mano che
   * porta `time_mode: normalized` senza `loop_unit` vale l'opposto, ed e' per
   * questo che l'unita' la chiede a loopUnitInfo invece di dedurla dallo
   * stream. */
  function splitAtPlayhead() {
    const t = time;
    const R = (x) => +x.toFixed(4);
    const targets = data.streams.filter(s =>
      selectedIds.includes(s.id) && t > s.onset + 1e-4 && t < s.onset + s.duration - 1e-4);
    if (!targets.length) {
      pushToast({ kind: "warn", title: "Niente da tagliare",
                  message: "il cursore non attraversa nessuna clip selezionata", duration: 3000 });
      return;
    }
    const cuts = [];
    for (const s of targets) {
      ensureGrainData(s.id);   // se il sidecar non e' ancora in memoria, chiedilo
      const gd = grainData[s.id];
      const sampleDur = (mediaList.files || []).find(f => f.name === s.sample)?.duration || 0;
      const ptr = gd && window.PGEGrainMap.readPositionAt(gd, t - s.onset, {
        jitter: !!(s.pointer && (s.pointer.offsetRange != null || s.pointer.offsetRangeEnv)),
        sampleDur,
      });
      if (!ptr) {
        pushToast({ kind: "warn", title: `Split rifiutato: ${s.id}`,
                    message: "posizione di lettura sconosciuta — renderizza lo stream e riprova",
                    duration: 5000 });
        return;
      }
      const unit = window.PGEEnvUtils.loopUnitInfo(s).unit;
      if (unit === "normalized" && !(sampleDur > 0)) {
        pushToast({ kind: "warn", title: `Split rifiutato: ${s.id}`,
                    message: "durata del sample sconosciuta: pointer.start e' normalizzato e non e' convertibile",
                    duration: 5000 });
        return;
      }
      cuts.push({ s, start: R(unit === "normalized" ? ptr.pos / sampleDur : ptr.pos), exact: ptr.exact });
    }
    const halves = new Map();   // srcId → {head, tail}
    let skipped = 0;
    for (const { s, start } of cuts) {
      const cutRel = t - s.onset;
      const cutNorm = cutRel / s.duration;
      const head = {
        ...truncateStreamEnvelopes(rescaleStreamEnvelopes(s, s.duration, cutRel)),
        duration: R(cutRel), durationImplicit: false, durationUnresolved: false,
      };
      const sliced = sliceStreamEnvelopes(s, cutNorm);
      skipped += sliced.skipped;
      const tail = {
        ...sliced.stream,
        onset: R(t), duration: R(s.duration - cutRel),
        durationImplicit: false, durationUnresolved: false,
        pointer: { ...(s.pointer || {}), start },
      };
      halves.set(s.id, { head, tail });
    }
    const newIds = [];
    setData(d => {
      const ids = window.PGEYaml.allocStreamIds(d.streams, halves.size, ownsStemFor);
      const tails = [];
      let i = 0;
      const streams = d.streams.map(s => {
        const h = halves.get(s.id);
        if (!h) return s;
        const id = ids[i++];
        newIds.push(id);
        tails.push({ src: s.id, stream: { ...h.tail, id } });
        return h.head;
      });
      const withTails = { ...d, streams: [...streams, ...tails.map(x => x.stream)] };
      // La coda nasce nella corsia della testa: e' la stessa clip, tagliata.
      let tr = TR.deriveTracks(withTails);
      tails.forEach(x => { tr = TR.addStreamToTrackOf(tr, x.src, x.stream.id); });
      return TR.applyTracks(withTails, tr);
    });
    setSelectedIds([...targets.map(s => s.id), ...newIds]);
    setDirty(true);
    if (cuts.some(c => !c.exact)) {
      pushToast({ kind: "warn", title: "pointer.start e' una stima",
                  message: "pointer.offset_range devia ogni grano: la posizione di lettura e' la mediana dei grani vicini",
                  duration: 5000 });
    }
    if (skipped) {
      pushToast({ kind: "warn", title: "Blocchi compatti non tagliati",
                  message: `${skipped} inviluppi contengono un blocco compatto e sono rimasti invariati nella coda`,
                  duration: 5000 });
    }
  }
  function updateStream(id, patch) {
    if (freezeEnvOnResize && patch.duration != null) {
      const cur = data.streams.find(s => s.id === id);
      if (cur && patch.duration !== cur.duration) {
        const inGesture = HC.isInGesture(historyRef.current);

        if (inGesture) {
          // Capture origin once per gesture (first frame that changes duration)
          if (!freezeOriginRef.current || freezeOriginRef.current.id !== id) {
            freezeOriginRef.current = { id, stream: cur };
          }
          const origin = freezeOriginRef.current.stream;
          const ratio = origin.duration / patch.duration;

          // Flag for post-gesture confirm if this gesture shrinks past existing BPs
          if (ratio > 1 && streamWouldTruncate(origin, ratio)) {
            pendingTruncateRef.current = { id };
          } else {
            pendingTruncateRef.current = null;
          }

          // Rescale from origin (not from current s.duration) — no accumulation
          setData(d => ({
            ...d,
            streams: d.streams.map(s => {
              if (s.id !== id) return s;
              return mergeStreamPatch(rescaleStreamEnvelopes(origin, origin.duration, patch.duration), patch, mediaList.files);
            }),
          }));
        } else {
          // Discrete (non-drag) edit: confirm + truncate immediately
          const ratio = cur.duration / patch.duration;
          if (ratio > 1 && streamWouldTruncate(cur, ratio)) {
            if (!window.confirm(
              "Reducing duration with freeze ON will truncate envelope breakpoints beyond the new end.\n\nBreakpoint data will be lost. (Ctrl+Z to undo)\n\nProceed?"
            )) return;
          }
          setData(d => ({
            ...d,
            streams: d.streams.map(s => {
              if (s.id !== id) return s;
              const rescaled = rescaleStreamEnvelopes(s, cur.duration, patch.duration);
              return mergeStreamPatch(ratio > 1 ? truncateStreamEnvelopes(rescaled) : rescaled, patch, mediaList.files);
            }),
          }));
        }
        setDirty(true);
        return;
      }
    }
    setData(d => ({ ...d, streams: d.streams.map(s => s.id === id ? mergeStreamPatch(s, patch, mediaList.files) : s) }));
    setDirty(true);
  }
  // Top-level `seed` (engine #81): project-wide, NOT per-stream — it never
  // enters the per-stream fingerprint, so changing it doesn't mark stems stale.
  // Empty/null clears it (key omitted on save = current unseeded behaviour).
  function setSeed(v) {
    const norm = (v === undefined || v === null || v === "") ? undefined : v;
    setData(d => {
      if (norm === d.seed) return d;            // no-op: skip history churn
      const n = { ...d };
      if (norm === undefined) delete n.seed; else n.seed = norm;
      return n;
    });
    setDirty(true);
  }
  /* ============ Tracks (issue #141) ============
   * A lane is a track, and a track can hold several streams. The grouping is a
   * single TOP-LEVEL `ui_tracks` key riding in `data._extra` — never a
   * per-stream key, which would enter the stem fingerprint and make
   * reorganizing lanes force a re-render that changes no sample. All the logic
   * is in tracks.js; app.jsx only derives, mutates, applies. */
  const TR = window.PGETracks;
  const tracks = useMemoApp(() => TR.deriveTracks(data), [data]);

  /* Every track mutation goes through here so the write path is one place:
   * `applyTracks` reorders `data.streams` into visual order and writes (or
   * drops) `ui_tracks`. It never rebuilds a stream object, so no stem goes
   * stale. */
  function mutateTracks(fn) {
    // `setDirty` stays outside and unconditional, matching every other mutation
    // in this file. It cannot move inside: an updater is not a place to run
    // effects (that is the very defect this issue removed from Timeline.jsx),
    // and a flag read back after `setData` would be stale — React runs the
    // updater lazily. An over-eager dirty flag costs a redundant save; a missed
    // one loses work, so the unconditional side is the safe one. `fn` returning
    // null or `cur` still short-circuits the data change itself.
    setData(d => {
      const cur = TR.deriveTracks(d);
      const next = fn(cur, d);
      if (!next || next === cur) return d;
      return TR.applyTracks(d, next);
    });
    setDirty(true);
  }
  function reorderTracks(srcIdx, dstIdx) {
    if (srcIdx === dstIdx) return;
    mutateTracks(t => TR.reorderTracks(t, srcIdx, dstIdx));
  }
  function renameTrack(trackId, name) {
    const cur = tracks.find(x => x.id === trackId);
    // The rename lands on blur, so it fires even when nothing was typed:
    // bail before mutateTracks rather than dirtying the project for nothing.
    if (!cur || !String(name).trim() || String(name).trim() === cur.name) return;
    mutateTracks(t => TR.renameTrack(t, trackId, name));
  }
  /* A lane with no clips: a track is an entity of its own, so it can be created
   * empty and filled later by dropping clips (or a sample) on it. It also means
   * a lane emptied by a move or a delete stays put — only this button removes
   * one. `addTrack` materializes `ui_tracks` (an empty lane is not trivial). */
  function addTrack() { mutateTracks(t => TR.addTrack(t)); }
  function removeTrack(trackId) { mutateTracks(t => TR.removeTrack(t, trackId)); }
  /* Vertical drag of a clip: join the lane it was dropped on, or (Alt) pull it
   * out into a lane of its own at that position. */
  function moveStreamsToLane(streamIds, dstLaneIdx, opts) {
    mutateTracks(t => TR.moveStreams(t, streamIds, dstLaneIdx, opts));
  }
  /* Keyboard twin of the vertical clip drag: move the whole selection one lane
   * up or down. Like the drag it is a lane DELTA, not a destination — every
   * clip keeps its offset from the anchor, so a selection spanning two lanes
   * stays spread over two lanes. The clamps differ from the drag's on purpose:
   * upward `moveStreams` already stops at lane 0, and downward a keypress must
   * NOT grow the layout the way a drop does — holding the key would otherwise
   * spawn empty lanes without end. So the move is refused once the lowest
   * selected clip sits on the last lane. Use the drag (or `add track`) to
   * create one. */
  function moveSelectionByLane(dir) {
    if (!selectedIds.length) return;
    const laneOf = new Map();
    tracks.forEach((t, i) => t.streamIds.forEach(id => laneOf.set(id, i)));
    const anchor = selectedIds.find(id => laneOf.has(id));
    if (anchor == null) return;
    const lanes = selectedIds.filter(id => laneOf.has(id)).map(id => laneOf.get(id));
    if (dir > 0 && Math.max(...lanes) >= tracks.length - 1) return;
    moveStreamsToLane(selectedIds, laneOf.get(anchor) + dir, { anchor });
  }
  /* Fan-out: the header's M/S write the per-stream keys the engine actually
   * reads. Partially-set groups go fully on, so one click always has an effect.
   * The mute/solo write is NOT a track mutation — it must not rewrite
   * `ui_tracks` — so it goes straight to the streams. */
  function setTrackFlag(trackId, key) {
    const t = tracks.find(x => x.id === trackId);
    if (!t) return;
    const ids = new Set(t.streamIds);
    setData(d => {
      // Both the read (is the group already all-on?) and the write come from
      // the updater's `d`. Deriving `on` from the render closure instead would
      // decide against a snapshot that a queued update may already have moved.
      const group = d.streams.filter(s => ids.has(s.id));
      if (!group.length) return d;
      const on = !group.every(s => s[key]);
      return { ...d, streams: d.streams.map(s => ids.has(s.id) ? { ...s, [key]: on } : s) };
    });
    setDirty(true);
  }
  /* Renaming a stream is an IDENTITY change, not a patch, so it does not go
   * through `updateStream`: the id is the stem filename, the cache-manifest
   * key, the RNG identity and what `ui_tracks` points at. Validate first, then
   * rewrite the stream and every layout reference in one step.
   *
   * The sound is deliberately NOT preserved. `rng_id = rng_group or stream_id`
   * (engine shared/seeding.py), so a renamed stream reseeds and draws different
   * grains. Writing `rng_group: <old id>` would pin it bit-for-bit, at the price
   * of a YAML carrying the old name forever and of a `rng_group` that means
   * "renamed" instead of "shares an RNG" — we would rather a rename be a rename.
   * The id is hashed on both sides, so the stem goes stale on its own: the 🟡
   * dot says so and the next render is the whole story.
   *
   * Returns null on success, or a message for the field to show. */
  function renameStream(oldId, rawName) {
    const newId = String(rawName == null ? "" : rawName).trim();
    if (!newId || newId === oldId) return null;
    // The id becomes a filename (`<basename>__<id>.<ext>`) and a path segment
    // on the way to server.py. Keep it to what is safe in both, and refuse a
    // leading dot so it cannot land as a hidden file.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(newId))
      return "letters, digits, . _ - only, and must start with a letter or digit";
    if (data.streams.some(s => s.id === newId)) return `"${newId}" is already a stream`;
    // A stem still on disk under that name would be picked up as this stream's
    // audio the moment it plays. Same hazard `allocStreamIds` guards against,
    // same oracle — and it is format-agnostic on purpose.
    if (ownsStemFor(newId)) return `a stem on disk still claims "${newId}"`;

    setData(d => {
      // Re-checked inside the updater: `data` in the closure may be a snapshot
      // behind, and this is the one mutation where a stale read would produce
      // two streams sharing an id.
      if (!d.streams.some(s => s.id === oldId) || d.streams.some(s => s.id === newId)) return d;
      const next = { ...d, streams: d.streams.map(s => s.id === oldId ? { ...s, id: newId } : s) };
      return TR.applyTracks(next, TR.renameStreamId(TR.deriveTracks(d), oldId, newId));
    });
    setSelectedIds(ids => ids.map(x => x === oldId ? newId : x));
    if (anchorIdRef.current === oldId) anchorIdRef.current = newId;
    // The render sidecars are keyed by stream id. Nothing reads the old key any
    // more, but leaving it means a stream that is one day allocated that id
    // would show a dead stream's waveform.
    const drop = (m) => { if (!(oldId in m)) return m; const n = { ...m }; delete n[oldId]; return n; };
    setWaveforms(drop); setSpectrograms(drop); setGrainData(drop);
    // A copy taken before the rename still points at the old id. Left alone it
    // would stop resolving and the paste would silently open a new lane instead
    // of joining the source's — `_srcId` has to keep naming the same stream.
    clipboardRef.current = clipboardRef.current.map(s =>
      (s._srcId === oldId && s._srcProject === activeProject) ? { ...s, _srcId: newId } : s);
    setDirty(true);
    return null;
  }
  function deleteStream(id) {
    if (!id) return;
    // Data only: setData is undoable, everything else here would not be. The
    // per-id caches (lastRenderedFps, waveforms, grainData, the grain refs, the
    // backend stem index) are deliberately left alone — wiping them made the
    // stream come back from Ctrl+Z silent and marked "never rendered", and now
    // that ids are never recycled (allocStreamIds) a leftover entry can never
    // be picked up by a different stream. It is simply what this stream had,
    // waiting for it if the delete is undone.
    setData(d => {
      // The layout is read BEFORE the stream goes, and `removeStreams` empties
      // its lane without removing it. Deriving from the post-delete data
      // instead would lose the lane outright: with no `ui_tracks` in the file
      // the lanes ARE the streams, so the only record of the lane is the one
      // this call has to write.
      const tracks = TR.removeStreams(TR.deriveTracks(d), [id]);
      const next = { ...d, streams: d.streams.filter(s => s.id !== id) };
      return TR.applyTracks(next, tracks);
    });
    if (selectedIds.includes(id) && selectedIds.length === 1) setInspectorOpen(false);
    setSelectedIds(ids => ids.filter(x => x !== id));
    setDirty(true);
  }
  /* `trackId` (a sample dropped on an EMPTY lane) fills that lane; otherwise the
   * new stream gets a lane of its own at `laneIdx`. */
  function createStreamFromSample({ sample, onset = 0, laneIdx, trackId }) {
    const media = mediaList.files || [];
    const sampleName = sample || (media[0] && media[0].name) || "";
    const sampleRec = media.find(s => s.name === sampleName) || { duration: 4 };
    const palette = ["#5C8868","#B89241","#3F8884","#5965A8","#8E5F8E","#C97A6E","#7A8DB0"];
    setData(d => {
      const [newId] = window.PGEYaml.allocStreamIds(d.streams, 1, ownsStemFor);
      const newStream = {
        id: newId, onset: Math.max(0, +onset.toFixed(2)),
        duration: Math.min(d.duration - onset, Math.max(2, sampleRec.duration)),
        sample: sampleName, color: palette[(d.streams.length) % palette.length],
        mute: false, solo: false,
        timeMode: "normalized", distributionMode: "uniform",
        // Overall density defaults to fill_factor mode (= 2): density tracks
        // grain_duration automatically instead of a fixed grains/sec. Mutually
        // exclusive with density — keep density null, mirroring parse output.
        density: null, fillFactor: 2, distribution: 0,
        volume: 0, volumeRange: null,
        pan: 0, panRange: null,
        grain: { duration: 0.05, durationRange: null, envelope: "hanning" },
        // loop_unit: normalized → start/loop coords read as [0,1] × sample_dur.
        // No loop_start, so no loop is created; it only sets the unit convention.
        // La chiave e' esplicita apposta: dopo PGE #222 e' l'unica cosa che dice
        // al motore di leggerli cosi' — time_mode non c'entra piu' nulla.
        pointer: { start: 0, speedRatio: 1, loopStart: null, loopDur: null, loopUnit: "normalized" },
        pitch: { semitones: 0, range: null },
        voices: { num: 1 },
      };
      const withNew = { ...d, streams: [...d.streams, newStream] };
      // `laneIdx` counts LANES, not streams: dropped below a three-clip lane the
      // new stream belongs one lane down, not three streams down.
      const base = TR.deriveTracks(withNew).filter(t => !t.streamIds.includes(newId));
      const target = trackId != null && base.find(t => t.id === trackId);
      const tr = target
        ? base.map(t => t.id === trackId ? { ...t, streamIds: [...t.streamIds, newId] } : t)
        : TR.insertStreamTrack(base, newId, laneIdx);
      return TR.applyTracks(withNew, tr);
    });
    setDirty(true);
  }
  /* `id` may be a single stream id (a clip) or a list (a lane header, which
   * stands for every stream on the track). */
  function selectClip(id, multi) {
    // Clicking a clip is a clip selection, never a lane one — `selectTrack`
    // re-sets it right after, and the later setState wins.
    setSelectedTrackId(null);
    const ids = Array.isArray(id) ? id : [id];
    if (!ids.length) return;
    if (multi) {
      setSelectedIds(prev => ids.every(x => prev.includes(x))
        ? prev.filter(x => !ids.includes(x))
        : [...new Set([...prev, ...ids])]);
    } else {
      anchorIdRef.current = ids[0];
      setSelectedIds(ids);
    }
  }
  /* Clicking a track header selects the LANE: its clips light up as before, and
   * the lane itself becomes the target of Delete. Ctrl/Cmd-click stays a plain
   * multi-clip toggle — an additive selection is about clips, not lanes. */
  function selectTrack(trackId, multi) {
    const t = tracks.find(x => x.id === trackId);
    if (!t) return;
    if (t.streamIds.length) selectClip(t.streamIds, multi);
    else if (!multi) setSelectedIds([]);
    if (!multi) setSelectedTrackId(trackId);
  }
  /* Delete on a selected lane: the lane goes AND every stream on it. One
   * setData, so it is one undo step. */
  function deleteTrack(trackId) {
    const t = tracks.find(x => x.id === trackId);
    if (!t) return;
    const ids = new Set(t.streamIds);
    setData(d => {
      const rest = TR.deriveTracks(d).filter(x => x.id !== trackId);
      return TR.applyTracks({ ...d, streams: d.streams.filter(s => !ids.has(s.id)) }, rest);
    });
    if (ids.size && selectedIds.some(x => ids.has(x))) setInspectorOpen(false);
    setSelectedIds(prev => prev.filter(x => !ids.has(x)));
    setSelectedTrackId(null);
    setDirty(true);
  }
  function rangeSelectClip(id) {
    setSelectedTrackId(null);
    const anchor = anchorIdRef.current;
    // Shift-range runs down what the user SEES. Track order is the visual
    // order and `data.streams` follows it (applyTracks), but a hand-edited
    // ui_tracks can put a stream elsewhere — so read the layout, not the file.
    const ss = TR.visualOrder(tracks);
    const anchorIdx = anchor ? ss.indexOf(anchor) : -1;
    const targetIdx = ss.indexOf(id);
    if (anchorIdx === -1 || targetIdx === -1) { setSelectedIds([id]); return; }
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    setSelectedIds(ss.slice(lo, hi + 1));
  }
  function marqueeSelectClips(ids, additive) {
    setSelectedTrackId(null);
    if (additive) setSelectedIds(prev => [...new Set([...prev, ...ids])]);
    else setSelectedIds(ids);
  }
  function openInspector(id) {
    if (id != null) setSelectedIds([id]);
    setInspectorOpen(true);
    setTweak("showEnvelopeEditor", true);
  }
  function closeInspector() { setInspectorOpen(false); }
  function toggleInspector() {
    // Ctrl+I: toggles inspector (opens even without a selected stream).
    setInspectorOpen(o => !o);
  }
  function selected() { return data.streams.find(s => s.id === selectedId); }

  /* ============ Due editor, un file (#185) ============ */

  /* Lo stesso file puo' stare aperto qui e nel laboratorio di mare-nostrum
     (regola 7 del piano `stream-come-file.md`). Il bridge tiene la firma di
     cio' che si e' letto e rifiuta di scrivere su un file che nel frattempo e'
     cambiato (`file_signature.py`); `PGEFileGuard` decide, file per file, se
     quel rifiuto si risolve rileggendo o chiedendo; qui c'e' la terza parte,
     quella che non si puo' decidere altrove: la domanda, e il lavoro proprio
     che la rende necessaria.

     Oggi il file e' UNO — il master in `configs/<basename>.yml`, l'unico che
     questo bridge scrive — e `refusedFiles` ne torna uno. Con gli stream
     importati (#184) ne tornera' N e nient'altro cambia: la decisione e' gia'
     per-file. */

  function masterFile() { return activeProject.replace(/\.yml$/, "") + ".yml"; }

  /* I file che il bridge ha rifiutato. `POST /render` nomina il suo
     (`name`), `PUT /file` no — li' il file e' quello che si stava scrivendo. */
  function refusedFiles(res) {
    const n = res && res.name;
    return n ? [n] : [masterFile()];
  }

  /* Il documento che il master contiene, per quanto ne sa questo editor:
     quello letto (`onProjectSelect`), quello salvato, quello che un render ha
     appena scritto (l'evento `file-signatures`). E' l'altra meta' di
     `dirtyOfFile`, e serve per il render: `/render` SCRIVE il config, ma non
     tocca `dirty`, che dice «non salvato» e resta acceso fino al prossimo
     Salva. Letto da solo, dopo il primo render ogni modifica del laboratorio
     diventava una domanda — «qui ci sono modifiche non salvate» su un file
     che conteneva esattamente il documento a schermo — e la rilettura, che e'
     lo scenario dell'issue, nel giro di lavoro di PGE-ui (modifica, rendi,
     ascolta) non arrivava mai. Per identita': lo stato e' immutabile, e la
     storia dell'undo rimette gli stessi oggetti, quindi un undo che torna al
     documento scritto e' di nuovo «niente da perdere», che e' vero. */
  const fileDocRef = useRefApp(null);

  /* C'e' lavoro proprio da perdere su questo file? Il flag del progetto,
     perche' il file e' uno e tutte le modifiche sono sue — tranne quando il
     documento che si scrive e' proprio quello che il file contiene (vedi
     `fileDocRef`). `doc` e' quel documento: di solito la `data`, ma dopo una
     rilettura e' quello appena letto, e allora la risposta e' «niente» senza
     dover chiedere niente al `dirty` di una chiusura che la rilettura ha gia'
     reso vecchia. Con #184 diventa per-file, ed e' per questo che e' una
     funzione del nome invece di essere `dirty` letto sul posto. */
  function dirtyOfFile(_name, doc = data) { return dirty && doc !== fileDocRef.current; }

  /* Lo stato di ADESSO, per le risposte alla domanda. Il toast vive piu' a
     lungo del render che l'ha creato — e' persistente, e la tastiera resta
     libera — quindi una risposta che chiudesse sulle variabili del momento in
     cui e' stata posta lavorerebbe su un editor che non c'e' piu': il
     `sovrascrivi` del Salva scriveva il documento di quando si era premuto
     Salva e poi spegneva `dirty`, cioe' «salvato» su modifiche fatte dopo e
     mai scritte — e alla prossima modifica del laboratorio la guardia, con
     `dirty` falso, le avrebbe rilette via senza chiedere. Il `sovrascrivi`
     del render rendeva quel documento col backend e le opzioni di allora.
     Riassegnato a ogni render: e' il valore, non un effetto. */
  const guardLatestRef = useRefApp(null);
  guardLatestRef.current = { data, renderAgain };

  /* Una domanda alla volta, come nel laboratorio («ogni scrittura nuova
     sostituisce la domanda in attesa»). Senza, due Salva — o un Salva e un
     render — impilavano due toast con due `sovrascrivi`, e quello rimasto
     indietro scriveva ancora. E un `apri` (anche quello della `ricarica`, o
     del cambio di workspace) la rende superata: la domanda e' su un file che
     non e' piu' il documento aperto, e un `sovrascrivi` ci scriverebbe sopra
     il progetto aperto dopo. */
  const changedQuestionRef = useRefApp(null);
  function dropChangedQuestion() {
    const id = changedQuestionRef.current;
    changedQuestionRef.current = null;
    if (id != null) dismissToast(id);
  }

  /* La domanda. Tre risposte e non due, per cui non e' un `confirm`:
     `ricarica`, `sovrascrivi`, e non scrivere niente — che e' la × del toast,
     non deve costare un click in piu' ne' stare sotto la stessa superficie di
     una che perde lavoro. Persistente perche' il render non riparte finche'
     non ha avuto risposta. */
  function askChangedOnDisk(names, onReload, onOverwrite) {
    dropChangedQuestion();
    let id = null;
    const answered = (fn) => () => {
      if (changedQuestionRef.current === id) changedQuestionRef.current = null;
      if (fn) fn();
    };
    id = pushToast({
      kind: "warn", persistent: true,
      title: names.length > 1
        ? `${names.length} file cambiati su disco`
        : `${names[0]} e' cambiato su disco`,
      message: "l'ha riscritto un altro editor, e qui ci sono modifiche non salvate",
      actions: [
        { label: "ricarica", onClick: answered(onReload) },
        { label: "sovrascrivi", kind: "danger", onClick: answered(onOverwrite) },
      ],
      onCancel: answered(null),
    });
    changedQuestionRef.current = id;
  }

  /* Rilegge i file che la guardia ha detto di rileggere, e torna il documento
     del master — che e' quello che chi riprova deve ri-serializzare.

     La rilettura del master E' `onProjectSelect`, cioe' un `apri` dello stesso
     file: `_setDataRaw` + `resetHistory` + `setDirty(false)`. La storia
     azzerata non e' un effetto collaterale, e' il criterio: senza, un undo
     riporterebbe indietro una versione che su disco non c'e' piu', e il
     salvataggio dopo la riscriverebbe sopra quella dell'altro editor. */
  async function rereadFiles(names) {
    let master = null;
    for (const name of names) {
      if (name === masterFile()) master = await onProjectSelect(activeProject);
      // #184: gli altri nomi sono i file-stream importati, che qui non
      // esistono ancora. `refusedFiles` ne torna uno solo, quindi questo ramo
      // non e' raggiungibile: quando lo sara', sara' perche' c'e' qualcosa da
      // rileggere.
    }
    return master;
  }

  /* Prova a scrivere e, sul rifiuto della guardia, applica la decisione.
     `attempt({overwrite, doc})` e' la scrittura — il salva o la POST del
     render — e torna il suo risultato.

     Il ciclo e' quello del laboratorio: rilegge, riprova, e se il file cambia
     ancora lo dice invece di rincorrerlo (`PGEFileGuard.MAX_REREAD`). Chi
     chiede si ferma qui e riprende dalla risposta, perche' la risposta e' di
     chi guarda. */
  async function writeWithGuard(attempt, label) {
    const G = window.PGEFileGuard;
    let doc = null, attempts = 0, dirtyNow = dirty;
    for (;;) {
      const res = await attempt({ overwrite: false, doc });
      if (!res || !res.changed) return res;
      const names = refusedFiles(res);
      const plan = G.plan(names.map(name => ({
        name, changed: true,
        // Dopo una rilettura il lavoro proprio non c'e' piu': l'ha scartato la
        // rilettura stessa. Si tiene qui e non in `dirty`, che e' stato React
        // e a questo punto della closure e' ancora quello di prima.
        dirty: attempts === 0 ? dirtyOfFile(name) : dirtyNow,
        attempts,
      })));
      /* Un ramo per decisione, e la rilettura dentro il ramo che la chiede:
         rileggere anche prima di arrendersi (`stop`) vorrebbe dire adottare la
         versione su disco di un file e poi dire «continua a cambiare», cioe'
         due cose di cui una sola e' vera. */
      if (plan.action === "reread") {
        const fresh = await rereadFiles(plan.reread);
        if (!fresh) {
          // Il file non si e' letto (vuoto, illeggibile): riprovare
          // scriverebbe il progetto di ripiego sopra quello dell'altro
          // editor. Si dice, e si lascia il disco com'e'.
          pushToast({ kind: "err", persistent: true,
                      title: `${label} fermo`,
                      message: `${names.join(", ")}: non si rilegge — niente scritto` });
          return res;
        }
        doc = fresh;
        attempts += 1;
        dirtyNow = false;
        logToTerminal(`[reread] ${names.join(", ")} · ripreso dalla versione su disco`, "warn");
        continue;
      }
      if (plan.action === "ask") {
        /* I file che volevano solo una rilettura si rileggono comunque: la
           domanda resta sugli altri. Oggi le due liste non sono mai piene
           insieme (il file e' uno), ma la decisione e' per-file e questo e' il
           ramo che #184 trova gia' scritto. */
        if (plan.reread.length) await rereadFiles(plan.reread);
        askChangedOnDisk(plan.ask,
          /* Fire-and-forget con la coda gestita: queste girano dal click sul
             toast, fuori da questa chiamata, e una promise rifiutata senza
             catch qui diventerebbe una unhandled rejection invece di un
             messaggio. */
          () => { rereadFiles(plan.ask).catch(() => {}); },
          () => {
            // `doc: null`: qui non si e' riletto niente (la domanda arriva
            // solo al primo tentativo), e `attempt` prende lo stato di adesso.
            Promise.resolve(attempt({ overwrite: true, doc: null })).catch((e) =>
              pushToast({ kind: "err", title: `${label} failed`,
                          message: e.message, persistent: true }));
          });
        // `pending`: la scrittura non e' avvenuta e non e' nemmeno fallita —
        // aspetta una risposta. Chi chiama non deve ne' festeggiare ne'
        // mostrare un errore.
        return { ...res, pending: true };
      }
      // "stop": niente da chiedere, e si e' gia' riletto una volta. Dirlo,
      // invece di rincorrere un file che qualcuno sta scrivendo adesso.
      pushToast({ kind: "err", persistent: true,
                  title: `${label} fermo`,
                  message: `${names.join(", ")} continua a cambiare su disco — niente scritto` });
      return res;
    }
  }

  /* ============ Save / SaveAs ============ */
  async function onSave() {
    const backend = window.PGEBackend.current;
    const basename = activeProject.replace(/\.yml$/, "");
    try {
      const res = await writeWithGuard(async ({ overwrite, doc }) => {
        /* `guardLatestRef` e non `data`: questa funzione la richiama anche il
           `sovrascrivi`, dal toast, magari minuti dopo — e quello che si
           sovrascrive e' il documento di ADESSO. Con la `data` di quando si
           era premuto Salva, le modifiche fatte nel frattempo restavano fuori
           dal file mentre `_saveWritten` spegneva `dirty`: «salvato» su lavoro
           mai scritto. Al primo tentativo le due cose coincidono. */
        const d = doc || guardLatestRef.current.data;
        const yaml = window.PGEYaml ? window.PGEYaml.serialize(d) :
          `# (yaml bridge not loaded — save skipped)\n# project: ${d.project}\n`;
        const r = await _saveWritten(backend, basename, yaml, overwrite);
        if (r && r.ok) fileDocRef.current = d;
        return r;
      }, "Save");
      if (!res || !res.ok) return;     // rifiutato, in attesa, o fermo: l'ha gia' detto
    } catch (e) {
      pushToast({ kind: "err", title: "Save failed", message: e.message, persistent: true });
    }
  }

  /* La scrittura vera, piu' cio' che segue un salvataggio riuscito. Separata
     perche' la chiamano due strade — il primo tentativo e il `sovrascrivi` —
     e cio' che un salvataggio lascia dietro (flag, migrazione, toast) non deve
     dipendere da quale delle due e' passata. */
  async function _saveWritten(backend, basename, yaml, overwrite) {
    const res = await backend.fs.writeFile("projects", basename + ".yml", yaml,
                                           { overwrite });
    if (!res || !res.ok) return res;
    setDirty(false);
    // Il file appena scritto porta `deviation_probability`: la migrazione da
    // `dephase` e' compiuta, e l'avviso in Inspector deve tacere. _setDataRaw
    // e non setData — spegnere un flag di provenienza dopo un salvataggio non
    // e' una modifica dell'autore: non sporca il progetto e non e' un passo
    // di undo, come l'arrivo tardivo dei media. Solo qui e non in onSaveAs:
    // quello scrive un altro file, l'originale porta ancora la chiave morta.
    _setDataRaw(d => window.PGEYaml ? window.PGEYaml.clearDeviationProbabilityLegacy(d) : d);
    // `written: false` non e' un salvataggio mancato: il file conteneva gia'
    // QUESTO documento, byte a parte (#185). Dirlo vuol dire dire anche che la
    // formattazione e i commenti dell'altro editor sono ancora li', che e' il
    // motivo per cui il bridge non ha scritto.
    pushToast({ kind: "ok", title: "Saved",
                message: res.written === false
                  ? `configs/${basename}.yml · era gia' questo documento`
                  : `configs/${basename}.yml · ${(yaml.length / 1024).toFixed(1)}kb`,
                duration: 2200 });
    refreshProjects();
    return res;
  }
  async function onSaveAs() {
    const name = prompt("Save a copy as…", activeProject.replace(/\.yml$/, "_copy.yml"));
    if (!name) return;
    const fullName = name.endsWith(".yml") ? name : name + ".yml";
    const backend = window.PGEBackend.current;
    const yaml = window.PGEYaml ? window.PGEYaml.serialize(data) :
      `# saved-as ${fullName}\n# from: ${activeProject}\n`;
    try {
      /* `overwrite` qui, e la guardia di #185 non c'entra: questo scrive un
         file che non e' quello aperto, su un nome che l'utente ha appena
         scritto. E' la regola del laboratorio per il suo `salva con nome` —
         non si manda nessuna firma, perche' dietro al documento che si scrive
         non c'e' una lettura di QUEL file. (Di la' della sovrascrittura chiede
         il pannello nativo di macOS; qui c'e' un `prompt`, che non chiede
         niente: e' il comportamento di prima di questa issue, e cambiarlo e'
         un'altra decisione.) Senza, un nome gia' aperto in questa sessione
         avrebbe la sua firma registrata e il 409 sarebbe arrivato a un
         chiamante che annuncia "Saved as" comunque. */
      const res = await backend.fs.writeFile("projects", fullName, yaml,
                                             { overwrite: true });
      if (!res || !res.ok) {
        pushToast({ kind: "err", title: "Save As failed",
                    message: (res && res.error) || "rifiutato", persistent: true });
        return;
      }
      pushToast({ kind: "ok", title: "Saved as", message: `configs/${fullName}`, duration: 2500 });
      refreshProjects();
    } catch (e) {
      pushToast({ kind: "err", title: "Save As failed", message: e.message, persistent: true });
    }
  }

  async function onNewProject() {
    const name = prompt("New project name (without .yml):", "untitled");
    if (!name) return;
    const basename = name.replace(/\.yml$/i, "");
    const fullName = basename + ".yml";
    const empty = window.PGEYaml ? window.PGEYaml.emptyProject(basename)
                                 : { project: basename, title: "", duration: 10, streams: [], samples: [] };
    const backend = window.PGEBackend.current;
    try {
      // `overwrite` per la ragione di onSaveAs: un nome appena scritto
      // dall'utente, dietro al quale non c'e' nessuna lettura di quel file.
      const res = await backend.fs.writeFile("projects", fullName,
        window.PGEYaml ? window.PGEYaml.serialize(empty) : "# empty\n",
        { overwrite: true });
      if (!res || !res.ok) {
        pushToast({ kind: "err", title: "Couldn't create project",
                    message: (res && res.error) || "rifiutato", persistent: true });
        return;
      }
      pushToast({ kind: "ok", title: "Project created", message: `configs/${fullName}`, duration: 2200 });
      await refreshProjects();
      onProjectSelect(fullName);
    } catch (e) {
      pushToast({ kind: "err", title: "Couldn't create project", message: e.message, persistent: true });
    }
  }

  /* ============ Render ============ */
  const renderOptions = {
    useCache: tweaks.renderUseCache !== false,
    visualize: !!tweaks.renderVisualize,
    showVoiceOffsets: !!tweaks.renderShowVoiceOffsets,
    grainJson: tweaks.renderGrainJson !== false,
    pageDuration: tweaks.renderPageDuration ?? 15,
    plotEnvelopes: Array.isArray(tweaks.renderPlotEnvelopes) ? tweaks.renderPlotEnvelopes : [],
    bw: !!tweaks.renderBw,
    magnify: !!tweaks.renderMagnify,
    magnifyAt: tweaks.renderMagnifyAt || "",
    reaper: !!tweaks.renderReaper,
    preclean: !!tweaks.renderPreclean,
    outputDir: tweaks.outputPath || "output",
    projectBasename: activeProject.replace(/\.yml$/, ""),
    // Il backend scelto nel popover (#150): acceso nel selettore e stampato
    // dall'anteprima del comando, dalla stessa lettura del POST (#151) —
    // `buildCommand` ne teneva un letterale suo, cioe' un'anteprima "byte per
    // byte" libera di dire numpy sopra un render csound.
    renderer: currentRenderer,
    // surfaced so the render popover can warn when grain data is off but the
    // grain view (in-clip or score panel) is open — see onRender forcing below.
    showGrains: !!tweaks.showGrains,
    grainScoreOpen: grainScoreOpen,
  };
  function setRenderOptions(next) {
    if (next._chooseOutput) {
      const p = prompt("Output folder path:", tweaks.outputPath || "output");
      if (p) setTweak("outputPath", p);
      return;
    }
    setTweak("renderRenderer", next.renderer);
    setTweak("renderUseCache",  next.useCache);
    setTweak("renderVisualize", next.visualize);
    setTweak("renderShowVoiceOffsets", next.showVoiceOffsets);
    setTweak("renderGrainJson", next.grainJson);
    setTweak("renderPageDuration", next.pageDuration);
    setTweak("renderPlotEnvelopes", Array.isArray(next.plotEnvelopes) ? next.plotEnvelopes : []);
    setTweak("renderBw",        next.bw);
    setTweak("renderMagnify",   next.magnify);
    setTweak("renderMagnifyAt", next.magnifyAt || "");
    setTweak("renderReaper",    next.reaper);
    setTweak("renderPreclean",  next.preclean);
  }

  /* Il render ha DUE ingressi — il bottone e la scorciatoia (`r`) — e nessuno
     dei due e' serializzato dal browser. La guardia sta tutta qui, e sul ref:
     con la sola `renderStatus.running` due ingressi ravvicinati passavano
     entrambi, e il danno non era cosmetico. Due `POST /render` scrivono lo
     stesso `configs/<basename>.yml` e gli stessi stem; e `cancelAbort` in
     backend.js e' UNA variabile di chiusura, riassegnata a ogni `run()`, quindi
     il secondo giro sovrascriveva quella del primo e Cancel ne uccideva uno
     solo — l'altro restava a scrivere sul disco senza piu' un modo di fermarlo. */
  /* L'ingresso della UI, e prende zero argomenti di proposito: e' passata a
     `onClick`, che le consegnerebbe un MouseEvent. Le opzioni della guardia
     di #185 entrano da `renderAgain`, cosi' non c'e' nessun patto implicito
     fra i nomi delle sue chiavi e quelli che un evento del DOM non ha. */
  async function onRender() { return renderAgain(); }

  async function renderAgain(opts = {}) {
    if (renderStatus.running || renderingRef.current) return;
    renderingRef.current = true;
    try {
      /* Le due risposte alla domanda di #185 rientrano da qui, e non da
         `runRender`, perche' la guardia della rientranza e' di questa
         funzione: la domanda resta in piedi mentre la tastiera e' libera, e
         un `r` premuto nel frattempo non deve diventare un secondo render.
         `reread` e' la risposta `ricarica`: si rilegge, e si rende la versione
         su disco. */
      let doc = opts.doc || null;
      if (opts.reread) {
        doc = await rereadFiles(opts.reread);
        if (!doc) {
          pushToast({ kind: "err", persistent: true, title: "Render fermo",
                      message: `${opts.reread.join(", ")}: non si rilegge` });
          return;
        }
      }
      await runRender({ doc, overwrite: opts.overwrite });
    } finally {
      renderingRef.current = false;
    }
  }

  /* `opts.doc` e' il documento da rendere, e `opts.overwrite` la decisione
     presa sulla domanda di #185: le passa la guardia quando il render
     riparte dopo una rilettura o un `sovrascrivi`. Senza, e' la `data` dello
     stato e nessuna decisione — cioe' il render di sempre. */
  async function runRender(opts0 = {}) {
    const backend = window.PGEBackend.current;
    const basename = activeProject.replace(/\.yml$/, "");
    const doc = opts0.doc || data;
    /* Le impronte del documento che si RENDE, che dopo una rilettura non e'
       la `data` di questa chiusura: e' quello appena letto dal disco, e
       `currentFps` descrive ancora la versione di prima. Scritte nel record
       dello `stream-done`, le impronte di prima marcavano giallo uno stem
       appena rifatto (la `data` passa alla versione letta subito dopo) — e
       verde quello di uno stream riportato a mano alla versione di prima, su
       un audio reso dall'altra. backend.js le calcola gia' da `opts.streams`,
       quindi qui si allineano i due lati. #185 */
    const fpsOfThisRun = doc === data ? currentFps
      : window.PGERenderStatus.fingerprintAll(doc.streams, tweaks.outputFormat || "wav");

    /* Lo stato si alza PRIMA di qualunque attesa. `jget` passa da
       `fetchWithTimeout` con timeout 10 s, e con l'attesa qui davanti premere
       Render non produceva niente di visibile — log non svuotato, nessun toast,
       bottone non "in corso" — per dieci secondi buoni col bridge lento o giu',
       e poi il render partiva lo stesso. */
    // Il log si azzera al render chiesto, non al nuovo tentativo dopo una
    // rilettura (#185): quello e' lo stesso render, e azzerarlo cancellava la
    // riga `[reread]` appena scritta — cioe' l'unica traccia del perche' il
    // progetto si era appena ricaricato da solo.
    if (!opts0.attempts) setLogLines([]);
    setRenderStatus({ running: true, total: doc.streams.length, done: 0, currentStreamId: null, lastOk: null, lastGenerated: 0 });
    if (!terminalOpen) {
      pushToast({ kind: "info", title: "Rendering started", message: `${doc.streams.length} streams · ${renderOptions.useCache ? "incremental" : "full"}`, duration: 3000 });
    }

    // Terza (e ultima utile) occasione per la versione di semantica: qui il
    // bridge e' per forza raggiungibile, si sta per parlarci. Attesa prima di
    // chiamare `run()`, cosi' gli `stream-done` la trovano gia' nel ref — e
    // l'ordine stato-poi-attesa non toglie niente a quell'intento, perche' il
    // consumatore legge `engineSemRef.current`, non lo stato.
    /* Il numero di QUESTO giro, letto una volta sola e passato a mano ai due
       consumatori: `run()` (che lo registra in fondo) e l'handler degli
       `stream-done` qui sotto. La cella condivisa e il ref sono riscritti da
       chiunque rilegga — e l'effetto sul cambio progetto non ha una guardia
       su `renderStatus.running` — quindi leggerli a meta' render puo' dare il
       numero di DOPO su stem scritti leggendo quello di PRIMA. */
    const semOfThisRun = await refreshEngineSem();
    /* Il backend di QUESTO giro, fissato accanto al numero e per la stessa
       ragione: i due consumatori — il corpo del POST e l'handler degli
       `stream-done` — devono leggere la stessa variabile, non la preferenza
       due volte. Da #150 la preferenza si cambia dal popover, e una seconda
       lettura allo `stream-done` che cadesse dopo un clic sul selettore
       darebbe al pallino il backend nuovo su uno stem che il motore ha scritto
       col vecchio. */
    const rendererOfThisRun = currentRenderer;
    // Terzo punto anche per i clamp, ma SENZA aspettarli: il render non li
    // consuma — li consuma l'editor, dopo — quindi un await qui metterebbe un
    // giro di rete davanti al motore per un dato che a nessuno serve subito.
    // La versione di semantica invece si aspetta eccome: la registrano gli
    // `stream-done` di questo stesso giro.
    refreshEngineBounds();

    let cacheHits = 0;
    let generated = 0;
    let curStreamId = null;

    const opts = {
      yamlBasename: basename,
      yamlContent: window.PGEYaml ? window.PGEYaml.serialize(doc) : null,
      renderer: rendererOfThisRun,
      useCache: renderOptions.useCache,
      visualize: renderOptions.visualize,
      // Force the grain sidecar on when the grain view is open, otherwise the
      // user would be "looking at grains" with no data to draw (issue #68).
      grainJson: renderOptions.grainJson || !!tweaks.showGrains || grainScoreOpen,
      pageDuration: renderOptions.visualize ? renderOptions.pageDuration : undefined,
      showVoiceOffsets: renderOptions.visualize && renderOptions.showVoiceOffsets
        ? true : undefined,
      plotEnvelopes: renderOptions.visualize && renderOptions.plotEnvelopes.length
        ? renderOptions.plotEnvelopes : undefined,
      // Preset di stampa in bianco e nero della partitura (PGE #248 /
      // issue #152). Interruttore puro: niente da validare prima di mandarlo,
      // e niente da temere da un motore che non lo conosce — la CLI ignora i
      // flag che non sa. Il gate su `visualize` e' quello delle altre opzioni
      // di partitura: senza `--visualize` il flag non avrebbe niente da
      // colorare, e l'argv che l'utente legge nel log direbbe il contrario.
      bw: renderOptions.visualize && renderOptions.bw ? true : undefined,
      // Lente della partitura (PGE #214 / issue #120). Lo SPEC dei target
      // espliciti parte solo se la grammatica regge: il motore lo rifiuterebbe
      // con exit 1, portandosi via anche l'audio gia' renderizzato.
      magnify: renderOptions.visualize && renderOptions.magnify ? true : undefined,
      magnifyAt: (renderOptions.visualize
        && magnifySpecToSend(renderOptions.magnifyAt)) || undefined,
      reaper: renderOptions.reaper,
      preclean: renderOptions.preclean,
      streams: doc.streams,
      outputFormat: tweaks.outputFormat || "wav",
      semanticsVersion: semOfThisRun,
      // La decisione presa sulla domanda di #185. La firma NO: la manda
      // backend.js da quella che ha registrato leggendo, che e' la lettura da
      // cui questo documento viene — tenerla in due posti vorrebbe dire
      // poterle far dire due cose.
      overwrite: opts0.overwrite || undefined,
    };
    const result = await backend.render.run(opts, (e) => {
      // Il bridge ha scritto (o trovato gia' scritto) il config: da qui il
      // master contiene QUESTO documento, che e' cio' che `dirtyOfFile`
      // confronta. La firma la registra backend.js; qui c'e' l'altra meta'.
      if (e.type === "file-signatures" && e.signatures && masterFile() in e.signatures) {
        fileDocRef.current = doc;
      }
      if (e.type === "log") {
        setLogLines(ls => [...ls, { text: e.line, cls: classifyLogLine(e.line) }]);
      } else if (e.type === "stream-start") {
        curStreamId = e.streamId;
        setRenderStatus(s => ({ ...s, currentStreamId: e.streamId }));
      } else if (e.type === "stream-done") {
        if (e.cached) cacheHits++;
        // cached=false → il motore ha riscritto il grain JSON: marcalo per il
        // refetch selettivo dei grani (#73).
        else {
          generated++;
          grainRegenRef.current.add(e.streamId);
          // Stem rigenerato → invalida la cache peaks anche quando il fingerprint
          // non cambia (es. spostamento clip: onset escluso dal fingerprint).
          stemRevRef.current[e.streamId] = (stemRevRef.current[e.streamId] || 0) + 1;
        }
        setRenderStatus(s => ({ ...s, done: s.done + 1 }));
        // bump fp for this stream (so UI marks it fresh)
        setLastRenderedFps(fps => ({ ...fps, [e.streamId]: fpsOfThisRun[e.streamId] }));
        // ...e la semantica con cui il motore l'ha appena scritto. Senza questa
        // riga lo stem resterebbe marcato con quella del render precedente e
        // tornerebbe giallo subito dopo essere stato rifatto. La persistenza su
        // localStorage la fa backend.js insieme ai fingerprint, con la stessa
        // regola: col numero ignoto la voce si cancella invece di restare
        // indietro, perche' una versione vecchia su uno stem nuovo e' peggio di
        // nessuna versione.
        setRenderedSem(m => {
          const sem = semOfThisRun;
          if (sem !== null) return { ...m, [e.streamId]: sem };
          if (!(e.streamId in m)) return m;
          const next = { ...m };
          delete next[e.streamId];
          return next;
        });
        // ...e il backend che l'ha scritto (#151). Stessa riga, stesso momento:
        // i due record descrivono lo stesso stem dello stesso giro, e backend.js
        // li persiste insieme.
        //
        // Col nome ignoto la voce si cancella, come per il numero — e la regola
        // si applica anche qui e non solo in backend.js perche' i due lati
        // devono dire la stessa cosa: backend.js cancella dal localStorage, e
        // uno stato in memoria che tenesse il nome di prima mostrerebbe un
        // colore diverso fino alla riapertura del progetto. E' la STESSA
        // regola, `rendererName`, non una copia: con un test di verita' qui e
        // la stringa non vuota la', un 7 restava in memoria e spariva dal
        // localStorage. Con la scelta nel popover (#150) il valore viene da
        // una preferenza, e una divergenza che dura una sessione e' peggio di
        // una che non esiste.
        setRenderedRenderer(m => {
          const name = window.PGEBackend.rendererName(rendererOfThisRun);
          if (name !== null) {
            return m[e.streamId] === name ? m : { ...m, [e.streamId]: name };
          }
          if (!(e.streamId in m)) return m;
          const next = { ...m };
          delete next[e.streamId];
          return next;
        });
      } else if (e.type === "stems-resync") {
        // Il giro e' fallito ma ha trovato stem su disco che il motore puo'
        // aver riscritto prima di morire (#151). Niente record di provenienza
        // — quelli li scrive solo lo `stream-done`, e qui non se ne reclama
        // uno — ma la meta' "media" di un `cached: false`: peaks, grani e
        // spettrogramma si rileggono dal disco, come backend.js ha appena
        // fatto con le durate. Senza, la clip suonava lo stem nuovo col
        // disegno del vecchio.
        for (const id of e.streamIds || []) {
          grainRegenRef.current.add(id);
          stemRevRef.current[id] = (stemRevRef.current[id] || 0) + 1;
        }
        setStemResync(n => n + 1);
      }
    });

    setRenderStatus(s => ({
      ...s, running: false, currentStreamId: null,
      lastOk: !!result.ok, lastGenerated: (result.generated || []).length,
    }));

    /* Due editor, un file (#185). Il bridge ha RIFIUTATO di scrivere il config
       e il motore non e' nemmeno partito: non e' un render fallito, e dirlo
       "Render failed" manderebbe chi guarda a cercare un errore nel log che
       non c'e'. La decisione e' la stessa del salva, perche' e' la stessa
       guardia sullo stesso file.

       La rilettura riparte dal render, col documento appena letto: «il render
       prosegue sulla versione su disco», che e' quella che l'altro editor ha
       appena scritto, cioe' quella che si vuole sentire. Il `sovrascrivi`
       riparte uguale, con la decisione in mano.

       `configWritten` resta false su questo ramo (lo dice backend.js), quindi
       la migrazione di `dephase` non si spegne: il file non e' stato scritto. */
    if (result.changed) {
      const names = refusedFiles(result);
      const plan = window.PGEFileGuard.plan(names.map(name => ({
        name, changed: true,
        // `doc` e non la `data` di questa chiusura: dopo una rilettura (il nuovo
        // tentativo qui sotto, o la `ricarica`) si rende il documento appena
        // letto, il lavoro proprio l'ha scartato la rilettura stessa, e la
        // `data` e il `dirty` di qui sono ancora quelli di prima.
        dirty: dirtyOfFile(name, doc),
        attempts: opts0.attempts || 0,
      })));
      if (plan.action === "reread") {
        const fresh = await rereadFiles(plan.reread);
        if (fresh) {
          logToTerminal(`[reread] ${names.join(", ")} · render ripreso dalla versione su disco`, "warn");
          return await runRender({ doc: fresh, attempts: (opts0.attempts || 0) + 1 });
        }
        pushToast({ kind: "err", persistent: true, title: "Render fermo",
                    message: `${names.join(", ")}: non si rilegge — niente scritto, niente reso` });
        return;
      }
      if (plan.action === "ask") {
        if (plan.reread.length) await rereadFiles(plan.reread);
        // Le due risposte girano dal click sul toast, fuori da qui: la coda si
        // chiude, o una promise rifiutata diventa una unhandled rejection. E
        // passano da `guardLatestRef`, cioe' dal `renderAgain` di ADESSO: quello
        // di questa chiusura renderebbe il documento, il backend e le opzioni
        // di quando la domanda e' stata posta, non di quando ha risposta.
        askChangedOnDisk(plan.ask,
          () => { guardLatestRef.current.renderAgain({ reread: plan.ask }).catch(() => {}); },
          () => { guardLatestRef.current.renderAgain({ overwrite: true }).catch(() => {}); });
        return;
      }
      pushToast({ kind: "err", persistent: true, title: "Render fermo",
                  message: `${names.join(", ")} continua a cambiare su disco — niente reso` });
      return;
    }

    // Come dopo un Save, e per la stessa ragione: server.py scrive yamlContent
    // su configs/<basename>.yml PRIMA di lanciare il motore, quindi la
    // migrazione di `dephase` e' avvenuta anche se poi il render fallisce —
    // percio' qui, non dentro `result.ok`. Ma non quando il file non e' stato
    // scritto affatto (server down, o uno dei quattro rifiuti 400 che precedono la
    // scrittura): li' la riscrittura e' ancora da fare e l'avviso deve restare.
    // `!== false` e non truthiness: sul percorso buono il campo non c'e', e
    // solo un "so che non e' stato scritto" esplicito spegne lo spegnimento.
    if (result.configWritten !== false) {
      _setDataRaw(d => window.PGEYaml ? window.PGEYaml.clearDeviationProbabilityLegacy(d) : d);
    }

    if (result.ok) {
      const ren = (result.generated?.length || 0) - cacheHits;
      const msg = `${ren} rendered · ${cacheHits} cached`;
      if (!terminalOpen) {
        pushToast({
          kind: "ok", title: "Render complete", message: msg, duration: 4000,
          action: { label: "open log", onClick: () => setTerminalOpen(true) },
        });
      }
    } else {
      pushToast({
        kind: "err", title: "Render failed", message: result.error || "see log",
        duration: 8000,
        action: { label: "open log", onClick: () => { setTerminalOpen(true); setTweak("terminalOpen", true); } },
      });
    }
  }
  function onCancelRender() {
    const backend = window.PGEBackend.current;
    backend.render.cancel();
  }

  /* ============ Play readiness ============ */
  const playReadiness = useMemoApp(() => {
    const total = renderSummary.total;
    const { fresh, stale, never } = renderSummary;
    if (renderStatus.running) {
      return { state: "rendering", label: "rendering…", tooltip: "render is still in progress" };
    }
    if (total === 0) {
      return { state: "blocked", label: "no streams", tooltip: "add a stream first" };
    }
    if (never === total) {
      return { state: "blocked", label: "no stems · render first", tooltip: "no audio has been rendered yet — click Render" };
    }
    if (stale > 0) {
      return { state: "warn", label: `${stale} stale · playing old audio`, tooltip: "playing previously-rendered audio; re-render to refresh" };
    }
    if (never > 0) {
      return { state: "warn", label: `${never} silent · need render`, tooltip: `${never} stream(s) never rendered — they will be silent during playback` };
    }
    return { state: "ready", label: "stems ready", tooltip: "all streams rendered and up-to-date" };
  }, [renderSummary, renderStatus.running]);

  async function doPlay() {
    if (playReadiness.state === "blocked") {
      pushToast({ kind: "warn", title: "Can't play yet", message: playReadiness.tooltip, duration: 3500,
                  action: { label: "render", onClick: onRender } });
      return;
    }
    const engine = window.PGEAudio?.engine;
    if (!engine) { setPlaying(p => !p); return; }

    if (playing) {
      engine.pause();
      setPlaying(false);
      return;
    }

    // Need a user gesture for audioCtx.resume() — this call IS the gesture.
    await engine.resumeIfSuspended();

    const backend = window.PGEBackend.current;
    const basename = activeProject.replace(/\.yml$/, "");

    // Rendered stems are fetched from server.py and decoded into AudioBuffers
    // for scheduling. Streams that have never been rendered have no stem and
    // stay silent.
    const urlMap = {};
    const preloads = [];
    for (const s of data.streams) {
      const last = lastRenderedFps[s.id];
      const hasStem = hasStemFor(s.id);
      if (!hasStem) continue;
      const url = backend.render.stemUrl ? backend.render.stemUrl(basename, s.id, tweaks.outputFormat || "wav") : null;
      if (url) {
        urlMap[s.id] = url;                            // streamed, no decode
      } else {
        preloads.push(
          engine.ensureBuffer(s.id, { duration: s.duration, color: s.color, fingerprint: last || currentFps[s.id], url: null })
            .catch((e) => pushToast({ kind: "warn", title: `couldn't load ${s.id}`, message: e.message, duration: 3000 }))
        );
      }
    }
    engine.setStreamUrls(urlMap);
    await Promise.all(preloads);

    engine.syncMuteSoloFromStreams(data.streams);
    audioErrToastedRef.current = false;      // one toast per playback, not per session
    engine.scheduleStreams(data.streams, basename, time);
    engine.play();
    setPlaying(true);
  }

  function doStop() {
    const engine = window.PGEAudio?.engine;
    if (engine) engine.stop();
    setPlaying(false);
    setTime(0);
  }

  function doSeekZero() {
    const engine = window.PGEAudio?.engine;
    if (engine) engine.seek(0);
    setTime(0);
  }

  /* ============ Project switch / folder pickers ============ */
  function logToTerminal(text, cls = "") {
    setLogLines(ls => [...ls, { text, cls }]);
  }

  async function onProjectSelect(name) {
    const backend = window.PGEBackend.current;
    // Un `apri` rende superata la domanda di #185, se ce n'e' una in piedi: era
    // su un file che da qui non e' piu' il documento aperto, e un suo
    // `sovrascrivi` ci scriverebbe sopra cio' che si apre adesso.
    dropChangedQuestion();
    setActiveProject(name);
    setTweak("activeProject", name);
    const t0 = performance.now();
    try {
      const yamlText = await backend.fs.readFile("projects", name);
      if (yamlText && window.PGEYaml) {
        const basename = name.replace(/\.yml$/, "");
        const parsed = window.PGEYaml.parse(yamlText, {
          project: basename,
          // dal ref, non dallo stato: la closure e' stata catturata prima
          // dell'await sopra, e la media list puo' essere atterrata nel mezzo.
          samples: mediaFilesRef.current || [],
        });
        // Intentional _setDataRaw (bypasses history): loading a project is an
        // atomic action, not an undoable edit — resetHistory() clears the stack
        // right after so undo can't step back into the previous project. #44
        _setDataRaw(parsed);
        resetHistory();
        setDirty(false);
        // Cio' che il file contiene, per `dirtyOfFile` (#185).
        fileDocRef.current = parsed;
        const ms = (performance.now() - t0).toFixed(0);
        logToTerminal(`[load] ${name} · ${parsed.streams.length} streams · ${parsed.duration}s · ${(yamlText.length/1024).toFixed(1)}kb · ${ms}ms`, "ok");
        // Run a round-trip check — if the bridge would lose information on
        // save, surface it now while the user can decide what to do.
        try {
          const diffs = window.PGEYaml.roundTripDiff(parsed);
          if (diffs.length) {
            logToTerminal(`[warn] round-trip would lose ${diffs.length} field(s) on save — see console for paths`, "warn");
            console.warn(`[PGE] round-trip diffs for ${name}:`, diffs);
            pushToast({
              kind: "warn", title: "YAML lossy round-trip",
              message: `${diffs.length} field(s) would change on Save — check terminal log`,
              duration: 6000,
              action: { label: "show log", onClick: () => setTerminalOpen(true) },
            });
          }
        } catch (e) { console.warn("round-trip check failed", e); }
        pushToast({ kind: "info", title: `loaded ${name}`, message: `${parsed.streams.length} streams · ${parsed.duration}s`, duration: 2000 });
        // also invalidate audio buffers — new project has different streams
        if (window.PGEAudio) window.PGEAudio.engine.invalidateAll();
        /* Il documento letto torna al chiamante, e serve a uno solo: la
           rilettura della guardia di #185, che subito dopo deve ri-serializzare
           cio' che ha appena letto. Lo stato React non e' disponibile in modo
           sincrono — `_setDataRaw` qui sopra non ha ancora cambiato la `data`
           della closure che sta scrivendo — e rileggere "e poi riprovare col
           documento di prima" rimanderebbe al bridge esattamente cio' che ha
           appena rifiutato. */
        return parsed;
      }
      logToTerminal(`[load] ${name} · empty file or yaml bridge unavailable — fallback`, "warn");
    } catch (e) {
      logToTerminal(`[ERROR] couldn't load ${name}: ${e.message}`, "err");
      pushToast({ kind: "warn", title: `couldn't load ${name}`, message: e.message + " · using fallback", duration: 3000 });
    }
    // Fallback: empty/unreadable file → synthesize a minimal blank project.
    // Same as above: intentional _setDataRaw + resetHistory (atomic load, not
    // an undoable edit). #44
    const meta = { project: name.replace(/\.yml$/, ""), title: "", duration: 10 };
    _setDataRaw(d => ({ ...d, project: meta.project, title: meta.title, duration: meta.duration, streams: [] }));
    resetHistory();
    setDirty(false);
    fileDocRef.current = null;
    // Niente da tornare: qui il file non si e' letto. Chi rilegge per la
    // guardia (#185) lo distingue da un documento vero e si fermera' invece di
    // riprovare a scrivere un progetto vuoto sopra quello dell'altro editor.
    return null;
  }

  /* Cambio di workspace (#147): la cartella con configs/ output/ cache/.
   *
   * Non e' un merge, e' un rimpiazzo. Tutto quello che il browser ha in mano
   * — elenco progetti, indice degli stem, peaks, spettrogrammi, grani,
   * impronte dell'ultimo render — descrive la cartella di prima; tenerne un
   * pezzo significa una clip col pallino verde e nessun audio dietro. Il
   * server e' l'autorita': valida il percorso, commuta e risponde con
   * l'elenco progetti nuovo, in un giro solo. */
  async function onWorkspaceChange(path) {
    const backend = window.PGEBackend.current;
    if (!backend.setWorkspace) {
      return { ok: false, error: "server.py senza endpoint /workspace — aggiornalo" };
    }
    const res = await backend.setWorkspace(path);
    if (!res || res.ok !== true) return res || { ok: false, error: "cambio rifiutato" };

    // La domanda di #185 era su un file della cartella di prima. Il ramo senza
    // progetti qui sotto non passa da `onProjectSelect`, che la chiuderebbe:
    // lasciata li', la sua `ricarica` aprirebbe un file che nella cartella
    // nuova non c'e' (cioe' il progetto vuoto di ripiego al posto di quello
    // aperto), e il `sovrascrivi` scriverebbe senza che nessuno l'abbia letto.
    dropChangedQuestion();

    // backend.setWorkspace ha gia' svuotato l'indice degli stem; qui cade il
    // resto dello stato per-stream, che e' React.
    setWaveforms({});
    setSpectrograms({});
    setGrainData({});
    setLastRenderedFps({});
    // La meta' in memoria di `pge-local-sem`, che setWorkspace ha appena
    // buttato: senza questa riga, un progetto omonimo (dove `activeProject`
    // non cambia e l'effetto su [activeProject] non riparte) continuerebbe a
    // classificare con le versioni della cartella di prima.
    setRenderedSem({});
    // ...e quella di `pge-local-renderer` (#151), per la stessa ragione: senza,
    // col motore ignoto gli stem della cartella nuova resterebbero verdi sui
    // backend registrati in quella di prima, fino al reload.
    setRenderedRenderer({});
    grainLoadedRef.current = new Set();
    grainRegenRef.current = new Set();
    stemRevRef.current = {};
    if (window.PGEAudio) window.PGEAudio.engine.invalidateAll();

    // I campi informativi in Settings vanno riscritti a forza: qui le path
    // sono cambiate davvero, mentre _syncPathsFromServer scrive solo i vuoti.
    const paths = res.paths || {};
    if (paths.refs)    setTweak("mediaPath",    paths.refs);
    if (paths.configs) setTweak("projectsPath", paths.configs);
    if (paths.output)  setTweak("outputPath",   paths.output);

    // Su un motore con --samples-dir anche refs/ e' cambiata (#148), quindi la
    // media list e' un'altra: questo e' il punto che se ne accorge. Sull'altro
    // motore torna identica, e ricaricarla costa una GET.
    await refreshMedia();
    await refreshProjects();

    const files = res.projects || [];
    if (!files.length) {
      // Nessun .yml: il progetto in memoria resta aperto ed e' quello che un
      // Salva scriverebbe qui — cioe' il modo di portarsi un brano nella
      // cartella nuova. Detto, non subito.
      pushToast({ kind: "warn", title: "workspace senza progetti",
                  message: `${res.workspace} — nessun .yml. Salva per portarci quello aperto`,
                  duration: 6000 });
    } else {
      // L'omonimo vince sul primo della lista, come al boot.
      const target = files.some(f => f.name === activeProject) ? activeProject : files[0].name;
      bootLoadedRef.current = true;   // la selezione l'abbiamo fatta noi
      await onProjectSelect(target);
      // E qui l'indice degli stem si riempie dalla output/ nuova. Non si puo'
      // lasciare all'effetto su [activeProject]: due cartelle possono avere un
      // progetto omonimo, e in quel caso `activeProject` non cambia, l'effetto
      // non riparte e ogni clip resterebbe ⚪ con gli stem sul disco.
      const cache = await backend.render.loadCache(target.replace(/\.yml$/, ""));
      setLastRenderedFps(cache || {});
      pushToast({ kind: "info", title: "workspace",
                  message: `${res.workspace} · ${files.length} progetti`, duration: 3000 });
    }
    logToTerminal(`[workspace] ${res.workspace} · ${files.length} progetti · configs ${paths.configs}`, "ok");
    return res;
  }

  async function onChooseMediaFolder() {
    const backend = window.PGEBackend.current;
    try {
      const res = await backend.fs.chooseDir("media");
      if (res) setTweak("mediaPath", res.path);
    } catch (e) {
      pushToast({ kind: "err", title: "Couldn't pick folder", message: e.message, duration: 4000 });
    }
  }
  async function onChooseProjectsFolder() {
    const backend = window.PGEBackend.current;
    try {
      const res = await backend.fs.chooseDir("projects");
      if (res) setTweak("projectsPath", res.path);
    } catch (e) {
      pushToast({ kind: "err", title: "Couldn't pick folder", message: e.message, duration: 4000 });
    }
  }

  /* ============ Render summary text in status bar ============ */
  const summaryLabel = useMemoApp(() => {
    const { fresh, stale, never, total } = renderSummary;
    if (renderStatus.running) return `⟳ rendering ${renderStatus.done}/${total}`;
    if (total === 0) return "— no streams";
    if (stale === 0 && never === 0) return `✓ ${total} stems · all fresh`;
    if (never === total) return "— never rendered";
    const parts = [];
    if (fresh) parts.push(`${fresh} fresh`);
    if (stale) parts.push(`${stale} stale`);
    if (never) parts.push(`${never} never`);
    return parts.join(" · ");
  }, [renderSummary, renderStatus.running, renderStatus.done]);

  const terminalDotState = renderStatus.running ? "run" : (renderStatus.lastOk === false ? "err" : (logLines.length ? "idle-ok" : null));

  const { TopBar, SampleBrowser, Timeline, Inspector, SplitPane, EnvelopeEditor, Terminal, Toast, SettingsPanel, MediaPreview, Stereoscope, ErrorBoundary, VUMeter, GrainScore } = window.PGE;
  const gestures = { zoom: tweaks.gestureZoom, laneHeight: tweaks.gestureLaneHeight, hScroll: tweaks.gestureHScroll };

  const browserPanel = (
    <div className="pge-browser-col">
      <SampleBrowser mediaList={mediaList} projectsList={projectsList}
                     onRefreshMedia={refreshMedia} onRefreshProjects={refreshProjects}
                     activeSample={activeSample} onSelectSample={setActiveSample}
                     onPreviewSample={setPreviewSample}
                     activeProject={activeProject}
                     onSelectProject={onProjectSelect}
                     onNewProject={onNewProject}
                     showWaveform={tweaks.showWaveformBrowser}
                     onChooseMediaFolder={onChooseMediaFolder}
                     onChooseProjectsFolder={onChooseProjectsFolder} />
      <div className="scope-row">
        <Stereoscope open={scopeOpen}
                     height={tweaks.scopeHeight || 180}
                     onHeightChange={(h) => setTweak("scopeHeight", h)}
                     onClose={() => { setScopeOpen(false); setTweak("scopeOpen", false); }} />
        {VUMeter && <VUMeter mode="master" open={scopeOpen} height={tweaks.scopeHeight || 180} />}
      </div>
    </div>
  );
  const timelineEl = (
    <ErrorBoundary label="Timeline">
    <Timeline streams={data.streams} tracks={tracks} selected={selectedIds}
              onSelect={selectClip} onTrackSelect={selectTrack} selectedTrack={selectedTrackId}
              onDeselect={() => { setSelectedIds([]); setSelectedTrackId(null); }} onRangeSelect={rangeSelectClip} onMarqueeSelect={marqueeSelectClips} onDoubleSelect={openInspector} onUpdate={updateStream}
              onTrackReorder={reorderTracks} onTrackRename={renameTrack}
              onTrackMute={(id) => setTrackFlag(id, "mute")} onTrackSolo={(id) => setTrackFlag(id, "solo")}
              onMoveStreams={moveStreamsToLane}
              onAddTrack={addTrack} onTrackRemove={removeTrack}
              onCreateStream={createStreamFromSample}
              playhead={time} duration={compDuration}
              pxPerSec={tweaks.zoom} showWaveforms={tweaks.showWaveforms} showSpectrograms={!!tweaks.showSpectrograms} showGrains={!!tweaks.showGrains} showClipLabels={tweaks.showClipLabels !== false}
              laneHeight={tweaks.laneHeight} gestures={gestures}
              onZoom={(v) => setTweak("zoom", v)}
              onLaneHeight={(v) => setTweak("laneHeight", v)}
              renderStatusFor={renderStatusForStream}
              waveformFor={(id) => waveforms[id]}
              spectrogramFor={(id) => spectrograms[id]}
              grainsFor={(id) => grainData[id]}
              loopEnabled={loopEnabled} loopRegion={loopRegion} onLoopRegionChange={setLoopRegion}
              arrowOwnerRef={envArrowRef}
              sampleDurOf={(name) => ((mediaList.files || []).find(f => f.name === name) || {}).duration || 0}
              stemDurFor={(id) => {
                const b = window.PGEBackend.current.render;
                return b.stemDur
                  ? b.stemDur(activeProject.replace(/\.yml$/, ""), id,
                              tweaks.outputFormat || "wav")
                  : null;
              }}
              onNeedGrains={ensureGrainData}
              laneMoveKeys={[tweaks.shortcutMoveLaneUp || MOVE_LANE_UP,
                             tweaks.shortcutMoveLaneDown || MOVE_LANE_DOWN]}
              analysersFor={(ids) => ids.map(id => window.PGEAudio?.engine?.trackAnalyser(id)).filter(Boolean)} />
    </ErrorBoundary>
  );
  const envelopeEl = (
    <ErrorBoundary label="Envelope editor">
    <EnvelopeEditor stream={selected()} pxPerSec={tweaks.zoom} duration={compDuration}
                    playhead={time}
                    samples={mediaList.files}
                    onChange={(p) => selectedId && updateStream(selectedId, p)}
               onRename={(name) => selectedId ? renameStream(selectedId, name) : null}
                    onLoopPanelChange={setLoopPanelOpen}
                    focusKey={envFocusKey}
                    arrowOwnerRef={envArrowRef} />
    </ErrorBoundary>
  );
  const center = (
    <div className="pge-center" data-screen-label="01 Main · Timeline + Envelopes">
      {tweaks.showEnvelopeEditor === false ? timelineEl : (
        <SplitPane dir="vert" persist="env-editor" initial={tweaks.envelopeHeight || 240} min={120} max={600} side="primary-last" extraSize={loopPanelOpen ? 110 : 0}>
          {timelineEl}
          {envelopeEl}
        </SplitPane>
      )}
    </div>
  );
  const inspectorEl = inspectorOpen ? (
    <ErrorBoundary label="Inspector">
    <Inspector stream={selected() || null}
               onChange={(p) => selectedId && updateStream(selectedId, p)}
               onRename={(name) => selectedId ? renameStream(selectedId, name) : null}
               onClose={closeInspector}
               tab={inspectorTab} onTab={setInspectorTab}
               samples={mediaList.files}
               freezeEnvOnResize={freezeEnvOnResize}
               onFreezeEnvToggle={setFreezeEnvOnResize}
               onFocusEnvParam={(key) => {
                 if (tweaks.showEnvelopeEditor === false) setTweak("showEnvelopeEditor", true);
                 setEnvFocusKey(key + ":" + Date.now());
               }} />
    </ErrorBoundary>
  ) : null;

  return (
    <div className={"pge-app" + (tweaks.showFooter ? "" : " no-footer") + (terminalOpen ? " with-terminal" : "") + (grainScoreOpen ? " with-grainscore" : "")}>
      <TopBar project={data.project} title={data.title} dirty={dirty}
              seed={data.seed} onSeedChange={setSeed}
              playing={playing} onPlay={doPlay}
              onStop={doStop}
              loopEnabled={loopEnabled} onToggleLoop={() => setLoopEnabled(v => !v)}
              onSeekZero={doSeekZero}
              onRender={onRender} onCancelRender={onCancelRender}
              renderStatus={renderStatus}
              renderOptions={renderOptions} onRenderOptionsChange={setRenderOptions}
              envelopeKeys={envelopeKeys}
              renderers={engineRenderers}
              onRenderOptionsOpen={refreshRenderers}
              time={time} duration={compDuration}
              onUndo={undo} onRedo={redo} canUndo={canUndo} canRedo={canRedo}
              browserOpen={browserOpen} onToggleBrowser={() => setBrowserOpen(o => !o)}
              onSave={onSave} onSaveAs={onSaveAs}
              onOpenSettings={() => setSettingsOpen(true)}
              terminalOpen={terminalOpen}
              onToggleTerminal={() => { const v = !terminalOpen; setTerminalOpen(v); setTweak("terminalOpen", v); if (v) dismissErrToasts(); }}
              terminalDotState={terminalDotState}
              scopeOpen={scopeOpen}
              onToggleScope={() => { const v = !scopeOpen; setScopeOpen(v); setTweak("scopeOpen", v); if (v && !browserOpen) { setBrowserOpen(true); } }}
              grainScoreOpen={grainScoreOpen}
              onToggleGrainScore={() => { const v = !grainScoreOpen; setGrainScoreOpen(v); setTweak("grainScoreOpen", v); }}
              playReadiness={playReadiness} />
      <div className={"pge-main split"}>
        {browserOpen ? (
          <SplitPane dir="horiz" persist="browser" initial={tweaks.browserWidth || 240} min={180} max={420}>
            {browserPanel}
            {inspectorEl ? (
              <SplitPane dir="horiz" persist="inspector" initial={tweaks.inspectorWidth || 380} min={260} max={560} side="primary-last">
                {center}
                {inspectorEl}
              </SplitPane>
            ) : center}
          </SplitPane>
        ) : (
          inspectorEl ? (
            <SplitPane dir="horiz" persist="inspector" initial={tweaks.inspectorWidth || 380} min={260} max={560} side="primary-last">
              {center}
              {inspectorEl}
            </SplitPane>
          ) : center
        )}
      </div>

      <Terminal open={terminalOpen} lines={logLines}
                onClose={() => { setTerminalOpen(false); setTweak("terminalOpen", false); }}
                onClear={() => setLogLines([])}
                onCopyAll={() => { navigator.clipboard?.writeText(logLines.map(l => l.text).join("\n")); pushToast({ kind: "ok", title: "Log copied", duration: 1600 }); }}
                height={tweaks.terminalHeight || 220}
                onHeightChange={(h) => setTweak("terminalHeight", h)}
                status={renderStatus} />
      {GrainScore ? (
        <GrainScore open={grainScoreOpen}
                    onClose={() => { setGrainScoreOpen(false); setTweak("grainScoreOpen", false); }}
                    height={tweaks.grainScoreHeight || 260}
                    onHeightChange={(h) => setTweak("grainScoreHeight", h)}
                    streams={data.streams}
                    grainData={grainData}
                    duration={compDuration}
                    playhead={time}
                    pxPerSec={tweaks.zoom} />
      ) : null}
      <Toast toasts={toasts} onDismiss={dismissToast} />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)}
                     tweaks={tweaks} setTweak={setTweak}
                     serverDown={serverDown}
                     onWorkspaceChange={onWorkspaceChange} />

      {previewSample && MediaPreview ? (
        <MediaPreview sample={previewSample}
                      baseUrl={tweaks.serverUrl || window.PGEBackend.defaultServerUrl()}
                      onClose={() => setPreviewSample(null)} />
      ) : null}

      {tweaks.showFooter ? (
        <footer className="pge-footer">
          <span className="dot" />
          <span className="mono">{data.streams.length} streams</span>
          <span className="sep" />
          <span className="mono">{`sr ${window.PGE_OUTPUT_SR} · stereo`}</span>
          <span className="sep" />
          <span className="mono">{activeProject.replace(/\.yml$/, ".aif")}</span>
          <span className="sep" />
          <span className={"render-summary mono"
            + (renderStatus.running ? " s-run"
              : renderSummary.stale > 0 ? " s-stale"
              : renderSummary.never === renderSummary.total ? " s-never"
              : renderSummary.never > 0 ? " s-partial"
              : " s-fresh")}
            title={`fresh ${renderSummary.fresh} · stale ${renderSummary.stale} · never ${renderSummary.never}`}>
            {summaryLabel}
          </span>
          <span style={{flex:1}} />
          <span className="mono">{dirty ? "● modified" : "● saved"}</span>
          <span className="sep" />
          <span className="mono">{prettyGesture(tweaks.gestureZoom)} ▸ zoom · {prettyGesture(tweaks.gestureLaneHeight)} ▸ lane h</span>
        </footer>
      ) : null}
    </div>
  );
}

/* SPEC delle lenti esplicite (--magnify-at): cosa parte, o null.
 *
 * Il motore rifiuta uno SPEC malformato con exit 1 — la partitura non si
 * degrada, muore l'intero render — quindi il filtro esiste; ma non vive piu'
 * qui. Era una copia, e come copia si e' disallineata: usava `.trim()` di JS
 * mentre il modulo era passato allo strip ASCII, cosi' la popover mostrava
 * rosso su uno SPEC che poi partiva ripulito. Ora la decisione e il testo che
 * finisce in argv vengono dalla stessa funzione (`sendable` in
 * src/lib/magnify-spec.js, node-testata), qui e in RenderButton.buildCommand.
 *
 * Il ramo senza modulo resta per il caso in cui magnify-spec.js non sia
 * caricato: manda quel che c'e', com'e' sempre stato. */
function magnifySpecToSend(spec) {
  if (window.PGEMagnifySpec) return window.PGEMagnifySpec.sendable(spec);
  return (spec || "").trim() || null;
}

function classifyLogLine(s) {
  if (!s) return "";
  if (/\[ERROR\]|Errore|errno|traceback/i.test(s)) return "err";
  if (/\[CACHE\]|cached/i.test(s)) return "muted";
  if (/\[ABORT\]/i.test(s)) return "warn";
  if (/Generazione completata|→ output\//i.test(s)) return "ok";
  if (/^\s*$/.test(s)) return "blank";
  return "";
}

function prettyGesture(g) {
  if (!g) return "wheel";
  return g.replace("cmd", "⌘").replace("alt", "⌥").replace("shift", "⇧").replace("ctrl", "⌃").replace("+wheel", "·wheel");
}

// Match a keyboard event against a shortcut spec like "cmd+i", "shift+cmd+p",
// "ctrl+alt+e", or a bare key like "f1". cmd matches metaKey on mac and ctrlKey
// elsewhere (so the same spec works cross-platform).
// Defaults for the lane-move pair. They live on `window` because three places
// need the same fallback: the handler, the Timeline (which must know what to
// keep its hands off) and the Settings row.
const MOVE_LANE_UP = "alt+arrowup";
const MOVE_LANE_DOWN = "alt+arrowdown";
window.PGE_MOVE_LANE_DEFAULTS = { up: MOVE_LANE_UP, down: MOVE_LANE_DOWN };
function matchShortcut(e, spec) {
  if (!spec) return false;
  const parts = spec.toLowerCase().split("+").map(s => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  const key = parts.pop();
  const needsCmd   = parts.includes("cmd") || parts.includes("meta");
  const needsCtrl  = parts.includes("ctrl") && !needsCmd;
  const needsShift = parts.includes("shift");
  const needsAlt   = parts.includes("alt") || parts.includes("opt") || parts.includes("option");
  const evKey = (e.key || "").toLowerCase();
  if (evKey !== key) return false;
  const cmdLike = e.metaKey || e.ctrlKey;
  if (needsCmd && !cmdLike) return false;
  if (!needsCmd && !needsCtrl && cmdLike) return false;
  if (needsCtrl && !e.ctrlKey) return false;
  if (needsShift !== e.shiftKey) return false;
  if (needsAlt !== e.altKey) return false;
  return true;
}
window.matchShortcut = matchShortcut;

// Render a shortcut spec as glyphs for display (e.g. "cmd+i" → "⌘ I").
function prettyShortcut(spec) {
  if (!spec) return "";
  return spec.toLowerCase().split("+").map(p => {
    if (p === "cmd" || p === "meta") return "⌘";
    if (p === "ctrl") return "⌃";
    if (p === "shift") return "⇧";
    if (p === "alt" || p === "opt" || p === "option") return "⌥";
    if (p === "arrowup") return "↑";
    if (p === "arrowdown") return "↓";
    if (p === "arrowleft") return "←";
    if (p === "arrowright") return "→";
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(" ");
}
window.prettyShortcut = prettyShortcut;

ReactDOM.createRoot(document.getElementById("app")).render(<App />);
