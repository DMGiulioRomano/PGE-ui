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
 *   5. due editor, un file (#185) — il laboratorio riscrive il progetto sul
 *                           disco mentre l'editor e' aperto: senza modifiche
 *                           proprie l'editor rilegge, con modifiche chiede, e
 *                           nessuna delle due strade si porta via il file
 *                           dell'altro senza una risposta
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

    {
      /* ============================================================
       * 5 — due editor, un file (#185)
       * ============================================================ */
      console.log("\n── due editor, un file: il laboratorio riscrive il progetto ──");

      /* Il "laboratorio" e' questo test che scrive sul disco del workspace,
       * col suo dumper e un commento suo: byte diversi da quelli di PGE-ui
       * anche a documento identico, che e' esattamente il caso vero. */
      const yaml = require("js-yaml");
      const cfg = path.join(session.paths.workspace, "configs", "PGE_smoke.yml");
      const labWrites = (mutate) => {
        const doc = yaml.load(fs.readFileSync(cfg, "utf8"));
        mutate(doc);
        fs.writeFileSync(cfg, "# scritto dal laboratorio\n" + yaml.dump(doc, { flowLevel: 3 }));
        return fs.readFileSync(cfg, "utf8");
      };
      const titleShown = () => page.evaluate(() =>
        ((document.querySelector(".pge-topbar .proj .meta") || {}).textContent || ""));
      const questions = () => page.evaluate(() =>
        [...document.querySelectorAll(".pge-toast.ask")].map(t => ({
          title: (t.querySelector(".tt-title") || {}).textContent || "",
          acts: [...t.querySelectorAll(".tt-act")].map(b => b.textContent),
          x: !!t.querySelector(".tt-x"),
        })));
      const toastTitles = () => page.evaluate(() =>
        [...document.querySelectorAll(".pge-toast .tt-title")].map(e => e.textContent));
      const canUndo = () => page.evaluate(() => window.PGEHistory && window.PGEHistory.canUndo);
      const stream2Onset = () => page.evaluate(() => {
        const c = [...document.querySelectorAll(".lane .clip")]
          .find(e => /^stream2\b/.test((e.querySelector(".lbl") || {}).textContent || ""));
        return c ? c.style.left : null;
      });
      // Le risposte 409 del bridge: il browser le scrive in console come risorsa
      // fallita. Sono provocate da questo test — il laboratorio che riscrive —
      // e si contano, una per rifiuto atteso, invece di sparire in un filtro.
      let expected409 = 0;
      const save = async () => { await page.keyboard.press("Control+s"); await wait(700); };
      // Le risposte di POST /render, in ordine: e' cio' che dice se il bridge ha
      // rifiutato (409) o ha fatto partire lo stream del render (200). Il log del
      // terminale no: chiuso, non disegna righe, e un "nessuna riga $" li'
      // sarebbe verde per cecita'.
      const renders = [];
      page.on("response", (r) => {
        if (new URL(r.url()).pathname === "/render") renders.push(r.status());
      });

      // (a) allineati: un salvataggio, e il disco e' il documento dell'editor.
      await page.click(".lane .clip");
      await save();
      assert("il salvataggio di partenza va", (await toastTitles()).includes("Saved"),
        JSON.stringify(await toastTitles()));

      // (b) il laboratorio cambia il titolo e accorcia stream3; l'editor non ha
      // modifiche proprie.
      /* stream2 e non stream3: accorciare l'ultima clip sposterebbe la durata
         del brano, che l'editor ricalcola dagli stream (`computeDuration`) — il
         documento riletto non sarebbe piu' quello del laboratorio, e la riprova
         lo riscriverebbe. Legittimo (e' cio' che l'editor scriverebbe), ma qui
         si verifica l'altro caso. */
      const widthOf2 = () => page.evaluate(() => {
        const c = [...document.querySelectorAll(".lane .clip")]
          .find(e => /^stream2\b/.test((e.querySelector(".lbl") || {}).textContent || ""));
        return c ? c.getBoundingClientRect().width : null;
      });
      const w2 = await widthOf2();
      const labA = labWrites(d => { d.title = "dal laboratorio"; d.streams[1].duration = 2; });
      expected409++;
      await save();
      assert("senza modifiche proprie non si chiede niente", (await questions()).length === 0,
        JSON.stringify(await questions()));
      assert("...si rilegge: il titolo del laboratorio arriva nell'editor",
        /dal laboratorio/.test(await titleShown()), await titleShown());
      assert("...e la timeline lo disegna: stream2 e' lunga la meta'",
        Math.abs((await widthOf2()) - w2 / 2) < 2, `${w2} → ${await widthOf2()}`);
      assert("...e lo dice", (await toastTitles()).some(t => /riletto/.test(t)),
        JSON.stringify(await toastTitles()));
      /* Il documento riletto e' gia' su disco: la riprova non lo riscrive, e il
         file resta del laboratorio byte per byte, commento compreso. Senza, al
         giro dopo la guardia del laboratorio direbbe "cambiato" su niente. */
      assert("...il file resta quello del laboratorio, byte per byte",
        fs.readFileSync(cfg, "utf8") === labA);
      assert("...e la rilettura azzera la storia", (await canUndo()) === false);

      // (c) modifiche proprie, e il laboratorio riscrive ancora.
      await page.click(".lane .clip");
      const onsetBefore = await stream2Onset();
      await page.keyboard.press("Shift+ArrowRight");
      await wait(300);
      assert("una modifica propria (⇧→)", (await canUndo()) === true);
      const labB = labWrites(d => { d.title = "laboratorio, due"; });
      expected409++;
      await save();
      const q1 = await questions();
      assert("con modifiche proprie si chiede", q1.length === 1, JSON.stringify(q1));
      assert("...con tre risposte: ricarica, sovrascrivi, ×",
        q1.length === 1 && q1[0].acts.join(",") === "ricarica,sovrascrivi" && q1[0].x,
        JSON.stringify(q1));
      assert("...e intanto il file resta del laboratorio", fs.readFileSync(cfg, "utf8") === labB);

      // «ricarica»: un "apri" dello stesso file.
      await page.click(".pge-toast.ask .tt-act:text-is('ricarica')");
      await wait(800);
      assert("ricarica: la domanda si chiude", (await questions()).length === 0);
      assert("...il documento e' quello del laboratorio", /laboratorio, due/.test(await titleShown()),
        await titleShown());
      /* Il criterio dell'issue: un undo riporterebbe una versione che su disco
         non c'e' piu', e la scrittura dopo la riscriverebbe. */
      assert("...e l'undo non riporta la versione vecchia", (await canUndo()) === false);
      assert("...la modifica propria e' andata (era la scelta)",
        (await stream2Onset()) === onsetBefore, `${onsetBefore} → ${await stream2Onset()}`);
      assert("...e il file non e' stato riscritto", fs.readFileSync(cfg, "utf8") === labB);

      // «sovrascrivi»: si scrive la versione dell'editor.
      await page.click(".lane .clip");
      await page.keyboard.press("Shift+ArrowRight");
      await wait(300);
      const onsetMine = await stream2Onset();
      labWrites(d => { d.title = "laboratorio, tre"; });
      expected409++;
      await save();
      assert("ancora modifiche proprie: si chiede", (await questions()).length === 1);
      await page.click(".pge-toast.ask .tt-act:text-is('sovrascrivi')");
      await wait(800);
      const afterOverwrite = yaml.load(fs.readFileSync(cfg, "utf8"));
      assert("sovrascrivi: su disco c'e' la versione dell'editor",
        afterOverwrite.title === "laboratorio, due" &&
        !fs.readFileSync(cfg, "utf8").startsWith("# scritto dal laboratorio"),
        String(afterOverwrite.title));
      assert("...con la modifica propria", (await stream2Onset()) === onsetMine);
      assert("...e il salvataggio lo dice", (await toastTitles()).includes("Saved"));

      // ×: non si scrive niente.
      await page.click(".lane .clip");
      await page.keyboard.press("Shift+ArrowRight");
      await wait(300);
      const labD = labWrites(d => { d.title = "laboratorio, quattro"; });
      expected409++;
      await save();
      await page.click(".pge-toast.ask .tt-x");
      await wait(300);
      assert("×: la domanda si chiude", (await questions()).length === 0);
      assert("...e il file resta del laboratorio", fs.readFileSync(cfg, "utf8") === labD);

      /* Il render passa dalla stessa guardia, prima di scrivere il config: con
         modifiche proprie chiede, e il motore non parte finche' non si risponde.
         (Il motore qui e' finto: partisse, la riga `$ …` lo direbbe nel log.) */
      expected409++;
      await page.keyboard.press("r");
      await wait(800);
      const q2 = await questions();
      assert("il render su un file cambiato, con modifiche proprie: si chiede",
        q2.length === 1 && /cambiato su disco/.test(q2[0].title), JSON.stringify(q2));
      assert("...e il bridge l'ha rifiutato prima di partire", renders.join(",") === "409",
        `risposte di /render: ${renders.join(",")}`);
      assert("...ne' il config viene riscritto", fs.readFileSync(cfg, "utf8") === labD);
      assert("...ne' si annuncia un render fallito", !(await toastTitles()).includes("Render failed"),
        JSON.stringify(await toastTitles()));

      /* «ricarica» riprende il render, sul documento riletto: e' quello che
         l'altro editor ha appena scritto, cioe' quello che si vuole sentire. Il
         config e' gia' su disco, quindi il render non lo riscrive. */
      await page.click(".pge-toast.ask .tt-act:text-is('ricarica')");
      await wait(1500);
      assert("ricarica, nel render: il render riparte e il bridge lo accetta",
        renders.join(",") === "409,200", `risposte di /render: ${renders.join(",")}`);
      // Il motore qui e' finto (un `python` non eseguibile): che il render
      // "fallisca" e' la prova che e' partito davvero, fino allo spawn.
      assert("...fino al motore", (await toastTitles()).includes("Render failed"),
        JSON.stringify(await toastTitles()));
      assert("...sul documento del laboratorio", /laboratorio, quattro/.test(await titleShown()));
      assert("...senza riscrivere il config", fs.readFileSync(cfg, "utf8") === labD);

      /* Senza modifiche proprie il render non chiede: rilegge e rende. */
      const labE = labWrites(d => { d.title = "laboratorio, cinque"; });
      expected409++;
      await page.keyboard.press("r");
      await wait(1500);
      assert("render senza modifiche proprie: nessuna domanda", (await questions()).length === 0);
      assert("...rilegge", /laboratorio, cinque/.test(await titleShown()), await titleShown());
      assert("...e rende: un rifiuto, una rilettura, una riprova accettata",
        renders.slice(2).join(",") === "409,200", `risposte di /render: ${renders.join(",")}`);
      assert("...lasciando il config al laboratorio", fs.readFileSync(cfg, "utf8") === labE);

      const refused = seen.errors.filter(e => / 409 /.test(e) && /\/(file|save|render)\b/.test(e));
      assert(`i rifiuti in console sono quelli provocati dal test (${expected409})`,
        refused.length === expected409, refused.join("\n      "));
      seen.errors.splice(0, seen.errors.length, ...seen.errors.filter(e => !refused.includes(e)));
    }

    {
      /* ============================================================
       * 6 — lo stream come file (#183, #184)
       * ============================================================ */
      console.log("\n── stream come file: master e file importato ──");

      /* Un master con `- file: streams/onda.yml` (fixtures/PGE_smoke_file.yml).
       * Il node copre le regole una per una (tests/node/test-stream-files.js);
       * qui si guarda la strada intera, che in node non gira: il browser dei
       * progetti, GET /import, Ctrl+S, POST /save, il ref del disco fuori dalla
       * storia. Cio' che e' finito dove lo si chiede al bridge, cioe' al disco:
       * GET /import per il file, GET /file per il master. */
      const FILE = "streams/onda.yml";
      const MASTER = "PGE_smoke_file.yml";
      const importText = () => page.evaluate(async (f) => {
        const r = await fetch(`/import?file=${encodeURIComponent(f)}`);
        const j = await r.json();
        return j && j.ok ? j.text : null;
      }, FILE);
      const masterText = () => page.evaluate(async (n) => {
        const r = await fetch(`/file?kind=projects&name=${encodeURIComponent(n)}`);
        return r.ok ? r.text() : null;
      }, MASTER);
      const yamlOf = (t) => page.evaluate((x) => window.jsyaml.load(x), t);
      // Il salvataggio rigenera l'intestazione (`# saved:` porta l'ora), e i
      // commenti della fixture non sopravvivono: il confronto e' sul resto.
      const bodyOf = (t) => (t || "").split("\n").filter(l => !l.startsWith("#")).join("\n").trim();
      const save = async () => { await page.keyboard.press("Control+s"); await wait(700); };

      const file0 = await importText();
      const master0 = await masterText();
      assert("il bridge serve il file importato (GET /import)", typeof file0 === "string" && /stream_id: onda/.test(file0),
        String(file0).slice(0, 120));

      await page.click(".bw-tabs button:nth-child(2)");
      const picked = await page.evaluate((n) => {
        const it = [...document.querySelectorAll(".pge-browser .it.proj")]
          .find(e => (e.querySelector(".nm") || {}).textContent === n);
        if (it) it.click();
        return !!it;
      }, MASTER);
      assert("il master compare fra i progetti, il file importato no",
        picked && !(await page.evaluate(() =>
          [...document.querySelectorAll(".pge-browser .it.proj .nm")].some(e => /onda/.test(e.textContent)))));
      let opened2 = true;
      try { await page.waitForSelector(".lane .clip .clip-file", { timeout: 10000 }); }
      catch { opened2 = false; }
      assert("lo stream importato e' in timeline, col nome del suo file", opened2);
      const clips2 = await page.evaluate(() =>
        [...document.querySelectorAll(".lane .clip .lbl")].map(e => e.textContent.trim()));
      assert("due stream: l'importato (id = nome del file) e quello scritto dentro",
        clips2.length === 2 && clips2.some(t => /^onda · streams\/onda\.yml/.test(t))
          && clips2.some(t => /^riva /.test(t)), JSON.stringify(clips2));
      const errToast = await page.evaluate(() =>
        [...document.querySelectorAll(".pge-toast")].some(t => /stream importati/.test(t.textContent)));
      assert("nessun errore sugli import", !errToast);

      // Selezionare la clip importata e' anche cio' che toglie il fuoco a un
      // campo dell'Inspector: con il fuoco in un input Ctrl+S non e' un
      // salvataggio (app.jsx lascia la tastiera a chi scrive).
      const importedClip = async () => {
        await page.click(".lane .clip:has(.clip-file)");
        await wait(200);
      };
      await importedClip();
      // `i` apre e chiude: la sezione 3 l'ha gia' aperto, e cambiare progetto
      // non lo richiude.
      if (!(await page.$(".pge-inspector"))) await page.keyboard.press("i");
      await wait(400);
      const fileRow = await page.evaluate(() => {
        const r = [...document.querySelectorAll(".pge-inspector .pge-prow")]
          .find(p => (p.querySelector(".k") || {}).textContent === "file");
        return r ? (r.querySelector(".v") || {}).textContent : null;
      });
      assert("l'Inspector dice da quale file viene lo stream", fileRow === FILE, JSON.stringify(fileRow));

      // 1 — aprire e salvare senza toccare niente.
      await importedClip();
      await save();
      const file1 = await importText(), master1 = await masterText();
      assert("salvato senza modifiche, il file importato e' intatto, byte per byte",
        file1 === file0, file1 === file0 ? "" : file1);
      assert("...e il master torna identico, a parte l'intestazione",
        bodyOf(master1) === bodyOf(master0), master1);

      // 2 — una chiave di stream (la durata, Ctrl+⇧→ = +1 s): nel file.
      const dur0 = (await yamlOf(file0)).streams[0].duration;
      await importedClip();
      await page.keyboard.press("Control+Shift+ArrowRight");
      await wait(300);
      await save();
      const file2 = await importText(), master2 = await masterText();
      const doc2 = await yamlOf(file2);
      assert("la durata finisce nel file importato", doc2.streams[0].duration === dur0 + 1,
        `${dur0} → ${doc2.streams[0].duration}`);
      assert("...che resta un documento del laboratorio: seed, stream_id e onset del file",
        doc2.seed === 1441 && doc2.streams[0].stream_id === "onda" && doc2.streams[0].onset === 0,
        JSON.stringify([doc2.seed, doc2.streams[0].stream_id, doc2.streams[0].onset]));
      const entry2 = (await yamlOf(master2)).streams[0];
      assert("...e la voce del master non cambia", JSON.stringify(entry2) === JSON.stringify({ file: FILE, onset: 1 }),
        JSON.stringify(entry2));

      // 3 — una chiave di piazzamento (l'onset, ⇧→ = +1 s): nel master.
      await importedClip();
      await page.keyboard.press("Shift+ArrowRight");
      await wait(300);
      await save();
      const file3 = await importText(), master3 = await masterText();
      assert("l'onset finisce nel master", (await yamlOf(master3)).streams[0].onset === 2,
        JSON.stringify((await yamlOf(master3)).streams[0]));
      assert("...e il file importato non si tocca", file3 === file2);

      // 4 — undo di entrambe, poi un salvataggio: il disco torna com'era.
      await page.keyboard.press("Control+z");
      await wait(300);
      await page.keyboard.press("Control+z");
      await wait(300);
      await save();
      const file4 = await importText(), master4 = await masterText();
      assert("dopo l'undo il file importato torna com'era (riscritto, perche' su disco era cambiato)",
        JSON.stringify(await yamlOf(file4)) === JSON.stringify(await yamlOf(file0)), file4);
      assert("...e la voce del master pure",
        JSON.stringify((await yamlOf(master4)).streams[0]) === JSON.stringify({ file: FILE, onset: 1 }),
        JSON.stringify((await yamlOf(master4)).streams[0]));

      // 4b — duplicare lo stream importato (#186): la copia e' un file nuovo
      // accanto all'originale, scritto al salvataggio e non al duplica. Cosa
      // c'e' nella cartella lo si chiede al bridge con GET /import-dir, che
      // risponde 200 anche per un file che non c'e': un GET /import di un file
      // assente sarebbe un 404, cioe' un errore in console messo dal test.
      const streamsDir = () => page.evaluate(async () => {
        const r = await fetch("/import-dir?dir=streams");
        const j = await r.json();
        return j && j.ok ? j.files.map(n => `streams/${n}`) : null;
      });
      const importOf = (f) => page.evaluate(async (x) => {
        const r = await fetch(`/import?file=${encodeURIComponent(x)}`);
        const j = await r.json();
        return j && j.ok ? j.text : null;
      }, f);
      const fileLabels = () => page.evaluate(() =>
        [...document.querySelectorAll(".lane .clip .clip-file")].map(e => e.textContent.trim()));
      const entriesOf = async () => (await yamlOf(await masterText())).streams;
      const entries4 = await entriesOf();
      const dir4 = await streamsDir();
      await importedClip();
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+v");
      await wait(600);                            // l'incolla aspetta GET /import-dir
      const labels7 = await fileLabels();
      const copyFile = labels7.find(t => t !== FILE);
      assert("incollato, lo stream importato ha un file suo accanto all'originale, col nome dell'id",
        labels7.length === 2 && /^streams\/stream\d+\.yml$/.test(copyFile || ""), JSON.stringify(labels7));
      assert("...che al duplica non si scrive", JSON.stringify(await streamsDir()) === JSON.stringify(dir4),
        JSON.stringify(await streamsDir()));
      // La copia incollata e' la selezione: la durata +1 va a lei.
      await page.keyboard.press("Control+Shift+ArrowRight");
      await wait(300);
      await save();
      const copyDoc = await yamlOf(await importOf(copyFile));
      const origDoc = await yamlOf(file4);
      const copyId = copyFile.replace(/^streams\//, "").replace(/\.yml$/, "");
      const sans = (d) => ({ ...d, duration: null,
        streams: d.streams.map(({ stream_id, duration, ...rest }) => rest) });
      assert("salvato, il file nuovo dice cio' che dice l'originale, tranne stream_id (= nome del file)",
        !!copyDoc && JSON.stringify(sans(copyDoc)) === JSON.stringify(sans(origDoc))
          && copyDoc.streams[0].stream_id === copyId, JSON.stringify(copyDoc));
      assert("...e la modifica alla copia sta nel suo file", copyDoc.streams[0].duration === origDoc.streams[0].duration + 1,
        `${origDoc.streams[0].duration} → ${copyDoc.streams[0].duration}`);
      assert("...e l'originale non si tocca, byte per byte", (await importText()) === file4);
      const entries7 = await entriesOf();
      assert("il master ha una voce `file:` nuova, senza stream_id",
        entries7.length === 3 && entries7.some(e => e.file === copyFile && !("stream_id" in e))
          && JSON.stringify(entries7[0]) === JSON.stringify(entries4[0]), JSON.stringify(entries7));

      // Undo della modifica e dell'incolla: la voce sparisce dal master. Il
      // file, scritto, resta — ed e' un nome che la copia dopo non prende.
      await page.keyboard.press("Control+z");
      await wait(300);
      await page.keyboard.press("Control+z");
      await wait(300);
      await save();
      assert("annullato l'incolla, la voce sparisce dal master",
        JSON.stringify(await entriesOf()) === JSON.stringify(entries4), JSON.stringify(await entriesOf()));
      await page.keyboard.press("Control+v");
      await wait(600);
      const copyFile2 = (await fileLabels()).find(t => t !== FILE);
      assert("incollato di nuovo, il nome evita il file che c'e' gia' su disco",
        !!copyFile2 && copyFile2 !== copyFile && (await streamsDir()).includes(copyFile)
          && !(await streamsDir()).includes(copyFile2), `${copyFile} → ${copyFile2}`);
      // ...e annullato PRIMA del salvataggio: su disco non resta niente.
      await page.keyboard.press("Control+z");
      await wait(300);
      await save();
      assert("undo del duplica prima del salvataggio: niente nel master, niente su disco",
        JSON.stringify(await entriesOf()) === JSON.stringify(entries4)
          && !(await streamsDir()).includes(copyFile2), JSON.stringify(await streamsDir()));

      // 4c — due editor, un file, sul file IMPORTATO (#185 sui file di #184).
      // Il laboratorio scrive i file degli stream, non il master: e' il caso
      // comune. Un file importato cambiato su disco si rilegge da solo — gli
      // stream di quel file e basta, senza riaprire il progetto — e il lavoro
      // non salvato altrove, master compreso, resta e si salva. Con modifiche
      // proprie in quel file si chiede, di quel file solo.
      {
        const lab = require("js-yaml");
        const importPath = path.join(session.paths.workspace, "configs", FILE);
        const masterPath4 = path.join(session.paths.workspace, "configs", MASTER);
        const labWritesFile = (p, mutate) => {
          const doc = lab.load(fs.readFileSync(p, "utf8"));
          mutate(doc);
          fs.writeFileSync(p, "# scritto dal laboratorio\n" + lab.dump(doc, { flowLevel: 3 }));
          return fs.readFileSync(p, "utf8");
        };
        const questions = () => page.evaluate(() =>
          [...document.querySelectorAll(".pge-toast.ask")].map(t => ({
            title: (t.querySelector(".tt-title") || {}).textContent || "",
            acts: [...t.querySelectorAll(".tt-act")].map(b => b.textContent),
          })));
        const toastTitles = () => page.evaluate(() =>
          [...document.querySelectorAll(".pge-toast .tt-title")].map(e => e.textContent));
        const canUndo = () => page.evaluate(() => window.PGEHistory && window.PGEHistory.canUndo);
        const rivaClip = async () => { await page.click(".lane .clip:not(:has(.clip-file))"); await wait(200); };
        const ondaWidth = () => page.evaluate(() => {
          const c = document.querySelector(".lane .clip:has(.clip-file)");
          return c ? c.getBoundingClientRect().width : null;
        });
        // Il volume dello stream importato, come lo mostra l'Inspector: e' cio'
        // che il laboratorio cambia, e cio' che dice se la rilettura e' arrivata.
        const ondaVolume = async () => {
          await importedClip();
          return page.evaluate(() => {
            const r = [...document.querySelectorAll(".pge-inspector .pge-prow")]
              .find(p => (p.querySelector(".k") || {}).textContent === "volume");
            const v = r && r.querySelector(".val");
            return v ? v.textContent : null;
          });
        };
        const rivaOnsetOnDisk = () => lab.load(fs.readFileSync(masterPath4, "utf8")).streams[1].onset;
        const reread = async () => { await save(); await wait(500); };

        // (a) niente di proprio nel file, un lavoro non salvato nel master
        // (l'onset di riva), e il laboratorio riscrive il file.
        const riva0 = rivaOnsetOnDisk();
        await rivaClip();
        await page.keyboard.press("Shift+ArrowRight");
        await wait(300);
        const labA = labWritesFile(importPath, d => { d.streams[0].volume = -3; });
        await reread();
        assert("file importato cambiato, senza modifiche proprie in lui: non si chiede niente",
          (await questions()).length === 0, JSON.stringify(await questions()));
        assert("...si rilegge quel file, e lo dice", (await toastTitles()).includes(`${FILE} riletto`),
          JSON.stringify(await toastTitles()));
        assert("...gli stream di quel file sono la versione del laboratorio", (await ondaVolume()) === "-3",
          String(await ondaVolume()));
        assert("...il file resta del laboratorio, byte per byte", fs.readFileSync(importPath, "utf8") === labA);
        assert("...e il lavoro nel master non si perde: si salva", rivaOnsetOnDisk() === riva0 + 1,
          `${riva0} → ${rivaOnsetOnDisk()}`);
        assert("...la rilettura azzera la storia", (await canUndo()) === false);

        // (b) modifiche proprie nel file (la durata) e nel master (riva), e il
        // laboratorio riscrive il file: si chiede di quel file, e basta.
        const w0 = await ondaWidth();
        await importedClip();
        await page.keyboard.press("Control+Shift+ArrowRight");
        await wait(300);
        await rivaClip();
        await page.keyboard.press("Shift+ArrowRight");
        await wait(300);
        const labB = labWritesFile(importPath, d => { d.streams[0].volume = -9; });
        await reread();
        const qb = await questions();
        assert("modifiche proprie nel file importato: si chiede, di quel file",
          qb.length === 1 && qb[0].title === `${FILE} e' cambiato su disco`
            && qb[0].acts.join(",") === "ricarica,sovrascrivi", JSON.stringify(qb));
        assert("...e intanto non si scrive niente", fs.readFileSync(importPath, "utf8") === labB
          && rivaOnsetOnDisk() === riva0 + 1);
        await page.click(".pge-toast.ask .tt-act:text-is('ricarica')");
        await wait(1200);
        assert("ricarica: la domanda si chiude", (await questions()).length === 0);
        assert("...il file si rilegge: la versione del laboratorio", (await ondaVolume()) === "-9"
          && Math.abs((await ondaWidth()) - w0) < 2, `${await ondaVolume()} · ${w0} → ${await ondaWidth()}`);
        assert("...il salvataggio riprende: il lavoro nel master si salva", rivaOnsetOnDisk() === riva0 + 2,
          `${riva0} → ${rivaOnsetOnDisk()}`);
        assert("...e il file resta del laboratorio, byte per byte", fs.readFileSync(importPath, "utf8") === labB);

        // (c) «sovrascrivi»: il file prende la versione dell'editor.
        await importedClip();
        await page.keyboard.press("Control+Shift+ArrowRight");
        await wait(300);
        labWritesFile(importPath, d => { d.streams[0].volume = -12; });
        await reread();
        assert("ancora modifiche proprie nel file: si chiede", (await questions()).length === 1);
        await page.click(".pge-toast.ask .tt-act:text-is('sovrascrivi')");
        await wait(1200);
        const docC = lab.load(fs.readFileSync(importPath, "utf8"));
        assert("sovrascrivi: su disco c'e' la versione dell'editor, con la sua durata",
          docC.streams[0].volume === -9 && docC.streams[0].duration === 4
            && !fs.readFileSync(importPath, "utf8").startsWith("# scritto dal laboratorio"),
          JSON.stringify([docC.streams[0].volume, docC.streams[0].duration]));
        // La durata torna 3: lo split del passo 6 taglia a meta' uno stream di 3 s.
        await page.keyboard.press("Control+z");
        await wait(300);
        await save();
        assert("...e un undo salvato la riporta", lab.load(fs.readFileSync(importPath, "utf8")).streams[0].duration === 3);

        // (d) il render, senza modifiche proprie: il motore rilegge gli import
        // dal disco, e partito su un file riscritto dal laboratorio suonerebbe
        // una versione che l'editor non mostra. Il bridge rifiuta anche se il
        // render quel file non lo scrive; si rilegge e si rende.
        const renders4 = [];
        const onResponse = (r) => { if (new URL(r.url()).pathname === "/render") renders4.push(r.status()); };
        page.on("response", onResponse);
        const labD = labWritesFile(importPath, d => { d.streams[0].volume = -6; });
        await importedClip();
        await page.keyboard.press("r");
        await wait(1800);
        page.off("response", onResponse);
        assert("render su un file importato riscritto: nessuna domanda", (await questions()).length === 0,
          JSON.stringify(await questions()));
        assert("...un rifiuto, la rilettura, una riprova accettata", renders4.join(",") === "409,200",
          `risposte di /render: ${renders4.join(",")}`);
        assert("...sulla versione del laboratorio, che resta sua byte per byte",
          (await ondaVolume()) === "-6" && fs.readFileSync(importPath, "utf8") === labD, String(await ondaVolume()));

        // (e) master e file cambiati insieme, con modifiche proprie nel file:
        // una domanda sola. La rilettura del master riapre il brano intero,
        // file importati compresi, quindi la sua risposta vale per tutti e due.
        await importedClip();
        await page.keyboard.press("Control+Shift+ArrowRight");
        await wait(300);
        const labEm = labWritesFile(masterPath4, d => { d.title = "dal laboratorio, 4c"; });
        const labEf = labWritesFile(importPath, d => { d.streams[0].volume = -15; });
        await reread();
        const qe = await questions();
        assert("master e file importato cambiati, con modifiche proprie: una domanda sola, per tutti e due",
          qe.length === 1 && qe[0].title === `${MASTER}, ${FILE} sono cambiati su disco`, JSON.stringify(qe));
        await page.click(".pge-toast.ask .tt-act:text-is('ricarica')");
        await wait(1500);
        assert("ricarica: il brano si riapre dal disco, file importato compreso",
          (await questions()).length === 0 && (await ondaVolume()) === "-15"
            && Math.abs((await ondaWidth()) - w0) < 2, `${await ondaVolume()} · ${await ondaWidth()}`);
        assert("...e il salvataggio che riprende non riscrive niente: i due file restano del laboratorio",
          fs.readFileSync(masterPath4, "utf8") === labEm && fs.readFileSync(importPath, "utf8") === labEf);

        // I 409 di POST /save e /render sono provocati da questo passo: si
        // contano, uno per rifiuto, e si tolgono dagli errori in console.
        const refused4 = seen.errors.filter(e => / 409 /.test(e) && /\/(save|render)\b/.test(e));
        assert("i rifiuti in console sono quelli provocati dal laboratorio (5)", refused4.length === 5,
          refused4.join("\n      "));
        seen.errors.splice(0, seen.errors.length, ...seen.errors.filter(e => !refused4.includes(e)));
      }

      // 5 — due editor, un file (#185) su un brano con import. Una modifica
      // dentro lo stream importato non muove il master, che ne tiene solo il
      // piazzamento; ma e' lavoro proprio, e la rilettura — un "apri" del
      // progetto intero, file importati compresi — la butterebbe via senza
      // chiedere. Quindi: il laboratorio riscrive il master, e il salvataggio
      // chiede invece di rileggere.
      const jsy = require("js-yaml");
      const masterPath = path.join(session.paths.workspace, "configs", MASTER);
      const filePath = path.join(session.paths.workspace, "configs", FILE);
      await importedClip();
      await page.keyboard.press("Control+Shift+ArrowRight");
      await wait(300);
      const file5 = fs.readFileSync(filePath, "utf8");
      const m5 = jsy.load(fs.readFileSync(masterPath, "utf8"));
      m5.title = "dal laboratorio";
      const labMaster = "# scritto dal laboratorio\n" + jsy.dump(m5, { flowLevel: 3 });
      fs.writeFileSync(masterPath, labMaster);
      await save();
      const asks5 = await page.evaluate(() => document.querySelectorAll(".pge-toast.ask").length);
      assert("una modifica dentro lo stream importato e' lavoro proprio: si chiede, non si rilegge",
        asks5 === 1, `${asks5} domande`);
      assert("...e niente e' scritto: ne' il master del laboratorio ne' il file importato",
        fs.readFileSync(masterPath, "utf8") === labMaster && fs.readFileSync(filePath, "utf8") === file5);
      await page.click(".pge-toast.ask .tt-x");
      await wait(300);
      // Il 409 di POST /save e' provocato dal test: si conta, come nella
      // sezione 5, invece di sparire in un filtro.
      const refused6 = seen.errors.filter(e => / 409 /.test(e) && /\/save\b/.test(e));
      assert("...un rifiuto, in console", refused6.length === 1, refused6.join("\n      "));
      seen.errors.splice(0, seen.errors.length, ...seen.errors.filter(e => !refused6.includes(e)));

      // 6 — lo split dello stream importato (#187): la testa resta nel suo
      // file, accorciata, e la coda e' un file nuovo, `onda-2.yml`, scritto al
      // salvataggio e non allo split. Lo split vuole due cose che il workspace
      // non ha: la posizione di lettura (il sidecar dei grani, che c'e' solo
      // accanto a uno stem) e, con `loop_unit: normalized`, la durata del
      // sample. Le scrive il test — un WAV muto e un sidecar a mano — e la
      // pagina si ricarica, perche' media e stem l'editor li legge al boot e
      // all'apertura. Uno stem orfano `onda-3` e' l'altra meta' della regola:
      // un id che ha ancora uno stem non si prende.
      const wav = (seconds, sr = 8000) => {
        const n = Math.round(seconds * sr), b = Buffer.alloc(44 + 2 * n);
        b.write("RIFF", 0); b.writeUInt32LE(36 + 2 * n, 4); b.write("WAVE", 8);
        b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
        b.writeUInt32LE(sr, 24); b.writeUInt32LE(2 * sr, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
        b.write("data", 36); b.writeUInt32LE(2 * n, 40);
        return b;
      };
      const media = await page.evaluate(async () => (await fetch("/media")).json());
      fs.writeFileSync(path.join(media.path, "smoke.wav"), wav(2));
      const outDir = path.join(session.paths.workspace, "output");
      fs.mkdirSync(outDir, { recursive: true });
      const stemBase = MASTER.replace(/\.yml$/, "");
      fs.writeFileSync(path.join(outDir, `${stemBase}__onda.wav`), wav(3));
      fs.writeFileSync(path.join(outDir, `${stemBase}__onda-3.wav`), wav(1));
      const grains = [];
      for (let t = 0; t < 3; t += 0.25) grains.push({ t, dur: 0.05, vol: -6, ptr: +(t * 0.1).toFixed(3), pr: 0.8, v: 0 });
      fs.writeFileSync(path.join(outDir, `${stemBase}__onda__grains.json`),
        JSON.stringify({ stream_id: "onda", duration: 3, num_voices: 1, grains }));
      // Il lavoro non salvato della sezione 5 resta indietro: alla domanda
      // del browser ("lasciare la pagina?") si risponde si'.
      const leave = (d) => d.accept();
      page.on("dialog", leave);
      await page.reload();
      await page.waitForSelector(".lane .clip", { timeout: 15000 });
      page.off("dialog", leave);
      await page.click(".bw-tabs button:nth-child(2)");
      await page.evaluate((n) => {
        const it = [...document.querySelectorAll(".pge-browser .it.proj")]
          .find(e => (e.querySelector(".nm") || {}).textContent === n);
        if (it) it.click();
      }, MASTER);
      await page.waitForSelector(".lane .clip .clip-file", { timeout: 10000 });
      await wait(500);
      const entries8 = await entriesOf();
      const head8 = await importText();
      const dir8 = await streamsDir();
      const splitHere = async () => {
        await importedClip();
        // onda e' a onset 1 per 3 s: il cursore a 2.5 la taglia a meta'.
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("pge-seek", { detail: 2.5 })));
        await wait(200);
        await page.keyboard.press("d");
        await wait(600);                          // lo split aspetta GET /import-dir
      };
      // Il primo `d` chiede il sidecar e rifiuta (la posizione di lettura
      // non e' ancora in memoria): e' il rifiuto di sempre, non della #187.
      await splitHere();
      const refusedFirst = (await fileLabels()).length === 1;
      if (refusedFirst) await splitHere();
      const labels8 = await fileLabels();
      assert("lo split dello stream importato: la coda ha un file suo, onda-2.yml, accanto alla testa",
        labels8.length === 2 && labels8.includes(FILE) && labels8.includes("streams/onda-2.yml"),
        JSON.stringify(labels8));
      assert("...che allo split non si scrive", JSON.stringify(await streamsDir()) === JSON.stringify(dir8),
        JSON.stringify(await streamsDir()));
      await save();
      const tailDoc = await yamlOf(await importOf("streams/onda-2.yml"));
      const headDoc = await yamlOf(await importText());
      assert("salvato, la coda e' un documento del laboratorio a se': uno stream, stream_id = nome del file",
        !!tailDoc && tailDoc.streams.length === 1 && tailDoc.streams[0].stream_id === "onda-2",
        JSON.stringify(tailDoc));
      assert("...col seed del file originale, lunga quanto la coda",
        tailDoc && tailDoc.seed === 1441 && tailDoc.duration === 1.5 && tailDoc.streams[0].duration === 1.5,
        JSON.stringify(tailDoc && [tailDoc.seed, tailDoc.duration, tailDoc.streams[0].duration]));
      // Il sidecar dice ptr 0.15 a 1.5 s dall'onset; il sample dura 2 s, e
      // loop_unit e' normalized: start = 0.15 / 2.
      assert("...che riprende la lettura del sample dove la testa si ferma",
        tailDoc && tailDoc.streams[0].pointer.start === 0.075, JSON.stringify(tailDoc && tailDoc.streams[0].pointer));
      assert("la testa resta nel suo file, accorciata",
        headDoc.streams[0].stream_id === "onda" && headDoc.streams[0].duration === 1.5 && headDoc.duration === 1.5,
        JSON.stringify([headDoc.duration, headDoc.streams[0].duration]));
      const entries9 = await entriesOf();
      const tailEntry = entries9.find(e => e.file === "streams/onda-2.yml");
      assert("il master ha due voci `file:`: la testa dov'era, la coda all'onset del taglio, senza stream_id",
        JSON.stringify(entries9.find(e => e.file === FILE)) === JSON.stringify(entries8.find(e => e.file === FILE))
          && JSON.stringify(tailEntry) === JSON.stringify({ file: "streams/onda-2.yml", onset: 2.5 })
          && entries9.length === entries8.length + 1, JSON.stringify(entries9));

      // Un undo solo: testa e coda tornano lo stream di prima, il master pure.
      await page.keyboard.press("Control+z");
      await wait(300);
      assert("lo split e' un passo solo di undo", (await fileLabels()).length === 1, JSON.stringify(await fileLabels()));
      await save();
      assert("...salvato, la voce della coda sparisce e la testa torna intera",
        JSON.stringify(await entriesOf()) === JSON.stringify(entries8)
          && JSON.stringify(await yamlOf(await importText())) === JSON.stringify(await yamlOf(head8)),
        JSON.stringify(await entriesOf()));
      // Di nuovo: onda-2.yml c'e' su disco, onda-3 ha uno stem. Si passa a -4.
      await splitHere();
      const labels10 = await fileLabels();
      assert("tagliato di nuovo: onda-2.yml esiste, onda-3 ha uno stem — la coda e' onda-4",
        labels10.includes("streams/onda-4.yml") && (await streamsDir()).includes("streams/onda-2.yml"),
        JSON.stringify(labels10));
      // ...e annullato PRIMA del salvataggio: su disco non resta niente.
      await page.keyboard.press("Control+z");
      await wait(300);
      await save();
      assert("undo dello split prima del salvataggio: niente nel master, niente su disco",
        JSON.stringify(await entriesOf()) === JSON.stringify(entries8)
          && !(await streamsDir()).includes("streams/onda-4.yml"), JSON.stringify(await streamsDir()));
    }

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
