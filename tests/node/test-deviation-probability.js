/* =============================================================================
 * test-deviation-probability.js — tests for deviation-probability.js
 * (window.PGEDeviationProb), the single source of truth that classifies a
 * stream's `deviation_probability` value into off / implicit / global /
 * perParam, mirroring the engine's GateFactory._classify_deviation_probability
 * ordering (envelope-like BEFORE dict→specific).
 *
 * Regression guard for the "cubic on a global envelope" bug: wrapEnv
 * turns a [[t,v],…] envelope into the typed `{type, points}` object form for
 * non-linear global interpolation, and that object must still read as a GLOBAL
 * envelope — not be mistaken for a per-param dict (which closed the envelope and
 * flipped the Inspector to per-param).
 *
 * Run: node test-deviation-probability.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// yaml-bridge.js (window.PGEYaml.DEVIATION_PROB_IMPLICIT) and envelope-loops.js
// (window.PGEEnv.isTypedEnv) must load first — deviation-probability.js reads
// both at call time.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/deviation-probability.js"), "utf8"));

const D = window.PGEDeviationProb;
const { DEVIATION_PROB_IMPLICIT } = window.PGEYaml;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

console.log("\n── module surface ──");
assert("PGEDeviationProb exposes mode + isEnvValue",
  D && typeof D.mode === "function" && typeof D.isEnvValue === "function",
  JSON.stringify(D && Object.keys(D)));

console.log("\n── mode(): off / implicit ──");
assert("undefined → off (key absent)", D.mode(undefined) === "off");
assert("null → off",                   D.mode(null) === "off");
assert("false → off",                  D.mode(false) === "off");
// `true` non è off: bool è sottoclasse di int in Python, e il motore lo prende
// dal ramo numerico. Verificato: create_gate(True, param_key='volume') → RandomGate.
assert("true → global (il motore ne fa un RandomGate su float(True))",
  D.mode(true) === "global");
assert("DEVIATION_PROB_IMPLICIT sentinel → implicit", D.mode(DEVIATION_PROB_IMPLICIT) === "implicit");

console.log("\n── mode(): global (scalar + envelope forms) ──");
assert("number → global",              D.mode(50) === "global");
assert("0 → global (scalar 0%)",       D.mode(0) === "global");
assert("array envelope → global",      D.mode([[0, 0], [1, 100]]) === "global");
// THE FIX: typed {type, points} envelope (what wrapEnv emits for cubic) → global.
assert("typed cubic envelope → global",
  D.mode({ type: "cubic", points: [[0, 0], [1, 100]] }) === "global");
assert("typed exp envelope → global",
  D.mode({ type: "exp", points: [[0, 0], [1, 100]] }) === "global");
// Il dict con il solo `points` — forma che l'editor non emette mai (wrapEnv
// scrive il dict solo per dire un interp non lineare) ma che il motore accetta:
// `is_envelope_like` guarda che `points` ci sia, non che ci sia anche `type`.
// Verificato sul motore: GateFactory.create_gate lo costruisce come EnvelopeGate.
// Leggerlo per-parametro apriva il pannello sbagliato.
assert("dict con points ma senza type → global (come il motore)",
  D.mode({ points: [[0, 0], [1, 100]] }) === "global");
// La trappola a valle: dichiararlo envelope senza che unwrapEnv lo sappia
// leggere lo farebbe aprire VUOTO nell'editor, e un commit lì sopra lo
// svuoterebbe davvero. È lo stesso giro che fa listEnvelopes → EnvelopeEditor:
// isEnvValue decide che è un envelope globale, unwrapEnv ne prende i punti.
{
  const stream = { id: "s1", deviationProbability: { points: [[0, 0], [1, 100]] } };
  assert("giro completo: dichiarato envelope…", D.isEnvValue(stream.deviationProbability));
  const un = window.PGEEnv.unwrapEnv(stream.deviationProbability);
  assert("…e aperto con i suoi punti, non vuoto",
    un.items.length === 2 && un.interp === "linear", JSON.stringify(un));
  const typed = window.PGEEnv.unwrapEnv({ type: "cubic", points: [[0, 0], [1, 100]] });
  assert("il typed env resta letto col suo interp (il bug per cui il modulo esiste)",
    typed.items.length === 2 && typed.interp === "cubic", JSON.stringify(typed));
}

console.log("\n── mode(): perParam ──");
assert("per-param dict → perParam", D.mode({ volume: 50 }) === "perParam");
assert("per-param dict with env value → perParam",
  D.mode({ volume: [[0, 0], [1, 100]] }) === "perParam");
assert("per-param dict with typed env value → perParam",
  D.mode({ pitch: { type: "cubic", points: [[0, 0], [1, 100]] } }) === "perParam");

console.log("\n── isEnvValue() ──");
assert("array → env",                    D.isEnvValue([[0, 0], [1, 1]]) === true);
assert("typed {type,points} → env",      D.isEnvValue({ type: "cubic", points: [[0, 0], [1, 1]] }) === true);
assert("{points} senza type → env (metà dict di is_envelope_like)",
  D.isEnvValue({ points: [[0, 0], [1, 1]] }) === true);
assert("dict per-parametro senza points → non env",
  D.isEnvValue({ volume: [[0, 0], [1, 1]] }) === false);
assert("number → not env",               D.isEnvValue(50) === false);
assert("per-param dict → not env",       D.isEnvValue({ volume: 50 }) === false);
assert("null → not env",                 D.isEnvValue(null) === false);
assert("false → not env",                D.isEnvValue(false) === false);
assert("string → not env",               D.isEnvValue("cubic") === false);

/* PARAM_KEYS / liveParamKeys — legate a un COMPORTAMENTO, non confrontate con
   una loro copia letterale: un'asserzione che ripete la lista passa con
   qualunque contenuto, ed e' come `envelope` (chiave morta) era rimasta dentro
   e `pc_rand_envelope` (viva) fuori senza che niente lo dicesse.

   Il criterio e' quello del motore, verificato eseguendolo: un corpo rotto
   sotto una chiave che GateFactory consulta deve essere segnalato; sotto una
   chiave che il motore scarta, no. `envelope` e' scartata perche' il suo spec
   (`grain_envelope`) e' is_smart=False e non passa mai da GateFactory —
   `{envelope: 50}` costruisce un AlwaysGate, cioe' ignora il numero. */
console.log("\n── PARAM_KEYS: chiavi vive vs chiavi morte ──");
const BROKEN = [];  // corpo che il motore rifiuta ovunque sia letto
for (const k of ["volume", "pan", "duration", "pitch", "pointer"])
  assert("chiave sempre viva segnalata: " + k,
    D.error({ [k]: BROKEN }) !== null, k);
for (const k of ["envelope", "foo", "pc_rand", "grain_envelope"])
  assert("chiave che il motore scarta → nessun avviso: " + k,
    D.error({ [k]: BROKEN }) === null, k);

/* Le condizionali: senza stream restano fuori (nessun avviso che potrebbe
   cadere su uno YAML che rende), con lo stream si risolvono esattamente come
   fa il motore. */
console.log("\n── liveParamKeys: le chiavi che dipendono dal blocco grain ──");
const grainOf = (g) => ({ grain: g || {} });
for (const k of ["reverse", "read_direction", "pc_rand_envelope"])
  assert("senza stream la condizionale non viene validata: " + k,
    D.error({ [k]: BROKEN }) === null, k);

// Gruppo esclusivo grain_direction: ExclusiveGroupSelector ne sceglie UNA.
// Senza `grain.read_direction` vince `reverse` (priorita' 1, default non-None).
assert("senza read_direction la chiave viva è reverse",
  D.error({ reverse: BROKEN }, grainOf({})) !== null);
assert("senza read_direction read_direction è inerte",
  D.error({ read_direction: BROKEN }, grainOf({})) === null);
assert("con grain.read_direction la chiave viva è read_direction",
  D.error({ read_direction: BROKEN }, grainOf({ readDirection: 1 })) !== null);
assert("con grain.read_direction reverse è inerte",
  D.error({ reverse: BROKEN }, grainOf({ readDirection: 1 })) === null);
// La chiave puo' essere scritta come envelope: lo scalare resta undefined,
// e la condizione deve guardare anche il campo parallelo.
assert("read_direction in forma envelope conta come scritta",
  D.error({ read_direction: BROKEN }, grainOf({ readDirectionEnv: [[0, 1], [1, -1]] })) !== null);
// La chiave nuda (`read_direction:` senza valore) e' comunque scritta.
assert("read_direction nuda conta come scritta",
  D.error({ read_direction: BROKEN }, grainOf({ readDirection: null })) !== null);

// pc_rand_envelope: viva salvo spec transition ({from,to}) o multistate.
assert("pc_rand_envelope viva con grain.envelope stringa",
  D.error({ pc_rand_envelope: BROKEN }, grainOf({ envelope: "hanning" })) !== null);
assert("pc_rand_envelope viva con grain.envelope lista",
  D.error({ pc_rand_envelope: BROKEN }, grainOf({ envelope: ["hanning", "gaussian"] })) !== null);
assert("pc_rand_envelope inerte con spec transition",
  D.error({ pc_rand_envelope: BROKEN }, grainOf({ envelope: { from: "hanning", to: "gaussian" } })) === null);
assert("pc_rand_envelope inerte con spec multistate",
  D.error({ pc_rand_envelope: BROKEN }, grainOf({ envelope: { states: ["hanning", "gaussian"] } })) === null);
// `from` senza `to` non e' una transition per il motore (esige entrambe).
assert("pc_rand_envelope viva con un dict che non è transition né multistate",
  D.error({ pc_rand_envelope: BROKEN }, grainOf({ envelope: { from: "hanning" } })) !== null);

// ALL_PARAM_KEYS serve al walk degli envelope, non alla validazione: contiene
// tutte le chiavi che in qualche configurazione il motore legge.
for (const k of ["volume", "pan", "duration", "pitch", "pointer",
                 "reverse", "read_direction", "pc_rand_envelope", "envelope"])
  assert("ALL_PARAM_KEYS contiene " + k, D.ALL_PARAM_KEYS.includes(k), k);

/* Breakpoint in forma dict {t, v, type?}: il builder del motore li normalizza
   in [t, v, type?] (envelope_builder.py:132), quindi sotto `points` e sotto una
   chiave per-parametro il corpo si costruisce. L'asimmetria e' del motore: la
   lista NUDA di soli dict a livello globale non passa is_envelope_like, e li'
   il rifiuto e' vero. Tutte e cinque verificate eseguendo il motore. */
console.log("\n── breakpoint in forma dict {t, v} ──");
const dictBPs = [{ t: 0, v: 1 }, { t: 1, v: 50 }];
assert("{points: [{t,v}…]} → nessun avviso",
  D.error({ points: dictBPs }) === null, JSON.stringify(D.error({ points: dictBPs })));
assert("{type, points: [{t,v}…]} → nessun avviso",
  D.error({ type: "cubic", points: dictBPs }) === null);
assert("per-param [{t,v}…] → nessun avviso",
  D.error({ pitch: dictBPs }) === null);
assert("per-param con interp per-punto → nessun avviso",
  D.error({ volume: [{ t: 0, v: 1, type: "cubic" }, { t: 1, v: 50 }] }) === null);
assert("lista NUDA di soli dict → segnalata (il motore la rifiuta)",
  D.error(dictBPs) !== null, JSON.stringify(D.error(dictBPs)));
assert("lista mista [[t,v], {t,v}] → nessun avviso (il motore la costruisce)",
  D.error([[0, 1], { t: 1, v: 50 }]) === null);

/* error() — i corpi che il motore rifiuta da PGE #209. Prima li accettava in
   silenzio e li leggeva come 100% (AlwaysGate): il render riusciva producendo
   l'opposto di quanto scritto. Ora solleva, e l'Inspector lo dice prima. */
console.log("\n── error(): i cinque stati che NON sono errori (PGE #210) ──");
assert("chiave assente → nessun errore",      D.error(undefined) === null);
assert("chiave vuota (sentinella) → nessun errore", D.error(DEVIATION_PROB_IMPLICIT) === null);
assert("dict vuoto → nessun errore",          D.error({}) === null);
assert("false → nessun errore",               D.error(false) === null);
assert("dict con sola chiave a null → nessun errore", D.error({ reverse: null }) === null);
assert("scalare → nessun errore",             D.error(50) === null);
assert("scalare 0 → nessun errore",           D.error(0) === null);
assert("true → nessun errore (per il motore è il numero 1)", D.error(true) === null);
assert("envelope valido → nessun errore",     D.error([[0, 0], [1, 100]]) === null);
assert("envelope tipizzato valido → nessun errore",
  D.error({ type: "cubic", points: [[0, 0], [1, 100]] }) === null);
assert("blocco compatto (annidato) → nessun errore",
  D.error([[[[0, 0], [100, 50]], 1.0, 4]]) === null);
// Le due forme in cui il corpo È il gruppo o il blocco, non li contiene:
// is_envelope_like le prova sull'oggetto intero prima di scorrerlo. Verificato
// sul motore: entrambe → EnvelopeGate.
assert("BP group diretto → nessun errore (PGE #64)",
  D.error([[[0, 0], [1, 100]], "cubic"]) === null);
assert("blocco compatto nudo → nessun errore",
  D.error([[[0, 0], [100, 50]], 1.0, 4]) === null);
assert("BP group diretto sotto una chiave per-parametro → nessun errore",
  D.error({ volume: [[[0, 0], [1, 100]], "cubic"] }) === null);
assert("blocco compatto nudo sotto una chiave per-parametro → nessun errore",
  D.error({ pitch: [[[0, 0], [100, 50]], 1.0, 4] }) === null);

console.log("\n── error(): envelope globale malformato ──");
assert("lista vuota → env/empty",
  JSON.stringify(D.error([])) === JSON.stringify({ kind: "env", reason: "empty", value: [] }),
  JSON.stringify(D.error([])));
assert("lista senza breakpoint → env/shape", (D.error(["x"]) || {}).reason === "shape");
assert("points vuoti → env/empty",
  (D.error({ type: "linear", points: [] }) || {}).reason === "empty");
assert("points scalare → env/shape (il motore legge la chiave, non il tipo)",
  (D.error({ type: "linear", points: 5 }) || {}).reason === "shape");
assert("globale malformato → nessun param nominato",
  D.error([]).param === undefined, JSON.stringify(D.error([])));
// Il ramo dict di _envBodyError, prima raggiungibile solo per-parametro: è la
// grafia più plausibile del terzo corpo malformato di PGE #209. Tutti e quattro
// verificati sul motore → InvalidFieldValueError.
assert("{points:} lasciata vuota → env/shape",
  (D.error({ points: null }) || {}).reason === "shape", JSON.stringify(D.error({ points: null })));
assert("{points: 'x'} → env/shape", (D.error({ points: "x" }) || {}).reason === "shape");
assert("{points: []} globale → env/empty", (D.error({ points: [] }) || {}).reason === "empty");
assert("{type: cubic, points: null} → env/shape",
  (D.error({ type: "cubic", points: null }) || {}).reason === "shape");
assert("{points: [[0,1]]} globale valido → nessun errore",
  D.error({ points: [[0, 1]] }) === null);

console.log("\n── error(): valore per-parametro malformato ──");
assert("volume: [] → env/empty su volume",
  JSON.stringify(D.error({ volume: [] })) ===
  JSON.stringify({ kind: "env", reason: "empty", param: "volume", value: [] }),
  JSON.stringify(D.error({ volume: [] })));
assert("pitch: {} (dict senza points) → env/shape su pitch",
  (D.error({ pitch: {} }) || {}).param === "pitch" &&
  (D.error({ pitch: {} }) || {}).reason === "shape");
assert("pointer: ['x'] → env/shape su pointer",
  (D.error({ pointer: ["x"] }) || {}).param === "pointer");
assert("valore di tipo estraneo → type",
  (D.error({ volume: "x" }) || {}).kind === "type");
// Il gate chiede il dict una chiave alla volta: quelle che non è mai chiamato a
// leggere non le legge nessuno, e un corpo rotto lì dentro non rompe il render.
assert("chiave che il motore non consulta → nessun errore", D.error({ foo: [] }) === null);
assert("chiave buona accanto a una ignota → nessun errore", D.error({ foo: [], volume: 50 }) === null);

console.log("\n── error(): tipo di primo livello ──");
assert("stringa → type", (D.error("ciao") || {}).kind === "type");
assert("stringa → riporta il valore", D.error("ciao").value === "ciao");

// Falso negativo dichiarato: il motore rifiuta anche la lista mista, il mirror
// no. È la direzione voluta — un avviso in meno, mai uno su uno YAML che rende.
assert("lista mista buono+rotto → passa (mirror conservativo)",
  D.error([[0, 0], "x"]) === null);

/* Cablaggio: i due posti che devono usare il modulo come si deve.
   Sono guardie sul sorgente perche' vivono in JSX, che i test node non
   eseguono — ma sono esattamente le righe che, restando indietro, hanno reso
   false due dichiarazioni di CLAUDE.md. */
console.log("\n── cablaggio UI ──");
const inspSrc = fs.readFileSync(path.join(__dirname, "../../src/components/Inspector.jsx"), "utf8");
const eeSrc   = fs.readFileSync(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"), "utf8");

assert("l'Inspector passa lo stream a error() (chiavi condizionali)",
  /\.error\(\s*d\s*,\s*stream\s*\)/.test(inspSrc));
/* «offre pc_rand_envelope, non la chiave morta envelope» e' un'affermazione sul
   COMPORTAMENTO, non sulla presenza di una stringa nel file: la chiave morta
   resta nel catalogo apposta (le sue righe devono essere visibili e
   cancellabili sui progetti che la portano scritta), ed e' liveParamKeys a
   decidere cosa viene offerto. */
assert("pc_rand_envelope e' fra le chiavi offerte",
  D.liveParamKeys(grainOf({ envelope: "hanning" })).includes("pc_rand_envelope"));
assert("la chiave morta envelope non e' mai offerta",
  ["hanning", ["hanning", "gaussian"], { from: "h", to: "g" }, { states: ["h", "g"] }, undefined]
    .every(e => !D.liveParamKeys(grainOf({ envelope: e })).includes("envelope")));
assert("ma resta nel catalogo dell'Inspector, per i file che la portano scritta",
  /key:\s*"envelope"/.test(inspSrc.split("const DEVIATION_PROB_PARAMS")[1].split("];")[0]));
assert("le righe offerte seguono le chiavi vive",
  /liveParamKeys\(stream\)/.test(inspSrc));

/* PGE #209: `[]` e' il primo dei corpi che il motore rifiuta, e l'editor non
   deve poterlo scrivere da nessuna delle sue tre vie di cancellazione — il
   guard c'era solo su una (Delete su un breakpoint), quindi un envelope fatto
   di un solo blocco loop si svuotava con "remove loop" o con Delete. */
assert("il guard 'non svuotare' esiste una volta sola",
  (eeSrc.match(/function wouldEmptyEnv/g) || []).length === 1);
/* Una asserzione NOMINATA per ciascuna via, non un conteggio: il conteggio
   includeva la definizione, quindi `>= 4` restava vero anche togliendone una —
   e quella scoperta era proprio il ramo del breakpoint, la via storica e
   l'unica che esisteva prima di questa PR. */
// La finestra esclude `selectedBlock`, cosi' il ramo del breakpoint non puo'
// passare grazie alla chiamata del ramo successivo.
assert("il ramo del breakpoint selezionato lo usa",
  /selectedBP\s*!=\s*null\)\s*\{(?:(?!selectedBlock)[\s\S]){0,900}?wouldEmptyEnv\(/.test(eeSrc));
assert("il ramo del blocco selezionato lo usa",
  /selectedBlock\s*!=\s*null\)\s*\{[\s\S]{0,600}?wouldEmptyEnv\(/.test(eeSrc));
assert("deleteSelectedLoop lo usa",
  /function deleteSelectedLoop\(\)[\s\S]{0,400}?wouldEmptyEnv\(/.test(eeSrc));
assert("il dblclick sul canvas lo usa, invece di ricontare a mano",
  /onCanvasDblClick[\s\S]{0,1600}?wouldEmptyEnv\(/.test(eeSrc));
// Il `disabled` guarda solo dentro LoopBlockPanel: senza questa seconda
// asserzione il genitore potrebbe smettere di passare il prop e il bottone
// resterebbe sempre abilitato con la suite verde.
assert("il bottone 'remove loop' e' disabilitato quando svuoterebbe",
  /disabled=\{!!onDeleteBlocked\}/.test(eeSrc));
assert("e il genitore gli passa davvero la condizione",
  /onDeleteBlocked=\{wouldEmptyEnv\(/.test(eeSrc));

console.log(`\n${fail ? "✗" : "✓"} deviation_probability: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
