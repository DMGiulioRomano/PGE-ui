/* @jsx React.createElement */
const { useState: useStateYE, useRef: useRefYE, useMemo: useMemoYE, useEffect: useEffectYE } = React;

/* -------- helpers --------
   Delegated to window.PGEEnv (envelope-loops.js) to handle both
   standard breakpoints [t,v] and compact loop blocks. */
const fmtNum    = (n) => window.PGEEnv.fmtNum(n);
const envInline = (env) => window.PGEEnv.fmtEnvInline(env);
const fmtEnvelope = (env) => {
  if (!env || typeof env === "string") return env || "hanning";
  return window.jsyaml.dump(env, { flowLevel: 0, lineWidth: -1 }).trim();
};

/* Build the structured line model — used by both highlighted view and the textarea. */
function buildLines(stream, sampleRec) {
  const sampleMissing = !sampleRec;
  const lines = [];
  const push = (o) => lines.push(o);
  push({ ind: 0, kind: "comment", text: `# stream "${stream.id}" — auto-rendered from project` });
  push({ ind: 0, kind: "s", key: "stream_id", val: `"${stream.id}"` });
  if (stream.timeMode) push({ ind: 0, kind: "r", key: "time_mode", val: stream.timeMode });
  push({ ind: 0, kind: "v", key: "onset", val: fmtNum(stream.onset) });
  push({ ind: 0, kind: "v", key: "duration", val: fmtNum(stream.duration) });
  push({ ind: 0, kind: "s", key: "sample", val: `"${stream.sample}"`, err: sampleMissing ? `sample not found: ${stream.sample}` : null });
  if (stream.mute) push({ ind: 0, kind: "flag", key: "mute" });
  if (stream.solo) push({ ind: 0, kind: "flag", key: "solo" });
  if (stream.distributionMode) push({ ind: 0, kind: "s", key: "distribution_mode", val: `'${stream.distributionMode}'` });

  if (stream.fillFactor != null) push({ ind: 0, kind: "v", key: "fill_factor", val: fmtNum(stream.fillFactor) });
  else if (stream.densityEnv) push({ ind: 0, kind: "raw", key: "density", val: envInline(stream.densityEnv) });
  else if (stream.density != null) push({ ind: 0, kind: "v", key: "density", val: fmtNum(stream.density) });

  if (stream.distributionEnv) push({ ind: 0, kind: "raw", key: "distribution", val: envInline(stream.distributionEnv) });
  else if (stream.distribution != null) push({ ind: 0, kind: "v", key: "distribution", val: fmtNum(stream.distribution) });

  push({ ind: 0, kind: "block", key: "pointer" });
  if (stream.pointer.speedRatioEnv) push({ ind: 1, kind: "raw", key: "speed_ratio", val: envInline(stream.pointer.speedRatioEnv) });
  else if (stream.pointer.speedRatio != null) push({ ind: 1, kind: "v", key: "speed_ratio", val: fmtNum(stream.pointer.speedRatio) });
  if (stream.pointer.loopStart != null || stream.pointer.loopStartEnv) {
    if (stream.pointer.loopStartEnv) push({ ind: 1, kind: "raw", key: "loop_start", val: envInline(stream.pointer.loopStartEnv) });
    else push({ ind: 1, kind: "v", key: "loop_start", val: fmtNum(stream.pointer.loopStart) });
    if (stream.pointer.loopEnd != null) {
      push({ ind: 1, kind: "v", key: "loop_end", val: fmtNum(stream.pointer.loopEnd),
        err: (sampleRec && stream.pointer.loopEnd > sampleRec.duration) ? `loop_end must be ≤ sample duration (${sampleRec.duration.toFixed(3)} s)` : null });
    } else if (stream.pointer.loopDurEnv) {
      push({ ind: 1, kind: "raw", key: "loop_duration", val: envInline(stream.pointer.loopDurEnv) });
    } else if (stream.pointer.loopDur != null) {
      push({ ind: 1, kind: "v", key: "loop_dur", val: fmtNum(stream.pointer.loopDur),
        err: (sampleRec && stream.pointer.loopDur > sampleRec.duration) ? `loop_dur must be ≤ sample duration (${sampleRec.duration.toFixed(3)} s)` : null });
    }
    if (stream.pointer.loopUnit) push({ ind: 1, kind: "r", key: "loop_unit", val: stream.pointer.loopUnit });
  }
  if (stream.pointer.offsetRange != null) push({ ind: 1, kind: "v", key: "offset_range", val: fmtNum(stream.pointer.offsetRange) });

  push({ ind: 0, kind: "block", key: "grain" });
  if (stream.grain.durationEnv) push({ ind: 1, kind: "raw", key: "duration", val: envInline(stream.grain.durationEnv) });
  else if (stream.grain.duration != null) push({ ind: 1, kind: "v", key: "duration", val: fmtNum(stream.grain.duration) });
  if (stream.grain.durationRange) push({ ind: 1, kind: "v", key: "duration_range", val: fmtNum(stream.grain.durationRange) });
  push({ ind: 1, kind: "r", key: "envelope", val: fmtEnvelope(stream.grain.envelope) });

  if (stream.pitch && (stream.pitch.valueEnv || stream.pitch.value != null)) {
    const pu = stream.pitch.unit || "semitones";
    const _safeNum = (n) => typeof n === "number" ? fmtNum(n) : fmtNum(0);
    push({ ind: 0, kind: "block", key: "pitch" });
    if (pu === "edo") {
      push({ ind: 1, kind: "v", key: "edo", val: String(stream.pitch.edoDivisions || 12) });
      if (stream.pitch.valueEnv) push({ ind: 1, kind: "raw", key: "value", val: envInline(stream.pitch.valueEnv) });
      else push({ ind: 1, kind: "v", key: "value", val: _safeNum(stream.pitch.value) });
    } else {
      if (stream.pitch.valueEnv) push({ ind: 1, kind: "raw", key: pu, val: envInline(stream.pitch.valueEnv) });
      else push({ ind: 1, kind: "v", key: pu, val: _safeNum(stream.pitch.value) });
    }
    if (stream.pitch.range) push({ ind: 1, kind: "v", key: "range", val: _safeNum(stream.pitch.range) });
  }

  if (stream.panEnv) push({ ind: 0, kind: "raw", key: "pan", val: envInline(stream.panEnv),
    warn: stream.panEnv.some(p => Math.abs(p[1]) > 90) ? "pan values exceed conventional range [−90, 90]" : null });
  else if (stream.pan != null) push({ ind: 0, kind: "v", key: "pan", val: fmtNum(stream.pan) });
  if (stream.panRange) push({ ind: 0, kind: "v", key: "pan_range", val: fmtNum(stream.panRange) });

  if (stream.volumeEnv) push({ ind: 0, kind: "raw", key: "volume", val: envInline(stream.volumeEnv) });
  else push({ ind: 0, kind: "v", key: "volume", val: fmtNum(stream.volume) });
  if (stream.volumeRange) push({ ind: 0, kind: "v", key: "volume_range", val: fmtNum(stream.volumeRange) });

  if (stream.dephase !== undefined) {
    if (stream.dephase === false) {
      push({ ind: 0, kind: "v", key: "dephase", val: "false" });
    } else if (stream.dephase === null) {
      push({ ind: 0, kind: "v", key: "dephase", val: "null" });
    } else if (typeof stream.dephase === "number") {
      push({ ind: 0, kind: "v", key: "dephase", val: fmtNum(stream.dephase) });
    } else if (Array.isArray(stream.dephase)) {
      push({ ind: 0, kind: "raw", key: "dephase", val: envInline(stream.dephase) });
    } else if (typeof stream.dephase === "object") {
      push({ ind: 0, kind: "block", key: "dephase" });
      Object.entries(stream.dephase).forEach(([k, v]) => {
        if (Array.isArray(v)) push({ ind: 1, kind: "raw", key: k, val: envInline(v) });
        else push({ ind: 1, kind: "v", key: k, val: fmtNum(v) });
      });
    }
  }

  const vo = stream.voices || {};
  const voNum = vo.num != null ? vo.num : (vo.numEnv ? null : 1);
  const hasVoices = (voNum != null && voNum > 1) || vo.numEnv || vo.scatterEnv || vo.scatter != null || vo.pitch || vo.onset_offset || vo.pointer || vo.pan;
  if (hasVoices) {
    push({ ind: 0, kind: "block", key: "voices" });
    if (vo.numEnv) push({ ind: 1, kind: "raw", key: "num_voices", val: envInline(vo.numEnv) });
    else push({ ind: 1, kind: "v", key: "num_voices", val: String(voNum ?? 1) });
    if (vo.scatterEnv) push({ ind: 1, kind: "raw", key: "scatter", val: envInline(vo.scatterEnv) });
    else if (vo.scatter != null) push({ ind: 1, kind: "v", key: "scatter", val: fmtNum(vo.scatter) });
    const vDims = [
      { key: "pitch",        data: vo.pitch },
      { key: "onset_offset", data: vo.onset_offset },
      { key: "pointer",      data: vo.pointer },
      { key: "pan",          data: vo.pan },
    ];
    for (const { key, data } of vDims) {
      if (!data || typeof data !== "object") continue;
      push({ ind: 1, kind: "block", key });
      for (const [k, val] of Object.entries(data)) {
        if (k.endsWith("Env")) continue;        // handled via base key below
        const envVal = data[k + "Env"];
        if (envVal != null) {
          push({ ind: 2, kind: "raw", key: k, val: envInline(envVal) });
        } else {
          if (val == null) continue;
          if (typeof val === "number") {
            push({ ind: 2, kind: "v", key: k, val: fmtNum(val) });
          } else if (typeof val === "string") {
            push({ ind: 2, kind: "r", key: k, val });
          } else if (typeof val === "object") {
            push({ ind: 2, kind: "r", key: k,
                   val: window.jsyaml.dump(val, { flowLevel: 0, lineWidth: -1 }).trim() });
          } else {
            push({ ind: 2, kind: "v", key: k, val: String(val) });
          }
        }
      }
    }
  }

  return lines;
}

function linesToText(lines) {
  return lines.map(ln => {
    const ind = "  ".repeat(ln.ind || 0);
    if (ln.kind === "comment") return ind + ln.text;
    if (ln.kind === "block") return ind + ln.key + ":";
    if (ln.kind === "flag") return ind + ln.key + ":";
    return ind + ln.key + ": " + ln.val;
  }).join("\n");
}

/* Lightweight YAML parser — handles the schema we emit:
   key: scalar | key: "str" | key: 'str' | key: [[..],[..]] (env) | key: (block).
   Returns the same {streamPatch, pointerPatch, grainPatch, pitchPatch} structure as our stream model.
   Unknown keys are ignored. */
function parseYaml(text) {
  const out = { patch: {}, pointer: {}, grain: {}, pitch: {} };
  let section = null; // null | 'pointer' | 'grain' | 'pitch' | 'dephase'
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^ */)[0].length;
    const body = raw.trim();
    // section header (no value after colon) — also handles bare 'mute:' / 'solo:' flags
    const sectionMatch = body.match(/^([a-z_]+):\s*$/);
    if (indent === 0 && sectionMatch) {
      const sect = sectionMatch[1];
      if (sect === "mute") { out.patch.mute = true; section = null; continue; }
      if (sect === "solo") { out.patch.solo = true; section = null; continue; }
      section = (sect === "pointer" || sect === "grain" || sect === "pitch" || sect === "dephase") ? sect : null;
      continue;
    }
    if (indent === 0) section = null; // a top-level key clears section
    const kv = body.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const valStr = kv[2].trim();
    const parsed = parseValue(valStr);
    if (parsed === undefined) continue;

    if (section === "pointer") {
      if (key === "speed_ratio") {
        if (Array.isArray(parsed)) { out.pointer.speedRatio = null; out.pointer.speedRatioEnv = parsed; }
        else { out.pointer.speedRatio = parsed; out.pointer.speedRatioEnv = null; }
      } else if (key === "loop_start") out.pointer.loopStart = parsed;
      else if (key === "loop_dur") out.pointer.loopDur = parsed;
    } else if (section === "grain") {
      if (key === "duration") {
        if (Array.isArray(parsed)) { out.grain.duration = null; out.grain.durationEnv = parsed; }
        else { out.grain.duration = parsed; out.grain.durationEnv = null; }
      } else if (key === "duration_range") out.grain.durationRange = parsed;
      else if (key === "envelope") out.grain.envelope = typeof parsed === "string" ? parsed.replace(/^['"]|['"]$/g, "") : parsed;
    } else if (section === "pitch") {
      const UNITS = ["semitones", "cents", "quarter_tone", "eighth_tone", "ratio"];
      if (UNITS.includes(key)) {
        out.pitch.unit = key;
        if (Array.isArray(parsed)) { out.pitch.value = null; out.pitch.valueEnv = parsed; }
        else { out.pitch.value = parsed; out.pitch.valueEnv = null; }
      } else if (key === "edo") {
        out.pitch.unit = "edo";
        out.pitch.edoDivisions = parsed;
      } else if (key === "value") {
        if (Array.isArray(parsed)) { out.pitch.value = null; out.pitch.valueEnv = parsed; }
        else { out.pitch.value = parsed; out.pitch.valueEnv = null; }
      } else if (key === "range") out.pitch.range = parsed;
    } else {
      // top-level
      if (key === "stream_id") out.patch.id = String(parsed).replace(/^['"]|['"]$/g, "");
      else if (key === "time_mode") out.patch.timeMode = String(parsed);
      else if (key === "onset") out.patch.onset = parsed;
      else if (key === "duration") out.patch.duration = parsed;
      else if (key === "sample") out.patch.sample = String(parsed).replace(/^['"]|['"]$/g, "");
      else if (key === "distribution_mode") out.patch.distributionMode = String(parsed).replace(/^['"]|['"]$/g, "");
      else if (key === "density") {
        if (Array.isArray(parsed)) { out.patch.density = null; out.patch.densityEnv = parsed; }
        else { out.patch.density = parsed; out.patch.densityEnv = null; }
      } else if (key === "distribution") {
        if (Array.isArray(parsed)) { out.patch.distribution = null; out.patch.distributionEnv = parsed; }
        else { out.patch.distribution = parsed; out.patch.distributionEnv = null; }
      } else if (key === "pan") {
        if (Array.isArray(parsed)) { out.patch.pan = null; out.patch.panEnv = parsed; }
        else { out.patch.pan = parsed; out.patch.panEnv = null; }
      } else if (key === "pan_range") out.patch.panRange = parsed;
      else if (key === "volume") out.patch.volume = parsed;
      else if (key === "volume_range") out.patch.volumeRange = parsed;
    }
  }
  return out;
}

function parseValue(s) {
  if (!s) return undefined;
  // env array [[..],[..]] / compact / typed dict {type: ..., points: [...]}
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const v = window.PGEEnv.parseEnvLiteral(s);
      return window.PGEEnv.normalizeEnv(v); // bare compact → wrapped [compact]
    } catch (e) { return undefined; }
  }
  // quoted string
  if (/^['"]/.test(s)) return s;
  // booleans
  if (s === "true" || s === "True") return true;
  if (s === "false" || s === "False") return false;
  // number?
  const n = Number(s);
  if (!isNaN(n) && s.match(/^-?\d+(\.\d+)?$/)) return n;
  return s;
}

function YamlEditor({ stream, onChange, samples }) {
  const { Icon } = window.PGE;
  const _samples = samples || [];
  const sampleRec = _samples.find(s => s.name === stream.sample);

  const lines = useMemoYE(() => buildLines(stream, sampleRec), [stream]);
  const generated = useMemoYE(() => linesToText(lines), [lines]);

  const [mode, setMode] = useStateYE("view"); // 'view' | 'edit'
  const [draft, setDraft] = useStateYE(generated);
  const [parseErr, setParseErr] = useStateYE(null);

  // when stream updates from outside (e.g. timeline drag) and we're not editing, refresh draft.
  useEffectYE(() => { if (mode === "view") setDraft(generated); }, [generated, mode]);

  const errCount = lines.filter(l => l.err).length;
  const warnCount = lines.filter(l => l.warn).length;
  const firstErrLine = lines.findIndex(l => l.err);
  const dirty = mode === "edit" && draft !== generated;

  function applyEdits() {
    try {
      const parsed = parseYaml(draft);
      const patch = { ...parsed.patch };
      if (Object.keys(parsed.pointer).length) patch.pointer = { ...stream.pointer, ...parsed.pointer };
      if (Object.keys(parsed.grain).length)   patch.grain   = { ...stream.grain,   ...parsed.grain };
      if (Object.keys(parsed.pitch).length)   patch.pitch   = { ...stream.pitch,   ...parsed.pitch };
      onChange && onChange(patch);
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

  // render highlighted view
  let lineNo = 0;
  const rendered = [];
  lines.forEach((ln, i) => {
    lineNo += 1;
    const ind = "  ".repeat(ln.ind || 0);
    const cls = ["ln", ln.err ? "has-err" : "", ln.warn ? "has-warn" : "", i === firstErrLine ? "cur" : ""].filter(Boolean).join(" ");
    rendered.push(
      <div key={"l"+i} className={cls}>
        <span className="num">{lineNo}</span>
        <span className="gutter-marker" />
        <span className="src">
          {ind}
          {ln.kind === "comment" ? <span className="c">{ln.text}</span> : null}
          {ln.kind === "block" ? <><span className="k">{ln.key}</span>:</> : null}
          {ln.kind === "flag" ? <><span className="k">{ln.key}</span>:</> : null}
          {(ln.kind === "v" || ln.kind === "s" || ln.kind === "r" || ln.kind === "raw") ? (
            <>
              <span className="k">{ln.key}</span>
              <span>: </span>
              {ln.kind === "v" ? <span className="v">{ln.val}</span> : null}
              {ln.kind === "s" ? <span className="s">{ln.val}</span> : null}
              {ln.kind === "r" ? <span className="r">{ln.val}</span> : null}
              {ln.kind === "raw" ? <span className="r">{ln.val}</span> : null}
            </>
          ) : null}
        </span>
      </div>
    );
    if (ln.err) {
      rendered.push(
        <div key={"e"+i} className="errpop">
          <Icon name="x" size={11} />
          <span>{ln.err}</span>
        </div>
      );
    }
    if (ln.warn) {
      rendered.push(
        <div key={"w"+i} className="warnpop">
          <span>⚠</span>
          <span>{ln.warn}</span>
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
        <span>{mode === "edit" ? `Ln 1, Col 1 · ${editLineCount} lines` : `Ln ${lineNo}, Col 1`}</span>
      </div>
    </div>
  );
}
window.PGE = window.PGE || {};
window.PGE.YamlEditor = YamlEditor;
