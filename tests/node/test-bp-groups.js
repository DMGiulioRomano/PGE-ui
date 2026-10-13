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
assert("tag ridondanti (== default globale) normalizzati via, se resta un tipo sul punto",
  eq(E.resugarBPGroups([[0, 0, "linear"], [0.5, 1, "step"], [1, 1]], "linear"),
     [[0, 0], [0.5, 1, "step"], [1, 1]]));
/* L'ultimo tipo sul punto non si toglie, anche ridondante: senza nessuno il
   motore costruisce un segmento solo invece di uno per coppia
   (`_parse_segments`: has_per_point_type), e sull'istante esatto di un
   salto legge l'altro punto. */
assert("…l'ultimo tipo sul punto resta, anche se ridondante",
  eq(E.resugarBPGroups([[0, 0, "linear"], [1, 1]], "linear"),
     [[0, 0, "linear"], [1, 1]]));
assert("default globale non-linear: run cubic con global cubic resta piatto, col suo tag",
  eq(E.resugarBPGroups([[0, 0, "cubic"], [1, 1]], "cubic"),
     [[0, 0, "cubic"], [1, 1]]));
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
// Il valore diceva 1, il primo y del gruppo: ma il bordo cade sul segmento che
// ENTRA nel gruppo, da [0, 0] a [1.2, 1], lineare (l'interp del punto prima,
// non la zona), e il motore a x=1 suona 0.8333 (test-envelope-cut-parity.js).
// La forma resta quella: il gruppo non sopravvive, il bordo e' un punto nudo.
assert("truncateEnvArray: gruppo degenerato a 1 punto → breakpoint nudo",
  eq(U.truncateEnvArray([[0, 0], [[[1.2, 1], [1.5, 2]], "cubic"]]),
     [[0, 0], [1, 0.8333]]),
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
  // paste): desugar per lavorare, resugar + wrap per scrivere, tutti e due col
  // valore da cui gli item vengono.
  const commitPath = (items, interp, like) =>
    E.wrapEnv(E.resugarBPGroups(items, interp || "linear", like), interp, like);
  const roundTrip = (x) => {
    const w = E.unwrapEnv(x);
    return commitPath(E.desugarBPGroups(w.items), w.interp, x);
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
  /* Il gruppo fra due breakpoint nudi usciva come i suoi 3-tuple:
     resugarBPGroups rifaceva un gruppo solo da un run INTERO di segmenti
     uniformi, e qui il run e' tutto l'envelope. Sul bordo di un salto quella
     forma suona diversa (il blocco qui sotto, "il commit sul bordo del
     salto"), e ora il resugar riceve il valore d'origine e ne riporta le zone:
     il gruppo resta gruppo, e col type globale resta tutto. */
  assert("BP group dentro il dict: dopo il commit il type resta, e il gruppo pure",
    eq(roundTrip(CON_GRUPPO), CON_GRUPPO), JSON.stringify(roundTrip(CON_GRUPPO)));

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
    const scritto = commitPath(next, g, FF);
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

  /* Con un blocco compatto fra gli item (#191). Fino a qui la lista restava
     piatta — il caso che #189 aveva lasciato dichiarato — e il `type` si
     perdeva al primo commit. Il motore legge l'interp di un blocco per FORMA:
     nella lista quello del primo blocco che lo dichiara e' il tipo globale
     (`EnvelopeBuilder.extract_interp_type`), nel dict non conta niente. Deciso:
     l'editor lo legge cosi' (listInterp, expandMixed) e lo scrive cosi' —
     il dict resta dict, la lista resta lista se dice gia' lo stesso globale,
     e l'interp di UN blocco va sui punti del suo pattern (setBlockInterp).
     Che il motore suoni lo stesso lo chiede test-envelope-wrap-parity.js. */
  const LOOPED = [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2]];
  assert("con un blocco compatto il dict resta: il type globale non si perde (#191)",
    eq(E.wrapEnv(LOOPED, "cubic"), { type: "cubic", points: LOOPED }),
    JSON.stringify(E.wrapEnv(LOOPED, "cubic")));
  const LOOPED_DICT = { type: "cubic", points: LOOPED };
  assert("…e il round-trip dell'editor senza modifiche lo rende identico",
    eq(roundTrip(LOOPED_DICT), LOOPED_DICT), JSON.stringify(roundTrip(LOOPED_DICT)));

  /* fmtEnvInline formattava i points del dict con fmtBP e basta: un gruppo
     dentro usciva come numeri senza senso. */
  const inline = E.fmtEnvInline(CON_GRUPPO);
  assert("fmtEnvInline: un gruppo dentro il dict esce come gruppo",
    inline === "{type: cubic, points: [[0, 2], [[[0.1, 1], [0.2, 3], [0.3, 0]], 'step'], [1, 1]]}",
    inline);
  assert("parseEnvLiteral ∘ fmtEnvInline round-trip sul dict con gruppo",
    eq(E.parseEnvLiteral(inline), CON_GRUPPO), inline);
}

/* ── il commit sul bordo del salto: zona e punti nudi non si scambiano ───────
   Per l'editor zona e punti nudi erano grafia: lavora sulla forma piatta, e
   al commit resugarBPGroups rifaceva un gruppo da ogni run di punti
   consecutivi con lo stesso tipo, e solo da quello. Per il motore non lo sono
   sul bordo di un salto: il primo punto di un BP group che cade sull'istante
   del punto prima — o prima ancora — si sposta a quell'istante piu'
   DISCONTINUITY_OFFSET (`_expand_bp_group`), un punto nudo li' resta dov'e'.
   Con `cubic` cambia la forma: le tangenti di Fritsch-Carlson vedono il
   microsecondo come una pendenza enorme e la curva riparte dal salto col
   doppio della pendenza della corda; sul salto largo zero la pendenza vale 0 e
   la curva riparte piatta. Un commit qualunque su quell'inviluppo scambiava le
   due grafie, nelle due direzioni: la zona sul salto, fra punti nudi, si
   appiattiva; i punti nudi taggati dopo un blocco diventavano una zona.
   Adesso il resugar riceve il valore da cui gli item vengono (`like`, lo
   stesso che wrapEnv riceve gia') e ne riporta le zone sugli item nuovi, e una
   zona nuova nasce solo dove non cambia il suono. Che il motore suoni lo
   stesso lo chiede tests/parity/test-envelope-wrap-parity.js; qui la forma. */
console.log("\n── il commit sul bordo del salto: zona e punti nudi non si scambiano ──");
{
  const commit = (items, interp, like) =>
    E.wrapEnv(E.resugarBPGroups(items, interp || "linear", like), interp, like);
  const rt = (x) => { const w = E.unwrapEnv(x); return commit(E.desugarBPGroups(w.items), w.interp, x); };

  const SALTO = [[0, 0], [0.5, 1], [[[0.5, 2], [1, 3]], "cubic"]];
  assert("la zona che comincia sul salto: il commit senza modifiche la rende identica",
    eq(rt(SALTO), SALTO), JSON.stringify(rt(SALTO)));
  const SALTO_DICT = { type: "cubic", points: SALTO };
  assert("…anche dentro un {type, points}", eq(rt(SALTO_DICT), SALTO_DICT), JSON.stringify(rt(SALTO_DICT)));
  const PRIMA = [[0, 0], [0.5, 1], [[[0.3, 2], [0.8, 2.5], [1, 3]], "cubic"]];
  assert("…e quella che comincia prima del punto precedente (il motore la porta dopo)",
    eq(rt(PRIMA), PRIMA), JSON.stringify(rt(PRIMA)));
  const LIBERA = { type: "cubic", points: [[0, 2], [[[0.1, 1], [0.2, 3], [0.3, 0]], "step"], [1, 1]] };
  assert("una zona lontana dal salto resta zona anche lei: lo YAML esce come l'autore l'ha scritto",
    eq(rt(LIBERA), LIBERA), JSON.stringify(rt(LIBERA)));
  assert("…senza il valore d'origine l'inferenza e' quella di sempre: il run misto resta piatto",
    eq(E.resugarBPGroups(E.desugarBPGroups(LIBERA.points), "cubic"),
       [[0, 2], [0.1, 1, "step"], [0.2, 3, "step"], [0.3, 0], [1, 1]]));
  assert("…e le zone dell'esempio della issue #108, blocco in mezzo, tornano le stesse",
    eq(E.resugarBPGroups(E.desugarBPGroups(MIXED), "linear", MIXED), MIXED));

  // L'altra direzione: punti nudi taggati che cominciano su un salto.
  const BLK = [[[0, 0], [100, 1]], 0.5, 1];
  const DOPO_BLOCCO = [BLK, [0.5, 2, "cubic"], [1, 3]];
  assert("punti nudi taggati dove finisce un blocco: restano nudi",
    eq(rt(DOPO_BLOCCO), DOPO_BLOCCO), JSON.stringify(rt(DOPO_BLOCCO)));
  assert("…anche senza il valore d'origine: la regola non ha bisogno di sapere cosa c'era",
    eq(E.resugarBPGroups(DOPO_BLOCCO, "linear"), DOPO_BLOCCO),
    JSON.stringify(E.resugarBPGroups(DOPO_BLOCCO, "linear")));
  const DOPO_DICT = [{ t: 0.5, v: 1 }, [0.5, 2, "cubic"], [1, 3]];
  assert("…e dopo un punto {t, v} sullo stesso istante",
    eq(E.resugarBPGroups(DOPO_DICT, "linear"), DOPO_DICT),
    JSON.stringify(E.resugarBPGroups(DOPO_DICT, "linear")));
  assert("lontano dal salto un run uniforme diventa ancora zona",
    eq(E.resugarBPGroups([BLK, [0.6, 2, "cubic"], [1, 3]], "linear"), [BLK, [[[0.6, 2], [1, 3]], "cubic"]]));
  /* Il builder porta avanti `current_time` col solo ULTIMO punto di una zona,
     coi punti nudi col massimo di ognuno: un run fuori ordine fatto zona
     sposterebbe l'inizio del blocco che segue. */
  const FUORI_ORDINE = [[0, 0, "cubic"], [0.9, 1, "cubic"], [0.8, 2], [[[0, 0], [100, 1]], 2, 2]];
  assert("…ma non un run fuori ordine: la zona rileggerebbe diverso cio' che la segue",
    eq(E.resugarBPGroups(FUORI_ORDINE, "linear"), FUORI_ORDINE),
    JSON.stringify(E.resugarBPGroups(FUORI_ORDINE, "linear")));

  // I gesti: la zona segue i suoi punti, e cambia solo cio' che il gesto tocca.
  const Z = [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "cubic"]];
  const f = E.desugarBPGroups(Z);
  const at = (i, p) => f.map((it, k) => (k === i ? p : it));
  assert("un punto trascinato fuori dalla zona: la zona resta",
    eq(commit(at(0, [0.1, 0.4]), "linear", Z), [[0.1, 0.4], [0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "cubic"]]),
    JSON.stringify(commit(at(0, [0.1, 0.4]), "linear", Z)));
  assert("una freccia su un punto della zona: la zona resta, col valore nuovo",
    eq(commit(at(3, [0.75, 2.7, "cubic"]), "linear", Z), [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.7], [1, 3]], "cubic"]]),
    JSON.stringify(commit(at(3, [0.75, 2.7, "cubic"]), "linear", Z)));
  assert("un segmento della zona portato al tipo globale (il menu lo scrive nudo): un'eccezione dentro la zona",
    eq(commit(at(3, [0.75, 2.5]), "linear", Z), [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.5, "linear"], [1, 3]], "cubic"]]),
    JSON.stringify(commit(at(3, [0.75, 2.5]), "linear", Z)));
  const tuttiStep = f.map((it, k) => (k === 2 || k === 3 ? [it[0], it[1], "step"] : it));
  assert("tutti i segmenti della zona portati a un altro tipo: la zona prende quel tipo",
    eq(commit(tuttiStep, "linear", Z), [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "step"]]),
    JSON.stringify(commit(tuttiStep, "linear", Z)));
  assert("il selettore del tipo globale: la zona tiene il suo",
    eq(commit(E.setGlobalInterp(f, "step"), "step", Z),
       { type: "step", points: [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "cubic"]] }),
    JSON.stringify(commit(E.setGlobalInterp(f, "step"), "step", Z)));

  // Un punto aggiunto (il doppio click: prende il tag del punto prima) o tolto.
  const ins = (i, p) => [...f.slice(0, i), p, ...f.slice(i)];
  const del = (i) => f.filter((_, k) => k !== i);
  assert("un punto aggiunto dentro la zona: la zona si allunga",
    eq(commit(ins(3, [0.6, 2.2, "cubic"]), "linear", Z),
       [[0, 0], [0.5, 1], [[[0.5, 2], [0.6, 2.2], [0.75, 2.5], [1, 3]], "cubic"]]),
    JSON.stringify(commit(ins(3, [0.6, 2.2, "cubic"]), "linear", Z)));
  assert("un punto aggiunto prima della zona: resta fuori",
    eq(commit(ins(1, [0.25, 0.5]), "linear", Z),
       [[0, 0], [0.25, 0.5], [0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "cubic"]]),
    JSON.stringify(commit(ins(1, [0.25, 0.5]), "linear", Z)));
  assert("un punto tolto prima della zona: la zona resta",
    eq(commit(del(0), "linear", Z), [[0.5, 1], [[[0.5, 2], [0.75, 2.5], [1, 3]], "cubic"]]),
    JSON.stringify(commit(del(0), "linear", Z)));
  assert("tolto il primo punto della zona: la zona riparte dal secondo",
    eq(commit(del(2), "linear", Z), [[0, 0], [0.5, 1], [[[0.75, 2.5], [1, 3]], "cubic"]]),
    JSON.stringify(commit(del(2), "linear", Z)));
  /* Tolto l'ultimo, il penultimo diventa l'ultimo: il suo tag era il tipo
     della zona messo dal desugar, e sull'ultimo punto governerebbe il gap in
     uscita. Nello YAML di prima, col solo punto tolto, quel gap e' globale. */
  assert("tolto l'ultimo punto della zona: il nuovo ultimo esce senza il tipo della zona",
    eq(commit(del(4), "linear", Z), [[0, 0], [0.5, 1], [[[0.5, 2], [0.75, 2.5]], "cubic"]]),
    JSON.stringify(commit(del(4), "linear", Z)));
  const S2 = E.desugarBPGroups(SALTO);
  assert("una zona di due punti che ne perde l'ultimo non c'e' piu': il punto che resta esce nudo",
    eq(commit(S2.slice(0, 3), "linear", SALTO), [[0, 0], [0.5, 1], [0.5, 2]]),
    JSON.stringify(commit(S2.slice(0, 3), "linear", SALTO)));

  /* Il fratello di questo difetto, nello stesso resugar, trovato dal
     confronto a caso di test-envelope-wrap-parity.js: il tag uguale al
     globale si toglieva sempre, e se era l'ultimo tipo sul punto il motore
     passava da un segmento per coppia a un segmento solo. Sull'istante esatto
     di un salto i due leggono l'altro punto: con linear e cubic in fondo
     all'inviluppo, con step in cima — a t = 0, dove cade il primo grano — e
     in mezzo. */
  const FINE_SALTO = [[0, 1], [0.2, 0.1], { t: 0.3, v: -0.2 }, [0.3, 0.1, "linear"]];
  assert("un inviluppo che finisce con un salto e un tag ridondante: il commit lo rende identico",
    eq(rt(FINE_SALTO), FINE_SALTO), JSON.stringify(rt(FINE_SALTO)));
  const INIZIO_SALTO = { type: "step", points: [[0, 0], [0, 1, "step"], [1, 2]] };
  assert("…e uno step che comincia con un salto",
    eq(rt(INIZIO_SALTO), INIZIO_SALTO), JSON.stringify(rt(INIZIO_SALTO)));

  // Il paste: il valore d'origine e' quello degli appunti, con la sua struttura.
  const incollato = U.remapEnvY(E.unwrapEnv(SALTO).items, 0, 3, 0, 6);
  assert("il paste: la zona sul salto arriva zona",
    eq(commit(E.desugarBPGroups(incollato), "linear", SALTO), [[0, 0], [0.5, 2], [[[0.5, 4], [1, 6]], "cubic"]]),
    JSON.stringify(commit(E.desugarBPGroups(incollato), "linear", SALTO)));
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
  /* Da #191 la lettura e' una funzione sola, envExpand: gli item dentro un
     dict col tipo globale — il `type`, o per la lista lo slot 3 del primo
     blocco — e l'editor la chiama invece di rifarla. I gruppi li legge interi,
     come il builder (il bordo di un gruppo, sotto in #190), e gli indici dei
     blocchi li da' in rawEnv: dove nessun gruppo cade sul punto prima e' la
     lettura degli item desugarati. */
  assert("…ma la lettura condivisa, envExpand, sul valore com'e' scritto",
    /PGEEnv\.envExpand\(\s*rawEnvRaw\b/.test(eeSrc) && !/PGEEnv\.expandMixed\(/.test(eeSrc));
  assert("envExpand, senza un gruppo sul punto prima, e' la lettura degli item desugarati",
    eq(E.envExpand(DICT), E.expandMixed({ type: DICT.type, points: rawEnv })));
  const exp = E.envExpand(DICT);
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
  const editorExp = (raw) => E.envExpand(raw);
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
  /* E deviation_probability, che il guard qui sopra non vedeva perche' il suo
     valore non si chiama `…Env`: il badge globale e le righe per-parametro
     contavano gli item DESUGARATI (un gruppo di tre punti «3 bp», dove
     fill_factor dice «1 el»), la riga globale passava a ParamRow la lista
     desugarata, e lo schizzo per-parametro leggeva `q[0]`/`q[1]` su ogni item:
     su un blocco compatto o su un punto `{t, v}` NaN nella polyline. */
  assert("deviation_probability: il badge globale conta con envCount",
    /PGEEnv\.envCount\(d\)/.test(inspSrc)
      && !/desugarBPGroups\(PGEEnv\.unwrapEnv\(d\)\.items\)\.length/.test(inspSrc));
  assert("deviation_probability: la riga globale passa il valore a ParamRow, non la lista desugarata",
    /envValue=\{dIsEnv \? d : null\}/.test(inspSrc));
  assert("deviation_probability: le righe per-parametro leggono per envSketch",
    /PGEEnv\.envSketch\(val\)/.test(inspSrc)
      && !/desugarBPGroups\(PGEEnv\.unwrapEnv\(val\)\.items\)/.test(inspSrc));
}

/* ── wrapEnv: le altre chiavi del dict sopravvivono al commit ────────────────
   `wrapEnv` ricostruiva il dict con le sole `type` e `points`, e senza `type`
   scriveva la lista: ogni altra chiave spariva al primo commit. La prima e'
   `time_unit`, che per il motore prevale sul `time_mode` dello stream
   (`create_scaled_envelope`: `raw_data.get('time_unit', time_mode)`), quindi
   perderla rilegge i tempi in un'altra unita' senza nessun segno. Che il
   motore suoni lo stesso lo chiede test-envelope-wrap-parity.js; qui la forma.
   Con chiavi in piu' la lista non e' una scrittura possibile: il dict e'
   obbligato, anche con un interp lineare e anche con un blocco fra gli item. */
console.log("\n── wrapEnv: le altre chiavi del dict (time_unit) restano ──");
{
  const commitPath = (items, interp, like) =>
    E.wrapEnv(E.resugarBPGroups(items, interp || "linear", like), interp, like);
  const roundTrip = (x) => {
    const w = E.unwrapEnv(x);
    return commitPath(E.desugarBPGroups(w.items), w.interp, x);
  };
  const CON_UNITA = { type: "cubic", time_unit: "absolute", points: [[0, 0], [2, 1, "step"], [4, 0]] };
  assert("time_unit: il round-trip del commit rende il dict identico",
    eq(roundTrip(CON_UNITA), CON_UNITA), JSON.stringify(roundTrip(CON_UNITA)));
  const SENZA_TYPE = { time_unit: "normalized", points: [[0, 0], [0.5, 1], [1, 0]] };
  assert("…anche senza `type`, dove l'interp e' lineare: resta dict, non diventa lista",
    eq(roundTrip(SENZA_TYPE), SENZA_TYPE), JSON.stringify(roundTrip(SENZA_TYPE)));
  const CON_GRUPPO = { time_unit: "absolute", type: "cubic", points: [[0, 0], [[[1, 2], [2, 3]], "step"], [4, 0]] };
  assert("…con un gruppo fra gli item: le chiavi e il loro ordine restano",
    eq(Object.keys(roundTrip(CON_GRUPPO)), ["time_unit", "type", "points"])
      && roundTrip(CON_GRUPPO).time_unit === "absolute",
    JSON.stringify(roundTrip(CON_GRUPPO)));
  // Il selettore dell'interp globale in testata (commitWithInterp): cambia il
  // tipo, non l'unita' dei tempi.
  const linear = commitPath(E.desugarBPGroups(CON_UNITA.points), "linear", CON_UNITA);
  assert("interp globale portato a linear: time_unit resta, e il type dice linear",
    eq(linear, { type: "linear", time_unit: "absolute", points: [[0, 0], [2, 1, "step"], [4, 0]] }),
    JSON.stringify(linear));
  const SENZA_T_CUBIC = commitPath(E.desugarBPGroups(SENZA_TYPE.points), "cubic", SENZA_TYPE);
  assert("…e un dict senza `type` che diventa cubic prende il `type` prima dei points",
    eq(SENZA_T_CUBIC, { time_unit: "normalized", type: "cubic", points: SENZA_TYPE.points }),
    JSON.stringify(SENZA_T_CUBIC));
  const CON_BLOCCO = { type: "cubic", time_unit: "absolute", points: [[0, 0], [[[0, 0], [100, 1]], 3, 2]] };
  assert("con un blocco compatto il dict e' obbligato: la lista perderebbe time_unit",
    eq(roundTrip(CON_BLOCCO), CON_BLOCCO), JSON.stringify(roundTrip(CON_BLOCCO)));
  // I confini: senza chiavi in piu' wrapEnv fa quello che faceva.
  assert("senza chiavi in piu' la forma non cambia: il dict lineare torna lista",
    eq(E.wrapEnv([[0, 0], [1, 1]], "linear", { type: "linear", points: [[0, 0], [1, 1]] }), [[0, 0], [1, 1]]));
  assert("…e un `like` che e' una lista non porta niente",
    eq(E.wrapEnv([[0, 0], [1, 1]], "cubic", [[0, 0], [1, 1]]), { type: "cubic", points: [[0, 0], [1, 1]] }));

  /* Ogni commit dell'EnvelopeEditor passa a wrapEnv il valore da cui gli item
     vengono: senza, la chiave si perde da quella porta. Le porte sono cinque
     (commit, commitWithInterp, il Delete, le frecce, il paste) e il guard le
     conta tutte: ogni chiamata ha tre argomenti. Lo stesso per
     resugarBPGroups, che da quel valore riporta le zone (il blocco "il commit
     sul bordo del salto"): una porta senza scambierebbe di nuovo zona e punti
     nudi, e il suono con loro. */
  const SG = require("./source-guard.js");
  const eeMask = SG.maskOf(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"));
  const argsOf = (re) => {
    const calls = [];
    for (const m of eeMask.matchAll(re)) {
      let depth = 0, args = 1, i = m.index + m[0].length - 1;
      for (; i < eeMask.length; i++) {
        const ch = eeMask[i];
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) { depth--; if (depth === 0) break; }
        else if (ch === "," && depth === 1) args++;
      }
      calls.push(args);
    }
    return calls;
  };
  const calls = argsOf(/(?<![\w])wrapEnv\(/g);
  assert("le cinque porte di scrittura dell'EnvelopeEditor passano il valore d'origine a wrapEnv",
    calls.length === 5 && calls.every((n) => n === 3), JSON.stringify(calls));
  const resugars = argsOf(/(?<![\w])resugarBPGroups\(/g);
  assert("…e a resugarBPGroups, che ne riporta le zone",
    resugars.length === 5 && resugars.every((n) => n === 3), JSON.stringify(resugars));
}

/* ── la curva di blend multistate: ogni grafia cambia scala ──────────────────
   `grain.envelope: {states, curve}` vive in due scale: il motore legge la curva
   in [0, 1], l'editor la mostra in [0, n-1] (uno stato per unita').
   `rescaleCurveY` (yaml-bridge.js) porta le y da una scala all'altra, al parse
   e al serialize, ma riconosceva solo i punti `[t, v]` / `[t, v, interp]`: un
   BP group, il pattern di un blocco, un punto `{t, v}` e le grafie nude
   passavano com'erano, e con tre stati arrivavano all'editor ancora in [0, 1]
   — disegnati a meta' altezza, e trascinati da li' nella scala sbagliata. La
   domanda si fa all'editor, non a una lista di numeri: lo schizzo della curva
   aperta (envSketch, la strada dell'EnvelopeEditor) deve essere quello della
   curva scritta con le y per n-1, tempi e tag uguali. */
console.log("\n── rescaleCurveY: la curva multistate cambia scala in ogni grafia ──");
{
  const Y = window.PGEYaml;
  const SAMPLES = { samples: [{ name: "a.wav", duration: 4 }] };
  const yamlOf = (curve, nStates) => {
    const states = Array.from({ length: nStates }, (_, i) =>
      `[${nStates === 1 ? 0 : i / (nStates - 1)}, ${["hanning", "bartlett", "gaussian", "blackman"][i]}]`);
    return "streams:\n  - stream_id: s\n    sample: a.wav\n    duration: 4\n    grain:\n" +
      "      envelope:\n        states: [" + states.join(", ") + "]\n" +
      "        curve: " + JSON.stringify(curve) + "\n";
  };
  const CURVE = {
    "un gruppo nella lista": [[0, 0], [[[0.3, 0.5], [0.6, 1]], "step"], [1, 0]],
    "un blocco nella lista": [[0, 0], [[[0, 0.5], [100, 1]], 0.8, 2], [1, 0]],
    "il dict con un gruppo": { type: "cubic", points: [[0, 0], [[[0.3, 0.5], [0.6, 1]], "step"], [1, 0]] },
    "i punti {t, v}": [{ t: 0, v: 0.5 }, { t: 1, v: 1 }],
    "un gruppo nudo": [[[0, 0], [0.5, 1], [1, 0.5]], "step"],
    "un blocco nudo": [[[0, 0.25], [100, 1]], 1, 2],
    "il dict i cui points sono un blocco nudo": { type: "step", points: [[[0, 0.25], [100, 1]], 1, 2] },
    "i punti [t, v] (il caso che c'era gia')": [[0, 0], [0.5, 1, "step"], [1, 0.5]],
  };
  // envSketch legge i punti {t, v} come l'editor, cioe' non li disegna: per
  // loro la domanda e' sulla forma scritta.
  const ys = (c) => E.envSketch(c).points;
  for (const [nome, curve] of Object.entries(CURVE)) {
    const d = Y.parse(yamlOf(curve, 3), SAMPLES);
    const ed = d.streams[0].grain.envelope.curve;
    const atteso = ys(curve).map((p) => [p[0], p[1] * 2, p[2]]);
    const dict = Array.isArray(curve) && curve.every((p) => p && !Array.isArray(p));
    assert(`multistate a tre stati, ${nome}: l'editor vede la curva in [0, 2]`,
      dict ? eq(ed, curve.map((p) => ({ ...p, v: p.v * 2 })))
           : eq(ys(ed).map((p) => [p[0], +p[1].toFixed(12), p[2]]),
                atteso.map((p) => [p[0], +p[1].toFixed(12), p[2]])),
      `${JSON.stringify(ed)} contro ${JSON.stringify(atteso)}`);
    // Salvato senza toccarlo, esce com'era scritto, byte per byte (#59).
    const back = Y.parse(Y.serialize(d), SAMPLES).streams[0].grain.envelope._curveRaw;
    assert(`…${nome}: il salvataggio senza modifiche la riscrive identica`,
      eq(back, curve), JSON.stringify(back));
  }
  /* Il ritorno dopo una modifica vera: la curva si riporta in [0, 1] per la
     stessa strada, gruppi e blocchi compresi. */
  {
    const d = Y.parse(yamlOf(CURVE["un gruppo nella lista"], 3), SAMPLES);
    const env = d.streams[0].grain.envelope;
    env.curve = [[0, 0], [[[0.3, 1.5], [0.6, 2]], "step"], [1, 0]];   // 0.5→1.5 in scala editor
    const out = Y.parse(Y.serialize(d), SAMPLES).streams[0].grain.envelope._curveRaw;
    assert("una modifica dentro il gruppo torna in [0, 1]",
      eq(out, [[0, 0], [[[0.3, 0.75], [0.6, 1]], "step"], [1, 0]]), JSON.stringify(out));
  }
  /* curveMatchesRaw riconosce come intatta una curva il cui ritorno in scala
     non e' esatto in virgola mobile (0.1·3/3): senza, un salvataggio che non
     ha toccato niente riscriverebbe 0.10000000000000002. */
  {
    const curve = [[0, 0], [[[0.2, 0.1], [0.7, 0.4]], "step"], [1, 0.1]];
    const d = Y.parse(yamlOf(curve, 4), SAMPLES);
    const out = window.jsyaml.load(Y.serialize(d)).streams[0].grain.envelope.curve;
    assert("quattro stati: il salvataggio senza modifiche non introduce deriva",
      eq(out, curve), JSON.stringify(out));
  }
}

/* ── la cubica come la calcola il motore (#190) ─────────────────────────────
   Le tangenti in un posto solo (cubicTangents), usate dal disegno (envPath) e
   dal cursore (envValueAt). Che i valori siano quelli del motore lo chiede
   tests/parity/test-envelope-eval-parity.js; qui le regole che non hanno
   bisogno del motore, e che disegno e cursore dicano la stessa curva. */
console.log("\n── cubicTangents / envValueAt / envPath (#190) ──");
{
  assert("due punti: tangenti a zero (lo smoothstep), non la pendenza",
    eq(E.cubicTangents([[0, 0.001], [1, 0.016]]), [0, 0]));
  assert("un punto, nessun punto: zeri",
    eq(E.cubicTangents([[0, 1]]), [0]) && eq(E.cubicTangents([]), []));
  const m = E.cubicTangents([[0, 0], [1, 2], [2, 3], [3, 1]]);
  assert("tre punti o piu': estremi = pendenza del segmento, interni = media armonica",
    m[0] === 2 && m[3] === -2 && m[1] === 2 / (1 / 2 + 1 / 1) && m[2] === 0, JSON.stringify(m));
  assert("un segmento largo zero (la discontinuita') ha pendenza zero, non quella del vicino",
    E.cubicTangents([[0, 0], [0.5, 1], [0.5, 3], [1, 4]])[1] === 0);

  const due = E.envExpand({ type: "cubic", points: [[0, 0.001], [1, 0.016]] });
  const v = E.envValueAt(due, 0.1);
  const smooth = 0.001 + 0.015 * (3 * 0.01 - 2 * 0.001);
  assert("la cubica di due punti sotto il cursore e' lo smoothstep, non la retta",
    Math.abs(v - smooth) < 1e-15 && Math.abs(v - 0.0025) > 1e-4, String(v));
  const cmds = E.envPath(due);
  assert("…e il disegno la traccia con le tangenti piatte: i punti di controllo stanno sugli estremi",
    cmds.length === 2 && cmds[1].op === "C" && cmds[1].c1[1] === 0.001 && cmds[1].c2[1] === 0.016,
    JSON.stringify(cmds));
  assert("lo stesso col tipo sul punto",
    eq(E.envPath(E.envExpand([[0, 0.001, "cubic"], [1, 0.016]])).map((c) => c.op), ["M", "C"]));

  /* (review) Il bordo di un gruppo. Il builder sposta di DISCONTINUITY_OFFSET
     il primo punto di un gruppo che cade sull'istante del punto prima, o
     prima (`_expand_bp_group`: `t <= current_time`), come il primo punto di un
     blocco; un breakpoint nudo no. envExpand leggeva gli item DESUGARATI, dove
     il gruppo e' gia' fatto di breakpoint nudi: lo spostamento si perdeva, il
     segmento del salto era largo zero — pendenza zero invece di 1e6 — e le
     tangenti della cubica accanto non erano quelle del motore (0.29 di
     scarto a t = 0.7 qui sotto: lo chiede test-envelope-eval-parity.js). */
  const BORDO = [[0, 0], [0.5, 1], [[[0.5, 2], [1, 3]], "cubic"]];
  const eb = E.envExpand(BORDO);
  assert("il primo punto di un gruppo sull'istante del punto prima si sposta come nel builder",
    eb.points.length === 4 && eb.points[1][0] === 0.5 && eb.points[2][0] === 0.5 + E.DISCONTINUITY_OFFSET,
    JSON.stringify(eb.points));
  assert("…e la tangente della cubica li' vede il salto (non zero)",
    E.cubicTangents(eb.points)[2] > 3.9, JSON.stringify(E.cubicTangents(eb.points)));
  assert("…un breakpoint nudo sullo stesso istante invece resta dov'e' (il builder non lo sposta)",
    E.envExpand([[0, 0], [0.5, 1], [0.5, 2, "cubic"], [1, 3]]).points[2][0] === 0.5);
  /* Letto il gruppo intero, gli indici dei blocchi restano quelli di rawEnv,
     che e' desugarato: l'invariante su cui l'editor poggia (blockByOrig). */
  const GB = [[[[0, 0], [0.2, 1], [0.3, 0.5]], "cubic"], [[[0, 1], [100, 0]], 1, 2]];
  const rawGB = E.desugarBPGroups(E.unwrapEnv(GB).items);
  const expGB = E.envExpand(GB);
  assert("…e con un gruppo prima di un blocco originalIdx indicizza ancora rawEnv",
    expGB.blocks.length === 1 && expGB.blocks[0].originalIdx === 3 && E.isCompactBlock(rawGB[3]),
    JSON.stringify(expGB.blocks.map((b) => b.originalIdx)));

  /* Disegno e cursore: la stessa curva. La Bezier di envPath, valutata come
     la traccia l'SVG, deve dare i valori di envValueAt dove il disegno ne ha
     uno solo (non sull'istante di un salto). */
  const bez = (cmds, t) => {
    let prev = cmds[0];
    for (const c of cmds.slice(1)) {
      if (prev.t < t && t < c.t) {
        const s = (t - prev.t) / (c.t - prev.t), r = 1 - s;
        return c.op === "C"
          ? r * r * r * prev.v + 3 * r * r * s * c.c1[1] + 3 * r * s * s * c.c2[1] + s * s * s * c.v
          : prev.v + s * (c.v - prev.v);
      }
      prev = c;
    }
    return null;
  };
  for (const [nome, raw] of [
    ["dict cubic con un gruppo e un blocco",
      { type: "cubic", points: [[0, 0], [[[0.1, 0.5], [0.2, 1]], "step"], [[[0, 1], [50, 0], [100, 1]], 0.6, 2], [1, 0.9]] }],
    ["lista con il globale in un blocco", [[0, 0], [0.2, 1], [[[0, 0], [50, 1], [100, 0]], 1, 2, "cubic"]]],
    ["step con una discontinuita'", { type: "step", points: [[0, 0], [0.5, 1], [0.5, 3], [1, 0]] }],
  ]) {
    const exp = E.envExpand(raw);
    const at = new Set(exp.points.map((p) => p[0]));
    const cm = E.envPath(exp);
    const bad = [];
    for (let i = 1; i < 300; i++) {
      const t = i / 300;
      if (at.has(t)) continue;
      const a = bez(cm, t), b = E.envValueAt(exp, t);
      if (a == null || Math.abs(a - b) > 1e-12) bad.push(`${t}: ${a} contro ${b}`);
    }
    assert(`disegno e cursore dicono la stessa curva: ${nome}`, bad.length === 0, bad.slice(0, 3).join("; "));
  }
  // L'editor non tiene piu' una sua copia delle tangenti.
  const SG = require("./source-guard.js");
  const eeSrc = SG.codeOf(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"));
  assert("l'EnvelopeEditor disegna con envPath e legge il cursore con envValueAt",
    /PGEEnv\.envPath\(\s*exp\s*\)/.test(eeSrc) && /PGEEnv\.envValueAt\(\s*exp\b/.test(eeSrc));
  assert("…e non calcola tangenti per conto suo",
    !/function\s+emitGroup\b/.test(eeSrc) && !/1\s*\/\s*dL\s*\+\s*1\s*\/\s*dR/.test(eeSrc) &&
    !/m\[0\]\s*=\s*delta\[0\]/.test(eeSrc));
}

/* ── l'interp di un blocco compatto: il modello del motore (#191) ───────────
   Il motore non ha un interp per blocco. Lo slot 3 di un compatto e' una
   grafia del tipo GLOBALE: nella lista quello del primo blocco che ne
   dichiara uno (`extract_interp_type`), nel dict niente. L'editor lo legge
   cosi' (listInterp, unwrapEnv, expandMixed) e lo scrive cosi': l'interp di
   UN blocco va sui punti interni del suo pattern (setBlockInterp), il globale
   dove il motore lo legge (setGlobalInterp, wrapEnv). Che il motore suoni lo
   stesso lo chiedono test-envelope-eval-parity.js e
   test-envelope-wrap-parity.js. */
console.log("\n── l'interp di un blocco compatto (#191) ──");
{
  const PAT = [[0, 0], [50, 1], [100, 0]];
  assert("listInterp: lo slot 3 del primo blocco che ne dichiara uno",
    E.listInterp([[0, 0], [PAT, 0.5, 2], [PAT, 0.8, 2, "step"], [PAT, 1, 2, "cubic"]]) === "step");
  assert("…il blocco nudo stesso",
    E.listInterp([PAT, 1, 2, "cubic"]) === "cubic");
  assert("…null senza nessuno, e null su cio' che non e' una lista",
    E.listInterp([[0, 0], [PAT, 1, 2]]) === null && E.listInterp({ type: "cubic", points: [] }) === null &&
    E.listInterp([PAT, 1, 2, null, "exponential"]) === null);
  assert("unwrapEnv: la lista col globale del suo blocco",
    E.unwrapEnv([[0, 0], [PAT, 1, 2, "cubic"]]).interp === "cubic");
  assert("…il dict col suo type, e lineare senza, qualunque cosa dica un blocco",
    E.unwrapEnv({ type: "step", points: [[PAT, 1, 2, "cubic"]] }).interp === "step" &&
    E.unwrapEnv({ time_unit: "absolute", points: [[PAT, 1, 2, "cubic"]] }).interp === "linear");

  const L = E.envExpand([[0, 0], [0.2, 1], [PAT, 1, 2, "step"]]);
  assert("expandMixed: nella lista lo step del blocco vale anche per i punti nudi",
    L.points[0][2] === "step" && L.points[1][2] === "step" && L.globalInterp === "step");
  const D = E.envExpand({ type: "cubic", points: [[0, 0], [0.2, 1], [PAT, 1, 2, "step"]] });
  assert("…nel dict lo slot 3 non conta: il blocco segue il type",
    D.points.every((p) => p[2] === "cubic"), JSON.stringify(D.points.map((p) => p[2])));
  assert("…e il blocco dice l'interp che suona, e lo slot com'e' scritto",
    D.blocks[0].interp === "cubic" && D.blocks[0].rawInterp === "step");
  const T = E.envExpand({ type: "cubic", points: [[0, 0], [[[0, 0, "step"], [50, 1, "step"], [100, 0]], 1, 2]] });
  assert("…i tag del pattern sono l'interp del blocco, nelle due forme",
    T.blocks[0].interp === "step" &&
    E.envExpand([[0, 0], [[[0, 0, "step"], [50, 1, "linear"], [100, 0]], 1, 2]]).blocks[0].interp === "mixed");

  // blockInterp: i punti interni, l'ultimo no (il suo segmento esce dal ciclo)
  assert("blockInterp: l'ultimo punto del pattern non conta",
    E.blockInterp([[[0, 0, "step"], [50, 1, "step"], [100, 0, "cubic"]], 1, 2], "linear") === "step");
  assert("…senza tag e' il globale", E.blockInterp([PAT, 1, 2, "step"], "cubic") === "cubic");

  // setBlockInterp: un blocco fra altri item → tag sul pattern
  const items = [[0, 0], [0.2, 1], [PAT, 1, 2]];
  const r = E.setBlockInterp(items, 2, "step", "cubic", { dict: true });
  assert("setBlockInterp: i punti interni del pattern prendono il tag, l'ultimo no",
    eq(r.items[2][0], [[0, 0, "step"], [50, 1, "step"], [100, 0]]) && r.interp === "cubic",
    JSON.stringify(r));
  assert("…il resto non si tocca, slot 3 compreso",
    r.items[0] === items[0] && r.items[1] === items[1] && r.items[2].length === 3);
  const back = E.setBlockInterp(r.items, 2, "cubic", "cubic", { dict: true });
  assert("…e scegliere il globale toglie i tag: segue il globale",
    eq(back.items[2][0], PAT));
  const conUltimo = E.setBlockInterp([[0, 0], [[[0, 0], [50, 1], [100, 0, "step"]], 1, 2]], 1, "cubic", "linear");
  assert("…il tag dell'ultimo punto (il segmento in uscita) resta com'e'",
    eq(conUltimo.items[1][0], [[0, 0, "cubic"], [50, 1, "cubic"], [100, 0, "step"]]));
  // il blocco solo: il suo interp e' il globale
  const solo = E.setBlockInterp([[[[0, 0, "step"], [50, 1], [100, 0]], 1, 4]], 0, "cubic", "linear", { dict: false });
  assert("setBlockInterp sul blocco solo: cambia il globale, scritto nello slot 3",
    eq(solo.items, [[PAT, 1, 4, "cubic"]]) && solo.interp === "cubic", JSON.stringify(solo));
  const soloDict = E.setBlockInterp([[PAT, 1, 4]], 0, "step", "cubic", { dict: true });
  assert("…nel dict il globale e' il type: lo slot 3 non si aggiunge",
    eq(soloDict.items, [[PAT, 1, 4]]) && soloDict.interp === "step");
  const soloLin = E.setBlockInterp([[PAT, 1, 4]], 0, "linear", "cubic", { dict: false });
  assert("…e linear senza slot 3 resta senza", eq(soloLin.items, [[PAT, 1, 4]]) && soloLin.interp === "linear");

  // setGlobalInterp: lo slot 3 dichiarato segue il globale, quello assente resta assente
  const G = [[0, 0], [PAT, 0.5, 2, "cubic"], [PAT, 1, 2, "step"], [[[0, 1], [100, 0]], 1.5, 2]];
  const g2 = E.setGlobalInterp(G, "linear");
  assert("setGlobalInterp: ogni slot 3 dichiarato dice il globale nuovo",
    g2[1][3] === "linear" && g2[2][3] === "linear" && g2[3].length === 3 && g2[0] === G[0]);
  assert("…e niente da cambiare: lo stesso oggetto", E.setGlobalInterp(g2, "linear") === g2);

  // wrapEnv con un blocco: la forma che dice il globale
  const cp = (items, interp, like) => E.wrapEnv(E.resugarBPGroups(items, interp || "linear", like), interp, like);
  const rt = (x) => { const w = E.unwrapEnv(x); return cp(E.desugarBPGroups(w.items), w.interp, x); };
  const LISTA = [[0, 0], [0.2, 1], [PAT, 1, 2, "step"]];
  assert("wrapEnv: la lista che dice gia' il globale resta lista (niente migrazione)",
    eq(rt(LISTA), LISTA), JSON.stringify(rt(LISTA)));
  assert("…il blocco nudo cubico, aperto e committato, resta il blocco cubico",
    eq(rt([PAT, 1, 3, "cubic"]), [[PAT, 1, 3, "cubic"]]), JSON.stringify(rt([PAT, 1, 3, "cubic"])));
  const DICT = { type: "cubic", points: [[0, 0], [PAT, 1, 2, "step"]] };
  assert("…il dict resta dict, slot 3 ignorato compreso", eq(rt(DICT), DICT), JSON.stringify(rt(DICT)));
  assert("…una lista senza slot 3 col globale non lineare diventa dict",
    eq(E.wrapEnv([[0, 0], [PAT, 1, 2]], "cubic", [[0, 0], [PAT, 1, 2]]), { type: "cubic", points: [[0, 0], [PAT, 1, 2]] }));
  assert("…un dict portato a linear torna lista se la lista lo dice",
    eq(E.wrapEnv([[0, 0], [PAT, 1, 2]], "linear", { type: "cubic", points: [] }), [[0, 0], [PAT, 1, 2]]));
  assert("…e resta dict se la lista direbbe un altro globale",
    eq(E.wrapEnv([[0, 0], [PAT, 1, 2, "step"]], "linear", { type: "cubic", points: [] }),
       { type: "linear", points: [[0, 0], [PAT, 1, 2, "step"]] }));
  /* Togliere il blocco che nella lista dichiarava il globale non cambia il
     tipo di tutto il resto: l'editor tiene il globale, e il commit lo scrive
     nel dict. */
  const senza = E.desugarBPGroups(E.unwrapEnv(LISTA).items).slice(0, 2);
  assert("…togliere il blocco del globale non lo perde",
    eq(cp(senza, E.unwrapEnv(LISTA).interp, LISTA), { type: "step", points: [[0, 0], [0.2, 1]] }));

  // il blocco di "add loop": niente slot 3, segue il globale
  const nuovo = E.defaultCompactBlock([[0, 0.3]], null, null);
  assert("defaultCompactBlock: pattern, end_time e n_reps, niente slot 3",
    nuovo.length === 3, JSON.stringify(nuovo));
  assert("…aggiunto a una curva cubica, suona cubico come il resto",
    E.envExpand({ type: "cubic", points: [[0, 0.3], nuovo] }).blocks[0].interp === "cubic");

  // fmtCompact: lo slot 3 null davanti a una distribuzione resta al suo posto
  assert("fmtCompact: un interp null davanti alla distribuzione resta null",
    E.fmtCompact([PAT, 1, 2, null, "exponential"]) === "[[[0, 0], [50, 1], [100, 0]], 1, 2, null, 'exponential']",
    E.fmtCompact([PAT, 1, 2, null, "exponential"]));
  assert("…e si rilegge con la distribuzione nello slot 4",
    E.parseEnvLiteral(E.fmtCompact([PAT, 1, 2, null, "exponential"]))[4] === "exponential");

  /* insertPatternPoint: il punto che il doppio click mette dentro un loop.
     Da #191 l'interp di un blocco sono i tag dei punti del suo pattern
     (setBlockInterp), quindi un punto nuovo senza tag seguiva il globale: il
     doppio click su un blocco `step` dentro una curva cubica rendeva cubica la
     meta' del segmento dopo il punto, e il blocco `mixed`. Il punto prende il
     tipo del punto prima, come il breakpoint nudo inserito in una zona. */
  const STEP_PAT = [[0, 0, "step"], [50, 1, "step"], [100, 0]];
  const ins = E.insertPatternPoint(STEP_PAT, 25, 0.5);
  assert("insertPatternPoint: il punto va al suo posto in x, e torna l'indice",
    ins.index === 1 && ins.pattern.length === 4 && ins.pattern[1][0] === 25, JSON.stringify(ins));
  assert("…e prende il tag del punto prima: le due meta' del segmento restano step",
    eq(ins.pattern[1], [25, 0.5, "step"]), JSON.stringify(ins.pattern));
  assert("…cosi' il blocco resta step dentro la curva cubica",
    E.blockInterp([ins.pattern, 1, 2], "cubic") === "step");
  assert("…e il pattern di prima non si tocca (l'undo lo ritrova com'era)",
    eq(STEP_PAT, [[0, 0, "step"], [50, 1, "step"], [100, 0]]));
  assert("dopo un punto senza tag: niente tag, segue il globale come il segmento che spezza",
    eq(E.insertPatternPoint(PAT, 25, 0.5).pattern[1], [25, 0.5]));
  assert("dopo l'ultimo punto: ne prende il tag, cioe' il segmento in uscita che spezza",
    eq(E.insertPatternPoint([[0, 0], [80, 1, "step"]], 90, 0.2).pattern,
       [[0, 0], [80, 1, "step"], [90, 0.2, "step"]]));
  assert("prima del primo punto: nessun punto prima, nessun tag",
    eq(E.insertPatternPoint([[10, 0, "step"], [100, 1]], 5, 0.3),
       { pattern: [[5, 0.3], [10, 0, "step"], [100, 1]], index: 0 }));
  assert("un tag che non e' una stringa non si eredita",
    eq(E.insertPatternPoint([[0, 0, null], [100, 1]], 50, 0.5).pattern[1], [50, 0.5]));

  /* Il cablaggio nell'EnvelopeEditor, che in node non gira: il pannello del
     loop scrive l'interp per setBlockInterp, il selettore globale per
     setGlobalInterp ed e' visibile anche con un loop, i setter del pannello
     non dichiarano piu' uno slot 3 da soli. */
  const SG = require("./source-guard.js");
  const eeSrc = SG.codeOf(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"));
  assert("il pannello del loop scrive l'interp per setBlockInterp",
    /PGEEnv\.setBlockInterp\(\s*rawEnv\b/.test(eeSrc) && /onSetInterp=\{/.test(eeSrc));
  assert("il selettore globale scrive per setGlobalInterp",
    /commitWithInterp\(\s*PGEEnv\.setGlobalInterp\(\s*rawEnv\s*,/.test(eeSrc));
  assert("…ed e' visibile anche con un loop (nascosto solo dove il motore impone lo step)",
    /const showGlobalInterp\s*=\s*!interpIsFixed\s*;/.test(eeSrc));
  assert("i setter del pannello non dichiarano lo slot 3 da soli",
    !/interp\s*\|\|\s*"linear"\s*,\s*dist/.test(eeSrc) && !/cleanPat/.test(eeSrc));
  /* Il trascinamento di un punto del pattern ricostruiva il blocco con i soli
     slot 0..4 (`[newPattern, block.raw[1], …, block.raw[4]]`): perdeva `wrap`,
     lo slot 5, il difetto che #191 ha tolto ai setter del pannello e al menu
     del segmento. Il blocco si copia, e cambia solo il pattern. */
  const dragAt = eeSrc.indexOf("function startPatternDrag(");
  const drag = dragAt < 0 ? "" : eeSrc.slice(dragAt, eeSrc.indexOf("function startLoopEndDrag(", dragAt));
  assert("il trascinamento di un punto del pattern copia il blocco: nessuno slot si perde",
    drag.length > 0 && /block\.raw\.slice\(\)/.test(drag) && !/\braw\[[1-5]\]/.test(drag), drag.slice(-400));
  assert("…e nessun altro punto dell'editor ricostruisce un blocco elencandone gli slot",
    !/block\.raw\[3\]\s*,\s*block\.raw\[4\]/.test(eeSrc));
  const dbl = eeSrc.slice(eeSrc.indexOf("function onCanvasDblClick("),
    eeSrc.indexOf("function rescaleZoneItems("));
  assert("il doppio click dentro un loop inserisce il punto per insertPatternPoint (il tipo del punto prima)",
    /PGEEnv\.insertPatternPoint\(\s*pattern\b/.test(dbl) && !/\[\.\.\.pattern,\s*newPt\]/.test(dbl), dbl.slice(0, 200));
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
