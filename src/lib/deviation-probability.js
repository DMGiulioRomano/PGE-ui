/* =============================================================================
 * deviation-probability.js — single source of truth for classifying a stream's
 * `deviation_probability`.
 *
 * The editor distinguishes four modes (off / implicit / global / perParam).
 * The discriminator used to be inlined as "Array.isArray = global env, any
 * other object = per-param" in three places (Inspector.detectMode,
 * EnvelopeEditor.listEnvelopes, the envelope-utils walk). That inline rule
 * broke as soon as an envelope took the typed `{type, points}` object form:
 * wrapEnv (envelope-loops.js) emits that form for any pure-breakpoint envelope
 * with a non-linear GLOBAL interpolation (e.g. cubic), so choosing "cubic" on a
 * global envelope turned the value into an object and the inline rule mis-read
 * it as per-param — closing the envelope and flipping the UI mode.
 *
 * This module centralizes the rule and mirrors the engine's authority,
 * GateFactory._classify_deviation_probability, which tests envelope-like
 * (Envelope.is_envelope_like: a list of breakpoints OR a dict carrying
 * 'points') BEFORE the dict→SPECIFIC (per-param) branch. So `{type, points}`
 * is a GLOBAL envelope, never per-param.
 *
 * The key was called `dephase` until PGE v7.0.0 (PGE #204); the editor healed
 * the old spelling at parse (yaml-bridge.js), so nothing downstream of the
 * parse ever sees it. #124
 *
 * Depends on window.PGEYaml (DEVIATION_PROBABILITY_IMPLICIT sentinel) and
 * window.PGEEnv (isTypedEnv) — both read at call time, so load order only
 * requires them present before these functions run. Attaches to
 * window.PGEDeviationProbability.
 * ===========================================================================*/

(function () {
  /* Is a deviation_probability VALUE an envelope? True for a breakpoint array
     [[t,v],…] and for the typed `{type, points}` object form. Used both for the
     top-level global value and for each per-param value. Mirrors the dict half
     of the engine's Envelope.is_envelope_like (a dict with 'points'). */
  function isEnvValue(v) {
    if (Array.isArray(v)) return true;
    return !!(window.PGEEnv && window.PGEEnv.isTypedEnv(v));
  }

  /* Classify `deviation_probability` into "off" | "implicit" | "global" |
     "perParam". Order matches GateFactory._classify_deviation_probability:
     envelope-like wins over the generic dict (per-param) check, so a typed
     global envelope stays global. */
  function mode(d) {
    if (d === window.PGEYaml.DEVIATION_PROBABILITY_IMPLICIT) return "implicit";
    // Key absent (undefined) and explicit false both mean off (engine default
    // off). Only the sentinel above means implicit 1%.
    if (d === false || d == null) return "off";
    if (typeof d === "number") return "global";
    if (isEnvValue(d)) return "global";          // [[t,v],…] or {type, points}
    if (typeof d === "object") return "perParam"; // dict without 'points'
    return "off";
  }

  window.PGEDeviationProbability = { mode, isEnvValue };
})();
