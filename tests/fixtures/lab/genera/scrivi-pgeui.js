// I file importati del master delle fixture, come li scriverebbe PGE-ui
// (`serializeImports` + `importedFileText`, la strada di `onSave`): una volta
// senza toccare niente, una volta col `volume` di quello stream toccato.
//
//   node tests/fixtures/lab/genera/scrivi-pgeui.js <cartella di uscita>
//
// Escono `noop__<nome>.yml` e `volume__<nome>.yml`. Li legge `ritorno.py`.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "../../../..");
const LAB = path.join(REPO, "tests/fixtures/lab");
const out = process.argv[2];
if (!out) { console.error("uso: scrivi-pgeui.js <cartella di uscita>"); process.exit(2); }
global.window = { jsyaml: require(path.join(REPO, "tests/node/node_modules/js-yaml")) };
eval(fs.readFileSync(path.join(REPO, "src/lib/yaml-bridge.js"), "utf8"));
const Y = window.PGEYaml;

const master = fs.readFileSync(path.join(LAB, "master.yml"), "utf8");
const imports = {};
for (const f of Y.importRefs(master)) imports[f] = { text: fs.readFileSync(path.join(LAB, f), "utf8") };
const data = Y.parse(master, { project: "master", samples: [], imports });
const files = Y.serializeImports(data).files;
fs.mkdirSync(out, { recursive: true });
for (const f of Object.keys(files)) {
  fs.writeFileSync(path.join(out, "noop__" + path.basename(f)), Y.importedFileText(f, files[f]));
}
for (const s of data.streams.filter(x => x._import)) {
  const d = { ...data, streams: data.streams.map(x =>
    (x === s ? Y.applyStreamPatch(x, { volume: -3, volumeEnv: null }) : x)) };
  const f = s._import.file;
  fs.writeFileSync(path.join(out, "volume__" + path.basename(f)),
    Y.importedFileText(f, Y.serializeImports(d).files[f]));
}
