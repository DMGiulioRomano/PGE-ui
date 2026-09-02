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
const SG   = require("./source-guard.js");

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
  // Il corpus e' cablato qui sopra, quindi svuotarlo lascerebbe l'etichetta a
  // dire «i quattro incroci» su zero confronti. Una riga davanti al ciclo.
  assert("la tabella degli incroci ha davvero quattro righe", M.length === 4,
    `${M.length}`);
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
  const backendSrc = SG.codeOf(path.join(__dirname, "../../src/lib/backend.js"));
  const appSrc = SG.codeOf(path.join(__dirname, "../../src/components/app.jsx"));

  /* Il ramo `GET \/semantics-version` dell'alternanza che c'era qui era una
     tautologia: nel sorgente la route compare solo come stringa, quindi quel
     ramo poteva matchare unicamente un commento — e con il sorgente letto
     grezzo bastava un commento di rimando a tenere verde la guardia dopo che
     la chiamata era sparita. */
  assert("backend chiede la versione al bridge",
    /"\/semantics-version"/.test(backendSrc),
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
    /* Guardie sull'invariante, non sulla forma. Il COMPORTAMENTO e' eseguito in
       test-semantics-store.js (fetch finta che cambia versione fra due
       chiamate); qui si pretende cio' che lo rende vero anche dopo una
       riscrittura, e che di qui non si vede: la lettura deve poter essere una
       RILETTURA — senza, un bump del motore sotto la sessione non arriva mai al
       pallino — e la cella deve prendere esattamente cio' che la lettura
       restituisce, fallimento compreso, o app.jsx (che rilegge prima del
       render) e run() (che legge la cella in fondo) registrerebbero versioni
       diverse dello stesso giro. */
    const fn = backendSrc.slice(backendSrc.indexOf("async function semanticsVersion"),
                                backendSrc.indexOf("// Eagerly pull config"));
    assert("la lettura della versione puo' essere una rilettura",
      /async function semanticsVersion\(opts\)/.test(fn) &&
      /opts\.refresh/.test(fn) && /_semantics !== undefined/.test(fn),
      fn.slice(0, 200));
    const cat = fn.slice(fn.indexOf("} catch"));
    assert("la cella prende cio' che la lettura restituisce, fallimento compreso",
      /_semantics = v;/.test(fn) && /return v;/.test(fn) && !/return/.test(cat.slice(0, cat.indexOf("}", cat.indexOf("{")))),
      cat.slice(0, 200));
  }

  assert("backend registra la semantica insieme ai fingerprint",
    /_persistSem\(/.test(backendSrc) && /loadSemantics\(/.test(backendSrc),
    "senza persistenza l'asse si spegne al reload della pagina");
  assert("...e la scrive dopo un render, non solo la legge",
    /await semanticsVersion\(\)[\s\S]{0,600}_persistSem\(/.test(backendSrc),
    "run() non registra la versione: ogni stem resta senza, per sempre");

  assert("app legge la versione del motore al boot, e la RILEGGE",
    /semanticsVersion\(\{\s*refresh:\s*true\s*\}\)[\s\S]{0,200}setEngineSem/.test(appSrc));
  assert("app carica le versioni registrate al cambio progetto",
    /loadSemantics\([\s\S]{0,120}?setRenderedSem/.test(appSrc));
  // Regex lasca sullo spazio: le righe sono lunghe e una riformattazione non
  // deve farle rosse. Cio' che conta e' che lo stato vivo venga aggiornato
  // sull'evento del singolo stream, leggendo il REF e non lo stato.
  assert("app aggiorna la versione dello stem appena reso",
    /setLastRenderedFps/.test(appSrc) &&
    /setRenderedSem\([\s\S]{0,300}?semOfThisRun[\s\S]{0,200}?e\.streamId\]/.test(appSrc),
    "senza questa riga uno stem appena renderizzato torna giallo subito");
  assert("...leggendo il numero fissato per QUESTO giro, non una cella condivisa",
    !/setRenderedSem\([\s\S]{0,300}?\[e\.streamId\]:\s*engineSem\b/.test(appSrc) &&
    !/setRenderedSem\([\s\S]{0,300}?engineSemRef\.current/.test(appSrc),
    "lo stato e' quello di prima della rilettura che runRender fa all'inizio; " +
    "il ref invece lo riscrive chiunque rilegga, render in volo compreso — " +
    "e i tre punti di rilettura non sono esclusivi col render in corso");

  /* La versione del motore si richiede in TRE punti, e questa e' la guardia che
   * tiene in vita l'asse. Con la sola chiamata al boot — effetto con dipendenze
   * vuote, e `serverDown` che non torna mai a falso senza reload — chi apre
   * l'editor prima di lanciare `make serve` resta senza asse per tutta la
   * sessione: `staleReason` esce dal ramo `engine == null` e nessun pallino lo
   * dice, mentre backend.js continua a REGISTRARE la versione a ogni render. */
  // `refreshEngineSem()` compare 4 volte per 3 chiamate: la quarta e' la
  // definizione (`async function refreshEngineSem() {`). Con `>= 3` la guardia
  // passava con DUE call site — e due sono gia' l'asse mezzo spento.
  assert("app richiede la versione del motore in tre punti, non solo al boot",
    (appSrc.match(/(?<!function )refreshEngineSem\(\)/g) || []).length >= 3,
    "boot, cambio progetto e inizio render: con uno solo l'asse muore " +
    "silenziosamente quando il bridge parte dopo l'editor");
  assert("...e il render l'aspetta prima di partire",
    /await refreshEngineSem\(\);/.test(appSrc),
    "senza await gli stream-done possono trovare il ref ancora vuoto");

  /* ...ma quell'attesa non deve stare dentro la finestra della guardia di
   * rientro, ed e' l'unico posto in cui questa PR ha allargato una finestra
   * invece di chiuderla. `jget` ha un timeout di 10 s: con l'`await` fra la
   * guardia e l'alzata dello stato, un secondo ingresso (la scorciatoia `r`, o
   * `r` piu' click) passava anche lui, e due `run()` in volo si contendono
   * l'unico `cancelAbort` di backend.js — Cancel ne ucciderebbe uno solo.
   *
   * Due guardie distinte perche' i difetti sono due:
   *   - la guardia deve stare su un REF, non sullo stato: l'effetto della
   *     scorciatoia ha dipendenze `[dirty]`, quindi chiude su un `onRender`
   *     vecchio; riordinare le setState non lo raggiunge nemmeno.
   *   - lo stato deve alzarsi PRIMA dell'attesa, o l'utente non vede niente
   *     (log, toast, bottone) finche' il bridge non risponde. */
  {
    const entry = appSrc.slice(appSrc.indexOf("async function onRender()"),
                               appSrc.indexOf("async function runRender()"));
    assert("la guardia di rientro del render si alza su un ref, prima di ogni await",
      /renderingRef\.current\) return;/.test(entry) &&
      entry.indexOf("renderingRef.current = true") < entry.indexOf("await"),
      entry);
    assert("...e si riabbassa in un finally",
      /finally\s*\{\s*renderingRef\.current = false;/.test(entry), entry);

    const body = appSrc.slice(appSrc.indexOf("async function runRender()"));
    const raise = body.indexOf("setRenderStatus({ running: true");
    const wait  = body.indexOf("await refreshEngineSem()");
    assert("lo stato di render si alza prima dell'attesa, non dopo",
      raise >= 0 && wait >= 0 && raise < wait,
      `setRenderStatus a ${raise}, await a ${wait}: col timeout di 10 s di jget ` +
      `un click su Render non produce feedback per dieci secondi`);
  }
  assert("app passa la coppia a entrambi i consumatori",
    /summarize\([^)]*semCtx\)/.test(appSrc) && /sem: semCtx,/.test(appSrc),
    "riepilogo e pallini leggerebbero dati diversi sullo stesso stem");
}

/* ── un solo run() per volta, e pretesa eseguendo ──────────────────────────
 *
 * `cancelAbort` in backend.js e' UNA variabile di chiusura: con due `run()`
 * in volo il secondo la sovrascrive, `cancel()` ne uccide uno solo e l'altro
 * resta a scrivere stem senza piu' un modo di fermarlo. Due POST /render
 * scrivono anche lo stesso `configs/<basename>.yml`.
 *
 * Il fix precedente ha chiuso il rientro nel CHIAMANTE (`renderingRef` in
 * app.jsx, pinnato qui sopra), che e' il posto giusto per i due ingressi
 * della UI — bottone e scorciatoia `r` sono un problema di app.jsx. Ma
 * lasciava l'invariante a vivere in un file e a essere subita da un altro,
 * senza niente che la pretendesse: `run()` accettava una seconda entrata in
 * silenzio. Qui si pretende dal file che la subisce, e si pretende
 * ESEGUENDO — due run() sovrapposti davvero, e si guarda chi muore quando si
 * preme Cancel.
 *
 * La sezione e' asincrona e sta PRIMA della registrazione dell'handler:
 * l'handler si registra sincronamente, il loop resta vivo per i timer di
 * `tick`/`withTimeout`, quindi il riepilogo si stampa dopo che questi assert
 * hanno contato. `withTimeout` c'e' perche' un'attesa che non si chiude qui
 * sarebbe un job in timeout invece di un verdetto: il modo peggiore di
 * rompersi. */
let reentrancyDone = false;
(async () => {
  console.log("\n── un solo run() per volta, dentro backend.js ──");

  const tick = () => new Promise(r => setTimeout(r, 0));
  function withTimeout(p, why, ms = 5000) {
    let t;
    return Promise.race([
      p.finally(() => clearTimeout(t)),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(why)), ms); }),
    ]);
  }

  // fetch finta: /render resta appesa finche' non la si annulla, cosi' due
  // run() possono davvero sovrapporsi invece di accodarsi.
  let renderPosts = 0, cancelPosts = 0;
  global.fetch = (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/render")) {
      renderPosts++;
      return new Promise((_, reject) => {
        const sig = init.signal;
        const die = () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); };
        if (!sig) return;                       // niente signal: resta appesa
        if (sig.aborted) die(); else sig.addEventListener("abort", die);
      });
    }
    if (u.endsWith("/render/cancel")) { cancelPosts++; return Promise.resolve({ ok: true }); }
    return Promise.reject(new Error("no network in test"));
  };

  const be = window.PGEBackend.create({ baseUrl: "http://test" });
  const opts = { yamlBasename: "proj", streams: [], outputFormat: "wav" };

  const ev2 = [];
  const p1 = be.render.run(opts, () => {});
  await tick();
  /* `withTimeout` anche qui, e non e' cintura in piu': SENZA la guardia questa
     attesa non finisce (il secondo run() fa il POST e la fetch finta resta
     appesa), il processo non ha piu' timer, node esce 0 e l'handler stampa il
     riepilogo con gli assert di questa sezione mai contati — verde. Il
     sabotaggio che deve provare la guardia la farebbe SPARIRE invece che
     fallire: e' il salto silenzioso di #133 dentro la suite che lo condanna.
     Cosi' invece diventa un fallimento con un nome. */
  const r2 = await withTimeout(be.render.run(opts, e => ev2.push(e)),
    "il secondo run() non e' tornato: la guardia di rientro non c'e', " +
    "e i due giri stanno scrivendo gli stessi stem");

  assert("il secondo run() e' rifiutato mentre il primo e' in volo",
    r2 && r2.ok === false && /already in progress/.test(r2.error || ""),
    JSON.stringify(r2));
  assert("...e non ha fatto il POST", renderPosts === 1,
    `POST /render: ${renderPosts} — il secondo giro riscriverebbe lo stesso ` +
    `configs/<basename>.yml e gli stessi stem del primo`);
  assert("...ne' dichiara scritto un config che non ha scritto",
    r2.configWritten === false,
    "col campo assente il chiamante legge `!== false` e spegne l'avviso di " +
    "migrazione di `dephase` per un render che non e' mai partito");
  assert("...e non emette `done`, che spegnerebbe la UI del render in volo",
    ev2.every(e => e.type !== "done") && ev2.some(e => e.type === "log"),
    JSON.stringify(ev2));

  // Il danno vero che la guardia impedisce: senza, il secondo giro avrebbe
  // preso `cancelAbort` e Cancel avrebbe ucciso lui, lasciando il primo a
  // scrivere. Qui Cancel deve raggiungere il giro che e' davvero in volo.
  be.render.cancel();
  const r1 = await withTimeout(p1, "il primo run() non risponde a cancel()");
  assert("Cancel raggiunge il render che e' davvero in volo",
    r1 && r1.ok === false && r1.error === "cancelled", JSON.stringify(r1));
  assert("...e il POST di annullamento parte una volta sola", cancelPosts === 1,
    `POST /render/cancel: ${cancelPosts}`);

  // La guardia deve riabbassarsi, o il primo render della sessione sarebbe
  // anche l'ultimo. Si riabbassa nel `finally`, quindi anche sul ramo di
  // errore — che e' quello appena percorso.
  const p3 = be.render.run(opts, () => {});
  await tick();
  assert("la guardia si riabbassa: dopo il primo giro un run() nuovo parte",
    renderPosts === 2,
    `POST /render: ${renderPosts} — con la guardia alzata per sempre il ` +
    `bottone Render resterebbe muto per il resto della sessione`);
  be.render.cancel();
  await withTimeout(p3, "il run() di verifica non si chiude");

  // ...e nel MEDESIMO finally di `cancelAbort`, che il ramo di successo qui
  // non percorre: le due variabili descrivono lo stesso giro e devono morire
  // insieme, o una `return` sul percorso buono lascerebbe la guardia alzata.
  assert("`running` si riabbassa nello stesso finally che azzera `cancelAbort`",
    /finally\s*\{\s*cancelAbort = null;\s*running = false;\s*\}/
      .test(SG.codeOf(path.join(__dirname, "../../src/lib/backend.js"))),
    "separarli fa vivere la guardia piu' del giro che descrive");

  reentrancyDone = true;
})().catch(e => {
  /* Un'eccezione qui non deve tornare a essere un'uscita muta: senza questo
     catch e' una unhandled rejection, e il riepilogo direbbe "0 failed" sotto
     uno stack trace. */
  fail++;
  console.error("FAIL  la sezione sul rientro e' morta a meta'\n      " +
    (e && e.message ? e.message : String(e)));
});

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  // La sezione sul rientro e' asincrona: se il loop si svuota prima che sia
  // arrivata in fondo, i suoi assert non hanno contato e il riepilogo sarebbe
  // verde su un confronto mai avvenuto. Qui non puo' sparire in silenzio.
  if (!reentrancyDone) {
    fail++;
    console.error("FAIL  la sezione sul rientro non e' arrivata in fondo: " +
      "i suoi assert non hanno contato");
  }
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
