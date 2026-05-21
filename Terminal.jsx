/* @jsx React.createElement */
/* Terminal — embedded log panel, collapsible. Also exposes a Toast surface
 * shown by app.jsx when the terminal is collapsed.
 *
 * Vertically resizable: drag the top edge to change height. Height is
 * persisted through the `onHeightChange` callback (wired to the
 * `terminalHeight` tweak in app.jsx). */

const { useRef: useRefT, useEffect: useEffectT, useState: useStateT } = React;

const TERMINAL_MIN_H = 90;
const TERMINAL_MAX_FRACTION = 0.85; // up to 85% of viewport height

function Terminal({ open, lines, onClose, onClear, status, onCopyAll, height = 220, onHeightChange }) {
  const { Icon } = window.PGE;
  const scrollerRef = useRefT(null);
  const dragRef = useRefT({ active: false, startY: 0, startH: 0 });
  const [resizing, setResizing] = useStateT(false);

  useEffectT(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [lines.length, open]);

  function clampH(h) {
    const max = Math.max(TERMINAL_MIN_H + 40, Math.round(window.innerHeight * TERMINAL_MAX_FRACTION));
    return Math.max(TERMINAL_MIN_H, Math.min(max, Math.round(h)));
  }

  function onResizeDown(e) {
    e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    dragRef.current = { active: true, startY: y, startH: height };
    setResizing(true);
    document.body.classList.add("pge-resizing-terminal");
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", onResizeUp);
    window.addEventListener("touchmove", onResizeMove, { passive: false });
    window.addEventListener("touchend", onResizeUp);
  }
  function onResizeMove(e) {
    if (!dragRef.current.active) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const dy = y - dragRef.current.startY;
    // dragging UP (negative dy) grows the terminal
    const next = clampH(dragRef.current.startH - dy);
    onHeightChange && onHeightChange(next);
  }
  function onResizeUp() {
    dragRef.current.active = false;
    setResizing(false);
    document.body.classList.remove("pge-resizing-terminal");
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeUp);
    window.removeEventListener("touchmove", onResizeMove);
    window.removeEventListener("touchend", onResizeUp);
  }
  function onResizeKey(e) {
    if (!onHeightChange) return;
    const step = e.shiftKey ? 40 : 12;
    if (e.key === "ArrowUp")   { e.preventDefault(); onHeightChange(clampH(height + step)); }
    if (e.key === "ArrowDown") { e.preventDefault(); onHeightChange(clampH(height - step)); }
  }
  function onResizeDouble() {
    // Double-click resets to default
    onHeightChange && onHeightChange(220);
  }

  // Cleanup on unmount
  useEffectT(() => () => {
    document.body.classList.remove("pge-resizing-terminal");
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeUp);
    window.removeEventListener("touchmove", onResizeMove);
    window.removeEventListener("touchend", onResizeUp);
  }, []);

  if (!open) return null;
  return (
    <div className={"pge-terminal" + (resizing ? " is-resizing" : "")} role="region" aria-label="render log">
      <div className="t-resize"
           role="separator"
           aria-orientation="horizontal"
           aria-label="resize terminal"
           tabIndex={0}
           onMouseDown={onResizeDown}
           onTouchStart={onResizeDown}
           onDoubleClick={onResizeDouble}
           onKeyDown={onResizeKey}
           title="drag to resize · double-click to reset" />
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
