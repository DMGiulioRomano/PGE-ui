/* =============================================================================
 * test-lab-roundtrip-parity.js — per il motore, un documento del laboratorio
 * passato da PGE-ui e' ancora lo stesso stream (#188).
 *
 * `tests/node/test-lab-roundtrip.js` chiede a PGE-ui che il file riscritto sia
 * lo stesso YAML del laboratorio. Qui la stessa domanda si fa a chi lo rende:
 * il master delle fixture (tests/fixtures/lab/) e i documenti che importa,
 * risolti dal MOTORE (`resolve_stream_files`) prima e dopo il giro in PGE-ui —
 * aperto e riscritto, master e file come li scriverebbe il salvataggio — devono
 * dare gli stessi stream: lo stesso fingerprint della cache del motore e lo
 * stesso piazzamento (che l'hash non vede: `mute` e `solo` sono fra le sue
 * chiavi ignorate). Poi la controprova: `volume` toccato su uno stream muove il
 * fingerprint di quello stream e di nessun altro, quindi l'uguaglianza qui
 * sopra non e' quella di un hash cieco.
 *
 * Nessun valore atteso e' scritto di qua, e le regole di risoluzione non si
 * ricopiano: i due termini di ogni confronto sono risposte del motore.
 *
 * Run: node tests/parity/test-lab-roundtrip-parity.js
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

/* Aprire come `onProjectSelect` (i testi letti, poi il parse che li risolve)
   e cio' che il salvataggio scriverebbe: il master, e ogni file importato. */
const open = () => Y.parse(MASTER, { project: "master", samples: [],
  imports: Object.fromEntries(Object.entries(DISK).map(([f, t]) => [f, { text: t }])) });
const written = (d) => ({ master: Y.serialize(d), files: Y.serializeImports(d).files });

parity({
  suite: "lab-roundtrip",
  why: "documenti del laboratorio importati con file:, prima e dopo PGE-ui  ↔  resolve_stream_files + compute_fingerprint",
  cases: [
    {
      label: "il motore risolve gli stessi stream prima e dopo il giro in PGE-ui",
      run: async (ask, assert) => {
        const load = (t) => window.jsyaml.load(t);
        const engineOf = async (docs) => {
          const r = await ask("resolve_stream_files", {
            master: load(docs.master),
            files: Object.fromEntries(Object.entries(docs.files).map(([f, t]) => [f, load(t)])) });
          if (!r.ok) throw new Error(`resolve_stream_files: ${r.error}`);
          return r.value.streams;
        };
        const hexOf = async (stream) => {
          const r = await ask("fingerprint", { stream });
          if (!r.ok) throw new Error(`fingerprint: ${r.error}`);
          return r.value.hex;
        };
        // Il piazzamento come lo legge il motore: mute e solo per presenza.
        const place = (s) => JSON.stringify({ stream_id: String(s.stream_id), onset: s.onset ?? 0,
                                              mute: "mute" in s, solo: "solo" in s });

        const before = await engineOf({ master: MASTER, files: DISK });
        const hexBefore = await Promise.all(before.map(hexOf));
        assert("il master delle fixture si risolve: sei stream, cinque importati",
          before.length === 6 && Object.keys(DISK).length === 5,
          before.map(s => s.stream_id).join(", "));

        const d0 = open();
        assert("PGE-ui apre il master senza errori di import", !d0.importErrors,
          JSON.stringify(d0.importErrors));
        const after = await engineOf(written(d0));
        assert("riscritto da PGE-ui, lo stesso numero di stream nello stesso ordine",
          JSON.stringify(after.map(s => String(s.stream_id))) === JSON.stringify(before.map(s => String(s.stream_id))),
          `${before.map(s => s.stream_id)} → ${after.map(s => s.stream_id)}`);
        for (let i = 0; i < before.length; i++) {
          const id = before[i].stream_id;
          assert(`${id}: stesso fingerprint del motore`, hexBefore[i] === await hexOf(after[i]),
            `prima ${JSON.stringify(before[i])}\n      dopo  ${JSON.stringify(after[i])}`);
          assert(`${id}: stesso piazzamento (mute e solo compresi)`, place(before[i]) === place(after[i]),
            `${place(before[i])} → ${place(after[i])}`);
        }

        /* La controprova: l'hash deve vedere una modifica vera, e solo dove
           e' stata fatta. Senza, l'uguaglianza qui sopra potrebbe essere quella
           di un fingerprint che non guarda il contenuto dei file importati. */
        const moved = [];
        for (const s of d0.streams.filter(x => x._import)) {
          const d1 = { ...d0, streams: d0.streams.map(x =>
            (x === s ? Y.applyStreamPatch(x, { volume: -3, volumeEnv: null }) : x)) };
          const res = await engineOf(written(d1));
          for (let i = 0; i < res.length; i++) {
            const changed = (await hexOf(res[i])) !== hexBefore[i];
            const target = String(res[i].stream_id) === s.id;
            if (changed !== target) moved.push(`volume di ${s.id}: ${res[i].stream_id} ${changed ? "si e' mosso" : "e' fermo"}`);
            if (target && res[i].volume !== -3) moved.push(`volume di ${s.id}: il motore legge ${JSON.stringify(res[i].volume)}`);
          }
        }
        assert("volume toccato su uno stream importato: il motore lo vede su quello, e su nessun altro",
          moved.length === 0, moved.join("\n      "));
      },
    },
  ],
});
