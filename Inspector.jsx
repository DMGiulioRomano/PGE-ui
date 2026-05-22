/* @jsx React.createElement */
const { useState: useStateIN, useMemo: useMemoIN } = React;

function AddParamMenu({ options, onAdd }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = React.useState(false);
  const avail = options.filter(o => !o.exists);
  if (!avail.length) return null;
  return (
    <div className="add-param">
      <button className="add-param-btn" onClick={() => setOpen(!open)}>
        <Icon name="plus" size={11} /> add parameter
      </button>
      {open ? (
        <div className="add-param-menu" onMouseLeave={() => setOpen(false)}>
          {avail.map(o => (
            <button key={o.key} className="add-param-item" onClick={() => {onAdd(o); setOpen(false);}}>
              <span className="k">{o.label}</span>
              <span className="desc">{o.desc}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Dephase Section ----------
   Per YAML reference: top-level stream param, not part of grain.
   Modes:
     - off           → dephase: false        (ranges only active if range_always_active)
     - implicit      → dephase: null/absent  (default ~1% global probability)
     - global        → dephase: number | [[t,v],…]  (probability 0–100, same for all params)
     - per-parameter → dephase: { volume?, pan?, duration?, pitch?, pointer?, reverse?, envelope? }
                       each value scalar or envelope (0–100)
*/
const DEPHASE_PARAMS = [
  { key: "volume",   desc: "applies volume_range per grain" },
  { key: "pan",      desc: "applies pan_range per grain" },
  { key: "duration", desc: "applies grain.duration_range" },
  { key: "pitch",    desc: "applies pitch.range" },
  { key: "pointer",  desc: "applies pointer.offset_range" },
  { key: "reverse",  desc: "flip grain reverse flag" },
  { key: "envelope", desc: "switch window when grain.envelope is a list" },
];

function detectDephaseMode(d) {
  if (d === false) return "off";
  if (d == null) return "implicit";
  if (typeof d === "number") return "global";
  if (Array.isArray(d)) return "global";
  if (typeof d === "object") return "perParam";
  return "implicit";
}

function DephaseSection({ stream, onChange }) {
  const { Section, ParamRow, Seg, Icon, Tag } = window.PGE;
  const d = stream.dephase;
  const mode = detectDephaseMode(d);

  function setMode(next) {
    if (next === "off")       return onChange({ dephase: false });
    if (next === "implicit")  return onChange({ dephase: null });
    if (next === "global")    return onChange({ dephase: typeof d === "number" ? d : (Array.isArray(d) ? d : 1) });
    if (next === "perParam")  return onChange({ dephase: (typeof d === "object" && !Array.isArray(d) && d) ? d : { volume: 50 } });
  }

  // Mini-badge mostra mode + sintesi numerica
  const badge = (() => {
    if (mode === "off")       return <span className="mono" style={{color:"var(--fg-3)"}}>off</span>;
    if (mode === "implicit")  return <span className="mono" style={{color:"var(--fg-3)"}}>implicit · 1%</span>;
    if (mode === "global")    {
      if (Array.isArray(d)) return <span className="mono" style={{color:"var(--accent)"}}>env · {d.length} bp</span>;
      return <span className="mono" style={{color:"var(--accent)"}}>{d}%</span>;
    }
    const n = Object.keys(d || {}).length;
    return <span className="mono" style={{color:"var(--accent)"}}>per-param · {n}</span>;
  })();

  return (
    <Section title="Dephase" badge={badge}
             right={<span className="mono" style={{fontSize:9, color:"var(--fg-4)"}}>stochastic ·_range gate</span>}>
      <div className="pge-prow">
        <span className="k">mode</span>
        <span />
        <span className="v">
          <Seg size="xs" value={mode} onChange={setMode}
               options={[
                 {label:"off",      value:"off"},
                 {label:"implicit", value:"implicit"},
                 {label:"global",   value:"global"},
                 {label:"per-param",value:"perParam"},
               ]} />
        </span>
        <span />
      </div>

      {mode === "off" ? (
        <div className="voice-empty">all _range fields ignored (unless range_always_active)</div>
      ) : null}

      {mode === "implicit" ? (
        <div className="voice-empty">no explicit value → engine uses default 1% global probability</div>
      ) : null}

      {mode === "global" ? (
        <ParamRow name="probability"
                  mode={Array.isArray(d) ? "env" : "scalar"}
                  onMode={(m) => {
                    if (m === "env") {
                      const v = typeof d === "number" ? d : 1;
                      onChange({ dephase: [[0, v], [1, v]] });
                    } else {
                      const v = Array.isArray(d) ? (d[0] && d[0][1]) || 1 : 1;
                      onChange({ dephase: v });
                    }
                  }}
                  value={Array.isArray(d) ? "—" : d}
                  unit={Array.isArray(d) ? "" : "%"}
                  accent={Array.isArray(d)}
                  envValue={Array.isArray(d) ? d : null}
                  onValue={(v) => onChange({dephase: v})} />
      ) : null}

      {mode === "perParam" ? (
        <>
          {DEPHASE_PARAMS.filter(p => (d && d[p.key] != null)).map(p => {
            const val = d[p.key];
            const isEnv = Array.isArray(val);
            return (
              <div key={p.key} className="pge-prow">
                <span className="k">{p.key}</span>
                <Seg size="xs" value={isEnv ? "env" : "scalar"}
                     onChange={(m) => {
                       const nv = m === "env" ? [[0, typeof val==="number" ? val : 1], [1, typeof val==="number" ? val : 1]] : (isEnv && val[0] ? val[0][1] : 1);
                       onChange({ dephase: { ...d, [p.key]: nv } });
                     }}
                     options={[{label:"scalar",value:"scalar"},{label:"env",value:"env"}]} />
                {isEnv ? (
                  <span className="v env">
                    <span className="env-mini"><svg viewBox="0 0 100 16" preserveAspectRatio="none"><polyline fill="none" stroke="#FF8C42" strokeWidth="1.2" points={val.map((q,i) => `${(q[0]/(val[val.length-1][0]||1)*100).toFixed(1)},${(14 - q[1]/100*12).toFixed(1)}`).join(" ")} /></svg></span>
                    <span className="env-label">{val.length} bp</span>
                  </span>
                ) : (
                  <span className="v"><span className="pge-field" style={{width:70}}><span className="val">{val}</span><span className="unit">%</span></span></span>
                )}
                <button className="pge-icon-btn" title="Remove"
                        onClick={() => { const nd = { ...d }; delete nd[p.key]; onChange({ dephase: Object.keys(nd).length ? nd : null }); }}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            );
          })}
          <AddParamMenu
            options={DEPHASE_PARAMS.map(p => ({
              key: p.key, label: p.key, desc: p.desc,
              exists: d && d[p.key] != null, def: 50
            }))}
            onAdd={(o) => onChange({ dephase: { ...(d || {}), [o.key]: o.def } })} />
        </>
      ) : null}
    </Section>
  );
}

function SamplePickerMenu({ current, onPick }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = React.useState(false);
  const [files, setFiles] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  async function handleOpen() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (files !== null) return;
    setLoading(true);
    try {
      const result = await window.PGEBackend.current.fs.listDir("media");
      setFiles(result.files || []);
    } catch (e) {
      console.error("[SamplePickerMenu] listDir failed:", e);
      setFiles([]);
    }
    setLoading(false);
  }

  return (
    <div style={{position:"relative", display:"inline-block"}}>
      <button className="pge-icon-btn" title="change sample" onClick={handleOpen}>
        <Icon name="chevronDown" size={11} />
      </button>
      {open ? (
        <div className="add-param-menu" style={{right:0, left:"auto", minWidth:180, maxHeight:220, overflowY:"auto"}}
             onMouseLeave={() => setOpen(false)}>
          {loading ? (
            <div className="add-param-item" style={{color:"var(--fg-4)"}}>loading…</div>
          ) : files && files.length === 0 ? (
            <div className="add-param-item" style={{color:"var(--fg-4)"}}>no media files found</div>
          ) : (files || []).map(f => (
            <button key={f.name} className="add-param-item"
                    style={f.name === current ? {color:"var(--accent)"} : {}}
                    onClick={() => { onPick(f.name); setOpen(false); }}>
              <span className="k" style={{fontFamily:"var(--mono)", fontSize:10}}>{f.name}</span>
              {f.duration ? <span className="desc">{f.duration.toFixed(2)}s</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Inspector({ stream, onChange, onClose, tab, onTab, samples }) {
  const { Section, ParamRow, Seg, Switch, Tag, NumberField, Icon, Button } = window.PGE;
  const [paramModes, setParamModes] = useStateIN({});
  const [selRow, setSelRow] = useStateIN(null);

  // Empty state — inspector opened via shortcut with no stream selected.
  // Keep the panel chrome so the layout doesn't jump, but show a hint.
  if (!stream) {
    return (
      <aside className="pge-inspector" data-screen-label="02 Inspector · Empty">
        <header className="ihead">
          <span className="title">Inspector</span>
          <span style={{ flex: 1 }} />
          <button className="pge-icon-btn" onClick={onClose} title="Close inspector"><Icon name="x" size={14} /></button>
        </header>
        <div className="inspector-empty">
          <div className="inspector-empty-glyph" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="14" width="10" height="20" rx="1.5" />
              <rect x="20" y="10" width="10" height="28" rx="1.5" />
              <rect x="34" y="18" width="8" height="12" rx="1.5" />
            </svg>
          </div>
          <div className="inspector-empty-title">Scegli uno stream</div>
          <div className="inspector-empty-hint">
            clicca una clip in timeline per ispezionarne i parametri
          </div>
          {window.prettyShortcut ? (
            <div className="inspector-empty-kbd mono">
              <kbd>{window.prettyShortcut((window.PGE_TWEAKS && window.PGE_TWEAKS.shortcutInspector) || "cmd+i")}</kbd>
              <span>per nascondere</span>
            </div>
          ) : null}
        </div>
      </aside>
    );
  }

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

  // Toggle a parameter between scalar and env, mutating the stream.
  // When entering env, seed an env array from the current scalar; when leaving env, collapse env→scalar.
  function toggleMode(k, newMode) {
    setMode(k, newMode);
    const defaultsByKey = { density: 8, distribution: 0, speedRatio: 1, grainDur: 0.05, pan: 0 };
    const fields = {
      density:      { sk: "density",     ek: "densityEnv" },
      distribution: { sk: "distribution",ek: "distributionEnv" },
      pan:          { sk: "pan",         ek: "panEnv" },
    };
    if (k === "speedRatio") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.speedRatio != null ? cur.speedRatio : 1;
        onChange({ pointer: { ...cur, speedRatio: null, speedRatioEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.speedRatioEnv && cur.speedRatioEnv[0] && cur.speedRatioEnv[0][1]) || 1;
        onChange({ pointer: { ...cur, speedRatio: v, speedRatioEnv: null } });
      }
      return;
    }
    if (k === "grainDur") {
      const cur = stream.grain || {};
      if (newMode === "env") {
        const v = cur.duration != null ? cur.duration : 0.05;
        onChange({ grain: { ...cur, duration: null, durationEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.durationEnv && cur.durationEnv[0] && cur.durationEnv[0][1]) || 0.05;
        onChange({ grain: { ...cur, duration: v, durationEnv: null } });
      }
      return;
    }
    const f = fields[k]; if (!f) return;
    if (newMode === "env") {
      const v = stream[f.sk] != null ? stream[f.sk] : defaultsByKey[k];
      onChange({ [f.sk]: null, [f.ek]: [[0, v], [1, v]] });
    } else {
      const v = (stream[f.ek] && stream[f.ek][0] && stream[f.ek][0][1]) || defaultsByKey[k];
      onChange({ [f.sk]: v, [f.ek]: null });
    }
  }

  const _sampleList = samples && samples.length ? samples : window.PGE_DATA.samples;
  const sampleDur = (_sampleList.find(s => s.name === stream.sample) || {}).duration;
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

            <Section title="Essentials"
                     badge={sampleDur ? <span className="mono">{sampleDur.toFixed(3)} s</span> :
                                       <span className="mono" style={{color:"var(--status-error)"}}>sample not found</span>}>
              <div className="pge-prow">
                <span className="k">stream_id</span><span />
                <span className="v" style={{color:"var(--accent)"}}>"{stream.id}"</span>
                <span />
              </div>
              <ParamRow name="onset" mode="scalar" value={stream.onset} unit="s"
                onSelect={() => setSelRow("onset")} selected={selRow==="onset"}
                onValue={(v) => onChange({onset: v})} />
              <ParamRow name="duration" mode="scalar" value={stream.duration} unit="s"
                onSelect={() => setSelRow("duration")} selected={selRow==="duration"}
                onValue={(v) => onChange({duration: v})} />
              <div className="pge-prow">
                <span className="k">sample</span><span />
                <span className="v" style={{color:"var(--accent)"}}>{stream.sample}</span>
                <SamplePickerMenu current={stream.sample} onPick={(name) => onChange({sample: name})} />
              </div>
            </Section>

            <Section title="Identity"
                     right={<span className="mono" style={{fontSize:9, color:"var(--fg-4)"}}>stream context</span>}>
              <div className="pge-prow">
                <span className="k" title="absolute = onset in seconds; normalized = onset ∈ [0,1] of total duration">time_mode</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.timeMode || "absolute"} onChange={v => onChange({timeMode: v})}
                       options={[{label:"absolute",value:"absolute"},{label:"normalized",value:"normalized"}]} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="stochastic distribution shape used by all *_range fields">distribution_mode</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.distributionMode || "uniform"} onChange={v => onChange({distributionMode: v})}
                       options={[{label:"uniform",value:"uniform"},{label:"gaussian",value:"gaussian"}]} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="when true, *_range fields apply even with dephase off">range_always_active</span>
                <span />
                <span className="v">
                  <Switch value={!!stream.rangeAlwaysActive}
                          onChange={v => onChange({rangeAlwaysActive: v})} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="multiply all temporal values (onset, duration, grain.duration)">time_scale</span>
                <span />
                <span className="v">
                  <NumberField value={stream.timeScale != null ? stream.timeScale : 1.0}
                               onChange={v => onChange({timeScale: v})} width={70} unit="×" />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="how grains that extend past clip end are handled">clip_strategy</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.clipStrategy || "overflow_margin"}
                       onChange={v => onChange({clipStrategy: v})}
                       options={[{label:"overflow",value:"overflow_margin"},{label:"passthrough",value:"passthrough"}]} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="extra seconds beyond duration for tail grains">clip_margin</span>
                <span />
                <span className="v">
                  <NumberField value={stream.clipMargin != null ? stream.clipMargin : 0}
                               onChange={v => onChange({clipMargin: v})} width={70} unit="s" />
                </span>
                <span />
              </div>
            </Section>

            <Section title="Overall density"
                     badge={stream.fillFactor != null
                       ? <span className="mono" style={{color:"var(--accent)"}}>fill_factor</span>
                       : (stream.densityEnv
                           ? <span className="mono" style={{color:"var(--accent)"}}>density · env · {stream.densityEnv.length} bp</span>
                           : <span className="mono">density</span>)}>
              <div className="pge-prow">
                <span className="k">unit</span>
                <span />
                <span className="v">
                  <Seg size="xs"
                       value={stream.fillFactor != null ? "fill_factor" : "density"}
                       onChange={(u) => {
                         if (u === "fill_factor") {
                           const ff = 2.0;
                           onChange({ density: null, densityEnv: null, fillFactor: ff });
                         } else {
                           onChange({ fillFactor: null, density: 8, densityEnv: null });
                         }
                       }}
                       options={[{label:"density",value:"density"},{label:"fill_factor",value:"fill_factor"}]} />
                </span>
                <span />
              </div>
              {stream.fillFactor != null ? (
                <ParamRow name="fill_factor" mode="scalar" value={stream.fillFactor} unit="×"
                  onSelect={() => setSelRow("fillFactor")} selected={selRow==="fillFactor"}
                  onValue={(v) => onChange({fillFactor: v})} />
              ) : (
                <ParamRow name="density"
                          mode={getMode("density")} onMode={(m) => toggleMode("density", m)}
                          value={stream.density != null ? stream.density : "—"} unit={stream.densityEnv ? "" : "g/s"}
                          accent={stream.densityEnv != null}
                          envValue={stream.densityEnv}
                          onSelect={() => setSelRow("density")} selected={selRow==="density"}
                          onValue={(v) => onChange({density: v})} />
              )}
              <ParamRow name="distribution"
                        mode={getMode("distribution")} onMode={(m) => toggleMode("distribution", m)}
                        value={stream.distribution != null ? stream.distribution : "—"}
                        accent={stream.distributionEnv != null}
                        envValue={stream.distributionEnv}
                        onSelect={() => setSelRow("distribution")} selected={selRow==="distribution"}
                        onValue={(v) => onChange({distribution: v})} />
              <div className="pge-prow hint" style={{paddingTop:0}}>
                <span className="k" />
                <span />
                <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                  0 → synchronous · 0.5 → quasi-sync · 1 → async
                </span>
                <span />
              </div>
            </Section>

            <Section title="Pointer">
              <ParamRow name="speed_ratio"
                        mode={getMode("speedRatio")} onMode={(m) => toggleMode("speedRatio", m)}
                        value={stream.pointer.speedRatio != null ? stream.pointer.speedRatio : "—"} unit="×"
                        accent={stream.pointer.speedRatioEnv != null}
                        envValue={stream.pointer.speedRatioEnv}
                        onSelect={() => setSelRow("speed")} selected={selRow==="speed"}
                        onValue={(v) => onChange({pointer: {...stream.pointer, speedRatio: v}})} />
              <ParamRow name="start" mode="scalar"
                        value={stream.pointer.start != null ? stream.pointer.start : 0} unit="s"
                        onSelect={() => setSelRow("ptr.start")} selected={selRow==="ptr.start"}
                        onValue={(v) => onChange({pointer: {...stream.pointer, start: v}})} />
              {(stream.pointer.loopStart != null || stream.pointer.loopEnd != null || stream.pointer.loopDur != null || stream.pointer.loopUnit != null) ? (
                <>
                  <ParamRow name="loop_start" mode="scalar"
                            value={stream.pointer.loopStart != null ? stream.pointer.loopStart : 0} unit="s"
                            onValue={(v) => onChange({pointer: {...stream.pointer, loopStart: v}})} />
                  <div className="pge-prow">
                    <span className="k">loop_end ↔ loop_dur</span>
                    <Seg size="xs"
                         value={stream.pointer.loopEnd != null ? "loop_end" : "loop_dur"}
                         onChange={(u) => {
                           if (u === "loop_end") {
                             const le = stream.pointer.loopEnd != null ? stream.pointer.loopEnd
                               : (stream.pointer.loopStart || 0) + (stream.pointer.loopDur != null ? stream.pointer.loopDur : 1);
                             onChange({ pointer: { ...stream.pointer, loopEnd: le, loopDur: null } });
                           } else {
                             const ld = stream.pointer.loopDur != null ? stream.pointer.loopDur
                               : Math.max(0.01, (stream.pointer.loopEnd || 0) - (stream.pointer.loopStart || 0));
                             onChange({ pointer: { ...stream.pointer, loopDur: ld, loopEnd: null } });
                           }
                         }}
                         options={[{label:"loop_dur",value:"loop_dur"},{label:"loop_end",value:"loop_end"}]} />
                    <span className="v">
                      <NumberField
                        value={stream.pointer.loopEnd != null ? stream.pointer.loopEnd : (stream.pointer.loopDur != null ? stream.pointer.loopDur : 0)}
                        unit="s" width={70} />
                    </span>
                    <span />
                  </div>
                  {stream.pointer.loopUnit ? (
                    <div className="pge-prow">
                      <span className="k">loop_unit</span><span />
                      <span className="v"><span style={{color:"var(--accent)"}}>{stream.pointer.loopUnit}</span></span>
                      <button className="pge-icon-btn" title="Remove"
                              onClick={() => { const np = { ...stream.pointer }; delete np.loopUnit; onChange({ pointer: np }); }}>
                        <Icon name="x" size={11} />
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="pge-prow"><span className="k" style={{color:"var(--fg-3)"}}>loop</span><span /><span className="v" style={{color:"var(--fg-3)"}}>—</span><span /></div>
              )}
              {stream.pointer.offsetRange != null ? (
                <div className="pge-prow">
                  <span className="k">offset_range</span><span />
                  <span className="v"><NumberField value={stream.pointer.offsetRange} width={70} /></span>
                  <button className="pge-icon-btn" title="Remove"
                          onClick={() => { const np = { ...stream.pointer }; delete np.offsetRange; onChange({ pointer: np }); }}>
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ) : null}
              <AddParamMenu
                options={[
                  { key: "loopStart",   label: "loop_start",   desc: "loop window start (s)",
                    exists: stream.pointer.loopStart != null, def: 0 },
                  { key: "loopEnd",     label: "loop_end",     desc: "loop end (s) — mutex w/ loop_dur, has priority",
                    exists: stream.pointer.loopEnd != null || stream.pointer.loopDur != null, def: 1 },
                  { key: "loopDur",     label: "loop_dur",     desc: "loop window length (s)",
                    exists: stream.pointer.loopDur != null || stream.pointer.loopEnd != null, def: 1 },
                  { key: "loopUnit",    label: "loop_unit",    desc: "\"normalized\" → loop coords ∈ [0,1] × sample_dur",
                    exists: stream.pointer.loopUnit != null, def: "normalized" },
                  { key: "offsetRange", label: "offset_range", desc: "per-grain pointer deviation ∈ [-1,1]",
                    exists: stream.pointer.offsetRange != null, def: 0.01 },
                ]}
                onAdd={(o) => {
                  const np = { ...stream.pointer, [o.key]: o.def };
                  // Loop fields only render together — if the user introduces
                  // loop_end/loop_dur/loop_unit without loop_start, seed it to 0
                  // so the row block appears.
                  if ((o.key === "loopEnd" || o.key === "loopDur" || o.key === "loopUnit")
                       && np.loopStart == null) {
                    np.loopStart = 0;
                  }
                  onChange({ pointer: np });
                }} />
            </Section>

            <Section title="Grain">
              <ParamRow name="duration"
                        mode={getMode("grainDur")} onMode={(m) => toggleMode("grainDur", m)}
                        value={stream.grain.duration != null ? stream.grain.duration : "—"}
                        unit={stream.grain.durationEnv ? "" : "s"}
                        range={stream.grain.durationRange}
                        accent={stream.grain.durationEnv != null}
                        envValue={stream.grain.durationEnv}
                        onSelect={() => setSelRow("grain.dur")} selected={selRow==="grain.dur"}
                        onValue={(v) => onChange({grain: {...stream.grain, duration: v}})} />
              <window.PGE.EnvelopeSelectorRow
                value={stream.grain.envelope}
                onChange={(env) => onChange({ grain: { ...stream.grain, envelope: env } })}
                onEditCurve={() => setSelRow("grain.envelope.curve")}
              />
              {stream.grain.reverse !== undefined ? (
                <div className="pge-prow">
                  <span className="k">reverse</span>
                  <span />
                  <span className="v"><span style={{color:"var(--accent)"}}>forced</span><span className="unit" style={{marginLeft:6, color:"var(--fg-3)"}}>· key present, value empty</span></span>
                  <button className="pge-icon-btn" title="Remove → reverse follows pointer speed (auto)"
                          onClick={() => { const ng = { ...stream.grain }; delete ng.reverse; onChange({ grain: ng }); }}>
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ) : null}
              <AddParamMenu
                options={[
                  { key: "durationRange", label: "duration_range", desc: "± randomization on grain duration", exists: stream.grain.durationRange != null, def: 0.01 },
                  { key: "reverse",       label: "reverse",        desc: "force reverse (key present, value empty)", exists: stream.grain.reverse !== undefined, def: null },
                ]}
                onAdd={(o) => onChange({ grain: { ...stream.grain, [o.key]: o.def } })} />
            </Section>

            <Section title="Pitch"
                     badge={stream.pitch.ratio != null && stream.pitch.semitones == null
                            ? <span className="mono">ratio</span>
                            : <span className="mono">semitones</span>}>
              <div className="pge-prow">
                <span className="k">unit</span>
                <span />
                <span className="v">
                  <Seg size="xs"
                       value={stream.pitch.ratio != null && stream.pitch.semitones == null ? "ratio" : "semitones"}
                       onChange={(u) => {
                         if (u === "semitones") {
                           const semi = stream.pitch.ratio != null ? Math.round(12 * Math.log2(stream.pitch.ratio)) : 0;
                           onChange({ pitch: { ...stream.pitch, semitones: semi, ratio: null } });
                         } else {
                           const r = stream.pitch.semitones != null ? +Math.pow(2, stream.pitch.semitones / 12).toFixed(4) : 1.0;
                           onChange({ pitch: { ...stream.pitch, ratio: r, semitones: null } });
                         }
                       }}
                       options={[{label:"semitones",value:"semitones"},{label:"ratio",value:"ratio"}]} />
                </span>
                <span />
              </div>
              {stream.pitch.ratio != null && stream.pitch.semitones == null ? (
                <ParamRow name="ratio" mode="scalar" value={stream.pitch.ratio} unit="×" range={stream.pitch.range}
                  onSelect={() => setSelRow("pitch.ratio")} selected={selRow==="pitch.ratio"}
                  onValue={(v) => onChange({pitch: {...stream.pitch, ratio: v}})} />
              ) : (
                <ParamRow name="semitones" mode="scalar" value={stream.pitch.semitones != null ? stream.pitch.semitones : 0} unit="st" range={stream.pitch.range}
                  onSelect={() => setSelRow("pitch.semi")} selected={selRow==="pitch.semi"}
                  onValue={(v) => onChange({pitch: {...stream.pitch, semitones: v}})} />
              )}
              <ParamRow name="range" mode="scalar" value={stream.pitch.range != null ? stream.pitch.range : 0}
                        unit={stream.pitch.ratio != null && stream.pitch.semitones == null ? "" : "st"}
                        onValue={(v) => onChange({pitch: {...stream.pitch, range: v}})} />
            </Section>

            <Section title="Volume & Pan">
              <ParamRow name="volume" mode="scalar" value={stream.volume} unit="dB" range={stream.volumeRange}
                onSelect={() => setSelRow("vol")} selected={selRow==="vol"}
                onValue={(v) => onChange({volume: v})} />
              <ParamRow name="volume_range" mode="scalar" value={stream.volumeRange != null ? stream.volumeRange : 0} unit="dB"
                onValue={(v) => onChange({volumeRange: v})} />
              <ParamRow name="pan"
                        mode={getMode("pan")} onMode={(m) => toggleMode("pan", m)}
                        value={stream.pan != null ? stream.pan : "—"} unit={stream.panEnv ? "" : "°"}
                        range={stream.panRange}
                        accent={stream.panEnv != null}
                        envValue={stream.panEnv}
                        onSelect={() => setSelRow("pan")} selected={selRow==="pan"}
                        onValue={(v) => onChange({pan: v})} />
              <ParamRow name="pan_range" mode="scalar" value={stream.panRange != null ? stream.panRange : 0} unit="°"
                onValue={(v) => onChange({panRange: v})} />
            </Section>

            <DephaseSection stream={stream} onChange={onChange} />

            {window.PGE.VoicesSection ? <window.PGE.VoicesSection stream={stream} onChange={onChange} /> : null}

          </div>
        </>
      ) : (
        <div className="ibody raw">
          {window.PGE.YamlEditor ? <window.PGE.YamlEditor stream={stream} onChange={onChange} /> : <div style={{padding:20,color:"var(--fg-3)"}}>YAML editor loading…</div>}
        </div>
      )}
    </aside>
  );
}
window.PGE = window.PGE || {};
window.PGE.Inspector = Inspector;
