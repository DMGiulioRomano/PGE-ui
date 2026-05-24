/* =============================================================================
 * backend.js — adapter abstractions for filesystem + render backend
 *
 * Goal: keep all I/O behind a single interface so the prototype can run with
 * mocks today, and switch to a real local server + File System Access API
 * later without touching the UI.
 *
 * Exposes globals:
 *   window.PGEBackend        — current active backend (mock by default)
 *   window.PGEBackend.create(kind) — factory: "mock" | "local"
 *
 * Contract (every backend implements):
 *   fs.listDir(kind)              → Promise<{ path, files: [{name, duration?}] }>
 *   fs.chooseDir(kind)            → Promise<{ path } | null>
 *   fs.readFile(kind, name)       → Promise<string>
 *   fs.writeFile(kind, name, str) → Promise<void>
 *   fs.fileExists(kind, name)     → Promise<boolean>
 *   render.run(opts, onEvent)     → Promise<{ ok, generated:[], cacheHits:[] }>
 *     onEvent({type, line?, streamId?, progress?})
 *   render.cancel()
 *   render.loadCache(yamlBasename)→ Promise<{[streamId]: fingerprint}>
 *
 * "kind" is "media" (refs/) or "projects" (configs/) or "output" or "cache".
 * ===========================================================================*/

(function () {
  /* ---------- tiny utils ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fast string hash → 16 hex chars. Not cryptographic but stable enough
  // to match Python's per-stream fingerprint behavior in the prototype.
  function fnv1a(str) {
    let h1 = 0x811c9dc5 >>> 0;
    let h2 = 0xcbf29ce4 >>> 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = ((h1 ^ c) * 0x01000193) >>> 0;
      h2 = ((h2 ^ c) * 0x100000001b3) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  function fingerprintStream(stream) {
    // Mirror python's stable hash: stringify with sorted keys, ignore UI-only
    // fields (color, mute, solo — those don't affect audio).
    const ignore = new Set(["color", "mute", "solo", "onset"]);
    const json = JSON.stringify(stream, (k, v) => (ignore.has(k) ? undefined : v));
    return fnv1a(json);
  }

  /* =========================================================================
   * MOCK BACKEND — works fully in-browser, no server, no FS access.
   * ======================================================================= */
  function createMockBackend() {
    const state = {
      folders: {
        media: "/Users/giulio/PGE/refs",
        projects: "/Users/giulio/PGE/configs",
        output: "/Users/giulio/PGE/output",
        cache: "/Users/giulio/PGE/cache",
      },
      // simulate rendered stems on disk: key = `${yamlBasename}__${streamId}.aif`
      renderedStems: JSON.parse(localStorage.getItem("pge-rendered-stems") || "{}"),
      // per-project cache manifests (mirrors cache/<name>.json)
      cacheManifests: JSON.parse(localStorage.getItem("pge-cache-manifests") || "{}"),
      cancelled: false,
    };

    function persist() {
      localStorage.setItem("pge-rendered-stems", JSON.stringify(state.renderedStems));
      localStorage.setItem("pge-cache-manifests", JSON.stringify(state.cacheManifests));
    }

    const fs = {
      async listDir(kind) {
        await sleep(40);
        if (kind === "media") {
          return {
            path: state.folders.media,
            files: (window.PGE_DATA?.samples || []).map((s) => ({
              name: s.name, duration: s.duration,
            })),
          };
        }
        if (kind === "projects") {
          return {
            path: state.folders.projects,
            files: Object.keys(window.PROJECTS_DB || {}).map((p) => ({ name: p })),
          };
        }
        return { path: state.folders[kind] || "/", files: [] };
      },
      async chooseDir(kind) {
        // Mock: prompt for a fake path (no real picker available in mock).
        const p = prompt(`mock — set ${kind} folder path:`, state.folders[kind] || "");
        if (p == null) return null;
        state.folders[kind] = p;
        return { path: p };
      },
      currentPath(kind) { return state.folders[kind]; },
      async readFile(kind, name) {
        await sleep(30);
        const k = `${kind}:${name}`;
        return localStorage.getItem("pge-file:" + k) || "";
      },
      async writeFile(kind, name, str) {
        await sleep(80);
        const k = `${kind}:${name}`;
        localStorage.setItem("pge-file:" + k, str);
      },
      async fileExists(kind, name) {
        return localStorage.getItem("pge-file:" + kind + ":" + name) != null;
      },
    };

    const render = {
      async loadCache(yamlBasename) {
        return state.cacheManifests[yamlBasename] || {};
      },
      cancel() { state.cancelled = true; },
      async run(opts, onEvent) {
        state.cancelled = false;
        const { yamlBasename, streams, renderer, useCache, visualize, reaper, preclean } = opts;
        const emit = (e) => onEvent && onEvent(e);

        emit({ type: "log", line: `[${new Date().toLocaleTimeString()}] starting render` });
        emit({ type: "log", line: `  yaml:       configs/${yamlBasename}.yml` });
        emit({ type: "log", line: `  renderer:   ${renderer}` });
        emit({ type: "log", line: `  per-stream: true` });
        emit({ type: "log", line: `  cache:      ${useCache ? "on" : "off"}` });
        if (visualize) emit({ type: "log", line: `  visualize:  pdf score` });
        if (reaper)    emit({ type: "log", line: `  reaper:     export .rpp` });
        if (preclean)  emit({ type: "log", line: `  preclean:   wipe output/` });
        emit({ type: "log", line: `` });

        const lastCache = state.cacheManifests[yamlBasename] || {};
        const newCache = {};
        const generated = [];
        const cacheHits = [];

        if (preclean) {
          // wipe any stem files for this project
          for (const k of Object.keys(state.renderedStems)) {
            if (k.startsWith(yamlBasename + "__")) delete state.renderedStems[k];
          }
          emit({ type: "log", line: `[CLEAN] removed previous stems for ${yamlBasename}` });
        }

        emit({ type: "log", line: `Caricamento configs/${yamlBasename}.yml...` });
        await sleep(120);
        emit({ type: "log", line: `Generazione streams...` });
        await sleep(80);
        emit({ type: "log", line: `[CACHE] Manifest: cache/${yamlBasename}.json` });
        emit({ type: "log", line: `` });

        for (let i = 0; i < streams.length; i++) {
          if (state.cancelled) {
            emit({ type: "log", line: `[ABORT] cancelled by user` });
            emit({ type: "done", ok: false, generated, cacheHits });
            return { ok: false, generated, cacheHits };
          }
          const s = streams[i];
          const fp = fingerprintStream(s);
          newCache[s.id] = fp;
          const aifName = `${yamlBasename}__${s.id}.aif`;
          const exists = state.renderedStems[aifName];
          const cached = useCache && lastCache[s.id] === fp && exists;

          emit({ type: "stream-start", streamId: s.id, index: i, total: streams.length });
          if (cached) {
            emit({ type: "log", line: `  [${i + 1}/${streams.length}] ${s.id.padEnd(10)} cached — skip` });
            cacheHits.push(s.id);
            generated.push(`output/${aifName}`);
            emit({ type: "stream-done", streamId: s.id, cached: true });
            await sleep(60);
          } else {
            emit({ type: "log", line: `  [${i + 1}/${streams.length}] ${s.id.padEnd(10)} rendering...` });
            // simulate work: variable per stream
            const t = 400 + Math.random() * 700;
            const tick = 50;
            let elapsed = 0;
            while (elapsed < t) {
              if (state.cancelled) break;
              await sleep(tick);
              elapsed += tick;
              emit({ type: "stream-progress", streamId: s.id, progress: Math.min(1, elapsed / t) });
            }
            if (state.cancelled) {
              emit({ type: "log", line: `[ABORT] cancelled mid-stream ${s.id}` });
              emit({ type: "done", ok: false, generated, cacheHits });
              return { ok: false, generated, cacheHits };
            }
            state.renderedStems[aifName] = { mtime: Date.now(), duration: s.duration || 5 };
            generated.push(`output/${aifName}`);
            emit({ type: "log", line: `      → output/${aifName}` });
            emit({ type: "stream-done", streamId: s.id, cached: false });
          }
        }

        state.cacheManifests[yamlBasename] = newCache;
        persist();

        if (visualize) {
          await sleep(300);
          emit({ type: "log", line: `` });
          emit({ type: "log", line: `Generazione partitura grafica...` });
          emit({ type: "log", line: `      → output/${yamlBasename}.pdf` });
        }
        if (reaper) {
          await sleep(100);
          emit({ type: "log", line: `Reaper project: ${yamlBasename}.rpp` });
        }
        emit({ type: "log", line: `` });
        emit({ type: "log", line: ` Generazione completata! ${generated.length} file generati` });
        for (const p of generated) emit({ type: "log", line: `    ${p}` });
        emit({ type: "log", line: `Log: logs/${yamlBasename}.log` });
        emit({ type: "done", ok: true, generated, cacheHits });
        return { ok: true, generated, cacheHits };
      },
      // does an output stem exist on disk for a given (project, streamId)?
      hasStem(yamlBasename, streamId) {
        return !!state.renderedStems[`${yamlBasename}__${streamId}.aif`];
      },
      // when was a stem rendered?
      stemMtime(yamlBasename, streamId) {
        const e = state.renderedStems[`${yamlBasename}__${streamId}.aif`];
        return e ? e.mtime : null;
      },
      // mock backend has no real audio file. The audio engine treats this
      // as "synthesize procedurally" when there's no url.
      stemUrl(yamlBasename, streamId) { return null; },
    };

    async function setup(onEvent) {
      onEvent?.({ type: "log", line: "[VENV] mock backend — no engine setup needed" });
      onEvent?.({ type: "done", ok: true });
      return { ok: true };
    }

    async function diagnose() {
      const checks = [];
      const push = (label, ok, detail) => checks.push({ label, ok, detail });
      push("backend kind", true, "mock (in-browser simulation)");
      try {
        const m = await fs.listDir("media");
        push("media folder", true, `${m.files.length} files · ${m.path}`);
      } catch (e) { push("media folder", false, e.message); }
      try {
        const p = await fs.listDir("projects");
        push("projects folder", true, `${p.files.length} projects · ${p.path}`);
      } catch (e) { push("projects folder", false, e.message); }
      push("yaml bridge", !!window.PGEYaml, window.PGEYaml ? "js-yaml + bridge ready" : "missing");
      push("audio engine", !!window.PGEAudio?.engine, window.PGEAudio ? "Web Audio API ready" : "missing");
      // Round-trip self-test on the bundled data
      if (window.PGEYaml && window.PGE_DATA) {
        try {
          const diffs = window.PGEYaml.roundTripDiff(window.PGE_DATA);
          push("yaml round-trip", diffs.length === 0,
               diffs.length === 0 ? "lossless on PGE_DATA"
                                  : `${diffs.length} mismatch(es) — see console`);
          if (diffs.length) console.warn("[diagnose] round-trip diffs:", diffs);
        } catch (e) {
          push("yaml round-trip", false, e.message);
        }
      }
      const renderedCount = Object.keys(JSON.parse(localStorage.getItem("pge-rendered-stems") || "{}")).length;
      push("simulated stems", true, `${renderedCount} on disk (localStorage)`);
      return { ok: checks.every(c => c.ok), checks };
    }

    return { kind: "mock", fs, render, fingerprintStream, diagnose, setup };
  }

  /* =========================================================================
   * LOCAL BACKEND — pure HTTP, talks to server.py.
   * Works in any browser (Chrome, Firefox, Safari, …) because the server
   * has the disk access; the browser only does fetch().
   * ======================================================================= */
  function createLocalBackend(opts = {}) {
    const baseUrl = (opts.baseUrl || "http://localhost:7878").replace(/\/$/, "");
    let cachedConfig = null;
    let cancelAbort = null;

    async function jget(path) {
      const r = await fetch(baseUrl + path);
      if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
      return await r.json();
    }
    async function jput(path, body) {
      const r = await fetch(baseUrl + path, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body,
      });
      if (!r.ok) throw new Error(`PUT ${path} → HTTP ${r.status}`);
      return await r.json();
    }
    async function getText(path) {
      const r = await fetch(baseUrl + path);
      if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
      return await r.text();
    }

    async function ensureConfig() {
      if (cachedConfig) return cachedConfig;
      const data = await jget("/health");
      cachedConfig = data;
      return data;
    }

    const fs = {
      async listDir(kind) {
        if (kind === "media") {
          const d = await jget("/media");
          return { path: d.path, files: d.files || [] };
        }
        if (kind === "projects") {
          const d = await jget("/projects");
          return { path: d.path, files: d.files || [] };
        }
        const cfg = await ensureConfig();
        return { path: cfg[kind] || "/", files: [] };
      },
      async chooseDir(kind) {
        // In local mode the server already knows the folders (configured at
        // launch via --root). There's nothing for the browser to "choose";
        // surface the server's resolved paths instead.
        const cfg = await ensureConfig();
        const key = kind === "media" ? "refs" : kind;
        return { path: cfg[key] || cfg.root || "/" };
      },
      currentPath(kind) {
        if (!cachedConfig) return null;
        const key = kind === "media" ? "refs" : kind;
        return cachedConfig[key] || null;
      },
      async readFile(kind, name) {
        return await getText(`/file?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`);
      },
      async writeFile(kind, name, str) {
        await jput(`/file?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`, str);
      },
      async fileExists(kind, name) {
        try {
          const r = await fetch(baseUrl + `/file?kind=${kind}&name=${encodeURIComponent(name)}`, { method: "HEAD" });
          return r.ok;
        } catch { return false; }
      },
    };

    // local stem index — populated as renders complete or restored from localStorage.
    // key: `${yamlBasename}__${streamId}` (internal key, not the filename)
    let stemIndex = {};
    try {
      stemIndex = JSON.parse(localStorage.getItem("pge-local-stems") || "{}");
    } catch {}

    function _persistStemIndex() {
      try { localStorage.setItem("pge-local-stems", JSON.stringify(stemIndex)); } catch {}
    }

    const render = {
      async loadCache(yamlBasename) {
        // We keep our own per-browser manifest (browser fingerprint algorithm
        // != Python's SHA-256 algorithm, so the on-disk cache/<name>.json is
        // not directly comparable). Python uses its cache.json for its own
        // skip decision during render; the UI uses this localStorage manifest
        // to color clips as fresh/stale.
        //
        // Also sync stem presence from disk so hasStem() works after page reload
        // even if the stems were rendered in a previous session.
        try {
          const sd = await jget(`/stems/${encodeURIComponent(yamlBasename)}`);
          if (sd && Array.isArray(sd.stems)) {
            for (const { streamId, mtime } of sd.stems) {
              stemIndex[`${yamlBasename}__${streamId}`] = mtime * 1000;
            }
            _persistStemIndex();
          }
        } catch {}
        try {
          const all = JSON.parse(localStorage.getItem("pge-local-fp") || "{}");
          return all[yamlBasename] || {};
        } catch { return {}; }
      },
      _persistFp(yamlBasename, fps) {
        try {
          const all = JSON.parse(localStorage.getItem("pge-local-fp") || "{}");
          all[yamlBasename] = fps;
          localStorage.setItem("pge-local-fp", JSON.stringify(all));
        } catch {}
      },
      cancel() {
        if (cancelAbort) cancelAbort.abort();
        // fire-and-forget POST so the server kills the subprocess too
        fetch(baseUrl + "/render/cancel", { method: "POST" }).catch(() => {});
      },
      async run(opts, onEvent) {
        cancelAbort = new AbortController();
        const localFps = {};   // computed browser-side per stream as we go
        if (opts.preclean) {
          // wipe cached stem knowledge for this project so stale entries don't linger
          const prefix = `${opts.yamlBasename}__`;
          for (const k of Object.keys(stemIndex)) {
            if (k.startsWith(prefix)) delete stemIndex[k];
          }
          _persistStemIndex();
        }
        try {
          const res = await fetch(baseUrl + "/render", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts),
            signal: cancelAbort.signal,
          });
          if (!res.ok || !res.body) {
            const txt = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          let lastResult = { ok: true };
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
                onEvent && onEvent(ev);
                if (ev.type === "done") {
                  lastResult = ev;
                  // Fallback: emit synthetic stream-done for any generated stem
                  // that didn't already get a stream-done event during streaming.
                  // This covers the case where parse_render_line missed a line.
                  const prefix = opts.yamlBasename + "__";
                  for (const genPath of (ev.generated || [])) {
                    const fname = genPath.replace(/^.*[\\/]/, "");
                    const stem  = fname.replace(/\.[^.]+$/, "");
                    if (!stem.startsWith(prefix)) continue;
                    const streamId = stem.slice(prefix.length);
                    if (!streamId) continue;
                    const key = `${opts.yamlBasename}__${streamId}`;
                    if (stemIndex[key]) continue;  // already handled
                    stemIndex[key] = Date.now();
                    const s = (opts.streams || []).find(x => x.id === streamId);
                    if (s) localFps[s.id] = fingerprintStream(s);
                    onEvent && onEvent({ type: "stream-done", streamId, cached: false });
                  }
                  _persistStemIndex();
                }
                if (ev.type === "stream-done") {
                  stemIndex[`${opts.yamlBasename}__${ev.streamId}`] = Date.now();
                  _persistStemIndex();
                  // freeze the browser-side fingerprint for this stream so the
                  // UI can mark it fresh (and detect later edits as stale).
                  const s = (opts.streams || []).find(x => x.id === ev.streamId);
                  if (s) localFps[s.id] = fingerprintStream(s);
                }
              } catch (parseErr) {
                onEvent && onEvent({ type: "log", line: `[warn] bad json line: ${line.slice(0,80)}` });
              }
            }
          }
          // persist the freshly-rendered fingerprints if anything succeeded
          if (Object.keys(localFps).length) {
            const existing = await this.loadCache(opts.yamlBasename);
            this._persistFp(opts.yamlBasename, { ...existing, ...localFps });
          }
          return lastResult;
        } catch (e) {
          const msg = e.name === "AbortError" ? "cancelled" : e.message;
          onEvent && onEvent({ type: "log", line: `[ERROR] ${msg}` });
          onEvent && onEvent({ type: "done", ok: false, error: msg });
          return { ok: false, error: msg };
        } finally {
          cancelAbort = null;
        }
      },
      hasStem(yamlBasename, streamId) {
        return !!stemIndex[`${yamlBasename}__${streamId}`];
      },
      stemMtime(yamlBasename, streamId) {
        return stemIndex[`${yamlBasename}__${streamId}`] || null;
      },
      stemUrl(yamlBasename, streamId) {
        // Use /audio/ (transcoded WAV) — works in every browser including FF.
        return `${baseUrl}/audio/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}.aif`;
      },
    };

    async function setup(onEvent) {
      try {
        const res = await fetch(baseUrl + "/setup", { method: "POST" });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let lastResult = { ok: true };
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              onEvent && onEvent(ev);
              if (ev.type === "done") lastResult = ev;
            } catch {}
          }
        }
        return lastResult;
      } catch (e) {
        onEvent && onEvent({ type: "log", line: `[ERROR] ${e.message}` });
        onEvent && onEvent({ type: "done", ok: false, error: e.message });
        return { ok: false, error: e.message };
      }
    }

    async function diagnose() {
      const checks = [];
      const push = (label, ok, detail) => checks.push({ label, ok, detail });
      push("backend kind", true, `local (server: ${baseUrl})`);

      // 1. Server reachable
      let serverInfo = null;
      try {
        serverInfo = await jget("/health");
        push("server reachable", !!serverInfo.ok, serverInfo.ok ? `v${serverInfo.version} · root: ${serverInfo.root}` : "no ok flag");
      } catch (e) {
        push("server reachable", false, `${e.message} — is server.py running on ${baseUrl}?`);
        return { ok: false, checks };
      }

      // 2. Try the optional /diagnose endpoint for server-side checks
      try {
        const sd = await jget("/diagnose");
        if (sd && Array.isArray(sd.checks)) {
          for (const c of sd.checks) push("server · " + c.label, c.ok, c.detail);
        }
      } catch {
        push("server · diagnose", false, "older server.py — no /diagnose endpoint");
      }

      // 3. Folder listings round-trip
      try {
        const m = await fs.listDir("media");
        push("media listing", !m.error, m.error || `${m.files.length} files · ${m.path}`);
      } catch (e) { push("media listing", false, e.message); }
      try {
        const p = await fs.listDir("projects");
        push("projects listing", !p.error, p.error || `${p.files.length} projects · ${p.path}`);
      } catch (e) { push("projects listing", false, e.message); }

      // 4. Yaml/audio engine on the browser side
      push("yaml bridge", !!window.PGEYaml, window.PGEYaml ? "js-yaml + bridge ready" : "missing");
      push("audio engine", !!window.PGEAudio?.engine, window.PGEAudio ? "Web Audio API ready" : "missing");

      // 5. CORS sanity: did the fetch above include the right headers? if we
      // got the JSON it did; just report it.
      push("CORS", true, "fetches succeeding from this origin");

      return { ok: checks.every(c => c.ok), checks };
    }

    // Eagerly pull config so currentPath() works without an await.
    ensureConfig().catch(() => {});

    return { kind: "local", fs, render, fingerprintStream, baseUrl, diagnose, setup };
  }

  window.PGEBackend = {
    fingerprintStream,
    create(kind, opts) {
      return kind === "local" ? createLocalBackend(opts) : createMockBackend();
    },
  };

  // Default: mock
  window.PGEBackend.current = createMockBackend();
})();
