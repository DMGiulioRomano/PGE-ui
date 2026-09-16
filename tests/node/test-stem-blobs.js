/* =============================================================================
 * test-stem-blobs.js — la cache di blob degli stem in audio-engine.js.
 *
 * Perche' esiste: un <audio> puntato direttamente all'URL http dello stem tiene
 * occupata la sua connessione per tutta la clip (il browser scarica a ritmo di
 * riproduzione, non in un colpo), e oltre il tetto di sei connessioni per
 * origine il settimo stem non arriva mai a `canplay`. Un elemento solo IN CODA
 * non emette nemmeno `error`: la traccia resta muta senza una riga da nessuna
 * parte — misurato sul progetto a nove stem di questo repo: sei partono in
 * 10 ms, il settimo a 8,3 s, gli ultimi due mai.
 *
 * Il rimedio e' scaricare i byte con fetch() (che libera lo slot appena ha
 * finito) e dare all'elemento un blob: URL, che di slot non ne costa. Qui si
 * verifica la parte che puo' sbagliare da sola: quando la cache riusa il blob
 * e quando no. Riusarlo di troppo significa suonare l'audio di PRIMA del
 * re-render, che e' il modo peggiore di fallire — il pallino e' verde e il
 * suono e' vecchio.
 *
 * Run: node test-stem-blobs.js (da tests/node/ dopo npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");
const { codeOf } = require("./source-guard");

const SRC = path.join(__dirname, "../../src/lib/audio-engine.js");

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

/* ---- finto ambiente browser: solo quello che la cache tocca -------------- */
const net = { heads: 0, bodies: 0, tag: "v1", ok: true, headOk: true };
const revoked = [];
let objSeq = 0;

global.window = {};
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
global.fetch = async (url, opts) => {
  if (opts && opts.method === "HEAD") {
    net.heads++;
    return { ok: net.headOk, headers: { get: (h) => (h === "etag" ? net.tag : null) } };
  }
  net.bodies++;
  if (!net.ok) return { ok: false, status: 404 };
  return { ok: true, blob: async () => ({ size: 1 }) };
};
global.URL = {
  createObjectURL: () => "blob:stem" + (++objSeq),
  revokeObjectURL: (o) => revoked.push(o),
};

eval(fs.readFileSync(SRC, "utf8"));
const engine = window.PGEAudio.engine;

const URL_A = "http://localhost:7878/output/p__stream1.wav";
const URL_B = "http://localhost:7878/output/p__stream2.wav";

(async () => {
  console.log("\n── un solo download per stem ──");
  const a1 = await engine._stemObjectUrl(URL_A);
  assert("il primo giro scarica i byte", net.bodies === 1 && a1.startsWith("blob:"));

  const a2 = await engine._stemObjectUrl(URL_A);
  // Stesso ETag = stesso file: il body non si riscarica, ed e' questo che rende
  // gratis un seek (che rischedula tutte le clip).
  assert("stesso ETag → nessun secondo download", net.bodies === 1);
  assert("stesso ETag → stesso blob", a2 === a1);
  assert("ma l'identita' del file viene ricontrollata", net.heads === 2);

  console.log("\n── un re-render cambia i byte sotto lo stesso nome ──");
  net.tag = "v2";
  const a3 = await engine._stemObjectUrl(URL_A);
  assert("ETag diverso → riscarica", net.bodies === 2);
  assert("ETag diverso → blob nuovo", a3 !== a1);
  assert("il blob vecchio viene revocato", revoked.includes(a1));

  console.log("\n── un tag sconosciuto non e' un tag uguale ──");
  // Nessun ETag (HEAD non disponibile) = "non lo so": riscaricare costa un
  // giro, riusare un blob stantio suona audio che l'autore non ha reso.
  net.headOk = false;
  const before = net.bodies;
  const a4 = await engine._stemObjectUrl(URL_A);
  assert("HEAD muta → riscarica invece di fidarsi", net.bodies === before + 1 && a4 !== a3);
  net.headOk = true;

  console.log("\n── il fetch fallito non resta in cache come successo ──");
  net.ok = false;
  let threw = false;
  try { await engine._stemObjectUrl(URL_B); } catch { threw = true; }
  assert("un 404 rifiuta la promise", threw);
  net.ok = true;
  const b1 = await engine._stemObjectUrl(URL_B);
  assert("e il giro dopo riprova davvero", b1 && b1.startsWith("blob:"));

  console.log("\n── il tetto non butta via quello che sta per servire ──");
  engine.setStreamUrls({ s1: URL_A });
  for (let i = 0; i < 40; i++) await engine._stemObjectUrl("http://x/" + i + ".wav");
  assert("la cache resta limitata", engine.stemBlobs.size <= 24 + 1,
    "size=" + engine.stemBlobs.size);
  assert("l'URL che il progetto corrente puo' ancora suonare sopravvive",
    engine.stemBlobs.has(URL_A));

  console.log("\n── invalidateStream libera il blob dello stream ──");
  const live = await engine._stemObjectUrl(URL_A);
  engine.invalidateStream("s1");
  await new Promise(r => setTimeout(r, 0));
  assert("il blob esce dalla cache", !engine.stemBlobs.has(URL_A));
  assert("e viene revocato", revoked.includes(live));

  /* ---- guardie sorgente: gli anelli che qui non girano ------------------- */
  console.log("\n── guardie sorgente ──");
  const code = codeOf(SRC);
  assert("l'elemento riceve il blob, non l'URL http",
    /el\.src\s*=\s*objUrl/.test(code) && !/el\.src\s*=\s*url\s*;/.test(code));
  assert("_scheduleStreaming scalda la cache al momento della schedulazione",
    /const objP = this\._stemObjectUrl\(url\)/.test(code));
  // `src = ""` non svuota l'elemento: la stringa vuota si risolve sull'URL del
  // documento, quindi l'elemento va a scaricare la pagina dell'editor come
  // media — una richiesta inutile per clip a ogni stop, proprio sul pool di
  // connessioni che questo cambiamento serve a risparmiare.
  assert("il teardown stacca il src invece di assegnargli la stringa vuota",
    /removeAttribute\("src"\)/.test(code) && !/\.src\s*=\s*""/.test(code));
})();

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file
// (#132): cosi' una sezione appesa dopo continua a contare, e un file che
// muore a meta' lo dice invece di stampare un riepilogo pulito.
process.on("exit", (code) => {
  console.log(`\n${fail ? "✗" : "✓"} stem-blobs: ${pass} passed, ${fail} failed\n`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0 || pass === 0) process.exitCode = 1;
});
