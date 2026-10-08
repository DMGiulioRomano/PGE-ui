/* =============================================================================
 * test-stream-split-parity.js — per il motore, lo split di uno stream
 * importato e' una testa e una coda, ognuna nel suo file (#187).
 *
 * `tests/node/test-stream-split.js` chiede a PGE-ui cosa scrive quando taglia
 * uno stream importato con `file:`: il file della testa accorciato, il file
 * nuovo `<nome>-2.yml` con la coda, e una voce `file:` in piu' nel master.
 * Qui la stessa domanda si fa a chi lo rende: il master delle fixture del
 * laboratorio (tests/fixtures/lab/) tagliato a meta' di ogni stream importato,
 * master e file come li scriverebbe il salvataggio, risolti dal MOTORE
 * (`resolve_stream_files`). Il motore deve trovarci la testa col suo id e la
 * coda con l'id che PGE-ui le ha dato — che nel master non e' scritto: e' il
 * default del motore, il nome del file, ed e' li' che la regola "il file e'
 * l'id" si verifica — e gli altri stream identici a prima. Poi il file della
 * coda da solo, come lo aprirebbe il laboratorio: un documento con uno stream.
 *
 * Nessun valore atteso e' scritto di qua che il motore possa dire da se':
 * gli stream "di prima" sono la sua risoluzione del master non tagliato.
 *
 * Run: node tests/parity/test-stream-split-parity.js
 * =========================================================================== */

const fs = require("fs");
const path = require("path");
const { parity, loadUiLibs } = require("./harness.js");

const window = loadUiLibs(["yaml-bridge.js", "envelope-loops.js", "deviation-probability.js", "envelope-utils.js"]);
const Y = window.PGEYaml;
const EU = window.PGEEnvUtils;

const LAB = path.join(__dirname, "../fixtures/lab");
const MASTER = fs.readFileSync(path.join(LAB, "master.yml"), "utf8");
const DISK = Object.fromEntries(Y.importRefs(MASTER).map(f =>
  [f, fs.readFileSync(path.join(LAB, f), "utf8")]));
const open = () => Y.parse(MASTER, { project: "master", samples: [],
  imports: Object.fromEntries(Object.entries(DISK).map(([f, t]) => [f, { text: t }])) });

/* Lo split come lo fa splitAtPlayhead (app.jsx), sulle funzioni della
   libreria: testa congelata, coda tagliata col `pointer.start` dato, id dalle
   basi e provenienza nuova da `copyImport`. Il disco dopo il salvataggio e'
   quello di prima piu' cio' che il salvataggio scrive. */
function split(d, id, start) {
  const s = d.streams.find(x => x.id === id);
  const cutRel = s.duration / 2, t = s.onset + cutRel;
  const head = { ...EU.truncateStreamEnvelopes(EU.rescaleStreamEnvelopes(s, s.duration, cutRel)),
                 duration: cutRel, durationImplicit: false, durationUnresolved: false };
  const sliced = EU.sliceStreamEnvelopes(s, 0.5).stream;
  const body = { ...sliced, onset: t, duration: s.duration - cutRel,
                 durationImplicit: false, durationUnresolved: false, pointer: { ...(sliced.pointer || {}), start } };
  const [tailId] = Y.allocStreamIds(d.streams, [Y.importSplitBase(s)], () => false);
  const tail = Y.copyImport(body, tailId);
  return { data: { ...d, streams: [...d.streams.map(x => (x === s ? head : x)), tail] }, head, tail, t, cutRel };
}

parity({
  suite: "stream-split",
  why: "lo split di uno stream importato: testa nel suo file, coda in <nome>-2.yml  ↔  resolve_stream_files + compute_fingerprint",
  cases: [
    {
      label: "il motore trova la testa, la coda col nome del suo file, e il resto com'era",
      run: async (ask, assert) => {
        const load = (t) => window.jsyaml.load(t);
        const resolve = async (master, files) => {
          const r = await ask("resolve_stream_files", { master, files });
          if (!r.ok) throw new Error(`resolve_stream_files: ${r.error}`);
          return r.value.streams;
        };
        const hexOf = async (stream) => {
          const r = await ask("fingerprint", { stream });
          if (!r.ok) throw new Error(`fingerprint: ${r.error}`);
          return r.value.hex;
        };
        const docs = (d) => ({ ...DISK, ...Y.serializeImports(d).files });

        const before = await resolve(load(MASTER), Object.fromEntries(Object.entries(DISK).map(([f, t]) => [f, load(t)])));
        const hexBefore = Object.fromEntries(await Promise.all(before.map(async s => [String(s.stream_id), await hexOf(s)])));
        const d0 = open();
        assert("il master delle fixture si apre senza errori di import", !d0.importErrors, JSON.stringify(d0.importErrors));

        for (const src of d0.streams.filter(s => s._import)) {
          const { data, head, tail, t, cutRel } = split(d0, src.id, 0.3);
          const files = docs(data);
          const after = await resolve(load(Y.serialize(data)),
            Object.fromEntries(Object.entries(files).map(([f, txt]) => [f, load(txt)])));
          const byId = Object.fromEntries(after.map(s => [String(s.stream_id), s]));
          const base = Y.importSplitBase(src);
          assert(`${src.id}: la coda si chiama come il suo file, ${base}-2, anche senza stream_id nel master`,
            tail.id === `${base}-2` && !!byId[tail.id], `${tail.id} ↔ ${after.map(s => s.stream_id)}`);
          assert(`${src.id}: un id per stream, uno in piu' di prima`,
            after.length === before.length + 1 && new Set(after.map(s => String(s.stream_id))).size === after.length,
            after.map(s => s.stream_id).join(", "));
          const rt = byId[tail.id] || {};
          assert(`${src.id}: la coda e' all'onset del taglio, lunga quanto resta, e legge da dove la testa si ferma`,
            rt.onset === t && rt.duration === src.duration - cutRel && rt.pointer && rt.pointer.start === 0.3,
            JSON.stringify({ onset: rt.onset, duration: rt.duration, pointer: rt.pointer }));
          const rh = byId[src.id] || {};
          assert(`${src.id}: la testa tiene id e onset, ed e' accorciata`,
            rh.onset === src.onset && rh.duration === head.duration,
            JSON.stringify({ onset: rh.onset, duration: rh.duration }));
          const others = [];
          for (const s of after) {
            const sid = String(s.stream_id);
            if (sid === src.id || sid === tail.id) continue;
            if (await hexOf(s) !== hexBefore[sid]) others.push(sid);
          }
          assert(`${src.id}: gli altri stream sono quelli di prima, per il fingerprint del motore`,
            others.length === 0, others.join(", "));
          // Il file della coda da solo, come lo aprirebbe il laboratorio: un
          // documento, uno stream, che il motore chiama col nome del file.
          const alone = load(files[tail._import.file]);
          const solo = await resolve(alone, {});
          const headDoc = load(DISK[src._import.file]);
          assert(`${src.id}: ${tail._import.file} da solo e' uno stream, ${tail.id}, col seed dell'originale`,
            solo.length === 1 && String(solo[0].stream_id) === tail.id && alone.seed === headDoc.seed,
            JSON.stringify({ ids: solo.map(s => s.stream_id), seed: alone.seed, orig: headDoc.seed }));
        }
      },
    },
  ],
});
