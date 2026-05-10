/* @jsx React.createElement */
const { useState, useRef, useEffect } = React;

/* ---------- Icons (Lucide subset, inline) ---------- */
function Icon({ name, size = 14, stroke = 1.5, fill = "none", style }) {
  const props = { width: size, height: size, viewBox: "0 0 24 24", fill: fill === "currentColor" ? "currentColor" : "none", stroke: fill === "currentColor" ? "none" : "currentColor", strokeWidth: stroke, strokeLinecap: "round", strokeLinejoin: "round", style };
  const paths = {
    play: <polygon points="6 4 20 12 6 20" fill="currentColor" stroke="none" />,
    pause: <g fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></g>,
    stop: <rect x="6" y="6" width="12" height="12" fill="currentColor" stroke="none" />,
    skipBack: <g fill="currentColor" stroke="none"><polygon points="6,4 6,20 4,20 4,4" /><polygon points="20,4 20,20 8,12" /></g>,
    repeat: <g><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></g>,
    plus: <g><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></g>,
    x: <g><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></g>,
    chevronDown: <polyline points="6 9 12 15 18 9" />,
    chevronRight: <polyline points="9 18 15 12 9 6" />,
    folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
    search: <g><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></g>,
    trash: <g><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></g>,
    download: <g><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></g>,
    save: <g><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v6h7V3" /></g>,
    sliders: <g><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></g>,
    code: <g><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></g>,
    edit: <g><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></g>,
    waveform: <g><line x1="2" y1="12" x2="2" y2="12" /><line x1="6" y1="8" x2="6" y2="16" /><line x1="10" y1="4" x2="10" y2="20" /><line x1="14" y1="9" x2="14" y2="15" /><line x1="18" y1="6" x2="18" y2="18" /><line x1="22" y1="11" x2="22" y2="13" /></g>,
    file: <g><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></g>,
  };
  return <svg {...props}>{paths[name] || null}</svg>;
}

/* ---------- Button ---------- */
function Button({ kind = "default", icon, children, active, onClick, title, style }) {
  const cls = ["pge-btn", kind, active ? "active" : ""].join(" ");
  return (
    <button className={cls} onClick={onClick} title={title} style={style}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </button>
  );
}

/* ---------- Segmented control ---------- */
function Seg({ value, onChange, options, size = "md" }) {
  return (
    <div className={"pge-seg " + size}>
      {options.map(o => (
        <button key={o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ---------- Switch ---------- */
function Switch({ value, onChange, label }) {
  return (
    <label className="pge-switch-row" onClick={() => onChange(!value)}>
      <span className={"pge-switch " + (value ? "on" : "")}><span className="knob" /></span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

/* ---------- Numeric field ---------- */
function NumberField({ value, unit, width = 96, onChange, accent, focus }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <span className={"pge-field" + (focus || editing ? " focus" : "") + (accent ? " accent" : "")} style={{ width }}>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => { setEditing(false); onChange && onChange(parseFloat(draft) || 0); }}
          onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { setDraft(String(value)); setEditing(false); } }}
        />
      ) : (
        <span className="val" onDoubleClick={() => setEditing(true)}>{value}</span>
      )}
      {unit ? <span className="unit">{unit}</span> : null}
    </span>
  );
}

/* ---------- Tag / Badge ---------- */
function Tag({ children, kind = "default" }) {
  return <span className={"pge-tag " + kind}>{children}</span>;
}

/* ---------- Collapsible Section ---------- */
function Section({ title, badge, children, defaultOpen = true, right }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={"pge-section" + (open ? "" : " collapsed")}>
      <header onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <h3>{title}</h3>
        {badge != null ? <Tag>{badge}</Tag> : null}
        <span style={{ flex: 1 }} />
        {right}
      </header>
      {open ? <div className="body">{children}</div> : null}
    </div>
  );
}

/* ---------- Parameter Row ---------- */
function ParamRow({ name, mode = "scalar", onMode, value, unit, range, selected, onEditEnv, onSelect, accent, envValue }) {
  // Build polyline points from envValue (array of [x, y]); auto-scale to viewBox.
  let pts = "0,12 25,9 50,4 75,7 100,11";
  if (envValue && envValue.length) {
    const xs = envValue.map(p => p[0]);
    const ys = envValue.map(p => p[1]);
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const xr = (xmax - xmin) || 1, yr = (ymax - ymin) || 1;
    pts = envValue.map(p => `${((p[0]-xmin)/xr*100).toFixed(1)},${(14 - ((p[1]-ymin)/yr*12)).toFixed(1)}`).join(" ");
  }
  const handleMode = (m) => { if (onMode) onMode(m); };
  return (
    <div className={"pge-prow" + (selected ? " selected" : "")} onClick={onSelect}>
      <span className="k">{name}</span>
      {onMode ? (
        <Seg size="xs" value={mode} onChange={handleMode} options={[{label:"scalar", value:"scalar"}, {label:"env", value:"env"}]} />
      ) : <span />}
      {mode === "scalar" || !envValue ? (
        <span className="v">
          {typeof value === "number" ? <NumberField value={value} unit={unit} width={70} accent={accent} /> : <span style={{color:"var(--fg-3)"}}>{value}</span>}
          {range ? <span className="range">±{range}</span> : null}
        </span>
      ) : (
        <span className="v env" onClick={onEditEnv}>
          <span className="env-mini">
            <svg viewBox="0 0 100 16" preserveAspectRatio="none">
              <polyline fill="none" stroke="#FF8C42" strokeWidth="1.2" points={pts} />
              {envValue.map((p, i) => {
                const xs = envValue.map(q => q[0]); const ys = envValue.map(q => q[1]);
                const xmin = Math.min(...xs), xmax = Math.max(...xs);
                const ymin = Math.min(...ys), ymax = Math.max(...ys);
                const xr = (xmax - xmin) || 1, yr = (ymax - ymin) || 1;
                const cx = (p[0]-xmin)/xr*100;
                const cy = 14 - ((p[1]-ymin)/yr*12);
                return <circle key={i} cx={cx} cy={cy} r="1" fill="#FF8C42" />;
              })}
            </svg>
          </span>
          <span className="env-label">{envValue.length} bp</span>
        </span>
      )}
      {onEditEnv ? <button className="pge-icon-btn" onClick={(e) => { e.stopPropagation(); onEditEnv && onEditEnv(); }}><Icon name="edit" size={11} /></button> : <span />}
    </div>
  );
}

window.PGE = window.PGE || {};
Object.assign(window.PGE, { Icon, Button, Seg, Switch, NumberField, Tag, Section, ParamRow });
