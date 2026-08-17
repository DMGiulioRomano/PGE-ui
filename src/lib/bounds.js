/* =============================================================================
 * bounds.js — fold the engine's parameter clamps into the UI's window.PGE_BOUNDS.
 *
 * server.py's GET /bounds AST-parses PythonGranularEngine's
 * parameter_definitions.py + pitch_unit.py and returns:
 *
 *   { params: { <engine_name>: { min_val, max_val, min_range, max_range,
 *                                default_jitter, variation_mode } },
 *     pitch:  { semitones|cents|quarter_tone|eighth_tone|ratio: { min, max, rangeMax },
 *               edoFactor: <number> } }
 *
 * The UI clamps live under UI-specific keys (density, durationRange, …) in
 * window.PGE_BOUNDS (yaml-bridge.js, static fallback). ENGINE_PARAM_MAP says
 * which engine parameter (and which field pair — the value bounds min_val/max_val
 * or the range bounds min_range/max_range) feeds each UI key. mergeEngineBounds()
 * is pure (node-tested in test-bounds.js); apply() installs the merge at boot
 * (app.jsx). Keys with no engine datum, and a null max_val (loop_* — the engine
 * bound is sample-driven), keep their static fallback.
 *
 * Exports (window.PGEBounds): ENGINE_PARAM_MAP, mergeEngineBounds(base, raw), apply(raw)
 * ===========================================================================*/
(function () {
  // Sample rate di output del motore (DEFAULT_OUTPUT_SR lato PGE): config
  // globale, non per-stream. Serve per il minimo di grain_duration a 1 campione.
  const OUTPUT_SR = 48000;

  // UI key → { param: <engine GRANULAR_PARAMETERS name>, field: "value" | "range" }.
  // "value" → {min_val, max_val}; "range" → {min_range, max_range}.
  // Pitch bounds are handled separately (engine ships them pre-computed per unit).
  // UI controls with no engine counterpart (voices onset_offset, pan spread,
  // dephase %, grain-env curve) are intentionally absent: they keep the static
  // fallback.
  const ENGINE_PARAM_MAP = {
    volume:             { param: "volume",              field: "value" },
    volumeRange:        { param: "volume",              field: "range" },
    pan:                { param: "pan",                 field: "value" },
    panRange:           { param: "pan",                 field: "range" },
    fillFactor:         { param: "fill_factor",         field: "value" },
    density:            { param: "density",             field: "value" },
    distribution:       { param: "distribution",        field: "value" },
    speedRatio:         { param: "pointer_speed_ratio", field: "value" },
    grainDur:           { param: "grain_duration",      field: "value" },
    durationRange:      { param: "grain_duration",      field: "range" },
    // read_direction (PGE #207): min_val/max_val = -1/+1. I bound da soli non
    // dicono che sono ammessi SOLO i due estremi — quel vincolo sta nella UI
    // (snapDirection), come per gli altri controlli senza controparte diretta.
    readDirection:      { param: "read_direction",      field: "value" },
    offsetRange:        { param: "pointer_deviation",   field: "range" },
    loopStart:          { param: "loop_start",          field: "value" },
    loopDur:            { param: "loop_dur",            field: "value" },
    loopEnd:            { param: "loop_end",            field: "value" },
    voicesNum:          { param: "num_voices",          field: "value" },
    scatter:            { param: "scatter",             field: "value" },
    voicePitchOffset:   { param: "voice_pitch_offset",  field: "value" },
    voicePointerOffset: { param: "voice_pointer_offset",field: "value" },
    voicePointerRange:  { param: "voice_pointer_range", field: "value" },
  };

  const PITCH_UNITS = ["semitones", "cents", "quarter_tone", "eighth_tone", "ratio"];

  function deepClone(o) {
    if (Array.isArray(o)) return o.map(deepClone);
    if (o && typeof o === "object") {
      const r = {};
      for (const k in o) r[k] = deepClone(o[k]);
      return r;
    }
    return o;
  }

  // Pure: return a new bounds object = base with engine values (raw) folded in.
  // Never mutates `base`. Missing engine data / non-numeric values fall through
  // to base, so the result is always a complete set of clamps.
  function mergeEngineBounds(base, raw) {
    const out = deepClone(base || {});
    if (!raw || typeof raw !== "object") return out;

    const params = raw.params || {};
    for (const uiKey in ENGINE_PARAM_MAP) {
      const { param, field } = ENGINE_PARAM_MAP[uiKey];
      const ep = params[param];
      if (!ep) continue;
      const lo = field === "range" ? ep.min_range : ep.min_val;
      const hi = field === "range" ? ep.max_range : ep.max_val;
      const next = Object.assign({}, out[uiKey]);
      if (typeof lo === "number") next.min = lo;
      // null max (loop_* is sample-driven) keeps the fallback cap.
      if (typeof hi === "number") next.max = hi;
      out[uiKey] = next;
    }

    // grain_duration min = 1 campione (PGE #158). L'engine espone via /bounds
    // solo il min statico (1 ms); il minimo reale è 1/output_sr, un override
    // dinamico che l'AST-parser di /bounds non vede. Lo applichiamo qui (output_sr
    // è una config globale del motore, costante 48000 Hz lato UI).
    if (out.grainDur) {
      out.grainDur = Object.assign({}, out.grainDur, {
        min: Math.min(out.grainDur.min, 1 / OUTPUT_SR),
      });
    }

    if (raw.pitch && typeof raw.pitch === "object") {
      out.pitch = Object.assign({}, out.pitch);
      for (const u of PITCH_UNITS) {
        if (raw.pitch[u] && typeof raw.pitch[u] === "object") {
          out.pitch[u] = Object.assign({}, out.pitch[u], raw.pitch[u]);
        }
      }
      if (typeof raw.pitch.edoFactor === "number") out.pitch.edoFactor = raw.pitch.edoFactor;
    }
    return out;
  }

  // Install the merged bounds onto window.PGE_BOUNDS. Consumers read
  // window.PGE_BOUNDS at use-time (EnvelopeEditor, Inspector, envelope-loops),
  // so swapping the object is enough. Returns the new object.
  function apply(raw) {
    window.PGE_BOUNDS = mergeEngineBounds(window.PGE_BOUNDS, raw);
    return window.PGE_BOUNDS;
  }

  window.PGEBounds = { ENGINE_PARAM_MAP, mergeEngineBounds, apply };
})();
