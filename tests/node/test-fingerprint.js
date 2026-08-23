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
// yaml-bridge comes along for applyStreamPatch (the editor's write path —
// what actually reaches the fingerprint after an Inspector edit).
global.window = { jsyaml: require("js-yaml") };
global.localStorage = { getItem: () => null, setItem: () => {} };
global.fetch = () => Promise.reject(new Error("no network in test"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/backend.js"), "utf8"));

const { fingerprintStream } = window.PGEBackend;
const { applyStreamPatch } = window.PGEYaml;

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
  // Bookkeeping for the optional `duration` (PGE #205): whether the length was
  // written in the YAML or inherited from the sample says nothing about the
  // audio — only the resolved number does, and that IS hashed.
  durationImplicit: true,
  durationUnresolved: true,
  // Same class (PGE #204): it records WHICH spelling the deviation came from,
  // `dephase` or the current key, not what it says. Reopening a pre-v7 project
  // must not mark every stem stale over a key name.
  deviationProbabilityLegacy: true,
};
for (const [k, v] of Object.entries(ignored)) {
  const s = base(); s[k] = v;
  assert(`ignores ${k}`, fp(s) === fp0, `${k}: fp changed`);
}

{
  // The healed VALUE is still hashed, so the migration marks stale exactly what
  // it changes: only the flag is free.
  const pre  = { ...base(), deviationProbability: 50, deviationProbabilityLegacy: true };
  const post = { ...base(), deviationProbability: 50, deviationProbabilityLegacy: false };
  assert("healing dephase → deviation_probability leaves the stem fresh",
    fp(pre) === fp(post), "fp changed");
  const changed = { ...post, deviationProbability: 80 };
  assert("changing the healed value still marks the stem stale", fp(changed) !== fp(post));
}

{
  // Typing the exact length the sample already implied is a no-op for the
  // renderer: the stem must stay green, not go stale on the flag alone.
  const implicit = { ...base(), duration: 10, durationImplicit: true };
  const madeExplicit = applyStreamPatch(implicit, { duration: 10 });
  assert("implicit → explicit at the same value keeps the stem fresh",
    fp(madeExplicit) === fp(implicit), "fp changed");
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
  // engine #169: shared RNG identity changes the drawn sequences → new audio.
  ["rngGroup",      s => s.rngGroup = "cugini"],
  // engine #173: the anchor changes the _range band, hence the drawn values.
  ["rangeAnchor",   s => s.rangeAnchor = "min"],
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

console.log("\n── clearing a field must not leave a stale-inducing residue ──");
{
  // Il giro completo dell'Inspector: assegno un gruppo, poi svuoto il campo.
  // Se il patch lasciasse `rngGroup: undefined` nello stato, canonicalJSON lo
  // serializzerebbe come `null` e lo stem risulterebbe stale pur essendo
  // tornato all'audio di prima (engine #169 / review PR #113).
  const never = base();
  const grouped = applyStreamPatch(never, { rngGroup: "cugini" });
  const cleared = applyStreamPatch(grouped, { rngGroup: undefined });

  assert("assigning a group changes the fingerprint", fp(grouped) !== fp(never));
  assert("clearing it restores the original fingerprint", fp(cleared) === fp(never),
    JSON.stringify({ never: fp(never), cleared: fp(cleared) }));
}

console.log("\n── _extra keys are audio-affecting: they enter the fingerprint (#115) ──");
{
  // Unknown stream keys the editor doesn't model are preserved verbatim under
  // `_extra` (yaml-bridge). canonicalJSON walks the whole stream object and
  // `_extra` is not in FP_IGNORE, so any such key DOES affect the fingerprint —
  // confirming the concern raised in PGE-ui #115: no _extra key can silently
  // leave a stale stem reading fresh.
  const s = base();
  s._extra = { some_future_engine_key: "a" };
  assert("adding an _extra key changes the fingerprint", fp(s) !== fp0);

  const t = base(); t._extra = { some_future_engine_key: "a" };
  const u = base(); u._extra = { some_future_engine_key: "b" };
  assert("changing an _extra value changes the fingerprint", fp(t) !== fp(u));
}

console.log("\n── grain.read_direction (PGE #207) ──");
{
  // Il verso cambia l'audio reso, quindi DEVE marcare lo stem stale. Non c'è
  // niente da aggiungere a FP_IGNORE: il fingerprint cammina l'oggetto stream
  // per intero, quindi i campi nuovi entrano da soli. Questo test è qui perché
  // se ne accorga chi un domani li escludesse per sbaglio.
  const auto = base();
  const avanti = base(); avanti.grain = { ...avanti.grain, readDirection: 1 };
  const indietro = base(); indietro.grain = { ...indietro.grain, readDirection: -1 };
  assert("dichiarare un verso cambia il fingerprint", fp(avanti) !== fp(auto));
  assert("i due versi hanno fingerprint diversi", fp(avanti) !== fp(indietro));

  const env = base();
  env.grain = { ...env.grain, readDirection: null, readDirectionEnv: [[0, 1], [0.5, -1]] };
  assert("passare a envelope cambia il fingerprint", fp(env) !== fp(avanti));

  const env2 = base();
  env2.grain = { ...env2.grain, readDirection: null, readDirectionEnv: [[0, 1], [0.7, -1]] };
  assert("spostare il cambio di verso nel tempo cambia il fingerprint",
    fp(env) !== fp(env2));

  // `reverse` e `read_direction: -1` dicono la stessa cosa al motore ma sono
  // scritture diverse: il fingerprint le distingue, ed è corretto — il primo
  // render dopo il cambio di chiave riparte, e questo è il comportamento
  // prudente su una coppia che il motore rifiuta se coesiste.
  const rev = base(); rev.grain = { ...rev.grain, reverse: null };
  assert("reverse e read_direction: -1 non collidono", fp(rev) !== fp(indietro));
}

// Il verdetto sta in un handler `exit`, non in una riga in fondo al file:
// cosi' una sezione appesa dopo continua a contare, invece di stampare FAIL
// e uscire 0. Il vincolo e' verificato da test-suite-harness.js (#132).
process.on("exit", () => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
});
