/* =============================================================================
 * test-stream-own-file-parity.js — per il motore, uno stream importato che
 * prende un file suo e' lo STESSO stream: stesso id, stesso fingerprint (#205).
 *
 * Lo stesso file importato da piu' voci del master e' un documento solo: le
 * voci differiscono nel piazzamento e basta. Appena una modifica di contenuto
 * ne tocca una, le copie in memoria divergono e salvataggio e render si
 * rifiutano (#184). Il rimedio mancava: dare a una voce un file suo. Il gesto
 * (`PGEYaml.ownFileImport`) e' un trasloco, non una copia (#186): il file
 * nuovo e' `<cartella>/<id>.yml`, lo stream TIENE il suo id — quindi la
 * realizzazione, `(seed, stream_id, componente)` — e la voce del master
 * diventa `file: <nuovo>` senza `stream_id`, che e' il default.
 *
 * Qui la domanda si fa a chi rende (`resolve_stream_files` + `fingerprint`),
 * su master e file come li lascerebbe il salvataggio:
 *   · il file condiviso: `streams/voci.yml` importato da `coro` e da `alto`
 *     (il caso della issue). `coro` prende `streams/coro.yml`: il motore lo
 *     trova con lo stesso fingerprint di prima, `alto` invariato, e
 *     `voci.yml` resta (lo importa ancora `alto`);
 *   · il file di una voce sola il cui nome non e' l'id: `voci.yml` importato
 *     come `coro` nel master delle fixture del laboratorio. Il gesto lo porta
 *     a `streams/coro.yml`, e `voci.yml` — che nessuno importa piu' — fra i
 *     file da cancellare (#208).
 * In entrambi il file nuovo, aperto da solo come lo aprirebbe il laboratorio,
 * e' uno stream con lo stesso id: brano e laboratorio suonano lo stesso.
 *
 * Nessun valore atteso e' scritto di qua: lo stream "di prima" e' la
 * risoluzione del motore del master non toccato.
 *
 * Run: node tests/parity/test-stream-own-file-parity.js
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["yaml-bridge.js"]);
const Y = window.PGEYaml;

const LAB = path.join(__dirname, "../fixtures/lab");
const LAB_MASTER = fs.readFileSync(path.join(LAB, "master.yml"), "utf8");
const readAll = (master) => Object.fromEntries(Y.importRefs(master).map(f =>
  [f, fs.readFileSync(path.join(LAB, f), "utf8")]));
// La voce condivisa: lo stesso file del laboratorio, importato due volte.
const SHARED_MASTER =
  "seed: 1441\nstreams:\n" +
  "  - file: streams/voci.yml\n    stream_id: coro\n    onset: 0\n" +
  "  - file: streams/voci.yml\n    stream_id: alto\n    onset: 4\n    mute: false\n" +
  "  - file: streams/risacca.yml\n    onset: 2\n";

const open = (master, disk) => Y.parse(master, { project: "master", samples: [],
  imports: Object.fromEntries(Object.entries(disk).map(([f, t]) => [f, { text: t }])) });

parity({
  suite: "stream-own-file",
  why: "il file suo di uno stream importato: stesso id, il file col suo nome  ↔  resolve_stream_files + fingerprint (#205)",
  cases: [
    ...[
      ["il file condiviso: coro e alto importano voci.yml", SHARED_MASTER, "coro", false],
      ["il file di una voce sola, col nome che non e' l'id (le fixture del laboratorio)", LAB_MASTER, "coro", true],
    ].map(([label, MASTER, id, orphan]) => ({
      label,
      run: async (ask, assert) => {
        const load = (t) => window.jsyaml.load(t);
        const loadAll = (files) => Object.fromEntries(Object.entries(files).map(([f, t]) => [f, load(t)]));
        const resolve = async (master, files) => {
          const r = await ask("resolve_stream_files", { master, files });
          if (!r.ok) throw new Error(`resolve_stream_files: ${r.error}`);
          return r.value;
        };
        const hexOf = async (stream) => {
          const r = await ask("fingerprint", { stream });
          if (!r.ok) throw new Error(`fingerprint: ${r.error}`);
          return r.value.hex;
        };
        const DISK = readAll(MASTER);
        const before = (await resolve(load(MASTER), loadAll(DISK))).streams;
        const hexBefore = Object.fromEntries(await Promise.all(before.map(async s => [String(s.stream_id), await hexOf(s)])));

        const d0 = open(MASTER, DISK);
        assert("il master si apre senza errori di import", !d0.importErrors, JSON.stringify(d0.importErrors));
        const disk0 = Y.serializeImports(d0).files;
        const src = d0.streams.find(s => s.id === id);
        const plan = Y.importOwnFile(src, d0.streams);
        assert(`${id}: il file suo e' streams/${id}.yml`, plan.file === `streams/${id}.yml`, JSON.stringify(plan));

        const data = { ...d0, streams: d0.streams.map(s => (s === src ? Y.ownFileImport(s, d0.streams, disk0) : s)) };
        const moved = data.streams.find(s => s.id === id);
        assert(`${id}: tiene il suo id, e cambia file`, !!moved && moved._import.file === plan.file);
        assert(`${id}: il file nuovo si crea al salvataggio, non al gesto`,
          JSON.stringify(Y.importCreates(data, disk0)) === JSON.stringify([plan.file]));
        const imp = Y.serializeImports(data);
        assert("nessun conflitto", imp.conflicts.length === 0, JSON.stringify(imp.conflicts));

        // Il disco dopo il salvataggio: cio' che c'era, piu' cio' che il
        // salvataggio scrive, meno cio' che cancella.
        const gone = Y.importOrphans(data, disk0);
        const files = { ...DISK, ...imp.files };
        for (const f of gone) delete files[f];
        assert(orphan ? "voci.yml, che nessuno importa piu', e' fra i file da cancellare"
                      : "voci.yml resta: lo importa ancora alto",
          JSON.stringify(gone) === JSON.stringify(orphan ? ["streams/voci.yml"] : []), JSON.stringify(gone));

        const master = load(Y.serialize(data));
        const entry = master.streams.find(e => e && e.file === plan.file);
        assert(`la voce del master e' file: ${plan.file}, senza stream_id (e' il default)`,
          !!entry && !("stream_id" in entry), JSON.stringify(master.streams));
        const after = await resolve(master, loadAll(files));
        const byId = Object.fromEntries(after.streams.map(s => [String(s.stream_id), s]));
        assert(`${id}: il motore lo trova nel file nuovo`, !!byId[id] && after.imported.includes(plan.file),
          `${after.streams.map(s => s.stream_id)} · ${JSON.stringify(after.imported)}`);
        assert(`${id}: per il fingerprint del motore e' lo stesso stream di prima`,
          !!byId[id] && (await hexOf(byId[id])) === hexBefore[id]);
        const others = [];
        for (const s of after.streams) {
          const sid = String(s.stream_id);
          if (sid !== id && (await hexOf(s)) !== hexBefore[sid]) others.push(sid);
        }
        assert("gli altri stream sono quelli di prima", others.length === 0 && after.streams.length === before.length,
          others.join(", "));
        const solo = (await resolve(load(files[plan.file]), {})).streams;
        assert(`${plan.file} da solo e' uno stream, ${id}: brano e laboratorio dicono lo stesso id`,
          solo.length === 1 && String(solo[0].stream_id) === id, JSON.stringify(solo.map(s => s.stream_id)));
      },
    })),
    {
      label: "il conflitto che il gesto scioglie: una modifica su una voce sola",
      run: async (ask, assert) => {
        /* Il caso della issue: il volume di `coro` cambiato, e `voci.yml` in
           conflitto. Dato a `coro` un file suo, il conflitto sparisce e il
           motore suona `coro` col volume nuovo e `alto` com'era. */
        const load = (t) => window.jsyaml.load(t);
        const loadAll = (files) => Object.fromEntries(Object.entries(files).map(([f, t]) => [f, load(t)]));
        const DISK = readAll(SHARED_MASTER);
        const d0 = open(SHARED_MASTER, DISK);
        const disk0 = Y.serializeImports(d0).files;
        const edited = { ...d0, streams: d0.streams.map(s => (s.id === "coro" ? { ...s, volume: -20 } : s)) };
        assert("una modifica su coro sola mette voci.yml in conflitto",
          JSON.stringify(Y.serializeImports(edited).conflicts) === JSON.stringify(["streams/voci.yml"]));
        const data = { ...edited, streams: edited.streams.map(s => (s.id === "coro" ? Y.ownFileImport(s, edited.streams, disk0) : s)) };
        const imp = Y.serializeImports(data);
        assert("…e il file suo lo scioglie", imp.conflicts.length === 0, JSON.stringify(imp.conflicts));
        const files = { ...DISK, ...imp.files };
        const r = await ask("resolve_stream_files", { master: load(Y.serialize(data)), files: loadAll(files) });
        if (!r.ok) throw new Error(`resolve_stream_files: ${r.error}`);
        const byId = Object.fromEntries(r.value.streams.map(s => [String(s.stream_id), s]));
        assert("il motore suona coro col volume nuovo, alto com'era",
          byId.coro && byId.coro.volume === -20 && byId.alto && byId.alto.volume === load(DISK["streams/voci.yml"]).streams[0].volume,
          JSON.stringify({ coro: byId.coro && byId.coro.volume, alto: byId.alto && byId.alto.volume }));
      },
    },
  ],
});
