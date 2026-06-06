/* =============================================================================
 * test-yaml-bridge.js — test suite for yaml-bridge.js pitch unit alignment
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
 * Summary
 * ============================================================ */

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
