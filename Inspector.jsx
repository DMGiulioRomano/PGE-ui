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
  if (d === window.PGEYaml.DEPHASE_IMPLICIT) return "implicit";
  // Key absent = engine default off (StreamConfig.dephase = False) — same as
  // explicit false. Only `dephase: null` (the sentinel) means implicit 1%.
  if (d === false || d == null) return "off";
  if (typeof d === "number") return "global";
  if (Array.isArray(d)) return "global";
  if (typeof d === "object") return "perParam";
  return "off";
}

function DephaseSection({ stream, onChange, onFocusEnvParam }) {
  const { Section, ParamRow, Seg, Icon, Tag } = window.PGE;
  const d = stream.dephase;
  const mode = detectDephaseMode(d);

  function setMode(next) {
    if (next === "off")       return onChange({ dephase: false });
    if (next === "implicit")  return onChange({ dephase: window.PGEYaml.DEPHASE_IMPLICIT });
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
                  onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("dephase") : undefined}
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
                  <span className="v env" onClick={onFocusEnvParam ? () => onFocusEnvParam("dephase_" + p.key) : undefined} style={onFocusEnvParam ? {cursor:"pointer"} : undefined}>
                    <span className="env-mini"><svg viewBox="0 0 100 16" preserveAspectRatio="none"><polyline fill="none" stroke="#FF8C42" strokeWidth="1.2" points={val.map((q,i) => `${(q[0]/(val[val.length-1][0]||1)*100).toFixed(1)},${(14 - q[1]/100*12).toFixed(1)}`).join(" ")} /></svg></span>
                    <span className="env-label">{val.length} bp</span>
                  </span>
                ) : (
                  <span className="v"><span className="pge-field" style={{width:70}}><span className="val">{val}</span><span className="unit">%</span></span></span>
                )}
                <button className="pge-icon-btn" title="Remove"
                        onClick={() => { const nd = { ...d }; delete nd[p.key]; onChange({ dephase: Object.keys(nd).length ? nd : window.PGEYaml.DEPHASE_IMPLICIT }); }}>
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

function SamplePickerMenu({ current, onPick, showLabel, triggerRef }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = React.useState(false);
  const [files, setFiles] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef(null);
  const inputRef = React.useRef(null);

  // close on click outside
  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false); setQuery("");
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // autofocus input when menu opens
  React.useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  async function handleOpen() {
    if (open) { setOpen(false); setQuery(""); return; }
    if (files === null) {
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
    setOpen(true);
  }
  if (triggerRef) triggerRef.current = handleOpen;

  const filtered = (files || []).filter(f =>
    f.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div ref={rootRef} style={{position:"relative", display:"inline-flex", alignItems:"center", gap:4}}>
      {showLabel && (
        <span className="v" style={{color:"var(--accent)", cursor:"pointer", fontFamily:"var(--mono)", fontSize:10}} onClick={handleOpen} title="change sample">
          {current}
        </span>
      )}
      <button className="pge-icon-btn" title="change sample" onClick={handleOpen}>
        <Icon name="chevronDown" size={11} />
      </button>
      {open ? (
        <div className="add-param-menu" style={{right:0, left:"auto", minWidth:200}}>
          <div style={{padding:"4px 6px", borderBottom:"1px solid var(--border)"}}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
              placeholder="cerca…"
              style={{
                width:"100%", boxSizing:"border-box",
                background:"var(--bg-2)", color:"var(--fg-1)",
                border:"1px solid var(--border)", borderRadius:3,
                padding:"2px 5px", fontSize:10, fontFamily:"var(--mono)",
                outline:"none",
              }}
            />
          </div>
          <div style={{maxHeight:200, overflowY:"auto"}}>
            {loading ? (
              <div className="add-param-item" style={{color:"var(--fg-4)"}}>loading…</div>
            ) : filtered.length === 0 ? (
              <div className="add-param-item" style={{color:"var(--fg-4)"}}>
                {files && files.length === 0 ? "no media files found" : "nessun risultato"}
              </div>
            ) : filtered.map(f => (
              <button key={f.name} className="add-param-item"
                      style={f.name === current ? {color:"var(--accent)"} : {}}
                      onClick={() => { onPick(f.name); setOpen(false); setQuery(""); }}>
                <span className="k" style={{fontFamily:"var(--mono)", fontSize:10}}>{f.name}</span>
                {f.duration ? <span className="desc">{f.duration.toFixed(2)}s</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Inspector({ stream, onChange, onClose, tab, onTab, samples, freezeEnvOnResize, onFreezeEnvToggle, onFocusEnvParam }) {
  const { Section, ParamRow, Seg, Switch, Tag, NumberField, Icon, Button } = window.PGE;
  const [paramModes, setParamModes] = useStateIN({});
  const [selRow, setSelRow] = useStateIN(null);
  const samplePickerTrigger = React.useRef(null);
  const ibodyRef = React.useRef(null);
  const ibodyScrollTop = React.useRef(0);
  const focusEnv = onFocusEnvParam ? (key) => () => onFocusEnvParam(key) : () => undefined;


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
              <kbd>{window.prettyShortcut((window.PGE_TWEAKS && window.PGE_TWEAKS.shortcutInspector) || "i")}</kbd>
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
    if (k === "loopStart"  && stream.pointer && stream.pointer.loopStartEnv)  return "env";
    if (k === "loopDur"    && stream.pointer && stream.pointer.loopDurEnv)    return "env";
    if (k === "grainDur" && stream.grain && stream.grain.durationEnv) return "env";
    if (k === "pan" && stream.panEnv) return "env";
    if (k === "volume" && stream.volumeEnv) return "env";
    if (k === "pitch" && stream.pitch && stream.pitch.valueEnv) return "env";
    if (k === "voicesNum" && stream.voices && stream.voices.numEnv) return "env";
    if (k === "scatter" && stream.voices && stream.voices.scatterEnv) return "env";
    if (k === "panRange"      && stream.panRangeEnv)                              return "env";
    if (k === "volumeRange"   && stream.volumeRangeEnv)                           return "env";
    if (k === "pitchRange"    && stream.pitch && stream.pitch.rangeEnv)           return "env";
    if (k === "durationRange" && stream.grain && stream.grain.durationRangeEnv)   return "env";
    if (k === "offsetRange"   && stream.pointer && stream.pointer.offsetRangeEnv) return "env";
    if (k === "fillFactor"    && stream.fillFactorEnv)                            return "env";
    if (k === "loopEnd"       && stream.pointer && stream.pointer.loopEndEnv)     return "env";
    return fallback || "scalar";
  };

  // Toggle a parameter between scalar and env, mutating the stream.
  // When entering env, seed an env array from the current scalar; when leaving env, collapse env→scalar.
  function toggleMode(k, newMode) {
    setMode(k, newMode);
    const defaultsByKey = { density: 8, fillFactor: 2, distribution: 0, speedRatio: 1, grainDur: 0.05, pan: 0, volume: 0 };
    const fields = {
      density:      { sk: "density",     ek: "densityEnv" },
      fillFactor:   { sk: "fillFactor",  ek: "fillFactorEnv" },
      distribution: { sk: "distribution",ek: "distributionEnv" },
      pan:          { sk: "pan",         ek: "panEnv" },
      volume:       { sk: "volume",      ek: "volumeEnv" },
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
    if (k === "loopStart") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.loopStart != null ? cur.loopStart : 0;
        onChange({ pointer: { ...cur, loopStart: null, loopStartEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.loopStartEnv && cur.loopStartEnv[0] && cur.loopStartEnv[0][1]) || 0;
        onChange({ pointer: { ...cur, loopStart: v, loopStartEnv: null } });
      }
      return;
    }
    if (k === "loopDur") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.loopDur != null ? cur.loopDur : 1;
        onChange({ pointer: { ...cur, loopDur: null, loopDurEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.loopDurEnv && cur.loopDurEnv[0] && cur.loopDurEnv[0][1]) || 1;
        onChange({ pointer: { ...cur, loopDur: v, loopDurEnv: null } });
      }
      return;
    }
    if (k === "loopEnd") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.loopEnd != null ? cur.loopEnd : 1;
        onChange({ pointer: { ...cur, loopEnd: null, loopEndEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.loopEndEnv && cur.loopEndEnv[0] && cur.loopEndEnv[0][1]) || 1;
        onChange({ pointer: { ...cur, loopEnd: v, loopEndEnv: null } });
      }
      return;
    }
    if (k === "pitch") {
      const cur = stream.pitch || {};
      if (newMode === "env") {
        const v = cur.value != null ? cur.value : (cur.unit === "ratio" ? 1.0 : 0);
        onChange({ pitch: { ...cur, value: null, valueEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.valueEnv && cur.valueEnv[0] && cur.valueEnv[0][1]);
        onChange({ pitch: { ...cur, value: v != null ? v : (cur.unit === "ratio" ? 1.0 : 0), valueEnv: null } });
      }
      return;
    }
    if (k === "voicesNum") {
      const cur = stream.voices || {};
      if (newMode === "env") {
        const v = cur.num != null ? cur.num : 1;
        onChange({ voices: { ...cur, num: null, numEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.numEnv && cur.numEnv[0] && cur.numEnv[0][1]) || 1;
        onChange({ voices: { ...cur, num: v, numEnv: null } });
      }
      return;
    }
    if (k === "scatter") {
      const cur = stream.voices || {};
      if (newMode === "env") {
        const v = cur.scatter != null ? cur.scatter : 0;
        onChange({ voices: { ...cur, scatter: null, scatterEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.scatterEnv && cur.scatterEnv[0] && cur.scatterEnv[0][1]) || 0;
        onChange({ voices: { ...cur, scatter: v, scatterEnv: null } });
      }
      return;
    }
    if (k === "panRange") {
      if (newMode === "env") {
        const v = stream.panRange != null ? stream.panRange : 0;
        onChange({ panRange: null, panRangeEnv: [[0, v], [1, v]] });
      } else {
        const v = (stream.panRangeEnv && stream.panRangeEnv[0] && stream.panRangeEnv[0][1]) || 0;
        onChange({ panRange: v, panRangeEnv: null });
      }
      return;
    }
    if (k === "volumeRange") {
      if (newMode === "env") {
        const v = stream.volumeRange != null ? stream.volumeRange : 0;
        onChange({ volumeRange: null, volumeRangeEnv: [[0, v], [1, v]] });
      } else {
        const v = (stream.volumeRangeEnv && stream.volumeRangeEnv[0] && stream.volumeRangeEnv[0][1]) || 0;
        onChange({ volumeRange: v, volumeRangeEnv: null });
      }
      return;
    }
    if (k === "pitchRange") {
      const cur = stream.pitch || {};
      if (newMode === "env") {
        const v = cur.range != null ? cur.range : 0;
        onChange({ pitch: { ...cur, range: null, rangeEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.rangeEnv && cur.rangeEnv[0] && cur.rangeEnv[0][1]) || 0;
        onChange({ pitch: { ...cur, range: v, rangeEnv: null } });
      }
      return;
    }
    if (k === "durationRange") {
      const cur = stream.grain || {};
      if (newMode === "env") {
        const v = cur.durationRange != null ? cur.durationRange : 0;
        onChange({ grain: { ...cur, durationRange: null, durationRangeEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.durationRangeEnv && cur.durationRangeEnv[0] && cur.durationRangeEnv[0][1]) || 0;
        onChange({ grain: { ...cur, durationRange: v, durationRangeEnv: null } });
      }
      return;
    }
    if (k === "offsetRange") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.offsetRange != null ? cur.offsetRange : 0;
        onChange({ pointer: { ...cur, offsetRange: null, offsetRangeEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.offsetRangeEnv && cur.offsetRangeEnv[0] && cur.offsetRangeEnv[0][1]) || 0;
        onChange({ pointer: { ...cur, offsetRange: v, offsetRangeEnv: null } });
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

  const _sampleList = samples || [];
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
          <div className="ibody" ref={el => { ibodyRef.current = el; if (el) el.scrollTop = ibodyScrollTop.current; }} onScroll={e => { ibodyScrollTop.current = e.currentTarget.scrollTop; }}>

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
                onValue={(v) => onChange({duration: v})}
                right={
                  <button
                    className={"pge-icon-btn" + (freezeEnvOnResize ? " active" : "")}
                    title={freezeEnvOnResize ? "envelopes: freeze (BPs keep absolute positions)" : "envelopes: stretch (BPs scale with duration)"}
                    onClick={(e) => { e.stopPropagation(); onFreezeEnvToggle && onFreezeEnvToggle(!freezeEnvOnResize); }}
                    style={{opacity: freezeEnvOnResize ? 1 : 0.4}}
                  >
                    <Icon name={freezeEnvOnResize ? "lock" : "lockOpen"} size={11} />
                  </button>
                } />
              <div className="pge-prow">
                <span className="k">sample</span>
                <span />
                <span className="v" style={{color:"var(--accent)", cursor:"pointer"}} onClick={() => samplePickerTrigger.current && samplePickerTrigger.current()}>{stream.sample}</span>
                <SamplePickerMenu current={stream.sample} onPick={(name) => onChange({sample: name})} showLabel={false} triggerRef={samplePickerTrigger} />
              </div>
            </Section>

            <Section title="Identity"
                     right={<span className="mono" style={{fontSize:9, color:"var(--fg-4)"}}>stream context</span>}>
              <div className="pge-prow">
                <span className="k" title="envelope time axis: normalized → x ∈ [0,1] of stream duration · absolute → x in seconds (engine default)">time_mode</span>
                <span />
                <span className="v">
                  <span className="mono" style={{fontSize:10, color:"var(--fg-3)"}}>
                    {stream.timeMode || "absolute"}{stream.timeMode ? "" : " (default)"}
                  </span>
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
                     badge={(stream.fillFactor != null || stream.fillFactorEnv != null)
                       ? <span className="mono" style={{color:"var(--accent)"}}>{stream.fillFactorEnv ? `fill_factor · env · ${stream.fillFactorEnv.length} bp` : "fill_factor"}</span>
                       : (stream.densityEnv
                           ? <span className="mono" style={{color:"var(--accent)"}}>density · env · {stream.densityEnv.length} bp</span>
                           : <span className="mono">density</span>)}>
              <div className="pge-prow">
                <span className="k">unit</span>
                <span />
                <span className="v">
                  <Seg size="xs"
                       value={(stream.fillFactor != null || stream.fillFactorEnv != null) ? "fill_factor" : "density"}
                       onChange={(u) => {
                         if (u === "fill_factor") {
                           const ff = 2.0;
                           onChange({ density: null, densityEnv: null, fillFactor: ff, fillFactorEnv: null });
                         } else {
                           onChange({ fillFactor: null, fillFactorEnv: null, density: 8, densityEnv: null });
                         }
                       }}
                       options={[{label:"density",value:"density"},{label:"fill_factor",value:"fill_factor"}]} />
                </span>
                <span />
              </div>
              {(stream.fillFactor != null || stream.fillFactorEnv != null) ? (
                <ParamRow name="fill_factor"
                  mode={getMode("fillFactor")} onMode={(m) => toggleMode("fillFactor", m)}
                  value={stream.fillFactor != null ? stream.fillFactor : "—"} unit={stream.fillFactorEnv ? "" : "×"}
                  accent={stream.fillFactorEnv != null}
                  envValue={stream.fillFactorEnv}
                  onEditEnv={focusEnv("fillFactor")}
                  onSelect={() => setSelRow("fillFactor")} selected={selRow==="fillFactor"}
                  onValue={(v) => onChange({fillFactor: Math.min(50, Math.max(0.001, v))})} />
              ) : (
                <ParamRow name="density"
                          mode={getMode("density")} onMode={(m) => toggleMode("density", m)}
                          value={stream.density != null ? stream.density : "—"} unit={stream.densityEnv ? "" : "g/s"}
                          accent={stream.densityEnv != null}
                          envValue={stream.densityEnv}
                          onEditEnv={focusEnv("density")}
                          onSelect={() => setSelRow("density")} selected={selRow==="density"}
                          onValue={(v) => onChange({density: v})} />
              )}
              <ParamRow name="distribution"
                        mode={getMode("distribution")} onMode={(m) => toggleMode("distribution", m)}
                        value={stream.distribution != null ? stream.distribution : "—"}
                        accent={stream.distributionEnv != null}
                        envValue={stream.distributionEnv}
                        onEditEnv={focusEnv("distribution")}
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
                        onEditEnv={focusEnv("speedRatio")}
                        onSelect={() => setSelRow("speed")} selected={selRow==="speed"}
                        onValue={(v) => onChange({pointer: {...stream.pointer, speedRatio: v}})} />
              <ParamRow name="start" mode="scalar"
                        value={stream.pointer.start != null ? stream.pointer.start : 0} unit="s"
                        onSelect={() => setSelRow("ptr.start")} selected={selRow==="ptr.start"}
                        onValue={(v) => onChange({pointer: {...stream.pointer, start: v}})} />
              {(stream.pointer.loopStart != null || stream.pointer.loopStartEnv != null || stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null || stream.pointer.loopDur != null || stream.pointer.loopDurEnv != null || stream.pointer.loopUnit != null) ? (
                <>
                  <ParamRow name="loop_start"
                            mode={getMode("loopStart")} onMode={(m) => toggleMode("loopStart", m)}
                            value={stream.pointer.loopStart != null ? stream.pointer.loopStart : (stream.pointer.loopStartEnv ? "—" : 0)} unit={stream.pointer.loopStartEnv ? "" : "s"}
                            accent={stream.pointer.loopStartEnv != null}
                            envValue={stream.pointer.loopStartEnv}
                            onEditEnv={focusEnv("loopStart")}
                            onValue={(v) => onChange({pointer: {...stream.pointer, loopStart: v}})} />
                  <div className="pge-prow">
                    <span className="k">loop_end ↔ loop_dur</span>
                    <Seg size="xs"
                         value={(stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null) ? "loop_end" : "loop_dur"}
                         onChange={(u) => {
                           if (u === "loop_end") {
                             const le = stream.pointer.loopEnd != null ? stream.pointer.loopEnd
                               : (stream.pointer.loopStart || 0) + (stream.pointer.loopDur != null ? stream.pointer.loopDur : 1);
                             onChange({ pointer: { ...stream.pointer, loopEnd: le, loopEndEnv: null, loopDur: null, loopDurEnv: null } });
                           } else {
                             const ld = stream.pointer.loopDur != null ? stream.pointer.loopDur
                               : Math.max(0.01, (stream.pointer.loopEnd || 0) - (stream.pointer.loopStart || 0));
                             onChange({ pointer: { ...stream.pointer, loopDur: ld, loopDurEnv: null, loopEnd: null, loopEndEnv: null } });
                           }
                         }}
                         options={[{label:"loop_dur",value:"loop_dur"},{label:"loop_end",value:"loop_end"}]} />
                    <span />
                    <span />
                  </div>
                  {(stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null) ? (
                    <ParamRow name="loop_end"
                              mode={getMode("loopEnd")} onMode={(m) => toggleMode("loopEnd", m)}
                              value={stream.pointer.loopEnd != null ? stream.pointer.loopEnd : (stream.pointer.loopEndEnv ? "—" : 1)} unit={stream.pointer.loopEndEnv ? "" : "s"}
                              accent={stream.pointer.loopEndEnv != null}
                              envValue={stream.pointer.loopEndEnv}
                              onEditEnv={focusEnv("loopEnd")}
                              onValue={(v) => onChange({pointer: {...stream.pointer, loopEnd: v}})} />
                  ) : (
                    <ParamRow name="loop_dur"
                              mode={getMode("loopDur")} onMode={(m) => toggleMode("loopDur", m)}
                              value={stream.pointer.loopDur != null ? stream.pointer.loopDur : (stream.pointer.loopDurEnv ? "—" : 1)} unit={stream.pointer.loopDurEnv ? "" : "s"}
                              accent={stream.pointer.loopDurEnv != null}
                              envValue={stream.pointer.loopDurEnv}
                              onEditEnv={focusEnv("loopDur")}
                              onValue={(v) => onChange({pointer: {...stream.pointer, loopDur: v}})} />
                  )}
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
              {(stream.pointer.offsetRange != null || stream.pointer.offsetRangeEnv != null) ? (
                <ParamRow name="offset_range"
                          mode={getMode("offsetRange")} onMode={(m) => toggleMode("offsetRange", m)}
                          value={stream.pointer.offsetRange != null ? stream.pointer.offsetRange : 0}
                          unit={stream.pointer.offsetRangeEnv ? "" : ""}
                          accent={stream.pointer.offsetRangeEnv != null}
                          envValue={stream.pointer.offsetRangeEnv}
                          onEditEnv={focusEnv("offsetRange")}
                          onValue={(v) => onChange({ pointer: { ...stream.pointer, offsetRange: v } })}
                          right={<button className="pge-icon-btn" title="Remove"
                            onClick={() => { const np = { ...stream.pointer }; delete np.offsetRange; delete np.offsetRangeEnv; onChange({ pointer: np }); }}>
                            <Icon name="x" size={11} />
                          </button>} />
              ) : null}
              <AddParamMenu
                options={[
                  { key: "loopStart",   label: "loop_start",   desc: "loop window start (s)",
                    exists: stream.pointer.loopStart != null, def: 0 },
                  { key: "loopEnd",     label: "loop_end",     desc: "loop end (s) — mutex w/ loop_dur, has priority",
                    exists: stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null || stream.pointer.loopDur != null || stream.pointer.loopDurEnv != null, def: 1 },
                  { key: "loopDur",     label: "loop_dur",     desc: "loop window length (s)",
                    exists: stream.pointer.loopDur != null || stream.pointer.loopDurEnv != null || stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null, def: 1 },
                  { key: "loopUnit",    label: "loop_unit",    desc: "\"normalized\" → loop coords ∈ [0,1] × sample_dur",
                    exists: stream.pointer.loopUnit != null, def: "normalized" },
                  { key: "offsetRange", label: "offset_range", desc: "per-grain pointer deviation ∈ [-1,1]",
                    exists: stream.pointer.offsetRange != null || stream.pointer.offsetRangeEnv != null, def: 0.01 },
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
                        range={stream.grain.durationRange != null && !stream.grain.durationRangeEnv ? stream.grain.durationRange : undefined}
                        accent={stream.grain.durationEnv != null}
                        envValue={stream.grain.durationEnv}
                        onEditEnv={focusEnv("grainDur")}
                        onSelect={() => setSelRow("grain.dur")} selected={selRow==="grain.dur"}
                        onValue={(v) => onChange({grain: {...stream.grain, duration: v}})} />
              {(stream.grain.durationRange != null || stream.grain.durationRangeEnv != null) ? (
                <ParamRow name="duration_range"
                          mode={getMode("durationRange")} onMode={(m) => toggleMode("durationRange", m)}
                          value={stream.grain.durationRange != null ? stream.grain.durationRange : 0} unit={stream.grain.durationRangeEnv ? "" : "s"}
                          accent={stream.grain.durationRangeEnv != null}
                          envValue={stream.grain.durationRangeEnv}
                          onEditEnv={focusEnv("durationRange")}
                          onValue={(v) => onChange({grain: {...stream.grain, durationRange: v}})} />
              ) : null}
              <window.PGE.EnvelopeSelectorRow
                value={stream.grain.envelope}
                onChange={(env) => onChange({ grain: { ...stream.grain, envelope: env } })}
                onEditCurve={() => { setSelRow("grain.envelope.curve"); if (onFocusEnvParam) onFocusEnvParam("grainEnvCurve"); }}
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
                  { key: "durationRange", label: "duration_range", desc: "± randomization on grain duration", exists: stream.grain.durationRange != null || stream.grain.durationRangeEnv != null, def: 0.01 },
                  { key: "reverse",       label: "reverse",        desc: "force reverse (key present, value empty)", exists: stream.grain.reverse !== undefined, def: null },
                ]}
                onAdd={(o) => onChange({ grain: { ...stream.grain, [o.key]: o.def } })} />
            </Section>

            {(() => {
              const pi = stream.pitch || {};
              const pu = pi.unit || "semitones";
              const isEdo = pu === "edo";
              const edoN = isEdo ? (pi.edoDivisions || 12) : null;
              const unitLabel = pu;
              const unitSymbol = window.PGEEnv.pitchUnitSymbol(pu, edoN);
              const pitchSteps = window.PGEEnv.pitchUnitIsInteger(pu) ? [1, 10, 100] : [0.1, 1, 10];
              const [slMin, slMax] = pu === "cents" ? [-3600, 3600]
                : pu === "quarter_tone" ? [-72, 72]
                : pu === "eighth_tone" ? [-144, 144]
                : pu === "ratio" ? [0.25, 4]
                : isEdo ? [-(3 * edoN), 3 * edoN]
                : [-48, 48];
              function setPitchUnit(newU) {
                if (newU === pu) return;
                const E = window.PGEEnv;
                const isNewEdo = newU === "edo";
                const newEDivs = isNewEdo ? (pi.edoDivisions || 12) : null;
                const fromDiv = edoN;            // current edo divisions (null if not edo)
                const toDiv = isNewEdo ? newEDivs : null;
                const patch = { ...pi, unit: newU, edoDivisions: newEDivs };
                if (pi.valueEnv) {
                  // keep env mode, remap breakpoints into the new unit
                  patch.valueEnv = E.convertPitchEnv(pi.valueEnv, pu, newU, fromDiv, toDiv);
                } else {
                  const curVal = pi.value ?? (pu === "ratio" ? 1.0 : 0);
                  patch.value = E.convertPitchValue(curVal, pu, newU, fromDiv, toDiv);
                  patch.valueEnv = null;
                }
                onChange({ pitch: patch });
              }
              return (
                <Section title="Pitch" badge={<span className="mono">{unitLabel}</span>}>
                  <div className="pge-prow">
                    <span className="k">unit</span>
                    <span />
                    <span className="v">
                      <select className="pge-mini-select" value={pu}
                              onChange={e => setPitchUnit(e.target.value)}>
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
                  {isEdo ? (
                    <div className="pge-prow">
                      <span className="k">divisions</span>
                      <span />
                      <span className="v">
                        <input type="number" className="pge-mini-input" min={1} step={1} value={edoN}
                               onChange={e => onChange({ pitch: { ...pi, edoDivisions: Math.max(1, Math.round(+e.target.value || 12)), unit: "edo" } })} />
                        <span className="hint">divisions/octave</span>
                      </span>
                      <span />
                    </div>
                  ) : null}
                  <ParamRow name={pu}
                            mode={getMode("pitch")} onMode={(m) => toggleMode("pitch", m)}
                            value={pi.value != null ? pi.value : "—"}
                            unit={pi.valueEnv ? "" : unitSymbol}
                            range={pi.range}
                            accent={pi.valueEnv != null}
                            envValue={pi.valueEnv}
                            onEditEnv={focusEnv("pitch")}
                            onSelect={() => setSelRow("pitch.value")} selected={selRow==="pitch.value"}
                            steps={pitchSteps}
                            onValue={(v) => onChange({pitch: {...pi, value: window.PGEEnv.pitchUnitIsInteger(pu) ? Math.round(v) : v}})} />
                  <ParamRow name="range"
                            mode={getMode("pitchRange")} onMode={(m) => toggleMode("pitchRange", m)}
                            value={pi.range != null ? pi.range : 0}
                            unit={pi.rangeEnv ? "" : unitSymbol} steps={pitchSteps}
                            accent={pi.rangeEnv != null}
                            envValue={pi.rangeEnv}
                            onEditEnv={focusEnv("pitchRange")}
                            onValue={(v) => onChange({pitch: {...pi, range: window.PGEEnv.pitchUnitIsInteger(pu) ? Math.round(v) : v}})} />
                </Section>
              );
            })()}

            <Section title="Volume & Pan">
              <ParamRow name="volume"
                        mode={getMode("volume")} onMode={(m) => toggleMode("volume", m)}
                        value={stream.volume != null ? stream.volume : "—"} unit={stream.volumeEnv ? "" : "dB"}
                        range={stream.volumeRange}
                        accent={stream.volumeEnv != null}
                        envValue={stream.volumeEnv}
                        onEditEnv={focusEnv("volume")}
                        onSelect={() => setSelRow("vol")} selected={selRow==="vol"}
                        onValue={(v) => onChange({volume: v})} />
              <ParamRow name="volume_range"
                        mode={getMode("volumeRange")} onMode={(m) => toggleMode("volumeRange", m)}
                        value={stream.volumeRange != null ? stream.volumeRange : 0} unit={stream.volumeRangeEnv ? "" : "dB"}
                        accent={stream.volumeRangeEnv != null}
                        envValue={stream.volumeRangeEnv}
                        onEditEnv={focusEnv("volumeRange")}
                        onValue={(v) => onChange({volumeRange: v})} />
              <ParamRow name="pan"
                        mode={getMode("pan")} onMode={(m) => toggleMode("pan", m)}
                        value={stream.pan != null ? stream.pan : "—"} unit={stream.panEnv ? "" : "°"}
                        range={stream.panRange}
                        accent={stream.panEnv != null}
                        envValue={stream.panEnv}
                        onEditEnv={focusEnv("pan")}
                        onSelect={() => setSelRow("pan")} selected={selRow==="pan"}
                        onValue={(v) => onChange({pan: v})} />
              <ParamRow name="pan_range"
                        mode={getMode("panRange")} onMode={(m) => toggleMode("panRange", m)}
                        value={stream.panRange != null ? stream.panRange : 0} unit={stream.panRangeEnv ? "" : "°"}
                        accent={stream.panRangeEnv != null}
                        envValue={stream.panRangeEnv}
                        onEditEnv={focusEnv("panRange")}
                        onValue={(v) => onChange({panRange: v})} />
            </Section>

            <DephaseSection stream={stream} onChange={onChange} onFocusEnvParam={onFocusEnvParam} />

            {window.PGE.VoicesSection ? <window.PGE.VoicesSection stream={stream} onChange={onChange} onFocusEnvParam={onFocusEnvParam} /> : null}

          </div>
        </>
      ) : (
        <div className="ibody raw">
          {window.PGE.YamlEditor ? <window.PGE.YamlEditor stream={stream} onChange={onChange} samples={samples} /> : <div style={{padding:20,color:"var(--fg-3)"}}>YAML editor loading…</div>}
        </div>
      )}
    </aside>
  );
}
window.PGE = window.PGE || {};
window.PGE.Inspector = Inspector;
