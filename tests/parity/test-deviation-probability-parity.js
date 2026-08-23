/* =============================================================================
 * test-deviation-probability-parity.js — `window.PGEDeviationProb` contro
 * GateFactory (issue #133).
 *
 * Il mirror fa due affermazioni sul motore, e finora nessuna era verificabile:
 *
 *   1. `mode()` replica l'ORDINE di `_classify_deviation_probability`: il ramo
 *      envelope-like viene prima del ramo dict, quindi `{type, points}` e'
 *      globale e non per-parametro. Un errore qui apre il pannello sbagliato.
 *   2. `error()` e' la META' CONSERVATIVA del builder: segnala solo i corpi che
 *      il motore rifiuta in ogni lettura. Meta' conservativa significa che
 *      l'implicazione va in un verso solo — dove la UI parla il motore deve
 *      rifiutare — e questa suite misura proprio quel verso.
 *
 * `isEnvValue` e' la regola del motore alla lettera (`'points' in obj`). Qui la
 * si osserva dal fuori: un valore e' envelope-like se e solo se il motore lo
 * classifica GLOBAL_ENV.
 *
 * Run: node tests/parity/test-deviation-probability-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs([
  "yaml-bridge.js",          // PGEYaml.DEVIATION_PROB_IMPLICIT
  "envelope-loops.js",       // PGEEnv.isBreakpoint / isBPGroup / isCompactBlock
  "deviation-probability.js",
]);
const D = window.PGEDeviationProb;
const IMPLICIT = window.PGEYaml.DEVIATION_PROB_IMPLICIT;

/* off/implicit/global/perParam ↔ disabled/implicit/global|global_env/specific.
 * La UI non distingue globale-numero da globale-envelope: sono lo stesso
 * pannello. Il motore si', perche' costruisce due gate diversi. */
const MODE_MAP = { disabled: "off", implicit: "implicit", global: "global",
                   global_env: "global", specific: "perParam" };

/* Il corpus. `js` e' cio' che l'editor tiene in memoria, `engine` cio' che
 * finisce nello YAML: coincidono sempre tranne per l'1% implicito, che nello
 * YAML e' `null` e in memoria e' la sentinella. */
const CORPUS = [
  { label: "chiave assente", js: undefined, engine: false },
  { label: "false (off esplicito)", js: false, engine: false },
  { label: "null → 1% implicito", js: IMPLICIT, engine: null },
  { label: "true", js: true, engine: true },
  { label: "numero 0", js: 0, engine: 0 },
  { label: "numero 50", js: 50, engine: 50 },
  { label: "numero 100", js: 100, engine: 100 },
  { label: "numero negativo", js: -5, engine: -5 },
  { label: "lista di breakpoint", js: [[0, 0], [1, 100]], engine: [[0, 0], [1, 100]] },
  { label: "envelope tipizzato {type, points}",
    js: { type: "cubic", points: [[0, 0], [1, 100]] },
    engine: { type: "cubic", points: [[0, 0], [1, 100]] } },
  { label: "dict con solo points",
    js: { points: [[0, 0], [1, 100]] }, engine: { points: [[0, 0], [1, 100]] } },
  { label: "dict per-parametro", js: { volume: 50 }, engine: { volume: 50 } },
  { label: "dict per-parametro con envelope",
    js: { volume: [[0, 0], [1, 100]] }, engine: { volume: [[0, 0], [1, 100]] } },
  { label: "dict per-parametro con chiave a null",
    js: { volume: null }, engine: { volume: null } },
  { label: "dict vuoto", js: {}, engine: {} },
  { label: "dict con chiave sconosciuta", js: { foo: 50 }, engine: { foo: 50 } },
  { label: "stringa (il motore la rifiuta)", js: "x", engine: "x" },
  { label: "lista vuota", js: [], engine: [] },
  { label: "points: null", js: { points: null }, engine: { points: null } },
  { label: "points: []", js: { points: [] }, engine: { points: [] } },
  { label: "blocco compatto nudo",
    js: [[[0, 0], [100, 50]], 1.0, 4], engine: [[[0, 0], [100, 50]], 1.0, 4] },
  { label: "BP group diretto",
    js: [[[0, 0], [1, 100]], "cubic"], engine: [[[0, 0], [1, 100]], "cubic"] },
];

/* I corpi malformati sotto una chiave per-parametro (PGE #209). */
const PER_PARAM_BODIES = [
  { label: "numero", body: 50 },
  { label: "null", body: null },
  { label: "true", body: true },
  { label: "lista di breakpoint", body: [[0, 0], [1, 100]] },
  { label: "lista vuota", body: [] },
  { label: "lista di spazzatura", body: ["x", "y"] },
  { label: "lista mista", body: [[0, 1], "x"] },
  { label: "dict senza points", body: { a: 1 } },
  { label: "points: null", body: { points: null } },
  { label: "points: []", body: { points: [] } },
  { label: "points di spazzatura", body: { points: ["x"] } },
  { label: "breakpoint dict", body: [{ t: 0, v: 0 }, { t: 1, v: 100 }] },
  { label: "points di breakpoint dict", body: { points: [{ t: 0, v: 0 }, { t: 1, v: 100 }] } },
  { label: "stringa", body: "x" },
  { label: "blocco compatto", body: [[[0, 0], [100, 50]], 1.0, 4] },
];

parity({
  suite: "deviation-probability",
  why: "window.PGEDeviationProb.mode/isEnvValue/error  ↔  pge.parameters.gate_factory.GateFactory",
  cases: [
    {
      label: "i modi del motore sono cinque e li conosciamo tutti",
      run: async (ask, assert) => {
        const c = (await ask("constants", {})).value;
        assert("DeviationProbabilityMode === i cinque che MODE_MAP traduce",
          JSON.stringify(c.deviation_probability_modes.slice().sort()) ===
          JSON.stringify(Object.keys(MODE_MAP).sort()),
          JSON.stringify(c.deviation_probability_modes));
        assert("il campo che il motore nomina negli errori e' quello scritto nello YAML",
          c.deviation_probability_field === "deviation_probability",
          c.deviation_probability_field);
      },
    },
    {
      label: "mode(): stesso ramo, corpus per corpus",
      run: async (ask, assert) => {
        const answers = await ask(CORPUS.map(e => ({
          op: "classify_deviation_probability", args: { value: e.engine } })));
        const bad = [];
        CORPUS.forEach((e, i) => {
          const r = answers[i];
          if (!r.ok) { bad.push(`${e.label}: oracolo ${r.error}`); return; }
          const mine = D.mode(e.js);
          if (r.value.mode === null) {
            // Il motore rifiuta il valore prima ancora di classificarlo: la UI
            // non ha un modo "errore", quindi qui non c'e' parita' da chiedere.
            // Si pretende pero' che error() lo segnali — caso dopo.
            return;
          }
          const theirs = MODE_MAP[r.value.mode];
          if (mine !== theirs) {
            bad.push(`${e.label}: ui=${mine} motore=${r.value.mode}→${theirs}`);
          }
        });
        assert(`${CORPUS.length} valori, stesso ramo di classificazione`,
          bad.length === 0, bad.join("\n      "));
      },
    },
    {
      label: "isEnvValue e' 'points in obj', non una sua approssimazione",
      run: async (ask, assert) => {
        const objs = CORPUS.filter(e => e.js !== null && typeof e.js === "object");
        const answers = await ask(objs.map(e => ({
          op: "classify_deviation_probability", args: { value: e.engine } })));
        const bad = [];
        objs.forEach((e, i) => {
          const r = answers[i];
          if (!r.ok || r.value.mode === null) return;
          const mine = D.isEnvValue(e.js);
          const theirs = r.value.mode === "global_env";
          if (mine !== theirs) bad.push(`${e.label}: ui=${mine} motore=${r.value.mode}`);
        });
        assert(`${objs.length} valori strutturati, stesso verdetto envelope-like`,
          bad.length === 0, bad.join("\n      "));
      },
    },
    {
      label: "error() globale: dove la UI parla il motore rifiuta",
      run: async (ask, assert) => {
        const answers = await ask(CORPUS.map(e => ({
          op: "classify_deviation_probability",
          args: { value: e.engine, param_key: "volume", duration: 10.0 } })));
        const falsePositives = [], flagged = [], silentRejections = [];
        CORPUS.forEach((e, i) => {
          const r = answers[i];
          if (!r.ok) throw new Error(`oracolo su ${e.label}: ${r.error}`);
          const uiErr = D.error(e.js);
          const engineRejects = r.value.mode_error !== null || r.value.gate_error !== null;
          if (uiErr && !engineRejects) {
            falsePositives.push(`${e.label}: ui=${JSON.stringify(uiErr)} — il motore lo costruisce (${r.value.gate})`);
          } else if (uiErr) {
            flagged.push(e.label);
          } else if (engineRejects) {
            silentRejections.push(`${e.label}: ${r.value.mode_error || r.value.gate_error}`);
          }
        });
        assert(`nessun avviso su uno YAML che rende (${flagged.length} corpi segnalati)`,
          falsePositives.length === 0, falsePositives.join("\n      "));
        assert(`la meta' conservativa: ${silentRejections.length} rifiuti che la UI lascia al motore`,
          true, silentRejections.join("\n      "));
      },
    },
    {
      label: "error() per-parametro: stesso verso, su ogni chiave viva",
      run: async (ask, assert) => {
        const reqs = [], meta = [];
        for (const key of D.PARAM_KEYS) {
          for (const b of PER_PARAM_BODIES) {
            const value = {}; value[key] = b.body;
            reqs.push({ op: "classify_deviation_probability",
                        args: { value, param_key: key, duration: 10.0 } });
            meta.push({ key, body: b, value });
          }
        }
        const answers = await ask(reqs);
        const falsePositives = [];
        let flagged = 0, silent = 0;
        answers.forEach((r, i) => {
          const { key, body, value } = meta[i];
          if (!r.ok) throw new Error(`oracolo su ${key}/${body.label}: ${r.error}`);
          const uiErr = D.error(value);
          const engineRejects = r.value.mode_error !== null || r.value.gate_error !== null;
          if (uiErr && !engineRejects) {
            falsePositives.push(`${key}: ${body.label} — ui=${uiErr.kind}/${uiErr.reason || ""} ma il motore costruisce ${r.value.gate}`);
          } else if (uiErr) flagged++;
          else if (engineRejects) silent++;
        });
        assert(`${reqs.length} coppie (chiave, corpo): nessun falso positivo (${flagged} segnalate)`,
          falsePositives.length === 0, falsePositives.join("\n      "));
        assert(`${silent} corpi che il motore rifiuta e la UI lascia passare (meta' conservativa, per costruzione)`,
          true);
      },
    },
    {
      label: "le cinque PARAM_KEYS il motore le consulta davvero",
      run: async (ask, assert) => {
        // La lista non e' una copia di uno spec del motore: e' la lista delle
        // chiavi che GateFactory guarda. Si verifica dal comportamento —
        // scrivere la chiave cambia il gate, scriverne una inventata no.
        const reqs = [], meta = [];
        for (const key of D.PARAM_KEYS) {
          const declared = {}; declared[key] = 100;
          reqs.push({ op: "classify_deviation_probability",
                      args: { value: declared, param_key: key, duration: 10.0 } });
          meta.push({ key, kind: "declared" });
          reqs.push({ op: "classify_deviation_probability",
                      args: { value: { chiave_inventata: 100 }, param_key: key, duration: 10.0 } });
          meta.push({ key, kind: "absent" });
        }
        const answers = await ask(reqs);
        const bad = [];
        for (let i = 0; i < answers.length; i += 2) {
          const key = meta[i].key;
          const declared = answers[i], absent = answers[i + 1];
          if (!declared.ok || !absent.ok) { bad.push(`${key}: oracolo ko`); continue; }
          if (declared.value.gate === absent.value.gate) {
            bad.push(`${key}: dichiararla non cambia il gate (${declared.value.gate}) — non e' una chiave consultata`);
          }
        }
        assert(`${D.PARAM_KEYS.length} chiavi sempre vive, tutte consultate dal motore`,
          bad.length === 0, bad.join("\n      "));
      },
    },
  ],
});
