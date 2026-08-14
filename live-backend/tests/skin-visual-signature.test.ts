import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { attachSkinOsk, attachSkinPreview, createPendingSkin, finishSkin, getSkin } from "../src/features/skins.js";
import { SKIN_SIMILARITY_FLOOR, skinSimilarity } from "../src/skins/similarity.js";
import { backfillSkinVisualSignatures, computeSkinVisualSignature } from "../src/skins/visual-signature.js";

function solidPng(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer();
}

function circlePng(size: number, fill: string): Promise<Buffer> {
  const radius = size / 2 - 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${fill}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function arrowPng(size: number, fill: string, rotation: number): Promise<Buffer> {
  const points = "4,32 38,4 38,19 60,19 60,45 38,45 38,60";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><polygon points="${points}" fill="${fill}" transform="rotate(${rotation} 32 32)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function buildOsk(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

const BAR_INI = "[General]\nName: Bars\nAuthor: sona\n\n[Mania]\nKeys: 4\nNoteImage0: whitenote\nNoteImage1: bluenote\n";
const DEFAULTS_INI = "[General]\nName: Circles\n\n[Mania]\nKeys: 4\n";

async function buildBarOsk(): Promise<Buffer> {
  return buildOsk({
    "skin.ini": BAR_INI,
    "whitenote.png": await solidPng(64, 16, { r: 255, g: 255, b: 255 }),
    "bluenote.png": await solidPng(64, 16, { r: 102, g: 204, b: 255 }),
  });
}

describe("computeSkinVisualSignature", () => {
  it("digests bar notes: wide aspect, full mask, one colour per distinct sprite", async () => {
    const signature = await computeSkinVisualSignature(await buildBarOsk());
    const art = signature?.keymodes["4"];
    expect(art).toBeDefined();
    if (!art) return;
    expect(art.aspect).toBeCloseTo(4);
    expect(art.mask).toBe("9".repeat(64));
    expect(art.colors).toEqual(["#ffffff", "#66ccff"]);
  });

  it("digests round notes through the default filenames, corners empty", async () => {
    // No NoteImage keys at all: stable's default resolution has to find
    // mania-note1/2, nested a folder deep and @2x, like real uploads ship.
    const signature = await computeSkinVisualSignature(await buildOsk({
      "skin.ini": DEFAULTS_INI,
      "art/mania-note1@2x.png": await circlePng(64, "#ffffff"),
      "art/mania-note2.png": await circlePng(64, "#88ff88"),
    }));
    const art = signature?.keymodes["4"];
    expect(art).toBeDefined();
    if (!art) return;
    expect(art.aspect).toBeCloseTo(1, 1);
    // The trimmed corners of a circle hold almost nothing.
    const corner = Number(art.mask[0]);
    const center = Number(art.mask[3 * 8 + 3]);
    expect(corner).toBeLessThanOrEqual(2);
    expect(center).toBe(9);
    expect(art.colors).toHaveLength(2);
  });

  it("digests every keymode block with its own art", async () => {
    // Circles in 4K, bars in 6K: one skin, two looks. Both keymodes digest,
    // each from the art its own block names.
    const signature = await computeSkinVisualSignature(await buildOsk({
      "skin.ini": "[General]\nName: Mixed\n\n"
        + "[Mania]\nKeys: 4\nNoteImage0: round\nNoteImage1: round\nNoteImage2: round\nNoteImage3: round\n\n"
        + "[Mania]\nKeys: 6\nNoteImage0: flat\nNoteImage1: flat\nNoteImage2: flat\nNoteImage3: flat\nNoteImage4: flat\nNoteImage5: flat\n",
      "round.png": await circlePng(64, "#ffffff"),
      "flat.png": await solidPng(64, 16, { r: 255, g: 255, b: 255 }),
    }));
    expect(signature).not.toBeNull();
    if (!signature) return;
    expect(Object.keys(signature.keymodes).sort()).toEqual(["4", "6"]);
    expect(signature.keymodes["4"].aspect).toBeCloseTo(1, 1);
    expect(signature.keymodes["6"].aspect).toBeCloseTo(4);
  });

  it("retains guarded directional arrow assignments when high-resolution geometry supports them", async () => {
    const arrows = await computeSkinVisualSignature(await buildOsk({
      "skin.ini": "[General]\nName: Soft arrows\n\n[Mania]\nKeys: 4\n"
        + "NoteImage0: arrows/LEFT\nNoteImage1: arrows/DOWN\n"
        + "NoteImage2: arrows/UP\nNoteImage3: arrows/RIGHT\n",
      "arrows/LEFT.png": await arrowPng(64, "#aaccff", 0),
      "arrows/DOWN.png": await arrowPng(64, "#aaccff", -90),
      "arrows/UP.png": await arrowPng(64, "#aaccff", 90),
      "arrows/RIGHT.png": await arrowPng(64, "#aaccff", 180),
      // These are unused alternatives. Their @2x suffix must not beat the
      // exact 1x paths above merely because suffix recovery can find them.
      "mania/arrows/left@2x.png": await circlePng(128, "#aaccff"),
      "mania/arrows/down@2x.png": await circlePng(128, "#aaccff"),
      "mania/arrows/up@2x.png": await circlePng(128, "#aaccff"),
      "mania/arrows/right@2x.png": await circlePng(128, "#aaccff"),
    }));
    expect(arrows?.keymodes["4"].arrowLayout).toBe(true);
  });

  it("does not let inherited arrow paths override flat circle geometry", async () => {
    const round = await circlePng(64, "#aaccff");
    const directionalNames = await computeSkinVisualSignature(await buildOsk({
      "skin.ini": "[General]\nName: Circles in an arrow template\n\n[Mania]\nKeys: 4\n"
        + "NoteImage0: mania/arrows/left\nNoteImage1: mania/arrows/down\n"
        + "NoteImage2: mania/arrows/up\nNoteImage3: mania/arrows/right\n",
      "mania/arrows/left.png": round,
      "mania/arrows/down.png": round,
      "mania/arrows/up.png": round,
      "mania/arrows/right.png": round,
    }));
    expect(directionalNames?.keymodes["4"].arrowLayout).toBeUndefined();

    // A copied rounded note living under arrows/ and reused in every column is
    // not directional evidence (the gray Malevich false positive).
    const repeated = await computeSkinVisualSignature(await buildOsk({
      "skin.ini": "[General]\nName: Rounded square\n\n[Mania]\nKeys: 4\n"
        + "NoteImage0: mania/arrows/left\nNoteImage1: mania/arrows/left\n"
        + "NoteImage2: mania/arrows/left\nNoteImage3: mania/arrows/left\n",
      "mania/arrows/left.png": round,
    }));
    expect(repeated?.keymodes["4"].arrowLayout).toBeUndefined();
  });

  it("digests nothing without note art or skin.ini", async () => {
    expect(await computeSkinVisualSignature(await buildOsk({ "skin.ini": DEFAULTS_INI }))).toBeNull();
    expect(await computeSkinVisualSignature(await buildOsk({ "readme.txt": "hi" }))).toBeNull();
    expect(await computeSkinVisualSignature(Buffer.from("not a zip"))).toBeNull();
  });

  it("keeps computed bar and circle skins apart in the scoring", async () => {
    const bar = await computeSkinVisualSignature(await buildBarOsk());
    const circle = await computeSkinVisualSignature(await buildOsk({
      "skin.ini": DEFAULTS_INI,
      "mania-note1.png": await circlePng(64, "#ffffff"),
      "mania-note2.png": await circlePng(64, "#66ccff"),
    }));
    expect(bar).not.toBeNull();
    expect(circle).not.toBeNull();
    // Same palette, same keymodes, and still no recommendation either way:
    // this is the circles-under-a-bar-skin strip from the bug report.
    const score = skinSimilarity(
      { author: null, keymodes: [4], accentColor: null, visual: bar },
      { author: null, keymodes: [4], accentColor: null, visual: circle },
    );
    expect(score).toBeLessThan(SKIN_SIMILARITY_FLOOR);
    const barTwin = skinSimilarity(
      { author: null, keymodes: [4], accentColor: null, visual: bar },
      { author: null, keymodes: [4], accentColor: null, visual: bar },
    );
    expect(barTwin).toBeGreaterThan(SKIN_SIMILARITY_FLOOR);
  });
});

describe("backfillSkinVisualSignatures", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-skin-visual-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function publishBare(name: string, sha: string): Promise<string> {
    const created = await createPendingSkin(db, { ownerUserId: 1, ownerUsername: "delta", name });
    if (!created.ok) throw new Error("createPendingSkin failed");
    const row = await getSkin(db, created.id);
    if (!row) throw new Error("row missing");
    await attachSkinOsk(db, row, {
      key: `skins/${created.id}/skin.osk`,
      url: `https://cdn.example/${created.id}/skin.osk`,
      sizeBytes: 1024,
      sha256: sha,
      keymodes: [4],
      specialKeymodes: [],
      accentColor: "#ff66aa",
      iniAuthor: null,
    });
    await attachSkinPreview(db, created.id, {
      key: `skins/${created.id}/preview.webp`,
      url: `https://cdn.example/${created.id}/preview.webp`,
      width: 1280,
      height: 720,
    });
    const finished = await finishSkin(db, created.id, created.token);
    if (!finished.ok) throw new Error("finishSkin failed");
    return created.id;
  }

  it("digests the existing catalog once, tolerating skins it cannot read", async () => {
    const digestible = await publishBare("Bars", "01".repeat(32));
    const unreadable = await publishBare("Gone", "02".repeat(32));
    const osk = await buildBarOsk();

    const readOsk = async (key: string) => (key.includes(digestible) ? osk : null);
    expect(await backfillSkinVisualSignatures(db, readOsk)).toBe(1);
    expect((await getSkin(db, digestible))?.visual?.keymodes["4"].aspect).toBeCloseTo(4);
    expect((await getSkin(db, digestible))?.noteShape).toBe("bar");
    expect((await getSkin(db, unreadable))?.visual).toBeNull();

    // One skin failing does not stall the marker: the scan must not re-read
    // the whole catalog from R2 on every boot.
    await exec(db, "update skins set visual_json = null where id = ?", [digestible]);
    expect(await backfillSkinVisualSignatures(db, readOsk)).toBe(0);
  });

  it("retries next boot when every read failed (storage down)", async () => {
    await publishBare("Bars", "01".repeat(32));
    expect(await backfillSkinVisualSignatures(db, async () => null)).toBe(0);
    // No marker was written, so a boot with storage back digests the catalog.
    const osk = await buildBarOsk();
    expect(await backfillSkinVisualSignatures(db, async () => osk)).toBe(1);
  });
});
