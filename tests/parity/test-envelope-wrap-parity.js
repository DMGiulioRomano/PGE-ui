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
const rewrap = (x) => { const w = E.unwrapEnv(x); return E.wrapEnv(w.items, w.interp, x); };
const commitPath = (items, interp, like) => E.wrapEnv(E.resugarBPGroups(items, interp || "linear"), interp, like);
const roundTrip = (x) => {
  const w = E.unwrapEnv(x);
  return commitPath(E.desugarBPGroups(w.items), w.interp, x);
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
  /* #191: con un blocco compatto fra gli item. Il dict resta dict; la lista
     che dice gia' il suo globale nello slot 3 del primo blocco resta lista;
     lo slot 3 di un blocco che il motore ignora non conta. */
  ["dict cubic con un blocco (la issue #191)",
    { type: "cubic", points: [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2]] }, true],
  ["dict cubic con un blocco step, ignorato dal motore",
    { type: "cubic", points: [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2, "step"]] }, true],
  ["lista che dichiara il globale nel blocco: step anche fuori",
    [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2, "step"]], false],
  ["lista con due blocchi: vale il primo che dichiara",
    [[0, 0], [[[0, 0], [50, 1], [100, 0]], 0.5, 2], [[[0, 1], [50, 0], [100, 1]], 1, 2, "cubic"]], false],
  ["blocco nudo cubico", [[[0, 0], [30, 1], [100, 0.5]], 1, 3, "cubic"], false],
];

/* `scaled` (facoltativo) e' lo stream che legge l'envelope — `{duration,
   time_mode}` — e il motore lo costruisce allora come lo costruisce uno
   stream (`create_scaled_envelope`), cioe' leggendo anche `time_unit`, che
   `Envelope` da solo ignora. I tempi sono quelli dell'envelope letto: secondi. */
const evaluate = async (ask, bodies, scaled = null, times = TIMES) => {
  const answers = await ask(bodies.map((raw) => ({
    op: "evaluate_envelope", args: { raw, times, ...(scaled || {}) } })));
  return answers.map((r, i) => {
    if (!r.ok) throw new Error(`oracolo: ${r.error}`);
    if (!r.value.ok) throw new Error(`il motore non valuta ${JSON.stringify(bodies[i])}: ${r.value.error}`);
    return r.value.values;
  });
};
const worst = (a, b, times = TIMES) => {
  let w = { d: 0, t: null };
  a.forEach((v, i) => { const d = Math.abs(v - b[i]); if (d > w.d) w = { d, t: times[i] }; });
  return w;
};
const same = (a, b) => worst(a, b).d <= TOL;
const fmtWorst = (a, b, times = TIMES) => {
  const w = worst(a, b, times); return `scarto massimo ${w.d.toExponential(3)} a t=${w.t}`;
};

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
      label: "time_unit sopravvive al commit: il motore legge i tempi nella stessa unita'",
      run: async (ask, assert) => {
        /* `wrapEnv` ricostruiva il dict con le sole `type` e `points`, e senza
           `type` scriveva la lista: `time_unit` spariva al primo commit. Per il
           motore prevale sul `time_mode` dello stream (`create_scaled_envelope`),
           quindi qui lo stream e' `normalized` e l'envelope dichiara secondi
           assoluti: perso, i tempi si rileggono come frazioni e si moltiplicano
           per la durata. */
        const STREAM = { duration: 4, time_mode: "normalized" };
        const SECS = [];
        for (let i = -4; i <= 84; i++) SECS.push(+(i / 20).toFixed(6));
        const BODIES = [
          ["type cubic, un'eccezione step",
            { type: "cubic", time_unit: "absolute", points: [[0, 0], [1, 2, "step"], [3, 1], [4, 0]] }],
          ["senza type (interp lineare)",
            { time_unit: "absolute", points: [[0, 0], [1, 2], [3, 1], [4, 0]] }],
          ["con un gruppo",
            { time_unit: "absolute", type: "cubic", points: [[0, 0], [[[1, 2], [2, 3]], "step"], [4, 0]] }],
        ];
        const raws = BODIES.map(([, x]) => x);
        const orig = await evaluate(ask, raws, STREAM, SECS);
        const out = await evaluate(ask, raws.map(roundTrip), STREAM, SECS);
        // Il presidio: senza time_unit lo stesso corpo suona diverso, o il
        // confronto sarebbe verde anche col difetto rimesso.
        const stripped = raws.map((x) => { const { time_unit, ...rest } = x; return rest; });
        const senza = await evaluate(ask, stripped, STREAM, SECS);
        BODIES.forEach(([label, x], i) => {
          assert(`${label}: il commit suona come l'originale`, same(orig[i], out[i]),
            `${fmtWorst(orig[i], out[i], SECS)}; scritto ${JSON.stringify(roundTrip(x))}`);
          assert(`${label}: …e senza time_unit no (il caso discrimina)`, !same(orig[i], senza[i]),
            fmtWorst(orig[i], senza[i], SECS));
        });
      },
    },
    {
      label: "con un blocco compatto il type globale sopravvive al commit (#191)",
      run: async (ask, assert) => {
        /* Fino a #191 wrapEnv scriveva la lista piatta appena c'era un blocco
           fra gli item, e il motore la suonava diversa dal dict: la
           divergenza che questa suite pretendeva. Deciso: il dict resta. */
        const LOOPED = { type: "cubic", points: [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2]] };
        const scritto = roundTrip(LOOPED);
        assert("il commit scrive il dict", !Array.isArray(scritto) && scritto.type === "cubic",
          JSON.stringify(scritto));
        const [o, s2, piatta] = await evaluate(ask, [LOOPED, scritto, LOOPED.points]);
        assert("…e il motore lo suona come l'originale", same(o, s2), fmtWorst(o, s2));
        assert("…mentre la lista piatta che si scriveva prima no (il caso discrimina)",
          !same(o, piatta), fmtWorst(o, piatta));
      },
    },
    {
      label: "l'interp di un blocco dal pannello del loop: suona quello scelto, il resto com'era (#191)",
      run: async (ask, assert) => {
        /* Il gesto che la issue temeva: "add loop" su una curva cubica, poi
           `step` sul blocco appena aggiunto. setBlockInterp lo scrive sui punti
           interni del pattern, che il motore legge uguale nelle due forme.
           Il "voluto" e' scritto qui: e' l'intento del gesto — il blocco a
           gradini dentro la curva che resta cubica — non un valore atteso. */
        const PAT = [[0, 0], [50, 1], [100, 0]];
        const CURVA = { type: "cubic", points: [[0, 0.2], [0.2, 1], [0.4, 0.6], [PAT, 0.9, 2], [1, 0.3]] };
        const w = E.unwrapEnv(CURVA);
        const items = E.desugarBPGroups(w.items);
        const res = E.setBlockInterp(items, 3, "step", w.interp, { dict: true });
        const scritto = commitPath(res.items, res.interp, CURVA);
        const voluto = { type: "cubic", points: [[0, 0.2], [0.2, 1], [0.4, 0.6],
                                                 [[[0, 0, "step"], [50, 1, "step"], [100, 0]], 0.9, 2], [1, 0.3]] };
        // Il gesto di prima: lo slot 3 del blocco, e la lista piatta.
        const prima = [[0, 0.2], [0.2, 1], [0.4, 0.6], [PAT, 0.9, 2, "step"], [1, 0.3]];
        const [v, s2, p] = await evaluate(ask, [voluto, scritto, prima]);
        assert("lo scritto suona come il voluto", same(v, s2), `${fmtWorst(v, s2)}; scritto ${JSON.stringify(scritto)}`);
        assert("…e il gesto di prima no: la curva fuori dal blocco diventava step (il caso discrimina)",
          !same(v, p), fmtWorst(v, p));

        // Il blocco che E' tutto l'envelope: il suo interp e' il globale, nello slot 3.
        const SOLO = [[PAT, 1, 4]];
        const r2 = E.setBlockInterp(SOLO, 0, "cubic", "linear", { dict: false });
        const scritto2 = commitPath(r2.items, r2.interp, SOLO);
        assert("blocco solo: lo slot 3 e' il globale, la lista resta lista",
          JSON.stringify(scritto2) === JSON.stringify([[PAT, 1, 4, "cubic"]]), JSON.stringify(scritto2));
        const [v2, s3] = await evaluate(ask, [{ type: "cubic", points: SOLO }, scritto2]);
        assert("…e suona come il blocco cubico", same(v2, s3), fmtWorst(v2, s3));
      },
    },
    {
      label: "l'interp globale dal selettore, con un blocco: si scrive dove il motore lo legge (#191)",
      run: async (ask, assert) => {
        const LISTA = [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2, "cubic"]];
        const w = E.unwrapEnv(LISTA);
        assert("la lista si apre col globale del suo blocco", w.interp === "cubic", w.interp);
        const items = E.desugarBPGroups(w.items);
        const scritto = commitPath(E.setGlobalInterp(items, "step"), "step", LISTA);
        const voluto = { type: "step", points: [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2]] };
        const [v, s2, o] = await evaluate(ask, [voluto, scritto, LISTA]);
        assert("lo scritto suona come il voluto (tutto step)", same(v, s2),
          `${fmtWorst(v, s2)}; scritto ${JSON.stringify(scritto)}`);
        assert("…e la lista resta lista: lo slot 3 del blocco dice step",
          Array.isArray(scritto) && scritto[2][3] === "step", JSON.stringify(scritto));
        assert("…e cambiare il globale cambia davvero il suono (il caso discrimina)", !same(v, o), fmtWorst(v, o));
      },
    },
  ],
});
