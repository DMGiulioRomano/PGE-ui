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
 * flag. A deciderlo è `sendable()`, qui sotto: torna i byte che arrivano ad
 * argv, oppure `null` quando il flag non va spedito affatto. Non è una
 * distinzione stilistica — quel gate è già stato una copia in app.jsx, è
 * rimasto su `.trim()` mentre qui si passava allo strip ASCII, e il popover
 * mostrava rosso su uno SPEC che poi partiva ripulito.
 *
 * Parità: se il motore cambia la grammatica, cambia anche qui — è lo stesso
 * patto del fingerprint JS/python descritto in CLAUDE.md.
 * window.* global, no modules. Test: tests/node/test-magnify-spec.js
 */
(function () {
  const NUMERIC_KEYS = ["t", "y", "zoom", "out", "src"];
  const STR_KEYS = ["stream"];
  const KEYS = [...NUMERIC_KEYS, ...STR_KEYS];

  /* Lo strip del motore, non quello di JS.
   *
   * `_parse_magnify_spec` usa `str.strip()`, che toglie ciò per cui
   * `str.isspace()` è vero. `String.prototype.trim()` toglie un insieme
   * diverso, e le due differenze non sono simmetriche:
   *
   *   - Python toglie `\x1c`–`\x1f`, `\x85`, U+00A0 e altri spazi Unicode che
   *     `trim()` lascia. Lì la UI è più stretta del motore: verso sicuro.
   *   - `trim()` toglie **U+FEFF**, che `str.strip()` non tocca. Lì la UI era
   *     più larga, ed è il verso che uccide il render: `t=<BOM>12` passava la
   *     UI e faceva uscire il motore con 1 («valore non numerico per 't'»).
   *     Lo stesso in tre posizioni — prima della chiave, nel valore, in coda —
   *     con tre errori diversi.
   *
   * Qui si toglie il solo insieme ASCII, che è un sottoinsieme di quello di
   * Python: così la divergenza residua è garantita nel verso sicuro, senza
   * dover replicare `str.isspace()`. */
  const ASCII_WS = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
  function strip(text) {
    return String(text).replace(ASCII_WS, "");
  }

  /* Il motore converte con `float()`, non con `Number()`, e le due grammatiche
     non coincidono. La differenza non è accademica: `Number("0x10")` fa 16,
     `float("0x10")` alza ValueError — quindi la vecchia guardia lasciava
     passare uno SPEC che ammazza il render, cioè il caso esatto che questo
     modulo esiste per intercettare. Nell'altro verso rifiutava `t=1_000` e
     `t=inf`, che il motore accetta, bloccando in UI uno SPEC che rende.

     Qui la grammatica è quella di `float()`: segno opzionale, poi `inf` /
     `infinity` / `nan` (senza distinzione di maiuscole) oppure una mantissa
     decimale con separatori `_` fra cifre ed esponente opzionale. Niente
     prefissi 0x/0b/0o, niente stringa vuota.

     Divergenza dichiarata e verificata in tests/parity/test-magnify-parity.js:
     `float()` accetta anche le cifre decimali Unicode (`t=１４`), che qui non
     passano. Replicarle richiederebbe la tabella `unicodedata.decimal`, e la
     divergenza è nel verso sicuro — la UI è più stretta del motore, mai il
     contrario. */
  const PY_DIGITS = "\\d(?:_?\\d)*";
  const PY_FLOAT_RE = new RegExp(
    "^[+-]?(?:inf(?:inity)?|nan|" +
      "(?:" + PY_DIGITS + "(?:\\.(?:" + PY_DIGITS + ")?)?|\\.(?:" + PY_DIGITS + "))" +
      "(?:[eE][+-]?" + PY_DIGITS + ")?" +
    ")$", "i");

  function isNumeric(value) {
    return PY_FLOAT_RE.test(value);
  }

  /* Il numero che il motore otterrebbe. Chiamata solo dopo isNumeric. */
  function toNumber(value) {
    const bare = value.replace(/_/g, "");
    const n = Number(bare);
    if (!Number.isNaN(n)) return n;                 // include "Infinity"
    // Restano le forme che `Number` non conosce: inf/infinity/nan.
    return /inf(inity)?$/i.test(bare)
      ? (bare[0] === "-" ? -Infinity : Infinity)
      : NaN;
  }

  /* Parsa un singolo target. Ritorna { target } oppure { error }. */
  function parseTarget(raw) {
    const target = {};
    for (const rawPair of raw.split(",")) {
      const pair = strip(rawPair);
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) {
        return { error: `token non valido '${pair}': usa chiave=valore (es. t=14,zoom=10)` };
      }
      const key = strip(pair.slice(0, eq));
      const value = strip(pair.slice(eq + 1));
      if (!KEYS.includes(key)) {
        return { error: `chiave ignota '${key}': valide ${KEYS.join(", ")}` };
      }
      if (NUMERIC_KEYS.includes(key)) {
        if (!isNumeric(value)) {
          return { error: `valore non numerico per '${key}': '${value}'` };
        }
        target[key] = toNumber(value);
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
    const text = strip(spec);
    if (!text) return null;
    let produced = 0;
    for (const raw of text.split(";")) {
      const chunk = strip(raw);
      if (!chunk) continue;
      const parsed = parseTarget(chunk);
      if (parsed.error) return parsed.error;
      produced++;
    }
    // Uno SPEC non vuoto che non produce nessun target: `;`, `;;`, ` ; `. La UI
    // li lasciava partire (error() null, e `magnifySpecSendable` guarda solo che
    // il testo non sia vuoto), e il motore ha un controllo finale che li rifiuta
    // — cli.py, dopo il ciclo. Sono diversi dallo SPEC VUOTO, che resta la
    // divergenza dichiarata: lì il flag non parte proprio.
    if (produced === 0) {
      return "nessun target valido nello SPEC: usa chiave=valore (es. t=14,zoom=10)";
    }
    return null;
  }

  /* Cosa parte davvero sulla riga di comando, o null se non parte niente.
   *
   * IL GATE VIVE QUI, e non piu' in app.jsx, per una ragione che si e' gia'
   * verificata: quando era una copia locale, il commit che ha portato questo
   * modulo dallo `.trim()` di JS allo strip ASCII non l'ha seguito. Le due
   * meta' della stessa popover si contraddicevano — `error()` mostrava rosso
   * su `t=12<U+00A0>` mentre il gate, che aveva gia' tolto l'NBSP col trim,
   * lo spediva ripulito. Un rosso su un campo che poi funziona e' peggio di
   * nessun rosso.
   *
   * Adesso la stessa funzione risponde a "parte?" e a "cosa parte?", quindi
   * le due meta' concordano per costruzione e non per coincidenza. Il testo
   * restituito e' cio' che questo repo SPEDISCE, ed e' quello che
   * `RenderButton.buildCommand` mostra.
   *
   * Non e' pero' l'ultima parola su argv: `server.py` ri-striscia con
   * `str.strip()` pieno prima di costruire il comando. Quindi la divergenza
   * residua fra lo strip ASCII di qui e quello di Python si chiude un piano
   * piu' sotto, ed e' un motivo in piu' per cui e' safe-direction — la UI puo'
   * segnalare rosso su uno SPEC che il bridge avrebbe ripulito, mai il
   * contrario. Sta gia' nella tabella delle divergenze; sovradiceva solo
   * questa riga.
   *
   * Attenzione al confine: qui lo SPEC vuoto vale null (non si manda il flag),
   * mentre `error()` lo dice valido. E' la divergenza dichiarata numero uno —
   * il motore rifiuta `--magnify-at ""` perche' il flag gli e' stato passato,
   * e nella UI il campo vuoto significa "nessun target esplicito". Le due
   * risposte diverse alla stessa stringa sono il punto, non un difetto. */
  function sendable(spec) {
    const text = strip(spec === null || spec === undefined ? "" : spec);
    if (!text) return null;
    return error(text) === null ? text : null;
  }

  /* I target dello SPEC, [] se vuoto o malformato. Non è la sorgente di verità
   * del render — quella resta lo SPEC testuale che il motore riparsa — ma serve
   * a chi vuole contarli o mostrarli (es. "2 lenti"). */
  function targets(spec) {
    if (error(spec) !== null) return [];
    const text = strip(spec === null || spec === undefined ? "" : spec);
    if (!text) return [];
    const out = [];
    for (const raw of text.split(";")) {
      const chunk = strip(raw);
      if (!chunk) continue;
      const parsed = parseTarget(chunk);
      if (parsed.target) out.push(parsed.target);
    }
    return out;
  }

  window.PGEMagnifySpec = { KEYS, NUMERIC_KEYS, STR_KEYS, strip, error, sendable, targets };
})();
