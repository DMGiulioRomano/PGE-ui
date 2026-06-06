/* @jsx React.createElement */
const { useState: useStateVS } = React;

/* Voices Section — full strategy config per PythonGranularEngine docs/multi-voice.md */

const PITCH_STRATEGIES = [
  { value: "step",       label: "step",       desc: "i × step  · arithmetic progression" },
  { value: "range",      label: "range",      desc: "fill pitch_range across N voices" },
  { value: "chord",      label: "chord",      desc: "harmonic intervals, octave-wraps" },
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
  { value: "linear",     label: "linear",     desc: "symmetric ±spread/2" },
  { value: "random",     label: "random",     desc: "seeded random in ±spread/2" },
  { value: "additive",   label: "additive",   desc: "constant offset, no spread" },
];
const CHORDS = ["maj","min","dom7","maj7","min7","dim","aug","sus2","sus4","dim7","minmaj7"];

const STRATEGY_DEFAULTS = {
  pitch: {
    step:       { step: 3.0 },
    range:      { pitch_range: 12.0 },
    chord:      { chord: "dom7", inversion: 0 },
    stochastic: { pitch_range: 0.5 },
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
    linear:     { spread: 60.0 },
    random:     { spread: 60.0 },
    additive:   { spread: 60.0 },
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

function VoiceStratParamRow({ name, value, valueEnv, unit, onValue, onMode, onEditEnv }) {
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
  />;
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
                    if (strat === "chord" || strat === "spectral") return null;
                    const curUnit = (v.pitch||{}).unit;
                    const isEdo = curUnit && typeof curUnit === "object";
                    const unitStr = isEdo ? "edo" : (curUnit || "semitones");
                    function setUnit(u) {
                      const edoN = isEdo ? curUnit.edo : 12;
                      const newUnit = u === "edo" ? { edo: edoN } : u;
                      updateDim("pitch", { unit: newUnit });
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
                unit="st"
                onValue={x => updateDim("pitch", { step: x })}
                onMode={m => toggleStratParam(v, "pitch", "step", 3.0, m, onChange)}
                onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPitchStep") : undefined} />
            ) : null}
            {strat === "range" ? (
              <VoiceStratParamRow name="pitch_range"
                value={(v.pitch||{}).pitch_range} valueEnv={(v.pitch||{}).pitch_rangeEnv}
                unit=""
                onValue={x => updateDim("pitch", { pitch_range: x })}
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
                      {CHORDS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </span>
                  <span />
                </div>
                <VoiceParamRow name="inversion" value={(v.pitch||{}).inversion ?? 0} unit=""
                  onChange={x => updateDim("pitch", { inversion: Math.max(0, Math.round(x)) })} />
              </>
            ) : null}
            {strat === "stochastic" ? (
              <>
                <VoiceStratParamRow name="pitch_range"
                  value={(v.pitch||{}).pitch_range} valueEnv={(v.pitch||{}).pitch_rangeEnv}
                  unit=""
                  onValue={x => updateDim("pitch", { pitch_range: x })}
                  onMode={m => toggleStratParam(v, "pitch", "pitch_range", 0.5, m, onChange)}
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
            <div className="voice-meta">offset in s · sums onto base pointer + grain jitter</div>
          </>
        )}
      </VoiceGroup>

      {/* PAN */}
      <VoiceGroup title="Pan" strategies={PAN_STRATEGIES}
                  voices={v} dim="pan" onChange={update}>
        {(strat) => (
          <>
            <VoiceStratParamRow name="spread"
              value={(v.pan||{}).spread} valueEnv={(v.pan||{}).spreadEnv}
              unit="°"
              onValue={x => updateDim("pan", { spread: x })}
              onMode={m => toggleStratParam(v, "pan", "spread", 60.0, m, onChange)}
              onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("voicesPanSpread") : undefined} />
            {strat === "linear" ? (
              <div className="voice-meta">symmetric · voice 0 = -spread/2 → voice N = +spread/2</div>
            ) : null}
            {strat === "random" ? (
              <div className="voice-meta">seeded random direction × spread/2</div>
            ) : null}
            {strat === "additive" ? (
              <div className="voice-meta">all voices shift by spread (no distribution)</div>
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
