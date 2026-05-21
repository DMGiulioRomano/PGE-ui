/* @jsx React.createElement */
/* SettingsPanel — backend + paths configuration, accessible via gear icon in topbar.
 * Replaces the need for the host's Tweaks panel when running standalone. */

const { useState: useStateSP, useRef: useRefSP, useEffect: useEffectSP } = React;

function SettingsPanel({ open, onClose, tweaks, setTweak, onSwitchBackend, currentBackendKind, onTestServer }) {
  const { Icon } = window.PGE;
  const ref = useRefSP(null);
  const [serverStatus, setServerStatus] = useStateSP({ state: "idle", message: "" });
  const [setupLog, setSetupLog] = useStateSP([]);
  const [setupRunning, setSetupRunning] = useStateSP(false);
  const setupLogRef = useRefSP(null);

  useEffectSP(() => {
    if (!open) return;
    function onDoc(e) {
      if (!ref.current) return;
      if (ref.current.contains(e.target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

  useEffectSP(() => {
    if (setupLogRef.current) {
      setupLogRef.current.scrollTop = setupLogRef.current.scrollHeight;
    }
  }, [setupLog]);

  if (!open) return null;

  async function runSetup() {
    const backend = window.PGEBackend?.current;
    if (!backend?.setup) return;
    setSetupLog([]);
    setSetupRunning(true);
    await backend.setup(ev => {
      if (ev.type === "log" && ev.line !== undefined) {
        setSetupLog(l => [...l, ev.line]);
      }
    });
    setSetupRunning(false);
  }

  async function pingServer() {
    setServerStatus({ state: "testing", message: "pinging…" });
    try {
      const url = (tweaks.serverUrl || "http://localhost:7878") + "/health";
      const res = await fetch(url, { method: "GET" });
      if (res.ok) {
        const txt = await res.text();
        setServerStatus({ state: "ok", message: `server reachable · ${txt.slice(0, 60)}` });
      } else {
        setServerStatus({ state: "err", message: `HTTP ${res.status}` });
      }
    } catch (e) {
      setServerStatus({ state: "err", message: e.message });
    }
  }

  return (
    <div className="sp-overlay">
      <div className="sp-panel" ref={ref} role="dialog" aria-label="Settings">
        <div className="sp-head">
          <span className="sp-title">Settings</span>
          <button className="sp-close" onClick={onClose} aria-label="close"><Icon name="x" size={12} /></button>
        </div>

        <div className="sp-section">
          <div className="sp-sec-head">Backend</div>
          <div className="sp-row">
            <span className="sp-k">mode</span>
            <div className="pge-seg sm">
              <button className={currentBackendKind === "mock" ? "on" : ""}
                      onClick={() => onSwitchBackend("mock")}>mock</button>
              <button className={currentBackendKind === "local" ? "on" : ""}
                      onClick={() => onSwitchBackend("local")}>local</button>
            </div>
          </div>
          <div className="sp-hint">
            {currentBackendKind === "mock"
              ? "in-browser simulation. Save writes to localStorage, Render fakes a python run. Use this to evaluate the UI without setting up the python server."
              : "real filesystem + local python server. The server has direct disk access — works in any browser (Chrome, Firefox, Safari). Save writes via HTTP PUT, Render POSTs to the URL below."}
          </div>

          {currentBackendKind === "local" ? (
            <>
              <div className="sp-row">
                <span className="sp-k">server URL</span>
                <input className="sp-input mono" value={tweaks.serverUrl || "http://localhost:7878"}
                       onChange={(e) => setTweak("serverUrl", e.target.value)} />
              </div>
              <div className="sp-row">
                <span className="sp-k"></span>
                <button className="sp-btn" onClick={pingServer}>test connection</button>
              </div>
              {serverStatus.state !== "idle" ? (
                <div className={"sp-status sp-status-" + serverStatus.state}>
                  <span className="sp-dot" /> <span className="mono">{serverStatus.message}</span>
                </div>
              ) : null}
              <div className="sp-hint">
                Requires running <span className="mono">python server.py</span> in your
                PythonGranularEngine folder. See <span className="mono">README-PGE-EDITOR.md</span>.
              </div>
            </>
          ) : null}
        </div>

        {currentBackendKind === "local" ? (
          <div className="sp-section">
            <div className="sp-sec-head">Engine</div>
            <div className="sp-row">
              <span className="sp-k">python venv</span>
              <button className="sp-btn" onClick={runSetup} disabled={setupRunning}>
                {setupRunning ? "setting up…" : "setup engine"}
              </button>
            </div>
            {setupLog.length > 0 ? (
              <div className="sp-setup-log" ref={setupLogRef}>
                {setupLog.map((line, i) => (
                  <div key={i}>{line || " "}</div>
                ))}
              </div>
            ) : null}
            <div className="sp-hint">
              Creates <span className="mono">.venv</span> inside the engine repo and installs{" "}
              <span className="mono">requirements.txt</span>. Run once on a new machine.
              Safe to re-run — skips if venv already present.
            </div>
          </div>
        ) : null}

        <div className="sp-section">
          <div className="sp-sec-head">Paths</div>
          <div className="sp-row">
            <span className="sp-k">media folder</span>
            <input className="sp-input mono" value={tweaks.mediaPath || ""}
                   placeholder="(not set)"
                   onChange={(e) => setTweak("mediaPath", e.target.value)} />
          </div>
          <div className="sp-row">
            <span className="sp-k">projects folder</span>
            <input className="sp-input mono" value={tweaks.projectsPath || ""}
                   placeholder="(not set)"
                   onChange={(e) => setTweak("projectsPath", e.target.value)} />
          </div>
          <div className="sp-row">
            <span className="sp-k">output folder</span>
            <input className="sp-input mono" value={tweaks.outputPath || "output"}
                   onChange={(e) => setTweak("outputPath", e.target.value)} />
          </div>
          <div className="sp-hint">
            In <span className="mono">local</span> mode you'll still need to click "choose folder…"
            in the Media/Projects panels to grant the browser access (File System Access API).
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sec-head">Render defaults</div>
          <div className="sp-row">
            <span className="sp-k">incremental cache</span>
            <SpToggle v={tweaks.renderUseCache !== false} onChange={(v) => setTweak("renderUseCache", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k">pdf score</span>
            <SpToggle v={!!tweaks.renderVisualize} onChange={(v) => setTweak("renderVisualize", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k">reaper project</span>
            <SpToggle v={!!tweaks.renderReaper} onChange={(v) => setTweak("renderReaper", v)} />
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sec-head">Appearance</div>
          <div className="sp-row">
            <span className="sp-k">accent</span>
            <div className="sp-swatches">
              {["#FF8C42","#6E9CFF","#3DB87A","#E5484D","#B89241"].map(c => (
                <button key={c} className={"sp-swatch" + (tweaks.accent === c ? " on" : "")}
                        style={{ background: c }}
                        onClick={() => setTweak("accent", c)} title={c} />
              ))}
            </div>
          </div>
          <div className="sp-row">
            <span className="sp-k">density</span>
            <div className="pge-seg sm">
              <button className={tweaks.density === "compact" ? "on" : ""} onClick={() => setTweak("density", "compact")}>compact</button>
              <button className={tweaks.density === "comfortable" ? "on" : ""} onClick={() => setTweak("density", "comfortable")}>comfy</button>
            </div>
          </div>
          <div className="sp-row">
            <span className="sp-k">status footer</span>
            <SpToggle v={tweaks.showFooter !== false} onChange={(v) => setTweak("showFooter", v)} />
          </div>
        </div>

        <div className="sp-foot">
          <span className="mono fade">PGE editor v0.2 · backend: {currentBackendKind}</span>
        </div>
      </div>
    </div>
  );
}

function SpToggle({ v, onChange }) {
  return (
    <button className={"sp-tog" + (v ? " on" : "")} role="switch" aria-checked={v}
            onClick={() => onChange(!v)}>
      <span className="sp-tog-knob" />
    </button>
  );
}

window.PGE.SettingsPanel = SettingsPanel;
