/* magnify-spec.js
 * Lo SPEC di `--magnify-at`, controllato prima di spedirlo al motore (#120).
 *
 * La lente della partitura ha due modi: automatica (`--magnify`, sul cluster
 * di grani più denso di ogni pagina) ed esplicita (`--magnify-at SPEC`, uno o
 * più punti scelti a mano). Il secondo passa per un campo di testo, e uno SPEC
 * malformato non degrada la partitura: `main.py` stampa l'errore ed esce con
 * codice 1, quindi un refuso costerebbe l'intero render, audio compreso.
 * Questo modulo replica la grammatica del motore (`_parse_magnify_spec` in
 * `src/pge/cli.py`) per dirlo prima, mentre si scrive.
 *
 * Grammatica: target separati da `;`, ogni target coppie `chiave=valore`
 * separate da `,`. Chiave `t` (secondi) obbligatoria; `y`, `zoom`, `out`, `src`
 * numeriche opzionali; `stream` stringa opzionale.
 *
 * Una differenza voluta rispetto al motore: qui lo spec VUOTO non è un errore.
 * Il motore rifiuta `--magnify-at ""` perché il flag gli è stato passato; nella
 * UI il campo vuoto significa "nessun target esplicito", e chi chiama omette il
 * flag — vedi `error() === null && spec.trim()` in app.jsx.
 *
 * Parità: se il motore cambia la grammatica, cambia anche qui — è lo stesso
 * patto del fingerprint JS/python descritto in CLAUDE.md.
 * window.* global, no modules. Test: tests/node/test-magnify-spec.js
 */
(function () {
  const NUMERIC_KEYS = ["t", "y", "zoom", "out", "src"];
  const STR_KEYS = ["stream"];
  const KEYS = [...NUMERIC_KEYS, ...STR_KEYS];

  function isNumeric(value) {
    // Number("") è 0: il valore vuoto va escluso a mano, o `t=` passerebbe.
    return value !== "" && Number.isFinite(Number(value));
  }

  /* Parsa un singolo target. Ritorna { target } oppure { error }. */
  function parseTarget(raw) {
    const target = {};
    for (const rawPair of raw.split(",")) {
      const pair = rawPair.trim();
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) {
        return { error: `token non valido '${pair}': usa chiave=valore (es. t=14,zoom=10)` };
      }
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!KEYS.includes(key)) {
        return { error: `chiave ignota '${key}': valide ${KEYS.join(", ")}` };
      }
      if (NUMERIC_KEYS.includes(key)) {
        if (!isNumeric(value)) {
          return { error: `valore non numerico per '${key}': '${value}'` };
        }
        target[key] = Number(value);
      } else {
        if (!value) return { error: `'${key}' non può essere vuoto` };
        target[key] = value;
      }
    }
    if (!("t" in target)) {
      return { error: "ogni target richiede 't' (tempo in secondi)" };
    }
    return { target };
  }

  /* null se lo SPEC è valido (o vuoto), altrimenti il messaggio da mostrare. */
  function error(spec) {
    if (spec === null || spec === undefined) return null;
    const text = String(spec).trim();
    if (!text) return null;
    for (const raw of text.split(";")) {
      const chunk = raw.trim();
      if (!chunk) continue;
      const parsed = parseTarget(chunk);
      if (parsed.error) return parsed.error;
    }
    return null;
  }

  /* I target dello SPEC, [] se vuoto o malformato. Non è la sorgente di verità
   * del render — quella resta lo SPEC testuale che il motore riparsa — ma serve
   * a chi vuole contarli o mostrarli (es. "2 lenti"). */
  function targets(spec) {
    if (error(spec) !== null) return [];
    const text = String(spec === null || spec === undefined ? "" : spec).trim();
    if (!text) return [];
    const out = [];
    for (const raw of text.split(";")) {
      const chunk = raw.trim();
      if (!chunk) continue;
      const parsed = parseTarget(chunk);
      if (parsed.target) out.push(parsed.target);
    }
    return out;
  }

  window.PGEMagnifySpec = { KEYS, NUMERIC_KEYS, STR_KEYS, error, targets };
})();
