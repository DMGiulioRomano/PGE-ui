/* @jsx React.createElement */
const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp, useMemo: useMemoApp, useCallback: useCallbackApp } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#FF8C42",
  "zoom": 36,
  "laneHeight": 56,
  "showWaveforms": true,
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
  "backendKind": "mock",
  "mediaPath": "",
  "projectsPath": "",
  "outputPath": "output",
  "renderUseCache": true,
  "renderVisualize": false,
  "renderReaper": false,
  "renderPreclean": false,
  "terminalOpen": false,
  "terminalHeight": 220,
  "shortcutInspector": "cmd+i",
  "stepMenuTrigger": "rightClick"
}/*EDITMODE-END*/;

const PROJECTS_DB = {
  "PGE_test.yml": { project: "PGE_test", title: "il mondo dorme", duration: 60 },
  "PGE_brano_8min.yml": { project: "PGE_brano_8min", title: "brano 8min", duration: 480 },
  "PGE_pino2.yml": { project: "PGE_pino2", title: "pino · sketch 2", duration: 30 },
};
window.PROJECTS_DB = PROJECTS_DB;

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
    document.body.dataset.density = tweaks.density;
  }, [tweaks.accent, tweaks.laneHeight, tweaks.browserWidth, tweaks.inspectorWidth, tweaks.density, tweaks.terminalHeight]);

  /* ============ History-aware data state ============ */
  const [data, _setDataRaw] = useStateApp(window.PGE_DATA);
  const historyRef = useRefApp({ past: [], future: [], snapshotBeforeGesture: null, inGesture: false });
  const [, setHistVer] = useStateApp(0);

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
      else if (k === "r") { e.preventDefault(); onRender(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const [selectedId, setSelectedId] = useStateApp(null);
  const [inspectorOpen, setInspectorOpen] = useStateApp(false);
  const [browserOpen, setBrowserOpen] = useStateApp(true);
  const [inspectorTab, setInspectorTab] = useStateApp("preview");
  const [playing, setPlaying] = useStateApp(false);
  const [time, setTime] = useStateApp(0);
  const [dirty, setDirty] = useStateApp(true);
  const [activeProject, setActiveProject] = useStateApp(tweaks.activeProject || "PGE_test.yml");
  const [activeSample, setActiveSample] = useStateApp(null);
  const tickRef = useRefApp();
  const [mediaList, setMediaList] = useStateApp({ loading: false, path: null, files: data.samples || [], error: null });
  const [projectsList, setProjectsList] = useStateApp({ loading: false, path: null, files: Object.keys(PROJECTS_DB).map(p => ({ name: p })), error: null });

  /* ============ Render state ============ */
  // lastRenderedFingerprints[streamId] = "abc123…" — what was on disk at last render
  const [lastRenderedFps, setLastRenderedFps] = useStateApp({});
  const [terminalOpen, setTerminalOpen] = useStateApp(!!tweaks.terminalOpen);
  const [logLines, setLogLines] = useStateApp([]);
  const [renderStatus, setRenderStatus] = useStateApp({
    running: false, total: 0, done: 0, currentStreamId: null, streamProgress: 0,
    lastOk: null, lastGenerated: 0,
  });
  const [streamProgress, setStreamProgress] = useStateApp({});  // {streamId: progress 0..1}
  const [toasts, setToasts] = useStateApp([]);
  const toastIdRef = useRefApp(0);
  const [settingsOpen, setSettingsOpen] = useStateApp(false);
  const [backendKind, setBackendKind] = useStateApp(tweaks.backendKind || "mock");

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

  useEffectApp(() => {
    if ((tweaks.backendKind || "mock") === "local") {
      _syncPathsFromServer(tweaks.serverUrl || "http://localhost:7878", tweaks);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchBackend(kind) {
    setBackendKind(kind);
    setTweak("backendKind", kind);
    const baseUrl = tweaks.serverUrl || "http://localhost:7878";
    window.PGEBackend.current = window.PGEBackend.create(kind, { baseUrl });
    pushToast({ kind: "info", title: `backend → ${kind}`, message: kind === "local" ? "needs server.py running" : "in-browser simulation", duration: 2400 });
    if (kind === "local") _syncPathsFromServer(baseUrl, tweaks);
    refreshMedia(); refreshProjects();
    // audio: invalidate cached buffers since urls change
    if (window.PGEAudio) window.PGEAudio.engine.invalidateAll();
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
  // Initial load + reload when backend changes
  useEffectApp(() => {
    refreshMedia(); refreshProjects();
  }, [backendKind]);

  // Seed: in mock mode, populate localStorage with the bundled PGE_DATA as
  // a real YAML file so onProjectSelect → readFile actually returns content
  // instead of an empty string.
  useEffectApp(() => {
    if (backendKind !== "mock" || !window.PGEYaml) return;
    (async () => {
      const backend = window.PGEBackend.current;
      const exists = await backend.fs.fileExists("projects", "PGE_test.yml");
      if (!exists) {
        const yaml = window.PGEYaml.serialize(window.PGE_DATA);
        await backend.fs.writeFile("projects", "PGE_test.yml", yaml);
      }
    })();
  }, [backendKind]);

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
    for (const s of data.streams) out[s.id] = window.PGEBackend.fingerprintStream(s);
    return out;
  }, [data.streams]);

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

  // Auto-stop when audio reaches duration
  useEffectApp(() => {
    if (playing && time >= data.duration) {
      const engine = window.PGEAudio?.engine;
      if (engine) engine.stop();
      setPlaying(false);
      setTime(0);
    }
  }, [time, playing, data.duration]);

  // Keep engine's mute/solo in sync with stream data
  useEffectApp(() => {
    const engine = window.PGEAudio?.engine;
    if (!engine) return;
    engine.syncMuteSoloFromStreams(data.streams);
  }, [data.streams.map(s => `${s.id}:${s.mute ? 1 : 0}:${s.solo ? 1 : 0}`).join("|")]);

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

  useEffectApp(() => {
    function onSeek(e) {
      const t = Math.max(0, e.detail);
      setTime(t);
      const engine = window.PGEAudio?.engine;
      if (engine) engine.seek(t);
    }
    window.addEventListener("pge-seek", onSeek);
    return () => window.removeEventListener("pge-seek", onSeek);
  }, [data.duration]);

  useEffectApp(() => {
    function onKey(e) {
      const tg = e.target;
      if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
      if (matchShortcut(e, tweaks.shortcutInspector || "cmd+i")) {
        e.preventDefault();
        toggleInspector();
        return;
      }
      if (e.key === " ") { e.preventDefault(); doPlay(); }
      else if (e.key === "Escape") { setInspectorOpen(false); }
      else if ((e.metaKey || e.ctrlKey) && e.key === ".") { e.preventDefault(); setBrowserOpen(o => !o); }
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteStream(selectedId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ============ Stream mutations ============ */
  function updateStream(id, patch) {
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
    if (window.PGEAudio?.engine?.invalidateStream) window.PGEAudio.engine.invalidateStream(id);
    if (selectedId === id) { setSelectedId(null); setInspectorOpen(false); }
    setDirty(true);
  }
  function createStreamFromSample({ sample, onset = 0, laneIdx }) {
    const sampleRec = (window.PGE_DATA.samples.find(s => s.name === sample) || { duration: 4 });
    const palette = ["#5C8868","#B89241","#3F8884","#5965A8","#8E5F8E","#C97A6E","#7A8DB0"];
    setData(d => {
      const n = d.streams.length + 1;
      const newStream = {
        id: "stream" + n, onset: Math.max(0, +onset.toFixed(2)),
        duration: Math.min(d.duration - onset, Math.max(2, sampleRec.duration)),
        sample, color: palette[(d.streams.length) % palette.length],
        mute: false, solo: false,
        timeMode: "absolute", distributionMode: "uniform",
        density: 8, distribution: 0,
        volume: -6, volumeRange: 0,
        pan: 0, panRange: 0,
        grain: { duration: 0.05, durationRange: 0, envelope: "hanning" },
        pointer: { start: 0, speedRatio: 1, loopStart: null, loopDur: null },
        pitch: { semitones: 0, range: 0 },
        voices: { num: 1 },
      };
      const arr = [...d.streams];
      if (laneIdx != null && laneIdx <= arr.length) arr.splice(laneIdx, 0, newStream);
      else arr.push(newStream);
      return { ...d, streams: arr };
    });
    setDirty(true);
  }
  function selectClip(id) {
    // Re-clicking the already-selected stream while the inspector is open closes it.
    // Clicking a different stream switches selection and (re)opens the inspector.
    if (id === selectedId && inspectorOpen) {
      setInspectorOpen(false);
      return;
    }
    setSelectedId(id);
    setInspectorOpen(true);
  }
  function closeInspector() { setInspectorOpen(false); }
  function toggleInspector() {
    // Shortcut entrypoint: opens the inspector even without a selected stream
    // (shows an empty "choose a stream" state). If already open, closes it.
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
                                 : { project: basename, title: "", duration: 60, streams: [], samples: [] };
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
    setTweak("renderReaper",    next.reaper);
    setTweak("renderPreclean",  next.preclean);
  }

  async function onRender() {
    if (renderStatus.running) return;
    const backend = window.PGEBackend.current;
    const basename = activeProject.replace(/\.yml$/, "");
    // Auto-save before render so the YAML on disk matches what we're rendering.
    if (dirty) await onSave();

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
      renderer: "numpy",
      useCache: renderOptions.useCache,
      visualize: renderOptions.visualize,
      reaper: renderOptions.reaper,
      preclean: renderOptions.preclean,
      streams: data.streams,
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
        persistent: true,
        action: { label: "open log", onClick: () => setTerminalOpen(true) },
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

    // Preload buffers for streams that have a stem (fresh or stale). Streams
    // never rendered will be silent during playback.
    const preloads = data.streams.map(async (s) => {
      const last = lastRenderedFps[s.id];
      const hasStem = backend.render.hasStem ? backend.render.hasStem(basename, s.id) : !!last;
      if (!hasStem) return;
      const url = backend.render.stemUrl ? backend.render.stemUrl(basename, s.id) : null;
      try {
        await engine.ensureBuffer(s.id, {
          duration: s.duration,
          color: s.color,
          fingerprint: last || currentFps[s.id],
          url,
        });
      } catch (e) {
        pushToast({ kind: "warn", title: `couldn't load ${s.id}`, message: e.message, duration: 3000 });
      }
    });
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
    // Fallback: synthesize a minimal data object from PROJECTS_DB.
    const meta = PROJECTS_DB[name] || { project: name.replace(/\.yml$/, ""), title: "", duration: 60 };
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

  const { TopBar, SampleBrowser, Timeline, Inspector, SplitPane, EnvelopeEditor, Terminal, Toast, SettingsPanel } = window.PGE;
  const gestures = { zoom: tweaks.gestureZoom, laneHeight: tweaks.gestureLaneHeight, hScroll: tweaks.gestureHScroll };

  const browser = (
    <SampleBrowser mediaList={mediaList} projectsList={projectsList}
                   onRefreshMedia={refreshMedia} onRefreshProjects={refreshProjects}
                   activeSample={activeSample} onSelectSample={setActiveSample}
                   activeProject={activeProject}
                   onSelectProject={onProjectSelect}
                   onNewProject={onNewProject}
                   showWaveform={tweaks.showWaveformBrowser}
                   onChooseMediaFolder={onChooseMediaFolder}
                   onChooseProjectsFolder={onChooseProjectsFolder} />
  );
  const timelineEl = (
    <Timeline streams={data.streams} selected={selectedId}
              onSelect={selectClip} onUpdate={updateStream} onReorder={reorderStreams}
              onCreateStream={createStreamFromSample}
              playhead={time} duration={data.duration}
              pxPerSec={tweaks.zoom} showWaveforms={tweaks.showWaveforms}
              laneHeight={tweaks.laneHeight} gestures={gestures}
              onZoom={(v) => setTweak("zoom", v)}
              onLaneHeight={(v) => setTweak("laneHeight", v)}
              renderStatusFor={renderStatusForStream} />
  );
  const envelopeEl = (
    <EnvelopeEditor stream={selected()} pxPerSec={tweaks.zoom} duration={data.duration}
                    playhead={time}
                    onChange={(p) => selectedId && updateStream(selectedId, p)} />
  );
  const center = (
    <div className="pge-center" data-screen-label="01 Main · Timeline + Envelopes">
      {tweaks.showEnvelopeEditor === false ? timelineEl : (
        <SplitPane dir="vert" persist="env-editor" initial={tweaks.envelopeHeight || 240} min={120} max={600} side="primary-last">
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
               tab={inspectorTab} onTab={setInspectorTab} />
  ) : null;

  return (
    <div className={"pge-app" + (tweaks.showFooter ? "" : " no-footer") + (terminalOpen ? " with-terminal" : "")}>
      <TopBar project={data.project} title={data.title} dirty={dirty}
              playing={playing} onPlay={doPlay}
              onStop={doStop}
              onSeekZero={doSeekZero}
              onRender={onRender} onCancelRender={onCancelRender}
              renderStatus={renderStatus}
              renderOptions={renderOptions} onRenderOptionsChange={setRenderOptions}
              time={time} duration={data.duration}
              onUndo={undo} onRedo={redo} canUndo={canUndo} canRedo={canRedo}
              browserOpen={browserOpen} onToggleBrowser={() => setBrowserOpen(o => !o)}
              onSave={onSave} onSaveAs={onSaveAs}
              onOpenSettings={() => setSettingsOpen(true)}
              terminalOpen={terminalOpen}
              onToggleTerminal={() => { const v = !terminalOpen; setTerminalOpen(v); setTweak("terminalOpen", v); }}
              terminalDotState={terminalDotState}
              playReadiness={playReadiness} />
      <div className={"pge-main split"}>
        {browserOpen ? (
          <SplitPane dir="horiz" persist="browser" initial={tweaks.browserWidth || 240} min={180} max={420}>
            {browser}
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
      <Toast toasts={toasts} onDismiss={dismissToast} />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)}
                     tweaks={tweaks} setTweak={setTweak}
                     currentBackendKind={backendKind}
                     onSwitchBackend={switchBackend} />

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
            <window.TweakRadio label="backend" value={tweaks.backendKind || "mock"}
              options={[{label:"mock", value:"mock"}, {label:"local", value:"local"}]}
              onChange={(v) => {
                setTweak("backendKind", v);
                window.PGEBackend.current = window.PGEBackend.create(v);
                pushToast({ kind: "info", title: `backend → ${v}`, duration: 1800 });
              }} />
            <div className="twk-hint">mock = in-browser simulation · local = real fs + http server on localhost:7878</div>
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
