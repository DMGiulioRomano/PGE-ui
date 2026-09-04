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
const { applyStreamPatch, serializeStream } = window.PGEYaml;

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

console.log("\n── i campi di preservazione del multistate (#59): il criterio e' lo YAML ──");
{
  // statePositions / _curveRaw sono iniettati al parse per far tornare indietro
  // le posizioni esplicite e la curva verbatim. Erano esclusi entrambi
  // dall'hash "perche' rispecchiano dati gia' codificati negli stati e nella
  // curva". Vero di uno, falso dell'altro, e il criterio giusto non e' "campo
  // dell'editor" ma ARRIVA NELLO YAML: cio' che ci arriva lo hasha il motore.
  //
  // `statePositions` ci arriva: `serializeGrainEnvelope` lo splicia dentro
  // `states` (`[[pos, name], …]`). Escluderlo voleva dire pallino verde su uno
  // stem che il motore riscrive — e riscrive DIVERSO, perche' le posizioni sono
  // soglie in value-space. Misurato contro il motore in
  // tests/parity/test-fingerprint-parity.js.
  const ms = () => ({
    id: "s1", duration: 10, sample: "x.wav",
    grain: { duration: 0.1, envelope: { states: ["hanning", "bartlett", "blackman"], curve: [[0, 0], [1, 2]] } },
  });
  const fpMs = fp(ms());
  {
    const s = ms(); s.grain.envelope.statePositions = [0, 0.2, 0.9];
    assert("detects grain.envelope.statePositions", fp(s) !== fpMs, "fp unchanged");
  }
  {
    // …e due posizioni diverse restano due fingerprint diversi: se l'hash le
    // vedesse solo come "presenti" (una chiave in piu') l'edit nel tab Raw da
    // 0.2 a 0.9 tornerebbe muto, che e' il difetto di prima con un passo in meno.
    const a = ms(); a.grain.envelope.statePositions = [0, 0.2, 0.9];
    const b = ms(); b.grain.envelope.statePositions = [0, 0.7, 0.9];
    assert("e posizioni diverse danno fingerprint diversi", fp(a) !== fp(b), "fp uguale");
  }
  {
    // `_curveRaw` resta fuori, ma non perche' sia "dell'editor": perche' non
    // puo' muoversi da solo. `parseGrainEnvelope` DERIVA `curve` da lui
    // (rescaleCurveY, lineare), quindi una deriva troppo piccola per il 1e-9 di
    // `curveMatchesRaw` finisce comunque in `curve`, che e' hashata. La premessa
    // e' pretesa dal motore in test-fingerprint-parity.js; qui si fissa il verso
    // che vale senza motore.
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
  {
    // La premessa di `_curveRaw`, dal lato che non ha bisogno del motore: una
    // curva che deriva sotto la tolleranza di `curveMatchesRaw` muove `curve` e
    // quindi l'hash. Se un domani il parse smettesse di derivarla, questo
    // assert cade e `_curveRaw` va hashato come le posizioni.
    const y = (cy) => `stream_id: s1\nduration: 10\nsample: x.wav\n` +
      `grain:\n  duration: 0.1\n  envelope:\n` +
      `    states: [[0, hanning], [0.5, bartlett], [1, blackman]]\n` +
      `    curve: [[0, 0], [1, ${cy}]]\n`;
    const p0 = window.PGEYaml.parseStream(y("1"), 0, { samples: [] });
    const p1 = window.PGEYaml.parseStream(y("1.0000000000001"), 0, { samples: [] });
    assert("una deriva sotto 1e-9 in _curveRaw passa comunque per curve",
      p0.grain.envelope._curveRaw[1][1] !== p1.grain.envelope._curveRaw[1][1] &&
      fp(p0) !== fp(p1), "fingerprint uguale");
  }
  {
    /* Il bordo del criterio, e il motivo per cui non e' una lista di nomi.
       «Arriva nello YAML» e' una domanda per il serializer: le posizioni
       arrivano SOLO finche' sono allineate agli stati. Dopo un edit
       strutturale (uno stato in piu') la copia resta corta, il serializer la
       ignora e scrive quelle uniformi — due stream cosi' danno lo stesso
       identico YAML, quindi lo stesso hash del motore, e devono dare lo stesso
       hash anche qui. Hasharle li' sarebbe giallo su uno stem fresco: verso
       sicuro, ma una seconda divergenza dalla derivata del motore, e la lista
       delle divergenze dichiarate ha un elemento solo. */
    const stale = (p) => {
      const s = ms(); s.grain.envelope.states = [...s.grain.envelope.states, "bartlett"];
      s.grain.envelope.statePositions = p; return s;
    };
    const a = stale([0, 0.2, 0.9]), b = stale([0, 0.7, 0.9]);
    assert("posizioni stale: stesso YAML",
      serializeStream(a) === serializeStream(b), "YAML diverso");
    assert("...e quindi stesso fingerprint", fp(a) === fp(b),
      "giallo su uno stem che il motore considera fresco");
    /* E il verso opposto, che e' quello che regge tutto il resto: quando le
       posizioni arrivano davvero, muoverle muove l'hash. Senza questo, un
       `positionsAreDropped` che rispondesse sempre "si'" passerebbe l'assert
       qui sopra e rimetterebbe in piedi il difetto di #134. */
    const live = (p) => { const s = ms(); s.grain.envelope.statePositions = p; return s; };
    assert("posizioni allineate: YAML diverso e fingerprint diverso",
      serializeStream(live([0, 0.2, 1])) !== serializeStream(live([0, 0.9, 1])) &&
      fp(live([0, 0.2, 1])) !== fp(live([0, 0.9, 1])), "hash fermo");
    /* Il ramo verbatim: senza `states` il serializer riemette l'oggetto com'e',
       posizioni comprese, quindi il motore le hasha e noi pure. E' il caso che
       una guardia scritta come "salta statePositions se la lunghezza non
       combacia" sbaglierebbe, perche' li' non c'e' nessuna lunghezza con cui
       combaciare. */
    const verb = (p) => ({ id: "s1", duration: 10, sample: "x.wav",
      grain: { duration: 0.1, envelope: { points: [[0, 0]], statePositions: p } } });
    assert("envelope senza states: le posizioni escono verbatim e si hashano",
      serializeStream(verb([0, 0.2])) !== serializeStream(verb([0, 0.9])) &&
      fp(verb([0, 0.2])) !== fp(verb([0, 0.9])), "hash fermo su un campo che esce");
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

  /* Le OMONIME delle chiavi escluse, e il livello che conta.
     `serializeStream` splicia `_extra` NEL livello del blocco che lo contiene:
     `stream._extra.mute` esce come un `mute:` di primo livello, che il motore
     filtra; `grain._extra.mute` esce come `grain: {mute: …}`, che il motore
     hasha (la sua e' una dict-comprehension sul solo primo livello). La lista
     qui filtrava a OGNI profondita', quindi il secondo caso spariva
     dall'hash della UI e non da quello del motore: verde su uno stem che il
     motore stava per riscrivere, cioe' un render di meno. */
  const muto = base(); muto.mute = true;
  assert("il mute dello stream resta fuori dall'hash", fp(muto) === fp0);
  const mutoExtra = base(); mutoExtra._extra = { mute: "qualcosa" };
  assert("...e cosi' un `mute` in _extra, che e' lo stesso livello YAML",
    fp(mutoExtra) === fp0,
    "il motore lo filtra: hasharlo qui sarebbe un render di troppo");

  /* Il caso annidato va misurato su un `_extra` che esiste in ENTRAMBI i
     termini: comparire e basta muove l'hash per la chiave `_extra` stessa,
     quindi un confronto contro la base non discriminerebbe niente. */
  const senza = base();
  senza.grain = { ...senza.grain, _extra: { chiave_futura: 1 } };
  const con = base();
  con.grain = { ...con.grain, _extra: { chiave_futura: 1, mute: true } };
  assert("un `mute` dentro grain._extra ENTRA nell'hash",
    fp(senza) !== fp(con),
    "esce come `grain: {mute: …}`, che il motore hasha (filtra il solo primo " +
    "livello): escluderlo qui e' un render di meno, il verso sbagliato");
  const senzaC = base();
  senzaC.pointer = { ...senzaC.pointer, _extra: { chiave_futura: 1 } };
  const conC = base();
  conC.pointer = { ...conC.pointer, _extra: { chiave_futura: 1, color: "#f00" } };
  assert("...e cosi' un `color` dentro pointer._extra", fp(senzaC) !== fp(conC));

  // I due campi dell'editor restano esclusi ovunque: vivono annidati per
  // costruzione, e sono l'unica ragione per cui il filtro in profondita'
  // esiste. Li verifica la sezione multistate qui sopra.
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
process.on("exit", (code) => {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (code && !fail) console.log("interrotto prima della fine: il riepilogo e' parziale");
  if (fail > 0) process.exitCode = 1;
});
