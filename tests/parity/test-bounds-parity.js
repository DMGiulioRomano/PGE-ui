/* =============================================================================
 * test-bounds-parity.js — i clamp della UI contro i bound veri (issue #133).
 *
 * Qui il buco era il piu' netto dei cinque. La catena e':
 *
 *     parameter_definitions.py  →  engine_introspect (AST)  →  GET /bounds
 *                               →  mergeEngineBounds  →  window.PGE_BOUNDS
 *
 * e ogni anello aveva il suo test. `test-bounds.js` costruisce un payload
 * sintetico e verifica la mappatura; `test_render_pipeline.py` scrive un finto
 * `parameter_definitions.py` in `tmp_path` e verifica il parser AST. Nessuno
 * dei due ha mai letto il file vero, quindi un rename nel motore — o un campo
 * che l'AST non sa leggere — passava senza far fallire niente e la UI si
 * teneva il fallback statico credendo di avere i bound del motore.
 *
 * Le cinque domande di questa suite:
 *
 *   1. il parser AST legge gli STESSI valori che il motore usa importato;
 *   2. ogni parametro nominato in ENGINE_PARAM_MAP esiste nel registro;
 *   3. i clamp che la UI finisce per usare sono quelli del motore, salvo le
 *      eccezioni dichiarate;
 *   4. il fallback statico — quello di `file://` e del server spento — non
 *      ammette valori che il motore rifiuta;
 *   5. e la stessa domanda per l'ALTRA lettura AST del bridge, quella di
 *      `/envelope-keys`: e' l'unico ponte fra `ENVELOPE_COLORS` e la UI, e
 *      finora nessun test l'aveva mai puntata sul file vero.
 *
 * Run: node tests/parity/test-bounds-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs([
  "yaml-bridge.js", "bounds.js",
  // envelope-utils porta LOOP_UNITS, l'ultimo vocabolario del motore che
  // questo repo scrive per esteso; le due prima sono le sue dipendenze di
  // caricamento (envelope-loops per window.PGEEnv, deviation-probability per
  // la lettura a chiamata).
  "envelope-loops.js", "deviation-probability.js", "envelope-utils.js",
]);
const B = window.PGEBounds;
const STATIC = JSON.parse(JSON.stringify(window.PGE_BOUNDS));

/* Una base deliberatamente sbagliata, e non e' un vezzo.
 *
 * `PGE_BOUNDS` statico oggi COINCIDE col motore su ogni campo mappato — e'
 * cio' che il caso 4 pretende. Quindi confrontare `mergeEngineBounds(STATIC,
 * motore)` col motore non dice niente sul merge: i due lati sono lo stesso
 * oggetto qualunque cosa faccia la funzione. Verificato rendendola un no-op
 * (`return deepClone(base)`): la suite restava 18/0.
 *
 * Partendo da una sentinella — un valore che il registro del motore non puo'
 * produrre — un merge che non fa niente si vede subito. E la stessa costruzione
 * fa parlare l'altra meta' della divergenza `loop_*`: dove il motore ha
 * `max_val: null` il merge deve LASCIARE la base, quindi il tetto deve restare
 * la sentinella. Togliendo la guardia `typeof hi === "number"` in bounds.js quel
 * tetto diventa `null` e i knob dei loop perdono il clamp: la suite prima
 * taceva, ora no.
 *
 * La sentinella e' DERIVATA dal motore, non scelta. Era `424242` con accanto
 * l'affermazione «non compare da nessuna parte nel registro del motore»: cioe'
 * esattamente il genere di cosa che questa cartella esiste per non credere sulla
 * parola, e che nessuno ricontrollerebbe quando il motore aggiunge un bound. Un
 * numero che il registro contiene davvero renderebbe questi assert bugiardi al
 * contrario — un merge corretto che produce quel valore verrebbe letto come "non
 * toccato". `max + 1` non e' producibile per costruzione, e c'e' un assert che
 * lo ricontrolla. */
function sentinelFor(payload) {
  let max = 0;
  const walk = (v) => {
    if (typeof v === "number") { if (Number.isFinite(v) && v > max) max = v; return; }
    if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(payload);
  return max + 1;
}
function wrongBase(sentinel) {
  const w = JSON.parse(JSON.stringify(STATIC));
  for (const k of Object.keys(B.ENGINE_PARAM_MAP)) {
    if (w[k]) w[k] = { min: sentinel, max: sentinel };
  }
  w.pitch = { edoFactor: sentinel };
  return w;
}
/* Ogni numero del payload, per il controllo di cui sopra. */
function everyNumber(v, out = []) {
  if (typeof v === "number") out.push(v);
  else if (v && typeof v === "object") Object.values(v).forEach(x => everyNumber(x, out));
  return out;
}

/* Eccezioni dichiarate, ognuna con la ragione. Non sono sviste: sono i punti
 * in cui i bound statici del motore NON sono il vincolo vero. */
const MIN_EXCEPTIONS = {
  grainDur: "il minimo vero e' 1 campione (1/output_sr, PGE #158), un override " +
            "dinamico che il registro statico non porta: bounds.js lo applica a mano",
};
const MAX_EXCEPTIONS = {
  loopStart: "max_val e' null: il tetto vero e' la durata del sample scelto",
  loopDur:   "max_val e' null: il tetto vero e' la durata del sample scelto",
  loopEnd:   "max_val e' null: il tetto vero e' la durata del sample scelto",
};

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}
const same = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));

function engineBound(raw, uiKey) {
  const { param, field } = B.ENGINE_PARAM_MAP[uiKey];
  const ep = (raw.params || {})[param];
  if (!ep) return null;
  return field === "range"
    ? { min: ep.min_range, max: ep.max_range, param }
    : { min: ep.min_val,   max: ep.max_val,   param };
}

parity({
  suite: "bounds",
  why: "GET /bounds (AST) + mergeEngineBounds + PGE_BOUNDS  ↔  GRANULAR_PARAMETERS / PitchUnit.value_bounds",
  cases: [
    {
      label: "il parser AST legge quello che il motore usa",
      run: async (ask, assert) => {
        const [impR, astR] = await ask([
          { op: "parameter_bounds", args: { source: "import" } },
          { op: "parameter_bounds", args: { source: "ast" } },
        ]);
        if (!impR.ok) throw new Error(`import: ${impR.error}`);
        if (!astR.ok) throw new Error(`ast: ${astR.error}`);
        const imp = impR.value, ast = astR.value;

        assert("l'AST trova tutti i parametri del registro",
          same(Object.keys(imp.params).sort(), Object.keys(ast.params || {}).sort()),
          `import=${Object.keys(imp.params).length} ast=${Object.keys(ast.params || {}).length}`);

        const diffs = [];
        for (const name of Object.keys(imp.params)) {
          if (!same(imp.params[name], (ast.params || {})[name])) {
            diffs.push(`${name}: import=${JSON.stringify(imp.params[name])} ast=${JSON.stringify((ast.params || {})[name])}`);
          }
        }
        assert(`${Object.keys(imp.params).length} parametri, stessi sei campi`,
          diffs.length === 0, diffs.join("\n      "));

        assert("stessi bound di pitch (unita' EDO + ratio + edoFactor)",
          same(imp.pitch, ast.pitch),
          `import=${JSON.stringify(imp.pitch)}\n      ast=${JSON.stringify(ast.pitch)}`);
      },
    },
    {
      label: "ENGINE_PARAM_MAP nomina parametri che esistono",
      run: async (ask, assert) => {
        const raw = await ask("parameter_bounds", { source: "import" });
        if (!raw.ok) throw new Error(raw.error);
        const params = raw.value.params;
        const missing = [];
        for (const uiKey of Object.keys(B.ENGINE_PARAM_MAP)) {
          const { param, field } = B.ENGINE_PARAM_MAP[uiKey];
          if (!params[param]) { missing.push(`${uiKey} → ${param} (inesistente)`); continue; }
          const need = field === "range" ? ["min_range", "max_range"] : ["min_val", "max_val"];
          for (const f of need) {
            if (!(f in params[param])) missing.push(`${uiKey} → ${param}.${f} assente`);
          }
        }
        assert(`${Object.keys(B.ENGINE_PARAM_MAP).length} chiavi mappate, tutte su un parametro reale`,
          missing.length === 0, missing.join("\n      "));

        /* E il verso opposto, che mancava: la mappa e' COMPLETA?
           Togliere una riga da ENGINE_PARAM_MAP lasciava la suite verde, con
           l'etichetta che continuava a dire "20 chiavi mappate" essendone 19 —
           e quel clamp tornava silenziosamente al fallback statico. L'invariante
           e' la regola gia' scritta in CLAUDE.md ("se aggiungi un clamp, aggiungi
           il fallback in yaml-bridge.js E la mappatura in bounds.js"): ogni
           chiave di PGE_BOUNDS o e' mappata, o e' `pitch`, che segue una strada
           sua (il motore lo consegna gia' calcolato per unita'). */
        const unmapped = Object.keys(STATIC)
          .filter(k => k !== "pitch" && !(k in B.ENGINE_PARAM_MAP));
        assert("ogni clamp di PGE_BOUNDS ha la sua mappatura (pitch a parte)",
          unmapped.length === 0,
          unmapped.join(", ") + " — senza mappatura restano al fallback statico " +
          "anche col bridge acceso");
      },
    },
    {
      label: "i clamp che la UI usa sono quelli del motore",
      run: async (ask, assert) => {
        const raw = await ask("parameter_bounds", { source: "import" });
        if (!raw.ok) throw new Error(raw.error);
        const merged = B.mergeEngineBounds(STATIC, raw.value);

        /* Prima la domanda che il merge deve saper reggere: da una base
           sbagliata, i valori del motore devono comunque arrivare. */
        const SENTINEL = sentinelFor(raw.value);
        assert(`la sentinella (${SENTINEL}) non e' un valore che il motore produce`,
          !everyNumber(raw.value).includes(SENTINEL),
          "con una sentinella producibile, un merge corretto che la restituisce " +
          "verrebbe letto come 'non toccato': gli assert qui sotto direbbero il falso");
        const fromWrong = B.mergeEngineBounds(wrongBase(SENTINEL), raw.value);
        const notMerged = [];
        for (const uiKey of Object.keys(B.ENGINE_PARAM_MAP)) {
          const e = engineBound(raw.value, uiKey);
          if (!e) continue;
          if (typeof e.min === "number" && fromWrong[uiKey].min === SENTINEL
              && !(uiKey in MIN_EXCEPTIONS)) {
            notMerged.push(`${uiKey}.min e' rimasto la sentinella: il merge non l'ha toccato`);
          }
          if (typeof e.max === "number" && fromWrong[uiKey].max === SENTINEL) {
            notMerged.push(`${uiKey}.max e' rimasto la sentinella: il merge non l'ha toccato`);
          }
        }
        assert("da una base sbagliata il merge porta comunque i valori del motore",
          notMerged.length === 0, notMerged.join("\n      "));
        assert("e anche i bound di pitch, che seguono un'altra strada",
          fromWrong.pitch.edoFactor === raw.value.pitch.edoFactor &&
          same(fromWrong.pitch.semitones, raw.value.pitch.semitones),
          JSON.stringify(fromWrong.pitch));

        /* E la meta' UI della divergenza loop_*: dove il motore non ha tetto,
           il merge deve LASCIARE quello della base. */
        const kept = [];
        for (const uiKey of Object.keys(MAX_EXCEPTIONS)) {
          if (fromWrong[uiKey].max !== SENTINEL) {
            kept.push(`${uiKey}.max = ${JSON.stringify(fromWrong[uiKey].max)} invece della base: ` +
                      `con max_val null il merge non deve toccare il tetto`);
          }
          if (merged[uiKey].max !== STATIC[uiKey].max) {
            kept.push(`${uiKey}.max = ${JSON.stringify(merged[uiKey].max)} invece di ${STATIC[uiKey].max}`);
          }
        }
        assert("loop_*: il tetto statico sopravvive al merge (max_val null)",
          kept.length === 0, kept.join("\n      "));

        const diffs = [];
        for (const uiKey of Object.keys(B.ENGINE_PARAM_MAP)) {
          const e = engineBound(raw.value, uiKey);
          if (!e) continue;
          const m = merged[uiKey];
          if (typeof e.min === "number" && m.min !== e.min && !(uiKey in MIN_EXCEPTIONS)) {
            diffs.push(`${uiKey}.min: ui=${m.min} motore=${e.min} (${e.param})`);
          }
          if (typeof e.max === "number" && m.max !== e.max && !(uiKey in MAX_EXCEPTIONS)) {
            diffs.push(`${uiKey}.max: ui=${m.max} motore=${e.max} (${e.param})`);
          }
        }
        assert("nessuna differenza fuori dalle eccezioni dichiarate",
          diffs.length === 0, diffs.join("\n      "));

        // Le eccezioni si pretendono: se un giorno il motore desse un max_val
        // ai loop_*, questa riga direbbe che l'eccezione non serve piu'.
        for (const uiKey of Object.keys(MAX_EXCEPTIONS)) {
          const e = engineBound(raw.value, uiKey);
          assert(`${uiKey}: il motore continua a non avere un tetto statico (${MAX_EXCEPTIONS[uiKey].slice(0, 40)}…)`,
            e && e.max === null, JSON.stringify(e));
        }
        assert("grainDur: il minimo della UI e' piu' basso di quello statico, non piu' alto",
          merged.grainDur.min < engineBound(raw.value, "grainDur").min,
          `${merged.grainDur.min} vs ${engineBound(raw.value, "grainDur").min}`);

        assert("i bound di pitch della UI sono quelli del motore",
          same(merged.pitch, Object.assign({}, STATIC.pitch, raw.value.pitch)),
          JSON.stringify(merged.pitch));
        for (const unit of ["semitones", "cents", "quarter_tone", "eighth_tone", "ratio"]) {
          assert(`pitch.${unit} === PitchUnit.value_bounds()`,
            same(merged.pitch[unit], raw.value.pitch[unit]),
            `ui=${JSON.stringify(merged.pitch[unit])} motore=${JSON.stringify(raw.value.pitch[unit])}`);
        }
      },
    },
    {
      label: "il fallback statico non ammette cio' che il motore rifiuta",
      run: async (ask, assert) => {
        // Questo e' il caso che nessuno guardava: su `file://` o con il server
        // spento la UI usa SOLO window.PGE_BOUNDS, e li' un tetto piu' alto di
        // quello del motore non e' prudenza, e' una manopola che arriva a un
        // valore che il render rifiuta.
        const raw = await ask("parameter_bounds", { source: "import" });
        if (!raw.ok) throw new Error(raw.error);

        const wider = [];
        for (const uiKey of Object.keys(B.ENGINE_PARAM_MAP)) {
          const e = engineBound(raw.value, uiKey);
          const s = STATIC[uiKey];
          if (!e || !s) continue;
          if (typeof e.min === "number" && s.min < e.min && !(uiKey in MIN_EXCEPTIONS)) {
            wider.push(`${uiKey}.min: statico=${s.min} < motore=${e.min}`);
          }
          if (typeof e.max === "number" && s.max > e.max && !(uiKey in MAX_EXCEPTIONS)) {
            wider.push(`${uiKey}.max: statico=${s.max} > motore=${e.max}`);
          }
        }
        assert("nessun clamp statico piu' largo del motore",
          wider.length === 0, wider.join("\n      "));

        const pitchDiffs = [];
        for (const unit of ["semitones", "cents", "quarter_tone", "eighth_tone", "ratio"]) {
          const s = STATIC.pitch[unit], e = raw.value.pitch[unit];
          if (!s || !e) continue;
          if (s.min < e.min) pitchDiffs.push(`${unit}.min: ${s.min} < ${e.min}`);
          if (s.max > e.max) pitchDiffs.push(`${unit}.max: ${s.max} > ${e.max}`);
          if (s.rangeMax > e.rangeMax) pitchDiffs.push(`${unit}.rangeMax: ${s.rangeMax} > ${e.rangeMax}`);
        }
        assert("nemmeno per il pitch", pitchDiffs.length === 0, pitchDiffs.join("\n      "));
        assert("edoFactor statico === quello del motore",
          STATIC.pitch.edoFactor === raw.value.pitch.edoFactor,
          `statico=${STATIC.pitch.edoFactor} motore=${raw.value.pitch.edoFactor}`);
      },
    },
    {
      /* Il sample rate: l'ultima costante del motore che questo repo teneva
       * ricopiata a mano, e la piu' pericolosa delle due che ne restavano.
       *
       * `DEFAULT_OUTPUT_SR` non e' un bound, ma ne genera uno (il minimo di
       * `grain_duration` e' 1 campione, `1/sr`) e soprattutto e' il fattore con
       * cui `grainUnitFactor` converte `grain.duration_unit: samples` —
       * `convertGrainDurationUnit` con quel fattore RISCRIVE `duration` e
       * `duration_range` nello YAML. Un clamp sbagliato stringe o allarga una
       * manopola; qui un numero sbagliato scrive durate sbagliate su disco.
       *
       * Tre anelli, tre asserzioni, la stessa forma della catena della
       * semantica: la costante vera (import), la lettura AST del bridge (la
       * sola via per cui il numero arriva alla UI) e il fallback statico di
       * yaml-bridge.js.
       *
       * Sul fallback si pretende l'UGUAGLIANZA e non il "non piu' largo" degli
       * altri clamp, perche' qui il verso sicuro non e' ovvio e cambia segno a
       * seconda del lettore: un `sr` statico piu' ALTO del motore da' un min
       * piu' PICCOLO (1/48000 < 1/44100), cioe' la UI ammette un grano piu'
       * corto di un campione vero — permissiva, il verso brutto; ma lo stesso
       * `sr` piu' alto rende la conversione `samples` troppo corta, che e' un
       * valore sbagliato e basta, in nessuna direzione utile. Un numero solo,
       * nessuna banda. */
      label: "il sample rate del motore, e il fallback statico che lo copia",
      run: async (ask, assert, ctx) => {
        const r = await ask("constants");
        if (!r.ok) throw new Error(r.error);
        const c = r.value;

        assert("il motore dichiara DEFAULT_OUTPUT_SR",
          Number.isInteger(c.default_output_sr) && c.default_output_sr > 0,
          `default_output_sr=${JSON.stringify(c.default_output_sr)} ` +
          `err=${c.default_output_sr_error || "-"}`);

        assert("la lettura AST del bridge da' lo stesso numero della costante",
          c.default_output_sr_ast === c.default_output_sr,
          `ast=${JSON.stringify(c.default_output_sr_ast)} ` +
          `import=${JSON.stringify(c.default_output_sr)} ` +
          `err=${c.default_output_sr_ast_error || "-"}`);

        assert("il fallback statico di yaml-bridge.js e' il numero del motore",
          window.PGE_OUTPUT_SR === c.default_output_sr,
          `statico=${window.PGE_OUTPUT_SR} motore=${c.default_output_sr} — ` +
          `aggiorna OUTPUT_SR in src/lib/yaml-bridge.js`);

        /* E che il fallback sia davvero il pavimento di grainDur: senza questa
         * riga si potrebbe togliere l'override e la prima resterebbe verde. */
        assert("il min statico di grainDur e' 1 campione a quel sample rate",
          Math.abs(STATIC.grainDur.min - 1 / c.default_output_sr) < 1e-15,
          `statico=${STATIC.grainDur.min} atteso=${1 / c.default_output_sr}`);

        /* L'anello che chiude la catena: col payload del motore in mano, il
         * numero installato e' quello del motore e non il letterale. Si prova
         * con un sample rate che il motore non ha, altrimenti i due lati
         * coincidono e l'assert non discrimina (lo stesso ragionamento della
         * sentinella qui sopra). */
        const other = c.default_output_sr === 44100 ? 48000 : 44100;
        const prev = window.PGE_OUTPUT_SR;
        try {
          const merged = B.mergeEngineBounds(STATIC, { output_sr: other });
          assert("mergeEngineBounds prende il sample rate dal payload, non da window",
            Math.abs(merged.grainDur.min - 1 / other) < 1e-15,
            `min=${merged.grainDur.min} atteso=${1 / other} (window=${prev})`);
          B.apply({ output_sr: other });
          assert("apply() installa il sample rate del motore su window",
            window.PGE_OUTPUT_SR === other,
            `window=${window.PGE_OUTPUT_SR} atteso=${other}`);
        } finally {
          window.PGE_OUTPUT_SR = prev;
          window.PGE_BOUNDS = JSON.parse(JSON.stringify(STATIC));
        }

        /* E l'altra costante che envelope-utils ricopiava: il default di
         * `grain_duration`. Non e' un bound ma un valore del motore, seminato
         * nello YAML quando l'utente accende la chiave — quindi va confrontato
         * qui come il sample rate, o «nessuna costante trascritta a mano»
         * resta un'affermazione e non un fatto. */
        const EU = loadUiLibs(["yaml-bridge.js", "envelope-loops.js",
                               "deviation-probability.js", "envelope-utils.js"])
          .PGEEnvUtils;
        assert("il default di grain_duration e' quello dello schema del motore",
          typeof c.grain_duration_default === "number" &&
          Math.abs(EU.grainDefaultDuration("seconds") - c.grain_duration_default) < 1e-15,
          `ui=${EU.grainDefaultDuration("seconds")} motore=${JSON.stringify(c.grain_duration_default)}`);
        assert("e in millisecondi e' lo stesso valore convertito, non un secondo letterale",
          Math.abs(EU.grainDefaultDuration("milliseconds") - c.grain_duration_default * 1000) < 1e-9,
          String(EU.grainDefaultDuration("milliseconds")));

        /* La premessa del pavimento secco.
         *
         * `mergeEngineBounds` mette `grainDur.min = 1/sr` e non
         * `Math.min(base.min, 1/sr)`, perche' il motore SOSTITUISCE il min
         * dichiarato — `get_parameter_bounds(..., output_sr=…)` ritorna
         * `min_val = 1.0/output_sr`. Il commento sul posto aggiunge che i due
         * coincidono comunque, «finche' il min dichiarato sta sopra un
         * campione», e quello e' un fatto del motore: qui si pretende invece
         * di ricopiarlo. Se un giorno il motore dichiarasse un min sotto il
         * campione, la regola implementata resterebbe quella giusta ma la
         * frase smetterebbe di descrivere il caso — e questa riga lo dice,
         * invece di lasciarla invecchiare come e' gia' successo al numero. */
        const pb = await ask("parameter_bounds", { source: "import" });
        assert("l'op parameter_bounds risponde", pb.ok, pb.error);
        const declared = pb.ok && pb.value.params.grain_duration
          ? pb.value.params.grain_duration.min_val : null;
        assert("il min dichiarato di grain_duration sta sopra un campione",
          typeof declared === "number" && declared > 1 / c.default_output_sr,
          `min_val=${JSON.stringify(declared)}, un campione=${1 / c.default_output_sr}`);

        ctx.note(`sample rate del motore: ${c.default_output_sr} Hz`,
          `min di grain_duration = 1/${c.default_output_sr} = ` +
          `${1 / c.default_output_sr} s; stesso fattore per duration_unit: samples`);
        ctx.note(`min dichiarato di grain_duration: ${declared} s`,
          `${declared * c.default_output_sr} campioni a ${c.default_output_sr} Hz — ` +
          `il motore lo sostituisce con 1, e il commento in bounds.js cita ` +
          `questo numero`);
      },
    },
    {
      label: "le chiavi degli envelope: l'altra lettura AST del bridge",
      run: async (ask, assert, ctx) => {
        /* Il gemello dimenticato di /bounds (issue #137, ultimo punto).
         *
         *     ENVELOPE_COLORS  →  engine_introspect (AST)  →  GET /envelope-keys
         *                      →  il filtro della popover di render
         *
         * e in mezzo `server.py` interseca i nomi richiesti con quella stessa
         * lettura prima di comporre argv, perche' un nome ignoto fa uscire il
         * motore con 1 — l'audio compreso. Come per i bound, ogni anello aveva
         * il suo test e nessuno leggeva il file vero: `test_render_pipeline.py`
         * scrive un finto `envelope_extractor.py` in `tmp_path`, cioe' verifica
         * il parser, non la parita'. Un rename nel motore lasciava tutto verde,
         * `keys: []`, e il filtro spariva dalla popover in silenzio.
         *
         * Qui non c'e' un fallback statico da controllare (`backend.envelopeKeys`
         * torna `[]` e la UI nasconde il filtro), quindi le domande sono due:
         * che la lettura AST dica quello che dice il motore importato, e che il
         * registro da cui il bridge legge sia davvero quello contro cui la CLI
         * valida. */
        const c = (await ask("constants", {})).value;
        const imported = c.envelope_colors_keys;
        const fromAst = c.envelope_colors_keys_ast;

        assert("il motore dichiara ENVELOPE_COLORS",
          Array.isArray(imported) && imported.length > 0,
          c.envelope_keys_error || JSON.stringify(imported));

        /* Ordine incluso: l'endpoint restituisce l'ordine del sorgente e la
         * popover disegna le caselle in quell'ordine, quindi confrontare gli
         * insiemi lascerebbe fuori meta' di cio' che l'utente vede. */
        assert("la lettura AST del bridge da' le stesse chiavi, nello stesso ordine",
          Array.isArray(fromAst) && JSON.stringify(fromAst) === JSON.stringify(imported),
          (c.envelope_colors_keys_ast_error ? `${c.envelope_colors_keys_ast_error} — ` : "") +
          `ast=${JSON.stringify(fromAst)} importato=${JSON.stringify(imported)}`);

        /* Il registro giusto. `cli.py` valida `--plot-envelopes` contro
         * PLOT_ENVELOPE_KEYS, non contro ENVELOPE_COLORS; oggi il primo e'
         * `frozenset(ENVELOPE_COLORS)`, ed e' quel «oggi» a rendere legittimo
         * che il bridge legga il dict. Se il motore restringesse la validazione
         * senza toccare il dict, il filtro del bridge diventerebbe piu' largo
         * del motore — cioe' un nome che passa il filtro e fa uscire il render
         * con 1, esattamente il difetto che quell'endpoint esiste per evitare. */
        const plot = c.plot_envelope_keys;
        assert("PLOT_ENVELOPE_KEYS e' ancora l'insieme di ENVELOPE_COLORS",
          Array.isArray(plot) &&
          JSON.stringify(plot) === JSON.stringify([...(imported || [])].sort()),
          `plot=${JSON.stringify(plot)}`);

        ctx.note(`${(imported || []).length} nomi plottabili, letti dal motore`,
          (imported || []).join(", "));
      },
    },
    {
      label: "il vocabolario di loop_unit: la terza lista che la UI scrive per esteso",
      run: async (ask, assert, ctx) => {
        /* PGE #222 / PGE-ui #149. Prima `loop_unit` non aveva un insieme
         * dichiarato: il motore testava `!= 'normalized'` e ogni altra stringa
         * valeva "assoluto", quindi non c'era niente da rispecchiare. Ora una
         * grafia fuori lista e' InvalidFieldValueError — un render che muore —
         * e `loopUnitError` in envelope-utils.js lo dice mentre si scrive.
         *
         * Il prezzo e' una lista di stringhe del motore scritta in questo repo,
         * cioe' esattamente cio' che CLAUDE.md vieta senza una parita' che la
         * tenga onesta: con il motore davanti i due lati coincidono sempre, e a
         * divergere sarebbero solo dopo un rename upstream che nessun test
         * node vedrebbe. Questo caso e' quella parita'.
         *
         * L'ordine conta: la prima grafia e' la canonica, ed e' quella che il
         * selettore dell'Inspector scrive quando l'utente sceglie l'assoluto. */
        const c = (await ask("constants", {})).value;
        const fromEngine = c.loop_units_ast;

        assert("il motore dichiara LOOP_UNITS",
          Array.isArray(fromEngine) && fromEngine.length > 0,
          c.loop_units_ast_error || JSON.stringify(fromEngine));

        assert("la UI ne ha la stessa copia, nello stesso ordine",
          JSON.stringify(window.PGEEnvUtils.LOOP_UNITS) === JSON.stringify(fromEngine),
          `ui=${JSON.stringify(window.PGEEnvUtils.LOOP_UNITS)} motore=${JSON.stringify(fromEngine)}`);

        /* Il default della UI dev'essere una grafia che il motore accetta, e
         * la canonica: e' quella che il selettore scrive, quindi una scelta
         * fuori lista sarebbe un render ucciso dall'editor stesso. */
        assert("il default della UI e' la prima grafia del motore",
          window.PGEEnvUtils.LOOP_UNIT_DEFAULT === fromEngine[0],
          `default=${window.PGEEnvUtils.LOOP_UNIT_DEFAULT} prima=${fromEngine[0]}`);

        /* E il mirror non deve solo avere la lista: deve usarla. Ogni grafia
         * del motore passa, una inventata no — altrimenti una `LOOP_UNITS`
         * allineata e un `loopUnitError` che ignora la lista starebbero
         * verdi insieme. */
        assert("loopUnitError accetta ogni grafia del motore",
          fromEngine.every(u => window.PGEEnvUtils.loopUnitError({ loopUnit: u }) === null));
        assert("…e rifiuta quel che il motore non dichiara",
          window.PGEEnvUtils.loopUnitError({ loopUnit: fromEngine[0] + "_"}) !== null);

        /* L'ereditarieta' e' morta davvero, e non solo nel commento: nessun
         * time_mode puo' far leggere le coordinate come normalized. E' la
         * divergenza che #149 ha chiuso — la UI scriveva 0.075 dove il motore
         * legge 0.6 s. */
        assert("nessun time_mode produce la lettura normalized",
          ["normalized", "absolute", undefined]
            .every(tm => window.PGEEnvUtils.loopUnitInfo({ timeMode: tm }).unit === "absolute"));

        ctx.note(`vocabolario di loop_unit: ${fromEngine.join(", ")}`,
          `canonica «${fromEngine[0]}», default della chiave assente`);
      },
    },
  ],
});
