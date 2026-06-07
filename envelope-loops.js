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
    return { interp: "linear", items: Array.isArray(env) ? env.slice() : [] };
  }
  function wrapEnv(items, interp) {
    const hasLoop = items.some(isCompactBlock);
    // if any breakpoint has an explicit per-point type, keep flat array (3-tuples)
    const hasPerPoint = items.some((it) => Array.isArray(it) && it.length === 3 && typeof it[2] === "string");
    if (hasPerPoint) return items;
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

  function envHasLoop(env) {
    const items = isTypedEnv(env) ? env.points : env;
    return Array.isArray(items) && items.some(isCompactBlock);
  }

  /* ---------- distribuzioni temporali (time_distribution.py) ----------
     vincolo invariante: sum(cycleDurs) === T                              */
  function computeCycleDurations(T, N, dist) {
    if (T <= 0 || N < 1) return [];
    const type = typeof dist === "string" ? dist : (dist && dist.type) || "linear";
    const p    = (typeof dist === "object" && dist) ? dist : {};

    if (type === "linear") return new Array(N).fill(T / N);

    if (type === "exponential" || type === "exp") {
      const rate = p.rate != null ? +p.rate : 2.0;
      const w = []; let sum = 0;
      for (let i = 0; i < N; i++) { const x = Math.pow(rate, -i); w.push(x); sum += x; }
      return w.map(x => x / sum * T);
    }
    if (type === "logarithmic" || type === "log") {
      const base = p.base != null ? +p.base : 2.0;
      const w = []; let sum = 0;
      for (let i = 0; i < N; i++) { const x = Math.log(i + 1) / Math.log(base) + 1; w.push(x); sum += x; }
      return w.map(x => x / sum * T);
    }
    if (type === "geometric" || type === "geo") {
      const r = p.ratio != null ? +p.ratio : 1.5;
      if (Math.abs(r - 1) < 1e-9) return new Array(N).fill(T / N);
      const d0 = T * (1 - r) / (1 - Math.pow(r, N));
      return new Array(N).fill(0).map((_, i) => d0 * Math.pow(r, i));
    }
    if (type === "power") {
      const e = p.exponent != null ? +p.exponent : 2.0;
      const w = []; let sum = 0;
      for (let i = 0; i < N; i++) { const x = Math.pow(i + 1, e); w.push(x); sum += x; }
      return w.map(x => x / sum * T);
    }
    return new Array(N).fill(T / N);
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
  function fmtEnvInline(env) {
    // typed envelope dict form: {type: 'cubic', points: [[t,v], …]}
    if (isTypedEnv(env)) {
      const pts = env.points.map(fmtBP).join(", ");
      return `{type: ${env.type}, points: [${pts}]}`;
    }
    if (!Array.isArray(env)) return JSON.stringify(env);
    // Single compact block: emit bare form (no outer wrapping), per reference §2.4
    if (env.length === 1 && isCompactBlock(env[0])) return fmtCompact(env[0]);
    return "[" + env.map(it => isBreakpoint(it) ? fmtBP(it) : fmtCompact(it)).join(", ") + "]";
  }

  /* normalizza un valore parsato all'array di items mixed-format
     - bare compact `[pattern, end, n, …]` → `[compact]`
     - resto invariato                                                   */
  function normalizeEnv(parsed) {
    if (!Array.isArray(parsed)) return parsed;
    if (isCompactBlock(parsed)) return [parsed];
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
  // convert a single scalar between two pitch units, applying the integer
  // rule of the destination unit
  function convertPitchValue(value, fromUnit, toUnit, fromEdoDiv, toEdoDiv) {
    if (value == null) return value;
    const st = pitchToSemitones(value, fromUnit, fromEdoDiv);
    let out = semitonesToPitch(st, toUnit, toEdoDiv);
    if (pitchUnitIsInteger(toUnit)) out = Math.round(out);
    else out = +out.toFixed(4);
    return out;
  }
  // remap envelope breakpoints [[x, y], …] — only y (the pitch value) is
  // rescaled; x (the time axis) is untouched
  function convertPitchEnv(env, fromUnit, toUnit, fromEdoDiv, toEdoDiv) {
    if (!Array.isArray(env)) return env;
    return env.map(bp =>
      (Array.isArray(bp) && bp.length >= 2)
        ? [bp[0], convertPitchValue(bp[1], fromUnit, toUnit, fromEdoDiv, toEdoDiv), ...bp.slice(2)]
        : bp);
  }

  window.PGEEnv = {
    DISCONTINUITY_OFFSET,
    isBreakpoint, isCompactBlock, envHasLoop,
    isTypedEnv, unwrapEnv, wrapEnv,
    computeCycleDurations, expandMixed,
    fmtEnvInline, fmtCompact, fmtDist, fmtBP, fmtNum,
    parseEnvLiteral, normalizeEnv, defaultCompactBlock,
    pitchUnitSymbol,
    normalizePitchUnit, pitchToSemitones, semitonesToPitch,
    pitchUnitIsInteger, convertPitchValue, convertPitchEnv,
  };
})();
