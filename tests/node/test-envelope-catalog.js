/* =============================================================================
 * test-envelope-catalog.js — le due funzioni pure che vivevano dentro
 * EnvelopeEditor.jsx (issue #140), ora in src/lib/ e qui ESEGUITE:
 *
 *   window.PGEEnv.wouldEmptyEnv          (envelope-loops.js)
 *   window.PGEEnvCatalog.listEnvelopes   (envelope-catalog.js)
 *
 * Sono le due dove un errore e' silenzioso e si vede solo usando l'editor:
 *
 *  1. `wouldEmptyEnv` e' il guard di PGE #209 — `[]` e' il primo dei corpi che
 *     il motore rifiuta — su cinque vie di cancellazione. I suoi due modi di
 *     sbagliare sono opposti e nessuno dei due alza niente: far passare un
 *     corpo vuoto (render che esce 1) oppure rifiutare un envelope PIENO che
 *     non riconosce (il paste che spariva in silenzio, la forma wrappata).
 *  2. `listEnvelopes` e' il catalogo di cosa si puo' aprire e disegnare. Una
 *     voce che manca rende irraggiungibile un envelope scritto e fa aprire
 *     all'Inspector un envelope diverso da quello cliccato; una voce con
 *     l'unita' o il cap sbagliati apre l'asse fuori scala, e computeYFit +
 *     clampY riscrivono il primo punto trascinato.
 *
 * Prima della #140 stavano nel JSX e la loro unica copertura era per
 * ESTRAZIONE dal sorgente (`extractFn` + `new Function` in
 * test-deviation-probability.js), con un `catch` che ricadeva su `() => []`:
 * su un'estrazione rotta meta' delle asserzioni restava verde, perche'
 * `{}.inert === undefined` e' vero su una lista vuota.
 *
 * Run: node test-envelope-catalog.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

const LIB = (f) => path.join(__dirname, "../../src/lib/", f);

// L'ordine e' quello di PGE Editor.html: il catalogo legge PGE_BOUNDS
// (yaml-bridge), PGEEnv, PGEEnvUtils e PGEDeviationProb — tutti a chiamata.
global.window = { jsyaml: require("js-yaml") };
for (const f of ["yaml-bridge.js", "envelope-loops.js", "deviation-probability.js",
                 "envelope-utils.js", "envelope-catalog.js"]) {
  eval(fs.readFileSync(LIB(f), "utf8"));
}

const E  = window.PGEEnv;
const EU = window.PGEEnvUtils;
const D  = window.PGEDeviationProb;
const C  = window.PGEEnvCatalog;
const PB = window.PGE_BOUNDS;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const BP   = [[0, 0], [0.5, 50], [1, 100]];
const LOOP = [[[0, 0], [100, 1]], 1, 4];   // blocco compatto: [pattern, end, n_reps]

/* ═══════════════════════════════════════════════════════════════════════════
   wouldEmptyEnv — il guard di PGE #209
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── superficie del modulo ──");
assert("wouldEmptyEnv e' pubblicata da PGEEnv, accanto ai predicati che somma",
  typeof E.wouldEmptyEnv === "function" &&
  typeof E.isBreakpoint === "function" &&
  typeof E.isDictBreakpoint === "function" &&
  typeof E.isCompactBlock === "function");

console.log("\n── wouldEmptyEnv: i corpi che il motore rifiuta ──");
assert("`[]` svuota (e' il corpo di PGE #209)", E.wouldEmptyEnv([]) === true);
assert("una lista di soli non-punti svuota",
  E.wouldEmptyEnv(["cubic", 3, null]) === true);

console.log("\n── wouldEmptyEnv: i contenuti veri (i falsi positivi storici) ──");
assert("un breakpoint basta", E.wouldEmptyEnv([[0, 1]]) === false);
assert("i breakpoint 3-tuple (interp per-punto) bastano",
  E.wouldEmptyEnv([[0, 1, "step"], [1, 0]]) === false);
/* Il blocco compatto NUDO: il valore E' il blocco invece di contenerlo, e
   nessun conteggio lo vede — ne' desugarBPGroups ne' unwrapEnv lo toccano. */
assert("il blocco compatto NUDO non svuota (il valore E' il blocco)",
  E.wouldEmptyEnv(LOOP) === false);
assert("un envelope fatto di un solo blocco loop non svuota",
  E.wouldEmptyEnv([LOOP]) === false);
/* Il dict {t, v}: il motore lo normalizza in [t, v] prima di guardarlo
   (envelope_builder.py:132). isBreakpoint non va allargata — dice anche cosa
   il canvas puo' trascinare — quindi il predicato e' isDictBreakpoint. */
assert("i breakpoint in forma dict {t, v} non svuotano",
  E.wouldEmptyEnv([{ t: 0, v: 1 }, { t: 1, v: 1 }]) === false);
assert("e basta un dict solo",
  E.wouldEmptyEnv([{ t: 0, v: 1 }]) === false);
assert("il predicato del dict e' quello del modulo, non un ramo locale",
  E.isDictBreakpoint({ t: 0, v: 1 }) === true &&
  E.wouldEmptyEnv([{ t: 0 }]) === true);

console.log("\n── wouldEmptyEnv: riceve gli ITEM, non la forma wrappata ──");
/* Il difetto del paste: `wrapEnv` restituisce {type, points} per un envelope
   di soli breakpoint con interp globale non lineare, e qui un non-array e'
   "vuoto". La funzione NON si allarga — chi ha in mano una forma wrappata
   passa prima da unwrapEnv — perche' il dict lo puo' anche portare un
   envelope davvero vuoto, e allargarla toglierebbe il guard a quella forma. */
const typed = E.wrapEnv([[0, 0], [1, 100]], "cubic");
assert("wrapEnv produce davvero la forma wrappata (premessa del caso)",
  typed && !Array.isArray(typed) && Array.isArray(typed.points));
assert("la forma wrappata, passata cosi', risulta vuota (e' il contratto)",
  E.wouldEmptyEnv(typed) === true);
assert("passata da unwrapEnv (i suoi `items`) non lo e' piu'",
  E.wouldEmptyEnv(E.unwrapEnv(typed).items) === false);
assert("e un envelope tipizzato SENZA punti resta vuoto anche dopo unwrapEnv",
  E.wouldEmptyEnv(E.unwrapEnv({ type: "step", points: [] }).items) === true);
/* Il BP group nudo e' l'altra forma che va normalizzata dal CHIAMANTE, e con
   l'altra funzione: desugarBPGroups, non unwrapEnv. */
const group = [BP, "cubic"];
assert("il BP group nudo, passato cosi', risulta vuoto (e' il contratto)",
  E.isBPGroup(group) && E.wouldEmptyEnv(group) === true);
assert("passato da desugarBPGroups non lo e' piu'",
  E.wouldEmptyEnv(E.desugarBPGroups(group)) === false);

console.log("\n── wouldEmptyEnv: i non-array ──");
for (const v of [null, undefined, 0, 1, "", "cubic", true, {}])
  assert("non-array → vuoto: " + JSON.stringify(v), E.wouldEmptyEnv(v) === true);

/* ═══════════════════════════════════════════════════════════════════════════
   listEnvelopes — il catalogo
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── listEnvelopes: superficie e casi degeneri ──");
assert("PGEEnvCatalog espone listEnvelopes", typeof C.listEnvelopes === "function");
assert("senza stream → lista vuota, non un throw", eq(C.listEnvelopes(null, 8), []));
assert("uno stream senza envelope → lista vuota", eq(C.listEnvelopes({ id: "s1" }, 8), []));

const byKey  = (l, k) => l.find(e => e.key === k);
const byPath = (l, p) => l.find(e => eq(e.path, p));

/* ── totalita': il catalogo copre almeno quel che il walk RISCRIVE ────────────
   `_applyEnvFields` (envelope-utils.js) e' il walk che rescale/truncate/slice
   applicano a ogni gesto di resize: se riscrive un campo che il catalogo non
   sa aprire, quell'envelope viene modificato dall'editor e non e' apribile
   ne' disegnabile da nessuna parte. L'elenco dei campi si LEGGE dal sorgente
   del walk — trascriverlo qui sarebbe una seconda copia, muta proprio il
   giorno in cui qualcuno aggiunge un parametro. */
console.log("\n── listEnvelopes: totalita' contro il walk di envelope-utils ──");
const walkPaths = (() => {
  const code = SG.codeOf(LIB("envelope-utils.js"));
  const body = code.slice(code.indexOf("function _applyEnvFields"));
  const end  = body.indexOf("\n  }");
  const src  = body.slice(0, end);
  const out  = [];
  const re = /wf\(\s*(stream(?:\.[A-Za-z_$][\w$]*)*)\s*,\s*"([A-Za-z_$][\w$]*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const prefix = m[1].split(".").slice(1);   // via il `stream` iniziale
    out.push(prefix.concat(m[2]));
  }
  return out;
})();
// Un elenco vuoto costruirebbe zero asserzioni e passerebbe: e' il modo
// silenzioso di sparire che questo repo conosce gia' (envelopeKeys() → []).
assert("l'elenco dei campi si legge davvero dal walk (>= 20 campi)",
  walkPaths.length >= 20, "trovati: " + walkPaths.length);
assert("e include i campi annidati, non solo quelli di primo livello",
  walkPaths.some(p => p.length === 2) && walkPaths.some(p => p.length === 3));

// Uno stream in cui OGNI campo del walk porta un envelope.
const fatStream = (() => {
  const s = { id: "fat", duration: 10 };
  const setPath = (obj, p, v) => {
    let cur = obj;
    for (const k of p.slice(0, -1)) cur = (cur[k] = cur[k] || {});
    cur[p[p.length - 1]] = v;
  };
  for (const p of walkPaths) setPath(s, p, BP);
  // `grain.envelope.curve` e' l'unico campo che il walk raggiunge senza `wf`
  // su uno *Env: sta dentro il dict della finestra, che deve esistere.
  s.grain = s.grain || {};
  s.grain.envelope = { from: "hanning", to: "bartlett", curve: BP };
  return s;
})();
const fatList = C.listEnvelopes(fatStream, 8);
for (const p of walkPaths)
  assert("il catalogo apre " + p.join("."), byPath(fatList, p) !== undefined);
assert("grain.envelope.curve ha la sua voce",
  byPath(fatList, ["grain", "envelope", "curve"]) !== undefined);
assert("ogni voce dichiara chiave, etichetta, gruppo e bound",
  fatList.every(e => typeof e.key === "string" && typeof e.label === "string" &&
                     typeof e.group === "string" && Array.isArray(e.path) &&
                     typeof e.hardMin === "number" && typeof e.hardMax === "number" &&
                     e.hardMin <= e.hardMax));
assert("nessuna chiave duplicata (la chiave sceglie la voce da aprire)",
  new Set(fatList.map(e => e.key)).size === fatList.length);

/* ── e il verso opposto, che e' quello che mancava ───────────────────────────
   Una voce di catalogo che il walk NON riscrive e' l'altra meta' dello stesso
   difetto, e si vede ancora meno: l'envelope si apre, si disegna, si trascina
   — poi un resize con freeze, o un taglio al cursore, sposta ogni altra curva
   e lascia quella dov'era, nel vecchio riferimento temporale. Nessun errore,
   nessun marcatore, e nemmeno la conferma «perdi dei breakpoint», perche'
   quella legge una terza lista ancora (sotto).
   Era il caso di `voices.pan.stepEnv`: il motore lo risolve al tempo del grain
   (StepPanStrategy.get_pan_offset → resolve_param(self.step, time)) esattamente
   come i suoi omonimi di pitch e pointer, che il walk riscriveva entrambi.
   `deviationProbability` e' l'unica esenzione: il walk ci arriva con
   _applyDeviationProb e non con `wf`, quindi il regex sopra non lo vede. Ha il
   suo caso ESEGUITO qui sotto, o sarebbe un buco col nome di una regola. */
const DP_KEY = "deviationProbability";
/* Le due liste devono venire da due FILE diversi, o il confronto si chiude su
   se stesso: `fatStream` e' costruito da `walkPaths`, quindi un campo tolto al
   walk sparisce anche dal catalogo che lo riceve — e i due insiemi si
   rimpiccioliscono insieme, verdi. Il verso opposto legge percio' i `path:`
   dal sorgente del CATALOGO, che del walk non sa niente. */
const catalogPaths = (() => {
  const src = SG.codeOf(LIB("envelope-catalog.js"));
  const out = [];
  const re = /path:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const parts = m[1].split(",").map(t => t.trim()).filter(Boolean);
    // Solo i path di sole stringhe letterali: quello di deviation_probability
    // per-parametro porta la variabile `pk`, ed e' l'esenzione qui sotto.
    if (parts.every(t => /^"[^"]*"$/.test(t)))
      out.push(parts.map(t => t.slice(1, -1)));
  }
  return out.filter(p => p[0] !== DP_KEY);
})();
// Un elenco vuoto costruirebbe zero asserzioni e passerebbe.
assert("i path si leggono davvero dal sorgente del catalogo (>= 20)",
  catalogPaths.length >= 20, "trovati: " + catalogPaths.length);
/* …e quel che si legge e' quel che il catalogo EMETTE: senza questo la lettura
   potrebbe inseguire righe morte e il confronto sotto girerebbe a vuoto. */
assert("i path letti coincidono con quelli emessi su fatStream",
  fatList.map(e => e.path).filter(p => p[0] !== DP_KEY)
    .every(p => catalogPaths.some(c => eq(c, p))));
for (const p of catalogPaths)
  assert("il walk riscrive " + p.join("."), walkPaths.some(w => eq(w, p)));
{
  const dp = { id: "s", deviationProbability: { volume: BP.map(b => b.slice()) } };
  const moved = EU.rescaleStreamEnvelopes(dp, 10, 5);   // ratio = 2
  assert("deviationProbability e' esente dal regex, non dal walk",
    eq(moved.deviationProbability.volume, [[0, 0], [1, 50], [2, 100]]));
}

/* ── la terza lista: l'avviso che parla PRIMA del gesto ──────────────────────
   `streamWouldTruncate` trascrive gli stessi campi una terza volta, ed e' lei
   a decidere se chiedere conferma quando un resize taglia dei breakpoint. Un
   campo che le manca viene troncato in silenzio: il walk lo riscrive, ma
   nessuno lo aveva annunciato. La si interroga per COMPORTAMENTO, campo per
   campo — leggerne l'elenco sarebbe la quarta copia della stessa lista. */
console.log("\n── l'avviso di troncamento copre gli stessi campi ──");
const PAST_END = [[0, 0], [1, 100]];   // a ratio 2 il punto a x=1 esce dalla finestra
for (const p of walkPaths) {
  const s = {};
  let cur = s;
  for (const k of p.slice(0, -1)) cur = (cur[k] = cur[k] || {});
  cur[p[p.length - 1]] = PAST_END.map(b => b.slice());
  assert("streamWouldTruncate vede " + p.join("."), EU.streamWouldTruncate(s, 2) === true);
}

/* ── loop_unit: DUE provenienze, non tre ─────────────────────────────────────
   La #140 ne chiedeva tre perche' all'epoca `loop_unit` ereditava da
   `time_mode`. PGE #222 ha tagliato quel fallback (PGE-ui #149): le
   provenienze sono `loop_unit` e `default`, e il default e' una costante
   (`seconds`), non una proprieta' dello stream. Il catalogo e' uno dei posti
   dove quella differenza si vede sull'asse, quindi il caso che vale la pena
   fissare e' proprio quello che non esiste piu': `time_mode: normalized` senza
   `loop_unit` deve leggere SECONDI. */
console.log("\n── listEnvelopes: la risoluzione di loop_unit ──");
const loopStream = (loopUnit, extra) => ({
  id: "s", ...(extra || {}),
  pointer: { loopStartEnv: BP, loopEndEnv: BP, loopDurEnv: BP,
             ...(loopUnit === undefined ? {} : { loopUnit }) },
});
const loopRows = (stream, dur) => {
  const l = C.listEnvelopes(stream, dur);
  return ["loopStart", "loopEnd", "loopDur"].map(k => byKey(l, k));
};

const norm = loopRows(loopStream("normalized"), 8);
assert("normalized: nessun suffisso (le coordinate non sono secondi)",
  norm.every(r => r.unit === ""));
assert("normalized: il cap e' 1, non la durata del sample",
  norm.every(r => r.hardMax === 1 && r.visMax === 1));

for (const spelling of EU.LOOP_UNITS.filter(u => u !== "normalized")) {
  const rows = loopRows(loopStream(spelling), 8);
  assert("`" + spelling + "`: suffisso in secondi", rows.every(r => r.unit === "s"));
  assert("`" + spelling + "`: il cap e' la durata del sample",
    rows.every(r => r.hardMax === 8 && r.visMax === 8));
}

const dflt = loopRows(loopStream(undefined), 8);
assert("chiave assente → il default del motore, che e' `" + EU.LOOP_UNIT_DEFAULT + "`",
  eq(dflt.map(r => [r.unit, r.hardMax]), loopRows(loopStream(EU.LOOP_UNIT_DEFAULT), 8)
    .map(r => [r.unit, r.hardMax])));
/* PGE #222 / PGE-ui #149: l'eredita' da time_mode non c'e' piu'. Su questi
   stream il motore legge secondi, e un catalogo che tappasse l'asse a 1
   riscriverebbe al primo drag ogni punto oltre il secondo. */
assert("time_mode: normalized SENZA loop_unit → secondi (l'eredita' e' tagliata)",
  loopRows(loopStream(undefined, { timeMode: "normalized" }), 8)
    .every(r => r.unit === "s" && r.hardMax === 8));
assert("…e con loop_unit: normalized scritto, normalized (le due chiavi coesistono)",
  loopRows(loopStream("normalized", { timeMode: "absolute" }), 8)
    .every(r => r.unit === "" && r.hardMax === 1));

/* Fuori vocabolario il motore alza InvalidFieldValueError e non guarda la
   finestra: il suffisso tace (loopUnitSuffix), perche' un "s" accanto alla
   riga rossa che dichiara l'unita' irriconoscibile sono due affermazioni
   opposte. Il cap resta quello della lettura di ripiego (assoluto). */
const bad = loopRows(loopStream("normalised"), 8);
assert("grafia fuori vocabolario → nessun suffisso (il suffisso tace)",
  EU.loopUnitError({ loopUnit: "normalised" }) && bad.every(r => r.unit === ""));

/* Durata sconosciuta: loopEnvMax torna null e il catalogo ricade sul cap
   statico di PGE_BOUNDS — mai su `undefined`, che renderebbe l'asse NaN. */
const unk = loopRows(loopStream("seconds"), undefined);
assert("durata sconosciuta → il cap statico, non undefined",
  unk.every(r => typeof r.hardMax === "number" && r.visMax === 10) &&
  byKey(C.listEnvelopes(loopStream("seconds"), undefined), "loopStart").hardMax === PB.loopStart.max);
assert("le tre righe del loop restano a grana fine in ogni unita'",
  norm.every(r => r.fine === true) && unk.every(r => r.fine === true));

/* ── grain.duration_unit ─────────────────────────────────────────────────────
   I bound del motore sono in SECONDI e i valori dell'envelope no: presi come
   sono, una curva in millisecondi resta tappata a 10 — dieci millisecondi
   invece di dieci secondi — e clampY riscrive il primo punto trascinato. */
console.log("\n── listEnvelopes: grain.duration_unit ──");
const grainRows = (unit) => {
  const s = { id: "s", grain: { durationEnv: BP, durationRangeEnv: BP,
                                ...(unit === undefined ? {} : { durationUnit: unit }) } };
  const l = C.listEnvelopes(s, 8);
  return [byKey(l, "grainDur"), byKey(l, "durationRange")];
};
for (const u of EU.GRAIN_DURATION_UNITS) {
  const rows = grainRows(u);
  const expDur = EU.grainUnitBounds(PB.grainDur, u);
  assert("`" + u + "`: i bound della durata sono quelli convertiti dal modulo",
    rows[0].hardMin === expDur.min && rows[0].hardMax === expDur.max);
  assert("`" + u + "`: il suffisso e' quello del modulo",
    rows[0].unit === EU.grainUnitSuffix(u) && rows[1].unit === EU.grainUnitSuffix(u));
}
assert("in millisecondi il cap e' 10000, non 10 (e' la conversione, non una vista)",
  grainRows("milliseconds")[0].hardMax === PB.grainDur.max * 1000);
assert("chiave assente = secondi", eq(grainRows(undefined).map(r => [r.unit, r.hardMax]),
                                      grainRows("seconds").map(r => [r.unit, r.hardMax])));
/* Unita' sconosciuta: il modulo non converte e non mette suffisso. Il
   catalogo non deve inventare una conversione per conto suo. */
assert("unita' sconosciuta → nessuna conversione e nessun suffisso",
  grainRows("furlongs")[0].unit === "" &&
  grainRows("furlongs")[0].hardMax === PB.grainDur.max);
/* La finestra VISIBILE segue l'unita' come i bound: in millisecondi una
   finestra 0.001–0.1 si aprirebbe schiacciata contro lo zero. */
assert("anche la finestra visibile e' nell'unita' in vigore",
  grainRows("milliseconds")[0].visMax === 100 && grainRows("seconds")[0].visMax === 0.1);

/* ── pitchEnvBounds: l'unita' scala l'asse, non solo l'etichetta ─────────────
   Le due voci di `voices.pitch` partono da una base in semitoni e la portano
   nell'unita' dichiarata: presa com'e', una curva in cents si aprirebbe su un
   asse ±12 — cioe' un dodicesimo di semitono — e clampY riscriverebbe ogni
   punto al primo drag, esattamente come la durata del grano in millisecondi. */
console.log("\n── listEnvelopes: le voci di voices.pitch seguono l'unita' ──");
const vpStream = (unit) => ({ id: "s",
  voices: { pitch: { ...(unit ? { unit } : {}), stepEnv: BP, pitch_rangeEnv: BP } } });
const vpRows = (unit) => {
  const l = C.listEnvelopes(vpStream(unit), 8);
  return [byKey(l, "voicesPitchStep"), byKey(l, "voicesPitchRange")];
};
assert("in semitoni `step` e' simmetrico attorno a zero, `pitch_range` no",
  vpRows("semitones")[0].visMin === -12 && vpRows("semitones")[0].visMax === 12 &&
  vpRows("semitones")[1].visMin === 0);
assert("in cents la finestra e' quella scalata, non ±12",
  vpRows("cents")[0].visMax === E.semitonesToPitch(12, "cents"));
assert("l'unita' del suffisso e' quella del modulo",
  vpRows("cents")[0].unit === E.pitchUnitSymbol("cents") &&
  vpRows(undefined)[0].unit === E.pitchUnitSymbol("semitones"));
assert("un'unita' a valori interi lo dichiara (il campo non accetta decimali)",
  vpRows("edo")[0].integer === E.pitchUnitIsInteger("edo"));
/* pitchEnvBounds e' esportato perche' e' proprio questa scalatura: qui la si
   interroga da sola, cosi' un suo errore ha un nome invece di arrivare
   travestito da voce di catalogo storta. */
assert("pitchEnvBounds: `signed` da' l'intervallo simmetrico, l'altro parte da 0",
  eq(C.pitchEnvBounds("semitones", { vis: 12, hard: 96 }, true),
     { visMin: -12, visMax: 12, hardMin: -96, hardMax: 96 }) &&
  eq(C.pitchEnvBounds("semitones", { vis: 12, hard: 96 }, false),
     { visMin: 0, visMax: 12, hardMin: 0, hardMax: 96 }));

/* ── read_direction: dominio discreto ──────────────────────────────────────── */
console.log("\n── listEnvelopes: il dominio discreto di read_direction ──");
const rd = byKey(C.listEnvelopes({ id: "s", grain: { readDirectionEnv: [[0, -1], [1, 1]] } }, 8),
                 "readDirection");
assert("la voce dichiara domain: 'direction' (e' cio' che fa snappare, non clampare)",
  rd.domain === "direction" && rd.integer === true);
assert("i bound restano [-1, 1] — servono al disegno",
  rd.hardMin === PB.readDirection.min && rd.hardMax === PB.readDirection.max);

/* ── deviation_probability: globale, per-parametro, e le chiavi inerti ───────
   Questa meta' stava in test-deviation-probability.js, costruita estraendo
   `listEnvelopes` dal JSX con un `catch` che ricadeva su `() => []`: su
   un'estrazione rotta le asserzioni «non porta il marcatore» restavano verdi,
   perche' su una lista vuota `{}.inert` e' undefined. Ora il catalogo e' un
   modulo e lo si chiama. */
console.log("\n── listEnvelopes: deviation_probability ──");
const DPENV = [[0, 0], [1, 100]];
assert("un deviation_probability globale ha UNA voce",
  eq(C.listEnvelopes({ id: "s", deviationProbability: DPENV }, 8).map(e => e.key),
     ["deviation_probability"]));
assert("anche nella forma tipizzata {type, points} (il ramo che si chiudeva da solo)",
  eq(C.listEnvelopes({ id: "s", deviationProbability: { type: "cubic", points: DPENV } }, 8)
       .map(e => e.key), ["deviation_probability"]));
assert("uno scalare non apre nessun envelope",
  eq(C.listEnvelopes({ id: "s", deviationProbability: 50 }, 8), []));

const dpCat = (grain, d) => C.listEnvelopes({ id: "s", grain, deviationProbability: d }, 8)
  .filter(e => /^deviation_probability_/.test(e.key));
const dpEntry = (list, pk) => list.find(e => e.key === "deviation_probability_" + pk) || {};

const TRANSITION = { envelope: { from: "hanning", to: "bartlett" } };
const MULTISTATE = { envelope: { states: [[0, "hanning"], [1, "bartlett"]] } };

const catLive = dpCat({ envelope: "hanning" },
  { volume: DPENV, envelope: DPENV, pc_rand_envelope: DPENV });
/* Il catalogo elenca ALL_PARAM_KEYS, non PARAM_KEYS: sbagliare per difetto
   lascia un envelope scritto senza voce, cioe' non apribile e non
   disegnabile, e il click sull'env mini dell'Inspector apre un altro
   envelope invece di dirlo. */
assert("la lista non e' vuota (premessa delle asserzioni sul marcatore)",
  catLive.length === 3);
assert("elenca anche le chiavi inerti — sono scritte, vanno aperte e tolte",
  dpEntry(catLive, "envelope").key === "deviation_probability_envelope");
assert("una chiave viva non porta il marcatore",
  dpEntry(catLive, "volume").inert === undefined);
assert("la chiave morta `envelope` lo porta sempre",
  typeof dpEntry(catLive, "envelope").inert === "string");
assert("pc_rand_envelope viva non lo porta",
  dpEntry(catLive, "pc_rand_envelope").inert === undefined);

for (const [name, grain] of [["transition", TRANSITION], ["multistate", MULTISTATE]]) {
  const l = dpCat(grain, { volume: DPENV, pc_rand_envelope: DPENV });
  assert("pc_rand_envelope con grain.envelope " + name + " → marcata, e nomina la causa",
    /grain\.envelope/.test(dpEntry(l, "pc_rand_envelope").inert || ""));
}
/* Il perdente del gruppo esclusivo direzione: il motore legge quella scritta
   in `grain` e scarta l'altra. */
const catDir = dpCat({ envelope: "hanning", readDirection: -1 },
  { reverse: DPENV, read_direction: DPENV });
assert("il perdente del gruppo esclusivo direzione e' marcato",
  typeof dpEntry(catDir, "reverse").inert === "string" &&
  dpEntry(catDir, "read_direction").inert === undefined);
/* Il motivo e' quello dell'Inspector, non una seconda copia della prosa. */
assert("il motivo viene da PGEDeviationProb.inertReason, la stessa dell'Inspector",
  dpEntry(catLive, "envelope").inert ===
    D.inertReason("envelope", D.liveParamKeys({ grain: { envelope: "hanning" } })));

/* ═══════════════════════════════════════════════════════════════════════════
   Il componente tiene la colla, e nient'altro
   ═══════════════════════════════════════════════════════════════════════════ */
console.log("\n── EnvelopeEditor.jsx delega, non ricopia ──");
const eeSrc = SG.codeOf(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"));
const htmlSrc = SG.codeOf(path.join(__dirname, "../../PGE Editor.html"));

assert("nessuna copia locale di wouldEmptyEnv nel componente",
  !/function\s+wouldEmptyEnv\s*\(/.test(eeSrc));
assert("nessuna copia locale di listEnvelopes nel componente",
  !/function\s+listEnvelopes\s*\(/.test(eeSrc));
assert("le prende dai moduli",
  /window\.PGEEnv\.wouldEmptyEnv/.test(eeSrc) &&
  /window\.PGEEnvCatalog\.listEnvelopes/.test(eeSrc));
/* La ragione dell'inerzia non sta piu' in un componente: il catalogo e' una
   lib e leggerla da window.PGE sarebbe una lib che dipende da un componente. */
assert("il catalogo NON legge la ragione dell'inerzia da un componente",
  !/window\.PGE\.deviationProbInertReason/.test(SG.codeOf(LIB("envelope-catalog.js"))));
assert("envelope-catalog.js e' caricato dall'HTML prima dei componenti",
  htmlSrc.indexOf("src/lib/envelope-catalog.js") !== -1 &&
  htmlSrc.indexOf("src/lib/envelope-catalog.js") <
    htmlSrc.indexOf("src/components/EnvelopeEditor.jsx"));
assert("…e dopo i quattro moduli che legge",
  ["yaml-bridge.js", "envelope-loops.js", "deviation-probability.js", "envelope-utils.js"]
    .every(f => htmlSrc.indexOf("src/lib/" + f) < htmlSrc.indexOf("src/lib/envelope-catalog.js")));

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
