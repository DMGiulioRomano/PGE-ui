/* @jsx React.createElement */
const { useState: useStateTL, useRef: useRefTL, useEffect: useEffTL } = React;

const LOOP_CURSOR = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='17 1 21 5 17 9'/%3E%3Cpath d='M3 11V9a4 4 0 0 1 4-4h14'/%3E%3Cpolyline points='7 23 3 19 7 15'/%3E%3Cpath d='M21 13v2a4 4 0 0 1-4 4H3'/%3E%3C/svg%3E\") 8 8, pointer";

/* Max canvas backing-store dimension (device px). A long clip zoomed in
 * (duration * PX_PER_S, up to 200 px/s) times devicePixelRatio easily exceeds
 * the browser's per-side canvas limit (Firefox 32767, Safari ~16384), which
 * throws "Canvas exceeds max size" and crashes the Timeline. 16384 is safe
 * across browsers and well within their area limits at clip heights. */
const MAX_CANVAS_PX = 16384;

/* Size a clip canvas' backing store at devicePixelRatio, but clamped so it
 * never exceeds MAX_CANVAS_PX on either side. The canvas is displayed via CSS
 * (width/height 100%) so a clamped backing store is just drawn lower-res and
 * stretched — never a crash. setTransform maps CSS-pixel draw coords (0..W,
 * 0..H) onto the (possibly clamped) backing store, so callers keep drawing in
 * CSS pixels. Returns the 2d context plus the CSS-pixel W/H to draw against. */
function setupClipCanvas(cvs, width, height) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.floor(width));
  const H = Math.max(1, Math.floor(height));
  const bw = Math.min(Math.floor(W * dpr), MAX_CANVAS_PX);
  const bh = Math.min(Math.floor(H * dpr), MAX_CANVAS_PX);
  cvs.width = bw;
  cvs.height = bh;
  const ctx = cvs.getContext("2d");
  ctx.setTransform(bw / W, 0, 0, bh / H, 0, 0);
  return { ctx, W, H };
}

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
    const { ctx, W, H } = setupClipCanvas(cvs, width, height);
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
    const { ctx, W, H } = setupClipCanvas(cvs, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(off, 0, 0, cols, bins, 0, 0, W, H);
  }, [buf, width, height]);
  return <canvas className="wave spec" ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
}

/* ---------- ClipGrains ---------- */
/* Draws the stream's grains "score-visualizer style" onto a <canvas> overlaid
 * on the clip: X=time, Y=pointer position (normalized per-stream, max on top),
 * color=pitch (turbo, autozoom in cents), alpha=volume. `data` is the engine's
 * grain JSON sidecar ({duration, grains:[{t,dur,vol,ptr,pr,v}], …}). Immediate-
 * mode canvas so tens of thousands of grains stay cheap; the .grains CSS sets
 * pointer-events:none so the overlay never steals the clip's drag/resize. The
 * mapping math lives in window.PGEGrainMap (shared with the GrainScore panel). */
function ClipGrains({ data, width, height }) {
  const canvasRef = useRefTL(null);
  useEffTL(() => {
    const cvs = canvasRef.current;
    const GM = window.PGEGrainMap;
    if (!cvs || !data || !GM || width < 2 || height < 2) return;
    const grains = data.grains || [];
    const { ctx, W, H } = setupClipCanvas(cvs, width, height);
    ctx.clearRect(0, 0, W, H);
    if (!grains.length) return;
    // px/s derived from the clip width and stream duration → X matches this
    // clip's timeline scale exactly (== PX_PER_S, but self-contained).
    const dur = data.duration || 0;
    // Extents pre-calcolati all'arrivo del JSON (app.jsx); fallback se assenti.
    const ext = data._ext || GM.computeExtents(grains);
    const gctx = {
      pxPerSec: dur > 0 ? W / dur : 0,
      height: H,
      ptrMin: ext.ptr.min, ptrMax: ext.ptr.max,
      grainHeight: 2,
    };
    GM.paintGrains(ctx, grains, gctx, ext.pit, { width: W });
  }, [data, width, height]);
  return <canvas className="grains" ref={canvasRef} style={{ width: "100%", height: "100%" }} />;
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

/* Clip box geometry, shared with `.clip` in editor.css (top/bottom: 6px). Only
 * the vertical stagger of stacked clips is computed here — CSS cannot know how
 * many clips a lane holds. Keep CLIP_PAD equal to the CSS inset. */
const CLIP_PAD        = 6;   // inset from the lane's top and bottom edges
const CLIP_STACK_STEP = 6;   // how far each stacked clip starts below the previous
const SEEK_SNAP_PX = 8;   // click within this of a clip's left edge = seek to its onset
const CLIP_MIN_H      = 22;  // the last clip in a stack never goes thinner than this

function Timeline({ streams, tracks, selected, selectedTrack, onSelect, onTrackSelect, onDeselect, onRangeSelect, onMarqueeSelect,
  onDoubleSelect, onUpdate, onTrackReorder, onTrackRename, onTrackMute, onTrackSolo, onMoveStreams,
  playhead, duration, onCreateStream, onAddTrack, onTrackRemove,
  pxPerSec, showWaveforms, showSpectrograms, showGrains, showClipLabels, laneHeight, gestures, onZoom, onLaneHeight,
  renderStatusFor, waveformFor, spectrogramFor, grainsFor,
  loopEnabled, loopRegion, onLoopRegionChange,
  arrowOwnerRef, laneMoveKeys, sampleDurOf, onNeedGrains, analysersFor }) {
  const { Icon, SplitPane } = window.PGE;
  const anySolo = streams.some(s => s.solo);
  // solo/mute stay PER STREAM: that is what the engine filters on
  // (Generator._filter_solo_mute) and what the YAML carries. A lane's M/S
  // button is a fan-out over its group, never a new piece of state.
  const isEffMuted = (s) => s.mute || (anySolo && !s.solo);
  // A lane is a track; with no track model supplied it degrades to one lane per
  // stream, which is what the timeline did before tracks existed.
  const baseTracks = (tracks && tracks.length)
    ? tracks
    : streams.map(s => ({ id: s.id, name: s.id, streamIds: [s.id] }));
  const streamById = new Map(streams.map(s => [s.id, s]));
  const laneOfStream = new Map();
  baseTracks.forEach((t, i) => t.streamIds.forEach(id => laneOfStream.set(id, i)));
  const PX_PER_S = pxPerSec || 36;
  /* Riquadro informativo sotto il cursore, sul modello di Reaper: compare
   * passando sopra una clip SELEZIONATA e dice dove si trova la clip nel tempo
   * e, in piu', dove sta leggendo la testina nel sample a quell'istante.
   *
   * Position/End ci sono SEMPRE: sono onset e durata, dati che abbiamo. La
   * riga `read` compare solo se il motore ha gia' scritto il sidecar dei grani
   * (layer grani acceso + un render fatto), perche' il `ptr` lo calcola lui e
   * non lo inventiamo noi (grain-map.js:readPositionAt). Quando manca lo dice,
   * invece di far sparire tutto il riquadro: una scatola che non compare non
   * si distingue da una funzione rotta.
   *
   * L'aggiornamento e' IMPERATIVO, non via setState: un pointermove su una
   * clip farebbe altrimenti ri-renderizzare l'intera timeline a ogni pixel —
   * il difetto che `hoverX` teneva in piedi qui prima. Stesso idiom della
   * sincronia delle testate (head.style.transform). */
  function fmtTime(t) {
    const m = Math.floor(t / 60);
    const sec = t - m * 60;
    return `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(3)}`;
  }
  function showReadout(e, s) {
    const el = readoutRef.current;
    if (!el) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const tRel = (e.clientX - rect.left) / PX_PER_S;
    const lines = [
      `Position: ${fmtTime(s.onset)}`,
      `End: ${fmtTime(s.onset + s.duration)}   Len: ${s.duration.toFixed(3)}`,
    ];
    // Il sidecar sta su disco appena lo stream e' stato renderizzato: se non e'
    // ancora in memoria lo si chiede, invece di pretendere che l'utente accenda
    // il layer grani per un dato che non c'entra con quel toggle.
    if (onNeedGrains) onNeedGrains(s.id);
    const data = grainsFor && grainsFor(s.id);
    const ptr = data && window.PGEGrainMap.readPositionAt(data, tRel, {
      // La deviazione stocastica esiste solo se offset_range e' dichiarato: il
      // centro della deviazione e' inchiodato a zero nello schema del motore
      // (`pointer_deviation`, yaml_path '_dummy_fixed_zero_'). Senza quella
      // chiave il ptr della voce 0 e' la posizione base, esatta.
      jitter: !!(s.pointer && (s.pointer.offsetRange != null || s.pointer.offsetRangeEnv)),
      sampleDur: sampleDurOf ? sampleDurOf(s.sample) : 0,
    });
    lines.push(ptr
      ? `Read: ${ptr.exact ? "" : "~"}${ptr.pos.toFixed(3)}  @ ${tRel.toFixed(3)}`
      : `Read: — (${readoutWhy(s, data)})`);
    el.textContent = lines.join("\n");
    el.title = ptr && !ptr.exact ? "stima: pointer.offset_range devia ogni grano" : "";
    // Il riquadro sta sotto-destra della punta, come in Reaper, e si ribalta
    // sul lato opposto quando toccherebbe il bordo della finestra.
    el.style.display = "block";
    const w = el.offsetWidth, h = el.offsetHeight;
    const x = e.clientX + 16, y = e.clientY + 16;
    el.style.left = (x + w > window.innerWidth  - 8 ? e.clientX - w - 8 : x) + "px";
    el.style.top  = (y + h > window.innerHeight - 8 ? e.clientY - h - 8 : y) + "px";
  }
  // Perche' la riga manca. Lo stato di render lo sappiamo gia' (e' lo stesso
  // che accende il pallino sulla clip): distinguere "mai renderizzato" da
  // "sto caricando" e' la differenza fra un'istruzione e un mistero.
  function readoutWhy(s, data) {
    if (data) return "nessun grano qui";
    const st = renderStatusFor && renderStatusFor(s.id);
    if (st && st.state === "never") return "stream mai renderizzato";
    return "sidecar in caricamento…";
  }
  function hideReadout() {
    if (readoutRef.current) readoutRef.current.style.display = "none";
  }
  const HEAD_W = 220;
  const ref = useRefTL(null);
  const headRef = useRefTL(null);
  const bodyRef = useRefTL(null);
  const readoutRef = useRefTL(null);
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
  // Lane heights are keyed by TRACK id. A singleton track's id is its stream id
  // (see tracks.js), so heights saved before tracks existed keep applying.
  function getH(id) { return laneHeights[id] || laneHeight || 56; }

  /* Lane index under a content-space y (already scroll-corrected). Clamped, so
   * dragging past either end lands on the first/last lane rather than nowhere —
   * except with `overflow`, which keeps counting past the bottom in lanes that
   * do not exist yet: the clip drag creates them, so it must be able to point
   * at them. Upward there is nothing to count into: lane 0 is a hard floor. */
  function laneIndexAtY(y, overflow) {
    if (!laneTracks.length) return -1;
    for (let i = 0; i < laneTracks.length; i++) {
      if (y < laneTops[i] + getH(laneTracks[i].id)) return Math.max(0, i);
    }
    const last = laneTracks.length - 1;
    if (!overflow) return last;
    const bottom = laneTops[last] + getH(laneTracks[last].id);
    return last + 1 + Math.floor((y - bottom) / (laneHeight || 56));
  }
  /* Same, from a raw clientY. `.lanes-area` is the scrolled content itself, so
   * its rect already carries scrollTop — adding it again would double-count. */
  function laneIndexAtClientY(clientY, overflow) {
    const area = lanesAreaRef.current;
    if (!area) return -1;
    return laneIndexAtY(clientY - area.getBoundingClientRect().top, overflow);
  }

  // The drop target during a drag. Mirrored in a ref because a state updater is
  // not a place to run effects: calling onReorder from inside setDragOver let a
  // concurrent replay of the updater apply the move twice.
  const dragOverRef = useRefTL(null);
  // Ids of the clips a lane-move drag is carrying, so the source lane can show
  // them faded and the target lane a preview of where they would land. Latched
  // once (a fresh array every pointermove would kill React's bail-out).
  const dragIdsRef = useRefTL(null);
  const [dragIds, setDragIds] = useStateTL(null);
  // How many lanes down (or up) the drag would shift what it carries. The lane
  // under the cursor is not enough on its own: the clips that are NOT the
  // grabbed one land relative to it.
  const [dragDelta, setDragDelta] = useStateTL(null);
  function setDrop(v, ids, delta) {
    dragOverRef.current = v;
    setDragOver(v);
    setDragDelta(v === null ? null : (delta == null ? null : delta));
    if (v === null) {
      setDropExtract(false);   // never outlive its own drag
      if (dragIdsRef.current) { dragIdsRef.current = null; setDragIds(null); }
    } else if (ids && !dragIdsRef.current) {
      dragIdsRef.current = ids;
      setDragIds(ids);
    }
  }
  // Reaper-style drag guides: the two vertical rules on the grabbed clip's
  // start/end, spanning every lane, plus the two horizontal rules on its top
  // and bottom edges. Content-space px, cleared on release.
  const [dragGuides, setDragGuides] = useStateTL(null);
  // Whether the pending drop would JOIN the target lane or EXTRACT into a new
  // one. Drawn differently, so the modifier's effect is visible before release.
  const [dropExtract, setDropExtract] = useStateTL(false);

  /* Where each dragged clip would land: its own lane plus the drag's delta
   * (the DAW rule — a selection keeps its lane spacing, see tracks.js). Null
   * outside a lane drag, and collapsed onto the one target lane under Alt,
   * which extracts everything into a single new lane. */
  function dstLaneOf(id) {
    if (dragDelta == null) return null;
    if (dropExtract) return dragOver;
    const src = laneOfStream.get(id);
    return src == null ? null : src + dragDelta;
  }
  /* Downward the drag GROWS the layout (moveStreams appends lanes), so the
   * lanes it would create are drawn as empty phantoms while it is held: the
   * preview must not stop at a bottom edge the drop does not respect. */
  const laneTracks = React.useMemo(() => {
    if (dragDelta == null || !dragIds) return baseTracks;
    let bottom = baseTracks.length - 1;
    for (const id of dragIds) {
      const d = dstLaneOf(id);
      if (d != null && d > bottom) bottom = d;
    }
    if (bottom < baseTracks.length) return baseTracks;
    const out = [...baseTracks];
    for (let i = baseTracks.length; i <= bottom; i++) out.push({ id: "__new" + i, name: "", streamIds: [], phantom: true });
    return out;
  }, [baseTracks, dragDelta, dragIds, dropExtract, dragOver]);
  const laneStreams = laneTracks.map(t => t.streamIds.map(id => streamById.get(id)).filter(Boolean));

  // Top edge of each lane inside .lanes-area, in content pixels.
  const laneTops = [];
  {
    let y = 0;
    for (const t of laneTracks) { laneTops.push(y); y += getH(t.id); }
  }


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
      setDrop(Math.max(0, Math.min(laneTracks.length - 1, dst)));
    }
    function up(ev) {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      const dst = dragOverRef.current;
      setDrop(null);
      if (dst != null && dst !== srcIdx && onTrackReorder) onTrackReorder(srcIdx, dst);
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
    const startY = e.clientY;
    const isInSelection = selected.includes(stream.id);
    const targets = isInSelection ? streams.filter(s => selected.includes(s.id)) : [stream];
    const origs = Object.fromEntries(targets.map(s => [s.id, { onset: s.onset, duration: s.duration }]));
    const srcLane = laneOfStream.has(stream.id) ? laneOfStream.get(stream.id) : -1;
    const canMoveLane = mode === "drag" && !!onMoveStreams && srcLane !== -1;
    // The highest lane the selection sits on: the drag stops when THAT clip
    // reaches lane 0, so a selection spanning two lanes never collapses onto
    // one against the ceiling (Reaper's rule, mirrored in tracks.js).
    const topLane = targets.reduce((m, s) => Math.min(m, laneOfStream.has(s.id) ? laneOfStream.get(s.id) : m), srcLane);
    // Alt is sampled while dragging, not at release: releasing the modifier a
    // frame before the button must not silently invert the outcome, and this is
    // the same value the lane highlight is drawn from.
    const extractRef = { current: false };
    // The clip's vertical extent, read once: it does not move until release
    // (a lane change lands on drop), and reading it per-move would trail the
    // React render by a frame.
    const areaR = lanesAreaRef.current && lanesAreaRef.current.getBoundingClientRect();
    const clipR = e.currentTarget.closest && e.currentTarget.closest(".clip")
      ? e.currentTarget.closest(".clip").getBoundingClientRect() : null;
    const gy = areaR && clipR ? { top: clipR.top - areaR.top, bottom: clipR.bottom - areaR.top } : null;
    // Vertical INTENT, sampled the same way, and the gate for the whole lane
    // move. Without it an ordinary horizontal drag still reports a drop lane —
    // the cursor never leaves the grabbed clip's own lane — so a selection
    // spanning two lanes would silently collapse into one every time it is
    // moved along the time axis, writing `ui_tracks` into the file.
    // `dstLane !== srcLane` is NOT the guard: `srcLane` is the lane of the
    // GRABBED clip, and a drag that returns it to its own row while the rest of
    // the selection has been clamped against the ceiling is still a real move.
    // It just has to ask vertically to be told apart from a plain horizontal
    // one. Once latched it stays latched: the drag has declared itself, and
    // coming back to the starting row is then a choice.
    const verticalRef = { current: false };
    let moved = false;
    const THRESHOLD = 4;
    function move(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // The threshold takes BOTH axes: a purely vertical drag leaves onset
      // alone, and without dy here it would never start at all.
      if (!moved && Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
      if (!moved) { window.PGEHistory && window.PGEHistory.beginGesture(); }
      moved = true;
      const dt = dx / PX_PER_S;
      for (const s of targets) {
        if (mode === "drag")   onUpdate(s.id, { onset:    Math.max(0,   +(origs[s.id].onset    + dt).toFixed(3)) });
        if (mode === "resize") onUpdate(s.id, { duration: Math.max(0.5, +(origs[s.id].duration + dt).toFixed(3)) });
      }
      if (canMoveLane) {
        if (Math.abs(dy) >= THRESHOLD) verticalRef.current = true;
        extractRef.current = !!ev.altKey;
        setDropExtract(extractRef.current);
        // No vertical intent, no highlight: the affordance must not promise a
        // lane change the release will not perform. Past the bottom the index
        // keeps counting into lanes the drop will create.
        const lane = verticalRef.current ? laneIndexAtClientY(ev.clientY, true) : -1;
        // Clamped upward only, and on the whole selection, not on the grabbed
        // clip: that is what preserves the spacing at the ceiling.
        const delta = lane === -1 ? null : Math.max(lane - srcLane, -topLane);
        setDrop(delta === null ? null : srcLane + delta, targets.map(s => s.id), delta);
      }
      if (gy) {
        const onset = mode === "drag" ? Math.max(0, origs[stream.id].onset + dt) : origs[stream.id].onset;
        const dur = mode === "resize" ? Math.max(0.5, origs[stream.id].duration + dt) : origs[stream.id].duration;
        // The horizontal rules ride the lane the drop would land on, not the
        // one the clip is still drawn in — that lane is where the eye is.
        const lane = dragOverRef.current;
        const y = lane != null && laneTracks[lane]
          ? { top: laneTops[lane] + CLIP_PAD, bottom: laneTops[lane] + getH(laneTracks[lane].id) - CLIP_PAD }
          : gy;
        setDragGuides({ ...y, x0: onset * PX_PER_S, x1: (onset + dur) * PX_PER_S });
      }
    }
    function up(ev) {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const dstLane = canMoveLane ? dragOverRef.current : null;
      setDrop(null);
      setDragGuides(null);
      // Inside the gesture, so the vertical move and the onset it travelled
      // with collapse into one undo step. `dstLane` is non-null only when
      // `verticalRef` latched (see move), so a horizontal drag never reaches
      // here. Whether a real drop changes anything is `moveStreams`' call — it
      // sees all the targets, this does not.
      if (moved && dstLane != null) {
        onMoveStreams(targets.map(s => s.id), dstLane, { extract: extractRef.current, anchor: stream.id });
      }
      if (moved && window.PGEHistory) window.PGEHistory.endGesture();
      if (!moved) {
        // Clicking a clip also moves the playhead where it was clicked (DAW
        // habit) — but only a plain click: shift/ctrl are selection gestures.
        if (areaR && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          const x = e.clientX - areaR.left;
          // Near the clip's left edge, snap to its exact onset: clicking "at
          // the start" always lands a few px in, and starting a hair late is
          // exactly what you don't want when you click the head of a clip.
          const t = Math.abs(x - stream.onset * PX_PER_S) <= SEEK_SNAP_PX
            ? stream.onset : x / PX_PER_S;
          window.dispatchEvent(new CustomEvent("pge-seek", { detail: Math.max(0, t) }));
        }
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
    // The rect of the scrolled content already carries the scroll offset, so
    // these are content coords — the same space as clip lefts and laneTops.
    const getCoords = (ev) => {
      const r = lanesAreaRef.current.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
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
        const ids = [];
        laneTracks.forEach((t, i) => {
          const laneTop = laneTops[i], laneBot = laneTop + getH(t.id);
          if (laneBot <= minY || laneTop >= maxY) return;
          // Every clip sharing the lane is a candidate, not just "the" stream:
          // the lane is no longer one stream tall.
          for (const s of laneStreams[i]) {
            const clipL = s.onset * PX_PER_S;
            const clipR = (s.onset + s.duration) * PX_PER_S;
            if (clipR <= minX || clipL >= maxX) continue;
            ids.push(s.id);
          }
        });
        if (ids.length > 0) onMarqueeSelect && onMarqueeSelect(ids, additive);
        else onDeselect && onDeselect();
      } else {
        // Click in empty timeline space = move the playhead, like a DAW. x0 is
        // already in content coords (scroll included).
        window.dispatchEvent(new CustomEvent("pge-seek", { detail: Math.max(0, x0 / PX_PER_S) }));
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
    // The lane is scrolled content: its rect already carries scrollLeft.
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    // An empty lane is waiting to be filled: the drop lands IN it. Otherwise a
    // NEW track at this position, inserted after the lane dropped onto —
    // `laneIdx` indexes tracks, not streams, so dropping below a three-clip
    // lane must land one lane down, not three streams down.
    const t = laneTracks[idx];
    const empty = t && !t.streamIds.length;
    onCreateStream && onCreateStream({ sample, onset: +(x / PX_PER_S).toFixed(2),
                                       laneIdx: idx + 1, trackId: empty ? t.id : null });
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
      const vert = e.key === "ArrowUp" || e.key === "ArrowDown";
      if (!vert && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented) return;
      // Selection present → the horizontal arrows belong to the app (nudge
      // onset / ctrl-resize). ↑/↓ have no app-level owner, so they keep
      // scrolling the lanes even with clips selected; the only other claimant
      // is the envelope editor's breakpoint nudge, and it can't be detected via
      // defaultPrevented (this listener is registered first — Timeline mounts
      // before EnvelopeEditor), hence the same ref the app consults.
      if (!vert && selected && selected.length > 0) return;
      if (vert && arrowOwnerRef && arrowOwnerRef.current &&
          arrowOwnerRef.current.focused && arrowOwnerRef.current.singleBPSelected) return;
      // The lane-move shortcut (alt+↑/↓ by default) belongs to the app: it
      // moves the selected clips, and scrolling under them at the same time
      // would fight it. Matched against the live spec rather than hardcoding
      // alt, so a rebind keeps the two in agreement.
      if (vert && laneMoveKeys && window.matchShortcut &&
          laneMoveKeys.some(k => window.matchShortcut(e, k))) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const body = bodyRef.current;
      if (!body) return;
      e.preventDefault();
      if (vert) {
        // One lane per press (the vertical twin of one second per press),
        // half a viewport with shift. The header column follows via the
        // scroll-sync transform, so nothing else has to move.
        const step = e.shiftKey ? body.clientHeight * 0.5 : (laneHeight || 56);
        body.scrollTop += e.key === "ArrowUp" ? -step : step;
        return;
      }
      const step = e.shiftKey ? body.clientWidth * 0.5 : PX_PER_S;
      body.scrollLeft += e.key === "ArrowLeft" ? -step : step;
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [PX_PER_S, selected, onZoom, laneHeight, onLaneHeight, arrowOwnerRef, laneMoveKeys]);

  return (
    <div className="pge-timeline split-tl" ref={ref}>
      <div className="ptr-readout mono" ref={readoutRef} style={{ display: "none" }} />
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
            {laneTracks.map((t, i) =>
            <TrackHeader key={t.id} track={t} streams={laneStreams[i]}
              selected={selectedTrack === t.id ||
                        (laneStreams[i].length > 0 && laneStreams[i].every(s => selected.includes(s.id)))}
              height={getH(t.id)} index={i} dragOver={dragOver === i}
              onResizeStart={(e) => startResizeLane(e, t.id)}
              onReorderStart={(e) => startReorder(e, i)}
              onSelect={(multi) => onTrackSelect ? onTrackSelect(t.id, multi) : onSelect(t.streamIds, multi)}
              onRangeSelect={() => onRangeSelect && onRangeSelect(t.streamIds[0])}
              onDoubleSelect={() => onDoubleSelect && onDoubleSelect(t.streamIds[0])}
              onRename={(name) => onTrackRename && onTrackRename(t.id, name)}
              onRemove={() => onTrackRemove && onTrackRemove(t.id)}
              onMute={() => onTrackMute && onTrackMute(t.id)} onSolo={() => onTrackSolo && onTrackSolo(t.id)}
              isEffMuted={isEffMuted} anySolo={anySolo}
              analysers={analysersFor ? analysersFor(t.streamIds) : null} />
            )}
          </div>
        </div>
        <div className="lanes-head-add">
          <button className="add-btn" onClick={() => onCreateStream && onCreateStream({ onset: 0 })}>
            <Icon name="plus" size={12} /> <span className="add-btn-lbl">add stream</span>
          </button>
          <button className="add-btn" onClick={() => onAddTrack && onAddTrack()}
                  title="add an empty track — drop a sample or a clip on it to fill it">
            <Icon name="plus" size={12} /> <span className="add-btn-lbl">add track</span>
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
                 const hasRegion = loopRegion && loopRegion.end > loopRegion.start;
                 if (y <= 12 && hasRegion) {
                   const lx = loopRegion.start * PX_PER_S;
                   const rx = loopRegion.end * PX_PER_S;
                   if (Math.abs(x - lx) <= 6 || Math.abs(x - rx) <= 6) {
                     e.currentTarget.style.cursor = 'ew-resize';
                   } else if (x >= lx && x <= rx) {
                     e.currentTarget.style.cursor = LOOP_CURSOR;
                   } else {
                     e.currentTarget.style.cursor = 'col-resize';
                   }
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
          {laneTracks.map((t, i) => {
            const laneH = getH(t.id);
            /* N clips share one lane and are placed by onset alone, so two of
             * them can cover each other exactly — Ctrl+C / Ctrl+V with the
             * playhead still on the source does it every time, and so does
             * dropping a clip onto an occupied lane at the same position. Fully
             * covered means unreachable: raising the SELECTED clip is no way
             * out, since selecting it means clicking it first.
             * So each row starts a few px lower than the one before, leaving a
             * grabbable strip of everything underneath. The step shrinks to fit
             * the lane instead of pushing the last clip out of it — and with a
             * single clip it is zero, which is the default layout untouched. */
            const n = laneStreams[i].length;
            const step = n > 1
              ? Math.min(CLIP_STACK_STEP, Math.max(0, laneH - CLIP_PAD * 2 - CLIP_MIN_H) / (n - 1))
              : 0;
            const landing = dragIds ? dragIds.filter(id => dstLaneOf(id) === i) : [];
            const isDrop = dragDelta != null ? landing.length > 0 : dragOver === i;
            return (
            <div key={t.id} className={"lane" + (isDrop ? (dropExtract ? " drop-target drop-extract" : " drop-target") : "")} style={{ height: laneH }} onDragOver={onSampleDragOver} onDrop={(e) => { dragEnterCount.current = 0; setSampleDragOver(false); onLaneDrop(e, i); }}
            onClick={(e) => { if (e.target === e.currentTarget) onDeselect?.(); }}>
              {laneStreams[i].map((s, k) => {
              const top = CLIP_PAD + k * step;
              // The children are canvases sized in px: they must follow the
              // clip's own box, not the lane's, or a staggered row draws its
              // waveform past its own bottom edge and gets cropped.
              const clipH = Math.max(1, laneH - top - CLIP_PAD);
              // A clip fades where it is leaving from, not merely because some
              // lane is highlighted: with a delta drag several lanes are both
              // a source and a target at once.
              const ghosting = dragIds && dragIds.includes(s.id) && dstLaneOf(s.id) !== i;
              return (
              <div key={s.id} className={"clip" + (ghosting ? " ghosting" : "") + (selected.includes(s.id) ? " selected" : "") + (s.error ? " error" : "") + (isEffMuted(s) ? " muted" : "") + (s.solo ? " soloed" : "")}
            style={{ left: s.onset * PX_PER_S, width: s.duration * PX_PER_S, top, background: s.color, zIndex: selected.includes(s.id) ? 3 : 1 }}
            onPointerDown={(e) => onPointerDown(e, s, "drag")}
            onPointerMove={selected.includes(s.id) ? (e) => showReadout(e, s) : undefined}
            onPointerLeave={selected.includes(s.id) ? hideReadout : undefined}
            onDoubleClick={() => onDoubleSelect && onDoubleSelect(s.id)}>
                {renderStatusFor ? <ClipRenderStatus status={renderStatusFor(s.id)} /> : null}
                {laneStreams[i].length > 1 ? (
                <div className="clip-ms" onPointerDown={(e) => e.stopPropagation()}>
                  <button className={"pill" + (s.mute ? " on-m" : "")} title="mute this stream"
                          onClick={(e) => { e.stopPropagation(); onUpdate(s.id, { mute: !s.mute }); }}>M</button>
                  <button className={"pill" + (s.solo ? " on-s" : "")} title="solo this stream"
                          onClick={(e) => { e.stopPropagation(); onUpdate(s.id, { solo: !s.solo }); }}>S</button>
                </div>
                ) : null}
                {showClipLabels !== false ? (<>
                <div className="lbl">{s.id} · {s.sample}</div>
                <div className="metaline">d:{(typeof s.density === "number" || typeof s.density === "string") ? s.density : (s.densityEnv ? "env" : "ff " + s.fillFactor)} · {(typeof s.voices.num === "number") ? s.voices.num : "env"}v</div>
                </>) : null}
                {showSpectrograms && spectrogramFor && spectrogramFor(s.id) ?
              <ClipSpectrogram buf={spectrogramFor(s.id)} width={s.duration * PX_PER_S} height={clipH} /> :
              showWaveforms !== false && waveformFor && waveformFor(s.id) ?
              <ClipWaveform peaks={waveformFor(s.id)} width={s.duration * PX_PER_S} height={clipH} color={s.color} /> :
              null}
                {showGrains && grainsFor && grainsFor(s.id) ?
              <ClipGrains data={grainsFor(s.id)} width={s.duration * PX_PER_S} height={clipH} /> :
              null}
                <div className="resize-handle" onPointerDown={(e) => onPointerDown(e, s, "resize")} />
                <div className="lane-resize" onPointerDown={(e) => startResizeLane(e, t.id)} title="drag to resize this track" />
              </div>
              );
              })}
              {landing.length ? landing
                .filter(id => !t.streamIds.includes(id))
                .map(id => streamById.get(id))
                .filter(Boolean)
                .map(s => (
                  <div key={"prev-" + s.id} className={"clip-preview" + (dropExtract ? " extract" : "")}
                       style={{ left: s.onset * PX_PER_S, width: s.duration * PX_PER_S,
                                top: CLIP_PAD, height: Math.max(1, laneH - CLIP_PAD * 2),
                                background: s.color }}>
                    <div className="lbl">{s.id}</div>
                  </div>
                )) : null}
            </div>
            );
          })}
          <div className="comp-end-line" style={{ left: duration * PX_PER_S }} />
          <div className="playhead-line" style={{ left: playhead * PX_PER_S }} />
          <div className="playhead-glow" style={{ left: playhead * PX_PER_S - 7 }} />
          {dragGuides ? (<>
            <div className="drag-guide-v" style={{ left: dragGuides.x0 }} />
            <div className="drag-guide-v" style={{ left: dragGuides.x1 }} />
            <div className="drag-guide-h" style={{ top: dragGuides.top }} />
            <div className="drag-guide-h" style={{ top: dragGuides.bottom }} />
          </>) : null}
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

/* One lane's header. It stands for a TRACK, which may hold several streams.
 *
 * M/S are a fan-out, not new state: the engine filters per stream
 * (Generator._filter_solo_mute) and the YAML carries mute/solo per stream, so
 * a group button reads three-valued (all / some / none) and writes the whole
 * group. For a lane with one clip — still the default — this is byte-identical
 * to the per-stream button it replaces. Per-clip M/S buttons appear on the
 * clips themselves once a lane holds more than one. */
function TrackHeader({ track, streams, selected, onSelect, onRangeSelect, onDoubleSelect, onRename, onRemove, onMute, onSolo, height, onResizeStart, onReorderStart, dragOver, isEffMuted, anySolo, analysers }) {
  const VUMeter = window.PGE?.VUMeter;
  const laneH = typeof height === "number" ? height : 56;
  const [editing, setEditing] = useStateTL(false);
  const ss = streams || [];
  const n = ss.length;
  const allMuted  = n > 0 && ss.every(s => s.mute);
  const someMuted = ss.some(s => s.mute);
  const allSolo   = n > 0 && ss.every(s => s.solo);
  const someSolo  = ss.some(s => s.solo);
  const allEffMuted = n > 0 && ss.every(s => isEffMuted(s));
  const lead = ss[0];
  const sub = n > 1
    ? n + " streams · " + Array.from(new Set(ss.map(s => s.sample))).join(", ")
    : (lead ? lead.sample : "empty");
  // `dim-by-solo` below deliberately reads "none of this lane is soloed": with
  // one stream soloed out of three the lane still sounds, so dimming the whole
  // header would misreport it. The muting of the other two shows on their own
  // clips, which is where per-stream state belongs.
  return (
    <div className={"track-head" + (selected ? " selected" : "") + (allEffMuted ? " muted" : "") + (allSolo ? " soloed" : "") + (anySolo && !someSolo ? " dim-by-solo" : "") + (dragOver ? " drop-target" : "")}
    style={{ borderLeftColor: lead ? lead.color : "transparent", height: height || "var(--lane-h)" }}
    onClick={(e) => { if (e.shiftKey) onRangeSelect && onRangeSelect(); else onSelect(e.ctrlKey || e.metaKey); }}
    onDoubleClick={onDoubleSelect}>
      <div className="grip" onPointerDown={onReorderStart} onClick={(e) => e.stopPropagation()} title="drag to reorder track">
        <span /><span /><span /><span /><span /><span />
      </div>
      <div className="lh">
        <div className="nm-row">
          {editing ? (
            <input className="nm-edit" autoFocus defaultValue={track.name}
                   onClick={(e) => e.stopPropagation()}
                   onPointerDown={(e) => e.stopPropagation()}
                   onBlur={(e) => { setEditing(false); onRename && onRename(e.target.value); }}
                   onKeyDown={(e) => {
                     e.stopPropagation();
                     if (e.key === "Enter") e.target.blur();
                     if (e.key === "Escape") { setEditing(false); }
                   }} />
          ) : (
            <span className="nm" title={n > 1 ? track.streamIds.join(", ") + " — double-click to rename the track" : "double-click to rename the track"}
                  onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
              {track.name}{n > 1 ? <span className="nm-count">{n}</span> : null}
            </span>
          )}
          <button className={"pill" + (allMuted ? " on-m" : someMuted ? " part-m" : "")} onClick={(e) => {e.stopPropagation();onMute();}}
                  title={n > 1 ? "mute every stream on this track" : "mute"}>M</button>
          <button className={"pill" + (allSolo ? " on-s" : someSolo ? " part-s" : "")} onClick={(e) => {e.stopPropagation();onSolo();}}
                  title={n > 1 ? "solo every stream on this track" : "solo"}>S</button>
          {/* An empty lane is the only one that can go: with clips on it,
              removing the lane would either orphan them or delete audio. */}
          {n === 0 ? (
            <button className="pill" onClick={(e) => {e.stopPropagation();onRemove && onRemove();}}
                    title="remove this empty track">×</button>
          ) : null}
        </div>
        <span className="sub" title={sub}>{sub}</span>
      </div>
      {VUMeter && <VUMeter mode="track" analyser={analysers} height={laneH} />}
      <div className="track-head-resize" onPointerDown={onResizeStart} onClick={(e) => e.stopPropagation()} />
    </div>);

}

window.PGE.Timeline = Timeline;