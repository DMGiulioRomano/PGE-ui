/* expressions.js — il terzo tipo di valore di un parametro (PGE #308, #313).
 *
 * Accanto al numero e all'envelope il motore accetta un'ESPRESSIONE: una
 * stringa fra parentesi che legge le mappe dello stream (`m1`, `m1.y`) o il
 * tempo (`t`), valutata a ogni grano — `grain.duration: (0.02 + 0.08*m1)`.
 * Vale sul valore base dei campi di EXPRESSION_FIELDS (la copia di
 * `pge/expressions/fields.py`, tenuta onesta da tests/parity); altrove il
 * motore la rifiuta.
 *
 * Nel modello dell'editor un'espressione vive nel campo SCALARE, come la
 * stringa scritta (`volume: "(-18 + 4*m1)"`, `volumeEnv: null`): e' cosi' che
 * yaml-bridge la legge e la riscrive senza toccarla. Questo modulo e' la sola
 * risposta alla domanda «questo valore e' un'espressione?», che ogni gesto
 * deve fare prima di trattarlo come un numero: un NumberField la
 * sovrascriverebbe, un clamp la farebbe NaN, il toggle scalare↔env la
 * metterebbe dentro un breakpoint.
 *
 * Puro, nessuna dipendenza: lo leggono primitives.jsx, l'Inspector,
 * envelope-utils (la conversione di unita') e i test node.
 */
(function () {
  "use strict";

  /** Il valore base di ogni parametro a schema (PGE #313), path YAML dentro
   * lo stream. */
  const EXPRESSION_FIELDS = Object.freeze([
    "grain.duration", "grain.iot", "pointer.position",
    "volume", "pan",
    "pitch.semitones", "pitch.cents", "pitch.quarter_tone",
    "pitch.eighth_tone", "pitch.ratio", "pitch.value",
    "density", "fill_factor", "distribution",
    "grain.read_direction",
  ]);

  /** Le chiavi che non convivono con `grain.iot` (PGE #311,
   * `IOT_EXCLUSIVE_KEYS`): un errore del motore per PRESENZA, non una
   * priorita' — anche `distribution: 0`. */
  const IOT_EXCLUSIVE_KEYS = Object.freeze(["density", "fill_factor", "distribution"]);

  /** Le chiavi di `pointer:` che non convivono con `position` (PGE #312,
   * `POSITION_EXCLUSIVE_KEYS`). */
  const POSITION_EXCLUSIVE_KEYS = Object.freeze(["speed_ratio", "start"]);

  /** I tipi di mappa (PGE #313: `MAP_TYPES` piu' `custom`) e, per quelli del
   * catalogo, l'intervallo di `r` e quello del valore (`MAP_KINDS`): servono
   * alla finestra dell'envelope di `r` e alla legenda, e la parita' li
   * confronta col catalogo del motore. */
  const MAP_TYPES = Object.freeze(["logistic", "tent", "sine", "cubic", "henon", "circle", "custom"]);
  const MAP_KINDS = Object.freeze({
    logistic: { r_range: [2.5, 4.0], value_range: [0.0, 1.0] },
    tent:     { r_range: [2.5, 3.999], value_range: [0.0, 1.0] },
    sine:     { r_range: [0.0, 4.0], value_range: [-1.0, 1.0] },
    cubic:    { r_range: [1.5, 3.0], value_range: [-1.2, 1.2] },
    henon:    { r_range: [0.8, 1.4], value_range: [-1.3, 1.4] },
    circle:   { r_range: [0.0, 1.0], value_range: [0.0, 1.0] },
  });

  /** True se il testo sta tutto dentro una coppia di parentesi esterne:
   * `(a) + (b)` comincia e finisce con una parentesi, ma non e' fra
   * parentesi (mirror di `outer_parenthesized` del motore). */
  function outerParenthesized(text) {
    if (typeof text !== "string") return false;
    const t = text.trim();
    if (t.length < 2 || t[0] !== "(" || t[t.length - 1] !== ")") return false;
    let open = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") open++;
      else if (t[i] === ")") {
        open--;
        if (open === 0) return i === t.length - 1;
      }
    }
    return false;
  }

  /** True se il valore e' un'espressione: una stringa fra parentesi esterne.
   * E' la domanda di ogni gesto che tratterebbe il valore come un numero. */
  function isExpression(v) {
    return typeof v === "string" && outerParenthesized(v);
  }

  /** L'espressione moltiplicata per `factor`, ancora fra parentesi esterne.
   * Il motore applica l'unita' di `grain.duration` / `grain.iot` al RISULTATO
   * dell'espressione: cambiando unita' il testo va scalato, o lo stesso testo
   * vale mille volte di piu' o di meno (PGE-ui #215). Il fattore 1 lascia il
   * testo com'e'. */
  function scaleExpression(text, factor) {
    if (!isExpression(text) || factor === 1) return text;
    if (!Number.isFinite(factor) || factor <= 0) return text;
    const f = Number(factor.toPrecision(12));
    return `(${text.trim()} * ${f})`;
  }

  /** Il seme di un'espressione nuova, scritta da un bottone: il numero che
   * la riga mostra, fra parentesi. */
  function seedExpression(v, fallback) {
    const n = typeof v === "number" && Number.isFinite(v) ? v
      : (typeof fallback === "number" ? fallback : 0);
    return `(${n})`;
  }

  window.PGEExpr = Object.freeze({
    EXPRESSION_FIELDS,
    IOT_EXCLUSIVE_KEYS,
    POSITION_EXCLUSIVE_KEYS,
    MAP_TYPES,
    MAP_KINDS,
    outerParenthesized,
    isExpression,
    scaleExpression,
    seedExpression,
  });
})();
