/* =============================================================================
 * test-magnify-parity.js — `window.PGEMagnifySpec` contro la grammatica vera
 * di `--magnify-at` (issue #133).
 *
 * `test-magnify-spec.js` verifica che il mirror sia coerente con se stesso e
 * con la grammatica DESCRITTA nel suo commento. Qui la grammatica viene
 * chiesta al motore: `_parse_magnify_spec` in `src/pge/cli.py`, eseguito,
 * sullo stesso corpus.
 *
 * La prima esecuzione di questo file ha trovato sei divergenze reali, fra cui
 * una nel verso pericoloso — `t=0x10` valido per `Number()`, rifiutato da
 * `float()`, cioe' uno SPEC che la UI lasciava passare e che uccideva il
 * render. Le divergenze rimaste sono tre, tutte dichiarate qui sotto.
 *
 * Run: node tests/parity/test-magnify-parity.js
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const { parity } = require("./harness.js");

global.window = {};
// eslint-disable-next-line no-eval
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/magnify-spec.js"), "utf8"));
const M = window.PGEMagnifySpec;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Il corpus. Ogni voce e' uno SPEC che qualcuno potrebbe scrivere nel campo
 * della lente, piu' le forme di numero su cui `Number()` e `float()` non erano
 * d'accordo. Nessuna aspettativa scritta qui: l'aspettativa e' il motore. */
const CORPUS = [
  // minimi e forme ordinarie
  "t=14", "t=14,zoom=10", "t=1;t=2", "t=0", "t=-3", "t=+5", "t=.5", "t=5.",
  "t=14,y=0.5,zoom=10,out=2,src=3", "t=14,stream=s1", "t=4,stream=texture 2",
  " t = 14 , zoom = 10 ", "t=4;", ";t=14;", "t=1;;t=2", "t=14,",
  // numeri al bordo delle due grammatiche
  "t=1e3", "t=1E3", "t=1e+3", "t=1e-3", "t=1_000", "t=1_0.5", "t=1.000_1",
  "t=0x10", "t=0b101", "t=0o17", "t=inf", "t=-inf", "t=Infinity", "t=infinity",
  "t=nan", "t=NaN", "t=1e400", "t=00012", "t=1.", "t=.", "t=_1", "t=1_",
  "t=1__0", "t=1e", "t=1e+", "t=--5", "t=1d", "t=1.2.3", "t=1 4",
  // errori di struttura
  "t=,t=14", "t=14,bogus=1", "zoom=10", "t=", "t", "t=abc", "t=14;zoom=3",
  "T=14", "stream=s1", "t=14,zoom", "t=14,zom=10",
];

/* Le divergenze che restano, ognuna con la ragione per cui resta. Il test le
 * PRETENDE: se una sparisce (o se ne aggiunge una) il test parla, invece di
 * lasciare che la lista invecchi in silenzio come farebbe un commento. */
const KNOWN = {
  "": {
    js: true, engine: false,
    why: "voluta e documentata in magnify-spec.js: il campo vuoto significa " +
         "'nessun target' e chi chiama omette il flag, quindi il motore non " +
         "vede mai lo SPEC vuoto che rifiuterebbe",
  },
  "t=4,stream=": {
    js: false, engine: true,
    why: "la UI e' piu' stretta: `stream=` vuoto non seleziona nessuno stream, " +
         "e rifiutarlo mentre si scrive e' meglio che disegnare una lente su " +
         "niente (gia' fissata in test-magnify-spec.js)",
  },
  "t=１４": {
    js: false, engine: true,
    why: "`float()` accetta le cifre decimali Unicode, `Number()` no. " +
         "Replicarlo richiederebbe la tabella unicodedata.decimal; la " +
         "divergenza e' nel verso sicuro (UI piu' stretta del motore)",
  },
};

parity({
  suite: "magnify-spec",
  why: "window.PGEMagnifySpec.error/targets  ↔  pge.cli._parse_magnify_spec",
  cases: [
    {
      label: "il registro delle chiavi e' quello del motore",
      run: async (ask, assert) => {
        const c = (await ask("constants", {})).value;
        assert("KEYS === _MAGNIFY_KEYS",
          eq([...M.KEYS].sort(), c.magnify_keys), JSON.stringify(c.magnify_keys));
        assert("NUMERIC_KEYS === _MAGNIFY_NUMERIC_KEYS",
          eq([...M.NUMERIC_KEYS].sort(), c.magnify_numeric_keys),
          JSON.stringify(c.magnify_numeric_keys));
        assert("STR_KEYS === _MAGNIFY_STR_KEYS",
          eq([...M.STR_KEYS].sort(), c.magnify_str_keys),
          JSON.stringify(c.magnify_str_keys));
      },
    },
    {
      label: "valido di qua ⇔ valido di la', su tutto il corpus",
      run: async (ask, assert) => {
        const specs = CORPUS.concat(Object.keys(KNOWN));
        const answers = await ask(
          specs.map(spec => ({ op: "parse_magnify_spec", args: { spec } })));

        const source = (answers.find(a => a.ok) || {}).value;
        assert("la grammatica arriva dal motore, non da una copia",
          source && (source.source === "import" || source.source === "ast-slice"),
          JSON.stringify(source && source.source));

        let agree = 0;
        const divergent = [];
        specs.forEach((spec, i) => {
          const jsOk = M.error(spec) === null;
          const engineOk = answers[i].ok;
          if (jsOk === engineOk) { agree++; return; }
          divergent.push({ spec, jsOk, engineOk, engineSays: answers[i].error });
        });

        for (const spec of Object.keys(KNOWN)) {
          const k = KNOWN[spec];
          const found = divergent.find(d => d.spec === spec);
          assert(`divergenza dichiarata su ${JSON.stringify(spec)} (${k.why.slice(0, 48)}…)`,
            !!found && found.jsOk === k.js && found.engineOk === k.engine,
            found ? JSON.stringify(found) : "non diverge piu': aggiorna KNOWN");
        }

        const unexpected = divergent.filter(d => !(d.spec in KNOWN));
        assert(`nessuna divergenza non dichiarata (${agree}/${specs.length} d'accordo)`,
          unexpected.length === 0,
          unexpected.map(d => `${JSON.stringify(d.spec)}: js=${d.jsOk} motore=${d.engineOk} — ${d.engineSays || ""}`).join("\n      "));
      },
    },
    {
      label: "i target parsati sono gli stessi numeri",
      run: async (ask, assert) => {
        // Solo gli SPEC che entrambi accettano: dove il verdetto diverge il
        // confronto dei target non ha significato.
        const specs = CORPUS.filter(s => M.error(s) === null);
        const answers = await ask(
          specs.map(spec => ({ op: "parse_magnify_spec", args: { spec } })));
        const mismatches = [];
        specs.forEach((spec, i) => {
          if (!answers[i].ok) return;
          const mine = M.targets(spec);
          const theirs = answers[i].value.targets;
          // JSON.stringify manda Infinity/NaN a null da entrambe le parti solo
          // se ci arrivano allo stesso modo: e' proprio cio' che si verifica.
          if (!eq(mine, theirs)) mismatches.push({ spec, mine, theirs });
        });
        assert(`${specs.length} SPEC validi → stessi target`,
          mismatches.length === 0,
          mismatches.map(m => `${JSON.stringify(m.spec)}: ui=${JSON.stringify(m.mine)} motore=${JSON.stringify(m.theirs)}`).join("\n      "));
      },
    },
    {
      label: "gli SPEC che la UI lascia partire il motore non li rifiuta mai",
      run: async (ask, assert) => {
        // Il contratto di app.jsx: `magnifySpecSendable` manda il flag solo se
        // error() e' null e la stringa non e' vuota. Questa e' quella regola,
        // misurata contro il motore invece che descritta.
        const sendable = CORPUS.filter(s => s.trim() && M.error(s) === null);
        const answers = await ask(
          sendable.map(spec => ({ op: "parse_magnify_spec", args: { spec } })));
        const killed = sendable.filter((s, i) => !answers[i].ok);
        assert(`${sendable.length} SPEC inviabili, nessuno fa uscire il motore con 1`,
          killed.length === 0,
          killed.map((s, i) => `${JSON.stringify(s)}`).join(", "));
      },
    },
  ],
});
