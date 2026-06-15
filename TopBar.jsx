/* @jsx React.createElement */
const { useState: useStateTB, useRef: useRefTB, useEffect: useEffectTB } = React;

function TopBar({
  project, title, dirty, seed, onSeedChange,
  playing, onPlay, onStop, onSeekZero, loopEnabled, onToggleLoop,
  onRender, onCancelRender, renderStatus, renderOptions, onRenderOptionsChange, envelopeKeys,
  time, duration, status,
  onUndo, onRedo, canUndo, canRedo,
  browserOpen, onToggleBrowser,
  onSave, onSaveAs,
  onOpenSettings,
  terminalOpen, onToggleTerminal, terminalDotState,
  scopeOpen, onToggleScope,
  grainScoreOpen, onToggleGrainScore,
  playReadiness,
}) {
  const { Button, Icon, RenderButton } = window.PGE;
  return (
    <div className="pge-topbar">
      <button className="tbtn sidebar-tgl" onClick={onToggleBrowser}
              title={browserOpen ? "chiudi barra laterale (⌘.)" : "apri barra laterale (⌘.)"}
              aria-label={browserOpen ? "chiudi barra laterale" : "apri barra laterale"}>
        <Icon name="panelLeft" size={13} />
      </button>
      <span className="proj">
        <span className="ttl">{project}</span>
        {title ? <span className="meta">· "{title}"</span> : null}
        {dirty ? <span className="unsaved" title="unsaved changes — ⌘S to save" /> : null}
      </span>
      {onSeedChange ? <SeedControl seed={seed} onChange={onSeedChange} /> : null}
      <span className="sep" />
      <div className="transport">
        <button className="tbtn" onClick={onUndo} disabled={!canUndo} title="undo (⌘Z)"><Icon name="undo" size={11} /></button>
        <button className="tbtn" onClick={onRedo} disabled={!canRedo} title="redo (⌘⇧Z)"><Icon name="redo" size={11} /></button>
      </div>
      <span className="sep" />
      <div className="transport">
        <button className="tbtn" onClick={onSeekZero} title="back to start"><Icon name="skipBack" size={11} /></button>
        <button className={"tbtn" + (playing ? " active" : "")}
                onClick={onPlay}
                disabled={playReadiness && playReadiness.state === "blocked"}
                title={playReadiness?.tooltip || (playing ? "pause (space)" : "play (space)")}>
          <Icon name={playing ? "pause" : "play"} size={11} />
        </button>
        <button className="tbtn" onClick={onStop} title="stop"><Icon name="stop" size={11} /></button>
        <button className={"tbtn" + (loopEnabled ? " active" : "")}
                onClick={onToggleLoop}
                title={loopEnabled ? "loop on — click to disable" : "loop off — click to enable"}>
          <Icon name="repeat" size={11} />
        </button>
      </div>
      <span className="clk">{fmtTime(time)}</span>
      <span className="meta dur">/ {duration.toFixed(3)}</span>
      <span style={{ flex: 1 }} />
      <button className={"tbtn grainscore-tgl" + (grainScoreOpen ? " active" : "")}
              onClick={onToggleGrainScore}
              title={grainScoreOpen ? "hide grain score (g)" : "show grain score (g)"}>
        <Icon name="waveform" size={11} />
        <span className="hide-md">grains</span>
      </button>
      <button className={"tbtn scope-tgl" + (scopeOpen ? " active" : "")}
              onClick={onToggleScope}
              title={scopeOpen ? "hide stereoscope (v)" : "show stereoscope (v)"}>
        <Icon name="scope" size={11} />
        <span className="hide-md">scope</span>
      </button>
      <button className={"tbtn terminal-tgl" + (terminalOpen ? " active" : "")}
              onClick={onToggleTerminal}
              title={terminalOpen ? "hide render log" : "show render log"}>
        <Icon name="code" size={11} />
        <span className="hide-md">log</span>
        {terminalDotState ? <span className={"tbtn-dot " + terminalDotState} /> : null}
      </button>
      <Button icon="save" kind="ghost" onClick={onSave} title="save project (⌘S)">
        <span className="hide-sm">Save</span>
      </Button>
      <Button icon="download" kind="ghost" onClick={onSaveAs} title="save a copy under a new name (⌘⇧S)">
        <span className="hide-sm">Save As…</span>
      </Button>
      <button className="tbtn settings-tgl" onClick={onOpenSettings} title="settings · backend, paths, appearance" aria-label="settings">
        <Icon name="settings" size={12} />
      </button>
      <RenderButton
        options={renderOptions}
        onOptionsChange={onRenderOptionsChange}
        envelopeKeys={envelopeKeys}
        onRender={onRender}
        onCancel={onCancelRender}
        status={renderStatus} />
    </div>);
}

function fmtTime(t) {
  const m = Math.floor(t / 60); const s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

/* SeedControl — top-level `seed` editor (engine #81). The seed makes NumPy
 * renders reproducible across runs; an absent seed = unseeded (the current,
 * default behaviour). Integers (incl. 0 and negatives) and strings are both
 * accepted by the engine. Sits next to the project name and opens a small
 * popover; commit on Enter or blur, Esc cancels. An empty value clears it. */
function SeedControl({ seed, onChange }) {
  const [open, setOpen] = useStateTB(false);
  const rootRef = useRefTB(null);

  useEffectTB(() => {
    function onDoc(e) {
      if (!rootRef.current || rootRef.current.contains(e.target)) return;
      setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const has = seed !== undefined && seed !== null && seed !== "";
  const display = has ? String(seed) : "";

  function commit(raw) {
    const t = (raw == null ? "" : String(raw)).trim();
    if (t === "") { onChange(undefined); return; }      // empty → unseeded
    // An integer (incl. 0/negative) is stored as a Number so the YAML emits it
    // unquoted; anything else is kept verbatim as a string (engine takes both).
    onChange(/^-?\d+$/.test(t) ? parseInt(t, 10) : t);
  }

  return (
    <span className="seed-ctl" ref={rootRef}>
      <button className={"seed-btn" + (has ? " on" : "")}
              onClick={() => setOpen(o => !o)}
              title={has ? `seed ${display} · render NumPy riproducibile` : "seed non impostato · render non riproducibile"}>
        <span className="seed-lbl mono">seed{has ? " " + display : ""}</span>
      </button>
      {open ? (
        <div className="seed-pop" role="dialog" aria-label="seed">
          <div className="seed-pop-head"><span className="seed-pop-title">seed</span></div>
          <input className="seed-input mono" type="text" autoFocus
                 placeholder="(non impostato)"
                 defaultValue={display}
                 onKeyDown={(e) => {
                   if (e.key === "Enter")  { commit(e.target.value); setOpen(false); }
                   if (e.key === "Escape") { setOpen(false); }
                 }}
                 onBlur={(e) => commit(e.target.value)} />
          <div className="seed-hint">
            Semina il renderer NumPy per render riproducibili tra esecuzioni.
            Vuoto = comportamento attuale (non riproducibile). Accetta interi
            (anche negativi) o stringhe.
          </div>
          <div className="seed-hint fade">
            Solo NumPy: con Csound i due renderer non sono bit-identici nemmeno con lo stesso seed.
          </div>
          {has ? (
            <button className="seed-clear" onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { onChange(undefined); setOpen(false); }}>
              rimuovi seed
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

window.PGE.TopBar = TopBar;
