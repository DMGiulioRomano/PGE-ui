/* grain-map.js
 * Matematica pura per disegnare i grani "in stile score visualizer", condivisa
 * tra il canvas dentro le clip (Timeline.jsx → ClipGrains) e il pannello
 * partitura full-width (GrainScore.jsx). Nessun DOM, nessun fetch: solo funzioni
 * pure (e una `paintGrains` che riceve il context 2D come argomento, quindi
 * testabile con uno stub) — tests/node/test-grain-map.js.
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

  // Estensioni ptr+pitch in un colpo solo. Da chiamare UNA volta quando il JSON
  // arriva dal backend (app.jsx), così il repaint non rifà O(N) ad ogni frame
  // (vedi issue #71, bottleneck 4). I consumatori leggono il risultato cachato.
  function computeExtents(grains) {
    return { ptr: pointerExtent(grains), pit: pitchExtentCents(grains) };
  }

  /* Geometria di un grano in coordinate canvas, senza colore (parte "calda" del
   * loop: nessuna allocazione di stringhe).
   * ctx: { pxPerSec, height, ptrMin, ptrMax, grainHeight? }
   * → { x, y, w, h } */
  function grainGeom(grain, ctx) {
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

    return { x, y, w, h: gh };
  }

  /* Rettangolo di un grano in coordinate canvas.
   * ctx: { pxPerSec, height, ptrMin, ptrMax, pitchLoCents, pitchHiCents,
   *        grainHeight? }
   * → { x, y, w, h, fill }  (fill = stringa rgba pronta per ctx.fillStyle) */
  function grainRect(grain, ctx) {
    const g = grainGeom(grain, ctx);
    const c = pitchColor(grain.pr, ctx.pitchLoCents, ctx.pitchHiCents);
    const a = volToAlpha(grain.vol);
    g.fill = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(3) + ")";
    return g;
  }

  // Default di quantizzazione della LUT colori (issue #71, bottleneck 1+2).
  const LUT_PITCH_BINS = 256;
  const LUT_ALPHA_BINS = 64;

  /* Lookup table di stringhe rgba pre-calcolate, per evitare nel loop per-grano
   * sia i calcoli transcendentali/scansioni (turbo, log2) sia la costruzione di
   * stringhe fresche con toFixed (GC). Quantizza pitch su nPitch livelli (più una
   * riga extra per i grani senza pr → colore di default) e volume su nAlpha.
   *   lut = { nPitch, nAlpha, loCents, hiCents, fills:[...] }
   *   fills[ pitchRow * nAlpha + alphaBin ]  (pitchRow == nPitch → default color)
   * Indicizza con colorBin(pr, vol, lut). */
  function buildColorLUT(loCents, hiCents, nPitch, nAlpha) {
    nPitch = nPitch || LUT_PITCH_BINS;
    nAlpha = nAlpha || LUT_ALPHA_BINS;
    const fills = new Array((nPitch + 1) * nAlpha);
    // Alpha pre-calcolato (stringhe già arrotondate) per ogni bin.
    const alphaStr = new Array(nAlpha);
    for (let a = 0; a < nAlpha; a++) {
      const t = (a + 0.5) / nAlpha;
      alphaStr[a] = (ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t).toFixed(3);
    }
    for (let p = 0; p < nPitch; p++) {
      const c = turbo((p + 0.5) / nPitch);
      const head = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",";
      const row = p * nAlpha;
      for (let a = 0; a < nAlpha; a++) fills[row + a] = head + alphaStr[a] + ")";
    }
    // Riga di default per grani privi di pr valido.
    const d = DEFAULT_PITCH_COLOR;
    const dHead = "rgba(" + d[0] + "," + d[1] + "," + d[2] + ",";
    const dRow = nPitch * nAlpha;
    for (let a = 0; a < nAlpha; a++) fills[dRow + a] = dHead + alphaStr[a] + ")";
    return { nPitch, nAlpha, loCents, hiCents, fills };
  }

  // pr+vol → indice piatto nella LUT (vedi buildColorLUT). Nessuna allocazione.
  function colorBin(pr, vol, lut) {
    const nAlpha = lut.nAlpha, nPitch = lut.nPitch;
    // alpha bin
    if (typeof vol !== "number" || !isFinite(vol)) vol = VOL_MAX_DB;
    let ta = clamp01((vol - VOL_MIN_DB) / (VOL_MAX_DB - VOL_MIN_DB));
    let aBin = (ta * nAlpha) | 0;
    if (aBin >= nAlpha) aBin = nAlpha - 1;
    // pitch row
    const c = ratioToCents(pr);
    if (c === null) return nPitch * nAlpha + aBin;   // riga default
    let tp = 0.5;
    if (lut.hiCents > lut.loCents) tp = clamp01((c - lut.loCents) / (lut.hiCents - lut.loCents));
    let pBin = (tp * nPitch) | 0;
    if (pBin >= nPitch) pBin = nPitch - 1;
    return pBin * nAlpha + aBin;
  }

  /* Pittura batched di una lista di grani su un context 2D (issue #71,
   * bottleneck 1+2). Riceve il ctx come argomento (nessun accesso al DOM →
   * testabile con uno stub che registra le chiamate). Raggruppa i grani per
   * colore quantizzato (LUT) così `fillStyle` cambia una volta per bin invece
   * che una volta per grano, e ogni bin è un singolo beginPath/fill.
   *   ctx     : CanvasRenderingContext2D (o stub)
   *   grains  : array di grani
   *   gctx    : { pxPerSec, height, ptrMin, ptrMax, grainHeight? } (geometria)
   *   pit     : { lo, hi } estensione pitch in cents (per la LUT)
   *   opts    : { offsetX?, laneY?, width? } — offset orizzontale/verticale e
   *             larghezza per il culling (se width omesso, niente culling). */
  function paintGrains(ctx, grains, gctx, pit, opts) {
    if (!grains || !grains.length) return;
    opts = opts || {};
    const offsetX = opts.offsetX || 0;
    const laneY = opts.laneY || 0;
    const W = opts.width;
    const cull = typeof W === "number";
    const lut = buildColorLUT(pit.lo, pit.hi);
    // bucket[bin] = array piatto [x,y,w,h, x,y,w,h, …]
    const buckets = new Map();
    for (let i = 0; i < grains.length; i++) {
      const g = grains[i];
      const geom = grainGeom(g, gctx);
      const x = geom.x + offsetX;
      if (cull && (x > W || x + geom.w < 0)) continue;
      const bin = colorBin(g.pr, g.vol, lut);
      let arr = buckets.get(bin);
      if (!arr) { arr = []; buckets.set(bin, arr); }
      arr.push(x, geom.y + laneY, geom.w, geom.h);
    }
    buckets.forEach((arr, bin) => {
      ctx.fillStyle = lut.fills[bin];
      ctx.beginPath();
      for (let j = 0; j < arr.length; j += 4) {
        ctx.rect(arr[j], arr[j + 1], arr[j + 2], arr[j + 3]);
      }
      ctx.fill();
    });
  }

  window.PGEGrainMap = {
    turbo,
    ratioToCents,
    pitchExtentCents,
    pointerExtent,
    computeExtents,
    volToAlpha,
    pitchColor,
    grainGeom,
    grainRect,
    buildColorLUT,
    colorBin,
    paintGrains,
    DEFAULT_GRAIN_HEIGHT,
    DEFAULT_PITCH_COLOR,
    LUT_PITCH_BINS,
    LUT_ALPHA_BINS,
  };
})();
