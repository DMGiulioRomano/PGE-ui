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
 *   - Unknown stream-level keys are preserved verbatim under `_extra`.
 *   - Loop entries inside envelopes (5-tuples with nested breakpoints) pass
 *     through unchanged.
 *   - dephase keeps all three shapes: scalar | envelope-array | per-param object.
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
    "density", "distribution",
    "grain", "pointer", "pitch", "voices",
    "pan", "pan_range", "volume", "volume_range",
    "dephase",
  ]);

  /* ---------- envelope helpers ---------- */

  function pickValueOrEnv(scalar, env) {
    // Editor stores either a scalar OR an envelope (the other is null).
    // YAML expects a single field. Prefer the envelope when it has content.
    if (Array.isArray(env) && env.length) return env;
    if (scalar != null) return scalar;
    return undefined;
  }

  function unpackValueOrEnv(yamlVal) {
    // Inverse: read a YAML value that might be scalar or envelope.
    // Returns { scalar, env } with exactly one of them set.
    // Loop entries (5-tuples with nested breakpoints) and plain breakpoint
    // arrays both arrive here as Arrays — they are routed to `env`.
    if (Array.isArray(yamlVal)) {
      return { scalar: null, env: yamlVal };
    }
    if (typeof yamlVal === "number" || typeof yamlVal === "string" || yamlVal == null) {
      return { scalar: yamlVal ?? null, env: null };
    }
    // unknown shape (object, etc) — keep it as scalar so we don't lose it.
    return { scalar: yamlVal, env: null };
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

    const density = pickValueOrEnv(s.density, s.densityEnv);
    if (density !== undefined) y.density = density;
    const distribution = pickValueOrEnv(s.distribution, s.distributionEnv);
    if (distribution !== undefined) y.distribution = distribution;

    const grain = s.grain || {};
    const grainDur = pickValueOrEnv(grain.duration, grain.durationEnv);
    const grainY = {
      duration:       grainDur,
      duration_range: nonZero(grain.durationRange) ? grain.durationRange : undefined,
      envelope:       grain.envelope || undefined,
    };
    if (Object.values(grainY).some(v => v !== undefined)) {
      y.grain = stripUndef(grainY);
    }

    const ptr = s.pointer || {};
    const ptrSp = pickValueOrEnv(ptr.speedRatio, ptr.speedRatioEnv);
    const ptrY = {
      start:         ptr.start ?? undefined,
      speed_ratio:   ptrSp,
      loop_start:    ptr.loopStart ?? undefined,
      loop_duration: ptr.loopDur ?? undefined,
    };
    if (Object.values(ptrY).some(v => v !== undefined)) {
      y.pointer = stripUndef(ptrY);
    }

    const pi = s.pitch || {};
    if (nonZero(pi.semitones) || nonZero(pi.range)) {
      y.pitch = stripUndef({
        semitones: nonZero(pi.semitones) ? pi.semitones : undefined,
        range:     nonZero(pi.range)     ? pi.range     : undefined,
      });
    }

    const pan = pickValueOrEnv(s.pan, s.panEnv);
    if (pan !== undefined) y.pan = pan;
    if (nonZero(s.panRange)) y.pan_range = s.panRange;

    if (s.volume != null) y.volume = s.volume;
    if (nonZero(s.volumeRange)) y.volume_range = s.volumeRange;

    const v = s.voices || {};
    const hasVoiceCfg =
      (v.num != null && v.num !== 1) ||
      v.pitch || v.onsetOffset || v.pointer || v.pan;
    if (hasVoiceCfg) {
      const vy = { num_voices: v.num || 1 };
      if (v.pitch)        vy.pitch        = v.pitch;
      if (v.onsetOffset)  vy.onset_offset = v.onsetOffset;
      if (v.pointer)      vy.pointer      = v.pointer;
      if (v.pan)          vy.pan          = v.pan;
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
      timeMode: y.time_mode || "absolute",
      distributionMode: y.distribution_mode || "uniform",
      rangeAlwaysActive: !!y.range_always_active,
      timeScale:    y.time_scale    != null ? y.time_scale    : 1.0,
      clipStrategy: y.clip_strategy || "overflow_margin",
      clipMargin:   y.clip_margin   != null ? y.clip_margin   : 0.0,

      density:    dens.scalar,
      densityEnv: dens.env,
      distribution:    dist.scalar,
      distributionEnv: dist.env,

      volume: y.volume ?? -6,
      volumeRange: y.volume_range || 0,
      pan:    pan.scalar,
      panEnv: pan.env,
      panRange: y.pan_range || 0,

      grain: {
        duration:      grDur.scalar,
        durationEnv:   grDur.env,
        durationRange: grain.duration_range || 0,
        envelope:      grain.envelope || "hanning",
      },
      pointer: {
        start:         ptr.start ?? 0,
        speedRatio:    ptrSp.scalar,
        speedRatioEnv: ptrSp.env,
        loopStart:     ptr.loop_start ?? null,
        loopDur:       ptr.loop_duration ?? null,
      },
      pitch: {
        semitones: y.pitch?.semitones ?? 0,
        range:     y.pitch?.range || 0,
      },
      voices: {
        num: y.voices?.num_voices || 1,
        pitch:       y.voices?.pitch,
        onsetOffset: y.voices?.onset_offset,
        pointer:     y.voices?.pointer,
        pan:         y.voices?.pan,
      },
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
