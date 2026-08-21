// Dump untranslated Spanish entries into chunk JSON files for translation.
// Run from the repo root: node scripts/i18n-es/dump-untranslated.mjs [chunkSize]
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(path.join(process.cwd(), "package.json"));
const { parsePo } = require("pofile-ts");

const PO_PATH = "src/locales/es/messages.po";
const OUT_DIR = "scripts/i18n-es/es-chunks";
const chunkSize = Number(process.argv[2] ?? 90);

const po = parsePo(fs.readFileSync(PO_PATH, "utf8"));
const untranslated = po.items
  .filter((it) => !(it.msgstr?.[0] ?? "").trim())
  .map((it) => ({ id: it.msgid, context: it.msgctxt ?? undefined, files: it.references ?? [] }));

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
let n = 0;
for (let i = 0; i < untranslated.length; i += chunkSize) {
  const chunk = untranslated.slice(i, i + chunkSize);
  fs.writeFileSync(path.join(OUT_DIR, `chunk-${String(n).padStart(2, "0")}.json`), JSON.stringify(chunk, null, 1));
  n++;
}
console.log(`total items: ${po.items.length}, untranslated: ${untranslated.length}, chunks: ${n} (size ${chunkSize}) -> ${OUT_DIR}`);
