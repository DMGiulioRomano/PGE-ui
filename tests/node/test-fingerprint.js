/* =============================================================================
 * test-fingerprint.js — pins the per-stream fingerprint contract (#39 / #46).
 *
 * fingerprintStream (backend.js) drives the 🟢/🟡/⚪ per-clip dots. The set of
 * fields it ignores must stay fixed and documented: UI-only color/mute/solo and
 * (deliberately) onset — moving a clip on the timeline must NOT mark its stem
 * stale. Everything else (audio-affecting) MUST change the fingerprint. The hash
 * must also be order-independent (canonicalJSON sorts keys recursively).
 *
 * Run: node test-fingerprint.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// Minimal browser shims so backend.js loads in node: no real network/storage.
global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.reject(new Error("no network in test"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

const { fingerprintStream } = window.PGEBackend;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

const base = () => ({
  id: "s1", color: "#aabbcc", mute: false, solo: false, onset: 1.5,
  duration: 10, sample: "x.wav",
  density: 20,
  grain:   { duration: 0.1, envelope: "hanning" },
  pointer: { speedRatio: 1 },
  pitch:   { unit: "semitones", value: 0 },
  pan: 0, volume: 0,
});

const fp = (s, fmt) => fingerprintStream(s, fmt || "aiff");
const fp0 = fp(base());

console.log("\n── fields that must NOT affect the fingerprint (UI-only + onset) ──");
const ignored = {
  color: "#000000",
  mute: true,
  solo: true,
  onset: 99.0,        // moving a clip on the timeline must not mark it stale
};
for (const [k, v] of Object.entries(ignored)) {
  const s = base(); s[k] = v;
  assert(`ignores ${k}`, fp(s) === fp0, `${k}: fp changed`);
}

console.log("\n── fields that MUST affect the fingerprint (audio-relevant) ──");
const sensitive = [
  ["id",            s => s.id = "s2"],
  ["duration",      s => s.duration = 20],
  ["sample",        s => s.sample = "y.wav"],
  ["density",       s => s.density = 21],
  ["grain.duration", s => s.grain.duration = 0.2],
  ["pitch.value",   s => s.pitch.value = 3],
  ["pan",           s => s.pan = 100],
  ["volume",        s => s.volume = -6],
  ["pointer.speedRatio", s => s.pointer.speedRatio = 2],
];
for (const [label, mut] of sensitive) {
  const s = base(); mut(s);
  assert(`detects ${label}`, fp(s) !== fp0, `${label}: fp unchanged`);
}

console.log("\n── output format + key-order stability ──");
assert("output format affects fingerprint", fp(base(), "aiff") !== fp(base(), "wav"));
{
  // Same data, different key insertion order → same fingerprint (canonicalJSON
  // sorts keys recursively; this is the #39 'sorted keys' guarantee).
  const a = { id: "s", duration: 5, sample: "x.wav", grain: { duration: 0.1, envelope: "hanning" } };
  const b = { grain: { envelope: "hanning", duration: 0.1 }, sample: "x.wav", id: "s", duration: 5 };
  assert("fingerprint is key-order independent", fp(a) === fp(b),
    JSON.stringify({ a: fp(a), b: fp(b) }));
}

console.log("\n── multistate envelope preservation fields are fingerprint-inert (#59) ──");
{
  // statePositions / _curveRaw are editor-only fields injected at parse to
  // round-trip explicit positions + the verbatim curve. They must not move the
  // fingerprint (or every already-rendered multistate stem would read stale),
  // while a real edit to a window name or the curve still must.
  const ms = () => ({
    id: "s1", duration: 10, sample: "x.wav",
    grain: { duration: 0.1, envelope: { states: ["hanning", "bartlett", "blackman"], curve: [[0, 0], [1, 2]] } },
  });
  const fpMs = fp(ms());
  {
    const s = ms(); s.grain.envelope.statePositions = [0, 0.2, 0.9];
    assert("ignores grain.envelope.statePositions", fp(s) === fpMs, "fp changed");
  }
  {
    const s = ms(); s.grain.envelope._curveRaw = [[0, 0], [1, 1]];
    assert("ignores grain.envelope._curveRaw", fp(s) === fpMs, "fp changed");
  }
  {
    const s = ms(); s.grain.envelope.states[1] = "gaussian";
    assert("detects grain.envelope.states[i] rename", fp(s) !== fpMs, "fp unchanged");
  }
  {
    const s = ms(); s.grain.envelope.curve = [[0, 0], [1, 1.5]];
    assert("detects grain.envelope.curve edit", fp(s) !== fpMs, "fp unchanged");
  }
}

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
