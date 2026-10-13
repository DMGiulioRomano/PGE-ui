/* envelope-loops.js
 * Helpers per il formato compatto degli envelope (loops ripetuti) — vedi
 * envelopes-reference.md §5 (formato compatto) e §6 (distribuzioni temporali).
 *
 * Modello dati:
 *   Forme top-level di una envelope:
 *   (A) array mixed   :  [item, item, …]
 *   (B) dict con type :  {type: 'linear'|'cubic'|'step', points: [item, …]}
 *                        — il `type` governa ogni segmento che non dichiara
 *                        un tipo sul punto; dentro `points` stanno gli stessi
 *                        item della forma (A). wrapEnv la scrive per ogni
 *                        interp globale non lineare, eccezioni sul punto e BP
 *                        group compresi (#189), ma non con un loop block fra
 *                        gli item (caso dichiarato, #191).
 *
 *   Gli `item` nella forma (A) sono:
 *   - breakpoint:  [t, v]                    (t∈[0,1] in editor visivo)
 *   - bp group:    [points, interp]          (PGE #64 / PR #165)
 *                  points: [[t, v(, type?)], …]  tempi ASSOLUTI
 *                  interp: 'linear' | 'cubic' | 'step' — governa i soli
 *                  segmenti interni (n punti → n−1 segmenti); il segmento in
 *                  uscita dall'ultimo punto segue il default globale. Un type
 *                  esplicito per-punto fa override dell'interp di zona.
 *                  Supportata anche la forma diretta `param: [points, interp]`.
 *   - compact:     [pattern, end_time, n_reps, interp?, dist?]
 *                  pattern: [[xPct, y], …]   xPct ∈ [0,100]
 *                  end_time: tempo ASSOLUTO finale (non durata)
 *                  n_reps:  intero ≥ 1
 *                  interp:  'linear' | 'cubic' | 'step'
 *                  dist:    'linear' | 'exponential' | 'logarithmic' |
 *                           'geometric' | 'power'
 *                           oppure {type: ..., rate?, base?, ratio?, exponent?}
 */
(function () {
  const DISCONTINUITY_OFFSET = 1e-6;

  function isBreakpoint(item) {
    return Array.isArray(item) &&
           (item.length === 2 || (item.length === 3 && typeof item[2] === "string")) &&
           typeof item[0] === "number" && typeof item[1] === "number";
  }

  /* Il breakpoint in forma dict `{t, v, type?}`: il builder del motore lo
     normalizza in `[t, v, type?]` prima di guardarlo (envelope_builder.py:132),
     quindi e' una grafia di prima classe e una y ce l'ha.
     Sta accanto a isBreakpoint e NON dentro: isBreakpoint dice anche cosa il
     canvas dell'EnvelopeEditor sa disegnare e trascinare, e un dict il canvas
     non lo disegna — allargarla renderebbe trascinabile quel che non si vede.
     Chi invece deve solo LEGGERE un punto chiede a questa, ed e' per questo che
     sta nel modulo: i lettori sono tre (wouldEmptyEnv, che conta i punti veri;
     firstBreakpointY qui sotto, che ne legge il valore per conto di ogni
     toggle env→scalare; e bpAt, per cui camminano sui tempi il rescale del
     freeze, il troncamento e il taglio al cursore) e due copie e' il modo in
     cui una di esse smette di valere.
     Il `typeof` e' piu' stretto della presenza delle chiavi che il motore
     testa — e quella lettura resta locale a deviation-probability.js, dove la
     domanda e' se il motore costruira' il corpo, non se c'e' un numero da
     leggere. */
  function isDictBreakpoint(item) {
    return !!item && typeof item === "object" && !Array.isArray(item) &&
           typeof item.t === "number" && typeof item.v === "number";
  }

  /* ---------- typed-envelope wrapper ----------
     `{type, points}` è la forma "tipata": il `type` vale per ogni segmento
     che non ne dichiara uno sul punto, e `points` porta gli stessi item della
     lista (3-tuple e BP group compresi, #189). Helpers per unwrappare a
     items[]/interp e ri-wrappare al commit.                                 */
  function isTypedEnv(env) {
    return env && typeof env === "object" && !Array.isArray(env) &&
           Array.isArray(env.points) && typeof env.type === "string";
  }
  /* L'interp globale di una LISTA, come la legge il motore (#191). La lista
     non ha un `type`: `Envelope.__init__` lo chiede a
     `EnvelopeBuilder.extract_interp_type`, cioe' al PRIMO blocco compatto che
     ne dichiara uno nello slot 3 — o al valore stesso, se e' un compatto
     nudo. Senza nessuno, null (il chiamante ripiega su `linear`). Lo slot 3 di
     un compatto non diventa un tag dei suoi punti
     (`_expand_compact_format` tagga solo i punti del pattern che ne hanno uno
     proprio): e' una delle grafie del tipo GLOBALE, e governa i breakpoint
     nudi fuori dal blocco e i punti di ogni altro blocco. Il riconoscimento e'
     quello del motore (`_engineIsCompact`), non quello di cio' che l'editor sa
     disegnare: decide lui che cosa e' un compatto. */
  function listInterp(raw) {
    if (_engineIsCompact(raw)) return typeof raw[3] === "string" ? raw[3] : null;
    if (!Array.isArray(raw)) return null;
    for (const it of raw) if (_engineIsCompact(it) && typeof it[3] === "string") return it[3];
    return null;
  }
  /* `interp` e' il tipo globale dell'envelope come lo legge il motore: il
     `type` del dict, per la lista quello di `listInterp`. Era `linear` per
     ogni lista, quindi una lista il cui blocco dichiarava `cubic` si apriva
     lineare — i breakpoint nudi disegnati dritti mentre il motore li suonava
     cubici — e un commit con quell'interp la riscriveva lineare (#191). */
  function unwrapEnv(env) {
    if (isTypedEnv(env)) {
      return { interp: env.type || "linear", items: env.points.slice() };
    }
    // Dict con `points` ma senza `type`: l'editor la scrive solo riscrivendo
    // un dict che porta altre chiavi (`time_unit`, che wrapEnv conserva) con
    // l'interp lineare; il motore la accetta comunque —
    // `is_envelope_like` guarda solo che `points` ci sia. Va
    // letta qui, altrimenti chi la dichiara envelope a monte se la vede aprire
    // vuota, e un commit su quell'editor la svuoterebbe davvero. Il suo tipo e'
    // `linear` anche con un blocco che ne dichiara un altro: nel dict il motore
    // legge `breakpoints.get('type', 'linear')`, e lo slot 3 lo ignora.
    if (env && typeof env === "object" && !Array.isArray(env) && Array.isArray(env.points)) {
      return { interp: "linear", items: env.points.slice() };
    }
    return { interp: listInterp(env) || "linear", items: Array.isArray(env) ? env.slice() : [] };
  }
  /* L'inversa di unwrapEnv: un interp globale non lineare esce `{type, points}`,
     ANCHE con 3-tuple o BP group fra gli item (#189). Per il motore il `type`
     del dict e' il tipo di ogni segmento che non ne dichiara uno sul punto
     (`Envelope._parse_segments`: `seg_types[i] if seg_types[i] is not None
     else self.type`), e il builder legge 3-tuple e gruppi dentro `points`
     come in una lista. In una lista piatta invece un punto senza tipo e'
     `linear`: scriverla appena c'era un'eccezione sul punto — com'era — faceva
     del primo commit una riscrittura silenziosa, e dopo il commit anche il
     disegno si adeguava (unwrapEnv della lista rende `interp: linear`), quindi
     non restava neppure un segno. Il gesto piu' corto per arrivarci era
     setZoneInterp su una curva che l'editor stesso aveva scritto cubica.

     Con un blocco compatto fra gli item (#191) la lista resta solo se dice
     gia' lo stesso tipo globale: nella lista il motore lo prende dallo slot 3
     del primo blocco che ne dichiara uno (`listInterp`), quindi
     `[[pattern, 1, 4, cubic]]` e' gia' cubico e si riscrive com'e'. Se no,
     dict: `{type: cubic, points: [[0, 0], [0.2, 1], blocco]}` usciva lista
     piatta, e dal primo commit i breakpoint nudi e il blocco suonavano
     lineari. Nel dict lo slot 3 dei blocchi il motore lo ignora, e l'editor
     lo disegna ignorato (expandMixed); l'interp di UN blocco si scrive sui
     punti del suo pattern (`setBlockInterp`), che il motore legge uguale nelle
     due forme. Un dict senza chiavi in piu' non torna lista solo se il tipo e'
     lineare e la lista lo direbbe: e' la regola di sempre, il dict serve a
     portare un tipo che la lista non sa scrivere.

     `like` e' il valore da cui gli item vengono (facoltativo). Il dict non ha
     solo `type` e `points`: `time_unit` per il motore prevale sul `time_mode`
     dello stream (`create_scaled_envelope`), e ricostruire il dict con le sole
     due chiavi — o scrivere la lista, che non ne porta nessuna — la perdeva al
     primo commit, rileggendo i tempi in un'altra unita'. Con chiavi in piu' il
     dict e' quindi OBBLIGATO, con l'interp lineare e anche con un blocco fra
     gli item: le chiavi restano nel loro ordine, `points` sono gli item nuovi,
     `type` dice l'interp (e se non c'era, si aggiunge davanti a `points` solo
     quando non e' lineare). */
  function wrapEnv(items, interp, like) {
    const extra = (like && typeof like === "object" && !Array.isArray(like))
      ? Object.keys(like).filter((k) => k !== "type" && k !== "points") : [];
    const nonLinear = !!interp && interp !== "linear";
    if (extra.length) {
      const out = {};
      for (const k of Object.keys(like)) {
        if (k === "type") out.type = interp || "linear";
        else if (k === "points") {
          if (!("type" in like) && nonLinear) out.type = interp;
          out.points = items.slice();
        } else out[k] = like[k];
      }
      if (!("points" in out)) {
        if (!("type" in out) && nonLinear) out.type = interp;
        out.points = items.slice();
      }
      return out;
    }
    if (!items.some(isCompactBlock)) return nonLinear ? { type: interp, points: items.slice() } : items;
    const g = nonLinear ? interp : "linear";
    const likeDict = !!like && typeof like === "object" && !Array.isArray(like);
    if ((listInterp(items) || "linear") === g && (!likeDict || !nonLinear)) return items;
    return { type: g, points: items.slice() };
  }

  function isCompactBlock(item) {
    return Array.isArray(item) && item.length >= 3 &&
           Array.isArray(item[0]) && item[0].length > 0 &&
           Array.isArray(item[0][0]) && item[0][0].length >= 2 &&
           typeof item[1] === "number" && typeof item[2] === "number";
  }

  /* ---------- BP group [points, interp] (PGE #64 / PR #165) ----------
     L'unica lista a 2 elementi con elem[0] lista di punti ed elem[1] stringa:
     nessuna collisione con [t, v], 3-tuple per-punto o loop block (3+ elem). */
  function isBPGroup(item) {
    return Array.isArray(item) && item.length === 2 &&
           Array.isArray(item[0]) && item[0].length > 0 &&
           Array.isArray(item[0][0]) && item[0][0].length >= 2 &&
           typeof item[1] === "string";
  }

  /* ---------- le grafie NUDE: il valore E' il gruppo, o E' il blocco --------
     `[[[0,0],[1,100]], "cubic"]` e `[[[0,0],[100,1]], 4, 2]` sono envelope
     INTERI, non item dentro una lista, e il motore li legge come tali
     (envelope_builder.build: is_compact_format / is_bp_group sul raw_points
     prima di iterare). Ogni lettore di questo repo ha quindi due domande sulla
     stessa lista — "e' un envelope?" e "e' un item?" — e la prima e' questa.
     Una regola sola perche' i lettori sono tre e lontani: desugarBPGroups qui
     sotto, che le incarta per l'editor; il walk sui tempi di envelope-utils.js
     (rescale / truncate / slice), che le incarta per riusare il suo mapper; e
     wouldEmptyEnv, che sul blocco risponde senza incartare perche' la sua e'
     una domanda di conteggio. */
  function isBareEnv(env) {
    return isBPGroup(env) || isCompactBlock(env);
  }

  /* ---------- wouldEmptyEnv (PGE #209) ----------
     Un envelope resterebbe senza contenuto? Un array senza nessun breakpoint
     isolato E senza nessun blocco loop e' `[]` per il serializer, cioe' il
     primo dei corpi che il motore rifiuta da PGE #209
     (InvalidFieldValueError). Nessuna cancellazione dell'editor deve poterci
     arrivare: il guard sta qui una volta sola perche' le vie sono cinque
     (Delete su un breakpoint, Delete su un blocco, il bottone "remove loop",
     il doppio click su un breakpoint, e il paste di un envelope vuoto), e
     finche' ne restava una scoperta la riga di CLAUDE.md che dichiara
     l'editor incapace di produrre quei corpi era falsa.

     Vive qui e non nel componente (#140) per la ragione dei suoi tre vicini:
     e' pura, decide al posto della colla React, e i suoi due falsi positivi
     storici si vedono solo eseguendola. Sta accanto a isBreakpoint /
     isDictBreakpoint / isCompactBlock perche' la sua risposta E' la loro
     somma: un predicato che cambia qui cambia il guard nello stesso file,
     invece che in un componente che nessun test carica.

     Riceve gli ITEM: la forma desugarata, e non quella wrappata. Su un BP
     group nudo (`[[[0,0],[0.5,50],[1,100]], "cubic"]`, PGE #64) direbbe
     `true` su un envelope pieno, perche' ne' isBreakpoint ne' isCompactBlock
     riconoscono il gruppo — quello lo normalizza desugarBPGroups, che ogni
     chiamante applica. E chi ha in mano una forma wrappata deve prima passare
     da `unwrapEnv`, non da desugarBPGroups: `wrapEnv` restituisce il dict
     {type, points} per un envelope di soli breakpoint con interp globale non
     lineare, desugarBPGroups su un non-array lo lascia intatto, e qui un
     non-array e' "vuoto". Era il difetto del paste (`handlePasteEnv`), che
     valutava l'output di wrapEnv e rifiutava in silenzio ogni envelope
     tipizzato.

     Due contenuti che il conteggio non vedeva da se', ed erano falsi positivi:
       - il blocco compatto NUDO (`[[[0,0],[100,1]],1,4]`), dove il valore E'
         il blocco invece di contenerlo. Qui si risponde senza incartarlo,
         perche' la domanda e' di conteggio e un blocco vale gia' uno; chi
         invece deve INDICIZZARE gli item passa da desugarBPGroups, che
         incarta le due grafie nude allo stesso modo (isBareEnv).
       - il breakpoint in forma dict `{t, v, type?}`, che il motore normalizza
         in `[t, v]` prima di guardarlo (envelope_builder.py:132).
         isBreakpoint non va allargata — la usa l'editor per decidere cosa e'
         trascinabile, e un dict il canvas non lo disegna — quindi il predicato
         e' il suo vicino di casa, isDictBreakpoint, condiviso con chi la y di
         quel punto la legge (loopSeedFrom, Inspector). */
  function wouldEmptyEnv(next) {
    if (isCompactBlock(next)) return false;   // il valore E' il blocco
    if (!Array.isArray(next)) return true;
    // Il dict `{t, v}` e' un punto vero, e lo dice il predicato accanto — lo
    // stesso che risponde a firstBreakpointY, che di quel punto legge la y.
    const bps   = next.filter((it) => isBreakpoint(it) || isDictBreakpoint(it)).length;
    const loops = next.filter(isCompactBlock).length;
    return bps + loops < 1;
  }

  function envHasLoop(env) {
    const items = isTypedEnv(env) ? env.points : env;
    return Array.isArray(items) && items.some(isCompactBlock);
  }

  function envHasGroup(env) {
    if (isBPGroup(env)) return true; // forma diretta [points, interp]
    const items = isTypedEnv(env) ? env.points : env;
    return Array.isArray(items) && items.some(isBPGroup);
  }

  /* ---------- desugar / resugar dei BP group ----------
     Il motore desugara il gruppo sui breakpoint 3-tuple della per-point interp
     (#54): l'interp di zona diventa il type esplicito dei punti interni,
     l'ultimo punto resta com'è (il suo type governa il gap in uscita).
     L'editor lavora sulla forma piatta (indici stabili) e ricompatta al commit.

     desugar:  [[pts, 'cubic'], …] → [t, v, 'cubic'] per i punti interni
     resugar:  le zone del valore da cui gli item vengono (`like`) tornano
               zone (_carryGroupSpans); fuori da quelle, un run di BP
               consecutivi i cui segmenti interni hanno tutti lo stesso type
               effettivo T ≠ default globale torna [points, T] — se non
               comincia su un salto ed e' in ordine; altrimenti resta piatto
               (i tag == default vengono normalizzati via, come fa il
               context-menu per-segmento). Il ciclo desugar∘resugar è
               idempotente sugli indici.

     Zona o punti nudi, per il motore, non sono solo grafia: sul bordo di un
     salto la lettura cambia. Il primo punto di un gruppo che cade
     sull'istante del punto prima — o prima ancora — il builder lo sposta a
     quell'istante piu' DISCONTINUITY_OFFSET (`_expand_bp_group`); un punto
     nudo li' resta dov'e', e due punti sullo stesso istante sono un salto
     largo zero. Con `cubic` cambia la forma, non solo il microsecondo: le
     tangenti di Fritsch-Carlson vedono il microsecondo come una pendenza
     enorme, e la curva riparte dal salto col doppio della pendenza della
     corda; sul salto largo zero quella pendenza vale 0 e la curva riparte
     piatta. Il resugar decideva la grafia dai soli tag, quindi il primo commit
     qualunque su quell'inviluppo la scambiava nelle due direzioni: la zona sul
     salto, fra punti nudi, si appiattiva; i punti nudi taggati dopo un blocco
     diventavano una zona. -0.29 e +0.29 su una zona cubica da 2 a 3. */
  function desugarBPGroups(items) {
    // Forma diretta: il valore E' il gruppo, oppure E' il blocco (isBareEnv).
    // Il blocco mancava, e non si vedeva da nessuna parte tranne l'unico posto
    // che conta: `unwrapEnv` di un blocco nudo rende i suoi TRE elementi
    // (pattern, end_time, n_reps), qui nessuno dei tre e' un item, e
    // l'EnvelopeEditor ci costruisce sopra `rawEnv` e `expandMixed`. Risultato:
    // canvas vuoto su un envelope pieno — 26 stream nel corpus del motore — e
    // il primo doppio click ci appendeva un breakpoint, cioe' scriveva
    // `[pattern, end, n_reps, [x, y]]`, che il motore non legge piu' come
    // compatto (item[3] non e' una stringa) e da cui salva il solo breakpoint:
    // il blocco sparito in silenzio. Incartarlo qui e' la stessa riga che il
    // gruppo aveva gia', e tiene allineati gli indici di rawEnv con gli
    // `originalIdx` di expandMixed, che e' l'invariante dell'editor.
    if (isBareEnv(items)) items = [items];
    if (!Array.isArray(items)) return items;
    const out = [];
    for (const it of items) {
      if (isBPGroup(it)) {
        const pts = it[0], g = it[1];
        pts.forEach((p, i) => {
          if (i < pts.length - 1) {
            out.push([p[0], p[1], typeof p[2] === "string" ? p[2] : g]);
          } else {
            out.push(p.length >= 3 && typeof p[2] === "string" ? [p[0], p[1], p[2]] : [p[0], p[1]]);
          }
        });
      } else {
        out.push(it);
      }
    }
    return out;
  }

  /* Le zone di un valore sugli indici della sua forma piatta: dove comincia e
     dove finisce ogni BP group dopo desugarBPGroups, e il suo interp. */
  function _groupSpans(items) {
    if (isBareEnv(items)) items = [items];
    const spans = [];
    if (!Array.isArray(items)) return spans;
    let k = 0;
    for (const it of items) {
      if (isBPGroup(it)) {
        spans.push({ start: k, end: k + it[0].length - 1, interp: it[1] });
        k += it[0].length;
      } else {
        k += 1;
      }
    }
    return spans;
  }

  /* Le zone di `like` — il valore da cui gli item vengono — riportate sugli
     item nuovi. Un gesto dell'editor cambia un item, ne aggiunge uno o ne
     toglie uno: a parita' di lunghezza gli indici sono gli stessi; altrimenti
     il cambio sta fra il prefisso e il suffisso che le due forme piatte hanno
     in comune. Un punto aggiunto dentro una zona la allunga, uno tolto la
     accorcia. Tolto l'ultimo, il nuovo ultimo perde il tipo della zona che il
     desugar gli aveva scritto (`untag`): sull'ultimo punto quel tag
     governerebbe il gap in uscita, che nello YAML di prima — col solo punto
     tolto — e' globale. Cio' che non si sa riportare, o che resta con meno di
     due punti o con un item che non e' un breakpoint, torna all'inferenza. */
  function _carryGroupSpans(items, like) {
    const w = unwrapEnv(like);
    const spans = _groupSpans(w.items).filter((sp) => sp.end > sp.start);
    const untag = [];
    if (!spans.length) return { spans, untag };
    const base = desugarBPGroups(w.items);
    const lb = base.length, ln = items.length;
    let carried = spans;
    if (lb !== ln) {
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      let p = 0;
      while (p < lb && p < ln && same(base[p], items[p])) p++;
      let s = 0;
      while (s < lb - p && s < ln - p && same(base[lb - 1 - s], items[ln - 1 - s])) s++;
      const removed = lb - s - p, added = ln - s - p;
      carried = [];
      for (const sp of spans) {
        if (sp.end < p) carried.push(sp);
        else if (sp.start >= lb - s) carried.push({ ...sp, start: sp.start + ln - lb, end: sp.end + ln - lb });
        else if (removed === 0 && added === 1) carried.push({ ...sp, end: sp.end + 1 });
        else if (removed === 1 && added === 0) {
          if (p === sp.end) untag.push({ index: p - 1, interp: sp.interp });
          carried.push({ ...sp, end: sp.end - 1 });
        }
      }
    }
    const ok = (sp) => {
      if (sp.start < 0 || sp.end >= ln || sp.end <= sp.start) return false;
      for (let k = sp.start; k <= sp.end; k++) if (!isBreakpoint(items[k])) return false;
      return true;
    };
    return { spans: carried.filter(ok), untag };
  }

  /* Una zona riportata, riscritta come gruppo. Il suo interp e' il tipo dei
     segmenti interni se e' uno solo — tutti portati a step, la zona e' step —
     se no quello che aveva; un segmento che ne dice un altro diventa
     un'eccezione sul punto, anche se e' il tipo globale: dentro un gruppo un
     punto nudo e' del gruppo, non del globale. L'ultimo punto resta come
     scritto, perche' il suo tag governa il gap in uscita. */
  function _spanGroup(pts, interp, g) {
    const effs = pts.slice(0, -1).map((p) => typeof p[2] === "string" ? p[2] : g);
    const T = effs.every((t) => t === effs[0]) ? effs[0] : interp;
    const body = pts.map((p, i) => {
      if (i === pts.length - 1) return typeof p[2] === "string" ? [p[0], p[1], p[2]] : [p[0], p[1]];
      return effs[i] === T ? [p[0], p[1]] : [p[0], p[1], effs[i]];
    });
    return [body, T];
  }

  function resugarBPGroups(items, globalDefault, like) {
    if (!Array.isArray(items)) return items;
    const g = globalDefault || "linear";
    const { spans, untag } = like == null ? { spans: [], untag: [] } : _carryGroupSpans(items, like);
    if (untag.length) {
      items = items.slice();
      for (const u of untag) {
        const p = items[u.index];
        if (isBreakpoint(p) && p[2] === u.interp) items[u.index] = [p[0], p[1]];
      }
    }
    /* Un tag uguale al globale e' ridondante solo se l'inviluppo ha comunque
       un tipo sul punto. Con anche uno solo il motore costruisce un segmento
       per coppia, senza nessuno un segmento solo (`_parse_segments`:
       has_per_point_type), e sull'istante esatto di un salto — due punti
       sullo stesso istante — i due leggono l'altro punto: con step quello
       all'inizio e quelli in mezzo, con linear e cubic quello in fondo. A
       t = 0 cade il primo grano. Lo danno una zona (i suoi punti interni hanno sempre il tipo), un tag
       diverso dal globale, un punto {t, v, type}, un punto del pattern di un
       blocco col suo tag. */
    const keepsPerPoint = spans.length > 0 || items.some((it) =>
      (isBreakpoint(it) && typeof it[2] === "string" && it[2] !== g) ||
      isBPGroup(it) ||
      (isDictBreakpoint(it) && typeof it.type === "string") ||
      (isCompactBlock(it) && it[0].some((p) => Array.isArray(p) && typeof p[2] === "string")));
    const spanAt = new Map(spans.map((sp) => [sp.start, sp]));
    const out = [];
    /* Lo stato di EnvelopeBuilder.parse mentre legge quello che si scrive:
       `cur` e' il suo current_time — il massimo per i punti, l'ULTIMO punto per
       un gruppo, l'ultimo punto espanso per un blocco — e `seen` il suo
       has_preceding. Servono a sapere se una zona nuova cadrebbe su un salto. */
    let cur = 0, seen = false;
    function emit(it) {
      out.push(it);
      if (isBreakpoint(it)) { if (it[0] > cur) cur = it[0]; seen = true; }
      else if (isDictBreakpoint(it)) { if (it.t > cur) cur = it.t; seen = true; }
      else if (isBPGroup(it)) { const last = it[0][it[0].length - 1]; if (last[0] > cur) cur = last[0]; seen = true; }
      else if (isCompactBlock(it)) { cur = _compactLastTime(it, cur); seen = true; }
    }
    let run = [];
    function flushRun() {
      if (!run.length) return;
      /* Una zona nuova solo dove si legge come i suoi punti nudi: non sul
         bordo di un salto, che le darebbe il microsecondo, e non fuori ordine,
         dove il builder porterebbe avanti l'ultimo punto invece del massimo e
         sposterebbe cio' che segue. */
      const inOrder = run.every((p, i) => i === 0 || p[0] >= run[i - 1][0]);
      if (run.length >= 2 && inOrder && !(seen && run[0][0] <= cur)) {
        const effs = run.slice(0, -1).map((p) => typeof p[2] === "string" ? p[2] : g);
        const T = effs.every((t) => t === effs[0]) ? effs[0] : null;
        if (T && T !== g) {
          const pts = run.map((p, i) => {
            if (i === run.length - 1) return typeof p[2] === "string" ? [p[0], p[1], p[2]] : [p[0], p[1]];
            return [p[0], p[1]]; // tag interno == T → assorbito dal gruppo
          });
          emit([pts, T]);
          run = [];
          return;
        }
      }
      // run piatto — normalizza via i tag ridondanti (== default globale),
      // finche' l'inviluppo resta con un tipo sul punto (keepsPerPoint)
      run.forEach((p) => emit(keepsPerPoint && typeof p[2] === "string" && p[2] === g ? [p[0], p[1]] : p));
      run = [];
    }
    for (let i = 0; i < items.length; i++) {
      const sp = spanAt.get(i);
      if (sp) {
        flushRun();
        emit(_spanGroup(items.slice(sp.start, sp.end + 1), sp.interp, g));
        i = sp.end;
        continue;
      }
      const it = items[i];
      if (isBreakpoint(it)) run.push(it);
      else { flushRun(); emit(it); }
    }
    flushRun();
    return out;
  }

  /* La y del PRIMO breakpoint di un envelope, qualunque grafia abbia.
     È la domanda che si fa ogni volta che una curva viene sostituita da uno
     scalare — il toggle env→scalare dell'Inspector, la conversione
     loop_end ↔ loop_dur — e la risposta non può essere `env[0][1]`:
       · una curva di soli BP con interp globale non lineare l'editor stesso la
         SCRIVE `{type, points}` (wrapEnv), e lì `env[0]` non esiste;
       · un BP group come primo item è `[points, interp]`, dove `[1]` è la
         STRINGA dell'interp — scritta tale e quale come valore del parametro;
       · un blocco compatto ha in `[1]` il suo END_TIME — il tempo assoluto
         finale, si veda l'intestazione del modulo — e nella forma diretta
         `param: [pattern, end, n_reps]` ha in `[1]` l'end_time ancora, mentre
         `[0]` e' il pattern: numeri che con il valore del parametro non
         c'entrano niente, e truthy entrambi, quindi un `|| default` li lascia
         passare. Il ratio della distribuzione sta altrove (dentro `dist`, in
         `[4]`): non e' mai lui il numero che finiva nello YAML.
     Si desugara quindi dopo aver unwrappato, e si chiede ai due predicati del
     modulo — le grafie di un punto sono due, `[t, v]` e `{t, v}` — così ogni
     forma che una y ce l'ha la dichiara. Ripiega solo su ciò che una y non ce
     l'ha davvero (blocco compatto, envelope vuoto o illeggibile), e il ripiego
     lo decide il chiamante: è il default del suo parametro, che il modulo non
     conosce.
     Il ritorno è il valore LETTO, zero compreso: un `|| default` non distingue
     la curva che vale zero da quella che non si sa leggere, ed è così che uno
     zero legittimo diventava una costante che la curva non aveva mai avuto. */
  function firstBreakpointY(env, fallback) {
    const bp = bpAt(desugarBPGroups(unwrapEnv(env).items)[0]);
    return bp ? bp[1] : fallback;
  }

  /* ---------- le due grafie di un punto, lette e riscritte come sono --------
     `bpAt` torna [x, y, interp|null] per l'una e per l'altra — null se l'item
     non e' un punto — e `bpAtX` / `bpMake` le riscrivono NELLA GRAFIA trovata.
     Serve a chi cammina sull'asse dei TEMPI (il rescale del freeze, il
     troncamento, il taglio al cursore): li' il dict `{t, v}` era invisibile,
     quindi quella curva restava nel vecchio riferimento temporale mentre ogni
     altra si spostava. Convertirla in `[t, v]` per farla vedere al walk
     sarebbe la cura peggiore del male: migrerebbe la grafia dell'autore a
     ogni resize, e il walk sulle y (envelope-utils._mapGrainEnvY) la rispetta
     da PGE #234.
     `bpMake` costruisce i due y che il taglio CALCOLA invece di sceglierli —
     la chiusura del truncate, l'apertura dello slice — nella grafia del punto
     accanto, perche' un envelope non diventi meta' dict e meta' array per un
     ridimensionamento. */
  function bpAt(item) {
    if (isBreakpoint(item))
      return [item[0], item[1], typeof item[2] === "string" ? item[2] : null];
    if (isDictBreakpoint(item))
      return [item.t, item.v, typeof item.type === "string" ? item.type : null];
    return null;
  }
  function bpAtX(item, x) {
    if (isDictBreakpoint(item)) return { ...item, t: x };
    const c = [...item]; c[0] = x; return c;
  }
  function bpMake(like, x, y, interp) {
    if (isDictBreakpoint(like))
      return interp ? { t: x, v: y, type: interp } : { t: x, v: y };
    return interp ? [x, y, interp] : [x, y];
  }

  /* ---------- distribuzioni temporali (time_distribution.py) ---------- */

  // Registro chiuso del motore (TimeDistributionFactory._DISTRIBUTIONS), alias
  // compresi, con il vincolo che ciascun costruttore applica al proprio
  // parametro. `power.exponent` chiede solo un numero: qualunque reale è un
  // esponente legittimo.
  const TIME_DIST_SPECS = {
    linear:      {},
    exponential: { rate: v => v > 0 },
    exp:         { rate: v => v > 0 },
    logarithmic: { base: v => v > 1 },
    log:         { base: v => v > 1 },
    geometric:   { ratio: v => v > 0 },
    geo:         { ratio: v => v > 0 },
    power:       { exponent: v => true },
  };
  const TIME_DIST_NAMES = Object.keys(TIME_DIST_SPECS);

  // Mirror delle validazioni che il motore fa costruendo la distribuzione
  // (PGE #208). Serve perché senza di esso l'anteprima disegna una curva
  // plausibile per uno YAML che non renderizza: un nome ignoto ripiega su
  // `linear` e sembra corretto, `{base: 1}` produce durate NaN e non lo dice.
  //
  // Ritorna null se valida, altrimenti { kind, name?, param? } —
  //   "name"     → il nome non è nel registro
  //   "param"    → il parametro esiste ma è fuori dal bound del costruttore, o è
  //                estraneo al tipo (il costruttore lo rifiuterebbe come kwarg
  //                inatteso).
  //   "overflow" → parametro e n_reps sono entrambi legittimi da soli, ma il
  //                conto che la distribuzione fa con quella coppia non dà un
  //                numero finito — e il conto è la SOMMA dei pesi, non solo il
  //                più grande, da quando il motore guarda quella (PGE #293;
  //                vedi _overflowError). Riportato solo se `nReps` è noto.
  //                Puro, node-testabile.
  function timeDistError(dist, nReps) {
    if (dist == null) return null;
    if (typeof dist !== "string" && typeof dist !== "object") return { kind: "name" };
    // `spec.get('type', 'linear')`: il default vale solo per la chiave ASSENTE.
    // `{type: null}` la chiave ce l'ha, e None non e' un nome — il motore lo
    // rifiuta (AttributeError prima di PGE #211, InvalidFieldValueError dopo).
    // Leggerlo `!= null` lo faceva `linear`, cioe' valido.
    const rawName = typeof dist === "string" ? dist : (dist.type !== undefined ? dist.type : "linear");
    if (typeof rawName !== "string") return { kind: "name" };
    const name = rawName.toLowerCase();
    if (!TIME_DIST_NAMES.includes(name)) return { kind: "name", name: rawName };

    if (typeof dist === "object") {
      const ammessi = TIME_DIST_SPECS[name];
      for (const k of Object.keys(dist)) {
        if (k === "type") continue;
        const num = typeof dist[k] === "number" && isFinite(dist[k]);
        if (!(k in ammessi) || !num || !ammessi[k](dist[k]))
          return { kind: "param", name, param: k };
      }
    }
    // Anche la forma stringa entra qui: i default del costruttore sono quelli
    // del motore, e con abbastanza cicli traboccano pure loro.
    return _overflowError(name, (typeof dist === "object" && dist) ? dist : {}, nReps);
  }

  // L'ordine di grandezza oltre cui un float non c'è più.
  const LOG10_MAX = Math.log10(Number.MAX_VALUE); // ≈ 308.25

  /* Mirror dell'overflow che il motore intercetta costruendo i pesi dei cicli
     (PGE #212, review #216). Non è un bound su un valore e non poteva esserlo:
     `ratio: 10` e `n_reps: 400` sono legittimi da soli, e il costruttore che
     riceve il primo non vede il secondo — è la coppia a esplodere. In JS non
     c'è OverflowError: la potenza diventa Infinity e le durate NaN o zero, così
     il blocco veniva disegnato collassato senza che niente lo dicesse.

     Il conto si fa sui logaritmi, mai sulla potenza: calcolarla per scoprire
     che trabocca darebbe Infinity e basta.

     Un caso resta fuori, e per una differenza che questo lato non può vedere:
     in `power` il motore trabocca solo se l'esponente è un float, perché con un
     intero Python calcola su interi illimitati e la divisione successiva torna
     buona. Ma `200` e `200.0` in YAML arrivano qui come lo stesso Number, e
     `Number.isInteger` non li distingue. Segnaliamo quindi solo l'esponente
     frazionario: chi scrive `exponent: 200.0` con troppi cicli vede l'errore
     del motore, non l'avviso — un avviso in meno, mai uno di troppo.

     La stessa ambiguità int/float c'è in `geometric` e in `exponential`, ma lì
     non si può scegliere allo stesso modo: la potenza sta dentro
     un'espressione, e la soglia intera e quella float distano un n_reps. Il
     conto qui modella il quoziente `(1 - r**N)/(1 - r)`, cioè la semantica
     INTERA, che è la più permissiva delle due: `ratio: 10` con `n_reps: 309`
     rende davvero, e adottare la soglia float lo segnalerebbe per sbaglio.
     Il prezzo è una banda di un valore dove il float trabocca e noi taciamo —
     `ratio: 10.0` a 309, `ratio: 2` a 1024 — sempre nella direzione
     dichiarata sicura. I bordi sono fissati nei test.

     Da PGE #293 (#219) il motore non guarda più solo la potenza: in
     `exponential` e in `power` controlla anche la SOMMA dei pesi
     (`TimeDistributionStrategy._normalize`), che trabocca prima del peso più
     grande — tanto prima quanto più `rate` è vicino a 1 o l'esponente è
     moderato: a `rate: 0.9` il peso trabocca a 6738 cicli e la somma a 6716,
     a `exponent: 60.5` a 124486 contro 109992. Qui si guarda quindi la somma.
     In `exponential` la somma ha una forma chiusa; in `power` no, e se ne
     prende un MINORANTE — mai un valore più alto del vero, così l'avviso non
     esce mai su uno YAML che rende. `rate: 0.5` resta l'unica banda di
     quella distribuzione, e non per la semantica intera (con rate < 1 i pesi
     sono sempre float): la somma vale 2**1024 - 1, `1024 * log10(2)` è
     esattamente LOG10_MAX, e la disuguaglianza stretta tace sul pareggio che
     il motore, sommando davvero, fa traboccare. */
  function _overflowError(name, p, nReps) {
    const N = +nReps;
    if (!isFinite(N) || N < 1) return null;
    const mk = (param, value) => ({ kind: "overflow", name, param, value, nReps: N });

    if (name === "geometric" || name === "geo") {
      const r = p.ratio != null ? +p.ratio : 1.5;
      // ratio ≈ 1 → il motore devia su linear prima di elevare; ratio < 1 → la
      // potenza tende a zero. Trabocca solo la crescita.
      if (!(r > 1) || Math.abs(r - 1) < 1e-6) return null;
      // sum_geometric = (1 - ratio**N) / (1 - ratio)
      const mag = N * Math.log10(r) - Math.log10(Math.abs(1 - r));
      return mag > LOG10_MAX ? mk("ratio", r) : null;
    }
    if (name === "exponential" || name === "exp") {
      const rate = p.rate != null ? +p.rate : 2.0;
      // weights[i] = rate ** -i: crescono solo se rate < 1. La somma, che il
      // motore controlla (PGE #293), e' geometrica di ragione q = 1/rate:
      // (q**N - 1) / (q - 1), in logaritmi. Contiene il peso piu' grande,
      // quindi trabocca prima di lui o insieme.
      // log10(q) si scrive -log10(rate), senza calcolare q: con un rate
      // subnormale 1/rate e' Infinity, e a n_reps 1 — un peso solo, che vale 1
      // — si segnalerebbe un overflow che il motore non ha.
      if (!(rate > 0) || rate >= 1) return null;
      const lq = -Math.log10(rate);
      const mag = N * lq + Math.log10(1 - Math.pow(rate, N))
                - (Math.log10(1 - rate) + lq);                 // log10(q - 1)
      return mag > LOG10_MAX ? mk("rate", rate) : null;
    }
    if (name === "power") {
      const e = p.exponent != null ? +p.exponent : 2.0;
      // weights[i] = (i+1) ** exponent: il massimo è N ** exponent.
      // `!isFinite(e)` non è raggiungibile dall'unico call site (i parametri
      // non finiti escono già come kind "param" nel loop qui sopra); resta
      // perché questa funzione dichiara di lavorare sui numeri che riceve, e
      // un secondo chiamante che saltasse quel controllo non deve poter
      // ottenere un `mag` NaN letto come "non trabocca".
      if (!isFinite(e) || e <= 0 || Number.isInteger(e)) return null;
      // La somma (PGE #293) non ha forma chiusa: se ne prende un minorante.
      // Per pesi crescenti sum(i**e, 1..N) >= integrale di x**e su [0, N] =
      // N**(e+1)/(e+1); con e >= 1 la funzione e' convessa, i trapezi stanno
      // sopra l'integrale e si guadagna N**e / 2. E la somma contiene il peso
      // piu' grande, N**e: il minorante e' il massimo fra i due.
      const c = e >= 1 ? 0.5 : 0;
      const mag = e * Math.log10(N) + Math.log10(Math.max(1, N / (e + 1) + c));
      return mag > LOG10_MAX ? mk("exponent", e) : null;
    }
    return null; // linear e logarithmic non elevano niente a potenza
  }

  /* Cosa si è misurato, nelle parole del motore (PGE #293, #219).

     L'hint del motore diceva «il risultato non sta in un float», e il
     messaggio del pannello lo ripeteva — parola per parola, perché l'avviso e
     l'errore del render sono lo stesso guasto detto due volte a un lettore
     solo. Non lo dice più: da quando la guardia sulla somma prende
     anche le somme `nan` (un parametro `.nan`/`.inf`, che nessun bound
     rifiuta) quella frase era falsa di metà dei casi — un `nan` in un float ci
     sta benissimo — e il motore dice ora ciò che ha misurato. Questo lato
     deve dirlo con le stesse parole: chi legge l'avviso nell'editor e poi
     l'errore del render fallito deve riconoscere lo stesso guasto, e non due.

     La frase sta qui, e non dentro la stringa del pannello, perché è testo del
     motore: `test-time-dist-parity.js` la chiede all'hint vero, come già fa
     per ogni altra costante che questo repo rispecchia. Lo stesso vale per
     TIME_DIST_OVERFLOW_FIX qui sotto, che è l'altra metà della stessa frase
     (`_RIMEDI_OVERFLOW` nel motore) e fino a quel patto era una trascrizione
     verificata solo contro se stessa. */
  const TIME_DIST_OVERFLOW_WHY = "il risultato non è un numero finito";

  // Il rimedio dipende dal parametro, non dalla distribuzione (PGE #216):
  // `ratio` e `rate` sono fattori di una progressione, e verso 1 la
  // progressione si appiattisce; `exponent` è una scala, dove 1 è un valore
  // ordinario ed è l'ordine di grandezza a essere fuori misura.
  const TIME_DIST_OVERFLOW_FIX = {
    ratio:    "avvicina ratio a 1",
    rate:     "avvicina rate a 1",
    exponent: "riduci exponent in valore assoluto",
  };

  /* vincolo invariante: sum(cycleDurs) === T
     Su una spec non valida si RIPIEGA su linear per poter comunque disegnare
     qualcosa, ma il fallback non è più muto: `timeDistError` dice che quello
     YAML non renderizza, e `expandMixed` lo riporta sul blocco. Prima il
     ripiegamento era indistinguibile da un `linear` scritto davvero — e per
     `{base: 1}` / `{exponent: 'x'}` non ripiegava affatto, produceva durate
     NaN che nessuno segnalava. */
  function computeCycleDurations(T, N, dist) {
    const uniform = () => new Array(N).fill(T / N);
    if (T <= 0 || N < 1) return [];
    const type = timeDistError(dist, N)
      ? "linear"
      : (typeof dist === "string" ? dist : (dist && dist.type) || "linear");
    const p    = (typeof dist === "object" && dist) ? dist : {};

    if (type === "linear") return uniform();

    if (type === "exponential" || type === "exp") {
      const rate = p.rate != null ? +p.rate : 2.0;
      const w = []; let sum = 0;
      for (let i = 0; i < N; i++) { const x = Math.pow(rate, -i); w.push(x); sum += x; }
      return guard(w.map(x => x / sum * T));
    }
    if (type === "logarithmic" || type === "log") {
      const base = p.base != null ? +p.base : 2.0;
      const w = []; let sum = 0;
      for (let i = 0; i < N; i++) { const x = Math.log(i + 1) / Math.log(base) + 1; w.push(x); sum += x; }
      return guard(w.map(x => x / sum * T));
    }
    if (type === "geometric" || type === "geo") {
      const r = p.ratio != null ? +p.ratio : 1.5;
      // 1e-6, la stessa soglia del motore (time_distribution.py: `abs(ratio -
      // 1.0) < 1e-6` -> LinearDistribution), non 1e-9. Nella finestra fra le
      // due il motore ripiegava su cicli uguali e qui il conto si faceva
      // davvero: `1 - Math.pow(r, N)` con r a un miliardesimo da 1 e' pura
      // cancellazione catastrofica, la somma non torna, e la guardia
      // sull'output segnalava un'anteprima che era invece esatta. Nessun
      // overflow di mezzo — allineare la soglia toglie il caso, allargare il
      // testo del warn lo avrebbe solo raccontato meglio.
      // `exponential` e `logarithmic` non hanno un ripiego lineare nel motore:
      // qui non c'e' niente da allineare.
      if (Math.abs(r - 1) < 1e-6) return uniform();
      const d0 = T * (1 - r) / (1 - Math.pow(r, N));
      return guard(new Array(N).fill(0).map((_, i) => d0 * Math.pow(r, i)));
    }
    if (type === "power") {
      const e = p.exponent != null ? +p.exponent : 2.0;
      const w = []; let sum = 0;
      for (let i = 0; i < N; i++) { const x = Math.pow(i + 1, e); w.push(x); sum += x; }
      return guard(w.map(x => x / sum * T));
    }
    return uniform();

    /* Ultima rete, sull'OUTPUT invece che sulla spec. `timeDistError` sa dire
       quali coppie (parametro, n_reps) il MOTORE rifiuta, e su quelle ripiega
       già; ma qui `Math.pow` trabocca anche dove il motore no — con un
       esponente o un ratio interi Python calcola su interi illimitati e
       renderizza, mentre di qua uscivano durate NaN o tutte zero, disegnate
       senza dire niente. Enumerare quei casi vorrebbe dire replicare la
       distinzione int/float che il JS non vede; guardare cosa è uscito la
       copre tutta: se le durate non sono finite, o non sommano a T, il disegno
       torna a cicli uguali — lo stesso ripiego dell'altro ramo.

       Ma qui il ripiego non può essere muto: cicli uguali sono un'anteprima
       plausibile e sbagliata — peggio delle NaN di prima, che almeno erano
       rotte a vista. Il ripiego marca quindi l'array con `previewFallback`,
       che `expandMixed` porta sul blocco e il pannello traduce in un messaggio
       suo, diverso da quello dell'overflow. Il flag nasce dalla guardia, cioè
       esattamente dove il conto JS ha fallito: nessuna soglia in più da tenere
       allineata al motore.

       Quello che il flag NON dice è cosa farà il motore, e il messaggio del
       pannello non lo afferma: la guardia scatta dove `Math.pow` non arriva, e
       lì il motore a volte rende, a volte rifiuta — e in questo paragrafo la
       grafia conta a ogni riga. Rende con `{power, exponent: 1000}` su 4 cicli
       (il 100% del tempo nell'ultimo), ma in grafia INTERA: `1000.0` sulla
       stessa coppia alza. Rende anche dentro la banda int/float che
       `timeDistError` lascia passare di proposito: `{geometric, ratio: 10}` a
       309 cicli, in grafia intera, somma 2.0 esatta, mentre `10.0` alza — è
       l'unico esempio in cui il motore distingue davvero le due tipizzazioni,
       ed è la coppia che il commento alla soglia, poco più su, cita come
       ragione per non adottare quella float.

       Rifiuta invece `{geometric, ratio: 2}` a 1024, e lì le tipizzazioni non
       le distingue affatto: alza in entrambe. Rifiuta anche
       `{exponential, rate: 0.5}` a 1025, che di grafie ne ha una sola — un
       rate fra 0 e 1 è float per costruzione — e il cui meccanismo non è
       int/float ma `rate < 1`: i pesi sono `rate ** -i`, e `0.5 ** -1024` è
       `2^1024`, che trabocca, mentre `2 ** -i` in Python è già float e degrada
       a subnormale (`{exponential, rate: 2}` a 1025 rende, in entrambe le
       grafie). Le due condizioni non coincidono e non possono: distinguerle
       vorrebbe dire replicare la semantica intera di Python, che è esattamente
       ciò che questa rete evita di fare. */
    function guard(durs) {
      const sum = durs.reduce((a, b) => a + b, 0);
      const ok = durs.every(d => isFinite(d) && d >= 0) &&
                 isFinite(sum) && Math.abs(sum - T) <= 1e-9 * Math.max(1, Math.abs(T));
      return ok ? durs : _markPreviewFallback(uniform());
    }
  }

  /* Marca un array di durate come ripiego dell'anteprima. Non enumerabile:
     JSON, spread e Object.keys non lo vedono, così nessun confronto esistente
     sulle durate cambia significato. Si legge con `isPreviewFallback`. */
  function _markPreviewFallback(durs) {
    Object.defineProperty(durs, "previewFallback", { value: true, enumerable: false });
    return durs;
  }
  function isPreviewFallback(durs) {
    return !!(durs && durs.previewFallback);
  }

  /* ---------- la forma di un envelope: i guard di EnvelopeBuilder (PGE #211, #180) ----------
     Da PGE #211 i guard di forma stanno nel builder del motore e valgono per
     OGNI chiave, e tre scritture che il motore rendeva in silenzio sono
     diventate errori che fermano il render: una `x` del pattern di un compatto
     fuori da [0, 100] o che torna indietro, `n_reps`/`end_time` booleani
     (`range(True)` rendeva un ciclo, `true` valeva 1.0 come istante) e una `y`
     booleana nel pattern. L'editor non li scrive — i drag del pattern restano
     fra i vicini e in [0, 100] — ma il tab Raw si', e prima nessuno lo diceva
     prima del render. `timeDistError` qui sopra era lo specchio di UNO slot;
     questo e' quello del blocco intero, e lo chiama per il suo.

     Ripercorre `EnvelopeBuilder.parse` passo per passo, e il motivo e' l'ordine:
     il motore si ferma al primo guard, e il primo errore e' quello che conta.
       · la forma diretta: il valore E' un compatto (inizio 0), o E' un gruppo;
       · altrimenti la lista, elemento per elemento: un dict `{t, v, type?}`
         diventa `[t, v, type?]`, poi compatto → gruppo → 3-tuple → `[t, v]`,
         e ogni altra cosa e' un elemento non riconosciuto;
       · dentro il compatto: n_reps, end_time (tipo, poi oltre l'inizio),
         pattern vuoto, i punti uno a uno (piatti, x in [0, 100], x non
         decrescente — una x ripetuta e' la discontinuita' e va bene), infine
         la distribuzione (timeDistError, overflow compreso).
     Il riconoscimento e' quello del motore, `is_compact_format` /
     `is_bp_group`, e NON isCompactBlock / isBPGroup: quelle dicono cosa
     l'editor sa disegnare, e sono piu' strette. `[pattern, 1, true]` per
     isCompactBlock non e' un blocco — non lo disegna — ma per il motore si', e
     l'errore giusto e' su `n_reps`, non «elemento sconosciuto».

     Il campo dell'errore e' la sotto-posizione del motore senza `envelope.`
     davanti (`where`: "compact.n_reps", "group.points", "point", …): e' cio'
     che il builder nomina quando nessuno gli passa la chiave YAML, e la
     parita' lo confronta una per una (test-envelope-shape-parity.js). La
     chiave YAML la aggiunge chi la sa, cioe' chi chiama.

     Fuori scope, e detto: cio' che il motore rifiuta FUORI dal builder — un
     interp per-punto o globale ignoto, la lista vuota (PGE #209, per cui c'e'
     wouldEmptyEnv), un dict senza `points` — e il punto cieco int/float:
     `n_reps: 2.0` e' un float per Python, quindi non un compatto, quindi un
     errore; di qua `2.0` e `2` sono lo stesso Number. Lo specchio tace, che e'
     il verso sicuro — lo stesso di `power.exponent` in timeDistError.

     Ritorna null, oppure { where, why, value, index, point?, start?, dist? }:
       where  la sotto-posizione (sopra)
       why    "element" | "interp" | "arity" | "reps" | "type" | "offset" |
              "empty" | "point" | "range" | "order" | il `kind` di timeDistError
       value  il valore colpevole come scritto (l'elemento, la x, n_reps, …)
       index  la posizione dell'elemento nella lista; null nella forma diretta
       point  l'indice del punto dentro il pattern
       start  l'istante da cui il blocco comincia, per `offset`
       dist   l'errore di timeDistError, tale e quale                      */
  // EnvelopeBuilder.VALID_INTERP_TYPES — la parita' pretende che coincidano.
  const INTERP_TYPES = ["linear", "cubic", "step"];

  // `bool` in Python e' sottoclasse di `int`, e `_is_number` lo esclude a
  // mano. In JS e' un tipo a se', quindi basta il typeof.
  const _isNum = (v) => typeof v === "number";
  const _isDict = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const _has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // EnvelopeBuilder.is_compact_format, alla lettera. Qui `isinstance(x, int)`
  // include il booleano (sottoclasse) e un float intero come 2.0 no: il primo
  // si replica, il secondo di qua non si vede (vedi sopra).
  function _engineIsCompact(item) {
    if (!Array.isArray(item) || item.length < 3 || item.length > 6) return false;
    if (!Array.isArray(item[0])) return false;
    if (!item[0].every((p) => Array.isArray(p) && (p.length === 2 || p.length === 3))) return false;
    if (!(_isNum(item[1]) || typeof item[1] === "boolean")) return false;
    if (!(Number.isInteger(item[2]) || typeof item[2] === "boolean")) return false;
    if (item.length >= 4 && item[3] != null && typeof item[3] !== "string") return false;
    if (item.length >= 5 && item[4] != null && !(typeof item[4] === "string" || _isDict(item[4]))) return false;
    if (item.length === 6 && item[5] != null && typeof item[5] !== "boolean") return false;
    return true;
  }

  // EnvelopeBuilder.is_bp_group. Un gruppo senza punti E' un gruppo (il loop
  // su una lista vuota non trova niente da rifiutare): lo ferma l'arita'.
  function _engineIsGroup(item) {
    if (!Array.isArray(item) || item.length !== 2) return false;
    const [pts, interp] = item;
    if (typeof interp !== "string" || !Array.isArray(pts)) return false;
    return pts.every((p) => Array.isArray(p) && (p.length === 2 || p.length === 3) &&
      _isNum(p[0]) && _isNum(p[1]) && (p.length === 2 || typeof p[2] === "string"));
  }

  function _groupError(group) {
    const [pts, interp] = group;
    if (!INTERP_TYPES.includes(interp))
      return { where: "group.interp", why: "interp", value: interp };
    if (pts.length < 2)
      return { where: "group.points", why: "arity", value: pts };
    return null;
  }

  // _expand_compact_format, i soli guard, nell'ordine in cui scattano.
  function _compactError(c, start) {
    const [pattern, end, nReps] = c;
    if (!_isNum(nReps) || nReps < 1)
      return { where: "compact.n_reps", why: "reps", value: nReps };
    if (!_isNum(end) || !isFinite(end))
      return { where: "compact.end_time", why: "type", value: end };
    if (end <= start)
      return { where: "compact.end_time", why: "offset", value: end, start };
    if (pattern.length === 0)
      return { where: "compact.pattern", why: "empty", value: pattern };
    let prev = null;
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i];
      const x = p[0];
      const type = p.length === 3 ? p[2] : null;
      if (!_isNum(x) || !_isNum(p[1]) || !(type == null || typeof type === "string"))
        return { where: "compact.pattern", why: "point", value: p, point: i };
      // Scritto cosi' e non `x < 0 || x > 100`: NaN deve cadere, come
      // `not 0 <= x <= 100` in Python.
      if (!(x >= 0 && x <= 100))
        return { where: "compact.pattern", why: "range", value: x, point: i };
      if (prev != null && x < prev)
        return { where: "compact.pattern", why: "order", value: x, point: i };
      prev = x;
    }
    const dist = c.length > 4 ? c[4] : null;
    const dErr = timeDistError(dist, nReps);
    if (dErr) return { where: "compact.time_dist", why: dErr.kind, value: dist, dist: dErr };
    return null;
  }

  /* Dove sta l'ultimo breakpoint che un compatto valido espande: e' da li' che
     comincia il blocco successivo (`current_time = compact_expanded[-1][0]`).
     Non e' l'end_time — e' l'ultimo punto dell'ultimo ciclo, che con un
     pattern finito prima di x=100 cade dentro il ciclo; con wrap il motore
     aggiunge un punto a fine ciclo (fine − DISCONTINUITY_OFFSET). L'ultimo
     ciclo dura quel che dice la distribuzione: le durate sono quelle di
     computeCycleDurations, che la parita' delle distribuzioni confronta con le
     sue. Si calcola solo se un compatto successivo ne ha bisogno. */
  function _compactLastTime(c, start) {
    const [pattern, end, nReps] = c;
    const dist = c.length > 4 ? c[4] : null;
    const wrap = c.length > 5 && c[5] === true;
    // Lineare (il default) in forma chiusa: computeCycleDurations alloca un
    // array di n_reps durate, e un `n_reps` enorme scritto a mano nel tab Raw
    // non deve bloccare le annotazioni, che prima non calcolavano niente.
    const name = dist == null ? "linear"
      : (typeof dist === "string" ? dist : (dist.type !== undefined ? dist.type : "linear"));
    let lastDur;
    if (typeof name === "string" && name.toLowerCase() === "linear") {
      lastDur = (end - start) / nReps;
    } else {
      const durs = computeCycleDurations(end - start, nReps, dist);
      lastDur = durs.length ? durs[durs.length - 1] : 0;
    }
    const xLast = pattern[pattern.length - 1][0];
    let last = end - lastDur * (1 - xLast / 100);
    if (pattern.length === 1 && (nReps > 1 || start > 0)) last += DISCONTINUITY_OFFSET;
    if (wrap && xLast < 100) last = Math.max(last, end - DISCONTINUITY_OFFSET);
    return last;
  }

  function envShapeError(env) {
    // `Envelope.__init__`: il dict passa `breakpoints['points']` al builder, e
    // senza la chiave e' un KeyError, prima del builder. Il builder poi itera
    // quello che riceve, e non solo una lista: una stringa si itera per
    // caratteri, un dict per chiavi — elementi che non sono breakpoint, e che
    // il suo guard rifiuta (`envelope.point`). Un numero o null non si
    // iterano: TypeError, fuori dal builder. Dal tab Raw ci si arriva da
    // `deviation_probability`, riconosciuto envelope da `'points' in obj`.
    let raw = env;
    if (_isDict(env)) {
      if (!_has(env, "points")) return null;
      raw = env.points;
      if (typeof raw === "string") raw = Array.from(raw);
      else if (_isDict(raw)) raw = Object.keys(raw);
    }
    if (_engineIsCompact(raw)) {
      const e = _compactError(raw, 0);
      return e ? { ...e, index: null } : null;
    }
    if (_engineIsGroup(raw)) {
      const e = _groupError(raw);
      return e ? { ...e, index: null } : null;
    }
    if (!Array.isArray(raw)) return null;

    // Gli elementi come li guarda il builder (`dict_as_list`): un dict
    // `{t, v, type?}` diventa `[t, v, type?]` PRIMA di ogni riconoscimento —
    // e cosi' normalizzato puo' essere anche un compatto (`{t: pattern,
    // v: end_time, type: n_reps}`), che sposta l'inizio del blocco dopo come
    // ogni altro. Cercare l'ultimo compatto sugli elementi come scritti lo
    // perdeva, e il blocco dopo ripartiva da 0.
    const items = raw.map((it) => (_isDict(it) && _has(it, "t") && _has(it, "v"))
      ? (_has(it, "type") ? [it.t, it.v, it.type] : [it.t, it.v])
      : it);
    let lastCompact = -1;
    items.forEach((it, i) => { if (_engineIsCompact(it)) lastCompact = i; });
    let current = 0;
    for (let i = 0; i < items.length; i++) {
      const written = raw[i];
      const item = items[i];
      let e = null;
      if (_engineIsCompact(item)) {
        e = _compactError(item, current);
        // `current_time = compact_expanded[-1][0]`: assegnato, non un massimo.
        if (!e && i < lastCompact) current = _compactLastTime(item, current);
      } else if (_engineIsGroup(item)) {
        e = _groupError(item);
        const lastT = item[0].length ? item[0][item[0].length - 1][0] : current;
        if (!e && lastT > current) current = lastT;
      } else if (Array.isArray(item) && _isNum(item[0]) && _isNum(item[1]) &&
                 (item.length === 2 || (item.length === 3 && typeof item[2] === "string"))) {
        // `max(current_time, t)` di Python: con t NaN resta current, e
        // Math.max darebbe NaN. Il confronto esplicito e' la stessa regola.
        if (item[0] > current) current = item[0];
      } else {
        e = { where: "point", why: "element", value: written };
      }
      if (e) return { ...e, index: i };
    }
    return null;
  }

  /* Lo schizzo di un envelope, per le righe che lo mostrano in piccolo
     (ParamRow in primitives.jsx, CurveRow in EnvelopeSelector.jsx): la strada
     dell'EnvelopeEditor — envExpand: unwrapEnv, expandMixed — per ogni
     grafia.
     Le due righe la percorrevano ciascuna a modo suo, e misuravano l'envelope
     come lista: su un dict `{type, points}` — che wrapEnv scrive per ogni
     interp globale non lineare, eccezioni sul punto comprese (#189) — una
     mostrava il segnaposto al posto della curva, l'altra la diagonale di
     default. Una lettura sola, cosi' non tornano a divergere.
       count:  gli elementi SCRITTI (envCount)
       points: i punti da tracciare, [t, v, interp]
       loops:  quanti blocchi compatti
     La strada e' quella dell'editor anche sul terzo campo: gli item dentro
     un dict col tipo globale, perche' expandMixed tagghi col globale i punti
     senza tipo suo. Passati come lista uscivano `linear`,
     cioe' lo schizzo perdeva proprio il dato che #189 esiste per conservare;
     e da #191 e' envExpand, la stessa funzione dell'editor, non una copia.  */
  function envSketch(env) {
    const exp = envExpand(env);
    return { count: envCount(env), points: exp.points, loops: exp.blocks.length };
  }

  /* Quanti elementi SCRITTI ha un envelope — i badge «N bp» dell'Inspector e
     le righe di envSketch, con una regola sola: per il dict i suoi points, per
     la lista i suoi item, e per una grafia NUDA (il blocco o il gruppo che E'
     il valore, anche come `points` del dict) uno. `unwrapEnv` la rende tale e
     quale, cioe' i tre campi del blocco (pattern, end_time, n_reps) o i due
     del gruppo, e contarli dava «↻1 · 3 el» su un envelope fatto di un
     blocco. Non espande niente: costa una lunghezza, non n_reps cicli.      */
  function envCount(env) {
    const items = unwrapEnv(env).items;
    return isBareEnv(items) ? 1 : items.length;
  }

  /* ---------- espansione: envelope misto → punti renderizzabili ----------
     Lo specchio di `EnvelopeBuilder.parse` piu' il tipo globale che
     `Envelope.__init__` gli mette sopra: gli stessi punti, negli stessi
     istanti, con l'interp che il motore da' a ciascun segmento.
     Output:
       points: [[t, v, interp], …]      — interp = il tipo del segmento che
                                          PARTE dal punto: il suo tag, o il
                                          globale
       cycles: [{ blockIdx, cycleIdx, start, end, points: [[t,v(,type)],…] }, …]
                                        — i soli punti del pattern, indice per
                                          indice (le maniglie del 1° ciclo)
       blocks: [{ index, start, end, nReps, interp, rawInterp, dist, pattern,
                  cycles: [...], originalIdx }]
       globalInterp: il tipo globale (#191)
       perPoint: qualche punto espanso porta un tipo suo — per il motore e'
                 un segmento per coppia, altrimenti uno solo (vedi envValueAt)

     L'interp di un punto senza tag e' il GLOBALE (#191): il `type` del dict,
     per la lista lo slot 3 del primo blocco che ne dichiara uno
     (`listInterp`). Lo slot 3 di un blocco non tagga i suoi punti: nella lista
     e' il globale solo se e' il primo dichiarato, nel dict non conta niente.
     Prima ogni ciclo si taggava col suo slot 3 e i breakpoint nudi di una
     lista `linear`: un blocco `step` dopo due punti nudi si disegnava a
     gradini e i due punti dritti, e il motore suonava a gradini anche loro;
     nel dict `cubic` lo stesso blocco si disegnava a gradini e suonava
     cubico. `block.interp` e' l'interp EFFETTIVO dei segmenti interni del
     blocco (i tag del pattern, o il globale; "mixed" se non sono uniformi),
     `block.rawInterp` lo slot 3 com'e' scritto.

     Il resto e' la lettura del builder, anche dove l'editor non ha maniglie:
       · il punto `{t, v, type?}` e' un punto (`dict_as_list`), e la curva ci
         passa — si disegna, non si trascina (isBreakpoint);
       · il blocco comincia dall'ULTIMO punto espanso di quello prima
         (`current_time = compact_expanded[-1][0]`), non dal suo end_time —
         con un pattern finito prima di x=100 cade dentro l'ultimo ciclo;
       · `wrap` (slot 5) aggiunge a fine ciclo un punto col primo y del
         pattern, se il pattern finisce prima di 100.
     Su queste tre il disegno raccontava un altro envelope: il cursore, i due
     punti di un gruppo o di un blocco successivo, e le tangenti della cubica
     che si calcolano su TUTTI i punti (#190). */
  function expandMixed(env) {
    let globalInterp;
    if (_isDict(env) && Array.isArray(env.points)) {
      globalInterp = typeof env.type === "string" && env.type ? env.type : "linear";
      env = env.points;
    } else {
      globalInterp = listInterp(env) || "linear";
    }
    if (isBareEnv(env)) env = [env]; // forma diretta: il valore E' il gruppo, o il blocco
    const points = [];
    const cycles = [];
    const blocks = [];
    let perPoint = false;
    let currentTime = 0;
    if (!Array.isArray(env)) return { points, cycles, blocks, globalInterp, perPoint };

    for (let i = 0; i < env.length; i++) {
      const item = env[i];
      const bp = bpAt(item);
      if (bp) {
        if (bp[2] != null) perPoint = true;
        points.push([bp[0], bp[1], bp[2] != null ? bp[2] : globalInterp]);
        if (bp[0] > currentTime) currentTime = bp[0];
        continue;
      }
      if (isBPGroup(item)) {
        // BP group: l'interp di zona governa i segmenti interni; il segmento
        // in uscita dall'ultimo punto segue il default globale. Un type
        // esplicito per-punto fa override. Tempi assoluti; collisione al bordo
        // zona (t <= ultimo punto precedente) → DISCONTINUITY_OFFSET, stessa
        // regola dei loop block.
        const pts = item[0], gInterp = item[1] || "linear";
        for (let pi = 0; pi < pts.length; pi++) {
          const p = pts[pi];
          let pt = p[0];
          if (pi === 0 && points.length > 0 && pt <= currentTime) {
            pt = currentTime + DISCONTINUITY_OFFSET;
          }
          const isLast = pi === pts.length - 1;
          const own = typeof p[2] === "string" ? p[2] : (isLast ? null : gInterp);
          if (own != null) perPoint = true;
          points.push([pt, p[1], own != null ? own : globalInterp]);
          if (pt > currentTime) currentTime = pt;
        }
        continue;
      }
      if (!isCompactBlock(item)) continue;
      const pattern = item[0];
      const endTime = item[1];
      const nReps   = item[2];
      const dist    = item[4] || "linear";
      const wrap    = item.length > 5 && item[5] === true;
      const blockStart = currentTime;
      const T = Math.max(0, endTime - blockStart);
      if (T <= 0 || nReps < 1) continue;
      const cycleDurs = computeCycleDurations(T, nReps, dist);
      const block = {
        index: blocks.length, originalIdx: i,
        start: blockStart, end: endTime, nReps, dist, pattern,
        interp: blockInterp(item, globalInterp),
        rawInterp: typeof item[3] === "string" ? item[3] : null,
        // Non null quando la distribuzione dichiarata non è costruibile: i
        // cicli qui sotto sono disegnati con il ripiego lineare, ma il motore
        // rifiuterebbe questo blocco. Chi disegna può dirlo.
        distError: timeDistError(dist, nReps),
        // L'altro ripiego, che è il contrario: la spec è buona e il motore la
        // rende, ma il conto in doppia precisione è uscito inservibile e i
        // cicli qui sotto sono uguali per forza. Chi disegna deve dirlo con
        // parole diverse — qui non c'è niente di sbagliato nello YAML.
        previewFallback: isPreviewFallback(cycleDurs),
        cycles: []
      };
      const blockPts = [];
      let t = blockStart;
      for (let c = 0; c < nReps; c++) {
        const dur = cycleDurs[c];
        const cs = t, ce = t + dur;
        const cyclePts = [];
        for (let pi = 0; pi < pattern.length; pi++) {
          const xPct = pattern[pi][0], y = pattern[pi][1];
          const own = pattern[pi].length >= 3 && typeof pattern[pi][2] === "string" ? pattern[pi][2] : null;
          let pt = cs + (xPct / 100) * dur;
          // discontinuità: primo punto del 1° ciclo se time_offset>0,
          // e primo punto di ogni ciclo successivo
          if (pi === 0 && (c > 0 || blockStart > 0)) pt += DISCONTINUITY_OFFSET;
          cyclePts.push(own != null ? [pt, y, own] : [pt, y]);
          if (own != null) perPoint = true;
          blockPts.push([pt, y, own != null ? own : globalInterp]);
        }
        const cycObj = { blockIdx: block.index, cycleIdx: c, start: cs, end: ce, points: cyclePts };
        cycles.push(cycObj);
        block.cycles.push(cycObj);
        t = ce;
      }
      // wrap (slot 5): un punto sintetico a fine ciclo col primo y del
      // pattern, se il pattern finisce prima di x=100 — il loop si chiude.
      // Poi l'ordine per tempo, stabile come `list.sort`.
      if (wrap && pattern[pattern.length - 1][0] < 100) {
        const firstY = pattern[0][1];
        for (const cyc of block.cycles) blockPts.push([cyc.end - DISCONTINUITY_OFFSET, firstY, globalInterp]);
        blockPts.sort((a, b) => a[0] - b[0]);
      }
      for (const p of blockPts) points.push(p);
      blocks.push(block);
      // `current_time = compact_expanded[-1][0]`: assegnato, e l'ultimo punto
      // espanso, non l'end_time.
      currentTime = blockPts.length ? blockPts[blockPts.length - 1][0] : endTime;
    }
    return { points, cycles, blocks, globalInterp, perPoint };
  }

  /* L'interp EFFETTIVO dei segmenti interni di un blocco: il tag di ogni
     punto del pattern tranne l'ultimo — il cui segmento esce dal ciclo, verso
     il ciclo dopo o verso cio' che segue il blocco — o, senza tag, il globale.
     "mixed" se non sono uniformi; un pattern di un punto solo ha un segmento
     solo, quello in uscita. E' quello che il pannello del loop mostra e il
     badge scrive (#191): lo slot 3 non lo e', per il motore e' il globale o
     niente. */
  function blockInterp(block, interp) {
    const g = interp || "linear";
    const pat = isCompactBlock(block) ? block[0] : [];
    if (!pat.length) return g;
    const inner = pat.length > 1 ? pat.slice(0, -1) : pat;
    const effs = inner.map((p) => (p.length >= 3 && typeof p[2] === "string") ? p[2] : g);
    return effs.every((e) => e === effs[0]) ? effs[0] : "mixed";
  }

  /* L'interp di UN blocco, scelta dal pannello del loop (#191). Il motore non
     ha un interp per blocco: lo slot 3 e' una grafia del tipo GLOBALE (il
     primo dichiarato, nella lista) o niente (nel dict). Quello che legge
     uguale nelle due forme e' il tag sul punto, quindi l'interp di un blocco
     sono i tag dei punti interni del suo pattern — tutti tranne l'ultimo, il
     cui segmento esce dal ciclo e segue il globale, come per il BP group;
     un tag uguale al globale non si scrive. Cosi' "add loop" su una curva
     cubica, e poi `step` sul blocco, fa a gradini il blocco e lascia cubico
     il resto, nelle due forme.
     L'eccezione e' il blocco che E' tutto l'envelope: li' l'interp del blocco
     e quello globale sono la stessa cosa, e il pannello cambia il globale —
     scritto nello slot 3 come la forma compatta lo documenta (`[pattern, 1,
     4, cubic]`), invece di un tag su ogni punto. Nel dict (`opts.dict`) il
     globale e' il `type`, e lo slot 3 si tocca solo se c'era, per non
     lasciarci un tipo che non vale. I tag interni si tolgono: valgono il
     globale.
     Torna `{items, interp}`: gli item nuovi e il globale (cambiato solo nel
     caso del blocco solo), da passare insieme al commit. */
  function setBlockInterp(items, idx, type, interp, opts) {
    const g = interp || "linear";
    const block = Array.isArray(items) ? items[idx] : null;
    if (!isCompactBlock(block)) return { items, interp: g };
    const pat = block[0];
    const last = pat.length - 1;
    const alone = items.length === 1;
    const nextPat = pat.map((p, i) => {
      if (i === last && last > 0) return p;
      if (alone || type === g) return [p[0], p[1]];
      return [p[0], p[1], type];
    });
    const nb = block.slice();
    nb[0] = nextPat;
    if (!alone) return { items: items.map((it, i) => (i === idx ? nb : it)), interp: g };
    const dict = !!(opts && opts.dict);
    if (typeof block[3] === "string" || (!dict && type !== "linear")) nb[3] = type;
    return { items: [nb], interp: type };
  }

  /* Un punto nuovo nel pattern di un blocco — il doppio click dentro il loop
     — al suo posto in x, col tipo del punto PRIMA: e' il segmento di quel
     punto che il nuovo spezza, e le due meta' restano quello che il segmento
     era, come per il breakpoint nudo inserito in una zona (onCanvasDblClick).
     Da #191 l'interp di un blocco sono i tag dei punti del suo pattern
     (setBlockInterp), quindi un punto senza tag seguiva il globale: il doppio
     click su un blocco `step` dentro una curva cubica rendeva cubica la meta'
     dopo il punto, e il blocco `mixed`. Dopo l'ultimo punto vale lo stesso
     (spezza il segmento in uscita, che e' del tag dell'ultimo); prima del
     primo un punto prima non c'e', e niente tag. Torna `{pattern, index}`: il
     pattern nuovo — quello di prima non si tocca — e dove sta il punto. */
  function insertPatternPoint(pattern, x, y) {
    const pat = Array.isArray(pattern) ? pattern : [];
    let index = pat.findIndex((p) => p[0] > x);
    if (index < 0) index = pat.length;
    const left = index > 0 ? pat[index - 1] : null;
    const pt = left && typeof left[2] === "string" ? [x, y, left[2]] : [x, y];
    return { pattern: [...pat.slice(0, index), pt, ...pat.slice(index)], index };
  }

  /* L'interp globale cambiato dal selettore in testata. Si scrive dove il
     motore lo legge: nel dict e' il `type` (wrapEnv), nella lista lo slot 3
     dei blocchi che ne dichiarano uno — il primo e' il globale, gli altri il
     motore non li guarda, e lasciarli con un tipo che non vale vorrebbe dire
     che togliere il primo blocco cambierebbe il tipo di tutto il resto. Un
     blocco senza slot 3 resta senza: segue il globale. */
  function setGlobalInterp(items, type) {
    if (!Array.isArray(items)) return items;
    let changed = false;
    const out = items.map((it) => {
      if (!isCompactBlock(it) || typeof it[3] !== "string" || it[3] === type) return it;
      changed = true;
      const nb = it.slice();
      nb[3] = type;
      return nb;
    });
    return changed ? out : items;
  }

  /* ---------- la cubica come la calcola il motore (#190) ----------
     Le tangenti di `Envelope._compute_fritsch_carlson_tangents`, su TUTTI i
     punti espansi dell'envelope — blocchi, gruppi e punti nudi insieme, come
     fa il motore (`_parse_segments`: `global_tangents` sulla lista intera) —
     e una funzione sola per il disegno e per il cursore, che prima ne
     avevano una copia a testa e sbagliavano allo stesso modo:
       · con DUE punti le tangenti sono zero: l'Hermite diventa lo smoothstep
         v0 + (v1 - v0)(3s² - 2s³), una S. Il disegno e il cursore davano a
         entrambi la pendenza del segmento, cioe' una retta: `cubic` e
         `linear` sembravano la stessa curva, e a t = 0.1 il valore mostrato
         era il 76% piu' alto di quello che suonava;
       · le tangenti del disegno si calcolavano per gruppo di breakpoint e per
         ciclo, ognuno coi suoi estremi: al confine fra un gruppo e un blocco,
         e fra un ciclo e il successivo, la curva disegnata non era quella
         suonata;
       · un segmento di ampiezza zero (la discontinuita') ha pendenza zero,
         non quella del vicino.
     Le pendenze e le tangenti interne seguono il motore alla lettera, operazione
     per operazione: la parita' li confronta su Envelope.evaluate. */
  function cubicTangents(points) {
    const n = points ? points.length : 0;
    const m = new Array(n).fill(0);
    if (n < 3) return m;
    const d = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const t0 = points[i][0], t1 = points[i + 1][0];
      d[i] = t1 > t0 ? (points[i + 1][1] - points[i][1]) / (t1 - t0) : 0;
    }
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      const dl = d[i - 1], dr = d[i];
      m[i] = dl * dr <= 0 ? 0 : 2 / (1 / dl + 1 / dr);
    }
    return m;
  }

  // CubicInterpolation._cubic_hermite, nello stesso ordine di operazioni.
  function hermite(t, t0, v0, m0, t1, v1, m1) {
    const h = t1 - t0;
    if (h === 0) return v0;
    const s = (t - t0) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * h * m0 +
           (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * h * m1;
  }

  /* Quanto vale l'envelope espanso (l'uscita di expandMixed) al tempo x, come
     `Envelope.evaluate`. Due strade, come nel motore:
       · nessun punto con un tipo suo (`perPoint` falso): UN segmento con il
         tipo globale. Lo step li' vale l'ultimo punto con t <= x, quindi su
         una discontinuita' (due punti allo stesso istante) il secondo;
       · altrimenti un segmento per coppia, ognuno col tipo del punto da cui
         parte: lo step tiene il valore fino al punto dopo, che vale da li'.
     Le due differiscono solo esattamente sull'istante di una discontinuita',
     ed e' per quello che ci sono tutte e due. */
  function envValueAt(exp, x) {
    const pts = exp && exp.points;
    if (!pts || !pts.length) return null;
    const n = pts.length;
    if (n === 1) return pts[0][1];
    const tg = cubicTangents(pts);
    const lerp = (a, b) => {
      const alpha = b[0] > a[0] ? (x - a[0]) / (b[0] - a[0]) : 0;
      return a[1] + alpha * (b[1] - a[1]);
    };
    if (!exp.perPoint) {
      const g = exp.globalInterp || "linear";
      if (x < pts[0][0]) return pts[0][1];
      if (x > pts[n - 1][0]) return pts[n - 1][1];
      if (g === "step") {
        for (let i = n - 1; i >= 0; i--) if (x >= pts[i][0]) return pts[i][1];
        return pts[0][1];
      }
      for (let i = 0; i < n - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (a[0] <= x && x <= b[0]) {
          return g === "cubic" ? hermite(x, a[0], a[1], tg[i], b[0], b[1], tg[i + 1]) : lerp(a, b);
        }
      }
      return pts[n - 1][1];
    }
    const pair = (i) => {
      const a = pts[i], b = pts[i + 1];
      if (a[2] === "step") return x >= b[0] ? b[1] : a[1];
      if (a[2] === "cubic") return hermite(x, a[0], a[1], tg[i], b[0], b[1], tg[i + 1]);
      return lerp(a, b);
    };
    // Un segmento solo (due punti): `NormalSegment.evaluate`, che tiene fuori
    // dagli estremi e altrimenti chiede alla strategia — anche sull'istante
    // di un segmento largo zero, dove lo step da' il secondo punto.
    if (n === 2) {
      if (x < pts[0][0]) return pts[0][1];
      if (x > pts[1][0]) return pts[1][1];
      return pair(0);
    }
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    for (let i = 0; i < n - 1; i++) {
      if (pts[i][0] <= x && x <= pts[i + 1][0]) return pair(i);
    }
    return pts[n - 1][1];
  }

  /* Il tracciato della curva, nel dominio (tempo, valore): lo stesso
     envelope di envValueAt, segmento per segmento, con le stesse tangenti.
     `M` sul primo punto, poi per ogni segmento:
       step  → `L` al tempo del punto dopo col valore tenuto, `L` al valore dopo;
       cubic → `C` coi punti di controllo di Bezier dell'Hermite
               (t0 + h/3, v0 + h·m0/3), (t1 − h/3, v1 − h·m1/3): in x il
               tempo e' lineare nel parametro, quindi la Bezier E' l'Hermite;
       altro → `L`.
     Il chiamante porta i comandi in pixel; la curva e' decisa qui, una volta
     sola per disegno e cursore. */
  function envPath(exp) {
    const pts = (exp && exp.points) || [];
    if (!pts.length) return [];
    const tg = cubicTangents(pts);
    const out = [{ op: "M", t: pts[0][0], v: pts[0][1] }];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const h = b[0] - a[0];
      // Senza tipi per-punto ogni punto porta gia' il globale (expandMixed):
      // un segmento solo o uno per coppia si disegnano uguali.
      const si = a[2];
      if (si === "step") {
        out.push({ op: "L", t: b[0], v: a[1] });
        out.push({ op: "L", t: b[0], v: b[1] });
      } else if (si === "cubic" && h > 0) {
        out.push({ op: "C",
                   c1: [a[0] + h / 3, a[1] + h * tg[i] / 3],
                   c2: [b[0] - h / 3, b[1] - h * tg[i + 1] / 3],
                   t: b[0], v: b[1] });
      } else {
        out.push({ op: "L", t: b[0], v: b[1] });
      }
    }
    return out;
  }

  /* La lettura dell'editor, una sola: l'envelope com'e' scritto → i punti
     espansi coi loro segmenti. Gli item come li legge il builder, dentro un
     dict col tipo globale del motore — il `type`, o per la lista
     `listInterp` — o quello che il motore impone (`imposed`: lo `step` di
     read_direction, che lo YAML non scrive). La usano l'EnvelopeEditor, gli
     schizzi delle righe (envSketch) e la parita'.
     I BP group restano INTERI, e non desugarati come `rawEnv`: il builder
     sposta di DISCONTINUITY_OFFSET il primo punto di un gruppo che cade
     sull'istante del punto prima (`_expand_bp_group`), e un breakpoint nudo
     no — sugli item desugarati lo spostamento si perdeva, il salto era un
     segmento largo zero, e le tangenti della cubica accanto non erano quelle
     del motore. Desugarati restano invece gli INDICI: `blocks[].originalIdx`
     e' la posizione del blocco in `rawEnv` (desugarBPGroups, dove un gruppo
     conta quanti i suoi punti), l'invariante su cui l'editor poggia. */
  function envExpand(raw, imposed) {
    const w = unwrapEnv(raw);
    const items = isBareEnv(w.items) ? [w.items] : w.items;
    const exp = expandMixed({ type: imposed || w.interp, points: items });
    if (Array.isArray(items) && exp.blocks.length) {
      const at = [];
      let k = 0;
      items.forEach((it, i) => { at[i] = k; k += isBPGroup(it) ? it[0].length : 1; });
      for (const b of exp.blocks) b.originalIdx = at[b.originalIdx];
    }
    return exp;
  }

  /* ---------- formattazione YAML del formato compatto ---------- */
  function fmtNum(n) {
    if (n == null) return "null";
    if (Number.isInteger(n)) return String(n);
    if (Math.abs(n) < 1) return (+n.toFixed(4)).toString();
    return (+n.toFixed(3)).toString();
  }
  function fmtBP(p) {
    const base = `[${fmtNum(p[0])}, ${fmtNum(p[1])}`;
    return p.length >= 3 ? `${base}, '${p[2]}']` : `${base}]`;
  }
  function fmtPattern(p) { return "[" + p.map(fmtBP).join(", ") + "]"; }
  function fmtDist(d) {
    if (!d) return null;
    if (typeof d === "string") return `'${d}'`;
    const keys = Object.keys(d).filter(k => k !== "type");
    if (!keys.length) return `'${d.type}'`;
    const body = `type: ${d.type}, ` + keys.map(k => `${k}: ${fmtNum(d[k])}`).join(", ");
    return `{${body}}`;
  }
  function fmtCompact(block) {
    const parts = [fmtPattern(block[0]), fmtNum(block[1]), String(block[2])];
    const interp = block[3], dist = block[4];
    // Gli slot sono POSIZIONALI: un interp non dichiarato (null) davanti a una
    // distribuzione resta `null`, o la distribuzione scivolerebbe nello slot
    // dell'interp e si rileggerebbe come tale.
    if (interp) parts.push(`'${interp}'`);
    else if (dist) parts.push("null");
    if (dist)   parts.push(fmtDist(dist));
    return "[" + parts.join(", ") + "]";
  }
  function fmtBPGroup(group) {
    return `[${fmtPattern(group[0])}, '${group[1]}']`;
  }
  function fmtItem(it) {
    return isBreakpoint(it) ? fmtBP(it) :
           isBPGroup(it)    ? fmtBPGroup(it) :
           fmtCompact(it);
  }
  function fmtEnvInline(env) {
    // typed envelope dict form: {type: 'cubic', points: [item, …]} — gli item
    // sono quelli della lista (3-tuple e BP group compresi, che wrapEnv ci
    // scrive da #189), quindi passano dallo stesso formattatore.
    if (isTypedEnv(env)) {
      const pts = env.points.map(fmtItem).join(", ");
      return `{type: ${env.type}, points: [${pts}]}`;
    }
    if (!Array.isArray(env)) return JSON.stringify(env);
    // Single compact block / BP group: emit bare form (no outer wrapping)
    if (env.length === 1 && isCompactBlock(env[0])) return fmtCompact(env[0]);
    if (env.length === 1 && isBPGroup(env[0])) return fmtBPGroup(env[0]);
    return "[" + env.map(fmtItem).join(", ") + "]";
  }

  /* normalizza un valore parsato all'array di items mixed-format
     - bare compact `[pattern, end, n, …]` → `[compact]`
     - bare BP group `[points, interp]`    → `[group]`
     - resto invariato                                                   */
  function normalizeEnv(parsed) {
    if (!Array.isArray(parsed)) return parsed;
    if (isCompactBlock(parsed)) return [parsed];
    if (isBPGroup(parsed)) return [parsed];
    return parsed;
  }

  /* ---------- parser YAML-ish per envelope (incluso compatto) ----------
     accetta:
       - apici singoli o doppi per stringhe
       - dict inline {type: foo, base: 3} con chiavi non quotate
       - numeri, true/false/null                                        */
  function parseEnvLiteral(text) {
    const p = new Parser(text);
    const v = p.parseValue();
    p.skipWS();
    if (!p.eof()) throw new Error("trailing characters at pos " + p.i);
    return v;
  }
  function Parser(s) { this.s = s; this.i = 0; }
  Parser.prototype.eof   = function () { return this.i >= this.s.length; };
  Parser.prototype.peek  = function () { return this.s[this.i]; };
  Parser.prototype.skipWS = function () {
    while (!this.eof() && /\s/.test(this.s[this.i])) this.i++;
  };
  Parser.prototype.expect = function (ch) {
    this.skipWS();
    if (this.s[this.i] !== ch) throw new Error(`expected '${ch}' at pos ${this.i}, got '${this.s[this.i]}'`);
    this.i++;
  };
  Parser.prototype.parseValue = function () {
    this.skipWS();
    const c = this.peek();
    if (c === "[") return this.parseArray();
    if (c === "{") return this.parseDict();
    if (c === "'" || c === '"') return this.parseString(c);
    return this.parseScalar();
  };
  Parser.prototype.parseArray = function () {
    this.expect("[");
    const arr = [];
    this.skipWS();
    if (this.peek() === "]") { this.i++; return arr; }
    while (true) {
      arr.push(this.parseValue());
      this.skipWS();
      if (this.peek() === ",") { this.i++; continue; }
      if (this.peek() === "]") { this.i++; return arr; }
      throw new Error("expected ',' or ']' at pos " + this.i);
    }
  };
  Parser.prototype.parseDict = function () {
    this.expect("{");
    const obj = {};
    this.skipWS();
    if (this.peek() === "}") { this.i++; return obj; }
    while (true) {
      this.skipWS();
      // chiave: identificatore, oppure 'str' / "str"
      let key;
      const c = this.peek();
      if (c === "'" || c === '"') key = this.parseString(c);
      else {
        const start = this.i;
        while (!this.eof() && /[A-Za-z0-9_]/.test(this.s[this.i])) this.i++;
        key = this.s.slice(start, this.i);
        if (!key) throw new Error("expected key at pos " + start);
      }
      this.skipWS(); this.expect(":");
      const val = this.parseValue();
      obj[key] = val;
      this.skipWS();
      if (this.peek() === ",") { this.i++; continue; }
      if (this.peek() === "}") { this.i++; return obj; }
      throw new Error("expected ',' or '}' at pos " + this.i);
    }
  };
  Parser.prototype.parseString = function (q) {
    this.i++; // consume quote
    let out = "";
    while (!this.eof() && this.s[this.i] !== q) {
      if (this.s[this.i] === "\\" && this.i + 1 < this.s.length) {
        out += this.s[this.i + 1]; this.i += 2;
      } else {
        out += this.s[this.i++];
      }
    }
    if (this.eof()) throw new Error("unterminated string");
    this.i++; // closing quote
    return out;
  };
  Parser.prototype.parseScalar = function () {
    const start = this.i;
    while (!this.eof() && !/[,\]\}\s]/.test(this.s[this.i])) this.i++;
    const tok = this.s.slice(start, this.i);
    if (tok === "true" || tok === "True")   return true;
    if (tok === "false" || tok === "False") return false;
    if (tok === "null" || tok === "None")   return null;
    if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(tok)) return Number(tok);
    return tok; // bare token (treat as string)
  };

  /* ---------- factory: blocco compatto di default ---------- */
  /* Il blocco che "add loop" aggiunge: pattern triangolare, end_time 1, quattro
     cicli, e NIENT'ALTRO. Prima portava `linear` nello slot 3 e nello slot 4:
     la distribuzione e' il default, ma lo slot 3 e' una grafia del tipo
     GLOBALE (#191) — nel dict `{type: cubic}` era un `linear` che il motore
     ignora e lo YAML dichiarava, e in una lista dove nessun blocco ne
     dichiarava uno era il blocco nuovo a fissare il globale. Senza, il blocco
     segue il globale come ogni altro segmento senza tipo suo, e il suo interp
     si sceglie dal pannello (setBlockInterp). */
  function defaultCompactBlock(env, fallbackY, bounds) {
    // pattern triangolare di default; end_time = 1; n_reps = 4
    const y0 = fallbackY != null ? fallbackY :
               (Array.isArray(env) && env.length && isBreakpoint(env[env.length - 1])
                ? env[env.length - 1][1] : 0);
    let peak;
    if (bounds) {
      const amplitude = (bounds.visMax - bounds.visMin) * 0.3;
      peak = +Math.min(bounds.hardMax, y0 + amplitude).toFixed(3);
    } else {
      peak = +(y0 * 1.5 + 1).toFixed(3);
    }
    return [
      [[0, +y0.toFixed(3)], [50, peak], [100, +y0.toFixed(3)]],
      1, 4
    ];
  }

  function pitchUnitSymbol(unit, edoDivisions) {
    if (unit && typeof unit === "object" && unit.edo != null) {
      return "°/" + unit.edo;
    }
    switch (unit) {
      case "ratio":        return "×";
      case "cents":        return "¢";
      case "quarter_tone": return "qt";
      case "eighth_tone":  return "et";
      case "edo":          return "°/" + (edoDivisions || 12);
      case "semitones":    return "st";
      default:             return "st";
    }
  }

  // ---- pitch unit conversion (shared Inspector + Voices) ----
  // edo unit may be the string "edo" (Inspector, divisions in a separate
  // field) or the object { edo: N } (Voices). Normalize to { kind, edo }.
  function normalizePitchUnit(unit, edoDivisions) {
    if (unit && typeof unit === "object" && unit.edo != null) {
      return { kind: "edo", edo: unit.edo };
    }
    if (unit === "edo") return { kind: "edo", edo: edoDivisions || 12 };
    return { kind: unit || "semitones", edo: null };
  }
  // value in given unit → equivalent in semitones
  function pitchToSemitones(value, unit, edoDivisions) {
    const u = normalizePitchUnit(unit, edoDivisions);
    switch (u.kind) {
      case "semitones":    return value;
      case "cents":        return value / 100;
      case "quarter_tone": return value / 2;
      case "eighth_tone":  return value / 4;
      case "ratio":        return 12 * Math.log2(value);
      case "edo":          return value * 12 / (u.edo || 12);
      default:             return value;
    }
  }
  // semitones → value in target unit
  function semitonesToPitch(st, unit, edoDivisions) {
    const u = normalizePitchUnit(unit, edoDivisions);
    switch (u.kind) {
      case "semitones":    return st;
      case "cents":        return st * 100;
      case "quarter_tone": return st * 2;
      case "eighth_tone":  return st * 4;
      case "ratio":        return Math.pow(2, st / 12);
      case "edo":          return st * (u.edo || 12) / 12;
      default:             return st;
    }
  }
  // true when the unit only admits integer values (everything but ratio)
  function pitchUnitIsInteger(unit) {
    const u = normalizePitchUnit(unit);
    return u.kind !== "ratio";
  }
  // safety bounds for a pitch unit, mirroring the engine's PitchUnit.value_bounds.
  // Reads window.PGE_BOUNDS.pitch (defined in yaml-bridge.js, loaded earlier);
  // edo derives its bounds from the divisions (±3 octaves). Returns
  // { min, max, rangeMax } in the unit's own scale.
  function pitchUnitBounds(unit, edoDivisions) {
    const u = normalizePitchUnit(unit, edoDivisions);
    if (u.kind === "edo") {
      // ±(edoFactor · divisions); edoFactor comes from the engine
      // (pitch_unit.py EdoUnit.value_bounds) via window.PGE_BOUNDS.pitch.
      const PBp = (typeof window !== "undefined" && window.PGE_BOUNDS && window.PGE_BOUNDS.pitch) || null;
      const factor = (PBp && typeof PBp.edoFactor === "number") ? PBp.edoFactor : 3;
      const bound = factor * (u.edo || 12);
      return { min: -bound, max: bound, rangeMax: bound };
    }
    const PB = (typeof window !== "undefined" && window.PGE_BOUNDS && window.PGE_BOUNDS.pitch) || null;
    if (PB && PB[u.kind]) return PB[u.kind];
    return (PB && PB.semitones) || { min: -36, max: 36, rangeMax: 36 };
  }
  // clamp a numeric value into [bounds.min, bounds.max]. Non-finite inputs
  // (e.g. 12*log2(0) = -Infinity when converting a ratio range of 0) collapse
  // to the nearest bound rather than escaping the range.
  function clampToBounds(v, bounds) {
    if (!bounds || typeof v !== "number") return v;
    if (bounds.min != null && v < bounds.min) return bounds.min;
    if (bounds.max != null && v > bounds.max) return bounds.max;
    return v;
  }
  // convert a single scalar between two pitch units, applying the integer
  // rule of the destination unit. With `bounds` ({min,max}) the converted
  // value is clamped into the destination unit's safe range so a change of
  // unit can never leave a value outside its bounds (e.g. cents 3600 → ratio 8
  // stays valid, but a range of 3600¢ → 8× is clamped to the ratio rangeMax).
  function convertPitchValue(value, fromUnit, toUnit, fromEdoDiv, toEdoDiv, bounds) {
    if (value == null) return value;
    const st = pitchToSemitones(value, fromUnit, fromEdoDiv);
    let out = semitonesToPitch(st, toUnit, toEdoDiv);
    if (pitchUnitIsInteger(toUnit)) out = Math.round(out);
    else out = +out.toFixed(4);
    return clampToBounds(out, bounds);
  }
  // convert a *range* (detune width / ± amount, never an absolute pitch). A
  // range of 0 means "no detune" in every unit, so it maps to 0 regardless of
  // family — bypassing the value math (which would send ratio 0 through
  // 12*log2(0) = -Infinity). Non-zero ranges convert like a value and clamp
  // into [0, rangeMax] of the destination unit.
  function convertPitchRange(value, fromUnit, toUnit, fromEdoDiv, toEdoDiv, bounds) {
    if (value == null) return value;
    if (value === 0) return 0;
    return convertPitchValue(value, fromUnit, toUnit, fromEdoDiv, toEdoDiv, bounds);
  }
  // walk an envelope (plain breakpoint array, typed `{type, points}`, or compact
  // loop block) applying `conv` to each y-value; x (time) is untouched.
  function _mapPitchEnv(env, conv) {
    function mapItem(item) {
      if (isBPGroup(item)) {
        // [ [[t,v(,type)],…], interp ]
        return [item[0].map(mapItem), item[1]];
      }
      if (isCompactBlock(item)) {
        // [ [[x,y],…], end_time, n_reps, interp_in, interp_out ]
        return [item[0].map(mapItem), ...item.slice(1)];
      }
      if (isBreakpoint(item)) {
        return [item[0], conv(item[1]), ...item.slice(2)];
      }
      return item;
    }
    if (isTypedEnv(env)) {
      return { ...env, points: env.points.map(mapItem) };
    }
    if (!Array.isArray(env)) return env;
    return env.map(mapItem);
  }
  // remap envelope y-values (the pitch value) into the new unit; optional
  // `bounds` clamps each breakpoint into the destination range.
  function convertPitchEnv(env, fromUnit, toUnit, fromEdoDiv, toEdoDiv, bounds) {
    return _mapPitchEnv(env, y => convertPitchValue(y, fromUnit, toUnit, fromEdoDiv, toEdoDiv, bounds));
  }
  // remap a *range* envelope's y-values, with the range semantics of
  // convertPitchRange (0 → 0, clamp into [0, rangeMax]).
  function convertPitchRangeEnv(env, fromUnit, toUnit, fromEdoDiv, toEdoDiv, bounds) {
    return _mapPitchEnv(env, y => convertPitchRange(y, fromUnit, toUnit, fromEdoDiv, toEdoDiv, bounds));
  }

  window.PGEEnv = {
    DISCONTINUITY_OFFSET,
    isBreakpoint, isDictBreakpoint, isCompactBlock, isBareEnv, envHasLoop,
    bpAt, bpAtX, bpMake,
    wouldEmptyEnv,
    isBPGroup, envHasGroup, desugarBPGroups, resugarBPGroups,
    firstBreakpointY,
    isTypedEnv, unwrapEnv, wrapEnv, listInterp,
    blockInterp, setBlockInterp, setGlobalInterp, insertPatternPoint,
    computeCycleDurations, isPreviewFallback, expandMixed, envExpand, envSketch, envCount,
    cubicTangents, hermite, envValueAt, envPath,
    TIME_DIST_NAMES, timeDistError, TIME_DIST_OVERFLOW_FIX, TIME_DIST_OVERFLOW_WHY,
    INTERP_TYPES, envShapeError,
    fmtEnvInline, fmtCompact, fmtBPGroup, fmtDist, fmtBP, fmtNum,
    parseEnvLiteral, normalizeEnv, defaultCompactBlock,
    pitchUnitSymbol,
    normalizePitchUnit, pitchToSemitones, semitonesToPitch,
    pitchUnitIsInteger, pitchUnitBounds, clampToBounds,
    convertPitchValue, convertPitchEnv,
    convertPitchRange, convertPitchRangeEnv,
  };
})();
