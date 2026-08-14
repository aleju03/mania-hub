import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  backfillSkinArchiveMeta,
  classifyKeymodeNoteShape,
  classifySkinNoteShape,
  classifySkinNoteShapes,
  computeSkinArchiveMeta,
} from "../src/skins/archive-meta.js";
import { computeSkinVisualSignature } from "../src/skins/visual-signature.js";

async function buildOsk(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .png()
    .toBuffer();
}

// The community's hide-the-stage blank: a fully transparent pixel under a
// stage element's default filename.
function transparentPng(): Promise<Buffer> {
  return sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png()
    .toBuffer();
}

function stripPng(
  width: number,
  height: number,
  strip: { left?: number; top: number; width?: number; height: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{
      input: {
        create: {
          width: strip.width ?? width,
          height: strip.height,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      },
      left: strip.left ?? 0,
      top: strip.top,
    }])
    .png()
    .toBuffer();
}

// 64x64 raster of a shape, reduced to the visual signature's own 8x8 mean-
// alpha decile grid, so the classifier is tested against masks built exactly
// the way computeSkinVisualSignature builds them.
function maskFromShape(fill: (x: number, y: number) => boolean): string {
  let mask = "";
  for (let cellY = 0; cellY < 8; cellY += 1) {
    for (let cellX = 0; cellX < 8; cellX += 1) {
      let sum = 0;
      for (let y = cellY * 8; y < cellY * 8 + 8; y += 1) {
        for (let x = cellX * 8; x < cellX * 8 + 8; x += 1) {
          sum += fill(x + 0.5, y + 0.5) ? 255 : 0;
        }
      }
      mask += String(Math.min(9, Math.floor(sum / 64 / 25.6)));
    }
  }
  return mask;
}

const CIRCLE_MASK = maskFromShape((x, y) => (x - 32) ** 2 + (y - 32) ** 2 <= 32 ** 2);
// Arrows the way arrow skins actually draw them: a triangular head on a
// narrower shaft. A plain full triangle is deliberately not an arrow to the
// classifier - its base fills both corners like a bar's.
const UP_ARROW_MASK = maskFromShape((x, y) => (y <= 32 ? Math.abs(x - 32) <= y : Math.abs(x - 32) <= 10));
const LEFT_ARROW_MASK = maskFromShape((x, y) => (x <= 32 ? Math.abs(y - 32) <= x : Math.abs(y - 32) <= 10));
const DIAMOND_MASK = maskFromShape((x, y) => Math.abs(x - 32) + Math.abs(y - 32) <= 32);
const FULL_MASK = "9".repeat(64);
// Verbatim v3 digests from the reported catalog false positives. They protect
// the real coarse/anti-aliased geometry, not only ideal SVG primitives.
const GRAY_ROUNDED_SQUARE_MASK = "0799997179999997999999999999999999999999999999997999999717999971";
const MARV_DIAMOND_MASK = "0028820002999920299999928999999889999999299999920299992000289200";
const CIRNO_ARROW_MASK = "0017710001899400189994318999999889999998189994310189940000177100";
const MYU_ARROW_MASK = "0018810001899400189996418999999889999998199996410199940000188100";
const CIRNO_CIRCLE_MASK = "0058850008999980599999958999999889999998599999960899999100588610";

describe("classifyKeymodeNoteShape", () => {
  it("calls wide art a bar whatever its outline", () => {
    expect(classifyKeymodeNoteShape(4, FULL_MASK)).toBe("bar");
    expect(classifyKeymodeNoteShape(2.5, CIRCLE_MASK)).toBe("bar");
  });

  it("calls a filled rectangle a bar only when it runs wide", () => {
    expect(classifyKeymodeNoteShape(1.4, FULL_MASK)).toBe("bar");
    // A solid square note is neither a circle nor a bar.
    expect(classifyKeymodeNoteShape(1, FULL_MASK)).toBe("other");
  });

  it("recognises circles: empty corners, full edges, symmetric both ways", () => {
    expect(classifyKeymodeNoteShape(1, CIRCLE_MASK)).toBe("circle");
  });

  it("recognises arrows by their one-axis asymmetry, whichever way they point", () => {
    expect(classifyKeymodeNoteShape(1, UP_ARROW_MASK)).toBe("arrow");
    expect(classifyKeymodeNoteShape(1, LEFT_ARROW_MASK)).toBe("arrow");
  });

  it("recognises the catalog's real note art, not just synthetic shapes", () => {
    // Verbatim digests from published skins (visual_json in the prod
    // snapshot), the calibration data for the thresholds above. Real
    // arrowheads blur to a much milder asymmetry than a clean triangle, and
    // real bar notes round their corners down from 9 to 4-5.
    const arrowMania4k = "0002820000299800039981004999999949999999039981000029980000028200";
    expect(classifyKeymodeNoteShape(0.89, arrowMania4k)).toBe("arrow");
    const roundedBar = "4999999499999999999999999999999999999999999999999999999949999994";
    expect(classifyKeymodeNoteShape(1.63, roundedBar)).toBe("bar");
    // Thick arrowheads blur much closer to symmetry than the older cutoff
    // allowed. These are Cirno-V1.1 and the shared Myu/Saragi/Quadraphinix art.
    expect(classifyKeymodeNoteShape(0.99, CIRNO_ARROW_MASK)).toBe("arrow");
    expect(classifyKeymodeNoteShape(1, MYU_ARROW_MASK)).toBe("arrow");
  });

  it("leaves a diamond out of the circle and arrow buckets", () => {
    expect(classifyKeymodeNoteShape(1, DIAMOND_MASK)).toBe("other");
    expect(classifyKeymodeNoteShape(1, MARV_DIAMOND_MASK)).toBe("other");
  });

  it("leaves a rounded square out of the circle bucket", () => {
    expect(classifyKeymodeNoteShape(1.02, GRAY_ROUNDED_SQUARE_MASK)).toBe("other");
  });

  it("uses a guarded directional layout when soft arrow art looks round", () => {
    expect(classifyKeymodeNoteShape(1, CIRCLE_MASK)).toBe("circle");
    expect(classifyKeymodeNoteShape(1, CIRCLE_MASK, true)).toBe("arrow");
  });

  it("answers other on a malformed mask", () => {
    expect(classifyKeymodeNoteShape(1, "not a mask")).toBe("other");
  });
});

describe("classifySkinNoteShape", () => {
  const visualOf = (keymodes: Record<string, { aspect: number; mask: string }>) => ({
    v: 3 as const,
    keymodes: Object.fromEntries(Object.entries(keymodes).map(([keys, art]) => [
      keys,
      { ...art, colors: ["#ffffff"], accents: [], sat: 0 },
    ])),
  });

  it("is null without a signature", () => {
    expect(classifySkinNoteShape(null)).toBeNull();
  });

  it("settles a mixed skin by majority", () => {
    const mixed = visualOf({
      4: { aspect: 1, mask: CIRCLE_MASK },
      6: { aspect: 3, mask: FULL_MASK },
      7: { aspect: 3, mask: FULL_MASK },
    });
    expect(classifySkinNoteShape(mixed)).toBe("bar");
    expect(classifySkinNoteShapes(mixed)).toEqual(["bar", "circle"]);
  });

  it("breaks a tie toward the lowest keymode", () => {
    const mixed = visualOf({
      4: { aspect: 1, mask: CIRCLE_MASK },
      7: { aspect: 3, mask: FULL_MASK },
    });
    expect(classifySkinNoteShape(mixed)).toBe("circle");
    expect(classifySkinNoteShapes(mixed)).toEqual(["circle", "bar"]);
  });

  it("labels Cirno by its 4K arrows when its 7K notes are circles", () => {
    expect(classifySkinNoteShape(visualOf({
      4: { aspect: 0.99, mask: CIRNO_ARROW_MASK },
      7: { aspect: 1, mask: CIRNO_CIRCLE_MASK },
    }))).toBe("arrow");
  });

  it("classifies what the real digest pipeline produces", async () => {
    const circleSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#fff"/></svg>';
    const circles = await computeSkinVisualSignature(await buildOsk({
      "skin.ini": "[General]\nName: Round\n\n[Mania]\nKeys: 4\nNoteImage0: note\n",
      "note.png": await sharp(Buffer.from(circleSvg)).png().toBuffer(),
    }));
    expect(classifySkinNoteShape(circles)).toBe("circle");

    const bars = await computeSkinVisualSignature(await buildOsk({
      "skin.ini": "[General]\nName: Flat\n\n[Mania]\nKeys: 4\nNoteImage0: note\n",
      "note.png": await solidPng(64, 16),
    }));
    expect(classifySkinNoteShape(bars)).toBe("bar");
  });
});

describe("computeSkinArchiveMeta", () => {
  const INI = "[General]\nName: Plain\n\n[Mania]\nKeys: 4\n";

  it("reads a plain stable skin as nothing special", async () => {
    const meta = await computeSkinArchiveMeta(await buildOsk({ "skin.ini": INI }));
    expect(meta).toEqual({ laneCover: false, maniaStage: false, lazer: false });
  });

  it("spots lazer's editor files by name, nested or not", async () => {
    const bySkininfo = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "skininfo.json": '{"Name":"x","Creator":"y","InstantiationInfo":"osu.Game.Skinning.LegacySkin, osu.Game"}',
    }));
    expect(bySkininfo?.lazer).toBe(true);
    const byLayout = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "Some Folder/MainHUDComponents.json": "[]",
    }));
    expect(byLayout?.lazer).toBe(true);
  });

  it("spots the comment older lazer builds appended to skin.ini", async () => {
    const meta = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": `${INI}\n// The following content was automatically added by osu! in order to use metadata that more closely matches user expectations.\n[General]\nName: Plain\n`,
    }));
    expect(meta?.lazer).toBe(true);
  });

  it("counts stage rails by default filename or by a resolvable skin.ini reference", async () => {
    const byName = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-left@2x.png": await solidPng(8, 8),
    }));
    expect(byName?.maniaStage).toBe(true);
    const byReference = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": "[General]\nName: Custom\n\n[Mania]\nKeys: 4\nStageLeft: art/frame\n",
      "art/frame.png": await solidPng(8, 8),
    }));
    expect(byReference?.maniaStage).toBe(true);
    // A reference to a file the archive does not ship is not stage art.
    const dangling = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": "[General]\nName: Custom\n\n[Mania]\nKeys: 4\nStageLeft: art/frame\n",
    }));
    expect(dangling?.maniaStage).toBe(false);
    // ...but the default filename still backs a broken reference, the way the
    // preview renderer resolves it.
    const brokenWithRealDefault = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": "[General]\nName: Custom\n\n[Mania]\nKeys: 4\nStageLeft: art/frame\n",
      "mania-stage-left.png": await solidPng(8, 8),
    }));
    expect(brokenWithRealDefault?.maniaStage).toBe(true);
  });

  it("does not call a hidden stage a stage, whatever files the zip carries", async () => {
    // The circle-template layout: the ini points the rails at files that are
    // not there, the default names hold fully transparent blanks, and the
    // shipped mania-stage-bottom is a featureless slab. Nothing of a stage
    // ever reaches the screen, so the skin does not include one.
    const template = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": "[General]\nName: Hidden\n\n[Mania]\nKeys: 4\nStageLeft: art/nothing\nStageRight: art/nothing\n\n[Mania]\nKeys: 5\n",
      "mania-stage-left.png": await transparentPng(),
      "mania-stage-right.png": await transparentPng(),
      "mania-stage-bottom.png": await solidPng(380, 141),
    }));
    expect(template?.maniaStage).toBe(false);
    // Bottom art alone is not a stage design either.
    const bottomOnly = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-bottom.png": await solidPng(380, 141),
    }));
    expect(bottomOnly?.maniaStage).toBe(false);
    // A real rail in any keymode block still counts.
    const mixed = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": "[General]\nName: Mixed\n\n[Mania]\nKeys: 4\nStageLeft: art/nothing\n\n[Mania]\nKeys: 7\nStageLeft: art/frame\n",
      "art/frame.png": await solidPng(8, 8),
    }));
    expect(mixed?.maniaStage).toBe(true);
  });

  it("finds a lane cover by filename", async () => {
    const meta = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "Lane Cover/mania-stage-hint@2x.png": await solidPng(8, 8),
    }));
    expect(meta?.laneCover).toBe(true);
  });

  it("finds a lane cover shipped as an oversized stage hint, scale-aware", async () => {
    const tall = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-hint.png": await solidPng(64, 400),
    }));
    expect(tall?.laneCover).toBe(true);
    // The same 400px drawn at @2x is 200 at 1x, right on the line; a plain
    // judgement-line hint stays well under it either way.
    const short = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-hint.png": await solidPng(64, 40),
    }));
    expect(short?.laneCover).toBe(false);
  });

  it("finds lane covers drawn at the top by an over-height StageBottom canvas", async () => {
    // saragi circle: the 576px canvas is bottom-aligned in stable's 480px
    // stage, so rows 96-140 of this top strip remain visible at y=0-44.
    const saragi = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-bottom.png": await stripPng(380, 576, { top: 0, height: 141 }),
      "mania-stage-hint.png": await transparentPng(),
    }));
    expect(saragi?.laneCover).toBe(true);

    // cool kalm tekkito: @2x makes this a 484.5-unit canvas whose top art
    // occupies roughly the first 58 visible units of the playfield.
    const kalm = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-bottom@2x.png": await stripPng(767, 969, { left: 97, top: 0, width: 567, height: 125 }),
    }));
    expect(kalm?.laneCover).toBe(true);
  });

  it("does not confuse ordinary bottom decks or tall side decorations for lane covers", async () => {
    const ordinary = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-bottom.png": await solidPng(380, 141),
    }));
    expect(ordinary?.laneCover).toBe(false);

    const bottomOnly = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-bottom.png": await stripPng(380, 576, { top: 435, height: 141 }),
    }));
    expect(bottomOnly?.laneCover).toBe(false);

    const sideOnly = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-bottom.png": await stripPng(380, 576, { left: 0, top: 0, width: 40, height: 141 }),
    }));
    expect(sideOnly?.laneCover).toBe(false);
  });

  it("checks every keymode hint and resolves animated stage assets", async () => {
    const laterKeymode = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": `${INI}StageHint: hints/short\n\n[Mania]\nKeys: 7\nStageHint: hints/cover\n`,
      "hints/short.png": await solidPng(64, 40),
      "hints/cover.png": await solidPng(64, 300),
    }));
    expect(laterKeymode?.laneCover).toBe(true);

    const animated = await computeSkinArchiveMeta(await buildOsk({
      "skin.ini": INI,
      "mania-stage-hint-0.png": await solidPng(64, 300),
    }));
    expect(animated?.laneCover).toBe(true);
  });

  it("answers null on bytes that are not a zip", async () => {
    expect(await computeSkinArchiveMeta(Buffer.from("nope"))).toBeNull();
  });
});

describe("backfillSkinArchiveMeta", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-skin-meta-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function seedSkin(id: string, oskKey: string, visualJson: string | null): Promise<void> {
    await exec(
      db,
      `insert into skins (id, owner_user_id, owner_username, name, status, visibility, osk_key, visual_json, created_at, updated_at)
       values (?, 1, 'delta', ?, 'published', 'public', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [id, id, oskKey, visualJson],
    );
  }

  it("fills the flag columns and the note shape from the stored signature, once", async () => {
    const visual = {
      v: 3,
      keymodes: { 4: { aspect: 1, mask: CIRCLE_MASK, colors: ["#ffffff"], accents: [], sat: 0 } },
    };
    await seedSkin("with-cover", "skins/with-cover/skin.osk", JSON.stringify(visual));
    await seedSkin("plain", "skins/plain/skin.osk", null);
    const archives = new Map<string, Buffer>([
      ["skins/with-cover/skin.osk", await buildOsk({
        "skin.ini": "[General]\nName: A\n\n[Mania]\nKeys: 4\n",
        "lanecover.png": await solidPng(8, 8),
        "skininfo.json": "{}",
      })],
      ["skins/plain/skin.osk", await buildOsk({ "skin.ini": "[General]\nName: B\n\n[Mania]\nKeys: 4\n" })],
    ]);
    const reads: string[] = [];
    const readOsk = (key: string) => {
      reads.push(key);
      return Promise.resolve(archives.get(key) ?? null);
    };

    expect(await backfillSkinArchiveMeta(db, readOsk)).toBe(2);
    const flagged = (await exec(db, "select lane_cover, mania_stage, lazer, note_shape from skins where id = 'with-cover'")).rows[0];
    expect(flagged).toMatchObject({ lane_cover: 1, mania_stage: 0, lazer: 1, note_shape: "circle" });
    const plain = (await exec(db, "select lane_cover, lazer, note_shape from skins where id = 'plain'")).rows[0];
    expect(plain).toMatchObject({ lane_cover: 0, lazer: 0, note_shape: null });

    // The marker holds: a second boot re-reads nothing.
    reads.length = 0;
    expect(await backfillSkinArchiveMeta(db, readOsk)).toBe(0);
    expect(reads).toEqual([]);
  });

  it("does not write the one-shot marker when every read failed", async () => {
    await seedSkin("unreachable", "skins/unreachable/skin.osk", null);
    expect(await backfillSkinArchiveMeta(db, () => Promise.resolve(null))).toBe(0);
    const marker = (await exec(db, "select 1 from live_meta where key like 'skin_archive_meta_backfill%'")).rows[0];
    expect(marker).toBeUndefined();
    // Storage back: the next boot finishes the sweep and seals it.
    const osk = await buildOsk({ "skin.ini": "[General]\nName: C\n\n[Mania]\nKeys: 4\n" });
    expect(await backfillSkinArchiveMeta(db, () => Promise.resolve(osk))).toBe(1);
  });
});
