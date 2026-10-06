/* =============================================================================
 * test-bp-groups.js — BP group [points, interp] per-macrozona (PGE #64 /
 * PR #165, PGE-ui issue #108).
 *
 * Copre la superficie di envelope-loops.js (window.PGEEnv): riconoscimento
 * (isBPGroup / envHasGroup), desugar/resugar (forma piatta 3-tuple usata
 * dall'editor ↔ forma YAML a gruppi), propagazione dell'interp per-zona in
 * expandMixed (segmenti interni vs gap in uscita, override per-punto,
 * DISCONTINUITY_OFFSET al bordo zona), formattazione inline e conversione
 * pitch; più i branch gruppo di envelope-utils.js (rescale/truncate).
 *
 * Run: node test-bp-groups.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = { jsyaml: require("js-yaml") };
// yaml-bridge per primo come nell'editor: pubblica window.PGE_OUTPUT_SR, che
// envelope-utils legge a chiamata per il fattore di 'samples'. Senza, quel
// ramo restituisce NaN invece di fallire — una trappola armata, non un errore.
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-loops.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/deviation-probability.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/envelope-utils.js"), "utf8"));

const E = window.PGEEnv;
const U = window.PGEEnvUtils;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// L'esempio della issue #108 (tempi normalizzati [0,1] come nell'editor)
const ZONE_A = [[[0.0, 0], [0.2, 12], [0.4, 8]], "cubic"];
const LOOP   = [[[0, 8], [50, 18], [100, 8]], 0.7, 4, "linear"];
const ZONE_B = [[[0.75, 6], [0.9, 6], [1.0, 0]], "step"];
const MIXED  = [ZONE_A, LOOP, ZONE_B];

console.log("\n── isBPGroup / envHasGroup ──");
assert("group [points, interp] riconosciuto", E.isBPGroup(ZONE_A));
assert("breakpoint [t, v] non è un gruppo", !E.isBPGroup([0, 1]));
assert("3-tuple per-punto non è un gruppo", !E.isBPGroup([0, 1, "cubic"]));
assert("loop block non è un gruppo", !E.isBPGroup(LOOP));
assert("dict tipato non è un gruppo", !E.isBPGroup({ type: "cubic", points: [[0, 0]] }));
assert("envHasGroup su lista mista", E.envHasGroup(MIXED));
assert("envHasGroup sulla forma diretta [points, interp]", E.envHasGroup(ZONE_A));
assert("envHasGroup falso su BP nudi", !E.envHasGroup([[0, 0], [1, 1]]));
assert("envHasLoop non scatta sui gruppi", !E.envHasLoop([ZONE_A]));

console.log("\n── desugarBPGroups ──");
assert("interp di zona → type esplicito dei punti interni, ultimo punto nudo",
  eq(E.desugarBPGroups([ZONE_A]),
     [[0, 0, "cubic"], [0.2, 12, "cubic"], [0.4, 8]]));
assert("override per-punto dentro la zona preservato",
  eq(E.desugarBPGroups([[[[0, 0], [0.5, 1, "step"], [1, 2]], "cubic"]]),
     [[0, 0, "cubic"], [0.5, 1, "step"], [1, 2]]));
assert("type esplicito sull'ultimo punto (gap in uscita) preservato",
  eq(E.desugarBPGroups([[[[0, 0], [1, 2, "step"]], "cubic"]]),
     [[0, 0, "cubic"], [1, 2, "step"]]));
assert("forma diretta [points, interp] normalizzata",
  eq(E.desugarBPGroups(ZONE_A),
     [[0, 0, "cubic"], [0.2, 12, "cubic"], [0.4, 8]]));
assert("loop block e BP nudi passano invariati",
  eq(E.desugarBPGroups([[0, 0], LOOP]), [[0, 0], LOOP]));

console.log("\n── resugarBPGroups ──");
assert("run uniforme ≠ default → gruppo (round-trip con desugar)",
  eq(E.resugarBPGroups(E.desugarBPGroups(MIXED), "linear"), MIXED));
assert("run di 2 punti cubic → gruppo",
  eq(E.resugarBPGroups([[0, 0, "cubic"], [1, 1]], "linear"),
     [[[[0, 0], [1, 1]], "cubic"]]));
assert("run misto resta piatto con i tag",
  eq(E.resugarBPGroups([[0, 0, "cubic"], [0.5, 1, "step"], [1, 2]], "linear"),
     [[0, 0, "cubic"], [0.5, 1, "step"], [1, 2]]));
assert("tag ridondanti (== default globale) normalizzati via",
  eq(E.resugarBPGroups([[0, 0, "linear"], [1, 1]], "linear"),
     [[0, 0], [1, 1]]));
assert("default globale non-linear: run cubic con global cubic resta piatto",
  eq(E.resugarBPGroups([[0, 0, "cubic"], [1, 1]], "cubic"),
     [[0, 0], [1, 1]]));
assert("desugar∘resugar idempotente sugli indici piatti",
  eq(E.desugarBPGroups(E.resugarBPGroups(E.desugarBPGroups(MIXED), "linear")),
     E.desugarBPGroups(MIXED)));

console.log("\n── expandMixed: propagazione interp per-zona ──");
{
  const exp = E.expandMixed(MIXED);
  const tags = exp.points.map((p) => p[2]);
  const zoneA = exp.points.slice(0, 3);
  assert("zona A: segmenti interni cubic, gap in uscita linear (default globale)",
    zoneA[0][2] === "cubic" && zoneA[1][2] === "cubic" && zoneA[2][2] === "linear",
    JSON.stringify(zoneA));
  const zoneB = exp.points.slice(-3);
  assert("zona B: segmenti interni step, ultimo punto linear",
    zoneB[0][2] === "step" && zoneB[1][2] === "step" && zoneB[2][2] === "linear",
    JSON.stringify(zoneB));
  assert("loop block espanso tra le due zone (1 blocco, 4 cicli)",
    exp.blocks.length === 1 && exp.cycles.length === 4);
  assert("il gruppo non fa leak sul default globale",
    tags.filter((t) => t === "cubic").length === 2);
}
{
  const exp = E.expandMixed([[[[0, 0], [0.5, 1, "step"], [1, 2]], "cubic"]]);
  assert("override per-punto dentro la zona vince sull'interp di gruppo",
    exp.points[1][2] === "step" && exp.points[0][2] === "cubic");
}
{
  const exp = E.expandMixed(ZONE_A);
  assert("forma diretta [points, interp] espansa come gruppo singolo",
    exp.points.length === 3 && exp.points[0][2] === "cubic");
}
{
  // collisione al bordo zona: t <= ultimo punto precedente → offset
  const exp = E.expandMixed([[0, 0], [0.5, 5], [[[0.5, 1], [1, 2]], "cubic"]]);
  assert("DISCONTINUITY_OFFSET applicato al primo punto del gruppo in collisione",
    exp.points[2][0] === 0.5 + E.DISCONTINUITY_OFFSET, JSON.stringify(exp.points));
  const exp2 = E.expandMixed([[0, 0], [[[0.75, 1], [1, 2]], "cubic"]]);
  assert("nessuno shift senza collisione (tempi assoluti)",
    exp2.points[1][0] === 0.75);
}
{
  const exp = E.expandMixed({ type: "cubic", points: [[0, 0], [1, 1]] });
  assert("forma dict tipata invariata (global interp sui punti)",
    exp.points.every((p) => p[2] === "cubic"));
}

console.log("\n── wrapEnv / normalizeEnv / fmtEnvInline ──");
/* Fino a #189 qui c'era l'opposto — «wrapEnv non incarta in dict un env con
   gruppi» — ed era il difetto fissato come contratto: la lista piatta perde il
   `type` globale, e i punti senza tipo suo tornano lineari. */
assert("wrapEnv tiene il dict anche con un gruppo dentro: il type globale resta",
  eq(E.wrapEnv([ZONE_A], "cubic"), { type: "cubic", points: [ZONE_A] }),
  JSON.stringify(E.wrapEnv([ZONE_A], "cubic")));
assert("normalizeEnv: bare group → [group]",
  eq(E.normalizeEnv(ZONE_A), [ZONE_A]));
assert("normalizeEnv: lista mista invariata",
  eq(E.normalizeEnv(MIXED), MIXED));
assert("fmtEnvInline: gruppo in lista mista",
  E.fmtEnvInline([ZONE_A, [0.6, 3]]) ===
    "[[[[0, 0], [0.2, 12], [0.4, 8]], 'cubic'], [0.6, 3]]",
  E.fmtEnvInline([ZONE_A, [0.6, 3]]));
assert("fmtEnvInline: gruppo singolo emesso in forma bare",
  E.fmtEnvInline([ZONE_A]) === "[[[0, 0], [0.2, 12], [0.4, 8]], 'cubic']",
  E.fmtEnvInline([ZONE_A]));
assert("parseEnvLiteral ∘ fmtEnvInline round-trip",
  eq(E.normalizeEnv(E.parseEnvLiteral(E.fmtEnvInline([ZONE_A]))), [ZONE_A]));

console.log("\n── conversione pitch sui gruppi ──");
assert("convertPitchEnv rimappa le y dentro il gruppo (st → cents)",
  eq(E.convertPitchEnv([[[[0, 1], [1, 2]], "cubic"]], "semitones", "cents"),
     [[[[0, 100], [1, 200]], "cubic"]]));

console.log("\n── envelope-utils: rescale / truncate / wouldTruncate ──");
assert("rescaleEnvArray scala i tempi dentro il gruppo",
  eq(U.rescaleEnvArray([ZONE_A], 0.5),
     [[[[0, 0], [0.1, 12], [0.2, 8]], "cubic"]]));
assert("truncateEnvArray interpola il punto di chiusura dentro il gruppo",
  eq(U.truncateEnvArray([[[[0, 0], [0.8, 1], [1.5, 2]], "cubic"]]),
     [[[[0, 0], [0.8, 1], [1, 1.2857]], "cubic"]]));
assert("truncateEnvArray: gruppo troncato a 2 punti resta gruppo",
  eq(U.truncateEnvArray([[0, 0], [[[0.5, 1], [1.5, 2]], "cubic"]]),
     [[0, 0], [[[0.5, 1], [1, 1.5]], "cubic"]]),
  JSON.stringify(U.truncateEnvArray([[0, 0], [[[0.5, 1], [1.5, 2]], "cubic"]])));
assert("truncateEnvArray: gruppo degenerato a 1 punto → breakpoint nudo",
  eq(U.truncateEnvArray([[0, 0], [[[1.2, 1], [1.5, 2]], "cubic"]]),
     [[0, 0], [1, 1]]),
  JSON.stringify(U.truncateEnvArray([[0, 0], [[[1.2, 1], [1.5, 2]], "cubic"]])));
assert("envArrayWouldTruncate vede i punti del gruppo",
  U.envArrayWouldTruncate([ZONE_A], 3) === true &&
  U.envArrayWouldTruncate([ZONE_A], 1) === false);

/* ============================================================================
 * firstBreakpointY — la y del primo breakpoint, qualunque grafia abbia
 *
 * E' la domanda di ogni toggle env→scalare: la curva sparisce, e il numero che
 * la sostituisce dev'essere quello che la curva diceva. `env[0][1]` non sa
 * rispondere, e sbaglia in tre modi diversi — uno per grafia — tutti e tre
 * silenziosi. Sta nel modulo perche' i chiamanti sono tredici (dodici rami di
 * toggleMode piu' il Seg del loop): scritta dentro uno, gli altri dodici
 * tengono la versione rotta, ed e' esattamente com'e' andata.
 * ========================================================================== */
console.log("\n── firstBreakpointY: la y del primo punto, in ogni grafia ──");
{
  const FB = (env, fb) => E.firstBreakpointY(env, fb);
  assert("lista piatta: la y del primo breakpoint",
    FB([[0, 6], [1, 2]], "FB") === 6);
  assert("3-tuple con interp per-punto: sempre la y",
    FB([[0, 6, "step"], [1, 2]], "FB") === 6);
  /* La grafia che l'editor SCRIVE da se': wrapEnv produce {type, points}
     appena l'interp globale di una curva di soli BP non e' lineare. Li'
     `env[0]` non esiste, quindi il vecchio lettore ripiegava sul default —
     la costante al posto della curva, sul caso raggiungibile senza scrivere
     una riga di YAML a mano. */
  assert("envelope tipato {type, points}: si unwrappa prima di leggere",
    FB({ type: "cubic", points: [[0, 6], [1, 2]] }, "FB") === 6);
  assert("dict con i soli points, che il motore accetta",
    FB({ points: [[0, 6], [1, 2]] }, "FB") === 6);
  /* Un BP group come primo item e' `[points, interp]`: `[1]` e' la STRINGA
     dell'interp, e `|| default` la lascia passare — cioe' `pan: "cubic"`
     scritto nello YAML come valore del parametro. */
  assert("BP group: si desugara, non si legge il nome dell'interp",
    FB([[[[0, 3], [1, 4]], "cubic"]], "FB") === 3);
  assert("BP group in forma diretta (non annidato in una lista)",
    FB([[[0, 3], [1, 4]], "cubic"], "FB") === 3);
  /* E il blocco compatto e' la grafia che una y non ce l'ha davvero: in `[1]`
     c'e' l'END_TIME del blocco, un numero che con il valore del
     parametro non c'entra niente. Qui il ripiego e' la risposta giusta. */
  assert("blocco compatto come primo item: ripiega, non scrive l'end_time",
    FB([[[[0, 0.1], [0.5, 0.2]], 2, 4]], "FB") === "FB");
  assert("blocco compatto in forma di dict: ripiega",
    FB({ type: "geometric", ratio: 2, n_reps: 4 }, "FB") === "FB");
  /* Il breakpoint in forma dict `{t, v}`: il builder del motore lo normalizza
     in `[t, v]` (envelope_builder.py:132) e wouldEmptyEnv lo conta gia' come
     punto vero, quindi una y ce l'ha ed e' `v`. */
  assert("breakpoint {t, v}: la y e' `v`",
    FB([{ t: 0, v: 6 }, { t: 1, v: 2 }], "FB") === 6);
  assert("…con l'interp per-punto, uguale",
    FB([{ t: 0, v: 6, type: "step" }], "FB") === 6);
  assert("dict senza una y numerica: non e' un punto, ripiega",
    FB([{ t: 0 }], "FB") === "FB");
  /* Il ritorno e' il valore LETTO, zero compreso. Con `|| default` uno zero
     legittimo — un loop_end a inizio file, una probabilita' «mai», un pan al
     centro — diventava una costante che la curva non aveva mai avuto. */
  assert("uno zero letto e' uno zero, non il ripiego",
    FB([[0, 0], [1, 1]], "FB") === 0 && FB([{ t: 0, v: 0 }], "FB") === 0);
  assert("y negativa: nessun trattamento speciale",
    FB([[0, -3], [1, 1]], "FB") === -3);
  /* Le forme che una y non ce l'hanno per niente: il ripiego e' del chiamante,
     perche' e' il default del SUO parametro — 1 per speed_ratio, 0 per pan,
     loopSeedWhole per il loop. Il modulo non ne conosce nessuno. */
  assert("envelope assente o vuoto: ripiega",
    FB(null, "FB") === "FB" && FB(undefined, "FB") === "FB" && FB([], "FB") === "FB");
  assert("uno scalare passato per sbaglio: ripiega, non si auto-legge",
    FB(5, "FB") === "FB");
  assert("ripiego non passato: undefined, cosi' il chiamante lo riconosce",
    FB([], undefined) === undefined && FB([[0, 0]], undefined) === 0);
}

/* ── le due grafie NUDE arrivano all'editor allo stesso modo ─────────────────
   `[points, interp]` e `[pattern, end_time, n_reps]` sono envelope INTERI, non
   item dentro una lista, e il motore li legge come tali (envelope_builder:
   is_bp_group / is_compact_format sul raw_points, prima di iterare). Il
   gruppo lo incartava gia' `desugarBPGroups`; il blocco no, e si vedeva in un
   posto solo — quello che conta. L'EnvelopeEditor costruisce `rawEnv` e
   `expandMixed` su `desugarBPGroups(unwrapEnv(v).items)`, e di un blocco nudo
   `unwrapEnv` rende i suoi TRE elementi: li' nessuno e' un punto ne' un
   blocco, quindi canvas VUOTO su un envelope pieno (26 stream nel corpus del
   motore, `PGE_envelope_syntax_test.yml` in testa). E il doppio click che
   segue — l'unico gesto disponibile su una tela vuota — ci appendeva un
   breakpoint: `[pattern, end, n_reps, [x, y]]`, che per il motore non e' piu'
   compatto (item[3] non e' una stringa) e da cui sopravvive il solo
   breakpoint. Il blocco sparito, senza un errore.
   La regola si interroga per CONFRONTO: la grafia nuda deve arrivare
   all'editor come la stessa identica grafia dentro una lista. */
console.log("\n── le grafie nude entrano nell'editor come quelle annidate ──");
{
  const BARE_BLOCK = [[[0, 5], [50, 30]], 0.8, 2];
  const BARE_GROUP = ZONE_A;
  // L'espressione dell'editor, non una sua parafrasi (EnvelopeEditor.jsx:588).
  const items = (v) => E.desugarBPGroups(E.unwrapEnv(v).items);

  assert("isBareEnv riconosce le due grafie nude e nient'altro",
    E.isBareEnv(BARE_BLOCK) && E.isBareEnv(BARE_GROUP) &&
    !E.isBareEnv([[0, 0], [1, 1]]) && !E.isBareEnv([BARE_BLOCK]) &&
    !E.isBareEnv({ type: "cubic", points: [[0, 0], [1, 1]] }));

  assert("il blocco nudo entra come quello dentro una lista",
    eq(items(BARE_BLOCK), items([BARE_BLOCK])),
    JSON.stringify(items(BARE_BLOCK)));
  assert("…e resta UN item, il blocco, non i suoi tre elementi",
    items(BARE_BLOCK).length === 1 && E.isCompactBlock(items(BARE_BLOCK)[0]));
  assert("il gruppo nudo entra come quello dentro una lista (regola gia' in vigore)",
    eq(items(BARE_GROUP), items([BARE_GROUP])));

  /* L'invariante su cui l'editor poggia: `blocks[].originalIdx` indicizza la
     lista desugarata. Con il blocco nudo la lista non conteneva blocchi, quindi
     expandMixed non ne trovava nessuno — il canvas vuoto. */
  const exp = E.expandMixed(items(BARE_BLOCK));
  assert("expandMixed disegna i punti del blocco nudo",
    exp.points.length === 4 && eq(exp.points.map(p => p[1]), [5, 30, 5, 30]),
    JSON.stringify(exp.points));
  assert("…e ogni originalIdx indicizza davvero un blocco della lista",
    exp.blocks.length === 1 &&
    exp.blocks.every(b => E.isCompactBlock(items(BARE_BLOCK)[b.originalIdx])));
  assert("il disegno e' lo stesso di quello annidato",
    eq(E.expandMixed(items(BARE_BLOCK)), E.expandMixed(items([BARE_BLOCK]))));

  /* Il gesto che distruggeva il blocco: su una tela vuota il doppio click
     appende un breakpoint alla lista. Sulla lista giusta il blocco resta. */
  const afterDblClick = [...items(BARE_BLOCK), [0.9, 42]];
  const committed = E.wrapEnv(E.resugarBPGroups(afterDblClick, "linear"), "linear");
  assert("aggiungere un breakpoint non fa sparire il blocco",
    E.envHasLoop(committed) && committed.length === 2,
    JSON.stringify(committed));
  assert("e quel che si committa e' leggibile come prima: un blocco piu' un bp",
    E.isCompactBlock(committed[0]) && E.isBreakpoint(committed[1]));

  /* Una regola sola: il walk sui tempi di envelope-utils incarta le stesse due
     grafie, e lo chiede a questa funzione invece di tenerne una copia. */
  const SG = require("./source-guard.js");
  const euSrc = SG.codeOf(path.join(__dirname, "../../src/lib/envelope-utils.js"));
  assert("il walk sui tempi usa la stessa regola, non una copia",
    /PGEEnv\.isBareEnv\(/.test(euSrc) &&
    !/isBPGroup\(arr\)\s*\|\|\s*PGEEnv\.isCompactBlock\(arr\)/.test(euSrc));
  assert("…e sul blocco nudo continua a muoversi come prima del riuso",
    U.rescaleEnvArray(BARE_BLOCK, 2)[1] === 1.6 &&
    E.isCompactBlock(U.rescaleEnvArray(BARE_BLOCK, 2)));
}

/* ── {type, points}: il type globale sopravvive al commit (#189) ────────────
   Per il motore il `type` di un dict e' il tipo di ogni segmento che non ne
   dichiara uno sul punto (`Envelope._parse_segments`: `seg_types[i] if
   seg_types[i] is not None else self.type`); in una lista piatta quel punto e'
   `linear`. `wrapEnv` scriveva la lista appena c'era un 3-tuple o un BP group,
   quindi il primo commit raddrizzava in silenzio ogni segmento che seguiva il
   tipo globale — e dopo il commit anche il disegno, perche' `unwrapEnv` della
   lista rende `interp: linear`. Che la semantica sia la stessa per il motore,
   valore per valore, lo chiede tests/parity/test-envelope-wrap-parity.js; qui
   si fissa la forma. */
console.log("\n── wrapEnv: il type globale di un {type, points} resta (#189) ──");
{
  const rewrap = (x) => { const w = E.unwrapEnv(x); return E.wrapEnv(w.items, w.interp); };
  // Il percorso di ogni commit dell'EnvelopeEditor (commit, commitCur, frecce,
  // paste): desugar per lavorare, resugar + wrap per scrivere.
  const commitPath = (items, interp) =>
    E.wrapEnv(E.resugarBPGroups(items, interp || "linear"), interp);
  const roundTrip = (x) => {
    const w = E.unwrapEnv(x);
    return commitPath(E.desugarBPGroups(w.items), w.interp);
  };

  // la forma mista: tipo globale ed eccezioni sul punto (la riproduzione della issue)
  const MISTA = { type: "cubic", points: [[0, 2], [0.2586, 0.4, "linear"], [1, 1]] };
  assert("forma mista: wrapEnv ∘ unwrapEnv la rende identica",
    eq(rewrap(MISTA), MISTA), JSON.stringify(rewrap(MISTA)));
  assert("forma mista: il round-trip dell'editor senza modifiche la rende identica",
    eq(roundTrip(MISTA), MISTA), JSON.stringify(roundTrip(MISTA)));

  const CON_GRUPPO = { type: "cubic", points: [[0, 2], [[[0.1, 1], [0.2, 3], [0.3, 0]], "step"], [1, 1]] };
  assert("BP group dentro il dict: wrapEnv ∘ unwrapEnv lo rende identico",
    eq(rewrap(CON_GRUPPO), CON_GRUPPO), JSON.stringify(rewrap(CON_GRUPPO)));
  /* Il gruppo fra due breakpoint nudi non si ricompatta: resugarBPGroups
     rifa un gruppo solo da un run INTERO di segmenti uniformi, e qui il run e'
     tutto l'envelope. Esce come i suoi 3-tuple — la stessa cosa che fa sulla
     lista piatta da sempre, e la stessa espansione che fa il builder
     (`_expand_bp_group`). La forma cambia, la semantica no; e il type globale
     resta, che e' il punto. */
  assert("BP group dentro il dict: dopo il commit il type resta, il gruppo diventa i suoi 3-tuple",
    eq(roundTrip(CON_GRUPPO),
       { type: "cubic", points: [[0, 2], [0.1, 1, "step"], [0.2, 3, "step"], [0.3, 0], [1, 1]] }),
    JSON.stringify(roundTrip(CON_GRUPPO)));

  const STEP_CON_CUBIC = { type: "step", points: [[0, 0], [0.5, 1, "cubic"], [0.7, 0.2, "cubic"], [1, 1]] };
  assert("anche con step globale e cubic sul punto",
    eq(roundTrip(STEP_CON_CUBIC), STEP_CON_CUBIC), JSON.stringify(roundTrip(STEP_CON_CUBIC)));

  /* Il caso della issue, da un gesto dell'editor: fill_factor di stream4 in
     mare-nostrum.yml, una zona di tre punti portata a `step` con
     setZoneInterp (EnvelopeEditor.jsx), che tagga i punti interni della zona
     col tipo scelto — o li lascia nudi se e' il default — e committa. */
  const FF = { type: "cubic", points: [[0, 2], [0.0926, 2.01], [0.1631, 0.46], [0.2586, 0.4], [0.3133, 2.75], [1, 1]] };
  {
    const w = E.unwrapEnv(FF);
    const rawEnv = E.desugarBPGroups(w.items);
    const g = w.interp;
    const internal = new Set([1, 2, 3].slice(0, -1));
    const next = rawEnv.map((it, i) => {
      if (!internal.has(i) || !E.isBreakpoint(it)) return it;
      return "step" === g ? [it[0], it[1]] : [it[0], it[1], "step"];
    });
    const scritto = commitPath(next, g);
    assert("setZoneInterp su un {type: cubic}: esce il dict con le due eccezioni step",
      eq(scritto, { type: "cubic", points: [[0, 2], [0.0926, 2.01, "step"], [0.1631, 0.46, "step"], [0.2586, 0.4], [0.3133, 2.75], [1, 1]] }),
      JSON.stringify(scritto));
    assert("…e riaperto, l'editor rilegge cubic come interp globale",
      E.unwrapEnv(scritto).interp === "cubic");
    // E il disegno, che passa da expandMixed: i segmenti 0, 3 e 4 restano cubici.
    const tags = E.expandMixed(scritto).points.map((p) => p[2]);
    assert("…e expandMixed disegna cubici i segmenti senza eccezione",
      eq(tags.slice(0, 5), ["cubic", "step", "step", "cubic", "cubic"]), JSON.stringify(tags));
  }

  // I confini, che non devono muoversi
  assert("interp lineare con un 3-tuple: lista piatta, come prima",
    eq(E.wrapEnv([[0, 0, "cubic"], [1, 1]], "linear"), [[0, 0, "cubic"], [1, 1]]));
  assert("interp assente: lista piatta, come prima",
    eq(E.wrapEnv([[0, 0], [[[0.2, 1], [0.8, 0]], "step"], [1, 1]], null),
       [[0, 0], [[[0.2, 1], [0.8, 0]], "step"], [1, 1]]));
  assert("soli breakpoint nudi con interp non lineare: dict, come prima",
    eq(E.wrapEnv([[0, 0], [1, 1]], "step"), { type: "step", points: [[0, 0], [1, 1]] }));

  /* Il caso dichiarato: con un blocco compatto fra gli item la lista resta
     piatta, come prima di #189. Il motore legge l'interp del blocco in due
     modi che l'editor non rispecchia — nella lista piatta quello del PRIMO
     blocco diventa il tipo globale (`EnvelopeBuilder.extract_interp_type`),
     nel dict viene ignorato e governa il `type` — mentre expandMixed lo
     disegna per blocco. Tenere il dict qui renderebbe identico il valore per
     il motore ma aprirebbe un disegno falso proprio sul blocco appena
     aggiunto con "add loop"; la decisione sta nella issue #191, e la
     divergenza e' asserita dalla suite di parita'. Se questo assert cade,
     qualcuno ha deciso: aggiornare la parita' e CLAUDE.md insieme. */
  const LOOPED = [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2]];
  assert("con un blocco compatto la lista resta piatta (caso dichiarato, #191)",
    eq(E.wrapEnv(LOOPED, "cubic"), LOOPED), JSON.stringify(E.wrapEnv(LOOPED, "cubic")));

  /* fmtEnvInline formattava i points del dict con fmtBP e basta: un gruppo
     dentro usciva come numeri senza senso. */
  const inline = E.fmtEnvInline(CON_GRUPPO);
  assert("fmtEnvInline: un gruppo dentro il dict esce come gruppo",
    inline === "{type: cubic, points: [[0, 2], [[[0.1, 1], [0.2, 3], [0.3, 0]], 'step'], [1, 1]]}",
    inline);
  assert("parseEnvLiteral ∘ fmtEnvInline round-trip sul dict con gruppo",
    eq(E.parseEnvLiteral(inline), CON_GRUPPO), inline);
}

/* ── l'anteprima dell'editor sul dict che porta gruppi (#189) ────────────────
   EnvelopeEditor passava il dict a expandMixed cosi' com'era, con un commento
   che lo giustificava — «la forma typed non contiene gruppi» — falso da #189,
   e falso gia' prima per un dict scritto a mano. Con un gruppo E un blocco nel
   dict, `blocks[].originalIdx` indicizzava i points non desugarati, mentre
   l'editor lo usa su `rawEnv`, che e' desugarato. */
console.log("\n── expandMixed sul dict con gruppi: gli indici sono quelli di rawEnv ──");
{
  const DICT = { type: "cubic", points: [[[[0, 0], [0.2, 1], [0.3, 0.5]], "step"], [[[0, 1], [100, 0]], 1, 2]] };
  const rawEnv = E.desugarBPGroups(E.unwrapEnv(DICT).items);
  const SG = require("./source-guard.js");
  const eeSrc = SG.codeOf(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"));
  assert("l'editor non passa piu' il dict grezzo a expandMixed",
    !/isTypedEnv\(rawEnvRaw\)\s*\?\s*rawEnvRaw\s*:/.test(eeSrc));
  assert("…ma un dict con i points desugarati, e il type del dict",
    /expandMixed\(\s*PGEEnv\.isTypedEnv\(rawEnvRaw\)\s*\?\s*\{\s*type:\s*rawEnvRaw\.type,\s*points:\s*items\s*\}\s*:\s*items\s*\)/.test(eeSrc));
  const exp = E.expandMixed({ type: DICT.type, points: rawEnv });
  assert("originalIdx indicizza un blocco di rawEnv",
    exp.blocks.length === 1 && E.isCompactBlock(rawEnv[exp.blocks[0].originalIdx]),
    JSON.stringify(exp.blocks.map((b) => b.originalIdx)));
  assert("…e il disegno dei breakpoint e' quello del dict grezzo",
    eq(exp.points, E.expandMixed(DICT).points));

  /* Gli altri lettori che misuravano un envelope come lista. Da #189 il dict
     lo scrive l'editor per ogni interp globale non lineare con eccezioni sul
     punto — curve che prima uscivano liste — e `.length` su un dict e'
     `undefined`: la riga dell'Inspector mostrava il segnaposto al posto della
     curva e «undefined bp» come conteggio. */
  const primSrc = SG.codeOf(path.join(__dirname, "../../src/components/primitives.jsx"));
  assert("ParamRow legge l'envelope per envSketch, non per la sua lunghezza",
    /PGEEnv\.envSketch\(envValue\)/.test(primSrc) && !/envValue\.length/.test(primSrc));
  const inspSrc = SG.codeOf(path.join(__dirname, "../../src/components/Inspector.jsx"));
  assert("i conteggi «N bp» dell'Inspector passano da unwrapEnv",
    !/(fillFactorEnv|densityEnv|readDirectionEnv)\.length/.test(inspSrc),
    (inspSrc.match(/\w+Env\.length/g) || []).join(", "));
  /* La curva di blend di grain.envelope (transition / multistate) la scrive
     lo stesso commit, e la riga che la mostra in piccolo — CurveRow, in
     EnvelopeSelector.jsx — la leggeva solo come lista: `Array.isArray(value) ?
     value : [[0, 0], [1, 1]]`. Su un dict disegnava la diagonale di default e
     «2 bp», cioe' una curva che non c'e'; e da #189 setZoneInterp su una curva
     cubica esce dict invece che lista, quindi il segnaposto avrebbe preso
     proprio la curva appena ritoccata. Un gruppo nella lista, poi, dava NaN
     nella polyline (`p[0]` di un gruppo e' una lista). */
  const selSrc = SG.codeOf(path.join(__dirname, "../../src/components/EnvelopeSelector.jsx"));
  assert("CurveRow legge la curva per envSketch, non come lista",
    /PGEEnv\.envSketch\(/.test(selSrc) && !/Array\.isArray\(value\)\s*\?\s*value\s*:/.test(selSrc));

  /* envSketch e' la lettura condivisa delle due righe: una sola strada
     (unwrapEnv → desugar → expandMixed), cosi' le due non divergono — ed e'
     lei che il test esegue, non una sua copia. */
  const MISTA = { type: "cubic", points: [[0, 2], [0.2586, 0.4, "linear"], [1, 1]] };
  const xy = (sk) => sk.points.map((p) => [p[0], p[1]]);
  assert("envSketch sul dict: i punti della lista, e il conteggio dei points scritti",
    eq(xy(E.envSketch(MISTA)), [[0, 2], [0.2586, 0.4], [1, 1]]) && E.envSketch(MISTA).count === 3
      && E.envSketch(MISTA).loops === 0,
    JSON.stringify(E.envSketch(MISTA)));
  assert("…lo stesso disegno della lista piatta degli stessi item",
    eq(xy(E.envSketch(MISTA)), xy(E.envSketch(MISTA.points))));
  const CURVA_GRUPPO = [[0, 0], [[[0.2, 1], [0.5, 0]], "step"], [1, 1]];
  const skG = E.envSketch(CURVA_GRUPPO);
  assert("envSketch su una lista con un gruppo: nessun NaN, il gruppo e' i suoi punti",
    eq(xy(skG), [[0, 0], [0.2, 1], [0.5, 0], [1, 1]]) && skG.count === 3, JSON.stringify(skG));
  assert("envSketch su un dict col gruppo: gli stessi punti",
    eq(xy(E.envSketch({ type: "cubic", points: CURVA_GRUPPO })), xy(skG)));
  const skL = E.envSketch([[0, 0], [[[0, 0], [100, 1]], 1, 2]]);
  assert("envSketch conta i blocchi", skL.loops === 1 && skL.points.length > 2, JSON.stringify(skL));
  assert("envSketch su un valore assente: niente punti, conteggio zero",
    eq(E.envSketch(null), { count: 0, points: [], loops: 0 }), JSON.stringify(E.envSketch(null)));

  /* (review) «La strada dell'EnvelopeEditor» valeva per x e y, non per il
     terzo campo: envSketch desugarava gli item e li passava a expandMixed come
     LISTA, quindi sul dict i punti senza tipo suo uscivano `linear` invece
     che col `type` — il dato che #189 esiste per conservare. L'editor rifa'
     il dict attorno agli item desugarati (l'espressione che il guard di
     sorgente qui sopra fissa), e lo schizzo deve tracciare la stessa cosa,
     tag compresi: chi un giorno disegnasse i segmenti dal tag lo leggerebbe
     di qui. */
  const editorExp = (raw) => {
    const items = E.desugarBPGroups(E.unwrapEnv(raw).items);
    return E.expandMixed(E.isTypedEnv(raw) ? { type: raw.type, points: items } : items);
  };
  for (const [nome, raw] of [["la forma mista", MISTA],
                             ["il dict con un gruppo", { type: "cubic", points: CURVA_GRUPPO }],
                             ["il dict di soli punti nudi", { type: "step", points: [[0, 0], [0.5, 1], [1, 0]] }],
                             ["la lista", CURVA_GRUPPO]]) {
    assert(`envSketch traccia come l'editor, interp compreso: ${nome}`,
      eq(E.envSketch(raw).points, editorExp(raw).points),
      `${JSON.stringify(E.envSketch(raw).points)} contro ${JSON.stringify(editorExp(raw).points)}`);
  }

  /* (review) `count` sono gli elementi SCRITTI, e una grafia nuda — il blocco
     o il gruppo che E' il valore, 26 stream nel corpus del motore — e' un
     elemento solo. `unwrapEnv` la rende tale e quale, cioe' i suoi tre campi
     (pattern, end_time, n_reps) o i suoi due (punti, interp), e il conteggio
     li contava: «↻1 · 3 el» su un envelope fatto di un blocco. */
  const BLOCCO_NUDO = [[[0, 0], [100, 1]], 1, 4];
  const GRUPPO_NUDO = [[[0, 0], [0.5, 1], [1, 0]], "step"];
  assert("envSketch: un blocco nudo e' un elemento, non i suoi tre campi",
    E.envSketch(BLOCCO_NUDO).count === 1 && E.envSketch(BLOCCO_NUDO).loops === 1,
    JSON.stringify({ count: E.envSketch(BLOCCO_NUDO).count, loops: E.envSketch(BLOCCO_NUDO).loops }));
  assert("…un gruppo nudo e' un elemento, non i suoi due",
    E.envSketch(GRUPPO_NUDO).count === 1, String(E.envSketch(GRUPPO_NUDO).count));
  assert("…e cosi' dentro il dict, i cui points sono un blocco nudo (la forma della docstring di Envelope)",
    E.envSketch({ type: "cubic", points: BLOCCO_NUDO }).count === 1,
    String(E.envSketch({ type: "cubic", points: BLOCCO_NUDO }).count));
  assert("envCount e' la stessa regola, esportata per chi conta senza tracciare",
    [MISTA, CURVA_GRUPPO, BLOCCO_NUDO, GRUPPO_NUDO, { type: "cubic", points: BLOCCO_NUDO }, null]
      .every((raw) => typeof E.envCount === "function" && E.envCount(raw) === E.envSketch(raw).count));
  /* I badge «N bp» dell'Inspector contano con la stessa regola delle righe
     sotto di loro: con `unwrapEnv(...).items.length` un fill_factor fatto di
     un blocco nudo leggeva «3 bp» nel badge e «1 el» nella riga. */
  assert("i badge dell'Inspector contano con envCount",
    ["fillFactorEnv", "densityEnv", "readDirectionEnv"].every((k) =>
      new RegExp(`PGEEnv\\.envCount\\(\\s*[\\w.]*\\b${k}\\s*\\)`).test(inspSrc))
      && !/unwrapEnv\([^)]*Env\)\.items\.length/.test(inspSrc),
    (inspSrc.match(/[\w.]*Env\)\.items\.length/g) || []).join(", "));
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
