/* =============================================================================
 * test-envelope-shape-parity.js — `window.PGEEnv.envShapeError` contro
 * `Envelope` del motore (#180, PGE #211).
 *
 * Lo specchio fa un'affermazione sola, ed e' forte: rifiuta esattamente i
 * corpi che il builder del motore rifiuta, e nomina la stessa sotto-posizione
 * che il builder nomina (`compact.n_reps` ↔ `envelope.compact.n_reps`). Il
 * corpus qui sotto e' fatto di corpi, non di chiavi: da PGE #211 i guard di
 * forma stanno nel builder e valgono per ogni chiave allo stesso modo.
 *
 * ## Il motore contro cui si confronta
 *
 * Prima di PGE #211 quattro scritture si rendevano in silenzio (la `x` del
 * pattern fuori da [0, 100] o all'indietro, `n_reps`/`end_time` booleani o
 * `end_time` non finito, la `y` booleana nel pattern) e gli altri guard erano
 * ValueError nudi, senza campo. La suite e' nata con un ramo di transizione per
 * quel motore, scelto da una sonda (`n_reps: true`), e lo ha tolto quando PGE
 * #211 (fuso con PGE #287) e' arrivato sul default branch che la CI segue. Il
 * confronto adesso e' uno solo, stretto; che il motore lo regga lo pretende lo
 * SHA registrato in tests/parity/README.md, che `test-fingerprint-parity.js`
 * vuole antenato del commit del run. Contro un motore piu' vecchio questa suite
 * non e' una transizione da accompagnare: e' rossa, e nomina i corpi.
 *
 * Run: node tests/parity/test-envelope-shape-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["envelope-loops.js"]);
const E = window.PGEEnv;

const PAT  = [[0, 0], [100, 1]];
const HALF = [[0, 0], [50, 1]];   // il pattern che finisce a meta' ciclo

/* Il corpus. Nessuna aspettativa scritta: la risposta e' del motore. Le
 * etichette dicono cosa il corpo esercita, non cosa deve succedere. */
const CORPUS = [
  // validi, in tutte le grafie che il builder legge
  ["breakpoint nudi", [[0, 0], [1, 1]]],
  ["breakpoint 3-tuple", [[0, 0, "cubic"], [1, 1]]],
  ["breakpoint dict", [{ t: 0, v: 0 }, { t: 1, v: 1, type: "step" }]],
  ["envelope tipizzato", { type: "cubic", points: [[0, 0], [1, 1]] }],
  ["dict con solo points", { points: [[0, 0], [1, 1]] }],
  ["compatto nudo", [PAT, 1, 4]],
  ["compatto in lista", [[PAT, 1, 4]]],
  ["x ripetuta (discontinuita')", [[[0, 0], [50, 1], [50, 0], [100, 1]], 1, 2]],
  ["x agli estremi esatti", [[[0, 0], [0, 1], [100, 0], [100, 1]], 1, 2]],
  ["punto del pattern con type", [[[0, 0, "step"], [100, 1]], 1, 2]],
  ["punto del pattern con type null", [[[0, 0, null], [100, 1]], 1, 2]],
  ["i sei slot", [PAT, 1, 2, "cubic", { type: "geometric", ratio: 1.5 }, true]],
  ["slot opzionali a null", [PAT, 1, 2, null, null, null]],
  ["BP group nudo", [[[0, 0], [1, 1]], "cubic"]],
  ["BP group in lista", [[0, 0], [[[0.2, 1], [0.8, 0]], "step"], [1, 1]]],
  ["misto con offset", [[0, 10], [0.3, 10], [[[0, 30], [100, 50]], 1.3, 5, "linear", "exponential"]]],
  ["due compatti in fila", [[PAT, 1, 2], [PAT, 2, 2]]],
  ["compatto dentro {type, points}", { type: "linear", points: [[PAT, 1, 2]] }],

  // le quattro scritture di PGE #211
  ["x a 150", [[[0, 0], [150, 1]], 1, 2]],
  ["x negativa", [[[-1, 0], [100, 1]], 1, 2]],
  ["x all'indietro", [[[100, 0], [0, 1]], 1, 2]],
  ["x all'indietro in lista", [[0, 0], [[[0, 0], [60, 1], [40, 0]], 1, 2]]],
  ["n_reps: true", [PAT, 1, true]],
  ["n_reps: true in lista", [[0, 0], [PAT, 1, true]]],
  ["end_time: true", [PAT, true, 2]],
  ["end_time .inf", [PAT, Infinity, 2]],
  ["end_time .nan", [PAT, NaN, 2]],
  ["y booleana nel pattern", [[[0, true], [100, 1]], 1, 2]],

  // i guard che c'erano gia', come ValueError nudi
  ["n_reps 0", [PAT, 1, 0]],
  ["n_reps negativo", [PAT, 1, -3]],
  ["end_time 0", [PAT, 0, 2]],
  ["end_time prima del breakpoint precedente", [[0, 0], [0.5, 1], [PAT, 0.5, 2]]],
  ["pattern vuoto", [[], 1, 2]],
  ["y stringa", [[[0, "a"], [100, 1]], 1, 2]],
  ["type numerico nel pattern", [[[0, 0, 5], [100, 1]], 1, 2]],
  ["BP group dentro il pattern", [[[[[0, 0], [1, 1]], "linear"], [100, 1]], 1, 2]],
  ["distribuzione ignota", [PAT, 1, 2, "linear", "bogus"]],
  ["distribuzione {type: null}", [PAT, 1, 2, "linear", { type: null }]],
  ["distribuzione {type: 5}", [PAT, 1, 2, "linear", { type: 5 }]],
  ["parametro della distribuzione fuori bound", [PAT, 1, 2, "linear", { type: "geometric", ratio: 0 }]],
  ["parametro estraneo alla distribuzione", [PAT, 1, 2, "linear", { type: "geometric", rate: 2 }]],
  ["gruppo di un punto", [[[0, 0]], "cubic"]],
  ["gruppo vuoto", [[], "linear"]],
  ["gruppo di un punto in lista", [[0, 0], [[[0.5, 1]], "step"]]],
  ["interp del gruppo ignota", [[[0, 0], [1, 1]], "cubicc"]],
  ["stringa in lista", [[0, 0], "x"]],
  ["breakpoint con v booleana", [[0, true], [1, 1]]],
  ["dict con type null", [{ t: 0, v: 0, type: null }]],
  ["3-tuple col terzo numerico", [[0, 0], [1, 1], [2, 2, 3]]],
  ["compatto con n_reps non intero, in lista", [[0, 0], [PAT, 1, 2.5]]],
  ["compatto con n_reps non intero, diretto", [PAT, 1, 2.5]],
  ["compatto con sette elementi", [[PAT, 1, 2, "linear", "linear", false, 9]]],

  // l'ordine dei guard: il primo vince, e la sotto-posizione lo dice
  ["n_reps prima di end_time", [[[0, 0], [150, 1]], true, true]],
  ["end_time prima del pattern", [[[0, 0], [150, 1]], true, 2]],
  ["pattern prima della distribuzione", [[[0, 0], [150, 1]], 1, 2, "linear", "bogus"]],
  ["end_time prima del pattern vuoto", [[], 0, 2]],
  ["interp del gruppo prima dell'arita'", [[[0, 0]], "cubicc"]],
  ["il primo elemento sbagliato vince", [[0, "x"], [PAT, 1, true]]],

  // dove comincia un blocco dopo un compatto: l'ultimo punto espanso
  ["dopo x=50: 0.9 e' oltre", [[HALF, 1, 2], [PAT, 0.9, 2]]],
  ["dopo x=50: 0.7 no", [[HALF, 1, 2], [PAT, 0.7, 2]]],
  ["dopo x=50 con wrap: 0.9 no", [[HALF, 1, 2, null, null, true], [PAT, 0.9, 2]]],
  ["dopo x=50 con wrap: 1.0 si'", [[HALF, 1, 2, null, null, true], [PAT, 1, 2]]],
  ["dopo cicli esponenziali: 0.85 si'", [[HALF, 1, 2, null, "exponential"], [PAT, 0.85, 2]]],
  ["dopo cicli esponenziali: 0.8 no", [[HALF, 1, 2, null, "exponential"], [PAT, 0.8, 2]]],
  ["dopo un pattern di un punto: 0.76 si'", [[[[50, 5]], 1, 2], [PAT, 0.76, 2]]],
  ["dopo un pattern di un punto: 0.75 no", [[[[50, 5]], 1, 2], [PAT, 0.75, 2]]],
  ["un breakpoint dopo il compatto sposta l'inizio", [[HALF, 1, 2], [0.8, 1], [PAT, 0.79, 2]]],
  ["dopo un gruppo, il suo ultimo punto", [[[[0, 0], [0.7, 1]], "cubic"], [PAT, 0.6, 2]]],
  ["dopo breakpoint dict", [{ t: 0, v: 0 }, { t: 0.5, v: 1 }, [PAT, 0.5, 2]]],
  // il dict `{t, v, type}` normalizzato e' anche un compatto, e sposta l'inizio
  ["compatto in forma dict, poi un altro: 0.7 no", [{ t: HALF, v: 1, type: 2 }, { t: PAT, v: 0.7, type: 2 }]],
  ["compatto in forma dict, poi un altro: 0.9 si'", [{ t: HALF, v: 1, type: 2 }, { t: PAT, v: 0.9, type: 2 }]],
  ["compatto in lista, poi uno in forma dict: 0.7 no", [[HALF, 1, 2], { t: PAT, v: 0.7, type: 2 }]],

  // `points` che non e' una lista: il builder la itera lo stesso
  ["points stringa", { points: "abc" }],
  ["points dict", { type: "linear", points: { t: 0, v: 1 } }],
];

const verdicts = async (ask) => {
  const answers = await ask(CORPUS.map(([, raw]) => ({ op: "build_envelope", args: { raw } })));
  return CORPUS.map(([label, raw], i) => {
    const r = answers[i];
    if (!r.ok) throw new Error(`oracolo su «${label}»: ${r.error}`);
    return { label, raw, ui: E.envShapeError(raw), engine: r.value };
  });
};

parity({
  suite: "envelope-shape",
  why: "window.PGEEnv.envShapeError  ↔  pge.envelopes.envelope.Envelope (EnvelopeBuilder, PGE #211)",
  cases: [
    {
      label: "le interpolazioni di un BP group sono quelle del builder",
      run: async (ask, assert) => {
        const c = (await ask("constants", {})).value;
        assert("INTERP_TYPES === EnvelopeBuilder.VALID_INTERP_TYPES, in ordine",
          JSON.stringify(E.INTERP_TYPES) === JSON.stringify(c.envelope_interp_types),
          `ui=${JSON.stringify(E.INTERP_TYPES)} motore=${JSON.stringify(c.envelope_interp_types)} ${c.envelope_interp_types_error || ""}`);
      },
    },
    {
      label: "stesso verdetto, corpo per corpo",
      run: async (ask, assert) => {
        const rows = await verdicts(ask);
        const rejected = rows.filter(r => !r.engine.ok).length;
        /* Il presidio contro il passaggio a vuoto: un corpus che il motore
           accetta per intero non discrimina niente, e un confronto che non
           avviene resta verde con l'etichetta che dice quanti erano. */
        assert(`il corpus ha corpi validi e corpi rifiutati (${rows.length - rejected} / ${rejected})`,
          rejected >= 20 && rows.length - rejected >= 15,
          `accettati ${rows.length - rejected}, rifiutati ${rejected}`);
        const bad = rows.filter(r => (r.ui === null) !== r.engine.ok)
          .map(r => `${r.label}: ui=${r.ui ? r.ui.where : "valido"} motore=${r.engine.ok ? "valido" : r.engine.error}`);
        assert(`${rows.length} corpi, stesso verdetto`, bad.length === 0, bad.join("\n      "));
      },
    },
    {
      label: "stessa sotto-posizione: il primo guard che scatta e' lo stesso",
      run: async (ask, assert) => {
        const rows = await verdicts(ask);
        /* Ogni rifiuto del builder e' un InvalidFieldValueError col campo;
           senza chiave passata, il campo e' la sotto-posizione
           `envelope.<where>`. Un rifiuto senza campo e' un errore che non
           viene dal builder (o un motore precedente a PGE #211), e qui non ha
           niente con cui confrontarsi: e' rosso anche lui. */
        const withField = rows.filter(r => !r.engine.ok && r.engine.field);
        const bad = withField.filter(r => !r.ui || `envelope.${r.ui.where}` !== r.engine.field)
          .map(r => `${r.label}: ui=${r.ui ? "envelope." + r.ui.where : "valido"} motore=${r.engine.field}`);
        assert(`${withField.length} rifiuti col campo, stessa sotto-posizione`,
          bad.length === 0, bad.join("\n      "));
        const noField = rows.filter(r => !r.engine.ok && !r.engine.field)
          .map(r => `${r.label}: ${r.engine.error}`);
        assert("ogni rifiuto del corpus porta il campo (e' un InvalidFieldValueError del builder)",
          noField.length === 0, noField.join("\n      "));
        assert("...e i confronti fatti sono tutti i rifiuti, non zero",
          withField.length >= 20, `confrontati ${withField.length}`);
      },
    },
    {
      label: "il punto cieco dichiarato: n_reps 2.0 e' un float per il motore",
      run: async (ask, assert) => {
        /* Di qua `2.0` e `2` sono lo stesso Number, e JSON non li distingue:
           il corpo si manda come testo JSON, che Python legge float. */
        const r = (await ask("build_envelope", { raw_json: "[[[0, 0], [100, 1]], 1, 2.0]" })).value;
        assert("il motore rifiuta n_reps: 2.0 (non e' un compatto)", r.ok === false, JSON.stringify(r));
        assert("...e la UI tace: vede n_reps 2, il verso sicuro",
          E.envShapeError([PAT, 1, 2.0]) === null);
        const same = (await ask("build_envelope", { raw_json: "[[[0, 0], [100, 1]], 1, 2]" })).value;
        assert("...mentre n_reps: 2 il motore lo costruisce: e' davvero il float",
          same.ok === true, JSON.stringify(same));
      },
    },
  ],
});
