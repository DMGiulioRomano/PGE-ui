/* =============================================================================
 * test-score-options.js — le opzioni di partitura che dal popover di render
 * arrivano ad argv, e in particolare l'interruttore `--bw` (PGE #248 /
 * issue #152): il preset di stampa in bianco e nero.
 *
 * Perché una suite di sole guardie sorgente: `--bw` non ha una grammatica da
 * specchiare (è un interruttore, non c'è un valore da sbagliare) né un filtro
 * da scrivere — a differenza di `--plot-envelopes` e `--magnify-at`, che
 * fanno uscire main.py con codice 1 e per questo hanno un mirror testato.
 * Quello che ha è una CATENA che passa per tre file che in node non girano
 * (RenderButton.jsx, app.jsx, server.py): la casella deve accendere un tweak,
 * il tweak deve entrare nel corpo della POST, e il corpo deve diventare il
 * flag. Se un anello salta il flag non parte e nessuno se ne accorge — il
 * render riesce lo stesso, semplicemente in colori. È lo stesso modo di
 * fallire che ha `--samples-dir`: silenzioso.
 *
 * La metà python della catena (corpo → argv) è in
 * tests/python/test_render_pipeline.py, dove il bridge si può davvero
 * chiamare; qui c'è la metà JSX, più il canarino sul motore.
 *
 * Run: node test-score-options.js (from tests/node/)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

const rbFile  = path.join(__dirname, "../../src/components/RenderButton.jsx");
const appFile = path.join(__dirname, "../../src/components/app.jsx");
const srvFile = path.join(__dirname, "../../server.py");

const rbSrc  = SG.codeOf(rbFile);
const appSrc = SG.codeOf(appFile);
const srvSrc = SG.codeOf(srvFile);      // python: `#` via, stringhe leggibili

/* Il gate è metà del contratto: `--bw` fuori dal blocco `visualize` sarebbe un
 * flag mandato a un render senza partitura, cioè un'argv che dice una cosa che
 * non succede. Cercarlo con un regex non basta — un `options.visualize ?`
 * qualunque, anche tre righe più su e già chiuso, farebbe verde.
 *
 * Si misura quindi sulle parentesi, e la stessa misura vale per le due metà
 * del file benché siano due linguaggi: profondità della riga maggiore di
 * quella del gate che la precede = dentro il suo blocco. Nel JSX il gate è
 * `{options.visualize ? (`, in `buildCommand` è `if (o.visualize)`; in
 * entrambi i casi la riga guardata sta una o più parentesi più a fondo, e
 * spostarla fuori pareggia le due profondità. */
function inGate(file, gate, needle) {
  const raw  = fs.readFileSync(file, "utf8");
  const code = SG.stripComments(raw);   // il needle si cerca senza commenti
  const mask = SG.maskLiterals(raw);    // la profondità sul mascherato
  const at = code.indexOf(needle);
  if (at < 0) return false;
  const gateAt = code.lastIndexOf(gate, at);
  if (gateAt < 0) return false;
  return SG.depthAt(mask, at) > SG.depthAt(mask, gateAt);
}

console.log("\n── popover: la casella esiste ed è dentro la partitura ──");
assert("RenderButton ha una riga per il preset b/n",
  /toggle\("bw"/.test(rbSrc),
  "nessuna casella nel popover: il preset resta irraggiungibile dall'editor");
assert("...e legge lo stato da options.bw",
  /options\.bw/.test(rbSrc));
assert("...ed è dentro il blocco `visualize`, come lente e voice offsets",
  inGate(rbFile, "options.visualize ?", 'toggle("bw"'),
  "la casella comparirebbe anche senza partitura, dove il flag non ha effetto");

console.log("\n── anteprima argv: mostra quello che parte ──");
assert("buildCommand stampa --bw", /parts\.push\("--bw"\)/.test(rbSrc),
  "l'anteprima direbbe un comando diverso da quello che il bridge esegue");
assert("...dentro il ramo o.visualize, come nel bridge",
  inGate(rbFile, "if (o.visualize)", 'parts.push("--bw")'));

console.log("\n── app.jsx: il tweak, il corpo della POST, il gate ──");
assert("l'opzione è persistita nei tweaks", /renderBw\b/.test(appSrc),
  "la scelta si perderebbe alla riapertura, a differenza delle altre");
assert("...letta e riscritta (entrambe le metà)",
  (appSrc.match(/renderBw\b/g) || []).length >= 2);
assert("il corpo della POST porta bw", /\bbw:/.test(appSrc),
  "senza questo la casella accende un tweak che nessuno legge");
assert("...solo con la partitura accesa",
  /\bbw:[^\n]*renderOptions\.visualize[^\n]*renderOptions\.bw/.test(appSrc),
  "il gate deve essere lo stesso di magnify/showVoiceOffsets");

console.log("\n── server.py: il corpo diventa argv ──");
/* Il bridge è testato davvero in pytest (corpo → argv, route inclusa); qui
 * basta l'anello: la chiave letta dal corpo e il kwarg passato al builder.
 * Anche questo passa da `codeOf`: da quando lo scanner sa leggere il python,
 * un anello commentato via non tiene più su la guardia. */
assert("il bridge legge bw dal corpo", /opts\.get\("bw"/.test(srvSrc));
assert("...e lo passa a build_render_command", /\bbw=bw\b/.test(srvSrc));

console.log("\n── canarino: il motore parsa ancora questo token ──");
/* `--bw` è inerte su un motore che non ce l'ha (la CLI parsa sys.argv a mano e
 * ignora i flag sconosciuti), quindi un rinomino a monte non rompe niente: fa
 * di peggio, lascia una casella che non fa nulla senza un solo test rosso.
 * Le tre uscite sono quelle delle fixture del motore (#132): salto legittimo
 * SOLO senza checkout, FAIL se il checkout c'è e il token no, e nessun salto
 * quando PGE_REQUIRE_ENGINE_FIXTURES=1 dice che il checkout è riuscito.
 *
 * Il salto va quindi appeso al CHECKOUT, non al singolo file: la CLI ha
 * cambiato casa due volte (`src/main.py` → `src/cli.py` → `src/pge/cli.py`,
 * PGE #162), e chiedere solo dell'ultimo indirizzo avrebbe rimesso in piedi
 * proprio la riga di mezzo della tabella — motore affiancato, sorgente
 * spostato, SKIP verde. I candidati sono quelli di
 * `engine_introspect.engine_supports_samples_dir`, dal più recente al più
 * vecchio, e nessuno di essi che esista è il FAIL che dice di aggiornare la
 * lista. */
const ENGINE_ROOT = path.resolve(process.env.PGE_ENGINE_ROOT
                                 || path.join(__dirname, "../../..", "PythonGranularEngine"));
const ENGINE_PRESENT = fs.existsSync(path.join(ENGINE_ROOT, "src"));
const CLI_CANDIDATES = [["src", "pge", "cli.py"], ["src", "cli.py"], ["src", "main.py"]]
  .map(parts => path.join(ENGINE_ROOT, ...parts));
const REQUIRE_ENGINE = process.env.PGE_REQUIRE_ENGINE_FIXTURES === "1";

if (ENGINE_PRESENT) {
  const found = CLI_CANDIDATES.filter(p => fs.existsSync(p));
  assert("i sorgenti della CLI del motore sono dove ce li si aspetta",
    found.length > 0,
    "nessuno di " + CLI_CANDIDATES.join(", ") + " esiste: la CLI ha cambiato "
    + "casa un'altra volta — aggiungi il nuovo indirizzo alla lista");
  if (found.length) {
    // Il token come lo scrive il motore, e nel codice: un `--bw` citato in un
    // commento o in una riga d'uso non è un flag che qualcuno parsa. Il
    // commento lo toglie lo scanner python di source-guard, non un regex per
    // riga: cosi' cade anche quello in coda a una riga di codice.
    const parses = found.some(p => /['"]--bw['"]\s+in\s+sys\.argv/.test(SG.codeOf(p)));
    assert("la CLI del motore parsa '--bw'", parses,
      "flag rinominato o rimosso a monte: la casella del popover non fa più nulla — "
      + "aggiorna il nome qui, in render_pipeline.py e in buildCommand "
      + "(RenderButton.jsx), non zittire la guardia");
  }
} else if (REQUIRE_ENGINE) {
  assert("checkout del motore presente (PGE_REQUIRE_ENGINE_FIXTURES=1)", false,
    "atteso " + path.join(ENGINE_ROOT, "src") + " — il checkout ha riportato "
    + "successo ma i sorgenti non sono lì");
} else {
  console.log(`  SKIP canarino --bw (nessun checkout del motore in ${ENGINE_ROOT})`);
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file: così
// una sezione appesa dopo continua a contare, invece di stampare FAIL e uscire
// 0. Il vincolo è verificato da test-suite-harness.js (#132).
process.on("exit", (code) => {
  console.log("\n──────────────────────────────────────────────────");
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
