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

/* Overflow: la coppia (parametro, n_reps) che il motore non riesce a calcolare
   (PGE #212). Le soglie qui sotto sono verificate contro il motore vero — sopra
   passa, sotto trabocca — e il mirror lavora sui logaritmi, perché calcolare la
   potenza per scoprire che trabocca darebbe solo Infinity. */
console.log("\n── timeDistError: overflow della coppia con n_reps ──");
{
  const kind = (d, n) => (E.timeDistError(d, n) || {}).kind;

  assert("senza n_reps l'overflow non si può nemmeno guardare",
    E.timeDistError({ type: "geometric", ratio: 10 }) === null);
  assert("geometric ratio 10 · n_reps 308 → sotto la soglia",
    kind({ type: "geometric", ratio: 10 }, 308) === undefined);
  assert("geometric ratio 10 · n_reps 310 → overflow",
    kind({ type: "geometric", ratio: 10 }, 310) === "overflow");
  assert("geometric ratio 10 · n_reps 400 → overflow (il caso della issue)",
    kind({ type: "geometric", ratio: 10 }, 400) === "overflow");
  assert("geometric ratio < 1 → la potenza tende a zero, nessun overflow",
    kind({ type: "geometric", ratio: 0.1 }, 4000) === undefined);
  assert("geometric ratio ≈ 1 → il motore devia su linear prima di elevare",
    kind({ type: "geometric", ratio: 1 }, 100000) === undefined);
  assert("forma stringa: anche i default traboccano, con abbastanza cicli",
    kind("geometric", 1760) === "overflow");
  assert("forma stringa: e sotto la soglia no", kind("geometric", 1747) === undefined);

  assert("exponential rate 0.1 · n_reps 400 → overflow",
    kind({ type: "exponential", rate: 0.1 }, 400) === "overflow");
  assert("exponential rate 0.1 · n_reps 300 → sotto la soglia",
    kind({ type: "exponential", rate: 0.1 }, 300) === undefined);
  assert("exponential rate > 1 → i pesi decrescono, nessun overflow",
    kind({ type: "exponential", rate: 2 }, 100000) === undefined);
  assert("exponential rate 0.5 · n_reps 1023 → sotto la soglia",
    kind({ type: "exponential", rate: 0.5 }, 1023) === undefined);
  assert("exponential rate 0.5 · n_reps 1200 → overflow",
    kind({ type: "exponential", rate: 0.5 }, 1200) === "overflow");

  assert("power exponent frazionario grande → overflow",
    kind({ type: "power", exponent: 200.5 }, 400) === "overflow");
  assert("power exponent frazionario ma pochi cicli → nessun overflow",
    kind({ type: "power", exponent: 200.5 }, 4) === undefined);
  assert("power exponent negativo → sottoflusso a zero, non overflow",
    kind({ type: "power", exponent: -200.5 }, 400) === undefined);
  // Limite dichiarato: in Python `200` è un intero e la potenza si calcola su
  // interi illimitati (nessun overflow), `200.0` è un float e trabocca. In JS
  // sono lo stesso Number: segnaliamo solo il frazionario, così l'avviso non
  // esce mai su uno YAML che rende.
  assert("power exponent intero → non segnalato (Python lo calcola su interi)",
    kind({ type: "power", exponent: 200 }, 400) === undefined);

  assert("linear non eleva niente a potenza", kind("linear", 100000) === undefined);
  assert("logarithmic nemmeno",
    kind({ type: "logarithmic", base: 2 }, 100000) === undefined);

  const ov = E.timeDistError({ type: "geometric", ratio: 10 }, 400);
  assert("l'errore nomina entrambi i colpevoli",
    ov.param === "ratio" && ov.value === 10 && ov.nReps === 400, JSON.stringify(ov));
  assert("e la distribuzione", ov.name === "geometric", JSON.stringify(ov));
  assert("il rimedio dipende dal parametro, non dalla distribuzione",
    E.TIME_DIST_OVERFLOW_FIX.ratio === "avvicina ratio a 1" &&
    E.TIME_DIST_OVERFLOW_FIX.rate === "avvicina rate a 1" &&
    E.TIME_DIST_OVERFLOW_FIX.exponent === "riduci exponent in valore assoluto",
    JSON.stringify(E.TIME_DIST_OVERFLOW_FIX));

  // Un parametro fuori bound resta un errore di parametro: il costruttore
  // fallisce prima che ci sia una potenza da calcolare.
  assert("bound rotto e overflow insieme → vince il bound",
    kind({ type: "geometric", ratio: -10 }, 400) === "param");

  // Il ripiego lineare vale anche qui: prima Math.pow dava Infinity e le durate
  // uscivano NaN o zero, e il blocco si disegnava collassato senza dirlo.
  const durs = E.computeCycleDurations(2.0, 400, { type: "geometric", ratio: 10 });
  assert("overflow → cicli di durata uguale, non NaN",
    durs.length === 400 && durs.every(d => isFinite(d) && d > 0), JSON.stringify(durs.slice(0, 3)));
  assert("e la somma resta il tempo del blocco",
    Math.abs(durs.reduce((a, b) => a + b, 0) - 2.0) < 1e-9);
}

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

  const traboccante = E.expandMixed([[[[0, 0], [50, 1]], 2.0, 400, "linear", { type: "geometric", ratio: 10 }]]);
  assert("blocco che trabocca → distError di overflow",
    (traboccante.blocks[0].distError || {}).kind === "overflow",
    JSON.stringify(traboccante.blocks[0].distError));
  assert("e i suoi punti restano finiti",
    traboccante.points.every(p => isFinite(p[0]) && isFinite(p[1])));

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
