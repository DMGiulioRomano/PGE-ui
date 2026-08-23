/* =============================================================================
 * test-magnify-spec.js — tests for magnify-spec.js (window.PGEMagnifySpec),
 * the client-side check of the engine's `--magnify-at` SPEC (issue #120).
 *
 * Perché esiste: uno SPEC malformato non degrada la partitura, fa uscire
 * main.py con codice 1 — quindi un refuso nel campo di testo ammazzerebbe
 * l'intero render, audio compreso. La grammatica è quella di
 * `_parse_magnify_spec` nel motore (src/pge/cli.py): target separati da ';',
 * coppie chiave=valore separate da ',', chiave 't' obbligatoria, chiavi
 * numeriche t/y/zoom/out/src e stringa 'stream'.
 *
 * Run: node test-magnify-spec.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = {};
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/magnify-spec.js"), "utf8"));

const M = window.PGEMagnifySpec;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("\n── module surface ──");
assert("PGEMagnifySpec espone error/targets/KEYS",
  typeof M.error === "function" && typeof M.targets === "function"
  && Array.isArray(M.KEYS));
assert("le chiavi sono quelle del motore",
  eq([...M.KEYS].sort(), ["out", "src", "stream", "t", "y", "zoom"]));

console.log("\n── spec vuoto = nessun target esplicito ──");
// Il campo vuoto non è un errore: significa "nessun target", e chi chiama
// omette il flag. Il motore invece rifiuta `--magnify-at ""`, ed è proprio il
// caso che questo contratto evita di produrre.
assert("stringa vuota → nessun errore", M.error("") === null);
assert("solo spazi → nessun errore", M.error("   ") === null);
assert("null/undefined → nessun errore",
  M.error(null) === null && M.error(undefined) === null);
assert("spec vuoto → nessun target", eq(M.targets(""), []));

console.log("\n── target validi ──");
assert("il minimo è t=", M.error("t=14") === null);
assert("tutte le chiavi insieme",
  M.error("t=14,y=2.7,zoom=10,out=0.12,src=0.03,stream=texture2") === null);
assert("spazi attorno alle coppie tollerati",
  M.error(" t = 14 , zoom = 10 ") === null);
assert("più target separati da ;", M.error("t=4;t=12,zoom=6") === null);
assert("';' finale ignorato", M.error("t=4;") === null);
assert("negativi e decimali", M.error("t=0.5,y=-1.25") === null);
assert("notazione esponenziale", M.error("t=1e1") === null);

console.log("\n── target parsati ──");
assert("i numerici diventano numeri, stream resta stringa",
  eq(M.targets("t=14,zoom=10,stream=s1"), [{ t: 14, zoom: 10, stream: "s1" }]));
assert("due target, ordine conservato",
  eq(M.targets("t=4;t=12"), [{ t: 4 }, { t: 12 }]));
assert("uno spec invalido non produce target", eq(M.targets("zoom=10"), []));

console.log("\n── errori: la grammatica del motore ──");
function errOf(spec) { return M.error(spec) || ""; }

assert("token senza '=' → errore che cita il token",
  errOf("t=14,zoom").includes("zoom"));
assert("chiave ignota → errore che cita la chiave",
  errOf("t=14,zom=10").includes("zom"));
assert("valore non numerico → errore che cita chiave e valore",
  errOf("t=abc").includes("t") && errOf("t=abc").includes("abc"));
assert("valore numerico vuoto è un errore",
  M.error("t=") !== null);
assert("'t' mancante → errore su t",
  errOf("zoom=10").toLowerCase().includes("t"));
assert("'t' manca in UNO dei target → errore comunque",
  M.error("t=4;zoom=10") !== null);
assert("stream accetta qualunque stringa non vuota",
  M.error("t=4,stream=texture 2") === null);
assert("stream vuoto è un errore", M.error("t=4,stream=") !== null);
assert("un errore è una stringa, non un booleano",
  typeof M.error("t=abc") === "string");

/* ============================================================
 * La grammatica numerica: `float()` di Python, non `Number()` di JS.
 *
 * Il motore converte i valori numerici con `float()`, e le due grammatiche non
 * coincidono. `tests/parity/test-magnify-parity.js` verifica CONTRO IL MOTORE
 * quale sia quella giusta, ma salta quando il motore non c'è — PR da un fork,
 * clone appena fatto, `make tests` senza repo fratello. Queste asserzioni
 * fissano che il modulo la implementi anche lì, senza dipendere dal motore:
 * un caso saltato non è un caso passato, che è il principio della issue #133
 * applicato al file che quella issue ha corretto.
 * ============================================================ */

console.log("\n── la grammatica numerica è quella di float() ──");

// Il caso che costava un render intero: `Number("0x10")` fa 16, `float("0x10")`
// alza ValueError. La vecchia guardia lasciava passare uno SPEC che il motore
// rifiuta, cioè il contrario di ciò per cui questo modulo esiste.
assert("prefissi non decimali rifiutati (0x/0b/0o)",
  M.error("t=0x10") !== null && M.error("t=0b101") !== null && M.error("t=0o17") !== null,
  JSON.stringify([M.error("t=0x10"), M.error("t=0b101"), M.error("t=0o17")]));

assert("underscore fra cifre accettato, come in float()",
  M.error("t=1_000") === null && M.targets("t=1_000")[0].t === 1000,
  JSON.stringify(M.targets("t=1_000")));
assert("underscore anche nella parte decimale",
  M.error("t=1.000_1") === null && M.targets("t=1.000_1")[0].t === 1.0001,
  JSON.stringify(M.targets("t=1.000_1")));
assert("underscore ai bordi o doppio rifiutato",
  M.error("t=_1") !== null && M.error("t=1_") !== null && M.error("t=1__0") !== null,
  JSON.stringify([M.error("t=_1"), M.error("t=1_"), M.error("t=1__0")]));

// Il ramo scritto a mano di toNumber: `Number()` non conosce "inf"/"nan", e il
// segno si legge dal primo carattere. È la parte del modulo che nessuna regex
// copre, quindi è quella che vale di più fissare qui.
assert("inf / infinity / Infinity valgono +∞",
  M.targets("t=inf")[0].t === Infinity &&
  M.targets("t=infinity")[0].t === Infinity &&
  M.targets("t=Infinity")[0].t === Infinity,
  JSON.stringify(M.targets("t=inf").concat(M.targets("t=infinity"), M.targets("t=Infinity"))));
assert("il segno di -inf è conservato",
  M.targets("t=-inf")[0].t === -Infinity && M.targets("t=-infinity")[0].t === -Infinity,
  String(M.targets("t=-inf")[0].t));
assert("+inf esplicito resta +∞", M.targets("t=+inf")[0].t === Infinity,
  String(M.targets("t=+inf")[0].t));
assert("nan / NaN sono NaN, non ±∞",
  Number.isNaN(M.targets("t=nan")[0].t) && Number.isNaN(M.targets("t=NaN")[0].t),
  String(M.targets("t=nan")[0].t));
assert("un overflow decimale è +∞ da entrambe le grammatiche",
  M.targets("t=1e400")[0].t === Infinity, String(M.targets("t=1e400")[0].t));

// Le forme ordinarie non devono essere state strette per sbaglio insieme al
// resto: sono quelle che si scrivono davvero nel campo.
for (const [spec, atteso] of [["t=14", 14], ["t=-3", -3], ["t=+5", 5],
                              ["t=.5", 0.5], ["t=5.", 5], ["t=1e3", 1000],
                              ["t=1E3", 1000], ["t=1e-3", 0.001], ["t=00012", 12]])
  assert(`${spec} → ${atteso}`,
    M.error(spec) === null && M.targets(spec)[0].t === atteso,
    JSON.stringify(M.targets(spec)));

assert("le forme che non sono numeri restano rifiutate",
  ["t=", "t=.", "t=1e", "t=1e+", "t=--5", "t=1d", "t=1.2.3", "t=1 4", "t=abc"]
    .every(s => M.error(s) !== null),
  ["t=", "t=.", "t=1e", "t=1e+", "t=--5", "t=1d", "t=1.2.3", "t=1 4", "t=abc"]
    .filter(s => M.error(s) === null).join(", "));

console.log("\n── il flag non parte quando lo spec non regge ──");
// Contratto usato da app.jsx: si invia magnifyAt solo se error() è null e la
// stringa non è vuota, così il motore non vede mai uno SPEC che rifiuterebbe.
const sendable = (s) => !!(s && s.trim() && M.error(s) === null);
assert("spec valido → si invia", sendable("t=14,zoom=10") === true);
assert("spec vuoto → non si invia", sendable("  ") === false);
assert("spec rotto → non si invia", sendable("t=14,zom=10") === false);

/* ============================================================
 * Cablaggio nella UI — la parte JSX non ha test di componente
 * (CLAUDE.md), quindi si asserisce sul sorgente come fa
 * test-tweaks-store.js per i residui del design tool.
 * ============================================================ */

console.log("\n── cablaggio ──");

const rbSrc   = fs.readFileSync(path.join(__dirname, "../../src/components/RenderButton.jsx"), "utf8");
const appSrc  = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");
const htmlSrc = fs.readFileSync(path.join(__dirname, "../../PGE Editor.html"), "utf8");
const cssSrc  = fs.readFileSync(path.join(__dirname, "../../styles/render-ui.css"), "utf8");

assert("l'HTML carica magnify-spec.js", /src\/lib\/magnify-spec\.js/.test(htmlSrc));
assert("magnify-spec.js è caricato prima dei componenti",
  htmlSrc.indexOf("src/lib/magnify-spec.js") < htmlSrc.indexOf("src/components/RenderButton.jsx"));
assert("RenderButton controlla lo SPEC mentre si scrive",
  /window\.PGEMagnifySpec[\s\S]{0,80}\.error\(/.test(rbSrc));
assert("l'anteprima argv mostra --magnify", /parts\.push\("--magnify"\)/.test(rbSrc));
assert("l'anteprima argv mostra --magnify-at", /"--magnify-at"/.test(rbSrc));
assert("app.jsx invia magnify e magnifyAt", /magnify:/.test(appSrc) && /magnifyAt:/.test(appSrc));
assert("app.jsx filtra lo SPEC prima di inviarlo",
  /magnifySpecSendable/.test(appSrc));
assert("le opzioni sono persistite nei tweaks",
  /renderMagnify\b/.test(appSrc) && /renderMagnifyAt/.test(appSrc));
assert("lo SPEC rotto ha uno stile d'errore", /\.rs-hint\.err/.test(cssSrc));

console.log("\n──────────────────────────────────────────────────");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
