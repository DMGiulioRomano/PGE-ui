/* =============================================================================
 * test-yaml-bridge.js — test suite for yaml-bridge.js round-trip fidelity
 * (pitch units, pointer loop keys, fill_factor, per-block extras, time_mode,
 * deviation_probability) — YAML→editor→YAML and editor→YAML→editor.
 *
 * Run: node test-yaml-bridge.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// Shim: provide window.jsyaml so yaml-bridge.js can load without a browser.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));

const { parse, serialize, serializeStream, parseStream, roundTripDiff, computeDuration, applyStreamPatch, resolveImplicitDurations } = window.PGEYaml;

/* ---------- micro test runner ---------- */

let pass = 0, fail = 0;

function assert(label, cond, extra) {
  if (cond) {
    pass++;
    console.log("  OK  " + label);
  } else {
    fail++;
    console.error("FAIL  " + label + (extra ? "\n      " + extra : ""));
  }
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------- helpers ---------- */

function minimalYaml(pitchBlock) {
  const pitchLine = pitchBlock == null
    ? ""
    : "\n    pitch:\n" + Object.entries(pitchBlock)
        .map(([k, v]) => `      ${k}: ${v}`)
        .join("\n");
  return `streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n    sample: test.wav${pitchLine}\n`;
}

function streamPitch(yamlText) {
  const data = parse(yamlText);
  return data.streams[0].pitch;
}

function streamToYamlText(pitchJs) {
  const data = parse(minimalYaml(null));    // baseline stream
  data.streams[0].pitch = pitchJs;
  return serialize(data);
}

/* ============================================================
 * SECTION 1 — parse: YAML → editor shape
 * ============================================================ */

console.log("\n── parse: pitch absent / null ──");

const pNone = streamPitch(minimalYaml(null));
assert("pitch absent → null", pNone === null, JSON.stringify(pNone));

// pitch: ~  (YAML null scalar)
const yamlNullPitch = "streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n    sample: test.wav\n    pitch: ~\n";
const pNull = streamPitch(yamlNullPitch);
assert("pitch: ~ → null", pNull === null, JSON.stringify(pNull));

console.log("\n── parse: 6 pitch units ──");

function testParse(unit, yamlBlock, expectValue, expectEdo) {
  const p = streamPitch(minimalYaml(yamlBlock));
  assert(`parse ${unit} — unit field`,   p && p.unit === unit, JSON.stringify(p));
  assert(`parse ${unit} — value field`,  p && p.value === expectValue, JSON.stringify(p));
  assert(`parse ${unit} — valueEnv null`, p && p.valueEnv == null, JSON.stringify(p));
  if (expectEdo !== undefined) {
    assert(`parse ${unit} — edoDivisions`, p && p.edoDivisions === expectEdo, JSON.stringify(p));
  } else {
    assert(`parse ${unit} — edoDivisions null`, p && p.edoDivisions == null, JSON.stringify(p));
  }
}

testParse("semitones",    { semitones: 7 },          7);
testParse("cents",        { cents: 200 },           200);
testParse("quarter_tone", { quarter_tone: 3 },        3);
testParse("eighth_tone",  { eighth_tone: 6 },         6);
testParse("edo",          { edo: 31, value: 18 },    18, 31);
testParse("ratio",        { ratio: 1.5 },           1.5);

// cents with range
const pCentsRange = streamPitch(minimalYaml({ cents: 200, range: 50 }));
assert("parse cents — range field", pCentsRange && pCentsRange.range === 50, JSON.stringify(pCentsRange));

/* ============================================================
 * SECTION 2 — serialize: editor shape → YAML text
 * ============================================================ */

console.log("\n── serialize: pitch null / omitted ──");

const yamlNoPitch = streamToYamlText(null);
assert("serialize null pitch → no 'pitch:' block", !yamlNoPitch.includes("\n  pitch:"), yamlNoPitch.slice(0, 300));

console.log("\n── serialize: 6 pitch units ──");

function testSerialize(unit, pitchJs, expectedKey, expectedValue, extraChecks) {
  const y = streamToYamlText(pitchJs);
  assert(`serialize ${unit} — key present`,  y.includes(expectedKey),   y.slice(0, 400));
  if (expectedValue !== undefined) {
    assert(`serialize ${unit} — value`,      y.includes(String(expectedValue)), y.slice(0, 400));
  }
  if (extraChecks) extraChecks(y);
}

testSerialize("semitones",    { unit: "semitones",    value: 7 },          "semitones:", 7);
testSerialize("cents",        { unit: "cents",        value: 200 },        "cents:",    200);
testSerialize("quarter_tone", { unit: "quarter_tone", value: 3 },          "quarter_tone:", 3);
testSerialize("eighth_tone",  { unit: "eighth_tone",  value: 6 },          "eighth_tone:", 6);
testSerialize("ratio",        { unit: "ratio",        value: 1.5 },        "ratio:",    1.5);
testSerialize("edo",
  { unit: "edo", value: 18, edoDivisions: 31 },
  "edo:", 31,
  (y) => assert("serialize edo — value key present", y.includes("value:"), y.slice(0, 400))
);

// range preserved
const yamlWithRange = streamToYamlText({ unit: "cents", value: 200, range: 50 });
assert("serialize cents — range key emitted", yamlWithRange.includes("range:"), yamlWithRange.slice(0, 400));

// no semitone_range in output
const yamlSt = streamToYamlText({ unit: "semitones", value: 0 });
assert("serialize semitones — no 'semitone_range' key", !yamlSt.includes("semitone_range"), yamlSt.slice(0, 400));

/* ============================================================
 * SECTION 3 — roundtrip: roundTripDiff returns []
 * ============================================================ */

console.log("\n── roundtrip ──");

function testRoundtrip(unit, pitchJs) {
  const data = parse(minimalYaml(null));
  data.streams[0].pitch = pitchJs;
  const diffs = roundTripDiff(data);
  const pitchDiffs = diffs.filter(d => d.path && d.path.includes("pitch"));
  assert(`roundtrip ${unit} — no pitch diffs`, pitchDiffs.length === 0,
    pitchDiffs.map(d => JSON.stringify(d)).join("; "));
}

testRoundtrip("semitones",    { unit: "semitones",    value: 7,   valueEnv: null, edoDivisions: null, range: null });
testRoundtrip("cents",        { unit: "cents",        value: 200, valueEnv: null, edoDivisions: null, range: null });
testRoundtrip("quarter_tone", { unit: "quarter_tone", value: 3,   valueEnv: null, edoDivisions: null, range: null });
testRoundtrip("eighth_tone",  { unit: "eighth_tone",  value: 6,   valueEnv: null, edoDivisions: null, range: null });
testRoundtrip("ratio",        { unit: "ratio",        value: 1.5, valueEnv: null, edoDivisions: null, range: null });
testRoundtrip("edo",          { unit: "edo",          value: 18,  valueEnv: null, edoDivisions: 31,   range: null });

/* ============================================================
 * SECTION 4 — voices pitch_range (rename from semitone_range)
 * ============================================================ */

console.log("\n── voices: pitch_range ──");

const yamlVoiceRange = `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    voices:
      num_voices: 4
      pitch:
        strategy: range
        pitch_range: 12
`;

const parsedVoice = parse(yamlVoiceRange);
const vp = parsedVoice.streams[0].voices.pitch;
assert("voices.pitch parsed — pitch_range present",  vp && "pitch_range" in vp,     JSON.stringify(vp));
assert("voices.pitch parsed — no semitone_range",    vp && !("semitone_range" in vp), JSON.stringify(vp));

const serializedVoice = serialize(parsedVoice);
assert("voices serialize — pitch_range in YAML",    serializedVoice.includes("pitch_range:"),  serializedVoice.slice(0, 500));
assert("voices serialize — no semitone_range",      !serializedVoice.includes("semitone_range"), serializedVoice.slice(0, 500));

// Voices EDO unit as object {edo: N}
const yamlVoiceEdo = `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    voices:
      num_voices: 4
      pitch:
        strategy: step
        unit:
          edo: 31
        step: 2
`;

const parsedVoiceEdo = parse(yamlVoiceEdo);
const vpEdo = parsedVoiceEdo.streams[0].voices.pitch;
assert("voices EDO parsed — unit object preserved", vpEdo && typeof vpEdo.unit === "object" && vpEdo.unit.edo === 31, JSON.stringify(vpEdo));
const serializedVoiceEdo = serialize(parsedVoiceEdo);
assert("voices EDO roundtrip — edo in YAML", serializedVoiceEdo.includes("edo: 31"), serializedVoiceEdo.slice(0, 500));

/* voices pitch chord_progression (PGE issue #86 / PGE-ui #104) — the strategy
 * carries a nested list plus interp/voice_leading; the round trip must keep
 * all three lossless through packStrategy/unpackStrategy. */
console.log("\n── voices: chord_progression ──");
const yamlChordProg = `streams:
  - stream_id: s1
    onset: 0
    duration: 16
    sample: test.wav
    voices:
      num_voices: 4
      pitch:
        strategy: chord_progression
        progression:
          - [0, maj7]
          - [8, min7, 1]
          - [16, {chord: dom7, inversion: 0}]
        interp: cubic
        voice_leading: positional
`;
const parsedCP = parse(yamlChordProg);
const cp = parsedCP.streams[0].voices.pitch;
assert("chord_progression — strategy parsed", cp && cp.strategy === "chord_progression", JSON.stringify(cp));
assert("chord_progression — progression is array of 3", Array.isArray(cp.progression) && cp.progression.length === 3, JSON.stringify(cp.progression));
assert("chord_progression — compact step preserved", cp.progression[0][0] === 0 && cp.progression[0][1] === "maj7", JSON.stringify(cp.progression[0]));
assert("chord_progression — inversion tuple preserved", cp.progression[1][2] === 1, JSON.stringify(cp.progression[1]));
assert("chord_progression — explicit-form step preserved", cp.progression[2][1] && cp.progression[2][1].chord === "dom7", JSON.stringify(cp.progression[2]));
assert("chord_progression — interp preserved", cp.interp === "cubic", JSON.stringify(cp));
assert("chord_progression — voice_leading preserved", cp.voice_leading === "positional", JSON.stringify(cp));
const serializedCP = serialize(parsedCP);
assert("chord_progression serialize — strategy in YAML", serializedCP.includes("strategy: chord_progression"), serializedCP.slice(0, 700));
assert("chord_progression serialize — progression in YAML", serializedCP.includes("progression:"), serializedCP.slice(0, 700));
assert("chord_progression serialize — interp in YAML", serializedCP.includes("interp: cubic"), serializedCP.slice(0, 700));
assert("chord_progression serialize — voice_leading in YAML", serializedCP.includes("voice_leading: positional"), serializedCP.slice(0, 700));
const cpDiffs = roundTripDiff(parsedCP).filter(d => d.path && d.path.includes("pitch"));
assert("chord_progression — roundtrip no pitch diffs", cpDiffs.length === 0, JSON.stringify(cpDiffs));

/* ============================================================
 * SECTION 5 — parse from real showcase YAML
 * ============================================================ */

console.log("\n── showcase YAML ──");

const showcasePath = path.join(__dirname, "../../..", "PythonGranularEngine/configs/PGE_pitch_units_showcase.yml");
if (fs.existsSync(showcasePath)) {
  const showcaseText = fs.readFileSync(showcasePath, "utf8");
  let showcaseData;
  try {
    showcaseData = parse(showcaseText);
    assert("showcase parse — no crash", true);
    const pitchStreams = showcaseData.streams.filter(s => s.pitch != null);
    assert("showcase — streams with pitch > 0", pitchStreams.length > 0, `found ${pitchStreams.length}`);
    const units = pitchStreams.map(s => s.pitch.unit);
    const VALID = ["semitones","cents","quarter_tone","eighth_tone","edo","ratio"];
    const allValid = units.every(u => VALID.includes(u));
    assert("showcase — all pitch units valid", allValid, units.join(", "));
    const diffs = roundTripDiff(showcaseData);
    const pitchDiffs = diffs.filter(d => d.path && d.path.includes("pitch"));
    assert("showcase — roundtrip no pitch diffs", pitchDiffs.length === 0,
      pitchDiffs.map(d => JSON.stringify(d)).join("; "));
  } catch(e) {
    assert("showcase parse — no crash", false, e.message);
  }
} else {
  console.log("  SKIP showcase (file not found at " + showcasePath + ")");
}

/* ============================================================
 * SECTION 6 — pointer loop keys: loop_dur, not loop_duration (#32)
 * ============================================================ */

console.log("\n── pointer: loop_dur (#32) ──");

function pointerYaml(ptrLines) {
  return `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    pointer:
${ptrLines.map(l => "      " + l).join("\n")}
`;
}

{
  const data = parse(pointerYaml(["loop_start: 0.25", "loop_dur: 2"]));
  const ptr = data.streams[0].pointer;
  assert("parse loop_dur scalar", ptr.loopDur === 2, JSON.stringify(ptr));
  assert("parse loop_dur scalar — env null", ptr.loopDurEnv == null, JSON.stringify(ptr));
  const y = serialize(data);
  assert("serialize loop — emits loop_dur", y.includes("loop_dur:"), y.slice(0, 500));
  assert("serialize loop — never loop_duration", !y.includes("loop_duration"), y.slice(0, 500));
  const diffs = roundTripDiff(data);
  assert("roundtrip loop scalar — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  const data = parse(pointerYaml(["loop_start: 0.25", "loop_dur: [[0, 0.6], [10, 0.1]]"]));
  const ptr = data.streams[0].pointer;
  assert("parse loop_dur env", Array.isArray(ptr.loopDurEnv) && ptr.loopDurEnv.length === 2, JSON.stringify(ptr));
  assert("parse loop_dur env — scalar null", ptr.loopDur == null, JSON.stringify(ptr));
  const diffs = roundTripDiff(data);
  assert("roundtrip loop env — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  // Legacy healing: files written by older editor builds used `loop_duration`.
  const data = parse(pointerYaml(["loop_start: 0.25", "loop_duration: 2"]));
  assert("legacy loop_duration healed on parse", data.streams[0].pointer.loopDur === 2,
    JSON.stringify(data.streams[0].pointer));
  const y = serialize(data);
  assert("legacy re-serialized as loop_dur", y.includes("loop_dur:") && !y.includes("loop_duration"), y.slice(0, 500));
}

{
  // Both present: canonical loop_dur wins over the legacy alias.
  const data = parse(pointerYaml(["loop_start: 0.25", "loop_dur: 3", "loop_duration: 9"]));
  assert("loop_dur wins over legacy alias", data.streams[0].pointer.loopDur === 3,
    JSON.stringify(data.streams[0].pointer));
}

const pino3Path = path.join(__dirname, "../../..", "PythonGranularEngine/configs/PGE_pino3.yml");
if (fs.existsSync(pino3Path)) {
  const data = parse(fs.readFileSync(pino3Path, "utf8"));
  const withLoop = data.streams.find(s => s.pointer && s.pointer.loopDurEnv);
  assert("pino3 fixture — compact loop env lands in loopDurEnv", !!withLoop,
    JSON.stringify(data.streams.map(s => s.pointer)));
  const y = serialize(data);
  assert("pino3 fixture — serialize emits loop_dur", y.includes("loop_dur:"), y.slice(0, 800));
  assert("pino3 fixture — serialize never loop_duration", !y.includes("loop_duration"), y.slice(0, 800));
} else {
  console.log("  SKIP pino3 fixture (file not found)");
}

/* ============================================================
 * SECTION 7 — fill_factor modelled, mutex with density (#33)
 * ============================================================ */

console.log("\n── fill_factor (#33) ──");

function topLevelYaml(extraLines) {
  return `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
${extraLines.map(l => "    " + l).join("\n")}
`;
}

{
  const data = parse(topLevelYaml(["fill_factor: 2.0"]));
  const s = data.streams[0];
  assert("parse fill_factor scalar", s.fillFactor === 2, JSON.stringify({ ff: s.fillFactor, ffe: s.fillFactorEnv }));
  assert("parse fill_factor — density null", s.density == null && s.densityEnv == null,
    JSON.stringify({ d: s.density, de: s.densityEnv }));
  assert("parse fill_factor — not in _extra", !s._extra || !("fill_factor" in s._extra), JSON.stringify(s._extra));
  const y = serialize(data);
  assert("serialize — fill_factor emitted", y.includes("fill_factor:"), y.slice(0, 400));
  assert("serialize — density not emitted", !y.includes("density:"), y.slice(0, 400));
  const diffs = roundTripDiff(data);
  assert("roundtrip fill_factor scalar — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  // Both present in the file: fill_factor wins (engine priority), density dropped.
  const data = parse(topLevelYaml(["density: 10", "fill_factor: 2"]));
  const s = data.streams[0];
  assert("both keys — fill_factor wins", s.fillFactor === 2, JSON.stringify(s.fillFactor));
  assert("both keys — density dropped", s.density == null, JSON.stringify(s.density));
  const y = serialize(data);
  assert("both keys — serialize emits only fill_factor", y.includes("fill_factor:") && !y.includes("density:"),
    y.slice(0, 400));
}

{
  const data = parse(topLevelYaml(["fill_factor: [[0, 1], [10, 4]]"]));
  const s = data.streams[0];
  assert("parse fill_factor env", Array.isArray(s.fillFactorEnv) && s.fillFactorEnv.length === 2,
    JSON.stringify(s.fillFactorEnv));
  assert("parse fill_factor env — scalar null", s.fillFactor == null, JSON.stringify(s.fillFactor));
  const diffs = roundTripDiff(data);
  assert("roundtrip fill_factor env — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  // Defensive: inconsistent UI state with both set → fill_factor wins on serialize.
  const data = parse(topLevelYaml(["density: 8"]));
  data.streams[0].fillFactor = 2;
  const y = serialize(data);
  assert("state with both — only fill_factor emitted", y.includes("fill_factor:") && !y.includes("density:"),
    y.slice(0, 400));
}

{
  // Neither present: parse must not inject either (engine default applies).
  const data = parse(topLevelYaml([]));
  const s = data.streams[0];
  assert("neither key — both absent in state", s.density == null && s.fillFactor == null,
    JSON.stringify({ d: s.density, ff: s.fillFactor }));
  const y = serialize(data);
  assert("neither key — neither emitted", !y.includes("density:") && !y.includes("fill_factor:"), y.slice(0, 400));
}

const ffPath = path.join(__dirname, "../../..", "PythonGranularEngine/configs/PGE_ff2_rassegna.yml");
if (fs.existsSync(ffPath)) {
  const data = parse(fs.readFileSync(ffPath, "utf8"));
  const ffStreams = data.streams.filter(s => s.fillFactor === 2);
  assert("ff2 fixture — fillFactor read on all streams", ffStreams.length === data.streams.length,
    `${ffStreams.length}/${data.streams.length}`);
  const back = parse(serialize(data));
  assert("ff2 fixture — fillFactor survives reparse",
    back.streams.every(s => s.fillFactor === 2 && s.density == null),
    JSON.stringify(back.streams.map(s => [s.fillFactor, s.density])));
} else {
  console.log("  SKIP ff2 fixture (file not found)");
}

/* ============================================================
 * SECTION 8 — loop_end / loop_unit / grain.reverse / per-block _extra (#34)
 * ============================================================ */

console.log("\n── loop_end · loop_unit · reverse · block extras (#34) ──");

{
  const data = parse(pointerYaml(["loop_start: 0.25", "loop_end: 2.5"]));
  const ptr = data.streams[0].pointer;
  assert("parse loop_end scalar", ptr.loopEnd === 2.5, JSON.stringify(ptr));
  const y = serialize(data);
  assert("serialize — loop_end emitted", y.includes("loop_end:"), y.slice(0, 500));
  assert("serialize — loop_dur not emitted", !y.includes("loop_dur:"), y.slice(0, 500));
  const diffs = roundTripDiff(data);
  assert("roundtrip loop_end scalar — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  const data = parse(pointerYaml(["loop_start: 0.25", "loop_end: [[0, 1], [10, 3]]"]));
  const ptr = data.streams[0].pointer;
  assert("parse loop_end env", Array.isArray(ptr.loopEndEnv) && ptr.loopEndEnv.length === 2, JSON.stringify(ptr));
  const diffs = roundTripDiff(data);
  assert("roundtrip loop_end env — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  // Both in the file: loop_end wins (engine exclusive group priority).
  const data = parse(pointerYaml(["loop_start: 0.25", "loop_end: 2.5", "loop_dur: 9"]));
  const ptr = data.streams[0].pointer;
  assert("loop_end + loop_dur — loop_end kept", ptr.loopEnd === 2.5, JSON.stringify(ptr));
  assert("loop_end + loop_dur — loop_dur dropped", ptr.loopDur == null && ptr.loopDurEnv == null, JSON.stringify(ptr));
  const y = serialize(data);
  assert("loop_end + loop_dur — only loop_end emitted", y.includes("loop_end:") && !y.includes("loop_dur:"),
    y.slice(0, 500));
}

{
  const data = parse(pointerYaml(["loop_start: 0.2", "loop_dur: 0.4", "loop_unit: normalized"]));
  const ptr = data.streams[0].pointer;
  assert("parse loop_unit", ptr.loopUnit === "normalized", JSON.stringify(ptr));
  const y = serialize(data);
  assert("serialize — loop_unit emitted", y.includes("loop_unit: normalized"), y.slice(0, 500));
  const diffs = roundTripDiff(data);
  assert("roundtrip loop_unit — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  const yamlRev = `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    grain:
      duration: 0.05
      reverse:
`;
  const data = parse(yamlRev);
  assert("parse reverse bare key → null", data.streams[0].grain.reverse === null,
    JSON.stringify(data.streams[0].grain));
  const y = serialize(data);
  assert("serialize — reverse: null emitted", /reverse: null/.test(y), y.slice(0, 500));
  assert("serialize — reverse never true/false", !/reverse: (true|false)/.test(y), y.slice(0, 500));
  const diffs = roundTripDiff(data);
  assert("roundtrip reverse — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  // reverse absent → key never appears.
  const data = parse(topLevelYaml(["grain: {duration: 0.05}"]));
  assert("reverse absent in state", !("reverse" in data.streams[0].grain), JSON.stringify(data.streams[0].grain));
  const y = serialize(data);
  assert("reverse absent — not emitted", !y.includes("reverse"), y.slice(0, 500));
}

{
  // Unknown keys inside rebuilt blocks survive via <block>._extra.
  const yamlExtras = `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    pointer:
      start: 0
      futuro_param: 7
    grain:
      duration: 0.05
      xkey: 1
    pitch:
      semitones: 2
      glide: 3
    voices:
      num_voices: 2
      nuova: 4
`;
  const data = parse(yamlExtras);
  const s = data.streams[0];
  assert("pointer._extra captured", s.pointer._extra && s.pointer._extra.futuro_param === 7, JSON.stringify(s.pointer._extra));
  assert("grain._extra captured", s.grain._extra && s.grain._extra.xkey === 1, JSON.stringify(s.grain._extra));
  assert("pitch._extra captured", s.pitch._extra && s.pitch._extra.glide === 3, JSON.stringify(s.pitch._extra));
  assert("voices._extra captured", s.voices._extra && s.voices._extra.nuova === 4, JSON.stringify(s.voices._extra));
  const y = serialize(data);
  for (const frag of ["futuro_param: 7", "xkey: 1", "glide: 3", "nuova: 4"]) {
    assert(`block extra re-emitted — ${frag}`, y.includes(frag), y.slice(0, 800));
  }
  const back = parse(y);
  const b = back.streams[0];
  assert("block extras stable after reparse",
    b.pointer._extra.futuro_param === 7 && b.grain._extra.xkey === 1 &&
    b.pitch._extra.glide === 3 && b.voices._extra.nuova === 4,
    JSON.stringify({ p: b.pointer._extra, g: b.grain._extra, pi: b.pitch._extra, v: b.voices._extra }));
  const diffs = roundTripDiff(data);
  assert("roundtrip block extras — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

const pino2Path = path.join(__dirname, "../../..", "PythonGranularEngine/configs/PGE_pino2.yml");
if (fs.existsSync(pino2Path)) {
  const text = fs.readFileSync(pino2Path, "utf8");
  const data = parse(text);
  const y = serialize(data);
  const count = (y.match(/loop_unit: normalized/g) || []).length;
  assert("pino2 fixture — loop_unit preserved on both streams", count === 2, `found ${count}, expected 2`);
} else {
  console.log("  SKIP pino2 fixture (file not found)");
}

const pino4Path = path.join(__dirname, "../../..", "PythonGranularEngine/configs/PGE_pino4.yml");
if (fs.existsSync(pino4Path)) {
  const data = parse(fs.readFileSync(pino4Path, "utf8"));
  const revCount = data.streams.filter(s => s.grain && s.grain.reverse === null).length;
  assert("pino4 fixture — bare reverse parsed on 2 streams", revCount === 2, `found ${revCount}`);
  const y = serialize(data);
  const emitted = (y.match(/reverse: null/g) || []).length;
  assert("pino4 fixture — reverse re-emitted on 2 streams", emitted === 2, `found ${emitted}`);
} else {
  console.log("  SKIP pino4 fixture (file not found)");
}

{
  // Explicit pitch.range: 0 disables implicit detune engine-side — it must
  // survive the round trip (caught by PGE_detune_implicito_test.yml).
  const data = parse(minimalYaml({ semitones: 7, range: 0 }));
  assert("parse pitch.range 0 kept", data.streams[0].pitch.range === 0, JSON.stringify(data.streams[0].pitch));
  const y = serialize(data);
  assert("serialize pitch.range 0 emitted", /range: 0/.test(y), y.slice(0, 400));
  const diffs = roundTripDiff(data);
  assert("roundtrip pitch.range 0 — no diffs", diffs.length === 0, JSON.stringify(diffs));
  // unset range (null) still omitted
  const data2 = parse(minimalYaml({ semitones: 7 }));
  const y2 = serialize(data2);
  assert("unset pitch.range still omitted", !/range:/.test(y2), y2.slice(0, 400));
}

/* ============================================================
 * SECTION 8b — time_mode: absence preserved, no default injected (#35)
 * ============================================================ */

console.log("\n── time_mode (#35) ──");

{
  // The bug: a file WITHOUT time_mode (= engine default "absolute") used to
  // come back from a load→save cycle with `time_mode: normalized`, silently
  // rescaling every envelope's time axis. YAML→UI→YAML direction.
  const data = parse(topLevelYaml([]));
  assert("absent time_mode — not defaulted in state", data.streams[0].timeMode == null,
    JSON.stringify(data.streams[0].timeMode));
  const y = serialize(data);
  assert("absent time_mode — not emitted", !y.includes("time_mode"), y.slice(0, 400));
}

{
  const data = parse(topLevelYaml(["time_mode: normalized"]));
  assert("explicit normalized — kept in state", data.streams[0].timeMode === "normalized",
    JSON.stringify(data.streams[0].timeMode));
  const y = serialize(data);
  assert("explicit normalized — emitted", y.includes("time_mode: normalized"), y.slice(0, 400));
}

{
  const data = parse(topLevelYaml(["time_mode: absolute"]));
  assert("explicit absolute — kept in state", data.streams[0].timeMode === "absolute",
    JSON.stringify(data.streams[0].timeMode));
  const y = serialize(data);
  assert("explicit absolute — emitted", y.includes("time_mode: absolute"), y.slice(0, 400));
}

{
  // New streams created by the UI carry timeMode: "normalized" explicitly —
  // serialize must keep writing it.
  const data = parse(topLevelYaml([]));
  data.streams[0].timeMode = "normalized";
  const y = serialize(data);
  assert("template-like state — time_mode emitted", y.includes("time_mode: normalized"), y.slice(0, 400));
  const diffs = roundTripDiff(data);
  assert("template-like state — roundtrip no diffs", diffs.length === 0, JSON.stringify(diffs));
}

/* ============================================================
 * SECTION 8c — deviation_probability: implicit null vs absent vs explicit (#36),
 * and the healing of the legacy `dephase` spelling (#124).
 *
 * PGE renamed the key in v7.0.0 ("Deviation Probability", commit 93b0a1c,
 * PGE #204) with no back-compat alias. The engine's StreamConfig.from_yaml
 * picks fields BY NAME, so the old spelling isn't rejected — it's dropped,
 * and the stream renders with deviation_probability=False while the YAML
 * says 50. Writing the old name is therefore a silent behaviour change, not
 * a parse error.
 * ============================================================ */

console.log("\n── deviation_probability (#36, #124) ──");

const { DEVIATION_PROBABILITY_IMPLICIT } = window.PGEYaml;

{
  assert("DEVIATION_PROBABILITY_IMPLICIT exported",
    typeof DEVIATION_PROBABILITY_IMPLICIT === "string" && DEVIATION_PROBABILITY_IMPLICIT.length > 0,
    JSON.stringify(DEVIATION_PROBABILITY_IMPLICIT));
}

{
  // absent → off (no key emitted)
  const data = parse(topLevelYaml([]));
  assert("deviation_probability absent — undefined in state",
    data.streams[0].deviationProbability === undefined,
    JSON.stringify(data.streams[0].deviationProbability));
  const y = serialize(data);
  assert("deviation_probability absent — not emitted", !y.includes("deviation_probability"), y.slice(0, 400));
}

{
  // explicit false → kept
  const data = parse(topLevelYaml(["deviation_probability: false"]));
  assert("deviation_probability false — kept in state", data.streams[0].deviationProbability === false,
    JSON.stringify(data.streams[0].deviationProbability));
  const y = serialize(data);
  assert("deviation_probability false — emitted", /deviation_probability: false/.test(y), y.slice(0, 400));
  assert("roundtrip deviation_probability false — no diffs", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  // `deviation_probability: null` (explicit) and the bare key both = implicit 1%
  for (const variant of ["deviation_probability: null", "deviation_probability:"]) {
    const data = parse(topLevelYaml([variant]));
    assert(`'${variant}' — sentinel in state`,
      data.streams[0].deviationProbability === DEVIATION_PROBABILITY_IMPLICIT,
      JSON.stringify(data.streams[0].deviationProbability));
    const y = serialize(data);
    assert(`'${variant}' — re-emitted as deviation_probability: null`,
      /^\s*deviation_probability: null$/m.test(y), y.slice(0, 500));
    assert(`'${variant}' — roundtrip no diffs`, roundTripDiff(data).length === 0,
      JSON.stringify(roundTripDiff(data)));
  }
}

{
  // scalar and envelope forms pass through
  const dataN = parse(topLevelYaml(["deviation_probability: 50"]));
  assert("deviation_probability scalar — kept", dataN.streams[0].deviationProbability === 50,
    JSON.stringify(dataN.streams[0].deviationProbability));
  assert("roundtrip deviation_probability scalar — no diffs", roundTripDiff(dataN).length === 0,
    JSON.stringify(roundTripDiff(dataN)));

  const dataE = parse(topLevelYaml(["deviation_probability: [[0, 0], [30, 80]]"]));
  assert("deviation_probability env — kept",
    Array.isArray(dataE.streams[0].deviationProbability) && dataE.streams[0].deviationProbability.length === 2,
    JSON.stringify(dataE.streams[0].deviationProbability));
  assert("roundtrip deviation_probability env — no diffs", roundTripDiff(dataE).length === 0,
    JSON.stringify(roundTripDiff(dataE)));
}

{
  // Typed `{type, points}` global envelope: the form wrapEnv emits when the user
  // picks cubic on a global deviation_probability envelope. The engine reads it
  // as a GLOBAL envelope (Envelope.is_envelope_like tests 'points' BEFORE the
  // dict→per-param branch), so the round trip must keep it whole.
  const dataT = parse(topLevelYaml(["deviation_probability:", "  type: cubic", "  points: [[0, 0], [1, 100]]"]));
  const d = dataT.streams[0].deviationProbability;
  assert("deviation_probability typed env — object with type+points kept",
    d && d.type === "cubic" && Array.isArray(d.points), JSON.stringify(d));
  assert("roundtrip deviation_probability typed env — no diffs", roundTripDiff(dataT).length === 0,
    JSON.stringify(roundTripDiff(dataT)));
  assert("deviation_probability typed env — survives YAML→UI→YAML→UI",
    eq(parse(serialize(dataT)).streams[0].deviationProbability, d),
    JSON.stringify({ before: d, after: parse(serialize(dataT)).streams[0].deviationProbability }));
}

{
  // per-param object: passes verbatim; an INTERNAL null (per-key default
  // prob) stays null, it must NOT become the sentinel.
  const yamlPP = `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    deviation_probability:
      pitch: 50
      reverse:
`;
  const data = parse(yamlPP);
  const d = data.streams[0].deviationProbability;
  assert("deviation_probability per-param — object kept", d && typeof d === "object" && !Array.isArray(d), JSON.stringify(d));
  assert("deviation_probability per-param — pitch 50", d.pitch === 50, JSON.stringify(d));
  assert("deviation_probability per-param — internal null stays null", d.reverse === null, JSON.stringify(d));
  const y = serialize(data);
  assert("deviation_probability per-param — reverse: null re-emitted", /reverse: null/.test(y), y.slice(0, 500));
  assert("roundtrip deviation_probability per-param — no diffs", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  // UI→YAML→UI starting from sentinel state (e.g. set via Inspector)
  const data = parse(topLevelYaml([]));
  data.streams[0].deviationProbability = DEVIATION_PROBABILITY_IMPLICIT;
  const back = parse(serialize(data));
  assert("sentinel state survives UI→YAML→UI",
    back.streams[0].deviationProbability === DEVIATION_PROBABILITY_IMPLICIT,
    JSON.stringify(back.streams[0].deviationProbability));
}

/* ---- the legacy `dephase` spelling (#124) ---------------------------------
   Same shape as `loop_duration`: a key the engine never knew, written by older
   editor builds, healed at parse and re-emitted under the name the engine
   reads. Without the healing a pre-v7 project reopened today would drop its
   deviation into `_extra` and render silently flat. */
{
  const data = parse(topLevelYaml(["dephase: 50"]));
  const s = data.streams[0];
  assert("legacy dephase — healed into deviationProbability", s.deviationProbability === 50,
    JSON.stringify(s.deviationProbability));
  assert("legacy dephase — flagged as migrated", s.deviationProbabilityLegacy === true,
    JSON.stringify(s.deviationProbabilityLegacy));
  assert("legacy dephase — not left in _extra", !(s._extra && "dephase" in s._extra),
    JSON.stringify(s._extra));
  const y = serialize(data);
  assert("legacy dephase — re-emitted under the new name", /^\s*deviation_probability: 50$/m.test(y), y.slice(0, 500));
  assert("legacy dephase — old key gone from the YAML", !/\bdephase\b/.test(y), y.slice(0, 500));
}

{
  // The healing runs once: after the migrating pass the stream is an ordinary
  // deviation_probability stream, flag included, and stops moving.
  const migrated = parse(serialize(parse(topLevelYaml(["dephase: 50"]))));
  assert("legacy dephase — settles after one migration pass",
    migrated.streams[0].deviationProbability === 50 && !migrated.streams[0].deviationProbabilityLegacy,
    JSON.stringify({ v: migrated.streams[0].deviationProbability, legacy: migrated.streams[0].deviationProbabilityLegacy }));
  assert("legacy dephase — migrated stream round-trips clean",
    roundTripDiff(migrated).length === 0, JSON.stringify(roundTripDiff(migrated)));
}

{
  // the bare legacy key is the implicit-1% sentinel, same as the new spelling
  const data = parse(topLevelYaml(["dephase:"]));
  assert("legacy bare dephase — sentinel", data.streams[0].deviationProbability === DEVIATION_PROBABILITY_IMPLICIT,
    JSON.stringify(data.streams[0].deviationProbability));
  assert("legacy bare dephase — re-emitted as deviation_probability: null",
    /^\s*deviation_probability: null$/m.test(serialize(data)), serialize(data).slice(0, 500));
}

{
  // both spellings present: the one the engine reads wins, the dead one is dropped
  const data = parse(topLevelYaml(["dephase: 10", "deviation_probability: 90"]));
  const s = data.streams[0];
  assert("both keys — the engine's key wins", s.deviationProbability === 90,
    JSON.stringify(s.deviationProbability));
  assert("both keys — not flagged legacy (nothing was migrated)", !s.deviationProbabilityLegacy,
    JSON.stringify(s.deviationProbabilityLegacy));
  const y = serialize(data);
  assert("both keys — only the new one emitted", /deviation_probability: 90/.test(y) && !/\bdephase\b/.test(y),
    y.slice(0, 500));
}

{
  // the legacy flag is provenance, not content: it must not reach the YAML,
  // and it must not mark an untouched stem stale (like durationImplicit).
  const data = parse(topLevelYaml(["dephase: 50"]));
  assert("legacy flag — never serialized", !serialize(data).includes("Legacy"), serialize(data).slice(0, 400));
  const fresh = parse(topLevelYaml(["deviation_probability: 50"]));
  assert("legacy flag — same fingerprint as the healed stream",
    fpIgnoresLegacyFlag(data.streams[0], fresh.streams[0]),
    JSON.stringify({ legacy: data.streams[0], fresh: fresh.streams[0] }));
}

/* Mirrors backend.js FP_IGNORE: two streams that differ ONLY by the legacy
   provenance flag must hash the same, or reopening a pre-v7 project would mark
   every stem stale for a key spelling. */
function fpIgnoresLegacyFlag(a, b) {
  const strip = (s) => {
    const { deviationProbabilityLegacy, color, ...rest } = s;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return strip(a) === strip(b);
}

const deviationFixtures = ["PGE_detune_implicito_test.yml", "PGE_test.yml", "PGE_pino2.yml"];
for (const f of deviationFixtures) {
  const p = path.join(__dirname, "../../..", "PythonGranularEngine/configs", f);
  if (!fs.existsSync(p)) { console.log(`  SKIP deviation_probability fixture ${f} (not found)`); continue; }
  const data = parse(fs.readFileSync(p, "utf8"));
  const flags = data.streams.map(s => s.deviationProbability !== undefined);
  // The fixtures are the engine's own configs: post-v7 they carry the new key,
  // so this must actually observe something rather than pass on all-undefined.
  assert(`${f} — fixture exercises deviation_probability`, flags.some(Boolean),
    JSON.stringify(flags));
  const back = parse(serialize(data));
  const backFlags = back.streams.map(s => s.deviationProbability !== undefined);
  assert(`${f} — deviation_probability presence stable through reparse`, eq(flags, backFlags),
    JSON.stringify({ before: flags, after: backFlags }));
  assert(`${f} — deviation_probability values stable through reparse`,
    eq(data.streams.map(s => s.deviationProbability), back.streams.map(s => s.deviationProbability)),
    JSON.stringify({ before: data.streams.map(s => s.deviationProbability), after: back.streams.map(s => s.deviationProbability) }));
}

/* ============================================================
 * SECTION 8e — multistate envelope: explicit state positions AND the curve
 * survive the round trip. The editor lists only window NAMES and assumes uniform
 * spacing i/(n-1); the engine stores explicit [position, name] pairs and uses the
 * positions as thresholds in value-space (window_selection_strategy.py). Dropping
 * them rewrote a deliberately non-uniform multistate as equispaced on a no-op
 * save — changing the rendered audio AND busting the per-stream cache. The curve
 * must also be re-emitted verbatim: the *(n-1) / /(n-1) rescale otherwise drifts
 * 0.7 → 0.6999999999999998 at n=4. (#59)
 * ============================================================ */

console.log("\n── multistate envelope: positions + curve preserved (#59) ──");

function multistateYaml(stateLines, curveLine) {
  return topLevelYaml([
    "grain:",
    "  duration: 0.05",
    "  envelope:",
    "    states:",
    ...stateLines.map(l => "      " + l),
    "    " + curveLine,
  ]);
}
const serEnv0 = (d) => window.jsyaml.load(serialize(d)).streams[0].grain.envelope;

{
  // non-uniform positions + a curve point that drifts under naive rescale (n=4)
  const data = parse(multistateYaml(
    ["- [0, hanning]", "- [0.3, bartlett]", "- [0.7, expodec]", "- [1, blackman]"],
    "curve: [[0, 0], [0.5, 0.7], [1, 1]]"));
  const env = serEnv0(data);
  assert("#59 non-uniform positions preserved",
    eq(env.states, [[0, "hanning"], [0.3, "bartlett"], [0.7, "expodec"], [1, "blackman"]]),
    JSON.stringify(env.states));
  assert("#59 curve preserved verbatim (no FP drift)",
    eq(env.curve, [[0, 0], [0.5, 0.7], [1, 1]]),
    JSON.stringify(env.curve));
  assert("#59 non-uniform multistate — roundTrip lossless",
    roundTripDiff(data).length === 0, JSON.stringify(roundTripDiff(data)));
}

{
  // uniform multistate (positions == i/(n-1)) round-trips with no extra state
  const data = parse(multistateYaml(
    ["- [0, hanning]", "- [0.5, bartlett]", "- [1, blackman]"],
    "curve: [[0, 0], [1, 1]]"));
  const env = serEnv0(data);
  assert("#59 uniform positions round-trip",
    eq(env.states, [[0, "hanning"], [0.5, "bartlett"], [1, "blackman"]]),
    JSON.stringify(env.states));
}

{
  // editing a state NAME keeps the custom positions (rename != restructure)
  const data = parse(multistateYaml(
    ["- [0, hanning]", "- [0.2, bartlett]", "- [0.9, blackman]"],
    "curve: [[0, 0], [1, 1]]"));
  data.streams[0].grain.envelope.states[1] = "gaussian";
  const env = serEnv0(data);
  assert("#59 rename keeps custom positions",
    eq(env.states, [[0, "hanning"], [0.2, "gaussian"], [0.9, "blackman"]]),
    JSON.stringify(env.states));
}

{
  // editing the curve (editor space [0, n-1]) re-emits the engine-space curve,
  // dropping the verbatim copy. n=3 → editor mid 1.0 == engine 0.5
  const data = parse(multistateYaml(
    ["- [0, hanning]", "- [0.5, bartlett]", "- [1, blackman]"],
    "curve: [[0, 0], [0.5, 0.7], [1, 1]]"));
  data.streams[0].grain.envelope.curve = [[0, 0], [0.5, 1.0], [1, 2]];
  const env = serEnv0(data);
  assert("#59 curve edit re-emitted in engine space",
    eq(env.curve, [[0, 0], [0.5, 0.5], [1, 1]]),
    JSON.stringify(env.curve));
}

{
  // adding a state is a structural change: stale statePositions (wrong length)
  // are ignored and spacing falls back to uniform i/(n-1)
  const data = parse(multistateYaml(
    ["- [0, hanning]", "- [0.2, bartlett]", "- [0.9, blackman]"],
    "curve: [[0, 0], [1, 1]]"));
  data.streams[0].grain.envelope.states.push("expodec");  // 3 → 4 states
  const env = serEnv0(data);
  assert("#59 adding a state falls back to uniform spacing",
    eq(env.states.map(s => s[0]), [0, 1 / 3, 2 / 3, 1]),
    JSON.stringify(env.states));
}

/* ============================================================
 * SECTION 8e-bis — grain.envelope blend curve with a non-linear global interp
 * (step / cubic). The editor stores it as the typed dict {type, points} (via
 * wrapEnv); parse/serialize must round-trip it WITHOUT crashing. The multistate
 * branch used `curve.map(...)`, which threw "map is not a function" on the dict
 * — the reported step/cubic crash. Transition keeps the dict verbatim.
 * ============================================================ */

console.log("\n── grain.envelope curve: step/cubic dict form (no crash) ──");

{
  // multistate + dict step curve in YAML → parse → serialize re-emits the
  // engine-space dict verbatim (n=3: engine 0.5 ↔ editor 1.0). Regression:
  // parse no longer crashes on the dict, serialize no longer crashes on `.map`.
  const data = parse(multistateYaml(
    ["- [0, hanning]", "- [0.5, bartlett]", "- [1, blackman]"],
    "curve: {type: step, points: [[0, 0], [0.5, 0.5], [1, 1]]}"));
  const env = serEnv0(data);
  assert("step dict curve preserved verbatim",
    eq(env.curve, { type: "step", points: [[0, 0], [0.5, 0.5], [1, 1]] }),
    JSON.stringify(env.curve));
  assert("step dict multistate — roundTrip lossless",
    roundTripDiff(data).length === 0, JSON.stringify(roundTripDiff(data)));
}

{
  // the actual editor gesture: an existing linear-array multistate curve gets the
  // dict cubic form assigned (what commitWithInterp/wrapEnv produce). serialize
  // must rescale points /(n-1), keep the {type} wrapper, and NOT throw.
  const data = parse(multistateYaml(
    ["- [0, hanning]", "- [0.5, bartlett]", "- [1, blackman]"],
    "curve: [[0, 0], [1, 1]]"));
  data.streams[0].grain.envelope.curve = { type: "cubic", points: [[0, 0], [0.5, 1.0], [1, 2]] };
  let env, threw = false;
  try { env = serEnv0(data); } catch (e) { threw = true; }
  assert("cubic dict curve edit serializes without crashing", !threw);
  assert("cubic dict curve edit rescaled to engine space, type kept",
    !threw && eq(env.curve, { type: "cubic", points: [[0, 0], [0.5, 0.5], [1, 1]] }),
    JSON.stringify(env && env.curve));
}

{
  // transition + dict step curve: kept verbatim through parse + serialize
  // (transition curve is already engine-space [0, 1], no rescale).
  const data = parse(topLevelYaml([
    "grain:",
    "  duration: 0.05",
    "  envelope:",
    "    from: hanning",
    "    to: bartlett",
    "    curve: {type: step, points: [[0, 0], [1, 1]]}",
  ]));
  const env = serEnv0(data);
  assert("transition step dict curve preserved",
    eq(env, { from: "hanning", to: "bartlett", curve: { type: "step", points: [[0, 0], [1, 1]] } }),
    JSON.stringify(env));
  assert("transition step dict — roundTrip lossless",
    roundTripDiff(data).length === 0, JSON.stringify(roundTripDiff(data)));
}

{
  // per-point interp triple on a multistate curve survives the round trip
  // (the old rescale dropped it, emitting only [t, v]).
  const data = parse(multistateYaml(
    ["- [0, hanning]", "- [0.5, bartlett]", "- [1, blackman]"],
    "curve: [[0, 0], [0.5, 0.5, step], [1, 1]]"));
  const env = serEnv0(data);
  assert("per-point interp on curve preserved",
    eq(env.curve, [[0, 0], [0.5, 0.5, "step"], [1, 1]]),
    JSON.stringify(env.curve));
}

/* ============================================================
 * SECTION 8f — explicit *_range: 0 is preserved (#50). Engine-side an explicit
 * range (even 0) sets has_explicit_range and DISABLES the implicit jitter the
 * deviation_probability gate would otherwise apply (parameter.py
 * _calculate_range: _mod_range
 * is None -> default_jitter); absent means "use the implicit jitter". So 0 is
 * NOT equivalent to absent — same rule already applied to pitch.range (#34).
 * The old `!== 0` serialize guard dropped an explicit 0 (and parse coerced
 * absent -> 0 for volume/pan/duration, hiding it). Fix: parse preserves absence
 * as null; serialize omits only null/undefined.
 * ============================================================ */

console.log("\n── explicit *_range: 0 preserved, absent stays absent (#50) ──");

const ser50 = (d) => window.jsyaml.load(serialize(d)).streams[0];

{
  const data = parse(topLevelYaml(["volume_range: 0", "pan_range: 0"]));
  const y = ser50(data);
  assert("#50 explicit volume_range: 0 preserved", y.volume_range === 0, JSON.stringify(y));
  assert("#50 explicit pan_range: 0 preserved", y.pan_range === 0, JSON.stringify(y));
  assert("#50 explicit volume/pan range 0 — roundtrip lossless",
    roundTripDiff(data).length === 0, JSON.stringify(roundTripDiff(data)));
}
{
  const data = parse(topLevelYaml(["grain: {duration: 0.05, duration_range: 0}"]));
  const g = ser50(data).grain || {};
  assert("#50 explicit grain.duration_range: 0 preserved", g.duration_range === 0, JSON.stringify(g));
}
{
  const data = parse(pointerYaml(["speed_ratio: 1", "offset_range: 0"]));
  const p = ser50(data).pointer || {};
  assert("#50 explicit pointer.offset_range: 0 preserved", p.offset_range === 0, JSON.stringify(p));
}
{
  // absent ranges must NOT gain a spurious *_range: 0
  const y = ser50(parse(topLevelYaml([])));
  assert("#50 absent volume_range not emitted", !("volume_range" in y), JSON.stringify(y));
  assert("#50 absent pan_range not emitted", !("pan_range" in y), JSON.stringify(y));
  assert("#50 absent grain.duration_range not emitted",
    !y.grain || !("duration_range" in y.grain), JSON.stringify(y.grain));
}
{
  // non-zero ranges still round-trip
  const data = parse(topLevelYaml(["volume_range: 3", "pan_range: 0.5",
    "grain: {duration: 0.05, duration_range: 0.01}"]));
  const y = ser50(data);
  assert("#50 non-zero volume_range kept", y.volume_range === 3, JSON.stringify(y));
  assert("#50 non-zero pan_range kept", y.pan_range === 0.5, JSON.stringify(y));
  assert("#50 non-zero duration_range kept", (y.grain || {}).duration_range === 0.01, JSON.stringify(y.grain));
  assert("#50 non-zero ranges — roundtrip lossless",
    roundTripDiff(data).length === 0, JSON.stringify(roundTripDiff(data)));
}

/* ============================================================
 * SECTION 8g — solo/mute propagated through parse + serialize, presence-keyed
 * to match the engine (#63). The engine's _filter_solo_mute (generator.py) keys
 * off KEY PRESENCE, not value: `solo: false` still counts as solo-active. So
 * serialize must emit the key ONLY when true (omit when false — never
 * `solo: false`), and parse must read presence-of-key as true. Both used to be
 * UI-only: streamToYaml never emitted them, streamFromYaml forced them to false,
 * and the round-trip diff ignored them — a solo set in the editor never reached
 * the engine, and a solo in a loaded file was dropped.
 * ============================================================ */

console.log("\n── solo/mute presence-keyed (#63) ──");

{
  // parse: presence of the key → true (mirrors the engine presence-based
  // filter), regardless of the YAML value.
  const sTrue = parse(topLevelYaml(["solo: true", "mute: true"])).streams[0];
  assert("#63 parse solo: true → solo true", sTrue.solo === true, JSON.stringify(sTrue.solo));
  assert("#63 parse mute: true → mute true", sTrue.mute === true, JSON.stringify(sTrue.mute));

  // presence vs false: `solo: false` is still PRESENT, so the engine treats it
  // as solo-active — the editor must read it as true, not false.
  const sFalse = parse(topLevelYaml(["solo: false", "mute: false"])).streams[0];
  assert("#63 parse solo: false (present) → solo true", sFalse.solo === true, JSON.stringify(sFalse.solo));
  assert("#63 parse mute: false (present) → mute true", sFalse.mute === true, JSON.stringify(sFalse.mute));

  // absent → false
  const sNone = parse(topLevelYaml([])).streams[0];
  assert("#63 absent solo → false", sNone.solo === false, JSON.stringify(sNone.solo));
  assert("#63 absent mute → false", sNone.mute === false, JSON.stringify(sNone.mute));
}

{
  // solo/mute are modelled keys now, not _extra leftovers (KNOWN_STREAM_KEYS).
  const s = parse(topLevelYaml(["solo: true", "mute: true"])).streams[0];
  assert("#63 solo/mute not captured in _extra",
    !s._extra || (!("solo" in s._extra) && !("mute" in s._extra)), JSON.stringify(s._extra));
}

{
  // serialize: emit ONLY when true (presence-keyed). false/absent → key omitted,
  // never `solo: false` (which the engine would misread as solo-active).
  const dOn = parse(topLevelYaml([]));
  dOn.streams[0].solo = true;
  dOn.streams[0].mute = true;
  const yOn = serialize(dOn);
  assert("#63 serialize solo true → 'solo: true' emitted", /^\s*solo: true$/m.test(yOn), yOn.slice(0, 400));
  assert("#63 serialize mute true → 'mute: true' emitted", /^\s*mute: true$/m.test(yOn), yOn.slice(0, 400));

  const dOff = parse(topLevelYaml([]));   // solo=false, mute=false from streamFromYaml
  const yOff = serialize(dOff);
  assert("#63 serialize solo false → key omitted (never 'solo: false')", !/solo:/.test(yOff), yOff.slice(0, 400));
  assert("#63 serialize mute false → key omitted (never 'mute: false')", !/mute:/.test(yOff), yOff.slice(0, 400));
}

{
  // editor→YAML→editor round trip is lossless once solo/mute are set (the path
  // roundTripDiff guards, and the one IGNORE_FIELDS used to hide).
  const d = parse(topLevelYaml([]));
  d.streams[0].solo = true;
  d.streams[0].mute = true;
  assert("#63 roundtrip solo+mute true — no diffs", roundTripDiff(d).length === 0, JSON.stringify(roundTripDiff(d)));
}

{
  // presence-vs-false round trip: a file with `solo: false` parses to solo-true
  // and re-serializes as `solo: true` (semantically identical to the engine),
  // stable on a second pass.
  const data = parse(topLevelYaml(["solo: false"]));
  const y = ser50(data);
  assert("#63 'solo: false' re-serialized as solo: true (presence-keyed)", y.solo === true, JSON.stringify(y));
  assert("#63 presence-vs-false — roundtrip lossless", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  // per-stream round trip (Raw tab path): solo/mute survive as top-level flags,
  // not _extra. serializeStream/parseStream are the single source of truth (#42).
  const s = parse(topLevelYaml([])).streams[0];
  s.solo = true;
  s.mute = true;
  const back = parseStream(serializeStream(s));
  assert("#63 per-stream round trip — solo preserved", back.solo === true, JSON.stringify(back.solo));
  assert("#63 per-stream round trip — mute preserved", back.mute === true, JSON.stringify(back.mute));
  assert("#63 per-stream round trip — not in _extra",
    !back._extra || (!("solo" in back._extra) && !("mute" in back._extra)), JSON.stringify(back._extra));
}

/* ============================================================
 * SECTION 9 — corpus: every engine config round-trips
 * ============================================================ */

console.log("\n── corpus: engine configs ──");

const configsDir = path.join(__dirname, "../../..", "PythonGranularEngine/configs");
if (fs.existsSync(configsDir)) {
  const files = fs.readdirSync(configsDir).filter(f => /\.ya?ml$/.test(f)).sort();
  for (const f of files) {
    const text = fs.readFileSync(path.join(configsDir, f), "utf8");
    let data;
    try {
      data = parse(text);
    } catch (e) {
      assert(`corpus ${f} — parse`, false, e.message);
      continue;
    }
    const diffs = roundTripDiff(data);
    assert(`corpus ${f} — roundTripDiff []`, diffs.length === 0,
      diffs.slice(0, 4).map(d => JSON.stringify(d)).join("; "));
    let back, stext;
    try {
      stext = serialize(data);
      back = parse(stext);
    } catch (e) {
      assert(`corpus ${f} — reparse`, false, e.message);
      continue;
    }
    assert(`corpus ${f} — stream count stable`, back.streams.length === data.streams.length,
      `${data.streams.length} → ${back.streams.length}`);
    assert(`corpus ${f} — envelopes inline (no '- -')`, !/^[ \t]*- -/m.test(stext),
      (stext.match(/^[ \t]*- -.*/m) || [""])[0]);
  }
} else {
  console.log("  SKIP corpus (engine configs dir not found)");
}

/* ============================================================
 * SECTION 10 — per-stream serializer unified on the bridge (#42)
 *
 * The Raw tab used to ship a second YAML emitter (buildLines) + inline parser
 * (parseYaml); both are removed. yaml-bridge now exposes serializeStream /
 * parseStream as the single source of truth, and YamlEditor.jsx keeps only
 * presentation helpers (tokenizeYamlLine, computeAnnotations). These tests pin
 * the new contracts and the per-stream round trip.
 * ============================================================ */

console.log("\n── per-stream serializer unified on bridge (#42) ──");

global.React = {};                                    // satisfies `const {…} = React`
const yeSrc = fs.readFileSync(path.join(__dirname, "../../src/components/YamlEditor.jsx"), "utf8");
eval(yeSrc.split("/* ==== node-test boundary")[0]);   // only the JSX-free head
// The eval above leaks `tokenizeYamlLine`/`computeAnnotations` (function
// declarations) into this scope; we call them directly rather than re-declaring
// with const (which would clash). They're also exposed on window.PGE.

const streamOf   = (yamlText) => parse(yamlText).streams[0];
const stripColor = (s) => { const c = { ...s }; delete c.color; return c; };

assert("#42 bridge exposes serializeStream/parseStream",
  typeof serializeStream === "function" && typeof parseStream === "function");
assert("#42 presentation helpers loaded",
  typeof tokenizeYamlLine === "function" && typeof computeAnnotations === "function");

// Round-trip serializeStream → parseStream is lossless (modulo UI-only color).
{
  const fixtures = [
    ["loop without loop_start", pointerYaml(["loop_dur: 0.4", "loop_unit: normalized"])],
    ["loop_end exclusive",      pointerYaml(["loop_end: 2.5"])],
    ["full loop",               pointerYaml(["loop_start: 0.2", "loop_dur: 0.4", "loop_unit: normalized"])],
    ["top-level extra",         topLevelYaml(["mio_extra: 9"])],
  ];
  for (const [label, yamlText] of fixtures) {
    const s = streamOf(yamlText);
    const back = parseStream(serializeStream(s));
    assert(`#42 round-trip serializeStream→parseStream — ${label}`,
      eq(stripColor(s), stripColor(back)),
      JSON.stringify({ before: stripColor(s), after: stripColor(back) }).slice(0, 400));
  }
}

{
  // Per-block _extra (pointer/grain/pitch/voices) survives the per-stream round trip.
  const yamlExtras = `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    pointer:
      start: 0
      futuro_param: 7
    grain:
      duration: 0.05
      xkey: 1
    pitch:
      semitones: 2
      glide: 3
    voices:
      num_voices: 2
      nuova: 4
`;
  const s = streamOf(yamlExtras);
  const back = parseStream(serializeStream(s));
  assert("#42 per-block _extra survives round trip", eq(stripColor(s), stripColor(back)),
    JSON.stringify(stripColor(back)).slice(0, 400));
}

{
  // deviation_probability modes survive the per-stream round trip
  // (implicit / false / number).
  for (const dep of ["deviation_probability:", "deviation_probability: false", "deviation_probability: 0.2"]) {
    const s = streamOf(topLevelYaml([dep]));
    const back = parseStream(serializeStream(s));
    assert(`#42 deviation_probability round trip — "${dep}"`, eq(stripColor(s), stripColor(back)),
      JSON.stringify({ before: s.deviationProbability, after: back.deviationProbability }));
  }
}

{
  // serializeStream(s) text equals the stream dict produced by full-project
  // serialize — proving the Raw tab can't drift from the save path.
  const s = streamOf(pointerYaml(["loop_dur: 0.4", "loop_unit: normalized", "futuro: 5"]));
  const single      = window.jsyaml.load(serializeStream(s));
  const fromProject = window.jsyaml.load(serialize({ streams: [s], title: "", duration: 60, bpm: 120 })).streams[0];
  assert("#42 serializeStream ≡ project serialize (per stream)", eq(single, fromProject),
    JSON.stringify({ single, fromProject }).slice(0, 400));
}

{
  // tokenizeYamlLine: presentation classification only (never re-derives YAML).
  const t1 = tokenizeYamlLine("sample: test.wav");
  assert("#42 tokenize key:value — key class", t1.key === "sample" && t1.spans[0].cls === "k", JSON.stringify(t1));
  const t2 = tokenizeYamlLine("onset: 0");
  assert("#42 tokenize numeric value class", t2.spans.some(sp => sp.cls === "v" && sp.text === "0"), JSON.stringify(t2));
  const t3 = tokenizeYamlLine("  - - 0");
  assert("#42 tokenize block-seq scalar", t3.spans.some(sp => sp.cls === "v" && sp.text === "0"), JSON.stringify(t3));
  const t4 = tokenizeYamlLine("# a comment");
  assert("#42 tokenize comment class", t4.spans.length === 1 && t4.spans[0].cls === "c", JSON.stringify(t4));
  const t5 = tokenizeYamlLine("pointer:");
  assert("#42 tokenize block header key", t5.key === "pointer", JSON.stringify(t5));
}

{
  // computeAnnotations: the three validations, attached by yaml key.
  const sNoRec = streamOf(minimalYaml(null));
  const a1 = computeAnnotations(sNoRec, null);   // no sample record
  assert("#42 annotate missing sample", a1.byKey.get("sample") && a1.byKey.get("sample").kind === "err",
    JSON.stringify([...a1.byKey]));

  const sLoop = streamOf(pointerYaml(["loop_end: 9"]));
  const a2 = computeAnnotations(sLoop, { name: "test.wav", duration: 5 });
  assert("#42 annotate loop_end over sample dur", a2.byKey.get("loop_end") && a2.byKey.get("loop_end").kind === "err",
    JSON.stringify([...a2.byKey]));

  const sOk = streamOf(pointerYaml(["loop_end: 3"]));
  const a3 = computeAnnotations(sOk, { name: "test.wav", duration: 5 });
  assert("#42 no annotation when loop_end within sample dur", !a3.byKey.has("loop_end"), JSON.stringify([...a3.byKey]));

  const sPan = streamOf(topLevelYaml(["pan: [[0, 0], [5, 5000]]"]));
  const a4 = computeAnnotations(sPan, { name: "test.wav", duration: 5 });
  assert("#42 annotate pan env out of range", a4.byKey.get("pan") && a4.byKey.get("pan").kind === "warn",
    JSON.stringify([...a4.byKey]));
}

/* ============================================================
 * SECTION — composition duration derived from streams (#auto-duration)
 * ============================================================ */

console.log("\n── computeDuration: derived from streams ──");

{
  assert("computeDuration([]) — pad only", computeDuration([]) === 10, String(computeDuration([])));
  assert("computeDuration default pad — furthest edge + 10",
    computeDuration([{ onset: 50, duration: 20 }]) === 80,
    String(computeDuration([{ onset: 50, duration: 20 }])));
  assert("computeDuration — max over many streams",
    computeDuration([{ onset: 0, duration: 5 }, { onset: 60, duration: 10 }, { onset: 30, duration: 5 }]) === 80,
    String(computeDuration([{ onset: 0, duration: 5 }, { onset: 60, duration: 10 }, { onset: 30, duration: 5 }])));
  assert("computeDuration — custom pad",
    computeDuration([{ onset: 5, duration: 5 }], 0) === 10,
    String(computeDuration([{ onset: 5, duration: 5 }], 0)));
}

{
  // serialize always emits the derived duration, ignoring stored data.duration.
  const data = parse("streams:\n  - stream_id: s1\n    onset: 60\n    duration: 10\n    sample: test.wav\n");
  data.duration = 9999;                       // stale stored value
  const y = serialize(data);
  const obj = window.jsyaml.load(y);
  assert("serialize — duration derived (70 + 10), stored ignored", obj.duration === 80, JSON.stringify(obj.duration));
}

{
  // parse ignores a stored duration: and derives from the streams instead.
  const data = parse("duration: 60\nstreams:\n  - stream_id: s1\n    onset: 100\n    duration: 5\n    sample: test.wav\n");
  assert("parse — stored duration ignored, derived from streams", data.duration === 115, String(data.duration));
}

/* ============================================================
 * SECTION — open+save is a no-op (no engine-default injection)
 * Cache-stability: parse→serialize must not add OR drop keys vs the source.
 * The engine's per-stream content hash (and the UI stale dot) re-render every
 * stem if a stream's raw dict changes on save. So: an ABSENT default stays
 * absent; an explicitly PRESENT value (even at the default) is kept verbatim.
 * ============================================================ */

console.log("\n── serialize: open+save is a no-op ──");

const _noop = "streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n    sample: t.wav";
function rawStream(yamlText) {
  const obj = window.jsyaml.load(serialize(parse(yamlText)));
  return ((obj || {}).streams || [])[0] || {};
}

{
  // Headline regression: a minimal hand-authored stream round-trips through
  // PGE-ui without gaining any default keys.
  const s = rawStream(_noop + "\n    density: 100\n    grain:\n      duration: 0.05\n");
  assert("minimal — distribution_mode not injected", !("distribution_mode" in s), JSON.stringify(s));
  assert("minimal — volume not injected",            !("volume" in s),            JSON.stringify(s));
  assert("minimal — grain.envelope not injected",    !("envelope" in (s.grain || {})), JSON.stringify(s.grain));
  assert("minimal — pointer (start) not injected",   !("pointer" in s),           JSON.stringify(s));
}

{
  // distribution_mode: absent stays absent (headline); explicit value (incl. the
  // default 'uniform') is kept verbatim.
  const sU = rawStream(_noop + "\n    distribution_mode: uniform\n");
  assert("distribution_mode: explicit uniform kept", sU.distribution_mode === "uniform", JSON.stringify(sU));
  const sG = rawStream(_noop + "\n    distribution_mode: gaussian\n");
  assert("distribution_mode: gaussian kept", sG.distribution_mode === "gaussian", JSON.stringify(sG));
}

{
  // volume: explicit 0 (the engine default) is kept verbatim; non-zero kept.
  const s0 = rawStream(_noop + "\n    volume: 0\n");
  assert("volume: explicit 0 kept", s0.volume === 0, JSON.stringify(s0));
  const sN = rawStream(_noop + "\n    volume: -6\n");
  assert("volume: -6 kept", sN.volume === -6, JSON.stringify(sN));
}

{
  // grain.envelope: explicit 'hanning' (the default) is kept; the grain block
  // survives when it carries other keys; other windows kept.
  const sH = rawStream(_noop + "\n    grain:\n      duration: 0.05\n      envelope: hanning\n");
  assert("grain.envelope: explicit hanning kept", sH.grain && sH.grain.envelope === "hanning", JSON.stringify(sH.grain));
  const sD = rawStream(_noop + "\n    grain:\n      duration: 0.05\n");
  assert("grain w/o envelope — none injected", sD.grain && !("envelope" in sD.grain), JSON.stringify(sD.grain));
  const sE = rawStream(_noop + "\n    grain:\n      duration: 0.05\n      envelope: expodec\n");
  assert("grain.envelope: expodec kept", sE.grain && sE.grain.envelope === "expodec", JSON.stringify(sE.grain));
}

{
  // pointer.start — the rendering-critical case. A pointer block WITHOUT start
  // must not gain `start: 0`: engine-side an absent start with a loop means
  // "begin at loop_start", so injecting 0 would both bust the cache AND change
  // the audio. Explicit start (any value, incl. 0) round-trips verbatim.
  const sLoopNoStart = rawStream(_noop + "\n    pointer:\n      loop_start: 0.1\n      speed_ratio: 0.001\n");
  assert("pointer w/o start — start not injected", !("start" in (sLoopNoStart.pointer || {})), JSON.stringify(sLoopNoStart.pointer));
  assert("pointer w/o start — block intact", sLoopNoStart.pointer && sLoopNoStart.pointer.loop_start === 0.1, JSON.stringify(sLoopNoStart.pointer));
  const s0 = rawStream(_noop + "\n    pointer:\n      start: 0\n      speed_ratio: 0.01\n");
  assert("pointer explicit start:0 kept", s0.pointer && s0.pointer.start === 0, JSON.stringify(s0.pointer));
  const sNZ = rawStream(_noop + "\n    pointer:\n      start: 0.5\n");
  assert("pointer start:0.5 kept", sNZ.pointer && sNZ.pointer.start === 0.5, JSON.stringify(sNZ.pointer));
}

{
  // Editor-level round trip stays lossless for all the above shapes.
  for (const [label, extra] of [
    ["minimal", ""],
    ["explicit start:0 + loop", "\n    pointer:\n      start: 0\n      loop_start: 0.25\n"],
    ["loop without start", "\n    pointer:\n      loop_start: 0.1\n      speed_ratio: 0.001\n"],
    ["explicit defaults", "\n    distribution_mode: uniform\n    volume: 0\n    grain:\n      duration: 0.05\n      envelope: hanning\n"],
  ]) {
    const d = parse(_noop + extra + "\n");
    assert(`roundtrip lossless — ${label}`, roundTripDiff(d).length === 0, JSON.stringify(roundTripDiff(d)));
  }
}

/* ============================================================
 * SECTION 11 — envelopes serialized inline (flow style)
 *
 * Breakpoint lists — and the points/states/curve/spread arrays inside the
 * dict-form envelopes — are emitted in flow style on a single line
 * (`[[t, v], [t, v], …]`) instead of block-style nested dashes (`- - t`).
 * Pure formatting: the parsed structure is identical, so parse() and the round
 * trip are unaffected; only how the saved file reads changes. The dict wrapper
 * (type/strategy/…) keeps block style; only the numeric lists go inline.
 * ============================================================ */

console.log("\n── envelopes inline / flow style ──");

const envHeavyYaml = `streams:
  - stream_id: s1
    onset: 0
    duration: 10
    sample: test.wav
    time_mode: normalized
    density: [[0, 110.13], [0.0423, 57.96], [0.1262, 208.37, cubic], [1, 8]]
    distribution:
      type: cubic
      points: [[0, 0], [0.10221, 0.99], [0.57069, 0]]
    grain:
      duration: [[0, 0.05], [0.57069, 0.05]]
      envelope:
        states:
          - [0, hanning]
          - [0.5, bartlett]
          - [1, blackman]
        curve: [[0, 0], [1, 1]]
    pointer:
      speed_ratio: [[0.00228, 0.07], [0.56687, -0.09]]
    pan: [[0, 0], [0.3577, 0], [1, 0]]
    voices:
      num_voices:
        type: step
        points: [[0, 1], [0.5, 4], [1, 1]]
      pan:
        spread: [[0, 60], [0.27, 155], [1, 60]]
        strategy: stochastic
    deviation_probability: [[0, 100], [0.4047, 100], [1, 1]]
`;

{
  const data = parse(envHeavyYaml);
  const y = serialize(data);

  // Headline guarantee: no block-style nested sequence anywhere.
  assert("inline — no block nested seq ('- -')", !/^[ \t]*- -/m.test(y),
    (y.match(/^[ \t]*- -.*/m) || [""])[0]);

  // Bare-array envelopes go inline as [[t, v], …].
  assert("inline — density bracket form",      /^\s*density: \[\[0, 110\.13\], /m.test(y),     y.slice(0, 700));
  assert("inline — pan bracket form",          /^\s*pan: \[\[0, 0\], /m.test(y),               y.slice(0, 900));
  assert("inline — pointer.speed_ratio inline",/^\s*speed_ratio: \[\[0\.00228, 0\.07\], /m.test(y), y);
  assert("inline — grain.duration inline",     /^\s*duration: \[\[0, 0\.05\], /m.test(y),      y);
  assert("inline — deviation_probability inline", /^\s*deviation_probability: \[\[0, 100\], /m.test(y), y);

  // Per-point interp triple preserved inside the inline list.
  assert("inline — per-point interp kept inline", /\[0\.1262, 208\.37, cubic\]/.test(y), y.slice(0, 700));

  // Dict-form envelopes: wrapper keeps block style, the points list goes inline.
  assert("inline — distribution keeps 'type: cubic' block key", /^\s*type: cubic$/m.test(y),      y);
  assert("inline — distribution points inline",                 /^\s*points: \[\[0, 0\], /m.test(y), y);
  assert("inline — num_voices keeps 'type: step'",              /^\s*type: step$/m.test(y),       y);
  assert("inline — num_voices points inline",                   /^\s*points: \[\[0, 1\], /m.test(y), y);
  assert("inline — voices.pan keeps 'strategy: stochastic'",    /^\s*strategy: stochastic$/m.test(y), y);
  assert("inline — voices.pan spread inline",                   /^\s*spread: \[\[0, 60\], /m.test(y), y);

  // Grain multistate envelope: states and curve both inline.
  assert("inline — grain.envelope states inline", /^\s*states: \[\[0, hanning\], /m.test(y), y);
  assert("inline — grain.envelope curve inline",  /^\s*curve: \[\[0, 0\], /m.test(y),        y);

  // Formatting only: round trip stays lossless.
  assert("inline — envelope-heavy round trip lossless", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)).slice(0, 600));
}

{
  // voices.pan step strategy: scalar + envelope round-trip (renamed pan surface).
  const stepScalarYaml = `
title: t
duration: 10
streams:
  - stream_id: s1
    onset: 0
    duration: 10
    sample: test.wav
    voices:
      num_voices: 4
      pan:
        strategy: step
        step: 15
`;
  const dScalar = parse(stepScalarYaml);
  const pan = dScalar.streams[0].voices.pan;
  assert("pan step — strategy parsed", pan.strategy === "step", JSON.stringify(pan));
  assert("pan step — scalar in step field", pan.step === 15 && pan.stepEnv == null, JSON.stringify(pan));
  assert("pan step — scalar round trip lossless", roundTripDiff(dScalar).length === 0,
    JSON.stringify(roundTripDiff(dScalar)).slice(0, 400));

  const stepEnvYaml = `
title: t
duration: 10
streams:
  - stream_id: s1
    onset: 0
    duration: 10
    sample: test.wav
    voices:
      num_voices: 4
      pan:
        strategy: step
        step: [[0, 0], [1, 30]]
`;
  const dEnv = parse(stepEnvYaml);
  const panE = dEnv.streams[0].voices.pan;
  assert("pan step — envelope in stepEnv field", Array.isArray(panE.stepEnv) && panE.step == null, JSON.stringify(panE));
  assert("pan step — envelope round trip lossless", roundTripDiff(dEnv).length === 0,
    JSON.stringify(roundTripDiff(dEnv)).slice(0, 400));
  const yE = serialize(dEnv);
  assert("pan step — envelope serialized inline", /^\s*step: \[\[0, 0\], \[1, 30\]\]$/m.test(yE), yE);
}

{
  // serializeStream (Raw tab) inlines envelopes too AND stays identical to the
  // project save path (#42 parity preserved).
  const s  = parse(envHeavyYaml).streams[0];
  const sy = serializeStream(s);
  assert("inline — serializeStream inlines (no '- -')", !/^[ \t]*- -/m.test(sy),
    (sy.match(/^[ \t]*- -.*/m) || [""])[0]);
  assert("inline — serializeStream density inline", /density: \[\[0, 110\.13\]/.test(sy), sy.slice(0, 400));
  const single      = window.jsyaml.load(sy);
  const fromProject = window.jsyaml.load(serialize({ streams: [s], title: "", duration: 60, bpm: 120 })).streams[0];
  assert("inline — serializeStream ≡ project serialize", eq(single, fromProject),
    JSON.stringify({ single, fromProject }).slice(0, 400));
}

{
  // Compact loop blocks (bare form: [pattern, end, n, interp, dist]) also go
  // inline on a single line.
  const loopYaml = `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    density: [[[0, 1], [50, 8], [100, 1]], 1, 4, linear, linear]
`;
  const data = parse(loopYaml);
  const y = serialize(data);
  assert("inline — compact loop block single line", !/^[ \t]*- -/m.test(y),
    (y.match(/^[ \t]*- -.*/m) || [""])[0]);
  assert("inline — compact loop block inline form", /density: \[\[\[0, 1\], /.test(y), y.slice(0, 400));
  assert("inline — compact loop block round trip", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)).slice(0, 400));
}

/* ============================================================
 * SECTION — top-level `seed` (#79)
 * Engine-side reproducible NumPy renders. `seed` is a top-level key (sibling of
 * `streams`), modelled first-class on `data.seed` (NOT swallowed by `_extra`).
 * Absent → key not emitted (behaviour unchanged). Integers (incl. 0 and
 * negatives) and strings are all valid; 0 must NOT be treated as falsy/absent.
 * ============================================================ */

console.log("\n── top-level seed (#79) ──");

// seed at document top level (sibling of streams), not nested in a stream.
function seedYaml(seedLine) {
  return `${seedLine}\nstreams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n    sample: test.wav\n`;
}
const noSeedYaml = "streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n    sample: test.wav\n";

{
  // parse: seed exposed first-class on data.seed, NOT swallowed by _extra.
  const d = parse(seedYaml("seed: 42"));
  assert("#79 parse — data.seed === 42", d.seed === 42, JSON.stringify(d.seed));
  assert("#79 parse — seed not in _extra", !d._extra || !("seed" in d._extra), JSON.stringify(d._extra));
}
{
  // seed: 0 is valid and must survive (not treated as falsy/absent).
  const d = parse(seedYaml("seed: 0"));
  assert("#79 parse — seed 0 kept first-class", d.seed === 0, JSON.stringify(d.seed));
}
{
  const d = parse(seedYaml("seed: -7"));
  assert("#79 parse — negative seed kept", d.seed === -7, JSON.stringify(d.seed));
}
{
  const d = parse(seedYaml('seed: "abc"'));
  assert("#79 parse — string seed kept", d.seed === "abc", JSON.stringify(d.seed));
}
{
  // absent seed → data.seed undefined, nothing leaked into _extra.
  const d = parse(noSeedYaml);
  assert("#79 parse — seed absent → undefined", d.seed === undefined, JSON.stringify(d.seed));
  assert("#79 parse — absent seed not in _extra", !d._extra || !("seed" in d._extra), JSON.stringify(d._extra));
}
{
  // serialize: emits seed at top level when present (incl. 0).
  const obj = window.jsyaml.load(serialize(parse(seedYaml("seed: 42"))));
  assert("#79 serialize — seed emitted", obj.seed === 42, JSON.stringify(obj.seed));
}
{
  const obj = window.jsyaml.load(serialize(parse(seedYaml("seed: 0"))));
  assert("#79 serialize — seed 0 emitted (not dropped as falsy)", obj.seed === 0, JSON.stringify(obj.seed));
}
{
  // absent seed → key not emitted (open+save no-op preserved).
  const obj = window.jsyaml.load(serialize(parse(noSeedYaml)));
  assert("#79 serialize — absent seed not emitted", !("seed" in obj), JSON.stringify(obj));
}
{
  // round trip lossless for int / 0 / negative / string.
  for (const sl of ["seed: 42", "seed: 0", "seed: -7", 'seed: "abc"']) {
    const before = parse(seedYaml(sl)).seed;
    const after  = parse(serialize(parse(seedYaml(sl)))).seed;
    assert(`#79 round trip — ${sl}`, before === after, JSON.stringify({ before, after }));
  }
}
{
  // roundTripDiff (the editor's lossy-save self-test) stays clean with a seed
  // set, and clean with no seed — seed is now a compared project-level field.
  for (const sl of ["seed: 42", "seed: 0", "seed: -7", 'seed: "abc"']) {
    const diffs = roundTripDiff(parse(seedYaml(sl)));
    assert(`#79 roundTripDiff clean — ${sl}`, diffs.length === 0, JSON.stringify(diffs));
  }
  assert("#79 roundTripDiff clean — no seed", roundTripDiff(parse(noSeedYaml)).length === 0,
    JSON.stringify(roundTripDiff(parse(noSeedYaml))));
}

/* ============================================================
 * SECTION 12 — new clip stream defaults (app.jsx createStreamFromSample)
 *
 * A freshly dropped clip defaults its Overall density to fill_factor mode
 * (= 2, density tracks grain_duration) and its pointer to loop_unit:
 * normalized (start/loop coords read as [0,1] × sample_dur). loop_start stays
 * absent, so no loop is created — loop_unit only sets the unit convention.
 * These pin the shape the editor emits so it can't silently drift back to a
 * fixed density: 8 / absent loop_unit.
 * ============================================================ */

console.log("\n── new clip stream defaults (#createStreamFromSample) ──");

{
  // Mirrors the object built in createStreamFromSample (color/onset omitted —
  // they don't affect the emitted density/pointer contract).
  const newClip = {
    id: "stream1", onset: 0, duration: 4, sample: "test.wav",
    mute: false, solo: false,
    timeMode: "normalized", distributionMode: "uniform",
    density: null, fillFactor: 2, distribution: 0,
    volume: 0, volumeRange: null,
    pan: 0, panRange: null,
    grain: { duration: 0.05, durationRange: null, envelope: "hanning" },
    pointer: { start: 0, speedRatio: 1, loopStart: null, loopDur: null, loopUnit: "normalized" },
    pitch: { semitones: 0, range: null },
    voices: { num: 1 },
  };
  const data = { streams: [newClip], title: "", duration: 60, bpm: 120 };
  const y = serialize(data);
  assert("new clip — fill_factor: 2 emitted", /fill_factor:\s*2\b/.test(y), y.slice(0, 500));
  assert("new clip — density not emitted", !/^\s*density:/m.test(y), y.slice(0, 500));
  assert("new clip — loop_unit: normalized emitted", y.includes("loop_unit: normalized"), y.slice(0, 500));
  assert("new clip — no loop_start (no loop created)", !/loop_start:/.test(y), y.slice(0, 500));

  const back = parse(y).streams[0];
  assert("new clip — fillFactor survives, density null", back.fillFactor === 2 && back.density == null,
    JSON.stringify({ ff: back.fillFactor, d: back.density }));
  assert("new clip — loopUnit survives reparse", back.pointer.loopUnit === "normalized",
    JSON.stringify(back.pointer));
}

/* ============================================================
 * SECTION — grain.duration_unit modelled (PGE #158)
 * ============================================================ */

console.log("\n── grain.duration_unit (#158) ──");

{
  const yamlSamples =
    "streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n    sample: test.wav\n" +
    "    grain:\n      duration: 480\n      duration_range: 96\n      duration_unit: samples\n";
  const d = parse(yamlSamples);
  const g = d.streams[0].grain;
  assert("parse grain.duration_unit → durationUnit", g.durationUnit === "samples",
    JSON.stringify(g));
  assert("duration_unit NOT captured under grain._extra",
    !(g._extra && "duration_unit" in g._extra), JSON.stringify(g._extra));
  const y = serialize(d);
  assert("serialize grain.duration_unit", /duration_unit:\s*samples/.test(y), y.slice(0, 400));
  assert("duration_unit emitted exactly once (no _extra dup)",
    (y.match(/duration_unit:/g) || []).length === 1, y.slice(0, 400));
  const back = parse(y).streams[0].grain;
  assert("durationUnit survives full round-trip", back.durationUnit === "samples");
}

{
  // Assente di default: nessuna chiave duration_unit iniettata.
  const d = parse("streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n" +
    "    sample: test.wav\n    grain:\n      duration: 0.05\n");
  assert("durationUnit null when absent", d.streams[0].grain.durationUnit == null,
    JSON.stringify(d.streams[0].grain));
  const y = serialize(d);
  assert("no duration_unit emitted when absent", !/duration_unit:/.test(y), y.slice(0, 400));
}

/* ============================================================
 * rng_group (engine #169) — identità RNG condivisa fra stream
 * ============================================================ */

{
  // Presente: modellato first-class come rngGroup, non in _extra.
  const d = parse("streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n" +
    "    sample: test.wav\n    rng_group: cugini\n");
  const s = d.streams[0];
  assert("parse rng_group → rngGroup", s.rngGroup === "cugini", JSON.stringify(s.rngGroup));
  assert("rng_group NOT captured under _extra",
    !(s._extra && "rng_group" in s._extra), JSON.stringify(s._extra));
  const y = serialize(d);
  assert("serialize rng_group", /rng_group:\s*cugini/.test(y), y.slice(0, 400));
  assert("rng_group emitted exactly once (no _extra dup)",
    (y.match(/rng_group:/g) || []).length === 1, y.slice(0, 400));
  const back = parse(y).streams[0];
  assert("rngGroup survives full round-trip", back.rngGroup === "cugini");
  const diffs = roundTripDiff(d);
  assert("roundtrip rng_group — no diffs", diffs.length === 0, JSON.stringify(diffs));
}

{
  // Assente di default: nessuna chiave rng_group iniettata (l'assenza deve
  // sopravvivere: identità = stream_id lato engine, file invariato al save).
  const d = parse("streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n" +
    "    sample: test.wav\n");
  assert("rngGroup null when absent", d.streams[0].rngGroup == null,
    JSON.stringify(d.streams[0].rngGroup));
  const y = serialize(d);
  assert("no rng_group emitted when absent", !/rng_group:/.test(y), y.slice(0, 400));
}

{
  // Stringa vuota (campo Inspector svuotato) = assente: mai `rng_group: ''`.
  const d = parse("streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n" +
    "    sample: test.wav\n    rng_group: cugini\n");
  d.streams[0].rngGroup = "";
  const y = serialize(d);
  assert("empty rngGroup not emitted", !/rng_group:/.test(y), y.slice(0, 400));
}

/* ============================================================
 * applyStreamPatch — un patch con `undefined` CANCELLA la chiave
 * ============================================================ */

{
  const { applyStreamPatch } = window.PGEYaml;
  const base = { id: "s1", density: 20, rngGroup: "cugini" };

  const cleared = applyStreamPatch(base, { rngGroup: undefined });
  assert("undefined patch removes the key", !("rngGroup" in cleared),
    JSON.stringify(cleared));
  assert("clearing leaves the other fields", cleared.density === 20 && cleared.id === "s1",
    JSON.stringify(cleared));

  const set = applyStreamPatch(base, { rngGroup: "altro" });
  assert("value patch assigns", set.rngGroup === "altro", JSON.stringify(set));

  // null NON cancella: nell'editor è un valore significativo (i campi
  // scalar/env paralleli usano null per "questo dei due non è attivo").
  const nulled = applyStreamPatch({ id: "s1", densityEnv: [[0, 1]] }, { densityEnv: null });
  assert("null patch keeps the key", "densityEnv" in nulled && nulled.densityEnv === null,
    JSON.stringify(nulled));

  // non muta l'originale (setData si aspetta un nuovo oggetto)
  assert("does not mutate the input", base.rngGroup === "cugini", JSON.stringify(base));

  // chiave assente + patch undefined → resta assente, nessuna chiave iniettata
  const noop = applyStreamPatch({ id: "s1" }, { rngGroup: undefined });
  assert("undefined patch on absent key stays absent", !("rngGroup" in noop),
    JSON.stringify(noop));
}

/* ============================================================
 * SECTION — range_anchor: modelled key, absence preserved (engine PR #173)
 *
 * range_anchor decides where `base` sits inside a `_range` band
 * (center default = symmetric, min = base is the floor). Same absence-
 * preservation contract as time_mode/distribution_mode: a stream WITHOUT the
 * key must round-trip WITHOUT it, or saving would write range_anchor: center
 * onto every stream and bust the engine's per-stream cache.
 * ============================================================ */

console.log("\n── range_anchor (engine #173) ──");

{
  const data = parse(topLevelYaml([]));
  assert("absent range_anchor — not defaulted in state",
    data.streams[0].rangeAnchor == null,
    JSON.stringify(data.streams[0].rangeAnchor));
  const y = serialize(data);
  assert("absent range_anchor — not emitted", !y.includes("range_anchor"),
    y.slice(0, 400));
}

{
  const data = parse(topLevelYaml(["range_anchor: min"]));
  assert("explicit min — kept in state", data.streams[0].rangeAnchor === "min",
    JSON.stringify(data.streams[0].rangeAnchor));
  const y = serialize(data);
  assert("explicit min — emitted", y.includes("range_anchor: min"), y.slice(0, 400));
}

{
  const data = parse(topLevelYaml(["range_anchor: center"]));
  assert("explicit center — kept in state",
    data.streams[0].rangeAnchor === "center",
    JSON.stringify(data.streams[0].rangeAnchor));
  const y = serialize(data);
  assert("explicit center — emitted", y.includes("range_anchor: center"),
    y.slice(0, 400));
}

{
  // range_anchor is modelled first-class, so it must NOT leak into _extra
  // (which would double-emit it on serialize).
  const data = parse(topLevelYaml(["range_anchor: min"]));
  const extra = data.streams[0]._extra || {};
  assert("range_anchor not captured in _extra", !("range_anchor" in extra),
    JSON.stringify(extra));
}

{
  // Lossless round-trip: no divergences reported for a stream using the key.
  const data = parse(topLevelYaml(["range_anchor: min"]));
  const diff = roundTripDiff(data);
  assert("range_anchor round-trip lossless", diff.length === 0,
    JSON.stringify(diff));
}

console.log("\n\u2500\u2500 duration optional (engine #205) \u2500\u2500");

// The media list (GET /media) is what tells the editor how long a sample is.
const SAMPLES = [{ name: "test.wav", duration: 2.5 }];

function durationYaml(durationLine) {
  return `streams:
  - stream_id: s1
    onset: 0
${durationLine ? "    " + durationLine + "\n" : ""}    sample: test.wav
`;
}

{
  // Absent duration: the stream lasts as long as the sample, not a hardcoded 5s.
  const data = parse(durationYaml(null), { samples: SAMPLES });
  const s = data.streams[0];
  assert("absent duration \u2192 sample duration", s.duration === 2.5, JSON.stringify(s.duration));
  assert("absent duration \u2192 marked implicit", s.durationImplicit === true,
    JSON.stringify(s.durationImplicit));
  assert("absent duration \u2192 sample resolved", !s.durationUnresolved,
    JSON.stringify(s.durationUnresolved));
  const y = serialize(data);
  assert("absent duration \u2192 not re-emitted", !/^[ \t]+duration:/m.test(y), y.slice(0, 400));
  const diffs = roundTripDiff(data);
  assert("absent duration \u2192 round-trip lossless", diffs.length === 0, JSON.stringify(diffs));
}

{
  // `duration: ~` is a null scalar: for the engine that is the same as absent.
  const data = parse(durationYaml("duration: ~"), { samples: SAMPLES });
  const s = data.streams[0];
  assert("duration: ~ \u2192 sample duration", s.duration === 2.5, JSON.stringify(s.duration));
  assert("duration: ~ \u2192 marked implicit", s.durationImplicit === true,
    JSON.stringify(s.durationImplicit));
  const y = serialize(data);
  assert("duration: ~ \u2192 not re-emitted", !/^[ \t]+duration:/m.test(y), y.slice(0, 400));
}

{
  // Explicit duration wins and keeps being written out.
  const data = parse(durationYaml("duration: 5"), { samples: SAMPLES });
  const s = data.streams[0];
  assert("explicit duration kept", s.duration === 5, JSON.stringify(s.duration));
  assert("explicit duration \u2192 not implicit", s.durationImplicit === false,
    JSON.stringify(s.durationImplicit));
  const y = serialize(data);
  assert("explicit duration \u2192 emitted", /^[ \t]+duration: 5$/m.test(y), y.slice(0, 400));
}

{
  // Sample not in the media list (file:// with no server, or a missing file):
  // the editor must not blow up, and must not silently pretend it knows.
  const data = parse(durationYaml(null), { samples: [] });
  const s = data.streams[0];
  assert("unresolvable sample \u2192 still a usable number",
    typeof s.duration === "number" && isFinite(s.duration) && s.duration > 0,
    JSON.stringify(s.duration));
  assert("unresolvable sample \u2192 flagged", s.durationUnresolved === true,
    JSON.stringify(s.durationUnresolved));
  assert("unresolvable sample \u2192 still implicit", s.durationImplicit === true,
    JSON.stringify(s.durationImplicit));
  const y = serialize(data);
  assert("unresolvable sample \u2192 duration still not invented in the YAML",
    !/^[ \t]+duration:/m.test(y), y.slice(0, 400));
}

{
  // Editing the duration from the interface makes it explicit.
  const data = parse(durationYaml(null), { samples: SAMPLES });
  const edited = { ...data, streams: [applyStreamPatch(data.streams[0], { duration: 3 })] };
  assert("UI edit \u2192 no longer implicit", edited.streams[0].durationImplicit === false,
    JSON.stringify(edited.streams[0].durationImplicit));
  const y = serialize(edited);
  assert("UI edit \u2192 duration written explicitly", /^[ \t]+duration: 3$/m.test(y), y.slice(0, 400));
}

{
  // A patch that doesn't mention duration leaves the implicit flag alone.
  const data = parse(durationYaml(null), { samples: SAMPLES });
  const patched = applyStreamPatch(data.streams[0], { onset: 1.5 });
  assert("unrelated patch \u2192 implicit preserved", patched.durationImplicit === true,
    JSON.stringify(patched.durationImplicit));
}

{
  // The Raw tab patches the WHOLE parsed stream, duration included. That patch
  // carries its own durationImplicit, which must win over the "the user typed a
  // duration" heuristic — otherwise editing anything in the raw YAML would
  // materialize a duration key the author never wrote.
  const data = parse(durationYaml(null), { samples: SAMPLES });
  const fromRaw = parseStream("stream_id: s1\nonset: 0\nsample: test.wav\n", 0, { samples: SAMPLES });
  const patched = applyStreamPatch(data.streams[0], fromRaw);
  assert("raw-tab patch \u2192 implicit preserved", patched.durationImplicit === true,
    JSON.stringify(patched.durationImplicit));
  assert("raw-tab patch \u2192 sample duration resolved", patched.duration === 2.5,
    JSON.stringify(patched.duration));
}

console.log("\n\u2500\u2500 duration implicita: risoluzione tardiva (engine #205) \u2500\u2500");

// Al boot la media list arriva DOPO il progetto: GET /projects e GET /media
// partono insieme e la prima risponde per prima. Se la risoluzione restasse
// solo al parse, ogni stream senza `duration` resterebbe congelato sul
// fallback per tutta la sessione.

{
  const atBoot = parse(durationYaml(null), { samples: [] });
  assert("boot senza media \u2192 non risolto", atBoot.streams[0].durationUnresolved === true,
    JSON.stringify(atBoot.streams[0].durationUnresolved));

  const settled = resolveImplicitDurations(atBoot, SAMPLES);
  assert("media in ritardo \u2192 durata vera", settled.streams[0].duration === 2.5,
    JSON.stringify(settled.streams[0].duration));
  assert("media in ritardo \u2192 non piu' irrisolto",
    settled.streams[0].durationUnresolved === false,
    JSON.stringify(settled.streams[0].durationUnresolved));
  assert("media in ritardo \u2192 resta implicita", settled.streams[0].durationImplicit === true,
    JSON.stringify(settled.streams[0].durationImplicit));
  const y = serialize(settled);
  assert("media in ritardo \u2192 la chiave resta omessa", !/^[ \t]+duration:/m.test(y),
    y.slice(0, 400));
}

{
  // La lista sample va aggiornata insieme alle durate, o roundTripDiff
  // ri-parserebbe con la lista vuota e segnalerebbe divergenze inventate.
  const settled = resolveImplicitDurations(parse(durationYaml(null), { samples: [] }), SAMPLES);
  assert("media in ritardo \u2192 round-trip pulito", roundTripDiff(settled).length === 0,
    JSON.stringify(roundTripDiff(settled)));
}

{
  const data = parse(durationYaml("duration: 5"), { samples: [] });
  const settled = resolveImplicitDurations(data, SAMPLES);
  assert("duration esplicita \u2192 non toccata dalla risoluzione tardiva",
    settled.streams[0].duration === 5, JSON.stringify(settled.streams[0].duration));
}

{
  // Nessun cambiamento -> stesso oggetto: la risoluzione non deve produrre
  // render inutili ne' passi di undo quando i media si ricaricano.
  const data = parse(durationYaml(null), { samples: SAMPLES });
  assert("niente da risolvere \u2192 stesso oggetto",
    resolveImplicitDurations(data, data.samples) === data);
}

console.log("\n\u2500\u2500 cambio sample: la durata implicita segue (engine #205) \u2500\u2500");

const OTHER_SAMPLES = [{ name: "test.wav", duration: 2.5 }, { name: "lungo.wav", duration: 9 }];

{
  const data = parse(durationYaml(null), { samples: OTHER_SAMPLES });
  const moved = applyStreamPatch(data.streams[0], { sample: "lungo.wav" },
                                 { samples: OTHER_SAMPLES });
  assert("cambio sample \u2192 durata del nuovo sample", moved.duration === 9,
    JSON.stringify(moved.duration));
  assert("cambio sample \u2192 resta implicita", moved.durationImplicit === true,
    JSON.stringify(moved.durationImplicit));
}

{
  const data = parse(durationYaml("duration: 5"), { samples: OTHER_SAMPLES });
  const moved = applyStreamPatch(data.streams[0], { sample: "lungo.wav" },
                                 { samples: OTHER_SAMPLES });
  assert("cambio sample con duration esplicita \u2192 durata invariata",
    moved.duration === 5, JSON.stringify(moved.duration));
}

{
  const data = parse(durationYaml(null), { samples: OTHER_SAMPLES });
  const moved = applyStreamPatch(data.streams[0], { sample: "ignoto.wav" },
                                 { samples: OTHER_SAMPLES });
  assert("cambio verso un sample ignoto \u2192 marcato irrisolto",
    moved.durationUnresolved === true, JSON.stringify(moved.durationUnresolved));
}

/* ============================================================
 * Summary
 * ============================================================ */

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

/* ============================================================
 * SECTION — grain.read_direction (PGE #207)
 * ============================================================
 * Scalare O envelope, quindi campi paralleli come gli altri parametri —
 * a differenza di `reverse`, che è presence-keyed e non prende valore.
 * Il default è l'ASSENZA: con entrambe le chiavi assenti il motore usa la
 * modalità `auto`, in cui il verso segue il segno di pointer.speed_ratio.
 * Materializzare un +1 su uno stream che nessuno ha toccato ne cambierebbe
 * la resa, quindi l'assenza si preserva.
 * ============================================================ */

console.log("\n── grain.read_direction (PGE #207) ──");

function grainYaml(body) {
  return `streams:\n  - stream_id: s1\n    onset: 0\n    duration: 5\n    sample: test.wav\n    grain:\n${body}`;
}

{
  const data = parse(grainYaml("      read_direction: 1\n"));
  const g = data.streams[0].grain;
  assert("scalare +1 → readDirection", g.readDirection === 1, JSON.stringify(g));
  assert("scalare → nessun env", g.readDirectionEnv == null, JSON.stringify(g));
  assert("non finisce in _extra (è in GRAIN_KNOWN)",
    !(g._extra && "read_direction" in g._extra), JSON.stringify(g._extra));
  const y = serialize(data);
  assert("serialize scalare", /read_direction: 1/.test(y), y.slice(0, 400));
  assert("nessun type: step scritto (è implicito lato motore)",
    !/type:\s*step/.test(y), y.slice(0, 400));
  assert("roundtrip scalare — nessun diff", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  const data = parse(grainYaml("      read_direction: -1\n"));
  assert("scalare -1", data.streams[0].grain.readDirection === -1);
  assert("serialize -1", /read_direction: -1/.test(serialize(data)));
}

{
  const data = parse(grainYaml("      read_direction: [[0, 1], [12, -1]]\n"));
  const g = data.streams[0].grain;
  assert("envelope → readDirectionEnv", eq(g.readDirectionEnv, [[0, 1], [12, -1]]),
    JSON.stringify(g));
  assert("envelope → nessuno scalare", g.readDirection == null, JSON.stringify(g));
  const y = serialize(data);
  assert("serialize envelope", /read_direction:/.test(y), y.slice(0, 400));
  assert("envelope: ancora nessun type: step", !/type:\s*step/.test(y), y.slice(0, 400));
  assert("roundtrip envelope — nessun diff", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  // L'assenza è il terzo stato: modalità `auto` del motore.
  const data = parse(grainYaml("      duration: 0.05\n"));
  const g = data.streams[0].grain;
  assert("chiave assente → non nello stato",
    !("readDirection" in g) && !("readDirectionEnv" in g), JSON.stringify(g));
  assert("assente → non emessa (auto preservato)",
    !serialize(data).includes("read_direction"), serialize(data).slice(0, 400));
}

{
  // `read_direction:` vuota è un ERRORE del motore, non una modalità come
  // `reverse:`. Si tiene verbatim perché l'Inspector possa dirlo invece che
  // l'editor cancellare in silenzio quello che l'autore ha scritto.
  const data = parse(grainYaml("      read_direction:\n"));
  const g = data.streams[0].grain;
  assert("chiave vuota → presente e null", "readDirection" in g && g.readDirection === null,
    JSON.stringify(g));
  assert("chiave vuota → riemessa", /read_direction: null/.test(serialize(data)),
    serialize(data).slice(0, 400));
  assert("roundtrip chiave vuota — nessun diff", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  // Le due chiavi insieme sono un errore del motore, non una priorità: a
  // differenza di loop_end/loop_dur (dove il precedente vicino ne scarta una)
  // qui si tengono entrambe. Scartarne una nasconderebbe l'errore dell'autore
  // — l'Inspector lo segnala, e il controllo del verso lo risolve.
  const data = parse(grainYaml("      reverse:\n      read_direction: 1\n"));
  const g = data.streams[0].grain;
  assert("entrambe le chiavi restano nello stato",
    g.reverse === null && g.readDirection === 1, JSON.stringify(g));
  const y = serialize(data);
  assert("entrambe riemesse (l'errore resta visibile)",
    /reverse: null/.test(y) && /read_direction: 1/.test(y), y.slice(0, 400));
  assert("roundtrip conflitto — nessun diff", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  // Un ciclo compatto sopravvive come per gli altri envelope.
  const data = parse(grainYaml("      read_direction: [[[0, 1], [50, -1]], 2.0, 2]\n"));
  const g = data.streams[0].grain;
  // Il blocco compatto E' il valore, non un elemento di una lista che lo
  // contiene: unpackValueOrEnv lo instrada a env così com'è.
  assert("formato compatto → env", eq(g.readDirectionEnv, [[[0, 1], [50, -1]], 2, 2]),
    JSON.stringify(g.readDirectionEnv));
  assert("roundtrip compatto — nessun diff", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  // Il bound statico serve al clamp quando il bridge non è raggiungibile.
  assert("PGE_BOUNDS.readDirection è il fallback statico",
    window.PGE_BOUNDS.readDirection.min === -1 && window.PGE_BOUNDS.readDirection.max === 1,
    JSON.stringify(window.PGE_BOUNDS.readDirection));
}
