/* =============================================================================
 * test-boot.js — l'applicazione esiste e risponde (#139).
 *
 * Fino a qui la verifica dell'interfaccia era manuale, e il CLAUDE.md lo
 * diceva: aprire `PGE Editor.html`, Settings → backend locale, test
 * connection, render. Il gate statico (#138, tests/node/test-sources.js) ha
 * chiuso la meta' economica del problema — ogni file parsa, l'ordine di
 * caricamento regge, nessuno legge un `window.*` che arriva dopo — ma un
 * componente puo' parsare benissimo ed esplodere al primo render. Da li' in
 * poi il sintomo e' una pagina bianca, e nessuna suite la vedeva.
 *
 * Questo file la vede. Non e' un test di regressione visiva: non guarda un
 * pixel, guarda che il boot arrivi in fondo e che le quattro superfici che
 * l'autore tocca per prime rispondano.
 *
 *   1. il boot            — zero eccezioni non gestite, zero errori in
 *                           console che non siano stati causati dal test
 *                           stesso (i font, vedi browser.js)
 *   2. il progetto        — una config versionata qui dentro, caricata dal
 *                           bridge vero: tre stream, due lane (`ui_tracks`
 *                           raggruppa i primi due)
 *   3. Inspector + EnvelopeEditor — si aprono sullo stream selezionato, e
 *                           l'envelope disegna i suoi breakpoint invece di
 *                           una cornice vuota
 *   4. undo/redo          — un gesto, un passo indietro, un passo avanti, e
 *                           lo stato torna dov'era
 *
 * Gli assert parlano di struttura (quanti breakpoint, quale stream, che
 * numero legge la riga `onset`), non di geometria: un assert sul pixel
 * invecchia male e costa manutenzione, uno sul boot no.
 *
 * Run: node test-boot.js  (da tests/e2e/, dopo `npm install` e
 *      `npx playwright install chromium`), oppure `make tests-e2e`.
 *
 * PGE_REQUIRE_E2E=1 trasforma "browser assente" da SKIP a FAIL: e' quello che
 * la CI passa, cosi' un job che non installa il browser non puo' passare
 * verde saltando tutto — la stessa regola di PGE_REQUIRE_ENGINE_FIXTURES.
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

const B = require("./browser.js");

let pass = 0, fail = 0;
// Il corpo della suite e' un IIFE async: se muore a meta', i suoi assert non
// contano e i contatori direbbero "0 failed" su una suite che non e' arrivata
// in fondo. La bandiera lo dice all'handler `exit`.
let bodyDone = false;
let skipped  = null;

function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

const REQUIRE = process.env.PGE_REQUIRE_E2E === "1";

/* Il browser non c'e' (clone appena fatto, `npx playwright install` mai
 * lanciato): si salta RUMOROSAMENTE, e con PGE_REQUIRE_E2E=1 non si salta
 * affatto. La distinzione e' la stessa delle fixture del motore: uno skip
 * legittimo su una macchina che non ha ancora scaricato 150 MB di Chromium,
 * mai in CI. */
function skip(reason, how) {
  if (REQUIRE) {
    assert("il browser headless c'e'", false,
      `${reason}\n      ${how}\n      (PGE_REQUIRE_E2E=1: uno skip qui e' un fallimento)`);
  } else {
    skipped = `${reason}\n  ${how}`;
  }
}

/* ---- il conteggio degli errori --------------------------------------------
 * Un errore in console e' dell'applicazione a meno che non sia il test ad
 * averlo causato. L'unica causa del test e' la politica di rete di
 * browser.js, che blocca i font: quelli si riconoscono dall'URL della
 * console message, non da una stringa nel testo — "Failed to load resource"
 * lo scrive il browser anche per una fetch dell'app che va storta, ed e'
 * esattamente il caso che questo test deve vedere.
 * ------------------------------------------------------------------------- */
function collect(page, blockedUrls) {
  const errors = [], pageerrors = [], mine = [];
  page.on("pageerror", e => pageerrors.push(e.stack || e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = (m.location() || {}).url || "";
    (blockedUrls.has(url) ? mine : errors).push(`${m.text()}  ← ${url || "(no url)"}`);
  });
  return { errors, pageerrors, mine };
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ============================================================
   * 0 — i vendor: gli stessi byte che l'utente riceve dalla CDN
   * ============================================================ */
  console.log("\n── vendor: cio' che il test serve e' cio' che l'HTML chiede ──");

  const problems = B.verifyVendor();
  assert("i quattro vendor coincidono con quelli di PGE Editor.html",
    problems.length === 0, problems.join("\n      "));

  const tags = B.htmlVendorTags();
  assert("ogni <script> esterno dell'HTML dichiara un integrity",
    tags.length > 0 && tags.every(t => t.integrity),
    "senza SRI il test servirebbe byte arbitrari e nessuno se ne accorgerebbe");

  /* La costante che l'app usa quando `serverUrl` e' vuoto. browser.js
   * riscrive quelle richieste sulla porta del bridge; se la costante cambia,
   * la riscrittura non aggancia piu' niente e l'app va in `serverDown` — cioe'
   * un boot che riesce a meta' e un test che continua a passare su meno di
   * quello che credeva. */
  const appSrc = fs.readFileSync(path.join(B.REPO, "src/components/app.jsx"), "utf8");
  assert("l'URL di default del bridge in app.jsx e' quello che il test riscrive",
    appSrc.includes(`"${B.APP_DEFAULT_SERVER}"`),
    `app.jsx non contiene piu' "${B.APP_DEFAULT_SERVER}": aggiorna ` +
    `APP_DEFAULT_SERVER in browser.js`);

  /* I font esterni: la lista viene letta dal CSS, non trascritta. Se il CSS
   * ne aggiunge uno, la politica di rete lo blocca e il conteggio lo
   * attribuisce al test — automaticamente, senza che nessuno se ne ricordi. */
  const fonts = B.cssFontUrls();
  assert("gli @font-face esterni del CSS sono stati riconosciuti",
    fonts.length > 0,
    "se il CSS non ha piu' font remoti, la politica di rete puo' smettere di " +
    "bloccarli e il conteggio degli errori torna secco");

  /* ============================================================
   * 1 — il boot
   * ============================================================ */
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (e) {
    skip("playwright non e' installato",
         "cd tests/e2e && npm install");
    bodyDone = true;
    return;
  }

  console.log("\n── boot: la pagina arriva in fondo ──");

  let session;
  try {
    session = await B.open({ chromium });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      skip("il browser di playwright non e' scaricato",
           "cd tests/e2e && npx playwright install chromium");
      bodyDone = true;
      return;
    }
    throw e;
  }

  try {
    const { page, net } = session;
    const seen = collect(page, new Set(session.fonts));
    // Un'interazione che non aggancia nulla e' un fallimento, non un'attesa:
    // con il default (30s) una suite rossa passa piu' tempo in timeout che a
    // testare. L'unica attesa lunga e' quella del boot, dichiarata sotto.
    page.setDefaultTimeout(10000);

    await page.goto(`http://127.0.0.1:${session.port}/`, { waitUntil: "load" });

    // Il primo segno di vita che non sia l'HTML: una clip disegnata dal
    // progetto letto dal bridge. Se non arriva, il boot e' morto e il
    // messaggio deve dirlo prima di dieci assert su un DOM vuoto.
    let booted = true;
    try {
      await page.waitForSelector(".lane .clip", { timeout: 30000 });
    } catch { booted = false; }
    assert("il progetto arriva in timeline", booted,
      booted ? "" : "nessuna clip dopo 30s: la pagina non ha finito il boot\n      " +
        (seen.pageerrors[0] || seen.errors[0] || "(nessun errore in console: " +
         "guarda il bridge)"));

    // Il boot continua dopo il primo render: /diagnose, /bounds,
    // /semantics-version e POST /setup arrivano dopo. Un errore che nasce li'
    // e' esattamente quello che questo test esiste per vedere.
    await wait(2500);

    assert("nessuna eccezione non gestita", seen.pageerrors.length === 0,
      seen.pageerrors.join("\n      "));
    assert("nessun errore in console che non sia del test",
      seen.errors.length === 0, seen.errors.join("\n      "));
    assert("nessuna richiesta verso l'esterno oltre a quelle dichiarate",
      net.unexpected.length === 0,
      [...new Set(net.unexpected)].join("\n      ") +
      "\n      un nuovo vendor/asset remoto va dichiarato in browser.js, " +
      "o il test gira su una rete che in CI non c'e'");
    assert("i quattro vendor sono stati serviti dal disco",
      net.served.length === B.VENDOR.length,
      `serviti ${net.served.length}: ${net.served.join(", ")}`);

    /* Il bridge risponde davvero. Senza questo assert un `serverDown` — cioe'
     * meta' applicazione mai esercitata — passerebbe verde: la pagina si
     * disegna lo stesso, con un progetto vuoto. */
    const down = await page.evaluate(() =>
      [...document.querySelectorAll(".pge-toast")]
        .some(t => /non raggiungibile/i.test(t.textContent)));
    assert("il bridge e' raggiungibile (nessun toast 'server non raggiungibile')",
      !down);

    /* ============================================================
     * 2 — il progetto versionato in fixtures/
     * ============================================================ */
    console.log("\n── progetto: la fixture, letta dal bridge ──");

    const shape = await page.evaluate(() => ({
      proj:  (document.querySelector(".pge-topbar .proj") || {}).textContent || "",
      clips: document.querySelectorAll(".lane .clip").length,
      lanes: document.querySelectorAll(".lanes-area .lane").length,
      ids:   [...document.querySelectorAll(".lane .clip .lbl")].map(e => e.textContent.split(" ")[0]),
    }));

    assert("la topbar nomina il progetto della fixture",
      /PGE_smoke/.test(shape.proj), JSON.stringify(shape.proj));
    assert("i tre stream della fixture sono in timeline", shape.clips === 3,
      `clip: ${shape.clips}`);
    /* Due lane e non tre: `ui_tracks` mette stream1 e stream2 sulla stessa.
     * E' l'unico assert qui che riguarda una feature (#141) e non il boot, e
     * ci sta perche' e' la sola strada in cui il `_extra` di primo livello
     * torna indietro dal YAML fino al layout. */
    assert("ui_tracks raggruppa i primi due stream su una lane sola",
      shape.lanes === 2, `lane: ${shape.lanes}`);
    assert("le clip portano gli id della fixture",
      shape.ids.join(",") === "stream1,stream2,stream3", shape.ids.join(","));

    /* ============================================================
     * 3 — Inspector ed EnvelopeEditor
     * ============================================================ */
    console.log("\n── Inspector · EnvelopeEditor ──");

    await page.click(".lane .clip");
    await page.keyboard.press("i");
    await wait(600);

    const insp = await page.evaluate(() => {
      const el = document.querySelector(".pge-inspector");
      if (!el) return null;
      const row = (name) => {
        const r = [...el.querySelectorAll(".pge-prow")]
          .find(p => (p.querySelector(".k") || {}).textContent === name);
        return r ? (r.querySelector(".v") || {}).textContent : null;
      };
      return { text: el.textContent.slice(0, 200), onset: row("onset"), sid: row("stream_id") };
    });
    assert("l'Inspector si apre sullo stream selezionato",
      insp !== null && /stream1/.test(insp.text), JSON.stringify(insp));
    assert("l'Inspector legge la riga onset dalla fixture",
      insp && /^0\s*s?$/.test((insp.onset || "").trim()),
      `onset: ${JSON.stringify(insp && insp.onset)}`);

    /* L'EnvelopeEditor: aprirlo dalla riga di un envelope e' il gesto vero
     * (`.v.env` nell'Inspector), e cio' che si verifica e' che DISEGNI —
     * tre breakpoint, quanti ne ha `density` nella fixture, piu' la
     * spezzata che li unisce. Una cornice vuota e un envelope disegnato
     * hanno lo stesso `.pge-envedit` intorno. */
    const opened = await page.evaluate(() => {
      const row = [...document.querySelectorAll(".pge-inspector .pge-prow")]
        .find(p => (p.querySelector(".k") || {}).textContent === "density");
      const env = row && row.querySelector(".v.env");
      if (!env) return false;
      env.click();
      return true;
    });
    assert("la riga density dell'Inspector porta all'EnvelopeEditor", opened);
    await wait(600);

    const drawn = await page.evaluate(() => {
      const svg = document.querySelector(".ee-canvas svg.ee-layer");
      if (!svg) return null;
      const paths = [...svg.querySelectorAll("path")].map(p => p.getAttribute("d") || "");
      return {
        param: (document.querySelector(".ee-psel-lbl") || {}).textContent || "",
        bps:   svg.querySelectorAll("circle.ee-bp").length,
        curve: paths.some(d => (d.match(/[0-9]/g) || []).length > 10),
      };
    });
    assert("l'EnvelopeEditor mostra il parametro aperto",
      drawn && drawn.param === "density", JSON.stringify(drawn));
    assert("disegna i tre breakpoint di density",
      drawn && drawn.bps === 3, `breakpoint: ${drawn && drawn.bps}`);
    assert("disegna la spezzata che li unisce",
      drawn && drawn.curve === true, JSON.stringify(drawn));

    /* ============================================================
     * 4 — undo / redo
     * ============================================================ */
    console.log("\n── undo · redo ──");

    /* Il gesto e' da tastiera e non un drag: ⇧→ sposta l'onset di 1s esatto
     * (app.jsx), mentre un drag dipende da soglie in pixel e da dove cade il
     * mouse — cioe' introduce nel test proprio il tipo di fragilita' che il
     * test deve non avere. Quello che si verifica e' la meccanica dello
     * stack, non il gesto. */
    await page.click(".lane .clip");
    const onsetOf = () => page.evaluate(() => {
      const c = document.querySelector(".lane .clip");
      return c ? c.style.left : null;
    });
    const before = await onsetOf();

    await page.keyboard.press("Shift+ArrowRight");
    await wait(400);
    const moved = await onsetOf();
    assert("⇧→ sposta la clip", moved !== before, `${before} → ${moved}`);

    await page.keyboard.press("Control+z");
    await wait(400);
    const undone = await onsetOf();
    assert("undo riporta la clip dov'era", undone === before,
      `atteso ${before}, letto ${undone}`);

    await page.keyboard.press("Control+Shift+z");
    await wait(400);
    const redone = await onsetOf();
    assert("redo la rimanda avanti", redone === moved,
      `atteso ${moved}, letto ${redone}`);

    /* Il conteggio si rifa' alla fine: un errore nato durante le interazioni
     * (un handler che esplode al primo click) e' esattamente quello che una
     * verifica fatta solo al boot non vedrebbe. */
    assert("nessuna eccezione durante le interazioni",
      seen.pageerrors.length === 0, seen.pageerrors.join("\n      "));
    assert("nessun errore in console durante le interazioni",
      seen.errors.length === 0, seen.errors.join("\n      "));

    if (seen.mine.length) {
      console.log(`\n  (${seen.mine.length} errori di rete causati dal test: ` +
        `i font bloccati da browser.js)`);
    }
  } finally {
    await session.close();
  }

  bodyDone = true;
})().catch(e => {
  /* Senza questo catch e' una unhandled rejection: exit 1 con lo stack e
     nessun riepilogo. */
  fail++;
  console.error("FAIL  il corpo della suite e' morto a meta'\n      " +
    (e && e.stack ? e.stack : String(e)));
});

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file: cosi'
// una sezione appesa dopo continua a contare, invece di stampare FAIL e uscire
// 0. E la registrazione sta a livello di modulo, non dentro il corpo che deve
// sorvegliare: registrata li' dentro, un corpo morto prima non avrebbe ne'
// riepilogo ne' "interrotto". Il vincolo e' verificato da
// tests/node/test-suite-harness.js (#132).
process.on("exit", (code) => {
  if (skipped) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`e2e saltato: ${skipped}`);
    console.log("PGE_REQUIRE_E2E=1 lo rende un fallimento (e' cio' che fa la CI).");
  }
  if (!bodyDone) {
    fail++;
    console.error("FAIL  il corpo della suite non e' arrivato in fondo: " +
      "i suoi assert non hanno contato");
  }
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
