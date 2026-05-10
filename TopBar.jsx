/* @jsx React.createElement */
const { useState: useStateTB } = React;

function TopBar({ project, title, dirty, playing, onPlay, onStop, onRender, time, duration, status }) {
  const { Button, Icon, Tag } = window.PGE;
  return (
    <div className="pge-topbar">
      <div className="logo">
        <svg width="14" height="14" viewBox="0 0 20 20"><g fill="#FF8C42"><circle cx="3" cy="3" r="1.2"/><circle cx="10" cy="3" r="1.2"/><circle cx="17" cy="3" r="1.2"/><circle cx="3" cy="10" r="1.2"/><circle cx="10" cy="10" r="1.2"/><circle cx="17" cy="10" r="1.2"/><circle cx="3" cy="17" r="1.2"/><circle cx="10" cy="17" r="1.2"/><circle cx="17" cy="17" r="1.2"/></g></svg>
        <span className="mark">PGE</span>
      </div>
      <span className="ttl">{project}</span>
      {title ? <span className="meta" style={{marginLeft:6}}>· "{title}"</span> : null}
      {dirty ? <span className="unsaved" title="unsaved" /> : null}
      <span className="sep" />
      <button className="tbtn" onClick={() => {}}><Icon name="skipBack" size={11} /></button>
      <button className={"tbtn" + (playing ? " active" : "")} onClick={onPlay}><Icon name={playing ? "pause" : "play"} size={11} /></button>
      <button className="tbtn" onClick={onStop}><Icon name="stop" size={11} /></button>
      <span className="clk">{fmtTime(time)}</span>
      <span className="meta">/ {duration.toFixed(3)}</span>
      <span className="sep" />
      <span className="meta">renderer</span><Tag kind="ok">csound</Tag>
      {status ? <span style={{marginLeft:6}}><Tag kind="busy">{status}</Tag></span> : null}
      <span style={{ flex: 1 }} />
      <Button icon="save" kind="ghost">Save</Button>
      <Button icon="download" kind="ghost">Export YAML</Button>
      <Button icon="play" kind="primary" onClick={onRender}>Render</Button>
    </div>
  );
}

function fmtTime(t) {
  const m = Math.floor(t / 60); const s = (t % 60);
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

window.PGE.TopBar = TopBar;
