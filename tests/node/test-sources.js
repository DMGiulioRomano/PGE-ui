/* =============================================================================
 * test-sources.js — il gate statico sui sorgenti dell'editor.
 *
 * Questo repo non ha build step, ne' linter, ne' typecheck: i `.jsx` li
 * traspila Babel NEL BROWSER, a runtime, e i `.js` di `src/lib/` sono script
 * classici caricati a mano da `PGE Editor.html`. Conseguenza: una virgola
 * sbagliata in EnvelopeEditor.jsx (2.300 righe) non fa fallire niente in CI —
 * si manifesta come pagina bianca, e la sola diagnosi e' la console del
 * browser. Le altre guardie della suite leggono questi file come TESTO
 * (guardie sorgente a regex), quindi restano verdi su un file che non gira.
 *
 * Quattro domande, tutte statiche:
 *
 *   1. ogni sorgente PARSA — `src/lib/*.js` come script classico,
 *      `src/components/*.jsx` come script classico piu' JSX, cioe' lo stesso
 *      dialetto che riceve il browser;
 *   2. il CENSIMENTO fra HTML e filesystem torna: ogni file e' caricato, una
 *      volta sola, e nessuno `<script>` punta a un file che non c'e';
 *   3. l'ORDINE ha la forma documentata in CLAUDE.md — vendor, poi `src/lib/`,
 *      poi `src/components/`, con `app.jsx` ultimo;
 *   4. la CATENA DI DIPENDENZE e' rispettata: cio' che un file legge da
 *      `window.*` al caricamento dev'essere gia' stato definito da uno script
 *      precedente.
 *
 * Il punto 4 e' DERIVATO dal sorgente, non da una tabella `{file: [deps]}`
 * scritta qui. Una tabella sarebbe una seconda copia della verita': chi
 * aggiunge una dipendenza non la aggiorna, e la guardia diventa muta proprio
 * mentre l'ordine sta per rompersi. E' la stessa ragione per cui in questo repo
 * nessuna costante del motore e' piu' trascritta a mano.
 *
 * Limite dichiarato del punto 4: "al caricamento" significa il corpo del
 * modulo piu' quello delle IIFE — che e' la forma di ogni file di `src/lib/` —
 * non il corpo di una funzione dichiarata li' e chiamata subito dopo. Una
 * dipendenza nascosta cosi' non viene vista. E' un falso negativo, cioe' la
 * direzione sicura: la guardia non inventa fallimenti, ne perde qualcuno.
 *
 * Run: node test-sources.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs     = require("fs");
const path   = require("path");
const parser = require("@babel/parser");
const SG     = require("./source-guard.js");

const REPO       = path.join(__dirname, "../..");
const LIB_DIR    = path.join(REPO, "src/lib");
const COMP_DIR   = path.join(REPO, "src/components");
const HTML_PATH  = path.join(REPO, "PGE Editor.html");

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

/* `readdirSync` su un path sbagliato LANCIA, e il modo realistico di avere zero
 * file e' proprio quello: senza questo catch il file usciva prima dell'assert
 * che nomina il caso, quindi quel ramo era irraggiungibile. */
function sourcesIn(dir, ext) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith(ext)).sort();
  } catch (e) {
    console.error("      " + e.message);
    return [];
  }
}

const libFiles  = sourcesIn(LIB_DIR, ".js");
const compFiles = sourcesIn(COMP_DIR, ".jsx");

/* ============================================================
 * 1 — ogni sorgente parsa
 * ============================================================ */

console.log(`\n── ${libFiles.length + compFiles.length} sorgenti parsano ──`);

// Zero file e' un fallimento, non un verde: significa che il path e' sbagliato.
assert("src/lib/ contiene sorgenti", libFiles.length > 0, "path sbagliato?");
assert("src/components/ contiene sorgenti", compFiles.length > 0, "path sbagliato?");

/** L'AST di un sorgente, o `null` con il fallimento gia' registrato. */
function parseSource(dir, file, plugins) {
  try {
    // Stesso dialetto che riceve il browser: script classici (window globals,
    // niente moduli — vedi "File layout & load order" in CLAUDE.md).
    const ast = parser.parse(fs.readFileSync(path.join(dir, file), "utf8"), {
      sourceType: "script",
      plugins,
    });
    pass++; console.log("  OK  " + file);
    return ast;
  } catch (e) {
    fail++; console.error("FAIL  " + file + "\n      " + e.message);
    return null;
  }
}

const asts = new Map();   // "src/lib/x.js" -> AST
for (const f of libFiles)  asts.set("src/lib/" + f,        parseSource(LIB_DIR, f, []));
for (const f of compFiles) asts.set("src/components/" + f, parseSource(COMP_DIR, f, ["jsx"]));

/* ============================================================
 * 2 — il censimento fra HTML e filesystem
 *
 * Un componente nuovo, valido, che nessuno ha aggiunto all'HTML semplicemente
 * non esiste a runtime: `window.PGE*` resta undefined e l'editor si rompe dove
 * lo usa. CLAUDE.md lo dice ("A new JSX file must be added to PGE Editor.html"),
 * e restava prosa. Il verso opposto conta uguale: uno `<script>` che punta a un
 * file rinominato e' una 404 che il browser non urla abbastanza forte.
 * ============================================================ */

console.log("\n── censimento: HTML ↔ filesystem ──");

// `codeOf` toglie i commenti: uno <script> dentro <!-- --> non carica niente.
const html = SG.codeOf(HTML_PATH);
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/g)].map(m => m[1]);

assert("PGE Editor.html dichiara degli <script>", scripts.length > 0, "nessuno trovato");

const isVendor = (src) => /^https?:\/\//.test(src);
const localScripts = scripts.filter(s => !isVendor(s));
const onDisk = libFiles.map(f => "src/lib/" + f).concat(compFiles.map(f => "src/components/" + f));

{
  const missing = onDisk.filter(f => !localScripts.includes(f));
  assert(`ogni sorgente e' caricato da PGE Editor.html (${onDisk.length})`,
    missing.length === 0,
    "questi non compaiono nell'HTML, quindi a runtime non esistono: " + missing.join(", "));
}
{
  // Il querystring e' legittimo sui CSS di questo repo (`render-ui.css?v=2`):
  // se un giorno arriva su uno <script>, il file va cercato senza.
  const ghosts = localScripts.filter(s => !fs.existsSync(path.join(REPO, s.split("?")[0])));
  assert("nessuno <script> punta a un file che non c'e'", ghosts.length === 0,
    "l'HTML li carica ma sul disco non ci sono: " + ghosts.join(", "));
}
{
  const seen = new Set(), dupes = [];
  for (const s of scripts) { if (seen.has(s)) dupes.push(s); else seen.add(s); }
  assert("nessuno <script> compare due volte", dupes.length === 0,
    "caricati due volte: " + dupes.join(", "));
}

/* ============================================================
 * 3 — la forma dell'ordine
 *
 * Vendor, poi src/lib/, poi src/components/, con app.jsx ultimo. Non e' solo
 * estetica: `app.jsx` e' l'unico file che fa il boot (`ReactDOM.createRoot`),
 * quindi tutto cio' che monta dev'essere gia' stato definito.
 * ============================================================ */

console.log("\n── forma dell'ordine di caricamento ──");

const phaseOf = (src) => isVendor(src) ? 0 : src.startsWith("src/lib/") ? 1 : 2;
{
  const phases = scripts.map(phaseOf);
  const back = [];
  for (let i = 1; i < phases.length; i++) {
    if (phases[i] < phases[i - 1]) back.push(`${scripts[i]} dopo ${scripts[i - 1]}`);
  }
  assert("vendor, poi src/lib/, poi src/components/", back.length === 0,
    "queste coppie tornano indietro di fase: " + back.join("; "));
}
assert("app.jsx e' l'ultimo script",
  scripts.length > 0 && scripts[scripts.length - 1] === "src/components/app.jsx",
  "ultimo: " + scripts[scripts.length - 1] +
  " — e' app.jsx a fare ReactDOM.createRoot, quindi monta cio' che non c'e' ancora");

/* ============================================================
 * 4 — la catena di dipendenze, derivata dal sorgente
 * ============================================================ */

console.log("\n── dipendenze a tempo di caricamento ──");

const FN_NODES = new Set([
  "FunctionExpression", "FunctionDeclaration", "ArrowFunctionExpression",
  "ObjectMethod", "ClassMethod", "ClassPrivateMethod",
]);
const SKIP_KEYS = new Set([
  "loc", "range", "start", "end", "leadingComments", "trailingComments",
  "innerComments", "extra",
]);

/** `window.<Nome>`, scritto cosi' e non calcolato. */
function windowMember(n) {
  return n && n.type === "MemberExpression" && !n.computed &&
    n.object && n.object.type === "Identifier" && n.object.name === "window" &&
    n.property && n.property.type === "Identifier";
}

/**
 * I nomi che un file DEFINISCE su `window` e quelli che ne LEGGE al
 * caricamento.
 *
 * "Al caricamento" = corpo del modulo, piu' quello di ogni funzione invocata
 * sul posto (`(function(){…})()`, la forma di ogni file di src/lib/). Il corpo
 * di una funzione che qualcun altro chiamera' dopo non conta: li' l'ordine
 * degli <script> e' gia' irrilevante.
 *
 * `window.PGE.Timeline = …` conta come LETTURA di `PGE`, non come definizione:
 * quel namespace dev'essere gia' li' — ed e' esattamente la dipendenza di ogni
 * componente da primitives.jsx.
 */
function scanWindowUse(ast) {
  const defines = new Set(), reads = new Set();
  (function walk(node, eager, parent, key) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, eager, parent, key); return; }
    if (!node.type) return;

    if (node.type === "AssignmentExpression" && windowMember(node.left)) {
      defines.add(node.left.property.name);
      walk(node.right, eager, node, "right");
      return;
    }
    if (windowMember(node)) { if (eager) reads.add(node.property.name); return; }

    let childEager = eager;
    if (FN_NODES.has(node.type)) {
      const invokedHere = parent && parent.type === "CallExpression" && key === "callee";
      childEager = eager && !!invokedHere;
    }
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (v && typeof v === "object") walk(v, childEager, node, k);
    }
  })(ast.program, true, null, null);
  return { defines, reads };
}

const use = new Map();
for (const [file, ast] of asts) if (ast) use.set(file, scanWindowUse(ast));

// Chi definisce un nome, e a che punto della sequenza di caricamento.
const definedAt = new Map();          // nome -> indice del primo <script> che lo definisce
localScripts.forEach((src, i) => {
  const u = use.get(src);
  if (!u) return;
  for (const name of u.defines) if (!definedAt.has(name)) definedAt.set(name, i);
});

{
  const late = [];
  localScripts.forEach((src, i) => {
    const u = use.get(src);
    if (!u) return;
    for (const name of u.reads) {
      // Un file che definisce il nome se lo soddisfa da solo: e' l'idioma
      // `window.PGE = window.PGE || {}`, che tollera l'assenza per costruzione.
      if (u.defines.has(name)) continue;
      const at = definedAt.get(name);
      if (at !== undefined && at > i) {
        late.push(`${src} legge window.${name}, definito da ${localScripts[at]} (dopo)`);
      }
    }
  });
  assert("ogni window.* letto al caricamento e' gia' definito", late.length === 0,
    late.join("\n      "));
}
{
  /* Un nome nostro che nessuno definisce e' un refuso, non un globale del
   * browser: `window.matchMedia` non comincia per PGE. Senza questo, un
   * `window.PGEEnvUtilss` passerebbe per una globale altrui e resterebbe muto. */
  const orphans = [];
  for (const [src, u] of use) {
    if (!localScripts.includes(src)) continue;
    for (const name of u.reads) {
      if (/^PGE/.test(name) && !definedAt.has(name)) orphans.push(`${src} → window.${name}`);
    }
  }
  assert("nessuna lettura di una globale PGE* che nessuno definisce",
    orphans.length === 0, orphans.join("\n      "));
}
{
  // La guardia del punto 4 e' muta se non ha archi da controllare: qui si
  // misura che la derivazione veda davvero qualcosa. Gli archi ci sono per
  // costruzione (ogni componente che scrive in window.PGE dipende da
  // primitives.jsx), e il giorno che spariscono e' la lettura a essersi rotta.
  let edges = 0;
  localScripts.forEach((src, i) => {
    const u = use.get(src);
    if (!u) return;
    for (const name of u.reads) {
      if (u.defines.has(name)) continue;
      const at = definedAt.get(name);
      if (at !== undefined && at < i) edges++;
    }
  });
  assert(`la derivazione trova dipendenze reali (${edges})`, edges > 0,
    "zero archi: lo scanner non sta leggendo piu' niente, non e' il grafo a " +
    "essere diventato piatto");
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
