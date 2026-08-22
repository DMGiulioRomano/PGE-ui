/* @jsx React.createElement */
const { useState: useStateIN, useMemo: useMemoIN } = React;

function AddParamMenu({ options, onAdd }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = React.useState(false);
  const avail = options.filter(o => !o.exists);
  if (!avail.length) return null;
  return (
    <div className="add-param">
      <button className="add-param-btn" onClick={() => setOpen(!open)}>
        <Icon name="plus" size={11} /> add parameter
      </button>
      {open ? (
        <div className="add-param-menu" onMouseLeave={() => setOpen(false)}>
          {avail.map(o => (
            <button key={o.key} className="add-param-item" onClick={() => {onAdd(o); setOpen(false);}}>
              <span className="k">{o.label}</span>
              <span className="desc">{o.desc}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Deviation probability Section ----------
   Per YAML reference: top-level stream param, not part of grain.
   Modes:
     - off           → deviation_probability: false        (ranges only active if range_always_active)
     - implicit      → deviation_probability: null/absent  (default ~1% global probability)
     - global        → deviation_probability: number | [[t,v],…]  (probability 0–100, same for all params)
     - per-parameter → deviation_probability: { volume?, pan?, duration?, pitch?, pointer?,
                                                 reverse? | read_direction?, pc_rand_envelope? }
                       each value scalar or envelope (0–100); a key left out (or
                       null) is range-only for that param — its _range applies at
                       100% if present, else no variation (engine: GateFactory
                       range-only, same as deviation_probability:false for that param)
*/
/* Il catalogo governa le RIGHE: tutte e nove le chiavi che l'editor puo'
   trovare scritte, comprese le inerti, che restano visibili (marcate) e
   cancellabili. Non e' la lista di cosa il motore consulta — quella e'
   window.PGEDeviationProb.liveParamKeys, che dipende dal blocco `grain` e ne
   ammette al massimo sette — e sono le voci del MENU di aggiunta a seguirla,
   con un filtro a parte. L'ordine e' quello di liveParamKeys, con in coda le
   due chiavi che quella lista non nomina mai. */
const DEVIATION_PROB_PARAMS = [
  { key: "volume",   desc: "applies volume_range per grain" },
  { key: "pan",      desc: "applies pan_range per grain" },
  { key: "duration", desc: "applies grain.duration_range" },
  { key: "pitch",    desc: "applies pitch.range" },
  { key: "pointer",  desc: "applies pointer.offset_range" },
  { key: "reverse",  desc: "flip grain reverse flag" },
  // Voce distinta da `reverse`, non un suo alias (PGE #207): ciascuna governa
  // la propria chiave del blocco grain e non tocca l'altra. Un
  // `deviation_probability: {reverse: N}` scritto prima non ribalta un
  // `read_direction` aggiunto dopo. Sono un gruppo esclusivo: il motore ne
  // legge UNA sola, quella del verso dichiarato in grain, e l'altra la scarta.
  { key: "read_direction", desc: "flip the declared grain.read_direction" },
  // La probabilita' di cambio finestra si dichiara su `pc_rand_envelope`, non
  // su `envelope`: quest'ultima e' il deviation_probability_key di
  // `grain_envelope`, che pero' e' `is_smart=False` e non passa mai da
  // GateFactory — `{envelope: 50}` costruisce un AlwaysGate quando il gate e'
  // attivo e le finestre dichiarate sono piu' di una (lista o `all`), un
  // NeverGate in ogni altro caso, compreso il dict transition/multistate, dove
  // il gate e' spento a monte e le finestre sono comunque due. In nessuno dei
  // due casi il numero scritto conta, ed e' indistinguibile da una chiave
  // inventata. Verificato eseguendo il motore. `pc_rand_envelope` e' il
  // param_key vero (window_controller.py), e con esso `{pc_rand_envelope: 50}`
  // costruisce il RandomGate atteso.
  { key: "pc_rand_envelope", desc: "switch window when grain.envelope is a list" },
  // Chiave morta, tenuta nel catalogo per un motivo solo: i progetti che la
  // portano scritta. Il catalogo governa le RIGHE, il menu di aggiunta e'
  // filtrato a parte su liveParamKeys — quindi questa voce non e' offerta a
  // nessuno, ma un `{envelope: 50}` gia' nel file resta visibile, spiegato e
  // cancellabile. Toglierla del tutto cancellava l'unico posto in cui quello
  // sbaglio era correggibile.
  { key: "envelope", desc: "chiave morta: il motore non la legge — usa pc_rand_envelope" },
];

/* Perche' una chiave scritta in deviation_probability e' inerte su QUESTO
   stream — undefined se e' viva. I casi sono TRE, quanti sono gli insiemi che
   liveParamKeys esclude, e il ternario inline che stava nel title ne
   distingueva due:
     - `envelope`, sempre: il motore non la legge mai (il suo spec
       `grain_envelope` e' is_smart=False, non raggiunge GateFactory);
     - il perdente del gruppo esclusivo reverse/read_direction, sempre: il
       motore legge quella dichiarata in grain e scarta l'altra;
     - `pc_rand_envelope`, quando grain.envelope e' in forma transition
       (`{from, to}`) o multistate (`{states}`): li' il gate e' spento a monte
       (uses_gate, window_controller.py) e la finestra la sceglie la curva.
   Il terzo cadeva nel ramo `else`, cioe' in quello del verso: la spiegazione
   era falsa e mandava a cercare il problema in grain.reverse, mentre la causa
   e' grain.envelope e il rimedio e' cambiare quello. Sullo stesso stream il
   rimando di `envelope` a `pc_rand_envelope` diventa a sua volta fuorviante —
   quella riga e' inerte anche lei — quindi e' condizionato. */
function deviationProbInertReason(key, liveKeys) {
  if (liveKeys.includes(key)) return undefined;
  if (key === "pc_rand_envelope")
    return "grain.envelope e' in forma transition o multistate: li' la finestra la sceglie la curva, non un gate — il rimedio e' cambiare la forma della finestra";
  if (key === "envelope")
    return liveKeys.includes("pc_rand_envelope")
      ? "il motore non legge questa chiave: la probabilita' di cambio finestra e' pc_rand_envelope"
      : "il motore non legge questa chiave; e su questo stream non e' letta nemmeno pc_rand_envelope, perche' grain.envelope e' in forma transition o multistate";
  return "su questo stream il verso e' governato dall'altra chiave del gruppo: questa non viene letta";
}

function DeviationProbabilitySection({ stream, onChange, onFocusEnvParam }) {
  const { Section, ParamRow, Seg, Icon, Tag, NumberField } = window.PGE;
  const PGEDeviationProb = window.PGEDeviationProb, PGEEnv = window.PGEEnv;
  const d = stream.deviationProbability;
  // Classification lives in the shared window.PGEDeviationProb (single source
  // of truth, mirrors the engine's
  // GateFactory._classify_deviation_probability). `dIsEnv` is true when the
  // global value is an envelope — array [[t,v],…] OR the typed
  // {type, points} object form the EnvelopeEditor emits for a non-linear global
  // interpolation (cubic/exp). Treating the typed form as a global env is what
  // stops "cubic" from collapsing the envelope and flipping mode to per-param.
  const mode = PGEDeviationProb.mode(d);          // off | implicit | global | perParam
  // Le chiavi che questo stream fa consultare davvero al motore: la voce da
  // aggiungere e' quella, non entrambe le meta' del gruppo esclusivo.
  const liveKeys = PGEDeviationProb.liveParamKeys(stream);
  const dIsEnv = PGEDeviationProb.isEnvValue(d);
  // Corpi che il motore rifiuta da PGE #209 — envelope svuotato, lista senza
  // breakpoint, dict senza points. Nessun controllo qui sotto li produce:
  // arrivano dal tab Raw o da uno YAML scritto a mano, e prima di #209
  // rendevano applicando la deviazione al 100% dei grani, cioe' l'opposto di
  // quanto scritto. Ora il render esce con errore: meglio dirlo qui.
  // Lo stream serve alle chiavi condizionali: quale del verso `reverse` /
  // `read_direction` il motore legge davvero (gruppo esclusivo, decide il
  // blocco grain) e se `pc_rand_envelope` e' viva (lo e' salvo grain.envelope
  // in forma transition o multistate). Senza, quelle tre non si possono
  // attribuire e resterebbero non validate.
  const bodyErr = PGEDeviationProb.error(d, stream);
  // `true` è un modo globale valido, non off: il motore lo legge come
  // float(True) = 1%. Mostrarlo come 1 evita un campo numerico che dice
  // "true", senza riscrivere lo YAML finché non lo si tocca.
  const dScalar = typeof d === "boolean" ? 1 : d;

  function setMode(next) {
    if (next === "off")       return onChange({ deviationProbability: false });
    if (next === "implicit")  return onChange({ deviationProbability: window.PGEYaml.DEVIATION_PROB_IMPLICIT });
    if (next === "global")    return onChange({ deviationProbability: typeof d === "number" ? d : (dIsEnv ? d : 1) });
    if (next === "perParam")  return onChange({ deviationProbability: mode === "perParam" ? d : { volume: 50 } });
  }

  // Mini-badge mostra mode + sintesi numerica
  const badge = (() => {
    if (mode === "off")       return <span className="mono" style={{color:"var(--fg-3)"}}>off</span>;
    if (mode === "implicit")  return <span className="mono" style={{color:"var(--fg-3)"}}>implicit · 1%</span>;
    if (mode === "global")    {
      if (dIsEnv) return <span className="mono" style={{color:"var(--accent)"}}>env · {PGEEnv.desugarBPGroups(PGEEnv.unwrapEnv(d).items).length} bp</span>;
      return <span className="mono" style={{color:"var(--accent)"}}>{dScalar}%</span>;
    }
    const n = Object.keys(d || {}).length;
    return <span className="mono" style={{color:"var(--accent)"}}>per-param · {n}</span>;
  })();

  return (
    <Section title="Deviation prob" badge={badge}
             right={<span className="mono" style={{fontSize:9, color:"var(--fg-4)"}}>stochastic ·_range gate</span>}>
      {/* Provenienza, non errore: il valore arriva dalla grafia morta e al
          salvataggio la chiave viene riscritta. E' la conversione che il motore
          chiede, quindi `voice-empty` e non `--status-error` — che in questa
          sezione e' gia' preso dagli errori di corpo envelope. Senza questa
          riga la migrazione e' muta: in questo repo un render persiste lo stato
          dell'editor su configs/<basename>.yml anche senza Save, quindi la
          riscrittura si scoprirebbe solo dal `git diff`, o non si scoprirebbe. */}
      {stream.deviationProbabilityLegacy ? (
        <div className="voice-empty">letto da <code>dephase</code>, chiave che il motore non legge piu&#39; (PGE v7.0.0): al salvataggio viene riscritta come <code>deviation_probability</code></div>
      ) : null}
      <div className="pge-prow">
        <span className="k">mode</span>
        <span />
        <span className="v">
          <Seg size="xs" value={mode} onChange={setMode}
               options={[
                 {label:"off",      value:"off"},
                 {label:"implicit", value:"implicit"},
                 {label:"global",   value:"global"},
                 {label:"per-param",value:"perParam"},
               ]} />
        </span>
        <span />
      </div>

      {bodyErr ? (
        <div className="pge-prow" style={{paddingTop:0}}>
          <span className="k" /><span />
          <span className="v mono" style={{fontSize:9, color:"var(--status-error)", lineHeight:1.4}}>
            {bodyErr.kind === "type"
              ? `deviation_probability${bodyErr.param ? "." + bodyErr.param : ""}: ${JSON.stringify(bodyErr.value)} non e' ne' una probabilita' (0-100) ne' un envelope: il motore rifiuta lo stream.`
              : `deviation_probability${bodyErr.param ? "." + bodyErr.param : ""}: ${bodyErr.reason === "empty" ? "envelope senza breakpoint" : "questo corpo non si costruisce come envelope"} — il motore rifiuta lo stream (prima lo trattava come 100%).`}
          </span>
          <span />
        </div>
      ) : null}

      {mode === "off" ? (
        <div className="voice-empty">all _range fields ignored (unless range_always_active)</div>
      ) : null}

      {mode === "implicit" ? (
        <div className="voice-empty">no explicit value → engine uses default 1% global probability</div>
      ) : null}

      {mode === "global" ? (
        <ParamRow name="probability"
                  mode={dIsEnv ? "env" : "scalar"}
                  onMode={(m) => {
                    if (m === "env") {
                      const v = typeof dScalar === "number" ? dScalar : 1;
                      onChange({ deviationProbability: [[0, v], [1, v]] });
                    } else {
                      const items = dIsEnv ? PGEEnv.desugarBPGroups(PGEEnv.unwrapEnv(d).items) : null;
                      const v = (items && items[0] && items[0][1]) || 1;
                      onChange({ deviationProbability: v });
                    }
                  }}
                  value={dIsEnv ? "—" : dScalar}
                  unit={dIsEnv ? "" : "%"}
                  accent={dIsEnv}
                  envValue={dIsEnv ? PGEEnv.desugarBPGroups(PGEEnv.unwrapEnv(d).items) : null}
                  onEditEnv={onFocusEnvParam ? () => onFocusEnvParam("deviation_probability") : undefined}
                  onValue={(v) => onChange({deviationProbability: v})} />
      ) : null}

      {mode === "perParam" ? (
        <>
          {DEVIATION_PROB_PARAMS.filter(p => (d && d[p.key] != null)).map(p => {
            const val = d[p.key];
            // Same typed-env handling per parameter: a per-param value can also
            // take the {type, points} form (cubic on a per-param envelope).
            const isEnv = PGEDeviationProb.isEnvValue(val);
            const items = isEnv ? PGEEnv.desugarBPGroups(PGEEnv.unwrapEnv(val).items) : null;
            return (
              <div key={p.key} className="pge-prow">
                {/* Scritta ma inerte su QUESTO stream: la chiave morta
                    `envelope`, e il perdente del gruppo esclusivo
                    reverse/read_direction. Il motore non le consulta, quindi il
                    numero scritto non fa niente — la riga resta (e' scritta,
                    va vista e tolta) ma lo dice. */}
                <span className="k" style={liveKeys.includes(p.key) ? undefined : {opacity:.55}}
                      title={deviationProbInertReason(p.key, liveKeys)}>
                  {p.key}{liveKeys.includes(p.key) ? null : <span style={{color:"var(--fg-4)"}}> · inerte</span>}
                </span>
                <Seg size="xs" value={isEnv ? "env" : "scalar"}
                     onChange={(m) => {
                       const nv = m === "env" ? [[0, typeof val==="number" ? val : 1], [1, typeof val==="number" ? val : 1]] : ((items && items[0] && items[0][1]) || 1);
                       onChange({ deviationProbability: { ...d, [p.key]: nv } });
                     }}
                     options={[{label:"scalar",value:"scalar"},{label:"env",value:"env"}]} />
                {isEnv ? (
                  <span className="v env" onClick={onFocusEnvParam ? () => onFocusEnvParam("deviation_probability_" + p.key) : undefined} style={onFocusEnvParam ? {cursor:"pointer"} : undefined}>
                    <span className="env-mini"><svg viewBox="0 0 100 16" preserveAspectRatio="none"><polyline fill="none" stroke="#FF8C42" strokeWidth="1.2" points={items.map((q,i) => `${(q[0]/(items[items.length-1][0]||1)*100).toFixed(1)},${(14 - q[1]/100*12).toFixed(1)}`).join(" ")} /></svg></span>
                    <span className="env-label">{items.length} bp</span>
                  </span>
                ) : (
                  <span className="v"><NumberField value={val} unit="%" width={70}
                        onChange={(nv) => onChange({ deviationProbability: { ...d, [p.key]: nv } })} /></span>
                )}
                {/* Tolta l'ultima chiave si torna a "off", cioe' `false`, mai alla
                    chiave vuota: quella e' l'unico dei cinque stati che NON
                    disattiva la deviazione (PGE #210, jitter implicito 1%), e
                    scriverla qui trasformerebbe "nessuna probabilita'
                    dichiarata" in "1% su tutti i parametri". */}
                <button className="pge-icon-btn" title="Remove"
                        onClick={() => { const nd = { ...d }; delete nd[p.key]; onChange({ deviationProbability: Object.keys(nd).length ? nd : false }); }}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            );
          })}
          <AddParamMenu
            options={DEVIATION_PROB_PARAMS.filter(p => liveKeys.includes(p.key) || (d && d[p.key] != null)).map(p => ({
              key: p.key, label: p.key, desc: p.desc,
              exists: d && d[p.key] != null, def: 50
            }))}
            onAdd={(o) => onChange({ deviationProbability: { ...(d || {}), [o.key]: o.def } })} />
          <div className="voice-empty">unlisted params apply their _range at 100% (off if none) — add one only to lower its probability</div>
        </>
      ) : null}
    </Section>
  );
}

function SamplePickerMenu({ current, onPick, showLabel, triggerRef }) {
  const { Icon } = window.PGE;
  const [open, setOpen] = React.useState(false);
  const [files, setFiles] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef(null);
  const inputRef = React.useRef(null);

  // close on click outside
  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false); setQuery("");
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // autofocus input when menu opens
  React.useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  async function handleOpen() {
    if (open) { setOpen(false); setQuery(""); return; }
    if (files === null) {
      setLoading(true);
      try {
        const result = await window.PGEBackend.current.fs.listDir("media");
        setFiles(result.files || []);
      } catch (e) {
        console.error("[SamplePickerMenu] listDir failed:", e);
        setFiles([]);
      }
      setLoading(false);
    }
    setOpen(true);
  }
  if (triggerRef) triggerRef.current = handleOpen;

  const filtered = (files || []).filter(f =>
    f.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div ref={rootRef} style={{position:"relative", display:"inline-flex", alignItems:"center", gap:4}}>
      {showLabel && (
        <span className="v" style={{color:"var(--accent)", cursor:"pointer", fontFamily:"var(--mono)", fontSize:10}} onClick={handleOpen} title="change sample">
          {current}
        </span>
      )}
      <button className="pge-icon-btn" title="change sample" onClick={handleOpen}>
        <Icon name="chevronDown" size={11} />
      </button>
      {open ? (
        <div className="add-param-menu" style={{right:0, left:"auto", minWidth:200}}>
          <div style={{padding:"4px 6px", borderBottom:"1px solid var(--border)"}}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
              placeholder="cerca…"
              style={{
                width:"100%", boxSizing:"border-box",
                background:"var(--bg-2)", color:"var(--fg-1)",
                border:"1px solid var(--border)", borderRadius:3,
                padding:"2px 5px", fontSize:10, fontFamily:"var(--mono)",
                outline:"none",
              }}
            />
          </div>
          <div style={{maxHeight:200, overflowY:"auto"}}>
            {loading ? (
              <div className="add-param-item" style={{color:"var(--fg-4)"}}>loading…</div>
            ) : filtered.length === 0 ? (
              <div className="add-param-item" style={{color:"var(--fg-4)"}}>
                {files && files.length === 0 ? "no media files found" : "nessun risultato"}
              </div>
            ) : filtered.map(f => (
              <button key={f.name} className="add-param-item"
                      style={f.name === current ? {color:"var(--accent)"} : {}}
                      onClick={() => { onPick(f.name); setOpen(false); setQuery(""); }}>
                <span className="k" style={{fontFamily:"var(--mono)", fontSize:10}}>{f.name}</span>
                {f.duration ? <span className="desc">{f.duration.toFixed(2)}s</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Inspector({ stream, onChange, onClose, tab, onTab, samples, freezeEnvOnResize, onFreezeEnvToggle, onFocusEnvParam }) {
  const { Section, ParamRow, Seg, Switch, Tag, NumberField, Icon, Button } = window.PGE;
  const [paramModes, setParamModes] = useStateIN({});
  const [selRow, setSelRow] = useStateIN(null);
  const samplePickerTrigger = React.useRef(null);
  const ibodyRef = React.useRef(null);
  const ibodyScrollTop = React.useRef(0);
  const focusEnv = onFocusEnvParam ? (key) => () => onFocusEnvParam(key) : () => undefined;


  // Empty state — inspector opened via shortcut with no stream selected.
  // Keep the panel chrome so the layout doesn't jump, but show a hint.
  if (!stream) {
    return (
      <aside className="pge-inspector" data-screen-label="02 Inspector · Empty">
        <header className="ihead">
          <span className="title">Inspector</span>
          <span style={{ flex: 1 }} />
          <button className="pge-icon-btn" onClick={onClose} title="Close inspector"><Icon name="x" size={14} /></button>
        </header>
        <div className="inspector-empty">
          <div className="inspector-empty-glyph" aria-hidden="true">
            <svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="14" width="10" height="20" rx="1.5" />
              <rect x="20" y="10" width="10" height="28" rx="1.5" />
              <rect x="34" y="18" width="8" height="12" rx="1.5" />
            </svg>
          </div>
          <div className="inspector-empty-title">Scegli uno stream</div>
          <div className="inspector-empty-hint">
            clicca una clip in timeline per ispezionarne i parametri
          </div>
          {window.prettyShortcut ? (
            <div className="inspector-empty-kbd mono">
              <kbd>{window.prettyShortcut((window.PGE_TWEAKS && window.PGE_TWEAKS.shortcutInspector) || "i")}</kbd>
              <span>per nascondere</span>
            </div>
          ) : null}
        </div>
      </aside>
    );
  }

  const setMode = (k, v) => setParamModes({ ...paramModes, [k]: v });
  const getMode = (k, fallback) => {
    if (paramModes[k]) return paramModes[k];
    if (k === "density" && stream.densityEnv) return "env";
    if (k === "distribution" && stream.distributionEnv) return "env";
    if (k === "speedRatio" && stream.pointer && stream.pointer.speedRatioEnv) return "env";
    if (k === "loopStart"  && stream.pointer && stream.pointer.loopStartEnv)  return "env";
    if (k === "loopDur"    && stream.pointer && stream.pointer.loopDurEnv)    return "env";
    if (k === "grainDur" && stream.grain && stream.grain.durationEnv) return "env";
    if (k === "readDirection" && stream.grain && stream.grain.readDirectionEnv) return "env";
    if (k === "pan" && stream.panEnv) return "env";
    if (k === "volume" && stream.volumeEnv) return "env";
    if (k === "pitch" && stream.pitch && stream.pitch.valueEnv) return "env";
    if (k === "voicesNum" && stream.voices && stream.voices.numEnv) return "env";
    if (k === "scatter" && stream.voices && stream.voices.scatterEnv) return "env";
    if (k === "panRange"      && stream.panRangeEnv)                              return "env";
    if (k === "volumeRange"   && stream.volumeRangeEnv)                           return "env";
    if (k === "pitchRange"    && stream.pitch && stream.pitch.rangeEnv)           return "env";
    if (k === "durationRange" && stream.grain && stream.grain.durationRangeEnv)   return "env";
    if (k === "offsetRange"   && stream.pointer && stream.pointer.offsetRangeEnv) return "env";
    if (k === "fillFactor"    && stream.fillFactorEnv)                            return "env";
    if (k === "loopEnd"       && stream.pointer && stream.pointer.loopEndEnv)     return "env";
    return fallback || "scalar";
  };

  // Toggle a parameter between scalar and env, mutating the stream.
  // When entering env, seed an env array from the current scalar; when leaving env, collapse env→scalar.
  function toggleMode(k, newMode) {
    setMode(k, newMode);
    const defaultsByKey = { density: 8, fillFactor: 2, distribution: 0, speedRatio: 1, grainDur: 0.05, pan: 0, volume: 0 };
    const fields = {
      density:      { sk: "density",     ek: "densityEnv" },
      fillFactor:   { sk: "fillFactor",  ek: "fillFactorEnv" },
      distribution: { sk: "distribution",ek: "distributionEnv" },
      pan:          { sk: "pan",         ek: "panEnv" },
      volume:       { sk: "volume",      ek: "volumeEnv" },
    };
    if (k === "speedRatio") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.speedRatio != null ? cur.speedRatio : 1;
        onChange({ pointer: { ...cur, speedRatio: null, speedRatioEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.speedRatioEnv && cur.speedRatioEnv[0] && cur.speedRatioEnv[0][1]) || 1;
        onChange({ pointer: { ...cur, speedRatio: v, speedRatioEnv: null } });
      }
      return;
    }
    if (k === "grainDur") {
      const cur = stream.grain || {};
      if (newMode === "env") {
        const v = cur.duration != null ? cur.duration : 0.05;
        onChange({ grain: { ...cur, duration: null, durationEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.durationEnv && cur.durationEnv[0] && cur.durationEnv[0][1]) || 0.05;
        onChange({ grain: { ...cur, duration: v, durationEnv: null } });
      }
      return;
    }
    if (k === "readDirection") {
      // Dominio {-1, +1} (PGE #207): l'envelope seminato è un cambio di verso,
      // non la rampa costante degli altri parametri — su due stati una rampa
      // non ha niente da produrre. Tornando a scalare si snappa il primo
      // breakpoint invece di prenderlo com'è: un valore intermedio arrivato
      // da un file scritto a mano non deve sopravvivere al giro.
      const cur = stream.grain || {};
      const S = window.PGEEnvUtils.snapDirection;
      if (newMode === "env") {
        const v = cur.readDirection != null ? S(cur.readDirection) : 1;
        onChange({ grain: { ...cur, readDirection: null,
                            readDirectionEnv: [[0, v], [0.5, -v]] } });
      } else {
        const first = cur.readDirectionEnv && cur.readDirectionEnv[0]
          && cur.readDirectionEnv[0][1];
        onChange({ grain: { ...cur, readDirection: first != null ? S(first) : 1,
                            readDirectionEnv: null } });
      }
      return;
    }
    if (k === "loopStart") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.loopStart != null ? cur.loopStart : 0;
        onChange({ pointer: { ...cur, loopStart: null, loopStartEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.loopStartEnv && cur.loopStartEnv[0] && cur.loopStartEnv[0][1]) || 0;
        onChange({ pointer: { ...cur, loopStart: v, loopStartEnv: null } });
      }
      return;
    }
    if (k === "loopDur") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.loopDur != null ? cur.loopDur : 1;
        onChange({ pointer: { ...cur, loopDur: null, loopDurEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.loopDurEnv && cur.loopDurEnv[0] && cur.loopDurEnv[0][1]) || 1;
        onChange({ pointer: { ...cur, loopDur: v, loopDurEnv: null } });
      }
      return;
    }
    if (k === "loopEnd") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.loopEnd != null ? cur.loopEnd : 1;
        onChange({ pointer: { ...cur, loopEnd: null, loopEndEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.loopEndEnv && cur.loopEndEnv[0] && cur.loopEndEnv[0][1]) || 1;
        onChange({ pointer: { ...cur, loopEnd: v, loopEndEnv: null } });
      }
      return;
    }
    if (k === "pitch") {
      const cur = stream.pitch || {};
      if (newMode === "env") {
        const v = cur.value != null ? cur.value : (cur.unit === "ratio" ? 1.0 : 0);
        onChange({ pitch: { ...cur, value: null, valueEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.valueEnv && cur.valueEnv[0] && cur.valueEnv[0][1]);
        onChange({ pitch: { ...cur, value: v != null ? v : (cur.unit === "ratio" ? 1.0 : 0), valueEnv: null } });
      }
      return;
    }
    if (k === "voicesNum") {
      const cur = stream.voices || {};
      if (newMode === "env") {
        const v = cur.num != null ? cur.num : 1;
        onChange({ voices: { ...cur, num: null, numEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.numEnv && cur.numEnv[0] && cur.numEnv[0][1]) || 1;
        onChange({ voices: { ...cur, num: v, numEnv: null } });
      }
      return;
    }
    if (k === "scatter") {
      const cur = stream.voices || {};
      if (newMode === "env") {
        const v = cur.scatter != null ? cur.scatter : 0;
        onChange({ voices: { ...cur, scatter: null, scatterEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.scatterEnv && cur.scatterEnv[0] && cur.scatterEnv[0][1]) || 0;
        onChange({ voices: { ...cur, scatter: v, scatterEnv: null } });
      }
      return;
    }
    if (k === "panRange") {
      if (newMode === "env") {
        const v = stream.panRange != null ? stream.panRange : 0;
        onChange({ panRange: null, panRangeEnv: [[0, v], [1, v]] });
      } else {
        const v = (stream.panRangeEnv && stream.panRangeEnv[0] && stream.panRangeEnv[0][1]) || 0;
        onChange({ panRange: v, panRangeEnv: null });
      }
      return;
    }
    if (k === "volumeRange") {
      if (newMode === "env") {
        const v = stream.volumeRange != null ? stream.volumeRange : 0;
        onChange({ volumeRange: null, volumeRangeEnv: [[0, v], [1, v]] });
      } else {
        const v = (stream.volumeRangeEnv && stream.volumeRangeEnv[0] && stream.volumeRangeEnv[0][1]) || 0;
        onChange({ volumeRange: v, volumeRangeEnv: null });
      }
      return;
    }
    if (k === "pitchRange") {
      const cur = stream.pitch || {};
      if (newMode === "env") {
        const v = cur.range != null ? cur.range : 0;
        onChange({ pitch: { ...cur, range: null, rangeEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.rangeEnv && cur.rangeEnv[0] && cur.rangeEnv[0][1]) || 0;
        onChange({ pitch: { ...cur, range: v, rangeEnv: null } });
      }
      return;
    }
    if (k === "durationRange") {
      const cur = stream.grain || {};
      if (newMode === "env") {
        const v = cur.durationRange != null ? cur.durationRange : 0;
        onChange({ grain: { ...cur, durationRange: null, durationRangeEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.durationRangeEnv && cur.durationRangeEnv[0] && cur.durationRangeEnv[0][1]) || 0;
        onChange({ grain: { ...cur, durationRange: v, durationRangeEnv: null } });
      }
      return;
    }
    if (k === "offsetRange") {
      const cur = stream.pointer || {};
      if (newMode === "env") {
        const v = cur.offsetRange != null ? cur.offsetRange : 0;
        onChange({ pointer: { ...cur, offsetRange: null, offsetRangeEnv: [[0, v], [1, v]] } });
      } else {
        const v = (cur.offsetRangeEnv && cur.offsetRangeEnv[0] && cur.offsetRangeEnv[0][1]) || 0;
        onChange({ pointer: { ...cur, offsetRange: v, offsetRangeEnv: null } });
      }
      return;
    }
    const f = fields[k]; if (!f) return;
    if (newMode === "env") {
      const v = stream[f.sk] != null ? stream[f.sk] : defaultsByKey[k];
      onChange({ [f.sk]: null, [f.ek]: [[0, v], [1, v]] });
    } else {
      const v = (stream[f.ek] && stream[f.ek][0] && stream[f.ek][0][1]) || defaultsByKey[k];
      onChange({ [f.sk]: v, [f.ek]: null });
    }
  }

  const _sampleList = samples || [];
  const sampleDur = (_sampleList.find(s => s.name === stream.sample) || {}).duration;
  const sampleMissing = !sampleDur;

  // loop_start/end/dur can't address past the sample's end — clamp scalar edits
  // to it (1.0 in normalized mode), unit-aware via loopEnvMax. A null cap (the
  // duration is unknown) keeps the static PGE_BOUNDS max. Mirrors the
  // sample-driven hardMax the EnvelopeEditor applies to the same params.
  const loopMax = window.PGEEnvUtils.loopEnvMax(stream, sampleDur);
  // Which unit the loop coordinates are in, and where it comes from (issue
  // #126). Every stream the editor creates is born `time_mode: normalized`, so
  // the loop window silently lives in [0,1] and the cap of 1 reads as arbitrary
  // — the YAML never mentions loop_unit. `loopUnitInherited` is what would be in
  // force with the key absent: picking it in the control deletes the key instead
  // of materializing a redundant one.
  const loopUnit = window.PGEEnvUtils.loopUnitInfo(stream);
  const loopUnitInherited = window.PGEEnvUtils.loopUnitInfo({ timeMode: stream.timeMode }).unit;
  // In normalized le coordinate del loop non sono secondi: un suffisso "s"
  // contraddirebbe la riga di hint due righe più sotto.
  const loopUnitSuffix = loopUnit.unit === "normalized" ? "" : "s";
  // Il blocco loop — controllo dell'unità e riga di hint — compare solo se una
  // chiave di loop esiste. pointer.start sta fuori ma il motore lo scala con lo
  // stesso criterio (_pre_normalize_loop_params scala 'start' a prescindere dal
  // loop), quindi senza blocco resterebbe senza suffisso e senza nessuno che
  // dica perché: uno YAML scritto a mano con time_mode: normalized e nessun
  // loop cade proprio lì. La scala sì, il bound no: 'start' è dichiarato
  // is_smart=False nello schema del motore — valore raw, nessun Parameter e
  // quindi nessun clamp — perciò qui NON passa da clampLoop e il Seg non lo
  // include nel ri-clamp: sarebbe la UI a inventarsi un vincolo che il motore
  // non ha.
  const loopBlockShown = !!(stream.pointer && (
    stream.pointer.loopStart != null || stream.pointer.loopStartEnv != null ||
    stream.pointer.loopEnd   != null || stream.pointer.loopEndEnv   != null ||
    stream.pointer.loopDur   != null || stream.pointer.loopDurEnv   != null ||
    stream.pointer.loopUnit  != null));
  // `cap` overrides the current loop cap — the unit control needs to clamp
  // against the cap the NEW unit brings, before the new pointer is state.
  const clampLoop = (key, v, cap) => {
    const b = window.PGE_BOUNDS[key];
    const hi = cap === undefined ? loopMax : cap;
    const max = hi != null ? hi : (b ? b.max : Infinity);
    return Math.max(b ? b.min : 0, Math.min(max, v));
  };

  // Loop semantics (issue #97): with a loop active the engine confines the grain
  // read position — base + offset_range + voice pointer offsets — to
  // [loop_start, loop_end) via modular wrap (previously the deviation could read
  // the whole file). A degenerate static window (loop_end <= loop_start) is
  // rejected at render (InvalidFieldValueError) → warn pre-render. loopActive
  // gates the offset_range confinement note; loopEndMode the loop_dur hint.
  const loopBoundsErr = window.PGEEnvUtils.loopBoundsError(stream.pointer);
  const loopActive = !!(stream.pointer && (
    stream.pointer.loopStart != null || stream.pointer.loopStartEnv != null ||
    stream.pointer.loopEnd   != null || stream.pointer.loopEndEnv   != null ||
    stream.pointer.loopDur   != null || stream.pointer.loopDurEnv   != null));
  const loopEndMode = !!(stream.pointer && (stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null));

  return (
    <aside className="pge-inspector" data-screen-label={tab === "raw" ? "03 Inspector Raw" : "02 Inspector Preview"}>
      <header className="ihead">
        <span className="title">Inspector</span>
        <span className="streamtag" style={{borderColor: stream.color, color: stream.color}}>{stream.id}</span>
        {sampleMissing ? <Tag kind="err">sample missing</Tag> : null}
        <span style={{ flex: 1 }} />
        <Seg value={tab} onChange={onTab} options={[{label:"Preview", value:"preview"},{label:"Raw", value:"raw"}]} />
        <button className="pge-icon-btn" onClick={onClose} title="Close inspector"><Icon name="x" size={14} /></button>
      </header>

      {tab === "preview" ? (
        <>
          <div className="isubhead">
            <span className="scrub"><span className="acc">{stream.id}</span> · {stream.sample} · {stream.onset.toFixed(2)}s → {(stream.onset + stream.duration).toFixed(2)}s</span>
            <span style={{flex:1}} />
            <Switch value={stream.solo} onChange={v => onChange({solo: v})} label="solo" />
            <Switch value={stream.mute} onChange={v => onChange({mute: v})} label="mute" />
          </div>
          <div className="ibody" ref={el => { ibodyRef.current = el; if (el) el.scrollTop = ibodyScrollTop.current; }} onScroll={e => { ibodyScrollTop.current = e.currentTarget.scrollTop; }}>

            <Section title="Essentials"
                     badge={sampleDur ? <span className="mono">{sampleDur.toFixed(3)} s</span> :
                                       <span className="mono" style={{color:"var(--status-error)"}}>sample not found</span>}>
              <div className="pge-prow">
                <span className="k">stream_id</span><span />
                <span className="v" style={{color:"var(--accent)"}}>"{stream.id}"</span>
                <span />
              </div>
              <ParamRow name="onset" mode="scalar" value={stream.onset} unit="s"
                onSelect={() => setSelRow("onset")} selected={selRow==="onset"}
                onValue={(v) => onChange({onset: v})} />
              <ParamRow name="duration" mode="scalar" value={stream.duration} unit="s"
                onSelect={() => setSelRow("duration")} selected={selRow==="duration"}
                onValue={(v) => onChange({duration: v})}
                right={
                  <button
                    className={"pge-icon-btn" + (freezeEnvOnResize ? " active" : "")}
                    title={freezeEnvOnResize ? "envelopes: freeze (BPs keep absolute positions)" : "envelopes: stretch (BPs scale with duration)"}
                    onClick={(e) => { e.stopPropagation(); onFreezeEnvToggle && onFreezeEnvToggle(!freezeEnvOnResize); }}
                    style={{opacity: freezeEnvOnResize ? 1 : 0.4}}
                  >
                    <Icon name={freezeEnvOnResize ? "lock" : "lockOpen"} size={11} />
                  </button>
                } />
              {/* duration implicita (engine #205): la chiave non c'e' nel YAML e
                  la lunghezza viene dal sample. Va detto, perche' il numero
                  mostrato non e' scritto da nessuna parte e cambia se cambia il
                  file; e va detto anche quando il sample non e' risolvibile,
                  perche' li' il numero e' una stima del solo editor. */}
              {stream.durationImplicit ? (
                <div className="pge-prow hint" style={{paddingTop:0}}>
                  <span className="k" /><span />
                  <span className="v mono" style={{
                    fontSize:9, lineHeight:1.4,
                    color: stream.durationUnresolved ? "var(--status-warn)" : "var(--fg-4)",
                  }}>
                    {stream.durationUnresolved
                      ? "durata stimata — non scritta nel YAML"
                      : "implicita = durata del sample · modificarla la rende esplicita"}
                  </span>
                  <span />
                </div>
              ) : null}
              <div className="pge-prow">
                <span className="k">sample</span>
                <span />
                <span className="v" style={{color:"var(--accent)", cursor:"pointer"}} onClick={() => samplePickerTrigger.current && samplePickerTrigger.current()}>{stream.sample}</span>
                <SamplePickerMenu current={stream.sample} onPick={(name) => onChange({sample: name})} showLabel={false} triggerRef={samplePickerTrigger} />
              </div>
            </Section>

            <Section title="Identity"
                     right={<span className="mono" style={{fontSize:9, color:"var(--fg-4)"}}>stream context</span>}>
              <div className="pge-prow">
                <span className="k" title="envelope time axis: normalized → x ∈ [0,1] of stream duration · absolute → x in seconds (engine default)">time_mode</span>
                <span />
                <span className="v">
                  <span className="mono" style={{fontSize:10, color:"var(--fg-3)"}}>
                    {stream.timeMode || "absolute"}{stream.timeMode ? "" : " (default)"}
                  </span>
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="shared RNG identity (engine #169): same group → same random sequences. Needs a project seed, and the same density/distribution — otherwise the time grids drift apart. Empty → per-stream isolation (stream_id)">rng_group</span>
                <span />
                <span className="v">
                  <input type="text" className="pge-mini-input" style={{width: 110}}
                         placeholder="(none)"
                         key={stream.id + ":" + (stream.rngGroup || "")}
                         defaultValue={stream.rngGroup || ""}
                         onBlur={e => {
                           const v = e.target.value.trim();
                           if (v !== (stream.rngGroup || "")) onChange({rngGroup: v || undefined});
                         }}
                         onKeyDown={e => {
                           if (e.key === "Enter") e.target.blur();
                           if (e.key === "Escape") { e.target.value = stream.rngGroup || ""; e.target.blur(); }
                         }} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="how a _range band is filled: uniform (flat) or gaussian (bell, σ = width/6)">distribution_mode</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.distributionMode || "uniform"} onChange={v => onChange({distributionMode: v})}
                       options={[{label:"uniform",value:"uniform"},{label:"gaussian",value:"gaussian"}]} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="where base sits inside a _range band: center (base ± range/2) or min (base → base+range)">range_anchor</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.rangeAnchor || "center"}
                       onChange={v => onChange({rangeAnchor: v === "center" ? undefined : v})}
                       options={[{label:"center",value:"center"},{label:"min",value:"min"}]} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="when true, *_range fields apply even with deviation_probability off">range_always_active</span>
                <span />
                <span className="v">
                  <Switch value={!!stream.rangeAlwaysActive}
                          onChange={v => onChange({rangeAlwaysActive: v})} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="multiply all temporal values (onset, duration, grain.duration)">time_scale</span>
                <span />
                <span className="v">
                  <NumberField value={stream.timeScale != null ? stream.timeScale : 1.0}
                               onChange={v => onChange({timeScale: v})} width={70} unit="×" />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="how grains that extend past clip end are handled">clip_strategy</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.clipStrategy || "overflow_margin"}
                       onChange={v => onChange({clipStrategy: v})}
                       options={[{label:"overflow",value:"overflow_margin"},{label:"passthrough",value:"passthrough"}]} />
                </span>
                <span />
              </div>
              <div className="pge-prow">
                <span className="k" title="extra seconds beyond duration for tail grains">clip_margin</span>
                <span />
                <span className="v">
                  <NumberField value={stream.clipMargin != null ? stream.clipMargin : 0}
                               onChange={v => onChange({clipMargin: v})} width={70} unit="s" />
                </span>
                <span />
              </div>
            </Section>

            <Section title="Overall density"
                     badge={(stream.fillFactor != null || stream.fillFactorEnv != null)
                       ? <span className="mono" style={{color:"var(--accent)"}}>{stream.fillFactorEnv ? `fill_factor · env · ${stream.fillFactorEnv.length} bp` : "fill_factor"}</span>
                       : (stream.densityEnv
                           ? <span className="mono" style={{color:"var(--accent)"}}>density · env · {stream.densityEnv.length} bp</span>
                           : <span className="mono">density</span>)}>
              <div className="pge-prow">
                <span className="k">unit</span>
                <span />
                <span className="v">
                  <Seg size="xs"
                       value={(stream.fillFactor != null || stream.fillFactorEnv != null) ? "fill_factor" : "density"}
                       onChange={(u) => {
                         if (u === "fill_factor") {
                           const ff = 2.0;
                           onChange({ density: null, densityEnv: null, fillFactor: ff, fillFactorEnv: null });
                         } else {
                           onChange({ fillFactor: null, fillFactorEnv: null, density: 8, densityEnv: null });
                         }
                       }}
                       options={[{label:"density",value:"density"},{label:"fill_factor",value:"fill_factor"}]} />
                </span>
                <span />
              </div>
              {(stream.fillFactor != null || stream.fillFactorEnv != null) ? (
                <ParamRow name="fill_factor"
                  mode={getMode("fillFactor")} onMode={(m) => toggleMode("fillFactor", m)}
                  value={stream.fillFactor != null ? stream.fillFactor : "—"} unit={stream.fillFactorEnv ? "" : "×"}
                  accent={stream.fillFactorEnv != null}
                  envValue={stream.fillFactorEnv}
                  onEditEnv={focusEnv("fillFactor")}
                  onSelect={() => setSelRow("fillFactor")} selected={selRow==="fillFactor"}
                  onValue={(v) => onChange({fillFactor: Math.max(window.PGE_BOUNDS.fillFactor.min, Math.min(window.PGE_BOUNDS.fillFactor.max, v))})} />
              ) : (
                <ParamRow name="density"
                          mode={getMode("density")} onMode={(m) => toggleMode("density", m)}
                          value={stream.density != null ? stream.density : "—"} unit={stream.densityEnv ? "" : "g/s"}
                          accent={stream.densityEnv != null}
                          envValue={stream.densityEnv}
                          onEditEnv={focusEnv("density")}
                          onSelect={() => setSelRow("density")} selected={selRow==="density"}
                          onValue={(v) => onChange({density: v})} />
              )}
              <ParamRow name="distribution"
                        mode={getMode("distribution")} onMode={(m) => toggleMode("distribution", m)}
                        value={stream.distribution != null ? stream.distribution : "—"}
                        accent={stream.distributionEnv != null}
                        envValue={stream.distributionEnv}
                        onEditEnv={focusEnv("distribution")}
                        onSelect={() => setSelRow("distribution")} selected={selRow==="distribution"}
                        onValue={(v) => onChange({distribution: v})} />
              <div className="pge-prow hint" style={{paddingTop:0}}>
                <span className="k" />
                <span />
                <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                  0 → synchronous · 0.5 → quasi-sync · 1 → async
                </span>
                <span />
              </div>
            </Section>

            <Section title="Pointer">
              <ParamRow name="speed_ratio"
                        mode={getMode("speedRatio")} onMode={(m) => toggleMode("speedRatio", m)}
                        value={stream.pointer.speedRatio != null ? stream.pointer.speedRatio : "—"} unit="×"
                        accent={stream.pointer.speedRatioEnv != null}
                        envValue={stream.pointer.speedRatioEnv}
                        onEditEnv={focusEnv("speedRatio")}
                        onSelect={() => setSelRow("speed")} selected={selRow==="speed"}
                        onValue={(v) => onChange({pointer: {...stream.pointer, speedRatio: v}})} />
              <ParamRow name="start" mode="scalar"
                        value={stream.pointer.start != null ? stream.pointer.start : 0} unit={loopUnitSuffix}
                        onSelect={() => setSelRow("ptr.start")} selected={selRow==="ptr.start"}
                        onValue={(v) => onChange({pointer: {...stream.pointer, start: v}})} />
              {loopUnit.unit === "normalized" && !loopBlockShown ? (
                <div className="pge-prow hint" style={{paddingTop:0}}>
                  <span className="k" /><span />
                  <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                    pointer.start è scalato per sample_dur dal motore ({loopUnit.source === "loop_unit" ? "loop_unit" : "time_mode"}: normalized) — valore raw, senza bound
                  </span>
                  <span />
                </div>
              ) : null}
              {loopBlockShown ? (
                <>
                  <ParamRow name="loop_start"
                            mode={getMode("loopStart")} onMode={(m) => toggleMode("loopStart", m)}
                            value={stream.pointer.loopStart != null ? stream.pointer.loopStart : (stream.pointer.loopStartEnv ? "—" : 0)} unit={stream.pointer.loopStartEnv ? "" : loopUnitSuffix}
                            accent={stream.pointer.loopStartEnv != null}
                            envValue={stream.pointer.loopStartEnv}
                            onEditEnv={focusEnv("loopStart")}
                            onValue={(v) => onChange({pointer: {...stream.pointer, loopStart: clampLoop("loopStart", v)}})}
                            right={<button className="pge-icon-btn" title="Remove loop"
                              onClick={() => { const np = { ...stream.pointer };
                                delete np.loopStart; delete np.loopStartEnv;
                                delete np.loopEnd; delete np.loopEndEnv;
                                delete np.loopDur; delete np.loopDurEnv;
                                delete np.loopUnit;
                                onChange({ pointer: np }); }}>
                              <Icon name="x" size={11} />
                            </button>} />
                  <div className="pge-prow">
                    <span className="k">loop_end ↔ loop_dur</span>
                    <Seg size="xs"
                         value={(stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null) ? "loop_end" : "loop_dur"}
                         onChange={(u) => {
                           if (u === "loop_end") {
                             const le = stream.pointer.loopEnd != null ? stream.pointer.loopEnd
                               : (stream.pointer.loopStart || 0) + (stream.pointer.loopDur != null ? stream.pointer.loopDur : 1);
                             onChange({ pointer: { ...stream.pointer, loopEnd: le, loopEndEnv: null, loopDur: null, loopDurEnv: null } });
                           } else {
                             const ld = stream.pointer.loopDur != null ? stream.pointer.loopDur
                               : Math.max(0.01, (stream.pointer.loopEnd || 0) - (stream.pointer.loopStart || 0));
                             onChange({ pointer: { ...stream.pointer, loopDur: ld, loopDurEnv: null, loopEnd: null, loopEndEnv: null } });
                           }
                         }}
                         options={[{label:"loop_dur",value:"loop_dur"},{label:"loop_end",value:"loop_end"}]} />
                    <span />
                    <span />
                  </div>
                  {(stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null) ? (
                    <ParamRow name="loop_end"
                              mode={getMode("loopEnd")} onMode={(m) => toggleMode("loopEnd", m)}
                              value={stream.pointer.loopEnd != null ? stream.pointer.loopEnd : (stream.pointer.loopEndEnv ? "—" : 1)} unit={stream.pointer.loopEndEnv ? "" : loopUnitSuffix}
                              accent={stream.pointer.loopEndEnv != null}
                              envValue={stream.pointer.loopEndEnv}
                              onEditEnv={focusEnv("loopEnd")}
                              onValue={(v) => onChange({pointer: {...stream.pointer, loopEnd: clampLoop("loopEnd", v)}})} />
                  ) : (
                    <ParamRow name="loop_dur"
                              mode={getMode("loopDur")} onMode={(m) => toggleMode("loopDur", m)}
                              value={stream.pointer.loopDur != null ? stream.pointer.loopDur : (stream.pointer.loopDurEnv ? "—" : 1)} unit={stream.pointer.loopDurEnv ? "" : loopUnitSuffix}
                              accent={stream.pointer.loopDurEnv != null}
                              envValue={stream.pointer.loopDurEnv}
                              onEditEnv={focusEnv("loopDur")}
                              onValue={(v) => onChange({pointer: {...stream.pointer, loopDur: clampLoop("loopDur", v)}})} />
                  )}
                  <div className="pge-prow">
                    <span className="k" title="unità delle coordinate del loop: absolute → secondi, cap = durata del sample · normalized → [0,1] × sample_dur. Assente = ereditata da time_mode (motore: loop_unit or time_mode)">loop_unit</span>
                    <Seg size="xs" value={loopUnit.unit}
                         onChange={(u) => {
                           const np = { ...stream.pointer };
                           // The unit already in force needs no key: absence
                           // means "inherit from time_mode", and writing it out
                           // would change the YAML without changing the render.
                           if (u === loopUnitInherited) delete np.loopUnit; else np.loopUnit = u;
                           // The cap travels with the unit (1 in normalized,
                           // sample_dur in seconds), so the endpoints get the
                           // same clamp a typed edit gets — otherwise switching
                           // to normalized would leave a 12 s loop_start sitting
                           // in a [0,1] field, which the engine silently clamps
                           // at render. Envelope endpoints are per-grain and
                           // exempt, as everywhere else in the loop block.
                           const cap = window.PGEEnvUtils.loopEnvMax({ ...stream, pointer: np }, sampleDur);
                           for (const k of ["loopStart", "loopEnd", "loopDur"]) {
                             if (typeof np[k] === "number") np[k] = clampLoop(k, np[k], cap);
                           }
                           onChange({ pointer: np });
                         }}
                         options={[{label:"absolute",value:"absolute"},{label:"normalized",value:"normalized"}]} />
                    <span className="v mono" style={{fontSize:9, color:"var(--fg-4)"}}>
                      {loopUnit.source === "loop_unit"
                        ? (stream.pointer.loopUnit === loopUnit.unit
                            ? "esplicito"
                            : ("esplicito: " + stream.pointer.loopUnit))
                        : loopUnit.source === "time_mode" ? ("da time_mode: " + stream.timeMode)
                        : "default"}
                    </span>
                    <span />
                  </div>
                  <div className="pge-prow hint" style={{paddingTop:0}}>
                    <span className="k" /><span />
                    <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                      {loopUnit.unit === "normalized"
                        ? "loop_start/end/dur ∈ [0, 1] · pointer.start è scalato per sample_dur ma resta un valore raw, senza bound (is_smart=False)"
                        : (loopMax != null
                            ? ("loop_start/end/dur in secondi · cap " + (+loopMax.toFixed(3)) + " s (durata del sample)")
                            : "loop_start/end/dur in secondi · durata del sample ignota, cap statico")}
                    </span>
                    <span />
                  </div>
                  {loopBoundsErr ? (
                    <div className="pge-prow" style={{paddingTop:0}}>
                      <span className="k" /><span />
                      <span className="v mono" style={{fontSize:9, color:"var(--status-error)", lineHeight:1.4}}>
                        loop_end ({loopBoundsErr.loopEnd}) ≤ loop_start ({loopBoundsErr.loopStart}): finestra di loop non valida.
                        Per un loop a cavallo della fine del file usa loop_dur.
                      </span>
                      <span />
                    </div>
                  ) : loopEndMode ? (
                    <div className="pge-prow hint" style={{paddingTop:0}}>
                      <span className="k" /><span />
                      <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                        loop_end ∈ [0, sample_dur] · per un loop oltre la fine del file usa loop_dur
                      </span>
                      <span />
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="pge-prow"><span className="k" style={{color:"var(--fg-3)"}}>loop</span><span /><span className="v" style={{color:"var(--fg-3)"}}>—</span><span /></div>
              )}
              {(stream.pointer.offsetRange != null || stream.pointer.offsetRangeEnv != null) ? (
                <ParamRow name="offset_range"
                          mode={getMode("offsetRange")} onMode={(m) => toggleMode("offsetRange", m)}
                          value={stream.pointer.offsetRange != null ? stream.pointer.offsetRange : 0}
                          unit={stream.pointer.offsetRangeEnv ? "" : ""}
                          accent={stream.pointer.offsetRangeEnv != null}
                          envValue={stream.pointer.offsetRangeEnv}
                          onEditEnv={focusEnv("offsetRange")}
                          onValue={(v) => onChange({ pointer: { ...stream.pointer, offsetRange: v } })}
                          right={<button className="pge-icon-btn" title="Remove"
                            onClick={() => { const np = { ...stream.pointer }; delete np.offsetRange; delete np.offsetRangeEnv; onChange({ pointer: np }); }}>
                            <Icon name="x" size={11} />
                          </button>} />
              ) : null}
              {(stream.pointer.offsetRange != null || stream.pointer.offsetRangeEnv != null) && loopActive ? (
                <div className="pge-prow hint" style={{paddingTop:0}}>
                  <span className="k" /><span />
                  <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                    con loop attivo la deviazione resta dentro [loop_start, loop_end)
                  </span>
                  <span />
                </div>
              ) : null}
              <AddParamMenu
                options={[
                  { key: "loopStart",   label: "loop_start",   desc: "loop window start (s) — confines the read to [loop_start, loop_end)",
                    exists: stream.pointer.loopStart != null, def: 0 },
                  { key: "loopEnd",     label: "loop_end",     desc: "loop end (s) ∈ [0, sample_dur], must be > loop_start — mutex w/ loop_dur, has priority",
                    exists: stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null || stream.pointer.loopDur != null || stream.pointer.loopDurEnv != null, def: 1 },
                  { key: "loopDur",     label: "loop_dur",     desc: "loop window length (s) — loop_start+loop_dur > sample_dur ⇒ loop straddling the file end",
                    exists: stream.pointer.loopDur != null || stream.pointer.loopDurEnv != null || stream.pointer.loopEnd != null || stream.pointer.loopEndEnv != null, def: 1 },
                  { key: "offsetRange", label: "offset_range", desc: "per-grain pointer deviation ∈ [-1,1] — with a loop active stays inside [loop_start, loop_end)",
                    exists: stream.pointer.offsetRange != null || stream.pointer.offsetRangeEnv != null, def: 0.01 },
                ]}
                onAdd={(o) => {
                  const np = { ...stream.pointer, [o.key]: o.def };
                  // Loop fields only render together — if the user introduces
                  // loop_end/loop_dur without loop_start, seed it to 0 so the
                  // row block appears.
                  if ((o.key === "loopEnd" || o.key === "loopDur")
                       && np.loopStart == null) {
                    np.loopStart = 0;
                  }
                  onChange({ pointer: np });
                }} />
            </Section>

            <Section title="Grain">
              <ParamRow name="duration"
                        mode={getMode("grainDur")} onMode={(m) => toggleMode("grainDur", m)}
                        value={stream.grain.duration != null ? stream.grain.duration : "—"}
                        unit={stream.grain.durationEnv ? "" : "s"}
                        range={stream.grain.durationRange != null && !stream.grain.durationRangeEnv ? stream.grain.durationRange : undefined}
                        accent={stream.grain.durationEnv != null}
                        envValue={stream.grain.durationEnv}
                        onEditEnv={focusEnv("grainDur")}
                        onSelect={() => setSelRow("grain.dur")} selected={selRow==="grain.dur"}
                        onValue={(v) => onChange({grain: {...stream.grain, duration: v}})} />
              {(stream.grain.durationRange != null || stream.grain.durationRangeEnv != null) ? (
                <ParamRow name="duration_range"
                          mode={getMode("durationRange")} onMode={(m) => toggleMode("durationRange", m)}
                          value={stream.grain.durationRange != null ? stream.grain.durationRange : 0} unit={stream.grain.durationRangeEnv ? "" : "s"}
                          accent={stream.grain.durationRangeEnv != null}
                          envValue={stream.grain.durationRangeEnv}
                          onEditEnv={focusEnv("durationRange")}
                          onValue={(v) => onChange({grain: {...stream.grain, durationRange: v}})} />
              ) : null}
              {/* duration_unit meta-key (PGE #158): seconds (default/absent) | samples */}
              <div className="pge-prow">
                <span className="k" title="unità di grain.duration e duration_range · samples: campioni a 48000 Hz (min 1 campione), richiede una duration esplicita">duration_unit</span>
                <span />
                <span className="v">
                  <Seg size="xs" value={stream.grain.durationUnit || "seconds"}
                       onChange={(v) => {
                         if (v === "samples") {
                           onChange({ grain: { ...stream.grain, durationUnit: "samples" } });
                         } else {
                           const ng = { ...stream.grain }; delete ng.durationUnit;
                           onChange({ grain: ng });
                         }
                       }}
                       options={[{label:"seconds",value:"seconds"},{label:"samples",value:"samples"}]} />
                  {stream.grain.durationUnit ? null : <span className="hint" style={{fontSize:9, marginLeft:4}}>default</span>}
                </span>
                <span />
              </div>
              {window.PGEEnvUtils.grainDurationUnitError(stream.grain) ? (
                <div className="pge-prow" style={{paddingTop:0}}>
                  <span className="k" /><span />
                  <span className="v mono" style={{fontSize:9, color:"var(--status-error)", lineHeight:1.4}}>
                    duration_unit: samples richiede una grain.duration esplicita (il default 0.05 è in secondi e non viene convertito).
                  </span>
                  <span />
                </div>
              ) : stream.grain.durationUnit === "samples" ? (
                <div className="pge-prow hint" style={{paddingTop:0}}>
                  <span className="k" /><span />
                  <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                    valori in campioni a 48000 Hz · min 1 campione · convertiti in secondi al parse
                  </span>
                  <span />
                </div>
              ) : null}
              <window.PGE.EnvelopeSelectorRow
                value={stream.grain.envelope}
                onChange={(env) => onChange({ grain: { ...stream.grain, envelope: env } })}
                onEditCurve={() => { setSelRow("grain.envelope.curve"); if (onFocusEnvParam) onFocusEnvParam("grainEnvCurve"); }}
              />
              {/* Verso di lettura del grano (PGE #207). Un controllo solo per
                  due chiavi mutuamente esclusive: `reverse` (presence-keyed,
                  storica) e `read_direction` (dichiarativa, anche envelope).
                  Il motore le rifiuta insieme — non sceglie per priorità —
                  quindi l'unico modo di non produrre YAML rotto è che sia la
                  UI a decidere quale scrivere.

                  Tre stati, non due: il terzo è la CHIAVE ASSENTE, cioè la
                  modalità `auto` in cui il verso segue il segno di
                  pointer.speed_ratio. È il default, e resta tale: scrivere +1
                  su uno stream che nessuno ha toccato ne cambierebbe la resa.

                  Le etichette dicono il verso, non il numero: `-1`/`+1` sono
                  la scrittura, «avanti»/«indietro» sono ciò che la chiave dice. */}
              {(() => {
                const g = stream.grain;
                const envMode = getMode("readDirection") === "env" && g.readDirectionEnv != null;
                const hasRD = g.readDirection !== undefined || g.readDirectionEnv != null;
                const state = envMode ? "env"
                  : g.reverse !== undefined ? "back"
                  : !hasRD ? "auto"
                  : g.readDirection === -1 ? "back"
                  : g.readDirection === 1 ? "forward"
                  : "invalid";
                // Passare da uno stato all'altro riscrive SEMPRE entrambe le
                // chiavi: è il punto in cui un conflitto ereditato da un file
                // scritto a mano si risolve, semplicemente usando il controllo.
                function setDirection(next) {
                  const ng = { ...g };
                  delete ng.reverse;
                  delete ng.readDirection;
                  delete ng.readDirectionEnv;
                  if (next === "forward") ng.readDirection = 1;
                  else if (next === "back") ng.readDirection = -1;
                  else if (next === "env") {
                    ng.readDirection = null;
                    ng.readDirectionEnv = [[0, 1], [0.5, -1]];
                  }
                  onChange({ grain: ng });
                }
                const err = window.PGEEnvUtils.readDirectionError(g);
                return (
                  <React.Fragment>
                    <div className={"pge-prow" + (selRow === "grain.readDirection" ? " selected" : "")}
                         onClick={() => setSelRow("grain.readDirection")}>
                      <span className="k" title="verso di lettura DENTRO il grano · indipendente dal segno di pointer.speed_ratio">read_direction</span>
                      <span />
                      {state === "env" ? (
                        <span className="v env" onClick={focusEnv("readDirection")}>
                          <span className="env-label" style={{color:"var(--accent)"}}>
                            {g.readDirectionEnv.length} bp · a gradino
                          </span>
                        </span>
                      ) : (
                        <span className="v">
                          <Seg size="xs" value={state === "invalid" ? "" : state}
                               onChange={setDirection}
                               options={[
                                 { label: "auto",     value: "auto" },
                                 { label: "avanti",   value: "forward" },
                                 { label: "indietro", value: "back" },
                                 { label: "env",      value: "env" },
                               ]} />
                        </span>
                      )}
                      {state === "env" ? (
                        <button className="pge-icon-btn" title="Torna a un verso costante"
                                onClick={() => setDirection("forward")}>
                          <Icon name="x" size={11} />
                        </button>
                      ) : <span />}
                    </div>
                    {state === "auto" ? (
                      <div className="pge-prow hint" style={{paddingTop:0}}>
                        <span className="k" /><span />
                        <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                          chiave assente · il verso segue il segno di pointer.speed_ratio
                        </span>
                        <span />
                      </div>
                    ) : null}
                    {g.reverse !== undefined && state === "back" ? (
                      <div className="pge-prow hint" style={{paddingTop:0}}>
                        <span className="k" /><span />
                        <span className="v mono" style={{fontSize:9, color:"var(--fg-4)", lineHeight:1.4}}>
                          scritto come <code>reverse:</code> (chiave vuota) · sceglierne un altro passa a read_direction
                        </span>
                        <span />
                      </div>
                    ) : null}
                    {err ? (
                      <div className="pge-prow" style={{paddingTop:0}}>
                        <span className="k" /><span />
                        <span className="v mono" style={{fontSize:9, color:"var(--status-error)", lineHeight:1.4}}>
                          {err.kind === "conflict"
                            ? "reverse e read_direction insieme: governano la stessa grandezza con semantiche opposte e il motore le rifiuta insieme. Scegli un verso qui sopra per tenerne una sola."
                            : err.kind === "empty"
                            ? "read_direction senza valore: a differenza di reverse: la chiave vuota qui è un errore. Scegli un verso."
                            : `${err.value} non è un verso: read_direction ammette solo -1 (indietro) e +1 (avanti), e il motore rifiuta gli intermedi al parse invece di clamparli.`}
                        </span>
                        <span />
                      </div>
                    ) : null}
                  </React.Fragment>
                );
              })()}
              <AddParamMenu
                options={[
                  { key: "durationRange", label: "duration_range", desc: "randomization band width on grain duration (see range_anchor)", exists: stream.grain.durationRange != null || stream.grain.durationRangeEnv != null, def: 0.01 },
                ]}
                onAdd={(o) => onChange({ grain: { ...stream.grain, [o.key]: o.def } })} />
            </Section>

            {(() => {
              const pi = stream.pitch || {};
              const pu = pi.unit || "semitones";
              const isEdo = pu === "edo";
              const edoN = isEdo ? (pi.edoDivisions || 12) : null;
              const unitLabel = pu;
              const unitSymbol = window.PGEEnv.pitchUnitSymbol(pu, edoN);
              const pitchSteps = window.PGEEnv.pitchUnitIsInteger(pu) ? [1, 10, 100] : [0.1, 1, 10];
              // engine-driven: pitchUnitBounds reads PB.pitch (presets) / edoFactor (edo)
              const pb = window.PGEEnv.pitchUnitBounds(pu, edoN);
              const [slMin, slMax] = [pb.min, pb.max];
              function setPitchUnit(newU) {
                if (newU === pu) return;
                const E = window.PGEEnv;
                const isNewEdo = newU === "edo";
                const newEDivs = isNewEdo ? (pi.edoDivisions || 12) : null;
                const fromDiv = edoN;            // current edo divisions (null if not edo)
                const toDiv = isNewEdo ? newEDivs : null;
                // destination bounds: a change of unit must never leave a value
                // (or range) outside the new unit's safe range — e.g. a 3600¢
                // range becomes 8× under absolute conversion but is clamped to
                // the ratio rangeMax (2×).
                const nb = E.pitchUnitBounds(newU, newEDivs);
                const valBounds = { min: nb.min, max: nb.max };
                const rangeBounds = { min: 0, max: nb.rangeMax };
                const patch = { ...pi, unit: newU, edoDivisions: newEDivs };
                // value (scalar or envelope)
                if (pi.valueEnv) {
                  // keep env mode, remap breakpoints into the new unit
                  patch.valueEnv = E.convertPitchEnv(pi.valueEnv, pu, newU, fromDiv, toDiv, valBounds);
                } else {
                  const curVal = pi.value ?? (pu === "ratio" ? 1.0 : 0);
                  patch.value = E.convertPitchValue(curVal, pu, newU, fromDiv, toDiv, valBounds);
                  patch.valueEnv = null;
                }
                // range (scalar or envelope) — must also be remapped, with range
                // semantics (0 stays 0, clamp into [0, rangeMax])
                if (pi.rangeEnv) {
                  patch.rangeEnv = E.convertPitchRangeEnv(pi.rangeEnv, pu, newU, fromDiv, toDiv, rangeBounds);
                } else if (pi.range != null) {
                  patch.range = E.convertPitchRange(pi.range, pu, newU, fromDiv, toDiv, rangeBounds);
                }
                onChange({ pitch: patch });
              }
              return (
                <Section title="Pitch" badge={<span className="mono">{unitLabel}</span>}>
                  <div className="pge-prow">
                    <span className="k">unit</span>
                    <span />
                    <span className="v">
                      <select className="pge-mini-select" value={pu}
                              onChange={e => setPitchUnit(e.target.value)}>
                        <option value="semitones">semitones</option>
                        <option value="cents">cents</option>
                        <option value="quarter_tone">quarter_tone</option>
                        <option value="eighth_tone">eighth_tone</option>
                        <option value="edo">edo (N-TET)</option>
                        <option value="ratio">ratio</option>
                      </select>
                    </span>
                    <span />
                  </div>
                  {isEdo ? (
                    <div className="pge-prow">
                      <span className="k">divisions</span>
                      <span />
                      <span className="v">
                        <input type="number" className="pge-mini-input" min={1} step={1} value={edoN}
                               onChange={e => onChange({ pitch: { ...pi, edoDivisions: Math.max(1, Math.round(+e.target.value || 12)), unit: "edo" } })} />
                        <span className="hint">divisions/octave</span>
                      </span>
                      <span />
                    </div>
                  ) : null}
                  <ParamRow name={pu}
                            mode={getMode("pitch")} onMode={(m) => toggleMode("pitch", m)}
                            value={pi.value != null ? pi.value : "—"}
                            unit={pi.valueEnv ? "" : unitSymbol}
                            range={pi.range}
                            accent={pi.valueEnv != null}
                            envValue={pi.valueEnv}
                            onEditEnv={focusEnv("pitch")}
                            onSelect={() => setSelRow("pitch.value")} selected={selRow==="pitch.value"}
                            steps={pitchSteps}
                            onValue={(v) => onChange({pitch: {...pi, value: window.PGEEnv.pitchUnitIsInteger(pu) ? Math.round(v) : v}})} />
                  <ParamRow name="range"
                            mode={getMode("pitchRange")} onMode={(m) => toggleMode("pitchRange", m)}
                            value={pi.range != null ? pi.range : 0}
                            unit={pi.rangeEnv ? "" : unitSymbol} steps={pitchSteps}
                            accent={pi.rangeEnv != null}
                            envValue={pi.rangeEnv}
                            onEditEnv={focusEnv("pitchRange")}
                            onValue={(v) => onChange({pitch: {...pi, range: window.PGEEnv.pitchUnitIsInteger(pu) ? Math.round(v) : v}})} />
                  {pu !== "ratio" ? (
                    <div className="pge-prow" style={{fontSize: 9, color: "var(--fg-4)", padding: "2px 0"}}>
                      <span className="k" />
                      <span />
                      <span className="v" title="EDO units without an explicit range get implicit detune; range: 0 disables it">
                        {pi.range == null ? "implicit detune ±12 cents" : (pi.range === 0 ? "detune disabled (range: 0)" : "")}
                      </span>
                      <span />
                    </div>
                  ) : null}
                </Section>
              );
            })()}

            <Section title="Volume & Pan">
              <ParamRow name="volume"
                        mode={getMode("volume")} onMode={(m) => toggleMode("volume", m)}
                        value={stream.volume != null ? stream.volume : "—"} unit={stream.volumeEnv ? "" : "dB"}
                        range={stream.volumeRange}
                        accent={stream.volumeEnv != null}
                        envValue={stream.volumeEnv}
                        onEditEnv={focusEnv("volume")}
                        onSelect={() => setSelRow("vol")} selected={selRow==="vol"}
                        onValue={(v) => onChange({volume: v})} />
              <ParamRow name="volume_range"
                        mode={getMode("volumeRange")} onMode={(m) => toggleMode("volumeRange", m)}
                        value={stream.volumeRange != null ? stream.volumeRange : 0} unit={stream.volumeRangeEnv ? "" : "dB"}
                        accent={stream.volumeRangeEnv != null}
                        envValue={stream.volumeRangeEnv}
                        onEditEnv={focusEnv("volumeRange")}
                        onValue={(v) => onChange({volumeRange: v})} />
              <ParamRow name="pan"
                        mode={getMode("pan")} onMode={(m) => toggleMode("pan", m)}
                        value={stream.pan != null ? stream.pan : "—"} unit={stream.panEnv ? "" : "°"}
                        range={stream.panRange}
                        accent={stream.panEnv != null}
                        envValue={stream.panEnv}
                        onEditEnv={focusEnv("pan")}
                        onSelect={() => setSelRow("pan")} selected={selRow==="pan"}
                        onValue={(v) => onChange({pan: v})} />
              <ParamRow name="pan_range"
                        mode={getMode("panRange")} onMode={(m) => toggleMode("panRange", m)}
                        value={stream.panRange != null ? stream.panRange : 0} unit={stream.panRangeEnv ? "" : "°"}
                        accent={stream.panRangeEnv != null}
                        envValue={stream.panRangeEnv}
                        onEditEnv={focusEnv("panRange")}
                        onValue={(v) => onChange({panRange: v})} />
            </Section>

            <DeviationProbabilitySection stream={stream} onChange={onChange} onFocusEnvParam={onFocusEnvParam} />

            {window.PGE.VoicesSection ? <window.PGE.VoicesSection stream={stream} onChange={onChange} onFocusEnvParam={onFocusEnvParam} /> : null}

          </div>
        </>
      ) : (
        <div className="ibody raw">
          {window.PGE.YamlEditor ? <window.PGE.YamlEditor stream={stream} onChange={onChange} samples={samples} /> : <div style={{padding:20,color:"var(--fg-3)"}}>YAML editor loading…</div>}
        </div>
      )}
    </aside>
  );
}
window.PGE = window.PGE || {};
/* Il motivo dell'inerzia esce dal file perche' anche il catalogo
   dell'EnvelopeEditor deve marcare quelle chiavi: due copie della stessa prosa
   divergerebbero al primo cambio di regola. */
Object.assign(window.PGE, { Inspector, deviationProbInertReason });
