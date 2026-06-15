/* @jsx React.createElement */
/* ErrorBoundary — isolates a render crash to one panel instead of blanking the
 * whole app. Wrap the heavy panels (Timeline / Inspector / EnvelopeEditor) so a
 * throw in one shows an inline error and leaves the rest of the editor — and the
 * top-bar Save — usable, preserving unsaved work. #45 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[PGE] ${this.props.label || "component"} crashed:`, error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const label = this.props.label || "panel";
    const msg = (this.state.error && this.state.error.message) || String(this.state.error);
    return (
      <div className="pge-error-boundary" style={{
        padding: "16px", margin: "8px", borderRadius: "6px",
        border: "1px solid var(--err, #c0392b)",
        background: "var(--bg-2, #1c1c1c)", color: "var(--fg, #ddd)",
        font: "12px/1.5 ui-monospace, monospace",
      }}>
        <div style={{ fontWeight: 600, marginBottom: "6px", color: "var(--err, #e74c3c)" }}>
          ⚠ The {label} hit an error
        </div>
        <div style={{ whiteSpace: "pre-wrap", opacity: 0.85, marginBottom: "8px" }}>{msg}</div>
        <div style={{ opacity: 0.7, marginBottom: "10px" }}>
          Your project is still loaded — use <strong>Save</strong> in the top bar to keep your work.
        </div>
        <button className="yaml-btn" onClick={() => this.setState({ error: null })}>retry</button>
      </div>
    );
  }
}

window.PGE = window.PGE || {};
window.PGE.ErrorBoundary = ErrorBoundary;
