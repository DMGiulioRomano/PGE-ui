/* @jsx React.createElement */
/* MediaPreview — in-app modal popup for a single refs/ media file.
 * Shows server-computed waveform + spectrogram and plays the file via an
 * isolated <audio> element (NOT the timeline PGEAudio engine). All heavy work
 * (transcode, peak extraction, STFT) runs in server.py; this only paints.
 *
 * Props: { sample, baseUrl, onClose }
 * Attaches window.PGE.MediaPreview. Loaded after SampleBrowser.jsx in
 * PGE Editor.html; references only React + window.PGE.Icon at parse time. */

const { useState: useStateMP, useRef: useRefMP, useEffect: useEffectMP } = React;

// uint8 spectrogram magnitude → [r,g,b], a magma-ish perceptual ramp.
function _specColor(v) {
  const t = v / 255;
  // piecewise: black → indigo → magenta → orange → pale yellow
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

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = (s - m * 60);
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

function MediaPreview({ sample, baseUrl, onClose }) {
  const { Icon } = window.PGE;
  const panelRef = useRefMP(null);
  const waveRef = useRefMP(null);
  const specRef = useRefMP(null);
  const audioRef = useRefMP(null);

  const [waveErr, setWaveErr] = useStateMP(null);
  const [specErr, setSpecErr] = useStateMP(null);
  const [loadingWave, setLoadingWave] = useStateMP(true);
  const [loadingSpec, setLoadingSpec] = useStateMP(true);
  const [playing, setPlaying] = useStateMP(false);
  const [curTime, setCurTime] = useStateMP(0);
  const [duration, setDuration] = useStateMP(0);
  const [hoverTime, setHoverTime] = useStateMP(null);

  const media = window.PGEBackend?.current?.media;
  const audioUrl = media ? media.audioUrl(sample) : `${baseUrl}/media_audio/${encodeURIComponent(sample)}`;
  const peaksUrl = media ? media.peaksUrl(sample) : `${baseUrl}/media_peaks/${encodeURIComponent(sample)}`;
  const specUrl = media ? media.spectrogramUrl(sample) : `${baseUrl}/media_spectrogram/${encodeURIComponent(sample)}`;

  // Keyboard: Space toggles THIS popup's player (not the timeline), Esc closes.
  // Capture phase + stopPropagation so the app's window-level keydown handler
  // (which would otherwise play/pause the timeline) never sees the event.
  useEffectMP(() => {
    function onKey(e) {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        const el = audioRef.current;
        if (el) { if (el.paused) el.play().catch(() => {}); else el.pause(); }
      } else if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Smooth playhead: drive curTime from requestAnimationFrame while playing
  // (onTimeUpdate alone fires only ~4x/sec → visibly choppy).
  useEffectMP(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) setCurTime(el.currentTime || 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // Fetch + draw waveform.
  useEffectMP(() => {
    let cancelled = false;
    setLoadingWave(true); setWaveErr(null);
    (async () => {
      try {
        const res = await fetch(peaksUrl);
        if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
        const peaks = new Float32Array(await res.arrayBuffer());
        if (cancelled) return;
        _drawWave(waveRef.current, peaks);
      } catch (e) {
        if (!cancelled) setWaveErr(e.message);
      } finally {
        if (!cancelled) setLoadingWave(false);
      }
    })();
    return () => { cancelled = true; };
  }, [peaksUrl]);

  // Fetch + draw spectrogram.
  useEffectMP(() => {
    let cancelled = false;
    setLoadingSpec(true); setSpecErr(null);
    (async () => {
      try {
        const res = await fetch(specUrl);
        if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        _drawSpec(specRef.current, buf);
      } catch (e) {
        if (!cancelled) setSpecErr(e.message);
      } finally {
        if (!cancelled) setLoadingSpec(false);
      }
    })();
    return () => { cancelled = true; };
  }, [specUrl]);

  function _drawWave(canvas, peaks) {
    if (!canvas) return;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 90;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const n = peaks.length;
    const per = n / w;
    ctx.strokeStyle = getComputedStyle(canvas).color || "#7fd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const start = Math.floor(x * per);
      const end = Math.min(n, Math.floor((x + 1) * per));
      let peak = 0;
      for (let i = start; i < end; i++) if (peaks[i] > peak) peak = peaks[i];
      const half = peak * mid;
      ctx.moveTo(x + 0.5, mid - half);
      ctx.lineTo(x + 0.5, mid + half);
    }
    ctx.stroke();
  }

  function _drawSpec(canvas, buf) {
    if (!canvas) return;
    const view = new DataView(buf);
    const width = view.getUint32(0, true);
    const height = view.getUint32(4, true);
    const grid = new Uint8Array(buf, 8, width * height);
    // Native-resolution offscreen, then scale onto the visible canvas.
    const off = document.createElement("canvas");
    off.width = width; off.height = height;
    const octx = off.getContext("2d");
    const img = octx.createImageData(width, height);
    for (let c = 0; c < width; c++) {
      for (let f = 0; f < height; f++) {
        const v = grid[c * height + f];
        const [r, g, b] = _specColor(v);
        // low freq at bottom: y = height-1-f
        const y = height - 1 - f;
        const p = (y * width + c) * 4;
        img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = b; img.data[p + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 220;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(off, 0, 0, width, height, 0, 0, w, h);
  }

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  }

  function seekFromEvent(e) {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = frac * duration;
    setCurTime(el.currentTime);
  }

  function hoverFromEvent(e) {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverTime(frac * duration);
  }

  const playheadPct = duration ? (curTime / duration) * 100 : 0;

  return (
    <div className="sp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sp-panel mp-panel" ref={panelRef} role="dialog" aria-label="Media preview">
        <div className="sp-head">
          <span className="sp-title mono">{sample}</span>
          <button className="sp-close" onClick={onClose} aria-label="close"><Icon name="x" size={12} /></button>
        </div>

        <div className="mp-body">
          <div className="mp-sec">
            <div className="mp-sec-label">waveform</div>
            <div className="mp-canvas-wrap" onClick={seekFromEvent} onMouseMove={hoverFromEvent} onMouseLeave={() => setHoverTime(null)}>
              <canvas ref={waveRef} className="mp-canvas mp-wave" />
              {playheadPct > 0 || duration ? <div className="mp-playhead" style={{ left: playheadPct + "%" }} /> : null}
              {loadingWave ? <div className="mp-status">computing waveform…</div> : null}
              {waveErr ? <div className="mp-status mp-err">{waveErr}</div> : null}
            </div>
          </div>

          <div className="mp-sec">
            <div className="mp-sec-label">spectrogram</div>
            <div className="mp-canvas-wrap" onClick={seekFromEvent} onMouseMove={hoverFromEvent} onMouseLeave={() => setHoverTime(null)}>
              <canvas ref={specRef} className="mp-canvas mp-spec" />
              {duration ? <div className="mp-playhead" style={{ left: playheadPct + "%" }} /> : null}
              {loadingSpec ? <div className="mp-status">computing spectrogram…</div> : null}
              {specErr ? <div className="mp-status mp-err">{specErr}</div> : null}
            </div>
          </div>

          <div className="mp-transport">
            <button className="mp-play" onClick={togglePlay} aria-label={playing ? "pause" : "play"}>
              <Icon name={playing ? "pause" : "play"} size={14} />
            </button>
            <span className="mp-time mono">{fmtTime(curTime)} / {fmtTime(duration)}</span>
            {hoverTime != null ? <span className="mp-hover-time mono">↳ {fmtTime(hoverTime)}</span> : null}
          </div>

          <audio
            ref={audioRef}
            src={audioUrl}
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          />
        </div>
      </div>
    </div>
  );
}

window.PGE.MediaPreview = MediaPreview;
