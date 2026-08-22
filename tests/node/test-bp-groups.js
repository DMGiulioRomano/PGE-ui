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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
