/* =============================================================================
 * test-time-dist.js — la distribuzione temporale dei cicli non ripiega in
 * silenzio (window.PGEEnv.timeDistError, envelope-loops.js).
 *
 * Perché esiste. Il quinto elemento del formato compatto è la distribuzione
 * temporale dei cicli. Il motore la costruisce a parse-time e ogni fallimento
 * è un errore duro (PGE #208); il mirror JS invece ripiegava su `linear` per
 * qualunque nome non riconosciuto — e per `{base: 1}` / `{exponent: 'x'}` non
 * ripiegava affatto, produceva durate NaN che nessuno segnalava.
 *
 * Il risultato era che l'editor disegnava una curva plausibile per uno YAML
 * che non renderizza. Qui si verifica che il ripiego resti (serve a disegnare
 * qualcosa) ma smetta di essere muto: `timeDistError` dice che quel blocco il
 * motore lo rifiuta, e `expandMixed` lo riporta su ogni blocco.
 *
 * Run: node test-time-dist.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));

const E = window.PGEEnv;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n── registro dei nomi (mirror di TimeDistributionFactory) ──");
assert("gli otto nomi del registro, alias compresi",
  eq([...E.TIME_DIST_NAMES].sort(),
     ["exp", "exponential", "geo", "geometric", "linear", "log", "logarithmic", "power"]),
  JSON.stringify(E.TIME_DIST_NAMES));

console.log("\n── timeDistError: nomi ──");
assert("omessa → valida (i cicli durano uguale)", E.timeDistError(null) === null);
assert("undefined → valida", E.timeDistError(undefined) === null);
for (const n of E.TIME_DIST_NAMES)
  assert(`"${n}" riconosciuto`, E.timeDistError(n) === null);
assert("nome ignoto → errore di nome",
  (E.timeDistError("bogus") || {}).kind === "name");
assert("l'errore nomina il colpevole",
  E.timeDistError("bogus").name === "bogus");
assert("dict con type ignoto → errore di nome",
  (E.timeDistError({ type: "bogus" }) || {}).kind === "name");
assert("type non stringa → errore di nome (nel motore era un AttributeError)",
  (E.timeDistError({ type: 5 }) || {}).kind === "name");
assert("maiuscole tollerate come nel factory (.lower())",
  E.timeDistError("Exponential") === null);

console.log("\n── timeDistError: bound dei costruttori ──");
const casi = [
  [{ type: "geometric", ratio: 1.5 }, true,  "ratio > 0"],
  [{ type: "geometric", ratio: 0 },   false, "ratio = 0 cade su > 0"],
  [{ type: "geometric", ratio: -1 },  false, "ratio negativo"],
  [{ type: "exponential", rate: 2 },  true,  "rate > 0"],
  [{ type: "exponential", rate: 0 },  false, "rate = 0"],
  [{ type: "logarithmic", base: 2 },  true,  "base > 1"],
  [{ type: "logarithmic", base: 1 },  false, "base = 1 cade su > 1"],
  [{ type: "power", exponent: 2 },    true,  "qualunque reale è un esponente"],
  [{ type: "power", exponent: -3 },   true,  "anche negativo"],
  [{ type: "power", exponent: "x" },  false, "ma non una stringa"],
  [{ type: "linear" },                true,  "linear senza parametri"],
];
for (const [spec, valido, why] of casi)
  assert(`${JSON.stringify(spec)} → ${valido ? "valida" : "errore"} (${why})`,
    (E.timeDistError(spec) === null) === valido, JSON.stringify(E.timeDistError(spec)));

assert("parametro estraneo al tipo → errore (il costruttore lo rifiuterebbe)",
  (E.timeDistError({ type: "exponential", ratio: 1.5 }) || {}).kind === "param");
assert("senza type la distribuzione è linear, che non prende parametri",
  (E.timeDistError({ ratio: 1.5 }) || {}).kind === "param");
assert("l'errore di parametro nomina il parametro",
  E.timeDistError({ type: "geometric", ratio: 0 }).param === "ratio");

console.log("\n── computeCycleDurations: il ripiego non produce più NaN ──");
function finite(a) { return Array.isArray(a) && a.length > 0 && a.every(x => typeof x === "number" && isFinite(x)); }
function sumsTo(a, T) { return Math.abs(a.reduce((s, x) => s + x, 0) - T) < 1e-9; }

for (const dist of ["bogus", { type: "bogus" }, { type: 5 },
                    { type: "geometric", ratio: 0 },
                    { type: "logarithmic", base: 1 },
                    { type: "power", exponent: "x" },
                    { ratio: 1.5 }]) {
  const d = E.computeCycleDurations(2.0, 3, dist);
  assert(`${JSON.stringify(dist)} → durate finite (prima: NaN / null / zeri)`,
    finite(d), JSON.stringify(d));
  assert(`${JSON.stringify(dist)} → l'invariante sum === T regge`,
    sumsTo(d, 2.0), JSON.stringify(d));
}

assert("una distribuzione valida NON viene ripiegata",
  !eq(E.computeCycleDurations(2.0, 3, { type: "geometric", ratio: 2 }),
      E.computeCycleDurations(2.0, 3, "linear")));

console.log("\n── expandMixed riporta l'errore sul blocco ──");
{
  const buono = E.expandMixed([[[[0, 0], [50, 1]], 2.0, 2, "linear", "exponential"]]);
  assert("blocco valido → distError null", buono.blocks[0].distError === null,
    JSON.stringify(buono.blocks[0].distError));

  const rotto = E.expandMixed([[[[0, 0], [50, 1]], 2.0, 2, "linear", "bogus"]]);
  assert("blocco con nome ignoto → distError valorizzato",
    (rotto.blocks[0].distError || {}).kind === "name",
    JSON.stringify(rotto.blocks[0].distError));
  assert("i cicli si disegnano comunque (ripiego lineare)",
    rotto.blocks[0].cycles.length === 2, JSON.stringify(rotto.blocks[0].cycles.length));
  assert("e i punti sono finiti, non NaN",
    rotto.points.every(p => isFinite(p[0]) && isFinite(p[1])),
    JSON.stringify(rotto.points));

  const rottoParam = E.expandMixed([[[[0, 0], [50, 1]], 2.0, 2, "linear", { type: "logarithmic", base: 1 }]]);
  assert("blocco con parametro fuori bound → distError di parametro",
    (rottoParam.blocks[0].distError || {}).kind === "param",
    JSON.stringify(rottoParam.blocks[0].distError));
  assert("e i suoi punti restano finiti (prima erano null)",
    rottoParam.points.every(p => isFinite(p[0]) && isFinite(p[1])),
    JSON.stringify(rottoParam.points));
}

console.log("\n" + "─".repeat(50));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
