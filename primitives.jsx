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
    settings: <g><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></g>,
    code: <g><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></g>,
    edit: <g><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></g>,
    waveform: <g><line x1="2" y1="12" x2="2" y2="12" /><line x1="6" y1="8" x2="6" y2="16" /><line x1="10" y1="4" x2="10" y2="20" /><line x1="14" y1="9" x2="14" y2="15" /><line x1="18" y1="6" x2="18" y2="18" /><line x1="22" y1="11" x2="22" y2="13" /></g>,
    file: <g><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></g>,
    undo: <g><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></g>,
    redo: <g><polyline points="15 14 20 9 15 4" /><path d="M4 20v-7a4 4 0 0 1 4-4h12" /></g>,
    panelLeft: <g><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /></g>,
    panelLeftClose: <g><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /><polyline points="16 15 13 12 16 9" /></g>,
    panelLeftOpen: <g><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /><polyline points="14 9 17 12 14 15" /></g>,
    lock: <g><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></g>,
    lockOpen: <g><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></g>,
    scope: <g><circle cx="12" cy="12" r="9" /><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="5.6" y1="5.6" x2="18.4" y2="18.4" /></g>
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
    </button>);

}

/* ---------- Segmented control ---------- */
function Seg({ value, onChange, options, size = "md" }) {
  return (
    <div className={"pge-seg " + size}>
      {options.map((o) =>
      <button key={o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)} style={{ height: "20px" }}>{o.label}</button>
      )}
    </div>);

}

/* ---------- Switch ---------- */
function Switch({ value, onChange, label }) {
  return (
    <label className="pge-switch-row" onClick={() => onChange(!value)}>
      <span className={"pge-switch " + (value ? "on" : "")}><span className="knob" /></span>
      {label ? <span>{label}</span> : null}
    </label>);

}

/* ---------- Numeric field ---------- */
function NumberField({ value, unit, width = 96, onChange, accent, focus, steps }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const [stepMenu, setStepMenu] = useState(null);
  const [hoveredStep, setHoveredStep] = useState(null);
  const [activeStep, setActiveStep] = useState(null);
  const hoverTimerRef = useRef(null);
  const activeStepRef = useRef(null);
  const valueRef = useRef(value);
  const lastYRef = useRef(null);
  const accPxRef = useRef(0);
  const STEPS = Array.isArray(steps) && steps.length ? steps : [0.01, 0.1, 1, 10];
  const PX_PER_STEP = 3;

  useEffect(() => { setDraft(String(value)); valueRef.current = value; }, [value]);

  function stepEnter(s) {
    setHoveredStep(s);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setActiveStep(s);
      activeStepRef.current = s;
      accPxRef.current = 0;
      hoverTimerRef.current = null;
    }, 500);
  }

  function stepLeave() {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setHoveredStep(null);
    // activeStep stays locked after activation — cleared only on mouseup
  }

  function matchesTrigger(e) {
    const t = (window.PGE_TWEAKS && window.PGE_TWEAKS.stepMenuTrigger) || "rightClick";
    switch (t) {
      case "rightClick":  return e.button === 2 && !e.shiftKey && !e.ctrlKey && !e.altKey;
      case "middleClick": return e.button === 1;
      case "shiftLeft":   return e.button === 0 && e.shiftKey && !e.ctrlKey && !e.altKey;
      case "ctrlLeft":    return e.button === 0 && e.ctrlKey && !e.shiftKey && !e.altKey;
      case "altLeft":     return e.button === 0 && e.altKey && !e.shiftKey && !e.ctrlKey;
      default:            return e.button === 2;
    }
  }

  function triggerButton() {
    const t = (window.PGE_TWEAKS && window.PGE_TWEAKS.stepMenuTrigger) || "rightClick";
    return t === "rightClick" ? 2 : t === "middleClick" ? 1 : 0;
  }

  function onRightDown(e) {
    if (!matchesTrigger(e)) return;
    e.preventDefault();
    setStepMenu({ x: e.clientX, y: e.clientY });
    setHoveredStep(null);
    setActiveStep(null);
    activeStepRef.current = null;
    lastYRef.current = e.clientY;
    accPxRef.current = 0;
    window.PGEHistory && window.PGEHistory.beginGesture();

    function onMove(ev) {
      const step = activeStepRef.current;
      if (step !== null) {
        const dy = lastYRef.current - ev.clientY;
        accPxRef.current += dy;
        const steps = Math.trunc(accPxRef.current / PX_PER_STEP);
        if (steps !== 0) {
          accPxRef.current -= steps * PX_PER_STEP;
          const raw = valueRef.current + steps * step;
          const dec = step < 1 ? (step.toString().split('.')[1] || '').length : 0;
          const rounded = parseFloat(raw.toFixed(Math.min(dec, 10)));
          valueRef.current = rounded;
          onChange && onChange(rounded);
        }
      }
      lastYRef.current = ev.clientY;
    }

    function onUp(ev) {
      if (ev.button !== triggerButton()) return;
      setStepMenu(null);
      setHoveredStep(null);
      setActiveStep(null);
      activeStepRef.current = null;
      if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
      window.PGEHistory && window.PGEHistory.endGesture();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onFieldClick(e) {
    if (editing) return;
    const t = (window.PGE_TWEAKS && window.PGE_TWEAKS.stepMenuTrigger) || "rightClick";
    if (t === "shiftLeft" && e.shiftKey) return;
    if (t === "ctrlLeft" && e.ctrlKey) return;
    if (t === "altLeft" && e.altKey) return;
    setEditing(true);
  }

  return (
    <span
      className={"pge-field" + (focus || editing ? " focus" : "") + (accent ? " accent" : "")}
      style={{ width }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={onRightDown}
      onClick={onFieldClick}
    >
      {editing ?
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {setEditing(false);onChange && onChange(parseFloat(draft) || 0);}}
        onKeyDown={(e) => {if (e.key === "Enter") e.target.blur();if (e.key === "Escape") {setDraft(String(value));setEditing(false);}}} /> :
      <span className="val">{value}</span>
      }
      {unit ? <span className="unit">{unit}</span> : null}
      {stepMenu ? (
        <span className="pge-step-menu" style={{ left: stepMenu.x - 88, top: stepMenu.y + 8 }}>
          {STEPS.map((s) => (
            <span
              key={s}
              className={"pge-step-cell" + (hoveredStep === s ? " hovered" : "") + (activeStep === s ? " active" : "")}
              onMouseEnter={() => stepEnter(s)}
              onMouseLeave={stepLeave}
            >{s}</span>
          ))}
        </span>
      ) : null}
    </span>);

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
    </div>);

}

/* ---------- Parameter Row ---------- */
function ParamRow({ name, mode = "scalar", onMode, value, unit, range, selected, onEditEnv, onSelect, accent, envValue, onValue, right, steps }) {
  // Build polyline points from envValue (array of [x, y] OR mixed with compact blocks).
  // For loops, expand via PGEEnv to the actual point sequence.
  let pts = "0,12 25,9 50,4 75,7 100,11";
  let loopCount = 0;
  let expandedBPs = [];
  if (envValue && envValue.length) {
    const hasLoop = window.PGEEnv && window.PGEEnv.envHasLoop(envValue);
    if (hasLoop) {
      const exp = window.PGEEnv.expandMixed(envValue);
      expandedBPs = exp.points;
      loopCount = exp.blocks.length;
    } else {
      expandedBPs = envValue;
    }
    if (expandedBPs.length) {
      const xs = expandedBPs.map((p) => p[0]);
      const ys = expandedBPs.map((p) => p[1]);
      const xmin = Math.min(...xs),xmax = Math.max(...xs);
      const ymin = Math.min(...ys),ymax = Math.max(...ys);
      const xr = xmax - xmin || 1,yr = ymax - ymin || 1;
      pts = expandedBPs.map((p) => `${((p[0] - xmin) / xr * 100).toFixed(1)},${(14 - (p[1] - ymin) / yr * 12).toFixed(1)}`).join(" ");
    }
  }
  const handleMode = (m) => {if (onMode) onMode(m);};
  return (
    <div className={"pge-prow" + (selected ? " selected" : "")} onClick={onSelect}>
      <span className="k">{name}</span>
      {onMode ?
      <Seg size="xs" value={mode} onChange={handleMode} options={[{ label: "scalar", value: "scalar" }, { label: "env", value: "env" }]} /> :
      <span />}
      {mode === "scalar" || !envValue ?
      <span className="v">
          {typeof value === "number" ? <NumberField value={value} unit={unit} width={70} accent={accent} onChange={onValue} steps={steps} /> : <span style={{ color: "var(--fg-3)" }}>{value}</span>}
          {range ? <span className="range">±{typeof range === "number" ? (range / 2) : range}</span> : null}
        </span> :

      <span className="v env" onClick={onEditEnv}>
          <span className="env-mini">
            <svg viewBox="0 0 100 16" preserveAspectRatio="none">
              <polyline fill="none" stroke="#FF8C42" strokeWidth="1.2" points={pts} />
              {expandedBPs.map((p, i) => {
              const xs = expandedBPs.map((q) => q[0]);const ys = expandedBPs.map((q) => q[1]);
              const xmin = Math.min(...xs),xmax = Math.max(...xs);
              const ymin = Math.min(...ys),ymax = Math.max(...ys);
              const xr = xmax - xmin || 1,yr = ymax - ymin || 1;
              const cx = (p[0] - xmin) / xr * 100;
              const cy = 14 - (p[1] - ymin) / yr * 12;
              return <circle key={i} cx={cx} cy={cy} r="1" fill="#FF8C42" />;
            })}
            </svg>
          </span>
          <span className="env-label">
            {loopCount > 0 ? <span style={{color:"#FFB07A"}}>↻{loopCount} · </span> : null}
            {envValue.length} {envValue.length === 1 ? "el" : (loopCount > 0 ? "el" : "bp")}
          </span>
        </span>
      }
      {right || <span />}
    </div>);

}

/* ---------- SplitPane (horizontal or vertical) ---------- */
function SplitPane({ initial = 240, min = 120, max = 800, dir = "horiz", side = "primary-first", persist, children, className, extraSize = 0 }) {
  const key = persist ? "pge-split-" + persist : null;
  const init = (() => {
    if (key) {
      const v = +localStorage.getItem(key);
      if (v && v > 0) return v;
    }
    return initial;
  })();
  const [size, setSize] = useState(init);
  function onDown(e) {
    e.preventDefault();
    const startPos = dir === "horiz" ? e.clientX : e.clientY;
    const orig = size;
    document.body.style.cursor = dir === "horiz" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    function move(ev) {
      const cur = dir === "horiz" ? ev.clientX : ev.clientY;
      const d = cur - startPos;
      const next = Math.max(min, Math.min(max, side === "primary-last" ? orig - d : orig + d));
      setSize(next);
      if (key) localStorage.setItem(key, next);
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const kids = React.Children.toArray(children);
  const a = kids[0], b = kids[1];
  const displaySize = Math.max(min, Math.min(max, size + extraSize));
  const primaryStyle = dir === "horiz" ? { width: displaySize, flex: "0 0 auto" } : { height: displaySize, flex: "0 0 auto" };
  const secondaryStyle = { flex: "1 1 0", minWidth: 0, minHeight: 0, position: "relative", display: "flex" };
  return (
    <div className={"pge-split " + dir + (className ? " " + className : "")} style={{ display: "flex", flexDirection: dir === "horiz" ? "row" : "column", flex: 1, minWidth: 0, minHeight: 0 }}>
      {side === "primary-last" ? (
        <>
          <div className="pane secondary" style={secondaryStyle}>{a}</div>
          <div className={"pge-splitter " + dir} onPointerDown={onDown} />
          <div className="pane primary" style={{ ...primaryStyle, display: "flex" }}>{b}</div>
        </>
      ) : (
        <>
          <div className="pane primary" style={{ ...primaryStyle, display: "flex" }}>{a}</div>
          <div className={"pge-splitter " + dir} onPointerDown={onDown} />
          <div className="pane secondary" style={secondaryStyle}>{b}</div>
        </>
      )}
    </div>
  );
}

window.PGE = window.PGE || {};
Object.assign(window.PGE, { Icon, Button, Seg, Switch, NumberField, Tag, Section, ParamRow, SplitPane });