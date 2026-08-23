/* =============================================================================
 * test-time-dist-parity.js — `window.PGEEnv.timeDistError` e
 * `computeCycleDurations` contro le distribuzioni vere (issue #133).
 *
 * Questa suite esiste per una riga precisa di `tests/node/test-time-dist.js`:
 *
 *     "verificato eseguendo il motore, {geometric, ratio: 2} a 1024 cicli e
 *      {exponential, rate: 0.5} a 1025 alzano ParameterBoundError"
 *
 * Qualcuno ha lanciato il motore una volta e ha trascritto il risultato. Da
 * quel momento quei numeri sono un'affermazione sul motore che nessun test
 * poteva piu' smentire: se le soglie cambiassero, `test-time-dist.js`
 * resterebbe verde e l'editor avviserebbe (o tacerebbe) sul blocco sbagliato.
 * Qui le stesse coppie vengono ricalcolate dal motore a ogni run.
 *
 * Tre patti, in ordine di importanza:
 *
 *   1. NESSUN FALSO POSITIVO. Dove il mirror segnala un errore, il motore deve
 *      rifiutare davvero. Un avviso su uno YAML che rende e' il difetto peggiore
 *      di uno specchio: insegna a ignorare gli avvisi.
 *   2. La banda int/float e' larga uno. `timeDistError` modella la semantica
 *      INTERA di Python (piu' permissiva): dove ratio/rate sono float il motore
 *      trabocca un n_reps prima e la UI tace. La suite misura la larghezza di
 *      quella banda invece di crederle sulla parola.
 *   3. Le durate disegnate sono quelle del motore, quando la UI non dichiara
 *      un ripiego.
 *
 * Run: node tests/parity/test-time-dist-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["envelope-loops.js"]);
const E = window.PGEEnv;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const T = 2.0;

/* Corpus dei costruttori: nomi, alias, bound, tipi. Nessuna aspettativa
 * scritta — la risposta e' `TimeDistributionFactory.create`. */
const SPECS = [
  null, "linear", "exponential", "exp", "logarithmic", "log", "geometric",
  "geo", "power", "Exponential", "GEOMETRIC", "bogus", "",
  { type: "geometric", ratio: 1.5 }, { type: "geometric", ratio: 0 },
  { type: "geometric", ratio: -1 }, { type: "geometric", ratio: 1 },
  { type: "exponential", rate: 2 }, { type: "exponential", rate: 0 },
  { type: "exponential", rate: -0.5 },
  { type: "logarithmic", base: 2 }, { type: "logarithmic", base: 1 },
  { type: "logarithmic", base: 0.5 },
  { type: "power", exponent: 2 }, { type: "power", exponent: -3 },
  { type: "power", exponent: 0 }, { type: "power", exponent: "x" },
  { type: "bogus" }, { type: 5 }, { ratio: 1.5 },
  { type: "exponential", ratio: 1.5 }, { type: "geometric", rate: 2 },
  { type: "geometric", ratio: 1.5, extra: 1 },
];

/* Le coppie (spec, n_reps) su cui `test-time-dist.js` afferma qualcosa del
 * motore. Ricalcolate qui. */
const OVERFLOW_PAIRS = [
  [{ type: "geometric", ratio: 10 }, 308], [{ type: "geometric", ratio: 10 }, 309],
  [{ type: "geometric", ratio: 10 }, 310], [{ type: "geometric", ratio: 10 }, 400],
  [{ type: "geometric", ratio: 2 }, 1024], [{ type: "geometric", ratio: 2 }, 1025],
  [{ type: "geometric", ratio: 2.5 }, 775],
  [{ type: "geometric", ratio: 0.1 }, 1000],
  [{ type: "exponential", rate: 0.5 }, 1023], [{ type: "exponential", rate: 0.5 }, 1025],
  [{ type: "exponential", rate: 0.5 }, 1026], [{ type: "exponential", rate: 0.5 }, 1200],
  [{ type: "exponential", rate: 0.25 }, 513],
  [{ type: "exponential", rate: 0.1 }, 300], [{ type: "exponential", rate: 0.1 }, 400],
  [{ type: "exponential", rate: 2 }, 2000],
  [{ type: "power", exponent: 200.5 }, 4], [{ type: "power", exponent: 200.5 }, 400],
  [{ type: "power", exponent: -200.5 }, 400],
  [{ type: "power", exponent: 200 }, 400], [{ type: "power", exponent: 400 }, 400],
  [{ type: "power", exponent: 1000 }, 4],
  ["geometric", 1747], ["geometric", 1760],
  ["linear", 4000], [{ type: "logarithmic", base: 2 }, 2000],
];

/* Distribuzioni sane su cui confrontare le durate una a una. */
const DURATION_CASES = [
  [{ type: "geometric", ratio: 1.5 }, 8], [{ type: "geometric", ratio: 0.5 }, 16],
  [{ type: "geometric", ratio: 1 }, 5], [{ type: "geometric", ratio: 1.000000002 }, 4],
  [{ type: "exponential", rate: 2 }, 10], [{ type: "exponential", rate: 0.5 }, 12],
  [{ type: "logarithmic", base: 2 }, 9], [{ type: "logarithmic", base: 10 }, 7],
  [{ type: "power", exponent: 2 }, 11], [{ type: "power", exponent: 0.5 }, 13],
  [{ type: "power", exponent: -1 }, 6],
  ["linear", 4], ["exp", 5], ["geo", 6], ["log", 7],
  [null, 3],
];

/* Cerca il primo n per cui il lato dato rifiuta, per bisezione: e' il numero
 * che i commenti di test-time-dist.js affermano a mano. */
async function firstRejected(ask, spec, lo, hi, side) {
  const probe = async (n) => {
    if (side === "ui") return E.timeDistError(spec, n) !== null;
    const r = await ask("build_time_distribution", { spec, n_reps: n, total_time: T });
    if (!r.ok) throw new Error(`oracolo: ${r.error}`);
    return r.value.build_error !== null || r.value.calc_error !== null;
  };
  if (!(await probe(hi))) return null;      // non rifiuta nemmeno in cima
  if (await probe(lo)) return lo;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await probe(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

parity({
  suite: "time-distribution",
  why: "window.PGEEnv.timeDistError / computeCycleDurations  ↔  pge.envelopes.time_distribution",
  cases: [
    {
      label: "il registro dei nomi e' quello del factory",
      run: async (ask, assert) => {
        const c = (await ask("constants", {})).value;
        assert("TIME_DIST_NAMES === TimeDistributionFactory.list_available()",
          eq([...E.TIME_DIST_NAMES].sort(), c.time_distribution_names),
          `ui=${JSON.stringify([...E.TIME_DIST_NAMES].sort())} motore=${JSON.stringify(c.time_distribution_names)}`);
      },
    },
    {
      label: "i costruttori: valido di qua ⇔ costruibile di la'",
      run: async (ask, assert) => {
        const answers = await ask(SPECS.map(spec => ({
          op: "build_time_distribution", args: { spec } })));
        const bad = [];
        SPECS.forEach((spec, i) => {
          const r = answers[i];
          if (!r.ok) { bad.push({ spec, note: `oracolo: ${r.error}` }); return; }
          const uiOk = E.timeDistError(spec) === null;
          const engineOk = r.value.build_error === null;
          if (uiOk !== engineOk) {
            bad.push({ spec, uiOk, engineOk, engineSays: r.value.build_error });
          }
        });
        assert(`${SPECS.length} spec, stesso verdetto di costruzione`,
          bad.length === 0,
          bad.map(b => `${JSON.stringify(b.spec)}: ui=${b.uiOk} motore=${b.engineOk} ${b.engineSays || b.note || ""}`).join("\n      "));
      },
    },
    {
      label: "overflow: dove la UI avvisa il motore rifiuta davvero",
      run: async (ask, assert, ctx) => {
        const answers = await ask(OVERFLOW_PAIRS.map(([spec, n]) => ({
          op: "build_time_distribution", args: { spec, n_reps: n, total_time: T } })));

        const falsePositives = [], agree = [], uiSilentEngineFails = [];
        OVERFLOW_PAIRS.forEach(([spec, n], i) => {
          const r = answers[i];
          if (!r.ok) throw new Error(`oracolo su ${JSON.stringify(spec)}@${n}: ${r.error}`);
          const uiErr = E.timeDistError(spec, n);
          const engineFails = r.value.build_error !== null || r.value.calc_error !== null;
          const label = `${JSON.stringify(spec)}@${n}`;
          if (uiErr !== null && !engineFails) falsePositives.push(`${label} — ui: ${uiErr.kind}`);
          else if (uiErr !== null && engineFails) agree.push(label);
          else if (uiErr === null && engineFails) {
            uiSilentEngineFails.push(`${label} — motore: ${r.value.calc_error || r.value.build_error}`);
          }
        });

        assert(`nessun falso positivo (${agree.length} coppie segnalate, tutte rifiutate dal motore)`,
          falsePositives.length === 0, falsePositives.join("\n      "));
        // Il verso opposto e' ammesso, ed e' la banda int/float: la UI modella
        // il quoziente intero, piu' permissivo. Non e' un'asserzione — misurarlo
        // e' compito del caso dopo, che cerca le due soglie; qui l'elenco serve
        // a chi legge l'output, quindi si stampa invece di fingersi un assert.
        ctx.note(`la UI tace su ${uiSilentEngineFails.length} coppie che il motore rifiuta (banda int/float, misurata sotto)`,
          uiSilentEngineFails);
      },
    },
    {
      label: "la banda int/float e' larga uno, non 'circa uno'",
      run: async (ask, assert) => {
        // I tre casi che test-time-dist.js afferma a mano. La soglia della UI
        // e la soglia del motore vengono cercate, non scritte.
        const probes = [
          [{ type: "geometric", ratio: 2 }, 900, 1200],
          [{ type: "exponential", rate: 0.5 }, 900, 1200],
          [{ type: "geometric", ratio: 10 }, 200, 400],
        ];
        for (const [spec, lo, hi] of probes) {
          const uiN = await firstRejected(ask, spec, lo, hi, "ui");
          const engN = await firstRejected(ask, spec, lo, hi, "engine");
          const label = JSON.stringify(spec);
          assert(`${label}: entrambi i lati hanno una soglia in [${lo}, ${hi}]`,
            uiN !== null && engN !== null, `ui=${uiN} motore=${engN}`);
          if (uiN === null || engN === null) continue;
          assert(`${label}: la UI non segnala prima del motore (motore @${engN}, ui @${uiN})`,
            uiN >= engN, `ui=${uiN} motore=${engN}`);
          assert(`${label}: la banda e' larga ${uiN - engN} (dichiarata: al massimo 1)`,
            uiN - engN <= 1, `ui=${uiN} motore=${engN}`);
        }
      },
    },
    {
      label: "le durate disegnate sono quelle del motore",
      run: async (ask, assert) => {
        const answers = await ask(DURATION_CASES.map(([spec, n]) => ({
          op: "build_time_distribution",
          args: { spec, n_reps: n, total_time: T, durations: true } })));

        const bad = [];
        DURATION_CASES.forEach(([spec, n], i) => {
          const r = answers[i];
          if (!r.ok || r.value.calc_error) {
            bad.push(`${JSON.stringify(spec)}@${n}: il motore non ha calcolato — ${r.error || r.value.calc_error}`);
            return;
          }
          const mine = E.computeCycleDurations(T, n, spec);
          const theirs = r.value.durations;
          if (E.isPreviewFallback(mine)) {
            // Il ripiego si dichiara: qui non c'e' niente da confrontare, ma
            // NON deve accendersi su una distribuzione che il motore calcola
            // senza problemi — e' il caso in cui l'anteprima e' plausibile e
            // sbagliata, e il pannello avvisa a sproposito.
            bad.push(`${JSON.stringify(spec)}@${n}: la UI ripiega su cicli uguali mentre il motore calcola`);
            return;
          }
          if (mine.length !== theirs.length) {
            bad.push(`${JSON.stringify(spec)}@${n}: ${mine.length} durate contro ${theirs.length}`);
            return;
          }
          for (let k = 0; k < mine.length; k++) {
            const scale = Math.max(Math.abs(theirs[k]), 1e-12);
            if (Math.abs(mine[k] - theirs[k]) / scale > 1e-9) {
              bad.push(`${JSON.stringify(spec)}@${n}: ciclo ${k} ui=${mine[k]} motore=${theirs[k]}`);
              return;
            }
          }
        });
        assert(`${DURATION_CASES.length} distribuzioni, durate identiche a meno di 1e-9 relativo`,
          bad.length === 0, bad.join("\n      "));
      },
    },
    {
      label: "il ripiego dell'anteprima si accende solo dove serve",
      run: async (ask, assert) => {
        // La banda dichiarata in test-time-dist.js: `timeDistError` tace, il
        // motore rifiuta, e la guardia sull'output ripiega. Che il motore
        // rifiuti e' un'affermazione che qui si verifica.
        const banda = [
          [{ type: "geometric", ratio: 2 }, 1024],
          [{ type: "exponential", rate: 0.5 }, 1025],
          [{ type: "geometric", ratio: 2.5 }, 775],
          [{ type: "exponential", rate: 0.25 }, 513],
        ];
        const answers = await ask(banda.map(([spec, n]) => ({
          op: "build_time_distribution", args: { spec, n_reps: n, total_time: T } })));
        banda.forEach(([spec, n], i) => {
          const r = answers[i];
          const label = `${JSON.stringify(spec)}@${n}`;
          assert(`${label}: il motore rifiuta davvero (era scritto a mano)`,
            r.ok && r.value.calc_error !== null,
            JSON.stringify(r.ok ? r.value : r.error));
          assert(`${label}: timeDistError tace (soglia intera, voluto)`,
            E.timeDistError(spec, n) === null);
          assert(`${label}: la guardia sull'output ripiega e lo dichiara`,
            E.isPreviewFallback(E.computeCycleDurations(T, n, spec)) === true);
        });
      },
    },
  ],
});
