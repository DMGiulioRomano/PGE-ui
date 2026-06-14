/* =============================================================================
 * test-grain-map.js — test della matematica pura di grain-map.js
 * (window.PGEGrainMap): estensioni ptr/pitch, turbo, vol→alpha, grainRect.
 *
 * Run: node test-grain-map.js (da tests/node/)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// Shim: grain-map.js fa `window.PGEGrainMap = {...}` dentro una IIFE.
global.window = {};
eval(fs.readFileSync(path.join(__dirname, "../../grain-map.js"), "utf8"));

const GM = window.PGEGrainMap;

/* ---------- micro test runner ---------- */

let pass = 0, fail = 0;

function assert(label, cond, extra) {
  if (cond) {
    pass++;
    console.log("  OK  " + label);
  } else {
    fail++;
    console.error("FAIL  " + label + (extra ? "\n      " + extra : ""));
  }
}

function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }
function maxChanDiff(c0, c1) {
  return Math.max(Math.abs(c0[0] - c1[0]), Math.abs(c0[1] - c1[1]), Math.abs(c0[2] - c1[2]));
}

/* ============================================================
 * 1. pointerExtent
 * ============================================================ */
{
  const e = GM.pointerExtent([{ ptr: 5 }, { ptr: 1 }, { ptr: 9 }]);
  assert("pointerExtent — min/max su valori misti", e.min === 1 && e.max === 9, JSON.stringify(e));

  const empty = GM.pointerExtent([]);
  assert("pointerExtent — lista vuota → fallback {0,1}", empty.min === 0 && empty.max === 1, JSON.stringify(empty));

  const nul = GM.pointerExtent(null);
  assert("pointerExtent — null → fallback {0,1}", nul.min === 0 && nul.max === 1, JSON.stringify(nul));

  const eq = GM.pointerExtent([{ ptr: 3 }, { ptr: 3 }]);
  assert("pointerExtent — tutti uguali → min==max", eq.min === 3 && eq.max === 3, JSON.stringify(eq));
}

/* ============================================================
 * 2. tempo → x  (e floor larghezza ≥ 1px)
 * ============================================================ */
{
  const base = { pxPerSec: 36, height: 100, ptrMin: 0, ptrMax: 1, pitchLoCents: -30, pitchHiCents: 30 };
  const r0 = GM.grainRect({ t: 0, dur: 1, ptr: 0.5, pr: 1, vol: 0 }, base);
  assert("grainRect — t=0 → x=0", r0.x === 0, String(r0.x));

  const r2 = GM.grainRect({ t: 2, dur: 1, ptr: 0.5, pr: 1, vol: 0 }, base);
  assert("grainRect — t=2, pxPerSec=36 → x=72", r2.x === 72, String(r2.x));

  const tiny = GM.grainRect({ t: 0, dur: 0.0001, ptr: 0.5, pr: 1, vol: 0 }, base);
  assert("grainRect — durata minuscola → w≥1 (floor)", tiny.w === 1, String(tiny.w));
}

/* ============================================================
 * 3. ptr → y  : invarianza all'unità (secondi vs frazione)
 * ============================================================ */
{
  const grainsSec  = [{ ptr: 0 }, { ptr: 5 }, { ptr: 10 }];
  const grainsFrac = [{ ptr: 0 }, { ptr: 0.5 }, { ptr: 1.0 }];
  const eSec  = GM.pointerExtent(grainsSec);
  const eFrac = GM.pointerExtent(grainsFrac);

  const ctxSec  = { pxPerSec: 10, height: 100, ptrMin: eSec.min,  ptrMax: eSec.max,  pitchLoCents: -30, pitchHiCents: 30, grainHeight: 2 };
  const ctxFrac = { pxPerSec: 10, height: 100, ptrMin: eFrac.min, ptrMax: eFrac.max, pitchLoCents: -30, pitchHiCents: 30, grainHeight: 2 };

  const ySec  = GM.grainRect({ t: 0, dur: 0, ptr: 5,   pr: 1, vol: 0 }, ctxSec).y;
  const yFrac = GM.grainRect({ t: 0, dur: 0, ptr: 0.5, pr: 1, vol: 0 }, ctxFrac).y;
  assert("grainRect — ptr a metà: stesso y in secondi e frazione", ySec === yFrac, ySec + " vs " + yFrac);

  // ptr max in alto (y minore), ptr min in basso (y maggiore).
  const yMax = GM.grainRect({ t: 0, dur: 0, ptr: 10, pr: 1, vol: 0 }, ctxSec).y;
  const yMin = GM.grainRect({ t: 0, dur: 0, ptr: 0,  pr: 1, vol: 0 }, ctxSec).y;
  assert("grainRect — ptr max più in alto di ptr min", yMax < yMin, yMax + " < " + yMin);

  // span nullo (tutti uguali) → y finito, niente NaN.
  const flat = GM.grainRect({ t: 0, dur: 0, ptr: 3, pr: 1, vol: 0 },
    { pxPerSec: 10, height: 100, ptrMin: 3, ptrMax: 3, pitchLoCents: -30, pitchHiCents: 30, grainHeight: 2 });
  assert("grainRect — span ptr nullo → y finito (no div/0)", isFinite(flat.y), String(flat.y));
}

/* ============================================================
 * 4. pitch → turbo  (estremi distinti, clamp, floor 50 cents)
 * ============================================================ */
{
  const c0 = GM.turbo(0), cHalf = GM.turbo(0.5), c1 = GM.turbo(1);
  assert("turbo — 3 canali interi 0..255", c0.length === 3 && c0.every(v => Number.isInteger(v) && v >= 0 && v <= 255), JSON.stringify(c0));
  assert("turbo — estremi distinti (0 vs 1)", maxChanDiff(c0, c1) > 50, JSON.stringify([c0, c1]));
  assert("turbo — metà distinta dagli estremi", maxChanDiff(c0, cHalf) > 20 && maxChanDiff(cHalf, c1) > 20);
  assert("turbo — clamp sotto 0", maxChanDiff(GM.turbo(-1), c0) === 0);
  assert("turbo — clamp sopra 1", maxChanDiff(GM.turbo(2), c1) === 0);

  // ratioToCents
  assert("ratioToCents — 1.0 → 0 cents", GM.ratioToCents(1.0) === 0);
  assert("ratioToCents — 2.0 → 1200 cents", approx(GM.ratioToCents(2.0), 1200, 1e-9));
  assert("ratioToCents — ratio non valido → null", GM.ratioToCents(0) === null && GM.ratioToCents(undefined) === null);

  // reverse: pr negativo → colorato per |pr| (parità con score_visualizer.py, che usa abs).
  assert("ratioToCents — pr negativo (reverse) → |pr| in cents", approx(GM.ratioToCents(-2.0), 1200, 1e-9));
  assert("ratioToCents — reverse a ratio 1 → 0 cents", GM.ratioToCents(-1.0) === 0);
  assert("ratioToCents — 0 resta null (guard, no log2(0))", GM.ratioToCents(0) === null);
  assert("ratioToCents — -Infinity resta null (guard)", GM.ratioToCents(-Infinity) === null);

  // floor 50 cents: due grani quasi identici → colori vicini (no arcobaleno).
  // Verifica relativa: col floor i colori sono molto più vicini che senza floor
  // (dove 1.7 cents di scarto coprirebbero l'intera colormap).
  const grains = [{ pr: 1.0 }, { pr: 1.001 }];
  const ext = GM.pitchExtentCents(grains);
  const colA = GM.pitchColor(1.0, ext.lo, ext.hi);
  const colB = GM.pitchColor(1.001, ext.lo, ext.hi);
  const flooredDiff = maxChanDiff(colA, colB);
  // Senza floor: range = solo min/max reale dei cents (estremi della colormap).
  const rawLo = GM.ratioToCents(1.0), rawHi = GM.ratioToCents(1.001);
  const noFloorDiff = maxChanDiff(GM.pitchColor(1.0, rawLo, rawHi), GM.pitchColor(1.001, rawLo, rawHi));
  assert("pitchExtentCents — span minimo applicato (≥50c + padding)", (ext.hi - ext.lo) >= 50, JSON.stringify(ext));
  assert("pitchColor — floor comprime la micro-variazione", flooredDiff < noFloorDiff * 0.5,
    "floored=" + flooredDiff + " noFloor=" + noFloorDiff);

  // estensione vuota → range simmetrico di default, niente crash.
  const extEmpty = GM.pitchExtentCents([]);
  assert("pitchExtentCents — vuoto → range finito simmetrico", isFinite(extEmpty.lo) && isFinite(extEmpty.hi) && extEmpty.lo < extEmpty.hi, JSON.stringify(extEmpty));

  // reverse: i grani con pr<0 entrano nel range via |pr| (prima venivano scartati →
  // fallback simmetrico). |−2| → 1200 cents deve cadere dentro l'estensione.
  const extRev = GM.pitchExtentCents([{ pr: -2.0 }]);
  assert("pitchExtentCents — reverse incluso via |pr| (1200c nel range)",
    isFinite(extRev.lo) && isFinite(extRev.hi) && extRev.hi > extRev.lo &&
    1200 >= extRev.lo && 1200 <= extRev.hi, JSON.stringify(extRev));
  const revCol = GM.pitchColor(-1.5, extRev.lo, extRev.hi);
  assert("pitchColor — reverse NON è il grigio di default",
    !(revCol[0] === 160 && revCol[1] === 160 && revCol[2] === 160), JSON.stringify(revCol));
}

/* ============================================================
 * 5. volume → alpha
 * ============================================================ */
{
  assert("volToAlpha — 0 dB → 1.0", approx(GM.volToAlpha(0), 1.0));
  assert("volToAlpha — -60 dB → 0.3", approx(GM.volToAlpha(-60), 0.3));
  assert("volToAlpha — -30 dB → 0.65", approx(GM.volToAlpha(-30), 0.65));
  assert("volToAlpha — +6 dB → clamp 1.0", approx(GM.volToAlpha(6), 1.0));
  assert("volToAlpha — -120 dB → clamp 0.3", approx(GM.volToAlpha(-120), 0.3));
}

/* ============================================================
 * 6. grainRect integrato
 * ============================================================ */
{
  const ctx = { pxPerSec: 36, height: 100, ptrMin: 0, ptrMax: 10, pitchLoCents: -30, pitchHiCents: 30, grainHeight: 2 };
  const r = GM.grainRect({ t: 2, dur: 0.5, vol: 0, ptr: 5, pr: 1.0 }, ctx);
  assert("grainRect — x", r.x === 72, String(r.x));
  assert("grainRect — w", r.w === 18, String(r.w));
  assert("grainRect — y (ptr a metà, centrato)", r.y === 49, String(r.y));
  assert("grainRect — h", r.h === 2, String(r.h));
  assert("grainRect — fill rgba a piena opacità a 0 dB", /^rgba\(\d+,\d+,\d+,1\.000\)$/.test(r.fill), r.fill);
}

/* ============================================================
 * 7. grano senza pr (retrocompat JSON vecchi)
 * ============================================================ */
{
  const ctx = { pxPerSec: 36, height: 100, ptrMin: 0, ptrMax: 10, pitchLoCents: -30, pitchHiCents: 30 };
  const r = GM.grainRect({ t: 0, dur: 0.1, vol: 0, ptr: 5 }, ctx);
  assert("grainRect — grano senza pr → colore di default deterministico", r.fill.indexOf("160,160,160") >= 0, r.fill);
  const col = GM.pitchColor(undefined, -30, 30);
  assert("pitchColor — pr assente → DEFAULT_PITCH_COLOR", col[0] === 160 && col[1] === 160 && col[2] === 160, JSON.stringify(col));
}

/* ============================================================
 * 8. computeExtents — cache ptr+pitch in un colpo (bottleneck 4)
 * ============================================================ */
{
  const grains = [{ ptr: 1, pr: 1.0 }, { ptr: 9, pr: 2.0 }];
  const ext = GM.computeExtents(grains);
  assert("computeExtents — ptr coerente con pointerExtent",
    ext.ptr.min === 1 && ext.ptr.max === 9, JSON.stringify(ext.ptr));
  const pit = GM.pitchExtentCents(grains);
  assert("computeExtents — pit coerente con pitchExtentCents",
    ext.pit.lo === pit.lo && ext.pit.hi === pit.hi, JSON.stringify(ext.pit));
}

/* ============================================================
 * 9. grainGeom — geometria senza colore (== grainRect senza fill)
 * ============================================================ */
{
  const ctx = { pxPerSec: 36, height: 100, ptrMin: 0, ptrMax: 10, grainHeight: 2 };
  const g = GM.grainGeom({ t: 2, dur: 0.5, ptr: 5 }, ctx);
  const r = GM.grainRect({ t: 2, dur: 0.5, ptr: 5, pr: 1.0, vol: 0 },
    { ...ctx, pitchLoCents: -30, pitchHiCents: 30 });
  assert("grainGeom — x/y/w/h identici a grainRect",
    g.x === r.x && g.y === r.y && g.w === r.w && g.h === r.h, JSON.stringify([g, r]));
  assert("grainGeom — nessun campo fill", g.fill === undefined, JSON.stringify(g));
}

/* ============================================================
 * 10. buildColorLUT + colorBin (bottleneck 1+2)
 * ============================================================ */
{
  const lut = GM.buildColorLUT(-30, 30, 256, 64);
  assert("buildColorLUT — dimensione fills = (nPitch+1)*nAlpha",
    lut.fills.length === (256 + 1) * 64, String(lut.fills.length));
  assert("buildColorLUT — ogni entry è una stringa rgba",
    lut.fills.every(f => /^rgba\(\d+,\d+,\d+,[\d.]+\)$/.test(f)), lut.fills[0]);

  // default bins: pr assente → riga di default (160,160,160).
  const dBin = GM.colorBin(undefined, 0, lut);
  assert("colorBin — pr assente → riga default", dBin >= 256 * 64 && dBin < 257 * 64, String(dBin));
  assert("colorBin — riga default usa DEFAULT_PITCH_COLOR",
    lut.fills[dBin].indexOf("160,160,160") === 5, lut.fills[dBin]);

  // pr valido → riga non-default; pitch più alto → bin più alto.
  const loBin = GM.colorBin(1.0, 0, lut);   // centro range (0 cents)
  assert("colorBin — pr valido non finisce in riga default", loBin < 256 * 64, String(loBin));
  const cents = (b) => Math.floor(b / 64);
  const bA = GM.colorBin(0.5, 0, lut);   // -1200 cents → clamp basso
  const bB = GM.colorBin(2.0, 0, lut);   // +1200 cents → clamp alto
  assert("colorBin — pitch basso < pitch alto (pitch row)", cents(bA) < cents(bB),
    cents(bA) + " vs " + cents(bB));

  // volume più alto → alpha bin più alto (a parità di pitch).
  const aLow = GM.colorBin(1.0, -60, lut) % 64;
  const aHigh = GM.colorBin(1.0, 0, lut) % 64;
  assert("colorBin — volume alto → alpha bin più alto", aHigh > aLow, aHigh + " vs " + aLow);

  // clamp: nessun bin fuori range.
  const huge = GM.colorBin(1000, 100, lut);
  assert("colorBin — clamp dentro fills", huge >= 0 && huge < lut.fills.length, String(huge));

  // reverse: pr negativo → riga NON di default (colorato per |pr|, non grigio).
  const revBin = GM.colorBin(-1.5, 0, lut);
  assert("colorBin — pr negativo (reverse) non finisce in riga default", revBin < 256 * 64, String(revBin));

  // default dei parametri.
  const lut2 = GM.buildColorLUT(-30, 30);
  assert("buildColorLUT — default nPitch/nAlpha",
    lut2.nPitch === GM.LUT_PITCH_BINS && lut2.nAlpha === GM.LUT_ALPHA_BINS,
    lut2.nPitch + "x" + lut2.nAlpha);
}

/* ============================================================
 * 11. paintGrains — batching su ctx stub (bottleneck 1)
 * ============================================================ */
{
  function makeStub() {
    const calls = { fillStyle: [], beginPath: 0, rect: 0, fill: 0 };
    let cur = null;
    return {
      calls,
      set fillStyle(v) { cur = v; calls.fillStyle.push(v); },
      get fillStyle() { return cur; },
      beginPath() { calls.beginPath++; },
      rect() { calls.rect++; },
      fill() { calls.fill++; },
    };
  }
  const gctx = { pxPerSec: 10, height: 100, ptrMin: 0, ptrMax: 1, grainHeight: 2 };
  const pit = { lo: -30, hi: 30 };

  // Tutti i grani con stesso colore quantizzato → un solo fillStyle/beginPath/fill.
  const same = [];
  for (let i = 0; i < 50; i++) same.push({ t: i * 0.01, dur: 0.001, ptr: 0.5, pr: 1.0, vol: 0 });
  const stub1 = makeStub();
  GM.paintGrains(stub1, same, gctx, pit, { width: 1000 });
  assert("paintGrains — N grani stesso colore → 1 solo bin",
    stub1.calls.fillStyle.length === 1 && stub1.calls.beginPath === 1 && stub1.calls.fill === 1,
    JSON.stringify(stub1.calls));
  assert("paintGrains — un rect per grano", stub1.calls.rect === 50, String(stub1.calls.rect));

  // Colori diversi (pitch agli estremi) → bin distinti.
  const diff = [
    { t: 0, dur: 0.001, ptr: 0.5, pr: 0.5, vol: 0 },
    { t: 0.1, dur: 0.001, ptr: 0.5, pr: 2.0, vol: 0 },
  ];
  const stub2 = makeStub();
  GM.paintGrains(stub2, diff, gctx, pit, { width: 1000 });
  assert("paintGrains — pitch diversi → 2 bin (2 fillStyle/beginPath/fill)",
    stub2.calls.fillStyle.length === 2 && stub2.calls.beginPath === 2 && stub2.calls.fill === 2,
    JSON.stringify(stub2.calls));

  // Culling orizzontale: grano fuori vista non viene disegnato.
  const stub3 = makeStub();
  GM.paintGrains(stub3, [{ t: 100, dur: 0.001, ptr: 0.5, pr: 1.0, vol: 0 }], gctx, pit, { width: 50 });
  assert("paintGrains — grano fuori vista cullato (nessun rect)", stub3.calls.rect === 0, String(stub3.calls.rect));

  // Lista vuota → no-op.
  const stub4 = makeStub();
  GM.paintGrains(stub4, [], gctx, pit, { width: 50 });
  assert("paintGrains — lista vuota → no-op", stub4.calls.beginPath === 0 && stub4.calls.fill === 0, JSON.stringify(stub4.calls));
}

/* ============================================================
 * N. selectGrainRefetch — quali stream rifetchare dopo un render (#73)
 *   loaded = Set di stream con grani già in memoria
 *   regen  = Set di stream rigenerati dal motore (cached=false → JSON riscritto)
 *   regola: refetch sse  NON loaded  OPPURE  rigenerato
 * ============================================================ */
{
  // Primo load: niente in memoria, nessun render → fetch di tutti gli stem.
  const all = GM.selectGrainRefetch(["a", "b"], new Set(), new Set());
  assert("selectGrainRefetch — mai caricati → fetch di tutti",
    all.length === 2 && all.includes("a") && all.includes("b"), JSON.stringify(all));

  // Tutti già caricati e nessun rigenerato (es. toggle vista, nessun render) →
  // nessun fetch.
  const clean = GM.selectGrainRefetch(["a", "b"], new Set(["a", "b"]), new Set());
  assert("selectGrainRefetch — caricati e non rigenerati → nessun fetch",
    clean.length === 0, JSON.stringify(clean));

  // Cache ON, un solo stream rigenerato → refetch solo quello, i clean restano.
  const one = GM.selectGrainRefetch(["a", "b"], new Set(["a", "b"]), new Set(["b"]));
  assert("selectGrainRefetch — un rigenerato → solo quello",
    one.length === 1 && one[0] === "b", JSON.stringify(one));

  // Cache OFF: il motore rigenera tutto → tutti rifetchati anche se già caricati.
  const allRegen = GM.selectGrainRefetch(["a", "b"], new Set(["a", "b"]), new Set(["a", "b"]));
  assert("selectGrainRefetch — cache OFF (tutti rigenerati) → fetch di tutti",
    allRegen.length === 2, JSON.stringify(allRegen));

  // Misto: non-caricati + rigenerati, ordine preservato.
  const mixed = GM.selectGrainRefetch(["a", "b", "c"], new Set(["a"]), new Set(["a"]));
  assert("selectGrainRefetch — misto (rigenerato + mai caricati)",
    mixed.length === 3 && mixed[0] === "a" && mixed[1] === "b" && mixed[2] === "c", JSON.stringify(mixed));

  // Sottoinsieme: tutti caricati, solo uno rigenerato → solo quello.
  const sub = GM.selectGrainRefetch(["a", "b", "c"], new Set(["a", "b", "c"]), new Set(["c"]));
  assert("selectGrainRefetch — caricati, un rigenerato → sottoinsieme",
    sub.length === 1 && sub[0] === "c", JSON.stringify(sub));

  // Nessuno stream con stem → array vuoto.
  const none = GM.selectGrainRefetch([], new Set(["a"]), new Set());
  assert("selectGrainRefetch — nessuno stream → []", none.length === 0, JSON.stringify(none));

  // Argomenti mancanti (difensivo): non deve lanciare; in dubbio rifetcha.
  let threw = false, r = [];
  try { r = GM.selectGrainRefetch(["a"], null, null); } catch (e) { threw = true; }
  assert("selectGrainRefetch — loaded/regen null → fetch senza eccezioni",
    !threw && r.length === 1 && r[0] === "a", JSON.stringify({ threw, r }));
}

/* ============================================================
 * Summary
 * ============================================================ */
console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
