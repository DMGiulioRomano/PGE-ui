/* =============================================================================
 * yaml-bridge.js — convert between the editor's in-memory data shape and
 * PythonGranularEngine's YAML format.
 *
 * The editor uses camelCase JS (id, timeMode, densityEnv) with parallel
 * scalar/envelope fields (density: number | densityEnv: array). The engine
 * uses snake_case YAML (stream_id, time_mode) with a single field that can
 * be either scalar OR envelope.
 *
 * Exports (window.PGEYaml):
 *   parse(text, opts?)        → { project, title, duration, streams, … }
 *   serialize(data)           → yaml text
 *   emptyProject(name)        → data object for a new project
 *   roundTripDiff(data)       → array of { path, jsBefore, jsAfter } diffs
 *                              (empty array == lossless)
 *
 * Round-trip notes:
 *   - Comments are lost.
 *   - Key order is normalised.
 *   - Numeric precision unchanged (no rounding) but YAML may emit `1` for `1.0`.
 *   - Unknown stream-level keys are preserved verbatim under `_extra`;
 *     unknown keys inside pointer/grain/pitch/voices are preserved under
 *     `<block>._extra` (those blocks are rebuilt in full on serialize).
 *   - Loop entries inside envelopes (5-tuples with nested breakpoints) pass
 *     through unchanged.
 *   - dephase keeps all engine states: absent (off) | false (off) |
 *     null = implicit 1% (stored as the DEPHASE_IMPLICIT sentinel string,
 *     because parse/serialize plumbing collapses null and undefined) |
 *     scalar | envelope-array | per-param object.
 *   - time_mode: absence is preserved (engine default is "absolute");
 *     new streams created by the UI write `time_mode: normalized` explicitly.
 * ===========================================================================*/

(function () {
  if (!window.jsyaml) {
    console.warn("js-yaml not loaded — yaml round-trip disabled");
  }

  // Engine bounds — STATIC FALLBACK for the UI clamps. These literals mirror
  // parameter_definitions.py / pitch_unit.py and are what the editor uses when
  // it can't reach the bridge (file:// with no server.py). When the bridge is
  // up, bounds.js fetches GET /bounds (the engine source, AST-parsed) and
  // overrides these via window.PGEBounds.apply() — so the live values track the
  // engine. Keys are the UI's own names; the engine→UI mapping (incl. value vs
  // range fields) lives in bounds.js (ENGINE_PARAM_MAP).
  window.PGE_BOUNDS = {
    volume:      { min: -120, max: 12 },
    volumeRange: { min: 0, max: 24 },
    pan:         { min: -3600, max: 3600 },
    panRange:    { min: 0, max: 360 },
    fillFactor:  { min: 0.001, max: 50 },
    offsetRange: { min: 0, max: 1 },
    density:     { min: 0.01, max: 4000 },
    distribution:{ min: 0, max: 1 },
    speedRatio:  { min: -100, max: 100 },
    grainDur:    { min: 1 / 48000, max: 10 },   // min 1 campione (PGE #158)
    durationRange:{ min: 0, max: 10 },
    // loop_* upper bound is sample-driven in the engine (max_val=None); these
    // are the editor's permissive fallback caps.
    loopStart:   { min: 0, max: 3600 },
    loopDur:     { min: 0.005, max: 3600 },
    loopEnd:     { min: 0, max: 3600 },
    voicesNum:   { min: 1, max: 256 },
    scatter:     { min: 0, max: 1 },
    voicePitchOffset:   { min: -48, max: 48 },
    voicePointerOffset: { min: -1, max: 1 },
    voicePointerRange:  { min: 0, max: 1 },
    pitch: {
      semitones:    { min: -36, max: 36, rangeMax: 36 },
      cents:        { min: -3600, max: 3600, rangeMax: 3600 },
      quarter_tone: { min: -72, max: 72, rangeMax: 72 },
      eighth_tone:  { min: -144, max: 144, rangeMax: 144 },
      ratio:        { min: 0.001, max: 8, rangeMax: 2 },
      edoFactor:    3,
    },
  };

  const PALETTE = ["#5C8868","#B89241","#3F8884","#5965A8","#8E5F8E","#C97A6E","#7A8DB0"];

  /* Editor-state sentinel for `dephase: null` (key present, empty value),
   * which the engine reads as "implicit mode, default 1% probability".
   * A plain null cannot represent it in the editor state: it would collapse
   * into undefined (= key absent = off) across `??` plumbing and JSON
   * clipboard copies. A string survives all of those and never collides
   * with legit engine values (bool | number | array | object). */
  const DEPHASE_IMPLICIT = "implicit";

  /* Known stream-level keys we map explicitly. Everything else under a
   * stream node is preserved as-is in `_extra` and re-emitted on serialize. */
  const KNOWN_STREAM_KEYS = new Set([
    "stream_id", "onset", "duration", "sample",
    "time_mode", "distribution_mode", "range_anchor",
    "range_always_active", "time_scale", "clip_strategy", "clip_margin",
    "density", "fill_factor", "distribution",
    "grain", "pointer", "pitch", "voices",
    "pan", "pan_range", "volume", "volume_range",
    "dephase",
    "solo", "mute",
    "rng_group",
  ]);

  /* Known keys inside the block nodes that serialize rebuilds in full
   * (pointer/grain/pitch/voices). Anything else found inside those blocks is
   * preserved under `<block>._extra` and re-emitted on serialize, so engine
   * keys the editor doesn't model yet survive the round trip instead of
   * dying silently. (`loop_duration` is the legacy alias healed at parse.) */
  const POINTER_KNOWN = new Set(["start", "speed_ratio", "loop_start", "loop_end", "loop_dur", "loop_duration", "loop_unit", "offset_range"]);
  const GRAIN_KNOWN   = new Set(["duration", "duration_range", "duration_unit", "envelope", "reverse"]);
  const PITCH_KNOWN   = new Set(["semitones", "cents", "quarter_tone", "eighth_tone", "ratio", "edo", "value", "range"]);
  const VOICES_KNOWN  = new Set(["num_voices", "scatter", "pitch", "onset_offset", "pointer", "pan"]);

  function collectExtras(block, known) {
    if (!block || typeof block !== "object") return undefined;
    const extras = {};
    for (const k of Object.keys(block)) {
      if (!known.has(k)) extras[k] = block[k];
    }
    return Object.keys(extras).length ? extras : undefined;
  }

  function mergeBlockExtras(blockY, extra) {
    if (!extra || typeof extra !== "object") return;
    for (const k of Object.keys(extra)) {
      if (!(k in blockY) || blockY[k] === undefined) blockY[k] = extra[k];
    }
  }

  /* ---------- envelope helpers ---------- */

  // A grain-envelope blend curve is EITHER a plain breakpoint array [[t, v], …]
  // OR the typed dict form {type, points} the editor emits (via wrapEnv) when
  // the user picks a non-linear global interpolation (step/cubic). The helpers
  // below normalize access so the multistate rescale below works on either
  // shape — otherwise `.map` on the dict throws (the step/cubic crash).
  function curvePoints(curve) {
    if (Array.isArray(curve)) return curve;
    if (curve && typeof curve === "object" && Array.isArray(curve.points)) return curve.points;
    return null;
  }
  // Rescale a curve's Y values by `factor`, preserving its shape: the {type,
  // points} wrapper, plain [t, v] breakpoints, and per-point [t, v, interp]
  // triples (the per-point interp is kept). Non-breakpoint entries (e.g. compact
  // loop blocks) pass through verbatim.
  function rescaleCurveY(curve, factor) {
    const mapPts = (pts) => pts.map((pt) =>
      (Array.isArray(pt) && typeof pt[0] === "number" && typeof pt[1] === "number")
        ? (pt.length >= 3 ? [pt[0], pt[1] * factor, pt[2]] : [pt[0], pt[1] * factor])
        : pt
    );
    if (Array.isArray(curve)) return mapPts(curve);
    if (curve && typeof curve === "object" && Array.isArray(curve.points)) {
      return { ...curve, points: mapPts(curve.points) };
    }
    return curve;
  }

  // True when the editor-space curve still maps back to the original engine
  // curve (within float tolerance) — i.e. the user hasn't edited it, so the
  // verbatim engine copy can be re-emitted unchanged instead of round-tripping
  // through the lossy *(n-1) / /(n-1) rescale. Handles both the plain-array and
  // the {type, points} dict shape, and compares the per-point interp. #59
  function curveMatchesRaw(editorCurve, rawCurve, n) {
    const ePts = curvePoints(editorCurve), rPts = curvePoints(rawCurve);
    if (!ePts || !rPts) return false;
    const eType = Array.isArray(editorCurve) ? null : (editorCurve.type || null);
    const rType = Array.isArray(rawCurve)    ? null : (rawCurve.type || null);
    if (eType !== rType) return false; // global interp wrapper must match
    if (ePts.length !== rPts.length) return false;
    for (let i = 0; i < ePts.length; i++) {
      const e = ePts[i], r = rPts[i];
      if (!Array.isArray(e) || !Array.isArray(r) || e.length < 2 || r.length < 2) {
        if (JSON.stringify(e) !== JSON.stringify(r)) return false;
        continue;
      }
      if (Math.abs(e[0] - r[0]) > 1e-9) return false;
      const engineY = n <= 1 ? 0 : e[1] / (n - 1);
      if (Math.abs(engineY - r[1]) > 1e-9) return false;
      if ((e[2] || null) !== (r[2] || null)) return false; // per-point interp
    }
    return true;
  }

  function serializeGrainEnvelope(env) {
    if (!env || typeof env === "string" || Array.isArray(env)) return env;
    if ("from" in env && "to" in env) return env;
    if ("states" in env && Array.isArray(env.states)) {
      const n = env.states.length;
      // Re-emit the explicit engine positions the editor preserved at parse;
      // fall back to uniform i/(n-1) when absent or stale after a structural
      // edit (statePositions length no longer matches the states). #59
      const positions = (Array.isArray(env.statePositions) && env.statePositions.length === n)
        ? env.statePositions : null;
      const engineStates = env.states.map((name, i) =>
        [positions ? positions[i] : (n === 1 ? 0.0 : i / (n - 1)), name]
      );
      // Re-emit the original engine curve verbatim while it's unedited; only a
      // real edit recomputes it (and accepts the rescale). #59
      const editorCurve = env.curve || [[0, 0], [1, 1]];
      // editor value-space [0, n-1] → engine [0, 1]; rescaleCurveY preserves the
      // {type, points} dict and per-point interp, so a step/cubic curve no longer
      // crashes here (was: editorCurve.map on a dict → "map is not a function").
      const engineCurve = (env._curveRaw && curveMatchesRaw(editorCurve, env._curveRaw, n))
        ? env._curveRaw
        : rescaleCurveY(editorCurve, n <= 1 ? 0 : 1 / (n - 1));
      return { states: engineStates, curve: engineCurve };
    }
    return env;
  }

  function parseGrainEnvelope(env) {
    if (!env || typeof env === "string" || Array.isArray(env)) return env;
    if ("from" in env && "to" in env) return env;
    if ("states" in env && Array.isArray(env.states)) {
      const raw = env.states;
      if (raw.length > 0 && Array.isArray(raw[0])) {
        const names = raw.map(([, w]) => w);
        const positions = raw.map(([p]) => p);
        const n = names.length;
        const rawCurve = env.curve || [[0, 0], [1, 1]];
        // engine [0, 1] → editor value-space [0, n-1]; preserves a {type, points}
        // dict and per-point interp instead of crashing on rawCurve.map.
        const editorCurve = rescaleCurveY(rawCurve, n - 1);
        const out = { states: names, curve: editorCurve };
        // The editor models states as names with uniform spacing; keep the
        // explicit engine positions when they diverge so serialize re-emits
        // them (lossless no-op save, stable per-stream cache). The engine uses
        // positions as thresholds in value-space, so forcing uniform spacing
        // would also change the rendered audio. Excluded from the UI
        // fingerprint (backend.js FP_IGNORE) so this preservation alone never
        // marks an already-rendered stem stale. #59
        if (positions.some((p, i) => p !== (n === 1 ? 0 : i / (n - 1)))) {
          out.statePositions = positions;
        }
        // Keep the engine curve verbatim so the editor-space rescale doesn't
        // introduce float drift on a no-op save. #59
        out._curveRaw = rawCurve;
        return out;
      }
      return env;
    }
    return env;
  }

  function isEnvObject(v) {
    // Object-form envelope: { points: [...], time_unit?, type?, … }
    // See envelope-loops.js isTypedEnv and engine YAMLs that use
    // `{time_unit: ..., points: [...]}` syntax.
    return v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.points);
  }

  function pickValueOrEnv(scalar, env) {
    // Editor stores either a scalar OR an envelope (the other is null).
    // YAML expects a single field. Prefer the envelope when it has content.
    if (Array.isArray(env) && env.length) return env;
    if (isEnvObject(env)) return env;
    if (scalar != null) return scalar;
    return undefined;
  }

  function unpackValueOrEnv(yamlVal) {
    // Inverse: read a YAML value that might be scalar or envelope.
    // Returns { scalar, env } with exactly one of them set.
    // Loop entries (5-tuples with nested breakpoints) and plain breakpoint
    // arrays both arrive here as Arrays — they are routed to `env`.
    // Object-form envelopes ({time_unit, points} / {type, points}) also go to env.
    if (Array.isArray(yamlVal)) {
      return { scalar: null, env: yamlVal };
    }
    if (isEnvObject(yamlVal)) {
      return { scalar: null, env: yamlVal };
    }
    if (typeof yamlVal === "number" || typeof yamlVal === "string" || yamlVal == null) {
      return { scalar: yamlVal ?? null, env: null };
    }
    // unknown shape (object, etc) — keep it as scalar so we don't lose it.
    return { scalar: yamlVal, env: null };
  }

  const VOICE_STRAT_ENV_PARAMS = ["step", "pitch_range", "max_offset", "base", "pointer_range", "spread"];

  function unpackStrategy(raw) {
    if (!raw || typeof raw !== "object") return raw;
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (VOICE_STRAT_ENV_PARAMS.includes(k)) {
        const u = unpackValueOrEnv(v);
        out[k] = u.scalar;
        if (u.env) out[k + "Env"] = u.env;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function packStrategy(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const out = {};
    for (const k of Object.keys(obj)) {
      if (k.endsWith("Env")) continue;
      if (VOICE_STRAT_ENV_PARAMS.includes(k)) {
        const packed = pickValueOrEnv(obj[k], obj[k + "Env"]);
        if (packed !== undefined) out[k] = packed;
      } else {
        if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
      }
    }
    return out;
  }

  function stripUndef(obj) {
    if (Array.isArray(obj)) return obj.map(stripUndef);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const k of Object.keys(obj)) {
        const v = stripUndef(obj[k]);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    return obj;
  }

  function colorForStream(_id, idx) {
    return PALETTE[idx % PALETTE.length];
  }

  function nonZero(x) { return x != null && x !== 0; }

  /* ---------- editor → yaml ---------- */

  function streamToYaml(s) {
    const y = {
      stream_id: s.id,
      onset:     s.onset ?? 0,
      // An implicit duration (PGE #205) stays implicit: writing the resolved
      // number back would materialize a value the author chose to leave to the
      // sample, and would freeze it against a later change of the audio file.
      ...(s.durationImplicit ? {} : { duration: s.duration ?? 0 }),
      sample:    s.sample,
    };
    if (s.timeMode)         y.time_mode = s.timeMode;
    if (s.distributionMode) y.distribution_mode = s.distributionMode;
    // Emit only when set: absence means the engine default 'center', and
    // writing range_anchor: center onto every stream would bust the per-stream
    // cache. Same rationale as distribution_mode above.
    if (s.rangeAnchor)      y.range_anchor = s.rangeAnchor;
    // Emit only a non-empty group: a cleared Inspector field means "no group"
    // and must never serialize as `rng_group: ''` (engine treats falsy as
    // absent, but the key would still churn the file and the stream cache).
    if (s.rngGroup)         y.rng_group = s.rngGroup;
    if (s.rangeAlwaysActive) y.range_always_active = true;
    if (s.timeScale != null && s.timeScale !== 1.0)        y.time_scale = s.timeScale;
    if (s.clipStrategy && s.clipStrategy !== "overflow_margin") y.clip_strategy = s.clipStrategy;
    if (s.clipMargin != null && s.clipMargin !== 0)        y.clip_margin = s.clipMargin;

    // fill_factor and density are mutually exclusive; the engine gives
    // fill_factor priority when both are present, so emit exactly one.
    const fillFactor = pickValueOrEnv(s.fillFactor, s.fillFactorEnv);
    const density = pickValueOrEnv(s.density, s.densityEnv);
    if (fillFactor !== undefined) y.fill_factor = fillFactor;
    else if (density !== undefined) y.density = density;
    const distribution = pickValueOrEnv(s.distribution, s.distributionEnv);
    if (distribution !== undefined) y.distribution = distribution;

    const grain = s.grain || {};
    const grainDur = pickValueOrEnv(grain.duration, grain.durationEnv);
    const grainY = {
      duration:       grainDur,
      // Explicit 0 is meaningful: it disables the implicit jitter the dephase
      // gate would otherwise apply (engine parameter.py), same as pitch.range —
      // emit it. pickValueOrEnv returns undefined when truly unset (null). #50
      duration_range: pickValueOrEnv(grain.durationRange, grain.durationRangeEnv),
      // Meta-chiave (PGE #158): unità di duration/duration_range. Emessa solo
      // se impostata; assente = default engine (seconds).
      duration_unit:  grain.durationUnit || undefined,
      envelope:       serializeGrainEnvelope(grain.envelope) || undefined,
    };
    // reverse is presence-keyed engine-side (`reverse:` bare = forced, absent
    // = auto). The editor stores null for the bare key; emit it verbatim —
    // null survives stripUndef and dumps as `reverse: null`.
    if (grain.reverse !== undefined) grainY.reverse = grain.reverse;
    mergeBlockExtras(grainY, grain._extra);
    if (Object.values(grainY).some(v => v !== undefined)) {
      y.grain = stripUndef(grainY);
    }

    const ptr = s.pointer || {};
    const ptrSp = pickValueOrEnv(ptr.speedRatio, ptr.speedRatioEnv);
    const ptrOffRange = pickValueOrEnv(ptr.offsetRange, ptr.offsetRangeEnv);
    // loop_end and loop_dur are an exclusive group engine-side with loop_end
    // taking priority — emit at most one of the two.
    const loopEndOut = pickValueOrEnv(ptr.loopEnd, ptr.loopEndEnv);
    const ptrY = {
      start:         ptr.start ?? undefined,
      speed_ratio:   ptrSp,
      loop_start:    pickValueOrEnv(ptr.loopStart, ptr.loopStartEnv),
      loop_end:      loopEndOut,
      loop_dur:      loopEndOut === undefined ? pickValueOrEnv(ptr.loopDur, ptr.loopDurEnv) : undefined,
      loop_unit:     ptr.loopUnit || undefined,
      offset_range:  ptrOffRange,  // explicit 0 disables implicit jitter — keep it (#50)
    };
    mergeBlockExtras(ptrY, ptr._extra);
    if (Object.values(ptrY).some(v => v !== undefined)) {
      y.pointer = stripUndef(ptrY);
    }

    const pi = s.pitch;
    if (pi && typeof pi === "object") {
      const unit = pi.unit || "semitones";
      const pitchVal = pickValueOrEnv(pi.value, pi.valueEnv);
      const hasValue = pitchVal !== undefined;
      const rangeVal = pickValueOrEnv(pi.range, pi.rangeEnv);
      // Explicit `range: 0` is meaningful engine-side (it disables the
      // implicit detune that dephase.pitch would otherwise apply) — emit it.
      // Unset stays null in the editor state and is not emitted.
      const hasRange = rangeVal !== undefined;
      const pitchExtra = (pi._extra && typeof pi._extra === "object" && Object.keys(pi._extra).length) ? pi._extra : undefined;
      if (hasValue || hasRange || pitchExtra) {
        const py = unit === "edo"
          ? {
              edo:   pi.edoDivisions ?? undefined,
              value: pitchVal,
              range: hasRange ? rangeVal : undefined,
            }
          : {
              [unit]: pitchVal,
              range:  hasRange ? rangeVal : undefined,
            };
        mergeBlockExtras(py, pitchExtra);
        y.pitch = stripUndef(py);
      }
    }

    const pan = pickValueOrEnv(s.pan, s.panEnv);
    if (pan !== undefined) y.pan = pan;
    const panRange = pickValueOrEnv(s.panRange, s.panRangeEnv);
    if (panRange !== undefined) y.pan_range = panRange;  // explicit 0 kept (#50)

    const vol = pickValueOrEnv(s.volume, s.volumeEnv);
    if (vol !== undefined) y.volume = vol;
    const volRange = pickValueOrEnv(s.volumeRange, s.volumeRangeEnv);
    if (volRange !== undefined) y.volume_range = volRange;  // explicit 0 kept (#50)

    const v = s.voices || {};
    const numOut = pickValueOrEnv(v.num, v.numEnv);
    const scatterOut = pickValueOrEnv(v.scatter, v.scatterEnv);
    const voicesExtra = (v._extra && typeof v._extra === "object" && Object.keys(v._extra).length) ? v._extra : undefined;
    const hasVoiceCfg =
      (numOut !== undefined && numOut !== 1) ||
      scatterOut != null ||
      v.pitch || v.onset_offset || v.pointer || v.pan || voicesExtra;
    if (hasVoiceCfg) {
      const vy = { num_voices: numOut !== undefined ? numOut : 1 };
      if (scatterOut != null) vy.scatter      = scatterOut;
      if (v.pitch)            vy.pitch        = packStrategy(v.pitch);
      if (v.onset_offset)     vy.onset_offset = packStrategy(v.onset_offset);
      if (v.pointer)          vy.pointer      = packStrategy(v.pointer);
      if (v.pan)              vy.pan          = packStrategy(v.pan);
      mergeBlockExtras(vy, voicesExtra);
      y.voices = vy;
    }

    // solo/mute are presence-keyed engine-side: _filter_solo_mute (generator.py)
    // checks key PRESENCE, not value, so a `solo: false` would still count as
    // solo-active. Emit them ONLY when truthy and omit them otherwise — never
    // `solo: false`. Mirrors the presence read in streamFromYaml. #63
    if (s.solo) y.solo = true;
    if (s.mute) y.mute = true;

    if (s.dephase === DEPHASE_IMPLICIT) y.dephase = null; // dumps as `dephase: null`
    else if (s.dephase !== undefined && s.dephase !== null) y.dephase = s.dephase;

    // Pass through any extra top-level keys we don't model explicitly.
    if (s._extra && typeof s._extra === "object") {
      for (const k of Object.keys(s._extra)) {
        if (!(k in y)) y[k] = s._extra[k];
      }
    }
    return stripUndef(y);
  }

  /* ---------- inline-envelope dump ----------
   * js-yaml has no per-node flow-style switch, so we mask every envelope
   * (breakpoint list / dict-form points / states / curve / spread / compact
   * loop block) with a unique scalar token, dump the rest in block style, then
   * splice each envelope back in as a single-line flow array `[[t, v], …]`.
   * Flow vs block is the same YAML once parsed — parse()/round-trip are
   * unaffected; this only changes how the saved file reads. */

  const DUMP_OPTS = {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  };

  function isBreakpointEntry(el) {
    // A breakpoint inside an envelope: array form ([t, v], the per-point interp
    // triple [t, v, "cubic"], or a wrapped compact block) OR the per-point dict
    // form ({t, v, type?}). The t/v signature excludes stream objects, so the
    // top-level `streams` list never matches.
    return Array.isArray(el) || (el != null && typeof el === "object" && "t" in el && "v" in el);
  }

  function isInlineEnvelope(node) {
    if (!Array.isArray(node) || node.length === 0) return false;
    // A list of breakpoints (array and/or dict form), e.g. density, points,
    // states, curve, spread, dephase. Excludes `streams` (objects without t/v).
    if (node.every(isBreakpointEntry)) return true;
    // Bare single compact loop block: [pattern, end_time, n_reps, interp?, dist?]
    if (Array.isArray(node[0]) && node[0].length > 0 && Array.isArray(node[0][0]) &&
        typeof node[1] === "number" && typeof node[2] === "number") return true;
    // Bare BP group (direct form): [points, interp] — PGE #64
    if (node.length === 2 && Array.isArray(node[0]) && node[0].length > 0 &&
        Array.isArray(node[0][0]) && typeof node[1] === "string") return true;
    return false;
  }

  function dumpWithInlineEnvelopes(payload) {
    if (!window.jsyaml) return "";
    const tokens = [];
    const mask = (node) => {
      if (isInlineEnvelope(node)) {
        const flow = window.jsyaml
          .dump(node, { ...DUMP_OPTS, flowLevel: 0, lineWidth: -1 })
          .replace(/\n$/, "");
        tokens.push(flow);
        return `__PGE_ENV_INLINE_${tokens.length - 1}__`;
      }
      if (Array.isArray(node)) return node.map(mask);
      if (node && typeof node === "object") {
        const out = {};
        for (const k of Object.keys(node)) out[k] = mask(node[k]);
        return out;
      }
      return node;
    };
    const text = window.jsyaml.dump(mask(payload), DUMP_OPTS);
    // The tokens are plain scalars js-yaml emits unquoted; each sits as the
    // value after `key: `, so splicing the flow form back in keeps indentation.
    return text.replace(/__PGE_ENV_INLINE_(\d+)__/g, (_, i) => tokens[+i]);
  }

  function dataToYaml(data) {
    if (!window.jsyaml) return "";
    const payload = {};
    if (data.title)    payload.title    = data.title;
    payload.duration = computeDuration(data.streams);
    if (data.bpm)      payload.bpm      = data.bpm;
    // seed (engine #81): emit on presence, not truthiness — seed: 0 is a valid
    // seed and must survive. Absent/null stays absent (open+save no-op).
    if (data.seed !== undefined && data.seed !== null) payload.seed = data.seed;
    payload.streams = (data.streams || []).map(streamToYaml);

    // Preserve any project-level extras we don't model.
    if (data._extra && typeof data._extra === "object") {
      for (const k of Object.keys(data._extra)) {
        if (!(k in payload)) payload[k] = data._extra[k];
      }
    }

    const head =
      `# project: ${data.project || "untitled"}\n` +
      `# saved:   ${new Date().toISOString()}\n` +
      `# editor:  PGE-ui\n` +
      `\n`;
    return head + dumpWithInlineEnvelopes(payload);
  }

  /* ---------- yaml → editor ---------- */

  /* Last-resort stream length, used only when `duration` is omitted AND the
   * sample's real length is unknown (file:// with no server, media list not
   * loaded yet, sample file missing). It is the historical editor default;
   * `durationUnresolved` marks it so the UI can say the number is a guess
   * instead of drawing it as fact. */
  const IMPLICIT_DURATION_FALLBACK = 5;

  /* Sample length from the media list (GET /media gives {name, duration}).
   * null when the sample can't be resolved — a 0 or a non-number is as
   * unusable as a missing entry, so it collapses to the same answer. */
  function sampleDurationOf(samples, name) {
    if (!name || !Array.isArray(samples)) return null;
    const hit = samples.find(s => s && s.name === name);
    const d = hit ? hit.duration : null;
    return (typeof d === "number" && isFinite(d) && d > 0) ? d : null;
  }

  /* Engine rule (PGE #205), mirrored: a declared duration wins; absent or null
   * means the sample's length. `== null` and not falsiness — `duration: 0` is
   * a real (degenerate) declaration and the engine keeps it as zero rather
   * than substituting the sample. */
  function resolveStreamDuration(y, samples) {
    const declared = y.duration ?? null;
    if (declared != null) {
      return { value: declared, implicit: false, unresolved: false };
    }
    const sampleDur = sampleDurationOf(samples, y.sample);
    return sampleDur != null
      ? { value: sampleDur, implicit: true, unresolved: false }
      : { value: IMPLICIT_DURATION_FALLBACK, implicit: true, unresolved: true };
  }

  function streamFromYaml(y, idx, samples) {
    const id = y.stream_id || ("stream" + (idx + 1));

    const dens = unpackValueOrEnv(y.density);
    const ff   = unpackValueOrEnv(y.fill_factor ?? null);
    // fill_factor wins over density engine-side; mirror that at parse so the
    // Inspector shows the branch the engine will actually use.
    const hasFF = ff.scalar != null || ff.env != null;
    const dist = unpackValueOrEnv(y.distribution);
    const pan  = unpackValueOrEnv(y.pan);

    const grain = y.grain || {};
    const grDur = unpackValueOrEnv(grain.duration);
    const ptr   = y.pointer || {};
    const ptrSp = unpackValueOrEnv(ptr.speed_ratio);

    /* Capture unknown keys so save round-trips them back. */
    const extras = {};
    for (const k of Object.keys(y)) {
      if (!KNOWN_STREAM_KEYS.has(k)) extras[k] = y[k];
    }

    // duration is optional in the engine (PGE #205): absent (or null) means
    // "as long as the sample". `resolved` is what every reader of the stream
    // uses — timeline width, envelope X axis, render extent — so it stays a
    // plain number; `durationImplicit` is what serialization looks at, so an
    // omitted key is not materialized on save.
    const dur = resolveStreamDuration(y, samples);

    const out = {
      id,
      onset: y.onset ?? 0,
      duration: dur.value,
      durationImplicit: dur.implicit,
      durationUnresolved: dur.unresolved,
      sample: y.sample || "",
      color: colorForStream(id, idx),
      // Presence-keyed to match the engine's _filter_solo_mute: the key being
      // present (any value, even `false`) means active, since the engine tests
      // `'solo' in stream`, not its value. Absent → false. Serialized back out
      // only when true (see streamToYaml). #63
      mute: ("mute" in y), solo: ("solo" in y),
      // Engine default is "absolute" — do NOT inject a default here. Absence
      // must round-trip as absence or saving a file rescales every envelope's
      // time axis. New streams created by the UI write "normalized"
      // explicitly (see createStreamFromSample in app.jsx).
      timeMode: y.time_mode ?? undefined,
      // Preserve absence (engine default is 'uniform'): injecting a default
      // here would write it back on save, changing every stream's raw dict and
      // busting the engine's per-stream content cache. UI falls back to display
      // 'uniform' when unset (see Inspector). Same rationale as time_mode above.
      distributionMode: y.distribution_mode ?? undefined,
      // Absence preserved (engine default 'center'): injecting a default would
      // write it back on save and bust the per-stream cache. Same as above.
      rangeAnchor: y.range_anchor ?? undefined,
      rangeAlwaysActive: !!y.range_always_active,
      // Shared RNG identity (engine #169). Absence must round-trip as absence
      // (identity = stream_id engine-side) AND as a *missing key*, not an
      // explicit undefined: canonicalJSON (backend.js) hashes present-but-
      // undefined keys as null, so an always-present key would shift every
      // stored fingerprint and mark all existing stems stale once.
      ...(y.rng_group != null ? { rngGroup: y.rng_group } : {}),
      timeScale:    y.time_scale    != null ? y.time_scale    : 1.0,
      clipStrategy: y.clip_strategy || "overflow_margin",
      clipMargin:   y.clip_margin   != null ? y.clip_margin   : 0.0,

      density:    hasFF ? null : dens.scalar,
      densityEnv: hasFF ? null : dens.env,
      fillFactor:    ff.scalar,
      fillFactorEnv: ff.env,
      distribution:    dist.scalar,
      distributionEnv: dist.env,

      // Preserve absence (engine default is 0 dB) — don't inject 0, or save
      // writes `volume: 0` into every stream and busts the engine cache.
      ...(() => { const v = unpackValueOrEnv(y.volume ?? null); return { volume: v.scalar, volumeEnv: v.env }; })(),
      // Preserve absence as null (engine: absent range = implicit jitter, distinct
      // from explicit 0 = jitter off). `?? 0` here coerced both to 0, hiding the
      // distinction and letting serialize drop an explicit 0. #50
      ...(() => { const vr = unpackValueOrEnv(y.volume_range ?? null); return { volumeRange: vr.scalar, volumeRangeEnv: vr.env }; })(),
      pan:    pan.scalar,
      panEnv: pan.env,
      ...(() => { const pr = unpackValueOrEnv(y.pan_range ?? null); return { panRange: pr.scalar, panRangeEnv: pr.env }; })(),  // preserve absence (#50)

      grain: {
        duration:      grDur.scalar,
        durationEnv:   grDur.env,
        ...(() => { const dr = unpackValueOrEnv(grain.duration_range ?? null); return { durationRange: dr.scalar, durationRangeEnv: dr.env }; })(),  // preserve absence (#50)
        // Meta-chiave (PGE #158): unità di duration/duration_range. Assente =
        // default engine (seconds); non iniettata per non sporcare la cache.
        ...("duration_unit" in grain ? { durationUnit: grain.duration_unit ?? null } : {}),
        // Preserve absence (engine default is 'hanning') — injecting it would
        // write `envelope: hanning` on save and bust the engine cache. The
        // EnvelopeSelector renders an unset value as 'hanning'.
        envelope:      parseGrainEnvelope(grain.envelope) ?? undefined,
        // Presence-keyed: `reverse:` bare (null) = forced, absent = auto.
        // Keep the value verbatim — anything non-null is an engine error the
        // user should still see round-trip.
        ...("reverse" in grain ? { reverse: grain.reverse ?? null } : {}),
        ...(() => { const ex = collectExtras(y.grain, GRAIN_KNOWN); return ex ? { _extra: ex } : {}; })(),
      },
      pointer: {
        // Preserve absence: engine-side, an absent start means 0 (no loop) or
        // "begin at loop_start" (with a loop). Injecting start: 0 here would
        // both bust the cache AND, for looped streams, override that behaviour.
        start:         ptr.start ?? undefined,
        speedRatio:    ptrSp.scalar,
        speedRatioEnv: ptrSp.env,
        ...(() => { const ls = unpackValueOrEnv(ptr.loop_start ?? null); return { loopStart: ls.scalar, loopStartEnv: ls.env }; })(),
        ...(() => {
          const le = unpackValueOrEnv(ptr.loop_end ?? null);
          const hasLE = le.scalar != null || le.env != null;
          // loop_end wins over loop_dur engine-side (exclusive group): when
          // both are in the file, keep only loop_end so the editor state
          // matches what the engine will render.
          // `loop_duration` is a legacy alias: older editor builds wrote it,
          // but the engine only knows `loop_dur` — read both, emit `loop_dur`.
          const ld = hasLE ? { scalar: null, env: null } : unpackValueOrEnv(ptr.loop_dur ?? ptr.loop_duration ?? null);
          return { loopEnd: le.scalar, loopEndEnv: le.env, loopDur: ld.scalar, loopDurEnv: ld.env };
        })(),
        ...(ptr.loop_unit != null ? { loopUnit: ptr.loop_unit } : {}),
        ...(() => { const or = unpackValueOrEnv(ptr.offset_range ?? null); return or.scalar != null || or.env ? { offsetRange: or.scalar, offsetRangeEnv: or.env } : {}; })(),
        ...(() => { const ex = collectExtras(y.pointer, POINTER_KNOWN); return ex ? { _extra: ex } : {}; })(),
      },
      pitch: (() => {
        const p = y.pitch;
        if (!p || typeof p !== "object") return null;
        const UNITS = ["semitones", "cents", "quarter_tone", "eighth_tone", "edo", "ratio"];
        const unit = UNITS.find(u => u in p) || "semitones";
        const rawVal = unit === "edo" ? p.value : p[unit];
        const { scalar, env } = unpackValueOrEnv(rawVal ?? null);
        return {
          unit,
          value:        scalar,
          valueEnv:     env,
          edoDivisions: unit === "edo" ? (p.edo ?? null) : null,
          ...(() => { const rr = unpackValueOrEnv(p.range ?? null); return { range: rr.scalar, rangeEnv: rr.env }; })(),
          ...(() => { const ex = collectExtras(p, PITCH_KNOWN); return ex ? { _extra: ex } : {}; })(),
        };
      })(),
      voices: (() => {
        const nv = unpackValueOrEnv(y.voices?.num_voices);
        const sc = unpackValueOrEnv(y.voices?.scatter ?? null);
        return {
          num:          nv.scalar != null ? nv.scalar : (nv.env ? null : 1),
          numEnv:       nv.env,
          scatter:      sc.scalar,
          scatterEnv:   sc.env,
          pitch:        unpackStrategy(y.voices?.pitch),
          onset_offset: unpackStrategy(y.voices?.onset_offset),
          pointer:      unpackStrategy(y.voices?.pointer),
          pan:          unpackStrategy(y.voices?.pan),
          ...(() => { const ex = collectExtras(y.voices, VOICES_KNOWN); return ex ? { _extra: ex } : {}; })(),
        };
      })(),
      // Key present with null value = implicit 1% — distinct from key absent
      // (= off). Per-param objects pass verbatim: a null INSIDE the object
      // means "default prob for that key" and stays null.
      dephase: ("dephase" in y) ? (y.dephase === null ? DEPHASE_IMPLICIT : y.dephase) : undefined,
    };
    if (Object.keys(extras).length) out._extra = extras;
    return out;
  }

  const KNOWN_PROJECT_KEYS = new Set(["title", "duration", "bpm", "streams", "project", "seed"]);

  function parse(text, opts = {}) {
    if (!window.jsyaml) throw new Error("js-yaml not loaded");
    const y = window.jsyaml.load(text) || {};
    const samples = opts.samples || [];
    const streams = Array.isArray(y.streams)
      ? y.streams.map((s, i) => streamFromYaml(s, i, samples))
      : [];
    // Dedupe stream ids — some engine configs have duplicate stream_id values,
    // which would break React keys + selection. Suffix collisions with #2, #3…
    {
      const seen = new Map();
      for (const s of streams) {
        const base = s.id;
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        if (n > 1) s.id = base + "#" + n;
      }
    }

    const extras = {};
    for (const k of Object.keys(y)) {
      if (!KNOWN_PROJECT_KEYS.has(k)) extras[k] = y[k];
    }

    const data = {
      project:  opts.project || (y.project || "untitled"),
      title:    y.title || "",
      duration: computeDuration(streams),
      bpm:      y.bpm || 120,
      streams,
      samples,
    };
    // seed: optional top-level key for reproducible NumPy renders (engine #81).
    // Modelled first-class (not _extra). Accept integers (incl. 0 and negatives)
    // and strings; a missing or null seed means "unseeded" and stays unmodelled.
    if (y.seed !== undefined && y.seed !== null) data.seed = y.seed;
    if (Object.keys(extras).length) data._extra = extras;
    return data;
  }

  function emptyProject(name) {
    return {
      project: (name || "new_project").replace(/\.yml$/i, ""),
      title: "",
      duration: computeDuration([]),
      bpm: 120,
      streams: [],
      samples: [],
    };
  }

  /* ---------- per-stream (single source of truth for the raw editor) ----------
   * The per-stream Raw tab in the Inspector routes through these so it can't
   * drift from the project save path: both delegate to streamToYaml /
   * streamFromYaml. serializeStream uses the EXACT dump options of dataToYaml,
   * so the text matches what a full save would write (minus the `streams:`
   * list indentation). parseStream returns the FULL stream shape; UI-only
   * fields (color/mute/solo) are synthesized by streamFromYaml and the caller
   * must preserve the live values — see YamlEditor.applyEdits. */
  function serializeStream(stream) {
    if (!window.jsyaml) return "";
    return dumpWithInlineEnvelopes(streamToYaml(stream)).replace(/\n$/, "");
  }

  function parseStream(text, idx = 0, opts = {}) {
    if (!window.jsyaml) throw new Error("js-yaml not loaded");
    const y = window.jsyaml.load(text) || {};
    // Same media list as the project parse: without it a stream that omits
    // `duration` would come back from the Raw tab flagged unresolved.
    return streamFromYaml(y, idx, opts.samples || []);
  }

  // Composition length is always derived from the streams: the furthest stream
  // edge (onset + duration) plus a silent tail. The renderer (PythonGranularEngine)
  // uses the top-level duration as the total render length, so this must reflect
  // the actual content or audio gets clipped. Single source of truth = streams.
  function computeDuration(streams, pad = 10) {
    const extent = (streams || []).reduce(
      (m, s) => Math.max(m, (s.onset || 0) + (s.duration || 0)), 0);
    return extent > 0 ? extent + pad : pad;
  }

  /* ---------- round-trip self-test ----------
   *
   * Serialise → parse → diff against original. Fields that never reach the YAML
   * (color, samples) are ignored. solo/mute now round-trip through the YAML
   * (#63), so they ARE diffed. Returns an array of { path, before, after }
   * difference records — empty array means lossless round-trip.
   */

  // Ignore only fields that don't (and shouldn't) reach the YAML: UI-only color,
  // the samples list, and the editor-only multistate preservation fields
  // statePositions/_curveRaw (#59) — their data is already encoded in the
  // serialized states/curve, so diffing them would double-count (and flag noise
  // after a curve/structure edit leaves the raw copy stale).
  // NOTE: solo/mute are intentionally NOT ignored here — they now round-trip
  // through the YAML (#63). This diverges from backend FP_IGNORE, which still
  // excludes them: serializing solo/mute changes WHICH streams render, not a
  // single stem's audio, so it must not mark a rendered stem stale.
  const IGNORE_FIELDS = new Set(["color", "samples", "statePositions", "_curveRaw"]);

  function deepDiff(a, b, path, out) {
    if (a === b) return;
    // Treat null and undefined as equivalent (both mean "field absent" — the
    // editor uses null for explicit empties, jsyaml drops fields entirely
    // when serialising and they come back as undefined).
    if (a == null && b == null) return;
    if (a == null || b == null) {
      out.push({ path: path.join("."), before: a, after: b });
      return;
    }
    if (typeof a !== typeof b) {
      out.push({ path: path.join("."), before: a, after: b });
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        out.push({ path: path.join("."), before: a, after: b });
        return;
      }
      for (let i = 0; i < a.length; i++) deepDiff(a[i], b[i], [...path, i], out);
      return;
    }
    if (typeof a === "object") {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        if (IGNORE_FIELDS.has(k)) continue;
        deepDiff(a[k], b[k], [...path, k], out);
      }
      return;
    }
    // primitive number/string mismatch
    // tolerate -0 / 0 and float jitter from yaml printer
    if (typeof a === "number" && typeof b === "number") {
      if (Math.abs(a - b) < 1e-9) return;
    }
    out.push({ path: path.join("."), before: a, after: b });
  }

  function roundTripDiff(data) {
    if (!window.jsyaml) return [{ path: "(no js-yaml)", before: null, after: null }];
    let text;
    try { text = dataToYaml(data); }
    catch (e) { return [{ path: "(serialize threw)", before: e.message, after: null }]; }
    let back;
    try { back = parse(text, { project: data.project, samples: data.samples }); }
    catch (e) { return [{ path: "(parse threw)", before: e.message, after: null }]; }

    const diffs = [];
    // Compare project-level fields
    // duration is derived from streams, not round-tripped — skip it here.
    deepDiff(
      { title: data.title || "", bpm: data.bpm || 0, seed: data.seed ?? null },
      { title: back.title || "",  bpm: back.bpm || 0, seed: back.seed ?? null },
      ["project"], diffs
    );
    // Compare each stream by id
    const byIdA = Object.fromEntries((data.streams || []).map(s => [s.id, s]));
    const byIdB = Object.fromEntries((back.streams || []).map(s => [s.id, s]));
    const ids = new Set([...Object.keys(byIdA), ...Object.keys(byIdB)]);
    for (const id of ids) {
      deepDiff(byIdA[id], byIdB[id], ["streams", id], diffs);
    }
    return diffs;
  }

  /* Merge a patch into a stream, treating an `undefined` value as "remove this
   * key" instead of "store the key with value undefined".
   *
   * The distinction is invisible to every reader of the stream object (`s.foo`
   * is undefined either way) but visible to `canonicalJSON` in backend.js,
   * which walks `Object.keys` and serializes a present-but-undefined key as
   * `null`. Without this, clearing an optional field (Inspector's rng_group)
   * would leave a residue that changes the fingerprint and marks the stem
   * stale even though the audio went back to what was already rendered.
   *
   * Only `undefined` deletes: `null` is a meaningful editor value (the
   * scalar/env pairs use it for "this one of the two isn't active"). */
  function applyStreamPatch(stream, patch, opts = {}) {
    const out = { ...stream };
    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete out[k];
      else out[k] = patch[k];
    }
    // Setting a duration from the interface is a decision: it makes the value
    // explicit, so it gets written to the YAML (PGE #205). A patch that brings
    // its own durationImplicit is a whole re-parsed stream (Raw tab), and there
    // the parsed flag is the truth — otherwise editing anything in the raw YAML
    // would materialize a duration key the author never wrote.
    if (patch.duration !== undefined && !("durationImplicit" in patch)) {
      out.durationImplicit = false;
      out.durationUnresolved = false;
      return out;
    }
    // Cambiare sample cambia la durata di uno stream che la eredita: senza
    // questo la timeline, l'asse X degli envelope e il fingerprint resterebbero
    // sulla lunghezza del sample precedente, proprio nel caso che il default
    // vuole rendere fedele. La lista arriva dal chiamante (mergeStreamPatch),
    // perche' qui dentro non c'e' accesso alla media list.
    //
    // Due esclusioni. Un patch che porta il proprio `durationImplicit` e' uno
    // stream intero ri-parsato (tab Raw): ha gia' risolto la durata con la sua
    // lista, ricalcolarla qui la sovrascriverebbe. E senza `samples` non si
    // ricalcola affatto: un chiamante che non la passa otterrebbe il fallback
    // al posto di un valore buono.
    if (patch.sample !== undefined
        && out.durationImplicit
        && !("durationImplicit" in patch)
        && Array.isArray(opts.samples)) {
      const dur = resolveStreamDuration({ sample: out.sample }, opts.samples);
      out.duration = dur.value;
      out.durationUnresolved = dur.unresolved;
    }
    return out;
  }

  /* Ri-risolve le durate implicite contro una lista sample arrivata DOPO il
   * parse. Al boot `GET /projects` e `GET /media` partono insieme e la prima
   * risponde per prima, quindi il progetto viene parsato con la media list
   * ancora vuota: senza questa seconda passata ogni stream senza `duration`
   * resterebbe congelato sul fallback per tutta la sessione — 5 secondi in
   * timeline, nota di durata stimata, `computeDuration` sbagliata, e un
   * fingerprint che cambia da solo al reload successivo.
   *
   * Ritorna lo STESSO oggetto quando non cambia niente: chi la chiama la
   * applica a ogni arrivo di media, e un oggetto nuovo a vuoto sarebbe un
   * render inutile (o, peggio, un passo di undo se passasse dalla history).
   *
   * `samples` finisce anche in `data.samples`, che roundTripDiff ri-passa al
   * parse di controllo: con la lista vecchia segnalerebbe divergenze inventate.
   */
  function resolveImplicitDurations(data, samples) {
    if (!data || !Array.isArray(data.streams)) return data;
    let changed = false;
    const streams = data.streams.map(s => {
      if (!s || !s.durationImplicit) return s;
      const dur = resolveStreamDuration({ sample: s.sample }, samples);
      if (dur.value === s.duration && dur.unresolved === !!s.durationUnresolved) return s;
      changed = true;
      return { ...s, duration: dur.value, durationUnresolved: dur.unresolved };
    });
    if (!changed && data.samples === samples) return data;
    return { ...data, streams, samples: samples || [] };
  }

  window.PGEYaml = {
    parse,
    serialize:       dataToYaml,
    serializeStream,
    applyStreamPatch,
    resolveImplicitDurations,
    parseStream,
    emptyProject,
    computeDuration,
    roundTripDiff,
    DEPHASE_IMPLICIT,
  };
})();
