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
 *   - dephase keeps all three shapes: scalar | envelope-array | per-param object.
 *   - time_mode: absence is preserved (engine default is "absolute");
 *     new streams created by the UI write `time_mode: normalized` explicitly.
 * ===========================================================================*/

(function () {
  if (!window.jsyaml) {
    console.warn("js-yaml not loaded — yaml round-trip disabled");
  }

  const PALETTE = ["#5C8868","#B89241","#3F8884","#5965A8","#8E5F8E","#C97A6E","#7A8DB0"];

  /* Known stream-level keys we map explicitly. Everything else under a
   * stream node is preserved as-is in `_extra` and re-emitted on serialize. */
  const KNOWN_STREAM_KEYS = new Set([
    "stream_id", "onset", "duration", "sample",
    "time_mode", "distribution_mode",
    "range_always_active", "time_scale", "clip_strategy", "clip_margin",
    "density", "fill_factor", "distribution",
    "grain", "pointer", "pitch", "voices",
    "pan", "pan_range", "volume", "volume_range",
    "dephase",
  ]);

  /* Known keys inside the block nodes that serialize rebuilds in full
   * (pointer/grain/pitch/voices). Anything else found inside those blocks is
   * preserved under `<block>._extra` and re-emitted on serialize, so engine
   * keys the editor doesn't model yet survive the round trip instead of
   * dying silently. (`loop_duration` is the legacy alias healed at parse.) */
  const POINTER_KNOWN = new Set(["start", "speed_ratio", "loop_start", "loop_end", "loop_dur", "loop_duration", "loop_unit", "offset_range"]);
  const GRAIN_KNOWN   = new Set(["duration", "duration_range", "envelope", "reverse"]);
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

  function serializeGrainEnvelope(env) {
    if (!env || typeof env === "string" || Array.isArray(env)) return env;
    if ("from" in env && "to" in env) return env;
    if ("states" in env && Array.isArray(env.states)) {
      const n = env.states.length;
      const engineStates = env.states.map((name, i) =>
        [n === 1 ? 0.0 : i / (n - 1), name]
      );
      const engineCurve = (env.curve || [[0, 0], [1, 1]]).map(pt => {
        if (Array.isArray(pt) && pt.length >= 2) {
          return [pt[0], n <= 1 ? 0 : pt[1] / (n - 1)];
        }
        return pt;
      });
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
        const n = names.length;
        const editorCurve = (env.curve || [[0, 0], [1, 1]]).map(pt => {
          if (Array.isArray(pt) && pt.length >= 2) {
            return [pt[0], pt[1] * (n - 1)];
          }
          return pt;
        });
        return { states: names, curve: editorCurve };
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
      duration:  s.duration ?? 0,
      sample:    s.sample,
    };
    if (s.timeMode)         y.time_mode = s.timeMode;
    if (s.distributionMode) y.distribution_mode = s.distributionMode;
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
      duration_range: (() => { const dr = pickValueOrEnv(grain.durationRange, grain.durationRangeEnv); return (dr !== undefined && dr !== 0) ? dr : undefined; })(),
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
      offset_range:  ptrOffRange !== undefined && ptrOffRange !== 0 ? ptrOffRange : undefined,
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
    if (panRange !== undefined && panRange !== 0) y.pan_range = panRange;

    const vol = pickValueOrEnv(s.volume, s.volumeEnv);
    if (vol !== undefined) y.volume = vol;
    const volRange = pickValueOrEnv(s.volumeRange, s.volumeRangeEnv);
    if (volRange !== undefined && volRange !== 0) y.volume_range = volRange;

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

    if (s.dephase !== undefined && s.dephase !== null) y.dephase = s.dephase;

    // Pass through any extra top-level keys we don't model explicitly.
    if (s._extra && typeof s._extra === "object") {
      for (const k of Object.keys(s._extra)) {
        if (!(k in y)) y[k] = s._extra[k];
      }
    }
    return stripUndef(y);
  }

  function dataToYaml(data) {
    if (!window.jsyaml) return "";
    const payload = {};
    if (data.title)    payload.title    = data.title;
    if (data.duration) payload.duration = data.duration;
    if (data.bpm)      payload.bpm      = data.bpm;
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
    return head + window.jsyaml.dump(payload, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      quotingType: '"',
      forceQuotes: false,
    });
  }

  /* ---------- yaml → editor ---------- */

  function streamFromYaml(y, idx) {
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

    const out = {
      id,
      onset: y.onset ?? 0,
      duration: y.duration ?? 5,
      sample: y.sample || "",
      color: colorForStream(id, idx),
      mute: false, solo: false,
      // Engine default is "absolute" — do NOT inject a default here. Absence
      // must round-trip as absence or saving a file rescales every envelope's
      // time axis. New streams created by the UI write "normalized"
      // explicitly (see createStreamFromSample in app.jsx).
      timeMode: y.time_mode ?? undefined,
      distributionMode: y.distribution_mode || "uniform",
      rangeAlwaysActive: !!y.range_always_active,
      timeScale:    y.time_scale    != null ? y.time_scale    : 1.0,
      clipStrategy: y.clip_strategy || "overflow_margin",
      clipMargin:   y.clip_margin   != null ? y.clip_margin   : 0.0,

      density:    hasFF ? null : dens.scalar,
      densityEnv: hasFF ? null : dens.env,
      fillFactor:    ff.scalar,
      fillFactorEnv: ff.env,
      distribution:    dist.scalar,
      distributionEnv: dist.env,

      ...(() => { const v = unpackValueOrEnv(y.volume ?? 0); return { volume: v.scalar, volumeEnv: v.env }; })(),
      ...(() => { const vr = unpackValueOrEnv(y.volume_range ?? 0); return { volumeRange: vr.scalar, volumeRangeEnv: vr.env }; })(),
      pan:    pan.scalar,
      panEnv: pan.env,
      ...(() => { const pr = unpackValueOrEnv(y.pan_range ?? 0); return { panRange: pr.scalar, panRangeEnv: pr.env }; })(),

      grain: {
        duration:      grDur.scalar,
        durationEnv:   grDur.env,
        ...(() => { const dr = unpackValueOrEnv(grain.duration_range ?? 0); return { durationRange: dr.scalar, durationRangeEnv: dr.env }; })(),
        envelope:      parseGrainEnvelope(grain.envelope) || "hanning",
        // Presence-keyed: `reverse:` bare (null) = forced, absent = auto.
        // Keep the value verbatim — anything non-null is an engine error the
        // user should still see round-trip.
        ...("reverse" in grain ? { reverse: grain.reverse ?? null } : {}),
        ...(() => { const ex = collectExtras(y.grain, GRAIN_KNOWN); return ex ? { _extra: ex } : {}; })(),
      },
      pointer: {
        start:         ptr.start ?? 0,
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
      dephase: y.dephase ?? undefined,
    };
    if (Object.keys(extras).length) out._extra = extras;
    return out;
  }

  const KNOWN_PROJECT_KEYS = new Set(["title", "duration", "bpm", "streams", "project"]);

  function parse(text, opts = {}) {
    if (!window.jsyaml) throw new Error("js-yaml not loaded");
    const y = window.jsyaml.load(text) || {};
    const streams = Array.isArray(y.streams) ? y.streams.map((s, i) => streamFromYaml(s, i)) : [];
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
      duration: y.duration || streams.reduce((m, s) => Math.max(m, (s.onset || 0) + (s.duration || 0)), 60),
      bpm:      y.bpm || 120,
      streams,
      samples:  opts.samples || [],
    };
    if (Object.keys(extras).length) data._extra = extras;
    return data;
  }

  function emptyProject(name) {
    return {
      project: (name || "new_project").replace(/\.yml$/i, ""),
      title: "",
      duration: 60,
      bpm: 120,
      streams: [],
      samples: [],
    };
  }

  /* ---------- round-trip self-test ----------
   *
   * Serialise → parse → diff against original. UI-only fields (color, mute,
   * solo, samples) are ignored. Returns an array of { path, before, after }
   * difference records — empty array means lossless round-trip.
   */

  const IGNORE_FIELDS = new Set(["color", "mute", "solo", "samples"]);

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
    deepDiff(
      { title: data.title || "", duration: data.duration || 0, bpm: data.bpm || 0 },
      { title: back.title || "",  duration: back.duration || 0, bpm: back.bpm || 0 },
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

  window.PGEYaml = {
    parse,
    serialize:     dataToYaml,
    emptyProject,
    roundTripDiff,
  };
})();
