/* =============================================================================
 * envelope-catalog.js — window.PGEEnvCatalog
 *
 * Il catalogo di cosa l'EnvelopeEditor puo' aprire e disegnare: da uno stream
 * e dalla durata del sample, la lista delle voci (chiave, etichetta, path
 * dentro lo stream, unita', finestra visibile e bound duri) che il selettore
 * mostra e che il canvas usa per scalare gli assi.
 *
 * Viveva dentro EnvelopeEditor.jsx (#140). Sta qui per la ragione dei suoi tre
 * precedenti — history-core.js, render-status.js, tweaks-store.js: e' pura,
 * decide al posto della colla React, e un suo errore e' SILENZIOSO. Una voce
 * che manca rende irraggiungibile un envelope scritto (non apribile, non
 * disegnabile) e fa aprire all'Inspector un envelope diverso da quello
 * cliccato; una voce con l'unita' o il cap sbagliati apre l'asse fuori scala,
 * e computeYFit + clampY riscrivono il primo punto trascinato. Niente di tutto
 * cio' lascia traccia: si vede solo usando l'editor.
 *
 * Le tre decisioni che il catalogo NON prende da se' — e che percio' non vanno
 * ricopiate qui:
 *   - il cap del loop e il suffisso della sua unita' → PGEEnvUtils.loopEnvMax /
 *     loopUnitSuffix, gli stessi che legge l'Inspector (#126, #149);
 *   - i bound della durata del grano nell'unita' dichiarata →
 *     PGEEnvUtils.grainUnitBounds / grainUnitSuffix (PGE #158, #171), e quelli
 *     della sua banda → grainRangeBounds / grainRangeSuffix (PGE #267);
 *   - perche' una chiave di deviation_probability e' inerte su questo stream →
 *     PGEDeviationProb.inertReason, la stessa funzione che marca le righe
 *     dell'Inspector: due copie della stessa prosa divergerebbero al primo
 *     cambio di regola.
 *
 * Dipendenze lette a CHIAMATA (non al load): window.PGE_BOUNDS, PGEEnv,
 * PGEEnvUtils, PGEDeviationProb.
 * =========================================================================== */
(function () {
  "use strict";

  /* Derive env-editor bounds for a voices pitch param from a semitone baseline,
     scaled into the actual unit so cents/edo don't clip the axis. `signed` →
     symmetric ±range (step); otherwise 0..range (pitch_range). */
  function pitchEnvBounds(unit, semis, signed) {
    const E = window.PGEEnv;
    const toU = st => {
      const v = E.semitonesToPitch(st, unit);
      return E.pitchUnitIsInteger(unit) ? Math.round(v) : +v.toFixed(4);
    };
    const vis = toU(semis.vis);
    const hard = toU(semis.hard);
    return signed
      ? { visMin: -vis, visMax: vis, hardMin: -hard, hardMax: hard }
      : { visMin: 0,    visMax: vis, hardMin: 0,     hardMax: hard };
  }

  function listEnvelopes(stream, sampleDur) {
    if (!stream) return [];
    const PB = window.PGE_BOUNDS;
    // loop_start/end/dur can't address past the sample's end — clamp to it
    // (or to 1.0 in normalized mode). null when the duration is unknown, in
    // which case we fall back to the static PGE_BOUNDS cap. See loopEnvMax.
    const loopMax = window.PGEEnvUtils.loopEnvMax(stream, sampleDur);
    // …e il suffisso segue la stessa risoluzione, come nell'Inspector (issue
    // #126): in normalized le coordinate del loop non sono secondi, e un "s"
    // qui contraddirebbe l'asse tappato a 1 e la riga dell'Inspector accanto.
    // Su una grafia fuori vocabolario non c'è suffisso: lo decide loopUnitSuffix,
    // una sola volta per i due componenti.
    // La precisione NON viaggia sull'unità — vedi `fine` sotto.
    const loopUnitSuffix = window.PGEEnvUtils.loopUnitSuffix(stream.pointer);
    // Stessa storia sulla durata del grano (PGE #158, tre unità da #171): i bound
    // statici sono in secondi, i valori dell'envelope no. Presi come sono, una
    // curva in millisecondi resta tappata a 10 — dieci millisecondi invece di
    // dieci secondi — e non è solo una vista storta: computeYFit clampa la
    // finestra dentro [hardMin, hardMax] e clampY riporta ogni punto trascinato
    // sotto il cap, quindi il primo drag riscrive il valore. I bound li converte
    // grainUnitBounds, come loopEnvMax fa col cap del loop.
    const grainUnit = (stream.grain && stream.grain.durationUnit) || "seconds";
    const grainUnitSuffix = window.PGEEnvUtils.grainUnitSuffix(grainUnit);
    const grainDurBounds = window.PGEEnvUtils.grainUnitBounds(PB.grainDur, grainUnit);
    // La banda ha un'unita' sua (PGE #267): con `duration_range_unit: relative`
    // e' una FRAZIONE della base, dominio [0, 1] in ogni unita' della base e
    // nessun suffisso. Convertita come una durata, in millisecondi il cap
    // diventava 1000 e clampY lasciava trascinare un punto che il motore
    // rifiuta. Lo decidono grainRangeBounds / grainRangeSuffix, gli stessi che
    // legge l'Inspector.
    const grainRangeRelative = window.PGEEnvUtils.grainRangeIsRelative(stream.grain);
    const grainRangeBounds = window.PGEEnvUtils.grainRangeBounds(stream.grain, PB);
    const grainRangeSuffix = window.PGEEnvUtils.grainRangeSuffix(stream.grain);
    // Anche la finestra di partenza era scritta in secondi (1-100 ms di grana,
    // 0-500 ms di range): va detta nell'unità in vigore o si apre già fuori scala.
    // In relativo la finestra e' il dominio intero: una frazione non ha una
    // scala tipica da cui partire piu' stretta.
    const grainDurVis = window.PGEEnvUtils.grainUnitBounds({ min: 0.001, max: 0.1 }, grainUnit);
    const grainRangeVis = grainRangeRelative
      ? { min: 0, max: grainRangeBounds.max }
      : window.PGEEnvUtils.grainUnitBounds({ min: 0, max: 0.5 }, grainUnit);
    const list = [];
    if (stream.densityEnv) {
      list.push({ key: "density", label: "density", group: "Overall density",
        path: ["densityEnv"], unit: "g/s",
        visMin: 0, visMax: 50, hardMin: PB.density.min, hardMax: PB.density.max });
    }
    if (stream.fillFactorEnv) {
      list.push({ key: "fillFactor", label: "fill_factor", group: "Overall density",
        path: ["fillFactorEnv"], unit: "×",
        visMin: 0.1, visMax: 20, hardMin: PB.fillFactor.min, hardMax: PB.fillFactor.max });
    }
    if (stream.distributionEnv) {
      list.push({ key: "distribution", label: "distribution", group: "Distribution",
        path: ["distributionEnv"], unit: "",
        visMin: 0, visMax: 1, hardMin: PB.distribution.min, hardMax: PB.distribution.max });
    }
    if (stream.pointer && stream.pointer.speedRatioEnv) {
      list.push({ key: "speedRatio", label: "speed_ratio", group: "Pointer",
        path: ["pointer", "speedRatioEnv"], unit: "×",
        visMin: -1, visMax: 1, hardMin: PB.speedRatio.min, hardMax: PB.speedRatio.max });
    }
    if (stream.pointer && stream.pointer.loopStartEnv) {
      list.push({ key: "loopStart", label: "loop_start", group: "Pointer",
        path: ["pointer", "loopStartEnv"], unit: loopUnitSuffix, fine: true,
        visMin: 0, visMax: loopMax != null ? loopMax : 10,
        hardMin: PB.loopStart.min, hardMax: loopMax != null ? loopMax : PB.loopStart.max });
    }
    if (stream.pointer && stream.pointer.loopDurEnv) {
      list.push({ key: "loopDur", label: "loop_dur", group: "Pointer",
        path: ["pointer", "loopDurEnv"], unit: loopUnitSuffix, fine: true,
        visMin: 0, visMax: loopMax != null ? loopMax : 10,
        hardMin: PB.loopDur.min, hardMax: loopMax != null ? loopMax : PB.loopDur.max });
    }
    if (stream.pointer && stream.pointer.loopEndEnv) {
      list.push({ key: "loopEnd", label: "loop_end", group: "Pointer",
        path: ["pointer", "loopEndEnv"], unit: loopUnitSuffix, fine: true,
        visMin: 0, visMax: loopMax != null ? loopMax : 10,
        hardMin: PB.loopEnd.min, hardMax: loopMax != null ? loopMax : PB.loopEnd.max });
    }
    if (stream.pointer && stream.pointer.offsetRangeEnv) {
      list.push({ key: "offsetRange", label: "offset_range", group: "Pointer",
        path: ["pointer", "offsetRangeEnv"], unit: "",
        visMin: 0, visMax: 1, hardMin: PB.offsetRange.min, hardMax: PB.offsetRange.max });
    }
    if (stream.grain && stream.grain.durationEnv) {
      list.push({ key: "grainDur", label: "duration", group: "Grain",
        path: ["grain", "durationEnv"], unit: grainUnitSuffix, fine: true,
        visMin: grainDurVis.min, visMax: grainDurVis.max,
        hardMin: grainDurBounds.min, hardMax: grainDurBounds.max });
    }
    if (stream.grain && stream.grain.durationRangeEnv) {
      list.push({ key: "durationRange", label: "duration_range", group: "Grain",
        path: ["grain", "durationRangeEnv"], unit: grainRangeSuffix, fine: true,
        visMin: grainRangeVis.min, visMax: grainRangeVis.max,
        hardMin: grainRangeBounds.min, hardMax: grainRangeBounds.max });
    }
    if (stream.grain && stream.grain.readDirectionEnv) {
      // `domain: "direction"` (PGE #207) è ciò che distingue questo envelope da
      // tutti gli altri: i suoi y non vivono su un continuo ma su {-1, +1}, e il
      // motore rifiuta gli intermedi al parse invece di clamparli. I bound qui
      // restano [-1, 1] perché servono al disegno — è lo snap, non il clamp, a
      // far rispettare il dominio quando l'utente trascina.
      list.push({ key: "readDirection", label: "read_direction", group: "Grain",
        path: ["grain", "readDirectionEnv"], unit: "",
        domain: "direction", integer: true,
        visMin: -1, visMax: 1,
        hardMin: PB.readDirection.min, hardMax: PB.readDirection.max });
    }
    if (stream.panEnv) {
      list.push({ key: "pan", label: "pan", group: "Volume & Pan",
        path: ["panEnv"], unit: "°",
        visMin: -360, visMax: 360, hardMin: PB.pan.min, hardMax: PB.pan.max });
    }
    if (stream.panRangeEnv) {
      list.push({ key: "panRange", label: "pan_range", group: "Volume & Pan",
        path: ["panRangeEnv"], unit: "°",
        visMin: 0, visMax: 360, hardMin: PB.panRange.min, hardMax: PB.panRange.max });
    }
    if (stream.volumeEnv) {
      list.push({ key: "volume", label: "volume", group: "Volume & Pan",
        path: ["volumeEnv"], unit: "dB",
        visMin: -40, visMax: 0, hardMin: PB.volume.min, hardMax: PB.volume.max });
    }
    if (stream.volumeRangeEnv) {
      list.push({ key: "volumeRange", label: "volume_range", group: "Volume & Pan",
        path: ["volumeRangeEnv"], unit: "dB",
        visMin: 0, visMax: 12, hardMin: PB.volumeRange.min, hardMax: PB.volumeRange.max });
    }
    if (stream.pitch && stream.pitch.valueEnv) {
      const pu = stream.pitch.unit || "semitones";
      const puLabel = pu === "ratio" ? "ratio" : pu;
      const edoN = stream.pitch.edoDivisions || 12;
      // Il simbolo lo dice il modulo (PGEEnv.pitchUnitSymbol), come per le due
      // voci di voices.pitch qui sotto e come fa l'Inspector sulla stessa riga.
      // Scritto a mano qui era una seconda copia della stessa tabella, e su edo
      // diceva un'altra cosa: `°edo` contro il `°/N` dell'Inspector, cioe' la
      // stessa curva etichettata in due modi e senza il numero di divisioni,
      // che e' l'unica cosa che quel simbolo ha da dire.
      const puUnit = window.PGEEnv.pitchUnitSymbol(pu, edoN);
      // engine-driven: pitchUnitBounds reads PB.pitch (presets) / edoFactor (edo)
      const pb = window.PGEEnv.pitchUnitBounds(pu, edoN);
      const [pvMin, pvMax, phMin, phMax] = pu === "cents" ? [-1200, 1200, pb.min, pb.max]
        : pu === "quarter_tone" ? [-12, 12, pb.min, pb.max]
        : pu === "eighth_tone" ? [-24, 24, pb.min, pb.max]
        : pu === "ratio"       ? [0.5, 2, pb.min, pb.max]
        : [-12, 12, pb.min, pb.max];
      list.push({ key: "pitch", label: puLabel, group: "Pitch",
        path: ["pitch", "valueEnv"], unit: puUnit,
        integer: window.PGEEnv.pitchUnitIsInteger(pu),
        visMin: pvMin, visMax: pvMax, hardMin: phMin, hardMax: phMax });
    }
    if (stream.pitch && stream.pitch.rangeEnv) {
      const pu = stream.pitch.unit || "semitones";
      const edoN2 = stream.pitch.edoDivisions || 12;
      const puUnit = window.PGEEnv.pitchUnitSymbol(pu, edoN2);
      // engine-driven: pitchUnitBounds reads PB.pitch (presets) / edoFactor (edo)
      const prb = window.PGEEnv.pitchUnitBounds(pu, edoN2);
      const [prVis, prHard] = pu === "cents" ? [1200, prb.rangeMax]
        : pu === "quarter_tone" ? [12, prb.rangeMax]
        : pu === "eighth_tone" ? [24, prb.rangeMax]
        : pu === "ratio"       ? [2, prb.rangeMax]
        : [12, prb.rangeMax];
      list.push({ key: "pitchRange", label: "range", group: "Pitch",
        path: ["pitch", "rangeEnv"], unit: puUnit,
        integer: window.PGEEnv.pitchUnitIsInteger(pu),
        visMin: 0, visMax: prVis, hardMin: 0, hardMax: prHard });
    }
    if (stream.voices && stream.voices.numEnv) {
      list.push({ key: "voicesNum", label: "num_voices", group: "Voices",
        path: ["voices", "numEnv"], unit: "",
        visMin: 1, visMax: 16, hardMin: PB.voicesNum.min, hardMax: PB.voicesNum.max });
    }
    if (stream.voices && stream.voices.scatterEnv) {
      list.push({ key: "scatter", label: "scatter", group: "Voices",
        path: ["voices", "scatterEnv"], unit: "",
        visMin: 0, visMax: 1, hardMin: PB.scatter.min, hardMax: PB.scatter.max });
    }
    if (stream.voices && stream.voices.pitch && stream.voices.pitch.stepEnv) {
      const vpu = (stream.voices.pitch || {}).unit;
      const b = pitchEnvBounds(vpu, { vis: 12, hard: PB.voicePitchOffset.max }, true);
      list.push({ key: "voicesPitchStep", label: "pitch · step", group: "Voices",
        path: ["voices", "pitch", "stepEnv"], unit: window.PGEEnv.pitchUnitSymbol(vpu || "semitones"),
        integer: window.PGEEnv.pitchUnitIsInteger(vpu),
        visMin: b.visMin, visMax: b.visMax, hardMin: b.hardMin, hardMax: b.hardMax });
    }
    if (stream.voices && stream.voices.pitch && stream.voices.pitch.pitch_rangeEnv) {
      const vpu = (stream.voices.pitch || {}).unit;
      const b = pitchEnvBounds(vpu, { vis: 24, hard: 96 }, false);
      list.push({ key: "voicesPitchRange", label: "pitch · pitch_range", group: "Voices",
        path: ["voices", "pitch", "pitch_rangeEnv"], unit: window.PGEEnv.pitchUnitSymbol(vpu || "semitones"),
        integer: window.PGEEnv.pitchUnitIsInteger(vpu),
        visMin: b.visMin, visMax: b.visMax, hardMin: b.hardMin, hardMax: b.hardMax });
    }
    if (stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.stepEnv)
      list.push({ key: "voicesOnsetStep", label: "onset · step", group: "Voices",
        path: ["voices", "onset_offset", "stepEnv"], unit: "s", fine: true,
        visMin: 0, visMax: 1, hardMin: 0, hardMax: 60 });
    if (stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.baseEnv)
      list.push({ key: "voicesOnsetBase", label: "onset · base", group: "Voices",
        path: ["voices", "onset_offset", "baseEnv"], unit: "",
        visMin: 1, visMax: 4, hardMin: 0.01, hardMax: 100 });
    if (stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.max_offsetEnv)
      list.push({ key: "voicesOnsetMaxOffset", label: "onset · max_offset", group: "Voices",
        path: ["voices", "onset_offset", "max_offsetEnv"], unit: "s", fine: true,
        visMin: 0, visMax: 2, hardMin: 0, hardMax: 60 });
    if (stream.voices && stream.voices.pointer && stream.voices.pointer.stepEnv)
      list.push({ key: "voicesPointerStep", label: "pointer · step", group: "Voices",
        path: ["voices", "pointer", "stepEnv"], unit: "",
        visMin: -1, visMax: 1, hardMin: PB.voicePointerOffset.min, hardMax: PB.voicePointerOffset.max });
    if (stream.voices && stream.voices.pointer && stream.voices.pointer.pointer_rangeEnv)
      list.push({ key: "voicesPointerRange", label: "pointer · range", group: "Voices",
        path: ["voices", "pointer", "pointer_rangeEnv"], unit: "",
        visMin: 0, visMax: 1, hardMin: PB.voicePointerRange.min, hardMax: PB.voicePointerRange.max });
    if (stream.voices && stream.voices.pan && stream.voices.pan.spreadEnv)
      list.push({ key: "voicesPanSpread", label: "pan · spread", group: "Voices",
        path: ["voices", "pan", "spreadEnv"], unit: "°",
        visMin: 0, visMax: 360, hardMin: 0, hardMax: 3600 });
    if (stream.voices && stream.voices.pan && stream.voices.pan.stepEnv)
      list.push({ key: "voicesPanStep", label: "pan · step", group: "Voices",
        path: ["voices", "pan", "stepEnv"], unit: "°",
        visMin: -90, visMax: 90, hardMin: -3600, hardMax: 3600 });
    // deviation_probability env detection goes through the shared classifier
    // (window.PGEDeviationProb), so the typed {type, points} form (cubic global
    // interp) registers as the
    // global env — not silently dropped. isEnvValue is true for [[t,v],…] and
    // {type, points}; the per-param branch only runs when the value is NOT itself
    // an env (i.e. a real per-param dict).
    const PGEDeviationProb = window.PGEDeviationProb;
    if (PGEDeviationProb.isEnvValue(stream.deviationProbability)) {
      list.push({ key: "deviation_probability", label: "probability", group: "Deviation",
        path: ["deviationProbability"], unit: "%",
        visMin: 0, visMax: 100, hardMin: 0, hardMax: 100 });
    } else if (PGEDeviationProb.mode(stream.deviationProbability) === "perParam") {
      // ALL_PARAM_KEYS, non PARAM_KEYS: questo e' il catalogo, e ha lo stesso
      // vincolo del walk di envelope-utils — sbagliare per difetto lascia un
      // envelope scritto senza voce, cioe' non apribile e non disegnabile, e il
      // click sull'env mini dell'Inspector apre un altro envelope invece di
      // dirlo. Le condizionali (reverse / read_direction / pc_rand_envelope) e
      // la chiave inerte `envelope` sono scrivibili, quindi vanno mostrate:
      // quali il motore CONSULTI e' la domanda di error(), non di questa.
      // ...ma elencarle non basta: su questo stream alcune sono INERTI, e senza
      // marcatore si disegna una curva su una chiave che il motore non legge,
      // nell'unico posto in cui non lo si dice — l'Inspector le marca gia'. Il
      // motivo e' quello dell'Inspector, non una seconda copia della stessa
      // prosa (PGEDeviationProb.inertReason).
      const liveKeys = PGEDeviationProb.liveParamKeys(stream);
      for (const pk of PGEDeviationProb.ALL_PARAM_KEYS) {
        if (PGEDeviationProb.isEnvValue(stream.deviationProbability[pk])) {
          list.push({ key: "deviation_probability_" + pk, label: pk, group: "Deviation",
            path: ["deviationProbability", pk], unit: "%",
            inert: PGEDeviationProb.inertReason(pk, liveKeys),
            visMin: 0, visMax: 100, hardMin: 0, hardMax: 100 });
        }
      }
    }
    // The blend curve is either a plain [[t,v],…] array or the typed dict form
    // {type, points} the editor emits when the user picks step/cubic global
    // interp. Recognize both, or a non-linear curve silently drops out of the
    // editor (and used to crash on serialize for multistate).
    const _gEnv = stream.grain && stream.grain.envelope;
    const _gEnvCurve = (_gEnv && typeof _gEnv === "object" && !Array.isArray(_gEnv)) ? _gEnv.curve : null;
    if (_gEnvCurve != null && (Array.isArray(_gEnvCurve) || (typeof _gEnvCurve === "object" && Array.isArray(_gEnvCurve.points)))) {
      const genv = stream.grain.envelope;
      const isMultistate = Array.isArray(genv.states);
      const vmax = isMultistate ? Math.max(1, genv.states.length - 1) : 1;
      list.push({ key: "grainEnvCurve", label: isMultistate ? "states · blend" : "transition · blend", group: "Grain",
        path: ["grain", "envelope", "curve"], unit: "",
        visMin: 0, visMax: vmax, hardMin: 0, hardMax: vmax });
    }
    return list;
  }

  window.PGEEnvCatalog = { listEnvelopes, pitchEnvBounds };
})();
