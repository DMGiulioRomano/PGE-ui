/* @jsx React.createElement */
const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp } = React;

function App() {
  const [data, setData] = useStateApp(window.PGE_DATA);
  const [selectedId, setSelectedId] = useStateApp(null);     // no clip selected → inspector closed
  const [inspectorOpen, setInspectorOpen] = useStateApp(false);
  const [inspectorTab, setInspectorTab] = useStateApp("preview");
  const [playing, setPlaying] = useStateApp(false);
  const [time, setTime] = useStateApp(0);
  const [renderStatus, setRenderStatus] = useStateApp(null);
  const [dirty, setDirty] = useStateApp(true);
  const tickRef = useRefApp();

  useEffectApp(() => {
    if (!playing) { cancelAnimationFrame(tickRef.current); return; }
    let last = performance.now();
    function step(now) {
      const dt = (now - last) / 1000; last = now;
      setTime(t => (t + dt > data.duration ? 0 : t + dt));
      tickRef.current = requestAnimationFrame(step);
    }
    tickRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(tickRef.current);
  }, [playing, data.duration]);

  useEffectApp(() => {
    function onKey(e) {
      if (e.target.tagName === "INPUT") return;
      if (e.key === " ") { e.preventDefault(); setPlaying(p => !p); }
      if (e.key === "Escape") { setInspectorOpen(false); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function updateStream(id, patch) {
    setData(d => ({ ...d, streams: d.streams.map(s => s.id === id ? { ...s, ...patch } : s) }));
    setDirty(true);
  }
  function selectClip(id) {
    setSelectedId(id);
    setInspectorOpen(true);
  }
  function closeInspector() { setInspectorOpen(false); }
  function selected() { return data.streams.find(s => s.id === selectedId); }

  function onRender() {
    setRenderStatus("rendering 0%");
    let p = 0;
    const id = setInterval(() => {
      p += 8 + Math.random() * 10;
      if (p >= 100) { clearInterval(id); setRenderStatus(null); }
      else setRenderStatus(`rendering ${Math.floor(p)}%`);
    }, 220);
  }

  const { TopBar, SampleBrowser, Timeline, Inspector } = window.PGE;

  return (
    <div className="pge-app">
      <TopBar project={data.project} title={data.title} dirty={dirty}
              playing={playing} onPlay={() => setPlaying(p => !p)}
              onStop={() => { setPlaying(false); setTime(0); }}
              onRender={onRender} time={time} duration={data.duration} status={renderStatus} />
      <div className={"pge-main" + (inspectorOpen && selected() ? " inspector-open" : "")}>
        <SampleBrowser samples={data.samples} />
        <div className="pge-center" data-screen-label="01 Main · Timeline">
          <Timeline streams={data.streams} selected={selectedId}
                    onSelect={selectClip} onUpdate={updateStream}
                    playhead={time} duration={data.duration} />
        </div>
        {inspectorOpen && selected() ? (
          <Inspector stream={selected()}
                     onChange={(p) => updateStream(selectedId, p)}
                     onClose={closeInspector}
                     tab={inspectorTab} onTab={setInspectorTab} />
        ) : null}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("app")).render(<App />);
