/* =============================================================================
 * test-bounds.js — tests for the engine→UI bounds mapping in bounds.js
 * (window.PGEBounds). The bridge's /bounds endpoint returns the engine's raw
 * GRANULAR_PARAMETERS + pitch records; mergeEngineBounds folds them into the
 * UI's window.PGE_BOUNDS (static fallback), and apply() installs the result.
 *
 * Run: node test-bounds.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

// yaml-bridge.js publishes window.PGE_BOUNDS (the static fallback); bounds.js
// publishes window.PGEBounds. js-yaml is required by yaml-bridge at load.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/bounds.js"), "utf8"));

const B = window.PGEBounds;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

console.log("\n── module surface ──");
assert("PGEBounds exposes mergeEngineBounds + apply + resolveOutputSr + ENGINE_PARAM_MAP",
  typeof B.mergeEngineBounds === "function" &&
  typeof B.apply === "function" &&
  typeof B.resolveOutputSr === "function" &&
  B.ENGINE_PARAM_MAP && typeof B.ENGINE_PARAM_MAP === "object");

console.log("\n── static fallback keys present in PGE_BOUNDS ──");
const NEEDED = ["volume","volumeRange","pan","panRange","fillFactor","offsetRange",
  "density","distribution","speedRatio","grainDur","durationRange",
  "loopStart","loopDur","loopEnd","voicesNum","scatter",
  "voicePitchOffset","voicePointerOffset","voicePointerRange"];
assert("all mapped UI keys have a static fallback",
  NEEDED.every(k => window.PGE_BOUNDS[k] && typeof window.PGE_BOUNDS[k].min === "number"),
  NEEDED.filter(k => !window.PGE_BOUNDS[k]).join(", "));
assert("pitch fallback present (semitones/cents/ratio)",
  window.PGE_BOUNDS.pitch && window.PGE_BOUNDS.pitch.semitones &&
  window.PGE_BOUNDS.pitch.cents && window.PGE_BOUNDS.pitch.ratio);
assert("every ENGINE_PARAM_MAP key has a fallback in PGE_BOUNDS",
  Object.keys(B.ENGINE_PARAM_MAP).every(k => window.PGE_BOUNDS[k]),
  Object.keys(B.ENGINE_PARAM_MAP).filter(k => !window.PGE_BOUNDS[k]).join(", "));

console.log("\n── mergeEngineBounds (value vs range fields) ──");
const raw = {
  params: {
    density:           { min_val: 0.5,  max_val: 2000, min_range: 0, max_range: 0,   default_jitter: 0,    variation_mode: "additive" },
    volume:            { min_val: -90,  max_val: 6,    min_range: 0, max_range: 18,  default_jitter: 3,    variation_mode: "additive" },
    grain_duration:    { min_val: 0.002,max_val: 5,    min_range: 0, max_range: 0.8, default_jitter: 0.01, variation_mode: "additive" },
    pointer_deviation: { min_val: -1,   max_val: 1,    min_range: 0, max_range: 1,   default_jitter: 0.05, variation_mode: "additive" },
    loop_dur:          { min_val: 0.01, max_val: null, min_range: 0, max_range: 0,   default_jitter: 0,    variation_mode: "additive" },
    num_voices:        { min_val: 1,    max_val: 256,  min_range: 0, max_range: 0,   default_jitter: 0,    variation_mode: "additive" },
  },
  pitch: {
    semitones: { min: -24, max: 24, rangeMax: 24 },
    ratio:     { min: 0.002, max: 7, rangeMax: 3 },
    edoFactor: 4,
  },
};

const baseDensityMax = window.PGE_BOUNDS.density.max;     // capture fallback before merge
const baseLoopDurMax = window.PGE_BOUNDS.loopDur.max;
const baseScatterMax = window.PGE_BOUNDS.scatter.max;
const baseCentsMax   = window.PGE_BOUNDS.pitch.cents.max;
const out = B.mergeEngineBounds(window.PGE_BOUNDS, raw);

assert("density ← density.value (min/max)", out.density.min === 0.5 && out.density.max === 2000);
assert("volume ← volume.value",             out.volume.min === -90 && out.volume.max === 6);
assert("volumeRange ← volume.RANGE",        out.volumeRange.min === 0 && out.volumeRange.max === 18);
assert("grainDur ← grain_duration.value",   out.grainDur.max === 5);
// PGE #158: il min reale di grain_duration è 1 campione (1/output_sr). L'engine
// espone via /bounds solo il min statico (1 ms); l'override dinamico non è
// visibile all'AST-parser, quindi lo applichiamo lato UI.
// Il sample rate si legge da window e non si riscrive 48000: qui il payload non
// ne porta uno, quindi vince il fallback statico, ed è quello il numero atteso.
// Che il fallback sia poi il numero GIUSTO lo pretende la parità — questa suite
// gira senza motore e non ha modo di saperlo. Due domande, due posti.
assert("grainDur.min floored to 1 sample despite engine 0.002",
  Math.abs(out.grainDur.min - 1 / window.PGE_OUTPUT_SR) < 1e-12, String(out.grainDur.min));
assert("static fallback grainDur.min is 1 sample",
  Math.abs(window.PGE_BOUNDS.grainDur.min - 1 / window.PGE_OUTPUT_SR) < 1e-12,
  String(window.PGE_BOUNDS.grainDur.min));
assert("durationRange ← grain_duration.RANGE (0..0.8)", out.durationRange.min === 0 && out.durationRange.max === 0.8);
// Il fallback statico deve dire lo stesso cap del motore (max_range = 1.0), non
// max_val: su file:// o con il server giù è l'unico clamp che la UI ha, e a 10
// lascerebbe scrivere una banda che _calculate_range taglia in silenzio.
assert("fallback statico durationRange = max_range del motore",
  window.PGE_BOUNDS.durationRange.max === 1, JSON.stringify(window.PGE_BOUNDS.durationRange));
assert("offsetRange ← pointer_deviation.RANGE (0..1)",  out.offsetRange.min === 0 && out.offsetRange.max === 1);
assert("loopDur.min ← loop_dur.value",      out.loopDur.min === 0.01);
assert("loopDur.max null → keeps fallback (sample-driven)", out.loopDur.max === baseLoopDurMax);
assert("voicesNum ← num_voices.value (1..256)", out.voicesNum.min === 1 && out.voicesNum.max === 256);
assert("voicesNum static fallback is 1..256 (PGE #145)", window.PGE_BOUNDS.voicesNum.min === 1 && window.PGE_BOUNDS.voicesNum.max === 256);

console.log("\n── mergeEngineBounds (pitch) ──");
assert("pitch.semitones ← engine", out.pitch.semitones.max === 24 && out.pitch.semitones.min === -24);
assert("pitch.ratio ← engine (rangeMax)", out.pitch.ratio.rangeMax === 3);
assert("pitch.edoFactor ← engine", out.pitch.edoFactor === 4);
assert("pitch unit absent from raw keeps fallback (cents)", out.pitch.cents.max === baseCentsMax);

/* Il bridge NON deve mandare numeri quando non ha letto niente: `edoFactor`,
 * `ratio` e la tabella dei preset avevano tre ripieghi trascritti in
 * engine_introspect.py, che arrivavano qui etichettati come verita' del
 * motore e vincevano sul fallback statico. Ora quelle chiavi mancano, ed e'
 * questo lato a dover trattare l'assenza come "non lo so" — la parita' non
 * puo' vederlo, perche' col motore vero i due lati coincidono. */
{
  const baseEdo   = window.PGE_BOUNDS.pitch.edoFactor;
  const baseRatio = window.PGE_BOUNDS.pitch.ratio.min;
  const partial = B.mergeEngineBounds(window.PGE_BOUNDS, { params: {}, pitch: {} });
  assert("pitch vuoto → edoFactor resta quello statico",
    partial.pitch.edoFactor === baseEdo,
    `${partial.pitch.edoFactor} contro ${baseEdo}`);
  assert("pitch vuoto → ratio resta quello statico",
    partial.pitch.ratio.min === baseRatio);
  assert("pitch vuoto → le unita' EDO restano quelle statiche",
    partial.pitch.cents.max === baseCentsMax);
}

console.log("\n── fallback preserved, base not mutated ──");
assert("key without engine data keeps fallback (scatter)", out.scatter.max === baseScatterMax);
assert("mergeEngineBounds does NOT mutate base", window.PGE_BOUNDS.density.max === baseDensityMax);
assert("empty raw → clone equal to base", B.mergeEngineBounds(window.PGE_BOUNDS, {}).density.max === baseDensityMax);
assert("null raw → no crash, clone of base", B.mergeEngineBounds(window.PGE_BOUNDS, null).density.max === baseDensityMax);

console.log("\n── read_direction (PGE #207) ──");
{
  // La chiave arriva da /bounds con min_val/max_val = -1/+1. Il mapping serve
  // a farla atterrare su window.PGE_BOUNDS come gli altri controlli; il
  // vincolo vero — SOLO i due estremi, non l'intervallo — non è esprimibile
  // qui e vive in PGEEnvUtils.snapDirection.
  assert("read_direction è mappato su ENGINE_PARAM_MAP",
    B.ENGINE_PARAM_MAP.readDirection
      && B.ENGINE_PARAM_MAP.readDirection.param === "read_direction"
      && B.ENGINE_PARAM_MAP.readDirection.field === "value",
    JSON.stringify(B.ENGINE_PARAM_MAP.readDirection));
  const rd = B.mergeEngineBounds(window.PGE_BOUNDS, {
    read_direction: { min_val: -1, max_val: 1, min_range: 0, max_range: 0,
                      variation_mode: "negate" },
  }).readDirection;
  assert("readDirection ← read_direction.value (-1..+1)",
    rd.min === -1 && rd.max === 1, JSON.stringify(rd));
  assert("fallback statico presente per file:// / server down",
    window.PGE_BOUNDS.readDirection.min === -1 && window.PGE_BOUNDS.readDirection.max === 1,
    JSON.stringify(window.PGE_BOUNDS.readDirection));
}

console.log("\n── senza window.PGE_OUTPUT_SR il min non diventa NaN ──");
{
  // mergeEngineBounds è pura: chiamarla senza yaml-bridge (che pubblica il
  // sample rate) deve lasciare il bound del motore, non produrre un NaN che
  // spegne in silenzio ogni clamp a valle.
  const prev = window.PGE_OUTPUT_SR;
  delete window.PGE_OUTPUT_SR;
  const noSr = B.mergeEngineBounds({ grainDur: { min: 0.002, max: 10 } },
    { params: { grain_duration: { min_val: 0.002, max_val: 10 } } }).grainDur;
  window.PGE_OUTPUT_SR = prev;
  assert("grainDur.min resta un numero", !isNaN(noSr.min) && noSr.min === 0.002,
    JSON.stringify(noSr));
}

console.log("\n── il sample rate viene dal motore, il letterale è solo il ripiego ──");
{
  /* La parità pretende che il letterale di yaml-bridge.js sia il numero del
     motore; queste righe pretendono, senza motore, che sia il PAYLOAD a vincere
     quando c'è. Sono due domande diverse e vanno tenute separate: se un giorno
     il motore cambia sample rate, la prima diventa rossa (giusto: aggiorna il
     ripiego) e queste restano verdi (giusto: la catena funziona lo stesso). */
  const prev = window.PGE_OUTPUT_SR;
  /* Il sample rate di prova è DERIVATO dal letterale, non scelto: con un 44100
     scritto a mano queste righe diventerebbero rosse il giorno che il motore
     adotta 44100 — cioè per il motivo sbagliato, visto che quel giorno è la
     parità a dover parlare (il ripiego statico da aggiornare), non questa
     suite, che gira senza motore e non sa nulla di lui. `prev * 2` è diverso
     da `prev` per costruzione. */
  const OTHER = prev * 2;
  try {
    const m = B.mergeEngineBounds({ grainDur: { min: 0.002, max: 10 } },
      { params: { grain_duration: { min_val: 0.002, max_val: 10 } }, output_sr: OTHER });
    assert("grainDur.min = 1 campione al sample rate del payload",
      Math.abs(m.grainDur.min - 1 / OTHER) < 1e-15, String(m.grainDur.min));
    assert("e non a quello del letterale statico",
      Math.abs(m.grainDur.min - 1 / prev) > 1e-15, `payload ${OTHER}, statico ${prev}`);

    /* Il caso che il `Math.min` di prima sbagliava: base già derivata da un
       sample rate PIÙ ALTO (min più piccolo). Prendere il minore dei due
       avrebbe tenuto il pavimento vecchio, cioè una durata sotto il campione
       vero — il difetto che questa lettura chiude, rientrato di lato. */
    const stale = B.mergeEngineBounds({ grainDur: { min: 1 / (OTHER * 2), max: 10 } },
      { output_sr: OTHER });
    assert("una base derivata da un sr più alto non tiene il pavimento vecchio",
      Math.abs(stale.grainDur.min - 1 / OTHER) < 1e-15, String(stale.grainDur.min));

    B.apply({ output_sr: OTHER });
    assert("apply() installa il sample rate su window (lo leggono envelope-utils e i tooltip)",
      window.PGE_OUTPUT_SR === OTHER, String(window.PGE_OUTPUT_SR));

    /* Un sr assurdo non è un ripiego: `1/0` è Infinity, `1/-1` è negativo, e
       un min così spegne ogni clamp a valle invece di stringerlo. */
    for (const bad of [0, -1, NaN, Infinity, String(prev), null]) {
      const r = B.resolveOutputSr({ output_sr: bad });
      // String() e non JSON.stringify: NaN e Infinity escono entrambi "null"
      // di lì, e tre righe identiche nel censimento non dicono quale caso è.
      assert(`output_sr ${String(bad)} → si ricade su window, non si propaga`,
        r === window.PGE_OUTPUT_SR, String(r));
    }
  } finally {
    window.PGE_OUTPUT_SR = prev;
  }
  assert("il letterale statico è tornato al suo posto", window.PGE_OUTPUT_SR === prev);
}

console.log("\n── la catena che porta il sample rate dal motore alla UI ──");
{
  /* Nessuno di questi anelli gira in node, e insieme sono l'unica strada per
     cui `DEFAULT_OUTPUT_SR` arriva ai suoi quattro lettori. Rotto un anello,
     tutto resta verde e la UI torna al letterale: giusto oggi, sbagliato in
     silenzio il giorno che il motore muove il numero. Il sorgente si legge
     come CODICE (source-guard.js), altrimenti una riscrittura che lascia il
     vecchio nome in un commento di rimando lascerebbe la guardia verde. */
  const appSrc  = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));
  const bndSrc  = SG.codeOf(path.join(__dirname, "../../src/lib/bounds.js"));
  const srvSrc  = SG.codeOf(path.join(__dirname, "../../server.py"));
  const introSrc = SG.codeOf(path.join(__dirname, "../../engine_introspect.py"));

  assert("app.jsx chiede /bounds al boot e passa il payload ad apply()",
    /\.bounds\(\)\s*\n?\s*\.then\(/.test(appSrc) &&
    /window\.PGEBounds\.apply\(raw\)/.test(appSrc));
  assert("apply() installa il sample rate su window, non solo i bound",
    /window\.PGE_OUTPUT_SR\s*=\s*sr/.test(bndSrc));
  assert("server.py mette output_sr nel payload di /bounds",
    /engine_output_sr\(root\)/.test(srvSrc) && /"output_sr"\]\s*=\s*sr/.test(srvSrc));
  assert("engine_introspect legge DEFAULT_OUTPUT_SR dai sorgenti del motore",
    /def engine_output_sr\(/.test(introSrc) &&
    /"DEFAULT_OUTPUT_SR"/.test(introSrc));
  assert("e lo legge da shared/constants.py, nei due layout",
    /"pge"\s*\/\s*"shared"\s*\/\s*"constants\.py"/.test(introSrc) &&
    /"src"\s*\/\s*"shared"\s*\/\s*"constants\.py"/.test(introSrc));

  /* Il letterale resta UNO. Due copie e la seconda non seguirebbe né il motore
     né apply(): è il difetto che questa modifica chiude, e va reso irripetibile. */
  const ybSrc = SG.codeOf(path.join(__dirname, "../../src/lib/yaml-bridge.js"));
  const literals = (ybSrc.match(/PGE_OUTPUT_SR/g) || []).length;
  assert("yaml-bridge.js pubblica il fallback una volta sola",
    literals === 1, `${literals} occorrenze di PGE_OUTPUT_SR`);
  assert("e nessun altro modulo di src/lib lo ASSEGNA fuori da apply()",
    ["yaml-bridge.js", "envelope-utils.js", "grain-map.js", "render-status.js"]
      .every(f => !/window\.PGE_OUTPUT_SR\s*=/.test(
        SG.codeOf(path.join(__dirname, "../../src/lib", f)).replace(
          /window\.PGE_OUTPUT_SR = OUTPUT_SR/, ""))));
}

console.log("\n── apply() installs onto window.PGE_BOUNDS ──");
B.apply(raw);
assert("apply mutates window.PGE_BOUNDS.density", window.PGE_BOUNDS.density.max === 2000);
assert("apply mutates window.PGE_BOUNDS.pitch.edoFactor", window.PGE_BOUNDS.pitch.edoFactor === 4);
assert("apply keeps unmapped fallback (scatter)", window.PGE_BOUNDS.scatter.max === baseScatterMax);

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed\n`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
