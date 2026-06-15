/* tweaks-store.js
 * Pure merge for the editor's preferences store (window.PGE_TWEAKS / `tweaks`).
 *
 * Extracted so app.jsx's useTweaks hook stays thin React glue and the
 * dual-signature merge — setTweak("key", val) OR setTweak({ k: v, ... }) — is
 * covered by tests/node/test-tweaks-store.js. This replaces the merge that used
 * to live in the (removed) design-tool tweaks-panel, minus its host postMessage
 * / "tweakchange" side effects. window.* global, no modules. */
(function () {
  // Accepts either applyEdit(prev, "key", val) or applyEdit(prev, { k: v, ... }).
  // The object form lets a useState-style call merge several keys without writing
  // a literal "[object Object]" key. Returns a new object (never mutates prev).
  function applyEdit(prev, keyOrEdits, val) {
    const edits = (typeof keyOrEdits === "object" && keyOrEdits !== null)
      ? keyOrEdits
      : { [keyOrEdits]: val };
    return { ...prev, ...edits };
  }

  window.PGETweaks = { applyEdit };
})();
