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
      run: async (ask, assert) => {
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

        const declared = MUTATIONS.filter(m => m.side === "engineOnly" || m.side === "uiOnly");
        assert(`${declared.length} divergenza/e dichiarata/e, tutte ancora vere`,
          declared.length > 0,
          declared.map(m => m.label).join(", "));
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
      label: "la versione di semantica del motore e' un canarino, non un dettaglio",
      run: async (ask, assert) => {
        // VARIATION_SEMANTICS_VERSION entra nell'hash del motore e non ha
        // controparte in quello della UI — non e' una svista: i due hash
        // rispondono a domande diverse ("il motore deve rifare lo stem" contro
        // "l'utente ha modificato qualcosa dall'ultimo render"), e la seconda
        // non dipende dalla semantica del motore.
        //
        // Il numero e' fissato qui APPOSTA, e questo e' l'unico posto del repo
        // in cui una costante del motore va trascritta a mano. Un bump la fa
        // diventare rossa, ed e' l'effetto voluto: un bump marca dirty ogni
        // stem di ogni progetto, quindi qualcuno qui deve decidere se e come
        // l'editor debba dirlo all'utente. Se la decisione e' "niente da fare",
        // si aggiorna il numero e si va avanti — ma consapevolmente.
        const ATTESA = 2;
        const c = (await ask("constants", {})).value;
        assert(`VARIATION_SEMANTICS_VERSION === ${ATTESA}`,
          c.variation_semantics_version === ATTESA,
          `il motore e' a ${c.variation_semantics_version}. Un bump invalida ogni ` +
          `stem gia' renderizzato: decidi se l'editor deve segnalarlo, poi aggiorna ` +
          `ATTESA in questo file.`);

        const s = base();
        const r = await ask("fingerprint", { stream: yamlDict(s) });
        assert("e resta dentro l'hash del motore (64 esadecimali di SHA-256)",
          r.ok && /^[0-9a-f]{64}$/.test(r.value.hex), JSON.stringify(r));
      },
    },
  ],
});
