/* =============================================================================
 * deviation-probability.js — single source of truth for classifying a stream's
 * `deviation_probability` (the engine key formerly named `dephase`, renamed in
 * PGE #204 with no back-compat alias).
 *
 * The editor distinguishes four modes (off / implicit / global / perParam).
 * The discriminator used to be inlined as "Array.isArray = global env, any
 * other object = per-param" in three places (Inspector.detectDeviationProbMode,
 * EnvelopeEditor.listEnvelopes, envelope-utils walk). That inline rule broke as
 * soon as an envelope took the typed `{type, points}` object form: wrapEnv
 * (envelope-loops.js) emits that form for any pure-breakpoint envelope with a
 * non-linear GLOBAL interpolation (e.g. cubic), so choosing "cubic" on a global
 * envelope turned the value into an object and the inline rule mis-read it as
 * per-param — closing the envelope and flipping the UI mode.
 *
 * This module centralizes the rule and mirrors the engine's authority,
 * GateFactory._classify_deviation_probability, which tests envelope-like
 * (Envelope.is_envelope_like: a list of breakpoints OR a dict carrying 'points')
 * BEFORE the dict→SPECIFIC (per-param) branch. So `{type, points}` is a GLOBAL
 * envelope, never per-param — and so is a bare `{points}` without `type`, which
 * the editor never emits but a hand-written file can carry.
 *
 * Depends on window.PGEYaml (DEVIATION_PROB_IMPLICIT sentinel) and window.PGEEnv
 * (isBreakpoint / isBPGroup / isCompactBlock) — both read at call time, so load
 * order only requires them present before these functions run. Attaches to
 * window.PGEDeviationProb.
 * ===========================================================================*/

(function () {
  /* Is a VALUE an envelope? True for a breakpoint array [[t,v],…], for the
     typed `{type, points}` object form the editor emits, and per il dict che
     porta `points` e basta. Usata sia per il valore globale sia per ciascun
     valore per-parametro.

     La metà dict è quella del motore alla lettera — `'points' in obj`, niente
     di più (Envelope.is_envelope_like). Chiedere anche `type`, come fa
     isTypedEnv, spostava nel ramo per-parametro un envelope globale valido:
     l'editor apriva il pannello sbagliato, e i corpi rotti sotto `points`
     (`{points: null}`, `{points: []}`) non arrivavano mai al controllo di
     error(). isTypedEnv resta più stretta perché lì `type` è il dato che si
     va a leggere; qui la domanda è solo se il motore lo tratterà da envelope. */
  function isEnvValue(v) {
    if (Array.isArray(v)) return true;
    return !!(v && typeof v === "object" && "points" in v);
  }

  /* Classify `deviation_probability` into "off" | "implicit" | "global" |
     "perParam". Order matches GateFactory._classify_deviation_probability:
     envelope-like wins over the generic dict (per-param) check, so a typed
     global envelope stays global. */
  function mode(d) {
    if (d === window.PGEYaml.DEVIATION_PROB_IMPLICIT) return "implicit";
    // Key absent (undefined) and explicit false both mean off (engine default
    // off). Only the DEVIATION_PROB_IMPLICIT sentinel above means implicit 1%.
    if (d === false || d == null) return "off";
    // `true` non è off: in Python bool è sottoclasse di int, quindi il motore
    // lo prende dal ramo `isinstance(dp, (int, float))` e costruisce un
    // RandomGate su float(True) — l'1% implicito, ma dichiarato. L'ordine
    // conta: il check su `false` sta sopra e resta off.
    if (typeof d === "boolean") return "global";
    if (typeof d === "number") return "global";
    if (isEnvValue(d)) return "global";          // [[t,v],…] or {type, points}
    if (typeof d === "object") return "perParam"; // dict without 'points'
    return "off";
  }

  /* Le chiavi del dict per-parametro che il motore consulta SEMPRE, qualunque
     sia il resto dello stream. Non è la lista dei `deviation_probability_key`
     dichiarati negli spec — sono due insiemi diversi, ed è la differenza che
     conta qui:

       - `envelope` è dichiarata da `grain_envelope`, che è `is_smart=False`
         (parameter_schema.py): l'orchestratore la manda al ramo `_raw_value` e
         non passa mai da GateFactory. Per il motore è come una chiave
         inventata: `{envelope: 50}` e `{foo: 50}` danno lo stesso gate — un
         AlwaysGate quando il gate è attivo e le finestre dichiarate sono più
         di una (lista o `all`), un NeverGate in ogni altro caso, compreso il
         dict transition/multistate. Il discriminante non è il numero di
         finestre: con transition o multistate il gate è spento a monte
         (`uses_gate = not (transition or multistate)`, window_controller.py),
         il deviation_probability arriva a GateFactory come `False` e
         has_explicit_range è False a prescindere — e le finestre lì sono
         proprio DUE, perché parse_window_list per `{from, to}` ritorna i due
         nomi. È la stessa condizione che liveParamKeys applica qui sotto. E in
         nessuno dei due casi il numero scritto conta. La probabilità della
         finestra si dichiara su `pc_rand_envelope` (window_controller.py),
         uno dei due param_key costruiti a runtime fuori dallo schema:
         l'altro è `pitch` (pitch_controller.py).
       - `pc_rand_envelope`, `reverse` e `read_direction` sono invece VIVE ma
         condizionali: dipendono da com'è scritto il blocco `grain`, che qui non
         si vede. Stanno in `liveParamKeys(stream)`, non qui.

     Le chiavi che nessun gate chiede non sono un errore e non vanno validate:
     il motore le scarta in silenzio. */
  const PARAM_KEYS = ["volume", "pan", "duration", "pitch", "pointer"];

  /* Le due chiavi che il blocco `grain` accende o spegne, e la regola con cui
     lo fa. Verificate eseguendo il motore, non leggendolo:

       - `reverse` / `read_direction` sono un gruppo esclusivo
         (`grain_direction`). ExclusiveGroupSelector ne sceglie UNA: quella
         scritta in `grain`, e con nessuna delle due scritte vince `reverse`
         (priorità 1, default non-None). Il perdente va a None senza che nessun
         gate venga creato, quindi la sua chiave in deviation_probability è
         inerte. Con ENTRAMBE scritte il motore rifiuta lo stream prima di
         arrivare qui (Stream._init_grain_reverse), e l'Inspector lo segnala
         già per conto suo: qui si sceglie comunque `read_direction`, perché è
         quella che il selettore prenderebbe.
       - `pc_rand_envelope` è viva quando `grain.envelope` NON è uno spec
         transition (`{from, to}`) o multistate (`{states}`):
         `uses_gate = not (_is_transition_spec or _is_multistate_spec)`
         (window_controller.py). Con la forma comune — una stringa, o una lista
         di finestre — il gate riceve il deviation_probability vero e valida. */
  /* Ogni chiave che in QUALCHE configurazione il motore legge: l'unione di
     PARAM_KEYS e delle condizionali. Non serve a validare — validare su questa
     lista rimetterebbe i falsi positivi che liveParamKeys esiste per togliere —
     ma a camminare gli envelope (envelope-utils: rescale e truncate al resize
     dello stream), dove sbagliare per eccesso costa un envelope riscalato che
     il motore non guarda, e sbagliare per difetto costa un envelope che resta
     fuori scala su uno YAML che rende. `envelope` c'è per i progetti che la
     portano ancora scritta: è inerte per il motore, ma finché sta nel file il
     round trip la deve trattare come le altre. */
  const ALL_PARAM_KEYS = PARAM_KEYS.concat(
    ["reverse", "read_direction", "pc_rand_envelope", "envelope"]);

  function liveParamKeys(stream) {
    const keys = PARAM_KEYS.slice();
    const grain = (stream && typeof stream.grain === "object" && stream.grain) || {};
    // "read_direction scritta" è la stessa condizione con cui il serializer
    // decide di riemettere la chiave: lo scalare può essere undefined mentre
    // l'envelope c'è, e la chiave nuda vale null (che è comunque scritta).
    const rdWritten = grain.readDirection !== undefined || grain.readDirectionEnv != null;
    keys.push(rdWritten ? "read_direction" : "reverse");
    const envSpec = grain.envelope;
    const envDict = !!(envSpec && typeof envSpec === "object" && !Array.isArray(envSpec));
    // transition = dict con ENTRAMBE 'from' e 'to'; multistate = dict con 'states'.
    const isTransition = envDict && "from" in envSpec && "to" in envSpec;
    const isMultistate = envDict && "states" in envSpec;
    if (!isTransition && !isMultistate) keys.push("pc_rand_envelope");
    return keys;
  }

  /* Un corpo destinato a diventare envelope si costruisce? Ritorna null se sì,
     altrimenti il motivo: "empty" (nessun breakpoint) o "shape" (niente di
     riconoscibile dentro).

     È la metà conservativa del builder del motore: segnala solo i corpi che
     NON possono essere un envelope in nessuna lettura. Una lista con un
     elemento buono e uno rotto (`[[0,1], 'x']`) il motore la rifiuta lo stesso,
     qui passa — meglio un avviso in meno che un avviso su uno YAML che rende. */
  /* Un breakpoint in forma dict `{t, v, type?}`. Il builder del motore lo
     normalizza in `[t, v, type?]` prima di guardarlo
     (envelope_builder.py:132), quindi è un formato di prima classe, non un
     residuo — e da PGE #234 lo è anche per `is_envelope_like`, che prima non
     lo riconosceva: una lista di soli dict veniva RIFIUTATA come corpo globale,
     e questo modulo doveva ricalcare l'asimmetria. Ora non più.
     `PGEEnv.isBreakpoint` esige `Array.isArray` e non lo vede — e non va
     allargata: la usa anche l'EnvelopeEditor per decidere cosa è trascinabile,
     e i breakpoint dict il canvas non li disegna. Il predicato resta quindi
     locale a questo modulo, dove la domanda è solo se il motore costruirà il
     corpo. */
  function _isDictBP(it) {
    return !!(it && typeof it === "object" && !Array.isArray(it) && "t" in it && "v" in it);
  }

  function _envBodyError(v) {
    const E = window.PGEEnv;
    if (Array.isArray(v)) {
      if (v.length === 0) return "empty";
      // Prima l'array INTERO, poi i suoi elementi — nello stesso ordine di
      // is_envelope_like. Due forme sono il corpo, non un elemento del corpo:
      // il BP group diretto `[[[0,0],[1,100]], 'cubic']` (PGE #64) e il blocco
      // compatto nudo `[[[0,0],[100,50]], 1.0, 4]`. Guardando solo gli elementi
      // finivano segnalate come non costruibili, e il motore le costruisce.
      if (E.isBPGroup(v) || E.isCompactBlock(v)) return null;
      const any = v.some(it => E.isBreakpoint(it) || E.isBPGroup(it) || E.isCompactBlock(it) ||
                               _isDictBP(it));
      return any ? null : "shape";
    }
    if (v && typeof v === "object") {
      // Il builder legge `points` senza guardare se c'è: un dict che non ce
      // l'ha alza KeyError, ed è il terzo dei corpi malformati di PGE #209.
      if (!Array.isArray(v.points)) return "shape";
      return _envBodyError(v.points);
    }
    return null;
  }

  /* I corpi che il motore rifiuta (PGE #209). Prima li accettava in silenzio e
     li trattava come probabilità 100% — il render riusciva producendo
     l'opposto di quanto scritto; ora solleva e il render esce con errore.

     Nessuno di questi corpi è producibile dai controlli dell'Inspector (il
     verso "off" scrive `false`, l'EnvelopeEditor rifiuta di svuotare un
     envelope): arrivano dal tab Raw o da uno YAML scritto a mano, e allora
     tanto vale dirlo prima del render invece che dopo.

     `stream` è opzionale e serve solo alle chiavi per-parametro condizionali
     (vedi liveParamKeys): passandolo si guadagnano gli avvisi su
     `pc_rand_envelope` e sulla chiave del verso effettivamente in vigore, che
     senza il blocco `grain` non si possono attribuire. Senza, si validano solo
     le cinque chiavi sempre vive — meno avvisi, mai uno su uno YAML che rende.

     Ritorna null se valido, altrimenti { kind, reason?, param?, value }:
       "type" → il corpo non è bool | numero | envelope | dict per-parametro
       "env"  → un corpo che vuole essere envelope e non si costruisce
     `param` è presente quando il colpevole è una chiave del dict per-parametro
     — la stessa che il motore nomina come `deviation_probability.<chiave>`.
     Puro: niente DOM, niente chiamate al motore. */
  function error(d, stream) {
    if (d === undefined || d === null || d === false) return null;
    if (d === window.PGEYaml.DEVIATION_PROB_IMPLICIT) return null;
    // `true` non è un errore: per il motore è un numero, e float(True) è 1%.
    if (typeof d === "number" || typeof d === "boolean") return null;
    if (typeof d !== "object") return { kind: "type", value: d };

    if (isEnvValue(d)) {
      const reason = _envBodyError(d);
      return reason ? { kind: "env", reason, value: d } : null;
    }

    for (const k of (stream ? liveParamKeys(stream) : PARAM_KEYS)) {
      if (!(k in d)) continue;
      const v = d[k];
      // chiave a null = range-only per quel parametro, non un envelope vuoto
      if (v === null || typeof v === "number" || typeof v === "boolean") continue;
      if (typeof v !== "object") return { kind: "type", param: k, value: v };
      const reason = _envBodyError(v);
      if (reason) return { kind: "env", reason, param: k, value: v };
    }
    return null;
  }

  window.PGEDeviationProb = { mode, isEnvValue, error, PARAM_KEYS, ALL_PARAM_KEYS, liveParamKeys };
})();
