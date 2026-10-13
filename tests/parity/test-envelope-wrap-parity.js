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
 * L'altra porta e' `resugarBPGroups`, che sceglie fra BP group e punti nudi.
 * Sul bordo di un salto per il motore non sono la stessa cosa, e il resugar
 * decideva dai soli tag: la zona sul salto si appiattiva, i punti nudi dopo
 * un blocco diventavano zona; e togliere l'ultimo tag uguale al globale
 * cambiava il modo in cui il motore costruisce i segmenti. Qui lo chiedono
 * un corpus, i gesti contro il loro intento e un confronto a caso, ognuno
 * col resugar di prima, congelato, come presidio.
 *
 * Run: node tests/parity/test-envelope-wrap-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

/* envelope-utils.js per remapEnvY, la proporzione del paste: il paste e' una
   delle porte da cui esce un envelope, e da #191 deve portare i tag del
   pattern. Carica dopo envelope-loops.js, come nell'editor. */
const window = loadUiLibs(["envelope-loops.js", "deviation-probability.js", "envelope-utils.js"]);
const E = window.PGEEnv;
const U = window.PGEEnvUtils;

/* Una griglia fitta, piu' un margine fuori da [0, 1] (prima del primo punto
   e dopo l'ultimo il motore tiene gli estremi, e anche quello deve restare). */
const TIMES = [];
for (let i = -20; i <= 420; i++) TIMES.push(+(i / 400).toFixed(6));
const TOL = 1e-9;

/* Le due scritture dell'editor. `rewrap` e' l'espressione dell'acceptance
   criterion della issue; `roundTrip` e' il percorso vero di ogni commit
   (EnvelopeEditor.jsx: commit, commitCur, le frecce, il paste) — desugar per
   lavorare sugli indici piatti, resugar + wrap per scrivere, tutti e due col
   valore da cui gli item vengono. */
const rewrap = (x) => { const w = E.unwrapEnv(x); return E.wrapEnv(w.items, w.interp, x); };
const commitPath = (items, interp, like) =>
  E.wrapEnv(E.resugarBPGroups(items, interp || "linear", like), interp, like);
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

/* ── il bordo del salto ──────────────────────────────────────────────────────
   Per il motore zona e punti nudi non sono la stessa cosa sul bordo di un
   salto: il primo punto di un BP group che cade sull'istante del punto prima
   — o prima ancora — va a quell'istante + DISCONTINUITY_OFFSET
   (`_expand_bp_group`), un punto nudo resta dov'e'. Il resugar decideva la
   grafia dai soli tag e la scambiava al primo commit, nelle due direzioni; e
   toglieva sempre i tag uguali al globale, anche l'ultimo tipo sul punto, che
   decide se il motore costruisce un segmento per coppia o uno solo
   (`_parse_segments`). `oldResugar` e' quel resugar, congelato qui: il
   presidio che i casi discriminino. */
function oldResugar(items, globalDefault) {
  if (!Array.isArray(items)) return items;
  const g = globalDefault || "linear";
  const out = [];
  let run = [];
  function flushRun() {
    if (!run.length) return;
    if (run.length >= 2) {
      const effs = run.slice(0, -1).map((p) => typeof p[2] === "string" ? p[2] : g);
      const T = effs.every((t) => t === effs[0]) ? effs[0] : null;
      if (T && T !== g) {
        out.push([run.map((p, i) => (i === run.length - 1
          ? (typeof p[2] === "string" ? [p[0], p[1], p[2]] : [p[0], p[1]])
          : [p[0], p[1]])), T]);
        run = [];
        return;
      }
    }
    run.forEach((p) => out.push(typeof p[2] === "string" && p[2] === g ? [p[0], p[1]] : p));
    run = [];
  }
  for (const it of items) {
    if (E.isBreakpoint(it)) run.push(it);
    else { flushRun(); out.push(it); }
  }
  flushRun();
  return out;
}
const oldRoundTrip = (x) => {
  const w = E.unwrapEnv(x);
  return E.wrapEnv(oldResugar(E.desugarBPGroups(w.items), w.interp || "linear"), w.interp, x);
};

const BLK = [[[0, 0], [100, 1]], 0.5, 1];
/* `oldDiffers`: il resugar di prima ne cambiava il suono. Dove non lo
   cambiava il caso resta, e chiede solo che il nuovo non lo cambi. */
const SALTI = [
  ["zona cubica sul salto, fra punti nudi", [[0, 0], [0.5, 1], [[[0.5, 2], [1, 3]], "cubic"]], true],
  ["…dentro un {type: cubic}", { type: "cubic", points: [[0, 0], [0.5, 1], [[[0.5, 2], [1, 3]], "cubic"]] }, true],
  ["zona che comincia prima del punto precedente", [[0, 0], [0.5, 1], [[[0.3, 2], [0.8, 2.5], [1, 3]], "cubic"]], true],
  ["…anche step (il resugar di prima sbagliava solo dentro il microsecondo)", [[0, 0], [0.5, 1], [[[0.3, 2], [0.8, 2.5], [1, 3]], "step"]], false],
  ["due zone, la seconda sul salto della prima", [[[[0, 0], [0.5, 1]], "cubic"], [[[0.5, 2], [1, 3]], "cubic"]], true],
  ["zona sul salto in fondo a un blocco", [BLK, [[[0.5, 2], [1, 3]], "cubic"]], false],
  ["punti nudi taggati dove finisce un blocco (l'altra direzione)", [BLK, [0.5, 2, "cubic"], [1, 3]], true],
  ["…e dopo un punto {t, v} sullo stesso istante", [{ t: 0, v: 0 }, { t: 0.5, v: 1 }, [0.5, 2, "cubic"], [1, 3]], true],
  ["un inviluppo che finisce con un salto e un tag ridondante", [[0, 1], [0.2, 0.1], { t: 0.3, v: -0.2 }, [0.3, 0.1, "linear"]], true],
  ["…e uno step che comincia con un salto (a t = 0, dove cade il primo grano)", { type: "step", points: [[0, 0], [0, 1, "step"], [1, 2]] }, true],
];

/* Il confronto a caso: inviluppi nella grammatica che l'editor legge — punti,
   `{t, v}`, gruppi (a volte sull'istante del punto prima, a volte prima),
   blocchi con slot 3, distribuzione e `wrap` — in lista e nei due dict, da un
   generatore seminato. I tempi sono una griglia piu' ogni istante scritto,
   perche' una delle due differenze sta tutta in un istante. */
const FUZZ_N = 300;
function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fuzzBody(rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const TYPES = ["linear", "cubic", "step"];
  const items = [];
  let t = 0;
  const n = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const kind = pick(["bp", "bp", "bp", "dict", "group", "block"]);
    if (kind === "bp" || kind === "dict") {
      t = r3(t + (rnd() < 0.15 ? 0 : 0.02 + rnd() * 0.25));
      const v = r3(rnd() * 2 - 0.5);
      const tag = rnd() < 0.3 ? pick(TYPES) : null;
      if (kind === "bp") items.push(tag ? [t, v, tag] : [t, v]);
      else items.push(tag ? { t, v, type: tag } : { t, v });
    } else if (kind === "group") {
      const pts = [];
      const m = 2 + Math.floor(rnd() * 3);
      const where = rnd();
      let gt = where < 0.3 ? t : where < 0.4 ? r3(Math.max(0, t - 0.05)) : r3(t + 0.01 + rnd() * 0.1);
      for (let k = 0; k < m; k++) {
        if (k > 0) gt = r3(gt + 0.02 + rnd() * 0.15);
        const tag = rnd() < 0.2 ? pick(TYPES) : null;
        const v = r3(rnd() * 2 - 0.5);
        pts.push(tag ? [gt, v, tag] : [gt, v]);
      }
      t = Math.max(t, gt);
      items.push([pts, pick(TYPES)]);
    } else {
      const pat = [];
      const m = 2 + Math.floor(rnd() * 3);
      let x = 0;
      for (let k = 0; k < m; k++) {
        if (k > 0) x = Math.min(100, Math.round(x + 5 + rnd() * 45));
        const tag = rnd() < 0.25 ? pick(TYPES) : null;
        const v = r3(rnd() * 2 - 0.5);
        pat.push(tag ? [x, v, tag] : [x, v]);
      }
      const end = r3(t + 0.1 + rnd() * 0.4);
      const blk = [pat, end, 1 + Math.floor(rnd() * 4)];
      const slot3 = rnd() < 0.4 ? pick(TYPES) : null;
      const dist = rnd() < 0.3 ? pick(["linear", "exponential", "logarithmic"]) : null;
      const wrap = rnd() < 0.25;
      if (slot3 || dist || wrap) blk.push(slot3);
      if (dist || wrap) blk.push(dist);
      if (wrap) blk.push(true);
      items.push(blk);
      t = end;
    }
  }
  const form = pick(["list", "list", "dict", "dictnotype"]);
  if (form === "list") return items;
  if (form === "dict") return { type: pick(TYPES), points: items };
  return { points: items };
}
function fuzzTimes(body) {
  const items = Array.isArray(body) ? body : body.points;
  const at = new Set();
  for (const it of items) {
    if (E.isDictBreakpoint(it)) at.add(it.t);
    else if (E.isBPGroup(it)) for (const p of it[0]) at.add(p[0]);
    else if (E.isCompactBlock(it)) at.add(it[1]);
    else if (Array.isArray(it)) at.add(it[0]);
  }
  const end = Math.max(1, ...at) + 0.1;
  const times = [];
  for (let k = -5; k * 0.01 <= end; k++) times.push(+(k * 0.01).toFixed(6));
  for (const t of at) { times.push(t); times.push(+(t + 0.002).toFixed(6)); }
  return times;
}
/* Come `evaluate`, ma ogni corpo coi suoi tempi, e un corpo che il motore
   rifiuta e' un `null` invece di un'eccezione: si contano. */
const evaluateEach = async (ask, bodies, timesOf) => {
  const answers = await ask(bodies.map((raw, i) => ({
    op: "evaluate_envelope", args: { raw, times: timesOf[i] } })));
  return answers.map((r) => (r.ok && r.value.ok ? r.value.values : null));
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
        const scritto = commitPath(next, w.interp, FF);
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
    {
      label: "l'interp di un blocco sopravvive al paste e al doppio click nel loop (#191)",
      run: async (ask, assert) => {
        /* Da #191 l'interp di un blocco sono i tag dei punti interni del suo
           pattern (setBlockInterp): due gesti che toccano il pattern lo
           perdevano, perche' scrivevano punti senza tag, che seguono il
           globale. La curva e' quella del caso del pannello: un blocco step
           dentro una curva cubica. */
        const PAT = [[0, 0], [50, 1], [100, 0]];
        const CURVA = { type: "cubic", points: [[0, 0.2], [0.2, 1], [0.4, 0.6], [PAT, 0.9, 2], [1, 0.3]] };
        const w0 = E.unwrapEnv(CURVA);
        const r0 = E.setBlockInterp(E.desugarBPGroups(w0.items), 3, "step", w0.interp, { dict: true });
        const SRC = commitPath(r0.items, r0.interp, CURVA);
        const untag = (pattern) => pattern.map((p) => [p[0], p[1]]);

        /* Il paste (handlePasteEnv in EnvelopeEditor.jsx) riporta i valori dal
           dominio della sorgente a quello della destinazione, qui da [0, 1] a
           [-5, 5]. La proporzione e' affine e il motore e' lineare nei valori,
           tangenti della cubica comprese: l'incollato deve suonare come la
           sorgente riportata, punto per punto. remapEnvY ricostruiva ogni punto
           del pattern come `[x, y]`. */
        const paste = (src) => {
          const u = E.unwrapEnv(src);
          const r = U.remapEnvY(u.items, 0, 1, -5, 5);
          return E.wrapEnv(E.resugarBPGroups(E.desugarBPGroups(r), u.interp || "linear", src), u.interp, src);
        };
        const incollato = paste(SRC);
        const primaPaste = JSON.parse(JSON.stringify(incollato));
        primaPaste.points[3][0] = untag(primaPaste.points[3][0]);
        const [s, p, pp] = await evaluate(ask, [SRC, incollato, primaPaste]);
        const riportata = s.map((v) => -5 + 10 * v);
        assert("il paste: il blocco incollato suona la sorgente riportata nel dominio nuovo", same(riportata, p),
          `${fmtWorst(riportata, p)}; incollato ${JSON.stringify(incollato)}`);
        assert("…e il pattern senza tag che il paste scriveva no (il caso discrimina)",
          !same(riportata, pp), fmtWorst(riportata, pp));

        /* Il doppio click dentro il loop aggiunge un punto al pattern. Messo
           SULLA curva — a x = 25%, dove lo step tiene ancora il primo punto,
           y = 0 — non deve cambiare niente di cio' che suona: le due meta' del
           segmento che spezza restano step. Senza tag la seconda seguiva il
           globale, cubica. */
        const items = E.desugarBPGroups(E.unwrapEnv(SRC).items);
        const blk = items[3];
        const ins = E.insertPatternPoint(blk[0], 25, 0);
        const conPunto = (pattern) => {
          const nb = blk.slice(); nb[0] = pattern;
          return commitPath(items.map((it, i) => (i === 3 ? nb : it)), E.unwrapEnv(SRC).interp, SRC);
        };
        const scritto = conPunto(ins.pattern);
        const primaDbl = conPunto([...blk[0], [25, 0]].sort((a, b) => a[0] - b[0]));
        const [o, d, pd] = await evaluate(ask, [SRC, scritto, primaDbl]);
        assert("il doppio click: un punto sulla curva non cambia il suono del blocco", same(o, d),
          `${fmtWorst(o, d)}; scritto ${JSON.stringify(scritto)}`);
        assert("…e il punto senza tag che si inseriva prima si' (il caso discrimina)",
          !same(o, pd), fmtWorst(o, pd));
      },
    },
    {
      label: "il bordo del salto: il commit senza modifiche suona come x",
      run: async (ask, assert) => {
        const raws = SALTI.map(([, x]) => x);
        const orig = await evaluate(ask, raws);
        const out = await evaluate(ask, raws.map(roundTrip));
        const prima = await evaluate(ask, raws.map(oldRoundTrip));
        SALTI.forEach(([label, x, oldDiffers], i) => {
          assert(label, same(orig[i], out[i]),
            `${fmtWorst(orig[i], out[i])}; scritto ${JSON.stringify(roundTrip(x))}`);
          if (oldDiffers) {
            assert(`${label}: …e col resugar di prima no (il caso discrimina)`, !same(orig[i], prima[i]),
              `scritto prima ${JSON.stringify(oldRoundTrip(x))}`);
          }
        });
      },
    },
    {
      label: "i gesti su una zona sul salto: suona quello voluto, e col resugar di prima no",
      run: async (ask, assert) => {
        /* Il "voluto" e' lo YAML di partenza col solo gesto applicato, nella
           sua grafia: l'intento del gesto, non un valore atteso del motore. */
        const Z = [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "cubic"]];
        const f = E.desugarBPGroups(Z);
        const at = (i, p) => f.map((it, k) => (k === i ? p : it));
        const GESTI = [
          ["un punto trascinato fuori dalla zona", at(0, [0.1, 0.4]), "linear",
            [[0.1, 0.4], [0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "cubic"]]],
          ["una freccia su un punto della zona", at(3, [0.75, 2.7, "cubic"]), "linear",
            [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.7], [1, 3]], "cubic"]]],
          ["un segmento della zona portato al tipo globale", at(3, [0.75, 2.5]), "linear",
            [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.5, "linear"], [1, 3]], "cubic"]]],
          ["un punto aggiunto dentro la zona", [...f.slice(0, 3), [0.6, 2.2, "cubic"], ...f.slice(3)], "linear",
            [[0, 0], [0.5, 1], [[[0.5, 2], [0.6, 2.2], [0.75, 2.5], [1, 3]], "cubic"]]],
          ["un punto tolto prima della zona", f.slice(1), "linear",
            [[0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "cubic"]]],
          ["il selettore del tipo globale", E.setGlobalInterp(f, "step"), "step",
            { type: "step", points: Z }],
        ];
        const voluti = await evaluate(ask, GESTI.map((g) => g[3]));
        const scritti = await evaluate(ask, GESTI.map(([, next, interp]) => commitPath(next, interp, Z)));
        const prima = await evaluate(ask, GESTI.map(([, next, interp]) =>
          E.wrapEnv(oldResugar(next, interp), interp, Z)));
        GESTI.forEach(([label], i) => {
          assert(`${label}: suona come voluto`, same(voluti[i], scritti[i]), fmtWorst(voluti[i], scritti[i]));
          assert(`${label}: …e col resugar di prima no`, !same(voluti[i], prima[i]), fmtWorst(voluti[i], prima[i]));
        });
      },
    },
    {
      label: `a caso: il commit senza modifiche suona come x su ${FUZZ_N} inviluppi generati`,
      run: async (ask, assert) => {
        const rnd = mulberry32(20261013);
        const bodies = [];
        for (let i = 0; i < FUZZ_N; i++) bodies.push(fuzzBody(rnd));
        const timesOf = bodies.map(fuzzTimes);
        const orig = await evaluateEach(ask, bodies, timesOf);
        const out = await evaluateEach(ask, bodies.map(roundTrip), timesOf);
        const prima = await evaluateEach(ask, bodies.map(oldRoundTrip), timesOf);
        const diverge = (a, b) => !a || !b || a.some((v, k) => Math.abs(v - b[k]) > TOL);
        const letti = bodies.map((_, i) => i).filter((i) => orig[i]);
        const rotti = letti.filter((i) => diverge(orig[i], out[i]));
        const primaRotti = letti.filter((i) => diverge(orig[i], prima[i]));
        assert(`il motore legge quasi tutti i corpi generati (${letti.length}/${FUZZ_N})`,
          letti.length >= FUZZ_N * 0.9, `rifiutati: ${FUZZ_N - letti.length}`);
        assert("nessun commit senza modifiche cambia cio' che il motore suona", rotti.length === 0,
          rotti.slice(0, 3).map((i) => `${JSON.stringify(bodies[i])} → ${JSON.stringify(roundTrip(bodies[i]))}`).join("\n      "));
        /* Il presidio: col resugar di prima il confronto trova le divergenze,
           o la griglia e il generatore non vedrebbero il difetto. */
        assert(`…mentre col resugar di prima ne cambiavano ${primaRotti.length} (il confronto discrimina)`,
          primaRotti.length >= 5, String(primaRotti.length));
      },
    },
  ],
});
