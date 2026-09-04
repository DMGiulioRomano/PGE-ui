/* =============================================================================
 * bounds.js — fold the engine's parameter clamps into the UI's window.PGE_BOUNDS.
 *
 * server.py's GET /bounds AST-parses PythonGranularEngine's
 * parameter_definitions.py + pitch_unit.py and returns:
 *
 *   { params: { <engine_name>: { min_val, max_val, min_range, max_range,
 *                                default_jitter, variation_mode } },
 *     pitch:  { semitones|cents|quarter_tone|eighth_tone|ratio: { min, max, rangeMax },
 *               edoFactor: <number> },
 *     output_sr: <number> }        // DEFAULT_OUTPUT_SR, shared/constants.py
 *
 * The UI clamps live under UI-specific keys (density, durationRange, …) in
 * window.PGE_BOUNDS (yaml-bridge.js, static fallback). ENGINE_PARAM_MAP says
 * which engine parameter (and which field pair — the value bounds min_val/max_val
 * or the range bounds min_range/max_range) feeds each UI key. mergeEngineBounds()
 * is pure (node-tested in test-bounds.js); apply() installs the merge at boot
 * (app.jsx). Keys with no engine datum, and a null max_val (loop_* — the engine
 * bound is sample-driven), keep their static fallback.
 *
 * Exports (window.PGEBounds): ENGINE_PARAM_MAP, resolveOutputSr(raw),
 * mergeEngineBounds(base, raw), apply(raw)
 * ===========================================================================*/
(function () {
  // UI key → { param: <engine GRANULAR_PARAMETERS name>, field: "value" | "range" }.
  // "value" → {min_val, max_val}; "range" → {min_range, max_range}.
  // Pitch bounds are handled separately (engine ships them pre-computed per unit).
  // UI controls with no engine counterpart (voices onset_offset, pan spread,
  // deviation_probability %, grain-env curve) are intentionally absent: they
  // keep the static fallback.
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

  /* Il sample rate di output del motore, o null se non si sa.
   *
   * Due sorgenti in ordine di autorità: il payload di /bounds (il motore vero,
   * letto dai suoi sorgenti) e poi il letterale statico pubblicato da
   * yaml-bridge.js. Un valore che non è un sample rate — 0, negativo, NaN,
   * Infinity, una stringa — non è un ripiego: è un guasto, e vale come
   * "non lo so" invece di propagarsi dentro una divisione.
   *
   * Pura, e senza `raw` risponde comunque: serve anche a chi il payload non
   * ce l'ha (file://). */
  function resolveOutputSr(raw) {
    const candidates = [raw && raw.output_sr, window.PGE_OUTPUT_SR];
    for (const v of candidates) {
      if (typeof v === "number" && isFinite(v) && v > 0) return v;
    }
    return null;
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
    // dinamico che l'AST-parser dei bound non vede.
    //
    // Il sample rate viene dal MOTORE quando c'è (`raw.output_sr`,
    // `DEFAULT_OUTPUT_SR` letto da engine_introspect) e dal letterale di
    // yaml-bridge.js solo quando non c'è — file://, bridge giù, o un motore
    // senza la costante. L'ordine è quello e non l'inverso: il letterale è un
    // fallback statico come window.PGE_BOUNDS, non una seconda verità.
    // Trascritto e basta era giusto finché il motore non lo muoveva, e nel
    // verso brutto — con il motore a 44100 e la UI ferma a 48000 il min
    // diventa 1/48000 < 1/44100, cioè un grano più corto di un campione vero.
    //
    // `resolveOutputSr` scarta ciò che non è un sample rate (0, negativo,
    // NaN): senza, `1/0` è Infinity e `1/undefined` è NaN, e un min a NaN non
    // fa mai scattare un confronto — spegnerebbe in silenzio ogni clamp a
    // valle. Quando non si sa niente si lascia il bound del motore com'è:
    // meglio quello che falsarlo. Questa funzione resta pura (node-testata),
    // quindi legge window.PGE_OUTPUT_SR ma non lo scrive: a installarlo è
    // apply().
    // Il pavimento e' `1/sr` e basta, non `Math.min(base.min, 1/sr)` come era
    // scritto. Non e' un rafforzamento: e' la regola del motore, che
    // SOSTITUISCE il min dichiarato invece di abbassarlo
    // (`get_parameter_bounds(..., output_sr=…)` in parameter_definitions.py
    // ritorna `min_val=1.0/output_sr`). I due coincidono finche' il min
    // dichiarato sta SOPRA un campione — oggi `grain_duration.min_val` e'
    // 0.001 s, cioe' 48 campioni a 48 kHz, e quella premessa e' pretesa da
    // test-bounds-parity.js invece di essere ricopiata qui e basta. Ma
    // il vincolo ha un verso solo: sotto un campione non c'e' niente da
    // rendere, quindi un min dichiarato piu' BASSO non deve vincere — e il
    // `Math.min` gli faceva vincere, cioe' ammetteva una durata sub-campione.
    //
    // Il caso non e' teorico da quando il payload porta `output_sr`: con i
    // bound assenti e il solo sample rate presente, `out.grainDur.min` e'
    // ancora il letterale statico `1/48000`, e `Math.min(1/48000, 1/44100)`
    // teneva il pavimento del sample rate SBAGLIATO — cioe' il difetto che
    // questa lettura esiste per chiudere, rientrato dalla porta di servizio.
    // La divergenza dichiarata in test-bounds-parity.js dice esattamente
    // questo: «il minimo vero e' 1 campione», non «il piu' piccolo dei due».
    const sr = resolveOutputSr(raw);
    if (out.grainDur && sr !== null) {
      out.grainDur = Object.assign({}, out.grainDur, { min: 1 / sr });
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

  /* Install the merged bounds onto window.PGE_BOUNDS. Consumers read
   * window.PGE_BOUNDS at use-time (EnvelopeEditor, Inspector, envelope-loops),
   * so swapping the object is enough. Returns the new object.
   *
   * Installa anche window.PGE_OUTPUT_SR, e non è un extra: il sample rate ha
   * QUATTRO lettori, e solo uno è la riga qui sopra. Gli altri tre lo leggono
   * da window a ogni chiamata —
   *
   *   - `grainUnitFactor` (envelope-utils.js): `1/sr` è il fattore di
   *     `grain.duration_unit: samples`, e `convertGrainDurationUnit` con quel
   *     fattore RISCRIVE `duration`/`duration_range` nello YAML. Qui un sample
   *     rate sbagliato non stringe un clamp: scrive numeri sbagliati.
   *   - Inspector.jsx (due tooltip) e app.jsx (la riga di stato) lo mostrano.
   *
   * Scriverlo dentro mergeEngineBounds l'avrebbe resa impura; lasciarlo al
   * solo letterale avrebbe corretto il clamp e lasciato la conversione al
   * numero trascritto — il lettore che sbaglia peggio. Quindi sta qui, nella
   * funzione che per contratto tocca window.
   *
   * Senza un numero utilizzabile non si scrive niente: il letterale di
   * yaml-bridge.js resta in piedi, che è la condizione di file://. */
  function apply(raw) {
    const sr = resolveOutputSr(raw);
    if (sr !== null) window.PGE_OUTPUT_SR = sr;
    window.PGE_BOUNDS = mergeEngineBounds(window.PGE_BOUNDS, raw);
    return window.PGE_BOUNDS;
  }

  window.PGEBounds = { ENGINE_PARAM_MAP, resolveOutputSr, mergeEngineBounds, apply };
})();
