/* =============================================================================
 * envelope-utils.js — pure envelope rescale/truncate math (freeze-on-resize).
 *
 * Extracted from app.jsx (#44) so it can be unit-tested in node like
 * yaml-bridge.js. No React, no DOM — depends only on window.PGEEnv
 * (envelope-loops.js, loaded before this file). Attaches to window.PGEEnvUtils.
 *
 * Field shapes handled: standard breakpoints [t, v], compact loop blocks, and
 * the object form {type, points}. The stream-level helpers walk every
 * scalar↔envelope field of a stream (top-level, grain, pointer, pitch, voices).
 * ===========================================================================*/

(function () {
  const PGEEnv = window.PGEEnv;

  function rescaleEnvArray(arr, ratio) {
    // object-form {type, points} envelope
    if (arr && typeof arr === "object" && !Array.isArray(arr) && Array.isArray(arr.points)) {
      return { ...arr, points: arr.points.map(p => [Math.min(1, +(p[0] * ratio).toFixed(5)), p[1]]) };
    }
    if (!Array.isArray(arr)) return arr;
    return arr.map(item => {
      if (PGEEnv.isBreakpoint(item)) {
        const c = [...item]; c[0] = Math.min(1, +(c[0] * ratio).toFixed(5)); return c;
      }
      if (PGEEnv.isCompactBlock(item)) {
        const c = [...item]; c[1] = Math.min(1, +(c[1] * ratio).toFixed(5)); return c;
      }
      return item;
    });
  }

  function truncateEnvArray(arr) {
    // object-form {type, points}: clip points beyond x=1.0, add closing BP
    if (arr && typeof arr === "object" && !Array.isArray(arr) && Array.isArray(arr.points)) {
      return { ...arr, points: truncateEnvArray(arr.points) };
    }
    if (!Array.isArray(arr) || !arr.length) return arr;
    const result = [];
    let prevX = 0, prevY = null;

    for (const item of arr) {
      if (PGEEnv.isBreakpoint(item)) {
        const [x, y] = item;
        if (x <= 1.0) {
          result.push(item);
          prevX = x; prevY = y;
        } else {
          // first BP past boundary — interpolate closing BP at x=1.0
          if (prevY !== null && prevX < x) {
            const t = (1.0 - prevX) / (x - prevX);
            result.push([1.0, +(prevY + (y - prevY) * t).toFixed(4)]);
          } else {
            result.push([1.0, +y.toFixed(4)]);
          }
          break;
        }
      } else if (PGEEnv.isCompactBlock(item)) {
        if (prevX >= 1.0) break; // block starts beyond boundary — drop
        if (item[1] > 1.0) {
          // clamp end_time to 1.0; cycles compress, nReps unchanged
          const clamped = [...item]; clamped[1] = 1.0;
          result.push(clamped);
          break;
        }
        result.push(item);
        prevX = item[1];
        prevY = item[0][item[0].length - 1][1]; // last pattern point y
      } else {
        result.push(item);
      }
    }
    return result;
  }

  function envArrayWouldTruncate(arr, ratio) {
    if (arr && typeof arr === "object" && !Array.isArray(arr) && Array.isArray(arr.points)) {
      return arr.points.some(p => p[0] * ratio > 1.0);
    }
    if (!Array.isArray(arr)) return false;
    return arr.some(item => {
      if (PGEEnv.isBreakpoint(item)) return item[0] * ratio > 1.0;
      if (PGEEnv.isCompactBlock(item)) return item[1] * ratio > 1.0;
      return false;
    });
  }

  // dephase per-parameter envelope keys (mirror EnvelopeEditor.jsx listEnvelopes).
  const DEPHASE_PARAM_KEYS = ["volume", "pan", "duration", "pitch", "pointer", "reverse", "envelope"];

  // dephase is stored verbatim (yaml-bridge passes it through): it can be the
  // DEPHASE_IMPLICIT sentinel / false / a scalar prob, a GLOBAL envelope (array
  // [[t,v],…] OR the typed {type, points} object form wrapEnv emits for a
  // non-linear global interp), or a per-param object whose values are scalar
  // prob, null, or an envelope (array or typed). Rescale every time-domain
  // envelope (window.PGEDephase.isEnvValue is the single discriminator, shared
  // with the Inspector/EnvelopeEditor); keep all other keys/values untouched so
  // the round trip stays lossless. rescaleEnvArray/truncateEnvArray already
  // handle the {type, points} object form.
  function _applyDephase(dephase, fn) {
    const isEnv = window.PGEDephase.isEnvValue;
    if (isEnv(dephase)) return fn(dephase);
    if (dephase && typeof dephase === "object") {
      return Object.fromEntries(Object.entries(dephase).map(([k, v]) =>
        DEPHASE_PARAM_KEYS.includes(k) && isEnv(v) ? [k, fn(v)] : [k, v]));
    }
    return dephase;
  }

  // Collect every time-domain envelope (array or typed) carried by a dephase.
  function _dephaseEnvs(dephase) {
    const isEnv = window.PGEDephase.isEnvValue;
    if (isEnv(dephase)) return [dephase];
    if (dephase && typeof dephase === "object")
      return DEPHASE_PARAM_KEYS.map(k => dephase[k]).filter(isEnv);
    return [];
  }

  function _applyEnvFields(stream, fn) {
    const wf = (obj, key) => obj[key] != null ? { [key]: fn(obj[key]) } : {};
    const dephaseWalk = Array.isArray(stream.dephase) || (stream.dephase && typeof stream.dephase === "object");
    return {
      ...stream,
      ...wf(stream, "densityEnv"),
      ...wf(stream, "fillFactorEnv"),
      ...wf(stream, "distributionEnv"),
      ...wf(stream, "panEnv"),
      ...wf(stream, "panRangeEnv"),
      ...wf(stream, "volumeEnv"),
      ...wf(stream, "volumeRangeEnv"),
      grain:   stream.grain   ? {
        ...stream.grain,
        ...wf(stream.grain, "durationEnv"),
        ...wf(stream.grain, "durationRangeEnv"),
        // grain.envelope.curve: blend/morph curve, array or {type,points} —
        // both handled by rescaleEnvArray/truncateEnvArray.
        ...(stream.grain.envelope && typeof stream.grain.envelope === "object" && !Array.isArray(stream.grain.envelope)
          ? { envelope: { ...stream.grain.envelope, ...wf(stream.grain.envelope, "curve") } }
          : {}),
      } : stream.grain,
      pointer: stream.pointer ? { ...stream.pointer, ...wf(stream.pointer, "speedRatioEnv"), ...wf(stream.pointer, "loopStartEnv"), ...wf(stream.pointer, "loopDurEnv"), ...wf(stream.pointer, "loopEndEnv"), ...wf(stream.pointer, "offsetRangeEnv") } : stream.pointer,
      pitch:   stream.pitch   ? { ...stream.pitch,   ...wf(stream.pitch,   "valueEnv"), ...wf(stream.pitch, "rangeEnv") } : stream.pitch,
      ...(dephaseWalk ? { dephase: _applyDephase(stream.dephase, fn) } : {}),
      voices:  stream.voices  ? {
        ...stream.voices,
        ...wf(stream.voices, "numEnv"),
        ...wf(stream.voices, "scatterEnv"),
        pitch:        stream.voices.pitch        ? { ...stream.voices.pitch,        ...wf(stream.voices.pitch,        "stepEnv"), ...wf(stream.voices.pitch,        "pitch_rangeEnv")    } : stream.voices.pitch,
        onset_offset: stream.voices.onset_offset ? { ...stream.voices.onset_offset, ...wf(stream.voices.onset_offset, "stepEnv"), ...wf(stream.voices.onset_offset, "baseEnv"), ...wf(stream.voices.onset_offset, "max_offsetEnv") } : stream.voices.onset_offset,
        pointer:      stream.voices.pointer      ? { ...stream.voices.pointer,      ...wf(stream.voices.pointer,      "stepEnv"), ...wf(stream.voices.pointer,      "pointer_rangeEnv") } : stream.voices.pointer,
        pan:          stream.voices.pan          ? { ...stream.voices.pan,          ...wf(stream.voices.pan,          "spreadEnv") } : stream.voices.pan,
      } : stream.voices,
    };
  }

  /* ---------- keyboard nudge of a single standard breakpoint ----------
     Move items[index] (a [t, v] / [t, v, interp] breakpoint) by `delta` along
     one axis, mirroring the pointer-drag clamps used in EnvelopeEditor:
       - axis "time"  → x in [0,1], clamped just inside the neighbouring BPs
                        (loop blocks are skipped, so a BP clamps to the nearest
                        standalone breakpoint, never the inside of a loop);
       - axis "value" → y clamped to the parameter range [hardMin, hardMax].
     Pure: never mutates `items`. Returns the SAME array reference when the move
     resolves to no change (clamped to a boundary, or the rounded delta is below
     one precision step) so callers can skip a redundant commit / undo entry.
     opts: { hardMin, hardMax, xPrec=4, yPrec=2, xStep=0.001, xMin=0, xMax=1 }. */
  function nudgeBreakpoint(items, index, axis, delta, opts) {
    opts = opts || {};
    const xPrec   = opts.xPrec   != null ? opts.xPrec   : 4;
    const yPrec   = opts.yPrec   != null ? opts.yPrec   : 2;
    const xStep   = opts.xStep   != null ? opts.xStep   : 0.001;
    const xMin    = opts.xMin    != null ? opts.xMin    : 0;
    const xMax    = opts.xMax    != null ? opts.xMax    : 1;
    const hardMin = opts.hardMin != null ? opts.hardMin : -Infinity;
    const hardMax = opts.hardMax != null ? opts.hardMax :  Infinity;
    if (!Array.isArray(items)) return items;
    const bp = items[index];
    if (!PGEEnv.isBreakpoint(bp)) return items;

    // neighbours in the FLAT list of standalone breakpoints (loop blocks skipped)
    const flatBPIndices = [];
    items.forEach((it, i) => { if (PGEEnv.isBreakpoint(it)) flatBPIndices.push(i); });
    const myPos  = flatBPIndices.indexOf(index);
    const prevBP = myPos > 0 ? items[flatBPIndices[myPos - 1]] : null;
    const nextBP = myPos < flatBPIndices.length - 1 ? items[flatBPIndices[myPos + 1]] : null;

    let newX = bp[0], newVal = bp[1];
    if (axis === "time") {
      const lo = prevBP ? prevBP[0] + xStep : xMin;
      const hi = nextBP ? nextBP[0] - xStep : xMax;
      newX = Math.max(lo, Math.min(hi, bp[0] + delta));
    } else {
      newVal = Math.max(hardMin, Math.min(hardMax, bp[1] + delta));
    }
    newX = +newX.toFixed(xPrec);
    newVal = +newVal.toFixed(yPrec);
    if (newX === bp[0] && newVal === bp[1]) return items; // clamped → no movement

    const moved = [newX, newVal];
    if (bp.length >= 3) moved.push(bp[2]); // preserve per-point interpolation
    return items.map((it, i) => i === index ? moved : it);
  }

  function rescaleStreamEnvelopes(stream, oldDur, newDur) {
    const ratio = oldDur / newDur;
    return _applyEnvFields(stream, arr => rescaleEnvArray(arr, ratio));
  }

  function truncateStreamEnvelopes(stream) {
    return _applyEnvFields(stream, truncateEnvArray);
  }

  function streamWouldTruncate(stream, ratio) {
    const fields = [
      stream.densityEnv, stream.fillFactorEnv, stream.distributionEnv,
      stream.panEnv, stream.panRangeEnv, stream.volumeEnv, stream.volumeRangeEnv,
      stream.grain    && stream.grain.durationEnv,
      stream.grain    && stream.grain.durationRangeEnv,
      stream.grain    && stream.grain.envelope && stream.grain.envelope.curve,
      stream.pointer  && stream.pointer.speedRatioEnv,
      stream.pointer  && stream.pointer.loopStartEnv,
      stream.pointer  && stream.pointer.loopDurEnv,
      stream.pointer  && stream.pointer.loopEndEnv,
      stream.pointer  && stream.pointer.offsetRangeEnv,
      stream.pitch    && stream.pitch.valueEnv,
      stream.pitch    && stream.pitch.rangeEnv,
      ..._dephaseEnvs(stream.dephase),
      stream.voices   && stream.voices.numEnv,
      stream.voices   && stream.voices.scatterEnv,
      stream.voices && stream.voices.pitch        && stream.voices.pitch.stepEnv,
      stream.voices && stream.voices.pitch        && stream.voices.pitch.pitch_rangeEnv,
      stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.stepEnv,
      stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.baseEnv,
      stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.max_offsetEnv,
      stream.voices && stream.voices.pointer      && stream.voices.pointer.stepEnv,
      stream.voices && stream.voices.pointer      && stream.voices.pointer.pointer_rangeEnv,
      stream.voices && stream.voices.pan          && stream.voices.pan.spreadEnv,
    ];
    return fields.some(f => f && envArrayWouldTruncate(f, ratio));
  }

  // Auto-fit the envelope Y window to the actual point values, for readability.
  // Fits the POINTS (min..max of the y-values) plus a `padFrac` margin (10% by
  // default), then clamps into [hardMin, hardMax]. This is the key change from
  // the old autofit, which unioned with the static [visMin,visMax] and so could
  // only grow — leaving an envelope whose points sit in a small sub-range
  // squashed against one edge. With no finite points it falls back to the
  // [visMin,visMax] default window; a constant set opens a minimal window
  // (0.01 for seconds, else 1) so a flat curve isn't pinned to an edge.
  // Pure: EnvelopeEditor recomputes it on open / param change / end-of-drag and
  // freezes the returned window during a drag (so the dragged point can't
  // "run away" under a rescaling axis). Returns { ymin, ymax }, ymax > ymin.
  function computeYFit(values, opts) {
    opts = opts || {};
    const { visMin, visMax, hardMin, hardMax, unit } = opts;
    const padFrac = opts.padFrac == null ? 0.10 : opts.padFrac;
    const nums = (values || []).filter(v => typeof v === "number" && isFinite(v));
    let lo, hi;
    if (nums.length) {
      lo = Math.min(...nums);
      hi = Math.max(...nums);
    } else {
      lo = (typeof visMin === "number") ? visMin : 0;
      hi = (typeof visMax === "number") ? visMax : lo + 1;
    }
    if (lo === hi) hi = lo + (unit === "s" ? 0.01 : 1);
    const range = hi - lo;
    hi = hi + range * padFrac;
    lo = lo - range * padFrac;
    if (typeof hardMax === "number") hi = Math.min(hardMax, hi);
    if (typeof hardMin === "number") lo = Math.max(hardMin, lo);
    if (!(hi > lo)) hi = lo + (unit === "s" ? 0.01 : 1);
    return { ymin: lo, ymax: hi };
  }

  // Dynamic upper bound for the loop-window envelopes (loop_start / loop_end /
  // loop_dur), driven by the chosen sample's duration. The engine declares
  // their max_val as None precisely because the real cap is sample_dur_sec,
  // injected at render time (parameter_definitions.get_parameter_definition);
  // the static PGE_BOUNDS cap (3600 s) is only a placeholder. A loop window can
  // never address past the end of the sample, so the editor clamps to it.
  // Mirrors PointerController._pre_normalize_loop_params unit resolution:
  //   unit = pointer.loopUnit || stream.timeMode (engine default "absolute")
  //   "normalized" → loop coords live in [0,1] (the engine scales them by the
  //                  sample duration) → cap = 1
  //   otherwise (absolute seconds) → cap = sampleDur
  // Returns null when the sample duration is unknown (file:// / server down /
  // unreadable file / sample not found) so callers keep the static fallback cap.
  function loopEnvMax(stream, sampleDur) {
    const unit = (stream && stream.pointer && stream.pointer.loopUnit)
      || (stream && stream.timeMode) || "absolute";
    if (unit === "normalized") return 1;
    return (typeof sampleDur === "number" && isFinite(sampleDur) && sampleDur > 0)
      ? sampleDur : null;
  }

  // Mirror of the engine's static loop-window validation (PGE issue #97 / engine
  // ec61242). With a loop active the engine now confines the grain read position
  // — base + pointer.offset_range + voice pointer offsets — to [loop_start,
  // loop_end) via modular wrap (previously it could read the whole file), and
  // rejects a degenerate window at parse time: loop_end <= loop_start raises
  // InvalidFieldValueError. Only the SCALAR (static-bound) form is checked: an
  // envelope on either endpoint is evaluated per-grain and is exempt, exactly as
  // the engine exempts dynamic bounds. loop_dur mode is intentionally
  // unconstrained here — it is the ONLY way to express a window that straddles
  // the end of the file (loop_start + loop_dur > sample_dur); loop_end stays
  // bound to [0, sample_dur]. loop_start absent defaults to 0 (engine default).
  // Returns null when valid / not applicable, else { loopStart, loopEnd } so the
  // caller can build the message. Pure — no DOM, no engine call.
  function loopBoundsError(pointer) {
    if (!pointer) return null;
    // dynamic endpoint → exempt (engine evaluates it per-grain, no static check)
    if (pointer.loopStartEnv != null || pointer.loopEndEnv != null) return null;
    const le = pointer.loopEnd;
    if (typeof le !== "number" || !isFinite(le)) return null; // loop_dur mode / no end
    const ls = (typeof pointer.loopStart === "number" && isFinite(pointer.loopStart))
      ? pointer.loopStart : 0;
    return le <= ls ? { loopStart: ls, loopEnd: le } : null;
  }

  // Mirror della validazione PGE #158: con grain.duration_unit: samples la
  // grain.duration deve essere esplicita. Il default 0.05 è in secondi e non
  // viene convertito, quindi base (secondi) e duration_range (campioni)
  // vivrebbero in domini diversi; il motore solleva MissingFieldError. Solo
  // 'samples' è vincolato — 'seconds' e l'assenza usano il default liberamente.
  // Ritorna null se valido/non applicabile, altrimenti { unit } così il chiamante
  // costruisce il messaggio. Puro — niente DOM, niente chiamate al motore.
  function grainDurationUnitError(grain) {
    if (!grain || grain.durationUnit !== "samples") return null;
    const hasScalar = grain.duration != null;
    const hasEnv = grain.durationEnv != null;
    return (hasScalar || hasEnv) ? null : { unit: "samples" };
  }

  window.PGEEnvUtils = {
    rescaleEnvArray,
    truncateEnvArray,
    envArrayWouldTruncate,
    _applyEnvFields,
    rescaleStreamEnvelopes,
    truncateStreamEnvelopes,
    streamWouldTruncate,
    nudgeBreakpoint,
    computeYFit,
    loopEnvMax,
    loopBoundsError,
    grainDurationUnitError,
  };
})();
