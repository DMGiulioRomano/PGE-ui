/* @jsx React.createElement */
/* Stereoscope — real-time goniometer / Lissajous widget.
 *
 * Embedded at the bottom of the sample-browser sidebar (not a fixed overlay).
 * Shows an XY scatter plot of L vs R audio rotated 45° (classic goniometer)
 * with phosphor trail and a phase correlation meter.
 *
 * Reads from window.PGEAudio.engine.analysers (lazy — null until first play).
 * DISPLAY_GAIN amplifies weak signals so the shape is visible even at low levels.
 * Exposed as window.PGE.Stereoscope. */

const { useRef: useRefSC, useEffect: useEffectSC, useState: useStateSC } = React;

const SCOPE_MIN_H = 80;
const SCOPE_MAX_FRACTION = 0.55;
const INV_SQRT2 = 1 / Math.sqrt(2);
const DISPLAY_GAIN = 4.0;   // amplify weak signals before plotting
const CORR_BAR_H = 20;

function Stereoscope({ open, height = 180, onHeightChange, onClose }) {
  const { Icon } = window.PGE;
  const canvasRef = useRefSC(null);
  const rafRef = useRefSC(null);
  const dragRef = useRefSC({ active: false, startY: 0, startH: 0 });
  const [resizing, setResizing] = useStateSC(false);

  // RAF draw loop — active while panel is open
  useEffectSC(() => {
    if (!open) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    function draw() {
      rafRef.current = requestAnimationFrame(draw);
      const analysers = window.PGEAudio?.engine?.analysers;
      const w = canvas.width;
      const h = canvas.height;
      const scopeH = h - CORR_BAR_H;

      if (!analysers) {
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#2a2a2a";
        ctx.font = "10px monospace";
        ctx.textAlign = "center";
        ctx.fillText("play to activate", w / 2, scopeH / 2 + 4);
        return;
      }

      const bufLen = analysers.left.frequencyBinCount;
      const dataL = new Float32Array(bufLen);
      const dataR = new Float32Array(bufLen);
      analysers.left.getFloatTimeDomainData(dataL);
      analysers.right.getFloatTimeDomainData(dataR);

      // Phosphor trail
      ctx.fillStyle = "rgba(10,10,10,0.18)";
      ctx.fillRect(0, 0, w, scopeH);

      // Grid lines
      if (scopeH > 50) {
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, scopeH);
        ctx.moveTo(0, scopeH / 2); ctx.lineTo(w, scopeH / 2);
        ctx.moveTo(0, 0); ctx.lineTo(w, scopeH);
        ctx.moveTo(w, 0); ctx.lineTo(0, scopeH);
        ctx.stroke();
      }

      // Lissajous plot (rotated 45°) with gain amplification
      const cx = w / 2;
      const cy = scopeH / 2;
      const scale = Math.min(w, scopeH) * 0.44;
      ctx.fillStyle = "#00ff88";
      const step = Math.max(1, Math.floor(bufLen / 512));
      for (let i = 0; i < bufLen; i += step) {
        const l = Math.max(-1, Math.min(1, dataL[i] * DISPLAY_GAIN));
        const r = Math.max(-1, Math.min(1, dataR[i] * DISPLAY_GAIN));
        const px = cx + (l + r) * INV_SQRT2 * scale;
        const py = cy - (l - r) * INV_SQRT2 * scale;
        ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5);
      }

      // Correlation (on raw data, not amplified)
      let sumLR = 0, sumL2 = 0, sumR2 = 0;
      for (let i = 0; i < bufLen; i++) {
        sumLR += dataL[i] * dataR[i];
        sumL2 += dataL[i] * dataL[i];
        sumR2 += dataR[i] * dataR[i];
      }
      const corr = (sumL2 > 1e-10 && sumR2 > 1e-10)
        ? Math.max(-1, Math.min(1, sumLR / Math.sqrt(sumL2 * sumR2)))
        : 0;

      _drawCorrBar(ctx, w, h, scopeH, corr);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [open]);

  // Sync canvas pixel dimensions with CSS size
  useEffectSC(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      const nw = Math.round(rect.width);
      const nh = Math.round(rect.height);
      if (canvas.width !== nw || canvas.height !== nh) {
        canvas.width = nw;
        canvas.height = nh;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, nw, nh);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [open]);

  // Resize handle
  function clampH(h) {
    const max = Math.max(SCOPE_MIN_H + 40, Math.round(window.innerHeight * SCOPE_MAX_FRACTION));
    return Math.max(SCOPE_MIN_H, Math.min(max, Math.round(h)));
  }
  function onResizeDown(e) {
    e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dragRef.current = { active: true, startY: y, startH: height };
    setResizing(true);
    document.body.classList.add("pge-resizing-scope");
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
    document.body.classList.remove("pge-resizing-scope");
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
  useEffectSC(() => () => {
    document.body.classList.remove("pge-resizing-scope");
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeUp);
    window.removeEventListener("touchmove", onResizeMove);
    window.removeEventListener("touchend", onResizeUp);
  }, []);

  if (!open) return null;
  return (
    <div className={"pge-scope" + (resizing ? " is-resizing" : "")}
         style={{ height: height + "px" }}
         role="region"
         aria-label="stereoscope">
      <div className="sc-resize"
           role="separator"
           aria-orientation="horizontal"
           aria-label="resize stereoscope"
           tabIndex={0}
           onMouseDown={onResizeDown}
           onTouchStart={onResizeDown}
           onDoubleClick={() => onHeightChange && onHeightChange(180)}
           onKeyDown={onResizeKey}
           title="drag to resize · double-click to reset" />
      <div className="sc-head">
        <span className="sc-title mono">scope</span>
        <span style={{ flex: 1 }} />
        <button className="sc-btn" onClick={onClose} title="hide stereoscope (v)">
          <Icon name="x" size={11} />
        </button>
      </div>
      <canvas ref={canvasRef} className="sc-canvas" />
    </div>
  );
}

function _drawCorrBar(ctx, w, h, scopeH, corr) {
  const barY = scopeH;
  const barH = CORR_BAR_H;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, barY, w, barH);
  ctx.fillStyle = "#252525";
  ctx.fillRect(w / 2 - 0.5, barY + 2, 1, barH - 4);
  const color = corr > 0.5 ? "#3DB87A" : corr > 0 ? "#F5A623" : "#E5484D";
  const cx = w / 2;
  const barW = Math.abs(corr) * (cx - 4);
  ctx.fillStyle = color;
  ctx.fillRect(corr >= 0 ? cx : cx - barW, barY + 4, barW, barH - 8);
  ctx.fillStyle = "#444";
  ctx.font = "9px monospace";
  ctx.textAlign = "left";  ctx.fillText("-1", 4, barY + barH - 4);
  ctx.textAlign = "right"; ctx.fillText("+1", w - 4, barY + barH - 4);
  ctx.textAlign = "center"; ctx.fillStyle = "#555";
  ctx.fillText(corr.toFixed(2), cx, barY + barH - 4);
}

window.PGE.Stereoscope = Stereoscope;
