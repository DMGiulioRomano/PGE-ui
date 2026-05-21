/* @jsx React.createElement */
const { useState: useStateTB } = React;

function TopBar({
  project, title, dirty,
  playing, onPlay, onStop, onSeekZero,
  onRender, onCancelRender, renderStatus, renderOptions, onRenderOptionsChange,
  time, duration, status,
  onUndo, onRedo, canUndo, canRedo,
  browserOpen, onToggleBrowser,
  onSave, onSaveAs,
  onOpenSettings,
  terminalOpen, onToggleTerminal, terminalDotState,
  playReadiness,
}) {
  const { Button, Icon, Tag, RenderButton } = window.PGE;
  return (
    <div className="pge-topbar">
      <button className="tbtn sidebar-tgl" onClick={onToggleBrowser}
              title={browserOpen ? "chiudi barra laterale (⌘.)" : "apri barra laterale (⌘.)"}
              aria-label={browserOpen ? "chiudi barra laterale" : "apri barra laterale"}>
        <Icon name="panelLeft" size={13} />
      </button>
      <div className="logo">
        <svg width="14" height="14" viewBox="0 0 20 20"><g fill="#FF8C42"><circle cx="3" cy="3" r="1.2" /><circle cx="10" cy="3" r="1.2" /><circle cx="17" cy="3" r="1.2" /><circle cx="3" cy="10" r="1.2" /><circle cx="10" cy="10" r="1.2" /><circle cx="17" cy="10" r="1.2" /><circle cx="3" cy="17" r="1.2" /><circle cx="10" cy="17" r="1.2" /><circle cx="17" cy="17" r="1.2" /></g></svg>
        <span className="mark">PGE</span>
      </div>
      <span className="proj">
        <span className="ttl">{project}</span>
        {title ? <span className="meta">· "{title}"</span> : null}
        {dirty ? <span className="unsaved" title="unsaved changes — ⌘S to save" /> : null}
      </span>
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
      </div>
      <span className="clk">{fmtTime(time)}</span>
      <span className="meta dur">/ {duration.toFixed(3)}</span>
      <span className="sep" />
      {playReadiness ? (
        <span className={"play-ready " + playReadiness.state} title={playReadiness.tooltip}>
          <span className="pr-dot" />
          <span className="pr-text mono">{playReadiness.label}</span>
        </span>
      ) : null}
      <span className="sep" />
      <span className="meta hide-md">renderer</span><Tag kind="ok">numpy</Tag>
      <span style={{ flex: 1 }} />
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
        onRender={onRender}
        onCancel={onCancelRender}
        status={renderStatus} />
    </div>);
}

function fmtTime(t) {
  const m = Math.floor(t / 60); const s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

window.PGE.TopBar = TopBar;
