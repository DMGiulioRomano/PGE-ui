/* =============================================================================
 * browser.js — apre l'editor in un Chromium headless, con la rete sotto
 * controllo del test (#139).
 *
 * Il boot dell'app dipende da tre cose che non stanno in questo repo: i
 * quattro script vendor che `PGE Editor.html` chiede alla CDN, i tre file di
 * font che `styles/colors_and_type.css` chiede a rsms.me e jsdelivr, e il
 * bridge. La regola qui e' una sola: la pagina ottiene ESATTAMENTE quelle
 * cose, e ogni altra richiesta verso l'esterno e' un fallimento con il suo
 * nome — non un caricamento che riesce sulla macchina di chi ha scritto il
 * test e sparisce in CI.
 *
 *   vendor  → serviti da tests/e2e/node_modules, cioe' dai pacchetti npm da
 *             cui la CDN pubblica quegli stessi byte. Non e' un surrogato:
 *             `verifyVendor` ricalcola l'hash SRI e lo confronta con quello
 *             scritto nell'HTML, quindi o i byte sono gli stessi o il test
 *             lo dice. E' anche il motivo per cui l'`integrity` dell'HTML
 *             risulta verificata di sbieco: se non tornasse, il browser
 *             bloccherebbe lo script e il boot morirebbe qui.
 *   font    → bloccati. Sono decorazione: il CSS non ha `local()` ne' copia
 *             locale, e l'unica alternativa sarebbe far dipendere il boot da
 *             due domini di terze parti. Il costo e' che il browser scrive
 *             "Failed to load resource" in console per ognuno, e per questo
 *             il conteggio degli errori li attribuisce al test invece che
 *             all'app (vedi `consoleErrors` in test-boot.js).
 *   bridge  → l'app chiede `http://localhost:7878` perche' quella e' la sua
 *             costante (TWEAK_DEFAULTS non ha `serverUrl`, e le preferenze
 *             non stanno in localStorage: non c'e' un modo di dirglielo da
 *             fuori). Riscrivere l'URL della richiesta e' l'alternativa a
 *             occupare la 7878, che sulla macchina di chi sviluppa e' la
 *             porta di `make serve`. La costante e' presidiata da una
 *             guardia di sorgente in test-boot.js: se cambia, il test lo
 *             dice invece di ritrovarsi silenziosamente `serverDown`.
 *
 * =========================================================================== */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");
const { spawn } = require("child_process");

const HERE = __dirname;
const REPO = path.join(HERE, "..", "..");
const NODE_MODULES = path.join(HERE, "node_modules");

/* L'URL che l'app usa quando `tweaks.serverUrl` e' vuoto — cioe' sempre, al
 * boot. Scritto qui una volta e verificato contro app.jsx da test-boot.js. */
const APP_DEFAULT_SERVER = "http://localhost:7878";

/* I quattro script vendor: URL come sta nell'HTML → file dentro node_modules.
 * Le versioni nei due posti devono coincidere, ed e' `verifyVendor` a dirlo. */
const VENDOR = [
  { url: "https://unpkg.com/react@18.3.1/umd/react.development.js",
    file: "react/umd/react.development.js" },
  { url: "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js",
    file: "react-dom/umd/react-dom.development.js" },
  { url: "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js",
    file: "@babel/standalone/babel.min.js" },
  { url: "https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js",
    file: "js-yaml/dist/js-yaml.min.js" },
];

/* ---------------------------------------------------------------------------
 * Le due liste che l'HTML e il CSS dichiarano davvero.
 *
 * Lette dai sorgenti, non trascritte: una lista scritta a mano qui sarebbe
 * una seconda copia della verita', e chi aggiunge uno <script> o un @font-face
 * non e' chi si ricorda di aggiornarla — andrebbe muta proprio mentre la
 * dipendenza esterna sta cambiando.
 * ------------------------------------------------------------------------- */

/** Gli <script src="https://…"> di PGE Editor.html, con il loro integrity. */
function htmlVendorTags() {
  const html = fs.readFileSync(path.join(REPO, "PGE Editor.html"), "utf8");
  const out = [];
  const re = /<script\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const integ = /\bintegrity="([^"]+)"/.exec(tag);
    out.push({ url: m[1], integrity: integ ? integ[1] : null });
  }
  return out;
}

/** Gli url() esterni dentro gli @font-face di styles/*.css. */
function cssFontUrls() {
  const dir = path.join(REPO, "styles");
  const out = new Set();
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".css"))) {
    const css = fs.readFileSync(path.join(dir, f), "utf8");
    for (const block of css.match(/@font-face\s*\{[^}]*\}/g) || []) {
      const re = /url\(\s*["']?(https?:\/\/[^"')]+)/g;
      let m;
      while ((m = re.exec(block))) out.add(m[1]);
    }
  }
  return [...out].sort();
}

/** sha256/384/512 in formato SRI di un file. */
function sriOf(file, algo) {
  const buf = fs.readFileSync(file);
  return `${algo}-${crypto.createHash(algo).update(buf).digest("base64")}`;
}

/**
 * Confronta i vendor serviti dal test con quelli che l'HTML chiede alla CDN.
 * Restituisce una lista di problemi (vuota = tutto a posto).
 *
 * Serve piu' di un controllo di versione: se i byte divergono, il browser
 * blocca lo script per SRI e il boot muore con un errore che non nomina la
 * causa. Qui la causa e' il messaggio.
 */
function verifyVendor() {
  const problems = [];
  const tags = htmlVendorTags();
  const byUrl = new Map(tags.map(t => [t.url, t]));

  for (const t of tags) {
    if (!VENDOR.some(v => v.url === t.url)) {
      problems.push(`PGE Editor.html carica ${t.url}, che il test non sa servire: ` +
        `aggiungilo a VENDOR in browser.js e a tests/e2e/package.json`);
    }
  }
  for (const v of VENDOR) {
    const tag = byUrl.get(v.url);
    if (!tag) {
      problems.push(`il test serve ${v.url}, che PGE Editor.html non chiede piu': ` +
        `VENDOR e' rimasto indietro`);
      continue;
    }
    const file = path.join(NODE_MODULES, v.file);
    if (!fs.existsSync(file)) {
      problems.push(`manca ${v.file} in tests/e2e/node_modules (npm install)`);
      continue;
    }
    if (!tag.integrity) continue;          // niente SRI da confrontare
    const algo = tag.integrity.split("-")[0];
    const got  = sriOf(file, algo);
    if (got !== tag.integrity) {
      problems.push(
        `${v.url}\n      HTML: ${tag.integrity}\n      npm : ${got}\n` +
        `      i byte non coincidono: allinea la versione in ` +
        `tests/e2e/package.json a quella nell'URL (o viceversa)`);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------------------
 * bridge.py
 * ------------------------------------------------------------------------- */

function pickPython() {
  const venv = path.join(REPO, ".venv", "bin", "python");
  return fs.existsSync(venv) ? venv : "python3";
}

/** Avvia bridge.py su una porta scelta dal kernel; risolve { proc, port }. */
function startBridge({ timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pickPython(), [path.join(HERE, "bridge.py")],
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(t); fn(arg); } };
    const t = setTimeout(() => {
      proc.kill();
      done(reject, new Error("bridge.py non ha annunciato la porta entro " +
        `${timeoutMs}ms\n${err || out}`));
    }, timeoutMs);

    proc.stdout.on("data", d => {
      out += d;
      const m = out.match(/PGE_E2E_PORT (\d+)/);
      if (m) done(resolve, { proc, port: Number(m[1]) });
    });
    proc.stderr.on("data", d => { err += d; });
    proc.on("exit", code => done(reject, new Error(
      `bridge.py e' uscito con ${code} prima di annunciare la porta\n${err || out}`)));
    proc.on("error", e => done(reject, e));
  });
}

/* ---------------------------------------------------------------------------
 * L'apertura vera
 * ------------------------------------------------------------------------- */

/**
 * Avvia bridge + browser e apre l'editor. Restituisce
 *   { page, port, close(), net }
 * dove `net` accumula cio' che la politica di rete ha deciso:
 *   net.blocked    — URL bloccati perche' dichiarati (i font)
 *   net.unexpected — URL verso l'esterno che nessuno ha dichiarato: sono un
 *                    fallimento, e il chiamante li legge come tali
 *   net.served     — i vendor effettivamente serviti dal disco
 */
async function open({ chromium, headless = true } = {}) {
  const fonts = new Set(cssFontUrls());
  const vendorByUrl = new Map(VENDOR.map(v => [v.url, v]));

  const { proc, port } = await startBridge();
  const bridgeOrigin = `http://127.0.0.1:${port}`;

  let browser;
  const net = { blocked: [], unexpected: [], served: [] };
  try {
    browser = await chromium.launch({ headless });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

    await ctx.route("**/*", async (route) => {
      const url = route.request().url();

      if (url.startsWith(bridgeOrigin)) return route.continue();

      // La costante dell'app: stessa richiesta, altra porta. Il browser resta
      // convinto di parlare con la 7878 (headers e CORS compresi), che e'
      // esattamente la configurazione dell'utente.
      if (url.startsWith(APP_DEFAULT_SERVER + "/")) {
        return route.continue({ url: bridgeOrigin + url.slice(APP_DEFAULT_SERVER.length) });
      }

      const v = vendorByUrl.get(url);
      if (v) {
        net.served.push(url);
        return route.fulfill({
          path: path.join(NODE_MODULES, v.file),
          contentType: "text/javascript; charset=utf-8",
        });
      }

      if (fonts.has(url)) { net.blocked.push(url); return route.abort(); }

      net.unexpected.push(url);
      return route.abort();
    });

    const page = await ctx.newPage();
    return {
      page, port, net,
      fonts: [...fonts],
      async close() {
        await browser.close().catch(() => {});
        proc.kill();
      },
    };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    proc.kill();
    throw e;
  }
}

module.exports = {
  APP_DEFAULT_SERVER, VENDOR, REPO, NODE_MODULES,
  htmlVendorTags, cssFontUrls, sriOf, verifyVendor, startBridge, open,
};
