/* @jsx React.createElement */
const { useState: useStateEE, useEffect: useEffectEE, useRef: useRefEE, useMemo: useMemoEE } = React;

/* ---------- Envelope catalog ---------- */
function listEnvelopes(stream) {
  if (!stream) return [];
  const list = [];
  if (stream.densityEnv) {
    list.push({ key: "density", label: "density", group: "Overall density",
      path: ["densityEnv"], unit: "g/s",
      visMin: 0, visMax: 50, hardMin: 0.01, hardMax: 4000 });
  }
  if (stream.distributionEnv) {
    list.push({ key: "distribution", label: "distribution", group: "Distribution",
      path: ["distributionEnv"], unit: "",
      visMin: 0, visMax: 1, hardMin: 0, hardMax: 1 });
  }
  if (stream.pointer && stream.pointer.speedRatioEnv) {
    list.push({ key: "speedRatio", label: "speed_ratio", group: "Pointer",
      path: ["pointer", "speedRatioEnv"], unit: "×",
      visMin: -1, visMax: 1, hardMin: -100, hardMax: 100 });
  }
  if (stream.pointer && stream.pointer.loopStartEnv) {
    list.push({ key: "loopStart", label: "loop_start", group: "Pointer",
      path: ["pointer", "loopStartEnv"], unit: "s",
      visMin: 0, visMax: 10, hardMin: 0, hardMax: 3600 });
  }
  if (stream.pointer && stream.pointer.loopDurEnv) {
    list.push({ key: "loopDur", label: "loop_duration", group: "Pointer",
      path: ["pointer", "loopDurEnv"], unit: "s",
      visMin: 0, visMax: 10, hardMin: 0.005, hardMax: 3600 });
  }
  if (stream.grain && stream.grain.durationEnv) {
    list.push({ key: "grainDur", label: "duration", group: "Grain",
      path: ["grain", "durationEnv"], unit: "s",
      visMin: 0.001, visMax: 0.1, hardMin: 0.001, hardMax: 10 });
  }
  if (stream.panEnv) {
    list.push({ key: "pan", label: "pan", group: "Volume & Pan",
      path: ["panEnv"], unit: "°",
      visMin: -360, visMax: 360, hardMin: -3600, hardMax: 3600 });
  }
  if (stream.volumeEnv) {
    list.push({ key: "volume", label: "volume", group: "Volume & Pan",
      path: ["volumeEnv"], unit: "dB",
      visMin: -40, visMax: 0, hardMin: -120, hardMax: 12 });
  }
  if (stream.pitch && stream.pitch.semitonesEnv) {
    list.push({ key: "pitch", label: "semitones", group: "Pitch",
      path: ["pitch", "semitonesEnv"], unit: "st",
      visMin: -12, visMax: 12, hardMin: -36, hardMax: 36 });
  }
  if (stream.voices && stream.voices.numEnv) {
    list.push({ key: "voicesNum", label: "num_voices", group: "Voices",
      path: ["voices", "numEnv"], unit: "",
      visMin: 1, visMax: 16, hardMin: 1, hardMax: 64 });
  }
  if (stream.voices && stream.voices.scatterEnv) {
    list.push({ key: "scatter", label: "scatter", group: "Voices",
      path: ["voices", "scatterEnv"], unit: "",
      visMin: 0, visMax: 1, hardMin: 0, hardMax: 1 });
  }
  if (stream.voices && stream.voices.pitch && stream.voices.pitch.stepEnv)
    list.push({ key: "voicesPitchStep", label: "pitch · step", group: "Voices",
      path: ["voices", "pitch", "stepEnv"], unit: "st",
      visMin: -12, visMax: 12, hardMin: -48, hardMax: 48 });
  if (stream.voices && stream.voices.pitch && stream.voices.pitch.semitone_rangeEnv)
    list.push({ key: "voicesPitchRange", label: "pitch · semitone_range", group: "Voices",
      path: ["voices", "pitch", "semitone_rangeEnv"], unit: "st",
      visMin: 0, visMax: 24, hardMin: 0, hardMax: 96 });
  if (stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.stepEnv)
    list.push({ key: "voicesOnsetStep", label: "onset · step", group: "Voices",
      path: ["voices", "onset_offset", "stepEnv"], unit: "s",
      visMin: 0, visMax: 1, hardMin: 0, hardMax: 60 });
  if (stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.baseEnv)
    list.push({ key: "voicesOnsetBase", label: "onset · base", group: "Voices",
      path: ["voices", "onset_offset", "baseEnv"], unit: "",
      visMin: 1, visMax: 4, hardMin: 0.01, hardMax: 100 });
  if (stream.voices && stream.voices.onset_offset && stream.voices.onset_offset.max_offsetEnv)
    list.push({ key: "voicesOnsetMaxOffset", label: "onset · max_offset", group: "Voices",
      path: ["voices", "onset_offset", "max_offsetEnv"], unit: "s",
      visMin: 0, visMax: 2, hardMin: 0, hardMax: 60 });
  if (stream.voices && stream.voices.pointer && stream.voices.pointer.stepEnv)
    list.push({ key: "voicesPointerStep", label: "pointer · step", group: "Voices",
      path: ["voices", "pointer", "stepEnv"], unit: "",
      visMin: -1, visMax: 1, hardMin: -1, hardMax: 1 });
  if (stream.voices && stream.voices.pointer && stream.voices.pointer.pointer_rangeEnv)
    list.push({ key: "voicesPointerRange", label: "pointer · range", group: "Voices",
      path: ["voices", "pointer", "pointer_rangeEnv"], unit: "",
      visMin: 0, visMax: 1, hardMin: 0, hardMax: 1 });
  if (stream.voices && stream.voices.pan && stream.voices.pan.spreadEnv)
    list.push({ key: "voicesPanSpread", label: "pan · spread", group: "Voices",
      path: ["voices", "pan", "spreadEnv"], unit: "°",
      visMin: 0, visMax: 360, hardMin: 0, hardMax: 3600 });
  if (Array.isArray(stream.dephase)) {
    list.push({ key: "dephase", label: "probability", group: "Dephase",
      path: ["dephase"], unit: "%",
      visMin: 0, visMax: 100, hardMin: 0, hardMax: 100 });
  }
  return list;
}

function getNested(obj, path) {return path.reduce((o, k) => o == null ? o : o[k], obj);}
function patchForPath(stream, path, value) {
  if (path.length === 1) return { [path[0]]: value };
  if (path.length === 2) return { [path[0]]: { ...(stream[path[0]] || {}), [path[1]]: value } };
  const top = stream[path[0]] || {};
  return { [path[0]]: { ...top, [path[1]]: { ...(top[path[1]] || {}), [path[2]]: value } } };
}

function fmtY(v, env) {
  if (env.unit === "s") return v.toFixed(3);
  if (env.unit === "%") return Math.round(v).toString();
  if (env.unit === "°") return Math.round(v).toString();
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/* ---------- EnvParamSelect ---------- */
function EnvParamSelect({ envelopes, value, onChange, compact }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = useStateEE(false);
  const [menuPos, setMenuPos] = useStateEE({ top: 0, left: 0, width: 0 });
  const ref = useRefEE(null);
  const btnRef = useRefEE(null);
  useEffectEE(() => {
    if (open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const MARGIN = 6;
      const spaceBelow = window.innerHeight - r.bottom - MARGIN;
      const spaceAbove = r.top - MARGIN;
      const flipUp = spaceBelow < 120 && spaceAbove > spaceBelow;
      setMenuPos({
        top: r.bottom + 2,
        bottom: window.innerHeight - r.top + 2,
        left: r.left,
        width: r.width,
        flipUp,
        maxH: Math.min(320, flipUp ? spaceAbove : spaceBelow),
      });
    }
  }, [open]);
  useEffectEE(() => {
    function onDoc(e) {if (ref.current && !ref.current.contains(e.target)) setOpen(false);}
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffectEE(() => {
    function onResize() { setOpen(false); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const cur = envelopes.find((e) => e.key === value) || envelopes[0];
  const groups = {};
  envelopes.forEach((e) => {(groups[e.group] = groups[e.group] || []).push(e);});
  return (
    <div className={"ee-psel-wrap" + (compact ? " compact" : "")} ref={ref}>
      <button className="ee-psel-btn" ref={btnRef} onClick={() => setOpen((o) => !o)}>
        {compact ? null : <span className="ee-psel-grp">{cur.group}</span>}
        {compact ? null : <span className="ee-psel-sep">/</span>}
        <span className="ee-psel-lbl">{cur.label}</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {open ?
      <div className="ee-psel-menu"
        style={{
          position: "fixed",
          ...(menuPos.flipUp ? { bottom: menuPos.bottom } : { top: menuPos.top }),
          left: menuPos.left,
          minWidth: compact ? menuPos.width : 240,
          maxHeight: menuPos.maxH || 320,
        }}>
          {Object.entries(groups).map(([g, items]) =>
        <div key={g} className="ee-psel-group">
              <div className="ee-psel-group-lbl">{g}</div>
              {items.map((it) =>
          <button key={it.key}
          className={"ee-psel-item" + (it.key === cur.key ? " on" : "")}
          onClick={() => {onChange(it.key);setOpen(false);}}>
                  <span className="ee-psel-item-l">{it.label}</span>
                  <span className="ee-psel-item-u">{it.unit || "·"}</span>
                </button>
          )}
            </div>
        )}
        </div> :
      null}
    </div>);

}

/* ---------- LoopBlockPanel — controls for the selected loop ---------- */
const DIST_TYPES = [
{ val: "linear", label: "linear", hint: "durate uguali" },
{ val: "exponential", label: "exp", hint: "accelerando · cicli sempre più brevi" },
{ val: "logarithmic", label: "log", hint: "ritardando · cicli sempre più lunghi" },
{ val: "geometric", label: "geo", hint: "progressione geometrica · ratio>1 ritarda" },
{ val: "power", label: "power", hint: "power law · cresce come (i+1)^e" }];

const INTERP_TYPES = [
{ val: "linear", label: "linear" },
{ val: "cubic", label: "cubic" },
{ val: "step", label: "step" }];

const DIST_PARAM = {
  linear: [],
  exponential: [{ key: "rate", label: "rate", def: 2.0, min: 0.1, max: 10, step: 0.1 }],
  logarithmic: [{ key: "base", label: "base", def: 2.0, min: 1.1, max: 10, step: 0.1 }],
  geometric: [{ key: "ratio", label: "ratio", def: 1.5, min: 0.1, max: 5, step: 0.05 }],
  power: [{ key: "exponent", label: "exponent", def: 2.0, min: 0.1, max: 6, step: 0.1 }]
};
function distType(d) {return typeof d === "string" ? d : d && d.type || "linear";}
function distParams(d) {return typeof d === "object" && d ? d : {};}

function LoopBlockPanel({ block, onUpdate, onDelete, color }) {
  const { Icon } = window.PGE;
  if (!block) return null;
  const [pat, end, n, interp, dist] = block.raw;
  const dtype = distType(dist);
  const dparams = distParams(dist);

  function setN(v) {
    const nn = Math.max(1, Math.min(64, Math.round(v)));
    onUpdate([pat, end, nn, interp || "linear", dist || "linear"]);
  }
  function setInterp(v) {onUpdate([pat, end, n, v, dist || "linear"]);}
  function setDistType(v) {
    if (v === "linear") onUpdate([pat, end, n, interp || "linear", "linear"]);else
    {
      const params = (DIST_PARAM[v] || []).reduce((a, p) => (a[p.key] = p.def, a), {});
      onUpdate([pat, end, n, interp || "linear", { type: v, ...params }]);
    }
  }
  function setDistParam(key, value) {
    onUpdate([pat, end, n, interp || "linear", { type: dtype, ...dparams, [key]: value }]);
  }
  function setEnd(v) {
    const ne = Math.max(block.start + 0.001, Math.min(1, v));
    onUpdate([pat, +ne.toFixed(4), n, interp || "linear", dist || "linear"]);
  }

  const params = DIST_PARAM[dtype] || [];

  return (
    <div className="ee-loop-panel" style={{ borderColor: color }}>
      <div className="ee-loop-panel-head">
        <span className="ee-loop-panel-icon" style={{ color }}>↻</span>
        <span className="ee-loop-panel-title">loop block</span>
        <span className="ee-loop-panel-meta mono">
          [{block.start.toFixed(3)} → {block.end.toFixed(3)}] · {block.pattern.length}pt × {n} cycles
        </span>
        <span style={{ flex: 1 }} />
        <button className="ee-loop-panel-del" title="remove loop" onClick={onDelete}>
          <Icon name="trash" size={11} />
        </button>
      </div>

      <div className="ee-loop-panel-row">
        <label className="ee-loop-fld">
          <span className="ee-loop-lbl">n_reps</span>
          <div className="ee-loop-stepper">
            <button onClick={() => setN(n - 1)} disabled={n <= 1}>−</button>
            <span className="mono">{n}</span>
            <button onClick={() => setN(n + 1)}>+</button>
          </div>
        </label>

        <label className="ee-loop-fld">
          <span className="ee-loop-lbl">end_time</span>
          <input type="number" className="ee-loop-input mono"
          value={end} min={0} max={1} step={0.01}
          onChange={(e) => setEnd(parseFloat(e.target.value) || 0)} />
          <span className="ee-loop-unit mono">x</span>
        </label>

        <label className="ee-loop-fld">
          <span className="ee-loop-lbl">interp</span>
          <select className="ee-loop-select mono" value={interp || "linear"}
          onChange={(e) => setInterp(e.target.value)}>
            {INTERP_TYPES.map((o) => <option key={o.val} value={o.val}>{o.label}</option>)}
          </select>
        </label>

        <label className="ee-loop-fld">
          <span className="ee-loop-lbl">time_dist</span>
          <select className="ee-loop-select mono" value={dtype}
          onChange={(e) => setDistType(e.target.value)}>
            {DIST_TYPES.map((o) => <option key={o.val} value={o.val}>{o.label}</option>)}
          </select>
        </label>

        {params.map((p) =>
        <label key={p.key} className="ee-loop-fld">
            <span className="ee-loop-lbl">{p.label}</span>
            <input type="number" className="ee-loop-input mono"
          value={dparams[p.key] != null ? dparams[p.key] : p.def}
          min={p.min} max={p.max} step={p.step}
          onChange={(e) => setDistParam(p.key, parseFloat(e.target.value) || p.def)} />
          </label>
        )}
      </div>

      <div className="ee-loop-panel-hint mono">
        pattern · {block.pattern.length} pt · x∈[0,100]% di ciclo · drag i punti del 1° ciclo per modificare il pattern · drag l'edge destro del loop per allungarlo
      </div>
    </div>);

}

function EnvelopeEditor({ stream, pxPerSec, duration, playhead, onChange, onLoopPanelChange, focusKey }) {
  const { Icon } = window.PGE;
  const envelopes = useMemoEE(() => listEnvelopes(stream), [stream]);
  const [selectedKey, setSelectedKey] = useStateEE(null);
  const [dragging, setDragging] = useStateEE(null);
  const [hoverBP, setHoverBP] = useStateEE(null);
  const [hoverBlock, setHoverBlock] = useStateEE(null);
  const [selectedBlock, setSelectedBlock] = useStateEE(null); // originalIdx of selected loop
  const [selectedBP, setSelectedBP] = useStateEE(null); // originalIdx of selected breakpoint
  const [selectedPattern, setSelectedPattern] = useStateEE(null); // {blockIdx, patIdx} of selected pattern point inside a loop
  const bodyRef = useRefEE(null);
  const svgRef = useRefEE(null);
  const zoneReorderRef = useRefEE(null); // tracks toIdx during zone-reorder drag

  /* undo/redo handled globally (TopBar + ⌘Z) — gestures bracket via window.PGEHistory */

  /* ---- side column width sync with timeline ---- */
  const [headW, setHeadW] = useStateEE(() => {
    const stored = parseFloat(localStorage.getItem("pge-split-tl-heads"));
    return (stored > 0) ? stored : 220;
  });
  useEffectEE(() => {
    function pickHead() {return document.querySelector(".lanes-head");}
    let head = pickHead();
    function update() {if (head) setHeadW(head.getBoundingClientRect().width);}
    if (!head) {
      const t = setTimeout(() => {
        head = pickHead();
        if (head) {
          update();
          const ro = new ResizeObserver(update);
          ro.observe(head);
        }
      }, 0);
      return () => clearTimeout(t);
    }
    update();
    const ro = new ResizeObserver(update);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);

  /* ---- keep a valid selection ---- */
  useEffectEE(() => {
    if (!envelopes.length) {setSelectedKey(null);return;}
    if (!envelopes.find((e) => e.key === selectedKey)) setSelectedKey(envelopes[0].key);
  }, [stream && stream.id, envelopes.map((e) => e.key).join(",")]);

  /* ---- external focus request from Inspector ---- */
  useEffectEE(() => {
    if (!focusKey) return;
    const key = focusKey.split(":")[0];
    if (envelopes.find((e) => e.key === key)) setSelectedKey(key);
  }, [focusKey]);

  /* clear selected block/bp on stream/env switch */
  useEffectEE(() => {setSelectedBlock(null);setSelectedBP(null);setSelectedPattern(null);}, [stream && stream.id, selectedKey]);

  /* ---- viewport size ---- */
  const [vp, setVp] = useStateEE({ w: 1200, h: 200 });
  useEffectEE(() => {
    const body = bodyRef.current;if (!body) return;
    const upd = () => setVp({ w: body.clientWidth || 1200, h: body.clientHeight || 200 });
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(body);
    return () => ro.disconnect();
  }, [stream?.id]);

  /* ---- keyboard: Backspace/Delete removes selected breakpoint or loop ---- */
  useEffectEE(() => {
    function onKey(e) {
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (selectedBP == null && selectedBlock == null && selectedPattern == null) return;
      if (!stream) return;
      const envs = listEnvelopes(stream);
      const e2 = envs.find((x) => x.key === selectedKey) || envs[0];
      if (!e2) return;
      const cur = (getNested(stream, e2.path) || []).slice();
      const PGEEnv = window.PGEEnv;
      e.preventDefault();
      if (selectedPattern != null) {
        // Delete a single pattern point inside a loop block. Refuse to drop
        // endpoints (xPct 0 / 100) or to leave fewer than 2 points.
        const { blockIdx, patIdx } = selectedPattern;
        const block = cur[blockIdx];
        if (!block || !PGEEnv.isCompactBlock(block)) {setSelectedPattern(null);return;}
        const pattern = block[0];
        if (patIdx === 0 || patIdx === pattern.length - 1) return;
        if (pattern.length <= 2) return;
        const newPattern = pattern.filter((_, i) => i !== patIdx);
        const newBlock = block.slice();
        newBlock[0] = newPattern;
        const next = cur.map((it, i) => i === blockIdx ? newBlock : it);
        onChange(patchForPath(stream, e2.path, next));
        setSelectedPattern(null);
      } else if (selectedBP != null) {
        // Allow deletion unless it would leave the envelope without any
        // standalone BP AND without any loop block (i.e. truly empty).
        const next = cur.filter((_, i) => i !== selectedBP);
        const remainingBPs = next.filter(PGEEnv.isBreakpoint).length;
        const remainingLoops = next.filter(PGEEnv.isCompactBlock).length;
        if (remainingBPs + remainingLoops < 1) {setSelectedBP(null);return;}
        onChange(patchForPath(stream, e2.path, next));
        setSelectedBP(null);
      } else if (selectedBlock != null) {
        const next = cur.filter((_, i) => i !== selectedBlock);
        onChange(patchForPath(stream, e2.path, next));
        setSelectedBlock(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stream, selectedKey, selectedBP, selectedBlock, selectedPattern]);

  /* ============ Envelope model — computed before early returns so hook count is stable ============ */
  const env = envelopes.find((e) => e.key === selectedKey) || envelopes[0];
  const isNormalized = stream ? stream.timeMode === "normalized" : false;
  const PGEEnv = window.PGEEnv;
  const rawEnvRaw = (stream && env) ? getNested(stream, env.path) : null;
  const _wrap = rawEnvRaw ? PGEEnv.unwrapEnv(rawEnvRaw) : { items: [], interp: null };
  const rawEnv = _wrap.items;
  const globalInterp = _wrap.interp;
  const exp = useMemoEE(() => rawEnvRaw ? PGEEnv.expandMixed(rawEnvRaw) : { blocks: [], bps: [] }, [rawEnvRaw]);
  const blockByOrig = useMemoEE(() => {
    const m = new Map();
    exp.blocks.forEach((b) => m.set(b.originalIdx, { ...b, raw: rawEnv[b.originalIdx] }));
    return m;
  }, [exp, rawEnv]);
  const macroZones = useMemoEE(() => {
    const zones = [];
    let cursor = 0;
    let curBP = null;
    for (let i = 0; i < rawEnv.length; i++) {
      const it = rawEnv[i];
      if (PGEEnv.isBreakpoint(it)) {
        if (!curBP) {
          curBP = { kind: "bps", indices: [], start: cursor };
          zones.push(curBP);
        }
        curBP.indices.push(i);
      } else if (PGEEnv.isCompactBlock(it)) {
        if (curBP) {
          curBP.end = rawEnv[curBP.indices[curBP.indices.length - 1]][0];
          cursor = curBP.end;
          curBP = null;
        }
        zones.push({ kind: "loop", index: i, start: cursor, end: it[1] });
        cursor = it[1];
      }
    }
    if (curBP) {
      curBP.end = rawEnv[curBP.indices[curBP.indices.length - 1]][0];
      cursor = curBP.end;
    }
    if (cursor < 1 - 1e-6) {
      zones.push({ kind: "empty", start: cursor, end: 1 });
    } else if (zones.length > 0) {
      zones.push({ kind: "empty", start: 1, end: 1 });
    }
    return zones;
  }, [rawEnv]);

  /* selectedBlockObj and its side-effect must live before any early return
     so that hook call count stays stable across renders. */
  const selectedBlockObj = selectedBlock != null ? blockByOrig.get(selectedBlock) : null;
  useEffectEE(() => { onLoopPanelChange?.(selectedBlockObj != null); }, [selectedBlockObj != null]);

  /* ============ Empty states ============ */
  if (!stream) {
    return (
      <div className="pge-envedit">
        <header className="ee-head">
          <Icon name="sliders" size={12} />
          <span className="ee-title">Envelopes</span>
          <span className="ee-meta">— no stream selected —</span>
        </header>
        <div className="ee-row">
          <div className="ee-side" style={{ width: headW }}>
            <div className="ee-side-empty mono">no stream</div>
          </div>
          <div className="ee-empty">
            <div className="ee-empty-icon"><Icon name="sliders" size={22} /></div>
            <div>select a stream in the timeline to edit its envelopes</div>
          </div>
        </div>
      </div>);

  }

  if (!env) {
    return (
      <div className="pge-envedit">
        <header className="ee-head">
          <Icon name="sliders" size={12} />
          <span className="ee-title">Envelopes</span>
          <span className="ee-streamtag" style={{ borderColor: stream.color, color: stream.color }}>{stream.id}</span>
          <span style={{ flex: 1 }} />
          <span className="ee-meta">no envelope parameters</span>
        </header>
        <div className="ee-row">
          <div className="ee-side" style={{ width: headW }}>
            <div className="ee-side-streamtag" style={{ borderColor: stream.color, color: stream.color }}>{stream.id}</div>
            <div className="ee-side-empty mono">— no envelopes —</div>
          </div>
          <div className="ee-empty">
            <div className="ee-empty-icon"><Icon name="sliders" size={22} /></div>
            <div>
              <span style={{ color: "var(--fg-2)" }}>{stream.id}</span> has no parameters in <span style={{ color: "var(--accent)" }}>env</span> mode.
            </div>
            <div className="ee-empty-hint">
              open the Inspector → switch any parameter from <span className="mono">scalar</span> to <span className="mono" style={{ color: "var(--accent)" }}>env</span> to start drawing its automation here.
            </div>
          </div>
        </div>
      </div>);

  }
  /* ============ Layout ============ */
  const totalW = Math.max(40, vp.w);
  const H = vp.h;
  const LOOP_BAND_H = 24;
  const PAD_T = 8 + LOOP_BAND_H + 20;
  const PAD_B = 16;
  const PAD_L = 6,PAD_R = 6;
  const innerH = Math.max(40, H - PAD_T - PAD_B);
  const innerW = Math.max(40, totalW - PAD_L - PAD_R);

  /* Y autofit — fit all expanded points + raw breakpoints */
  let ymin = env.visMin,ymax = env.visMax;
  if (exp.points.length) {
    const ys = exp.points.map((p) => p[1]);
    ymin = Math.min(ymin, ...ys);
    ymax = Math.max(ymax, ...ys);
  }
  if (ymin === ymax) ymax = ymin + (env.unit === "s" ? 0.01 : 1);
  const yRange = ymax - ymin;
  ymax = Math.min(env.hardMax, ymax + yRange * 0.10);
  ymin = Math.max(env.hardMin, ymin - yRange * 0.10);

  function xOf(bpX) {return PAD_L + bpX * innerW;}
  function bpXofXPx(xPx) {return (xPx - PAD_L) / innerW;}
  function yOf(val) {return PAD_T + (1 - (val - ymin) / (ymax - ymin)) * innerH;}
  function valOfY(yPx) {return ymin + (1 - (yPx - PAD_T) / innerH) * (ymax - ymin);}

  const xPrec = 4;
  const yPrec = env.unit === "s" ? 4 : 2;
  const xMin = 0,xMax = 1;

  /* time grid */
  const ticks = [];
  for (let i = 0; i <= 10; i++) {
    const v = +(i / 10).toFixed(4);
    ticks.push({ s: v, major: i % (10 / 4) === 0 || i === 10, x: xOf(v) });
  }
  const fmtTimeTick = (v) => v === 0 ? "0" : v === 1 ? "1" : v.toFixed(1);

  /* y ticks */
  const Y_DIV = 4;
  const yTicks = [];
  for (let i = 0; i <= Y_DIV; i++) {
    const v = ymin + i / Y_DIV * (ymax - ymin);
    yTicks.push({ v, y: yOf(v) });
  }

  const streamX0 = xOf(0);
  const streamX1 = xOf(1);

  /* ============ Interactions ============ */
  function commit(next) {
    onChange(patchForPath(stream, env.path, PGEEnv.wrapEnv(next, globalInterp)));
  }
  function commitWithInterp(nextItems, nextInterp) {
    onChange(patchForPath(stream, env.path, PGEEnv.wrapEnv(nextItems, nextInterp)));
  }
  function beginDragHistory() {if (window.PGEHistory) window.PGEHistory.beginGesture();}
  function endDragHistory() {if (window.PGEHistory) window.PGEHistory.endGesture();}

  /* ----- standard breakpoint drag ----- */
  function startBPDrag(e, idx) {
    e.preventDefault();e.stopPropagation();
    setDragging({ kind: "bp", idx });
    setSelectedBP(idx);
    setSelectedBlock(null);
    setSelectedPattern(null);
    beginDragHistory();
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    // neighbour indices in the FLAT list of standard breakpoints
    const flatBPIndices = rawEnv.map((it, i) => PGEEnv.isBreakpoint(it) ? i : -1).filter((i) => i >= 0);
    const myPos = flatBPIndices.indexOf(idx);
    const prevBP = myPos > 0 ? rawEnv[flatBPIndices[myPos - 1]] : null;
    const nextBP = myPos < flatBPIndices.length - 1 ? rawEnv[flatBPIndices[myPos + 1]] : null;

    function move(ev) {
      const xPx = ev.clientX - rect.left;
      const yPx = ev.clientY - rect.top;
      const xStep = 0.001;
      let newX = bpXofXPx(xPx);
      const lo = prevBP ? prevBP[0] + xStep : xMin;
      const hi = nextBP ? nextBP[0] - xStep : xMax;
      newX = Math.max(lo, Math.min(hi, newX));
      let newVal = valOfY(yPx);
      newVal = Math.max(env.hardMin, Math.min(env.hardMax, newVal));
      if (ev.shiftKey) {
        const niceY = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000];
        let s = niceY[0];
        for (const n of niceY) {if (n * 10 >= ymax - ymin) {s = n;break;}}
        newVal = Math.round(newVal / s) * s;
      }
      const updated = rawEnv.map((it, i) => i === idx ?
      [+newX.toFixed(xPrec), +newVal.toFixed(yPrec)] : it);
      commit(updated);
    }
    function up() {
      setDragging(null);
      endDragHistory();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ----- pattern point drag (inside loop's first cycle) ----- */
  function startPatternDrag(e, blockOrigIdx, patIdx) {
    e.preventDefault();e.stopPropagation();
    setDragging({ kind: "pat", blockOrigIdx, patIdx });
    setSelectedPattern({ blockIdx: blockOrigIdx, patIdx });
    setSelectedBlock(null);
    setSelectedBP(null);
    beginDragHistory();
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    const block = blockByOrig.get(blockOrigIdx);
    const firstCycle = block.cycles[0];
    const cycT = firstCycle.end - firstCycle.start; // duration of first cycle (timeline x units)

    function move(ev) {
      const xPx = ev.clientX - rect.left;
      const yPx = ev.clientY - rect.top;
      const tx = bpXofXPx(xPx); // [0,1] envelope x
      // map to pattern percent [0,100] within the cycle
      let xPct = (tx - firstCycle.start) / cycT * 100;
      const pattern = block.raw[0];
      const prev = patIdx > 0 ? pattern[patIdx - 1][0] : 0;
      const next = patIdx < pattern.length - 1 ? pattern[patIdx + 1][0] : 100;
      if (patIdx === 0) xPct = 0;else
      if (patIdx === pattern.length - 1) xPct = 100;else
      xPct = Math.max(prev + 0.1, Math.min(next - 0.1, xPct));
      let newVal = valOfY(yPx);
      newVal = Math.max(env.hardMin, Math.min(env.hardMax, newVal));
      const newPattern = pattern.map((p, i) => i === patIdx ?
      [+xPct.toFixed(2), +newVal.toFixed(yPrec)] : p);
      const newBlock = [newPattern, block.raw[1], block.raw[2], block.raw[3], block.raw[4]].filter((x) => x !== undefined);
      const updated = rawEnv.map((it, i) => i === blockOrigIdx ? newBlock : it);
      commit(updated);
    }
    function up() {
      setDragging(null);
      endDragHistory();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ----- loop end_time drag ----- */
  function startLoopEndDrag(e, blockOrigIdx) {
    e.preventDefault();e.stopPropagation();
    setDragging({ kind: "end", blockOrigIdx });
    setSelectedBlock(blockOrigIdx);
    setSelectedBP(null);
    setSelectedPattern(null);
    beginDragHistory();
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    function move(ev) {
      const xPx = ev.clientX - rect.left;
      let nx = bpXofXPx(xPx);
      const block = blockByOrig.get(blockOrigIdx);
      // find next standard BP or end of envelope
      let hi = 1;
      for (let i = blockOrigIdx + 1; i < rawEnv.length; i++) {
        if (PGEEnv.isBreakpoint(rawEnv[i])) {hi = rawEnv[i][0] - 0.001;break;}
        if (PGEEnv.isCompactBlock(rawEnv[i])) {hi = rawEnv[i][1] - 0.001;break;}
      }
      nx = Math.max(block.start + 0.01, Math.min(hi, nx));
      const newBlock = block.raw.slice();
      newBlock[1] = +nx.toFixed(4);
      const updated = rawEnv.map((it, i) => i === blockOrigIdx ? newBlock : it);
      commit(updated);
    }
    function up() {
      setDragging(null);
      endDragHistory();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ----- dbl click on canvas: add bp; on bp / pattern pt: delete ----- */
  function onCanvasDblClick(e) {
    const tgt = e.target;
    if (tgt && tgt.classList && tgt.classList.contains("ee-bp")) {
      const idx = +tgt.dataset.idx;
      const next = rawEnv.filter((_, i) => i !== idx);
      const remainingBPs = next.filter(PGEEnv.isBreakpoint).length;
      const remainingLoops = next.filter(PGEEnv.isCompactBlock).length;
      if (remainingBPs + remainingLoops < 1) return;
      commit(next);
      return;
    }
    if (tgt && tgt.classList && tgt.classList.contains("ee-pat-handle")) {
      const blockIdx = +tgt.dataset.block;
      const patIdx = +tgt.dataset.pat;
      const block = blockByOrig.get(blockIdx);
      if (!block) return;
      const pattern = block.raw[0];
      // patterns must keep their endpoints (xPct 0 and 100) — refuse to delete those,
      // and don't drop below 2 points (a loop needs at least start + end).
      if (patIdx === 0 || patIdx === pattern.length - 1) return;
      if (pattern.length <= 2) return;
      const newPattern = pattern.filter((_, i) => i !== patIdx);
      const newBlock = block.raw.slice();
      newBlock[0] = newPattern;
      const next = rawEnv.map((it, i) => i === blockIdx ? newBlock : it);
      commit(next);
      return;
    }
    const rect = svgRef.current.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    if (yPx < PAD_T) return; // ignore loop band
    const x = Math.max(xMin, Math.min(xMax, bpXofXPx(xPx)));
    const val = Math.max(env.hardMin, Math.min(env.hardMax, valOfY(yPx)));

    // If the click landed *inside* a loop block's x-range, add a new pattern
    // point to that block instead of a standalone breakpoint. The new point
    // is positioned by mapping the click into the *first cycle's* xPct space
    // (patterns are defined once per block, in cycle-local 0..100 coords).
    const hostBlock = exp.blocks.find((b) => x >= b.start && x <= b.end);
    if (hostBlock) {
      const cyc = hostBlock.cycles.find((c) => x >= c.start && x <= c.end) || hostBlock.cycles[0];
      const cycDur = Math.max(1e-9, cyc.end - cyc.start);
      let xPct = (x - cyc.start) / cycDur * 100;
      // raw[] is only populated on blockByOrig — use the raw env item directly
      const rawBlock = rawEnv[hostBlock.originalIdx];
      const pattern = rawBlock[0];
      const minPct = 0.1, maxPct = 99.9;
      // collision guard — don't drop a duplicate within 0.5% of an existing point
      const COLLIDE = 0.5;
      if (pattern.some((p) => Math.abs(p[0] - xPct) < COLLIDE)) return;
      xPct = Math.max(minPct, Math.min(maxPct, xPct));
      const newPt = [+xPct.toFixed(2), +val.toFixed(yPrec)];
      const newPattern = [...pattern, newPt].sort((a, b) => a[0] - b[0]);
      const newBlock = rawBlock.slice();
      newBlock[0] = newPattern;
      const next = rawEnv.map((it, i) => i === hostBlock.originalIdx ? newBlock : it);
      commit(next);
      const newPatIdx = newPattern.findIndex((p) => p === newPt);
      setSelectedPattern({ blockIdx: hostBlock.originalIdx, patIdx: newPatIdx });
      setSelectedBlock(null);
      setSelectedBP(null);
      return;
    }

    // Otherwise: insert a standalone breakpoint, preserving the order of
    // standard BPs and the position of any loop blocks.
    const newBP = [+x.toFixed(xPrec), +val.toFixed(yPrec)];
    let insertAt = rawEnv.length;
    for (let i = 0; i < rawEnv.length; i++) {
      if (PGEEnv.isBreakpoint(rawEnv[i]) && rawEnv[i][0] > x) {insertAt = i;break;}
      if (PGEEnv.isCompactBlock(rawEnv[i]) && rawEnv[i][1] > x) {insertAt = i;break;}
    }
    const next = [...rawEnv];
    next.splice(insertAt, 0, newBP);
    commit(next);
  }

  function rescaleZoneItems(env, zone, newStart, newEnd) {
    if (zone.kind === "empty") return env;
    const oldStart = zone.start, oldEnd = zone.end;
    const oldLen = oldEnd - oldStart;
    if (zone.kind === "bps") {
      return env.map((it, i) => {
        if (!zone.indices.includes(i)) return it;
        const nt = oldLen <= 1e-9 ?
          newEnd :
          newStart + (it[0] - oldStart) * (newEnd - newStart) / oldLen;
        return [+nt.toFixed(xPrec), it[1]];
      });
    }
    if (zone.kind === "loop") {
      return env.map((it, i) => {
        if (i !== zone.index) return it;
        const copy = it.slice();
        copy[1] = +newEnd.toFixed(4);
        return copy;
      });
    }
    return env;
  }

  /* ----- zone boundary drag (rescale two adjacent zones) ----- */
  function startZoneBoundaryDrag(e, leftZone, rightZone) {
    e.preventDefault();
    e.stopPropagation();
    setDragging({ kind: "zone-boundary", at: leftZone.end });
    beginDragHistory();
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const MIN = 0.005;
    // snapshot original zone bounds so we always remap from the original env
    const origLeft = { ...leftZone };
    const origRight = { ...rightZone };

    function move(ev) {
      const xPx = ev.clientX - rect.left;
      let B = bpXofXPx(xPx);
      B = Math.max(origLeft.start + MIN, Math.min(origRight.end - MIN, B));

      let next = rawEnv;
      next = rescaleZoneItems(next, origLeft, origLeft.start, B);
      next = rescaleZoneItems(next, origRight, B, origRight.end);
      commit(next);
      setDragging({ kind: "zone-boundary", at: B });
    }
    function up() {
      setDragging(null);
      endDragHistory();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* ----- zone reorder drag ----- */
  function startZoneDrag(e, fromZoneIdx) {
    const zone = macroZones[fromZoneIdx];
    if (!zone || zone.kind === "empty") return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedBlock(null);
    setSelectedBP(null);
    setSelectedPattern(null);
    beginDragHistory();
    zoneReorderRef.current = fromZoneIdx;
    setDragging({ kind: "zone-reorder", fromIdx: fromZoneIdx, toIdx: fromZoneIdx });
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    function move(ev) {
      const xNorm = bpXofXPx(ev.clientX - rect.left);
      let toIdx = fromZoneIdx;
      for (let i = 0; i < macroZones.length; i++) {
        const z = macroZones[i];
        if (z.kind === "empty") continue;
        if (xNorm >= z.start && xNorm <= z.end) { toIdx = i; break; }
      }
      zoneReorderRef.current = toIdx;
      setDragging({ kind: "zone-reorder", fromIdx: fromZoneIdx, toIdx });
    }
    function up() {
      const toIdx = zoneReorderRef.current;
      if (toIdx != null && toIdx !== fromZoneIdx) doZoneReorder(fromZoneIdx, toIdx);
      zoneReorderRef.current = null;
      setDragging(null);
      endDragHistory();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function doZoneReorder(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const nonEmpty = macroZones.filter((z) => z.kind !== "empty");
    const fromZone = macroZones[fromIdx];
    const toZone = macroZones[toIdx];
    if (!fromZone || !toZone || fromZone.kind === "empty" || toZone.kind === "empty") return;
    const fi = nonEmpty.indexOf(fromZone);
    const ti = nonEmpty.indexOf(toZone);
    if (fi < 0 || ti < 0) return;

    const newOrder = nonEmpty.slice();
    [newOrder[fi], newOrder[ti]] = [newOrder[ti], newOrder[fi]];

    // compute new time slots — each zone keeps its original duration
    let cursor = 0;
    const slots = newOrder.map((z) => {
      const dur = z.end - z.start;
      const ns = cursor, ne = cursor + dur;
      cursor = ne;
      return { zone: z, ns, ne };
    });

    // remap items to new time range
    const remapped = new Map();
    slots.forEach(({ zone, ns, ne }) => {
      const os = zone.start, oe = zone.end, od = oe - os;
      if (zone.kind === "bps") {
        zone.indices.forEach((i) => {
          const it = rawEnv[i];
          const nt = od <= 1e-9 ? ne : ns + (it[0] - os) * (ne - ns) / od;
          remapped.set(i, [+nt.toFixed(xPrec), it[1]]);
        });
      } else if (zone.kind === "loop") {
        const copy = rawEnv[zone.index].slice();
        copy[1] = +ne.toFixed(4);
        remapped.set(zone.index, copy);
      }
    });

    const next = [];
    slots.forEach(({ zone }) => {
      if (zone.kind === "bps") {
        const bps = zone.indices.map((i) => remapped.get(i));
        bps.sort((a, b) => a[0] - b[0]);
        next.push(...bps);
      } else if (zone.kind === "loop") {
        next.push(remapped.get(zone.index));
      }
    });
    commit(next);
  }

  /* ----- add new loop block ----- */
  /* Behavior:
       - append at end with default block ending at 1.0
       - if there isn't enough room (>=15% free on the right), auto-squeeze
         all existing items proportionally so the new loop gets at least
         MIN_LOOP_WIDTH width. The user can then fine-tune by dragging the
         macro-zone boundaries in the zones bar. */
  function addLoop() {
    let lastT = 0, lastV = 0;
    for (let i = 0; i < rawEnv.length; i++) {
      if (PGEEnv.isBreakpoint(rawEnv[i])) {lastT = rawEnv[i][0];lastV = rawEnv[i][1];} else
      if (PGEEnv.isCompactBlock(rawEnv[i])) {lastT = rawEnv[i][1];lastV = rawEnv[i][0][rawEnv[i][0].length - 1][1];}
    }

    const MIN_LOOP_WIDTH = 0.15;
    let working = rawEnv;
    let blockStart = lastT;
    if (lastT > 1 - MIN_LOOP_WIDTH && lastT > 0) {
      // squeeze prior content into [0, 1 - MIN_LOOP_WIDTH]
      const scale = (1 - MIN_LOOP_WIDTH) / lastT;
      working = rawEnv.map((it) => {
        if (PGEEnv.isBreakpoint(it)) return [+(it[0] * scale).toFixed(4), it[1]];
        if (PGEEnv.isCompactBlock(it)) {
          const copy = it.slice();
          copy[1] = +(it[1] * scale).toFixed(4);
          return copy;
        }
        return it;
      });
      blockStart = 1 - MIN_LOOP_WIDTH;
    }
    const block = PGEEnv.defaultCompactBlock(working, lastV);
    block[1] = 1;
    const next = [...working, block];
    commit(next);
    // select it after commit — index will be next.length - 1
    setSelectedPattern(null);
    setSelectedBP(null);
    setTimeout(() => setSelectedBlock(next.length - 1), 0);
  }

  /* ----- delete selected loop block ----- */
  function deleteSelectedLoop() {
    if (selectedBlock == null) return;
    const next = rawEnv.filter((_, i) => i !== selectedBlock);
    commit(next);
    setSelectedBlock(null);
    setSelectedPattern(null);
  }

  /* ----- update loop block ----- */
  function updateBlock(origIdx, newRaw) {
    const next = rawEnv.map((it, i) => i === origIdx ? newRaw : it);
    commit(next);
  }

  /* ============ path strings ============
     Renders the envelope as an SVG `d` honoring interp:
       - standalone BPs use globalInterp (mutually exclusive with loop blocks)
       - loop cycles use block.interp (intra-cycle); cross-cycle and
         block-boundary connectors are forced linear (logical discontinuities)

     CUBIC = PCHIP (Fritsch-Carlson 1980, monotone-preserving):
       segment slopes  δᵢ = (vᵢ₊₁ − vᵢ) / (tᵢ₊₁ − tᵢ)
       at interior i:  if δ_{i-1}·δᵢ ≤ 0  → mᵢ = 0          (local extremum)
                       else mᵢ = 2 / (1/δ_{i-1} + 1/δᵢ)     (weighted harmonic)
       at endpoints:   m₀ = δ₀, m_{n-1} = δ_{n-2}
     Hermite → Bezier control points in DOMAIN space:
       cp1 = (tᵢ + h/3,   vᵢ   + h·mᵢ/3)
       cp2 = (tᵢ₊₁ − h/3, vᵢ₊₁ − h·mᵢ₊₁/3)
     Reference: Fritsch & Carlson, SIAM J. Numer. Anal. 17 (1980).         */
  function emitGroup(bps, interp, started) {
    if (!bps.length) return { d: "", firstX: 0, lastX: 0 };
    const head = bps[0];
    const x0 = xOf(head[0]), y0 = yOf(head[1]);
    let d = started ? ` L ${x0.toFixed(2)} ${y0.toFixed(2)}` :
                      `M ${x0.toFixed(2)} ${y0.toFixed(2)}`;
    const n = bps.length;
    if (n === 1) return { d, firstX: x0, lastX: x0 };

    if (interp === "step") {
      for (let k = 1; k < n; k++) {
        const px  = xOf(bps[k][0]).toFixed(2);
        const ppy = yOf(bps[k - 1][1]).toFixed(2);
        const py  = yOf(bps[k][1]).toFixed(2);
        d += ` L ${px} ${ppy} L ${px} ${py}`;
      }
    } else if (interp === "cubic" && n >= 2) {
      // PCHIP — slopes & tangents in domain coords
      const h = new Array(n - 1);
      const delta = new Array(n - 1);
      for (let i = 0; i < n - 1; i++) {
        h[i] = bps[i + 1][0] - bps[i][0];
        delta[i] = h[i] !== 0 ? (bps[i + 1][1] - bps[i][1]) / h[i] : 0;
      }
      const m = new Array(n);
      if (n === 2) { m[0] = delta[0]; m[1] = delta[0]; }
      else {
        m[0]     = delta[0];
        m[n - 1] = delta[n - 2];
        for (let i = 1; i < n - 1; i++) {
          const dl = delta[i - 1], dr = delta[i];
          if (dl * dr <= 0) m[i] = 0;
          else m[i] = 2 / (1 / dl + 1 / dr);
        }
      }
      for (let i = 0; i < n - 1; i++) {
        const t0 = bps[i][0],     v0 = bps[i][1];
        const t1 = bps[i + 1][0], v1 = bps[i + 1][1];
        const cp1t = t0 + h[i] / 3,        cp1v = v0 + h[i] * m[i]     / 3;
        const cp2t = t1 - h[i] / 3,        cp2v = v1 - h[i] * m[i + 1] / 3;
        d += ` C ${xOf(cp1t).toFixed(2)} ${yOf(cp1v).toFixed(2)}` +
             ` ${xOf(cp2t).toFixed(2)} ${yOf(cp2v).toFixed(2)}` +
             ` ${xOf(t1).toFixed(2)} ${yOf(v1).toFixed(2)}`;
      }
    } else {
      for (let k = 1; k < n; k++) {
        d += ` L ${xOf(bps[k][0]).toFixed(2)} ${yOf(bps[k][1]).toFixed(2)}`;
      }
    }
    const last = bps[n - 1];
    return { d, firstX: x0, lastX: xOf(last[0]) };
  }

  function buildEnvelopeD() {
    if (!exp.points.length) return { lineD: "", firstX: 0, lastX: 0 };
    const blockByIdx = new Map();
    exp.blocks.forEach((b) => blockByIdx.set(b.originalIdx, b));

    let d = "";
    let started = false;
    let firstX = 0, lastX = 0;
    let bpRun = []; // consecutive standalone BPs — emitted as one group

    function flushBPs() {
      if (!bpRun.length) return;
      const res = emitGroup(bpRun, globalInterp || "linear", started);
      if (!started) firstX = res.firstX;
      lastX = res.lastX;
      started = true;
      d += res.d;
      bpRun = [];
    }

    for (let i = 0; i < rawEnv.length; i++) {
      const item = rawEnv[i];
      if (PGEEnv.isBreakpoint(item)) {
        bpRun.push(item);
      } else if (PGEEnv.isCompactBlock(item)) {
        flushBPs();
        const block = blockByIdx.get(i);
        if (!block) continue;
        const blockInterp = block.interp || "linear";
        for (let c = 0; c < block.cycles.length; c++) {
          const cycPts = block.cycles[c].points;
          if (!cycPts.length) continue;
          const res = emitGroup(cycPts, blockInterp, started);
          if (!started) firstX = res.firstX;
          lastX = res.lastX;
          started = true;
          d += res.d;
        }
      }
    }
    flushBPs();
    return { lineD: d, firstX, lastX };
  }
  const { lineD, firstX, lastX } = buildEnvelopeD();
  const baseY = (PAD_T + innerH).toFixed(2);
  const fillD = lineD && exp.points.length >= 2 ?
    `${lineD} L ${lastX.toFixed(2)} ${baseY} L ${firstX.toFixed(2)} ${baseY} Z` :
    "";

  /* ============ value at playhead ============ */
  function valueAtTime(t) {
    if (!exp.points.length) return null;
    const x = (t - stream.onset) / Math.max(1e-9, stream.duration);
    if (x <= exp.points[0][0]) return exp.points[0][1];
    if (x >= exp.points[exp.points.length - 1][0]) return exp.points[exp.points.length - 1][1];
    for (let i = 0; i < exp.points.length - 1; i++) {
      const a = exp.points[i],b = exp.points[i + 1];
      if (x >= a[0] && x <= b[0]) {
        const u = (x - a[0]) / (b[0] - a[0] || 1);
        return a[1] + u * (b[1] - a[1]);
      }
    }
    return exp.points[0][1];
  }
  const inStream = playhead != null && playhead >= stream.onset && playhead <= stream.onset + stream.duration;
  const liveVal = inStream ? valueAtTime(playhead) : null;
  const playheadX = inStream ? xOf((playhead - stream.onset) / Math.max(1e-9, stream.duration)) : null;

  /* ============ stable indexes ============ */
  // flat indexes of standard breakpoints (for drag/dbl-click)
  const bpIndices = rawEnv.map((it, i) => PGEEnv.isBreakpoint(it) ? i : -1).filter((i) => i >= 0);

  const hasLoop = exp.blocks.length > 0;

  return (
    <div className="pge-envedit" data-screen-label="04 Envelope Editor">
      {/* ============ TOP HEADER ============ */}
      <header className="ee-head">
        <Icon name="sliders" size={12} />
        <span className="ee-title">Envelopes</span>
        <span className="ee-streamtag" style={{ borderColor: stream.color, color: stream.color }}>{stream.id}</span>
        <span className="ee-sub mono">{stream.sample}</span>
        <span className="ee-time-mode mono">normalized · x ∈ [0,1]{isNormalized ? "" : " · maps to clip onset → end"}</span>
        <span style={{ flex: 1 }} />
        {!hasLoop ?
        <label className="ee-loop-fld" title="global interpolation for this envelope's breakpoints">
            <span className="ee-loop-lbl">interp</span>
            <select className="ee-loop-select mono" value={globalInterp}
              onChange={(e) => commitWithInterp(rawEnv, e.target.value)}>
              {INTERP_TYPES.map((o) => <option key={o.val} value={o.val}>{o.label}</option>)}
            </select>
          </label> :
        null}
        {hasLoop ?
        <span className="ee-loop-count mono" title="loop blocks in this envelope">
            <span className="ee-loop-sym">↻</span> {exp.blocks.length} loop{exp.blocks.length > 1 ? "s" : ""} · {exp.cycles.length} cyc
          </span> :
        null}
        <button className="ee-add-loop" onClick={addLoop} title="add a loop block (compact format)">
          <span className="ee-loop-sym">↻</span> add loop
        </button>
        {liveVal != null ?
        <span className="ee-live">
            <span className="ee-live-dot" />
            <span className="mono" style={{ color: "var(--accent)" }}>{fmtY(liveVal, env)}{env.unit}</span>
            <span className="mono" style={{ color: "var(--fg-3)" }}>@ {playhead.toFixed(2)}s</span>
          </span> :
        null}
        <span className="ee-hint mono">dbl-click ▸ add bp · in a loop ▸ add pattern pt · drag ▸ move · drag zone bar ▸ riordina blocchi · click ▸ select · ⌫ ▸ delete · ⌘Z ▸ undo</span>
      </header>

      {/* ============ optional: selected loop control panel ============ */}
      {selectedBlockObj ?
      <LoopBlockPanel block={selectedBlockObj} color={stream.color}
      onUpdate={(newRaw) => updateBlock(selectedBlock, newRaw)}
      onDelete={deleteSelectedLoop} /> :
      null}

      {/* ============ ROW: side column + canvas ============ */}
      <div className="ee-row">
        <div className="ee-side" style={{ width: headW }}>
          <div className="ee-side-head">
            <EnvParamSelect envelopes={envelopes} value={env.key} onChange={setSelectedKey} compact />
          </div>
          <div className="ee-side-yaxis">
            {yTicks.map((yt) =>
            <div key={yt.v.toFixed(6)} className="ee-side-ylbl mono" style={{ top: yt.y }}>
                {fmtY(yt.v, env)}
              </div>
            )}
          </div>
        </div>

        <div className="ee-body" ref={bodyRef}>
          <div className="ee-canvas" style={{ height: "100%" }}>
            <svg ref={svgRef} className="ee-layer" width="100%" height={H}
            onDoubleClick={onCanvasDblClick}
            onClick={(e) => {if (e.target === e.currentTarget) {setSelectedBlock(null);setSelectedBP(null);setSelectedPattern(null);}}}>

              {/* vertical x grid */}
              <g className="ee-grid">
                {ticks.map((t) =>
                <line key={"v" + t.s} x1={t.x} x2={t.x} y1={PAD_T - 4} y2={H} className={t.major ? "v major" : "v"} />
                )}
                {yTicks.map((yt) =>
                <line key={"h" + yt.v.toFixed(6)} x1={0} x2={totalW} y1={yt.y} y2={yt.y} className="h" />
                )}
              </g>

              {/* envelope domain frame */}
              <line x1={streamX0} x2={streamX0} y1={PAD_T} y2={PAD_T + innerH}
              stroke={stream.color} strokeWidth="1" strokeDasharray="2,3" opacity="0.55" />
              <line x1={streamX1} x2={streamX1} y1={PAD_T} y2={PAD_T + innerH}
              stroke={stream.color} strokeWidth="1" strokeDasharray="2,3" opacity="0.55" />

              {/* ============ LOOP BAND ============ */}
              <g className="ee-loop-band">
                {/* band base */}
                <rect x={PAD_L} y={8} width={innerW} height={LOOP_BAND_H}
                className="ee-loop-band-bg" />
                {/* per-block region */}
                {exp.blocks.map((b) => {
                  const x0 = xOf(b.start);
                  const x1 = xOf(b.end);
                  const sel = selectedBlock === b.originalIdx;
                  const hov = hoverBlock === b.originalIdx;
                  return (
                    <g key={"b" + b.originalIdx}>
                      <rect x={x0} y={8} width={x1 - x0} height={LOOP_BAND_H}
                      className={"ee-loop-region" + (sel ? " sel" : "") + (hov ? " hov" : "")}
                      onMouseEnter={() => setHoverBlock(b.originalIdx)}
                      onMouseLeave={() => setHoverBlock(null)}
                      onClick={(e) => {e.stopPropagation();setSelectedBlock(b.originalIdx);setSelectedBP(null);setSelectedPattern(null);}} />
                      {/* cycle dividers */}
                      {b.cycles.slice(1).map((c, ci) =>
                      <line key={"d" + ci} x1={xOf(c.start)} x2={xOf(c.start)}
                      y1={8} y2={H - PAD_B - 2}
                      className="ee-cycle-divider"
                      strokeDasharray="2,2" />
                      )}
                      {/* badge text */}
                      <text x={x0 + 6} y={8 + LOOP_BAND_H / 2 + 3}
                      className="ee-loop-badge mono" pointerEvents="none">
                        ↻ ×{b.nReps} · {b.interp} · {distType(b.dist)}
                      </text>
                      {/* end-time drag handle */}
                      <rect x={x1 - 3} y={8} width={6} height={LOOP_BAND_H}
                      className="ee-loop-end-handle"
                      onPointerDown={(e) => startLoopEndDrag(e, b.originalIdx)} />
                    </g>);

                })}
              </g>

              {/* ============ MACRO ZONES BAR ============
                   Each contiguous run of standalone BPs, each loop block, and
                   any trailing empty space, is shown as a colored band. Drag
                   the handle between two adjacent zones to rescale them
                   horizontally — items inside are remapped proportionally. */}
              <g className="ee-zone-bar">
                <rect x={PAD_L} y={8 + LOOP_BAND_H + 2} width={innerW} height={12}
                  className="ee-zone-bar-bg" />
                {macroZones.map((z, zi) => {
                  const x0 = xOf(z.start);
                  const x1 = xOf(z.end);
                  if (x1 - x0 < 0.5) return null;
                  const w = x1 - x0;
                  const isZoneReorder = dragging && dragging.kind === "zone-reorder";
                  const isFrom = isZoneReorder && dragging.fromIdx === zi;
                  const isTo = isZoneReorder && dragging.toIdx === zi && dragging.toIdx !== dragging.fromIdx;
                  const cls = "ee-zone ee-zone-" + z.kind +
                    (isFrom ? " ee-zone-drag-from" : "") +
                    (isTo ? " ee-zone-drag-to" : "");
                  const label =
                    z.kind === "bps" ? (z.indices.length + " bp" + (z.indices.length > 1 ? "s" : "")) :
                    z.kind === "loop" ? "↻ loop" :
                    "free";
                  const showLabel = w >= 38;
                  return (
                    <g key={"z" + zi}>
                      <rect x={x0} y={8 + LOOP_BAND_H + 2} width={w} height={12}
                        className={cls}
                        style={z.kind !== "empty" ? { cursor: isFrom ? "grabbing" : "grab" } : {}}
                        onPointerDown={z.kind !== "empty" ? (ev) => startZoneDrag(ev, zi) : undefined} />
                      {showLabel ?
                      <text x={x0 + w / 2} y={8 + LOOP_BAND_H + 2 + 8}
                        textAnchor="middle" className="ee-zone-label mono"
                        pointerEvents="none">{label}</text> :
                      null}
                    </g>);
                })}
                {/* drag handles between adjacent zones (skip after last) */}
                {macroZones.slice(0, -1).map((z, zi) => {
                  const next = macroZones[zi + 1];
                  const x = xOf(z.end);
                  const y = 8 + LOOP_BAND_H + 2;
                  return (
                    <g key={"zh" + zi}>
                      <line x1={x} x2={x} y1={y} y2={y + 12}
                        className="ee-zone-handle-line"
                        pointerEvents="none" />
                      <rect x={x - 4} y={y - 1} width={8} height={14}
                        className="ee-zone-handle"
                        onPointerDown={(ev) => startZoneBoundaryDrag(ev, z, next)} />
                    </g>);
                })}
                {/* live boundary line while dragging — extends down across the curve */}
                {dragging && dragging.kind === "zone-boundary" ?
                <line x1={xOf(dragging.at)} x2={xOf(dragging.at)}
                  y1={8 + LOOP_BAND_H + 2} y2={H - PAD_B}
                  className="ee-zone-drag-guide" pointerEvents="none" /> :
                null}
              </g>

              {/* ============ CURVE ============ */}
              {fillD ? <path className="ee-fill" d={fillD} /> : null}
              {lineD ? <path className="ee-line" d={lineD} /> : null}

              {/* ============ EXPANDED PATTERN POINTS (loops) ============ */}
              {exp.blocks.map((b) =>
              <g key={"pp" + b.originalIdx}>
                  {/* Pattern points render only on the FIRST cycle.
                      Subsequent cycles are visual replicas of the same pattern;
                      drawing ghost dots on them clutters the boundary between
                      cycles (especially when pattern[0].y ≠ pattern[last].y,
                      where a real discontinuity makes the ghost overlap with
                      the previous cycle's last dot in confusing ways).
                      The curve path already shows each cycle's full shape. */}
                  {b.cycles[0].points.map((p, pi) => {
                  const isSelected = selectedPattern != null && selectedPattern.blockIdx === b.originalIdx && selectedPattern.patIdx === pi;
                  const cx = xOf(p[0]),cy = yOf(p[1]);
                  const r = isSelected ? 4 : 2.5;
                  const cls = "ee-pat-pt first" + (isSelected ? " sel" : "");
                  return (
                    <g key={"0-" + pi}>
                          <circle className="ee-pat-handle" cx={cx} cy={cy} r="9" fill="transparent"
                      data-block={b.originalIdx} data-pat={pi}
                      onPointerDown={(e) => startPatternDrag(e, b.originalIdx, pi)}
                      style={{ cursor: "grab" }} />
                          <circle className={cls} cx={cx} cy={cy} r={r} pointerEvents="none" />
                        </g>);

                })}
                </g>
              )}

              {/* ============ STANDARD BREAKPOINTS ============ */}
              {bpIndices.map((origIdx) => {
                const p = rawEnv[origIdx];
                return (
                  <g key={"bp" + origIdx}>
                    <circle cx={xOf(p[0])} cy={yOf(p[1])} r="9"
                    fill="transparent"
                    onPointerDown={(e) => startBPDrag(e, origIdx)}
                    onMouseEnter={() => setHoverBP(origIdx)}
                    onMouseLeave={() => setHoverBP(null)}
                    style={{ cursor: "grab" }} />
                    <circle className={"ee-bp" + (
                    dragging && dragging.kind === "bp" && dragging.idx === origIdx ? " on" : "") + (
                    selectedBP === origIdx ? " sel" : "") + (
                    hoverBP === origIdx ? " hov" : "")}
                    data-idx={origIdx}
                    cx={xOf(p[0])} cy={yOf(p[1])} r="4"
                    pointerEvents="none" />
                  </g>);

              })}

              {/* clip endpoint labels */}
              <text x={streamX0 + 4} y={H - 4} fontFamily="JetBrains Mono" fontSize="9" fill={stream.color}>0 · {stream.onset.toFixed(2)}s</text>
              <text x={streamX1 - 4} y={H - 4} textAnchor="end" fontFamily="JetBrains Mono" fontSize="9" fill={stream.color}>1 · {(stream.onset + stream.duration).toFixed(2)}s</text>

              {/* x tick labels */}
              {ticks.filter((t) => t.major && t.s !== 0 && t.s !== 1).map((t) =>
              <text key={"tl" + t.s} x={t.x + 3} y={H - 4} fontFamily="JetBrains Mono" fontSize="9" fill="#404652">{fmtTimeTick(t.s)}</text>
              )}

              {/* playhead */}
              {playheadX != null ?
              <line x1={playheadX} x2={playheadX} y1={PAD_T} y2={H}
              stroke="#FF8C42" strokeWidth="1" opacity="0.55" pointerEvents="none" /> :
              null}
              {liveVal != null && playheadX != null ?
              <circle cx={playheadX} cy={yOf(liveVal)} r="3"
              fill="#FF8C42" stroke="#0E0F11" strokeWidth="1" pointerEvents="none" /> :
              null}
            </svg>

            {/* BP tooltip — hover only */}
            {hoverBP != null && rawEnv[hoverBP] && PGEEnv.isBreakpoint(rawEnv[hoverBP]) && dragging == null ? (() => {
              const p = rawEnv[hoverBP];
              return (
                <div className="ee-bp-tip" style={{ left: xOf(p[0]), top: yOf(p[1]) }}>
                  <span className="mono" style={{ color: "var(--accent)" }}>{fmtY(p[1], env)}{env.unit}</span>
                  <span className="mono" style={{ color: "var(--fg-3)" }}> · x={p[0].toFixed(3)}</span>
                  <span className="mono" style={{ color: "var(--fg-4)" }}> · {(stream.onset + p[0] * stream.duration).toFixed(2)}s</span>
                </div>);

            })() : null}

            {/* Drag readout — fixed bottom-left of canvas, while dragging */}
            {(() => {
              if (!dragging) return null;
              let val = null, xNorm = null, label = "";
              if (dragging.kind === "bp" && rawEnv[dragging.idx] && PGEEnv.isBreakpoint(rawEnv[dragging.idx])) {
                const p = rawEnv[dragging.idx];
                val = p[1]; xNorm = p[0]; label = "bp";
              } else if (dragging.kind === "pat") {
                const block = blockByOrig.get(dragging.blockOrigIdx);
                if (block) {
                  const pt = block.pattern[dragging.patIdx];
                  val = pt[1]; xNorm = pt[0] / 100; label = `pattern ${dragging.patIdx + 1}/${block.pattern.length}`;
                }
              } else if (dragging.kind === "end") {
                const block = blockByOrig.get(dragging.blockOrigIdx);
                if (block) {
                  xNorm = block.end;
                  label = "loop end";
                }
              }
              if (val == null && xNorm == null) return null;
              return (
                <div className="ee-drag-readout">
                  {val != null ?
                    <span className="mono" style={{ color: "var(--accent)" }}>{fmtY(val, env)}{env.unit}</span> :
                    null}
                  {xNorm != null ?
                    <span className="mono" style={{ color: "var(--fg-3)" }}> · x={xNorm.toFixed(3)}</span> :
                    null}
                  {xNorm != null ?
                    <span className="mono" style={{ color: "var(--fg-4)" }}> · {(stream.onset + xNorm * stream.duration).toFixed(2)}s</span> :
                    null}
                  <span className="mono ee-drag-readout-label">{label}</span>
                </div>);
            })()}
          </div>
        </div>
      </div>
    </div>);

}

window.PGE = window.PGE || {};
window.PGE.EnvelopeEditor = EnvelopeEditor;