/* @jsx React.createElement */
const { useState: useStateVS } = React;

/* Voices Section — full strategy config per PythonGranularEngine docs/multi-voice.md */

const PITCH_STRATEGIES = [
  { value: "step",       label: "step",       desc: "i × step  · arithmetic progression" },
  { value: "range",      label: "range",      desc: "fill semitone_range across N voices" },
  { value: "chord",      label: "chord",      desc: "harmonic intervals, octave-wraps" },
  { value: "stochastic", label: "stochastic", desc: "seeded random in ±range" },
];
const ONSET_STRATEGIES = [
  { value: "linear",     label: "linear",     desc: "i × step (s)" },
  { value: "geometric",  label: "geometric",  desc: "step × baseⁱ⁻¹" },
  { value: "stochastic", label: "stochastic", desc: "seeded random in [0, max]" },
];
const POINTER_STRATEGIES = [
  { value: "linear",     label: "linear",     desc: "i × step (normalized 0–1)" },
  { value: "stochastic", label: "stochastic", desc: "seeded random in ±range" },
];
const PAN_STRATEGIES = [
  { value: "linear",     label: "linear",     desc: "symmetric ±spread/2" },
  { value: "random",     label: "random",     desc: "seeded random in ±spread/2" },
  { value: "additive",   label: "additive",   desc: "constant offset, no spread" },
];
const CHORDS = ["maj","min","dom7","maj7","min7","dim","aug","sus2","sus4","dim7","minmaj7"];

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
  return <ParamRow name={name} mode="scalar" value={value != null ? value : "—"} unit={unit} />;
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
            onChange={v => onChange({ [dim]: v === "off" ? null : { ...(voices[dim] || {}), strategy: v } })} />
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

function VoicesSection({ stream, onChange }) {
  const { Section, ParamRow, Seg } = window.PGE;
  const v = stream.voices || { num_voices: 1 };
  const N = v.num_voices || v.num || 1;

  function update(patch) {
    onChange({ voices: { ...v, ...patch } });
  }
  function updateDim(dim, patch) {
    onChange({ voices: { ...v, [dim]: { ...(v[dim] || {}), ...patch } } });
  }

  return (
    <Section title="Voices"
             badge={<span className="mono">{N} voice{N>1?"s":""}</span>}
             defaultOpen={true}>
      <ParamRow name="num_voices" mode="scalar" value={N} onValue={x => update({ num: Math.max(1, Math.round(x)) })} />
      <ParamRow name="scatter" mode="scalar" value={v.scatter != null ? v.scatter : 0} unit="" onValue={x => update({ scatter: x })} />
      <div className="voice-help">voice 0 is reference (all offsets = 0). additional voices receive offsets from each strategy below. scatter ∈ [0,1] randomizes per-voice timing.</div>

      <div className="voice-substack">

      {/* PITCH */}
      <VoiceGroup title="Pitch" strategies={PITCH_STRATEGIES}
                  voices={v} dim="pitch" onChange={update}>
        {(strat) => (
          <>
            {strat === "step" ? (
              <VoiceParamRow name="step" value={(v.pitch||{}).step ?? 3.0} unit="st" onChange={x => updateDim("pitch", { step: x })} />
            ) : null}
            {strat === "range" ? (
              <VoiceParamRow name="semitone_range" value={(v.pitch||{}).semitone_range ?? 12.0} unit="st" />
            ) : null}
            {strat === "chord" ? (
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
            ) : null}
            {strat === "stochastic" ? (
              <>
                <VoiceParamRow name="semitone_range" value={(v.pitch||{}).semitone_range ?? 0.5} unit="st" />
                <div className="voice-meta">seed = hash(stream_id + voice_idx) · direction cached</div>
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
              <VoiceParamRow name="step" value={(v.onset_offset||{}).step ?? 0.05} unit="s" />
            ) : null}
            {strat === "geometric" ? (
              <>
                <VoiceParamRow name="step" value={(v.onset_offset||{}).step ?? 0.05} unit="s" />
                <VoiceParamRow name="base" value={(v.onset_offset||{}).base ?? 2.0} />
              </>
            ) : null}
            {strat === "stochastic" ? (
              <>
                <VoiceParamRow name="max_offset" value={(v.onset_offset||{}).max_offset ?? 0.1} unit="s" />
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
              <VoiceParamRow name="step" value={(v.pointer||{}).step ?? 0.1} unit="" />
            ) : null}
            {strat === "stochastic" ? (
              <VoiceParamRow name="pointer_range" value={(v.pointer||{}).pointer_range ?? 0.02} unit="" />
            ) : null}
            <div className="voice-meta">offset normalized 0–1 · sums onto base pointer + grain jitter</div>
          </>
        )}
      </VoiceGroup>

      {/* PAN */}
      <VoiceGroup title="Pan" strategies={PAN_STRATEGIES}
                  voices={v} dim="pan" onChange={update}>
        {(strat) => (
          <>
            <VoiceParamRow name="spread" value={(v.pan||{}).spread ?? 60.0} unit="°" />
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
