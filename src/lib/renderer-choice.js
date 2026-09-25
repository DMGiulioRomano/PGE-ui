/* =============================================================================
 * renderer-choice.js — i bottoni del selettore di backend nel popover di render
 * (PGE-ui #150). window.PGERendererChoice.
 *
 * Il motore ha tre backend audio (numpy, csound, supercollider — PGE #228) e ne
 * tiene l'elenco in un posto solo (`RendererFactory.available_types()`, esposto
 * come `pge.api.renderer_types()`), proprio perche' chi deve popolare un
 * selettore lo chieda invece di tenerne una copia. Il bridge lo legge dal
 * sorgente (GET /renderers) insieme a quello che serve a ciascuno per girare;
 * qui si decide, puro, cosa diventa cliccabile. Nessun nome di backend e'
 * scritto in questo file.
 *
 * Pura perche' decide in vece del componente, e perche' un suo errore e'
 * silenzioso: un bottone acceso su un backend che non esiste manda un render
 * che il bridge rifiuta, uno spento su un backend che c'e' nasconde proprio
 * quello che la issue esiste per rendere raggiungibile.
 * ===========================================================================*/

(function () {
  /* `renderers`: le righe di GET /renderers, `{name, available, detail}`, con
   * `available` a tre valori — `false` e' "manca qualcosa" (il bottone si
   * spegne), `null` e' "il bridge non sa cosa serva a questo backend" e NON
   * spegne niente: a rifiutarlo, se serve, sara' il motore col suo messaggio.
   * `current`: il backend scelto adesso.
   *
   * Ritorna `[{name, on, disabled, title}]`, nell'ordine del motore.
   *
   * Due casi al bordo, e nessuno dei due nasconde il backend acceso:
   *
   *   - elenco vuoto (bridge giu', motore di cui non si legge l'elenco): resta
   *     il solo backend corrente, acceso e bloccato. E' il comportamento di
   *     prima di #150 — un bottone solo — e il titolo dice perche';
   *   - backend corrente fuori elenco (un `git pull` che l'ha tolto): resta in
   *     coda, acceso e spento. Toglierlo lascerebbe un selettore senza nessun
   *     bottone acceso, e il render partirebbe con un nome che il bridge
   *     rifiuta senza che il popover l'abbia detto. */
  function choices(renderers, current) {
    const rows = Array.isArray(renderers)
      ? renderers.filter(r => r && typeof r.name === "string" && r.name)
      : [];
    const hasCurrent = typeof current === "string" && current;
    if (!rows.length) {
      return hasCurrent ? [{
        name: current, on: true, disabled: true,
        title: "renderer list not available from the engine — rendering with " + current,
      }] : [];
    }
    const out = rows.map(r => ({
      name: r.name,
      on: r.name === current,
      disabled: r.available === false,
      title: r.detail || r.name,
    }));
    if (hasCurrent && !rows.some(r => r.name === current)) {
      out.push({ name: current, on: true, disabled: true,
                 title: "not offered by this engine — pick another renderer" });
    }
    return out;
  }

  window.PGERendererChoice = { choices };
})();
