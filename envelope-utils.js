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

  function _applyEnvFields(stream, fn) {
    const wf = (obj, key) => obj[key] != null ? { [key]: fn(obj[key]) } : {};
    return {
      ...stream,
      ...wf(stream, "densityEnv"),
      ...wf(stream, "fillFactorEnv"),
      ...wf(stream, "distributionEnv"),
      ...wf(stream, "panEnv"),
      ...wf(stream, "volumeEnv"),
      grain:   stream.grain   ? { ...stream.grain,   ...wf(stream.grain,   "durationEnv")   } : stream.grain,
      pointer: stream.pointer ? { ...stream.pointer, ...wf(stream.pointer, "speedRatioEnv"), ...wf(stream.pointer, "loopStartEnv"), ...wf(stream.pointer, "loopDurEnv"), ...wf(stream.pointer, "loopEndEnv") } : stream.pointer,
      pitch:   stream.pitch   ? { ...stream.pitch,   ...wf(stream.pitch,   "valueEnv")      } : stream.pitch,
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
      stream.densityEnv, stream.fillFactorEnv, stream.distributionEnv, stream.panEnv, stream.volumeEnv,
      stream.grain    && stream.grain.durationEnv,
      stream.pointer  && stream.pointer.speedRatioEnv,
      stream.pointer  && stream.pointer.loopStartEnv,
      stream.pointer  && stream.pointer.loopDurEnv,
      stream.pointer  && stream.pointer.loopEndEnv,
      stream.pitch    && stream.pitch.valueEnv,
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

  window.PGEEnvUtils = {
    rescaleEnvArray,
    truncateEnvArray,
    envArrayWouldTruncate,
    _applyEnvFields,
    rescaleStreamEnvelopes,
    truncateStreamEnvelopes,
    streamWouldTruncate,
    nudgeBreakpoint,
  };
})();
