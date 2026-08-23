/* =============================================================================
 * test-tracks.js — pins the track model (issue #141: a lane holds N streams).
 *
 * Three properties carry the whole design, and each has a way of quietly
 * breaking:
 *
 *  1. The grouping must never reach the stem fingerprint. It lives in a
 *     TOP-LEVEL key (`ui_tracks` in `data._extra`), so `applyTracks` must not
 *     touch a stream object — a single rewritten stream would mark its stem
 *     stale and force a re-render that changes no sample.
 *  2. `deriveTracks` must be total. It is fed hand-edited YAML: unknown ids,
 *     a stream listed twice, a stream listed nowhere. A stream that falls out
 *     of the layout disappears from the timeline while still rendering.
 *  3. The key must not appear until it says something. A project that never
 *     groups anything must round-trip byte-identical to before tracks existed.
 *
 * Run: node test-tracks.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

global.window = {};
eval(fs.readFileSync(path.join(__dirname, "../../src/lib/tracks.js"), "utf8"));

const T = window.PGETracks;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const data = (ids, uiTracks) => ({
  project: "p",
  streams: ids.map(id => ({ id, onset: 0, duration: 1 })),
  ...(uiTracks ? { _extra: { ui_tracks: uiTracks } } : {}),
});
const shape = (tracks) => tracks.map(t => [t.id, t.name, t.streamIds.join("+")].join(":"));

console.log("\n── no ui_tracks: one lane per stream, in file order (today's behaviour) ──");
{
  const tr = T.deriveTracks(data(["stream1", "stream2", "stream3"]));
  assert("one track per stream", tr.length === 3, JSON.stringify(shape(tr)));
  assert("id and name are the stream id — laneHeights keys keep applying",
         eq(shape(tr), ["stream1:stream1:stream1", "stream2:stream2:stream2", "stream3:stream3:stream3"]),
         JSON.stringify(shape(tr)));
  assert("the layout is trivial", T.isTrivial(tr) === true);
  const out = T.applyTracks(data(["stream1", "stream2", "stream3"]), tr);
  assert("applyTracks writes no ui_tracks for a trivial layout",
         out._extra === undefined, JSON.stringify(out._extra));
}

console.log("\n── an explicit grouping is read back in order ──");
{
  const d = data(["stream1", "stream2", "stream3", "stream4"], [
    { id: "t1", name: "bassi", streams: ["stream1", "stream4"] },
    { id: "t2", name: "texture", streams: ["stream2", "stream3"] },
  ]);
  const tr = T.deriveTracks(d);
  assert("two lanes", eq(shape(tr), ["t1:bassi:stream1+stream4", "t2:texture:stream2+stream3"]),
         JSON.stringify(shape(tr)));
  assert("not trivial", T.isTrivial(tr) === false);
  assert("visual order flattens the lanes",
         eq(T.visualOrder(tr), ["stream1", "stream4", "stream2", "stream3"]));
}

console.log("\n── deriveTracks is total against a hand-edited file ──");
{
  // ui_tracks names a stream that no longer exists, repeats one, and forgets
  // another entirely.
  const d = data(["stream1", "stream2", "stream3"], [
    { id: "t1", name: "a", streams: ["stream1", "ghost", "stream1"] },
    { id: "t2", name: "b", streams: ["stream1"] },   // already placed → empties → dropped
  ]);
  const tr = T.deriveTracks(d);
  assert("the dead id is dropped", !T.visualOrder(tr).includes("ghost"), JSON.stringify(shape(tr)));
  assert("a stream is placed exactly once",
         T.visualOrder(tr).length === new Set(T.visualOrder(tr)).size, JSON.stringify(shape(tr)));
  assert("a track emptied by the dedupe disappears",
         !tr.some(t => t.id === "t2"), JSON.stringify(shape(tr)));
  assert("the unmentioned streams get their own lanes, in file order",
         eq(T.visualOrder(tr), ["stream1", "stream2", "stream3"]), JSON.stringify(shape(tr)));
  assert("every live stream is laid out",
         eq(new Set(T.visualOrder(tr)), new Set(["stream1", "stream2", "stream3"])));
}

console.log("\n── a non-string stream id must not lose the grouping ──");
{
  // `stream_id: 1` unquoted in YAML parses as a NUMBER. `parse` now coerces it,
  // but this lib is fed hand-built data too, and a number on one side against
  // its string on the other matches nothing — the group would vanish without a
  // word, and the next save would erase the key for good.
  const d = {
    streams: [{ id: 1 }, { id: 2 }],
    _extra: { ui_tracks: [{ id: "t1", name: "gruppo", streams: [1, 2] }] },
  };
  const tr = T.deriveTracks(d);
  assert("the grouping survives numeric ids", eq(shape(tr), ["t1:gruppo:1+2"]), JSON.stringify(shape(tr)));
  const out = T.applyTracks(d, tr);
  assert("applyTracks still finds the streams to order",
         out.streams.length === 2 && eq(out.streams.map(s => s.id), [1, 2]),
         JSON.stringify(out.streams));
  assert("and writes the ids as strings",
         eq(out._extra.ui_tracks[0].streams, ["1", "2"]), JSON.stringify(out._extra));
}

console.log("\n── parse coerces the stream id to a string ──");
{
  global.window.jsyaml = require("js-yaml");
  eval(fs.readFileSync(path.join(__dirname, "../../src/lib/yaml-bridge.js"), "utf8"));
  const parsed = window.PGEYaml.parse("streams:\n  - stream_id: 1\n    onset: 0\n    duration: 5\n    sample: t.wav\n");
  assert("an unquoted numeric stream_id becomes a string",
         parsed.streams[0].id === "1", JSON.stringify(parsed.streams[0].id));
}

console.log("\n── colliding ids never merge two lanes ──");
{
  // A hand-written track id that shadows a stream id: both are laneHeights keys
  // and React keys, so the collision must be broken, not tolerated.
  const d = data(["stream1", "stream2"], [
    { id: "stream2", name: "shadow", streams: ["stream1"] },
  ]);
  const tr = T.deriveTracks(d);
  assert("two distinct lanes survive", tr.length === 2, JSON.stringify(shape(tr)));
  assert("their ids are distinct", tr[0].id !== tr[1].id, JSON.stringify(shape(tr)));
  const fresh = T.newTrackId(tr);
  assert("a fresh id collides with neither a track id nor a stream id",
         !tr.some(t => t.id === fresh || t.streamIds.includes(fresh)), fresh);
}

console.log("\n── applyTracks never rewrites a stream (the fingerprint stays put) ──");
{
  const d = data(["stream1", "stream2"]);
  const before = d.streams.map(s => s);
  const tr = T.moveStreams(T.deriveTracks(d), ["stream2"], 0);
  const out = T.applyTracks(d, tr);
  assert("grouping puts both streams on one lane", tr.length === 1, JSON.stringify(shape(tr)));
  assert("stream objects are the SAME references — nothing to re-hash",
         out.streams.every(s => before.includes(s)), "a stream object was rebuilt");
  assert("no stream gained a track key",
         out.streams.every(s => !("track" in s) && !("ui_track" in s)));
  assert("the grouping is written top-level",
         eq(out._extra.ui_tracks, [{ id: "stream1", name: "stream1", streams: ["stream1", "stream2"] }]),
         JSON.stringify(out._extra));
}

console.log("\n── applyTracks reorders data.streams into visual order ──");
{
  const d = data(["stream1", "stream2", "stream3"]);
  const tr = T.reorderTracks(T.deriveTracks(d), 2, 0);
  const out = T.applyTracks(d, tr);
  assert("streams follow the lanes",
         eq(out.streams.map(s => s.id), ["stream3", "stream1", "stream2"]),
         JSON.stringify(out.streams.map(s => s.id)));
  assert("a pure reorder still writes no ui_tracks", out._extra === undefined);
  assert("input untouched", eq(d.streams.map(s => s.id), ["stream1", "stream2", "stream3"]));
}

console.log("\n── group then ungroup returns the file to where it started ──");
{
  const d = data(["stream1", "stream2"]);
  const grouped = T.moveStreams(T.deriveTracks(d), ["stream2"], 0);
  assert("grouped writes the key", T.applyTracks(d, grouped)._extra !== undefined);
  // The lane a lone clip lands in reclaims its stream id, so the layout is
  // trivial again — a `t1` here would keep the key alive saying nothing.
  const split = T.moveStreams(grouped, ["stream2"], 1, { extract: true });
  assert("two lanes again", split.length === 2, JSON.stringify(shape(split)));
  assert("the layout is trivial once more", T.isTrivial(split) === true, JSON.stringify(shape(split)));
  const out = T.applyTracks(d, split);
  assert("_extra is gone entirely, not left as an empty object",
         out._extra === undefined, JSON.stringify(out._extra));
}

console.log("\n── a NAMED lane survives losing a clip ──");
{
  // The name is the user's, not a by-product of the grouping: emptying the lane
  // down to one clip must not silently discard it.
  const d = data(["stream1", "stream2"], [
    { id: "t1", name: "bassi", streams: ["stream1", "stream2"] },
  ]);
  const split = T.moveStreams(T.deriveTracks(d), ["stream2"], 1, { extract: true });
  assert("the named lane keeps its name", eq(shape(split)[0], "t1:bassi:stream1"),
         JSON.stringify(shape(split)));
  assert("so the key stays — it still says something",
         T.applyTracks(d, split)._extra !== undefined);
}

console.log("\n── _extra keys that are not ours survive both directions ──");
{
  const d = data(["stream1"]);
  d._extra = { some_other_key: { keep: 1 } };
  const out = T.applyTracks(d, T.deriveTracks(d));
  assert("a foreign extra is preserved when ui_tracks is dropped",
         eq(out._extra, { some_other_key: { keep: 1 } }), JSON.stringify(out._extra));
}

console.log("\n── moving a clip between lanes ──");
{
  const d = data(["stream1", "stream2", "stream3"]);
  const tr = T.deriveTracks(d);
  const joined = T.moveStreams(tr, ["stream3"], 0);
  assert("the clip joins the target lane",
         eq(shape(joined), ["stream1:stream1:stream1+stream3", "stream2:stream2:stream2"]),
         JSON.stringify(shape(joined)));
  assert("the emptied source lane is pruned", joined.length === 2);

  const back = T.moveStreams(joined, ["stream3"], 1, { extract: true });
  assert("extract inserts a new lane at the drop position",
         eq(T.visualOrder(back), ["stream1", "stream3", "stream2"]),
         JSON.stringify(shape(back)));

  const noop = T.moveStreams(tr, ["stream1"], 0);
  assert("dropping a lone clip back on its own lane is a no-op (no history churn)",
         noop === tr);
  assert("...and so is extracting a clip that is already alone there",
         T.moveStreams(tr, ["stream1"], 0, { extract: true }) === tr);

  const multi = T.moveStreams(tr, ["stream2", "stream3"], 0);
  assert("a multi-selection moves together",
         eq(shape(multi), ["stream1:stream1:stream1+stream2+stream3"]),
         JSON.stringify(shape(multi)));

  // The gesture the old `dstLane !== srcLane` guard in Timeline.jsx swallowed:
  // a selection spanning lanes, dropped on the grabbed clip's OWN lane. Only
  // the target's contents can tell "gather them here" from a real no-op.
  const gather = T.moveStreams(tr, ["stream1", "stream3"], 0);
  assert("a cross-lane selection dropped on the grabbed clip's lane gathers it",
         eq(shape(gather), ["stream1:stream1:stream1+stream3", "stream2:stream2:stream2"]),
         JSON.stringify(shape(gather)));
}

console.log("\n── paste lands in the original's lane ──");
{
  const tr = T.deriveTracks(data(["stream1", "stream2"], [
    { id: "t1", name: "bassi", streams: ["stream1", "stream2"] },
  ]));
  const after = T.addStreamToTrackOf(tr, "stream2", "stream3");
  assert("the copy joins the source's lane, no new lane appears",
         eq(shape(after), ["t1:bassi:stream1+stream2+stream3"]), JSON.stringify(shape(after)));
  const orphan = T.addStreamToTrackOf(tr, "gone", "stream4");
  assert("an unknown source falls back to a lane of its own",
         orphan.length === 2 && eq(orphan[1].streamIds, ["stream4"]), JSON.stringify(shape(orphan)));
  assert("...and the original lane is untouched",
         eq(shape(orphan)[0], "t1:bassi:stream1+stream2"), JSON.stringify(shape(orphan)));
}

console.log("\n── delete prunes the lane it empties ──");
{
  const tr = T.deriveTracks(data(["stream1", "stream2", "stream3"], [
    { id: "t1", name: "bassi", streams: ["stream1", "stream2"] },
  ]));
  const after = T.removeStreams(tr, ["stream3"]);
  assert("the singleton lane goes", eq(shape(after), ["t1:bassi:stream1+stream2"]), JSON.stringify(shape(after)));
  const gutted = T.removeStreams(tr, ["stream1", "stream2"]);
  assert("a lane that loses every stream goes too",
         eq(shape(gutted), ["stream3:stream3:stream3"]), JSON.stringify(shape(gutted)));
}

console.log("\n── a new stream gets its own lane at the drop index ──");
{
  const tr = T.deriveTracks(data(["stream1", "stream2"]));
  const after = T.insertStreamTrack(tr, "stream3", 1);
  assert("inserted between the two", eq(T.visualOrder(after), ["stream1", "stream3", "stream2"]),
         JSON.stringify(shape(after)));
  assert("its lane id is its stream id while that is free",
         after[1].id === "stream3", JSON.stringify(shape(after)));
  assert("the layout stays trivial, so no key is written",
         T.isTrivial(after) === true);
}

console.log("\n── UI wiring (source guards) ──");
{
  const tlSrc  = fs.readFileSync(path.join(__dirname, "../../src/components/Timeline.jsx"), "utf8");
  // Guards that assert the ABSENCE of a pattern read the code with comments
  // stripped: a comment explaining why the pattern is gone would otherwise
  // keep the guard red forever.
  const tlCode = tlSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const appSrc = fs.readFileSync(path.join(__dirname, "../../src/components/app.jsx"), "utf8");

  // The defect the track layer removes: onReorder was called from inside a
  // setDragOver updater. React may replay an updater, applying the move twice.
  assert("no side effect survives inside a setDragOver updater",
         !/setDragOver\(\s*\((\w+)\)\s*=>\s*\{[\s\S]{0,200}?on(Reorder|TrackReorder)/.test(tlCode));

  // The drop must not be skipped on `srcLane`: that is the lane of the GRABBED
  // clip, and a selection spanning lanes dropped there is a real move.
  assert("the clip drop does not second-guess moveStreams on the source lane",
         !/dstLane !== srcLane/.test(tlCode));
  // Alt is sampled during the drag, so the highlight and the outcome agree.
  assert("the extract modifier is read while dragging, not at release",
         /extractRef\.current = !!ev\.altKey/.test(tlCode) &&
         !/extract: !!\(ev && ev\.altKey\)/.test(tlCode));
  assert("and a pending extract is drawn differently from a join",
         /drop-extract/.test(tlSrc) &&
         /drop-extract/.test(fs.readFileSync(path.join(__dirname, "../../styles/editor.css"), "utf8")));

  // The two parallel maps that made lane i == stream i: heads and lanes are
  // now driven by the track list, and neither may be keyed on a stream again.
  assert("the header column is rendered per track",
         /laneTracks\.map\(\(t, i\) =>\s*\n?\s*<TrackHeader/.test(tlSrc));
  assert("the lane column is rendered per track",
         /laneTracks\.map\(\(t, i\) => \{/.test(tlSrc));
  assert("no TrackHeader is keyed on a stream any more", !/<TrackHeader key=\{s\.id\}/.test(tlCode));
  assert("a lane draws every clip it holds", /laneStreams\[i\]\.map\(/.test(tlSrc));

  // laneHeights must key on the track, not the stream.
  assert("lane heights are keyed by track", /getH\(t\.id\)/.test(tlSrc));
  assert("the lane resize handle writes the track's height, not a stream's",
         !/startResizeLane\(e, s\.id\)/.test(tlCode));

  assert("app.jsx derives tracks from the model, not from streams",
         /window\.PGETracks/.test(appSrc) && /\bTR\.deriveTracks\(/.test(appSrc));
  assert("app.jsx writes them back through applyTracks",
         /\bTR\.applyTracks\(/.test(appSrc));
  assert("paste routes through addStreamToTrackOf",
         /addStreamToTrackOf/.test(appSrc));
  assert("the header VU is fed the whole group",
         /analysersFor/.test(appSrc) && /analysersFor/.test(tlSrc));
  assert("the group VU never re-reads a single trackAnalyser per lane",
         !/analyserFor=/.test(appSrc));
  assert("tracks.js is loaded before the components that use it",
         (() => {
           const html = fs.readFileSync(path.join(__dirname, "../../PGE Editor.html"), "utf8");
           return html.indexOf("src/lib/tracks.js") !== -1 &&
                  html.indexOf("src/lib/tracks.js") < html.indexOf("src/components/Timeline.jsx");
         })());
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
