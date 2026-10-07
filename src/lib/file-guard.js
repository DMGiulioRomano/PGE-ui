/* =============================================================================
 * file-guard.js — due editor, un file (#185): cosa fare quando il bridge
 * rifiuta una scrittura perche' il file su disco e' cambiato.
 *
 * Lo stesso `configs/<brano>.yml` puo' stare aperto in PGE-ui e nel laboratorio
 * di mare-nostrum. Il bridge (`file_signature.py`) non scrive un file che su
 * disco non e' piu' quello che l'editor ha letto, e risponde `changed`. La
 * decisione su quel rifiuto e' di qua, ed e' una sola domanda, FILE PER FILE:
 * c'e' lavoro proprio da perdere su quel file?
 *
 *   - no  → si rilegge e si riprova: il render prosegue sulla versione su
 *           disco, che e' quella che l'altro editor ha appena scritto, cioe'
 *           quella che si vuole sentire;
 *   - si' → si chiede: ricarica, sovrascrivi, o non scrivere niente.
 *
 * Una rilettura sola (`MAX_REREADS`, il numero del laboratorio): se il file
 * cambia ancora fra la rilettura e la scrittura, qualcuno ci sta scrivendo
 * adesso, e rincorrerlo non finisce mai — lo si dice e si lascia riprovare.
 *
 * Per file e non "sul file" dal primo giorno: oggi l'editor scrive un file
 * solo, il master, ma con #184 una scrittura toccera' anche gli stream
 * importati, e un importato pulito si rilegge anche quando il master ha da
 * chiedere. La decisione va richiamata, non riscritta.
 *
 * Due meta':
 *   - la decisione pura (`decide`, `plan`, `ownChanges`), che non sa niente di
 *     React ne' di rete;
 *   - il giro (`attempt`): scrittura → rifiuto → riletture → riprova, con la
 *     scrittura, la rilettura e "ci sono modifiche proprie?" iniettate. E' la
 *     funzione che app.jsx chiama per il salvataggio e per il render, cosi' la
 *     regola "una rilettura sola" e l'ordine delle riletture vivono qui, dove
 *     node le esegue, e non nella colla.
 *
 * Exposes window.PGEFileGuard. Node-tested in tests/node/test-file-guard.js.
 * ===========================================================================*/

(function () {
  const MAX_REREADS = 1;

  /* Il documento senza l'intestazione di commenti che `serialize()` mette in
     testa (`# project:`, `# saved: <ISO>`, `# editor:`). Il `# saved:` cambia a
     ogni serializzazione: confrontare il testo intero direbbe "modificato" su
     ogni documento. Un commento DENTRO il documento resta, ed e' una
     differenza come un'altra. */
  function documentBody(text) {
    const lines = String(text == null ? "" : text).split("\n");
    let i = 0;
    while (i < lines.length && (/^\s*#/.test(lines[i]) || lines[i].trim() === "")) i++;
    return lines.slice(i).join("\n");
  }

  /* Modifiche proprie su un file: quello che l'editor scriverebbe adesso non e'
     quello che il file conteneva l'ultima volta che i due erano allineati (una
     lettura, o una scrittura andata a buon fine). Si confrontano due
     serializzazioni dello STESSO serializzatore, quindi la formattazione
     dell'altro editor non entra: entra solo cio' che l'editor ha cambiato.

     Senza un allineamento noto (`synced` assente) la risposta e' si': il verso
     sicuro di "non lo so" e' la domanda, che costa un click; il verso opposto e'
     una rilettura che butta lavoro senza un errore da nessuna parte. */
  function ownChanges(current, synced) {
    if (synced === null || synced === undefined) return true;
    return documentBody(current) !== documentBody(synced);
  }

  /* La decisione su UN file rifiutato: "reread" | "ask" | "stop".
     La rilettura gia' fatta viene prima di tutto: un file riletto e rifiutato
     di nuovo sta cambiando adesso, e nessuna risposta lo ferma. Poi le
     modifiche proprie, dove solo un `false` esplicito vale "nessuna". */
  function decide(file) {
    const f = file || {};
    if ((f.rereads || 0) >= MAX_REREADS) return "stop";
    return f.ownChanges === false ? "reread" : "ask";
  }

  /* N file rifiutati → { action, reread, ask, stop }.
     `action` e' "stop" se un file si ferma, altrimenti "ask" se uno chiede,
     altrimenti "retry". Le due precedenze hanno ragioni diverse:
       - "stop" batte "ask": rispondere non serve, perche' il giro dopo torna sul
         rifiuto del file che cambia ancora. E con lo stop non si rilegge
         niente: una rilettura e' una modifica dello stato dell'editor, e
         nessuna scrittura la seguirebbe;
       - "ask" non ferma le riletture: un file pulito si rilegge comunque, non
         perde niente, e la domanda riguarda solo i file con lavoro proprio.
     Un rifiuto che non nomina file non dice cosa rileggere ne' di cosa
     chiedere: si ferma. */
  function plan(files) {
    const out = { action: "stop", reread: [], ask: [], stop: [] };
    const list = Array.isArray(files) ? files : [];
    for (const f of list) out[decide(f)].push(f.name);
    if (!list.length || out.stop.length) {
      out.reread = []; out.ask = [];
      return out;
    }
    out.action = out.ask.length ? "ask" : "retry";
    return out;
  }

  /* Lo stato di un giro: quante riletture ha avuto ogni file, quali file
     l'utente ha detto di sovrascrivere, e il documento da scrivere quando una
     rilettura lo ha appena rimpiazzato. Quest'ultimo serve perche' lo stato di
     React non e' sincrono: riprovare con la `data` della closure rimanderebbe
     al bridge esattamente cio' che ha appena rifiutato. */
  function initialState() {
    return { rereads: {}, overwrite: [], doc: null };
  }
  function afterReread(state, name, doc) {
    const s = state || initialState();
    return { ...s, rereads: { ...s.rereads, [name]: (s.rereads[name] || 0) + 1 }, doc };
  }
  /* La sovrascrittura scrive cio' che l'utente ha davanti ADESSO: la domanda
     non ferma la tastiera, e un documento tenuto da prima della risposta
     butterebbe le modifiche fatte nel frattempo. Percio' il documento torna al
     chiamante (`doc: null`). */
  function afterOverwrite(state, name) {
    const s = state || initialState();
    return { ...s, overwrite: s.overwrite.includes(name) ? s.overwrite : [...s.overwrite, name],
             doc: null };
  }
  function overwrites(state, name) {
    return !!(state && Array.isArray(state.overwrite) && state.overwrite.includes(name));
  }

  /* Il giro. `hooks`:
       write(state)    → Promise<{ ok, changed?, files? }>: la scrittura (il
                         salvataggio, o il render intero), col documento
                         `state.doc` se c'e' e la sovrascrittura dei file in
                         `state.overwrite`;
       ownChanges(name)→ boolean: lavoro proprio su quel file, adesso;
       reread(name)    → Promise<doc | null>: rilegge il file e torna il
                         documento dell'editor dopo la rilettura; `null` se la
                         rilettura non ha prodotto un documento.
     Torna { outcome, result, state, files? } con outcome:
       "done"          — scritto (o gia' su disco);
       "failed"        — un fallimento che non e' un rifiuto: passa com'e';
       "asked"         — c'e' da chiedere dei `files`; `state` e' quello da cui
                         riprendere con la risposta (`afterOverwrite` /
                         `afterReread`);
       "stopped"       — i `files` cambiano mentre li si rilegge;
       "reread-failed" — la rilettura di un file non ha dato un documento: non
                         si riprova, riprovare scriverebbe il ripiego sopra il
                         file dell'altro editor.
     Le modifiche proprie si chiedono PRIMA di rileggere qualunque file: la
     rilettura di uno cambia lo stato dell'editor, e la domanda sugli altri
     deve guardare quello di prima. Il giro termina sempre: ogni file si
     rilegge al piu' una volta, e un file sovrascritto non torna rifiutato. */
  async function attempt(hooks, state) {
    let st = state || initialState();
    for (;;) {
      const result = await hooks.write(st);
      if (!result || !result.changed) {
        return { outcome: result && result.ok ? "done" : "failed", result, state: st };
      }
      const files = Array.isArray(result.files) ? result.files : [];
      const p = plan(files.map((name) => ({
        name, ownChanges: hooks.ownChanges(name), rereads: st.rereads[name] || 0,
      })));
      if (p.action === "stop") {
        return { outcome: "stopped", result, state: st, files: p.stop.length ? p.stop : files };
      }
      for (const name of p.reread) {
        const doc = await hooks.reread(name);
        if (doc === null || doc === undefined) {
          return { outcome: "reread-failed", result, state: st, files: [name] };
        }
        st = afterReread(st, name, doc);
      }
      if (p.action === "ask") return { outcome: "asked", result, state: st, files: p.ask };
    }
  }

  window.PGEFileGuard = {
    MAX_REREADS, documentBody, ownChanges, decide, plan,
    initialState, afterReread, afterOverwrite, overwrites, attempt,
  };
})();
