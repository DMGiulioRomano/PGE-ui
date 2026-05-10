/* @jsx React.createElement */
function YamlEditor({ stream }) {
  const { Icon } = window.PGE;
  const samples = window.PGE_DATA.samples;
  const sampleRec = samples.find(s => s.name === stream.sample);
  const sampleMissing = !sampleRec;

  // Build lines: { ind, text, kind: 'comment'|'key'|'block', tokens: [...] }
  const lines = [];
  function fmtNum(n) { return Number.isInteger(n) ? String(n) : (Math.abs(n) < 1 ? n.toString() : n.toFixed(2).replace(/\.?0+$/, "")); }
  function envInline(env) {
    return "[" + env.map(p => `[${fmtNum(p[0])}, ${fmtNum(p[1])}]`).join(", ") + "]";
  }
  function pushKV(ind, key, kind, val, opts={}) {
    lines.push({ ind, key, kind, val, ...opts });
  }
  function pushBlock(ind, key) { lines.push({ ind, key, kind: "block" }); }
  function pushBare(ind, text, kind="comment") { lines.push({ ind, kind, text }); }

  pushBare(0, `# stream "${stream.id}" — auto-rendered from project`, "comment");
  pushKV(0, "stream_id", "s", `"${stream.id}"`);
  if (stream.timeMode) pushKV(0, "time_mode", "r", stream.timeMode);
  pushKV(0, "onset", "v", fmtNum(stream.onset));
  pushKV(0, "duration", "v", fmtNum(stream.duration));
  pushKV(0, "sample", "s", `"${stream.sample}"`, { err: sampleMissing ? `sample not found: ${stream.sample}` : null });
  if (stream.distributionMode) pushKV(0, "distribution_mode", "s", `'${stream.distributionMode}'`);

  if (stream.densityEnv) pushKV(0, "density", "raw", envInline(stream.densityEnv));
  else if (stream.density != null) pushKV(0, "density", "v", fmtNum(stream.density));

  if (stream.distributionEnv) pushKV(0, "distribution", "raw", envInline(stream.distributionEnv));
  else if (stream.distribution != null) pushKV(0, "distribution", "v", fmtNum(stream.distribution));

  pushBlock(0, "pointer");
  if (stream.pointer.speedRatioEnv) pushKV(1, "speed_ratio", "raw", envInline(stream.pointer.speedRatioEnv));
  else if (stream.pointer.speedRatio != null) pushKV(1, "speed_ratio", "v", fmtNum(stream.pointer.speedRatio));
  if (stream.pointer.loopStart != null) {
    pushKV(1, "loop_start", "v", fmtNum(stream.pointer.loopStart));
    pushKV(1, "loop_dur", "v", fmtNum(stream.pointer.loopDur),
      { err: (sampleRec && stream.pointer.loopDur > sampleRec.duration) ? `loop_dur must be ≤ sample duration (${sampleRec.duration.toFixed(3)} s)` : null });
  }

  pushBlock(0, "grain");
  if (stream.grain.durationEnv) pushKV(1, "duration", "raw", envInline(stream.grain.durationEnv));
  else if (stream.grain.duration != null) pushKV(1, "duration", "v", fmtNum(stream.grain.duration));
  if (stream.grain.durationRange) pushKV(1, "duration_range", "v", fmtNum(stream.grain.durationRange));
  pushKV(1, "envelope", "r", stream.grain.envelope);

  if (stream.pitch.semitones != null) {
    pushBlock(0, "pitch");
    pushKV(1, "semitones", "v", fmtNum(stream.pitch.semitones));
    if (stream.pitch.range) pushKV(1, "range", "v", fmtNum(stream.pitch.range));
  }

  if (stream.panEnv) pushKV(0, "pan", "raw", envInline(stream.panEnv),
    { warn: stream.panEnv.some(p => Math.abs(p[1]) > 90) ? "pan values exceed conventional range [−90, 90]" : null });
  else if (stream.pan != null) pushKV(0, "pan", "v", fmtNum(stream.pan));
  if (stream.panRange) pushKV(0, "pan_range", "v", fmtNum(stream.panRange));

  pushKV(0, "volume", "v", fmtNum(stream.volume));
  if (stream.volumeRange) pushKV(0, "volume_range", "v", fmtNum(stream.volumeRange));

  if (stream.dephase) {
    pushBlock(0, "dephase");
    pushKV(1, "type", "s", `'${stream.dephase.type}'`);
    pushKV(1, "points", "raw", envInline(stream.dephase.points));
  }

  // count diagnostics
  const errCount = lines.filter(l => l.err).length;
  const warnCount = lines.filter(l => l.warn).length;
  const firstErrLine = lines.findIndex(l => l.err);

  // render with possible inline pop after error/warn lines
  const rendered = [];
  let lineNo = 0;
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

  return (
    <div className="pge-yaml">
      <div className="head">
        <Icon name="code" size={12} />
        <span className="t">stream "{stream.id}"</span>
        <span>·</span><span>raw yaml</span>
        <span style={{ flex: 1 }} />
        {errCount > 0 ? <span className="err">● {errCount} error{errCount>1?"s":""}</span> :
         warnCount > 0 ? <span className="acc">{warnCount} warning{warnCount>1?"s":""}</span> :
         <span className="acc">valid</span>}
      </div>
      <div className="body">
        {rendered}
      </div>
      <div className="footer">
        <span>YAML · UTF-8 · LF</span>
        <span style={{flex:1}} />
        {errCount > 0 ? <span className="err-count">✕ {errCount}</span> : null}
        {warnCount > 0 ? <span className="warn-count">⚠ {warnCount}</span> : null}
        {errCount === 0 && warnCount === 0 ? <span style={{color:"var(--status-ok)"}}>● ready</span> : null}
        <span>Ln {lineNo}, Col 1</span>
      </div>
    </div>
  );
}
window.PGE = window.PGE || {};
window.PGE.YamlEditor = YamlEditor;
