/* =============================================================================
 * history-core.js — pure undo/redo stack mechanics (cap 200, gesture collapse).
 *
 * Extracted from app.jsx (#58, follow-up of #44) so the history bookkeeping can
 * be unit-tested in node like envelope-utils.js. No React, no DOM — operates on
 * a plain history object { past, future, snapshotBeforeGesture, inGesture }.
 * Attaches to window.PGEHistoryCore.
 *
 * app.jsx keeps the React glue: the [data, _setDataRaw] state, the historyRef,
 * the setHistVer re-render bump, the window.PGEHistory publication, the keyboard
 * shortcuts and the freeze-on-resize confirm in endGesture. Those wrappers call
 * into this module and bump setHistVer when a function returns `bumped: true`.
 *
 * Invariants preserved verbatim from app.jsx:
 *  - record(h, prev) is only called after the caller has confirmed next !== prev.
 *  - the 200-cap drops the OLDEST entry (Array.shift), in both record + commitGesture.
 *  - a new mutation (record / commitGesture) clears `future`; undo/redo never do.
 *  - undo/redo on an empty stack return the current value unchanged, bumped:false.
 * ===========================================================================*/

(function () {
  const CAP = 200;

  function create() {
    return { past: [], future: [], snapshotBeforeGesture: null, inGesture: false };
  }

  // Push a snapshot onto `past`, enforce the cap (drop oldest), clear redo stack.
  function _push(h, snapshot) {
    h.past.push(snapshot);
    if (h.past.length > CAP) h.past.shift();
    h.future = [];
  }

  // Record a free-form mutation. During a gesture, snapshot the pre-gesture state
  // once (so the whole gesture collapses to a single undo step) without pushing.
  // Outside a gesture, push immediately. Returns true when the caller should bump
  // the history version (i.e. a real push happened).
  function record(h, prev) {
    if (h.inGesture) {
      if (h.snapshotBeforeGesture == null) h.snapshotBeforeGesture = prev;
      return false;
    }
    _push(h, prev);
    return true;
  }

  function beginGesture(h) {
    h.inGesture = true;
    h.snapshotBeforeGesture = null;
  }

  // End a gesture: if any mutation happened during it, push the pre-gesture
  // snapshot as the single undo step. Returns true when a push happened.
  // (The freeze-on-resize confirmation stays in app.jsx, after this call.)
  function commitGesture(h) {
    let bumped = false;
    if (h.snapshotBeforeGesture != null) {
      _push(h, h.snapshotBeforeGesture);
      bumped = true;
    }
    h.inGesture = false;
    h.snapshotBeforeGesture = null;
    return bumped;
  }

  function undo(h, cur) {
    if (!h.past.length) return { data: cur, bumped: false };
    const prev = h.past.pop();
    h.future.push(cur);
    return { data: prev, bumped: true };
  }

  function redo(h, cur) {
    if (!h.future.length) return { data: cur, bumped: false };
    const nxt = h.future.pop();
    h.past.push(cur);
    return { data: nxt, bumped: true };
  }

  function reset(h) {
    h.past = [];
    h.future = [];
    h.snapshotBeforeGesture = null;
    h.inGesture = false;
  }

  function canUndo(h) { return h.past.length > 0; }
  function canRedo(h) { return h.future.length > 0; }
  // Whether a gesture is currently open. app.jsx reads this from updateStream
  // (the freeze-on-resize path) instead of poking historyRef.current.inGesture,
  // so the history object's shape stays owned by this module.
  function isInGesture(h) { return h.inGesture; }

  window.PGEHistoryCore = {
    CAP,
    create,
    record,
    beginGesture,
    commitGesture,
    undo,
    redo,
    reset,
    canUndo,
    canRedo,
    isInGesture,
  };
})();
