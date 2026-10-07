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
 *   5. due editor, un file (#185) — l'altro editor riscrive il progetto, il
 *                           Salva chiede invece di scrivere (una domanda sola
 *                           per due Salva), e il `sovrascrivi` dato dopo
 *                           un'altra modifica scrive il documento di ADESSO:
 *                           e' un difetto delle chiusure di React, cioe' dove
 *                           le guardie sorgente non arrivano
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

  /* Il ripiego di file:// (#166), letto da backend.js. Senza, la politica di
   * rete non saprebbe riconoscere la richiesta che una pagina servita dal
   * bridge non deve fare, e l'assert piu' sotto sarebbe verde per cecita'. */
  assert("il ripiego di file:// si legge da backend.js",
    /^https?:\/\/[^/]+$/.test(B.FILE_FALLBACK_SERVER || ""),
    `letto: ${B.FILE_FALLBACK_SERVER} — se backend.js ha cambiato il modo di ` +
    `dichiararlo, aggiorna la lettura in browser.js, non aggirarla`);

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

    /* La strada che `pge-ui` apre (#166): la pagina arriva dal bridge e parla
     * con il suo origin. Fino a #166 chiedeva `localhost:7878` qualunque
     * porta l'avesse servita, e questo test lo nascondeva riscrivendo quelle
     * richieste. Il bridge qui e' su una porta del kernel, quindi una sola
     * fetch al ripiego e' una pagina che parla con un altro bridge. */
    assert("l'editor servito dal bridge parla con il proprio origin",
      net.fallback.length === 0,
      [...new Set(net.fallback)].join("\n      "));
    const baseUrl = await page.evaluate(() =>
      window.PGEBackend && window.PGEBackend.current && window.PGEBackend.current.baseUrl);
    assert("il backend di boot punta al bridge che ha servito la pagina",
      baseUrl === `http://127.0.0.1:${session.port}`, String(baseUrl));

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
     * 3b — il selettore del backend nel popover di render (#150)
     * ============================================================ */
    console.log("\n── popover di render: il selettore del backend ──");

    /* Il selettore e' l'unico pezzo di #150 che si vede, e l'unico che in node
     * gira solo per guardia sorgente: qui si apre davvero. Il motore finto
     * dichiara `numpy` e `stub` (bridge.py), quindi i bottoni sono quelli e
     * nell'ordine di `available_types()` — il popover non ne tiene una copia. */
    const rendererSeg = () => page.evaluate(() => {
      const row = [...document.querySelectorAll(".rs-pop .rs-row")]
        .find(r => (r.querySelector(".rs-k") || {}).textContent === "renderer");
      if (!row) return null;
      return [...row.querySelectorAll(".pge-seg button")].map(b => ({
        name: b.textContent.trim(), on: b.classList.contains("on"),
        disabled: b.disabled }));
    });
    const commandLine = () => page.evaluate(() => {
      const c = document.querySelector(".rs-pop .rs-cmd-body");
      return c ? c.textContent : "";
    });
    const clickRenderer = (name) => page.evaluate((n) => {
      const row = [...document.querySelectorAll(".rs-pop .rs-row")]
        .find(r => (r.querySelector(".rs-k") || {}).textContent === "renderer");
      const b = row && [...row.querySelectorAll(".pge-seg button")]
        .find(x => x.textContent.trim() === n);
      if (b) b.click();
      return !!b;
    }, name);

    await page.click(".rs-caret");
    await page.waitForSelector(".rs-pop");
    await wait(300);          // l'apertura rilegge GET /renderers
    const seg0 = await rendererSeg();
    assert("un bottone per backend del motore, nel suo ordine",
      seg0 && JSON.stringify(seg0.map(b => b.name)) === JSON.stringify(["numpy", "stub"]),
      JSON.stringify(seg0));
    assert("acceso il default (numpy), e cliccabili entrambi",
      seg0 && seg0[0].on && !seg0[1].on && seg0.every(b => !b.disabled),
      JSON.stringify(seg0));
    assert("l'anteprima del comando dice numpy",
      /--renderer numpy\b/.test(await commandLine()), await commandLine());

    assert("il bottone dell'altro backend c'e'", await clickRenderer("stub"));
    await wait(200);
    const seg1 = await rendererSeg();
    assert("il clic accende l'altro backend",
      seg1 && !seg1[0].on && seg1[1].on, JSON.stringify(seg1));
    assert("...e l'anteprima lo segue",
      /--renderer stub\b/.test(await commandLine()), await commandLine());

    await clickRenderer("numpy");
    await wait(200);
    const seg2 = await rendererSeg();
    assert("si torna a numpy", seg2 && seg2[0].on && !seg2[1].on, JSON.stringify(seg2));
    await page.click(".rs-caret");   // chiude il popover

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

    /* ============================================================
     * 5 — due editor, un file (#185)
     * ============================================================ */
    console.log("\n── due editor, un file: la domanda e le sue risposte ──");

    /* Le guardie sorgente di tests/node/test-file-guard.js dicono che la
     * catena c'e'; il difetto che questa sezione esiste per vedere sta nelle
     * CHIUSURE di React, cioe' dove una guardia sorgente non arriva. La domanda
     * e' un toast persistente e la tastiera resta libera: chi risponde lo fa
     * su un editor che nel frattempo e' andato avanti, e la risposta deve
     * valere per quello — non per l'editor di quando la domanda e' stata
     * posta. Il `sovrascrivi` scriveva il documento di quando si era premuto
     * Salva, e poi spegneva `dirty`: «salvato» su lavoro mai scritto.
     *
     * «L'altro editor» e' una PUT senza firma: e' cio' che il bridge vede di
     * una scrittura del laboratorio — una che non ha letto questo file — e non
     * serve conoscere la cartella temporanea di bridge.py. */
    const bridge = `http://127.0.0.1:${session.port}`;
    const FILE = `${bridge}/file?kind=projects&name=PGE_smoke.yml`;
    const yaml = require("js-yaml");
    const onDisk = async () => yaml.load(await (await fetch(FILE)).text());
    const questions = () => page.evaluate(() =>
      [...document.querySelectorAll(".pge-toast")]
        .filter(t => /cambiato su disco/.test(
          (t.querySelector(".tt-title") || {}).textContent || "")).length);
    const errorsBefore = seen.errors.length;

    const theirs = await (await fetch(FILE)).text();
    const lab = await fetch(FILE, { method: "PUT",
      body: theirs.replace(/^title: smoke$/m, "title: dal-laboratorio") });
    assert("il laboratorio riscrive il file sotto all'editor",
      lab.ok && (await onDisk()).title === "dal-laboratorio");

    /* L'editor ha una modifica sua (lo spostamento rifatto dal redo qui
     * sopra), quindi la guardia deve chiedere, non rileggere. Due Salva:
     * la domanda e' una sola, la seconda sostituisce la prima. */
    const onsetSaved = await onsetOf();
    await page.keyboard.press("Control+s");
    await wait(600);
    await page.keyboard.press("Control+s");
    await wait(600);
    assert("con lavoro proprio il Salva chiede invece di scrivere",
      (await onDisk()).title === "dal-laboratorio",
      "il file del laboratorio e' stato sovrascritto senza domanda");
    assert("due Salva, una domanda sola",
      (await questions()) === 1, `domande aperte: ${await questions()}`);

    /* La domanda resta in piedi e la tastiera no: un'altra modifica, POI la
     * risposta. */
    await page.click(".lane .clip");
    await page.keyboard.press("Shift+ArrowRight");
    await wait(400);
    const onsetNow = await onsetOf();
    assert("con la domanda aperta si continua a lavorare",
      onsetNow !== onsetSaved, `${onsetSaved} → ${onsetNow}`);

    const clicked = await page.evaluate(() => {
      const q = [...document.querySelectorAll(".pge-toast")]
        .find(t => /cambiato su disco/.test(t.textContent));
      const b = q && [...q.querySelectorAll("button.tt-act")]
        .find(x => x.textContent.trim() === "sovrascrivi");
      if (b) b.click();
      return !!b;
    });
    assert("la domanda offre `sovrascrivi`", clicked);
    await wait(800);

    const after = await onDisk();
    const stream1 = (after.streams || []).find(s => s.stream_id === "stream1");
    const left = (await page.evaluate(() => {
      const c = document.querySelector(".lane .clip");
      return c ? c.style.left : null;
    }));
    /* La fixture ha stream1 a 0; il redo qui sopra l'ha lasciato a 1, che e'
     * cio' che c'era al Salva; la modifica a domanda aperta l'ha portato a 2.
     * Il `sovrascrivi` della chiusura vecchia scriveva 1. */
    assert("`sovrascrivi` scrive il documento di adesso, non quello del primo Salva",
      left === onsetNow && stream1 && stream1.onset === 2,
      `onset su disco: ${stream1 && stream1.onset}, atteso 2 (1 era quello ` +
      `del primo Salva; la clip e' a ${left}, era a ${onsetSaved})`);
    assert("...e si porta via il titolo dell'altro editor, come ha chiesto",
      after.title === "smoke", `titolo su disco: ${after.title}`);
    assert("...e la domanda non c'e' piu'", (await questions()) === 0);
    const unsaved = await page.evaluate(() =>
      !!document.querySelector(".pge-topbar .unsaved"));
    assert("...e la topbar dice salvato perche' il file e' lo stato a schermo",
      !unsaved);

    /* Un 409 e' una risposta che il browser registra in console come
     * «Failed to load resource»: e' cio' che questa sezione ha provocato, e
     * nient'altro deve esserci. */
    const fresh = seen.errors.slice(errorsBefore);
    assert("nessun errore oltre ai 409 della guardia",
      fresh.every(e => /409/.test(e) && /\/file\?kind=projects/.test(e)),
      fresh.join("\n      "));
    assert("nessuna eccezione nella sezione",
      seen.pageerrors.length === 0, seen.pageerrors.join("\n      "));

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
