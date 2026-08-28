/* =============================================================================
 * test-fingerprint-parity.js — il fingerprint della UI contro quello del
 * motore (issue #133).
 *
 * I due hash non sono lo stesso hash e non devono esserlo: la UI fa FNV-1a
 * sullo stato camelCase in memoria, il motore SHA-256 sul dict YAML. Quello
 * che deve coincidere e' la DERIVATA: quali modifiche muovono l'hash.
 *
 * Non e' pignoleria. I due hash pilotano la stessa decisione da due lati —
 * i pallini 🟢/🟡/⚪ dell'editor e il manifest `cache/<basename>.json` con cui
 * il motore decide quali stream ri-renderizzare. Se un campo muove uno e non
 * l'altro, o l'editor mostra verde su uno stem che il motore ha rifatto, o
 * mostra giallo su uno che non toccherebbe.
 *
 * `tests/node/test-fingerprint.js` fissa il lato JS. Il lato python non l'ha
 * mai visto nessuno: qui lo stream viene serializzato con il serializer vero
 * (`serializeStream`), riletto come dict YAML e passato a
 * `StreamCacheManager.compute_fingerprint`.
 *
 * Fuori portata, dichiarato: gli stream a durata implicita (PGE #205). Li' il
 * motore risolve la lunghezza dal file audio, e quel ramo importa soundfile —
 * assente su un checkout senza venv, cioe' proprio la configurazione in cui
 * questa suite deve girare in CI. Tutti i casi qui hanno `duration` scritta.
 *
 * Run: node tests/parity/test-fingerprint-parity.js
 * =========================================================================== */

const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["yaml-bridge.js", "backend.js"], {
  localStorage: { getItem: () => null, setItem: () => {} },
  fetch: () => Promise.reject(new Error("nessuna rete nei test")),
});
const { fingerprintStream } = window.PGEBackend;
const { serializeStream } = window.PGEYaml;

/* Lo stesso stream di base di test-fingerprint.js, meno i campi che quel test
 * usa per il ramo a durata implicita. */
const base = () => ({
  id: "s1", color: "#aabbcc", mute: false, solo: false, onset: 1.5,
  duration: 10, sample: "x.wav",
  density: 20,
  grain:   { duration: 0.1, envelope: "hanning" },
  pointer: { speedRatio: 1 },
  pitch:   { unit: "semitones", value: 0 },
  pan: 0, volume: 0,
});

/* Le mutazioni. `both` = deve muovere entrambi gli hash; `uiOnly` /
 * `engineOnly` = divergenza dichiarata, con la ragione. */
const MUTATIONS = [
  // --- audio: entrambi devono accorgersene ------------------------------
  { label: "id dello stream", side: "both", mut: s => { s.id = "s2"; } },
  { label: "duration",        side: "both", mut: s => { s.duration = 20; } },
  { label: "sample",          side: "both", mut: s => { s.sample = "y.wav"; } },
  { label: "density",         side: "both", mut: s => { s.density = 21; } },
  { label: "grain.duration",  side: "both", mut: s => { s.grain.duration = 0.2; } },
  { label: "grain.envelope",  side: "both", mut: s => { s.grain.envelope = "gaussian"; } },
  { label: "pitch.value",     side: "both", mut: s => { s.pitch.value = 3; } },
  { label: "pitch.unit",      side: "both", mut: s => { s.pitch.unit = "cents"; } },
  { label: "pan",             side: "both", mut: s => { s.pan = 100; } },
  { label: "volume",          side: "both", mut: s => { s.volume = -6; } },
  { label: "pointer.speedRatio", side: "both", mut: s => { s.pointer.speedRatio = 2; } },
  { label: "rngGroup (PGE #169)", side: "both", mut: s => { s.rngGroup = "cugini"; } },
  { label: "rangeAnchor (PGE #173)", side: "both", mut: s => { s.rangeAnchor = "min"; } },
  { label: "grain.readDirection (PGE #207)", side: "both",
    mut: s => { s.grain.readDirection = -1; } },
  { label: "deviationProbability", side: "both", mut: s => { s.deviationProbability = 50; } },
  { label: "una chiave sconosciuta in _extra (PGE-ui #115)", side: "both",
    mut: s => { s._extra = { chiave_futura: "a" }; } },
  { label: "voices", side: "both", mut: s => { s.voices = { num: 3, scatter: 0.2 }; } },
  { label: "un envelope al posto di uno scalare", side: "both",
    mut: s => { s.density = null; s.densityEnv = [[0, 10], [1, 40]]; } },

  // --- solo UI: campi che nello YAML non esistono ------------------------
  { label: "color", side: "neither",
    why: "non e' una chiave dello YAML: il serializer non la emette, quindi il " +
         "motore non puo' vederla, ed e' fuori dal fingerprint JS per lo stesso motivo" },
  { label: "mute", side: "neither",
    why: "il motore la esclude esplicitamente (FINGERPRINT_IGNORE_KEYS): cambia " +
         "QUALI stream si renderizzano, non l'audio del singolo stem" },
  { label: "solo", side: "neither", why: "idem mute" },

  // --- la divergenza dichiarata -----------------------------------------
  { label: "onset", side: "engineOnly",
    why: "divergenza voluta e documentata in CLAUDE.md: spostare una clip sulla " +
         "timeline non cambia l'audio dello stem, quindi la UI non lo marca " +
         "stale; il motore hasha il dict intero e ce lo trova dentro" },
];
// Le tre "neither" hanno bisogno della loro mutazione, scritta qui per
// tenerle vicine alla ragione.
const NEITHER_MUT = {
  color: s => { s.color = "#000000"; },
  mute:  s => { s.mute = true; },
  solo:  s => { s.solo = true; },
  onset: s => { s.onset = 99.0; },
};

function yamlDict(stream) {
  return window.jsyaml.load(serializeStream(stream));
}

parity({
  suite: "fingerprint",
  why: "backend.fingerprintStream (FNV-1a, stato camelCase)  ↔  StreamCacheManager.compute_fingerprint (SHA-256, dict YAML)",
  cases: [
    {
      label: "le chiavi che il motore esclude sono escluse anche qui",
      run: async (ask, assert) => {
        const c = (await ask("constants", {})).value;
        assert("FINGERPRINT_IGNORE_KEYS === {mute, solo}",
          JSON.stringify(c.fingerprint_ignore_keys) === JSON.stringify(["mute", "solo"]),
          JSON.stringify(c.fingerprint_ignore_keys));
        // Il verso che conta: cio' che il motore ignora la UI non deve
        // marcarlo stale, o l'editor chiederebbe un re-render che il motore
        // non farebbe.
        for (const k of c.fingerprint_ignore_keys) {
          const s = base(); NEITHER_MUT[k](s);
          assert(`la UI ignora '${k}' come il motore`,
            fingerprintStream(s, "wav") === fingerprintStream(base(), "wav"));
        }
      },
    },
    {
      label: "la derivata coincide: stesse modifiche, stesso movimento",
      run: async (ask, assert, ctx) => {
        const streams = MUTATIONS.map(m => {
          const s = base();
          (m.mut || NEITHER_MUT[m.label])(s);
          return s;
        });
        const answers = await ask(
          [base()].concat(streams).map(s => ({
            op: "fingerprint", args: { stream: yamlDict(s) } })));
        for (const a of answers) if (!a.ok) throw new Error(`oracolo: ${a.error}`);

        const fp0js = fingerprintStream(base(), "wav");
        const fp0eng = answers[0].value.hex;

        const bad = [];
        MUTATIONS.forEach((m, i) => {
          const jsMoved = fingerprintStream(streams[i], "wav") !== fp0js;
          const engMoved = answers[i + 1].value.hex !== fp0eng;
          const expected = {
            both:       [true, true],
            neither:    [false, false],
            engineOnly: [false, true],
            uiOnly:     [true, false],
          }[m.side];
          if (jsMoved !== expected[0] || engMoved !== expected[1]) {
            bad.push(`${m.label}: atteso ui=${expected[0]}/motore=${expected[1]}, ` +
                     `ottenuto ui=${jsMoved}/motore=${engMoved}` +
                     (m.why ? `\n        (dichiarato: ${m.why})` : ""));
          }
        });
        assert(`${MUTATIONS.length} modifiche, stesso verdetto su entrambi i lati`,
          bad.length === 0, bad.join("\n      "));

        // Quali siano le divergenze dichiarate lo decide la tabella qui sopra,
        // quindi contarle non discrimina niente: a verificarle e' il ciclo,
        // che pretende il movimento esatto di ciascuna. Qui si stampano, perche'
        // leggerle nell'output vale — ma da elenco, non da assert che non
        // puo' fallire.
        const declared = MUTATIONS.filter(m => m.side === "engineOnly" || m.side === "uiOnly");
        ctx.note(`${declared.length} divergenza/e dichiarata/e, verificate una a una qui sopra`,
          declared.map(m => `${m.label} → ${m.side}`));
      },
    },
    {
      label: "l'ordine delle chiavi non entra nell'hash, da nessuno dei due lati",
      run: async (ask, assert) => {
        const a = { stream_id: "s", duration: 5, sample: "x.wav",
                    grain: { duration: 0.1, envelope: "hanning" } };
        const b = { grain: { envelope: "hanning", duration: 0.1 },
                    sample: "x.wav", stream_id: "s", duration: 5 };
        const [ra, rb] = await ask([
          { op: "fingerprint", args: { stream: a } },
          { op: "fingerprint", args: { stream: b } },
        ]);
        if (!ra.ok || !rb.ok) throw new Error(ra.error || rb.error);
        assert("il motore ordina le chiavi (sort_keys=True)",
          ra.value.hex === rb.value.hex, `${ra.value.hex} vs ${rb.value.hex}`);
      },
    },
    {
      label: "la versione di semantica del motore la legge il bridge, non un umano",
      run: async (ask, assert) => {
        // VARIATION_SEMANTICS_VERSION entra nell'hash del MOTORE e non in
        // quello della UI. Non e' una svista, ed e' rimasta cosi': i due hash
        // rispondono a domande diverse — "il motore deve rifare lo stem" contro
        // "l'utente ha modificato qualcosa dall'ultimo render" — e la seconda
        // non dipende dalla semantica del motore.
        //
        // Ma il PALLINO dell'editor risponde alla prima, e per un po' ha
        // mentito: a un bump del motore (2 -> 3, PGE #222) l'hash della UI non
        // si muove, quindi gli stem restavano verdi mentre il motore era gia'
        // pronto a rifarli diversi. La decisione, presa qui e non rimandata:
        // la versione diventa un SECONDO asse di staleness, separato
        // dall'hash — `staleReason` in render-status.js, registrata per stream
        // insieme ai fingerprint (loadSemantics in backend.js) e letta dal
        // motore via GET /semantics-version.
        //
        // Quindi qui non c'e' piu' nessun numero trascritto a mano: era
        // l'ultima costante del motore ricopiata in questo repo, e un ATTESA
        // aggiornato a mano a ogni bump sarebbe stato lo stesso specchio che
        // questa cartella esiste per chiudere. Al suo posto i due fatti da cui
        // dipende la decisione: che il numero arrivi alla UI per la strada
        // giusta, e che sia davvero quello che sposta l'hash del motore.
        const c = (await ask("constants", {})).value;
        const imported = c.variation_semantics_version;
        const fromAst = c.variation_semantics_version_ast;

        assert("il motore la dichiara come intero",
          Number.isInteger(imported),
          `${JSON.stringify(imported)} — se e' sparita, l'asse "semantica" ` +
          `dell'editor non ha piu' sorgente e va tolto, non lasciato muto`);

        // Questa e' la strada VERA: la UI non importa niente del motore, riceve
        // il numero da GET /semantics-version, che chiama
        // engine_introspect.engine_semantics_version — lo stesso lettore AST
        // usato qui. Se un giorno la costante si sposta di file o diventa
        // un'espressione, l'AST torna null: il bridge risponde null, l'editor
        // non pretende niente e i pallini tornano a mentire in silenzio. Questo
        // assert e' cio' che impedisce al silenzio di passare inosservato.
        assert("e il lettore AST del bridge legge lo stesso numero",
          fromAst === imported,
          `AST=${JSON.stringify(fromAst)} import=${JSON.stringify(imported)}` +
          (c.variation_semantics_version_ast_error
            ? ` (${c.variation_semantics_version_ast_error})` : "") +
          ". La UI riceve il ramo AST: se diverge, l'editor giudica gli stem " +
          "con un numero che il motore non usa.");

        // E che quel numero sia dentro l'hash, non solo dichiarato: e' la
        // premessa dell'intero asse. Dall'esadecimale non si legge, quindi si
        // chiede al motore di rifare il conto con la sua costante cambiata.
        const s = base();
        const [plain, bumped, again] = await ask([
          { op: "fingerprint", args: { stream: yamlDict(s) } },
          { op: "fingerprint", args: { stream: yamlDict(s), semantics: imported + 1000 } },
          { op: "fingerprint", args: { stream: yamlDict(s) } },
        ]);
        if (!plain.ok || !bumped.ok || !again.ok) {
          throw new Error(plain.error || bumped.error || again.error);
        }
        assert("e' dentro l'hash: cambiarla a YAML fermo lo sposta",
          plain.value.hex !== bumped.value.hex,
          `${plain.value.hex} invariato con semantics=${imported + 1000}. ` +
          "Se il motore ha smesso di metterla nel fingerprint, l'editor sta " +
          "marcando stale degli stem per niente: togli l'asse.");

        assert("l'hash e' un SHA-256 e il patch non e' rimasto attaccato",
          /^[0-9a-f]{64}$/.test(plain.value.hex) && again.value.hex === plain.value.hex,
          `${JSON.stringify(plain.value)} poi ${JSON.stringify(again.value)}`);
      },
    },
  ],
});
