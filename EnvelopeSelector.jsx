/* @jsx React.createElement */
/* ============================================================================
 * EnvelopeSelector.jsx
 *
 * UI for `stream.grain.envelope`. The engine accepts FOUR forms:
 *
 *   1. single      → "hanning"                        (string)
 *   2. random      → ["hanning", "expodec", ...]      (string[])  picks per grain
 *   3. transition  → {from, to, curve}                (object)    crossfade
 *   4. multistate  → {states: [...], curve}           (object)    N-way blend
 *
 * Window registry (16 funcs + 1 alias), from src/controllers/window_registry.py:
 *
 *   Symmetric bells   hanning hamming bartlett blackman blackman_harris
 *                     gaussian kaiser half_sine rectangle sinc
 *   Percussive decay  expodec expodec_strong rexpodec
 *   Percussive rise   exporise exporise_strong rexporise
 *   Aliases           triangle → bartlett
 *
 * The selector renders a popover under the envelope row with a strategy
 * segmented control + a visual grid of windows. Closed by clicking outside
 * or pressing Esc. The shape SVGs are generated from analytical formulas
 * so the user can tell windows apart at a glance.
 * ==========================================================================*/

const { useState: useStateES, useRef: useRefES, useEffect: useEffectES, useMemo: useMemoES } = React;

/* ----- analytical shape functions (x ∈ [0,1] → y ∈ [0,1]) ----- */
const SHAPES = {
  hanning: (x) => 0.5 - 0.5 * Math.cos(2 * Math.PI * x),
  hamming: (x) => 0.54 - 0.46 * Math.cos(2 * Math.PI * x),
  bartlett: (x) => 1 - Math.abs(2 * x - 1),
  triangle: (x) => 1 - Math.abs(2 * x - 1), // alias
  blackman: (x) =>
    0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x),
  blackman_harris: (x) =>
    0.35875 -
    0.48829 * Math.cos(2 * Math.PI * x) +
    0.14128 * Math.cos(4 * Math.PI * x) -
    0.01168 * Math.cos(6 * Math.PI * x),
  gaussian: (x) => Math.exp(-Math.pow((x - 0.5) / 0.18, 2) / 2),
  kaiser: (x) => {
    // visual approximation of Kaiser β=8 — narrow bell, doesn't quite reach zero
    const v = Math.exp(-Math.pow((x - 0.5) / 0.22, 2) / 2);
    return 0.04 + 0.96 * v;
  },
  rectangle: () => 1.0,
  sinc: (x) => {
    const t = (x - 0.5) * 8 * Math.PI;
    return t === 0 ? 1 : Math.max(0, 0.6 + 0.4 * Math.sin(t) / t);
  },
  half_sine: (x) => Math.sin(Math.PI * x),
  expodec: (x) => Math.exp(-5 * x),
  expodec_strong: (x) => Math.exp(-12 * x),
  exporise: (x) => Math.exp(5 * (x - 1)),
  exporise_strong: (x) => Math.exp(12 * (x - 1)),
  rexpodec: (x) => {
    // "reversed expodec" — quick attack then exponential body. Visually: rises
    // fast at start, hits a plateau, decays at end.
    if (x < 0.15) return x / 0.15;
    return Math.exp(-5 * (x - 0.15) / 0.85);
  },
  rexporise: (x) => {
    // mirror of rexpodec — body grows exponentially, fast release at end
    if (x > 0.85) return (1 - x) / 0.15;
    return Math.exp(5 * (x - 0.85) / 0.85);
  },
};

/* Ordered list of windows. Categories chosen to mirror the engine docs. */
const WINDOWS = [
  // bells (symmetric)
  { name: "hanning",         cat: "bell",     desc: "smooth cosine bell, zero at edges (default)" },
  { name: "hamming",         cat: "bell",     desc: "cosine bell with small DC offset" },
  { name: "blackman",        cat: "bell",     desc: "narrower bell, suppressed sidelobes" },
  { name: "blackman_harris", cat: "bell",     desc: "very narrow, maximum sidelobe suppression" },
  { name: "gaussian",        cat: "bell",     desc: "gaussian bell, soft edges" },
  { name: "kaiser",          cat: "bell",     desc: "kaiser β=8 — tunable bell" },
  { name: "bartlett",        cat: "bell",     desc: "triangle window (alias: triangle)" },
  { name: "half_sine",       cat: "bell",     desc: "single half-cycle of sine" },
  // edges / specials
  { name: "rectangle",       cat: "special",  desc: "no fade — click-prone, raw grain" },
  { name: "sinc",            cat: "special",  desc: "oscillating sidelobes around peak" },
  // percussive decay
  { name: "expodec",         cat: "decay",    desc: "exponential decay — percussive" },
  { name: "expodec_strong",  cat: "decay",    desc: "fast exponential decay — sharp attack" },
  { name: "rexpodec",        cat: "decay",    desc: "fast attack, exponential decay body" },
  // percussive rise
  { name: "exporise",        cat: "rise",     desc: "exponential rise — reverse percussive" },
  { name: "exporise_strong", cat: "rise",     desc: "fast exponential rise" },
  { name: "rexporise",       cat: "rise",     desc: "exponential body, fast release end" },
];

const CAT_LABELS = {
  bell:    "Symmetric bells",
  special: "Special",
  decay:   "Percussive decay",
  rise:    "Percussive rise",
};

/* ----- helpers to classify the current envelope value ----- */
function detectStrategy(env) {
  if (env == null) return "single";
  if (typeof env === "string") return "single";
  if (Array.isArray(env)) return "random";
  if (typeof env === "object") {
    if (Array.isArray(env.states)) return "multistate";
    if (env.from != null && env.to != null) return "transition";
  }
  return "single";
}

function envSummary(env) {
  const s = detectStrategy(env);
  if (s === "single") return env || "hanning";
  if (s === "random") return `random · ${env.length}`;
  if (s === "transition") return `${env.from} → ${env.to}`;
  if (s === "multistate") return `${env.states.length} states`;
  return "—";
}

/* ----- shape svg for a window name ----- */
function WindowShape({ name, w = 56, h = 22, stroke = "currentColor", strokeWidth = 1.2, fill = false }) {
  const fn = SHAPES[name] || SHAPES.hanning;
  const N = 36;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    const y = Math.max(0, Math.min(1, fn(x)));
    pts.push(`${(x * w).toFixed(2)},${(h - 1 - y * (h - 2)).toFixed(2)}`);
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <line x1="0" y1={h - 1} x2={w} y2={h - 1} stroke="var(--fg-4)" strokeWidth="0.5" />
      {fill ? <polygon points={`0,${h - 1} ${pts.join(" ")} ${w},${h - 1}`} fill={stroke} fillOpacity="0.12" /> : null}
      <polyline fill="none" stroke={stroke} strokeWidth={strokeWidth} points={pts.join(" ")} />
    </svg>
  );
}

/* ============================================================================
 * Main component
 * ==========================================================================*/
function EnvelopeSelectorRow({ value, onChange, onEditCurve }) {
  const { Icon, Seg, Tag } = window.PGE;
  const [open, setOpen] = useStateES(false);
  const popRef = useRefES(null);
  const btnRef = useRefES(null);

  const strategy = detectStrategy(value);

  // Close on outside click / Esc
  useEffectES(() => {
    if (!open) return;
    function onDoc(e) {
      if (popRef.current && popRef.current.contains(e.target)) return;
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function setStrategy(next) {
    if (next === strategy) return;
    if (next === "single") {
      // Pick a reasonable carry-over
      const carry =
        strategy === "random" ? value[0] :
        strategy === "transition" ? value.from :
        strategy === "multistate" ? value.states[0] :
        "hanning";
      onChange(carry || "hanning");
    } else if (next === "random") {
      const seed =
        strategy === "single" ? [value || "hanning", "expodec"] :
        strategy === "transition" ? [value.from, value.to] :
        strategy === "multistate" ? value.states.slice() :
        ["hanning", "expodec"];
      onChange(seed);
    } else if (next === "transition") {
      const from =
        strategy === "single" ? (value || "hanning") :
        strategy === "random" ? value[0] :
        strategy === "multistate" ? value.states[0] : "hanning";
      const to =
        strategy === "single" ? "expodec" :
        strategy === "random" ? (value[1] || "expodec") :
        strategy === "multistate" ? (value.states[1] || "expodec") : "expodec";
      onChange({ from, to, curve: [[0, 0], [1, 1]] });
    } else if (next === "multistate") {
      const states =
        strategy === "single" ? [value || "hanning", "blackman", "expodec"] :
        strategy === "random" ? value.slice() :
        strategy === "transition" ? [value.from, value.to] :
        ["hanning", "blackman", "expodec"];
      onChange({ states, curve: [[0, 0], [1, 1]] });
    }
  }

  /* ----- list helpers for random / multistate ----- */
  function setListAt(i, name) {
    if (strategy === "random") {
      const next = value.slice(); next[i] = name; onChange(next);
    } else if (strategy === "multistate") {
      const next = value.states.slice(); next[i] = name;
      onChange({ ...value, states: next });
    }
  }
  function removeAt(i) {
    if (strategy === "random") {
      const next = value.filter((_, j) => j !== i);
      if (next.length === 0) onChange("hanning");
      else if (next.length === 1) onChange(next[0]);
      else onChange(next);
    } else if (strategy === "multistate") {
      const next = value.states.filter((_, j) => j !== i);
      if (next.length < 2) {
        // multistate requires >= 2 states; drop to random or single
        onChange(next.length === 1 ? next[0] : "hanning");
      } else {
        onChange({ ...value, states: next });
      }
    }
  }
  function addItem(name) {
    if (strategy === "random") onChange([...value, name]);
    else if (strategy === "multistate") onChange({ ...value, states: [...value.states, name] });
  }

  return (
    <>
      {/* Header row — replaces the broken envelope row in Inspector */}
      <div className={"pge-prow envelope-row" + (open ? " selected" : "")}>
        <span className="k">envelope</span>
        <span className="env-strategy-tag mono">{strategy}</span>
        <span className="v">
          <span className="env-summary-shape">
            {strategy === "single" ? (
              <WindowShape name={value || "hanning"} w={32} h={14} stroke="var(--accent)" fill />
            ) : strategy === "random" ? (
              <span className="env-stack">
                {value.slice(0, 3).map((n, i) => (
                  <WindowShape key={i} name={n} w={20} h={14} stroke="var(--accent)" strokeWidth={1} />
                ))}
                {value.length > 3 ? <span className="more">+{value.length - 3}</span> : null}
              </span>
            ) : strategy === "transition" ? (
              <span className="env-stack">
                <WindowShape name={value.from} w={20} h={14} stroke="var(--accent)" />
                <span className="arrow">→</span>
                <WindowShape name={value.to} w={20} h={14} stroke="var(--accent)" />
              </span>
            ) : (
              <span className="env-stack">
                {value.states.slice(0, 4).map((n, i) => (
                  <WindowShape key={i} name={n} w={16} h={14} stroke="var(--accent)" strokeWidth={1} />
                ))}
                {value.states.length > 4 ? <span className="more">+{value.states.length - 4}</span> : null}
              </span>
            )}
          </span>
          <span className="env-summary-label" title={envSummary(value)}>{envSummary(value)}</span>
        </span>
        <button ref={btnRef} className="pge-icon-btn" onClick={() => setOpen(!open)} title="Choose envelope">
          <Icon name="chevronDown" size={11} />
        </button>
      </div>

      {/* Popover */}
      {open ? (
        <div className="env-popover" ref={popRef}>
          <header className="env-popover-head">
            <span className="env-head-title">grain.envelope</span>
            <span style={{ flex: 1 }} />
            <button className="pge-icon-btn" onClick={() => setOpen(false)} title="Close">
              <Icon name="x" size={11} />
            </button>
          </header>

          <div className="env-strategy-bar">
            <Seg size="xs" value={strategy} onChange={setStrategy}
                 options={[
                   { label: "single",     value: "single" },
                   { label: "random",     value: "random" },
                   { label: "transition", value: "transition" },
                   { label: "multistate", value: "multistate" },
                 ]} />
            <span className="env-strategy-hint">
              {strategy === "single"     && "one window for every grain"}
              {strategy === "random"     && "engine picks one per grain"}
              {strategy === "transition" && "crossfade from → to over curve"}
              {strategy === "multistate" && "N-way blend along curve ∈ [0, N-1]"}
            </span>
          </div>

          {/* Body — different per strategy */}
          {strategy === "single" ? (
            <WindowGrid selected={value || "hanning"} onPick={(n) => { onChange(n); }} />
          ) : null}

          {strategy === "random" ? (
            <ListEditor
              items={value}
              onPickAt={setListAt}
              onRemoveAt={removeAt}
              onAdd={addItem}
              label="pool"
              hint="per-grain choice is uniform random"
            />
          ) : null}

          {strategy === "transition" ? (
            <div className="env-transition">
              <div className="env-tx-row">
                <span className="env-tx-label">from</span>
                <WindowChip name={value.from} onPick={(n) => onChange({ ...value, from: n })} />
              </div>
              <div className="env-tx-row">
                <span className="env-tx-label">to</span>
                <WindowChip name={value.to} onPick={(n) => onChange({ ...value, to: n })} />
              </div>
              <CurveRow value={value.curve} onChange={(c) => onChange({ ...value, curve: c })}
                        onEdit={() => onEditCurve && onEditCurve("envelope.curve")}
                        range="[0, 1] blend" />
            </div>
          ) : null}

          {strategy === "multistate" ? (
            <div className="env-multistate">
              <ListEditor
                items={value.states}
                onPickAt={setListAt}
                onRemoveAt={removeAt}
                onAdd={addItem}
                label="states"
                hint={`curve in [0, ${value.states.length - 1}] selects between states`}
                indexed
              />
              <CurveRow value={value.curve} onChange={(c) => onChange({ ...value, curve: c })}
                        onEdit={() => onEditCurve && onEditCurve("envelope.curve")}
                        range={`[0, ${value.states.length - 1}] state index`} />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/* ----- The grid of all 16 windows ----- */
function WindowGrid({ selected, onPick }) {
  const groups = useMemoES(() => {
    const out = { bell: [], special: [], decay: [], rise: [] };
    WINDOWS.forEach(w => out[w.cat].push(w));
    return out;
  }, []);
  return (
    <div className="env-grid">
      {Object.entries(groups).map(([cat, items]) => (
        <div key={cat} className="env-grid-group">
          <div className="env-grid-cat">{CAT_LABELS[cat]}</div>
          <div className="env-grid-tiles">
            {items.map(w => (
              <button key={w.name}
                      className={"env-tile" + (selected === w.name ? " on" : "")}
                      onClick={() => onPick(w.name)}
                      title={w.desc}>
                <WindowShape name={w.name} w={56} h={22}
                             stroke={selected === w.name ? "var(--accent)" : "var(--fg-2)"}
                             fill={selected === w.name} />
                <span className="env-tile-label">{w.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ----- Inline window picker chip (used for transition from/to) ----- */
function WindowChip({ name, onPick }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = useStateES(false);
  const [popPos, setPopPos] = useStateES(null);
  const ref = useRefES(null);
  const btnRef = useRefES(null);
  useEffectES(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  function handleOpen() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPopPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(!open);
  }
  return (
    <span className="env-chip-wrap" ref={ref}>
      <button ref={btnRef} className={"env-chip" + (open ? " open" : "")} onClick={handleOpen}>
        <WindowShape name={name} w={28} h={14} stroke="var(--accent)" />
        <span className="env-chip-name">{name}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {open && popPos ? (
        <div className="env-chip-pop" style={{ position: "fixed", top: popPos.top, left: popPos.left }}>
          <WindowGrid selected={name} onPick={(n) => { onPick(n); setOpen(false); }} />
        </div>
      ) : null}
    </span>
  );
}

/* ----- list editor for random / multistate ----- */
function ListEditor({ items, onPickAt, onRemoveAt, onAdd, label, hint, indexed }) {
  const { Icon } = window.PGE;
  const [adding, setAdding] = useStateES(false);
  const [addPopPos, setAddPopPos] = useStateES(null);
  const addRef = useRefES(null);
  const addBtnRef = useRefES(null);
  useEffectES(() => {
    if (!adding) return;
    function onDoc(e) { if (addRef.current && !addRef.current.contains(e.target)) setAdding(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [adding]);
  return (
    <div className="env-list">
      <div className="env-list-head">
        <span className="env-list-label">{label}</span>
        <span className="env-list-hint">{hint}</span>
      </div>
      <div className="env-list-items">
        {items.map((n, i) => (
          <div key={i} className="env-list-row">
            {indexed ? <span className="env-list-idx mono">{i}</span> : null}
            <WindowChip name={n} onPick={(x) => onPickAt(i, x)} />
            <span style={{ flex: 1 }} />
            <button className="pge-icon-btn" onClick={() => onRemoveAt(i)} title="Remove"
                    disabled={indexed ? items.length <= 2 : items.length <= 1}>
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="env-list-add" ref={addRef}>
        <button ref={addBtnRef} className="add-param-btn" onClick={() => {
          if (!adding && addBtnRef.current) {
            const r = addBtnRef.current.getBoundingClientRect();
            setAddPopPos({ top: r.bottom + 4, left: r.left });
          }
          setAdding(!adding);
        }}>
          <Icon name="plus" size={11} /> add window
        </button>
        {adding && addPopPos ? (
          <div className="env-chip-pop env-chip-pop-add" style={{ position: "fixed", top: addPopPos.top, left: addPopPos.left }}>
            <WindowGrid selected={null} onPick={(n) => { onAdd(n); setAdding(false); }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ----- curve row for transition / multistate ----- */
function CurveRow({ value, onChange, onEdit, range }) {
  const { Icon } = window.PGE;
  // value is an envelope: [[t, v], ...]
  const bp = Array.isArray(value) ? value : [[0, 0], [1, 1]];
  const xs = bp.map(p => p[0]); const ys = bp.map(p => p[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const xr = xmax - xmin || 1, yr = ymax - ymin || 1;
  const pts = bp.map(p => `${((p[0]-xmin)/xr*100).toFixed(1)},${(14-(p[1]-ymin)/yr*12).toFixed(1)}`).join(" ");
  return (
    <div className="env-curve-row">
      <span className="env-curve-label">curve</span>
      <span className="env-curve-range mono">{range}</span>
      <span style={{ flex: 1 }} />
      <span className="env-curve-mini">
        <svg viewBox="0 0 100 16" preserveAspectRatio="none">
          <polyline fill="none" stroke="var(--accent)" strokeWidth="1.2" points={pts} />
        </svg>
      </span>
      <span className="env-curve-bp mono">{bp.length} bp</span>
      <button className="pge-icon-btn" onClick={onEdit} title="Edit curve">
        <Icon name="edit" size={11} />
      </button>
    </div>
  );
}

window.PGE = window.PGE || {};
Object.assign(window.PGE, { EnvelopeSelectorRow, WindowShape, WINDOWS, SHAPES });
