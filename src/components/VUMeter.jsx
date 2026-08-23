/* VUMeter.jsx — canvas-based dBFS meter.
 *
 * mode="master"  stereo L/R bars, reads engine.analysers.left/right
 * mode="track"   mono bar, reads prop `analyser` (AnalyserNode|null)
 *
 * Scale: -60..0 dBFS. Zones: green <-12, yellow -12..-3, red >-3.
 * Peak hold: 2 s then decay at 8 dB/s.
 * Exported as window.PGE.VUMeter.
 */
(function () {
  const { useRef, useEffect } = React;

  const DB_MIN = -60;
  const DB_MAX = 0;
  const PEAK_HOLD_MS = 2000;
  const PEAK_DECAY_DB_S = 8;

  function dbToFrac(db) {
    return Math.max(0, Math.min(1, (db - DB_MIN) / (DB_MAX - DB_MIN)));
  }

  function meanSquare(analyser) {
    const buf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return sum / buf.length;
  }

  /* dBFS of one analyser, or of a GROUP of them.
   *
   * A track lane can hold several streams (PGE-ui #141) and each keeps its own
   * post-gain tap (audio-engine trackAnalysers). There is no summing node to
   * read, so the group level is the sum of the powers — what a bus carrying
   * mutually uncorrelated sources reads, and the only figure available without
   * rebuilding the audio graph for a purely visual meter. */
  function rmsDb(analyser) {
    if (!analyser) return -Infinity;
    const list = Array.isArray(analyser) ? analyser.filter(Boolean) : [analyser];
    if (!list.length) return -Infinity;
    let power = 0;
    for (const a of list) power += meanSquare(a);
    const rms = Math.sqrt(power);
    return rms > 1e-6 ? 20 * Math.log10(rms) : -Infinity;
  }

  function barColor(db) {
    if (db > -3)  return "#e44";
    if (db > -12) return "#db4";
    return "#2da";
  }

  /* ── Master VU (stereo, L/R side-by-side, with dB labels) ── */
  function MasterVU({ height, open }) {
    const canvasRef = useRef(null);
    const rafRef    = useRef(null);
    const peaksRef  = useRef({ L: -Infinity, R: -Infinity, tL: 0, tR: 0 });

    useEffect(() => {
      if (!open) {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const LABEL_W = 24;
      const BAR_W   = 9;
      const GAP     = 4;
      const now     = () => performance.now();

      function draw() {
        const h   = canvas.height;
        const w   = canvas.width;
        const barH = h - 4; // 2px padding top+bottom

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, w, h);

        const analysers = window.PGEAudio?.engine?.analysers;
        const dbL = rmsDb(analysers?.left);
        const dbR = rmsDb(analysers?.right);
        const t   = now();
        const pk  = peaksRef.current;

        // peak update
        if (dbL > pk.L) { pk.L = dbL; pk.tL = t; }
        if (dbR > pk.R) { pk.R = dbR; pk.tR = t; }
        // peak decay after hold
        const decayL = Math.max(0, (t - pk.tL - PEAK_HOLD_MS) / 1000) * PEAK_DECAY_DB_S;
        const decayR = Math.max(0, (t - pk.tR - PEAK_HOLD_MS) / 1000) * PEAK_DECAY_DB_S;
        pk.L = Math.max(DB_MIN, pk.L - decayL * (decayL > 0 ? 1 : 0));
        pk.R = Math.max(DB_MIN, pk.R - decayR * (decayR > 0 ? 1 : 0));

        const xL = LABEL_W;
        const xR = LABEL_W + BAR_W + GAP;

        for (const [db, pkDb, x] of [[dbL, pk.L, xL], [dbR, pk.R, xR]]) {
          // background track
          ctx.fillStyle = "#2a2a2a";
          ctx.fillRect(x, 2, BAR_W, barH);

          if (db > DB_MIN) {
            const filledH = Math.round(dbToFrac(db) * barH);
            const y = 2 + barH - filledH;
            ctx.fillStyle = barColor(db);
            ctx.fillRect(x, y, BAR_W, filledH);
          }

          // peak line
          if (pkDb > DB_MIN) {
            const py = 2 + Math.round((1 - dbToFrac(pkDb)) * barH);
            ctx.fillStyle = pkDb > -3 ? "#f88" : "#fff";
            ctx.fillRect(x, py, BAR_W, 1);
          }
        }

        // L / R channel labels at bottom of each bar
        ctx.fillStyle = "#777";
        ctx.font = "8px monospace";
        ctx.textAlign = "center";
        ctx.fillText("L", xL + BAR_W / 2, h - 1);
        ctx.fillText("R", xR + BAR_W / 2, h - 1);

        // dB scale on left
        ctx.font = "8px monospace";
        ctx.textAlign = "right";
        for (const label of [0, -12, -24, -48]) {
          const py = 2 + Math.round((1 - dbToFrac(label)) * barH);
          ctx.fillStyle = "#3a3a3a";
          ctx.fillRect(LABEL_W, py, BAR_W * 2 + GAP, 1);
          ctx.fillStyle = "#999";
          ctx.fillText(String(label), LABEL_W - 2, py + 3);
        }

        rafRef.current = requestAnimationFrame(draw);
      }

      rafRef.current = requestAnimationFrame(draw);
      return () => cancelAnimationFrame(rafRef.current);
    }, [open]);

    if (!open) return null;

    const LABEL_W = 24;
    const BAR_W   = 9;
    const GAP     = 4;
    const totalW  = LABEL_W + BAR_W * 2 + GAP + 4;

    return (
      <canvas
        ref={canvasRef}
        className="vu-master"
        width={totalW}
        height={height}
        title="Master L/R level (dBFS)"
      />
    );
  }

  /* ── Track VU (mono, narrow strip) ── */
  function TrackVU({ analyser, height }) {
    const canvasRef = useRef(null);
    const rafRef    = useRef(null);
    const peakRef   = useRef({ db: -Infinity, t: 0 });
    // A track lane can pass a GROUP of analysers, rebuilt as a fresh array on
    // every render. Reading it through a ref keeps one rAF loop for the life of
    // the meter — depending on the array would tear the loop down each frame,
    // and depending on its length alone would leave `draw` on a stale copy.
    const analyserRef = useRef(analyser);
    analyserRef.current = analyser;

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const now = () => performance.now();

      function draw() {
        const h = canvas.height;
        const w = canvas.width;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, w, h);

        const db = rmsDb(analyserRef.current);
        const t  = now();
        const pk = peakRef.current;

        if (db > pk.db) { pk.db = db; pk.t = t; }
        const decay = Math.max(0, (t - pk.t - PEAK_HOLD_MS) / 1000) * PEAK_DECAY_DB_S;
        pk.db = Math.max(DB_MIN, pk.db - decay * (decay > 0 ? 1 : 0));

        // background
        ctx.fillStyle = "#1e1e1e";
        ctx.fillRect(0, 0, w, h);

        if (db > DB_MIN) {
          const filledH = Math.round(dbToFrac(db) * h);
          ctx.fillStyle = barColor(db);
          ctx.fillRect(0, h - filledH, w, filledH);
        }

        // peak line
        if (pk.db > DB_MIN) {
          const py = Math.round((1 - dbToFrac(pk.db)) * h);
          ctx.fillStyle = pk.db > -3 ? "#f88" : "#aaa";
          ctx.fillRect(0, py, w, 1);
        }

        rafRef.current = requestAnimationFrame(draw);
      }

      rafRef.current = requestAnimationFrame(draw);
      return () => cancelAnimationFrame(rafRef.current);
    }, []);

    return (
      <canvas
        ref={canvasRef}
        className="vu-track"
        width={6}
        height={height || 56}
        title="Stream level (dBFS)"
      />
    );
  }

  /* ── Public API ── */
  function VUMeter(props) {
    if (props.mode === "track") return <TrackVU {...props} />;
    return <MasterVU {...props} />;
  }

  window.PGE = window.PGE || {};
  window.PGE.VUMeter = VUMeter;
})();
