/* =============================================================================
 * test-stream-id.js — pins stream-id allocation (issue: stream identity).
 *
 * The id is not just a React key: it is the stem filename on disk
 * (<basename>__<id>.<ext>), the key of the engine's cache manifest and of the
 * browser's stem index. So a *recycled* id makes a brand-new stream inherit the
 * audio, waveform and render dot of a deleted one. Allocation must therefore
 * avoid ids that still own a stem, not just ids currently in the stream list.
 *
 * Run: node test-stream-id.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = { jsyaml: require("js-yaml") };
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));

const { allocStreamIds } = window.PGEYaml;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}

const streams = (n) => Array.from({ length: n }, (_, i) => ({ id: "stream" + (i + 1) }));

console.log("\n── an id that still owns a stem is never reused ──");
{
  // The user deleted stream5; its file is still in output/ and the engine's GC
  // will not remove it once the id is back in the YAML.
  const hasStem = (id) => id === "stream5";
  const [id] = allocStreamIds(streams(4), 1, hasStem);
  assert("skips the deleted stream's id", id !== "stream5", `got ${id}`);
  assert("skips the live ids too", !["stream1","stream2","stream3","stream4"].includes(id), `got ${id}`);
}

console.log("\n── a multi-stream paste gets distinct ids ──");
{
  const ids = allocStreamIds(streams(3), 3, () => false);
  assert("returns as many ids as asked", ids.length === 3, JSON.stringify(ids));
  assert("all distinct", new Set(ids).size === 3, JSON.stringify(ids));
  assert("none collides with a live stream", ids.every(i => !["stream1","stream2","stream3"].includes(i)), JSON.stringify(ids));
}

console.log("\n── app.jsx wiring (source guard) ──");
{
  const appSrc = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");
  assert("no inline \"stream\" + counter allocator survives",
         !/"stream"\s*\+\s*counter/.test(appSrc));
  const calls = appSrc.match(/allocStreamIds\([^)]*\)/g) || [];
  assert("both call sites (paste + create) go through allocStreamIds",
         calls.length === 2, JSON.stringify(calls));
  assert("both pass the stem oracle so a deleted id is not recycled",
         calls.every(c => /hasStem/.test(c)), JSON.stringify(calls));
}

console.log("\n── deleting a stream is undoable (source guard) ──");
{
  // setData pushes to the history stack, so Ctrl+Z restores data.streams. It
  // restores nothing else. Any collateral wipe deleteStream performs on state
  // undo cannot reach (lastRenderedFps, waveforms, grainData, the grain refs,
  // the backend stem index) survives the undo and leaves the resurrected stream
  // silent and marked "never rendered". With ids that no longer recycle, those
  // per-id entries are inert for every other stream, so the cure is to not wipe.
  const appSrc = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");
  const m = appSrc.match(/function deleteStream\(id\) \{[\s\S]*?\n  \}/);
  assert("deleteStream found in app.jsx", !!m);
  const body = m ? m[0] : "";
  for (const wipe of ["setLastRenderedFps", "setWaveforms", "setGrainData",
                      "grainLoadedRef", "grainRegenRef", "forgetStream",
                      "invalidateStream", "setStreamProgress"]) {
    assert(`does not wipe ${wipe} (undo could not restore it)`, !body.includes(wipe));
  }
  assert("still mutates through setData so the delete is undoable",
         /setData\(/.test(body));
}

console.log(`\n${"─".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
