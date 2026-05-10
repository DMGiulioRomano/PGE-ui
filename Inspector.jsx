/* @jsx React.createElement */
const { useState: useStateIN, useMemo: useMemoIN } = React;

function Inspector({ stream, onChange, onClose, tab, onTab }) {
  const { Section, ParamRow, Seg, Switch, Tag, NumberField, Icon, Button } = window.PGE;
  const [paramModes, setParamModes] = useStateIN({});
  const [selRow, setSelRow] = useStateIN(null);

  if (!stream) return null;

  const setMode = (k, v) => setParamModes({ ...paramModes, [k]: v });
  const getMode = (k, fallback) => {
    if (paramModes[k]) return paramModes[k];
    if (k === "density" && stream.densityEnv) return "env";
    if (k === "distribution" && stream.distributionEnv) return "env";
    if (k === "speedRatio" && stream.pointer && stream.pointer.speedRatioEnv) return "env";
    if (k === "grainDur" && stream.grain && stream.grain.durationEnv) return "env";
    if (k === "pan" && stream.panEnv) return "env";
    return fallback || "scalar";
  };

  const sampleDur = (window.PGE_DATA.samples.find(s => s.name === stream.sample) || {}).duration;
  const sampleMissing = !sampleDur;

  return (
    <aside className="pge-inspector" data-screen-label={tab === "raw" ? "03 Inspector Raw" : "02 Inspector Preview"}>
      <header className="ihead">
        <span className="title">Inspector</span>
        <span className="streamtag" style={{borderColor: stream.color, color: stream.color}}>{stream.id}</span>
        {sampleMissing ? <Tag kind="err">sample missing</Tag> : null}
        <span style={{ flex: 1 }} />
        <Seg value={tab} onChange={onTab} options={[{label:"Preview", value:"preview"},{label:"Raw", value:"raw"}]} />
        <button className="pge-icon-btn" onClick={onClose} title="Close inspector"><Icon name="x" size={14} /></button>
      </header>

      {tab === "preview" ? (
        <>
          <div className="isubhead">
            <span className="scrub"><span className="acc">{stream.id}</span> · {stream.sample} · {stream.onset.toFixed(2)}s → {(stream.onset + stream.duration).toFixed(2)}s</span>
            <span style={{flex:1}} />
            <Switch value={stream.solo} onChange={v => onChange({solo: v})} label="solo" />
            <Switch value={stream.mute} onChange={v => onChange({mute: v})} label="mute" />
          </div>
          <div className="ibody">

            <Section title="Identity">
              <div className="pge-prow">
                <span className="k">stream_id</span><span />
                <span className="v" style={{color:"var(--accent)"}}>"{stream.id}"</span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k">time_mode</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.timeMode || "absolute"} onChange={v => onChange({timeMode: v})}
                       options={[{label:"absolute",value:"absolute"},{label:"normalized",value:"normalized"}]} />
                </span>
                <span />
              </div>
            </Section>

            <Section title="Time">
              <ParamRow name="onset" mode="scalar" value={stream.onset} unit="s"
                onSelect={() => setSelRow("onset")} selected={selRow==="onset"} />
              <ParamRow name="duration" mode="scalar" value={stream.duration} unit="s"
                onSelect={() => setSelRow("duration")} selected={selRow==="duration"} />
            </Section>

            <Section title="Sample" badge={sampleDur ? <span className="mono">{sampleDur.toFixed(3)} s</span> : <span className="mono" style={{color:"var(--status-error)"}}>not found</span>}>
              <div className="pge-prow">
                <span className="k">sample</span><span />
                <span className="v" style={{color:"var(--accent)"}}>{stream.sample}</span>
                <button className="pge-icon-btn"><Icon name="chevronDown" size={11} /></button>
              </div>
            </Section>

            <Section title="Density"
                     badge={stream.densityEnv ? <span className="mono" style={{color:"var(--accent)"}}>env · {stream.densityEnv.length} bp</span> : <span className="mono">scalar</span>}>
              <ParamRow name="density"
                        mode={getMode("density")} onMode={(m) => setMode("density", m)}
                        value={stream.density != null ? stream.density : "—"} unit={stream.densityEnv ? "" : "g/s"}
                        accent={stream.densityEnv != null}
                        envValue={stream.densityEnv}
                        onSelect={() => setSelRow("density")} selected={selRow==="density"} />
            </Section>

            <Section title="Distribution"
                     badge={stream.distributionEnv ? <span className="mono" style={{color:"var(--accent)"}}>env</span> : <span className="mono">scalar</span>}>
              <div className="pge-prow">
                <span className="k">mode</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.distributionMode || "uniform"} onChange={v => onChange({distributionMode: v})}
                       options={[{label:"uniform",value:"uniform"},{label:"gaussian",value:"gaussian"}]} />
                </span>
                <span />
              </div>
              <ParamRow name="distribution"
                        mode={getMode("distribution")} onMode={(m) => setMode("distribution", m)}
                        value={stream.distribution != null ? stream.distribution : "—"}
                        accent={stream.distributionEnv != null}
                        envValue={stream.distributionEnv}
                        onSelect={() => setSelRow("distribution")} selected={selRow==="distribution"} />
            </Section>

            <Section title="Pointer">
              <ParamRow name="speed_ratio"
                        mode={getMode("speedRatio")} onMode={(m) => setMode("speedRatio", m)}
                        value={stream.pointer.speedRatio != null ? stream.pointer.speedRatio : "—"} unit="×"
                        accent={stream.pointer.speedRatioEnv != null}
                        envValue={stream.pointer.speedRatioEnv}
                        onSelect={() => setSelRow("speed")} selected={selRow==="speed"} />
              {stream.pointer.loopStart != null ? (
                <>
                  <ParamRow name="loop_start" mode="scalar" value={stream.pointer.loopStart} unit="s" />
                  <ParamRow name="loop_dur" mode="scalar" value={stream.pointer.loopDur} unit="s" />
                </>
              ) : (
                <div className="pge-prow"><span className="k" style={{color:"var(--fg-3)"}}>loop</span><span /><span className="v" style={{color:"var(--fg-3)"}}>—</span><span /></div>
              )}
            </Section>

            <Section title="Grain">
              <ParamRow name="duration"
                        mode={getMode("grainDur")} onMode={(m) => setMode("grainDur", m)}
                        value={stream.grain.duration != null ? stream.grain.duration : "—"}
                        unit={stream.grain.durationEnv ? "" : "s"}
                        range={stream.grain.durationRange}
                        accent={stream.grain.durationEnv != null}
                        envValue={stream.grain.durationEnv}
                        onSelect={() => setSelRow("grain.dur")} selected={selRow==="grain.dur"} />
              <div className="pge-prow">
                <span className="k">envelope</span><span />
                <span className="v"><span style={{color:"var(--accent)"}}>{stream.grain.envelope}</span></span>
                <button className="pge-icon-btn"><Icon name="chevronDown" size={11} /></button>
              </div>
            </Section>

            <Section title="Pitch">
              <ParamRow name="semitones" mode="scalar" value={stream.pitch.semitones} unit="st" range={stream.pitch.range}
                onSelect={() => setSelRow("pitch.semi")} selected={selRow==="pitch.semi"} />
              <ParamRow name="range" mode="scalar" value={stream.pitch.range} unit="st" />
            </Section>

            <Section title="Pan">
              <ParamRow name="pan"
                        mode={getMode("pan")} onMode={(m) => setMode("pan", m)}
                        value={stream.pan != null ? stream.pan : "—"} unit={stream.panEnv ? "" : "°"}
                        range={stream.panRange}
                        accent={stream.panEnv != null}
                        envValue={stream.panEnv}
                        onSelect={() => setSelRow("pan")} selected={selRow==="pan"} />
            </Section>

          </div>
        </>
      ) : (
        <div className="ibody raw">
          {window.PGE.YamlEditor ? <window.PGE.YamlEditor stream={stream} /> : <div style={{padding:20,color:"var(--fg-3)"}}>YAML editor loading…</div>}
        </div>
      )}
    </aside>
  );
}
window.PGE = window.PGE || {};
window.PGE.Inspector = Inspector;
