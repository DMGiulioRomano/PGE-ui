/* =============================================================================
 * backend.js — adapter for filesystem + render backend (local server)
 *
 * Goal: keep all I/O behind a single interface so the UI never touches the
 * filesystem or the renderer directly. The only backend is `local`: a thin
 * HTTP client that talks to server.py, which has the real disk access.
 *
 * Exposes globals:
 *   window.PGEBackend        — current active backend
 *   window.PGEBackend.create(opts) — factory (returns the local backend)
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
  // Fast string hash → 16 hex chars. Not cryptographic but stable enough
  // to match Python's per-stream fingerprint behavior.
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

  function fingerprintStream(stream, format) {
    // Mirror python's stable hash: stringify with sorted keys, ignore UI-only
    // fields (color, mute, solo — those don't affect audio).
    // format is folded in so stems rendered with a different format are stale.
    const ignore = new Set(["color", "mute", "solo", "onset"]);
    const json = JSON.stringify(stream, (k, v) => (ignore.has(k) ? undefined : v))
      + `|fmt:${format || "aiff"}`;
    return fnv1a(json);
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
                    if (s) localFps[s.id] = fingerprintStream(s, opts.outputFormat);
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
                  if (s) localFps[s.id] = fingerprintStream(s, opts.outputFormat);
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
      stemUrl(yamlBasename, streamId, format) {
        // aiff → /audio/ (server transcodes to WAV via sox; browsers can't decode AIFF natively)
        // wav/flac → /output/ (browsers decode these natively, no transcode needed)
        if (!format || format === "aiff") {
          return `${baseUrl}/audio/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}.aif`;
        }
        const extMap = { wav: ".wav", flac: ".flac" };
        const ext = extMap[format] || ".wav";
        return `${baseUrl}/output/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}${ext}`;
      },
      // Server-side waveform peaks (~128 KB float32). Extension is irrelevant —
      // the server resolves the stem regardless of format.
      peaksUrl(yamlBasename, streamId) {
        return `${baseUrl}/peaks/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}.aif`;
      },
    };

    // Preview URLs for refs/ media files (MediaPreview popup). Heavy work
    // (transcode, peaks, STFT) runs server-side; the browser only paints.
    const media = {
      audioUrl(name)       { return `${baseUrl}/media_audio/${encodeURIComponent(name)}`; },
      peaksUrl(name)       { return `${baseUrl}/media_peaks/${encodeURIComponent(name)}`; },
      spectrogramUrl(name) { return `${baseUrl}/media_spectrogram/${encodeURIComponent(name)}`; },
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

    return { kind: "local", fs, render, media, fingerprintStream, baseUrl, diagnose, setup };
  }

  window.PGEBackend = {
    fingerprintStream,
    // Single backend: always the local HTTP client. `opts` may carry { baseUrl }.
    create(opts) {
      return createLocalBackend(opts);
    },
  };

  window.PGEBackend.current = createLocalBackend();
})();
