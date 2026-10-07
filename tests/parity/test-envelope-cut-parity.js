/* =============================================================================
 * test-envelope-cut-parity.js — il taglio di un envelope (resize col freeze,
 * split al cursore) suona come l'originale fino al bordo.
 *
 * `truncateEnvArray` tiene la testa e chiude con un punto CALCOLATO a x=1;
 * `sliceEnvArray` tiene la coda e la riapre con un punto calcolato a x'=0. Il
 * valore di quel punto lo decide `boundaryY` dall'interp del segmento tagliato,
 * e quell'interp guardava il solo tag scritto sul punto: un punto nudo era
 * lineare dappertutto. Non lo e': nel dict `{type, points}` segue il `type`,
 * in un BP group l'interp del gruppo, su read_direction lo step che il motore
 * impone (`{type: step, points}`, read_direction.py). Su uno step il bordo
 * cadeva interpolato, cioe' un gradino che l'envelope non ha.
 *
 * La domanda e' al motore, valore per valore: l'envelope tagliato, valutato
 * sulla sua griglia, contro l'originale valutato agli stessi istanti assoluti.
 * Nessun valore atteso e' scritto di qua, tranne il presidio: per i corpi a
 * gradino il valore lineare che il taglio scriveva prima deve essere DIVERSO
 * da quello del motore al bordo, o il confronto sarebbe verde anche col
 * difetto rimesso.
 *
 * Run: node tests/parity/test-envelope-cut-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["yaml-bridge.js", "envelope-loops.js",
                           "deviation-probability.js", "envelope-utils.js"]);
const U = window.PGEEnvUtils;

const GRID = [];
for (let i = 0; i <= 200; i++) GRID.push(i / 200);
// Il punto calcolato e' arrotondato a 4 decimali (`close` in envelope-utils).
const TOL = 1e-4;

const evaluate = async (ask, bodies, times) => {
  const answers = await ask(bodies.map(([raw, ts]) => ({
    op: "evaluate_envelope", args: { raw, times: ts || times } })));
  return answers.map((r, i) => {
    if (!r.ok) throw new Error(`oracolo: ${r.error}`);
    if (!r.value.ok) throw new Error(`il motore non valuta ${JSON.stringify(bodies[i][0])}: ${r.value.error}`);
    return r.value.values;
  });
};
const worst = (a, b) => {
  let w = { d: 0, i: -1 };
  a.forEach((v, i) => { const d = Math.abs(v - b[i]); if (d > w.d) w = { d, i }; });
  return w;
};

/* read_direction come la legge il motore: qualunque forma diventa
   `{type: step, points: <raw>}`. */
const asDirection = (raw) => ({ type: "step", points: raw });

/* [etichetta, originale, tagliato, valore lineare che il taglio scriveva
   prima (null dove non c'era difetto)] */
const TRUNCATE = [
  ["{type: step}", { type: "step", points: [[0, 0], [0.5, 1], [1.5, 3]] }, null, 2],
  ["{type: step} con un tag linear che vince",
    { type: "step", points: [[0, 0], [0.5, 1, "linear"], [1.5, 3]] }, null, null],
  ["BP group step", [[[[0.15, 1], [0.75, 3], [1.2, 0]], "step"]], null, 1.3333],
  ["{type: step} dopo un gruppo linear",
    { type: "step", points: [[[[0, 0], [0.4, 1]], "linear"], [1.5, 3]] }, null, 2.0909],
  ["{type: step} dopo un blocco",
    { type: "step", points: [[[[0, 0], [100, 1]], 0.5, 2], [1.5, 3]] }, null, 2],
  ["lista lineare", [[0, 0], [1.5, 3]], null, null],
].map(([label, raw, , lin]) => [label, raw, U.truncateEnvArray(raw), lin]);
{
  const rd = [[0, 1], [1.1, -1]];
  const cut = U.truncateStreamEnvelopes({ grain: { readDirectionEnv: rd } }).grain.readDirectionEnv;
  TRUNCATE.push(["read_direction (step imposto)", asDirection(rd), asDirection(cut), -1]);
}

const CUT = 0.5;
const SLICE = [
  ["{type: step}", { type: "step", points: [[0, 0.2], [1, 1]] }, 0.6],
  ["BP group step", [[[[0, 1], [0.6, 3], [1, 0]], "step"]], 2.6667],
  ["lista lineare", [[0, 0], [1, 1]], null],
].map(([label, raw, lin]) => [label, raw, U.sliceEnvArray(raw, CUT), lin]);
{
  const rd = [[0, -1], [1, 1]];
  const tail = U.sliceStreamEnvelopes({ grain: { readDirectionEnv: rd } }, CUT).stream.grain.readDirectionEnv;
  SLICE.push(["read_direction (step imposto)", asDirection(rd), asDirection(tail), 1]);
}

parity({
  suite: "envelope-cut",
  why: "PGEEnvUtils.truncateEnvArray / sliceEnvArray  ↔  pge.envelopes.envelope.Envelope.evaluate",
  cases: [
    {
      label: "truncate: la testa tagliata suona come l'originale fino al bordo",
      run: async (ask, assert) => {
        const orig = await evaluate(ask, TRUNCATE.map(([, raw]) => [raw]), GRID);
        const cut = await evaluate(ask, TRUNCATE.map(([, , c]) => [c]), GRID);
        TRUNCATE.forEach(([label, , c, lin], i) => {
          const w = worst(orig[i], cut[i]);
          assert(label, w.d <= TOL,
            `scarto ${w.d.toExponential(3)} a t=${GRID[w.i]}; scritto ${JSON.stringify(c)}`);
          if (lin != null) {
            // Il presidio: il valore che il taglio scriveva prima non e' quello
            // del motore al bordo (l'ultimo punto della griglia, t=1).
            const at1 = orig[i][GRID.length - 1];
            assert(`${label}: il valore lineare di prima (${lin}) non era quello del motore (${at1})`,
              Math.abs(at1 - lin) > TOL);
          }
        });
      },
    },
    {
      label: "slice: la coda suona come l'originale dal taglio in poi",
      run: async (ask, assert) => {
        // x' della coda ↔ x = CUT + x'·(1 − CUT) dell'originale.
        const abs = GRID.map((x) => CUT + x * (1 - CUT));
        const orig = await evaluate(ask, SLICE.map(([, raw]) => [raw, abs]));
        const tail = await evaluate(ask, SLICE.map(([, , t]) => [t, GRID]));
        SLICE.forEach(([label, , t, lin], i) => {
          const w = worst(orig[i], tail[i]);
          assert(label, w.d <= TOL,
            `scarto ${w.d.toExponential(3)} a x'=${GRID[w.i]}; scritto ${JSON.stringify(t)}`);
          if (lin != null) {
            assert(`${label}: il valore lineare di prima (${lin}) non era quello del motore (${orig[i][0]})`,
              Math.abs(orig[i][0] - lin) > TOL);
          }
        });
      },
    },
  ],
});
