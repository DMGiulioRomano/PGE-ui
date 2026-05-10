/* @jsx React.createElement */
const { useState: useStateTL, useRef: useRefTL, useEffect: useEffTL } = React;

function Timeline({ streams, selected, onSelect, onUpdate, playhead, duration, onCreateStream }) {
  const { Icon } = window.PGE;
  const PX_PER_S = 36;          // 36 pixels per second of timeline
  const HEAD_W = 220;
  const ref = useRefTL(null);
  const [hoverX, setHoverX] = useStateTL(null);

  const ticks = [];
  for (let s = 0; s <= duration; s++) {
    const major = s % 5 === 0;
    ticks.push({ s, major, x: s * PX_PER_S });
  }

  function onPointerDown(e, stream, mode) {
    e.preventDefault();
    e.stopPropagation();
    onSelect(stream.id);
    const startX = e.clientX;
    const orig = { onset: stream.onset, duration: stream.duration };
    function move(ev) {
      const dx = (ev.clientX - startX) / PX_PER_S;
      if (mode === "drag") {
        onUpdate(stream.id, { onset: Math.max(0, +(orig.onset + dx).toFixed(3)) });
      } else if (mode === "resize") {
        onUpdate(stream.id, { duration: Math.max(0.5, +(orig.duration + dx).toFixed(3)) });
      }
    }
    function up() { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onLaneDrop(e, idx) {
    e.preventDefault();
    const sample = e.dataTransfer.getData("text/sample");
    if (!sample) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    onCreateStream && onCreateStream({ sample, onset: +(x / PX_PER_S).toFixed(2), laneIdx: idx });
  }

  return (
    <div className="pge-timeline" ref={ref}>
      {/* track header column */}
      <div className="lanes-head" style={{ width: HEAD_W }}>
        <div className="ruler-corner">
          <span className="z">timeline</span>
          <span className="z2">{duration}s · 120 bpm</span>
        </div>
        {streams.map(s => (
          <TrackHeader key={s.id} stream={s} selected={selected === s.id} onSelect={() => onSelect(s.id)} onMute={() => onUpdate(s.id, { mute: !s.mute })} onSolo={() => onUpdate(s.id, { solo: !s.solo })} />
        ))}
        <div className="lanes-head-add">
          <button className="add-btn"><Icon name="plus" size={12} /> add stream</button>
        </div>
      </div>
      {/* timeline grid */}
      <div className="lanes-body">
        <div className="ruler" style={{ width: duration * PX_PER_S }}>
          {ticks.map(t => (
            <React.Fragment key={t.s}>
              <span className={"tick" + (t.major ? " major" : "")} style={{ left: t.x }} />
              {t.major ? <span className="lbl" style={{ left: t.x }}>{t.s}.0</span> : null}
            </React.Fragment>
          ))}
          <div className="head" style={{ left: playhead * PX_PER_S }}>
            <div className="head-flag" />
          </div>
        </div>
        <div className="lanes-area" style={{ width: duration * PX_PER_S }}>
          {streams.map((s, i) => (
            <div key={s.id} className="lane" onDragOver={e => e.preventDefault()} onDrop={e => onLaneDrop(e, i)}
                 onMouseMove={e => setHoverX(((e.clientX - e.currentTarget.getBoundingClientRect().left) / PX_PER_S))}>
              <div className={"clip" + (s.id === selected ? " selected" : "") + (s.error ? " error" : "") + (s.mute ? " muted" : "")}
                   style={{ left: s.onset * PX_PER_S, width: s.duration * PX_PER_S, background: s.color }}
                   onPointerDown={(e) => onPointerDown(e, s, "drag")}>
                <div className="lbl">{s.id} · {s.sample}</div>
                <div className="metaline">d:{s.density ?? "ff " + s.fillFactor} · {s.voices.num}v</div>
                <svg className="wave" viewBox="0 0 240 22" preserveAspectRatio="none">
                  <path fill="rgba(255,255,255,.55)" d="M0,11 L8,5 16,17 24,8 32,15 40,4 48,18 56,9 64,16 72,3 80,18 88,11 96,15 104,7 112,17 120,5 128,19 136,10 144,16 152,8 160,17 168,4 176,18 184,11 192,15 200,7 208,17 216,5 224,18 232,11 240,11 240,11 0,11" />
                </svg>
                {/* density mini-curve overlay */}
                {s.densityEnv ? (
                  <svg className="env-overlay" viewBox={`0 0 ${s.densityEnv.length * 100} 30`} preserveAspectRatio="none">
                    <polyline fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="1" points={s.densityEnv.map((p, i) => `${(i / (s.densityEnv.length - 1)) * (s.densityEnv.length * 100)},${30 - (p[1] / 60) * 28}`).join(" ")} />
                  </svg>
                ) : null}
                <div className="resize-handle" onPointerDown={(e) => onPointerDown(e, s, "resize")} />
              </div>
            </div>
          ))}
          <div className="playhead-line" style={{ left: playhead * PX_PER_S }} />
          <div className="playhead-glow" style={{ left: playhead * PX_PER_S - 7 }} />
        </div>
      </div>
    </div>
  );
}

function TrackHeader({ stream, selected, onSelect, onMute, onSolo }) {
  return (
    <div className={"track-head" + (selected ? " selected" : "") + (stream.mute ? " muted" : "")}
         style={{ borderLeftColor: stream.color }} onClick={onSelect}>
      <div className="lh">
        <span className="nm">{stream.id}</span>
        <span className="sub">{stream.sample}</span>
      </div>
      <span className="vc">{stream.voices.num}v</span>
      <button className={"pill" + (stream.mute ? " on-m" : "")} onClick={(e) => { e.stopPropagation(); onMute(); }} title="mute">M</button>
      <button className={"pill" + (stream.solo ? " on-s" : "")} onClick={(e) => { e.stopPropagation(); onSolo(); }} title="solo">S</button>
    </div>
  );
}

window.PGE.Timeline = Timeline;
