/* @jsx React.createElement */
/* RenderButton — split-button con popover di opzioni + barra di progresso */

const { useState: useStateRB, useRef: useRefRB, useEffect: useEffectRB } = React;

function RenderButton({ options, onOptionsChange, onRender, onCancel, status, envelopeKeys }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = useStateRB(false);
  const rootRef = useRefRB(null);
  const keys = Array.isArray(envelopeKeys) ? envelopeKeys : [];
  const selectedEnv = Array.isArray(options.plotEnvelopes) ? options.plotEnvelopes : [];
  // Grammatica dello SPEC delle lenti esplicite, controllata mentre si scrive:
  // uno SPEC rotto non degrada la partitura, fa uscire main.py con codice 1 e
  // porta via l'intero render (issue #120). Il campo vuoto non è un errore.
  const magnifyErr = window.PGEMagnifySpec
    ? window.PGEMagnifySpec.error(options.magnifyAt)
    : null;

  function toggleEnv(name) {
    const next = selectedEnv.includes(name)
      ? selectedEnv.filter(n => n !== name)
      : [...selectedEnv, name];
    onOptionsChange({ ...options, plotEnvelopes: next });
  }

  useEffectRB(() => {
    function onDoc(e) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target)) return;
      setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const running = status && status.running;
  const total = status?.total || 0;
  const done = status?.done || 0;
  const cur = status?.currentStreamId;
  const pct = total ? Math.min(1, (done + (status?.streamProgress || 0)) / total) : 0;

  function toggle(key, val) {
    onOptionsChange({ ...options, [key]: val });
  }

  return (
    <div className="pge-render-split" ref={rootRef}>
      {running ? (
        <div className="rs-progress">
          <div className="rs-bar"><div className="rs-fill" style={{ width: (pct * 100).toFixed(1) + "%" }} /></div>
          <div className="rs-label">
            <span className="mono">rendering {done}/{total}</span>
            {cur ? <span className="mono fade"> · {cur}</span> : null}
          </div>
          <button className="rs-cancel" onClick={onCancel} title="cancel render">
            <Icon name="x" size={11} />
          </button>
        </div>
      ) : (
        <>
          <button className="pge-btn primary rs-main" onClick={onRender} title="render with current options (⌘R)">
            <Icon name="play" size={12} />
            <span>Render</span>
          </button>
          <button className={"pge-btn primary rs-caret" + (open ? " on" : "")}
                  onClick={() => setOpen(o => !o)} title="render options" aria-label="render options">
            <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2,4 L5,7 L8,4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </>
      )}

      {open && !running ? (
        <div className="rs-pop" role="dialog" aria-label="render options">
          <div className="rs-pop-head">
            <span className="rs-pop-title">render options</span>
            <span className="rs-pop-meta">applied to next render</span>
          </div>

          <div className="rs-row">
            <span className="rs-k">renderer</span>
            <div className="pge-seg sm">
              <button className="on" disabled title="only numpy is available in this build">numpy</button>
              <button disabled className="dim" title="csound renderer not enabled">csound</button>
            </div>
          </div>

          <div className="rs-row">
            <span className="rs-k">per-stream stems</span>
            <span className="rs-locked"><Icon name="folder" size={10} /> required for playback</span>
          </div>

          <RsToggle k="incremental cache" v={options.useCache} onChange={(v) => toggle("useCache", v)}
                    hint="only re-renders streams whose YAML changed" />
          <RsToggle k="pdf score" v={options.visualize} onChange={(v) => toggle("visualize", v)}
                    hint="generate a graphic score alongside audio" />
          <RsToggle k="grain data" v={options.grainJson !== false} onChange={(v) => toggle("grainJson", v)}
                    hint="per-stream grain JSON for the grain view (heavy on dense scores)" />
          {options.grainJson === false && (options.showGrains || options.grainScoreOpen) ? (
            <div className="rs-row" style={{paddingLeft: 18}}>
              <span className="rs-hint">grain view is open — will render with grain data anyway</span>
            </div>
          ) : null}
          {options.visualize ? (
            <div className="rs-row" style={{paddingLeft: 18}}>
              <span className="rs-k">page duration</span>
              <input type="number" className="pge-mini-input" min={1} step={1} style={{width: 52}}
                     value={options.pageDuration ?? 15}
                     onChange={e => toggle("pageDuration", Math.max(1, +e.target.value || 15))} />
              <span className="rs-hint">seconds per page</span>
            </div>
          ) : null}
          {options.visualize ? (
            <div className="rs-row" style={{paddingLeft: 18}}
                 onClick={() => toggle("showVoiceOffsets", !options.showVoiceOffsets)}>
              <span className="rs-k">voice offsets</span>
              <div className={"rs-tog" + (options.showVoiceOffsets ? " on" : "")}
                   role="switch" aria-checked={!!options.showVoiceOffsets}>
                <span className="rs-tog-knob" />
              </div>
              <div className="rs-hint">per-voice pitch/pointer offset curves in the score</div>
            </div>
          ) : null}
          {options.visualize ? (
            <div className="rs-row" style={{paddingLeft: 18}}
                 onClick={() => toggle("magnify", !options.magnify)}>
              <span className="rs-k">lens</span>
              <div className={"rs-tog" + (options.magnify ? " on" : "")}
                   role="switch" aria-checked={!!options.magnify}>
                <span className="rs-tog-knob" />
              </div>
              <div className="rs-hint">zoom circle on each page's densest grain cluster, with the envelope values read at that instant</div>
            </div>
          ) : null}
          {options.visualize ? (
            <div className="rs-row" style={{paddingLeft: 18}}>
              <span className="rs-k">lens targets</span>
              <input type="text" style={{width: 172}}
                     className={"pge-mini-input" + (magnifyErr ? " err" : "")}
                     placeholder="t=14,zoom=10;t=32,stream=s2"
                     value={options.magnifyAt || ""}
                     onChange={e => toggle("magnifyAt", e.target.value)} />
              <div className={"rs-hint" + (magnifyErr ? " err" : "")}>
                {magnifyErr
                  ? `--magnify-at: ${magnifyErr} — not sent`
                  : "explicit lenses: t (s) required; y, zoom, out, src, stream optional; ';' separates targets"}
              </div>
            </div>
          ) : null}
          {options.visualize && keys.length ? (
            <div className="rs-row rs-env-filter" style={{paddingLeft: 18}}>
              <span className="rs-k">plot envelopes</span>
              <div className="rs-env-list">
                {keys.map(name => (
                  <label key={name} className={"rs-env-chk" + (selectedEnv.includes(name) ? " on" : "")}>
                    <input type="checkbox" checked={selectedEnv.includes(name)}
                           onChange={() => toggleEnv(name)} />
                    <span className="mono">{name}</span>
                  </label>
                ))}
              </div>
              <div className="rs-hint">
                {selectedEnv.length
                  ? `only these ${selectedEnv.length} · static params shown (show-static on)`
                  : "none selected = all envelopes"}
              </div>
            </div>
          ) : null}
          <RsToggle k="reaper project" v={options.reaper} onChange={(v) => toggle("reaper", v)}
                    hint="export a .rpp Reaper session" />
          <RsToggle k="preclean output" v={options.preclean} onChange={(v) => toggle("preclean", v)}
                    hint="wipe output/ before rendering (disables cache)" />

          <div className="rs-row">
            <span className="rs-k">output folder</span>
            <button className="rs-folder-btn" onClick={() => onOptionsChange({ ...options, _chooseOutput: Date.now() })} title="change output folder">
              <Icon name="folder" size={10} />
              <span className="mono fade">{options.outputDir || "output/"}</span>
            </button>
          </div>

          <div className="rs-cmd">
            <div className="rs-cmd-head">command</div>
            <div className="rs-cmd-body mono">
              {buildCommand(options)}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RsToggle({ k, v, onChange, hint }) {
  return (
    <div className="rs-row" onClick={() => onChange(!v)}>
      <span className="rs-k">{k}</span>
      <div className={"rs-tog" + (v ? " on" : "")} role="switch" aria-checked={v}>
        <span className="rs-tog-knob" />
      </div>
      {hint ? <div className="rs-hint">{hint}</div> : null}
    </div>
  );
}

function buildCommand(o) {
  const parts = [
    "python",
    "src/main.py",
    `configs/${o.projectBasename || "PGE_test"}.yml`,
    `${o.outputDir || "output"}/${o.projectBasename || "PGE_test"}.aif`,
    "--renderer", "numpy",
    "--per-stream",
  ];
  // grain data forced on while the grain view is open (matches onRender payload)
  if (o.grainJson !== false || o.showGrains || o.grainScoreOpen) parts.push("--grain-json");
  if (o.useCache) parts.push("--cache", "--cache-dir", "cache");
  if (o.visualize) {
    parts.push("--visualize", "--show-static");
    if (o.showVoiceOffsets) parts.push("--show-voice-offsets");
    if (o.pageDuration && o.pageDuration !== 15) parts.push("--page-duration", String(o.pageDuration));
    if (Array.isArray(o.plotEnvelopes) && o.plotEnvelopes.length) {
      parts.push("--plot-envelopes", o.plotEnvelopes.join(","));
    }
    if (o.magnify) parts.push("--magnify");
    // Stesso filtro di onRender: uno SPEC vuoto o rotto non viene spedito,
    // quindi l'anteprima non deve mostrarlo.
    const spec = (o.magnifyAt || "").trim();
    const specOk = spec && window.PGEMagnifySpec
      && window.PGEMagnifySpec.error(spec) === null;
    if (specOk) parts.push("--magnify-at", `"${spec}"`);
  }
  if (o.reaper) parts.push("--reaper");
  return parts.join(" ");
}

window.PGE.RenderButton = RenderButton;
