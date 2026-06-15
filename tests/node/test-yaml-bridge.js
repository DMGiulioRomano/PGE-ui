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
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));

const { parse, serialize, serializeStream, parseStream, roundTripDiff, computeDuration } = window.PGEYaml;

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
 * SECTION 8c — dephase: implicit null vs absent vs explicit (#36)
 * ============================================================ */

console.log("\n── dephase (#36) ──");

const { DEPHASE_IMPLICIT } = window.PGEYaml;

{
  assert("DEPHASE_IMPLICIT exported", typeof DEPHASE_IMPLICIT === "string" && DEPHASE_IMPLICIT.length > 0,
    JSON.stringify(DEPHASE_IMPLICIT));
}

{
  // absent → off (no key emitted)
  const data = parse(topLevelYaml([]));
  assert("dephase absent — undefined in state", data.streams[0].dephase === undefined,
    JSON.stringify(data.streams[0].dephase));
  const y = serialize(data);
  assert("dephase absent — not emitted", !y.includes("dephase"), y.slice(0, 400));
}

{
  // explicit false → kept
  const data = parse(topLevelYaml(["dephase: false"]));
  assert("dephase false — kept in state", data.streams[0].dephase === false, JSON.stringify(data.streams[0].dephase));
  const y = serialize(data);
  assert("dephase false — emitted", /dephase: false/.test(y), y.slice(0, 400));
  assert("roundtrip dephase false — no diffs", roundTripDiff(data).length === 0, JSON.stringify(roundTripDiff(data)));
}

{
  // `dephase: null` (explicit) and `dephase:` (bare) both = implicit 1%
  for (const variant of ["dephase: null", "dephase:"]) {
    const data = parse(topLevelYaml([variant]));
    assert(`'${variant}' — sentinel in state`, data.streams[0].dephase === DEPHASE_IMPLICIT,
      JSON.stringify(data.streams[0].dephase));
    const y = serialize(data);
    assert(`'${variant}' — re-emitted as dephase: null`, /^\s*dephase: null$/m.test(y), y.slice(0, 500));
    assert(`'${variant}' — roundtrip no diffs`, roundTripDiff(data).length === 0,
      JSON.stringify(roundTripDiff(data)));
  }
}

{
  // global scalar and envelope forms unchanged
  const dataN = parse(topLevelYaml(["dephase: 50"]));
  assert("dephase scalar — kept", dataN.streams[0].dephase === 50, JSON.stringify(dataN.streams[0].dephase));
  assert("roundtrip dephase scalar — no diffs", roundTripDiff(dataN).length === 0,
    JSON.stringify(roundTripDiff(dataN)));
  const dataE = parse(topLevelYaml(["dephase: [[0, 0], [30, 80]]"]));
  assert("dephase env — kept", Array.isArray(dataE.streams[0].dephase) && dataE.streams[0].dephase.length === 2,
    JSON.stringify(dataE.streams[0].dephase));
  assert("roundtrip dephase env — no diffs", roundTripDiff(dataE).length === 0,
    JSON.stringify(roundTripDiff(dataE)));
}

{
  // per-param object: passes verbatim; an INTERNAL null (per-key default
  // prob) stays null, it must NOT become the sentinel.
  const yamlPP = `streams:
  - stream_id: s1
    onset: 0
    duration: 5
    sample: test.wav
    dephase:
      pitch: 50
      reverse:
`;
  const data = parse(yamlPP);
  const d = data.streams[0].dephase;
  assert("dephase per-param — object kept", d && typeof d === "object" && !Array.isArray(d), JSON.stringify(d));
  assert("dephase per-param — pitch 50", d.pitch === 50, JSON.stringify(d));
  assert("dephase per-param — internal null stays null", d.reverse === null, JSON.stringify(d));
  const y = serialize(data);
  assert("dephase per-param — reverse: null re-emitted", /reverse: null/.test(y), y.slice(0, 500));
  assert("roundtrip dephase per-param — no diffs", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)));
}

{
  // UI→YAML→UI starting from sentinel state (e.g. set via Inspector)
  const data = parse(topLevelYaml([]));
  data.streams[0].dephase = DEPHASE_IMPLICIT;
  const back = parse(serialize(data));
  assert("sentinel state survives UI→YAML→UI", back.streams[0].dephase === DEPHASE_IMPLICIT,
    JSON.stringify(back.streams[0].dephase));
}

const dephaseFixtures = ["PGE_detune_implicito_test.yml", "PGE_test.yml", "PGE_pino2.yml"];
for (const f of dephaseFixtures) {
  const p = path.join(__dirname, "../../..", "PythonGranularEngine/configs", f);
  if (!fs.existsSync(p)) { console.log(`  SKIP dephase fixture ${f} (not found)`); continue; }
  const data = parse(fs.readFileSync(p, "utf8"));
  const flags = data.streams.map(s => s.dephase !== undefined);
  const back = parse(serialize(data));
  const backFlags = back.streams.map(s => s.dephase !== undefined);
  assert(`${f} — dephase presence stable through reparse`, eq(flags, backFlags),
    JSON.stringify({ before: flags, after: backFlags }));
  assert(`${f} — dephase values stable through reparse`,
    eq(data.streams.map(s => s.dephase), back.streams.map(s => s.dephase)),
    JSON.stringify({ before: data.streams.map(s => s.dephase), after: back.streams.map(s => s.dephase) }));
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
 * SECTION 8f — explicit *_range: 0 is preserved (#50). Engine-side an explicit
 * range (even 0) sets has_explicit_range and DISABLES the implicit jitter the
 * dephase gate would otherwise apply (parameter.py _calculate_range: _mod_range
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
  // dephase modes survive the per-stream round trip (implicit / false / number).
  for (const dep of ["dephase:", "dephase: false", "dephase: 0.2"]) {
    const s = streamOf(topLevelYaml([dep]));
    const back = parseStream(serializeStream(s));
    assert(`#42 dephase round trip — "${dep}"`, eq(stripColor(s), stripColor(back)),
      JSON.stringify({ before: s.dephase, after: back.dephase }));
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
        strategy: random
    dephase: [[0, 100], [0.4047, 100], [1, 1]]
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
  assert("inline — dephase inline",            /^\s*dephase: \[\[0, 100\], /m.test(y),         y);

  // Per-point interp triple preserved inside the inline list.
  assert("inline — per-point interp kept inline", /\[0\.1262, 208\.37, cubic\]/.test(y), y.slice(0, 700));

  // Dict-form envelopes: wrapper keeps block style, the points list goes inline.
  assert("inline — distribution keeps 'type: cubic' block key", /^\s*type: cubic$/m.test(y),      y);
  assert("inline — distribution points inline",                 /^\s*points: \[\[0, 0\], /m.test(y), y);
  assert("inline — num_voices keeps 'type: step'",              /^\s*type: step$/m.test(y),       y);
  assert("inline — num_voices points inline",                   /^\s*points: \[\[0, 1\], /m.test(y), y);
  assert("inline — voices.pan keeps 'strategy: random'",        /^\s*strategy: random$/m.test(y), y);
  assert("inline — voices.pan spread inline",                   /^\s*spread: \[\[0, 60\], /m.test(y), y);

  // Grain multistate envelope: states and curve both inline.
  assert("inline — grain.envelope states inline", /^\s*states: \[\[0, hanning\], /m.test(y), y);
  assert("inline — grain.envelope curve inline",  /^\s*curve: \[\[0, 0\], /m.test(y),        y);

  // Formatting only: round trip stays lossless.
  assert("inline — envelope-heavy round trip lossless", roundTripDiff(data).length === 0,
    JSON.stringify(roundTripDiff(data)).slice(0, 600));
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
 * Summary
 * ============================================================ */

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
