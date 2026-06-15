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
  const TOOLTIPS = {
    running: "rendering this stream…",
    never:   "this stream has never been rendered",
    fresh:   "rendered and up-to-date with the YAML",
    stale:   "YAML changed since last render — re-render to update",
  };

  // Per-stream fingerprints for the live editor state. Wraps the backend hash;
  // the caller passes the already-resolved output format (app.jsx uses
  // tweaks.outputFormat || "wav").
  function fingerprintAll(streams, format) {
    const out = {};
    for (const s of streams) out[s.id] = window.PGEBackend.fingerprintStream(s, format);
    return out;
  }

  // The core stale/fresh/never decision, shared by summarize + statusForStream.
  // hasStem is a boolean. !lastFp uses falsiness on purpose (undefined / "" / 0
  // all read as never), matching the original `!last` guard in app.jsx.
  function classifyStream(lastFp, currentFp, hasStem) {
    if (!lastFp || !hasStem) return STATES.NEVER;
    if (lastFp === currentFp) return STATES.FRESH;
    return STATES.STALE;
  }

  // Aggregate fresh/stale/never counts across all streams. hasStem is (id)=>bool.
  function summarize(streams, currentFps, lastRenderedFps, hasStem) {
    let fresh = 0, stale = 0, never = 0;
    for (const s of streams) {
      const state = classifyStream(lastRenderedFps[s.id], currentFps[s.id], hasStem(s.id));
      if (state === STATES.FRESH) fresh++;
      else if (state === STATES.STALE) stale++;
      else never++;
    }
    return { fresh, stale, never, total: streams.length };
  }

  // Per-stream status object consumed by Timeline.jsx (ClipRenderStatus).
  // ctx = { currentFps, lastRenderedFps, hasStem:(id)=>bool, running:bool,
  //         currentStreamId, streamProgress }.
  function statusForStream(streamId, ctx) {
    if (ctx.running && ctx.currentStreamId === streamId) {
      return { state: STATES.RUNNING, progress: ctx.streamProgress[streamId] || 0, tooltip: TOOLTIPS.running };
    }
    const state = classifyStream(ctx.lastRenderedFps[streamId], ctx.currentFps[streamId], ctx.hasStem(streamId));
    return { state, tooltip: TOOLTIPS[state] };
  }

  window.PGERenderStatus = {
    STATES,
    TOOLTIPS,
    fingerprintAll,
    classifyStream,
    summarize,
    statusForStream,
  };
})();
