/* grain-map.js
 * Matematica pura per disegnare i grani "in stile score visualizer", condivisa
 * tra il canvas dentro le clip (Timeline.jsx → ClipGrains) e il pannello
 * partitura full-width (GrainScore.jsx). Nessun DOM, nessun fetch: solo funzioni
 * pure testabili in node (tests/node/test-grain-map.js).
 *
 * Sorgente dati: sidecar JSON del motore output/<basename>__<sid>__grains.json
 *   { stream_id, duration, num_voices, grains:[{t,dur,vol,ptr,pr,v}, ...] }
 *   t=onset rel. allo stream (s), dur=durata (s), vol=volume (dB),
 *   ptr=pointer pos (unità variabile), pr=pitch_ratio, v=indice voce.
 *
 * Mappatura (replica src/rendering/score_visualizer.py del motore):
 *   X      = t * pxPerSec
 *   larg.  = max(1px, dur * pxPerSec)
 *   Y      = ptr normalizzato per-stream sul min/max effettivo, invertito
 *            (ptr max in alto) → indipendente dall'unità di ptr
 *   colore = pitch via turbo, autozoom in cents con floor (_pitch_to_color,
 *            _compute_pitch_color_range)
 *   alpha  = volume dB -60..0 → 0.3..1.0 (_volume_to_alpha)
 */
(function () {
  // Replica dei default del motore (score_visualizer.py:100-114).
  const VOL_MIN_DB = -60, VOL_MAX_DB = 0;
  const ALPHA_MIN = 0.3, ALPHA_MAX = 1.0;
  const PITCH_MIN_SPAN_CENTS = 50.0;   // floor: ~1 semitono (evita arcobaleno)
  const PITCH_PAD_RATIO = 0.1;         // margine 10% per lato
  const DEFAULT_GRAIN_HEIGHT = 2;      // px: banda sottile per grano
  const DEFAULT_PITCH_COLOR = [160, 160, 160]; // grano privo di pr (retrocompat)

  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

  // Colormap turbo (approssimazione a stop, stesso schema di _specColorTL in
  // Timeline.jsx): t∈[0,1] → [r,g,b]. Blu scuro → ciano → verde → giallo → rosso.
  function turbo(t) {
    t = clamp01(t);
    const stops = [
      [0.00, [48, 18, 59]],
      [0.13, [70, 107, 227]],
      [0.25, [40, 168, 244]],
      [0.38, [24, 220, 197]],
      [0.50, [122, 254, 116]],
      [0.63, [191, 251, 54]],
      [0.75, [253, 195, 40]],
      [0.88, [241, 105, 19]],
      [1.00, [122, 4, 3]],
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
    return [122, 4, 3];
  }

  // pitch_ratio → cents (1200*log2). null se ratio non valido (≤0 / non numero).
  function ratioToCents(pr) {
    if (typeof pr !== "number" || !(pr > 0) || !isFinite(pr)) return null;
    return 1200.0 * Math.log2(pr);
  }

  // Range colore pitch auto-zoomato in cents (replica _compute_pitch_color_range):
  // span = max(estensione, 50 cents), poi padding 10% per lato attorno al centro.
  function pitchExtentCents(grains) {
    let lo = Infinity, hi = -Infinity;
    if (grains) for (let i = 0; i < grains.length; i++) {
      const c = ratioToCents(grains[i].pr);
      if (c === null) continue;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    if (!isFinite(lo) || !isFinite(hi)) {
      return { lo: -PITCH_MIN_SPAN_CENTS / 2, hi: PITCH_MIN_SPAN_CENTS / 2 };
    }
    const center = (lo + hi) / 2;
    const span = Math.max(hi - lo, PITCH_MIN_SPAN_CENTS);
    const half = span / 2 + PITCH_PAD_RATIO * span;
    return { lo: center - half, hi: center + half };
  }

  // Estensione di ptr nello stream (per normalizzare Y). Fallback {0,1} se vuoto.
  function pointerExtent(grains) {
    let min = Infinity, max = -Infinity;
    if (grains) for (let i = 0; i < grains.length; i++) {
      const p = grains[i].ptr;
      if (typeof p !== "number" || !isFinite(p)) continue;
      if (p < min) min = p;
      if (p > max) max = p;
    }
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
    return { min, max };
  }

  // volume (dB) → alpha, clampato (replica _volume_to_alpha).
  function volToAlpha(volDb) {
    if (typeof volDb !== "number" || !isFinite(volDb)) volDb = VOL_MAX_DB;
    const t = clamp01((volDb - VOL_MIN_DB) / (VOL_MAX_DB - VOL_MIN_DB));
    return ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t;
  }

  // pitch_ratio → [r,g,b] dal colormap, normalizzato sul range cents fornito.
  function pitchColor(pr, loCents, hiCents) {
    const c = ratioToCents(pr);
    if (c === null) return DEFAULT_PITCH_COLOR.slice();
    let t = 0.5;
    if (typeof loCents === "number" && typeof hiCents === "number" && hiCents > loCents) {
      t = clamp01((c - loCents) / (hiCents - loCents));
    }
    return turbo(t);
  }

  /* Rettangolo di un grano in coordinate canvas.
   * ctx: { pxPerSec, height, ptrMin, ptrMax, pitchLoCents, pitchHiCents,
   *        grainHeight? }
   * → { x, y, w, h, fill }  (fill = stringa rgba pronta per ctx.fillStyle) */
  function grainRect(grain, ctx) {
    const pxPerSec = ctx.pxPerSec || 0;
    const H = ctx.height || 0;
    const gh = Math.max(1, ctx.grainHeight || DEFAULT_GRAIN_HEIGHT);

    const x = (grain.t || 0) * pxPerSec;
    const w = Math.max(1, (grain.dur || 0) * pxPerSec);

    // Y: ptr normalizzato sul range per-stream, invertito (ptr max in alto).
    let normY = 0.5;
    const span = (ctx.ptrMax - ctx.ptrMin);
    if (span > 0 && typeof grain.ptr === "number" && isFinite(grain.ptr)) {
      normY = clamp01((grain.ptr - ctx.ptrMin) / span);
    }
    let y = (1 - normY) * H - gh / 2;
    if (y < 0) y = 0;
    else if (y + gh > H) y = Math.max(0, H - gh);

    const c = pitchColor(grain.pr, ctx.pitchLoCents, ctx.pitchHiCents);
    const a = volToAlpha(grain.vol);
    const fill = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(3) + ")";

    return { x, y, w, h: gh, fill };
  }

  window.PGEGrainMap = {
    turbo,
    ratioToCents,
    pitchExtentCents,
    pointerExtent,
    volToAlpha,
    pitchColor,
    grainRect,
    DEFAULT_GRAIN_HEIGHT,
    DEFAULT_PITCH_COLOR,
  };
})();
