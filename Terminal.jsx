/* @jsx React.createElement */
/* Terminal — embedded log panel, collapsible. Also exposes a Toast surface
 * shown by app.jsx when the terminal is collapsed. */

const { useRef: useRefT, useEffect: useEffectT, useState: useStateT } = React;

function Terminal({ open, lines, onClose, onClear, status, onCopyAll }) {
  const { Icon } = window.PGE;
  const scrollerRef = useRefT(null);
  useEffectT(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [lines.length, open]);

  if (!open) return null;
  return (
    <div className="pge-terminal" role="region" aria-label="render log">
      <div className="t-head">
        <span className="t-dot" data-state={status?.running ? "run" : (status?.lastOk === false ? "err" : "idle")} />
        <span className="t-title mono">render log</span>
        {status?.running ? (
          <span className="t-meta mono">running · {status.done}/{status.total}</span>
        ) : (
          <span className="t-meta mono">{status?.lastOk === false ? "last run failed" : (status?.lastOk ? `last run ok · ${status.lastGenerated || 0} files` : "idle")}</span>
        )}
        <span style={{ flex: 1 }} />
        <button className="t-btn" onClick={onCopyAll} title="copy all"><Icon name="download" size={10} /></button>
        <button className="t-btn" onClick={onClear} title="clear log"><Icon name="trash" size={10} /></button>
        <button className="t-btn" onClick={onClose} title="hide terminal"><Icon name="x" size={11} /></button>
      </div>
      <div className="t-body" ref={scrollerRef}>
        {lines.length === 0 ? <div className="t-empty">— no output yet —</div> : null}
        {lines.map((l, i) => (
          <div key={i} className={"t-line " + (l.cls || "")}>
            <span className="t-gutter mono">{String(i + 1).padStart(3, " ")}</span>
            <span className="t-text mono">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Toast({ toasts, onDismiss }) {
  if (!toasts || toasts.length === 0) return null;
  return (
    <div className="pge-toasts">
      {toasts.map((t) => (
        <div key={t.id} className={"pge-toast " + (t.kind || "info")} onClick={() => onDismiss(t.id)}>
          <span className="tt-dot" />
          <div className="tt-body">
            <div className="tt-title">{t.title}</div>
            {t.message ? <div className="tt-msg mono">{t.message}</div> : null}
          </div>
          {t.action ? (
            <button className="tt-act" onClick={(e) => { e.stopPropagation(); t.action.onClick(); onDismiss(t.id); }}>{t.action.label}</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

window.PGE.Terminal = Terminal;
window.PGE.Toast = Toast;
