/* envelope-loops.js
 * Helpers per il formato compatto degli envelope (loops ripetuti) — vedi
 * envelopes-reference.md §5 (formato compatto) e §6 (distribuzioni temporali).
 *
 * Modello dati:
 *   Forme top-level di una envelope:
 *   (A) array mixed   :  [item, item, …]
 *   (B) dict con type :  {type: 'linear'|'cubic'|'step', points: [[t,v], …]}
 *                        — solo per envelope di soli breakpoint, applica
 *                        l'interpolazione globalmente a tutti i segmenti.
 *                        Non si combina con loop block.
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

  /* ---------- typed-envelope wrapper ----------
     `{type, points}` è la forma "tipata" globale per envelope di soli BP.
     Helpers per unwrappare a items[]/interp e ri-wrappare al commit.        */
  function isTypedEnv(env) {
    return env && typeof env === "object" && !Array.isArray(env) &&
           Array.isArray(env.points) && typeof env.type === "string";
  }
  function unwrapEnv(env) {
    if (isTypedEnv(env)) {
      return { interp: env.type || "linear", items: env.points.slice() };
    }
    // Dict con `points` ma senza `type`: forma che l'editor non emette mai
    // (wrapEnv scrive il dict solo per dire un interp non lineare) ma che il
    // motore accetta — `is_envelope_like` guarda solo che `points` ci sia. Va
    // letta qui, altrimenti chi la dichiara envelope a monte se la vede aprire
    // vuota, e un commit su quell'editor la svuoterebbe davvero.
    if (env && typeof env === "object" && !Array.isArray(env) && Array.isArray(env.points)) {
      return { interp: "linear", items: env.points.slice() };
    }
    return { interp: "linear", items: Array.isArray(env) ? env.slice() : [] };
  }
  function wrapEnv(items, interp) {
    const hasLoop = items.some(isCompactBlock);
    // BP groups keep the flat mixed-array form: the dict form is only for
    // pure-BP envelopes with a single global interp
    const hasGroup = items.some(isBPGroup);
    // if any breakpoint has an explicit per-point type, keep flat array (3-tuples)
    const hasPerPoint = items.some((it) => Array.isArray(it) && it.length === 3 && typeof it[2] === "string");
    if (hasPerPoint || hasGroup) return items;
    if (!interp || interp === "linear" || hasLoop) return items;
    // dict form available only for pure-BP envelopes with non-linear global interp
    return { type: interp, points: items.slice() };
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
     resugar:  un run di BP consecutivi i cui segmenti interni hanno tutti lo
               stesso type effettivo T ≠ default globale torna [points, T];
               altrimenti resta piatto (i tag == default vengono normalizzati
               via, come fa il context-menu per-segmento). Il ciclo
               desugar∘resugar è idempotente sugli indici. */
  function desugarBPGroups(items) {
    if (isBPGroup(items)) items = [items]; // forma diretta
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

  function resugarBPGroups(items, globalDefault) {
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
          const pts = run.map((p, i) => {
            if (i === run.length - 1) return typeof p[2] === "string" ? [p[0], p[1], p[2]] : [p[0], p[1]];
            return [p[0], p[1]]; // tag interno == T → assorbito dal gruppo
          });
          out.push([pts, T]);
          run = [];
          return;
        }
      }
      // run piatto — normalizza via i tag ridondanti (== default globale)
      run.forEach((p) => out.push(typeof p[2] === "string" && p[2] === g ? [p[0], p[1]] : p));
      run = [];
    }
    for (const it of items) {
      if (isBreakpoint(it)) run.push(it);
      else { flushRun(); out.push(it); }
    }
    flushRun();
    return out;
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
  //   "overflow" → parametro e n_reps sono entrambi legittimi da soli, ma la
  //                potenza che la distribuzione calcola con quella coppia non
  //                sta in un float (vedi _overflowError). Riportato solo se
  //                `nReps` è noto. Puro, node-testabile.
  function timeDistError(dist, nReps) {
    if (dist == null) return null;
    if (typeof dist !== "string" && typeof dist !== "object") return { kind: "name" };
    const rawName = typeof dist === "string" ? dist : (dist.type != null ? dist.type : "linear");
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
     `ratio: 10.0` a 309, `ratio: 2` a 1024, `rate: 0.5` a 1025 — sempre nella
     direzione dichiarata sicura. I bordi sono fissati nei test. */
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
      // weights[i] = rate ** -i: cresce solo se rate < 1, e al massimo in i=N-1.
      if (!(rate > 0) || rate >= 1) return null;
      const mag = (N - 1) * Math.log10(1 / rate);
      return mag > LOG10_MAX ? mk("rate", rate) : null;
    }
    if (name === "power") {
      const e = p.exponent != null ? +p.exponent : 2.0;
      // weights[i] = (i+1) ** exponent: il massimo è N ** exponent.
      if (!isFinite(e) || e <= 0 || Number.isInteger(e)) return null;
      const mag = e * Math.log10(N);
      return mag > LOG10_MAX ? mk("exponent", e) : null;
    }
    return null; // linear e logarithmic non elevano niente a potenza
  }

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
      if (Math.abs(r - 1) < 1e-9) return uniform();
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

       Ma qui il ripiego non può essere muto come là, e per la ragione opposta:
       quando parla `timeDistError` il motore RIFIUTA il blocco, e il pannello
       lo dice; qui il motore lo RENDE, spesso fortemente sbilanciato (con
       `{power, exponent: 1000}` e 4 cicli mette il 100% del tempo nell'ultimo),
       e cicli uguali sono un'anteprima plausibile e sbagliata — peggio delle
       NaN di prima, che almeno erano rotte a vista. Il ripiego marca quindi
       l'array con `previewFallback`, che `expandMixed` porta sul blocco e il
       pannello traduce in un messaggio suo, diverso da quello dell'overflow.
       Il flag nasce dalla guardia, cioè esattamente dove il conto JS ha
       fallito: nessuna soglia in più da tenere allineata al motore. */
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

  /* ---------- espansione: envelope misto → punti renderizzabili ----------
     Output:
       points: [[t, v], …]              — utili a tracciare la curva
       cycles: [{ blockIdx, cycleIdx, start, end, points: [[t,v],…] }, …]
       blocks: [{ index, start, end, nReps, interp, dist, pattern,
                  cycles: [...], originalIdx }]                                */
  function expandMixed(env) {
    // typed envelope wrapping: peel it and tag points with the global interp
    let globalInterp = "linear";
    if (isTypedEnv(env)) { globalInterp = env.type || "linear"; env = env.points; }
    if (isBPGroup(env)) env = [env]; // forma diretta [points, interp]
    const points = [];
    const cycles = [];
    const blocks = [];
    let currentTime = 0;
    if (!Array.isArray(env)) return { points, cycles, blocks };

    for (let i = 0; i < env.length; i++) {
      const item = env[i];
      if (isBreakpoint(item)) {
        points.push([item[0], item[1], (typeof item[2] === "string" ? item[2] : globalInterp)]);
        if (item[0] > currentTime) currentTime = item[0];
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
          const tag = typeof p[2] === "string" ? p[2] : (isLast ? globalInterp : gInterp);
          points.push([pt, p[1], tag]);
          if (pt > currentTime) currentTime = pt;
        }
        continue;
      }
      if (!isCompactBlock(item)) continue;
      const pattern = item[0];
      const endTime = item[1];
      const nReps   = item[2];
      const interp  = item[3] || "linear";
      const dist    = item[4] || "linear";
      const blockStart = currentTime;
      const T = Math.max(0, endTime - blockStart);
      if (T <= 0 || nReps < 1) continue;
      const cycleDurs = computeCycleDurations(T, nReps, dist);
      const block = {
        index: blocks.length, originalIdx: i,
        start: blockStart, end: endTime, nReps, interp, dist, pattern,
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
      let t = blockStart;
      for (let c = 0; c < nReps; c++) {
        const dur = cycleDurs[c];
        const cs = t, ce = t + dur;
        const cyclePts = [];
        for (let pi = 0; pi < pattern.length; pi++) {
          const xPct = pattern[pi][0], y = pattern[pi][1];
          let pt = cs + (xPct / 100) * dur;
          // discontinuità: primo punto del 1° ciclo se time_offset>0,
          // e primo punto di ogni ciclo successivo
          if (pi === 0 && (c > 0 || blockStart > 0)) pt += DISCONTINUITY_OFFSET;
          cyclePts.push(pattern[pi].length >= 3 ? [pt, y, pattern[pi][2]] : [pt, y]);
          points.push([pt, y, (pattern[pi].length >= 3 ? pattern[pi][2] : interp)]);
        }
        const cycObj = { blockIdx: block.index, cycleIdx: c, start: cs, end: ce, points: cyclePts };
        cycles.push(cycObj);
        block.cycles.push(cycObj);
        t = ce;
      }
      blocks.push(block);
      currentTime = endTime;
    }
    return { points, cycles, blocks, globalInterp };
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
    if (interp) parts.push(`'${interp}'`);
    if (dist)   parts.push(fmtDist(dist));
    return "[" + parts.join(", ") + "]";
  }
  function fmtBPGroup(group) {
    return `[${fmtPattern(group[0])}, '${group[1]}']`;
  }
  function fmtEnvInline(env) {
    // typed envelope dict form: {type: 'cubic', points: [[t,v], …]}
    if (isTypedEnv(env)) {
      const pts = env.points.map(fmtBP).join(", ");
      return `{type: ${env.type}, points: [${pts}]}`;
    }
    if (!Array.isArray(env)) return JSON.stringify(env);
    // Single compact block / BP group: emit bare form (no outer wrapping)
    if (env.length === 1 && isCompactBlock(env[0])) return fmtCompact(env[0]);
    if (env.length === 1 && isBPGroup(env[0])) return fmtBPGroup(env[0]);
    return "[" + env.map(it =>
      isBreakpoint(it) ? fmtBP(it) :
      isBPGroup(it)    ? fmtBPGroup(it) :
      fmtCompact(it)
    ).join(", ") + "]";
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
  function defaultCompactBlock(env, fallbackY, bounds) {
    // pattern triangolare di default; end_time = 1; n_reps = 4; linear/linear
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
      1, 4, "linear", "linear"
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
    isBreakpoint, isCompactBlock, envHasLoop,
    isBPGroup, envHasGroup, desugarBPGroups, resugarBPGroups,
    isTypedEnv, unwrapEnv, wrapEnv,
    computeCycleDurations, isPreviewFallback, expandMixed,
    TIME_DIST_NAMES, timeDistError, TIME_DIST_OVERFLOW_FIX,
    fmtEnvInline, fmtCompact, fmtBPGroup, fmtDist, fmtBP, fmtNum,
    parseEnvLiteral, normalizeEnv, defaultCompactBlock,
    pitchUnitSymbol,
    normalizePitchUnit, pitchToSemitones, semitonesToPitch,
    pitchUnitIsInteger, pitchUnitBounds, clampToBounds,
    convertPitchValue, convertPitchEnv,
    convertPitchRange, convertPitchRangeEnv,
  };
})();
