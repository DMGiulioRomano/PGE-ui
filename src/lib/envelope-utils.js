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

  /* ---------- grain.read_direction: un dominio di due elementi ----------
   * PGE #207. Il verso di lettura vale -1 o +1 e basta: il motore rifiuta ogni
   * valore intermedio al parse (InvalidFieldValueError), NON lo clampa. Il
   * dominio è l'insieme {-1, +1}, mentre i bound `[-1, 1]` che arrivano da
   * /bounds descrivono un intervallo — leggerli come tali è esattamente
   * l'errore che questa costante evita.
   *
   * Conseguenza operativa: dovunque la UI CALCOLI un y invece di sceglierlo
   * (interpolazione del breakpoint di chiusura, drag, nudge da tastiera) il
   * valore va SNAPPATO al segno, non clampato al range. Senza questo un
   * ridimensionamento dello stream può trasformare un progetto valido in uno
   * che non renderizza, senza che l'utente abbia toccato il verso. */
  const DIRECTION_VALUES = [-1, 1];

  function snapDirection(y) {
    return (typeof y === "number" && y < 0) ? -1 : 1;
  }

  // Il "domain" di un campo envelope: `null` per il continuo (tutti gli altri
  // parametri), "direction" per read_direction. Passato ai walker per campo,
  // perché la regola non è dello stream ma della singola chiave.
  function snapForDomain(domain) {
    return domain === "direction" ? snapDirection : null;
  }

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
      if (PGEEnv.isBPGroup(item)) {
        // BP group [points, interp]: i punti hanno tempi assoluti come i BP
        return [rescaleEnvArray(item[0], ratio), item[1]];
      }
      if (PGEEnv.isCompactBlock(item)) {
        const c = [...item]; c[1] = Math.min(1, +(c[1] * ratio).toFixed(5)); return c;
      }
      return item;
    });
  }

  // `snap`, quando presente, riscrive ogni y CALCOLATO da questa funzione (il
  // breakpoint di chiusura interpolato al bordo). I valori scelti dall'utente
  // passano intatti: se sono fuori dominio è un problema che va segnalato, non
  // corretto in silenzio. Su read_direction senza snap l'interpolazione fra un
  // +1 e un -1 produce tipicamente uno 0.3, che il motore rifiuta.
  function truncateEnvArray(arr, snap) {
    // object-form {type, points}: clip points beyond x=1.0, add closing BP
    if (arr && typeof arr === "object" && !Array.isArray(arr) && Array.isArray(arr.points)) {
      return { ...arr, points: truncateEnvArray(arr.points, snap) };
    }
    if (!Array.isArray(arr) || !arr.length) return arr;
    const result = [];
    let prevX = 0, prevY = null;
    const close = (y) => (snap ? snap(y) : +y.toFixed(4));

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
            result.push([1.0, close(prevY + (y - prevY) * t)]);
          } else {
            result.push([1.0, close(y)]);
          }
          break;
        }
      } else if (PGEEnv.isBPGroup(item)) {
        // BP group: tronca i punti interni (stessa regola dei BP); se resta
        // un solo punto il gruppo degenera a breakpoint nudo.
        if (prevX >= 1.0) break;
        const inner = truncateEnvArray(item[0], snap);
        if (inner.length >= 2) result.push([inner, item[1]]);
        else if (inner.length === 1) result.push(inner[0]);
        const lastP = inner[inner.length - 1];
        if (lastP) { prevX = lastP[0]; prevY = lastP[1]; }
        if (item[0].some(p => p[0] > 1.0)) break; // il gruppo è stato tagliato
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
      if (PGEEnv.isBPGroup(item)) return item[0].some(p => p[0] * ratio > 1.0);
      if (PGEEnv.isCompactBlock(item)) return item[1] * ratio > 1.0;
      return false;
    });
  }

  // deviation_probability per-parameter keys — dal classificatore condiviso,
  // letto a chiamata come isEnvValue (stesso modulo, stesso ordine di carico).
  // Qui serve l'UNIONE (ALL_PARAM_KEYS), non le sole chiavi sempre vive: il
  // walk riscala e tronca, e una chiave saltata lascia un envelope fuori scala
  // su uno YAML che rende. La lista ristretta e' quella della validazione, che
  // ha il vincolo opposto.
  const paramKeys = () => window.PGEDeviationProb.ALL_PARAM_KEYS;

  // deviation_probability is stored verbatim (yaml-bridge passes it through):
  // it can be the DEVIATION_PROB_IMPLICIT sentinel / false / a scalar prob, a
  // GLOBAL envelope (array
  // [[t,v],…] OR the typed {type, points} object form wrapEnv emits for a
  // non-linear global interp), or a per-param object whose values are scalar
  // prob, null, or an envelope (array or typed). Rescale every time-domain
  // envelope (window.PGEDeviationProb.isEnvValue is the single discriminator,
  // shared with the Inspector/EnvelopeEditor); keep all other keys/values untouched so
  // the round trip stays lossless. rescaleEnvArray/truncateEnvArray already
  // handle the {type, points} object form.
  function _applyDeviationProb(deviationProbability, fn) {
    const isEnv = window.PGEDeviationProb.isEnvValue;
    if (isEnv(deviationProbability)) return fn(deviationProbability);
    if (deviationProbability && typeof deviationProbability === "object") {
      return Object.fromEntries(Object.entries(deviationProbability).map(([k, v]) =>
        paramKeys().includes(k) && isEnv(v) ? [k, fn(v)] : [k, v]));
    }
    return deviationProbability;
  }

  // Collect every time-domain envelope (array or typed) carried by a
  // deviation_probability.
  function _deviationProbEnvs(deviationProbability) {
    const isEnv = window.PGEDeviationProb.isEnvValue;
    if (isEnv(deviationProbability)) return [deviationProbability];
    if (deviationProbability && typeof deviationProbability === "object")
      return paramKeys().map(k => deviationProbability[k]).filter(isEnv);
    return [];
  }

  // `fn` riceve (envelope, domain): il dominio è della singola chiave, non
  // dello stream, e solo read_direction ne ha uno che non sia il continuo.
  function _applyEnvFields(stream, fn) {
    const wf = (obj, key, domain) => obj[key] != null ? { [key]: fn(obj[key], domain) } : {};
    const dp = stream.deviationProbability;
    const deviationProbWalk = Array.isArray(dp) || (dp && typeof dp === "object");
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
        // read_direction: dominio {-1, +1}, non un continuo (PGE #207).
        ...wf(stream.grain, "readDirectionEnv", "direction"),
        // grain.envelope.curve: blend/morph curve, array or {type,points} —
        // both handled by rescaleEnvArray/truncateEnvArray.
        ...(stream.grain.envelope && typeof stream.grain.envelope === "object" && !Array.isArray(stream.grain.envelope)
          ? { envelope: { ...stream.grain.envelope, ...wf(stream.grain.envelope, "curve") } }
          : {}),
      } : stream.grain,
      pointer: stream.pointer ? { ...stream.pointer, ...wf(stream.pointer, "speedRatioEnv"), ...wf(stream.pointer, "loopStartEnv"), ...wf(stream.pointer, "loopDurEnv"), ...wf(stream.pointer, "loopEndEnv"), ...wf(stream.pointer, "offsetRangeEnv") } : stream.pointer,
      pitch:   stream.pitch   ? { ...stream.pitch,   ...wf(stream.pitch,   "valueEnv"), ...wf(stream.pitch, "rangeEnv") } : stream.pitch,
      ...(deviationProbWalk ? { deviationProbability: _applyDeviationProb(dp, fn) } : {}),
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
     opts: { hardMin, hardMax, xPrec=4, yPrec=2, xStep=0.001, xMin=0, xMax=1,
             snapYFromDelta }.
     `snapYFromDelta` sostituisce il clamp sull'asse valore su un dominio
     discreto (read_direction, PGE #207), e riceve il DELTA, non la somma.
     È voluto: su due soli stati l'asse non ha distanze, ha un verso. Sommando
     il delta al valore corrente, un passo da 0.1 partendo da -1 darebbe -0.9,
     che snappato torna a -1 — la freccia non farebbe niente finché il passo
     non supera 1. Con il delta, freccia su = lo stato in alto, freccia giù =
     quello in basso, che è l'unica cosa che quell'asse può voler dire. */
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
    } else if (opts.snapYFromDelta) {
      newVal = opts.snapYFromDelta(delta);
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
    // Il rescale tocca solo la x: nessun y viene calcolato, quindi nessun snap.
    return _applyEnvFields(stream, arr => rescaleEnvArray(arr, ratio));
  }

  function truncateStreamEnvelopes(stream) {
    return _applyEnvFields(stream,
      (arr, domain) => truncateEnvArray(arr, snapForDomain(domain)));
  }

  function streamWouldTruncate(stream, ratio) {
    const fields = [
      stream.densityEnv, stream.fillFactorEnv, stream.distributionEnv,
      stream.panEnv, stream.panRangeEnv, stream.volumeEnv, stream.volumeRangeEnv,
      stream.grain    && stream.grain.durationEnv,
      stream.grain    && stream.grain.durationRangeEnv,
      stream.grain    && stream.grain.readDirectionEnv,
      stream.grain    && stream.grain.envelope && stream.grain.envelope.curve,
      stream.pointer  && stream.pointer.speedRatioEnv,
      stream.pointer  && stream.pointer.loopStartEnv,
      stream.pointer  && stream.pointer.loopDurEnv,
      stream.pointer  && stream.pointer.loopEndEnv,
      stream.pointer  && stream.pointer.offsetRangeEnv,
      stream.pitch    && stream.pitch.valueEnv,
      stream.pitch    && stream.pitch.rangeEnv,
      ..._deviationProbEnvs(stream.deviationProbability),
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
  // (0.01 on a fine-grained parameter, else 1) so a flat curve isn't pinned to
  // an edge. `fine` is the caller's precision declaration, NOT the display unit:
  // the loop window is fine-grained in both its units, and in normalized it has
  // no unit string at all (issue #126) — reading the unit here would have
  // silently coarsened it to a 1-wide window on a [0,1] axis.
  // Pure: EnvelopeEditor recomputes it on open / param change / end-of-drag and
  // freezes the returned window during a drag (so the dragged point can't
  // "run away" under a rescaling axis). Returns { ymin, ymax }, ymax > ymin.
  function computeYFit(values, opts) {
    opts = opts || {};
    const { visMin, visMax, hardMin, hardMax } = opts;
    const fine = !!opts.fine;
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
    if (lo === hi) hi = lo + (fine ? 0.01 : 1);
    const range = hi - lo;
    hi = hi + range * padFrac;
    lo = lo - range * padFrac;
    if (typeof hardMax === "number") hi = Math.min(hardMax, hi);
    if (typeof hardMin === "number") lo = Math.max(hardMin, lo);
    if (!(hi > lo)) hi = lo + (fine ? 0.01 : 1);
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
    const unit = loopUnitInfo(stream).unit;
    if (unit === "normalized") return 1;
    return (typeof sampleDur === "number" && isFinite(sampleDur) && sampleDur > 0)
      ? sampleDur : null;
  }

  // Which unit the loop window is written in, and WHERE that unit comes from.
  // Same resolution as the engine (PointerController._pre_normalize_loop_params:
  // `loop_unit = params.get('loop_unit') or self._config.time_mode`), but it also
  // reports the provenance, because the provenance is the whole usability
  // problem: every stream the editor creates is born `time_mode: normalized`, so
  // the loop coordinates silently live in [0,1] — and the cap of 1 looks
  // arbitrary — even though no `loop_unit` key was ever written (issue #126).
  // The Inspector needs the source to (a) label the loop_unit control as
  // inherited and (b) delete the key instead of materializing a redundant one
  // when the user picks the value that was already in force.
  //   source "loop_unit" → pointer.loop_unit is explicit in the YAML
  //   source "time_mode" → inherited from the stream's time_mode
  //   source "default"   → neither key present, engine default "absolute"
  // Anything other than "normalized" means absolute seconds — the engine only
  // ever tests `!= 'normalized'` — so an unknown string resolves to "absolute"
  // here too, keeping the mirror faithful for hand-written YAML.
  function loopUnitInfo(stream) {
    const explicit = stream && stream.pointer && stream.pointer.loopUnit;
    if (explicit) {
      return { unit: explicit === "normalized" ? "normalized" : "absolute", source: "loop_unit" };
    }
    const tm = stream && stream.timeMode;
    if (tm) {
      return { unit: tm === "normalized" ? "normalized" : "absolute", source: "time_mode" };
    }
    return { unit: "absolute", source: "default" };
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

  // Le unità ammesse per grain.duration / grain.duration_range, nell'ordine in
  // cui il motore le dichiara (Stream.GRAIN_DURATION_UNITS). 'milliseconds' è
  // arrivato con PGE v5.2.0 (#171): a differenza di 'samples' il suo fattore è
  // fisso (1e-3) e non dipende da output_sr. Esportate perché il controllo
  // dell'Inspector ci costruisca sopra le opzioni: con la coppia cablata a mano
  // la terza unità non era selezionabile, e sceglierla cancellava la chiave.
  const GRAIN_DURATION_UNITS = ["seconds", "samples", "milliseconds"];

  // Mirror dei due rifiuti del motore su grain.duration_unit
  // (Stream._pre_normalize_grain_params).
  //
  //   "missing-duration" → unità non-secondi senza una grain.duration
  //                        esplicita. Il default 0.05 è in secondi e non viene
  //                        convertito: base (secondi) e duration_range
  //                        (nell'unità dichiarata) vivrebbero in domini
  //                        diversi, e il motore solleva MissingFieldError. Il
  //                        vincolo era di 'samples' finché le unità erano due;
  //                        da PGE #171 vale per ogni unità che non sia
  //                        'seconds'.
  //   "unknown"          → un'unità fuori dall'insieme (InvalidFieldValueError).
  //                        Non producibile dal controllo — arriva da uno YAML
  //                        scritto a mano — e precede il controllo sulla
  //                        durata, quindi resta anche con duration esplicita.
  //
  // 'seconds' e la chiave assente usano il default liberamente. `duration_unit:`
  // vuota (durationUnit null lato bridge) è trattata come assente: il
  // serializer la lascia cadere, quindi l'editor non la porta al render.
  // Ritorna null se valido/non applicabile, altrimenti { kind, unit } così il
  // chiamante costruisce il messaggio. Puro — niente DOM, niente chiamate al
  // motore.
  function grainDurationUnitError(grain) {
    if (!grain) return null;
    const unit = grain.durationUnit;
    if (unit == null || unit === "seconds") return null;
    if (GRAIN_DURATION_UNITS.indexOf(unit) === -1) return { kind: "unknown", unit };
    const hasScalar = grain.duration != null;
    const hasEnv = grain.durationEnv != null;
    return (hasScalar || hasEnv) ? null : { kind: "missing-duration", unit };
  }

  // Mirror dei due rifiuti del motore su grain.read_direction (PGE #207) che
  // l'editor può incontrare aprendo uno YAML scritto a mano. Non sono
  // producibili dai controlli — il verso è un controllo solo, e sceglie quale
  // chiave scrivere — ma un file caricato può contenerli, e allora il render
  // fallisce: meglio dirlo nell'Inspector che dopo un render andato a vuoto.
  //
  //   "conflict" → reverse e read_direction insieme. Errore esplicito, non una
  //                priorità: le due chiavi governano la stessa grandezza con
  //                semantiche opposte e il motore rifiuta di scegliere.
  //   "empty"    → `read_direction:` senza valore. A differenza di `reverse:`,
  //                dove la chiave vuota È la sintassi, qui è un errore.
  //   "domain"   → un valore fuori da {-1, +1}, scalare o dentro l'envelope.
  //
  // Ritorna null se valido/non applicabile, altrimenti { kind, value }.
  // Puro — niente DOM, niente chiamate al motore.
  function readDirectionError(grain) {
    if (!grain) return null;
    const present = grain.readDirection !== undefined || grain.readDirectionEnv != null;
    if (!present) return null;

    if (grain.reverse !== undefined) return { kind: "conflict" };

    if (grain.readDirectionEnv != null) {
      const bad = _envValuesOutsideDirection(grain.readDirectionEnv);
      return bad.length ? { kind: "domain", value: bad[0] } : null;
    }
    if (grain.readDirection == null) return { kind: "empty" };
    return DIRECTION_VALUES.includes(grain.readDirection)
      ? null : { kind: "domain", value: grain.readDirection };
  }

  // Raccoglie i valori Y fuori dominio in un envelope, in ogni forma che il
  // motore accetta. Serve solo a nominare il primo colpevole nel messaggio,
  // quindi non replica la validazione completa del motore: quella è del
  // language server, che vede il testo YAML e può ancorarla a una riga.
  function _envValuesOutsideDirection(env) {
    const out = [];
    const check = (y) => {
      if (typeof y === "number" && !DIRECTION_VALUES.includes(y)) out.push(y);
    };
    const walk = (arr) => {
      if (arr && typeof arr === "object" && !Array.isArray(arr) && Array.isArray(arr.points)) {
        walk(arr.points);
        return;
      }
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        if (PGEEnv.isBPGroup(item)) walk(item[0]);
        else if (PGEEnv.isCompactBlock(item)) walk(item[0]);
        else if (PGEEnv.isBreakpoint(item)) check(item[1]);
        else if (Array.isArray(item) && item.length >= 2) check(item[1]);
      }
    };
    walk(env);
    return out;
  }

  window.PGEEnvUtils = {
    DIRECTION_VALUES,
    snapDirection,
    snapForDomain,
    readDirectionError,
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
    loopUnitInfo,
    loopBoundsError,
    grainDurationUnitError,
    GRAIN_DURATION_UNITS,
  };
})();
