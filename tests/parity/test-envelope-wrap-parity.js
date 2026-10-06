/* =============================================================================
 * test-envelope-wrap-parity.js — il commit dell'EnvelopeEditor non cambia
 * cosa il motore suona (#189).
 *
 * `wrapEnv` (envelope-loops.js) e' la porta da cui esce ogni envelope che
 * l'editor scrive. Fino a #189 un `{type: T, points}` con un 3-tuple o un BP
 * group fra gli item usciva come lista piatta: per il motore il `type` del
 * dict e' il tipo di ogni segmento che non ne dichiara uno sul punto
 * (`Envelope._parse_segments`), in una lista piatta quel segmento e' `linear`.
 * Il corpo restava valido — `build_envelope` lo costruiva — e suonava diverso.
 * Per questo la domanda qui non e' il verdetto ma il VALORE: lo stesso
 * envelope, prima e dopo il commit, valutato dal motore sugli stessi tempi.
 *
 * Nessun valore atteso e' scritto di qua: i due termini del confronto sono
 * entrambi risposte del motore.
 *
 * Run: node tests/parity/test-envelope-wrap-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["envelope-loops.js"]);
const E = window.PGEEnv;

/* Una griglia fitta, piu' un margine fuori da [0, 1] (prima del primo punto
   e dopo l'ultimo il motore tiene gli estremi, e anche quello deve restare). */
const TIMES = [];
for (let i = -20; i <= 420; i++) TIMES.push(+(i / 400).toFixed(6));
const TOL = 1e-9;

/* Le due scritture dell'editor. `rewrap` e' l'espressione dell'acceptance
   criterion della issue; `roundTrip` e' il percorso vero di ogni commit
   (EnvelopeEditor.jsx: commit, commitCur, le frecce, il paste) — desugar per
   lavorare sugli indici piatti, resugar + wrap per scrivere. */
const rewrap = (x) => { const w = E.unwrapEnv(x); return E.wrapEnv(w.items, w.interp); };
const commitPath = (items, interp) => E.wrapEnv(E.resugarBPGroups(items, interp || "linear"), interp);
const roundTrip = (x) => {
  const w = E.unwrapEnv(x);
  return commitPath(E.desugarBPGroups(w.items), w.interp);
};

// fill_factor di stream4 in mare-nostrum.yml: il {type: cubic} della issue.
const FF = { type: "cubic", points: [[0, 2], [0.0926, 2.01], [0.1631, 0.46], [0.2586, 0.4], [0.3133, 2.75], [1, 1]] };

/* Il corpus: corpi `{type, points}` che l'editor puo' aprire e riscrivere.
   `flatDiffers` dice se, per costruzione, la lista piatta degli stessi item
   suona diversa: e' il presidio che il confronto discrimini. */
const CORPUS = [
  ["forma mista (la riproduzione della issue)",
    { type: "cubic", points: [[0, 2], [0.2586, 0.4, "linear"], [1, 1]] }, true],
  ["BP group fra due breakpoint nudi",
    { type: "cubic", points: [[0, 2], [[[0.1, 1], [0.2, 3], [0.3, 0]], "step"], [1, 1]] }, true],
  ["step globale, cubic sul punto",
    { type: "step", points: [[0, 0], [0.5, 1, "cubic"], [0.7, 0.2, "cubic"], [1, 1]] }, true],
  ["due gruppi in fila e un punto nudo",
    { type: "cubic", points: [[[[0, 0], [0.2, 1], [0.3, 0.5]], "step"], [[[0.5, 2], [0.7, 0]], "linear"], [0.9, 1.5], [1, 0.2]] }, true],
  ["un gruppo che copre tutto l'envelope (si ricompatta)",
    { type: "cubic", points: [[[[0, 0], [0.3, 1], [0.6, 0.2], [1, 1]], "step"]] }, false],
  ["soli breakpoint nudi (il caso che c'era gia')", FF, true],
];

const evaluate = async (ask, bodies) => {
  const answers = await ask(bodies.map((raw) => ({ op: "evaluate_envelope", args: { raw, times: TIMES } })));
  return answers.map((r, i) => {
    if (!r.ok) throw new Error(`oracolo: ${r.error}`);
    if (!r.value.ok) throw new Error(`il motore non valuta ${JSON.stringify(bodies[i])}: ${r.value.error}`);
    return r.value.values;
  });
};
const worst = (a, b) => {
  let w = { d: 0, t: null };
  a.forEach((v, i) => { const d = Math.abs(v - b[i]); if (d > w.d) w = { d, t: TIMES[i] }; });
  return w;
};
const same = (a, b) => worst(a, b).d <= TOL;
const fmtWorst = (a, b) => { const w = worst(a, b); return `scarto massimo ${w.d.toExponential(3)} a t=${w.t}`; };

parity({
  suite: "envelope-wrap",
  why: "window.PGEEnv.wrapEnv ∘ unwrapEnv  ↔  pge.envelopes.envelope.Envelope.evaluate (#189)",
  cases: [
    {
      label: "il corpus discrimina: la lista piatta degli stessi item suona diversa",
      run: async (ask, assert) => {
        const rows = CORPUS.filter(([, , differs]) => differs);
        const orig = await evaluate(ask, rows.map(([, x]) => x));
        const flat = await evaluate(ask, rows.map(([, x]) => E.unwrapEnv(x).items));
        /* Senza questo, un confronto che non distingue le due forme sarebbe
           verde anche con il difetto rimesso. */
        const mute = rows.filter((r, i) => same(orig[i], flat[i])).map(([label]) => label);
        assert(`${rows.length} corpi dove il type globale conta davvero`,
          mute.length === 0, mute.join("\n      "));
      },
    },
    {
      label: "wrapEnv(unwrapEnv(x)) suona come x",
      run: async (ask, assert) => {
        const orig = await evaluate(ask, CORPUS.map(([, x]) => x));
        const out = await evaluate(ask, CORPUS.map(([, x]) => rewrap(x)));
        CORPUS.forEach(([label, x], i) => {
          assert(label, same(orig[i], out[i]),
            `${fmtWorst(orig[i], out[i])}; scritto ${JSON.stringify(rewrap(x))}`);
        });
      },
    },
    {
      label: "il round-trip di un commit dell'editor senza modifiche suona come x",
      run: async (ask, assert) => {
        const orig = await evaluate(ask, CORPUS.map(([, x]) => x));
        const out = await evaluate(ask, CORPUS.map(([, x]) => roundTrip(x)));
        CORPUS.forEach(([label, x], i) => {
          assert(label, same(orig[i], out[i]),
            `${fmtWorst(orig[i], out[i])}; scritto ${JSON.stringify(roundTrip(x))}`);
        });
      },
    },
    {
      label: "setZoneInterp su fill_factor di stream4: il motore suona quello voluto",
      run: async (ask, assert) => {
        /* Il gesto della issue: una zona di tre punti (indici 1..3) portata a
           `step`. setZoneInterp tagga i punti interni della zona — o li lascia
           nudi se il tipo scelto e' il default — e committa. Il "voluto" e'
           scritto qui: e' l'intento del gesto, il dict con le due eccezioni,
           non una risposta attesa del motore. */
        const w = E.unwrapEnv(FF);
        const rawEnv = E.desugarBPGroups(w.items);
        const internal = new Set([1, 2]);
        const next = rawEnv.map((it, i) =>
          (!internal.has(i) || !E.isBreakpoint(it)) ? it
            : ("step" === w.interp ? [it[0], it[1]] : [it[0], it[1], "step"]));
        const scritto = commitPath(next, w.interp);
        const voluto = { type: "cubic", points: next };
        const [v, s, piatto] = await evaluate(ask, [voluto, scritto, next]);
        assert("lo scritto suona come il voluto", same(v, s),
          `${fmtWorst(v, s)}; scritto ${JSON.stringify(scritto)}`);
        assert("…e la lista piatta che si scriveva prima di #189 no: il caso discrimina",
          !same(v, piatto), fmtWorst(v, piatto));
      },
    },
    {
      label: "la divergenza dichiarata: con un blocco compatto il type globale si perde ancora (#191)",
      run: async (ask, assert) => {
        /* Con un blocco compatto fra gli item wrapEnv scrive ancora la lista
           piatta (envelope-loops.js, e il caso dichiarato in
           test-bp-groups.js). Il motore legge l'interp di un blocco in due
           modi diversi secondo la forma — nella lista quello del primo blocco
           diventa il tipo globale, nel dict viene ignorato — e l'editor lo
           disegna per blocco: la decisione e' della issue #191. Asserita qui
           perche' una divergenza che sparisce deve far parlare un test, non
           lasciare un commento stantio. */
        const LOOPED = { type: "cubic", points: [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2]] };
        const scritto = rewrap(LOOPED);
        assert("wrapEnv scrive la lista piatta", Array.isArray(scritto), JSON.stringify(scritto));
        const [o, s] = await evaluate(ask, [LOOPED, scritto]);
        assert("…e il motore la suona diversa dal dict", !same(o, s), fmtWorst(o, s));
      },
    },
  ],
});
