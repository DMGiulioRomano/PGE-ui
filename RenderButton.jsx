/* @jsx React.createElement */
/* RenderButton — split-button con popover di opzioni + barra di progresso */

const { useState: useStateRB, useRef: useRefRB, useEffect: useEffectRB } = React;

function RenderButton({ options, onOptionsChange, onRender, onCancel, status }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = useStateRB(false);
  const rootRef = useRefRB(null);

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
          {options.visualize ? (
            <div className="rs-row" style={{paddingLeft: 18}}>
              <span className="rs-k">page duration</span>
              <input type="number" className="pge-mini-input" min={1} step={1} style={{width: 52}}
                     value={options.pageDuration ?? 15}
                     onChange={e => toggle("pageDuration", Math.max(1, +e.target.value || 15))} />
              <span className="rs-hint">seconds per page</span>
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
  if (o.useCache) parts.push("--cache", "--cache-dir", "cache");
  if (o.visualize) {
    parts.push("--visualize", "--show-static");
    if (o.pageDuration && o.pageDuration !== 15) parts.push("--page-duration", String(o.pageDuration));
  }
  if (o.reaper) parts.push("--reaper");
  return parts.join(" ");
}

window.PGE.RenderButton = RenderButton;
