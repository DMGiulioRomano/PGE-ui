/* =============================================================================
 * test-workspace.js — la cartella dei progetti si stacca dal repo del motore
 * (#147).
 *
 * `--root` e' la sorgente del motore, il *workspace* e' dove vivono
 * configs/ output/ cache/ — cioe' il lavoro dell'autore. La commutazione a
 * caldo passa da POST /workspace, e il pezzo delicato sta di qua: quello che
 * il browser ha in mano descrive la cartella di PRIMA.
 *
 * L'indice degli stem e' il caso peggiore. Sopravvive in localStorage, e'
 * chiavato su `<basename>__<id><ext>` senza traccia di quale output/ lo ha
 * prodotto, e nessuno lo smentisce: una clip che risulta renderizzata ma il
 * cui stem sta nell'altra cartella si disegna col pallino verde e non suona.
 * Il 404 dell'<audio> non e' un errore visibile — `canplay` semplicemente non
 * parte mai. Quindi il cambio riuscito lo svuota, e /stems lo riempie di nuovo
 * dal disco al primo progetto caricato.
 *
 * L'altra meta': un cambio RIFIUTATO (percorso inesistente, render in corso)
 * non deve toccare niente. E' una risposta del server, non un guasto: nessuna
 * eccezione, il messaggio arriva al campo in Settings, lo stato resta dov'era.
 *
 * Run: node test-workspace.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

let pass = 0, fail = 0;
// Il corpo della suite e' un IIFE async: se muore a meta', i suoi assert non
// contano e i contatori direbbero "0 failed" su una suite che non e' arrivata
// in fondo. La bandiera lo dice all'handler `exit`.
let bodyDone = false;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

/* ---- finto disco + finto server.py ---------------------------------- */
let DISK = [];                 // stem nella output/ del workspace corrente
let WS   = "/engine";          // workspace corrente lato "server"
let REFUSE = null;             // { status, error } per far rifiutare la POST
const POSTS = [];              // corpi inviati a POST /workspace

const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

function jsonRes(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

global.fetch = (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith("/workspace") && (opts.method || "GET") === "POST") {
    const body = JSON.parse(opts.body || "{}");
    POSTS.push(body);
    if (REFUSE) {
      // Come server.py: il corpo dell'errore porta comunque lo stato attuale.
      return jsonRes(REFUSE.status,
        { ok: false, error: REFUSE.error, workspace: WS, isRoot: false, paths: {}, projects: [] });
    }
    WS = body.path || "/engine";
    DISK = [];                 // la output/ nuova e' un'altra cartella
    return jsonRes(200, { ok: true, workspace: WS, isRoot: WS === "/engine",
                          paths: { configs: WS + "/configs", output: WS + "/output" },
                          projects: [{ name: "altro.yml", mtime: 1 }] });
  }
  if (u.endsWith("/workspace")) {
    return jsonRes(200, { ok: true, workspace: WS, isRoot: WS === "/engine",
                          paths: {}, projects: [] });
  }
  const m = u.match(/\/stems\/([^?]+)/);
  if (m) {
    const bn = decodeURIComponent(m[1]);
    const stems = DISK.filter(f => f.startsWith(bn + "__")).map(f => ({
      streamId: f.slice(bn.length + 2).replace(/\.[^.]+$/, ""),
      ext: f.slice(f.lastIndexOf(".")),
      mtime: 1700000000,
      dur: 4.0,
    }));
    return jsonRes(200, { basename: bn, stems });
  }
  return Promise.reject(new Error("unexpected fetch " + u));
};

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

const backend = window.PGEBackend.create({ baseUrl: "http://x" });

(async () => {
  console.log("\n── un cambio riuscito dimentica gli stem dell'altra cartella ──");
  {
    DISK = ["proj__stream1.wav", "proj__stream2.wav"];
    await backend.render.loadCache("proj");
    assert("l'indice parte pieno", backend.render.hasStem("proj", "stream1", "wav") === true);
    assert("e sa quanto dura lo stem su disco", backend.render.stemDur("proj", "stream1") === 4.0);

    const res = await backend.setWorkspace("/brani");
    assert("la commutazione riesce", res.ok === true && res.workspace === "/brani",
           JSON.stringify(res));
    assert("l'elenco progetti nuovo torna con la risposta",
           (res.projects || []).length === 1 && res.projects[0].name === "altro.yml");

    assert("hasStem non rivendica piu' lo stem dell'altra output/",
           backend.render.hasStem("proj", "stream1", "wav") === false);
    assert("ownsStem nemmeno (e' format-agnostico, ma l'indice e' vuoto)",
           backend.render.ownsStem("proj", "stream1") === false);
    assert("la durata su disco se ne va con lui",
           backend.render.stemDur("proj", "stream1") === null);
    assert("e lo svuotamento e' persistito, non solo in memoria",
           JSON.parse(store["pge-local-stems"] || "{}") &&
           Object.keys(JSON.parse(store["pge-local-stems"] || "{}")).length === 0,
           store["pge-local-stems"]);
  }

  console.log("\n── e /stems lo ripopola dalla cartella nuova ──");
  {
    DISK = ["proj__stream1.wav"];          // stessa proj, altra output/
    await backend.render.loadCache("proj");
    assert("lo stem che esiste davvero qui torna a contare",
           backend.render.hasStem("proj", "stream1", "wav") === true);
    assert("quello che qui non c'e' resta assente",
           backend.render.hasStem("proj", "stream2", "wav") === false);
  }

  console.log("\n── un cambio rifiutato non tocca niente ──");
  {
    DISK = ["proj__stream1.wav"];
    await backend.render.loadCache("proj");
    const before = store["pge-local-stems"];

    REFUSE = { status: 400, error: "non esiste: /refuso — crea la cartella e riprova" };
    const res = await backend.setWorkspace("/refuso");
    REFUSE = null;

    assert("il 400 e' una risposta, non un'eccezione", res && res.ok === false);
    assert("e porta con se' il messaggio del server (che finisce nel campo)",
           /non esiste/.test(res.error), JSON.stringify(res));
    assert("l'indice degli stem resta intatto",
           backend.render.hasStem("proj", "stream1", "wav") === true);
    assert("e non e' stato riscritto", store["pge-local-stems"] === before);
  }

  console.log("\n── 409 a render in corso: stessa regola ──");
  {
    REFUSE = { status: 409, error: "render in corso — riprova a render finito" };
    const res = await backend.setWorkspace("/altrove");
    REFUSE = null;
    assert("rifiutato senza throw", res && res.ok === false);
    assert("col motivo del server", /render in corso/.test(res.error));
    assert("gli stem restano quelli di adesso",
           backend.render.hasStem("proj", "stream1", "wav") === true);
  }

  console.log("\n── il campo vuoto significa 'torna al motore' ──");
  {
    POSTS.length = 0;
    await backend.setWorkspace("");
    assert("il percorso vuoto viaggia comunque, come stringa vuota",
           POSTS.length === 1 && POSTS[0].path === "",
           JSON.stringify(POSTS));
    // Il default lo decide il server (--root), non il browser: mandare
    // undefined lo farebbe leggere come chiave assente, che e' la stessa cosa,
    // ma la stringa vuota rende esplicito che il campo e' stato svuotato.
  }

  console.log("\n── il server e' l'autorita' sul percorso (source guard) ──");
  {
    const srv = fs.readFileSync(path.join(__dirname, "../../server.py"), "utf8");
    assert("le path di lavoro non sono piu' costanti della closure",
           /def _set_workspace\(path\)/.test(srv) && !/^\s*BASES = \{/m.test(srv));
    assert("la mappa kind→cartella si ricalcola a ogni richiesta",
           /def _bases\(\)/.test(srv) && /_bases\(\)\.get\(kind\)/.test(srv));
    assert("refs/ resta legata al motore (PythonGranularEngine#235)",
           /refs\s*=\s*root \/ "refs"/.test(srv));
    assert("la cartella deve esistere: si creano le sotto, non il workspace",
           /non esiste: \{target\}/.test(srv));
    assert("e la commutazione e' rifiutata a render in corso",
           /if rs\.is_running\(\):/.test(srv));
    const rp = fs.readFileSync(path.join(__dirname, "../../render_pipeline.py"), "utf8");
    assert("is_running guarda il processo, non solo il campo",
           /def is_running\(self\)/.test(rp) && /proc\.poll\(\) is None/.test(rp));
  }

  console.log("\n── il resto dello stato per-stream cade con l'indice (source guard) ──");
  {
    const app = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");
    const h = app.slice(app.indexOf("async function onWorkspaceChange"),
                        app.indexOf("async function onChooseMediaFolder"));
    assert("onWorkspaceChange esiste ed e' passato al pannello",
           h.length > 0 && /onWorkspaceChange=\{onWorkspaceChange\}/.test(app));
    for (const setter of ["setWaveforms({})", "setSpectrograms({})", "setGrainData({})"]) {
      assert(`butta ${setter}`, h.includes(setter));
    }
    assert("azzera i ref dei grani e la revisione degli stem",
           /grainLoadedRef\.current = new Set\(\)/.test(h) &&
           /grainRegenRef\.current = new Set\(\)/.test(h) &&
           /stemRevRef\.current = \{\}/.test(h));
    assert("invalida i buffer audio",
           /window\.PGEAudio\.engine\.invalidateAll\(\)/.test(h));
    assert("ricarica progetti e media", /refreshProjects\(\)/.test(h) && /refreshMedia\(\)/.test(h));
    // Due cartelle possono avere un progetto omonimo: li' `activeProject` non
    // cambia e l'effetto su [activeProject] non riparte. Senza questa riga
    // l'indice resterebbe vuoto e ogni clip ⚪ con gli stem sul disco.
    assert("e riempie l'indice degli stem senza aspettare l'effetto",
           /backend\.render\.loadCache\(target\.replace/.test(h));
  }

  console.log("\n── il pannello Settings ha il campo (source guard) ──");
  {
    const sp = fs.readFileSync(path.join(__dirname, "../../src/components/SettingsPanel.jsx"), "utf8");
    assert("sezione Workspace", /sp-sec-head">Workspace</.test(sp));
    assert("campo di testo + applica", /applyWorkspace\(wsPath\)/.test(sp));
    assert("e un modo di tornare al motore", /applyWorkspace\(""\)/.test(sp));
    assert("il valore mostrato viene dal server, non da una preferenza",
           /backend\.workspace\(\)/.test(sp) && !/tweaks\.workspacePath/.test(sp));
    assert("l'errore del server e' quello che si legge",
           /res && res\.error/.test(sp));
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
// test-suite-harness.js (#132).
process.on("exit", (code) => {
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
