/* =============================================================================
 * tracks.js — the track model: a lane can hold more than one stream.
 *
 * Until now the timeline had no track entity at all: lane *i* was stream *i*,
 * because Timeline.jsx mapped `streams` twice in parallel (heads and lanes).
 * A track is the missing layer — an ordered, named group of streams that share
 * one lane.
 *
 * WHERE THE GROUPING LIVES (and why not on the stream)
 * ----------------------------------------------------
 * A per-stream `track:` key would be hashed: the engine's
 * FINGERPRINT_IGNORE_KEYS holds only {solo, mute}
 * (stream_cache_manager.py), and the browser's FP_IGNORE (backend.js) is
 * likewise a deny-list. So reorganizing lanes would mark every touched stem
 * DIRTY and force a re-render that changes not one sample.
 *
 * The grouping is therefore a single TOP-LEVEL key, `ui_tracks`:
 *
 *   ui_tracks:
 *     - id: t1
 *       name: bassi
 *       streams: [stream1, stream4]
 *     - id: stream2
 *       name: stream2
 *       streams: [stream2]
 *
 * It rides for free on three existing properties:
 *   - KNOWN_PROJECT_KEYS (yaml-bridge.js) does not know it, so `parse` puts it
 *     in `data._extra` and `dataToYaml` re-emits it verbatim. No round-trip work.
 *   - The engine's `load_yaml` reads only `seed` and `streams`, and nothing
 *     validates the top level, so an unknown key is silently ignored.
 *   - The stem fingerprint is computed per STREAM, so a top-level key can never
 *     enter it. Reorganizing lanes invalidates nothing.
 * And unlike `laneHeights` (localStorage) it travels with the file.
 *
 * One engine footnote, corrected: `_eval_math_expressions` recurses as
 * `{k: eval(v)}` — it walks VALUES, never KEYS. Track names here are values
 * (`name:`), so a name containing parentheses ("mix (final)") does get matched
 * by its `\(...\)` pattern; the eval fails, the helper prints a warning and
 * returns the string untouched. Nothing is lost on disk either way: the engine
 * never writes YAML back, PGE-ui is the only writer.
 *
 * MATERIALIZATION
 * ---------------
 * `deriveTracks` is total and self-healing: unknown or duplicated stream ids
 * are dropped, emptied tracks disappear, and any stream `ui_tracks` does not
 * mention becomes its own singleton track (appended in `data.streams` order).
 * With the key absent this yields exactly one track per stream, in file order —
 * today's behaviour, bit for bit.
 *
 * `applyTracks` is the inverse and holds the invariant that keeps the file
 * clean: it reorders `data.streams` into visual order (which is what reordering
 * lanes has always done) and writes `ui_tracks` ONLY when the grouping says
 * something the stream order alone cannot — a lane with two streams, a renamed
 * lane, an id that is not its stream's. A project that never groups anything
 * never grows the key. Note that a single rename or a single group materializes
 * the WHOLE list — the price of a form that declares its own order.
 *
 * That reorder is only safe because the engine's randomness does not depend on
 * a stream's position in the list: `_create_streams` iterates without an index
 * and every stochastic site takes an RNG derived from
 * (seed, stream_id, component), so "solo/mute, stem caching and materialization
 * order do not alter the grains of other streams" (generator.py, its own
 * words). If that ever changes, every grouping gesture starts rewriting audio.
 *
 * A track's id is also the `laneHeights` key (Timeline.jsx, localStorage).
 * A singleton track's id is its stream id, so heights saved before tracks
 * existed keep applying.
 *
 * Exposed as window.PGETracks. Pure — no React, no DOM. Node-tested in
 * tests/node/test-tracks.js.
 * =========================================================================== */
(function () {
  "use strict";

  const TRACKS_KEY = "ui_tracks";

  /* ---------- derive ---------- */

  /* data → ordered [{id, name, streamIds}]. Total over well-formed input: every
   * live stream appears in exactly one track, whatever `ui_tracks` says (or
   * fails to say). The one exception is two streams sharing an id, which land
   * on one lane — a duplicate id is already fatal a layer down (it is the stem
   * filename and the cache-manifest key), and no `ui_tracks` could round-trip
   * two lanes pointing at the same id. */
  function deriveTracks(data) {
    const streams = (data && Array.isArray(data.streams)) ? data.streams : [];
    // Stream ids are normalized to strings on both sides. `parse` already
    // coerces them (yaml-bridge), but this lib is fed hand-built data too, and
    // a number on one side and its string on the other match nothing — which
    // would drop the grouping silently and let the next save erase the key.
    const live = new Set(streams.map(s => String(s.id)));
    const raw = (data && data._extra && Array.isArray(data._extra[TRACKS_KEY]))
      ? data._extra[TRACKS_KEY] : [];

    const placed = new Set();
    const usedIds = new Set();
    const out = [];

    // A singleton lane's id IS its stream id, so track ids and stream ids share
    // one namespace — and that id is the `laneHeights` key. Reserve up front the
    // ids of the streams `ui_tracks` does not place: each will become a
    // singleton lane and needs its own name. Without this a hand-written group
    // calling itself `stream2` takes the name first, and the real stream2's lane
    // comes out as `stream2_`, silently losing its saved height.
    {
      const claimed = new Set();
      for (const t of raw) {
        if (!t || typeof t !== "object") continue;
        for (const entry of (Array.isArray(t.streams) ? t.streams : [])) {
          const id = String(entry);
          if (live.has(id)) claimed.add(id);
        }
      }
      for (const s of streams) {
        const sid = String(s.id);
        if (!claimed.has(sid)) usedIds.add(sid);
      }
    }

    const claim = (want, fallback) => {
      let id = (want != null && String(want)) || String(fallback);
      while (usedIds.has(id)) id = id + "_";
      usedIds.add(id);
      return id;
    };

    for (const t of raw) {
      if (!t || typeof t !== "object") continue;
      const ids = [];
      for (const entry of (Array.isArray(t.streams) ? t.streams : [])) {
        const id = String(entry);
        // `placed` is consulted AND updated per id: a list repeating the same
        // stream ("stream1, ghost, stream1") must not lay it out twice, or the
        // clip is drawn on one lane and dragged from the other.
        if (!live.has(id) || placed.has(id)) continue;
        placed.add(id);
        ids.push(id);
      }
      if (!ids.length) continue;              // lost every stream → the track goes
      out.push({
        id: claim(t.id, ids[0]),
        name: t.name != null ? String(t.name) : ids[0],
        streamIds: ids,
      });
    }

    // Streams `ui_tracks` never mentioned (hand-edited Raw tab, older file):
    // each gets its own lane, appended in file order. The next write
    // materializes them.
    for (const s of streams) {
      const sid = String(s.id);
      if (placed.has(sid)) continue;
      placed.add(sid);
      // Spend the reservation made above. `claim` still runs, so a `streams`
      // list that repeats an id (hand-edited file) gets the second lane
      // suffixed rather than colliding on the React key.
      usedIds.delete(sid);
      out.push({ id: claim(sid, sid), name: sid, streamIds: [sid] });
    }
    return out;
  }

  /* True when the track layout carries no information the plain stream order
   * does not already carry: one stream per lane, unrenamed, id == stream id. */
  function isTrivial(tracks) {
    return (tracks || []).every(t =>
      t.streamIds.length === 1 &&
      t.id === t.streamIds[0] &&
      t.name === t.streamIds[0]);
  }

  /* ---------- apply ---------- */

  /* tracks → data. Reorders `data.streams` into visual order and writes (or
   * removes) `_extra.ui_tracks`. Never mutates its arguments. */
  function applyTracks(data, tracks) {
    const streams = (data && Array.isArray(data.streams)) ? data.streams : [];
    const byId = new Map(streams.map(s => [String(s.id), s]));
    const ordered = [];
    for (const id of visualOrder(tracks)) {
      const s = byId.get(id);
      if (s) { ordered.push(s); byId.delete(id); }
    }
    // Anything the tracks do not mention keeps its place at the end rather than
    // vanishing: `streams` is the source of truth for existence, tracks only
    // for layout.
    for (const s of streams) if (byId.has(String(s.id))) ordered.push(s);

    const next = { ...data, streams: ordered };
    const extra = { ...(data && data._extra) };
    if (isTrivial(tracks)) delete extra[TRACKS_KEY];
    else extra[TRACKS_KEY] = tracks.map(t => ({
      id: t.id, name: t.name, streams: [...t.streamIds],
    }));
    if (Object.keys(extra).length) next._extra = extra;
    else delete next._extra;
    return next;
  }

  /* ---------- queries ---------- */

  function visualOrder(tracks) {
    const ids = [];
    for (const t of (tracks || [])) for (const id of t.streamIds) ids.push(id);
    return ids;
  }

  function trackOfStream(tracks, streamId) {
    return (tracks || []).find(t => t.streamIds.includes(streamId)) || null;
  }

  function trackIndexOfStream(tracks, streamId) {
    return (tracks || []).findIndex(t => t.streamIds.includes(streamId));
  }

  function takenIds(tracks) {
    const taken = new Set();
    for (const t of (tracks || [])) {
      taken.add(t.id);
      for (const id of t.streamIds) taken.add(id);
    }
    return taken;
  }

  /* A fresh track id, unique against both existing track ids and stream ids —
   * a singleton track's id IS its stream id, so the two namespaces share one
   * space and a collision would silently merge two lanes. */
  function newTrackId(tracks) {
    const taken = takenIds(tracks);
    let n = 1;
    while (taken.has("t" + n)) n++;
    return "t" + n;
  }

  /* A lane holding exactly these streams. A lone stream keeps its own id as the
   * lane id whenever that is free, so pulling the last clip out of a group
   * lands back on the trivial layout — and the `ui_tracks` key disappears
   * instead of lingering as a `t1` that says nothing. */
  function freshTrack(tracks, ids) {
    const taken = takenIds(tracks);
    const id = (ids.length === 1 && !taken.has(ids[0])) ? ids[0] : newTrackId(tracks);
    return { id, name: ids[0], streamIds: [...ids] };
  }

  /* ---------- mutations (all pure) ---------- */

  function prune(tracks) {
    return tracks.filter(t => t.streamIds.length > 0);
  }

  function reorderTracks(tracks, srcIdx, dstIdx) {
    const arr = [...(tracks || [])];
    if (srcIdx === dstIdx || srcIdx < 0 || srcIdx >= arr.length) return tracks;
    const dst = Math.max(0, Math.min(arr.length - 1, dstIdx));
    const [m] = arr.splice(srcIdx, 1);
    arr.splice(dst, 0, m);
    return arr;
  }

  /* Move streams onto the lane at `dstIdx`.
   *   default    → they join the track already living there
   *   {extract}  → they go into a NEW track inserted at that position
   * `dstIdx` indexes the layout as the caller sees it, before any emptied
   * source track is pruned. */
  function moveStreams(tracks, streamIds, dstIdx, opts) {
    const ids = (streamIds || []).filter(Boolean);
    if (!ids.length) return tracks;
    const extract = !!(opts && opts.extract);
    const dstTrack = (tracks || [])[dstIdx];
    if (!extract && !dstTrack) return tracks;
    const idSet = new Set(ids);

    // A no-op must not churn history. The target lane already holding exactly
    // these streams means the layout is what the drop asks for — under
    // `extract` too, since extracting them again rebuilds the same lane.
    // The check lives HERE and not in the caller: a multi-lane selection
    // dropped back on the grabbed clip's own lane is a real move (it gathers
    // the others), and only the target's contents can tell the two apart.
    if (dstTrack && dstTrack.streamIds.length === ids.length &&
        ids.every(id => dstTrack.streamIds.includes(id))) return tracks;

    let next = (tracks || []).map(t => ({
      ...t, streamIds: t.streamIds.filter(id => !idSet.has(id)),
    }));

    if (extract) {
      const at = Math.max(0, Math.min(next.length, dstIdx));
      next.splice(at, 0, freshTrack(prune(next), ids));
    } else {
      next = next.map(t => t.id === dstTrack.id
        ? { ...t, streamIds: [...t.streamIds, ...ids] }
        : t);
    }
    return prune(next);
  }

  /* Paste lands next to its original: the copy joins the track the source
   * stream sits in. An unknown source (its track was deleted meanwhile) falls
   * back to a lane of its own at the end. */
  function addStreamToTrackOf(tracks, srcStreamId, newStreamId) {
    const idx = trackIndexOfStream(tracks, srcStreamId);
    if (idx === -1) {
      return [...(tracks || []), freshTrack(tracks, [newStreamId])];
    }
    return tracks.map((t, i) => i === idx
      ? { ...t, streamIds: [...t.streamIds, newStreamId] }
      : t);
  }

  /* A brand-new stream gets its own lane at `laneIdx` (or last). */
  function insertStreamTrack(tracks, streamId, laneIdx) {
    const arr = [...(tracks || [])];
    const t = freshTrack(arr, [streamId]);
    if (laneIdx != null && laneIdx >= 0 && laneIdx <= arr.length) arr.splice(laneIdx, 0, t);
    else arr.push(t);
    return arr;
  }

  function removeStreams(tracks, streamIds) {
    const idSet = new Set(streamIds || []);
    return prune((tracks || []).map(t => ({
      ...t, streamIds: t.streamIds.filter(id => !idSet.has(id)),
    })));
  }

  function renameTrack(tracks, trackId, name) {
    const clean = String(name == null ? "" : name).trim();
    if (!clean) return tracks;
    return (tracks || []).map(t => t.id === trackId ? { ...t, name: clean } : t);
  }

  window.PGETracks = {
    TRACKS_KEY,
    deriveTracks,
    applyTracks,
    isTrivial,
    visualOrder,
    trackOfStream,
    trackIndexOfStream,
    newTrackId,
    reorderTracks,
    moveStreams,
    addStreamToTrackOf,
    insertStreamTrack,
    removeStreams,
    renameTrack,
  };
})();
