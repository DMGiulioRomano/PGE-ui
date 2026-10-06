/* @jsx React.createElement */
const { useState: useStateYE, useRef: useRefYE, useMemo: useMemoYE, useEffect: useEffectYE } = React;

/* -------- presentation layer --------
   The Raw tab no longer serializes or parses YAML itself: yaml-bridge.js
   (window.PGEYaml.serializeStream / parseStream) is the single source of
   truth. The helpers below only (1) re-color the text the bridge produced
   and (2) compute validation annotations over the stream — neither emits or
   reads YAML, so they can't drift from the save path. #42 */

// Classify a single scalar token into one of the existing CSS classes
// (s=string, v=number/bool/null, r=raw/other). Used by tokenizeYamlLine.
function classifyScalar(val) {
  if (/^["']/.test(val)) return { cls: "s", text: val };
  if (val === "true" || val === "false" || val === "null" || val === "~") return { cls: "v", text: val };
  if (/^-?\d/.test(val)) return { cls: "v", text: val };
  return { cls: "r", text: val };
}

// Tokenize ONE already-serialized YAML line into colored spans. This is pure
// presentation — it never re-derives YAML. Returns { indent, spans, key }.
// `key` is the mapping key on the line (or null) so annotations can attach.
function tokenizeYamlLine(rawLine) {
  const indent = (rawLine.match(/^\s*/) || [""])[0];
  let rest = rawLine.slice(indent.length);
  if (!rest) return { indent, spans: [], key: null };
  if (rest.startsWith("#")) return { indent, spans: [{ cls: "c", text: rest }], key: null };

  const spans = [];
  // leading block-sequence dashes ("- ", possibly nested "- - ")
  while (rest.startsWith("- ")) { spans.push({ cls: "", text: "- " }); rest = rest.slice(2); }
  if (rest === "-") { spans.push({ cls: "", text: "-" }); return { indent, spans, key: null }; }

  // `key:` (block header) or `key: value`
  const kv = rest.match(/^([A-Za-z_][\w]*):(?:\s+(.*))?$/);
  if (kv) {
    const key = kv[1];
    spans.push({ cls: "k", text: key });
    spans.push({ cls: "", text: ":" });
    if (kv[2] != null && kv[2] !== "") {
      spans.push({ cls: "", text: " " });
      spans.push(classifyScalar(kv[2]));
    }
    return { indent, spans, key };
  }
  // bare scalar (block-sequence item value, e.g. "0" / "20")
  spans.push(classifyScalar(rest));
  return { indent, spans, key: null };
}

// The dotted YAML path of every line of the text the bridge emitted, or null
// for a line that carries no key (a block-sequence item, a comment). The path
// comes from the indentation: a line's parents are the keys above it with a
// smaller column. A key after "- " sits at the column of its dash plus two,
// which is where YAML puts the mapping it opens. #180: annotations used to
// attach to the first line with the same BARE key, so an error on
// `grain.duration` landed on the stream's own `duration:`, and one on
// `deviation_probability.pan` on the top-level `pan:`.
function yamlLinePaths(lines) {
  const stack = [];            // [{ col, key }]
  return lines.map((raw) => {
    const tok = tokenizeYamlLine(raw);
    if (!tok.key) return null;
    const dashes = (raw.slice(tok.indent.length).match(/^(- )*/) || [""])[0].length;
    const col = tok.indent.length + dashes;
    while (stack.length && stack[stack.length - 1].col >= col) stack.pop();
    stack.push({ col, key: tok.key });
    return stack.map((f) => f.key).join(".");
  });
}

// A value as the author wrote it: JSON for structures, but numbers printed as
// numbers, or `.nan` / `.inf` would read `null`.
function fmtShapeValue(v) {
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

// The sentence for one envShapeError (window.PGEEnv, envelope-loops.js). The
// rule lives in the mirror; this is only its wording for the Raw tab — the
// EnvelopeEditor words the same error in its own panel.
function shapeErrorText(e) {
  const v = fmtShapeValue(e.value);
  switch (e.where) {
    case "point":
      return `element ${e.index} is not a breakpoint [t, v] / [t, v, type], a BP group or a compact block: ${v}`;
    case "group.interp":
      return `BP group interp ${v} is not one of ${window.PGEEnv.INTERP_TYPES.join(", ")}`;
    case "group.points":
      return "a BP group needs at least 2 points — a single point is written as a bare breakpoint [t, v]";
    case "compact.n_reps":
      return `n_reps (3rd element of the compact block) must be an integer ≥ 1 — got ${v}${typeof e.value === "boolean" ? " (true is not 1)" : ""}`;
    case "compact.end_time":
      return e.why === "offset"
        ? `end_time ${v} must be past the block start (${+e.start.toFixed(6)}) — it is an absolute time, not a duration`
        : `end_time (2nd element of the compact block) must be a finite number — got ${v}`;
    case "compact.pattern":
      if (e.why === "empty") return "the compact block's pattern is empty";
      if (e.why === "range") return `pattern point ${e.point}: x = ${v} is outside [0, 100] (a percentage of the cycle)`;
      if (e.why === "order") return `pattern point ${e.point}: x = ${v} goes backwards — a repeated x is fine, a smaller one is not`;
      return `pattern point ${e.point} must be [x%, y] or [x%, y, type] with numbers (true is not 1) — got ${v}`;
    case "compact.time_dist": {
      const d = e.dist || {};
      if (d.kind === "overflow")
        return `time_dist ${d.name}: ${d.param}=${d.value} with n_reps=${d.nReps} overflows a float`;
      if (d.kind === "param")
        return `time_dist ${d.name}: parameter "${d.param}" is not valid`;
      return `time_dist ${v} is not a known distribution (${window.PGEEnv.TIME_DIST_NAMES.join(", ")})`;
    }
    default:
      return `malformed envelope: ${v}`;
  }
}

// Validation annotations computed from the stream (not from emitter internals).
// Returns { byPath: Map<dotted YAML path, {kind:"err"|"warn", msg}> }; the
// component attaches each to the serialized line with that path
// (yamlLinePaths). Mirrors the three checks the old buildLines did inline
// (sample / loop bounds / pan), #42, plus the shape of every envelope, #180.
function computeAnnotations(stream, sampleRec) {
  const byPath = new Map();
  if (!sampleRec) {
    byPath.set("sample", { kind: "err", msg: `sample not found: ${stream.sample}` });
  } else {
    const ptr = stream.pointer || {};
    // Il tetto della finestra di loop NON e' la durata del sample: e' la durata
    // nell'UNITA' in vigore. `loop_unit` (PGE #222, #149) decide se questi
    // numeri sono secondi — e allora il tetto e' sample_dur — oppure
    // [0,1] × sample_dur, dove il tetto e' 1 e la durata del file nel confronto
    // non entra affatto. Misurato in secondi, il controllo sbagliava in
    // entrambe le direzioni: rosso su `loop_end: 0.9` normalized (= 0.36 s) di
    // un sample da 0.4 — cioe' su ogni clip nato nell'editor, che
    // `loop_unit: normalized` ce l'ha sempre — e silenzio su `loop_end: 5`
    // normalized, cinque volte oltre la fine del file. Ed era la stessa unita'
    // fissa che l'Inspector ha smesso di dichiarare: un rosso qui contro il
    // suffisso unit-aware della riga di la' sono due affermazioni opposte.
    // Il tetto viene da loopEnvMax, la sorgente unica gia' letta dall'Inspector
    // e dall'EnvelopeEditor, non da una seconda copia della regola.
    // …e la grafia dell'unita' viene prima del tetto, perche' e' il tetto a
    // dipendere da lei. Fuori dal vocabolario (PGE #222) il motore alza
    // InvalidFieldValueError sull'unita' senza mai guardare la finestra, e
    // loopUnitInfo legge quella grafia come assoluta PER ESCLUSIONE: misurare
    // in secondi darebbe un rosso che dichiara un'unita' diversa da quella
    // scritta, mentre la tab Preview su quelle stesse righe non mette nemmeno
    // la «s» (loopUnitSuffix tace apposta). Quindi il rosso qui e' quello vero
    // — l'unita' — e il controllo sulla finestra tace, che e' la stessa regola
    // del cap ignoto tre righe piu' giu'.
    const loopUnitErr = window.PGEEnvUtils.loopUnitError(ptr);
    if (loopUnitErr) {
      byPath.set("pointer.loop_unit", { kind: "err",
        msg: `loop_unit: ${JSON.stringify(loopUnitErr.value)} is not a recognized unit — the engine rejects the stream (${loopUnitErr.units.join(", ")})` });
    }
    const loopCap = window.PGEEnvUtils.loopEnvMax(stream, sampleRec.duration);
    const loopNormalized = window.PGEEnvUtils.loopUnitInfo(stream).unit === "normalized";
    // loopCap null = secondi con la durata ignota: non c'e' niente contro cui
    // misurare, e un controllo che non sa tace.
    const capMsg = loopNormalized
      ? "1 (loop_unit: normalized — coordinates are [0,1] × sample duration)"
      : `sample duration (${loopCap != null ? loopCap.toFixed(3) : "?"} s)`;
    const overCap = (v) => !loopUnitErr && loopCap != null && v > loopCap;
    if (!ptr.loopEndEnv && ptr.loopEnd != null && overCap(ptr.loopEnd)) {
      byPath.set("pointer.loop_end", { kind: "err", msg: `loop_end must be ≤ ${capMsg}` });
    }
    if (!ptr.loopDurEnv && ptr.loopDur != null && overCap(ptr.loopDur)) {
      byPath.set("pointer.loop_dur", { kind: "err", msg: `loop_dur must be ≤ ${capMsg}` });
    }
  }
  // Le y SCRITTE del pan, in ogni grafia: il dict `{type, points}` (che wrapEnv
  // scrive per ogni interp globale non lineare, eccezioni sul punto comprese,
  // da #189), i gruppi, i punti `{t, v}` e i pattern dei blocchi. Il controllo
  // guardava le sole liste, e un pan ritoccato con setZoneInterp ne usciva.
  // Niente expandMixed: un blocco ripete le y del suo pattern e basta, e
  // espanderlo costerebbe n_reps cicli a ogni tasto del tab Raw.
  const E = window.PGEEnv;
  const panYs = stream.panEnv
    ? E.desugarBPGroups(E.unwrapEnv(stream.panEnv).items).flatMap((it) =>
        E.isCompactBlock(it) ? it[0].map((p) => p[1]) : (E.bpAt(it) ? [E.bpAt(it)[1]] : []))
    : [];
  if (panYs.some(y => Math.abs(y) > 3600)) {
    byPath.set("pan", { kind: "warn", msg: "pan values exceed conventional range [−3600, 3600]" });
  }
  // La forma di ogni envelope, come la giudica il builder del motore (PGE
  // #211): la regola e' PGEEnv.envShapeError, gli envelope e il loro path YAML
  // li dice il catalogo — lo stesso che l'EnvelopeEditor apre. Le voci inerti
  // restano fuori: il motore non le costruisce, quindi non le rifiuta, e un
  // rosso li' direbbe il falso. Un errore di forma vince sul warn del pan: e'
  // il motivo per cui il render non parte.
  const sampleDur = sampleRec ? sampleRec.duration : undefined;
  for (const entry of window.PGEEnvCatalog.listEnvelopes(stream, sampleDur)) {
    if (entry.inert) continue;
    const env = entry.path.reduce((o, k) => (o == null ? o : o[k]), stream);
    const err = window.PGEEnv.envShapeError(env);
    if (err) byPath.set(entry.yaml, { kind: "err",
      msg: `${entry.yaml}: ${shapeErrorText(err)} — the engine rejects the stream` });
  }
  return { byPath };
}

// Expose the pure (JSX-free) presentation helpers so node tests can exercise
// them. Harmless in the browser. #42
window.PGE = window.PGE || {};
window.PGE.tokenizeYamlLine = tokenizeYamlLine;
window.PGE.yamlLinePaths = yamlLinePaths;
window.PGE.computeAnnotations = computeAnnotations;

/* ==== node-test boundary: everything above is JSX-free and reusable ==== */
function YamlEditor({ stream, onChange, samples }) {
  const { Icon } = window.PGE;
  const _samples = samples || [];
  const sampleRec = _samples.find(s => s.name === stream.sample);

  // Single source of truth: the bridge serializes the stream; we only tokenize
  // its output for coloring and compute annotations alongside.
  const generated = useMemoYE(() => window.PGEYaml.serializeStream(stream), [stream]);
  const tokens = useMemoYE(() => generated.split("\n").map(tokenizeYamlLine), [generated]);
  const linePaths = useMemoYE(() => yamlLinePaths(generated.split("\n")), [generated]);
  const annotations = useMemoYE(() => computeAnnotations(stream, sampleRec), [stream, sampleRec]);

  const [mode, setMode] = useStateYE("view"); // 'view' | 'edit'
  const [draft, setDraft] = useStateYE(generated);
  const [parseErr, setParseErr] = useStateYE(null);

  // when stream updates from outside (e.g. timeline drag) and we're not editing, refresh draft.
  useEffectYE(() => { if (mode === "view") setDraft(generated); }, [generated, mode]);

  const dirty = mode === "edit" && draft !== generated;

  function applyEdits() {
    try {
      // parseStream returns the FULL stream shape. solo/mute now round-trip
      // through the YAML (#63), so they come from `parsed` — editing them in the
      // Raw tab takes effect. Only `color` (synthesized by streamFromYaml, never
      // in the YAML) and `id` (identity, kept stable even if stream_id is
      // blanked) are preserved from the live stream. updateStream in app.jsx
      // does a shallow {...s, ...patch}, so a complete object is safe. #42
      // La media list serve al parse quanto al progetto intero: senza, uno
      // stream che omette `duration` tornerebbe qui marcato irrisolto (#117).
      const parsed = window.PGEYaml.parseStream(draft, 0, { samples: _samples });
      onChange && onChange({
        ...parsed,
        color: stream.color,   // synthesized by streamFromYaml, never in YAML
        id:    stream.id,       // keep identity stable even if stream_id blanked
        // Provenienza sintetizzata dal parse, come color/id: la regola sta nel
        // bridge (una sola copia, testata direttamente li').
        deviationProbabilityLegacy: window.PGEYaml.mergeDeviationProbabilityLegacy(parsed, stream),
      });
      setParseErr(null);
      setMode("view");
    } catch (e) {
      setParseErr(e.message || String(e));
    }
  }

  function discardEdits() {
    setDraft(generated);
    setParseErr(null);
    setMode("view");
  }

  // render highlighted view from the bridge text + annotations
  const ann = annotations.byPath;
  const usedPaths = new Set();
  let errCount = 0, warnCount = 0, firstErrLine = -1;
  const rendered = [];
  tokens.forEach((tok, i) => {
    let a = null;
    const p = linePaths[i];
    if (p && ann.has(p) && !usedPaths.has(p)) {
      a = ann.get(p);
      usedPaths.add(p);
    }
    const isErr = a && a.kind === "err";
    const isWarn = a && a.kind === "warn";
    if (isErr) { errCount += 1; if (firstErrLine < 0) firstErrLine = i; }
    if (isWarn) warnCount += 1;
    const cls = ["ln", isErr ? "has-err" : "", isWarn ? "has-warn" : "", i === firstErrLine ? "cur" : ""].filter(Boolean).join(" ");
    rendered.push(
      <div key={"l"+i} className={cls}>
        <span className="num">{i + 1}</span>
        <span className="gutter-marker" />
        <span className="src">
          {tok.indent}
          {tok.spans.map((sp, j) => sp.cls
            ? <span key={j} className={sp.cls}>{sp.text}</span>
            : <span key={j}>{sp.text}</span>)}
        </span>
      </div>
    );
    if (isErr) {
      rendered.push(
        <div key={"e"+i} className="errpop">
          <Icon name="x" size={11} />
          <span>{a.msg}</span>
        </div>
      );
    }
    if (isWarn) {
      rendered.push(
        <div key={"w"+i} className="warnpop">
          <span>⚠</span>
          <span>{a.msg}</span>
        </div>
      );
    }
  });

  const editLineCount = draft.split("\n").length;
  const editLineNums = Array.from({ length: editLineCount }, (_, i) => i + 1).join("\n");

  return (
    <div className="pge-yaml">
      <div className="head">
        <Icon name="code" size={12} />
        <span className="t">stream "{stream.id}"</span>
        <span>·</span><span>raw yaml</span>
        <span style={{ flex: 1 }} />
        {mode === "edit" ? (
          <>
            {parseErr ? <span className="err" title={parseErr}>● parse error</span> : null}
            <button className="yaml-btn" onClick={discardEdits} title="Discard">cancel</button>
            <button className={"yaml-btn primary" + (dirty ? "" : " disabled")} onClick={applyEdits} disabled={!dirty} title="Apply changes">apply</button>
          </>
        ) : (
          <>
            {errCount > 0 ? <span className="err">● {errCount} error{errCount>1?"s":""}</span> :
             warnCount > 0 ? <span className="acc">{warnCount} warning{warnCount>1?"s":""}</span> :
             <span className="acc">valid</span>}
            <button className="yaml-btn" onClick={() => { setDraft(generated); setMode("edit"); }} title="Edit YAML">
              <Icon name="edit" size={12} /> edit
            </button>
          </>
        )}
      </div>
      {mode === "view" ? (
        <div className="body">{rendered}</div>
      ) : (
        <div className="body editing">
          <pre className="edit-gutter" aria-hidden="true">{editLineNums}</pre>
          <textarea
            className="edit-area"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onScroll={(e) => {
              const g = e.target.parentElement.querySelector(".edit-gutter");
              if (g) g.scrollTop = e.target.scrollTop;
            }}
          />
        </div>
      )}
      <div className="footer">
        <span>YAML · UTF-8 · LF</span>
        <span style={{flex:1}} />
        {mode === "edit" && dirty ? <span className="acc">● modified</span> : null}
        {mode === "view" && errCount > 0 ? <span className="err-count">✕ {errCount}</span> : null}
        {mode === "view" && warnCount > 0 ? <span className="warn-count">⚠ {warnCount}</span> : null}
        {mode === "view" && errCount === 0 && warnCount === 0 ? <span style={{color:"var(--status-ok)"}}>● ready</span> : null}
        <span>{mode === "edit" ? `Ln 1, Col 1 · ${editLineCount} lines` : `Ln ${tokens.length}, Col 1`}</span>
      </div>
    </div>
  );
}
window.PGE = window.PGE || {};
window.PGE.YamlEditor = YamlEditor;
