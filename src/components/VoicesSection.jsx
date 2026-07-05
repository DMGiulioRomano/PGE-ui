/* @jsx React.createElement */
const { useState: useStateVS } = React;

/* Voices Section — full strategy config per PythonGranularEngine docs/multi-voice.md */

const PITCH_STRATEGIES = [
  { value: "step",       label: "step",       desc: "i × step  · arithmetic progression" },
  { value: "range",      label: "range",      desc: "fill pitch_range across N voices" },
  { value: "chord",      label: "chord",      desc: "harmonic intervals, octave-wraps" },
  { value: "chord_progression", label: "chord progression", desc: "harmony over time · per-voice glissando/step" },
  { value: "stochastic", label: "stochastic", desc: "seeded random in ±pitch_range" },
  { value: "spectral",   label: "spectral",   desc: "harmonic series · offset(i)=round(12×log₂(i+1))" },
];
const ONSET_STRATEGIES = [
  { value: "linear",     label: "linear",     desc: "i × step (s)" },
  { value: "geometric",  label: "geometric",  desc: "step × baseⁱ⁻¹" },
  { value: "stochastic", label: "stochastic", desc: "seeded random in [0, max]" },
];
const POINTER_STRATEGIES = [
  { value: "linear",     label: "linear",     desc: "i × step (s · or % sample if normalized)" },
  { value: "stochastic", label: "stochastic", desc: "seeded random in ±range (s · or % sample if normalized)" },
];
const PAN_STRATEGIES = [
  { value: "range",      label: "range",      desc: "equidistant in ±spread/2" },
  { value: "stochastic", label: "stochastic", desc: "seeded random in ±spread/2" },
  { value: "step",       label: "step",       desc: "voice i → i × step" },
];
const CHORDS_3V = ["maj","min","dim","aug","sus2","sus4"];
const CHORDS_4V = ["dom7","maj7","min7","dim7","minmaj7"];
const CHORDS_5V = ["dom9","maj9","min9","9sus4"];
const CHORDS_6V = ["dom9s11","maj9s11","min11"];
const CHORDS_7V = ["dom13","min13","maj13s11","altered"];
const CHORD_GROUPS = [
  { label: "3 voices", chords: CHORDS_3V },
  { label: "4 voices", chords: CHORDS_4V },
  { label: "5 voices", chords: CHORDS_5V },
  { label: "6 voices", chords: CHORDS_6V },
  { label: "7 voices", chords: CHORDS_7V },
];

// note count per chord, derived from the voices-count groups above
// (index 0 = 3 voices, …, index 4 = 7 voices). Drives the inversion range.
const CHORD_SIZES = {};
CHORD_GROUPS.forEach((g, i) => { g.chords.forEach(c => { CHORD_SIZES[c] = i + 3; }); });

// progression step accessors — tolerate the three YAML forms the engine accepts:
//   [t, "maj7"] · [t, "min7", 1] · [t, {chord, inversion}]
function cpStepT(step)     { return Array.isArray(step) ? (step[0] ?? 0) : 0; }
function cpStepChord(step) {
  if (!Array.isArray(step)) return "maj7";
  const s = step[1];
  return (s && typeof s === "object") ? s.chord : s;
}
function cpStepInv(step) {
  if (!Array.isArray(step)) return 0;
  const s = step[1];
  if (s && typeof s === "object") return s.inversion || 0;
  return step[2] || 0;
}
// normalize to the compact array form on any edit: 2-tuple when root position,
// 3-tuple otherwise (matches the issue examples, keeps YAML clean).
function cpMakeStep(t, chord, inv) { return inv ? [t, chord, inv] : [t, chord]; }

const STRATEGY_DEFAULTS = {
  pitch: {
    step:       { step: 3.0 },
    range:      { pitch_range: 12.0 },
    chord:      { chord: "dom7", inversion: 0 },
    chord_progression: { progression: [[0, "maj7"], [8, "min7"]], interp: "linear", voice_leading: "nearest" },
    stochastic: { pitch_range: 12.0 },
    spectral:   { max_partial: 16 },
  },
  onset_offset: {
    linear:     { step: 0.05 },
    geometric:  { step: 0.05, base: 2.0 },
    stochastic: { max_offset: 0.1 },
  },
  pointer: {
    linear:     { step: 0.1 },
    stochastic: { pointer_range: 0.02 },
  },
  pan: {
    range:      { spread: 60.0 },
    stochastic: { spread: 60.0 },
    step:       { step: 15.0 },
  },
};

function StrategySelect({ value, options, onChange }) {
  const cur = options.find(o => o.value === value) || options[0];
  return (
    <div className="strategy-select">
      <select value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="hint">{cur.desc}</span>
    </div>
  );
}

function VoiceParamRow({ name, value, unit, onChange }) {
  const { ParamRow } = window.PGE;
  return <ParamRow name={name} mode="scalar" value={value != null ? value : "—"} unit={unit} onValue={onChange} />;
}

function toggleStratParam(v, dim, paramKey, defaultVal, newMode, onChange) {
  const cur = v[dim] || {};
  const envKey = paramKey + "Env";
  if (newMode === "env") {
    const val = cur[paramKey] != null ? cur[paramKey] : defaultVal;
    onChange({ voices: { ...v, [dim]: { ...cur, [paramKey]: null, [envKey]: [[0, val], [1, val]] } } });
  } else {
    const arr = cur[envKey];
    const val = (arr && arr[0] && arr[0][1]) != null ? (arr[0][1]) : defaultVal;
    onChange({ voices: { ...v, [dim]: { ...cur, [paramKey]: val, [envKey]: null } } });
  }
}

function VoiceStratParamRow({ name, value, valueEnv, unit, onValue, onMode, onEditEnv, steps }) {
  const { ParamRow } = window.PGE;
  const mode = valueEnv ? "env" : "scalar";
  return <ParamRow
    name={name} mode={mode} onMode={onMode}
    value={value != null ? value : "—"}
    unit={valueEnv ? "" : (unit || "")}
    accent={!!valueEnv}
    envValue={valueEnv || null}
    onEditEnv={onEditEnv}
    onValue={onValue}
    steps={steps}
  />;
}

function ChordProgressionEditor({ pitch, timeMode, onPatch }) {
  const prog = Array.isArray(pitch.progression) ? pitch.progression : [];
  const interp = pitch.interp || "linear";
  const voiceLeading = pitch.voice_leading || "nearest";
  const normalized = timeMode === "normalized";
  const tUnit = normalized ? "0..1" : "s";

  function writeStep(i, t, chord, inv) {
    const next = prog.slice();
    next[i] = cpMakeStep(t, chord, inv);
    onPatch({ progression: next });
  }
  function addStep() {
    const last = prog.length ? prog[prog.length - 1] : null;
    const t = last ? cpStepT(last) : 0;
    const chord = last ? cpStepChord(last) : "maj7";
    onPatch({ progression: prog.concat([[t, chord]]) });
  }
  function removeStep(i) {
    const next = prog.slice();
    next.splice(i, 1);
    onPatch({ progression: next });
  }

  return (
    <>
      <div className="pge-prow">
        <span className="k">interp</span><span />
        <span className="v">
          <select className="pge-mini-select" value={interp}
                  onChange={e => onPatch({ interp: e.target.value })}>
            <option value="linear">linear</option>
            <option value="cubic">cubic</option>
            <option value="step">step</option>
          </select>
        </span><span />
      </div>
      <div className="pge-prow">
        <span className="k">voice_leading</span><span />
        <span className="v">
          <select className="pge-mini-select" value={voiceLeading}
                  onChange={e => onPatch({ voice_leading: e.target.value })}>
            <option value="nearest">nearest</option>
            <option value="positional">positional</option>
          </select>
        </span><span />
      </div>
      <div className="cp-list">
        <div className="cp-head">
          <span>t · {tUnit}</span><span>chord</span><span>inv</span><span />
        </div>
        {prog.length === 0 ? (
          <div className="voice-empty">empty progression · add at least one chord</div>
        ) : null}
        {prog.map((step, i) => {
          const chord = cpStepChord(step);
          const nInv = CHORD_SIZES[chord] || 1;
          const inv = Math.min(cpStepInv(step), nInv - 1);
          return (
            <div className="cp-row" key={i}>
              <input type="number" className="pge-mini-input cp-t"
                     step={normalized ? 0.01 : 0.1}
                     value={cpStepT(step)}
                     onChange={e => writeStep(i, +e.target.value || 0, chord, inv)} />
              <select className="pge-mini-select cp-chord" value={chord}
                      onChange={e => {
                        const nc = e.target.value;
                        const cap = (CHORD_SIZES[nc] || 1) - 1;
                        writeStep(i, cpStepT(step), nc, Math.min(inv, cap));
                      }}>
                {CHORD_GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.chords.map(c => <option key={c} value={c}>{c}</option>)}
                  </optgroup>
                ))}
              </select>
              <input type="number" className="pge-mini-input cp-inv"
                     min={0} max={nInv - 1} step={1} value={inv}
                     title={`inversion ∈ [0, ${nInv - 1}] for ${chord}`}
                     onChange={e => writeStep(i, cpStepT(step), chord,
                       Math.max(0, Math.min(nInv - 1, Math.round(+e.target.value || 0))))} />
              <button className="pge-btn ghost cp-del" title="remove step"
                      onClick={() => removeStep(i)}>✕</button>
            </div>
          );
        })}
        <button className="pge-btn ghost cp-add" onClick={addStep}>+ add chord</button>
      </div>
      <div className="voice-meta">
        chord = f(time) · voice 0 = reference (root motion lives in the stream pitch envelope) ·
        interp linear/cubic = glissando, step = blocks · times follow stream time_mode
        ({normalized ? "0..1 of duration" : "seconds"}) and must be non-decreasing · semitone-locked
      </div>
    </>
  );
}

function VoiceGroup({ title, strategies, voices, dim, onChange, children, extraTopRow }) {
  const { Section } = window.PGE;
  const cur = (voices[dim] && voices[dim].strategy) || "off";
  const enabled = cur !== "off";
  const displayStrategy = enabled ? cur : strategies[0].value;
  const optsWithOff = [{ value: "off", label: "— off —", desc: "no voice offset on this dimension" }, ...strategies];

  return (
    <Section title={title}
             badge={<span className="mono" style={{color: enabled ? "var(--accent)" : "var(--fg-3)"}}>{enabled ? cur : "off"}</span>}
             defaultOpen={enabled}>
      <div className="pge-prow">
        <span className="k">strategy</span>
        <span />
        <span className="v">
          <StrategySelect
            value={enabled ? cur : "off"}
            options={optsWithOff}
            onChange={v => {
            if (v === "off") { onChange({ [dim]: null }); return; }
            const defaults = (STRATEGY_DEFAULTS[dim] || {})[v] || {};
            onChange({ [dim]: { ...defaults, strategy: v } });
          }} />
        </span>
        <span />
      </div>
      {extraTopRow && enabled ? extraTopRow(displayStrategy) : null}
      {enabled ? children(displayStrategy) : (
        <div className="voice-empty">no offset · all voices share this dimension</div>
      )}
    </Section>
  );
}

function VoicesSection({ stream, onChange, onFocusEnvParam }) {
  const { Section, ParamRow, Seg } = window.PGE;
  const v = stream.voices || { num: 1 };
  const N = v.num != null ? v.num : (v.numEnv ? null : 1);
  const numMode = v.numEnv ? "env" : "scalar";
  const scatterMode = v.scatterEnv ? "env" : "scalar";

  function update(patch) {
    onChange({ voices: { ...v, ...patch } });
  }
  function updateDim(dim, patch) {
    onChange({ voices: { ...v, [dim]: { ...(v[dim] || {}), ...patch } } });
  }
  function toggleNumMode(newMode) {
    if (newMode === "env") {
      const val = v.num != null ? v.num : 1;
      update({ num: null, numEnv: [[0, val], [1, val]] });
    } else {
      const val = (v.numEnv && v.numEnv[0] && v.numEnv[0][1]) || 1;
      update({ num: val, numEnv: null });
    }
  }
  function toggleScatterMode(newMode) {
    if (newMode === "env") {
      const val = v.scatter != null ? v.scatter : 0;
      update({ scatter: null, scatterEnv: [[0, val], [1, val]] });
    } else {
      const val = (v.scatterEnv && v.scatterEnv[0] && v.scatterEnv[0][1]) || 0;
      update({ scatter: val, scatterEnv: null });
    }
  }

  return (
    <Section title="Voices"
             badge={<span className="mono">{N != null ? `${N} voice${N>1?"s":""}` : "voices env"}</span>}
             defaultOpen={true}>
      <ParamRow name="num_voices"
                mode={numMode} onMode={toggleNumMode}
                value={N != null ? N : "—"} unit={v.numEnv ? "" : ""}
                accent={v.numEnv != null}
                envValue={v.numEnv}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesNum") : undefined}
                onValue={x => update({ num: Math.max(1, Math.round(x)) })} />
      <ParamRow name="scatter"
                mode={scatterMode} onMode={toggleScatterMode}
                value={v.scatter != null ? v.scatter : (v.scatterEnv ? "—" : 0)} unit=""
                accent={v.scatterEnv != null}
                envValue={v.scatterEnv}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("scatter") : undefined}
                onValue={x => update({ scatter: x })} />
      <div className="voice-help">voice 0 is reference (all offsets = 0). additional voices receive offsets from each strategy below. scatter ∈ [0,1] randomizes per-voice timing.</div>

      <div className="voice-substack">

      {/* PITCH */}
      <VoiceGroup title="Pitch" strategies={PITCH_STRATEGIES}
                  voices={v} dim="pitch" onChange={update}
                  extraTopRow={(strat) => {
                    // semitone-locked strategies: no unit selector
                    if (strat === "chord" || strat === "chord_progression" || strat === "spectral") return null;
                    const curUnit = (v.pitch||{}).unit;
                    const isEdo = curUnit && typeof curUnit === "object";
                    const unitStr = isEdo ? "edo" : (curUnit || "semitones");
                    function setUnit(u) {
                      const edoN = isEdo ? curUnit.edo : 12;
                      const newUnit = u === "edo" ? { edo: edoN } : u;
                      const E = window.PGEEnv;
                      const p = v.pitch || {};
                      const fromEdo = isEdo ? curUnit.edo : 12;
                      const toEdo = u === "edo" ? edoN : 12;
                      const patch = { unit: newUnit };
                      // destination bounds: clamp so a change of unit can't push
                      // a value past the new unit's safe range. `step` is a
                      // signed pitch (full [min,max]); `pitch_range` is a width
                      // (0 stays 0, clamp into [0, rangeMax]).
                      const nb = E.pitchUnitBounds(newUnit, toEdo);
                      const bounds = {
                        step:        { min: nb.min, max: nb.max },
                        pitch_range: { min: 0, max: nb.rangeMax },
                      };
                      // convert scalars + envelope breakpoints for both pitch params
                      ["step", "pitch_range"].forEach(key => {
                        const isRange = key === "pitch_range";
                        if (p[key] != null) {
                          patch[key] = isRange
                            ? E.convertPitchRange(p[key], curUnit, newUnit, fromEdo, toEdo, bounds[key])
                            : E.convertPitchValue(p[key], curUnit, newUnit, fromEdo, toEdo, bounds[key]);
                        }
                        const envKey = key + "Env";
                        if (Array.isArray(p[envKey])) {
                          patch[envKey] = isRange
                            ? E.convertPitchRangeEnv(p[envKey], curUnit, newUnit, fromEdo, toEdo, bounds[key])
                            : E.convertPitchEnv(p[envKey], curUnit, newUnit, fromEdo, toEdo, bounds[key]);
                        }
                      });
                      updateDim("pitch", patch);
                    }
                    return (
                      <>
                        <div className="pge-prow">
                          <span className="k">unit</span>
                          <span />
                          <span className="v">
                            <select className="pge-mini-select" value={unitStr}
                                    onChange={e => setUnit(e.target.value)}>
                              <option value="semitones">semitones</option>
                              <option value="cents">cents</option>
                              <option value="quarter_tone">quarter_tone</option>
                              <option value="eighth_tone">eighth_tone</option>
                              <option value="edo">edo (N-TET)</option>
                              <option value="ratio">ratio</option>
                            </select>
                          </span>
                          <span />
                        </div>
                        {unitStr === "edo" ? (
                          <div className="pge-prow">
                            <span className="k">divisions</span>
                            <span />
                            <span className="v">
                              <input type="number" className="pge-mini-input" min={1} step={1}
                                     value={isEdo ? curUnit.edo : 12}
                                     onChange={e => updateDim("pitch", { unit: { edo: Math.max(1, Math.round(+e.target.value || 12)) } })} />
                              <span className="hint">divisions/octave</span>
                            </span>
                            <span />
                          </div>
                        ) : null}
                      </>
                    );
                  }}>
        {(strat) => (
          <>
            {strat === "step" ? (
              <VoiceStratParamRow name="step"
                value={(v.pitch||{}).step} valueEnv={(v.pitch||{}).stepEnv}
                unit={window.PGEEnv.pitchUnitSymbol((v.pitch||{}).unit || "semitones")}
                steps={window.PGEEnv.pitchUnitIsInteger((v.pitch||{}).unit) ? [1, 10, 100] : [0.1, 1, 10]}
                onValue={x => updateDim("pitch", { step: window.PGEEnv.pitchUnitIsInteger((v.pitch||{}).unit) ? Math.round(x) : x })}
                onMode={m => toggleStratParam(v, "pitch", "step", 3.0, m, onChange)}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPitchStep") : undefined} />
            ) : null}
            {strat === "range" ? (
              <VoiceStratParamRow name="pitch_range"
                value={(v.pitch||{}).pitch_range} valueEnv={(v.pitch||{}).pitch_rangeEnv}
                unit={window.PGEEnv.pitchUnitSymbol((v.pitch||{}).unit || "semitones")}
                steps={window.PGEEnv.pitchUnitIsInteger((v.pitch||{}).unit) ? [1, 10, 100] : [0.1, 1, 10]}
                onValue={x => updateDim("pitch", { pitch_range: window.PGEEnv.pitchUnitIsInteger((v.pitch||{}).unit) ? Math.round(x) : x })}
                onMode={m => toggleStratParam(v, "pitch", "pitch_range", 12.0, m, onChange)}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPitchRange") : undefined} />
            ) : null}
            {strat === "chord" ? (
              <>
                <div className="pge-prow">
                  <span className="k">chord</span>
                  <span />
                  <span className="v">
                    <select className="pge-mini-select" value={(v.pitch||{}).chord || "dom7"}
                            onChange={e => updateDim("pitch", { chord: e.target.value })}>
                      {CHORD_GROUPS.map(g => (
                        <optgroup key={g.label} label={g.label}>
                          {g.chords.map(c => <option key={c} value={c}>{c}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </span>
                  <span />
                </div>
                <VoiceParamRow name="inversion" value={(v.pitch||{}).inversion ?? 0} unit=""
                  onChange={x => updateDim("pitch", { inversion: Math.max(0, Math.round(x)) })} />
              </>
            ) : null}
            {strat === "chord_progression" ? (
              <ChordProgressionEditor
                pitch={v.pitch || {}}
                timeMode={stream.timeMode}
                onPatch={patch => updateDim("pitch", patch)} />
            ) : null}
            {strat === "stochastic" ? (
              <>
                <VoiceStratParamRow name="pitch_range"
                  value={(v.pitch||{}).pitch_range} valueEnv={(v.pitch||{}).pitch_rangeEnv}
                  unit={window.PGEEnv.pitchUnitSymbol((v.pitch||{}).unit || "semitones")}
                  steps={window.PGEEnv.pitchUnitIsInteger((v.pitch||{}).unit) ? [1, 10, 100] : [0.1, 1, 10]}
                  onValue={x => updateDim("pitch", { pitch_range: window.PGEEnv.pitchUnitIsInteger((v.pitch||{}).unit) ? Math.round(x) : x })}
                  onMode={m => toggleStratParam(v, "pitch", "pitch_range", 12.0, m, onChange)}
                  onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPitchRange") : undefined} />
                <div className="voice-meta">seed = hash(stream_id + voice_idx) · direction cached</div>
              </>
            ) : null}
            {strat === "spectral" ? (
              <>
                <VoiceParamRow name="max_partial" value={(v.pitch||{}).max_partial ?? 16} unit=""
                  onChange={x => updateDim("pitch", { max_partial: Math.max(1, Math.round(x)) })} />
                <div className="voice-meta">harmonic series · voice i → round(12×log₂(i+1)) st</div>
              </>
            ) : null}
          </>
        )}
      </VoiceGroup>

      {/* ONSET */}
      <VoiceGroup title="Onset offset" strategies={ONSET_STRATEGIES}
                  voices={v} dim="onset_offset" onChange={update}>
        {(strat) => (
          <>
            {strat === "linear" ? (
              <VoiceStratParamRow name="step"
                value={(v.onset_offset||{}).step} valueEnv={(v.onset_offset||{}).stepEnv}
                unit="s"
                onValue={x => updateDim("onset_offset", { step: x })}
                onMode={m => toggleStratParam(v, "onset_offset", "step", 0.05, m, onChange)}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesOnsetStep") : undefined} />
            ) : null}
            {strat === "geometric" ? (
              <>
                <VoiceStratParamRow name="step"
                  value={(v.onset_offset||{}).step} valueEnv={(v.onset_offset||{}).stepEnv}
                  unit="s"
                  onValue={x => updateDim("onset_offset", { step: x })}
                  onMode={m => toggleStratParam(v, "onset_offset", "step", 0.05, m, onChange)}
                  onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesOnsetStep") : undefined} />
                <VoiceStratParamRow name="base"
                  value={(v.onset_offset||{}).base} valueEnv={(v.onset_offset||{}).baseEnv}
                  unit=""
                  onValue={x => updateDim("onset_offset", { base: x })}
                  onMode={m => toggleStratParam(v, "onset_offset", "base", 2.0, m, onChange)}
                  onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesOnsetBase") : undefined} />
              </>
            ) : null}
            {strat === "stochastic" ? (
              <>
                <VoiceStratParamRow name="max_offset"
                  value={(v.onset_offset||{}).max_offset} valueEnv={(v.onset_offset||{}).max_offsetEnv}
                  unit="s"
                  onValue={x => updateDim("onset_offset", { max_offset: x })}
                  onMode={m => toggleStratParam(v, "onset_offset", "max_offset", 0.1, m, onChange)}
                  onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesOnsetMaxOffset") : undefined} />
                <div className="voice-meta">unidirectional [0, max] · voices never precede voice 0</div>
              </>
            ) : null}
          </>
        )}
      </VoiceGroup>

      {/* POINTER */}
      <VoiceGroup title="Pointer" strategies={POINTER_STRATEGIES}
                  voices={v} dim="pointer" onChange={update}>
        {(strat) => (
          <>
            {strat === "linear" ? (
              <VoiceStratParamRow name="step"
                value={(v.pointer||{}).step} valueEnv={(v.pointer||{}).stepEnv}
                unit={(v.pointer||{}).normalized ? "×sample" : "s"}
                onValue={x => updateDim("pointer", { step: x })}
                onMode={m => toggleStratParam(v, "pointer", "step", 0.1, m, onChange)}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPointerStep") : undefined} />
            ) : null}
            {strat === "stochastic" ? (
              <VoiceStratParamRow name="pointer_range"
                value={(v.pointer||{}).pointer_range} valueEnv={(v.pointer||{}).pointer_rangeEnv}
                unit={(v.pointer||{}).normalized ? "×sample" : "s"}
                onValue={x => updateDim("pointer", { pointer_range: x })}
                onMode={m => toggleStratParam(v, "pointer", "pointer_range", 0.02, m, onChange)}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPointerRange") : undefined} />
            ) : null}
            <div className="pge-prow">
              <span className="k">normalized</span>
              <span />
              <span className="v">
                <input type="checkbox"
                  checked={!!(v.pointer||{}).normalized}
                  onChange={e => updateDim("pointer", {
                    normalized: e.target.checked ? true : undefined
                  })} />
                <span className="hint">{(v.pointer||{}).normalized
                  ? "offset as fraction of sample_dur_sec"
                  : "offset in seconds (default)"}</span>
              </span>
              <span />
            </div>
            <div className="voice-meta">offset in s · sums onto base pointer + grain jitter · with a loop, confined to [loop_start, loop_end)</div>
          </>
        )}
      </VoiceGroup>

      {/* PAN */}
      <VoiceGroup title="Pan" strategies={PAN_STRATEGIES}
                  voices={v} dim="pan" onChange={update}>
        {(strat) => (
          <>
            {strat === "range" || strat === "stochastic" ? (
              <VoiceStratParamRow name="spread"
                value={(v.pan||{}).spread} valueEnv={(v.pan||{}).spreadEnv}
                unit="°"
                onValue={x => updateDim("pan", { spread: x })}
                onMode={m => toggleStratParam(v, "pan", "spread", 60.0, m, onChange)}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPanSpread") : undefined} />
            ) : null}
            {strat === "step" ? (
              <VoiceStratParamRow name="step"
                value={(v.pan||{}).step} valueEnv={(v.pan||{}).stepEnv}
                unit="°"
                onValue={x => updateDim("pan", { step: x })}
                onMode={m => toggleStratParam(v, "pan", "step", 15.0, m, onChange)}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPanStep") : undefined} />
            ) : null}
            {strat === "range" ? (
              <div className="voice-meta">equidistant · voice 0 = 0 · voices 1..N fill ±spread/2</div>
            ) : null}
            {strat === "stochastic" ? (
              <div className="voice-meta">seeded random direction × spread/2 · voice 0 = 0</div>
            ) : null}
            {strat === "step" ? (
              <div className="voice-meta">voice i → i × step° · voice 0 = 0 · step may be negative</div>
            ) : null}
          </>
        )}
      </VoiceGroup>

      </div>
    </Section>
  );
}

window.PGE = window.PGE || {};
window.PGE.VoicesSection = VoicesSection;
