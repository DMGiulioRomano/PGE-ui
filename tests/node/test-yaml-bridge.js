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

const { parse, serialize, roundTripDiff, computeDuration } = window.PGEYaml;

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
    let back;
    try {
      back = parse(serialize(data));
    } catch (e) {
      assert(`corpus ${f} — reparse`, false, e.message);
      continue;
    }
    assert(`corpus ${f} — stream count stable`, back.streams.length === data.streams.length,
      `${data.streams.length} → ${back.streams.length}`);
  }
} else {
  console.log("  SKIP corpus (engine configs dir not found)");
}

/* ============================================================
 * SECTION 10 — YamlEditor inline view (buildLines) parity with serialize (#51)
 *
 * YamlEditor.jsx ships a second YAML emitter (buildLines) + inline parser
 * (parseYaml) for the per-stream text editor, previously untested and diverging
 * from yaml-bridge.serialize: loop keys were gated on loop_start, and loop_unit
 * / per-block _extra were never re-emitted. We load the JSX-free helpers
 * (everything above the node-test boundary in YamlEditor.jsx) and check parity
 * on the same streams that the bridge parses.
 * ============================================================ */

console.log("\n── YamlEditor.buildLines parity (#51) ──");

global.React = {};                                    // satisfies `const {…} = React`
eval(fs.readFileSync(path.join(__dirname, "../../envelope-loops.js"), "utf8")); // window.PGEEnv
const yeSrc = fs.readFileSync(path.join(__dirname, "../../YamlEditor.jsx"), "utf8");
eval(yeSrc.split("/* ==== node-test boundary")[0]);   // only the JSX-free head
// Read the helpers off window.PGE. (The direct eval above also leaks the
// `function buildLines`/`linesToText`/`parseYaml` declarations into this scope;
// we deliberately don't re-declare them with const to avoid a clash.)
const _ye = window.PGE;
const parseInline = _ye.parseYaml;

const inlineText = (stream, rec) => _ye.linesToText(_ye.buildLines(stream, rec));
const streamOf   = (yamlText) => parse(yamlText).streams[0];

assert("#51 helpers loaded", typeof _ye.buildLines === "function" && typeof parseInline === "function",
  JSON.stringify(Object.keys(_ye || {})));

{
  // loop_dur + loop_unit WITHOUT loop_start — pre-fix both were swallowed by
  // the `if (loopStart != null …)` gate.
  const s = streamOf(pointerYaml(["loop_dur: 0.4", "loop_unit: normalized"]));
  assert("#51 setup — loop without loop_start", s.pointer.loopStart == null && !s.pointer.loopStartEnv,
    JSON.stringify(s.pointer));
  const t = inlineText(s);
  assert("#51 buildLines — loop_dur emitted without loop_start", /^\s*loop_dur:/m.test(t), t);
  assert("#51 buildLines — loop_unit emitted without loop_start", /loop_unit: normalized/.test(t), t);
}

{
  // loop_end WITHOUT loop_start; loop_end wins over loop_dur (exclusive group).
  const s = streamOf(pointerYaml(["loop_end: 2.5"]));
  const t = inlineText(s);
  assert("#51 buildLines — loop_end emitted without loop_start", /^\s*loop_end:/m.test(t), t);
  assert("#51 buildLines — loop_dur not emitted alongside loop_end", !/^\s*loop_dur:/m.test(t), t);
}

{
  // Regression: full loop with loop_start still emits everything.
  const s = streamOf(pointerYaml(["loop_start: 0.2", "loop_dur: 0.4", "loop_unit: normalized"]));
  const t = inlineText(s);
  assert("#51 buildLines — loop_start kept", /^\s*loop_start:/m.test(t), t);
  assert("#51 buildLines — loop_dur kept", /^\s*loop_dur:/m.test(t), t);
  assert("#51 buildLines — loop_unit kept", /loop_unit: normalized/.test(t), t);
}

{
  // Per-block _extra re-emitted (pointer/grain/pitch/voices).
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
  const s = parse(yamlExtras).streams[0];
  const t = inlineText(s);
  for (const frag of ["futuro_param: 7", "xkey: 1", "glide: 3", "nuova: 4"]) {
    assert(`#51 buildLines — block extra re-emitted: ${frag}`, t.includes(frag), t);
  }
}

{
  // Top-level (stream-level) _extra re-emitted.
  const s = parse(topLevelYaml(["mio_extra: 9"])).streams[0];
  assert("#51 setup — top-level extra captured", s._extra && s._extra.mio_extra === 9, JSON.stringify(s._extra));
  const t = inlineText(s);
  assert("#51 buildLines — top-level extra re-emitted", /^mio_extra: 9$/m.test(t), t);
}

{
  // Structural parity with serialize, scoped to the pointer loop keys + _extra
  // (buildLines legitimately differs on start/volume/etc., so we don't deep-eq
  // the whole stream).
  const s = streamOf(pointerYaml(["loop_dur: 0.4", "loop_unit: normalized", "futuro: 5"]));
  const inlinePtr = (window.jsyaml.load(inlineText(s)) || {}).pointer || {};
  const canonObj  = window.jsyaml.load(serialize({ streams: [s], title: "", duration: 60, bpm: 120 }));
  const canonPtr  = (canonObj.streams[0] || {}).pointer || {};
  for (const k of ["loop_start", "loop_end", "loop_dur", "loop_unit", "futuro"]) {
    assert(`#51 parity pointer.${k}`, eq(inlinePtr[k], canonPtr[k]),
      JSON.stringify({ inline: inlinePtr[k], canon: canonPtr[k] }));
  }
}

{
  // The inline parser reads back what the (fixed) inline emitter writes.
  const s = streamOf(pointerYaml(["loop_dur: 0.4", "loop_unit: normalized"]));
  const reparsed = parseInline(inlineText(s));
  assert("#51 parseInline — loop_unit read back", reparsed.pointer.loopUnit === "normalized",
    JSON.stringify(reparsed.pointer));
  assert("#51 parseInline — loop_dur read back", reparsed.pointer.loopDur === 0.4,
    JSON.stringify(reparsed.pointer));
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
 * Summary
 * ============================================================ */

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
