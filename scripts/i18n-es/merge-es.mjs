// Merge translated chunk outputs into the Spanish PO, then run
// `npm run i18n:extract` once to normalize line folding and `npm run i18n:compile`.
// Each input file: JSON object { "<msgid>": "<msgstr>", ... } or array [{id, es}].
// Run from the repo root: node scripts/i18n-es/merge-es.mjs scripts/i18n-es/es-out/*.json
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { parsePo, stringifyPo } = require("pofile-ts");

const PO_PATH = "src/locales/es/messages.po";
const po = parsePo(fs.readFileSync(PO_PATH, "utf8"));
const byId = new Map(po.items.map((it) => [it.msgid, it]));

const map = new Map();
for (const file of process.argv.slice(2)) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = Array.isArray(data) ? data.map((entry) => [entry.id, entry.es]) : Object.entries(data);
  for (const [id, es] of entries) {
    if (typeof es === "string" && es.trim()) map.set(id, es);
  }
}

let applied = 0;
let missing = 0;
let skippedNonEmpty = 0;
for (const [id, es] of map) {
  const item = byId.get(id);
  if (!item) {
    missing++;
    console.error(`no such msgid: ${JSON.stringify(id).slice(0, 100)}`);
    continue;
  }
  if ((item.msgstr?.[0] ?? "").trim()) {
    skippedNonEmpty++;
    continue;
  }
  item.msgstr = [es];
  applied++;
}
fs.writeFileSync(PO_PATH, stringifyPo(po));
const stillEmpty = po.items.filter((it) => !(it.msgstr?.[0] ?? "").trim()).length;
console.log(`applied: ${applied}, unknown msgid: ${missing}, already translated (skipped): ${skippedNonEmpty}, still empty: ${stillEmpty}`);
