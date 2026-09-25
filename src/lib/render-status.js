/* =============================================================================
 * render-status.js — pure render/fingerprint tracking logic (stale/fresh/never).
 *
 * Extracted from app.jsx (#58, follow-up of #44) so the per-stream stale/fresh
 * decision and the aggregate render summary can be unit-tested in node like
 * backend.js / envelope-utils.js. No React, no DOM. Attaches to
 * window.PGERenderStatus.
 *
 * The fingerprint itself lives in backend.js (window.PGEBackend.fingerprintStream,
 * FNV-1a — pinned by tests/node/test-fingerprint.js); this module *consumes* it
 * via fingerprintAll, it does not duplicate the hash. The "does this stream have
 * a stem on disk" check is injected as a hasStem(id)=>bool closure so the module
 * never reaches into window.PGEBackend.current.
 *
 * State (lastRenderedFps, renderStatus) and all its setters/effects stay in
 * app.jsx — only the pure classification/aggregation moves here.
 * ===========================================================================*/

(function () {
  const STATES = { FRESH: "fresh", STALE: "stale", NEVER: "never", RUNNING: "running" };

  // Tooltip strings kept verbatim from app.jsx so the UI text is unchanged.
  // The two additions are the same yellow dot with a different reason:
  // `staleSemantics` — the YAML did not move, the engine's reading of it did;
  // `staleRenderer` — neither moved, and nothing says the current backend
  // wrote the file. Worded to be true on BOTH branches of that axis: a
  // different recorded backend, and no record at all — the second being every
  // stem rendered before #151, i.e. the only case that fires while the UI
  // writes numpy alone. "Another backend rendered this stem" was false there.
  const TOOLTIPS = {
    running: "rendering this stream…",
    never:   "this stream has never been rendered",
    fresh:   "rendered and up-to-date with the YAML",
    stale:   "YAML changed since last render — re-render to update",
    staleSemantics: "the engine's reading of this YAML doesn't match this " +
                    "stem — re-render to update",
    staleRenderer:  "no record that the current backend rendered this stem — " +
                    "re-render to update",
  };

  // Per-stream fingerprints for the live editor state. Wraps the backend hash;
  // the caller passes the already-resolved output format (app.jsx uses
  // tweaks.outputFormat || "wav").
  function fingerprintAll(streams, format) {
    const out = {};
    for (const s of streams) out[s.id] = window.PGEBackend.fingerprintStream(s, format);
    return out;
  }

  // Perche' uno stem e' stale, o null se non lo e'. Tre assi indipendenti:
  //
  //   "yaml"      — l'utente ha modificato lo stream dall'ultimo render. E'
  //                 l'hash della UI a dirlo, ed e' l'unica cosa che sa dire.
  //   "semantics" — VARIATION_SEMANTICS_VERSION del motore e' cambiata da
  //                 quando quello stem e' stato scritto: stesso YAML, lettura
  //                 diversa, audio diverso al prossimo render. Il motore la
  //                 mette nel proprio fingerprint (stream_cache_manager.py) e
  //                 rifara' lo stem; senza quest'asse l'editor mostrerebbe
  //                 verde su audio che il motore considera gia' morto.
  //   "renderer"  — il backend che ha scritto quello stem non e' quello con cui
  //                 l'editor renderizzerebbe adesso (#151). Il motore mette
  //                 anche `renderer_type` nel proprio fingerprint (PGE #228):
  //                 stesso YAML, stessa lettura, file prodotto da un altro
  //                 motore audio. Tre backend esistono per essere confrontati,
  //                 quindi renderizzare con uno e rilanciare con un altro e' lo
  //                 scenario d'uso, non il caso limite.
  //
  // Ne' il numero ne' il nome entrano nell'hash della UI, e non e' una svista:
  // l'hash risponde a "l'utente ha toccato qualcosa", che a un bump del motore
  // o a un cambio di backend non si muove. Non c'e' nemmeno un hash da far
  // combaciare — quello del motore la UI non lo legge mai (`loadCache` in
  // backend.js: manifest per-browser, FNV-1a contro SHA-256). Il criterio e'
  // quello di #134, "raggiunge lo YAML?", e per entrambi la risposta e' no:
  // dentro l'hash, il pallino direbbe "yaml" su uno YAML che nessuno ha
  // toccato. Sono domande diverse, e restano record diversi (vedi
  // loadSemantics / loadRenderers in backend.js). `sem` e' { rendered, engine },
  // `rend` e' { rendered, current }, tutti opzionali.
  //
  // I DUE IGNOTI NON SONO LO STESSO IGNOTO, e la differenza e' se il giallo si
  // possa poi spegnere:
  //
  //   - motore ignoto (bridge giu', motore senza la costante): nessuna
  //     pretesa. Non e' prudenza generica — e' che quel giallo sarebbe
  //     INELIMINABILE: `_persistSem` scrive solo quando il numero si sa,
  //     quindi nessun re-render lo cancellerebbe, e l'editor resterebbe giallo
  //     per sempre su stem perfetti.
  //   - versione dello stem assente, con motore noto: "semantics". E' lo stem
  //     scritto prima che l'editor registrasse il numero, cioe' OGNI stem
  //     esistente al momento di questa modifica: stem scritti da un motore di
  //     cui non sappiamo la lettura. La regola non ha bisogno del numero, e non
  //     deve averlo — trascriverlo qui sarebbe di nuovo una costante del motore
  //     tenuta a mano in questo repo, gia' falsa su un checkout qualunque.
  //     Tacere qui vorrebbe dire essere ciechi esattamente nel caso per cui
  //     l'asse e' stato scritto. E quel giallo si spegne da solo al primo
  //     giro, anche a vuoto: il motore emette `stream-done` anche per gli
  //     stream che salta (`cached: true`, render_pipeline.py), e backend.js
  //     registra la versione su quell'evento come su un render vero.
  //
  // Cioe' la regola del repo applicata bene: un render di troppo, mai uno di
  // meno.
  //
  // L'asse del backend ha gli stessi due ignoti e la stessa risposta, con una
  // differenza che vale la pena scrivere perche' e' l'unica ragione per cui il
  // ramo "record assente" e' li': oggi non scopre niente — la UI ha sempre e
  // solo scritto numpy, e lo pretende una guardia sorgente — quindi costa un
  // giro a vuoto per progetto e basta. Serve il giorno in cui la scelta del
  // backend arriva nelle Settings (#150): li' gli stem resi prima, senza
  // record, sotto un altro backend resterebbero VERDI, cioe' un render di meno
  // proprio nel caso per cui l'asse esiste. Tacere adesso vorrebbe dire
  // costruire l'asse e spegnerlo sulla popolazione piu' numerosa.
  //
  // La precedenza fra i due assi del motore e' la semantica, ed e' deliberata:
  // l'asse nuovo e' additivo — nessun caso che esistesse prima cambia risposta
  // — e un render solo li spegne comunque entrambi, quindi la precedenza non
  // costa un giro a nessuno.
  function staleReason(lastFp, currentFp, sem, rend) {
    if (lastFp !== currentFp) return "yaml";
    const engine = sem && sem.engine;
    if (engine != null) {
      const rendered = sem.rendered;
      if (rendered == null || rendered !== engine) return "semantics";
    }
    const current = rend && rend.current;
    if (current != null) {
      const renderedBy = rend.rendered;
      if (renderedBy == null || renderedBy !== current) return "renderer";
    }
    return null;
  }

  // The core stale/fresh/never decision, shared by summarize + statusForStream.
  // hasStem is a boolean. !lastFp uses falsiness on purpose (undefined / "" / 0
  // all read as never), matching the original `!last` guard in app.jsx.
  // `sem` is optional (omitting it is the pre-#133 behaviour exactly), and so
  // is `rend` (pre-#151).
  function classifyStream(lastFp, currentFp, hasStem, sem, rend) {
    if (!lastFp || !hasStem) return STATES.NEVER;
    return staleReason(lastFp, currentFp, sem, rend) === null ? STATES.FRESH : STATES.STALE;
  }

  // Aggregate fresh/stale/never counts across all streams. hasStem is (id)=>bool.
  // `sem` is optional: { rendered: {[streamId]: version}, engine: version|null }.
  // `rend` likewise: { rendered: {[streamId]: backend}, current: backend|null }.
  function summarize(streams, currentFps, lastRenderedFps, hasStem, sem, rend) {
    let fresh = 0, stale = 0, never = 0;
    for (const s of streams) {
      const state = classifyStream(lastRenderedFps[s.id], currentFps[s.id], hasStem(s.id),
                                   semFor(sem, s.id), rendererFor(rend, s.id));
      if (state === STATES.FRESH) fresh++;
      else if (state === STATES.STALE) stale++;
      else never++;
    }
    return { fresh, stale, never, total: streams.length };
  }

  // La coppia { rendered, <lato vivo> } per un singolo stream, dalla forma che
  // app.jsx tiene in stato. Una funzione per asse perche' le usano sia
  // summarize sia statusForStream, e sbagliare l'indicizzazione in uno dei due
  // significa due pallini che non concordano sullo stesso stem.
  function semFor(sem, streamId) {
    if (!sem) return null;
    return { rendered: (sem.rendered || {})[streamId], engine: sem.engine };
  }
  function rendererFor(rend, streamId) {
    if (!rend) return null;
    return { rendered: (rend.rendered || {})[streamId], current: rend.current };
  }

  // Per-stream status object consumed by Timeline.jsx (ClipRenderStatus).
  // ctx = { currentFps, lastRenderedFps, hasStem:(id)=>bool, running:bool,
  //         currentStreamId, sem, rend }.
  //
  // Lo stato RUNNING non porta un `progress` (#162). Lo portava, letto da una
  // mappa `streamProgress` che solo l'evento `stream-progress` riempiva — e
  // quell'evento non lo emette nessuno: ne' server.py ne' render_pipeline.py,
  // e il motore non ha una riga da cui ricavarlo. La barra per clip stava
  // quindi a 0% per tutto il render, tranne l'istante fra uno `stream-done` e
  // lo `stream-start` successivo, in cui leggeva 100% sullo stream gia'
  // finito. Il pallino pulsante e' tutto cio' che si sa davvero dire.
  //
  // Il motivo si chiede UNA volta e si indicizza: con un `if` per asse, il
  // giorno che ne nasce un quarto il ramo nuovo resta senza testo e il pallino
  // giallo torna a dire quello dello YAML — che e' falso e manda a cercare una
  // modifica che nessuno ha fatto.
  //
  // La tabella da sola pero' non lo impedisce: una voce dimenticata cade sul
  // ripiego qui sotto, e il ripiego e' proprio il testo dello YAML (come la
  // mappa di `ClipRenderStatus` un livello sotto). Lo impedisce
  // test-render-status.js, che raccoglie i motivi dai `return` di
  // `staleReason` e pretende una voce per ciascuno — per questo la tabella e'
  // esposta, e per questo `staleReason` restituisce solo letterali.
  const STALE_TOOLTIP = {
    yaml:      TOOLTIPS.stale,
    semantics: TOOLTIPS.staleSemantics,
    renderer:  TOOLTIPS.staleRenderer,
  };
  function statusForStream(streamId, ctx) {
    if (ctx.running && ctx.currentStreamId === streamId) {
      return { state: STATES.RUNNING, tooltip: TOOLTIPS.running };
    }
    const sem = semFor(ctx.sem, streamId);
    const rend = rendererFor(ctx.rend, streamId);
    const lastFp = ctx.lastRenderedFps[streamId];
    const state = classifyStream(lastFp, ctx.currentFps[streamId], ctx.hasStem(streamId), sem, rend);
    if (state === STATES.STALE) {
      const why = staleReason(lastFp, ctx.currentFps[streamId], sem, rend);
      return { state, tooltip: STALE_TOOLTIP[why] || TOOLTIPS.stale };
    }
    return { state, tooltip: TOOLTIPS[state] };
  }

  window.PGERenderStatus = {
    STATES,
    TOOLTIPS,
    STALE_TOOLTIP,
    fingerprintAll,
    classifyStream,
    staleReason,
    summarize,
    statusForStream,
  };
})();
