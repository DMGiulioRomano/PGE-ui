/* @jsx React.createElement */
function SampleBrowser({ samples, onDragSample }) {
  const { Icon } = window.PGE;
  return (
    <div className="pge-browser">
      <div className="head">
        <Icon name="folder" size={12} /><span>Media/</span>
      </div>
      <div className="search">
        <Icon name="search" size={12} /><span>search</span>
      </div>
      <div className="list">
        {samples.map(s => (
          <div key={s.name} className="it" draggable onDragStart={e => { e.dataTransfer.setData("text/sample", s.name); onDragSample && onDragSample(s.name); }}>
            <svg className="wave" viewBox="0 0 36 14" preserveAspectRatio="none">
              <path stroke="#A7ADB8" strokeWidth="1" fill="none" d="M0,7 3,3 6,11 9,5 12,9 15,2 18,12 21,6 24,8 27,4 30,10 33,5 36,7" />
            </svg>
            <span className="nm">{s.name}</span>
            <span className="du">{s.duration.toFixed(2)}s</span>
          </div>
        ))}
      </div>
      <div className="head" style={{ marginTop: 8 }}>
        <Icon name="file" size={12} /><span>Projects</span>
      </div>
      <div className="list">
        <div className="it on">
          <span className="nm" style={{paddingLeft: 6}}>PGE_test.yml</span>
          <span className="du" style={{color:"var(--accent)"}}>●</span>
        </div>
        <div className="it"><span className="nm" style={{paddingLeft: 6}}>PGE_brano_8min.yml</span></div>
        <div className="it"><span className="nm" style={{paddingLeft: 6}}>PGE_pino2.yml</span></div>
      </div>
    </div>
  );
}
window.PGE.SampleBrowser = SampleBrowser;
