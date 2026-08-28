/* =============================================================================
 * render-status.js — pure render/fingerprint tracking logic (stale/fresh/never).
 *
 * Extracted from app.jsx (#58, follow-up of #44) so the per-stream stale/fresh
 * decision and the aggregate render summary can be unit-tested in node like
 * backend.js / envelope-utils.js. No React, no DOM. Attaches to
 * window.PGERenderStatus.
 *
 * The fingerprint itself lives in backend.js (window.PGEBackend.fingerprintStream,
 * FNV-1a — pinned by tests/node/test-fingerprint.js); this module *consumes* it
 * via fingerprintAll, it does not duplicate the hash. The "does this stream have
 * a stem on disk" check is injected as a hasStem(id)=>bool closure so the module
 * never reaches into window.PGEBackend.current.
 *
 * State (lastRenderedFps, renderStatus, streamProgress) and all its setters/effects
 * stay in app.jsx — only the pure classification/aggregation moves here.
 * ===========================================================================*/

(function () {
  const STATES = { FRESH: "fresh", STALE: "stale", NEVER: "never", RUNNING: "running" };

  // Tooltip strings kept verbatim from app.jsx so the UI text is unchanged.
  // `staleSemantics` is the one addition: same yellow dot, different reason —
  // the YAML did not move, the engine's reading of it did.
  const TOOLTIPS = {
    running: "rendering this stream…",
    never:   "this stream has never been rendered",
    fresh:   "rendered and up-to-date with the YAML",
    stale:   "YAML changed since last render — re-render to update",
    staleSemantics: "the engine's reading of this YAML doesn't match this " +
                    "stem — re-render to update",
  };

  // Per-stream fingerprints for the live editor state. Wraps the backend hash;
  // the caller passes the already-resolved output format (app.jsx uses
  // tweaks.outputFormat || "wav").
  function fingerprintAll(streams, format) {
    const out = {};
    for (const s of streams) out[s.id] = window.PGEBackend.fingerprintStream(s, format);
    return out;
  }

  // Perche' uno stem e' stale, o null se non lo e'. Due assi indipendenti:
  //
  //   "yaml"      — l'utente ha modificato lo stream dall'ultimo render. E'
  //                 l'hash della UI a dirlo, ed e' l'unica cosa che sa dire.
  //   "semantics" — VARIATION_SEMANTICS_VERSION del motore e' cambiata da
  //                 quando quello stem e' stato scritto: stesso YAML, lettura
  //                 diversa, audio diverso al prossimo render. Il motore la
  //                 mette nel proprio fingerprint (stream_cache_manager.py) e
  //                 rifara' lo stem; senza quest'asse l'editor mostrerebbe
  //                 verde su audio che il motore considera gia' morto.
  //
  // Il numero NON entra nell'hash della UI, e non e' una svista: l'hash
  // risponde a "l'utente ha toccato qualcosa", che a un bump del motore non si
  // muove. Sono due domande, e restano due record (vedi loadSemantics in
  // backend.js). `sem` e' { rendered, engine }, entrambi opzionali.
  //
  // I DUE IGNOTI NON SONO LO STESSO IGNOTO, e la differenza e' se il giallo si
  // possa poi spegnere:
  //
  //   - motore ignoto (bridge giu', motore senza la costante): nessuna
  //     pretesa. Non e' prudenza generica — e' che quel giallo sarebbe
  //     INELIMINABILE: `_persistSem` scrive solo quando il numero si sa,
  //     quindi nessun re-render lo cancellerebbe, e l'editor resterebbe giallo
  //     per sempre su stem perfetti.
  //   - versione dello stem assente, con motore noto: "semantics". E' lo stem
  //     scritto prima che l'editor registrasse il numero, cioe' OGNI stem
  //     esistente al momento di questa modifica — e siccome il motore e' gia'
  //     passato a 3 (PGE #222), sono tutti stem che il motore rifara' diversi.
  //     Tacere qui vorrebbe dire essere ciechi esattamente nel caso per cui
  //     l'asse e' stato scritto. E quel giallo si spegne da solo al primo
  //     giro, anche a vuoto: il motore emette `stream-done` anche per gli
  //     stream che salta (`cached: true`, render_pipeline.py), e backend.js
  //     registra la versione su quell'evento come su un render vero.
  //
  // Cioe' la regola del repo applicata bene: un render di troppo, mai uno di
  // meno.
  function staleReason(lastFp, currentFp, sem) {
    if (lastFp !== currentFp) return "yaml";
    const rendered = sem && sem.rendered;
    const engine = sem && sem.engine;
    if (engine == null) return null;
    if (rendered == null) return "semantics";
    return rendered !== engine ? "semantics" : null;
  }

  // The core stale/fresh/never decision, shared by summarize + statusForStream.
  // hasStem is a boolean. !lastFp uses falsiness on purpose (undefined / "" / 0
  // all read as never), matching the original `!last` guard in app.jsx.
  // `sem` is optional: omitting it is the pre-#133 behaviour exactly.
  function classifyStream(lastFp, currentFp, hasStem, sem) {
    if (!lastFp || !hasStem) return STATES.NEVER;
    return staleReason(lastFp, currentFp, sem) === null ? STATES.FRESH : STATES.STALE;
  }

  // Aggregate fresh/stale/never counts across all streams. hasStem is (id)=>bool.
  // `sem` is optional: { rendered: {[streamId]: version}, engine: version|null }.
  function summarize(streams, currentFps, lastRenderedFps, hasStem, sem) {
    let fresh = 0, stale = 0, never = 0;
    for (const s of streams) {
      const state = classifyStream(lastRenderedFps[s.id], currentFps[s.id], hasStem(s.id),
                                   semFor(sem, s.id));
      if (state === STATES.FRESH) fresh++;
      else if (state === STATES.STALE) stale++;
      else never++;
    }
    return { fresh, stale, never, total: streams.length };
  }

  // La coppia { rendered, engine } per un singolo stream, dalla forma che
  // app.jsx tiene in stato. Una funzione sola perche' la usano sia summarize
  // sia statusForStream, e sbagliarla in uno dei due significa due pallini che
  // non concordano sullo stesso stem.
  function semFor(sem, streamId) {
    if (!sem) return null;
    return { rendered: (sem.rendered || {})[streamId], engine: sem.engine };
  }

  // Per-stream status object consumed by Timeline.jsx (ClipRenderStatus).
  // ctx = { currentFps, lastRenderedFps, hasStem:(id)=>bool, running:bool,
  //         currentStreamId, streamProgress, sem }.
  function statusForStream(streamId, ctx) {
    if (ctx.running && ctx.currentStreamId === streamId) {
      return { state: STATES.RUNNING, progress: ctx.streamProgress[streamId] || 0, tooltip: TOOLTIPS.running };
    }
    const sem = semFor(ctx.sem, streamId);
    const lastFp = ctx.lastRenderedFps[streamId];
    const state = classifyStream(lastFp, ctx.currentFps[streamId], ctx.hasStem(streamId), sem);
    if (state === STATES.STALE && staleReason(lastFp, ctx.currentFps[streamId], sem) === "semantics") {
      return { state, tooltip: TOOLTIPS.staleSemantics };
    }
    return { state, tooltip: TOOLTIPS[state] };
  }

  window.PGERenderStatus = {
    STATES,
    TOOLTIPS,
    fingerprintAll,
    classifyStream,
    staleReason,
    summarize,
    statusForStream,
  };
})();
