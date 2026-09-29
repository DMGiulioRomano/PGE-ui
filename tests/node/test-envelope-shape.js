/* =============================================================================
 * test-envelope-shape.js — la forma di un envelope, come la giudica il
 * builder del motore (window.PGEEnv.envShapeError, envelope-loops.js; #180).
 *
 * Perche' esiste. Da PGE #211 i guard di forma degli envelope stanno in
 * `EnvelopeBuilder` e valgono per ogni chiave, e tre scritture che il motore
 * rendeva in silenzio sono diventate errori: una `x` del pattern di un
 * compatto fuori da [0, 100] o che torna indietro, `n_reps: true` (rendeva un
 * ciclo) ed `end_time: true` (valeva 1.0) — piu' una `y` booleana nel pattern
 * (valeva 1). L'editor non scrive questi corpi: i drag del pattern restano fra
 * i vicini e in [0, 100]. Il tab Raw invece si', e prima nessuno specchio lo
 * diceva prima del render.
 *
 * Qui si esegue lo specchio contro se stesso: ogni regola, nelle due forme in
 * cui il motore la incontra (il valore E' il blocco, o lo contiene), l'ordine
 * in cui i guard scattano — il motore si ferma al primo — e i corpi validi
 * che non devono mai accendere niente. Che le risposte siano quelle del
 * motore lo chiede tests/parity/test-envelope-shape-parity.js.
 *
 * Run: node test-envelope-shape.js (from tests/node/ after npm install)
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
// In testa e non in fondo: se lo specchio manca, la prima chiamata muore, e
// senza l'handler gia' registrato quella morte uscirebbe senza riepilogo.
// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log("\n" + "─".repeat(50));
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
const show = (v) => JSON.stringify(v);
const err = (env) => E.envShapeError(env);
// L'errore atteso, per sotto-insieme: una chiave non nominata non si guarda.
function is(env, want) {
  const got = err(env);
  if (!got) return false;
  return Object.keys(want).every(k => show(got[k]) === show(want[k]));
}

const PAT = [[0, 0], [100, 1]];

console.log("\n── superficie del modulo ──");
assert("envShapeError e' pubblicata da PGEEnv, accanto a timeDistError",
  typeof E.envShapeError === "function" && typeof E.timeDistError === "function");
assert("l'elenco delle interpolazioni e' pubblicato (lo confronta la parita')",
  Array.isArray(E.INTERP_TYPES) && E.INTERP_TYPES.length === 3,
  show(E.INTERP_TYPES));

/* ═══════════════════════════════════════════════════════════════════════════
   I corpi validi: nessuna di queste scritture deve accendere niente. Sono le
   forme che il motore legge e quelle che l'editor stesso scrive — un rosso qui
   sarebbe un falso positivo su un render che riesce.
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── i corpi validi restano muti ──");
const VALID = [
  ["breakpoint nudi", [[0, 0], [1, 1]]],
  ["breakpoint 3-tuple", [[0, 0, "cubic"], [1, 1]]],
  ["breakpoint dict", [{ t: 0, v: 0 }, { t: 1, v: 1, type: "step" }]],
  ["envelope tipizzato", { type: "cubic", points: [[0, 0], [1, 1]] }],
  ["dict con solo points", { points: [[0, 0], [1, 1]] }],
  ["compatto nudo", [PAT, 1, 4]],
  ["compatto in lista", [[PAT, 1, 4]]],
  ["x ripetuta: e' la discontinuita'", [[[0, 0], [50, 1], [50, 0], [100, 1]], 1, 2]],
  ["punto del pattern con type", [[[0, 0, "step"], [100, 1]], 1, 2]],
  ["punto del pattern con type null", [[[0, 0, null], [100, 1]], 1, 2]],
  ["x agli estremi esatti", [[[0, 0], [0, 1], [100, 0], [100, 1]], 1, 2]],
  ["i sei slot", [PAT, 1, 2, "cubic", { type: "geometric", ratio: 1.5 }, true]],
  ["slot opzionali a null", [PAT, 1, 2, null, null, null]],
  ["distribuzione per nome", [PAT, 1, 2, "linear", "exponential"]],
  ["BP group nudo", [[[0, 0], [1, 1]], "cubic"]],
  ["BP group in lista", [[0, 0], [[[0.2, 1], [0.8, 0]], "step"], [1, 1]]],
  ["misto con offset", [[0, 10], [0.3, 10], [[[0, 30], [100, 50]], 1.3, 5, "linear", "exponential"]]],
  ["due compatti in fila", [[PAT, 1, 2], [PAT, 2, 2]]],
  ["compatto dentro {type, points}", { type: "linear", points: [[PAT, 1, 2]] }],
];
for (const [label, env] of VALID)
  assert(`${label}: nessun errore`, err(env) === null, show(err(env)));

// Il blocco che l'editor crea da se' (bottone "add loop"): se questo fosse
// rosso, il rosso lo scriverebbe l'editor.
{
  const blk = E.defaultCompactBlock([[0, 0.3]], null, null);
  assert("il blocco di default dell'editor e' valido, nudo e in lista",
    err(blk) === null && err([[0, 0.3], blk]) === null, show(err(blk)));
}

console.log("\n── cio' che non e' un envelope non e' affare di questo specchio ──");
for (const [label, v] of [["numero", 5], ["stringa", "x"], ["null", null],
                          ["undefined", undefined], ["dict senza points", { a: 1 }],
                          ["points non lista", { points: 3 }], ["lista vuota", []]]) {
  assert(`${label}: null (lo decide un altro strato, non il builder)`, err(v) === null, show(err(v)));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Le scritture che PGE #211 ha reso errori
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── le quattro scritture nuove di PGE #211 ──");
assert("x a 150 → compact.pattern, fuori da [0, 100]",
  is([[[0, 0], [150, 1]], 1, 2], { where: "compact.pattern", why: "range", value: 150, point: 1 }),
  show(err([[[0, 0], [150, 1]], 1, 2])));
assert("x negativa → compact.pattern, fuori da [0, 100]",
  is([[[-1, 0], [100, 1]], 1, 2], { where: "compact.pattern", why: "range", value: -1, point: 0 }),
  show(err([[[-1, 0], [100, 1]], 1, 2])));
assert("x che torna indietro → compact.pattern, ordine",
  is([[[100, 0], [0, 1]], 1, 2], { where: "compact.pattern", why: "order", value: 0, point: 1 }),
  show(err([[[100, 0], [0, 1]], 1, 2])));
assert("n_reps: true → compact.n_reps (true non e' 1)",
  is([PAT, 1, true], { where: "compact.n_reps", why: "reps", value: true }),
  show(err([PAT, 1, true])));
assert("end_time: true → compact.end_time (true non e' 1.0)",
  is([PAT, true, 2], { where: "compact.end_time", why: "type", value: true }),
  show(err([PAT, true, 2])));
assert("y booleana nel pattern → compact.pattern, punto non piatto",
  is([[[0, true], [100, 1]], 1, 2], { where: "compact.pattern", why: "point", point: 0 }),
  show(err([[[0, true], [100, 1]], 1, 2])));

console.log("\n── gli altri guard del compatto ──");
assert("n_reps 0 → compact.n_reps", is([PAT, 1, 0], { where: "compact.n_reps", value: 0 }));
assert("n_reps negativo → compact.n_reps", is([PAT, 1, -3], { where: "compact.n_reps", value: -3 }));
assert("end_time infinito → compact.end_time, tipo",
  is([PAT, Infinity, 2], { where: "compact.end_time", why: "type" }));
assert("end_time NaN → compact.end_time, tipo (ogni confronto con NaN e' falso)",
  is([PAT, NaN, 2], { where: "compact.end_time", why: "type" }));
assert("end_time 0 nella forma diretta → oltre l'inizio, che e' 0",
  is([PAT, 0, 2], { where: "compact.end_time", why: "offset", start: 0 }));
assert("end_time negativo → oltre l'inizio",
  is([PAT, -1, 2], { where: "compact.end_time", why: "offset" }));
assert("pattern vuoto → compact.pattern, vuoto",
  is([[], 1, 2], { where: "compact.pattern", why: "empty" }));
assert("y stringa → compact.pattern, punto",
  is([[[0, "a"], [100, 1]], 1, 2], { where: "compact.pattern", why: "point", point: 0 }));
assert("y lista → compact.pattern, punto",
  is([[[0, [1]], [100, 1]], 1, 2], { where: "compact.pattern", why: "point", point: 0 }));
assert("type numerico → compact.pattern, punto",
  is([[[0, 0, 5], [100, 1]], 1, 2], { where: "compact.pattern", why: "point", point: 0 }));
assert("x booleana → compact.pattern, punto (non 'fuori range')",
  is([[[true, 0], [100, 1]], 1, 2], { where: "compact.pattern", why: "point", point: 0 }));
assert("un BP group infilato nel pattern → compact.pattern, punto",
  is([[[[[0, 0], [1, 1]], "linear"], [100, 1]], 1, 2], { where: "compact.pattern", why: "point", point: 0 }));
assert("x NaN → compact.pattern, fuori da [0, 100]",
  is([[[NaN, 0], [100, 1]], 1, 2], { where: "compact.pattern", why: "range", point: 0 }));
assert("distribuzione ignota → compact.time_dist, nome",
  is([PAT, 1, 2, "linear", "bogus"], { where: "compact.time_dist", why: "name" }));
assert("distribuzione {type: null} → compact.time_dist, nome (non 'linear')",
  is([PAT, 1, 2, "linear", { type: null }], { where: "compact.time_dist", why: "name" }),
  show(err([PAT, 1, 2, "linear", { type: null }])));
assert("parametro fuori bound → compact.time_dist, parametro",
  is([PAT, 1, 2, "linear", { type: "geometric", ratio: 0 }], { where: "compact.time_dist", why: "param" }));
assert("…e l'errore della distribuzione e' quello di timeDistError, non una sua copia",
  show(err([PAT, 1, 2, "linear", "bogus"]).dist) === show(E.timeDistError("bogus", 2)));

console.log("\n── BP group ──");
assert("gruppo di un punto → group.points",
  is([[[0, 0]], "cubic"], { where: "group.points", why: "arity" }));
assert("gruppo vuoto → group.points (il motore lo riconosce come gruppo)",
  is([[], "linear"], { where: "group.points", why: "arity" }));
assert("gruppo in lista di un punto → group.points, con l'indice",
  is([[0, 0], [[[0.5, 1]], "step"]], { where: "group.points", index: 1 }));
assert("interp del gruppo ignota → group.interp",
  is([[[0, 0], [1, 1]], "cubicc"], { where: "group.interp", why: "interp", value: "cubicc" }));

console.log("\n── elementi non riconosciuti ──");
assert("una stringa in lista → point, con l'indice",
  is([[0, 0], "x"], { where: "point", why: "element", index: 1, value: "x" }));
assert("un breakpoint con la v booleana → point",
  is([[0, true], [1, 1]], { where: "point", index: 0 }));
assert("un dict con type null → point (normalizzato in [t, v, null])",
  is([{ t: 0, v: 0, type: null }], { where: "point", index: 0 }));
assert("un 3-tuple col terzo numerico → point",
  is([[0, 0], [1, 1], [2, 2, 3]], { where: "point", index: 2 }));
assert("un compatto con n_reps non intero, in lista → point (non e' un compatto)",
  is([[0, 0], [PAT, 1, 2.5]], { where: "point", index: 1 }));
assert("…e nella forma diretta il motore lo legge come lista: il primo elemento e' il pattern",
  is([PAT, 1, 2.5], { where: "point", index: 0 }));
assert("un compatto con sette elementi → point",
  is([[PAT, 1, 2, "linear", "linear", false, 9]], { where: "point", index: 0 }));
assert("il valore riportato e' l'elemento come scritto, dict compreso",
  show(err([{ t: 0, v: true }]).value) === show({ t: 0, v: true }), show(err([{ t: 0, v: true }])));

/* ═══════════════════════════════════════════════════════════════════════════
   L'ordine: il motore si ferma al primo guard, e l'errore e' quello
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── l'ordine dei guard ──");
assert("n_reps prima di end_time", is([[[0, 0], [150, 1]], true, true], { where: "compact.n_reps" }));
assert("end_time prima del pattern", is([[[0, 0], [150, 1]], true, 2], { where: "compact.end_time" }));
assert("il pattern prima della distribuzione",
  is([[[0, 0], [150, 1]], 1, 2, "linear", "bogus"], { where: "compact.pattern" }));
assert("il pattern vuoto prima dei punti", is([[], 0, 2], { where: "compact.end_time" }),
  "end_time 0 viene prima del pattern vuoto: " + show(err([[], 0, 2])));
assert("l'interp del gruppo prima della sua arita'",
  is([[[0, 0]], "cubicc"], { where: "group.interp" }));
assert("nella lista vince il primo elemento sbagliato",
  is([[0, "x"], [PAT, 1, true]], { where: "point", index: 0 }));
assert("la forma tipizzata passa i punti al builder: l'errore e' dentro",
  is({ type: "cubic", points: [[PAT, 1, true]] }, { where: "compact.n_reps", index: 0 }));

/* ═══════════════════════════════════════════════════════════════════════════
   Dove comincia un blocco. Nella forma diretta a 0; in una lista dall'ultimo
   breakpoint ESPANSO prima di lui — che dopo un compatto non e' il suo
   end_time: e' l'ultimo punto dell'ultimo ciclo. Con il pattern che finisce a
   x=50 quel punto sta a meta' dell'ultimo ciclo, e un secondo compatto che
   finisce prima dell'end_time del primo e' valido. L'anteprima
   (expandMixed) fa ripartire il blocco da end_time: e' il motore a decidere
   cosa si rifiuta, non il disegno.
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── l'inizio di un blocco ──");
assert("dopo un breakpoint il blocco comincia li'",
  is([[0, 0], [0.5, 1], [PAT, 0.5, 2]], { where: "compact.end_time", why: "offset", start: 0.5 }));
assert("il massimo dei breakpoint, non l'ultimo",
  is([[0.8, 0], [0.2, 1], [PAT, 0.5, 2]], { where: "compact.end_time", start: 0.8 }));
assert("dopo un gruppo, il suo ultimo punto",
  is([[[[0, 0], [0.7, 1]], "cubic"], [PAT, 0.6, 2]], { where: "compact.end_time", start: 0.7 }));
{
  const half = [[0, 0], [50, 1]];
  // 2 cicli da 0.5 su [0, 1]: l'ultimo punto e' 0.5 + 0.5 × 50% = 0.75.
  assert("dopo un compatto che finisce a x=50: 0.9 e' oltre l'ultimo punto, valido",
    err([[half, 1, 2], [PAT, 0.9, 2]]) === null, show(err([[half, 1, 2], [PAT, 0.9, 2]])));
  const early = err([[half, 1, 2], [PAT, 0.7, 2]]);
  assert("…e 0.7 no: l'inizio e' 0.75, non l'end_time del primo",
    early && early.where === "compact.end_time" && Math.abs(early.start - 0.75) < 1e-9, show(early));
  // Con wrap il motore aggiunge un punto a fine ciclo (end − 1e-6).
  const wrapped = err([[half, 1, 2, null, null, true], [PAT, 0.9, 2]]);
  assert("con wrap l'ultimo punto e' la fine del ciclo: 0.9 non basta piu'",
    wrapped && wrapped.where === "compact.end_time" && wrapped.start > 0.99, show(wrapped));
  // E la distribuzione conta: con cicli che accelerano l'ultimo e' corto.
  const expo = [[half, 1, 2, null, "exponential"], [PAT, 0.85, 2]];
  assert("con cicli esponenziali l'ultimo ciclo e' piu' corto: 0.85 e' valido",
    err(expo) === null, show(err(expo)));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Il punto cieco dichiarato: int e float. Il motore chiede `isinstance(n_reps,
   int)`, e in YAML `2.0` e' un float — non un compatto, quindi un errore.
   Di qua `2` e `2.0` arrivano come lo stesso Number: lo specchio tace. E' il
   verso sicuro (tace dove il motore parla, mai il contrario), lo stesso di
   `power.exponent` in timeDistError.
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── il punto cieco int/float ──");
assert("n_reps 2.0 non si distingue da 2: lo specchio tace (verso sicuro)",
  err([PAT, 1, 2.0]) === null);
