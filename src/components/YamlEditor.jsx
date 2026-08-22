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

// Validation annotations computed from the stream (not from emitter internals).
// Returns { byKey: Map<yamlKey, {kind:"err"|"warn", msg}> }; the component
// attaches each to the first serialized line carrying that key. Mirrors the
// three checks the old buildLines did inline (sample / loop bounds / pan). #42
function computeAnnotations(stream, sampleRec) {
  const byKey = new Map();
  if (!sampleRec) {
    byKey.set("sample", { kind: "err", msg: `sample not found: ${stream.sample}` });
  } else {
    const ptr = stream.pointer || {};
    if (!ptr.loopEndEnv && ptr.loopEnd != null && ptr.loopEnd > sampleRec.duration) {
      byKey.set("loop_end", { kind: "err", msg: `loop_end must be ≤ sample duration (${sampleRec.duration.toFixed(3)} s)` });
    }
    if (!ptr.loopDurEnv && ptr.loopDur != null && ptr.loopDur > sampleRec.duration) {
      byKey.set("loop_dur", { kind: "err", msg: `loop_dur must be ≤ sample duration (${sampleRec.duration.toFixed(3)} s)` });
    }
  }
  if (Array.isArray(stream.panEnv) && stream.panEnv.some(p => Math.abs(p[1]) > 3600)) {
    byKey.set("pan", { kind: "warn", msg: "pan values exceed conventional range [−3600, 3600]" });
  }
  return { byKey };
}

// Expose the pure (JSX-free) presentation helpers so node tests can exercise
// them. Harmless in the browser. #42
window.PGE = window.PGE || {};
window.PGE.tokenizeYamlLine = tokenizeYamlLine;
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
        // Il flag e' l'OR fra quello che il draft dichiara e quello che il file
        // su disco porta ancora, perche' la grafia morta puo' entrare da tutte
        // e due le parti.
        //
        // Da destra: `generated` riserializza lo stream sotto la chiave viva,
        // quindi `dephase` non e' MOSTRATO qui e un ri-parse nudo leggerebbe
        // false — mentre il file su disco porta ancora la grafia morta e la
        // riscrittura e' da fare. Quel ramo si spegne solo se la deviazione
        // sparisce del tutto: senza valore non c'e' nessuna chiave da
        // riscrivere, e l'avviso non avrebbe piu' niente da annunciare.
        //
        // Da sinistra: non mostrato non e' non scrivibile. La textarea e'
        // libera, e chi ha in mano un progetto pre-v7 la grafia morta la
        // conosce: digitando `dephase: 99` qui si introduce la chiave che il
        // motore non legge, e senza questo ramo il salvataggio la riscriverebbe
        // in silenzio — il guasto stesso della #130, sull'unica superficie dove
        // `dephase` e' ancora digitabile. L'OR non contraddice l'altro ramo:
        // con la chiave presente readDeviationProbability restituisce il valore
        // o la sentinella, mai undefined, quindi `parsed.…Legacy === true`
        // implica sempre `parsed.deviationProbability !== undefined`.
        deviationProbabilityLegacy:
          parsed.deviationProbabilityLegacy ||
          (!!stream.deviationProbabilityLegacy && parsed.deviationProbability !== undefined),
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
  const ann = annotations.byKey;
  const usedKeys = new Set();
  let errCount = 0, warnCount = 0, firstErrLine = -1;
  const rendered = [];
  tokens.forEach((tok, i) => {
    let a = null;
    if (tok.key && ann.has(tok.key) && !usedKeys.has(tok.key)) {
      a = ann.get(tok.key);
      usedKeys.add(tok.key);
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
