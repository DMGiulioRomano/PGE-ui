/* =============================================================================
 * file-guard.js — due editor, un file: rilegge o chiede (PGE-ui #185).
 * window.PGEFileGuard.
 *
 * Lo stesso `streams/risacca.yml` puo' stare aperto nel laboratorio di
 * mare-nostrum e qui (regola 7 del piano `stream-come-file.md`). Il bridge
 * tiene la meta' che guarda il disco — la firma di cio' che si e' letto, e il
 * rifiuto `{ok:false, changed:true}` di una scrittura su un file che nel
 * frattempo e' cambiato (`file_signature.py`). Questo modulo e' l'altra meta':
 * dato quel rifiuto, decide cosa fare, e lo decide **file per file**.
 *
 * Il criterio e' uno solo: *c'e' lavoro proprio da perdere su quel file?*
 *
 *   - no  → si **rilegge** e si riprova, e il render prosegue sulla versione su
 *           disco. Quella e' la versione che l'altro editor ha appena scritto,
 *           cioe' quella che si vuole sentire: non c'e' niente da chiedere;
 *   - si' → si **chiede**, perche' la scelta (ricarica / sovrascrivi / non
 *           scrivere niente) la deve fare chi perde il lavoro.
 *
 * Puro, e in `src/lib/` per la ragione di `history-core.js` e `render-status.js`:
 * decide in vece del componente, e un suo errore e' *silenzioso*. Un `ask`
 * letto come `reread` butta le modifiche di chi sta componendo senza dire
 * niente — non un'eccezione, non un toast: il lavoro non c'e' piu'. Un `reread`
 * letto come `ask` mette una domanda che non ha nessuna risposta utile davanti
 * a ogni render.
 *
 * **Totale su N file dal primo giorno.** Oggi il file e' uno — il master in
 * `configs/<basename>.yml` — e il chiamante ne passa uno; con gli stream
 * importati (#184) saranno N, e `plan()` e' gia' scritto per loro perche' il
 * criterio dell'issue e' per-file e una logica "sul file" andrebbe riscritta
 * invece di essere richiamata.
 * ===========================================================================*/

(function () {
  /* Quante volte si rilegge e si riprova prima di dirlo invece di rincorrere il
   * file. Una, come nel laboratorio: se fra la rilettura e la scrittura il file
   * cambia ancora, chi sta scrivendo dall'altra parte sta scrivendo adesso, e
   * un ciclo di riletture non arriverebbe mai in fondo — ci arriverebbe solo
   * dopo, quando chi guarda ha gia' smesso di capire cosa sta succedendo. */
  const MAX_REREAD = 1;

  /* La decisione su UN file.
   *
   *   `changed`  — il bridge ha rifiutato la scrittura di questo file;
   *   `dirty`    — ci sono modifiche proprie da perdere su questo file;
   *   `attempts` — quante volte lo si e' gia' riletto in questa operazione.
   *
   * Ritorna `"write"` (niente da fare, la scrittura passa), `"reread"`,
   * `"ask"`, `"stop"`.
   *
   * `dirty` assente vale **true**, e non e' una svista: il verso sicuro di
   * questo default e' la domanda. Un chiamante che si dimentica di dire se ha
   * lavoro proprio, letto come "non ne ha", si ritrova le modifiche rilette via
   * senza un errore da nessuna parte; letto come "ne ha" si ritrova una domanda
   * di troppo, che si chiude con un click. */
  function decide(file) {
    const f = file || {};
    if (!f.changed) return "write";
    const dirty = f.dirty === undefined ? true : !!f.dirty;
    if (dirty) return "ask";
    const attempts = Number(f.attempts) || 0;
    return attempts < MAX_REREAD ? "reread" : "stop";
  }

  /* La decisione sull'operazione, da quelle dei suoi file.
   *
   * `files`: `[{name, changed, dirty, attempts}]`. Ritorna
   * `{action, byName, reread, ask, stop}` — `action` e' cosa fa il chiamante
   * adesso, le tre liste sono i nomi che hanno chiesto ciascuna cosa (per il
   * messaggio: con N file "e' cambiato un file" non dice quale).
   *
   * La precedenza e' `ask` > `stop` > `reread`, e i due confronti non sono
   * simmetrici:
   *
   *   - `ask` batte tutto perche' e' l'unica decisione che ha una via d'uscita
   *     per la scrittura (`sovrascrivi`). Dire "mi arrendo" mentre una domanda
   *     e' in piedi toglierebbe quella via a chi la stava per usare. I file che
   *     volevano solo una rilettura restano elencati in `reread`: si rileggono
   *     comunque, e la domanda resta sugli altri;
   *   - `stop` batte `reread` perche' rileggere e riprovare passerebbe di nuovo
   *     dal file che ha gia' esaurito le riletture: lo stesso rifiuto, un giro
   *     piu' tardi. Con niente da chiedere, la cosa da fare e' dirlo. */
  function plan(files) {
    const rows = (Array.isArray(files) ? files : []).filter(f => f && f.name);
    const byName = {};
    const reread = [], ask = [], stop = [];
    for (const f of rows) {
      const d = decide(f);
      byName[f.name] = d;
      if (d === "reread") reread.push(f.name);
      else if (d === "ask") ask.push(f.name);
      else if (d === "stop") stop.push(f.name);
    }
    const action = ask.length ? "ask"
                 : stop.length ? "stop"
                 : reread.length ? "reread"
                 : "write";
    return { action, byName, reread, ask, stop };
  }

  window.PGEFileGuard = { MAX_REREAD, decide, plan };
})();
