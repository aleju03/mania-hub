import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceDir = path.join(repoRoot, "public", "audio", "hitsounds");
const outputDir = path.join(repoRoot, "public", "assets");
const outputPath = path.join(outputDir, "replay-default-hitsounds-v1.zip");
const temporaryPath = `${outputPath}.tmp`;
const fixedDate = new Date("2000-01-01T00:00:00.000Z");

const sampleFiles = [
  "normal-hitnormal.wav",
  "normal-hitwhistle.wav",
  "normal-hitfinish.wav",
  "normal-hitclap.wav",
  "soft-hitnormal.wav",
  "soft-hitwhistle.wav",
  "soft-hitfinish.wav",
  "soft-hitclap.wav",
  "drum-hitnormal.wav",
  "drum-hitwhistle.wav",
  "drum-hitfinish.wav",
  "drum-hitclap.wav",
  "combobreak.mp3",
];

const zip = new JSZip();
for (const filename of sampleFiles) {
  zip.file(filename, await readFile(path.join(sourceDir, filename)), {
    date: fixedDate,
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    createFolders: false,
  });
}

const bundle = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
  platform: "UNIX",
});

await mkdir(outputDir, { recursive: true });
await writeFile(temporaryPath, bundle);
await rename(temporaryPath, outputPath);
console.log(`Built ${path.relative(repoRoot, outputPath)} (${bundle.length} bytes).`);
