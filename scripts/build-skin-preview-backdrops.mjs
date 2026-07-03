// Pre-shrinks the curated skin-preview backdrop covers into static assets.
//
// The upload modal composes skin previews over one of the map covers listed
// in SKIN_PREVIEW_BACKGROUND_SETS (src/lib/skin-preview-render.ts). The
// fullsize originals on assets.ppy.sh run up to several MB, which is what the
// browser used to download through /api/background before the first preview
// could render. This bakes each cover down to the exact 1280x720 the renderer
// draws (cover-fit crop, WebP) and drops it in public/, so the client fetches
// ~100 KB from the static CDN instead.
//
// Run after editing SKIN_PREVIEW_BACKGROUND_SETS: npm run skins:build-preview-backdrops

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "public", "images", "skin-preview-backdrops");

// Single source of truth stays in the renderer module; lift the ids out of it.
const rendererSource = await readFile(path.join(repoRoot, "src", "lib", "skin-preview-render.ts"), "utf8");
const listMatch = rendererSource.match(/SKIN_PREVIEW_BACKGROUND_SETS\s*=\s*\[([^\]]+)\]/);
if (!listMatch) {
  throw new Error("SKIN_PREVIEW_BACKGROUND_SETS not found in src/lib/skin-preview-render.ts");
}
const setIds = listMatch[1]
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value));
if (setIds.length === 0) {
  throw new Error("SKIN_PREVIEW_BACKGROUND_SETS parsed to an empty list");
}

await mkdir(outDir, { recursive: true });
for (const setId of setIds) {
  const response = await fetch(`https://assets.ppy.sh/beatmaps/${setId}/covers/fullsize.jpg`);
  if (!response.ok) {
    throw new Error(`set ${setId}: fullsize cover fetch failed (${response.status})`);
  }
  const original = Buffer.from(await response.arrayBuffer());
  // The renderer dims the cover to ~28% behind the stage, so quality 78 is
  // already indistinguishable in the composed preview.
  const webp = await sharp(original).resize(1280, 720, { fit: "cover" }).webp({ quality: 78 }).toBuffer();
  const outFile = path.join(outDir, `${setId}.webp`);
  await writeFile(outFile, webp);
  console.log(`${setId}: ${(original.length / 1024).toFixed(0)} KB -> ${(webp.length / 1024).toFixed(0)} KB`);
}
console.log(`Wrote ${setIds.length} backdrops to ${path.relative(repoRoot, outDir)}`);
