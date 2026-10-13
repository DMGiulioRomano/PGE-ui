/* =============================================================================
 * test-envelope-eval-parity.js — l'EnvelopeEditor disegna e legge sotto il
 * cursore quello che il motore suona (#190, #191).
 *
 * La lettura dell'editor e' una sola: `envExpand` (envelope-loops.js) porta il
 * valore com'e' scritto ai punti espansi, `envValueAt` ne da' il valore a un
 * tempo, `envPath` la curva da disegnare — con le stesse tangenti, calcolate
 * in un posto solo (`cubicTangents`). Qui le prime due si confrontano con
 * `Envelope.evaluate` del motore, tempo per tempo, e la terza con la seconda:
 * il disegno e' la curva che il cursore legge.
 *
 * I due difetti che la suite esiste per fermare:
 *   · #190 — con due punti il motore mette le tangenti della cubica a zero
 *     (`_compute_fritsch_carlson_tangents`, caso `n == 2`), lo smoothstep;
 *     disegno e cursore davano a entrambe la pendenza del segmento, cioe' una
 *     retta. E le tangenti del disegno si calcolavano per gruppo e per ciclo,
 *     dove il motore le calcola su tutti i punti espansi.
 *   · #191 — l'interp di un blocco compatto il motore lo legge per FORMA: nella
 *     lista quello del primo blocco che lo dichiara e' il tipo globale
 *     (`extract_interp_type`), nel dict e' ignorato. L'editor lo disegnava per
 *     blocco, e i breakpoint nudi di una lista sempre lineari.
 *
 * Nessun valore atteso e' scritto di qua: un termine e' la UI, l'altro il
 * motore. I presidi (`OLD`) sono la lettura di prima, rifatta qui per
 * dimostrare che il corpus la distingue — non un'aspettativa.
 *
 * Run: node tests/parity/test-envelope-eval-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["envelope-loops.js"]);
const E = window.PGEEnv;

/* Una griglia fitta su [0, 1] con un margine fuori (prima del primo punto e
   dopo l'ultimo il motore tiene gli estremi), e nessun tempo che cada su un
   breakpoint del corpus per caso: i tempi sono a passo 1/397. */
const TIMES = [];
for (let i = -12; i <= 409; i++) TIMES.push(i / 397);
const TOL = 1e-9;

const ui = (raw, times = TIMES) => {
  const exp = E.envExpand(raw);
  return times.map((t) => E.envValueAt(exp, t));
};
const engine = async (ask, bodies, times = TIMES) => {
  const answers = await ask(bodies.map((raw) => ({ op: "evaluate_envelope", args: { raw, times } })));
  return answers.map((r, i) => {
    if (!r.ok) throw new Error(`oracolo: ${r.error}`);
    if (!r.value.ok) throw new Error(`il motore non valuta ${JSON.stringify(bodies[i])}: ${r.value.error}`);
    return r.value.values;
  });
};
const worst = (a, b, times = TIMES) => {
  let w = { d: 0, t: null };
  a.forEach((v, i) => { const d = Math.abs(v - b[i]); if (!(d <= w.d)) w = { d, t: times[i] }; });
  return w;
};
const same = (a, b, times = TIMES) => worst(a, b, times).d <= TOL;
const fmtWorst = (a, b, times = TIMES) => {
  const w = worst(a, b, times);
  return `scarto massimo ${Number(w.d).toExponential(3)} a t=${w.t}`;
};

/* La lettura di PRIMA, per i presidi: com'era prima di #190/#191, copiata da
   envelope-loops.js / EnvelopeEditor.jsx e ridotta a cio' che serve qui.
   Non e' un'aspettativa: serve a dimostrare che il corpus la distingue dal
   motore, cioe' che la suite sarebbe rossa se tornasse.
     · l'espansione (expandMixed di allora): i punti nudi col `type` del dict
       o `linear` per ogni lista, i punti del pattern col loro slot 3, il
       blocco dopo un blocco dal suo end_time, niente `wrap`, niente `{t, v}`;
     · il cursore (valueAtTime): le tangenti su tutti i punti, ma agli estremi
       la pendenza del segmento — con due punti, una retta;
     · il disegno (emitGroup): un pezzo per run di breakpoint nudi e uno per
       ciclo, ciascuno con le tangenti dei suoi soli punti, e fra un pezzo e
       l'altro un raccordo dritto. */
const D = E.DISCONTINUITY_OFFSET;
function legacyExpand(raw) {
  let g = "linear";
  let env = E.desugarBPGroups(E.unwrapEnv(raw).items);
  if (E.isTypedEnv(raw)) g = raw.type || "linear";
  const points = [], blocks = [];
  let cur = 0;
  env.forEach((item, i) => {
    if (E.isBreakpoint(item)) {
      points.push([item[0], item[1], typeof item[2] === "string" ? item[2] : g]);
      if (item[0] > cur) cur = item[0];
      return;
    }
    if (!E.isCompactBlock(item)) return;
    const [pattern, end, n] = item;
    const interp = item[3] || "linear";
    const start = cur;
    const durs = E.computeCycleDurations(Math.max(0, end - start), n, item[4] || "linear");
    const block = { originalIdx: i, interp, cycles: [] };
    let t = start;
    for (let c = 0; c < n; c++) {
      const cyc = [];
      pattern.forEach((p, pi) => {
        let pt = t + (p[0] / 100) * durs[c];
        if (pi === 0 && (c > 0 || start > 0)) pt += D;
        cyc.push(p.length >= 3 ? [pt, p[1], p[2]] : [pt, p[1]]);
        points.push([pt, p[1], p.length >= 3 ? p[2] : interp]);
      });
      block.cycles.push(cyc);
      t += durs[c];
    }
    blocks.push(block);
    cur = end;
  });
  return { points, blocks, g, items: env };
}
function legacyCursor(raw, times = TIMES) {
  const pts = legacyExpand(raw).points;
  return times.map((x) => {
    if (!pts.length) return null;
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (!(x >= a[0] && x <= b[0])) continue;
      const h = b[0] - a[0];
      if (h <= 0) return a[1];
      if (a[2] === "step") return a[1];
      if (a[2] !== "cubic") return a[1] + (x - a[0]) / h * (b[1] - a[1]);
      const tan = (k) => {
        const hL = k > 0 ? pts[k][0] - pts[k - 1][0] : 0;
        const hR = k < pts.length - 1 ? pts[k + 1][0] - pts[k][0] : 0;
        const dL = hL > 0 ? (pts[k][1] - pts[k - 1][1]) / hL : null;
        const dR = hR > 0 ? (pts[k + 1][1] - pts[k][1]) / hR : null;
        if (dL == null) return dR == null ? 0 : dR;
        if (dR == null) return dL;
        return dL * dR <= 0 ? 0 : 2 / (1 / dL + 1 / dR);
      };
      return E.hermite(x, a[0], a[1], tan(i), b[0], b[1], tan(i + 1));
    }
    return pts[0][1];
  });
}
function legacyDrawn(raw, times = TIMES) {
  const { blocks, g, items } = legacyExpand(raw);
  const segs = [];
  let prev = null;
  const emit = (bps, interp) => {
    if (prev) segs.push({ a: prev, b: bps[0], s: "linear" });
    const n = bps.length, d = [], m = new Array(n).fill(0);
    for (let i = 0; i < n - 1; i++) {
      const h = bps[i + 1][0] - bps[i][0];
      d[i] = h !== 0 ? (bps[i + 1][1] - bps[i][1]) / h : 0;
    }
    if (n === 2) { m[0] = d[0]; m[1] = d[0]; }
    else if (n > 2) {
      m[0] = d[0]; m[n - 1] = d[n - 2];
      for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 / (1 / d[i - 1] + 1 / d[i]);
    }
    for (let i = 0; i < n - 1; i++) {
      segs.push({ a: bps[i], b: bps[i + 1], s: typeof bps[i][2] === "string" ? bps[i][2] : interp,
                  m0: m[i], m1: m[i + 1] });
    }
    prev = bps[n - 1];
  };
  let run = [];
  items.forEach((it, i) => {
    if (E.isBreakpoint(it)) { run.push(it); return; }
    if (!E.isCompactBlock(it)) return;
    if (run.length) emit(run, g);
    run = [];
    const b = blocks.find((x) => x.originalIdx === i);
    if (b) for (const c of b.cycles) emit(c, b.interp);
  });
  if (run.length) emit(run, g);
  return times.map((t) => {
    if (!segs.length) return prev ? prev[1] : null;
    if (t <= segs[0].a[0]) return segs[0].a[1];
    for (const sg of segs) {
      const t0 = sg.a[0], t1 = sg.b[0];
      if (t < t0 || t > t1) continue;
      if (t1 <= t0) return sg.b[1];
      if (sg.s === "step") return t < t1 ? sg.a[1] : sg.b[1];
      if (sg.s === "cubic") return E.hermite(t, t0, sg.a[1], sg.m0, t1, sg.b[1], sg.m1);
      return sg.a[1] + (t - t0) / (t1 - t0) * (sg.b[1] - sg.a[1]);
    }
    return segs[segs.length - 1].b[1];
  });
}

/* Il disegno: i comandi di envPath valutati come li traccia l'SVG. In x il
   tempo e' lineare nel parametro della Bezier (punti di controllo a 1/3 e
   2/3), quindi a un tempo t corrisponde s = (t - t0)/h. Lo step sono due `L`:
   l'orizzontale al valore tenuto, poi la verticale — e un tratto verticale ha
   due valori allo stesso istante. Su quegli istanti (i tempi dei punti) il
   disegno non dice un numero solo: li' risponde il cursore, che il caso prima
   confronta, e qui si saltano. */
function pathValue(cmds, t) {
  if (!cmds.length) return null;
  if (t < cmds[0].t) return cmds[0].v;
  let prev = cmds[0];
  for (let i = 1; i < cmds.length; i++) {
    const c = cmds[i];
    if (prev.t < t && t < c.t) {
      const s = (t - prev.t) / (c.t - prev.t);
      if (c.op === "C") {
        const r = 1 - s;
        return r * r * r * prev.v + 3 * r * r * s * c.c1[1] + 3 * r * s * s * c.c2[1] + s * s * s * c.v;
      }
      return prev.v + s * (c.v - prev.v);
    }
    prev = c;
  }
  return prev.v;
}

const BLOCK = [[[0, 0], [50, 1], [100, 0]], 1, 2];
/* Il corpus: [etichetta, corpo, il presidio discrimina?]. */
const CORPUS = [
  // #190 — la tabella della issue, e le sue due grafie
  ["cubica di due punti, {type: cubic}", { type: "cubic", points: [[0, 0.001], [1, 0.016]] }, true],
  ["cubica di due punti, tipo sul punto", [[0, 0.001, "cubic"], [1, 0.016]], true],
  ["cubica di tre punti, {type: cubic}", { type: "cubic", points: [[0, 0], [0.4, 1], [1, 0.2]] }, false],
  ["cubica di tre punti, tipo sul punto", [[0, 0, "cubic"], [0.4, 1, "cubic"], [1, 0.2]], false],
  ["un segmento cubico fra due lineari", [[0, 0], [0.3, 0.5, "cubic"], [0.6, 1], [1, 0.1]], false],
  // #190 — il confine fra un gruppo e un blocco, e fra un ciclo e l'altro
  ["gruppo cubico, poi un blocco, poi punti nudi (dict cubic)",
    { type: "cubic", points: [[0, 0], [0.1, 0.5], [0.2, 1], [[[0, 1], [50, 0], [100, 1]], 0.6, 2], [0.8, 0.2], [1, 0.9]] }, true],
  ["BP group cubico accanto a un blocco cubico",
    [[[[0, 0], [0.15, 0.8], [0.3, 0.2]], "cubic"], [[[0, 0.2], [40, 1], [100, 0.4]], 0.8, 3, "cubic"], [1, 0]], true],
  ["blocco cubico nudo, cicli che si toccano", [[[0, 0], [30, 1], [100, 0.5]], 1, 3, "cubic"], true],
  // #191 — la tabella della issue: la stessa forma, l'interp del blocco
  ["dict cubic con un blocco (la riga 1 della issue)",
    { type: "cubic", points: [[0, 0], [0.2, 1], BLOCK] }, true],
  ["lista con un blocco senza interp (riga 2)", [[0, 0], [0.2, 1], BLOCK], false],
  ["lista con un blocco step (riga 3)", [[0, 0], [0.2, 1], [...BLOCK, "step"]], true],
  ["dict cubic con un blocco step (riga 4)", { type: "cubic", points: [[0, 0], [0.2, 1], [...BLOCK, "step"]] }, true],
  ["lista con due blocchi: vale il primo che dichiara",
    [[0, 0], [[[0, 0], [50, 1], [100, 0]], 0.5, 2], [[[0, 1], [50, 0], [100, 1]], 0.8, 2, "step"],
     [[[0, 0], [50, 1], [100, 0]], 1, 2, "cubic"]], true],
  ["dict senza type con un blocco step: lineare", { points: [[0, 0], [0.2, 1], [...BLOCK, "step"]] }, true],
  ["dict i cui points sono un blocco nudo", { type: "step", points: [[[0, 0], [50, 1], [100, 0.5]], 1, 3] }, true],
  ["tag sul pattern dentro un dict cubic",
    { type: "cubic", points: [[0, 0], [[[0, 0, "step"], [50, 1, "step"], [100, 0]], 1, 2]] }, false],
  // Le letture del builder che l'editor non faceva
  ["un pattern che finisce prima di 100, e il blocco dopo comincia li'",
    [[[[0, 0], [60, 1]], 0.5, 2], [[[0, 0.5], [100, 0]], 1, 2]], true],
  ["wrap: il ciclo si chiude sul primo y", [[[0, 0], [50, 1]], 1, 3, "linear", "linear", true], true],
  // Il primo punto di un gruppo sull'istante del punto prima: il builder lo
  // sposta di DISCONTINUITY_OFFSET (`_expand_bp_group`), e le tangenti della
  // cubica vedono il salto. Gli item desugarati lo perdevano.
  ["un gruppo cubico che comincia sull'istante del punto prima",
    [[0, 0], [0.5, 1], [[[0.5, 2], [1, 3]], "cubic"]], true],
  ["…e sull'istante dell'ultimo punto di un blocco",
    [[[[0, 0], [100, 1]], 0.5, 2], [[[0.5, 0], [0.75, 1], [1, 0.2]], "cubic"]], true],
  ["il punto {t, v}", [{ t: 0, v: 0 }, { t: 0.5, v: 1, type: "cubic" }, { t: 1, v: 0.25 }], true],
  ["distribuzione temporale, cubica", [[[0, 0], [50, 1], [100, 0]], 1, 4, "cubic", "exponential"], true],
  // Gli step: un segmento solo o uno per coppia
  ["step globale, una discontinuita'", { type: "step", points: [[0, 0], [0.5, 1], [0.5, 3], [1, 0]] }, false],
  ["step sul punto, una discontinuita'", [[0, 0, "step"], [0.5, 1, "step"], [0.5, 3], [1, 0]], false],
];

parity({
  suite: "envelope-eval",
  why: "window.PGEEnv.envValueAt ∘ envExpand  ↔  pge.envelopes.envelope.Envelope.evaluate (#190, #191)",
  cases: [
    {
      label: "il corpus discrimina: la lettura di prima suona diverso dal motore",
      run: async (ask, assert) => {
        const rows = CORPUS.filter(([, , differs]) => differs);
        const eng = await engine(ask, rows.map(([, x]) => x));
        const mute = rows.filter(([, x], i) => same(legacyCursor(x), eng[i]) && same(legacyDrawn(x), eng[i]))
          .map(([label]) => label);
        assert(`${rows.length} corpi dove la lettura di prima (cursore o disegno) sbagliava`, mute.length === 0,
          mute.join("\n      "));
      },
    },
    {
      label: "il cursore dell'editor legge quello che il motore suona",
      run: async (ask, assert) => {
        const eng = await engine(ask, CORPUS.map(([, x]) => x));
        CORPUS.forEach(([label, x], i) => {
          const u = ui(x);
          assert(label, same(u, eng[i]), fmtWorst(u, eng[i]));
        });
      },
    },
    {
      label: "la discontinuita' all'istante esatto: un segmento solo o uno per coppia",
      run: async (ask, assert) => {
        /* Sull'istante di due punti allo stesso tempo le due strade del motore
           danno valori diversi (lo step di un segmento solo prende l'ultimo
           punto, quello per coppia il primo), e la griglia qui sopra quell'istante
           non lo tocca mai. Si chiede apposta. */
        const AT = [0.5, 0.25, 0.75, 0, 1];
        const bodies = CORPUS.filter(([label]) => /discontinuita'/.test(label)).map(([, x]) => x);
        const eng = await engine(ask, bodies, AT);
        bodies.forEach((x, i) => {
          const u = ui(x, AT);
          assert(JSON.stringify(x), same(u, eng[i], AT), `${JSON.stringify(u)} contro ${JSON.stringify(eng[i])}`);
        });
        assert("…e le due strade li' differiscono davvero (il caso discrimina)",
          !same(eng[0].slice(0, 1), eng[1].slice(0, 1), AT.slice(0, 1)),
          `${eng[0][0]} e ${eng[1][0]}`);
      },
    },
    {
      label: "la divergenza dichiarata: un pattern che comincia con un salto",
      run: async (ask, assert) => {
        /* Due punti alla stessa x in testa al pattern: un salto all'attacco del
           ciclo. Il builder aggiunge DISCONTINUITY_OFFSET al solo PRIMO punto
           di ogni ciclo dopo il primo, che finisce cosi' 1e-6 DOPO il secondo.
           Senza un tipo per punto il motore fa un segmento solo e lo ordina
           (`NormalSegment`: `sorted`), quindi dal secondo ciclo il salto si
           inverte e il ciclo si appiattisce sul primo y; con un tipo su un
           punto fa un segmento per coppia e suona la rampa in ogni ciclo, come
           nel primo. L'editor legge e disegna la rampa: e' un'incoerenza del
           motore — un tipo ridondante cambia il suono — e la lettura non la
           copia. Asserita perche' il giorno che il motore la toglie, questo
           caso parli (tests/parity/README.md, divergenze dichiarate). */
        const AT = [0.25, 0.75];
        const SALTO = [[[0, 0], [0, 1], [100, 0]], 1, 2];
        const CON_TIPO = [[[0, 0], [0, 1, "linear"], [100, 0]], 1, 2];
        const [nudo, tipato] = await engine(ask, [SALTO, CON_TIPO], AT);
        const u = ui(SALTO, AT);
        assert("l'editor legge la rampa in ogni ciclo", same(u, [0.5, 0.5], AT), JSON.stringify(u));
        assert("…come il motore quando un punto porta un tipo (un segmento per coppia)",
          same(u, tipato, AT), `${JSON.stringify(u)} contro ${JSON.stringify(tipato)}`);
        assert("…e senza, il motore appiattisce dal secondo ciclo (la divergenza dichiarata)",
          same(nudo.slice(0, 1), u.slice(0, 1), AT.slice(0, 1)) && !same(nudo.slice(1), u.slice(1), AT.slice(1)),
          `${JSON.stringify(nudo)} contro ${JSON.stringify(u)}`);
      },
    },
    {
      label: "il disegno e' la curva che il cursore legge",
      run: async (ask, assert) => {
        /* envPath porta in pixel la stessa curva: valutati come li traccia
           l'SVG, i suoi comandi devono dare i valori del motore. */
        const eng = await engine(ask, CORPUS.map(([, x]) => x));
        let skipped = 0;
        CORPUS.forEach(([label, x], i) => {
          const exp = E.envExpand(x);
          const at = new Set(exp.points.map((p) => p[0]));
          const keep = TIMES.map((t) => !at.has(t));
          skipped += keep.filter((k) => !k).length;
          const cmds = E.envPath(exp);
          const drawn = TIMES.filter((t, k) => keep[k]).map((t) => pathValue(cmds, t));
          const ref = eng[i].filter((v, k) => keep[k]);
          const times = TIMES.filter((t, k) => keep[k]);
          assert(label, same(drawn, ref, times), fmtWorst(drawn, ref, times));
        });
        // Il salto non deve mangiarsi la griglia: sono gli estremi 0 e 1.
        assert(`saltati solo gli istanti dei punti (${skipped})`, skipped <= 2 * CORPUS.length, String(skipped));
      },
    },
  ],
});
