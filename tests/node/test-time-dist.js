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

  /* I bordi della banda int/float, fissati qui perché il commento in
     _overflowError li dichiara. Il conto modella il quoziente intero, che è la
     lettura più permissiva: sotto questi n_reps il motore rende davvero con
     ratio/rate INTERI, e segnalare prima sarebbe un falso positivo. Dove il
     valore è float il motore trabocca un n_reps prima e noi taciamo — banda da
     uno, nella direzione sicura. Numeri verificati sul motore. */
  assert("ratio 10 · 309 tace (con ratio intero il motore rende)",
    kind({ type: "geometric", ratio: 10 }, 309) === undefined);
  assert("ratio 10 · 310 segnala (primo rifiutato dal motore con ratio intero)",
    kind({ type: "geometric", ratio: 10 }, 310) === "overflow");
  assert("ratio 2 · 1024 tace (il motore lo rifiuta: banda da uno)",
    kind({ type: "geometric", ratio: 2 }, 1024) === undefined);
  assert("ratio 2 · 1025 segnala", kind({ type: "geometric", ratio: 2 }, 1025) === "overflow");
  assert("rate 0.5 · 1025 tace (il motore lo rifiuta: banda da uno)",
    kind({ type: "exponential", rate: 0.5 }, 1025) === undefined);
  assert("rate 0.5 · 1026 segnala", kind({ type: "exponential", rate: 0.5 }, 1026) === "overflow");

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

/* La rete sull'OUTPUT. `timeDistError` copre le coppie che il MOTORE rifiuta;
   restano quelle che il motore rende e Math.pow no — esponente o ratio interi,
   dove Python calcola su interi illimitati. Lì distError tace, e prima uscivano
   durate NaN o tutte zero disegnate in silenzio: esattamente il sintomo che
   questa PR dichiara di chiudere. La guardia non enumera quei casi, guarda cosa
   è uscito. */
console.log("\n── computeCycleDurations: ripiego anche quando a tradire sono le durate ──");
{
  const sane = (durs, N, T) =>
    durs.length === N && durs.every(d => isFinite(d) && d >= 0) &&
    Math.abs(durs.reduce((a, b) => a + b, 0) - T) < 1e-9;

  /* Il ripiego qui NON può essere muto come quello di timeDistError, e per la
     ragione opposta: là il motore rifiuta il blocco, qui lo rende — spesso
     fortemente sbilanciato — e cicli uguali sono un'anteprima plausibile e
     sbagliata, peggio delle NaN di prima che almeno erano rotte a vista.
     Numeri del motore, verificati: `power exponent 1000` con 4 cicli mette il
     100% del tempo nell'ultimo, `geometric ratio 10` con 309 cicli il 90%.
     Quindi si fissa il SEGNALE, non solo la sanità delle durate. */
  for (const [dist, N, perche] of [
    [{ type: "power", exponent: 1000 }, 4, "bastano 4 cicli: il motore mette tutto nell'ultimo"],
    [{ type: "power", exponent: 400 }, 400, "esponente intero: il motore rende, Math.pow no"],
    [{ type: "power", exponent: 200 }, 400, "idem, sotto la soglia float"],
    [{ type: "geometric", ratio: 10 }, 309, "ratio intero a un passo dalla soglia: durate tutte zero"],
  ]) {
    const durs = E.computeCycleDurations(2.0, N, dist);
    assert(`${JSON.stringify(dist)} · n=${N} → durate sane (${perche})`,
      sane(durs, N, 2.0), JSON.stringify(durs.slice(0, 3)));
    assert(`${JSON.stringify(dist)} · n=${N} → e distError tace (il motore rende)`,
      E.timeDistError(dist, N) === null, JSON.stringify(E.timeDistError(dist, N)));
    assert(`${JSON.stringify(dist)} · n=${N} → ma il ripiego si dichiara`,
      E.isPreviewFallback(durs) === true);
  }

  // Il flag è invisibile a JSON/Object.keys, così nessun confronto sulle durate
  // cambia significato per il fatto che ci sia.
  {
    const durs = E.computeCycleDurations(2.0, 4, { type: "power", exponent: 1000 });
    assert("il flag non entra nel JSON delle durate",
      JSON.stringify(durs) === JSON.stringify([0.5, 0.5, 0.5, 0.5]), JSON.stringify(durs));
    assert("né in Object.keys", !Object.keys(durs).includes("previewFallback"));
  }

  // E non si accende dove il ripiego è già dichiarato da distError (là il
  // pannello parla di suo, e il motore quel blocco lo rifiuta) né su una
  // distribuzione uniforme scritta davvero.
  assert("distribuzione con errore dichiarato → non è un ripiego dell'anteprima",
    E.isPreviewFallback(E.computeCycleDurations(2.0, 400, { type: "geometric", ratio: 10 })) === false);
  assert("nome ignoto → idem",
    E.isPreviewFallback(E.computeCycleDurations(2.0, 8, "bogus")) === false);
  assert("linear scritta davvero → nessun ripiego",
    E.isPreviewFallback(E.computeCycleDurations(2.0, 8, "linear")) === false);
  assert("ratio ≈ 1 (il motore devia su linear) → nessun ripiego",
    E.isPreviewFallback(E.computeCycleDurations(2.0, 8, { type: "geometric", ratio: 1 })) === false);

  // E le distribuzioni sane non devono ripiegare per colpa della guardia: la
  // tolleranza è relativa, non assoluta.
  for (const [dist, N] of [
    [{ type: "geometric", ratio: 1.5 }, 100], [{ type: "geometric", ratio: 10 }, 300],
    [{ type: "geometric", ratio: 0.1 }, 300], [{ type: "exponential", rate: 0.5 }, 1000],
    [{ type: "logarithmic", base: 2 }, 500], [{ type: "power", exponent: 0.5 }, 1000],
  ]) {
    const durs = E.computeCycleDurations(2.0, N, dist);
    const uniforme = durs.every(d => Math.abs(d - 2.0 / N) < 1e-15);
    assert(`${JSON.stringify(dist)} · n=${N} → NON ripiegata`,
      !uniforme && sane(durs, N, 2.0) && !E.isPreviewFallback(durs));
  }

  // expandMixed porta il flag sul blocco, che è dove il pannello lo legge.
  {
    const ripiegato = E.expandMixed([[[[0, 0], [50, 1]], 2.0, 4, "linear", { type: "power", exponent: 1000 }]]);
    assert("expandMixed → previewFallback sul blocco",
      ripiegato.blocks[0].previewFallback === true);
    assert("…e distError resta null, così il pannello sceglie l'altro messaggio",
      ripiegato.blocks[0].distError === null, JSON.stringify(ripiegato.blocks[0].distError));

    const sano = E.expandMixed([[[[0, 0], [50, 1]], 2.0, 4, "linear", { type: "geometric", ratio: 1.5 }]]);
    assert("blocco sano → previewFallback false", sano.blocks[0].previewFallback === false);

    const overflow = E.expandMixed([[[[0, 0], [50, 1]], 2.0, 400, "linear", { type: "geometric", ratio: 10 }]]);
    assert("blocco che il motore rifiuta → parla distError, non previewFallback",
      overflow.blocks[0].distError.kind === "overflow" && overflow.blocks[0].previewFallback === false);
  }
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

/* La banda int/float e cosa il pannello puo' dirne.
   `timeDistError` tace di proposito su una fascia di coppie che il motore
   rifiuta comunque (la soglia intera e' la piu' permissiva delle due, e
   stringerla reintrodurrebbe falsi positivi: a `ratio: 2` la parita' e'
   ESATTA in doppia precisione). Dentro quella fascia scatta la guardia
   sull'output, che sa solo che il conto JS non e' arrivato — non cosa fara' il
   motore. Il messaggio del pannello non deve quindi affermarlo: verificato
   eseguendo il motore, {geometric, ratio: 2} a 1024 cicli e {exponential,
   rate: 0.5} a 1025 alzano ParameterBoundError mentre la UI ripiega. */
{
  console.log("\n── la banda int/float: la guardia parla, ma non del motore ──");
  const banda = [
    [{ type: "geometric",   ratio: 2   }, 1024],
    [{ type: "exponential", rate:  0.5 }, 1025],
    [{ type: "geometric",   ratio: 2.5 }, 775],
    [{ type: "exponential", rate:  0.25 }, 513],
  ];
  for (const [spec, n] of banda) {
    const label = `${spec.type} @${n}`;
    assert(`${label}: timeDistError tace (soglia intera, voluto)`,
      E.timeDistError(spec, n) === null, JSON.stringify(E.timeDistError(spec, n)));
    assert(`${label}: la guardia sull'output ripiega e lo dichiara`,
      E.isPreviewFallback(E.computeCycleDurations(2.0, n, spec)) === true);
  }

  // Nota, non asserzione: `1024*Math.log10(2) === Math.log10(Number.MAX_VALUE)`
  // è una proprietà di IEEE754, che nessuna modifica a questo repo può far
  // cadere — è la stessa classe della tautologia rimossa nel giro precedente.
  // È la ragione per cui la disuguaglianza in _overflowError deve restare `>`:
  // il comportamento che ne dipende è già fissato dalla riga qui sopra, che a
  // `ratio: 2` @1024 pretende `timeDistError` null.

  /* La finestra lineare del motore: `abs(ratio - 1.0) < 1e-6` ripiega su
     LinearDistribution (time_distribution.py). Il mirror la teneva a 1e-9, e
     nella finestra fra le due faceva il conto per davvero: `1 - Math.pow(r, N)`
     con r a un miliardesimo da 1 è cancellazione catastrofica, la somma non
     torna a T, la guardia scattava — e il pannello avvisava su un'anteprima
     esatta. Le durate qui sotto sono le stesse su entrambi i lati, verificate
     eseguendo il motore. */
  for (const [r, n] of [[1.000000002, 4], [0.999999998, 4], [1.00000001, 8]]) {
    const durs = E.computeCycleDurations(2.0, n, { type: "geometric", ratio: r });
    assert(`geometric ratio=${r} @${n}: nessun ripiego (è la finestra lineare del motore)`,
      E.isPreviewFallback(durs) === false);
    assert(`geometric ratio=${r} @${n}: cicli uguali, come il motore`,
      durs.every(d => Math.abs(d - 2.0 / n) < 1e-12), JSON.stringify(durs));
  }
  // `exponential` e `logarithmic` non hanno un ripiego lineare nel motore:
  // niente da allineare, e nessuna trip muta nello sweep sui parametri ordinari.

  const eeSrc = fs.readFileSync(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"), "utf8");
  const warn = (eeSrc.split("block.previewFallback ?")[1] || "").slice(0, 700);
  assert("il pannello ha un messaggio per previewFallback", warn.length > 0);
  assert("e non afferma che il motore la rende",
    !/il motore la rende|il motore lo rende/.test(warn), warn.slice(0, 200));
  assert("dice invece che le durate disegnate non sono quelle del blocco",
    /non\s+sono\s+quelle\s+del\s+blocco/.test(warn), warn.slice(0, 200));
  assert("e resta un warn, non un error",
    /--status-warn/.test(warn), warn.slice(0, 200));
}

console.log("\n" + "─".repeat(50));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
