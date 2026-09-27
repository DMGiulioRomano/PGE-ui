/* =============================================================================
 * test-server-url.js — l'editor parla con il bridge che lo serve (#166).
 *
 * Il bridge serve l'editor da se' (`GET /` → PGE Editor.html), e da #166 e'
 * quella la strada: `pge-ui` apre il browser su `http://127.0.0.1:<porta>/`.
 * Ma l'indirizzo del bridge, nell'editor, era una costante —
 * `http://localhost:7878`, scritta in cinque punti — e le preferenze non hanno
 * `serverUrl` ne' si salvano. Quindi la pagina servita dalla 7879 (un secondo
 * brano, il bridge che sceglie la prima porta libera) faceva le sue fetch
 * alla 7878: all'ALTRO bridge, sull'altro workspace, dove avrebbe salvato e
 * renderizzato. E anche nel caso buono `127.0.0.1` e `localhost` sono due
 * origin, cioe' ogni richiesta era cross-origin e passava dal CORS.
 *
 * La regola: servita via http(s), il bridge e' l'origin della pagina; la
 * costante resta il ripiego di `file://`, dove un origin non c'e'. Una regola
 * sola, `PGEBackend.defaultServerUrl`, e un literal solo nei sorgenti.
 *
 * Run: node test-server-url.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const SG   = require("./source-guard.js");

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

const SRC = path.join(__dirname, "../../src");
const FETCHED = [];
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.fetch = (url) => { FETCHED.push(String(url)); return new Promise(() => {}); };

/* Carica backend.js come lo carica il browser, con `window.location` quella
 * data (o nessuna, come in node). Ritorna window.PGEBackend. */
function boot(location) {
  global.window = { jsyaml: require("js-yaml") };
  if (location) global.window.location = location;
  FETCHED.length = 0;
  eval(fs.readFileSync(path.join(SRC, "lib/yaml-bridge.js"), "utf8"));
  eval(fs.readFileSync(path.join(SRC, "lib/backend.js"), "utf8"));
  return window.PGEBackend;
}

console.log("\n── servita dal bridge: il bridge e' l'origin della pagina ──");
{
  const B = boot({ protocol: "http:", origin: "http://127.0.0.1:7879" });
  assert("defaultServerUrl() e' l'origin",
    B.defaultServerUrl && B.defaultServerUrl() === "http://127.0.0.1:7879",
    B.defaultServerUrl && B.defaultServerUrl());
  assert("il backend creato al caricamento parla con quell'origin",
    B.current.baseUrl === "http://127.0.0.1:7879", B.current.baseUrl);
  assert("e la prima richiesta ci va davvero",
    FETCHED.length > 0 && FETCHED.every(u => u.startsWith("http://127.0.0.1:7879/")),
    FETCHED.join(", "));
  assert("create() senza baseUrl fa lo stesso",
    B.create().baseUrl === "http://127.0.0.1:7879", B.create().baseUrl);
  assert("un baseUrl esplicito vince (il campo di Settings)",
    B.create({ baseUrl: "http://10.0.0.2:9000/" }).baseUrl === "http://10.0.0.2:9000");
}
{
  const B = boot({ protocol: "https:", origin: "https://pge.local:8443" });
  assert("https vale come http", B.defaultServerUrl() === "https://pge.local:8443");
}

console.log("\n── file:// resta possibile: li' un origin non c'e' ──");
{
  // Su file:// `location.origin` e' la stringa "null": usarla come base
  // manderebbe le fetch a "null/health".
  const B = boot({ protocol: "file:", origin: "null" });
  const fb = B.defaultServerUrl();
  assert("su file:// il ripiego e' la porta di default del bridge",
    /^http:\/\/(localhost|127\.0\.0\.1):7878$/.test(fb), fb);
  assert("e il backend di boot lo usa", B.current.baseUrl === fb);
}
{
  const B = boot(null);
  assert("senza window.location (node) si ripiega uguale",
    B.defaultServerUrl() === boot({ protocol: "file:", origin: "null" }).defaultServerUrl());
}

console.log("\n── una regola, un literal ──");
{
  // Il ripiego di file:// si scrive una volta, in backend.js. Era scritto
  // cinque volte (app.jsx due, SettingsPanel.jsx due, backend.js una), e una
  // copia sopravvissuta e' esattamente la pagina che parla col bridge
  // sbagliato su un campo solo — Settings che fa "test connection" alla 7878
  // mentre il resto dell'editor parla con la 7879.
  const files = [
    ...fs.readdirSync(path.join(SRC, "lib")).filter(f => f.endsWith(".js")).map(f => "lib/" + f),
    ...fs.readdirSync(path.join(SRC, "components")).filter(f => f.endsWith(".jsx")).map(f => "components/" + f),
  ];
  const hits = [];
  for (const f of files) {
    const code = SG.codeOf(path.join(SRC, f));
    const n = (code.match(/["'`]https?:\/\/(localhost|127\.0\.0\.1):\d+/g) || []).length;
    if (n) hits.push(`${f} ×${n}`);
  }
  assert("l'indirizzo di ripiego compare una volta sola, in backend.js",
    hits.length === 1 && hits[0] === "lib/backend.js ×1", hits.join(", ") || "nessuno");

  // Chi legge `tweaks.serverUrl` ricade sulla regola, non su un suo default.
  const readers = [];
  for (const f of ["components/app.jsx", "components/SettingsPanel.jsx"]) {
    const code = SG.codeOf(path.join(SRC, f));
    for (const m of code.matchAll(/tweaks\.serverUrl\s*\|\|\s*(window\.PGEBackend\.defaultServerUrl\(\)|[^;,)\n]+)/g)) {
      readers.push({ f, rhs: m[1].trim() });
    }
  }
  assert("app.jsx e SettingsPanel.jsx leggono serverUrl (la guardia vede i lettori)",
    readers.length >= 4, `trovati ${readers.length}`);
  const off = readers.filter(r => !/^window\.PGEBackend\.defaultServerUrl\(\)/.test(r.rhs));
  assert("ogni `tweaks.serverUrl ||` ricade su PGEBackend.defaultServerUrl()",
    off.length === 0, off.map(r => `${r.f}: ${r.rhs}`).join("\n      "));
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
