/* @jsx React.createElement */
const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp, useMemo: useMemoApp, useCallback: useCallbackApp } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
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
}/*EDITMODE-END*/;

/* ---- Envelope rescale + truncate utilities (freeze-on-resize feature) ---- */
function rescaleEnvArray(arr, ratio) {
  // object-form {type, points} envelope
  if (arr && typeof arr === "object" && !Array.isArray(arr) && Array.isArray(arr.points)) {
    return { ...arr, points: arr.points.map(p => [Math.min(1, +(p[0] * ratio).toFixed(5)), p[1]]) };
  }
  if (!Array.isArray(arr)) return arr;
  return arr.map(item => {
    if (PGEEnv.isBreakpoint(item)) {
      const c = [...item]; c[0] = Math.min(1, +(c[0] * ratio).toFixed(5)); return c;
    }
    if (PGEEnv.isCompactBlock(item)) {
      const c = [...item]; c[1] = Math.min(1, +(c[1] * ratio).toFixed(5)); return c;
    }
    return item;
  });
}

function truncateEnvArray(arr) {
  // object-form {type, points}: clip points beyond x=1.0, add closing BP
  if (arr && typeof arr === "object" && !Array.isArray(arr) && Array.isArray(arr.points)) {
    return { ...arr, points: truncateEnvArray(arr.points) };
  }
  if (!Array.isArray(arr) || !arr.length) return arr;
  const result = [];
  let prevX = 0, prevY = null;

  for (const item of arr) {
    if (PGEEnv.isBreakpoint(item)) {
      const [x, y] = item;
      if (x <= 1.0) {
        result.push(item);
        prevX = x; prevY = y;
      } else {
        // first BP past boundary — interpolate closing BP at x=1.0
        if (prevY !== null && prevX < x) {
          const t = (1.0 - prevX) / (x - prevX);
          result.push([1.0, +(prevY + (y - prevY) * t).toFixed(4)]);
        } else {
          result.push([1.0, +y.toFixed(4)]);
        }
        break;
      }
    } else if (PGEEnv.isCompactBlock(item)) {
      if (prevX >= 1.0) break; // block starts beyond boundary — drop
      if (item[1] > 1.0) {
        // clamp end_time to 1.0; cycles compress, nReps unchanged
        const clamped = [...item]; clamped[1] = 1.0;
        result.push(clamped);
        break;
      }
      result.push(item);
      prevX = item[1];
      prevY = item[0][item[0].length - 1][1]; // last pattern point y
    } else {
      result.push(item);
    }
  }
  return result;
}

function envArrayWouldTruncate(arr, ratio) {
  if (arr && typeof arr === "object" && !Array.isArray(arr) && Array.isArray(arr.points)) {
    return arr.points.some(p => p[0] * ratio > 1.0);
  }
  if (!Array.isArray(arr)) return false;
  return arr.some(item => {
    if (PGEEnv.isBreakpoint(item)) return item[0] * ratio > 1.0;
    if (PGEEnv.isCompactBlock(item)) return item[1] * ratio > 1.0;
    return false;
  });
}

function _applyEnvFields(stream, fn) {
  const wf = (obj, key) => obj[key] != null ? { [key]: fn(obj[key]) } : {};
  return {
    ...stream,
    ...wf(stream, "densityEnv"),
    ...wf(stream, "fillFactorEnv"),
    ...wf(stream, "distributionEnv"),
    ...wf(stream, "panEnv"),
    ...wf(stream, "volumeEnv"),
    grain:   stream.grain   ? { ...stream.grain,   ...wf(stream.grain,   "durationEnv")   } : stream.grain,
    pointer: stream.pointer ? { ...stream.pointer, ...wf(stream.pointer, "speedRatioEnv"), ...wf(stream.pointer, "loopStartEnv"), ...wf(stream.pointer, "loopDurEnv"), ...wf(stream.pointer, "loopEndEnv") } : stream.pointer,
    pitch:   stream.pitch   ? { ...stream.pitch,   ...wf(stream.pitch,   "valueEnv")      } : stream.pitch,
    voices:  stream.voices  ? {
      ...stream.voices,
      ...wf(stream.voices, "numEnv"),
      ...wf(stream.voices, "scatterEnv"),
      pitch:        stream.voices.pitch        ? { ...stream.voices.pitch,        ...wf(stream.voices.pitch,        "stepEnv"), ...wf(stream.voices.pitch,        "pitch_rangeEnv")    } : stream.voices.pitch,
      onset_offset: stream.voices.onset_offset ? { ...stream.voices.onset_offset, ...wf(stream.voices.onset_offset, "stepEnv"), ...wf(stream.voices.onset_offset, "baseEnv"), ...wf(stream.voices.onset_offset, "max_offsetEnv") } : stream.voices.onset_offset,
      pointer:      stream.voices.pointer      ? { ...stream.voices.pointer,      ...wf(stream.voices.pointer,      "stepEnv"), ...wf(stream.voices.pointer,      "pointer_rangeEnv") } : stream.voices.pointer,
      pan:          stream.voices.pan          ? { ...stream.voices.pan,          ...wf(stream.voices.pan,          "spreadEnv") } : stream.voices.pan,
    } : stream.voices,
  };
}

function rescaleStreamEnvelopes(stream, oldDur, newDur) {
  const ratio = oldDur / newDur;
  return _applyEnvFields(stream, arr => rescaleEnvArray(arr, ratio));
}

function truncateStreamEnvelopes(stream) {
  return _applyEnvFields(stream, truncateEnvArray);
}

function streamWouldTruncate(stream, ratio) {
  const fields = [
    stream.densityEnv, stream.fillFactorEnv, stream.distributionEnv, stream.panEnv, stream.volumeEnv,
    stream.grain    && stream.grain.durationEnv,
    stream.pointer  && stream.pointer.speedRatioEnv,
    stream.pointer  && stream.pointer.loopStartEnv,
    stream.pointer  && stream.pointer.loopDurEnv,
    stream.pointer  && stream.pointer.loopEndEnv,
    stream.pitch    && stream.pitch.valueEnv,
    stream.voices   && stream.voices.numEnv,
    stream.voices   && stream.voices.scatterEnv,
    stream.voices && stream.voices.pitch        && stream.voices.pitch.stepEnv,
    stream.voices && stream.voices.pitch        && stream.voices.pitch.pitch_rangeEnv,
    stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.stepEnv,
    stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.baseEnv,
    stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.max_offsetEnv,
    stream.voices && stream.voices.pointer      && stream.voices.pointer.stepEnv,
    stream.voices && stream.voices.pointer      && stream.voices.pointer.pointer_rangeEnv,
    stream.voices && stream.voices.pan          && stream.voices.pan.spreadEnv,
  ];
  return fields.some(f => f && envArrayWouldTruncate(f, ratio));
}

// Blank in-memory project used as the editor's initial state before the real
// project is loaded from the server (server.py lists configs/*.yml on boot).
const EMPTY_PROJECT = { project: "", title: "", duration: 10, bpm: 120, streams: [], samples: [] };

function App() {
  const t = window.useTweaks ? window.useTweaks(TWEAK_DEFAULTS) : [TWEAK_DEFAULTS, () => {}];
  const tweaks = Array.isArray(t) ? t[0] : t.tweaks;
  const setTweak = Array.isArray(t) ? t[1] : t.setTweak;

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
  const historyRef = useRefApp({ past: [], future: [], snapshotBeforeGesture: null, inGesture: false });
  const [, setHistVer] = useStateApp(0);
  const freezeOriginRef = useRefApp(null);   // {id, stream} captured at gesture start when freeze ON
  const pendingTruncateRef = useRefApp(null); // {id} set during gesture if shrink would truncate

  function setData(updater) {
    _setDataRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next === prev) return prev;
      const h = historyRef.current;
      if (h.inGesture) {
        if (h.snapshotBeforeGesture == null) h.snapshotBeforeGesture = prev;
      } else {
        h.past.push(prev);
        if (h.past.length > 200) h.past.shift();
        h.future = [];
        setHistVer(v => v + 1);
      }
      return next;
    });
  }
  function beginGesture() {
    historyRef.current.inGesture = true;
    historyRef.current.snapshotBeforeGesture = null;
  }
  function endGesture() {
    const h = historyRef.current;
    if (h.snapshotBeforeGesture != null) {
      h.past.push(h.snapshotBeforeGesture);
      if (h.past.length > 200) h.past.shift();
      h.future = [];
      setHistVer(v => v + 1);
    }
    h.inGesture = false;
    h.snapshotBeforeGesture = null;
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
      const h = historyRef.current;
      if (!h.past.length) return cur;
      const prev = h.past.pop();
      h.future.push(cur);
      setHistVer(v => v + 1);
      return prev;
    });
  }
  function redo() {
    _setDataRaw(cur => {
      const h = historyRef.current;
      if (!h.future.length) return cur;
      const nxt = h.future.pop();
      h.past.push(cur);
      setHistVer(v => v + 1);
      return nxt;
    });
  }
  function resetHistory() {
    historyRef.current.past = [];
    historyRef.current.future = [];
    historyRef.current.snapshotBeforeGesture = null;
    historyRef.current.inGesture = false;
    setHistVer(v => v + 1);
  }
  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  useEffectApp(() => {
    window.PGEHistory = { beginGesture, endGesture, undo, redo,
                          get canUndo() { return historyRef.current.past.length > 0; },
                          get canRedo() { return historyRef.current.future.length > 0; } };
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
  const clipboardRef = React.useRef([]);
  const [mediaList, setMediaList] = useStateApp({ loading: false, path: null, files: [], error: null });
  const [projectsList, setProjectsList] = useStateApp({ loading: false, path: null, files: [], error: null });

  /* ============ Render state ============ */
  // lastRenderedFingerprints[streamId] = "abc123…" — what was on disk at last render
  const [lastRenderedFps, setLastRenderedFps] = useStateApp({});
  const [waveforms, setWaveforms] = useStateApp({});  // {streamId: Float32Array of peaks}
  const [spectrograms, setSpectrograms] = useStateApp({});  // {streamId: ArrayBuffer of STFT grid}
  const [grainData, setGrainData] = useStateApp({});  // {streamId: grain JSON sidecar {duration, grains:[…]}}
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
    backend.render.loadCache(basename).then(cache => {
      setLastRenderedFps(cache || {});
    });
  }, [activeProject]);

  /* Current fingerprint per stream — recomputed when data changes */
  const currentFps = useMemoApp(() => {
    const out = {};
    const fmt = tweaks.outputFormat || "wav";
    for (const s of data.streams) out[s.id] = window.PGEBackend.fingerprintStream(s, fmt);
    return out;
  }, [data.streams, tweaks.outputFormat]);

  /* Composition length is derived from the streams (furthest edge + silent tail),
     not the stored data.duration which goes stale after edits. Single source of
     truth lives in yaml-bridge.computeDuration. */
  const compDuration = useMemoApp(
    () => window.PGEYaml ? window.PGEYaml.computeDuration(data.streams) : data.duration,
    [data.streams]);

  /* Aggregate render summary: counts of fresh / stale / never */
  const renderSummary = useMemoApp(() => {
    const basename = activeProject.replace(/\.yml$/, "");
    const backend = window.PGEBackend.current;
    let fresh = 0, stale = 0, never = 0;
    for (const s of data.streams) {
      const cur = currentFps[s.id];
      const last = lastRenderedFps[s.id];
      const hasStem = backend.render.hasStem ? backend.render.hasStem(basename, s.id) : !!last;
      if (!last || !hasStem) never++;
      else if (last === cur) fresh++;
      else stale++;
    }
    return { fresh, stale, never, total: data.streams.length };
  }, [data.streams, currentFps, lastRenderedFps, activeProject]);

  function renderStatusForStream(streamId) {
    const cur = currentFps[streamId];
    const last = lastRenderedFps[streamId];
    const basename = activeProject.replace(/\.yml$/, "");
    const backend = window.PGEBackend.current;
    const hasStem = backend.render.hasStem ? backend.render.hasStem(basename, streamId) : !!last;
    if (renderStatus.running && renderStatus.currentStreamId === streamId) {
      return { state: "running", progress: streamProgress[streamId] || 0, tooltip: "rendering this stream…" };
    }
    if (!last || !hasStem) return { state: "never", tooltip: "this stream has never been rendered" };
    if (last === cur) return { state: "fresh", tooltip: "rendered and up-to-date with the YAML" };
    return { state: "stale", tooltip: "YAML changed since last render — re-render to update" };
  }

  /* ============ Playback (Web Audio driven) ============ */
  // Drive the timeline from the AudioEngine's clock when playing.
  useEffectApp(() => {
    function onTick(e) { setTime(e.detail); }
    window.addEventListener("pge-audio-tick", onTick);
    return () => window.removeEventListener("pge-audio-tick", onTick);
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
        const hasStem = backend.render.hasStem ? backend.render.hasStem(basename, s.id) : !!last;
        if (!hasStem) {
          setWaveforms(w => { if (!(s.id in w)) return w; const m = { ...w }; delete m[s.id]; return m; });
          continue;
        }
        const url = backend.render.stemUrl ? backend.render.stemUrl(basename, s.id, tweaks.outputFormat || "wav") : null;
        const peaksUrl = backend.render.peaksUrl ? backend.render.peaksUrl(basename, s.id) : null;
        try {
          const peaks = await engine.ensurePeaks(s.id, { duration: s.duration, fingerprint: last || currentFps[s.id], url, peaksUrl });
          if (!cancelled && peaks) setWaveforms(w => ({ ...w, [s.id]: peaks }));
        } catch (e) { /* stem missing or undecodable — leave clip flat */ }
      }
    })();
    return () => { cancelled = true; };
  }, [data.streams, lastRenderedFps, activeProject, backendKind]);

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
        const last = lastRenderedFps[s.id];
        const hasStem = backend.render.hasStem ? backend.render.hasStem(basename, s.id) : !!last;
        if (!hasStem) {
          setSpectrograms(m => { if (!(s.id in m)) return m; const n = { ...m }; delete n[s.id]; return n; });
          continue;
        }
        try {
          const res = await fetch(backend.render.spectrogramUrl(basename, s.id, tweaks.spectrogramScale || "linear"));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          if (!cancelled && buf) setSpectrograms(m => ({ ...m, [s.id]: buf }));
        } catch (e) { /* stem missing / numpy absent — leave clip without spectrogram */ }
      }
    })();
    return () => { cancelled = true; };
  }, [data.streams, lastRenderedFps, activeProject, backendKind, tweaks.showSpectrograms, tweaks.spectrogramScale]);

  // Grain JSON sidecars (engine --grain-json) → per-stream data for the grain
  // canvas inside clips and the score panel. Same lazy trigger as peaks/spectro:
  // refetches on fingerprint change (each stream-done). Gated by either the
  // in-clip toggle or the score panel being open.
  useEffectApp(() => {
    if (!tweaks.showGrains && !grainScoreOpen) return;
    const backend = window.PGEBackend.current;
    if (!backend.render.loadGrainData) return;
    const basename = activeProject.replace(/\.yml$/, "");
    let cancelled = false;
    (async () => {
      for (const s of data.streams) {
        if (cancelled) return;
        const last = lastRenderedFps[s.id];
        const hasStem = backend.render.hasStem ? backend.render.hasStem(basename, s.id) : !!last;
        if (!hasStem) {
          setGrainData(m => { if (!(s.id in m)) return m; const n = { ...m }; delete n[s.id]; return n; });
          continue;
        }
        try {
          const j = await backend.render.loadGrainData(basename, s.id);
          if (!cancelled && j) setGrainData(m => ({ ...m, [s.id]: j }));
        } catch (e) { /* sidecar missing / not yet rendered — leave clip without grains */ }
      }
    })();
    return () => { cancelled = true; };
  }, [data.streams, lastRenderedFps, activeProject, backendKind, tweaks.showGrains, grainScoreOpen]);

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
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && selectedIds.length > 0) {
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
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !e.defaultPrevented) {
        // Envelope editor is visible and showing this stream — let it handle Delete (BP deletion)
        if (tweaks.showEnvelopeEditor !== false && selected()) return;
        e.preventDefault();
        deleteStream(selectedId);
      }
    }
    function onKeyUp(e) {
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && arrowGestureRef.current) {
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
    clipboardRef.current = JSON.parse(JSON.stringify(toCopy));
  }
  function pasteStreams() {
    const copied = clipboardRef.current;
    if (!copied.length) return;
    const minOnset = Math.min(...copied.map(s => s.onset));
    const shift = Math.max(0, time) - minOnset;
    const newIds = [];
    setData(d => {
      const usedIds = new Set(d.streams.map(s => s.id));
      let counter = d.streams.length + 1;
      function freshId() {
        while (usedIds.has("stream" + counter)) counter++;
        const id = "stream" + counter++;
        usedIds.add(id);
        return id;
      }
      const pasted = copied.map(s => {
        const id = freshId();
        newIds.push(id);
        return { ...JSON.parse(JSON.stringify(s)), id, onset: Math.max(0, +(s.onset + shift).toFixed(2)) };
      });
      return { ...d, streams: [...d.streams, ...pasted] };
    });
    setSelectedIds(newIds);
    setDirty(true);
  }
  function updateStream(id, patch) {
    if (freezeEnvOnResize && patch.duration != null) {
      const cur = data.streams.find(s => s.id === id);
      if (cur && patch.duration !== cur.duration) {
        const inGesture = historyRef.current.inGesture;

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
              return { ...rescaleStreamEnvelopes(origin, origin.duration, patch.duration), ...patch };
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
              return { ...(ratio > 1 ? truncateStreamEnvelopes(rescaled) : rescaled), ...patch };
            }),
          }));
        }
        setDirty(true);
        return;
      }
    }
    setData(d => ({ ...d, streams: d.streams.map(s => s.id === id ? { ...s, ...patch } : s) }));
    setDirty(true);
  }
  function reorderStreams(srcIdx, dstIdx) {
    if (srcIdx === dstIdx) return;
    setData(d => {
      const arr = [...d.streams];
      const [m] = arr.splice(srcIdx, 1);
      arr.splice(dstIdx, 0, m);
      return { ...d, streams: arr };
    });
    setDirty(true);
  }
  function deleteStream(id) {
    if (!id) return;
    setData(d => ({ ...d, streams: d.streams.filter(s => s.id !== id) }));
    // collateral cleanup
    setLastRenderedFps(fps => { const n = { ...fps }; delete n[id]; return n; });
    setStreamProgress(p => { const n = { ...p }; delete n[id]; return n; });
    setWaveforms(w => { const n = { ...w }; delete n[id]; return n; });
    setGrainData(g => { const n = { ...g }; delete n[id]; return n; });
    if (window.PGEAudio?.engine?.invalidateStream) window.PGEAudio.engine.invalidateStream(id);
    if (selectedIds.includes(id) && selectedIds.length === 1) setInspectorOpen(false);
    setSelectedIds(ids => ids.filter(x => x !== id));
    setDirty(true);
  }
  function createStreamFromSample({ sample, onset = 0, laneIdx }) {
    const media = mediaList.files || [];
    const sampleName = sample || (media[0] && media[0].name) || "";
    const sampleRec = media.find(s => s.name === sampleName) || { duration: 4 };
    const palette = ["#5C8868","#B89241","#3F8884","#5965A8","#8E5F8E","#C97A6E","#7A8DB0"];
    setData(d => {
      const n = d.streams.length + 1;
      const newStream = {
        id: "stream" + n, onset: Math.max(0, +onset.toFixed(2)),
        duration: Math.min(d.duration - onset, Math.max(2, sampleRec.duration)),
        sample: sampleName, color: palette[(d.streams.length) % palette.length],
        mute: false, solo: false,
        timeMode: "normalized", distributionMode: "uniform",
        density: 8, distribution: 0,
        volume: 0, volumeRange: 0,
        pan: 0, panRange: 0,
        grain: { duration: 0.05, durationRange: 0, envelope: "hanning" },
        pointer: { start: 0, speedRatio: 1, loopStart: null, loopDur: null },
        pitch: { semitones: 0, range: null },
        voices: { num: 1 },
      };
      const arr = [...d.streams];
      if (laneIdx != null && laneIdx <= arr.length) arr.splice(laneIdx, 0, newStream);
      else arr.push(newStream);
      return { ...d, streams: arr };
    });
    setDirty(true);
  }
  function selectClip(id, multi) {
    if (multi) {
      setSelectedIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
    } else {
      anchorIdRef.current = id;
      setSelectedIds([id]);
    }
  }
  function rangeSelectClip(id) {
    const anchor = anchorIdRef.current;
    const ss = data.streams;
    const anchorIdx = anchor ? ss.findIndex(s => s.id === anchor) : -1;
    const targetIdx = ss.findIndex(s => s.id === id);
    if (anchorIdx === -1 || targetIdx === -1) { setSelectedIds([id]); return; }
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    setSelectedIds(ss.slice(lo, hi + 1).map(s => s.id));
  }
  function marqueeSelectClips(ids, additive) {
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
    pageDuration: tweaks.renderPageDuration ?? 15,
    reaper: !!tweaks.renderReaper,
    preclean: !!tweaks.renderPreclean,
    outputDir: tweaks.outputPath || "output",
    projectBasename: activeProject.replace(/\.yml$/, ""),
  };
  function setRenderOptions(next) {
    if (next._chooseOutput) {
      const p = prompt("Output folder path:", tweaks.outputPath || "output");
      if (p) setTweak("outputPath", p);
      return;
    }
    setTweak("renderUseCache",  next.useCache);
    setTweak("renderVisualize", next.visualize);
    setTweak("renderPageDuration", next.pageDuration);
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
      pageDuration: renderOptions.visualize ? renderOptions.pageDuration : undefined,
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
        else generated++;
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
      const hasStem = backend.render.hasStem ? backend.render.hasStem(basename, s.id) : !!last;
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
          samples: mediaList.files || [],
        });
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

  const { TopBar, SampleBrowser, Timeline, Inspector, SplitPane, EnvelopeEditor, Terminal, Toast, SettingsPanel, MediaPreview, Stereoscope, VUMeter, GrainScore } = window.PGE;
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
    <Timeline streams={data.streams} selected={selectedIds}
              onSelect={selectClip} onDeselect={() => setSelectedIds([])} onRangeSelect={rangeSelectClip} onMarqueeSelect={marqueeSelectClips} onDoubleSelect={openInspector} onUpdate={updateStream} onReorder={reorderStreams}
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
              analyserFor={(id) => window.PGEAudio?.engine?.trackAnalyser(id)} />
  );
  const envelopeEl = (
    <EnvelopeEditor stream={selected()} pxPerSec={tweaks.zoom} duration={compDuration}
                    playhead={time}
                    onChange={(p) => selectedId && updateStream(selectedId, p)}
                    onLoopPanelChange={setLoopPanelOpen}
                    focusKey={envFocusKey} />
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
    <Inspector stream={selected() || null}
               onChange={(p) => selectedId && updateStream(selectedId, p)}
               onClose={closeInspector}
               tab={inspectorTab} onTab={setInspectorTab}
               samples={mediaList.files}
               freezeEnvOnResize={freezeEnvOnResize}
               onFreezeEnvToggle={setFreezeEnvOnResize}
               onFocusEnvParam={(key) => {
                 if (tweaks.showEnvelopeEditor === false) setTweak("showEnvelopeEditor", true);
                 setEnvFocusKey(key + ":" + Date.now());
               }} />
  ) : null;

  return (
    <div className={"pge-app" + (tweaks.showFooter ? "" : " no-footer") + (terminalOpen ? " with-terminal" : "") + (grainScoreOpen ? " with-grainscore" : "")}>
      <TopBar project={data.project} title={data.title} dirty={dirty}
              playing={playing} onPlay={doPlay}
              onStop={doStop}
              loopEnabled={loopEnabled} onToggleLoop={() => setLoopEnabled(v => !v)}
              onSeekZero={doSeekZero}
              onRender={onRender} onCancelRender={onCancelRender}
              renderStatus={renderStatus}
              renderOptions={renderOptions} onRenderOptionsChange={setRenderOptions}
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
          <span className="mono">sr 48000 · stereo</span>
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
      {window.TweaksPanel ? (
        <window.TweaksPanel title="Preferences">
          <window.TweakSection label="Appearance">
            <window.TweakColor label="accent" value={tweaks.accent}
              options={["#FF8C42","#6E9CFF","#3DB87A","#E5484D","#B89241"]}
              onChange={(v) => setTweak("accent", v)} />
            <window.TweakRadio label="density" value={tweaks.density}
              options={[{label:"compact",value:"compact"},{label:"comfy",value:"comfortable"}]}
              onChange={(v) => setTweak("density", v)} />
            <window.TweakToggle label="status footer" value={tweaks.showFooter}
              onChange={(v) => setTweak("showFooter", v)} />
          </window.TweakSection>
          <window.TweakSection label="Backend">
            <div className="twk-hint">local server (server.py) on {tweaks.serverUrl || "http://localhost:7878"}</div>
            <window.TweakSelect label="output format" value={tweaks.outputFormat || "wav"}
              options={[
                {label:"AIFF", value:"aiff"},
                {label:"WAV (default)", value:"wav"},
                {label:"FLAC", value:"flac"}]}
              onChange={(v) => setTweak("outputFormat", v)} />
            <window.TweakText label="media path" value={tweaks.mediaPath} onChange={(v) => setTweak("mediaPath", v)} />
            <window.TweakText label="projects path" value={tweaks.projectsPath} onChange={(v) => setTweak("projectsPath", v)} />
            <window.TweakText label="output path" value={tweaks.outputPath} onChange={(v) => setTweak("outputPath", v)} />
          </window.TweakSection>
          <window.TweakSection label="Timeline">
            <window.TweakSlider label="zoom" value={tweaks.zoom} min={0.5} max={200} step={0.5} unit=" px/s"
              onChange={(v) => setTweak("zoom", v)} />
            <window.TweakSlider label="lane height" value={tweaks.laneHeight} min={36} max={120} step={4} unit="px"
              onChange={(v) => setTweak("laneHeight", v)} />
            <window.TweakToggle label="waveforms in clips" value={tweaks.showWaveforms}
              onChange={(v) => setTweak("showWaveforms", v)} />
            <window.TweakToggle label="spettrogramma nei clip" value={!!tweaks.showSpectrograms}
              onChange={(v) => setTweak("showSpectrograms", v)} />
            <window.TweakToggle label="grani nei clip" value={!!tweaks.showGrains}
              onChange={(v) => setTweak("showGrains", v)} />
            <window.TweakToggle label="envelope overlay" value={tweaks.showEnvOverlay}
              onChange={(v) => setTweak("showEnvOverlay", v)} />
            <window.TweakToggle label="envelope editor pane" value={tweaks.showEnvelopeEditor !== false}
              onChange={(v) => setTweak("showEnvelopeEditor", v)} />
          </window.TweakSection>
          <window.TweakSection label="Gestures">
            <window.TweakSelect label="zoom" value={tweaks.gestureZoom}
              options={[
                {label:"wheel", value:"wheel"},
                {label:"⌘ + wheel", value:"cmd+wheel"},
                {label:"⌥ + wheel", value:"alt+wheel"},
                {label:"ctrl + wheel", value:"ctrl+wheel"}]}
              onChange={(v) => setTweak("gestureZoom", v)} />
            <window.TweakSelect label="lane height" value={tweaks.gestureLaneHeight}
              options={[
                {label:"⇧ + wheel", value:"shift+wheel"},
                {label:"⇧⌘ + wheel", value:"shift+cmd+wheel"},
                {label:"⇧⌥ + wheel", value:"shift+alt+wheel"}]}
              onChange={(v) => setTweak("gestureLaneHeight", v)} />
            <window.TweakSelect label="h-scroll" value={tweaks.gestureHScroll}
              options={[
                {label:"⌥ + wheel", value:"alt+wheel"},
                {label:"⌘ + wheel", value:"cmd+wheel"},
                {label:"shift + wheel", value:"shift+wheel"}]}
              onChange={(v) => setTweak("gestureHScroll", v)} />
            <div className="twk-hint">vertical track scroll: hover the track header column · drag clip = move · drag right edge = resize</div>
          </window.TweakSection>
          <window.TweakSection label="Panels">
            <window.TweakSlider label="browser width" value={tweaks.browserWidth} min={180} max={360} step={10} unit="px"
              onChange={(v) => setTweak("browserWidth", v)} />
            <window.TweakSlider label="inspector width" value={tweaks.inspectorWidth} min={260} max={520} step={10} unit="px"
              onChange={(v) => setTweak("inspectorWidth", v)} />
            <window.TweakToggle label="waveform thumbnails" value={tweaks.showWaveformBrowser}
              onChange={(v) => setTweak("showWaveformBrowser", v)} />
          </window.TweakSection>
        </window.TweaksPanel>
      ) : null}
    </div>
  );
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
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(" ");
}
window.prettyShortcut = prettyShortcut;

ReactDOM.createRoot(document.getElementById("app")).render(<App />);
