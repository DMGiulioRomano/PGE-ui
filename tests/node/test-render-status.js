/* =============================================================================
 * test-render-status.js — pins the stale/fresh/never classification + summary
 * extracted from app.jsx to render-status.js (window.PGERenderStatus, #58).
 *
 * The fingerprint hash itself is covered by test-fingerprint.js; here we test the
 * decision built on top of it: classifyStream, summarize, statusForStream, and
 * that fingerprintAll just maps backend.fingerprintStream over the streams.
 *
 * Run: node test-render-status.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// render-status.js calls window.PGEBackend.fingerprintStream, so load backend.js
// first under the same minimal browser shims as test-fingerprint.js.
global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.reject(new Error("no network in test"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/render-status.js"), "utf8"));

const RS = window.PGERenderStatus;
const { fingerprintStream } = window.PGEBackend;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n── module surface ──");
assert("STATES present", RS.STATES && RS.STATES.FRESH === "fresh" && RS.STATES.STALE === "stale" &&
  RS.STATES.NEVER === "never" && RS.STATES.RUNNING === "running");
assert("TOOLTIPS present (5 strings)", RS.TOOLTIPS &&
  RS.TOOLTIPS.staleSemantics ===
    "the engine's reading of this YAML doesn't match this stem — re-render to update" &&
  RS.TOOLTIPS.running === "rendering this stream…" &&
  RS.TOOLTIPS.never === "this stream has never been rendered" &&
  RS.TOOLTIPS.fresh === "rendered and up-to-date with the YAML" &&
  RS.TOOLTIPS.stale === "YAML changed since last render — re-render to update");
for (const fn of ["fingerprintAll", "classifyStream", "staleReason", "summarize", "statusForStream"])
  assert(`exports ${fn}`, typeof RS[fn] === "function");

console.log("\n── classifyStream(lastFp, currentFp, hasStem) ──");
assert("null last → never",        RS.classifyStream(null, "x", true) === "never");
assert("empty-string last → never", RS.classifyStream("", "x", true) === "never");
assert("no stem → never",          RS.classifyStream("a", "b", false) === "never");
assert("last === current → fresh", RS.classifyStream("a", "a", true) === "fresh");
assert("last !== current → stale", RS.classifyStream("a", "b", true) === "stale");

console.log("\n── fingerprintAll(streams, format) ──");
{
  const s1 = { id: "s1", duration: 10, sample: "x.wav", density: 20 };
  const s2 = { id: "s2", duration: 5,  sample: "y.wav", density: 9 };
  const all = RS.fingerprintAll([s1, s2], "wav");
  assert("maps each stream id", Object.keys(all).sort().join(",") === "s1,s2");
  assert("s1 parity with fingerprintStream", all.s1 === fingerprintStream(s1, "wav"));
  assert("s2 parity with fingerprintStream", all.s2 === fingerprintStream(s2, "wav"));
  assert("threads the format through", RS.fingerprintAll([s1], "aiff").s1 === fingerprintStream(s1, "aiff"));
  assert("format actually matters", RS.fingerprintAll([s1], "wav").s1 !== RS.fingerprintAll([s1], "aiff").s1);
}

console.log("\n── summarize(streams, currentFps, lastRenderedFps, hasStem) ──");
{
  const streams = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const currentFps      = { a: "1", b: "2", c: "3", d: "4" };
  const lastRenderedFps = { a: "1", b: "X", /* c missing */ d: "4" };
  const hasStem = (id) => id !== "d"; // d rendered (last===cur) but stem gone → never
  const sum = RS.summarize(streams, currentFps, lastRenderedFps, hasStem);
  assert("counts {fresh:1,stale:1,never:2,total:4}",
    eq(sum, { fresh: 1, stale: 1, never: 2, total: 4 }), JSON.stringify(sum));
  assert("total is streams.length", RS.summarize([], {}, {}, () => true).total === 0);
}

console.log("\n── statusForStream(streamId, ctx) ──");
{
  const base = {
    currentFps:      { a: "1", b: "2", c: "3" },
    lastRenderedFps: { a: "1", b: "9" /* c missing */ },
    hasStem: (id) => id !== "z",
    running: false, currentStreamId: null, streamProgress: {},
  };
  assert("fresh", eq(RS.statusForStream("a", base), { state: "fresh", tooltip: RS.TOOLTIPS.fresh }));
  assert("stale", eq(RS.statusForStream("b", base), { state: "stale", tooltip: RS.TOOLTIPS.stale }));
  assert("never", eq(RS.statusForStream("c", base), { state: "never", tooltip: RS.TOOLTIPS.never }));

  const running = { ...base, running: true, currentStreamId: "a", streamProgress: { a: 0.42 } };
  assert("running with progress",
    eq(RS.statusForStream("a", running), { state: "running", progress: 0.42, tooltip: RS.TOOLTIPS.running }));

  const runningNoProg = { ...base, running: true, currentStreamId: "a", streamProgress: {} };
  assert("running progress defaults to 0",
    eq(RS.statusForStream("a", runningNoProg), { state: "running", progress: 0, tooltip: RS.TOOLTIPS.running }));

  // Running, but a *different* stream is current → falls through to classify.
  assert("running for other stream falls through to classify",
    eq(RS.statusForStream("b", running), { state: "stale", tooltip: RS.TOOLTIPS.stale }));
}

/* ---------------------------------------------------------------------------
 * L'asse "semantica" (#133).
 *
 * VARIATION_SEMANTICS_VERSION e' il numero con cui il motore dichiara COME
 * legge lo YAML. Entra nel fingerprint del motore e non in quello della UI, e
 * resta cosi': i due hash rispondono a domande diverse. Ma il pallino risponde
 * alla domanda del motore ("questo stem e' ancora buono?"), quindi la versione
 * e' un secondo asse di staleness accanto all'hash — non un campo dentro.
 *
 * La regola che tiene in piedi tutto il resto: ignoto da un lato = nessuna
 * pretesa. Un numero e' un'affermazione, l'assenza no. Senza questa regola
 * l'aggiornamento avrebbe marcato giallo ogni stem di ogni progetto gia'
 * renderizzato — non perche' fossero vecchi, ma perche' nessuno aveva ancora
 * registrato con quale semantica erano stati scritti.
 * ------------------------------------------------------------------------- */
console.log("\n── staleReason: due assi indipendenti ──");
{
  assert("yaml diverso → 'yaml', qualunque sia la semantica",
    RS.staleReason("a", "b", { rendered: 3, engine: 3 }) === "yaml");
  assert("yaml uguale e semantica uguale → null",
    RS.staleReason("a", "a", { rendered: 3, engine: 3 }) === null);
  assert("yaml uguale e semantica diversa → 'semantics'",
    RS.staleReason("a", "a", { rendered: 2, engine: 3 }) === "semantics");

  // I DUE IGNOTI NON SONO LO STESSO IGNOTO, e la differenza e' se il giallo si
  // possa poi spegnere.
  //
  // Motore ignoto: nessuna pretesa, e non per prudenza generica. `_persistSem`
  // scrive solo quando il numero si sa, quindi quel giallo non lo cancellerebbe
  // nessun re-render: sarebbe permanente su stem perfetti.
  assert("nessun sem → null (comportamento pre-#133 esatto)",
    RS.staleReason("a", "a", undefined) === null);
  assert("sem vuoto → null",
    RS.staleReason("a", "a", {}) === null);
  assert("motore ignoto (bridge giu', route assente) → null",
    RS.staleReason("a", "a", { rendered: 2, engine: null }) === null);
  assert("...anche senza versione dello stem: due ignoti non fanno un'asserzione",
    RS.staleReason("a", "a", { rendered: undefined, engine: null }) === null);

  // Versione dello stem assente ma motore noto: "semantics". E' lo stem scritto
  // prima che l'editor registrasse il numero — cioe' OGNI stem esistente quando
  // questo asse e' entrato, e il motore era gia' passato a 3 (PGE #222): sono
  // tutti stem che rifara' diversi. Tacere qui vuol dire essere ciechi proprio
  // nel caso per cui l'asse esiste.
  //
  // E questo giallo si spegne da solo: il motore emette `stream-done` anche per
  // gli stream che salta (`cached: true`), e backend.js registra la versione su
  // quell'evento come su un render vero. Un giro per progetto, una volta.
  assert("stem senza versione registrata, motore noto → 'semantics'",
    RS.staleReason("a", "a", { rendered: undefined, engine: 3 }) === "semantics");
  assert("...e vale anche col motore a 0 (il ramo non guarda il valore)",
    RS.staleReason("a", "a", { rendered: undefined, engine: 0 }) === "semantics");

  // `0` e' una versione come le altre: il guardiano e' `== null`, non falsiness.
  // Con `!rendered` uno stem a semantica 0 sarebbe stato indistinguibile da uno
  // senza versione, e sarebbe rimasto verde per sempre.
  assert("la versione 0 e' un numero, non un'assenza",
    RS.staleReason("a", "a", { rendered: 0, engine: 3 }) === "semantics");
  assert("...e concorda con se stessa",
    RS.staleReason("a", "a", { rendered: 0, engine: 0 }) === null);
}

// I quattro incroci, in un colpo: e' la tabella su cui la decisione e' stata
// presa, e tenerla come tabella rende visibile che i due `null` non sono lo
// stesso caso.
{
  const M = [
    // [rendered,   engine, atteso,        cosa e' nel mondo reale]
    [undefined,     3,      "semantics",   "stem reso prima di questo asse, motore a 3"],
    [2,             3,      "semantics",   "stem reso con semantica 2, motore a 3"],
    [3,             3,      null,          "stem reso con semantica 3, motore a 3"],
    [2,             null,   null,          "motore ignoto: il giallo sarebbe ineliminabile"],
  ];
  const bad = M.filter(([r, e, atteso]) =>
    RS.staleReason("a", "a", { rendered: r, engine: e }) !== atteso);
  assert("i quattro incroci rendered x engine",
    bad.length === 0,
    bad.map(([r, e, atteso, why]) =>
      `rendered=${r} engine=${e}: atteso ${atteso}, ottenuto ` +
      `${RS.staleReason("a", "a", { rendered: r, engine: e })} (${why})`).join("\n      "));
}

console.log("\n── classifyStream con l'asse semantica ──");
{
  assert("stem mai renderizzato resta 'never' anche a semantica diversa",
    RS.classifyStream(null, "x", true, { rendered: 2, engine: 3 }) === "never");
  assert("...e resta 'never' anche senza versione registrata",
    RS.classifyStream(null, "x", true, { rendered: undefined, engine: 3 }) === "never");
  assert("stem senza file su disco resta 'never'",
    RS.classifyStream("x", "x", false, { rendered: 2, engine: 3 }) === "never");
  assert("yaml fermo + bump del motore → 'stale'",
    RS.classifyStream("x", "x", true, { rendered: 2, engine: 3 }) === "stale");
  assert("yaml fermo + stessa semantica → 'fresh'",
    RS.classifyStream("x", "x", true, { rendered: 3, engine: 3 }) === "fresh");
  assert("senza sem, la firma a 3 argomenti si comporta come prima",
    RS.classifyStream("x", "x", true) === "fresh" &&
    RS.classifyStream("x", "y", true) === "stale");
}

console.log("\n── il pallino dice PERCHE' e' giallo ──");
{
  const ctx = {
    currentFps: { a: "1", b: "2", c: "3" },
    lastRenderedFps: { a: "1", b: "9", c: "3" },
    hasStem: () => true,
    running: false, currentStreamId: null, streamProgress: {},
    sem: { rendered: { a: 3, b: 3, c: 2 }, engine: 3 },
  };
  assert("yaml modificato → il testo di sempre",
    eq(RS.statusForStream("b", ctx), { state: "stale", tooltip: RS.TOOLTIPS.stale }));
  assert("motore cambiato a yaml fermo → il testo nuovo",
    eq(RS.statusForStream("c", ctx), { state: "stale", tooltip: RS.TOOLTIPS.staleSemantics }));
  assert("niente da dire → fresh",
    eq(RS.statusForStream("a", ctx), { state: "fresh", tooltip: RS.TOOLTIPS.fresh }));

  // Il conteggio aggregato deve vedere lo stesso stem giallo che vede il
  // pallino: sono due funzioni, e la coppia { rendered, engine } la estrae una
  // sola (semFor). Se divergessero, il riepilogo direbbe "3 rendered" mentre
  // tre pallini su cinque sono gialli.
  const streams = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert("summarize concorda con statusForStream",
    eq(RS.summarize(streams, ctx.currentFps, ctx.lastRenderedFps, ctx.hasStem, ctx.sem),
       { fresh: 1, stale: 2, never: 0, total: 3 }));
  assert("senza sem, summarize conta come prima di #133",
    eq(RS.summarize(streams, ctx.currentFps, ctx.lastRenderedFps, ctx.hasStem),
       { fresh: 2, stale: 1, never: 0, total: 3 }));
}

/* ---------------------------------------------------------------------------
 * Guardie sul sorgente: la catena che porta il numero dal motore al pallino.
 * Nessuna di queste righe gira in node (sono React / fetch), e ognuna e' un
 * anello che, se salta, spegne l'asse in silenzio — il pallino torna verde e
 * nessun test se ne accorge.
 * ------------------------------------------------------------------------- */
console.log("\n── la catena dal motore al pallino ──");
{
  const backendSrc = fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");

  assert("backend chiede la versione al bridge",
    /GET \/semantics-version|"\/semantics-version"/.test(backendSrc),
    "semanticsVersion() non chiama piu' la route: il numero non arriva");
  assert("backend espone semanticsVersion",
    /semanticsVersion\s*[,}]/.test(backendSrc));
  /* Col numero ignoto la voce si CANCELLA, in tutti e due i posti che la
   * tengono. Saltare la scrittura lascerebbe in piedi la versione di un render
   * precedente: uno stem appena reso, con il bridge senza route, resterebbe
   * marcato `2` e diventerebbe giallo appena il numero si sapesse. Assente vuol
   * dire "non lo so", che e' la verita'. */
  assert("backend cancella la voce quando il numero e' ignoto",
    /if \(sem === null\) delete next\[id\];/.test(backendSrc),
    "saltare la scrittura lascia in piedi una versione vecchia su uno stem nuovo");
  assert("...e app.jsx fa lo stesso nello stato vivo",
    /delete next\[e\.streamId\];/.test(appSrc));

  /* Il fallimento della fetch non si memorizza: le altre due letture del motore
   * al massimo nascondono un filtro, questa decide un pallino, e un bridge giu'
   * al boot condannerebbe la sessione a mostrare verde anche dopo che e'
   * tornato su. Un `null` che ARRIVA dal bridge e' invece una risposta. */
  {
    // Guardia sull'invariante, non sulla forma: dentro il `catch` di
    // `semanticsVersion` non deve comparire un'assegnazione a `_semantics`.
    // Memorizzare il fallimento spegne l'asse fino al reload della pagina.
    const fn = backendSrc.slice(backendSrc.indexOf("async function semanticsVersion"));
    const cat = fn.slice(fn.indexOf("} catch"), fn.indexOf("} catch") + 700);
    assert("un bridge irraggiungibile non si ricorda per tutta la sessione",
      !/_semantics\s*=/.test(cat) && /return null;/.test(cat),
      cat.slice(0, 200));
  }

  assert("backend registra la semantica insieme ai fingerprint",
    /_persistSem\(/.test(backendSrc) && /loadSemantics\(/.test(backendSrc),
    "senza persistenza l'asse si spegne al reload della pagina");
  assert("...e la scrive dopo un render, non solo la legge",
    /await semanticsVersion\(\)[\s\S]{0,600}_persistSem\(/.test(backendSrc),
    "run() non registra la versione: ogni stem resta senza, per sempre");

  assert("app legge la versione del motore al boot",
    /semanticsVersion\(\)[\s\S]{0,120}setEngineSem/.test(appSrc));
  assert("app carica le versioni registrate al cambio progetto",
    /loadSemantics\([\s\S]{0,120}?setRenderedSem/.test(appSrc));
  // Regex lasca sullo spazio: le righe sono lunghe e una riformattazione non
  // deve farle rosse. Cio' che conta e' che lo stato vivo venga aggiornato
  // sull'evento del singolo stream, leggendo il REF e non lo stato.
  assert("app aggiorna la versione dello stem appena reso",
    /setLastRenderedFps/.test(appSrc) &&
    /setRenderedSem\([\s\S]{0,300}?engineSemRef\.current[\s\S]{0,200}?e\.streamId\]/.test(appSrc),
    "senza questa riga uno stem appena renderizzato torna giallo subito");
  assert("...leggendo il ref, non lo stato catturato quando onRender fu definita",
    !/setRenderedSem\([\s\S]{0,300}?\[e\.streamId\]:\s*engineSem\b/.test(appSrc),
    "gli stream-done arrivano dentro un await gia' in volo: lo stato li' e' " +
    "quello di prima della rilettura che onRender fa all'inizio");

  /* La versione del motore si richiede in TRE punti, e questa e' la guardia che
   * tiene in vita l'asse. Con la sola chiamata al boot — effetto con dipendenze
   * vuote, e `serverDown` che non torna mai a falso senza reload — chi apre
   * l'editor prima di lanciare `make serve` resta senza asse per tutta la
   * sessione: `staleReason` esce dal ramo `engine == null` e nessun pallino lo
   * dice, mentre backend.js continua a REGISTRARE la versione a ogni render. */
  assert("app richiede la versione del motore in tre punti, non solo al boot",
    (appSrc.match(/refreshEngineSem\(\)/g) || []).length >= 3,
    "boot, cambio progetto e inizio render: con uno solo l'asse muore " +
    "silenziosamente quando il bridge parte dopo l'editor");
  assert("...e il render l'aspetta prima di partire",
    /await refreshEngineSem\(\);/.test(appSrc),
    "senza await gli stream-done possono trovare il ref ancora vuoto");
  assert("app passa la coppia a entrambi i consumatori",
    /summarize\([^)]*semCtx\)/.test(appSrc) && /sem: semCtx,/.test(appSrc),
    "riepilogo e pallini leggerebbero dati diversi sullo stesso stem");
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
