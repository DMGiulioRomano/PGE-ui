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
  // DEPHASE_IMPLICIT sentinel / false / a scalar prob, a global envelope array,
  // or a per-param object whose values are scalar prob, null, or an envelope
  // array. Only the array-form envelopes are time-domain — rescale those, keep
  // every other key/value untouched so the round trip stays lossless.
  function _applyDephase(dephase, fn) {
    if (Array.isArray(dephase)) return fn(dephase);
    if (dephase && typeof dephase === "object") {
      return Object.fromEntries(Object.entries(dephase).map(([k, v]) =>
        DEPHASE_PARAM_KEYS.includes(k) && Array.isArray(v) ? [k, fn(v)] : [k, v]));
    }
    return dephase;
  }

  // Collect every time-domain envelope array carried by a stream's dephase.
  function _dephaseEnvs(dephase) {
    if (Array.isArray(dephase)) return [dephase];
    if (dephase && typeof dephase === "object")
      return DEPHASE_PARAM_KEYS.map(k => dephase[k]).filter(Array.isArray);
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

  window.PGEEnvUtils = {
    rescaleEnvArray,
    truncateEnvArray,
    envArrayWouldTruncate,
    _applyEnvFields,
    rescaleStreamEnvelopes,
    truncateStreamEnvelopes,
    streamWouldTruncate,
  };
})();
