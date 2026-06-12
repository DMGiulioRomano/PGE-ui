/* =============================================================================
 * test-yaml-bridge.js — test suite for yaml-bridge.js round-trip fidelity
 * (pitch units, pointer loop keys, fill_factor, per-block extras, time_mode,
 * dephase) — YAML→editor→YAML and editor→YAML→editor.
 *
 * Run: node test-yaml-bridge.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

// Shim: provide window.jsyaml so yaml-bridge.js can load without a browser.
global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../yaml-bridge.js"), "utf8"));

const { parse, serialize, roundTripDiff } = window.PGEYaml;

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
 * Summary
 * ============================================================ */

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
