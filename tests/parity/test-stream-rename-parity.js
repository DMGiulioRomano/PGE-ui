/* =============================================================================
 * test-stream-rename-parity.js — per il motore, uno stream importato
 * rinominato e' lo stesso stream con l'id nuovo, nel file col nome nuovo (#208).
 *
 * `tests/node/test-stream-orphans.js` chiede a PGE-ui cosa scrive quando
 * rinomina uno stream importato con `file:`: un file nuovo
 * `<cartella>/<nuovo>.yml` con lo `stream_id` del suo nome, la voce del master
 * col file nuovo e senza `stream_id`, e il file vecchio fra quelli da
 * cancellare. Qui la stessa domanda si fa a chi lo rende: ogni stream
 * importato del master delle fixture del laboratorio (tests/fixtures/lab/)
 * rinominato, master e file come li lascerebbe il salvataggio — il file nuovo
 * scritto, il vecchio CANCELLATO, cioe' tolto dai file che l'oracolo puo'
 * leggere — risolti dal MOTORE (`resolve_stream_files`).
 *
 * Il motore deve trovarci lo stream con l'id nuovo — che nel master non e'
 * scritto: e' il suo default, il nome del file, ed e' li' che la regola "il
 * file e' l'id" si verifica — e per il resto lo stesso stream di prima: il suo
 * fingerprint e' quello dello stream di prima con lo `stream_id` nuovo. Gli
 * altri stream identici a prima. E il file nuovo da solo, come lo aprirebbe il
 * laboratorio, e' uno stream con lo stesso id: e' il punto dell'issue, brano e
 * laboratorio suonano la stessa realizzazione. Fra le fixture c'e' `voci.yml`
 * importato come `coro`: la voce che divergeva dal nome del file, rinominata,
 * torna a coincidere.
 *
 * Nessun valore atteso e' scritto di qua che il motore possa dire da se': gli
 * stream "di prima" sono la sua risoluzione del master non toccato.
 *
 * Run: node tests/parity/test-stream-rename-parity.js
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["yaml-bridge.js"]);
const Y = window.PGEYaml;

const LAB = path.join(__dirname, "../fixtures/lab");
const MASTER = fs.readFileSync(path.join(LAB, "master.yml"), "utf8");
const DISK = Object.fromEntries(Y.importRefs(MASTER).map(f =>
  [f, fs.readFileSync(path.join(LAB, f), "utf8")]));
const open = () => Y.parse(MASTER, { project: "master", samples: [],
  imports: Object.fromEntries(Object.entries(DISK).map(([f, t]) => [f, { text: t }])) });

parity({
  suite: "stream-rename",
  why: "la rinomina di uno stream importato: il file nuovo col nome nuovo, il vecchio cancellato  ↔  resolve_stream_files + compute_fingerprint",
  cases: [
    {
      label: "il motore trova lo stream di prima con l'id nuovo, nel file nuovo, senza il file vecchio",
      run: async (ask, assert) => {
        const load = (t) => window.jsyaml.load(t);
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
        const loadAll = (files) => Object.fromEntries(Object.entries(files).map(([f, t]) => [f, load(t)]));

        const before = (await resolve(load(MASTER), loadAll(DISK))).streams;
        const byIdBefore = Object.fromEntries(before.map(s => [String(s.stream_id), s]));
        const hexBefore = Object.fromEntries(await Promise.all(before.map(async s => [String(s.stream_id), await hexOf(s)])));
        const d0 = open();
        assert("il master delle fixture si apre senza errori di import", !d0.importErrors, JSON.stringify(d0.importErrors));
        const disk0 = Y.serializeImports(d0).files;

        for (const src of d0.streams.filter(s => s._import)) {
          const newId = `${src.id}-r`;
          const data = { ...d0, streams: d0.streams.map(s => (s === src ? Y.renameImport(s, newId, d0.streams) : s)) };
          const moved = data.streams.find(s => s.id === newId);
          // Il disco dopo il salvataggio: cio' che c'era, piu' cio' che il
          // salvataggio scrive, meno cio' che cancella.
          const gone = Y.importOrphans(data, disk0);
          const files = { ...DISK, ...Y.serializeImports(data).files };
          for (const f of gone) delete files[f];
          assert(`${src.id}: il file vecchio, ${src._import.file}, e' fra quelli da cancellare`,
            gone.length === 1 && gone[0] === src._import.file, JSON.stringify(gone));

          const after = await resolve(load(Y.serialize(data)), loadAll(files));
          const byId = Object.fromEntries(after.streams.map(s => [String(s.stream_id), s]));
          assert(`${src.id}: il motore lo trova come ${newId}, il nome del suo file, anche senza stream_id nel master`,
            !!byId[newId] && !byId[src.id] && moved._import.file === `streams/${newId}.yml`,
            `${after.streams.map(s => s.stream_id)} · ${moved._import.file}`);
          assert(`${src.id}: e il master importa il file nuovo, non il vecchio`,
            after.imported.includes(moved._import.file) && !after.imported.includes(src._import.file),
            JSON.stringify(after.imported));
          const same = await hexOf({ ...byIdBefore[src.id], stream_id: newId });
          assert(`${src.id}: per il fingerprint del motore e' lo stream di prima con l'id nuovo`,
            !!byId[newId] && (await hexOf(byId[newId])) === same);
          const others = [];
          for (const s of after.streams) {
            const sid = String(s.stream_id);
            if (sid === newId) continue;
            if (await hexOf(s) !== hexBefore[sid]) others.push(sid);
          }
          assert(`${src.id}: gli altri stream sono quelli di prima`, others.length === 0, others.join(", "));
          // Il file nuovo da solo, come lo aprirebbe il laboratorio: lo stesso id
          // del brano, cioe' la stessa realizzazione.
          const solo = (await resolve(load(files[moved._import.file]), {})).streams;
          assert(`${src.id}: ${moved._import.file} da solo e' uno stream, ${newId}: brano e laboratorio dicono lo stesso id`,
            solo.length === 1 && String(solo[0].stream_id) === newId,
            JSON.stringify(solo.map(s => s.stream_id)));
        }
      },
    },
    {
      /* Il laboratorio salva il file VECCHIO fra la rinomina e il salvataggio
         qui: il bridge rifiuta (la firma letta del file vecchio non e' piu'
         quella), l'editor rilegge quel file dentro lo stream rinominato
         (`rereadImport`) e riprova. Cio' che il salvataggio lascia su disco —
         il file nuovo scritto da quello stato, il vecchio cancellato — deve
         suonare per il motore come il brano NON rinominato col file del
         laboratorio, a parte l'id: il lavoro del laboratorio non si perde
         nello spostamento. */
      label: "il file vecchio salvato dal laboratorio dopo la rinomina: il motore trova il suo stream nel file nuovo",
      run: async (ask, assert) => {
        const load = (t) => window.jsyaml.load(t);
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
        const loadAll = (files) => Object.fromEntries(Object.entries(files).map(([f, t]) => [f, load(t)]));
        const d0 = open();
        const disk0 = Y.serializeImports(d0).files;

        for (const src of d0.streams.filter(s => s._import)) {
          const newId = `${src.id}-r`;
          const old = src._import.file;
          const data = { ...d0, streams: d0.streams.map(s => (s === src ? Y.renameImport(s, newId, d0.streams, disk0) : s)) };
          // Il laboratorio riscrive il file vecchio a modo suo, col volume cambiato.
          const labDoc = load(DISK[old]);
          labDoc.streams[0].volume = -7.5;
          const labText = "# scritto dal laboratorio\n" + window.jsyaml.dump(labDoc);
          assert(`${src.id}: il file vecchio e' una lettura da rispettare`,
            Y.importReadFiles(data, disk0).includes(old), JSON.stringify(Y.importReadFiles(data, disk0)));
          const out = Y.rereadImport(data, old, labText, { project: "master" });
          assert(`${src.id}: la rilettura del file vecchio non da' errori`, !out.error, out.error);
          if (out.error) continue;
          const reread = out.data;
          const moved = reread.streams.find(s => s.id === newId);
          // Il disco dopo il salvataggio che riprova.
          const disk1 = { ...disk0, ...Y.importMoveSources(reread, disk0) };
          const gone = Y.importOrphans(reread, disk1);
          const files = { ...DISK, [old]: labText, ...Y.serializeImports(reread).files };
          for (const f of gone) delete files[f];
          assert(`${src.id}: il file vecchio si cancella, quello nuovo c'e'`,
            gone.length === 1 && gone[0] === old && moved._import.file in files, JSON.stringify(gone));

          const after = (await resolve(load(Y.serialize(reread)), loadAll(files))).streams;
          const byId = Object.fromEntries(after.map(s => [String(s.stream_id), s]));
          const withLab = (await resolve(load(MASTER), loadAll({ ...DISK, [old]: labText }))).streams;
          const labStream = withLab.find(s => String(s.stream_id) === String(src.id));
          assert(`${src.id}: per il motore lo stream nel file nuovo e' quello del laboratorio, con l'id nuovo`,
            !!byId[newId] && !!labStream
              && (await hexOf(byId[newId])) === (await hexOf({ ...labStream, stream_id: newId })),
            JSON.stringify({ volume: byId[newId] && byId[newId].volume }));
          assert(`${src.id}: ...e non quello di prima della rinomina`,
            !!byId[newId] && byId[newId].volume === -7.5, String(byId[newId] && byId[newId].volume));
        }
      },
    },
  ],
});
