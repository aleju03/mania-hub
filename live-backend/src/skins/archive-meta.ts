// The archive-derived facts the /skins filters ask about: whether the skin
// ships a lane cover, whether it ships its own mania stage art, and whether it
// carries osu!lazer-only modifications. Computed where the server already
// holds the .osk (upload, replacement, and the one-shot boot backfill below),
// same as the visual signature. The note-shape classifier lives here too, but
// reads the stored visual signature rather than the archive: the 8x8 alpha
// mask and aspect the similarity digest already keeps are exactly the shape
// facts circle/arrow/bar are told apart by.
//
// Type-only jszip, lazy sharp: both must stay out of the serving process's
// boot module graph (tests/boot-imports.test.ts), like the validator does.
import type JSZip from "jszip";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { logWarn } from "../logger.js";
import { nowIso } from "../shared/score.js";
import { normalizeSkinVisualSignature, type SkinVisualSignature } from "./similarity.js";
import { parseSkinIni } from "./validate-osk.js";

export type SkinNoteShape = "circle" | "arrow" | "bar" | "other";

export function isSkinNoteShape(value: unknown): value is SkinNoteShape {
  return value === "circle" || value === "arrow" || value === "bar" || value === "other";
}

export interface SkinArchiveMeta {
  laneCover: boolean;
  maniaStage: boolean;
  lazer: boolean;
}

// What lazer's skin editor leaves behind when it saves: skininfo.json plus one
// layout json per edited target. The target names are the members of lazer's
// GlobalSkinnableContainers enum, unchanged across every release that could
// write them, so this list is exhaustive rather than a guess. Matched by
// basename: lazer writes them at the archive root, but a re-zipped skin can
// carry them a folder deep like everything else.
const LAZER_MARKER_FILES = new Set([
  "skininfo.json",
  "mainhudcomponents.json",
  "songselect.json",
  "playfield.json",
]);

// Older lazer builds appended this comment to skin.ini when they rewrote it;
// the phrasing is lazer's own and appears nowhere else.
const LAZER_INI_MARKER = "automatically added by osu!";

// The stage frame the player actually sees: the left and right rails.
// StageHint is deliberately not on this list: nearly every skin ships one (it
// is the judgement-line art), so it says nothing about whether the skin has
// its own stage design - and an oversized one is the lane-cover trick, which
// is the other detector's business. StageBottom is also handled by the cover
// detector: a normal deck stays at the receptors, while an over-height canvas
// can deliberately place its visible pixels across the top of the lanes.
const STAGE_RAILS = [
  { key: "StageLeft", fallback: "mania-stage-left" },
  { key: "StageRight", fallback: "mania-stage-right" },
] as const;

// Same caps as the visual signature: anything past these is not a sprite, and
// a crafted archive must not expand into a giant raw decode.
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 4096 * 4096;

// A stage hint taller than this (at 1x scale) is not a judgement line, it is
// the community's standard way of shipping a lane cover: StageHint draws
// centred on the hit position, so an oversized image blankets the lanes above
// it. Real hints run 10-100px; covers span hundreds.
const LANE_COVER_HINT_MIN_HEIGHT = 200;

// Stable lays mania-stage-bottom out in a 480-unit playfield, bottom-aligned
// and at its native size. Some circle skins exploit that rule with a canvas a
// little (or a lot) taller than 480: transparent padding hangs off-screen and
// the art at the canvas's top becomes a cover across the top lanes. Count a
// meaningful run of pixels in the upper third, but require those rows to draw
// through the centre of the sprite so tall side decorations do not qualify.
const MANIA_STAGE_HEIGHT = 480;
const LANE_COVER_TOP_BAND_HEIGHT = 160;
const LANE_COVER_BOTTOM_MIN_DRAWN_HEIGHT = 12;
const LANE_COVER_BOTTOM_MIN_CENTRE_COVERAGE = 0.15;

interface ImageAlphaGeometry {
  nativeHeight: number;
  drawnHeight: number;
  scale: number;
  centreRowCoverage: number[];
}

export async function computeSkinArchiveMeta(buffer: Buffer): Promise<SkinArchiveMeta | null> {
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
    const clean = cleanZipPath(file.name).toLowerCase();
    if (clean) lookup.set(clean, file);
  }

  let lazer = false;
  let laneCover = false;
  for (const path of lookup.keys()) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (LAZER_MARKER_FILES.has(basename)) lazer = true;
    // Skins that ship a cover as its own file overwhelmingly name it so:
    // "lanecover.png", "Lane Cover/...", "lane-cover@2x.png".
    if (/lane[\s_-]?cover/.test(path)) laneCover = true;
  }

  const iniFile = lookup.get("skin.ini")
    ?? [...lookup.entries()].find(([key]) => key.endsWith("/skin.ini"))?.[1];
  let maniaBlocks: Array<Record<string, string>> = [];
  if (iniFile) {
    try {
      const raw = (await iniFile.async("nodebuffer")).toString("utf8");
      if (raw.includes(LAZER_INI_MARKER)) lazer = true;
      maniaBlocks = parseSkinIni(raw).mania;
    } catch {
      // An unreadable ini leaves the entry-name findings standing.
    }
  }

  // One decode per distinct file: blocks overwhelmingly share their sprites.
  const imageGeometries = new Map<string, Promise<ImageAlphaGeometry | null>>();
  const imageGeometry = (entry: { key: string; file: JSZip.JSZipObject }): Promise<ImageAlphaGeometry | null> => {
    let pending = imageGeometries.get(entry.key);
    if (!pending) {
      pending = imageAlphaGeometry(entry).catch(() => null);
      imageGeometries.set(entry.key, pending);
    }
    return pending;
  };

  const maniaBlocksToScan = maniaBlocks.length > 0 ? maniaBlocks : [{} as Record<string, string>];

  // The badge means "downloading this gets you a stage design", so it follows
  // what stable draws, not what the archive carries: per keymode block, a rail
  // resolves from its skin.ini reference with the default filename as the
  // fallback (the same order the frontend's preview renderer uses), and the
  // art has to put pixels on screen. The circle templates hide their stage by
  // pointing the ini at a file that is not there and shipping fully
  // transparent blanks under the default names; those leftovers are not a
  // stage, however many stage-named files they add to the zip.
  let maniaStage = false;
  outer: for (const block of maniaBlocksToScan) {
    for (const rail of STAGE_RAILS) {
      const resolved = resolveStageImageEntry(lookup, block[rail.key], rail.fallback);
      if (resolved && (await imageGeometry(resolved)) != null) {
        maniaStage = true;
        break outer;
      }
    }
  }

  if (!laneCover) {
    // Covers can be keymode-specific, so resolve each block independently in
    // the same custom -> animated custom -> default -> animated default order
    // as the preview importer. Do not stop at an ordinary hint in an earlier
    // block: a later keymode may carry the actual oversized cover.
    for (const block of maniaBlocksToScan) {
      const resolved = resolveStageImageEntry(lookup, block.StageHint, "mania-stage-hint");
      if (!resolved) continue;
      const geometry = await imageGeometry(resolved);
      if (geometry != null && geometry.drawnHeight >= LANE_COVER_HINT_MIN_HEIGHT) {
        laneCover = true;
        break;
      }
    }
  }

  if (!laneCover) {
    for (const block of maniaBlocksToScan) {
      const resolved = resolveStageImageEntry(lookup, block.StageBottom, "mania-stage-bottom");
      if (!resolved) continue;
      const geometry = await imageGeometry(resolved);
      if (geometry != null && stageBottomDrawsLaneCover(geometry)) {
        laneCover = true;
        break;
      }
    }
  }

  return { laneCover, maniaStage, lazer };
}

// skin.ini references drop the extension; stable resolves @2x first and finds
// files nested a folder deep. Animation-frame fallback is layered on by
// resolveStageImageEntry below.
function resolveImageEntry(
  lookup: Map<string, JSZip.JSZipObject>,
  reference: string,
): { key: string; file: JSZip.JSZipObject } | null {
  const base = cleanZipPath(reference).replace(/\.(png|jpe?g)$/i, "");
  if (!base) return null;
  for (const ext of ["png", "jpg", "jpeg"]) {
    for (const candidate of [`${base}@2x.${ext}`, `${base}.${ext}`]) {
      const key = candidate.toLowerCase();
      const direct = lookup.get(key);
      if (direct) return { key, file: direct };
      for (const [entryKey, file] of lookup) {
        if (entryKey.endsWith(`/${key}`)) return { key: entryKey, file };
      }
    }
  }
  return null;
}

// Stable retries animation frame zero for stage furniture, then falls back to
// the default name when a custom reference is absent or unresolved. Keep the
// metadata pass in lockstep with replay-skin-import.ts.
function resolveStageImageEntry(
  lookup: Map<string, JSZip.JSZipObject>,
  reference: string | undefined,
  fallback: string,
): { key: string; file: JSZip.JSZipObject } | null {
  return (reference ? resolveImageEntry(lookup, reference) : null)
    ?? (reference ? resolveImageEntry(lookup, `${reference}-0`) : null)
    ?? resolveImageEntry(lookup, fallback)
    ?? resolveImageEntry(lookup, `${fallback}-0`);
}

// Geometry of the drawn (non-transparent) pixels, scaled back to 1x when the
// file is @2x art. The per-row centre coverage lets StageBottom distinguish a
// cover crossing the lanes from a tall decoration that stays at the sides.
async function imageAlphaGeometry(entry: { key: string; file: JSZip.JSZipObject }): Promise<ImageAlphaGeometry | null> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await entry.file.async("nodebuffer"));
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;

  const { default: sharp } = await import("sharp");
  let data: Buffer;
  let width: number;
  let height: number;
  try {
    const decoded = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = decoded.data;
    ({ width, height } = decoded.info);
  } catch {
    return null;
  }
  let top = height;
  let bottom = -1;
  const centreLeft = Math.floor(width * 0.25);
  const centreRight = Math.max(centreLeft + 1, Math.ceil(width * 0.75));
  const centreWidth = centreRight - centreLeft;
  const centreRowCoverage = Array.from({ length: height }, () => 0);
  for (let y = 0; y < height; y += 1) {
    let centreDrawn = 0;
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 24) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x >= centreLeft && x < centreRight) centreDrawn += 1;
      }
    }
    centreRowCoverage[y] = centreDrawn / centreWidth;
  }
  if (bottom < top) return null;
  const scale = /@2x\.(png|jpe?g)$/.test(entry.key) ? 2 : 1;
  return {
    nativeHeight: height / scale,
    drawnHeight: (bottom - top + 1) / scale,
    scale,
    centreRowCoverage,
  };
}

function stageBottomDrawsLaneCover(geometry: ImageAlphaGeometry): boolean {
  const spriteTop = MANIA_STAGE_HEIGHT - geometry.nativeHeight;
  let coveredHeight = 0;
  for (let y = 0; y < geometry.centreRowCoverage.length; y += 1) {
    if (geometry.centreRowCoverage[y] < LANE_COVER_BOTTOM_MIN_CENTRE_COVERAGE) continue;
    const rowTop = spriteTop + y / geometry.scale;
    const rowBottom = spriteTop + (y + 1) / geometry.scale;
    const visibleTop = Math.max(0, rowTop);
    const visibleBottom = Math.min(LANE_COVER_TOP_BAND_HEIGHT, rowBottom);
    if (visibleBottom > visibleTop) coveredHeight += visibleBottom - visibleTop;
  }
  return coveredHeight >= LANE_COVER_BOTTOM_MIN_DRAWN_HEIGHT;
}

function cleanZipPath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").trim();
  return clean.includes("..") ? "" : clean;
}

// ---------------------------------------------------------------------------
// Note shape, from the stored visual signature.

const MASK_SIZE = 8;

// Every tap-note shape a skin carries, classified per keymode block from the
// digest's trimmed aspect and 8x8 alpha mask. The majority shape comes first;
// ties follow the lowest keymode, the one a skin is usually recognised by.
export function classifySkinNoteShapes(visual: SkinVisualSignature | null): SkinNoteShape[] {
  if (!visual) return [];
  const entries = Object.entries(visual.keymodes)
    .map(([keys, art]) => ({
      keys: Number(keys),
      shape: classifyKeymodeNoteShape(art.aspect, art.mask, art.arrowLayout === true),
    }))
    .sort((a, b) => a.keys - b.keys);
  const buckets = new Map<SkinNoteShape, { count: number; firstKeys: number }>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.shape);
    if (bucket) bucket.count += 1;
    else buckets.set(entry.shape, { count: 1, firstKeys: entry.keys });
  }
  return [...buckets]
    .sort(([, left], [, right]) => right.count - left.count || left.firstKeys - right.firstKeys)
    .map(([shape]) => shape);
}

// The catalog filter still needs one primary label. Keep its established
// majority/tie behavior while summaries expose the complete set above.
export function classifySkinNoteShape(visual: SkinVisualSignature | null): SkinNoteShape | null {
  return classifySkinNoteShapes(visual)[0] ?? null;
}

export function classifyKeymodeNoteShape(aspect: number, mask: string, arrowLayout = false): SkinNoteShape {
  if (!/^[0-9]{64}$/.test(mask)) return "other";
  // Direction assignments are stronger than a soft outer silhouette. This is
  // deliberately guarded while digesting skin.ini: one arrow-ish filename or
  // an unused folder never sets it.
  if (arrowLayout) return "arrow";
  // Wide art is a bar whatever its outline: the eye reads a 3:1 pill and a
  // 3:1 rectangle as the same kind of note.
  if (aspect >= 1.8) return "bar";

  const cell = (x: number, y: number) => Number(mask[y * MASK_SIZE + x]);
  let filled = 0;
  let alpha = 0;
  for (let index = 0; index < mask.length; index += 1) {
    const value = Number(mask[index]);
    alpha += value;
    if (value >= 5) filled += 1;
  }
  const coverage = filled / mask.length;
  const alphaCoverage = alpha / (9 * mask.length);
  const corners = (cell(0, 0) + cell(7, 0) + cell(0, 7) + cell(7, 7)) / 4;

  // Mean per-cell disagreement with the mirror image, per axis, 0-9. A circle
  // is symmetric both ways, an arrow is symmetric along exactly one.
  let horizontal = 0;
  let vertical = 0;
  for (let y = 0; y < MASK_SIZE; y += 1) {
    for (let x = 0; x < MASK_SIZE; x += 1) {
      horizontal += Math.abs(cell(x, y) - cell(MASK_SIZE - 1 - x, y));
      vertical += Math.abs(cell(x, y) - cell(x, MASK_SIZE - 1 - y));
    }
  }
  horizontal /= mask.length;
  vertical /= mask.length;

  // A filled rectangle: near-total coverage with drawn corners. The corner
  // floor is deliberately low (3.5, not "solid") because bar notes round
  // their corners and the mean-alpha corner cells of a rounded rect land at
  // 4-5; a circle's are 0-2, so the buckets stay apart. Squarish solid notes
  // read as neither circles nor bars.
  if (corners >= 3.5 && coverage >= 0.88) return aspect >= 1.15 ? "bar" : "other";
  // Round: empty corners, full edge midpoints and shoulders, symmetric both
  // ways, with about a circle's area. Midpoints alone are not enough: a
  // diamond has strong tips there, while its adjacent shoulder cells stay
  // sparse. The area ceiling separates a rounded square, whose corners may be
  // empty in this coarse mask but whose body still fills almost the whole box.
  const edgeMids = [
    (cell(3, 0) + cell(4, 0)) / 2,
    (cell(3, 7) + cell(4, 7)) / 2,
    (cell(0, 3) + cell(0, 4)) / 2,
    (cell(7, 3) + cell(7, 4)) / 2,
  ];
  const edgeShoulders = [
    (cell(2, 0) + cell(5, 0)) / 2,
    (cell(2, 7) + cell(5, 7)) / 2,
    (cell(0, 2) + cell(0, 5)) / 2,
    (cell(7, 2) + cell(7, 5)) / 2,
  ];
  if (
    corners <= 3.5 && horizontal <= 0.5 && vertical <= 0.5
    && edgeMids.every((mid) => mid >= 6.5)
    && edgeShoulders.every((shoulder) => shoulder >= 3.5)
    && alphaCoverage <= 0.88
    && coverage >= 0.4 && coverage <= 0.9
  ) {
    return "circle";
  }
  // An arrow points somewhere: asymmetric along its axis, mirror-symmetric
  // across it. Cardinal directions only - that is what mania arrow skins
  // ship. Thick, rounded arrowheads in the catalog measure only 0.8-1.0 on
  // their pointing axis at 8x8; true circles sit below 0.2 on both axes.
  const arrowVertical = vertical >= 0.65 && horizontal <= 0.35;
  const arrowHorizontal = horizontal >= 0.65 && vertical <= 0.35;
  if ((arrowVertical || arrowHorizontal) && corners <= 1.5 && coverage >= 0.3 && coverage <= 0.85) return "arrow";
  return "other";
}

// ---------------------------------------------------------------------------
// One-shot boot backfill for the catalog uploaded before these columns
// existed. Same shape as the visual-signature backfill: downloads run one at
// a time behind boot, a row whose .osk cannot be read is logged and skipped,
// and only a pass where every read failed (storage down at boot) skips the
// one-shot marker so the next boot retries. The note shape rides along from
// the visual signature already on the row, so it stays consistent with what
// an upload would have computed.
// v2: the stage flag became "what stable draws" (rails only, resolved per
// block, visibly drawn) rather than "stage-named files exist in the zip".
// v3: lane covers also follow StageBottom's screen-space layout and every
// stage asset resolves per keymode with animated-frame fallback.
const BACKFILL_META_KEY = "skin_archive_meta_backfill:v3";

export async function backfillSkinArchiveMeta(
  db: Db,
  readOsk: (key: string) => Promise<Buffer | null>,
): Promise<number> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [BACKFILL_META_KEY])).rows[0];
  if (done) return 0;
  const rows = (await exec(
    db,
    "select id, osk_key, visual_json from skins where status != 'pending' and osk_key is not null",
  )).rows;
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const id = String(row.id);
    const buffer = await readOsk(String(row.osk_key)).catch(() => null);
    if (!buffer) {
      failed += 1;
      logWarn("skin_archive_meta_unreadable", { id, reason: "osk_read_failed" });
      continue;
    }
    const meta = await computeSkinArchiveMeta(buffer).catch(() => null);
    if (!meta) {
      logWarn("skin_archive_meta_undigestible", { id });
      continue;
    }
    const visual = normalizeSkinVisualSignature(parseJson<unknown>(String(row.visual_json ?? "null"), null));
    const noteShapes = classifySkinNoteShapes(visual);
    await exec(
      db,
      "update skins set lane_cover = ?, mania_stage = ?, lazer = ?, note_shape = ?, note_shapes_json = ?, updated_at = ? where id = ?",
      [meta.laneCover ? 1 : 0, meta.maniaStage ? 1 : 0, meta.lazer ? 1 : 0, noteShapes[0] ?? null, JSON.stringify(noteShapes), nowIso(), id],
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
