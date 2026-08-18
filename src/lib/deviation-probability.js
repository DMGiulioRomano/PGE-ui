/* =============================================================================
 * deviation-probability.js — single source of truth for classifying a stream's
 * `deviation_probability` (the engine key formerly named `dephase`, renamed in
 * PGE #204 with no back-compat alias).
 *
 * The editor distinguishes four modes (off / implicit / global / perParam).
 * The discriminator used to be inlined as "Array.isArray = global env, any
 * other object = per-param" in three places (Inspector.detectDeviationProbMode,
 * EnvelopeEditor.listEnvelopes, envelope-utils walk). That inline rule broke as
 * soon as an envelope took the typed `{type, points}` object form: wrapEnv
 * (envelope-loops.js) emits that form for any pure-breakpoint envelope with a
 * non-linear GLOBAL interpolation (e.g. cubic), so choosing "cubic" on a global
 * envelope turned the value into an object and the inline rule mis-read it as
 * per-param — closing the envelope and flipping the UI mode.
 *
 * This module centralizes the rule and mirrors the engine's authority,
 * GateFactory._classify_deviation_probability, which tests envelope-like
 * (Envelope.is_envelope_like: a list of breakpoints OR a dict carrying 'points')
 * BEFORE the dict→SPECIFIC (per-param) branch. So `{type, points}` is a GLOBAL
 * envelope, never per-param.
 *
 * Depends on window.PGEYaml (DEVIATION_PROB_IMPLICIT sentinel) and window.PGEEnv
 * (isTypedEnv) — both read at call time, so load order only requires them
 * present before these functions run. Attaches to window.PGEDeviationProb.
 * ===========================================================================*/

(function () {
  /* Is a VALUE an envelope? True for a breakpoint array [[t,v],…] and for the
     typed `{type, points}` object form. Used both for the top-level global
     value and for each per-param value. Mirrors the dict half of the engine's
     Envelope.is_envelope_like (a dict with 'points'). */
  function isEnvValue(v) {
    if (Array.isArray(v)) return true;
    return !!(window.PGEEnv && window.PGEEnv.isTypedEnv(v));
  }

  /* Classify `deviation_probability` into "off" | "implicit" | "global" |
     "perParam". Order matches GateFactory._classify_deviation_probability:
     envelope-like wins over the generic dict (per-param) check, so a typed
     global envelope stays global. */
  function mode(d) {
    if (d === window.PGEYaml.DEVIATION_PROB_IMPLICIT) return "implicit";
    // Key absent (undefined) and explicit false both mean off (engine default
    // off). Only the DEVIATION_PROB_IMPLICIT sentinel above means implicit 1%.
    if (d === false || d == null) return "off";
    if (typeof d === "number") return "global";
    if (isEnvValue(d)) return "global";          // [[t,v],…] or {type, points}
    if (typeof d === "object") return "perParam"; // dict without 'points'
    return "off";
  }

  /* Le chiavi che il motore consulta davvero in modalità per-parametro: una
     per `deviation_probability_key` dichiarata nei ParameterSpec. Le altre
     chiavi di quel dict non vengono mai lette (nessun gate le chiede), quindi
     non sono un errore e non vanno validate. */
  const PARAM_KEYS = ["volume", "pan", "duration", "pitch", "pointer",
                      "reverse", "read_direction", "envelope"];

  /* Un corpo destinato a diventare envelope si costruisce? Ritorna null se sì,
     altrimenti il motivo: "empty" (nessun breakpoint) o "shape" (niente di
     riconoscibile dentro).

     È la metà conservativa del builder del motore: segnala solo i corpi che
     NON possono essere un envelope in nessuna lettura. Una lista con un
     elemento buono e uno rotto (`[[0,1], 'x']`) il motore la rifiuta lo stesso,
     qui passa — meglio un avviso in meno che un avviso su uno YAML che rende. */
  function _envBodyError(v) {
    const E = window.PGEEnv;
    if (Array.isArray(v)) {
      if (v.length === 0) return "empty";
      const any = v.some(it => E.isBreakpoint(it) || E.isBPGroup(it) || E.isCompactBlock(it));
      return any ? null : "shape";
    }
    if (v && typeof v === "object") {
      // Il builder legge `points` senza guardare se c'è: un dict che non ce
      // l'ha alza KeyError, ed è il terzo dei corpi malformati di PGE #209.
      if (!Array.isArray(v.points)) return "shape";
      return _envBodyError(v.points);
    }
    return null;
  }

  /* I corpi che il motore rifiuta (PGE #209). Prima li accettava in silenzio e
     li trattava come probabilità 100% — il render riusciva producendo
     l'opposto di quanto scritto; ora solleva e il render esce con errore.

     Nessuno di questi corpi è producibile dai controlli dell'Inspector (il
     verso "off" scrive `false`, l'EnvelopeEditor rifiuta di svuotare un
     envelope): arrivano dal tab Raw o da uno YAML scritto a mano, e allora
     tanto vale dirlo prima del render invece che dopo.

     Ritorna null se valido, altrimenti { kind, reason?, param?, value }:
       "type" → il corpo non è bool | numero | envelope | dict per-parametro
       "env"  → un corpo che vuole essere envelope e non si costruisce
     `param` è presente quando il colpevole è una chiave del dict per-parametro
     — la stessa che il motore nomina come `deviation_probability.<chiave>`.
     Puro: niente DOM, niente chiamate al motore. */
  function error(d) {
    if (d === undefined || d === null || d === false) return null;
    if (d === window.PGEYaml.DEVIATION_PROB_IMPLICIT) return null;
    // `true` non è un errore: per il motore è un numero, e float(True) è 1%.
    if (typeof d === "number" || typeof d === "boolean") return null;
    if (typeof d !== "object") return { kind: "type", value: d };

    if (isEnvValue(d)) {
      const reason = _envBodyError(d);
      return reason ? { kind: "env", reason, value: d } : null;
    }

    for (const k of PARAM_KEYS) {
      if (!(k in d)) continue;
      const v = d[k];
      // chiave a null = range-only per quel parametro, non un envelope vuoto
      if (v === null || typeof v === "number" || typeof v === "boolean") continue;
      if (typeof v !== "object") return { kind: "type", param: k, value: v };
      const reason = _envBodyError(v);
      if (reason) return { kind: "env", reason, param: k, value: v };
    }
    return null;
  }

  window.PGEDeviationProb = { mode, isEnvValue, error, PARAM_KEYS };
})();
