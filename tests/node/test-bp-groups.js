/* =============================================================================
 * test-bp-groups.js — BP group [points, interp] per-macrozona (PGE #64 /
 * PR #165, PGE-ui issue #108).
 *
 * Copre la superficie di envelope-loops.js (window.PGEEnv): riconoscimento
 * (isBPGroup / envHasGroup), desugar/resugar (forma piatta 3-tuple usata
 * dall'editor ↔ forma YAML a gruppi), propagazione dell'interp per-zona in
 * expandMixed (segmenti interni vs gap in uscita, override per-punto,
 * DISCONTINUITY_OFFSET al bordo zona), formattazione inline e conversione
 * pitch; più i branch gruppo di envelope-utils.js (rescale/truncate).
 *
 * Run: node test-bp-groups.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = { jsyaml: require("js-yaml") };
// yaml-bridge per primo come nell'editor: pubblica window.PGE_OUTPUT_SR, che
// envelope-utils legge a chiamata per il fattore di 'samples'. Senza, quel
// ramo restituisce NaN invece di fallire — una trappola armata, non un errore.
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/deviation-probability.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-utils.js"), "utf8"));

const E = window.PGEEnv;
const U = window.PGEEnvUtils;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// L'esempio della issue #108 (tempi normalizzati [0,1] come nell'editor)
const ZONE_A = [[[0.0, 0], [0.2, 12], [0.4, 8]], "cubic"];
const LOOP   = [[[0, 8], [50, 18], [100, 8]], 0.7, 4, "linear"];
const ZONE_B = [[[0.75, 6], [0.9, 6], [1.0, 0]], "step"];
const MIXED  = [ZONE_A, LOOP, ZONE_B];

console.log("\n── isBPGroup / envHasGroup ──");
assert("group [points, interp] riconosciuto", E.isBPGroup(ZONE_A));
assert("breakpoint [t, v] non è un gruppo", !E.isBPGroup([0, 1]));
assert("3-tuple per-punto non è un gruppo", !E.isBPGroup([0, 1, "cubic"]));
assert("loop block non è un gruppo", !E.isBPGroup(LOOP));
assert("dict tipato non è un gruppo", !E.isBPGroup({ type: "cubic", points: [[0, 0]] }));
assert("envHasGroup su lista mista", E.envHasGroup(MIXED));
assert("envHasGroup sulla forma diretta [points, interp]", E.envHasGroup(ZONE_A));
assert("envHasGroup falso su BP nudi", !E.envHasGroup([[0, 0], [1, 1]]));
assert("envHasLoop non scatta sui gruppi", !E.envHasLoop([ZONE_A]));

console.log("\n── desugarBPGroups ──");
assert("interp di zona → type esplicito dei punti interni, ultimo punto nudo",
  eq(E.desugarBPGroups([ZONE_A]),
     [[0, 0, "cubic"], [0.2, 12, "cubic"], [0.4, 8]]));
assert("override per-punto dentro la zona preservato",
  eq(E.desugarBPGroups([[[[0, 0], [0.5, 1, "step"], [1, 2]], "cubic"]]),
     [[0, 0, "cubic"], [0.5, 1, "step"], [1, 2]]));
assert("type esplicito sull'ultimo punto (gap in uscita) preservato",
  eq(E.desugarBPGroups([[[[0, 0], [1, 2, "step"]], "cubic"]]),
     [[0, 0, "cubic"], [1, 2, "step"]]));
assert("forma diretta [points, interp] normalizzata",
  eq(E.desugarBPGroups(ZONE_A),
     [[0, 0, "cubic"], [0.2, 12, "cubic"], [0.4, 8]]));
assert("loop block e BP nudi passano invariati",
  eq(E.desugarBPGroups([[0, 0], LOOP]), [[0, 0], LOOP]));

console.log("\n── resugarBPGroups ──");
assert("run uniforme ≠ default → gruppo (round-trip con desugar)",
  eq(E.resugarBPGroups(E.desugarBPGroups(MIXED), "linear"), MIXED));
assert("run di 2 punti cubic → gruppo",
  eq(E.resugarBPGroups([[0, 0, "cubic"], [1, 1]], "linear"),
     [[[[0, 0], [1, 1]], "cubic"]]));
assert("run misto resta piatto con i tag",
  eq(E.resugarBPGroups([[0, 0, "cubic"], [0.5, 1, "step"], [1, 2]], "linear"),
     [[0, 0, "cubic"], [0.5, 1, "step"], [1, 2]]));
assert("tag ridondanti (== default globale) normalizzati via",
  eq(E.resugarBPGroups([[0, 0, "linear"], [1, 1]], "linear"),
     [[0, 0], [1, 1]]));
assert("default globale non-linear: run cubic con global cubic resta piatto",
  eq(E.resugarBPGroups([[0, 0, "cubic"], [1, 1]], "cubic"),
     [[0, 0], [1, 1]]));
assert("desugar∘resugar idempotente sugli indici piatti",
  eq(E.desugarBPGroups(E.resugarBPGroups(E.desugarBPGroups(MIXED), "linear")),
     E.desugarBPGroups(MIXED)));

console.log("\n── expandMixed: propagazione interp per-zona ──");
{
  const exp = E.expandMixed(MIXED);
  const tags = exp.points.map((p) => p[2]);
  const zoneA = exp.points.slice(0, 3);
  assert("zona A: segmenti interni cubic, gap in uscita linear (default globale)",
    zoneA[0][2] === "cubic" && zoneA[1][2] === "cubic" && zoneA[2][2] === "linear",
    JSON.stringify(zoneA));
  const zoneB = exp.points.slice(-3);
  assert("zona B: segmenti interni step, ultimo punto linear",
    zoneB[0][2] === "step" && zoneB[1][2] === "step" && zoneB[2][2] === "linear",
    JSON.stringify(zoneB));
  assert("loop block espanso tra le due zone (1 blocco, 4 cicli)",
    exp.blocks.length === 1 && exp.cycles.length === 4);
  assert("il gruppo non fa leak sul default globale",
    tags.filter((t) => t === "cubic").length === 2);
}
{
  const exp = E.expandMixed([[[[0, 0], [0.5, 1, "step"], [1, 2]], "cubic"]]);
  assert("override per-punto dentro la zona vince sull'interp di gruppo",
    exp.points[1][2] === "step" && exp.points[0][2] === "cubic");
}
{
  const exp = E.expandMixed(ZONE_A);
  assert("forma diretta [points, interp] espansa come gruppo singolo",
    exp.points.length === 3 && exp.points[0][2] === "cubic");
}
{
  // collisione al bordo zona: t <= ultimo punto precedente → offset
  const exp = E.expandMixed([[0, 0], [0.5, 5], [[[0.5, 1], [1, 2]], "cubic"]]);
  assert("DISCONTINUITY_OFFSET applicato al primo punto del gruppo in collisione",
    exp.points[2][0] === 0.5 + E.DISCONTINUITY_OFFSET, JSON.stringify(exp.points));
  const exp2 = E.expandMixed([[0, 0], [[[0.75, 1], [1, 2]], "cubic"]]);
  assert("nessuno shift senza collisione (tempi assoluti)",
    exp2.points[1][0] === 0.75);
}
{
  const exp = E.expandMixed({ type: "cubic", points: [[0, 0], [1, 1]] });
  assert("forma dict tipata invariata (global interp sui punti)",
    exp.points.every((p) => p[2] === "cubic"));
}

console.log("\n── wrapEnv / normalizeEnv / fmtEnvInline ──");
assert("wrapEnv non incarta in dict un env con gruppi",
  Array.isArray(E.wrapEnv([ZONE_A], "cubic")));
assert("normalizeEnv: bare group → [group]",
  eq(E.normalizeEnv(ZONE_A), [ZONE_A]));
assert("normalizeEnv: lista mista invariata",
  eq(E.normalizeEnv(MIXED), MIXED));
assert("fmtEnvInline: gruppo in lista mista",
  E.fmtEnvInline([ZONE_A, [0.6, 3]]) ===
    "[[[[0, 0], [0.2, 12], [0.4, 8]], 'cubic'], [0.6, 3]]",
  E.fmtEnvInline([ZONE_A, [0.6, 3]]));
assert("fmtEnvInline: gruppo singolo emesso in forma bare",
  E.fmtEnvInline([ZONE_A]) === "[[[0, 0], [0.2, 12], [0.4, 8]], 'cubic']",
  E.fmtEnvInline([ZONE_A]));
assert("parseEnvLiteral ∘ fmtEnvInline round-trip",
  eq(E.normalizeEnv(E.parseEnvLiteral(E.fmtEnvInline([ZONE_A]))), [ZONE_A]));

console.log("\n── conversione pitch sui gruppi ──");
assert("convertPitchEnv rimappa le y dentro il gruppo (st → cents)",
  eq(E.convertPitchEnv([[[[0, 1], [1, 2]], "cubic"]], "semitones", "cents"),
     [[[[0, 100], [1, 200]], "cubic"]]));

console.log("\n── envelope-utils: rescale / truncate / wouldTruncate ──");
assert("rescaleEnvArray scala i tempi dentro il gruppo",
  eq(U.rescaleEnvArray([ZONE_A], 0.5),
     [[[[0, 0], [0.1, 12], [0.2, 8]], "cubic"]]));
assert("truncateEnvArray interpola il punto di chiusura dentro il gruppo",
  eq(U.truncateEnvArray([[[[0, 0], [0.8, 1], [1.5, 2]], "cubic"]]),
     [[[[0, 0], [0.8, 1], [1, 1.2857]], "cubic"]]));
assert("truncateEnvArray: gruppo troncato a 2 punti resta gruppo",
  eq(U.truncateEnvArray([[0, 0], [[[0.5, 1], [1.5, 2]], "cubic"]]),
     [[0, 0], [[[0.5, 1], [1, 1.5]], "cubic"]]),
  JSON.stringify(U.truncateEnvArray([[0, 0], [[[0.5, 1], [1.5, 2]], "cubic"]])));
assert("truncateEnvArray: gruppo degenerato a 1 punto → breakpoint nudo",
  eq(U.truncateEnvArray([[0, 0], [[[1.2, 1], [1.5, 2]], "cubic"]]),
     [[0, 0], [1, 1]]),
  JSON.stringify(U.truncateEnvArray([[0, 0], [[[1.2, 1], [1.5, 2]], "cubic"]])));
assert("envArrayWouldTruncate vede i punti del gruppo",
  U.envArrayWouldTruncate([ZONE_A], 3) === true &&
  U.envArrayWouldTruncate([ZONE_A], 1) === false);

/* ============================================================================
 * firstBreakpointY — la y del primo breakpoint, qualunque grafia abbia
 *
 * E' la domanda di ogni toggle env→scalare: la curva sparisce, e il numero che
 * la sostituisce dev'essere quello che la curva diceva. `env[0][1]` non sa
 * rispondere, e sbaglia in tre modi diversi — uno per grafia — tutti e tre
 * silenziosi. Sta nel modulo perche' i chiamanti sono tredici (dodici rami di
 * toggleMode piu' il Seg del loop): scritta dentro uno, gli altri dodici
 * tengono la versione rotta, ed e' esattamente com'e' andata.
 * ========================================================================== */
console.log("\n── firstBreakpointY: la y del primo punto, in ogni grafia ──");
{
  const FB = (env, fb) => E.firstBreakpointY(env, fb);
  assert("lista piatta: la y del primo breakpoint",
    FB([[0, 6], [1, 2]], "FB") === 6);
  assert("3-tuple con interp per-punto: sempre la y",
    FB([[0, 6, "step"], [1, 2]], "FB") === 6);
  /* La grafia che l'editor SCRIVE da se': wrapEnv produce {type, points}
     appena l'interp globale di una curva di soli BP non e' lineare. Li'
     `env[0]` non esiste, quindi il vecchio lettore ripiegava sul default —
     la costante al posto della curva, sul caso raggiungibile senza scrivere
     una riga di YAML a mano. */
  assert("envelope tipato {type, points}: si unwrappa prima di leggere",
    FB({ type: "cubic", points: [[0, 6], [1, 2]] }, "FB") === 6);
  assert("dict con i soli points, che il motore accetta",
    FB({ points: [[0, 6], [1, 2]] }, "FB") === 6);
  /* Un BP group come primo item e' `[points, interp]`: `[1]` e' la STRINGA
     dell'interp, e `|| default` la lascia passare — cioe' `pan: "cubic"`
     scritto nello YAML come valore del parametro. */
  assert("BP group: si desugara, non si legge il nome dell'interp",
    FB([[[[0, 3], [1, 4]], "cubic"]], "FB") === 3);
  assert("BP group in forma diretta (non annidato in una lista)",
    FB([[[0, 3], [1, 4]], "cubic"], "FB") === 3);
  /* E il blocco compatto e' la grafia che una y non ce l'ha davvero: in `[1]`
     c'e' il RATIO della distribuzione, un numero che con il valore del
     parametro non c'entra niente. Qui il ripiego e' la risposta giusta. */
  assert("blocco compatto come primo item: ripiega, non scrive il ratio",
    FB([[[[0, 0.1], [0.5, 0.2]], 2, 4]], "FB") === "FB");
  assert("blocco compatto in forma di dict: ripiega",
    FB({ type: "geometric", ratio: 2, n_reps: 4 }, "FB") === "FB");
  /* Il breakpoint in forma dict `{t, v}`: il builder del motore lo normalizza
     in `[t, v]` (envelope_builder.py:132) e wouldEmptyEnv lo conta gia' come
     punto vero, quindi una y ce l'ha ed e' `v`. */
  assert("breakpoint {t, v}: la y e' `v`",
    FB([{ t: 0, v: 6 }, { t: 1, v: 2 }], "FB") === 6);
  assert("…con l'interp per-punto, uguale",
    FB([{ t: 0, v: 6, type: "step" }], "FB") === 6);
  assert("dict senza una y numerica: non e' un punto, ripiega",
    FB([{ t: 0 }], "FB") === "FB");
  /* Il ritorno e' il valore LETTO, zero compreso. Con `|| default` uno zero
     legittimo — un loop_end a inizio file, una probabilita' «mai», un pan al
     centro — diventava una costante che la curva non aveva mai avuto. */
  assert("uno zero letto e' uno zero, non il ripiego",
    FB([[0, 0], [1, 1]], "FB") === 0 && FB([{ t: 0, v: 0 }], "FB") === 0);
  assert("y negativa: nessun trattamento speciale",
    FB([[0, -3], [1, 1]], "FB") === -3);
  /* Le forme che una y non ce l'hanno per niente: il ripiego e' del chiamante,
     perche' e' il default del SUO parametro — 1 per speed_ratio, 0 per pan,
     loopSeedWhole per il loop. Il modulo non ne conosce nessuno. */
  assert("envelope assente o vuoto: ripiega",
    FB(null, "FB") === "FB" && FB(undefined, "FB") === "FB" && FB([], "FB") === "FB");
  assert("uno scalare passato per sbaglio: ripiega, non si auto-legge",
    FB(5, "FB") === "FB");
  assert("ripiego non passato: undefined, cosi' il chiamante lo riconosce",
    FB([], undefined) === undefined && FB([[0, 0]], undefined) === 0);
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
