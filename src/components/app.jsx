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
const { rescaleStreamEnvelopes, truncateStreamEnvelopes, streamWouldTruncate } = window.PGEEnvUtils;

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
  const [terminalOpen, setTerminalOpen] = useStateApp(!!tweaks.terminalOpen);
  const [scopeOpen, setScopeOpen] = useStateApp(!!tweaks.scopeOpen);
  const [grainScoreOpen, setGrainScoreOpen] = useStateApp(!!tweaks.grainScoreOpen);
  const [logLines, setLogLines] = useStateApp([]);
  const [renderStatus, setRenderStatus] = useStateApp({
    running: false, total: 0, done: 0, currentStreamId: null, streamProgress: 0,
    lastOk: null, lastGenerated: 0,
  });
  const [streamProgress, setStreamProgress] = useStateApp({});  // {streamId: progress 0..1}
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
      const baseUrl = tweaks.serverUrl || "http://localhost:7878";
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
        // Pull the engine's parameter clamps so the UI's bounds + envelope
        // auto-fit track the engine instead of the static fallback. Best-effort:
        // an older server.py / engine returns {} and the fallback stays.
        if (window.PGEBounds && window.PGEBackend.current.bounds) {
          window.PGEBackend.current.bounds()
            .then(raw => { if (raw && Object.keys(raw).length) window.PGEBounds.apply(raw); })
            .catch(() => {});
        }
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
        logToTerminal(`[boot] server non raggiungibile su ${baseUrl} — avvia server.py (make serve)`, "err");
        pushToast({
          kind: "warn", title: "Server non raggiungibile",
          message: `avvia server.py su ${baseUrl} (make serve)`,
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

  /* Aggregate render summary: counts of fresh / stale / never */
  const renderSummary = useMemoApp(
    () => window.PGERenderStatus.summarize(data.streams, currentFps, lastRenderedFps, hasStemFor),
    [data.streams, currentFps, lastRenderedFps, activeProject]);

  function renderStatusForStream(streamId) {
    return window.PGERenderStatus.statusForStream(streamId, {
      currentFps, lastRenderedFps, hasStem: hasStemFor,
      running: renderStatus.running,
      currentStreamId: renderStatus.currentStreamId,
      streamProgress,
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
        const peaksUrl = backend.render.peaksUrl ? backend.render.peaksUrl(basename, s.id) : null;
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
  }, [streamMediaKey, lastRenderedFps, activeProject, backendKind]);

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
          const res = await fetch(backend.render.spectrogramUrl(basename, s.id, tweaks.spectrogramScale || "linear"));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          if (!cancelled && buf) setSpectrograms(m => m[s.id] === buf ? m : ({ ...m, [s.id]: buf }));
        } catch (e) { /* stem missing / numpy absent — leave clip without spectrogram */ }
      }
    })();
    return () => { cancelled = true; };
  }, [streamMediaKey, lastRenderedFps, activeProject, backendKind, tweaks.showSpectrograms, tweaks.spectrogramScale]);

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
  }, [streamMediaKey, lastRenderedFps, activeProject, backendKind, tweaks.showGrains, grainScoreOpen]);

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

  /* ============ Save / SaveAs ============ */
  async function onSave() {
    const backend = window.PGEBackend.current;
    const basename = activeProject.replace(/\.yml$/, "");
    const yaml = window.PGEYaml ? window.PGEYaml.serialize(data) :
      `# (yaml bridge not loaded — save skipped)\n# project: ${data.project}\n`;
    try {
      await backend.fs.writeFile("projects", basename + ".yml", yaml);
      setDirty(false);
      // Il file appena scritto porta `deviation_probability`: la migrazione da
      // `dephase` e' compiuta, e l'avviso in Inspector deve tacere. _setDataRaw
      // e non setData — spegnere un flag di provenienza dopo un salvataggio non
      // e' una modifica dell'autore: non sporca il progetto e non e' un passo
      // di undo, come l'arrivo tardivo dei media. Solo qui e non in onSaveAs:
      // quello scrive un altro file, l'originale porta ancora la chiave morta.
      _setDataRaw(d => window.PGEYaml ? window.PGEYaml.clearDeviationProbabilityLegacy(d) : d);
      pushToast({ kind: "ok", title: "Saved", message: `configs/${basename}.yml · ${(yaml.length / 1024).toFixed(1)}kb`, duration: 2200 });
      refreshProjects();
    } catch (e) {
      pushToast({ kind: "err", title: "Save failed", message: e.message, persistent: true });
    }
  }
  async function onSaveAs() {
    const name = prompt("Save a copy as…", activeProject.replace(/\.yml$/, "_copy.yml"));
    if (!name) return;
    const fullName = name.endsWith(".yml") ? name : name + ".yml";
    const backend = window.PGEBackend.current;
    const yaml = window.PGEYaml ? window.PGEYaml.serialize(data) :
      `# saved-as ${fullName}\n# from: ${activeProject}\n`;
    try {
      await backend.fs.writeFile("projects", fullName, yaml);
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
      await backend.fs.writeFile("projects", fullName, window.PGEYaml ? window.PGEYaml.serialize(empty) : "# empty\n");
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
    magnify: !!tweaks.renderMagnify,
    magnifyAt: tweaks.renderMagnifyAt || "",
    reaper: !!tweaks.renderReaper,
    preclean: !!tweaks.renderPreclean,
    outputDir: tweaks.outputPath || "output",
    projectBasename: activeProject.replace(/\.yml$/, ""),
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
    setTweak("renderUseCache",  next.useCache);
    setTweak("renderVisualize", next.visualize);
    setTweak("renderShowVoiceOffsets", next.showVoiceOffsets);
    setTweak("renderGrainJson", next.grainJson);
    setTweak("renderPageDuration", next.pageDuration);
    setTweak("renderPlotEnvelopes", Array.isArray(next.plotEnvelopes) ? next.plotEnvelopes : []);
    setTweak("renderMagnify",   next.magnify);
    setTweak("renderMagnifyAt", next.magnifyAt || "");
    setTweak("renderReaper",    next.reaper);
    setTweak("renderPreclean",  next.preclean);
  }

  async function onRender() {
    if (renderStatus.running) return;
    const backend = window.PGEBackend.current;
    const basename = activeProject.replace(/\.yml$/, "");

    setLogLines([]);
    setStreamProgress({});
    setRenderStatus({ running: true, total: data.streams.length, done: 0, currentStreamId: null, streamProgress: 0, lastOk: null, lastGenerated: 0 });
    if (!terminalOpen) {
      pushToast({ kind: "info", title: "Rendering started", message: `${data.streams.length} streams · ${renderOptions.useCache ? "incremental" : "full"}`, duration: 3000 });
    }

    let cacheHits = 0;
    let generated = 0;
    let curStreamId = null;

    const opts = {
      yamlBasename: basename,
      yamlContent: window.PGEYaml ? window.PGEYaml.serialize(data) : null,
      renderer: "numpy",
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
      // Lente della partitura (PGE #214 / issue #120). Lo SPEC dei target
      // espliciti parte solo se la grammatica regge: il motore lo rifiuterebbe
      // con exit 1, portandosi via anche l'audio gia' renderizzato.
      magnify: renderOptions.visualize && renderOptions.magnify ? true : undefined,
      magnifyAt: renderOptions.visualize && magnifySpecSendable(renderOptions.magnifyAt)
        ? renderOptions.magnifyAt.trim() : undefined,
      reaper: renderOptions.reaper,
      preclean: renderOptions.preclean,
      streams: data.streams,
      outputFormat: tweaks.outputFormat || "wav",
    };
    const result = await backend.render.run(opts, (e) => {
      if (e.type === "log") {
        setLogLines(ls => [...ls, { text: e.line, cls: classifyLogLine(e.line) }]);
      } else if (e.type === "stream-start") {
        curStreamId = e.streamId;
        setRenderStatus(s => ({ ...s, currentStreamId: e.streamId, streamProgress: 0 }));
      } else if (e.type === "stream-progress") {
        setStreamProgress(p => ({ ...p, [e.streamId]: e.progress }));
        setRenderStatus(s => ({ ...s, streamProgress: e.progress }));
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
        setStreamProgress(p => ({ ...p, [e.streamId]: 1 }));
        setRenderStatus(s => ({ ...s, done: s.done + 1, streamProgress: 0 }));
        // bump fp for this stream (so UI marks it fresh)
        setLastRenderedFps(fps => ({ ...fps, [e.streamId]: currentFps[e.streamId] }));
      }
    });

    setRenderStatus(s => ({
      ...s, running: false, currentStreamId: null, streamProgress: 0,
      lastOk: !!result.ok, lastGenerated: (result.generated || []).length,
    }));

    // Come dopo un Save, e per la stessa ragione: server.py scrive yamlContent
    // su configs/<basename>.yml PRIMA di lanciare il motore, quindi la
    // migrazione di `dephase` e' avvenuta anche se poi il render fallisce —
    // percio' qui, non dentro `result.ok`. Ma non quando il file non e' stato
    // scritto affatto (server down, o uno dei tre abort(400) che precedono la
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
        return;
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
                     serverDown={serverDown} />

      {previewSample && MediaPreview ? (
        <MediaPreview sample={previewSample}
                      baseUrl={tweaks.serverUrl || "http://localhost:7878"}
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

/* SPEC delle lenti esplicite (--magnify-at): si invia solo se c'è ed è valido.
 * Il motore rifiuta uno SPEC malformato con exit 1 — la partitura non si
 * degrada, muore l'intero render — quindi il filtro sta qui e in
 * RenderButton.buildCommand, che deve mostrare quello che parte davvero. La
 * grammatica vive in src/lib/magnify-spec.js (node-testata). */
function magnifySpecSendable(spec) {
  const text = (spec || "").trim();
  if (!text) return false;
  return !window.PGEMagnifySpec || window.PGEMagnifySpec.error(text) === null;
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
