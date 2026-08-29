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
 *   render.grainsUrl(yamlBasename, streamId)     → string (grain JSON sidecar URL)
 *   render.loadGrainData(yamlBasename, streamId) → Promise<grainData | null>
 *
 * "kind" is "media" (refs/) or "projects" (configs/) or "output" or "cache".
 * ===========================================================================*/

(function () {
  // Output format → stem extension. One table: the index key, the playback URL
  // and the render bookkeeping must all agree on it.
  const EXT_OF = { wav: ".wav", aiff: ".aif", flac: ".flac" };

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

  // Ignored fields for fingerprint: UI-only (color, mute, solo) don't affect
  // audio. onset is excluded intentionally — moving a clip on the timeline
  // doesn't change the rendered stem audio, so it shouldn't mark the stem
  // stale. The engine's SHA-256 includes onset (it hashes the full YAML dict),
  // so this is a deliberate divergence for UX reasons.
  // statePositions / _curveRaw (grain.envelope multistate) are editor-only
  // preservation fields injected at parse to round-trip explicit positions and
  // the verbatim curve (#59). They mirror data already encoded in the serialized
  // states/curve, so hashing them too would double-count — and, more importantly,
  // would mark every already-rendered multistate stem stale the moment this
  // preservation shipped. Exclude them: only a real edit to a window name or the
  // curve changes the fingerprint.
  // durationImplicit / durationUnresolved (engine #205) are bookkeeping for the
  // optional `duration`: they record whether the length was written in the YAML
  // or inherited from the sample. The renderer only ever sees the resolved
  // number, which IS hashed — so typing the value the sample already implied
  // must leave the stem green instead of going stale on a flag flip.
  // deviationProbabilityLegacy (PGE #204) is the same kind of bookkeeping: it
  // records WHICH spelling the deviation came from, `dephase` or the current
  // key, not what it says. Reopening a pre-v7 project must not mark every stem
  // stale over a key name — the healed value is hashed, so the migration still
  // marks stale exactly what it changes.
  const FP_IGNORE = new Set(["color", "mute", "solo", "onset", "statePositions", "_curveRaw",
                             "durationImplicit", "durationUnresolved",
                             "deviationProbabilityLegacy"]);

  function canonicalJSON(v, ignore) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(x => canonicalJSON(x, ignore)).join(",") + "]";
    const keys = Object.keys(v).filter(k => !ignore.has(k)).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(v[k], ignore)).join(",") + "}";
  }

  function fingerprintStream(stream, format) {
    const json = canonicalJSON(stream, FP_IGNORE) + `|fmt:${format || "aiff"}`;
    return fnv1a(json);
  }

  // fetch with an AbortController timeout so a hung server.py can't leave a
  // promise pending forever (the boot probe in app.jsx uses the same pattern at
  // a tighter 1.5s). Data ops default to 10s. #45
  async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
      throw e;
    } finally {
      clearTimeout(tid);
    }
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
      const r = await fetchWithTimeout(baseUrl + path);
      if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
      return await r.json();
    }
    async function jput(path, body) {
      const r = await fetchWithTimeout(baseUrl + path, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body,
      });
      if (!r.ok) throw new Error(`PUT ${path} → HTTP ${r.status}`);
      return await r.json();
    }
    async function getText(path) {
      const r = await fetchWithTimeout(baseUrl + path);
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
          const r = await fetchWithTimeout(baseUrl + `/file?kind=${kind}&name=${encodeURIComponent(name)}`, { method: "HEAD" }, 5000);
          return r.ok;
        } catch { return false; }
      },
    };

    // local stem index — populated as renders complete or restored from
    // localStorage. Keyed by the *filename* `${basename}__${streamId}${ext}`,
    // extension included: a stem is playable only in the format stemUrl() will
    // ask for, and a stem present as .aif only is not playable while the
    // Settings format is wav (the request 404s and the <audio> element reports
    // it by never firing `canplay` — a silently silent clip). Entries persisted
    // by an older build carry no extension; they simply never match, and the
    // next loadCache refills the index from disk.
    let stemIndex = {};
    try {
      stemIndex = JSON.parse(localStorage.getItem("pge-local-stems") || "{}");
    } catch {}

    // Durata degli stem SUL DISCO, per nome file. Cache di sessione, non
    // persistita: la riempie /stems al caricamento del progetto e serve solo a
    // disegnare il waveform nel tempo giusto. Quando manca, chi disegna assume
    // "stem lungo quanto la clip", che e' l'ipotesi giusta subito dopo un
    // render — l'unico momento in cui la mappa puo' non avere ancora la voce.
    const stemDurIndex = {};

    function _persistStemIndex() {
      try { localStorage.setItem("pge-local-stems", JSON.stringify(stemIndex)); } catch {}
    }

    // Uno stem appena scritto ha una durata nuova, e quella in `stemDurIndex`
    // e' quella di prima: tenerla sarebbe peggio che non averla (un waveform
    // tagliato sulla misura vecchia). Dimenticarla riporta chi disegna
    // all'ipotesi "stem lungo quanto la clip", vera appena dopo un render.
    function _markStemFresh(key) {
      stemIndex[key] = Date.now();
      delete stemDurIndex[key];
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
            for (const { streamId, ext, mtime, dur } of sd.stems) {
              stemIndex[`${yamlBasename}__${streamId}${ext || ""}`] = mtime * 1000;
              if (dur > 0) stemDurIndex[`${yamlBasename}__${streamId}${ext || ""}`] = dur;
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

      // La semantica del motore con cui ogni stem e' stato scritto, per
      // progetto e per stream. Mappa parallela a `pge-local-fp`, non un campo
      // dentro il fingerprint: i due dati rispondono a domande diverse — l'hash
      // dice "l'utente ha modificato lo YAML", questa dice "il motore lo legge
      // come allora" — e un progetto puo' portare stem scritti da motori
      // diversi, quindi il dato e' per stream come l'hash.
      //
      // Voce assente = stem renderizzato prima che l'editor registrasse il
      // numero. Resta assente: chi classifica non pretende niente da un dato
      // che non c'e', e il primo render la scrive.
      async loadSemantics(yamlBasename) {
        try {
          const all = JSON.parse(localStorage.getItem("pge-local-sem") || "{}");
          const one = all[yamlBasename];
          return (one && typeof one === "object") ? one : {};
        } catch { return {}; }
      },
      _persistSem(yamlBasename, sems) {
        try {
          const all = JSON.parse(localStorage.getItem("pge-local-sem") || "{}");
          all[yamlBasename] = sems;
          localStorage.setItem("pge-local-sem", JSON.stringify(all));
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
          const suffix = EXT_OF[opts.outputFormat] || EXT_OF.wav;
          const prefix = `${opts.yamlBasename}__`;
          for (const k of Object.keys(stemIndex)) {
            if (k.startsWith(prefix) && k.endsWith(suffix)) { delete stemIndex[k]; delete stemDurIndex[k]; }
          }
          _persistStemIndex();
        }
        // Il server scrive lo YAML su configs/<basename>.yml PRIMA di costruire
        // lo stream di eventi, e i suoi tre abort(400) (basename mancante, con
        // traversal, formato ignoto) precedono quella scrittura. Quindi una
        // risposta buona implica il file scritto, e un fallimento prima di qui
        // implica il contrario: e' quello che il chiamante deve sapere per
        // decidere se la migrazione di `dephase` e' avvenuta.
        //
        // La distinzione non e' "la richiesta e' arrivata": il catch qui sotto
        // copre anche il loop di lettura NDJSON, quindi un annullamento o una
        // connessione caduta a meta' stream ci finiscono dentro — e li' il file
        // e' scritto eccome. Percio' il flag si alza qui, non nel catch — e
        // sulla RISPOSTA, non sul body: `!res.ok || !res.body` e' un throw solo,
        // ma un 200 senza body e' comunque un server che ha gia' scritto.
        let configWritten = false;
        try {
          const res = await fetch(baseUrl + "/render", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts),
            signal: cancelAbort.signal,
          });
          configWritten = res.ok;
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
                    const key = `${opts.yamlBasename}__${streamId}${EXT_OF[opts.outputFormat] || EXT_OF.wav}`;
                    if (stemIndex[key]) continue;  // already handled
                    _markStemFresh(key);
                    const s = (opts.streams || []).find(x => x.id === streamId);
                    if (s) localFps[s.id] = fingerprintStream(s, opts.outputFormat);
                    onEvent && onEvent({ type: "stream-done", streamId, cached: false });
                  }
                  _persistStemIndex();
                }
                if (ev.type === "stream-done") {
                  _markStemFresh(`${opts.yamlBasename}__${ev.streamId}${EXT_OF[opts.outputFormat] || EXT_OF.wav}`);
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
            // ...e la semantica con cui il motore li ha appena scritti. Chiesta
            // qui e non presa da chi chiama: e' una proprieta' del motore che
            // ha reso, e la risposta e' gia' in cache dopo il primo giro.
            //
            // Col numero ignoto la voce si CANCELLA, non si salta: saltarla
            // lascerebbe in piedi la versione di un render precedente, e uno
            // stem appena reso apparirebbe giallo appena il numero si sapesse.
            // Assente vuol dire "non lo so", che e' la verita'.
            const sem = await semanticsVersion();
            const prev = await this.loadSemantics(opts.yamlBasename);
            const next = { ...prev };
            for (const id of Object.keys(localFps)) {
              if (sem === null) delete next[id];
              else next[id] = sem;
            }
            this._persistSem(opts.yamlBasename, next);
          }
          return lastResult;
        } catch (e) {
          const msg = e.name === "AbortError" ? "cancelled" : e.message;
          onEvent && onEvent({ type: "log", line: `[ERROR] ${msg}` });
          onEvent && onEvent({ type: "done", ok: false, error: msg });
          return { ok: false, error: msg, configWritten };
        } finally {
          cancelAbort = null;
        }
      },
      // Playable *now*: a stem in the format stemUrl() is about to request.
      hasStem(yamlBasename, streamId, format) {
        return !!stemIndex[`${yamlBasename}__${streamId}${EXT_OF[format] || EXT_OF.wav}`];
      },
      // Claims the id: any format counts. Id allocation asks this, and must not
      // be format-specific or it would recycle an id whose stem is on disk in
      // the other format — the new stream would inherit the dead one's audio
      // the moment the Settings format switched back.
      ownsStem(yamlBasename, streamId) {
        return Object.values(EXT_OF).some(
          (e) => !!stemIndex[`${yamlBasename}__${streamId}${e}`]);
      },
      // Durata dello stem su disco, format-agnostica come ownsStem: chi
      // disegna vuole sapere quanto dura l'audio che ha in mano, non in che
      // formato sta. `null` = non lo sappiamo (nessun /stems ancora, render
      // appena fatto, file illeggibile).
      stemDur(yamlBasename, streamId) {
        for (const e of Object.values(EXT_OF)) {
          const d = stemDurIndex[`${yamlBasename}__${streamId}${e}`];
          if (d > 0) return d;
        }
        return null;
      },
      stemUrl(yamlBasename, streamId, format) {
        // aiff → /audio/ (server transcodes to WAV via sox; browsers can't decode AIFF natively)
        // wav/flac → /output/ (browsers decode these natively, no transcode needed)
        if (!format || format === "aiff") {
          return `${baseUrl}/audio/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}.aif`;
        }
        const ext = EXT_OF[format] || EXT_OF.wav;
        return `${baseUrl}/output/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}${ext}`;
      },
      // Server-side waveform peaks (~128 KB float32). Extension is irrelevant —
      // the server resolves the stem regardless of format.
      peaksUrl(yamlBasename, streamId) {
        return `${baseUrl}/peaks/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}.aif`;
      },
      // Server-side STFT spectrogram (uint32 w/h header + uint8 grid). Same stem
      // resolution as peaksUrl — extension is irrelevant. `scale` ("linear" |
      // "log") picks the frequency-axis bucketing.
      spectrogramUrl(yamlBasename, streamId, scale) {
        const q = scale === "log" ? "?scale=log" : "";
        return `${baseUrl}/spectrogram/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}.aif${q}`;
      },
      // Per-stream grain JSON sidecar (engine --grain-json). basename and
      // streamId are separate path segments because the file is
      // <basename>__<streamId>__grains.json, not an audio stem.
      grainsUrl(yamlBasename, streamId) {
        return `${baseUrl}/grains/${encodeURIComponent(yamlBasename)}/${encodeURIComponent(streamId)}`;
      },
      // Fetch + parse the grain JSON; null on 404 / error / server down so the
      // caller can simply skip drawing (no grains = solid clip, as before).
      async loadGrainData(yamlBasename, streamId) {
        try {
          const r = await fetch(this.grainsUrl(yamlBasename, streamId));
          if (!r.ok) return null;
          return await r.json();
        } catch (e) {
          return null;
        }
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

    // Valid `--plot-envelopes` names, sourced from the engine (issue #31) so the
    // render-options filter isn't hardcoded. Returns [] for an older server.py
    // without the endpoint, or an older engine without the constant — the UI
    // then simply hides the filter.
    async function envelopeKeys() {
      try {
        const d = await jget("/envelope-keys");
        return Array.isArray(d.keys) ? d.keys : [];
      } catch { return []; }
    }

    // Engine parameter clamps (min/max/range + pitch), AST-parsed from the
    // engine source by the bridge so the UI's bounds aren't hardcoded. Returns
    // {} for an older server.py without /bounds or an engine without the
    // parameter files — the UI then keeps its static fallback (PGE_BOUNDS).
    async function bounds() {
      try {
        const d = await jget("/bounds");
        return (d && d.bounds && typeof d.bounds === "object") ? d.bounds : {};
      } catch { return {}; }
    }

    // `VARIATION_SEMANTICS_VERSION` del motore, letta dal bridge dalla sorgente
    // del motore (#133). E' il numero che il motore mette nel PROPRIO
    // fingerprint: quando cambia, ogni stem gia' su disco e' stato scritto con
    // una lettura diversa dello stesso YAML, e il pallino verde dell'editor
    // starebbe mentendo.
    //
    // `null` per un server.py senza la route, un motore senza la costante o un
    // bridge irraggiungibile: chi classifica non pretende niente e i pallini
    // restano quelli di prima. Un numero e' un'affermazione, l'assenza no.
    //
    // Cache di sessione, ma solo delle RISPOSTE. Un bridge irraggiungibile al
    // boot non deve condannare la sessione a non sapere: le altre due letture
    // del motore (envelopeKeys, bounds) al massimo nascondono un filtro, questa
    // decide un pallino, e ricordare il fallimento lo terrebbe verde anche dopo
    // che il bridge e' tornato su. Un `null` che ARRIVA dal bridge (motore senza
    // la costante) e' invece una risposta, e si ricorda come le altre.
    let _semantics;
    async function semanticsVersion() {
      if (_semantics !== undefined) return _semantics;
      try {
        const d = await jget("/semantics-version");
        _semantics = Number.isInteger(d && d.version) ? d.version : null;
        return _semantics;
      } catch {
        // Non memorizzato, e il prossimo giro esiste davvero: app.jsx la
        // richiede al boot, a ogni cambio progetto e all'inizio di ogni render
        // (`refreshEngineSem`). Con la sola chiamata al boot — che ha le
        // dipendenze vuote, e `serverDown` non torna mai a falso senza reload —
        // chi apriva l'editor prima di `make serve` restava senza asse per
        // tutta la sessione, mentre `run()` qui sotto REGISTRAVA comunque la
        // versione: nessun pallino poteva dirlo.
        return null;
      }
    }

    // Eagerly pull config so currentPath() works without an await.
    ensureConfig().catch(() => {});

    return { kind: "local", fs, render, media, fingerprintStream, baseUrl, diagnose, setup,
             envelopeKeys, bounds, semanticsVersion };
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
