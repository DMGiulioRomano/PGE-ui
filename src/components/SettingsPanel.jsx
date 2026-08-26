/* @jsx React.createElement */
/* SettingsPanel — backend + paths configuration, accessible via gear icon in topbar.
 * Replaces the need for the host's Tweaks panel when running standalone. */

const { useState: useStateSP, useRef: useRefSP, useEffect: useEffectSP } = React;

function SettingsPanel({ open, onClose, tweaks, setTweak, serverDown }) {
  const { Icon } = window.PGE;
  const currentBackendKind = "local";  // single backend now
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
          <div className="sp-sec-head">Server</div>
          {serverDown ? (
            <div className="sp-status sp-status-err">
              <span className="sp-dot" /> <span className="mono">server non raggiungibile — avvia server.py (make serve)</span>
            </div>
          ) : null}
          <div className="sp-hint">
            Real filesystem + local python server. The server has direct disk
            access, so the editor works in any browser (Chrome, Firefox, Safari).
            Save writes via HTTP PUT, Render POSTs to the URL below.
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
                PGE-ui folder. See <span className="mono">README-PGE-EDITOR.md</span>.
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
            These paths are resolved by <span className="mono">server.py</span> at launch
            (via <span className="mono">--root</span>). The fields above are informational;
            edit them on the server side, not here.
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
            <span className="sp-k" title="genera il sidecar JSON dei grani per stream (pesante su scene dense)">grain data</span>
            <SpToggle v={tweaks.renderGrainJson !== false} onChange={(v) => setTweak("renderGrainJson", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="formato dei file audio renderizzati">output format</span>
            <select className="sp-select mono"
                    value={tweaks.outputFormat || "wav"}
                    onChange={(e) => setTweak("outputFormat", e.target.value)}>
              <option value="aiff">AIFF</option>
              <option value="wav">WAV (default)</option>
              <option value="flac">FLAC</option>
            </select>
          </div>
          {tweaks.renderVisualize ? (
            <div className="sp-row" style={{paddingLeft: 12}}>
              <span className="sp-k">page duration (s)</span>
              <input type="number" className="pge-mini-input" min={1} step={1} style={{width: 52}}
                     value={tweaks.renderPageDuration ?? 15}
                     onChange={e => setTweak("renderPageDuration", Math.max(1, +e.target.value || 15))} />
            </div>
          ) : null}
          <div className="sp-row">
            <span className="sp-k">reaper project</span>
            <SpToggle v={!!tweaks.renderReaper} onChange={(v) => setTweak("renderReaper", v)} />
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sec-head">Shortcuts</div>
          <div className="sp-row">
            <span className="sp-k" title="apre/chiude il pannello impostazioni">settings</span>
            <ShortcutInput value={tweaks.shortcutSettings || ","}
                           onChange={(v) => setTweak("shortcutSettings", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="avvia il render del progetto corrente">render</span>
            <ShortcutInput value={tweaks.shortcutRender || "r"}
                           onChange={(v) => setTweak("shortcutRender", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="apre/chiude l'inspector da tastiera">inspector toggle</span>
            <ShortcutInput value={tweaks.shortcutInspector || "i"}
                           onChange={(v) => setTweak("shortcutInspector", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="apre/chiude il pannello envelope editor">envelope editor toggle</span>
            <ShortcutInput value={tweaks.shortcutEnvelopeEditor || "o"}
                           onChange={(v) => setTweak("shortcutEnvelopeEditor", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="torna all'inizio (back to start)">back to start</span>
            <ShortcutInput value={tweaks.shortcutBackToStart || "z"}
                           onChange={(v) => setTweak("shortcutBackToStart", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="avvia / metti in pausa la riproduzione">play / pause</span>
            <ShortcutInput value={tweaks.shortcutPlay || "x"}
                           onChange={(v) => setTweak("shortcutPlay", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="ferma la riproduzione e torna all'inizio">stop</span>
            <ShortcutInput value={tweaks.shortcutStop || "c"}
                           onChange={(v) => setTweak("shortcutStop", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="apre/chiude il pannello log / terminale">log toggle</span>
            <ShortcutInput value={tweaks.shortcutLog || "l"}
                           onChange={(v) => setTweak("shortcutLog", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="mostra/nasconde nome, sample, densità e voci sui clip">clip labels toggle</span>
            <ShortcutInput value={tweaks.shortcutToggleLabels || "h"}
                           onChange={(v) => setTweak("shortcutToggleLabels", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="commuta tutti i clip tra waveform e spettrogramma">spettrogramma nei clip</span>
            <ShortcutInput value={tweaks.shortcutToggleSpectrogram || "t"}
                           onChange={(v) => setTweak("shortcutToggleSpectrogram", v)} />
            <select className="sp-select mono"
                    title="scala dell'asse delle frequenze dello spettrogramma"
                    value={tweaks.spectrogramScale || "linear"}
                    onChange={(e) => setTweak("spectrogramScale", e.target.value)}>
              <option value="linear">lineare</option>
              <option value="log">logaritmico</option>
            </select>
          </div>
          <div className="sp-row">
            <span className="sp-k" title="muta/smuta gli stream selezionati">mute selection</span>
            <ShortcutInput value={tweaks.shortcutMute || "m"}
                           onChange={(v) => setTweak("shortcutMute", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="sola/desola gli stream selezionati">solo selection</span>
            <ShortcutInput value={tweaks.shortcutSolo || "s"}
                           onChange={(v) => setTweak("shortcutSolo", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="taglia in due gli stream selezionati nel punto del cursore">split at playhead</span>
            <ShortcutInput value={tweaks.shortcutSplit || "d"}
                           onChange={(v) => setTweak("shortcutSplit", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="sposta gli stream selezionati sulla traccia sopra">move to track above</span>
            <ShortcutInput value={tweaks.shortcutMoveLaneUp || window.PGE_MOVE_LANE_DEFAULTS.up}
                           onChange={(v) => setTweak("shortcutMoveLaneUp", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="sposta gli stream selezionati sulla traccia sotto">move to track below</span>
            <ShortcutInput value={tweaks.shortcutMoveLaneDown || window.PGE_MOVE_LANE_DEFAULTS.down}
                           onChange={(v) => setTweak("shortcutMoveLaneDown", v)} />
          </div>
          <div className="sp-hint">
            Click sul campo e premi la combinazione desiderata. Funziona anche cliccando
            di nuovo sullo stesso stream in timeline. Se nessuno stream è selezionato,
            l'inspector mostra uno stato vuoto.
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sec-head">Interaction</div>
          <div className="sp-row">
            <span className="sp-k" title="tasto/combinazione per aprire il menu step sui campi numerici">step menu trigger</span>
            <select className="sp-select mono"
                    value={tweaks.stepMenuTrigger || "rightClick"}
                    onChange={(e) => setTweak("stepMenuTrigger", e.target.value)}>
              <option value="rightClick">right click</option>
              <option value="middleClick">middle click</option>
              <option value="shiftLeft">shift + click</option>
              <option value="ctrlLeft">ctrl + click</option>
              <option value="altLeft">alt + click</option>
            </select>
          </div>
          <div className="sp-hint">
            Tieni premuto per aprire il menu step sui valori scalari (0.01 / 0.1 / 1 / 10).
            Passa su un rettangolo e aspetta 0.5s → si attiva. Poi muovi su/giù per cambiare il valore.
            Una volta attivato, il passo rimane selezionato anche uscendo dal rettangolino.
          </div>
          <div className="sp-row">
            <span className="sp-k" title="gesture per lo zoom della timeline">gesture · zoom</span>
            <select className="sp-select mono" value={tweaks.gestureZoom || "wheel"}
                    onChange={(e) => setTweak("gestureZoom", e.target.value)}>
              <option value="wheel">wheel</option>
              <option value="cmd+wheel">⌘ + wheel</option>
              <option value="alt+wheel">⌥ + wheel</option>
              <option value="ctrl+wheel">ctrl + wheel</option>
            </select>
          </div>
          <div className="sp-row">
            <span className="sp-k" title="gesture per l'altezza delle lane">gesture · lane height</span>
            <select className="sp-select mono" value={tweaks.gestureLaneHeight || "shift+wheel"}
                    onChange={(e) => setTweak("gestureLaneHeight", e.target.value)}>
              <option value="shift+wheel">⇧ + wheel</option>
              <option value="shift+cmd+wheel">⇧⌘ + wheel</option>
              <option value="shift+alt+wheel">⇧⌥ + wheel</option>
            </select>
          </div>
          <div className="sp-row">
            <span className="sp-k" title="gesture per lo scroll orizzontale">gesture · h-scroll</span>
            <select className="sp-select mono" value={tweaks.gestureHScroll || "alt+wheel"}
                    onChange={(e) => setTweak("gestureHScroll", e.target.value)}>
              <option value="alt+wheel">⌥ + wheel</option>
              <option value="cmd+wheel">⌘ + wheel</option>
              <option value="shift+wheel">shift + wheel</option>
            </select>
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
          <div className="sp-row">
            <span className="sp-k" title="nome, sample, densità e voci sopra i clip">clip labels</span>
            <SpToggle v={tweaks.showClipLabels !== false} onChange={(v) => setTweak("showClipLabels", v)} />
          </div>
        </div>

        <div className="sp-section">
          <div className="sp-sec-head">View</div>
          <div className="sp-row">
            <span className="sp-k" title="mostra le waveform dentro i clip">waveforms in clips</span>
            <SpToggle v={tweaks.showWaveforms !== false} onChange={(v) => setTweak("showWaveforms", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="mostra lo spettrogramma dentro i clip (scorciatoia: t)">spettrogramma nei clip</span>
            <SpToggle v={!!tweaks.showSpectrograms} onChange={(v) => setTweak("showSpectrograms", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="mostra i grani dentro i clip">grani nei clip</span>
            <SpToggle v={!!tweaks.showGrains} onChange={(v) => setTweak("showGrains", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="mostra l'overlay degli envelope sui clip">envelope overlay</span>
            <SpToggle v={tweaks.showEnvOverlay !== false} onChange={(v) => setTweak("showEnvOverlay", v)} />
          </div>
          <div className="sp-row">
            <span className="sp-k" title="mostra le miniature waveform nel browser dei sample">waveform thumbnails</span>
            <SpToggle v={tweaks.showWaveformBrowser !== false} onChange={(v) => setTweak("showWaveformBrowser", v)} />
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

/* ShortcutInput — click to record, then press the combo. Esc cancels, Backspace
 * (without modifiers) clears. The stored format is "cmd+i", "shift+cmd+p", etc.
 * cmd matches metaKey on mac and ctrlKey elsewhere, mirroring matchShortcut(). */
function ShortcutInput({ value, onChange }) {
  const [recording, setRecording] = useStateSP(false);
  const inputRef = useRefSP(null);

  function startRecording() {
    setRecording(true);
    setTimeout(() => inputRef.current && inputRef.current.focus(), 0);
  }

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { setRecording(false); return; }
    // Pressing a bare modifier shouldn't commit — wait for the actual key.
    if (e.key === "Meta" || e.key === "Control" || e.key === "Shift" || e.key === "Alt") return;
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push("cmd");
    if (e.shiftKey) parts.push("shift");
    if (e.altKey) parts.push("alt");
    let k = (e.key || "").toLowerCase();
    if (k === " ") k = "space";
    parts.push(k);
    onChange(parts.join("+"));
    setRecording(false);
  }

  const display = window.prettyShortcut ? window.prettyShortcut(value) : value;
  return (
    <button
      ref={inputRef}
      type="button"
      className={"sp-kbd" + (recording ? " recording" : "")}
      onClick={startRecording}
      onKeyDown={recording ? onKey : undefined}
      onBlur={() => setRecording(false)}
      title={recording ? "Press the key combination… (Esc to cancel)" : "Click to change"}
    >
      {recording ? <span className="sp-kbd-hint">press keys…</span> : <span className="sp-kbd-glyphs mono">{display}</span>}
    </button>
  );
}

window.PGE.SettingsPanel = SettingsPanel;
