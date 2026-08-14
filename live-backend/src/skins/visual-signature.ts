// Digests the note art inside an .osk into the SkinVisualSignature the
// similar-skins scoring compares (src/skins/similarity.ts). Runs where the
// server already holds the archive: once per .osk upload or replacement, and
// once per existing skin in the boot backfill below. Nothing here touches the
// rendered previews - their backdrop art is the uploader's wallpaper, not the
// skin - the signature comes from the tap-note images themselves.
//
// Type-only jszip, lazy sharp: both must stay out of the serving process's
// boot module graph (tests/boot-imports.test.ts), like the validator and the
// avatar accents do.
import type JSZip from "jszip";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { logWarn } from "../logger.js";
import { nowIso } from "../shared/score.js";
import { classifySkinNoteShape } from "./archive-meta.js";
import type { SkinKeymodeVisual, SkinVisualSignature } from "./similarity.js";
import { parseSkinIni } from "./validate-osk.js";

// Note images are small sprites; anything past these caps is not one, and a
// crafted archive must not expand into a giant raw decode.
const MAX_NOTE_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_NOTE_IMAGE_PIXELS = 4096 * 4096;
const MAX_DISTINCT_NOTES = 4;
// Across the whole archive: keymode blocks overwhelmingly share sprites, so a
// skin that really ships this many distinct notes is decoded no further.
const MAX_TOTAL_DECODES = 12;
const MASK_SIZE = 8;

export async function computeSkinVisualSignature(buffer: Buffer): Promise<SkinVisualSignature | null> {
  const { default: JSZipRuntime } = await import("jszip");
  let zip: JSZip;
  try {
    zip = await JSZipRuntime.loadAsync(buffer);
  } catch {
    return null;
  }

  const lookup = new Map<string, JSZip.JSZipObject>();
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    lookup.set(cleanZipPath(file.name).toLowerCase(), file);
  }

  const iniFile = lookup.get("skin.ini")
    ?? [...lookup.entries()].find(([key]) => key.endsWith("/skin.ini"))?.[1];
  if (!iniFile) return null;
  let blocks: Array<{ keys: number; block: Record<string, string> }> = [];
  try {
    const parsed = parseSkinIni((await iniFile.async("nodebuffer")).toString("utf8"));
    // Every keymode block gets its own digest - a skin's 4K bars and 6K
    // circles are different skins to the eye, and the scoring compares like
    // with like. First block per keymode wins, as it does in stable.
    const seen = new Set<number>();
    blocks = parsed.mania
      .map((block) => ({ block, keys: Math.round(Number(block.Keys)) }))
      .filter(({ keys }) => Number.isInteger(keys) && keys >= 1 && keys <= 10)
      .filter(({ keys }) => !seen.has(keys) && seen.add(keys));
  } catch {
    return null;
  }
  if (blocks.length === 0) return null;

  // Sprites are shared across keymode blocks constantly, so every image is
  // analyzed once however many blocks point at it.
  const analyzed = new Map<string, Promise<AnalyzedNote | null>>();
  let decodes = 0;
  const analyzeOnce = (key: string, file: JSZip.JSZipObject): Promise<AnalyzedNote | null> => {
    let promise = analyzed.get(key);
    if (!promise) {
      if (decodes >= MAX_TOTAL_DECODES) return Promise.resolve(null);
      decodes += 1;
      promise = analyzeNoteImage(file);
      analyzed.set(key, promise);
    }
    return promise;
  };

  const keymodes: Record<string, SkinKeymodeVisual> = {};
  for (const { keys, block } of blocks) {
    // One entry per distinct tap image, in column order: most skins alternate
    // two or three sprites across the columns.
    const seenFiles = new Set<string>();
    const files: Array<{ key: string; file: JSZip.JSZipObject }> = [];
    for (let col = 0; col < keys && files.length < MAX_DISTINCT_NOTES; col += 1) {
      const resolved = resolveNoteImage(lookup, block[`NoteImage${col}`], `mania-note${defaultManiaImageSuffix(keys, col)}`);
      if (!resolved || seenFiles.has(resolved.key)) continue;
      seenFiles.add(resolved.key);
      files.push(resolved);
    }
    let aspect: number | null = null;
    let mask: string | null = null;
    const colors: string[] = [];
    const accents: string[] = [];
    const notes: AnalyzedNote[] = [];
    let sat = 0;
    for (const entry of files) {
      const note = await analyzeOnce(entry.key, entry.file);
      if (!note) continue;
      // The first decodable note stands for the keymode's shape; shapes
      // rarely differ across columns, colours are what alternates.
      aspect ??= note.aspect;
      mask ??= note.mask;
      colors.push(note.color);
      if (note.accent) accents.push(note.accent);
      sat += note.sat;
      notes.push(note);
    }
    if (aspect != null && mask != null && colors.length > 0) {
      keymodes[String(keys)] = {
        aspect,
        mask,
        colors: colors.slice(0, 4),
        accents: accents.slice(0, 4),
        sat: sat / colors.length,
        ...(hasArrowLayout(block, keys, notes) ? { arrowLayout: true as const } : {}),
      };
    }
  }
  if (Object.keys(keymodes).length === 0) return null;
  return { v: 3, keymodes };
}

// A filename merely containing "arrow" is weak evidence: skins keep unused
// alternatives in arrow folders, and rounded-square edits are often copied
// from one. A live Mania block assigning at least three different cardinal
// directions from such a folder is the convention used by actual arrow sets.
// The referenced art must also point along one axis at full resolution. That
// visual check matters because many circle skins inherit these exact folder
// and filename conventions from an arrow template.
function hasArrowLayout(block: Record<string, string>, keys: number, notes: AnalyzedNote[]): boolean {
  const references = Array.from({ length: keys }, (_, column) => block[`NoteImage${column}`])
    .filter((reference): reference is string => Boolean(reference));
  if (!references.some((reference) => /(?:^|[\\/_ -])arrows?(?:[\\/_ -]|$)/i.test(reference))) return false;
  const directions = new Set<string>();
  for (const reference of references) {
    const basename = reference.replace(/\\/g, "/").split("/").pop()?.replace(/@2x$/i, "").toLowerCase() ?? "";
    for (const direction of ["left", "right", "up", "down"] as const) {
      if (basename.includes(direction)) directions.add(direction);
    }
  }
  return directions.size >= 3 && notes.some((note) => note.directionalAlpha);
}

// Stable's default column layout: alternating 1/2 mirrored from the outer
// edges in, with the middle column of odd keymodes as the special "S" lane.
// 4K = 1,2,2,1; 7K = 1,2,1,S,1,2,1. Same port as the replay importer's.
function defaultManiaImageSuffix(keys: number, column: number): "1" | "2" | "S" {
  if (keys % 2 === 1 && column === Math.floor(keys / 2)) return "S";
  const mirrored = column < keys / 2 ? column : keys - 1 - column;
  return mirrored % 2 === 0 ? "1" : "2";
}

// skin.ini references drop the extension; stable resolves @2x first, falls
// back to the animation's first frame when only that exists, and finds files
// nested a folder deep. All ported from the replay importer, minus formats
// sharp cannot decode anyway.
function resolveNoteImage(
  lookup: Map<string, JSZip.JSZipObject>,
  reference: string | undefined,
  fallback: string,
): { key: string; file: JSZip.JSZipObject } | null {
  for (const name of [reference, reference ? `${reference}-0` : undefined, fallback, `${fallback}-0`]) {
    if (!name) continue;
    const base = cleanZipPath(name).replace(/\.(png|jpe?g)$/i, "");
    if (!base) continue;
    const candidates = ["png", "jpg", "jpeg"]
      .flatMap((ext) => [`${base}@2x.${ext}`, `${base}.${ext}`])
      .map((candidate) => candidate.toLowerCase());
    // Exact paths have stable's @2x preference, but an unrelated nested
    // alternative must never beat the exact 1x file. re;owoTuna, for example,
    // references Arrows/LEFT.png while also shipping a circle at
    // mania/arrows/left@2x.png.
    for (const key of candidates) {
      const direct = lookup.get(key);
      if (direct) return { key, file: direct };
    }
    // Some uploads omit the art folder from skin.ini/default references, so
    // retain the one-folder-deep recovery only after exact resolution fails.
    for (const key of candidates) {
      for (const [entryKey, file] of lookup) {
        if (entryKey.endsWith(`/${key}`)) return { key: entryKey, file };
      }
    }
  }
  return null;
}

function cleanZipPath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").trim();
  return clean.includes("..") ? "" : clean;
}

interface AnalyzedNote {
  aspect: number;
  mask: string;
  color: string;
  // The saturated colour a player reads the note by; null on colourless art.
  accent: string | null;
  // Share of the drawn pixels that carry saturated colour, 0-1.
  sat: number;
  // The full-resolution alpha silhouette points along one axis. Kept only
  // while digesting so directional filenames cannot turn flat circles into
  // arrows, while coarse 8x8 masks can still be rescued when they blur one.
  directionalAlpha: boolean;
}

async function analyzeNoteImage(file: JSZip.JSZipObject): Promise<AnalyzedNote | null> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.async("nodebuffer"));
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_NOTE_IMAGE_BYTES) return null;

  const { default: sharp } = await import("sharp");
  let data: Buffer;
  let width: number;
  let height: number;
  try {
    const decoded = await sharp(bytes, { limitInputPixels: MAX_NOTE_IMAGE_PIXELS })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = decoded.data;
    ({ width, height } = decoded.info);
  } catch {
    return null;
  }
  if (width < 1 || height < 1) return null;

  // Trim to the drawn pixels first: note sprites routinely pad with
  // transparency, and both the aspect and the mask grid are about the note.
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 24) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < left || bottom < top) return null;
  const boxWidth = right - left + 1;
  const boxHeight = bottom - top + 1;
  const aspect = Math.min(20, Math.max(0.05, boxWidth / boxHeight));

  // The compact mask below deliberately loses detail. Measure symmetry once
  // against the original alpha pixels so a rounded/lobed arrow still has
  // visual evidence behind an arrow-named skin.ini layout. Cardinal arrows
  // disagree strongly with one mirror and little with the perpendicular one;
  // circles remain near zero on both (apart from antialiasing rounding).
  let mirrorXDifference = 0;
  let mirrorYDifference = 0;
  let mirrorSamples = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      const mirrorXAlpha = data[(y * width + (left + right - x)) * 4 + 3];
      const mirrorYAlpha = data[((top + bottom - y) * width + x) * 4 + 3];
      mirrorXDifference += Math.abs(alpha - mirrorXAlpha);
      mirrorYDifference += Math.abs(alpha - mirrorYAlpha);
      mirrorSamples += 1;
    }
  }
  const normalizedMirrorX = mirrorXDifference / (mirrorSamples * 255);
  const normalizedMirrorY = mirrorYDifference / (mirrorSamples * 255);
  const strongMirrorDifference = Math.max(normalizedMirrorX, normalizedMirrorY);
  const weakMirrorDifference = Math.min(normalizedMirrorX, normalizedMirrorY);
  const directionalAlpha = strongMirrorDifference >= 0.06 && weakMirrorDifference <= 0.04;

  // 8x8 mean-alpha grid over the trimmed box, one decile digit per cell.
  let mask = "";
  for (let cellY = 0; cellY < MASK_SIZE; cellY += 1) {
    for (let cellX = 0; cellX < MASK_SIZE; cellX += 1) {
      const x0 = left + Math.floor((cellX * boxWidth) / MASK_SIZE);
      const x1 = left + Math.max(x0 - left + 1, Math.floor(((cellX + 1) * boxWidth) / MASK_SIZE));
      const y0 = top + Math.floor((cellY * boxHeight) / MASK_SIZE);
      const y1 = top + Math.max(y0 - top + 1, Math.floor(((cellY + 1) * boxHeight) / MASK_SIZE));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          sum += data[(y * width + x) * 4 + 3];
          count += 1;
        }
      }
      mask += String(Math.min(9, Math.floor(sum / Math.max(1, count) / 25.6)));
    }
  }

  // Two colours per sprite, because a mania note is usually a white or grey
  // body carrying a coloured rim or core, and the body dominates any plain
  // average: the mean of everything drawn, and the mean of only the saturated
  // pixels, which is the colour a player would name the skin by.
  let r = 0;
  let g = 0;
  let b = 0;
  let solid = 0;
  let accentR = 0;
  let accentG = 0;
  let accentB = 0;
  let saturated = 0;
  for (let alphaFloor = 96; solid === 0 && alphaFloor > 0; alphaFloor -= 72) {
    // A sprite that is all faint glow has no solid pixels at all; drop the
    // threshold once rather than losing the note entirely.
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const offset = (y * width + x) * 4;
        if (data[offset + 3] < alphaFloor) continue;
        const pixelR = data[offset];
        const pixelG = data[offset + 1];
        const pixelB = data[offset + 2];
        r += pixelR;
        g += pixelG;
        b += pixelB;
        solid += 1;
        const max = Math.max(pixelR, pixelG, pixelB);
        const min = Math.min(pixelR, pixelG, pixelB);
        // Saturation as HSV reads it, ignoring near-black pixels where a
        // large ratio is just noise in the shadows.
        if (max >= 40 && (max - min) / max >= 0.35) {
          accentR += pixelR;
          accentG += pixelG;
          accentB += pixelB;
          saturated += 1;
        }
      }
    }
  }
  if (solid === 0) return null;
  const hex = (value: number, count: number) => Math.round(value / count).toString(16).padStart(2, "0");
  const satFraction = saturated / solid;
  return {
    aspect,
    mask,
    color: `#${hex(r, solid)}${hex(g, solid)}${hex(b, solid)}`,
    // Below a rim's worth of coloured pixels there is no accent to speak of,
    // and averaging a handful of stray ones would invent one.
    accent: satFraction >= 0.02 ? `#${hex(accentR, saturated)}${hex(accentG, saturated)}${hex(accentB, saturated)}` : null,
    sat: satFraction,
    directionalAlpha,
  };
}

// v2 digested a single keymode block, which scored a skin off art the viewer
// might not be looking at. v3 adds the saturated accent colour and how
// colourful the note art is: the catalog turned out to be mostly round white
// notes of near-identical proportions, so shape alone left forty skins at one
// indistinguishable point and their strips were arbitrary. Each bump
// re-digests the whole catalog once. v4 retained guarded arrow-layout evidence
// for soft arrows whose outer alpha silhouette looks round; v5 required the
// referenced sprite itself to have directional full-resolution geometry; v6
// also gives exact 1x references precedence over unrelated nested @2x art.
const BACKFILL_META_KEY = "skin_visual_signature_backfill:v6";

// One-time digest of skins uploaded before signatures existed: re-reads each
// stored .osk and records what its notes look like. Purely additive metadata,
// same shape as the special-keymodes backfill: downloads run one at a time
// behind boot, a skin whose art cannot be digested is logged and left to the
// accent fallback, and only a pass where every read failed (storage down at
// boot) skips the one-shot marker so the next boot retries.
export async function backfillSkinVisualSignatures(
  db: Db,
  readOsk: (key: string) => Promise<Buffer | null>,
): Promise<number> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [BACKFILL_META_KEY])).rows[0];
  if (done) return 0;
  const rows = (await exec(
    db,
    // Not conditioned on visual_json being null: a marker bump means the
    // stored digests are the old format and every row re-digests.
    "select id, osk_key from skins where status != 'pending' and osk_key is not null",
  )).rows;
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const id = String(row.id);
    const buffer = await readOsk(String(row.osk_key)).catch(() => null);
    if (!buffer) {
      failed += 1;
      logWarn("skin_visual_signature_unreadable", { id, reason: "osk_read_failed" });
      continue;
    }
    const signature = await computeSkinVisualSignature(buffer).catch(() => null);
    if (!signature) {
      logWarn("skin_visual_signature_undigestible", { id });
      continue;
    }
    await exec(
      db,
      "update skins set visual_json = ?, note_shape = ?, updated_at = ? where id = ?",
      [JSON.stringify(signature), classifySkinNoteShape(signature), nowIso(), id],
    );
    updated += 1;
  }
  const allFailed = rows.length > 0 && failed === rows.length;
  if (!allFailed) {
    await exec(
      db,
      "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
      [BACKFILL_META_KEY, JSON.stringify({ scanned: rows.length, updated, failed }), nowIso()],
    );
  }
  return updated;
}
