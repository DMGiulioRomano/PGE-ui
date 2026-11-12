/* =============================================================================
 * test-expressions.js — il terzo tipo di valore e i modi nuovi delle mappe
 * caotiche (PGE-ui #215, #216; PGE #307).
 *
 * Il motore accetta un'ESPRESSIONE fra parentesi (`(0.02 + 0.08*m1)`) dove
 * stavano un numero o un envelope, sul valore base di quindici campi; e due
 * chiavi nuove: `grain.iot` (il terzo modo della densita') e
 * `pointer.position` (la posizione di lettura scritta). Qui si guarda che
 * l'editor non li perda e non li corrompa:
 *
 *   - window.PGEExpr: cosa e' un'espressione, come si scala, come si semina;
 *   - yaml-bridge: grain.iot e pointer.position fanno il giro, presence-keyed;
 *   - convertGrainDurationUnit: un'espressione si scala nel testo, iot si
 *     converte come la durata;
 *   - la camminata del tempo e il catalogo: iotEnv, positionEnv, e gli
 *     envelope di `r` e `clock` delle mappe;
 *   - la guardia di ParamRow: il click sul bottone acceso non cancella
 *     un'espressione.
 *
 * Run: node test-expressions.js (from tests/node/ after npm install)
 * =========================================================================== */

const fs   = require("fs");
const path = require("path");

const LIB = (f) => path.join(__dirname, "../../src/lib/", f);
global.window = { jsyaml: require("js-yaml") };
for (const f of ["yaml-bridge.js", "expressions.js", "envelope-loops.js",
                 "deviation-probability.js", "envelope-utils.js", "envelope-catalog.js"]) {
  eval(fs.readFileSync(LIB(f), "utf8"));
}
const X  = window.PGEExpr;
const Y  = window.PGEYaml;
const EU = window.PGEEnvUtils;
const C  = window.PGEEnvCatalog;

let pass = 0, fail = 0;
function assert(label, cond, extra) {
  if (cond) { pass++; console.log("  OK  " + label); }
  else { fail++; console.error("FAIL  " + label + (extra ? "\n      " + extra : "")); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

process.on("exit", (code) => {
  console.log("\n" + "─".repeat(50));
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});

console.log("\n── PGEExpr ──");
assert("fra parentesi esterne", X.isExpression("(0.02 + 0.08*m1)"));
assert("(a) + (b) non e' fra parentesi esterne", !X.isExpression("(a) + (b)"));
assert("un numero non e' un'espressione", !X.isExpression(0.5));
assert("una parola non e' un'espressione", !X.isExpression("forte"));
assert("gli spazi ai bordi non contano", X.isExpression("  (m1)  "));
assert("scalare il testo lo tiene un'espressione",
  X.scaleExpression("(0.02 + 0.08*m1)", 1000) === "((0.02 + 0.08*m1) * 1000)"
  && X.isExpression(X.scaleExpression("(m1)", 0.001)));
assert("il fattore 1 lascia il testo com'era", X.scaleExpression("(m1)", 1) === "(m1)");
assert("il seme e' il numero fra parentesi", X.seedExpression(0.05) === "(0.05)"
  && X.seedExpression("—", 0) === "(0)");
assert("i quindici campi del motore", X.EXPRESSION_FIELDS.length === 15
  && X.EXPRESSION_FIELDS.includes("grain.iot") && X.EXPRESSION_FIELDS.includes("pointer.position"));

console.log("\n── yaml-bridge: grain.iot e pointer.position ──");
const doc = (body) => "streams:\n  - stream_id: s1\n    sample: x.wav\n    duration: 4\n" + body;
const roundTrip = (body) => {
  const d = Y.parse(doc(body), { samples: [] });
  const back = Y.parse(Y.serialize(d), { samples: [] });
  return { d, s: d.streams[0], back: back.streams[0], text: Y.serialize(d) };
};
{
  const r = roundTrip("    maps:\n      m1: {type: logistic, r: 3.5}\n    grain:\n      iot: (0.020 + 0.180*m1)\n");
  assert("grain.iot espressione: nel campo scalare, come stringa",
    r.s.grain.iot === "(0.020 + 0.180*m1)" && r.s.grain.iotEnv === null);
  assert("…e torna identica", r.back.grain.iot === "(0.020 + 0.180*m1)");
  assert("maps resta nello _extra dello stream", eq(r.back._extra.maps, { m1: { type: "logistic", r: 3.5 } }));
  assert("iot non e' piu' una chiave sconosciuta", !(r.s.grain._extra && "iot" in r.s.grain._extra));
}
{
  const r = roundTrip("    grain:\n      iot: [[0, 0.1], [4, 0.02]]\n");
  assert("grain.iot envelope", eq(r.s.grain.iotEnv, [[0, 0.1], [4, 0.02]]) && r.s.grain.iot === null);
  assert("…e torna envelope", eq(r.back.grain.iotEnv, [[0, 0.1], [4, 0.02]]));
}
{
  const r = roundTrip("    grain:\n      iot:\n");
  assert("grain.iot vuota resta scritta (e' il modo scelto senza valore)",
    "iot" in r.s.grain && /iot: null/.test(r.text), r.text);
}
{
  const r = roundTrip("    pointer:\n      position: 1.25\n");
  assert("pointer.position fuori da 0-1 resta com'e' (avvolge)", r.back.pointer.position === 1.25);
}
{
  const r = roundTrip("    pointer:\n      position: [[0, 0], [4, 3]]\n");
  assert("pointer.position envelope", eq(r.back.pointer.positionEnv, [[0, 0], [4, 3]]));
}
{
  const r = roundTrip("    maps:\n      m1: {type: logistic, r: 3.5}\n    volume: (-18 + 4*m1)\n    pan: (100*m1)\n    pointer:\n      position: (m1)\n");
  assert("le espressioni dei campi fanno il giro intatte",
    r.back.volume === "(-18 + 4*m1)" && r.back.pan === "(100*m1)" && r.back.pointer.position === "(m1)");
}
{
  const r = roundTrip("    density: 20\n");
  assert("senza le chiavi nuove niente cambia", !/iot|position/.test(r.text));
}

console.log("\n── convertGrainDurationUnit ──");
{
  const g = EU.convertGrainDurationUnit({ duration: "(0.02 + 0.08*m1)" }, "milliseconds", {});
  assert("un'espressione si scala nel testo (il fattore va sul risultato)",
    g.duration === "((0.02 + 0.08*m1) * 1000)" && g.durationUnit === "milliseconds", JSON.stringify(g));
  const back = EU.convertGrainDurationUnit(g, "seconds", {});
  assert("…e tornando si scala di nuovo", back.duration === "(((0.02 + 0.08*m1) * 1000) * 0.001)"
    && !("durationUnit" in back), JSON.stringify(back));
}
{
  const g = EU.convertGrainDurationUnit({ duration: 0.05, iot: 0.1, iotEnv: null }, "milliseconds", {});
  assert("grain.iot si converte come la durata", g.iot === 100 && g.duration === 50, JSON.stringify(g));
  const e = EU.convertGrainDurationUnit({ duration: 0.05, iot: null, iotEnv: [[0, 0.1], [1, 0.2]] }, "milliseconds", {});
  assert("…anche come envelope", eq(e.iotEnv, [[0, 100], [1, 200]]), JSON.stringify(e.iotEnv));
  const x = EU.convertGrainDurationUnit({ duration: 0.05, iot: "(0.1*m1)" }, "milliseconds", {});
  assert("…e come espressione", x.iot === "((0.1*m1) * 1000)");
}
assert("il clamp di iot e' nell'unita' e lascia passare un'espressione",
  EU.clampGrainIot({ durationUnit: "milliseconds" }, 200000, window.PGE_BOUNDS) === 100000
  && EU.clampGrainIot({}, "(m1)", window.PGE_BOUNDS) === "(m1)");

console.log("\n── la camminata del tempo e il catalogo ──");
const S = {
  id: "s1", duration: 4,
  grain: { duration: 0.05, iot: null, iotEnv: [[0, 0.1], [4, 0.02]] },
  pointer: { position: null, positionEnv: [[0, 0], [4, 3]] },
  _extra: { maps: { m1: { type: "logistic", r: [[0, 3.0], [4, 4.0]], clock: [[0, 2], [4, 20]] },
                    m2: { type: "tent", r: 3.2, iterate: 4 } } },
};
{
  const r = EU.rescaleStreamEnvelopes(S, 4, 8);
  assert("il resize senza freeze riporta iot", eq(r.grain.iotEnv, S.grain.iotEnv) || !eq(r, S));
  const sl = EU.sliceStreamEnvelopes(S, 0.5);
  assert("lo split taglia iotEnv", Array.isArray(sl.stream.grain.iotEnv)
    && !eq(sl.stream.grain.iotEnv, S.grain.iotEnv), JSON.stringify(sl.stream.grain.iotEnv));
  assert("…positionEnv", !eq(sl.stream.pointer.positionEnv, S.pointer.positionEnv));
  assert("…e r e clock delle mappe", !eq(sl.stream._extra.maps.m1.r, S._extra.maps.m1.r)
    && !eq(sl.stream._extra.maps.m1.clock, S._extra.maps.m1.clock),
    JSON.stringify(sl.stream._extra.maps.m1));
  assert("…lasciando un r numero e le altre chiavi com'erano",
    eq(sl.stream._extra.maps.m2, S._extra.maps.m2));
  const tr = EU.truncateStreamEnvelopes(EU.rescaleStreamEnvelopes(S, 4, 2));
  assert("il truncate vede gli envelope delle mappe",
    Array.isArray(tr._extra.maps.m1.r));
  assert("streamWouldTruncate vede r delle mappe",
    EU.streamWouldTruncate({ id: "x", duration: 4, _extra: { maps: { m1: { type: "logistic", r: [[0, 3], [0.5, 3.5], [1, 4]] } } } }, 2.5)
    && !EU.streamWouldTruncate({ id: "x", duration: 4, _extra: { maps: { m1: { type: "logistic", r: 3.5 } } } }, 2.5));
}
{
  const list = C.listEnvelopes(S, [], null);
  const by = Object.fromEntries(list.map((e) => [e.key, e]));
  assert("il catalogo elenca iot", by.grainIot && by.grainIot.yaml === "grain.iot");
  assert("…position, senza bordi duri (avvolge)", by.position
    && by.position.hardMin === -Infinity && by.position.hardMax === Infinity);
  assert("…r della mappa, con la finestra del tipo",
    by.map_m1_r && by.map_m1_r.yaml === "maps.m1.r" && by.map_m1_r.visMin === 2.5 && by.map_m1_r.visMax === 4.0);
  assert("…e il clock", by.map_m1_clock && by.map_m1_clock.yaml === "maps.m1.clock");
  assert("un r numero non e' un envelope da aprire", !by.map_m2_r);
}

console.log("\n── la guardia di ParamRow non cancella un'espressione ──");
{
  const prim = fs.readFileSync(path.join(__dirname, "../../src/components/primitives.jsx"), "utf8");
  const at = prim.indexOf("const handleMode = (m) => {");
  let d = 0, end = -1;
  for (let j = prim.indexOf("{", prim.indexOf("=>", at)); j < prim.length; j++) {
    if (prim[j] === "{") d++;
    else if (prim[j] === "}" && --d === 0) { end = j + 1; break; }
  }
  const src = prim.slice(at, end) + ";";
  const click = (mode, value, envValue, m) => {
    let got = null;
    new Function("window", "mode", "value", "envValue", "onMode", "m", src + "\nhandleMode(m);")(
      window, mode, value, envValue, (x) => { got = x; }, m);
    return got;
  };
  assert("bottone scalar acceso su un'espressione: onMode non viene chiamato",
    click("scalar", "(0.02 + 0.08*m1)", null, "scalar") === null);
  assert("…su una parola che non e' un'espressione il click materializza, come prima",
    click("scalar", "—", null, "scalar") === "scalar");
  assert("…e il passaggio a env resta un click vero", click("scalar", "(m1)", null, "env") === "env");
  assert("le righe dei campi a espressione passano onExpr",
    ["fillFactor: t", "density: t", "distribution: t", "duration: t", "volume: t", "pan: t",
     "value: t", "iot: t", "position: t"].every((n) =>
      fs.readFileSync(path.join(__dirname, "../../src/components/Inspector.jsx"), "utf8").includes(n)));
}

console.log("\n── toggleMode: il seme di un envelope e' un numero ──");
{
  const insp = fs.readFileSync(path.join(__dirname, "../../src/components/Inspector.jsx"), "utf8");
  const a = insp.indexOf("function toggleMode(k, newMode) {");
  const b = insp.indexOf("const _sampleList = samples || [];", a);
  const body = insp.slice(a, b);
  assert("nessun ramo semina un envelope da uno scalare che non e' un numero",
    !/const v = [\w.\[\]]+ != null \?/.test(body)
    && (body.match(/const v = typeof [\w.\[\]]+ === "number" \?/g) || []).length >= 17,
    String((body.match(/const v = typeof [\w.\[\]]+ === "number" \?/g) || []).length));
}

console.log("\n── l'EnvelopeEditor scrive gli envelope delle mappe al loro posto ──");
{
  const src = fs.readFileSync(path.join(__dirname, "../../src/components/EnvelopeEditor.jsx"), "utf8");
  const a = src.indexOf("function patchForPath");
  let d = 0, e = -1;
  for (let j = src.indexOf("{", a); j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}" && --d === 0) { e = j + 1; break; }
  }
  const patchForPath = new Function(src.slice(a, e) + ";return patchForPath;")();
  const st = { grain: { duration: 1, iotEnv: [[0, 1]] },
               _extra: { maps: { m1: { type: "logistic", r: [[0, 3]], clock: 2 }, m2: { type: "tent" } }, k: 1 } };
  assert("a quattro livelli tocca solo `r`, la mappa resta",
    eq(patchForPath(st, ["_extra", "maps", "m1", "r"], [[0, 9]]),
       { _extra: { maps: { m1: { type: "logistic", r: [[0, 9]], clock: 2 }, m2: { type: "tent" } }, k: 1 } }));
  assert("a due livelli come prima", eq(patchForPath(st, ["grain", "iotEnv"], [[0, 2]]),
    { grain: { duration: 1, iotEnv: [[0, 2]] } }));
  assert("a uno come prima", eq(patchForPath(st, ["volumeEnv"], [[0, 2]]), { volumeEnv: [[0, 2]] }));
}
