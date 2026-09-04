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
 *   workspace()                   → Promise<{ ok, workspace, isRoot, paths, projects }>
 *   setWorkspace(path)            → lo stesso, oppure { ok:false, error } (percorso
 *                                   invalido / render in corso). "" torna al --root
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
  // the verbatim curve (#59). They were both excluded here on the grounds that
  // they mirror data already encoded in the serialized states/curve — true of
  // one and false of the other, and nobody had asked the engine which:
  //   * `statePositions` does NOT mirror anything. `serializeGrainEnvelope`
  //     splices it INTO `states` (`[[pos, name], …]`), so it reaches the YAML,
  //     the engine hashes it, and its own comment says the positions are
  //     thresholds in value-space — i.e. they change the rendered audio. Edit
  //     them in the Raw tab and `states` stays a list of the same names: the
  //     engine hash moved, this one didn't, and the dot stayed green on a stem
  //     the engine was about to rewrite. It IS hashed now.
  //   * `_curveRaw` really is redundant, and for a reason worth writing down:
  //     `parseGrainEnvelope` DERIVES `curve` from it (`rescaleCurveY`, a linear
  //     *(n-1)), so the two can't move apart on the path that creates them —
  //     a drift too small for `curveMatchesRaw`'s 1e-9 to notice still lands in
  //     `curve`, which is hashed. It stays excluded, and that premise is pinned
  //     by a parity case (a reparse whose curve drifts must move BOTH hashes)
  //     instead of being asserted here.
  // Cost of hashing the positions: every already-rendered multistate stem with
  // non-uniform positions reads stale once. Safe direction, self-clearing on the
  // first pass — one render too many, never one too few.
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
  // Le due liste NON hanno la stessa portata, e prima erano una sola.
  //
  // `FP_IGNORE_TOP` sono campi PER STREAM: il colore della clip, mute/solo, la
  // posizione sulla timeline, la provenienza della durata e della grafia di
  // `deviation_probability`. Il motore esclude i suoi (`solo`, `mute`) con una
  // dict-comprehension sul solo primo livello, quindi escluderli anche in
  // profondita' era una divergenza nel verso sbagliato: un `grain.mute` — o una
  // chiave omonima dentro `_extra`, cioe' una chiave del motore che l'editor
  // non modella — muove l'hash del motore e non muoveva questo, e il pallino
  // restava verde su uno stem che il motore stava per riscrivere. Un render di
  // meno, che e' l'errore che questo asse esiste per non fare.
  //
  // `FP_IGNORE_DEEP` sono invece campi dell'EDITOR iniettati al parse, e vivono
  // annidati per costruzione (`grain.envelope._curveRaw`). Il criterio non e'
  // "campo dell'editor" ma "arriva nello YAML": quello che ci arriva lo hasha
  // il motore, e se non lo hashiamo anche noi il pallino resta verde su uno
  // stem che verra' riscritto. `statePositions` ci arriva (spliciato dentro
  // `states`) ed e' uscito da questa lista; `_curveRaw` ci arriva pure, ma non
  // puo' muoversi senza muovere `curve`, che e' hashata — vedi sopra.
  //
  // «Arriva nello YAML» va preso alla lettera, ed e' percio' una domanda per il
  // serializer, non per una lista di nomi: le posizioni stale (lunghezza != a
  // quella di `states`) non ci arrivano, e infatti non si hashano — vedi
  // `positionsAreDropped` qui sotto. Una lista di chiavi non puo' rispondere:
  // la stessa chiave, nello stesso posto, a volte esce e a volte no.
  const FP_IGNORE_TOP  = new Set(["color", "mute", "solo", "onset",
                                  "durationImplicit", "durationUnresolved",
                                  "deviationProbabilityLegacy"]);
  const FP_IGNORE_DEEP = new Set(["_curveRaw"]);

  /* Il criterio «arriva nello YAML» ha un caso in cui `statePositions` NON ci
     arriva: `serializeGrainEnvelope` lo ignora e scrive posizioni uniformi
     quando la sua lunghezza non combacia con quella di `states` — una copia
     rimasta stale dopo un edit strutturale. Hasharlo anche li' vorrebbe dire
     due stream che serializzano lo STESSO IDENTICO YAML con due fingerprint
     diversi: giallo su uno stem che il motore considera fresco. Verso sicuro,
     ma sarebbe una seconda divergenza dalla derivata del motore — e la lista
     delle divergenze dichiarate ha un elemento solo, `onset`.
     La regola non si ricopia qui: la scrive `yaml-bridge.js`, che e' il posto
     che decide cosa esce, e questa e' la seconda chiamante. Senza il bridge
     (non succede: si carica prima) si hasha tutto — un render di troppo invece
     di uno di meno. */
  function positionsAreDropped(v) {
    if (!("statePositions" in v)) return false;
    const reaches = window.PGEYaml && window.PGEYaml.statePositionsReachYaml;
    return reaches ? !reaches(v) : false;
  }

  function canonicalJSON(v, ignore, deep) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(x => canonicalJSON(x, deep, deep)).join(",") + "]";
    const drop = positionsAreDropped(v);
    const keys = Object.keys(v)
      .filter(k => !ignore.has(k) && !(drop && k === "statePositions")).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" +
      canonicalJSON(v[k], deep, deep)).join(",") + "}";
  }

  /* Il primo livello e' quello dello YAML, non quello dell'oggetto JS, e i due
     non coincidono: `serializeStream` splicia `_extra` NEL livello del blocco
     che lo contiene, quindi `stream._extra.mute` esce come un `mute:` di primo
     livello — che il motore filtra — mentre `grain._extra.mute` esce come
     `grain: {mute: …}`, che il motore hasha eccome (la sua e' una
     dict-comprehension sul solo primo livello). Percio' `FP_IGNORE_TOP` vale
     sulle chiavi dello stream E su quelle del suo `_extra`, e basta. */
  function fingerprintStream(stream, format) {
    const top = new Set([...FP_IGNORE_TOP, ...FP_IGNORE_DEEP]);
    const keys = Object.keys(stream || {}).filter(k => !top.has(k)).sort();
    const parts = [];
    for (const k of keys) {
      // `_extra` e' lo stesso livello YAML dello stream, quindi ci si applica
      // la lista del primo livello...
      const body = canonicalJSON(stream[k], k === "_extra" ? top : FP_IGNORE_DEEP,
                                 FP_IGNORE_DEEP);
      // ...e se dopo il filtro non resta niente, la voce sparisce del tutto:
      // un `_extra` di soli nomi esclusi non e' distinguibile, nello YAML, da
      // un `_extra` assente — e per il motore infatti non lo e'.
      if (k === "_extra" && body === "{}") continue;
      parts.push(JSON.stringify(k) + ":" + body);
    }
    return fnv1a("{" + parts.join(",") + "}" + `|fmt:${format || "aiff"}`);
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
    /* `cancelAbort` e' UNA variabile di chiusura: due `run()` in volo se la
       contendono, il secondo sovrascrive l'AbortController del primo, e
       `cancel()` ne uccide uno solo — l'altro resta a scrivere stem senza piu'
       un modo di fermarlo. Anche il file su disco e' uno: due POST /render
       scrivono lo stesso `configs/<basename>.yml` e gli stessi stem.
       La guardia sta QUI, nel file che subisce l'invariante, e non solo nel
       chiamante: `renderingRef` in app.jsx copre i due ingressi della UI
       (bottone e scorciatoia `r`), che sono un problema di app.jsx, ma
       lasciava `run()` ad accettare in silenzio una seconda entrata — un patto
       fra due file tenuto dalla prosa. */
    let running = false;

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
        /* Rigetto esplicito, e PRIMA di ogni scrittura di stato: alzare la
           guardia dopo aver toccato `cancelAbort` avrebbe gia' fatto il danno
           che la guardia esiste per impedire.
           Ritorna invece di lanciare, come ogni altro fallimento di `run()`
           (il catch in fondo non rilancia mai): il chiamante non ha try/catch,
           e un throw diventerebbe una unhandled rejection. `configWritten:
           false` e' la verita' su QUESTA chiamata — non ha fatto il POST,
           quindi non ha riscritto il config, quindi non spegne l'avviso di
           migrazione di `dephase`.

           Nessun evento `done`, e la ragione scritta qui prima era falsa:
           diceva che spegnerebbe la UI del render in volo, ma `runRender`
           azzera log, progresso e stato PRIMA di chiamare `run()` e fa la
           teardown incondizionata al ritorno, quindi non c'e' una UI da
           spegnere. La ragione vera e' che `done` e' l'evento di un render
           FINITO: emetterlo qui farebbe registrare al chiamante l'esito (e il
           conto degli stem generati) di un giro che non e' mai partito, e lo
           direbbe a chiunque altro ascolti lo stream. Il rifiuto lo dice il
           valore di ritorno, che e' la sede giusta. */
        if (running) {
          const msg = "render already in progress";
          onEvent && onEvent({ type: "log", line: `[ERROR] ${msg}` });
          return { ok: false, error: msg, configWritten: false };
        }
        running = true;
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
        // Gli id che hanno gia' ricevuto il loro `stream-done` in QUESTO giro.
        // Il fallback di `done` chiedeva la stessa cosa a `stemIndex`, che pero'
        // `loadCache` riempie da /stems a ogni apertura di progetto: li'
        // "gia' gestito" voleva dire "esisteva su disco", quindi dal secondo
        // render in poi il fallback era morto — e il fallback e' l'unica rete
        // dell'ultimo stream DIRTY del giro, il solo che dipende dalla riga di
        // path stampata in fondo.
        const doneThisRun = new Set();
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
                    if (doneThisRun.has(streamId)) continue;  // already handled, this run
                    const key = `${opts.yamlBasename}__${streamId}${EXT_OF[opts.outputFormat] || EXT_OF.wav}`;
                    doneThisRun.add(streamId);
                    // Qui l'id NON si valida contro `opts.streams`: `generated`
                    // e' la lista dei file che il server ha trovato su disco,
                    // quindi anche lo stem di uno stream cancellato esiste
                    // davvero, e l'indice deve saperlo — e' esattamente la
                    // domanda a cui `ownsStem` risponde.
                    _markStemFresh(key);
                    const s = (opts.streams || []).find(x => x.id === streamId);
                    if (s) localFps[s.id] = fingerprintStream(s, opts.outputFormat);
                    onEvent && onEvent({ type: "stream-done", streamId, cached: false });
                  }
                  _persistStemIndex();
                }
                if (ev.type === "stream-done") {
                  // Un solo `if (s)` per entrambe le scritture. L'evento arriva
                  // da una riga di log parsata, non da un file: il motore
                  // stampa righe `[CACHE]` di servizio (Manifest, GC) che ne
                  // hanno la forma, e ognuna valeva una voce fantasma
                  // nell'indice — da cui `ownsStem` rispondeva `true` per un
                  // file mai esistito, bruciando quel nome per `allocStreamIds`
                  // e per `renameStream`. Il fingerprint sotto gia' pretendeva
                  // uno stream dichiarato; l'indice no.
                  const s = (opts.streams || []).find(x => x.id === ev.streamId);
                  if (s) {
                    _markStemFresh(`${opts.yamlBasename}__${ev.streamId}${EXT_OF[opts.outputFormat] || EXT_OF.wav}`);
                    _persistStemIndex();
                    doneThisRun.add(ev.streamId);
                    // freeze the browser-side fingerprint for this stream so the
                    // UI can mark it fresh (and detect later edits as stale).
                    localFps[s.id] = fingerprintStream(s, opts.outputFormat);
                  }
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
            // ...e la semantica con cui il motore li ha appena scritti. E' il
            // CHIAMANTE a fissarla, con `opts.semanticsVersion`: la riempie col
            // valore che `refreshEngineSem()` gli ha appena restituito, cosi' i
            // due lati leggono letteralmente la stessa variabile invece di due
            // letture che si spera coincidano. Prima si prendeva la cella
            // condivisa `_semantics` senza `refresh`, contando sul fatto che
            // nessuno la riscrivesse a meta' giro — ma i tre punti di rilettura
            // (boot, cambio progetto, inizio render) non sono mutuamente
            // esclusivi col render in volo: cambiare progetto mentre rende, con
            // il motore mosso nel frattempo, registrava la versione NUOVA su
            // stem scritti leggendo la VECCHIA.
            //
            // Il ripiego sulla cella resta per un chiamante che non passa il
            // campo: assente significherebbe "non lo so", e li' sarebbe una
            // bugia che cancella le voci di stem appena resi.
            //
            // Col numero ignoto la voce si CANCELLA, non si salta: saltarla
            // lascerebbe in piedi la versione di un render precedente, e uno
            // stem appena reso apparirebbe giallo appena il numero si sapesse.
            // Assente vuol dire "non lo so", che e' la verita'.
            const sem = opts.semanticsVersion === undefined
              ? await semanticsVersion()
              : (Number.isInteger(opts.semanticsVersion) ? opts.semanticsVersion : null);
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
          running = false;
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
      // Durata dello stem su disco: sta dalla parte di hasStem, non di
      // ownsStem. Il numero regge `span`, cioe' su che larghezza va disegnato
      // il waveform, e il waveform e' quello del file che /peaks ha letto —
      // l'estensione del formato di output. Format-agnostica iterava EXT_OF
      // (wav per primo) mentre il disegno poteva arrivare dall'aif: `span`
      // descriveva un file diverso da quello disegnato. Il fallback sugli
      // altri formati resta, perche' il disegno stesso ricade li' quando il
      // formato chiesto non e' sul disco. `null` = non lo sappiamo (nessun
      // /stems ancora, render appena fatto, file illeggibile).
      stemDur(yamlBasename, streamId, format) {
        const want = EXT_OF[format];
        const exts = want
          ? [want, ...Object.values(EXT_OF).filter((e) => e !== want)]
          : Object.values(EXT_OF);
        for (const e of exts) {
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
      // Server-side waveform peaks (~128 KB float32). L'estensione e' quella
      // del formato di output, come in stemUrl: il server ora prova prima
      // quella chiesta, e con un `.aif` di un render precedente ancora sul
      // disco un `.aif` cablato qui faceva sentire l'audio nuovo e vedere il
      // disegno vecchio. Il fallback lato server copre il caso in cui il
      // formato chiesto non sia stato reso.
      peaksUrl(yamlBasename, streamId, format) {
        const ext = EXT_OF[format] || EXT_OF.wav;
        return `${baseUrl}/peaks/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}${ext}`;
      },
      // Server-side STFT spectrogram (uint32 w/h header + uint8 grid). Stessa
      // risoluzione di peaksUrl, stessa ragione per il formato. `scale`
      // ("linear" | "log") picks the frequency-axis bucketing.
      spectrogramUrl(yamlBasename, streamId, scale, format) {
        const q = scale === "log" ? "?scale=log" : "";
        const ext = EXT_OF[format] || EXT_OF.wav;
        return `${baseUrl}/spectrogram/${encodeURIComponent(yamlBasename)}__${encodeURIComponent(streamId)}${ext}${q}`;
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

    /* ---- workspace (#147) ------------------------------------------------
     * La cartella che contiene configs/ output/ cache/, indipendente dal
     * checkout del motore. L'autorita' e' il server: l'editor gira su file://
     * e non ha ne' un file picker nativo ne' modo di sapere se un percorso
     * esiste, quindi il percorso si digita, il server valida e risponde con
     * l'elenco progetti nuovo. */
    async function workspace() {
      try { return await jget("/workspace"); }
      catch (e) { return { ok: false, error: e.message }; }
    }

    async function setWorkspace(path) {
      let res, body;
      try {
        res = await fetchWithTimeout(baseUrl + "/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: path || "" }),
        });
        body = await res.json().catch(() => null);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      // Un 400 (percorso inesistente) o un 409 (render in corso) sono
      // risposte, non guasti: il messaggio del server e' esattamente quello
      // che il campo in Settings deve mostrare, quindi niente throw.
      if (!res.ok || !body || body.ok !== true) {
        return { ...(body || {}), ok: false,
                 error: (body && body.error) || `HTTP ${res.status}` };
      }
      // L'indice degli stem parla della output/ di PRIMA. Tenerlo darebbe una
      // clip col pallino verde e nessun audio dietro: un 404 che l'elemento
      // <audio> segnala non facendo mai partire `canplay`, cioe' in silenzio.
      // Svuotarlo e' senza costi — loadCache rilegge /stems dal disco al primo
      // progetto caricato, e la mappa delle durate si ricostruisce con lui.
      //
      // Le impronte in `pge-local-fp` restano: sono chiavate sul basename e
      // dicono "com'era lo stream quando l'ho renderizzato". Un progetto
      // omonimo in un'altra cartella con contenuto diverso ha impronta diversa
      // (quindi stale, che e' la direzione giusta); con contenuto identico
      // l'audio sarebbe identico — i sample vengono comunque dal motore.
      //
      // Le versioni di semantica in `pge-local-sem` NO, e la differenza sta in
      // cosa affermano: non parlano dello YAML ma dei FILE — "lo stem l'ha
      // scritto un motore che leggeva cosi'" — cioe' degli stessi file di cui
      // l'indice qui sopra e' l'inventario, quelli della output/ di prima.
      // Ereditate in una cartella nuova affermano una lettura che li' nessuno
      // ha osservato, e con lo YAML identico l'impronta combacia: verde su
      // stem che un motore piu' vecchio ha scritto diversi, cioe' il caso per
      // cui l'asse e' stato aggiunto (#133). Senza record il pallino e' giallo
      // — "stem di cui non so la lettura" — e si spegne al primo giro, anche a
      // vuoto. Un render di troppo, mai uno di meno.
      stemIndex = {};
      for (const k of Object.keys(stemDurIndex)) delete stemDurIndex[k];
      _persistStemIndex();
      try { localStorage.removeItem("pge-local-sem"); } catch {}
      cachedConfig = null;      // /health portava le path di prima
      return body;
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
    // La cache NON e' a vita, ed e' la stessa decisione che il bridge prende un
    // livello piu' sotto: `engine_introspect.engine_semantics_version` invalida
    // sull'mtime, perche' se il motore viene aggiornato sotto un `make serve`
    // acceso una cache a vita renderebbe il bump invisibile — proprio l'evento
    // che questa lettura esiste per intercettare. Qui vale identico: il numero
    // e' una proprieta' del motore accanto, non della sessione dell'editor, e un
    // `git checkout` nel repo fratello lo cambia sotto i piedi. Memorizzarlo per
    // sempre significherebbe pallini VERDI su stem che il motore rifara'
    // diversi, fino al reload della pagina.
    //
    // Quindi la freschezza sta nei CHIAMANTI, non nella cella: `refreshEngineSem`
    // (app.jsx: boot, cambio progetto, inizio render) chiede `{refresh:true}` e
    // riscrive la cella; chi legge senza flag riceve quel valore.
    //
    // Ed e' cio' che tiene allineati i due lati di un render: app.jsx rilegge
    // PRIMA di partire e mette il numero nel ref, `run()` lo richiede in FONDO
    // per registrarlo sugli stem. Poiche' una rilettura scrive nella cella
    // esattamente cio' che restituisce — numero o `null`, il fallimento
    // compreso — la seconda lettura non puo' cadere su un'altra risposta.
    let _semantics;
    async function semanticsVersion(opts) {
      if (!(opts && opts.refresh) && _semantics !== undefined) return _semantics;
      let v = null;
      try {
        const d = await jget("/semantics-version");
        v = Number.isInteger(d && d.version) ? d.version : null;
      } catch {
        // Bridge irraggiungibile o server.py senza la route: non si sa. Il
        // fallimento non condanna piu' la sessione perche' la rilettura esiste
        // — prima era la cella a doverlo garantire, non ricordandolo.
        v = null;
      }
      _semantics = v;
      return v;
    }

    // Eagerly pull config so currentPath() works without an await.
    ensureConfig().catch(() => {});

    return { kind: "local", fs, render, media, fingerprintStream, baseUrl, diagnose, setup,
             envelopeKeys, bounds, semanticsVersion, workspace, setWorkspace };
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
