/* @jsx React.createElement */
const { useState: useStateTL, useRef: useRefTL, useEffect: useEffTL } = React;

/* ---------- ClipRenderStatus ---------- */
/* tiny status pill sitting in the bottom-left of a clip.
 * states:
 *   fresh   — last rendered fingerprint matches current yaml
 *   stale   — rendered but yaml has changed since
 *   never   — never rendered (no stem on disk)
 *   running — currently being rendered
 */
function ClipRenderStatus({ status }) {
  // fresh & up-to-date shows no marker — only never/stale/running/error surface.
  if (!status || status.state === "hidden" || status.state === "fresh") return null;
  const tip = status.tooltip || {
    stale:   "stale — yaml changed since last render",
    never:   "never rendered",
    running: "rendering…",
    error:   "error",
  }[status.state] || status.state;
  const isWarn = status.state === "stale" || status.state === "error";
  return (
    <div className={"clip-render-status s-" + status.state} title={tip}>
      {isWarn ? <span className="crs-mark">⚠</span> : <span className="crs-dot" />}
      {typeof status.progress === "number" && status.state === "running" ? (
        <span className="crs-bar"><span className="crs-bar-fill" style={{ width: (status.progress * 100).toFixed(0) + "%" }} /></span>
      ) : null}
    </div>
  );
}

/* ---------- ClipWaveform ---------- */
/* Draws the real waveform of a stream's rendered stem onto a <canvas>.
 * `peaks` is a Float32Array (0..1) from the audio engine; we downsample it to
 * the clip's pixel width so detail follows timeline zoom. Canvas (not SVG) so
 * the repaint on every zoom step stays cheap. Renders nothing when peaks are
 * missing (e.g. a never-rendered stream). */
function ClipWaveform({ peaks, width, height, color }) {
  const canvasRef = useRefTL(null);
  useEffTL(() => {
    const cvs = canvasRef.current;
    if (!cvs || !peaks || width < 2 || height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.floor(width));
    const H = Math.max(1, Math.floor(height));
    cvs.width = Math.floor(W * dpr);
    cvs.height = Math.floor(H * dpr);
    const ctx = cvs.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.55)";
    const mid = H / 2;
    const half = H / 2;
    const n = peaks.length;
    // Per-pixel peak: take the MAX of every bucket this column spans, so
    // transients aren't dropped when n >> W (the usual case at normal zoom).
    // Computed once, reused for both mirrored edges.
    const cols = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let k0 = Math.floor((x / W) * n);
      let k1 = Math.floor(((x + 1) / W) * n);
      if (k1 <= k0) k1 = k0 + 1;          // zoomed in (W > n) → 1 bucket/pixel
      if (k1 > n) k1 = n;
      let p = 0;
      for (let k = k0; k < k1; k++) if (peaks[k] > p) p = peaks[k];
      cols[x] = p;
    }
    ctx.beginPath();
    // top edge left→right, then bottom edge right→left, mirrored about mid.
    for (let x = 0; x < W; x++) {
      const y = mid - cols[x] * half;
      x === 0 ? ctx.moveTo(0, y) : ctx.lineTo(x, y);
    }
    for (let x = W - 1; x >= 0; x--) {
      ctx.lineTo(x, mid + cols[x] * half);
    }
    ctx.closePath();
    ctx.fill();
  }, [peaks, width, height]);
  return <canvas className="wave" ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
}

/* ---------- ClipSpectrogram ---------- */
/* magma-ish perceptual ramp: uint8 magnitude → [r,g,b]. Mirrors _specColor in
 * MediaPreview.jsx (kept local to avoid a parse-time cross-file dependency). */
function _specColorTL(v) {
  const t = v / 255;
  const stops = [
    [0.0, [0, 0, 4]],
    [0.25, [40, 11, 84]],
    [0.5, [139, 36, 109]],
    [0.75, [222, 73, 64]],
    [0.9, [251, 159, 58]],
    [1.0, [252, 253, 191]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (t - t0) / (t1 - t0 || 1);
      return [
        (c0[0] + (c1[0] - c0[0]) * f) | 0,
        (c0[1] + (c1[1] - c0[1]) * f) | 0,
        (c0[2] + (c1[2] - c0[2]) * f) | 0,
      ];
    }
  }
  return [252, 253, 191];
}

/* Draws a stream's stem spectrogram (server-computed STFT) onto a <canvas>.
 * `buf` is the raw ArrayBuffer: 8-byte header (uint32 width, uint32 height)
 * then width*height uint8 magnitudes (column-major, low freq first). Painted at
 * native resolution offscreen, then scaled onto the clip-sized canvas. Same
 * binary protocol + draw as MediaPreview's _drawSpec. */
function ClipSpectrogram({ buf, width, height }) {
  const canvasRef = useRefTL(null);
  useEffTL(() => {
    const cvs = canvasRef.current;
    if (!cvs || !buf || width < 2 || height < 2) return;
    const view = new DataView(buf);
    const cols = view.getUint32(0, true);
    const bins = view.getUint32(4, true);
    if (!cols || !bins) return;
    const grid = new Uint8Array(buf, 8, cols * bins);
    // Native-resolution offscreen, then scale onto the visible canvas.
    const off = document.createElement("canvas");
    off.width = cols; off.height = bins;
    const octx = off.getContext("2d");
    const img = octx.createImageData(cols, bins);
    for (let c = 0; c < cols; c++) {
      for (let f = 0; f < bins; f++) {
        const v = grid[c * bins + f];
        const [r, g, b] = _specColorTL(v);
        const y = bins - 1 - f;            // low freq at bottom
        const p = (y * cols + c) * 4;
        img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.floor(width));
    const H = Math.max(1, Math.floor(height));
    cvs.width = Math.floor(W * dpr);
    cvs.height = Math.floor(H * dpr);
    const ctx = cvs.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(off, 0, 0, cols, bins, 0, 0, W, H);
  }, [buf, width, height]);
  return <canvas className="wave spec" ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
}

function gestureMatches(rule, e) {
  // rule examples: "wheel", "shift+wheel", "alt+wheel", "cmd+wheel", "ctrl+wheel"
  if (!rule) return false;
  const wantShift = /shift/i.test(rule);
  const wantAlt = /alt/i.test(rule);
  const wantCmd = /cmd|meta/i.test(rule);
  const wantCtrl = /ctrl/i.test(rule) && !/cmd/i.test(rule);
  return !!e.shiftKey === wantShift &&
  !!e.altKey === wantAlt &&
  !!e.metaKey === wantCmd &&
  !!e.ctrlKey === wantCtrl;
}

function Timeline({ streams, selected, onSelect, onDeselect, onRangeSelect, onMarqueeSelect,
  onDoubleSelect, onUpdate, onReorder, playhead, duration, onCreateStream,
  pxPerSec, showWaveforms, showSpectrograms, showClipLabels, laneHeight, gestures, onZoom, onLaneHeight,
  renderStatusFor, waveformFor, spectrogramFor,
  loopEnabled, loopRegion, onLoopRegionChange }) {
  const { Icon, SplitPane } = window.PGE;
  const anySolo = streams.some(s => s.solo);
  const isEffMuted = (s) => s.mute || (anySolo && !s.solo);
  const PX_PER_S = pxPerSec || 36;
  const HEAD_W = 220;
  const ref = useRefTL(null);
  const headRef = useRefTL(null);
  const bodyRef = useRefTL(null);
  const [hoverX, setHoverX] = useStateTL(null);
  const [hint, setHint] = useStateTL(null);
  const [dragOver, setDragOver] = useStateTL(null);
  const [sampleDragOver, setSampleDragOver] = useStateTL(false);
  const [marquee, setMarquee] = useStateTL(null);
  const lanesAreaRef = useRefTL(null);
  const loopDragRef = useRefTL(null);
  const dragEnterCount = useRefTL(0);
  const zoomState = useRefTL({ pending: null, raf: null });
  const zoomAnchor = useRefTL({ active: false, t: 0, vx: 0, endTimer: null });
  const [zoomLock, setZoomLock] = useStateTL(false);
  // Latest values readable inside the wheel listener without re-binding it.
  const playheadRef = useRefTL(playhead); playheadRef.current = playhead;
  const zoomLockRef = useRefTL(zoomLock); zoomLockRef.current = zoomLock;

  // Re-anchor scrollLeft after each zoom-driven re-render, synchronously,
  // so the time under the cursor stays put across frames.
  React.useLayoutEffect(() => {
    if (zoomAnchor.current.active && bodyRef.current) {
      bodyRef.current.scrollLeft = zoomAnchor.current.t * PX_PER_S - zoomAnchor.current.vx;
    }
  }, [PX_PER_S]);
  const [laneHeights, setLaneHeights] = useStateTL(() => {
    try { return JSON.parse(localStorage.getItem("pge-lane-heights") || "{}"); } catch (e) { return {}; }
  });
  function getH(id) { return laneHeights[id] || laneHeight || 56; }
  function startReorder(e, srcIdx) {
    e.preventDefault(); e.stopPropagation();
    const headEl = headRef.current;
    if (!headEl) return;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    function move(ev) {
      // figure out which lane the cursor is over
      const heads = headEl.querySelectorAll(".track-head");
      let dst = srcIdx;
      for (let i = 0; i < heads.length; i++) {
        const r = heads[i].getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) { dst = i; break; }
        if (ev.clientY > r.bottom) dst = i + 1;
      }
      dst = Math.max(0, Math.min(streams.length - 1, dst));
      setDragOver(dst);
    }
    function up(ev) {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      setDragOver((dst) => {
        if (dst != null && dst !== srcIdx && onReorder) onReorder(srcIdx, dst);
        return null;
      });
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startResizeLane(e, id) {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const orig = getH(id);
    let moved = false;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    function move(ev) {
      if (Math.abs(ev.clientY - startY) > 2) moved = true;
      const next = Math.max(28, Math.min(240, orig + (ev.clientY - startY)));
      setLaneHeights(h => {
        const m = { ...h, [id]: next };
        localStorage.setItem("pge-lane-heights", JSON.stringify(m));
        return m;
      });
    }
    function up(ev) {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      if (moved) {
        // Suppress the click event that would otherwise bubble to track-head and open the inspector
        const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); window.removeEventListener("click", stop, true); };
        window.addEventListener("click", stop, true);
        setTimeout(() => window.removeEventListener("click", stop, true), 50);
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Visible viewport in seconds drives how far past `duration` we render so that
  // zooming out keeps the ruler + grid filling the viewport beyond composition end.
  const [viewportPx, setViewportPx] = useStateTL(1200);
  useEffTL(() => {
    const body = bodyRef.current;
    if (!body) return;
    const upd = () => setViewportPx(body.clientWidth || 1200);
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  const renderSec = Math.max(duration, Math.ceil(viewportPx / PX_PER_S) + 8);

  // Adaptive tick step: aim for ~30–40 px between minor ticks; major every 6 minors
  // so there are exactly 5 minor lines between two majors.
  const niceSteps = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
  const targetPx = 30;
  let step = niceSteps[niceSteps.length - 1];
  for (const s of niceSteps) { if (s * PX_PER_S >= targetPx) { step = s; break; } }
  const majorEvery = 6;

  const ticks = [];
  for (let i = 0; i * step <= renderSec + 1e-6; i++) {
    const s = +(i * step).toFixed(6);
    const major = i % majorEvery === 0;
    ticks.push({ s, major, x: s * PX_PER_S });
  }
  // Format label nicely
  function fmt(s) {
    if (step >= 60) {
      const m = Math.floor(s / 60), sec = Math.round(s - m * 60);
      return sec ? `${m}m${sec.toString().padStart(2,"0")}s` : `${m}m`;
    }
    if (step >= 1) return s.toFixed(0) + "s";
    if (step >= 0.1) return s.toFixed(1) + "s";
    return s.toFixed(2) + "s";
  }

  function onPointerDown(e, stream, mode) {
    e.preventDefault();e.stopPropagation();
    const startX = e.clientX;
    const isInSelection = selected.includes(stream.id);
    const targets = isInSelection ? streams.filter(s => selected.includes(s.id)) : [stream];
    const origs = Object.fromEntries(targets.map(s => [s.id, { onset: s.onset, duration: s.duration }]));
    let moved = false;
    const THRESHOLD = 4;
    function move(ev) {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < THRESHOLD) return;
      if (!moved) { window.PGEHistory && window.PGEHistory.beginGesture(); }
      moved = true;
      const dt = dx / PX_PER_S;
      for (const s of targets) {
        if (mode === "drag")   onUpdate(s.id, { onset:    Math.max(0,   +(origs[s.id].onset    + dt).toFixed(3)) });
        if (mode === "resize") onUpdate(s.id, { duration: Math.max(0.5, +(origs[s.id].duration + dt).toFixed(3)) });
      }
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved && window.PGEHistory) window.PGEHistory.endGesture();
      if (!moved) {
        if (e.shiftKey) onRangeSelect && onRangeSelect(stream.id);
        else onSelect(stream.id, e.ctrlKey || e.metaKey);
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onMarqueeStart(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const additive = e.ctrlKey || e.metaKey;
    const getCoords = (ev) => {
      const r = lanesAreaRef.current.getBoundingClientRect();
      return {
        x: ev.clientX - r.left + bodyRef.current.scrollLeft,
        y: ev.clientY - r.top + bodyRef.current.scrollTop,
      };
    };
    const { x: x0, y: y0 } = getCoords(e);
    setMarquee({ x0, y0, x1: x0, y1: y0 });
    function move(ev) {
      const { x, y } = getCoords(ev);
      setMarquee({ x0, y0, x1: x, y1: y });
    }
    function up(ev) {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const { x: x1, y: y1 } = getCoords(ev);
      const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
      const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
      if (maxX - minX > 4 || maxY - minY > 4) {
        let cumY = 0;
        const ids = [];
        for (const s of streams) {
          const h = getH(s.id);
          const laneTop = cumY, laneBot = cumY + h;
          cumY += h;
          if (laneBot <= minY || laneTop >= maxY) continue;
          const clipL = s.onset * PX_PER_S;
          const clipR = (s.onset + s.duration) * PX_PER_S;
          if (clipR <= minX || clipL >= maxX) continue;
          ids.push(s.id);
        }
        if (ids.length > 0) onMarqueeSelect && onMarqueeSelect(ids, additive);
        else onDeselect && onDeselect();
      } else {
        onDeselect && onDeselect();
      }
      setMarquee(null);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onLaneDrop(e, idx) {
    e.preventDefault();
    e.stopPropagation();
    const sample = e.dataTransfer.getData("text/sample");
    if (!sample) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + bodyRef.current.scrollLeft;
    // Always create a NEW track at this position, inserted after the lane dropped onto.
    onCreateStream && onCreateStream({ sample, onset: +(x / PX_PER_S).toFixed(2), laneIdx: idx + 1 });
  }

  function onEmptyDrop(e) {
    e.preventDefault();
    dragEnterCount.current = 0;
    setSampleDragOver(false);
    const sample = e.dataTransfer.getData("text/sample");
    if (!sample) return;
    const rect = bodyRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + bodyRef.current.scrollLeft;
    onCreateStream && onCreateStream({ sample, onset: +(x / PX_PER_S).toFixed(2) });
  }

  function onSampleDragEnter(e) {
    if (!e.dataTransfer.types.includes("text/sample")) return;
    dragEnterCount.current++;
    setSampleDragOver(true);
  }

  function onSampleDragLeave(e) {
    dragEnterCount.current--;
    if (dragEnterCount.current <= 0) { dragEnterCount.current = 0; setSampleDragOver(false); }
  }

  function onSampleDragOver(e) {
    if (!e.dataTransfer.types.includes("text/sample")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  // Lock track-heads to lanes via transform — body owns vertical scroll,
  // headRef inner is translated to match. No two-scrollbar drift possible.
  useEffTL(() => {
    const head = headRef.current;const body = bodyRef.current;
    if (!head || !body) return;
    function sync() { head.style.transform = `translateY(${-body.scrollTop}px)`; }
    sync();
    body.addEventListener("scroll", sync, { passive: true });
    // Forward wheel over the header column to the body's vertical scroll.
    const headArea = head.parentElement;
    function onHeadWheel(e) {
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();
      body.scrollTop += e.deltaY;
    }
    headArea && headArea.addEventListener("wheel", onHeadWheel, { passive: false });
    return () => {
      body.removeEventListener("scroll", sync);
      headArea && headArea.removeEventListener("wheel", onHeadWheel);
    };
  }, []);

  // Wheel handler — bound to bodyRef so we can preventDefault on zoom/laneHeight gestures.
  useEffTL(() => {
    const body = bodyRef.current;
    if (!body) return;
    const g = gestures || { zoom: "wheel", laneHeight: "shift+wheel", hScroll: "alt+wheel" };

    function showHint(text) {
      setHint(text);
      clearTimeout(showHint._t);
      showHint._t = setTimeout(() => setHint(null), 700);
    }

    function onWheel(e) {
      const dy = e.deltaY;
      const dx = e.deltaX;
      // Two-finger horizontal swipe → horizontal scroll, regardless of gesture rule
      if (Math.abs(dx) > Math.abs(dy) * 1.2) {
        e.preventDefault();
        body.scrollLeft += dx;
        return;
      }
      // Lane height
      if (gestureMatches(g.laneHeight, e)) {
        e.preventDefault();
        onLaneHeight && onLaneHeight(Math.max(36, Math.min(120, (laneHeight || 56) - Math.sign(dy) * 4)));
        showHint(`lane ${(laneHeight || 56) - Math.sign(dy) * 4}px`);
        return;
      }
      // Zoom (rAF-batched + layout-effect re-anchor for flicker-free zoom)
      if (gestureMatches(g.zoom, e)) {
        e.preventDefault();
        const rect = body.getBoundingClientRect();
        const cursorVX = e.clientX - rect.left;
        // Anchor: when zoom-lock is on, pin the playhead (yellow line) as the zoom
        // center; otherwise pin the time under the cursor RIGHT NOW.
        // Update on every event so the anchor tracks if user moves the cursor mid-zoom.
        zoomAnchor.current.active = true;
        if (zoomLockRef.current) {
          const ph = playheadRef.current;
          // Pull the playhead toward the viewport center as we zoom: lerp its
          // on-screen x from where it is now toward center. scrollLeft clamps
          // near edges, so it centers only as far as content allows.
          const curVX = ph * PX_PER_S - body.scrollLeft;
          const center = body.clientWidth / 2;
          zoomAnchor.current.t = ph;
          zoomAnchor.current.vx = curVX + (center - curVX) * 0.08;
        } else {
          zoomAnchor.current.t = (body.scrollLeft + cursorVX) / PX_PER_S;
          zoomAnchor.current.vx = cursorVX;
        }
        clearTimeout(zoomAnchor.current.endTimer);
        zoomAnchor.current.endTimer = setTimeout(() => { zoomAnchor.current.active = false; }, 250);
        // Accumulate factor across rapid wheel events into a single rAF commit.
        if (zoomState.current.pending == null) zoomState.current.pending = PX_PER_S;
        const factor = Math.exp(-dy * 0.0008);
        zoomState.current.pending = Math.max(0.5, Math.min(200, zoomState.current.pending * factor));
        if (!zoomState.current.raf) {
          zoomState.current.raf = requestAnimationFrame(() => {
            const next = +zoomState.current.pending.toFixed(2);
            zoomState.current.pending = null;
            zoomState.current.raf = null;
            onZoom && onZoom(next);
          });
        }
        showHint(`zoom ${zoomState.current.pending >= 10 ? Math.round(zoomState.current.pending) : zoomState.current.pending.toFixed(1)} px/s`);
        return;
      }
      // Horizontal scroll on alt by default
      if (gestureMatches(g.hScroll, e)) {
        e.preventDefault();
        body.scrollLeft += dy;
        return;
      }
      // Otherwise default vertical scroll (browser handles)
    }
    body.addEventListener("wheel", onWheel, { passive: false });
    return () => body.removeEventListener("wheel", onWheel);
  }, [PX_PER_S, laneHeight, gestures, onZoom, onLaneHeight]);

  // Arrow Left/Right → scroll the timeline horizontally. When a stream is
  // selected the app-level handler claims the arrows (to nudge onset/duration)
  // and calls preventDefault first, so we bow out via e.defaultPrevented.
  useEffTL(() => {
    function onKey(e) {
      // Ctrl/Cmd + Shift + Up/Down → vertical zoom: grow/shrink ALL lane heights
      // together. Up expands, Down shrinks. Scales the global default AND every
      // per-lane override so manually-resized lanes move in step.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (e.defaultPrevented) return;
        e.preventDefault();
        const delta = e.key === "ArrowUp" ? 8 : -8;
        const nextGlobal = Math.max(36, Math.min(120, (laneHeight || 56) + delta));
        onLaneHeight && onLaneHeight(nextGlobal);
        setLaneHeights(h => {
          const m = {};
          for (const k in h) m[k] = Math.max(28, Math.min(240, h[k] + delta));
          localStorage.setItem("pge-lane-heights", JSON.stringify(m));
          return m;
        });
        setHint(`lane ${nextGlobal}px`);
        clearTimeout(onKey._hintT);
        onKey._hintT = setTimeout(() => setHint(null), 700);
        return;
      }
      // Ctrl/Cmd + Up/Down → zoom the timeline (in / out), anchored on the
      // playhead when zoom-lock is on, otherwise on the viewport center.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (e.defaultPrevented) return;
        const body = bodyRef.current;
        if (!body) return;
        e.preventDefault();
        const factor = e.key === "ArrowUp" ? 1 / 1.2 : 1.2;
        const next = +Math.max(0.5, Math.min(200, PX_PER_S * factor)).toFixed(2);
        zoomAnchor.current.active = true;
        if (zoomLockRef.current) {
          const ph = playheadRef.current;
          // Pull the playhead toward center as we zoom (clamped by scroll bounds).
          const curVX = ph * PX_PER_S - body.scrollLeft;
          const center = body.clientWidth / 2;
          zoomAnchor.current.t = ph;
          zoomAnchor.current.vx = curVX + (center - curVX) * 0.35;
        } else {
          const cx = body.clientWidth / 2;
          zoomAnchor.current.t = (body.scrollLeft + cx) / PX_PER_S;
          zoomAnchor.current.vx = cx;
        }
        clearTimeout(zoomAnchor.current.endTimer);
        zoomAnchor.current.endTimer = setTimeout(() => { zoomAnchor.current.active = false; }, 250);
        onZoom && onZoom(next);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented) return;
      // Selection present → arrows belong to the app (nudge onset / ctrl-resize).
      if (selected && selected.length > 0) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const body = bodyRef.current;
      if (!body) return;
      e.preventDefault();
      const step = e.shiftKey ? body.clientWidth * 0.5 : PX_PER_S;
      body.scrollLeft += e.key === "ArrowLeft" ? -step : step;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [PX_PER_S, selected, onZoom, laneHeight, onLaneHeight]);

  return (
    <div className="pge-timeline split-tl" ref={ref}>
      <SplitPane dir="horiz" persist="tl-heads" initial={220} min={140} max={420}>
      {/* track header column */}
      <div className="lanes-head">
        <div className="ruler-corner">
          <span className="z2">{duration}s · 120 bpm</span>
          <button className={"zoom-lock-tgl" + (zoomLock ? " active" : "")}
                  onClick={() => setZoomLock(v => !v)}
                  title={zoomLock
                    ? "zoom centrato sulla testina (playhead) — clicca per tornare al cursore"
                    : "zoom centrato sul cursore — clicca per bloccarlo sulla testina (playhead)"}
                  aria-pressed={zoomLock}>
            <Icon name="search" size={12} />
            <Icon name={zoomLock ? "lock" : "lockOpen"} size={10} />
          </button>
        </div>
        <div className="lanes-head-clip">
          <div className="track-heads" ref={headRef}>
            {streams.map((s, i) =>
            <TrackHeader key={s.id} stream={s} selected={selected.includes(s.id)}
              height={getH(s.id)} index={i} dragOver={dragOver === i}
              onResizeStart={(e) => startResizeLane(e, s.id)}
              onReorderStart={(e) => startReorder(e, i)}
              onSelect={(multi) => onSelect(s.id, multi)} onRangeSelect={() => onRangeSelect && onRangeSelect(s.id)} onDoubleSelect={() => onDoubleSelect && onDoubleSelect(s.id)}
              onMute={() => onUpdate(s.id, { mute: !s.mute })} onSolo={() => onUpdate(s.id, { solo: !s.solo })}
              effMuted={isEffMuted(s)} anySolo={anySolo} />
            )}
          </div>
        </div>
        <div className="lanes-head-add">
          <button className="add-btn" onClick={() => onCreateStream && onCreateStream({ onset: 0 })}>
            <Icon name="plus" size={12} /> <span className="add-btn-lbl">add stream</span>
          </button>
        </div>
      </div>
      {/* timeline grid */}
      <div className="lanes-body" ref={bodyRef}>
        <div className="ruler" style={{ width: renderSec * PX_PER_S }}
             onPointerDown={(e) => {
               const rect = e.currentTarget.getBoundingClientRect();
               const x = e.clientX - rect.left;
               const y = e.clientY - rect.top;
               if (y <= 12) {
                 const hasRegion = loopRegion && loopRegion.end > loopRegion.start;
                 const leftPx = hasRegion ? loopRegion.start * PX_PER_S : -Infinity;
                 const rightPx = hasRegion ? loopRegion.end * PX_PER_S : -Infinity;
                 e.currentTarget.setPointerCapture(e.pointerId);
                 if (hasRegion && Math.abs(x - leftPx) <= 6) {
                   loopDragRef.current = { mode: 'resize', fixedT: loopRegion.end };
                 } else if (hasRegion && Math.abs(x - rightPx) <= 6) {
                   loopDragRef.current = { mode: 'resize', fixedT: loopRegion.start };
                 } else {
                   const startT = Math.max(0, x / PX_PER_S);
                   loopDragRef.current = { mode: 'new', startT };
                   onLoopRegionChange && onLoopRegionChange({ start: startT, end: startT });
                 }
               } else {
                 window.dispatchEvent(new CustomEvent("pge-seek", { detail: Math.max(0, x / PX_PER_S) }));
               }
             }}
             onPointerMove={(e) => {
               const rect = e.currentTarget.getBoundingClientRect();
               const x = e.clientX - rect.left;
               const y = e.clientY - rect.top;
               if (!loopDragRef.current) {
                 // Cursor hint when hovering near loop region edges
                 const hasRegion = loopRegion && loopRegion.end > loopRegion.start;
                 if (y <= 12 && hasRegion) {
                   const lx = loopRegion.start * PX_PER_S;
                   const rx = loopRegion.end * PX_PER_S;
                   e.currentTarget.style.cursor = (Math.abs(x - lx) <= 6 || Math.abs(x - rx) <= 6)
                     ? 'ew-resize' : 'col-resize';
                 } else {
                   e.currentTarget.style.cursor = '';
                 }
                 return;
               }
               const t = Math.max(0, x / PX_PER_S);
               const { mode, startT, fixedT } = loopDragRef.current;
               if (mode === 'resize') {
                 onLoopRegionChange && onLoopRegionChange(
                   t <= fixedT ? { start: t, end: fixedT } : { start: fixedT, end: t }
                 );
               } else {
                 onLoopRegionChange && onLoopRegionChange(
                   t >= startT ? { start: startT, end: t } : { start: t, end: startT }
                 );
               }
             }}
             onPointerUp={(e) => {
               if (!loopDragRef.current) return;
               e.currentTarget.releasePointerCapture(e.pointerId);
               e.currentTarget.style.cursor = '';
               loopDragRef.current = null;
             }}
             onPointerLeave={(e) => {
               if (!loopDragRef.current) e.currentTarget.style.cursor = '';
             }}>
          {ticks.map((t) =>
          <React.Fragment key={t.s}>
              <span className={"tick" + (t.major ? " major" : "")} style={{ left: t.x }} />
              {t.major ? <span className="lbl" style={{ left: t.x }}>{fmt(t.s)}</span> : null}
            </React.Fragment>
          )}
          {loopRegion && loopRegion.end > loopRegion.start ? (
            <div className={"loop-region" + (loopEnabled ? " enabled" : "")}
                 style={{ left: loopRegion.start * PX_PER_S, width: (loopRegion.end - loopRegion.start) * PX_PER_S }} />
          ) : null}
          <div className="head" style={{ left: playhead * PX_PER_S }}>
            <div className="head-flag" />
          </div>
        </div>
        <div className={"lanes-area" + (sampleDragOver ? " sample-drag-over" : "")}
             ref={lanesAreaRef}
             style={{ width: renderSec * PX_PER_S }}
             onPointerDown={onMarqueeStart}
             onDragEnter={onSampleDragEnter}
             onDragLeave={onSampleDragLeave}
             onDragOver={onSampleDragOver}
             onDrop={onEmptyDrop}>
          <div className="lanes-grid" aria-hidden="true">
            {ticks.map((t) => (
              <span key={t.s} className={"gline" + (t.major ? " major" : "")} style={{ left: t.x }} />
            ))}
          </div>
          {streams.map((s, i) =>
          <div key={s.id} className="lane" style={{ height: getH(s.id) }} onDragOver={onSampleDragOver} onDrop={(e) => { dragEnterCount.current = 0; setSampleDragOver(false); onLaneDrop(e, i); }}
          onMouseMove={(e) => setHoverX((e.clientX - e.currentTarget.getBoundingClientRect().left) / PX_PER_S)}
          onClick={(e) => { if (e.target === e.currentTarget) onDeselect?.(); }}>
              <div className={"clip" + (selected.includes(s.id) ? " selected" : "") + (s.error ? " error" : "") + (isEffMuted(s) ? " muted" : "") + (s.solo ? " soloed" : "")}
            style={{ left: s.onset * PX_PER_S, width: s.duration * PX_PER_S, background: s.color }}
            onPointerDown={(e) => onPointerDown(e, s, "drag")}
            onDoubleClick={() => onDoubleSelect && onDoubleSelect(s.id)}>
                {renderStatusFor ? <ClipRenderStatus status={renderStatusFor(s.id)} /> : null}
                {showClipLabels !== false ? (<>
                <div className="lbl">{s.id} · {s.sample}</div>
                <div className="metaline">d:{(typeof s.density === "number" || typeof s.density === "string") ? s.density : (s.densityEnv ? "env" : "ff " + s.fillFactor)} · {(typeof s.voices.num === "number") ? s.voices.num : "env"}v</div>
                </>) : null}
                {showSpectrograms && spectrogramFor && spectrogramFor(s.id) ?
              <ClipSpectrogram buf={spectrogramFor(s.id)} width={s.duration * PX_PER_S} height={getH(s.id)} /> :
              showWaveforms !== false && waveformFor && waveformFor(s.id) ?
              <ClipWaveform peaks={waveformFor(s.id)} width={s.duration * PX_PER_S} height={getH(s.id)} color={s.color} /> :
              null}
                <div className="resize-handle" onPointerDown={(e) => onPointerDown(e, s, "resize")} />
                <div className="lane-resize" onPointerDown={(e) => startResizeLane(e, s.id)} title="drag to resize this track" />
              </div>
            </div>
          )}
          <div className="comp-end-line" style={{ left: duration * PX_PER_S }} />
          <div className="playhead-line" style={{ left: playhead * PX_PER_S }} />
          <div className="playhead-glow" style={{ left: playhead * PX_PER_S - 7 }} />
          {marquee && (() => {
            const x = Math.min(marquee.x0, marquee.x1);
            const y = Math.min(marquee.y0, marquee.y1);
            const w = Math.abs(marquee.x1 - marquee.x0);
            const h = Math.abs(marquee.y1 - marquee.y0);
            return <div className="marquee-rect" style={{ left: x, top: y, width: w, height: h }} />;
          })()}
        </div>
        {hint ? <div className="zoom-hint">{hint}</div> : null}
      </div>
      </SplitPane>
    </div>);

}

function TrackHeader({ stream, selected, onSelect, onRangeSelect, onDoubleSelect, onMute, onSolo, height, onResizeStart, onReorderStart, dragOver, effMuted, anySolo }) {
  return (
    <div className={"track-head" + (selected ? " selected" : "") + (effMuted ? " muted" : "") + (stream.solo ? " soloed" : "") + (anySolo && !stream.solo ? " dim-by-solo" : "") + (dragOver ? " drop-target" : "")}
    style={{ borderLeftColor: stream.color, height: height || "var(--lane-h)" }}
    onClick={(e) => { if (e.shiftKey) onRangeSelect && onRangeSelect(); else onSelect(e.ctrlKey || e.metaKey); }}
    onDoubleClick={onDoubleSelect}>
      <div className="grip" onPointerDown={onReorderStart} onClick={(e) => e.stopPropagation()} title="drag to reorder track">
        <span /><span /><span /><span /><span /><span />
      </div>
      <div className="lh">
        <div className="nm-row">
          <span className="nm">{stream.id}</span>
          <button className={"pill" + (stream.mute ? " on-m" : "")} onClick={(e) => {e.stopPropagation();onMute();}} title="mute">M</button>
          <button className={"pill" + (stream.solo ? " on-s" : "")} onClick={(e) => {e.stopPropagation();onSolo();}} title="solo">S</button>
        </div>
        <span className="sub">{stream.sample}</span>
      </div>
      <div className="track-head-resize" onPointerDown={onResizeStart} onClick={(e) => e.stopPropagation()} />
    </div>);

}

window.PGE.Timeline = Timeline;