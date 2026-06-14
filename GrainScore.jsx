/* @jsx React.createElement */
/* GrainScore — full-width "graphic score" panel, the timeline-wide companion to
 * the per-clip grain canvas. Mirrors the engine's ScoreVisualizer PDF:
 *   X = absolute time (stream.onset + grain.t), whole composition fit to width
 *   Y = pointer position, normalized per stream inside its lane (max on top)
 *   color = pitch (turbo, autozoom in cents)   alpha = volume (dB → 0.3..1.0)
 * One lane per stream, stacked vertically. All grains are painted in immediate
 * mode on a single <canvas> (no DOM per grain); the playhead is a positioned
 * div so moving it never repaints the grains. Shared math: window.PGEGrainMap.
 * Panel chrome (resize handle, header, close) mirrors Stereoscope.jsx.
 * Exposed as window.PGE.GrainScore. */

const { useRef: useRefGS, useEffect: useEffectGS, useState: useStateGS } = React;

const GS_MIN_H = 90;
const GS_MAX_FRACTION = 0.6;
const GS_LANE_MIN_H = 14;
const GS_GRAIN_H = 2;

function GrainScore({ open, height = 260, onHeightChange, onClose, streams, grainData, duration, playhead, pxPerSec }) {
  const { Icon } = window.PGE;
  const canvasRef = useRefGS(null);
  const wrapRef = useRefGS(null);
  const dragRef = useRefGS({ active: false, startY: 0, startH: 0 });
  const [resizing, setResizing] = useStateGS(false);
  const [dims, setDims] = useStateGS({ w: 0, h: 0 });

  // Keep canvas backing store in sync with its CSS box (DPR-aware).
  useEffectGS(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width), h = Math.round(rect.height);
      setDims(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [open]);

  // Paint all grains. Keyed on data + dims only (NOT playhead → no repaint while
  // playing; the playhead is a separate positioned element).
  useEffectGS(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    const GM = window.PGEGrainMap;
    if (!canvas || !GM) return;
    const W = dims.w, H = dims.h;
    if (W < 2 || H < 2) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const list = (streams || []).filter(s => grainData && grainData[s.id] && (grainData[s.id].grains || []).length);
    const total = duration && duration > 0 ? duration : 1;
    const ppsFit = W / total;                     // fit whole composition to width
    const lanes = (streams || []).length || 1;
    const laneH = Math.max(GS_LANE_MIN_H, H / lanes);

    // Lane separators + labels for every stream (even those without grains).
    ctx.font = "9px ui-monospace, monospace";
    ctx.textBaseline = "top";
    (streams || []).forEach((s, i) => {
      const y = i * laneH;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillText(s.id, 4, y + 2);
    });

    // Grains, per lane.
    list.forEach((s) => {
      const idx = (streams || []).indexOf(s);
      const laneY = idx * laneH;
      const gd = grainData[s.id];
      const grains = gd.grains || [];
      const ptr = GM.pointerExtent(grains);
      const pit = GM.pitchExtentCents(grains);
      const gctx = {
        pxPerSec: ppsFit, height: laneH,
        ptrMin: ptr.min, ptrMax: ptr.max,
        pitchLoCents: pit.lo, pitchHiCents: pit.hi,
        grainHeight: GS_GRAIN_H,
      };
      const onsetX = (s.onset || 0) * ppsFit;
      for (let k = 0; k < grains.length; k++) {
        const r = GM.grainRect(grains[k], gctx);
        const x = r.x + onsetX;
        if (x > W || x + r.w < 0) continue;       // horizontal culling
        ctx.fillStyle = r.fill;
        ctx.fillRect(x, r.y + laneY, r.w, r.h);
      }
    });

    if (!list.length) {
      ctx.fillStyle = "rgba(255,255,255,0.30)";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("render with grains to populate the score", W / 2, H / 2 - 6);
      ctx.textAlign = "left";
    }
  }, [open, streams, grainData, dims, duration]);

  // ----- resize handle (mirrors Stereoscope) -----
  function clampH(h) {
    const max = Math.max(GS_MIN_H + 40, Math.round(window.innerHeight * GS_MAX_FRACTION));
    return Math.max(GS_MIN_H, Math.min(max, Math.round(h)));
  }
  function onResizeDown(e) {
    e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dragRef.current = { active: true, startY: y, startH: height };
    setResizing(true);
    document.body.classList.add("pge-resizing-grainscore");
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", onResizeUp);
    window.addEventListener("touchmove", onResizeMove, { passive: false });
    window.addEventListener("touchend", onResizeUp);
  }
  function onResizeMove(e) {
    if (!dragRef.current.active) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = y - dragRef.current.startY;
    onHeightChange && onHeightChange(clampH(dragRef.current.startH - dy));
  }
  function onResizeUp() {
    dragRef.current.active = false;
    setResizing(false);
    document.body.classList.remove("pge-resizing-grainscore");
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeUp);
    window.removeEventListener("touchmove", onResizeMove);
    window.removeEventListener("touchend", onResizeUp);
  }
  function onResizeKey(e) {
    if (!onHeightChange) return;
    const step = e.shiftKey ? 40 : 12;
    if (e.key === "ArrowUp")   { e.preventDefault(); onHeightChange(clampH(height + step)); }
    if (e.key === "ArrowDown") { e.preventDefault(); onHeightChange(clampH(height - step)); }
  }
  useEffectGS(() => () => {
    document.body.classList.remove("pge-resizing-grainscore");
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeUp);
    window.removeEventListener("touchmove", onResizeMove);
    window.removeEventListener("touchend", onResizeUp);
  }, []);

  if (!open) return null;
  const total = duration && duration > 0 ? duration : 1;
  const playX = dims.w ? Math.max(0, Math.min(dims.w, (playhead / total) * dims.w)) : 0;
  return (
    <div className={"pge-grainscore" + (resizing ? " is-resizing" : "")}
         style={{ height: height + "px" }}
         role="region"
         aria-label="grain score">
      <div className="gs-resize"
           role="separator"
           aria-orientation="horizontal"
           aria-label="resize grain score"
           tabIndex={0}
           onMouseDown={onResizeDown}
           onTouchStart={onResizeDown}
           onDoubleClick={() => onHeightChange && onHeightChange(260)}
           onKeyDown={onResizeKey}
           title="drag to resize · double-click to reset" />
      <div className="gs-head">
        <span className="gs-title mono">grain score</span>
        <span style={{ flex: 1 }} />
        <button className="gs-btn" onClick={onClose} title="hide grain score (g)">
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="gs-body" ref={wrapRef}>
        <canvas ref={canvasRef} className="gs-canvas" />
        <div className="gs-playhead" style={{ left: playX + "px" }} />
      </div>
    </div>
  );
}

window.PGE.GrainScore = GrainScore;
