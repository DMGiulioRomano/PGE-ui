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
 * Summary
 * ============================================================ */
console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
