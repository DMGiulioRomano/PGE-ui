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
  if (!status || status.state === "hidden") return null;
  const label = {
    fresh:   "✓ rendered",
    stale:   "⚠ stale",
    never:   "· never rendered",
    running: "rendering…",
    error:   "error",
  }[status.state] || status.state;
  const tip = status.tooltip || label;
  return (
    <div className={"clip-render-status s-" + status.state} title={tip}>
      <span className="crs-dot" />
      <span className="crs-text mono">{label}</span>
      {typeof status.progress === "number" && status.state === "running" ? (
        <span className="crs-bar"><span className="crs-bar-fill" style={{ width: (status.progress * 100).toFixed(0) + "%" }} /></span>
      ) : null}
    </div>
  );
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

function Timeline({ streams, selected, onSelect, onDoubleSelect, onUpdate, onReorder, playhead, duration, onCreateStream,
  pxPerSec, showWaveforms, laneHeight, gestures, onZoom, onLaneHeight,
  renderStatusFor }) {
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
  const dragEnterCount = useRefTL(0);
  const zoomState = useRefTL({ pending: null, raf: null });
  const zoomAnchor = useRefTL({ active: false, t: 0, vx: 0, endTimer: null });

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
    const orig = { onset: stream.onset, duration: stream.duration };
    let moved = false;
    const THRESHOLD = 4;
    function move(ev) {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < THRESHOLD) return;
      if (!moved) { window.PGEHistory && window.PGEHistory.beginGesture(); }
      moved = true;
      const dt = dx / PX_PER_S;
      if (mode === "drag") {
        onUpdate(stream.id, { onset: Math.max(0, +(orig.onset + dt).toFixed(3)) });
      } else if (mode === "resize") {
        onUpdate(stream.id, { duration: Math.max(0.5, +(orig.duration + dt).toFixed(3)) });
      }
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved && window.PGEHistory) window.PGEHistory.endGesture();
      // Click (no significant movement) → select. Double-click handled separately.
      if (!moved) onSelect(stream.id);
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
        // Anchor: time under the cursor RIGHT NOW (using current scrollLeft + current PX_PER_S).
        // Update on every event so the cursor tracks if user moves it mid-zoom.
        zoomAnchor.current.active = true;
        zoomAnchor.current.t = (body.scrollLeft + cursorVX) / PX_PER_S;
        zoomAnchor.current.vx = cursorVX;
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

  return (
    <div className="pge-timeline split-tl" ref={ref}>
      <SplitPane dir="horiz" persist="tl-heads" initial={220} min={140} max={420}>
      {/* track header column */}
      <div className="lanes-head">
        <div className="ruler-corner">
          <span className="z2">{duration}s · 120 bpm</span>
        </div>
        <div className="lanes-head-clip">
          <div className="track-heads" ref={headRef}>
            {streams.map((s, i) =>
            <TrackHeader key={s.id} stream={s} selected={selected === s.id}
              height={getH(s.id)} index={i} dragOver={dragOver === i}
              onResizeStart={(e) => startResizeLane(e, s.id)}
              onReorderStart={(e) => startReorder(e, i)}
              onSelect={() => onSelect(s.id)} onDoubleSelect={() => onDoubleSelect && onDoubleSelect(s.id)}
              onMute={() => onUpdate(s.id, { mute: !s.mute })} onSolo={() => onUpdate(s.id, { solo: !s.solo })}
              effMuted={isEffMuted(s)} anySolo={anySolo} />
            )}
          </div>
        </div>
        <div className="lanes-head-add">
          <button className="add-btn" onClick={() => onCreateStream && onCreateStream({ sample: (window.PGE_DATA.samples[0] || {}).name, onset: 0 })}>
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
               window.dispatchEvent(new CustomEvent("pge-seek", { detail: Math.max(0, x / PX_PER_S) }));
             }}>
          {ticks.map((t) =>
          <React.Fragment key={t.s}>
              <span className={"tick" + (t.major ? " major" : "")} style={{ left: t.x }} />
              {t.major ? <span className="lbl" style={{ left: t.x }}>{fmt(t.s)}</span> : null}
            </React.Fragment>
          )}
          <div className="head" style={{ left: playhead * PX_PER_S }}>
            <div className="head-flag" />
          </div>
        </div>
        <div className={"lanes-area" + (sampleDragOver ? " sample-drag-over" : "")}
             style={{ width: renderSec * PX_PER_S }}
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
          onMouseMove={(e) => setHoverX((e.clientX - e.currentTarget.getBoundingClientRect().left) / PX_PER_S)}>
              <div className={"clip" + (s.id === selected ? " selected" : "") + (s.error ? " error" : "") + (isEffMuted(s) ? " muted" : "") + (s.solo ? " soloed" : "")}
            style={{ left: s.onset * PX_PER_S, width: s.duration * PX_PER_S, background: s.color }}
            onPointerDown={(e) => onPointerDown(e, s, "drag")}
            onDoubleClick={() => onDoubleSelect && onDoubleSelect(s.id)}>
                {renderStatusFor ? <ClipRenderStatus status={renderStatusFor(s.id)} /> : null}
                <div className="lbl">{s.id} · {s.sample}</div>
                <div className="metaline">d:{(typeof s.density === "number" || typeof s.density === "string") ? s.density : (s.densityEnv ? "env" : "ff " + s.fillFactor)} · {(typeof s.voices.num === "number") ? s.voices.num : "env"}v</div>
                {showWaveforms !== false ?
              <svg className="wave" viewBox="0 0 240 22" preserveAspectRatio="none">
                    <path fill="rgba(255,255,255,.55)" d="M0,11 L8,5 16,17 24,8 32,15 40,4 48,18 56,9 64,16 72,3 80,18 88,11 96,15 104,7 112,17 120,5 128,19 136,10 144,16 152,8 160,17 168,4 176,18 184,11 192,15 200,7 208,17 216,5 224,18 232,11 240,11 240,11 0,11" />
                  </svg> :
              null}
                <div className="resize-handle" onPointerDown={(e) => onPointerDown(e, s, "resize")} />
                <div className="lane-resize" onPointerDown={(e) => startResizeLane(e, s.id)} title="drag to resize this track" />
              </div>
            </div>
          )}
          <div className="comp-end-line" style={{ left: duration * PX_PER_S }} />
          <div className="playhead-line" style={{ left: playhead * PX_PER_S }} />
          <div className="playhead-glow" style={{ left: playhead * PX_PER_S - 7 }} />
        </div>
        {hint ? <div className="zoom-hint">{hint}</div> : null}
      </div>
      </SplitPane>
    </div>);

}

function TrackHeader({ stream, selected, onSelect, onDoubleSelect, onMute, onSolo, height, onResizeStart, onReorderStart, dragOver, effMuted, anySolo }) {
  return (
    <div className={"track-head" + (selected ? " selected" : "") + (effMuted ? " muted" : "") + (stream.solo ? " soloed" : "") + (anySolo && !stream.solo ? " dim-by-solo" : "") + (dragOver ? " drop-target" : "")}
    style={{ borderLeftColor: stream.color, height: height || "var(--lane-h)" }} onClick={onSelect} onDoubleClick={onDoubleSelect}>
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