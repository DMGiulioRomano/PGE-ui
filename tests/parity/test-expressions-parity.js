/* =============================================================================
 * test-expressions-parity.js — il terzo tipo di valore e le mappe caotiche
 * (PGE-ui #215, #216) contro il motore.
 *
 * `src/lib/expressions.js` ricopia cinque cose del motore: dove
 * un'espressione vale (`EXPRESSION_FIELDS`), le chiavi che escludono
 * `grain.iot` e `pointer.position`, i tipi di mappa e gli intervalli del
 * catalogo. Le prime due decidono dove l'Inspector offre la riga di testo e
 * dove un click scriverebbe una chiave che il motore rifiuta: una copia che
 * diverge e' un errore muto. Gli intervalli servono solo al disegno, ma una
 * copia non verificata e' la seconda verita' che questo repo non tiene.
 *
 * E una domanda sul bridge: il clamp. `pointer_position` avvolge
 * (`WRAPPING_PARAMETERS`), quindi la UI non deve tagliarla.
 *
 * Run: node tests/parity/test-expressions-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["yaml-bridge.js", "expressions.js", "bounds.js"]);
const X = window.PGEExpr;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

parity({
  suite: "expressions",
  why: "PGEExpr (EXPRESSION_FIELDS, modi esclusivi, catalogo)  ↔  pge.expressions.fields / controller / maps.catalog",
  cases: [
    {
      label: "i letterali delle mappe caotiche sono quelli del motore",
      run: async (ask, assert) => {
        const [r] = await ask([{ op: "constants", args: {} }]);
        if (!r.ok) throw new Error(r.error);
        const c = r.value;
        assert("EXPRESSION_FIELDS, nell'ordine del motore",
          same(X.EXPRESSION_FIELDS, c.expression_fields),
          `ui=${JSON.stringify(X.EXPRESSION_FIELDS)} motore=${JSON.stringify(c.expression_fields)}`);
        assert("IOT_EXCLUSIVE_KEYS", same(X.IOT_EXCLUSIVE_KEYS, c.iot_exclusive_keys),
          JSON.stringify(c.iot_exclusive_keys));
        assert("POSITION_EXCLUSIVE_KEYS", same(X.POSITION_EXCLUSIVE_KEYS, c.position_exclusive_keys),
          JSON.stringify(c.position_exclusive_keys));
        assert("i tipi di mappa, custom compreso", same(X.MAP_TYPES, c.map_types),
          JSON.stringify(c.map_types));
        assert("gli intervalli del catalogo", same(X.MAP_KINDS, c.map_kinds),
          JSON.stringify(c.map_kinds));
        assert("pointer_position avvolge (WRAPPING_PARAMETERS)",
          Array.isArray(c.wrapping_parameters) && c.wrapping_parameters.includes("pointer_position"),
          JSON.stringify(c.wrapping_parameters));
      },
    },
    {
      label: "il fallback statico non taglia pointer.position e porta grain.iot",
      run: async (ask, assert) => {
        const [b] = await ask([{ op: "parameter_bounds", args: { source: "import" } }]);
        if (!b.ok) throw new Error(b.error);
        const iot = b.value.params.grain_iot;
        const PB = window.PGE_BOUNDS;
        assert("PGE_BOUNDS.grainIot = i bound di grain_iot",
          iot && PB.grainIot && PB.grainIot.min === iot.min_val && PB.grainIot.max === iot.max_val,
          `ui=${JSON.stringify(PB.grainIot)} motore=${JSON.stringify(iot)}`);
        assert("PGE_BOUNDS.pointerPosition non ha bordi (il valore rientra a capo)",
          PB.pointerPosition && PB.pointerPosition.min === -Infinity
            && PB.pointerPosition.max === Infinity,
          String(PB.pointerPosition && [PB.pointerPosition.min, PB.pointerPosition.max]));
      },
    },
  ],
});
