/* =============================================================================
 * test-stem-index.js — pins the browser's stem index (backend.js).
 *
 * The index answers two *different* questions and must not conflate them:
 *
 *   hasStem(bn, sid, format)  "is there a stem I can actually play right now?"
 *                             Playback asks this. It is format-specific:
 *                             stemUrl() requests the extension of the Settings
 *                             output format, and a stem rendered only as .aif
 *                             404s when the format is wav — which the <audio>
 *                             element reports as *nothing at all* (canplay never
 *                             fires), i.e. a clip that is silently silent.
 *
 *   ownsStem(bn, sid)         "does any file on disk still claim this id?"
 *                             Id allocation asks this, and must stay
 *                             format-agnostic or it recycles an id whose stem
 *                             exists in the other format.
 *
 * Run: node test-stem-index.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// Fake disk + the /stems shape server.py serves from it.
let DISK = [];                                   // ["proj__stream1.wav", …]
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
global.fetch = (url) => {
  const m = String(url).match(/\/stems\/([^?]+)/);
  if (!m) return Promise.reject(new Error("unexpected fetch " + url));
  const bn = decodeURIComponent(m[1]);
  const stems = DISK.filter(f => f.startsWith(bn + "__")).map(f => ({
    streamId: f.slice(bn.length + 2).replace(/\.[^.]+$/, ""),
    ext: f.slice(f.lastIndexOf(".")),
    mtime: 1700000000,
  }));
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ basename: bn, stems }) });
};
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

const backend = window.PGEBackend.create({ baseUrl: "http://x" });

console.log("\n── a stem present in one format only ──");
(async () => {
  DISK = ["proj__stream1.wav", "proj__stream2.aif"];
  await backend.render.loadCache("proj");

  assert("hasStem(wav) true for the .wav stem",  backend.render.hasStem("proj", "stream1", "wav") === true);
  assert("hasStem(aiff) FALSE for it — no .aif to play",
         backend.render.hasStem("proj", "stream1", "aiff") === false);
  assert("hasStem(aiff) true for the .aif stem", backend.render.hasStem("proj", "stream2", "aiff") === true);
  assert("hasStem(wav) FALSE for it — no .wav to play",
         backend.render.hasStem("proj", "stream2", "wav") === false);

  console.log("\n── id ownership stays format-agnostic ──");
  assert("ownsStem sees the .wav stem", backend.render.ownsStem("proj", "stream1") === true);
  assert("ownsStem sees the .aif stem", backend.render.ownsStem("proj", "stream2") === true);
  assert("ownsStem false for a free id", backend.render.ownsStem("proj", "stream3") === false);

  console.log("\n── a clip that cannot sound says so (source guard) ──");
  {
    const engSrc = fs.readFileSync(path.join(__dirname, "../../src/lib/audio-engine.js"), "utf8");
    const appSrc = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");
    assert("play() rejections are no longer swallowed",
           !/\.play\(\)\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(engSrc));
    assert("the <audio> element's error is listened for",
           /addEventListener\("error"/.test(engSrc));
    assert("the engine reports it as pge-audio-error",
           /pge-audio-error/.test(engSrc));
    assert("app.jsx listens for it", /pge-audio-error/.test(appSrc));
  }

  // Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
  // cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
  // e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
  process.on("exit", (code) => {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`${pass} passed, ${fail} failed`);
    if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
    if (fail > 0) process.exitCode = 1;
  });
})();
