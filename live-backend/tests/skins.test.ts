import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  appendSkinScreenshot,
  attachSkinOsk,
  attachSkinPreview,
  backfillSkinSlugs,
  createPendingSkin,
  deleteSkin,
  finishSkin,
  getSkin,
  getSkinByRef,
  getSkinForUpload,
  listExpiredPendingSkins,
  listSkins,
  setSkinAccent,
  setSkinHidden,
  SKIN_DESCRIPTION_MAX_LENGTH,
  SKIN_MAX_PENDING_PER_USER,
  SKIN_MAX_PER_USER,
  SKIN_MAX_SCREENSHOTS,
  toSkinSummary,
  upsertSkinKeymodePreview,
} from "../src/features/skins.js";
import { runRetention } from "../src/retention.js";
import { sniffImage, validateOskBuffer } from "../src/skins/validate-osk.js";
import { oskFilename, skinOskKey, skinPreviewKey } from "../src/skins/r2.js";
import { slugifySkinName } from "../src/skins/slug.js";

let dir = "";
let db: Db;

const OWNER = { ownerUserId: 101, ownerUsername: "delta", name: "Cloudy Skies" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-skins-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function createPublishedSkin(input: {
  ownerUserId: number;
  ownerUsername: string;
  name: string;
  keymodes?: number[];
}): Promise<string> {
  const created = await createPendingSkin(db, {
    ownerUserId: input.ownerUserId,
    ownerUsername: input.ownerUsername,
    name: input.name,
  });
  if (!created.ok) throw new Error(`createPendingSkin failed: ${created.error}`);
  const pendingRow = await getSkin(db, created.id);
  if (!pendingRow) throw new Error("pending skin row missing");
  await attachSkinOsk(db, pendingRow, {
    key: skinOskKey(created.id, input.name),
    url: `https://cdn.example/skins/${created.id}/skin.osk`,
    sizeBytes: 1024,
    sha256: "ab".repeat(32),
    keymodes: input.keymodes ?? [4],
    accentColor: "#ff66aa",
    iniAuthor: null,
  });
  await attachSkinPreview(db, created.id, {
    key: skinPreviewKey(created.id, "webp"),
    url: `https://cdn.example/skins/${created.id}/preview.webp`,
    width: 1280,
    height: 720,
  });
  const finished = await finishSkin(db, created.id, created.token);
  if (!finished.ok) throw new Error(`finishSkin failed: ${finished.error}`);
  return created.id;
}

describe("skin slugs", () => {
  it("slugifies names to lowercase ascii kebab-case", () => {
    expect(slugifySkinName("pl0x Aleju03 mix")).toBe("pl0x-aleju03-mix");
    expect(slugifySkinName("  Café ~Zwölf~ 7K!!  ")).toBe("cafe-zwolf-7k");
    expect(slugifySkinName("★彡")).toBe("skin");
    expect(slugifySkinName("a".repeat(120))).toHaveLength(60);
  });

  it("assigns a unique slug at publish and resolves it via getSkinByRef", async () => {
    const first = await createPublishedSkin({ ownerUserId: 1, ownerUsername: "delta", name: "Cloudy Skies" });
    const second = await createPublishedSkin({ ownerUserId: 2, ownerUsername: "echo", name: "Cloudy  Skies!" });

    expect((await getSkin(db, first))?.slug).toBe("cloudy-skies");
    expect((await getSkin(db, second))?.slug).toBe("cloudy-skies-2");

    expect((await getSkinByRef(db, "cloudy-skies"))?.id).toBe(first);
    expect((await getSkinByRef(db, "cloudy-skies-2"))?.id).toBe(second);
    // Pre-slug links carry the raw id; both forms keep resolving.
    expect((await getSkinByRef(db, first))?.id).toBe(first);
    expect(await getSkinByRef(db, "no-such-skin")).toBeNull();
  });

  it("backfills slugs for rows published before the column existed", async () => {
    const id = await createPublishedSkin({ ownerUserId: 3, ownerUsername: "foxtrot", name: "Old Upload" });
    await exec(db, "update skins set slug = null where id = ?", [id]);

    expect(await backfillSkinSlugs(db)).toBe(1);
    expect((await getSkin(db, id))?.slug).toBe("old-upload");

    // Pending rows stay slugless until they publish. The one-shot marker the
    // first call wrote would otherwise short-circuit before the query runs, so
    // this case would pass without ever exercising the pending exclusion.
    await exec(db, "delete from live_meta where key = 'skin_slug_backfill:v1'");
    const pending = await createPendingSkin(db, OWNER);
    if (!pending.ok) throw new Error("pending failed");
    expect(await backfillSkinSlugs(db)).toBe(0);
    expect((await getSkin(db, pending.id))?.slug).toBeNull();
  });

  it("stops scanning for slugless skins once the backfill has succeeded", async () => {
    const id = await createPublishedSkin({ ownerUserId: 4, ownerUsername: "golf", name: "Marked Upload" });
    expect(await backfillSkinSlugs(db)).toBe(0);

    // The marker is now set, so a row that becomes slugless afterwards is left
    // alone: the unindexed "slug is null" scan must not run on every boot.
    await exec(db, "update skins set slug = null where id = ?", [id]);
    expect(await backfillSkinSlugs(db)).toBe(0);
    expect((await getSkin(db, id))?.slug).toBeNull();
  });
});

describe("skins feature", () => {
  it("keeps the client-sampled accent over the skin.ini colour from the .osk", async () => {
    const created = await createPendingSkin(db, OWNER);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The previews upload first and carry the note-art accent; malformed
    // values are ignored, valid ones are normalized to lowercase.
    await setSkinAccent(db, created.id, "red");
    expect((await getSkin(db, created.id))?.accentColor).toBeNull();
    await setSkinAccent(db, created.id, "#BBDFFF");
    expect((await getSkin(db, created.id))?.accentColor).toBe("#bbdfff");

    // The .osk uploads last; its skin.ini colour must not clobber the sample.
    await attachSkinOsk(db, (await getSkin(db, created.id))!, {
      key: skinOskKey(created.id, OWNER.name),
      url: "https://cdn.example/skin.osk",
      sizeBytes: 2048,
      sha256: "cd".repeat(32),
      keymodes: [4],
      accentColor: "#ff0000",
      iniAuthor: null,
    });
    expect((await getSkin(db, created.id))?.accentColor).toBe("#bbdfff");
  });

  it("falls back to the skin.ini colour when no accent was sampled", async () => {
    const created = await createPendingSkin(db, OWNER);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await attachSkinOsk(db, (await getSkin(db, created.id))!, {
      key: skinOskKey(created.id, OWNER.name),
      url: "https://cdn.example/skin.osk",
      sizeBytes: 2048,
      sha256: "cd".repeat(32),
      keymodes: [4],
      accentColor: "#ff0000",
      iniAuthor: null,
    });
    expect((await getSkin(db, created.id))?.accentColor).toBe("#ff0000");
  });

  it("creates a pending skin with a ticket and publishes through the upload flow", async () => {
    const created = await createPendingSkin(db, OWNER);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const pending = await getSkin(db, created.id);
    expect(pending?.status).toBe("pending");
    expect(pending?.uploadToken).toBe(created.token);

    expect(await getSkinForUpload(db, created.id, created.token)).not.toBeNull();
    expect(await getSkinForUpload(db, created.id, "wrong-token")).toBeNull();

    // finish requires the .osk and the composed preview
    expect(await finishSkin(db, created.id, created.token)).toEqual({ ok: false, error: "missing_osk" });
    await attachSkinOsk(db, (await getSkin(db, created.id))!, {
      key: skinOskKey(created.id, OWNER.name),
      url: "https://cdn.example/skin.osk",
      sizeBytes: 2048,
      sha256: "cd".repeat(32),
      keymodes: [4, 7],
      accentColor: "#aabbcc",
      iniAuthor: null,
    });
    expect(await finishSkin(db, created.id, created.token)).toEqual({ ok: false, error: "missing_preview" });
    await attachSkinPreview(db, created.id, { key: "skins/x/preview.webp", url: "https://cdn.example/preview.webp", width: 1280, height: 720 });

    const finished = await finishSkin(db, created.id, created.token);
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.skin.status).toBe("published");
    expect(finished.skin.keymodes).toEqual([4, 7]);
    expect(finished.skin.name).toBe("Cloudy Skies");
    expect("uploadToken" in finished.skin).toBe(false);

    const published = await getSkin(db, created.id);
    expect(published?.uploadToken).toBeNull();
    expect(published?.publishedAt).toBeTruthy();

    // a published skin's ticket is gone: further upload calls are rejected
    expect(await getSkinForUpload(db, created.id, created.token)).toBeNull();
  });

  it("credits the skin author: form value wins, skin.ini fills the gap, search matches it", async () => {
    // No form author: the skin.ini Author lands on the row at osk attach.
    const fromIni = await createPendingSkin(db, OWNER);
    expect(fromIni.ok).toBe(true);
    if (!fromIni.ok) return;
    await attachSkinOsk(db, (await getSkin(db, fromIni.id))!, {
      key: skinOskKey(fromIni.id, OWNER.name),
      url: "https://cdn.example/skin.osk",
      sizeBytes: 2048,
      sha256: "cd".repeat(32),
      keymodes: [4],
      accentColor: null,
      iniAuthor: "  Guden  ",
    });
    expect((await getSkin(db, fromIni.id))?.author).toBe("Guden");

    // A form author survives the ini author from the .osk.
    const fromForm = await createPendingSkin(db, { ...OWNER, name: "another skin", author: "pl0x" });
    expect(fromForm.ok).toBe(true);
    if (!fromForm.ok) return;
    await attachSkinOsk(db, (await getSkin(db, fromForm.id))!, {
      key: skinOskKey(fromForm.id, "another skin"),
      url: "https://cdn.example/skin2.osk",
      sizeBytes: 2048,
      sha256: "cd".repeat(32),
      keymodes: [4],
      accentColor: null,
      iniAuthor: "Guden",
    });
    const formRow = await getSkin(db, fromForm.id);
    expect(formRow?.author).toBe("pl0x");

    // The author is searchable once published.
    await attachSkinPreview(db, fromForm.id, { key: "skins/y/preview.webp", url: "https://cdn.example/p.webp", width: 1280, height: 720 });
    await finishSkin(db, fromForm.id, fromForm.token);
    const byAuthor = await listSkins(db, { q: "pl0x" });
    expect(byAuthor.skins.map((skin) => skin.id)).toEqual([fromForm.id]);
    expect(byAuthor.skins[0].author).toBe("pl0x");
  });

  it("rejects empty names and strips control characters", async () => {
    expect(await createPendingSkin(db, { ...OWNER, name: "   " })).toEqual({ ok: false, error: "invalid_name" });
    const created = await createPendingSkin(db, { ...OWNER, name: "a\u0000b\u001fc" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await getSkin(db, created.id))?.name).toBe("a b c");
  });

  it("stores an optional description, keeping line breaks but not control characters", async () => {
    const created = await createPendingSkin(db, {
      ...OWNER,
      description: "  For 4K jacks.\r\n\r\n\r\nArrow  notes,   dark\u0007 HUD.\n  ".repeat(20),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await getSkin(db, created.id);
    expect(row?.description?.startsWith("For 4K jacks.\n\nArrow notes, dark HUD.")).toBe(true);
    expect(row?.description).not.toMatch(/\n{3,}|\r|\u0007| {2}/);
    expect((row?.description ?? "").length).toBeLessThanOrEqual(SKIN_DESCRIPTION_MAX_LENGTH);
    expect(toSkinSummary(row!).description).toBe(row?.description);

    // omitted or blank descriptions stay null
    const bare = await createPendingSkin(db, { ...OWNER, ownerUserId: 909, name: "No blurb", description: "  \n " });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const bareRow = await getSkin(db, bare.id);
    expect(bareRow?.description).toBeNull();
    expect(toSkinSummary(bareRow!).description).toBeNull();
  });

  it("enforces per-user pending and total caps", async () => {
    for (let i = 0; i < SKIN_MAX_PENDING_PER_USER; i += 1) {
      const created = await createPendingSkin(db, { ...OWNER, name: `Pending ${i}` });
      expect(created.ok).toBe(true);
    }
    expect(await createPendingSkin(db, { ...OWNER, name: "One too many" })).toEqual({ ok: false, error: "pending_limit" });

    // a different user is unaffected
    expect((await createPendingSkin(db, { ...OWNER, ownerUserId: 202, name: "Other user" })).ok).toBe(true);

    // total cap counts all statuses
    await exec(db, "delete from skins where owner_user_id = ?", [OWNER.ownerUserId]);
    for (let i = 0; i < SKIN_MAX_PER_USER; i += 1) {
      await createPublishedSkin({ ownerUserId: OWNER.ownerUserId, ownerUsername: OWNER.ownerUsername, name: `Skin ${i}` });
    }
    expect(await createPendingSkin(db, { ...OWNER, name: "Over the total cap" })).toEqual({ ok: false, error: "skin_limit" });
  });

  it("keeps one preview per keymode, marks the cover, and sorts by downloads", async () => {
    const created = await createPendingSkin(db, OWNER);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    for (const [keys, cover] of [[4, false], [7, true], [4, false]] as Array<[number, boolean]>) {
      const upserted = await upsertSkinKeymodePreview(db, created.id, {
        keys,
        key: `skins/${created.id}/preview-${keys}k.webp`,
        url: `https://cdn.example/preview-${keys}k.webp`,
        width: 1280,
        height: 720,
      }, cover);
      expect(upserted).toEqual({ ok: true });
    }
    const row = await getSkin(db, created.id);
    expect(row?.previews.map((preview) => preview.keys)).toEqual([4, 7]);
    // the cover follows the entry uploaded with isCover
    expect(row?.previewUrl).toBe("https://cdn.example/preview-7k.webp");
    expect(toSkinSummary(row!).previews).toHaveLength(2);

    // downloads sort puts the most-downloaded first regardless of recency
    await exec(db, "delete from skins");
    const first = await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Old But Gold" });
    await createPublishedSkin({ ownerUserId: 2, ownerUsername: "bravo", name: "Fresh" });
    await exec(db, "update skins set download_count = 50 where id = ?", [first]);
    const byDownloads = await listSkins(db, { sort: "downloads" });
    expect(byDownloads.skins.map((skin) => skin.name)).toEqual(["Old But Gold", "Fresh"]);
  });

  it("rejects expired tickets", async () => {
    const created = await createPendingSkin(db, OWNER);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await exec(db, "update skins set token_expires_at = ? where id = ?", [new Date(Date.now() - 1000).toISOString(), created.id]);
    expect(await getSkinForUpload(db, created.id, created.token)).toBeNull();
    expect(await finishSkin(db, created.id, created.token)).toEqual({ ok: false, error: "not_found" });
  });

  it("caps screenshots per skin", async () => {
    const created = await createPendingSkin(db, OWNER);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    for (let i = 0; i < SKIN_MAX_SCREENSHOTS; i += 1) {
      const appended = await appendSkinScreenshot(db, created.id, {
        key: `skins/${created.id}/shot-${i}.webp`,
        url: `https://cdn.example/shot-${i}.webp`,
        width: 1920,
        height: 1080,
      });
      expect(appended).toEqual({ ok: true, index: i });
    }
    expect(await appendSkinScreenshot(db, created.id, { key: "skins/x/shot-4.webp", url: "https://cdn.example/shot-4.webp", width: null, height: null }))
      .toEqual({ ok: false, error: "screenshot_limit" });
  });

  it("lists published skins newest-first with search, keymode filter, and pagination", async () => {
    await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Rainbow Road", keymodes: [4] });
    await createPublishedSkin({ ownerUserId: 2, ownerUsername: "bravo", name: "Midnight 100% Flow", keymodes: [4, 7] });
    await createPublishedSkin({ ownerUserId: 3, ownerUsername: "charlie", name: "Circles", keymodes: [7] });
    // pending rows never show up in the public list
    await createPendingSkin(db, { ...OWNER, name: "Hidden pending" });
    // Publishing back to back can land in the same millisecond; spread the
    // timestamps so newest-first ordering is deterministic.
    await exec(db, "update skins set published_at = '2026-01-01T00:00:01Z' where name = 'Rainbow Road'");
    await exec(db, "update skins set published_at = '2026-01-01T00:00:02Z' where name = 'Midnight 100% Flow'");
    await exec(db, "update skins set published_at = '2026-01-01T00:00:03Z' where name = 'Circles'");

    const all = await listSkins(db, {});
    expect(all.total).toBe(3);
    expect(all.skins.map((skin) => skin.name)).toEqual(["Circles", "Midnight 100% Flow", "Rainbow Road"]);

    // search hits name and uploader username, case-insensitively
    expect((await listSkins(db, { q: "rainbow" })).total).toBe(1);
    expect((await listSkins(db, { q: "BRAVO" })).total).toBe(1);
    expect((await listSkins(db, { q: "charlie" })).total).toBe(1);

    // LIKE wildcards in the query are escaped, not interpreted
    expect((await listSkins(db, { q: "100%" })).total).toBe(1);
    expect((await listSkins(db, { q: "%" })).total).toBe(1);
    expect((await listSkins(db, { q: "_" })).total).toBe(0);

    expect((await listSkins(db, { keymode: 7 })).skins.map((skin) => skin.name)).toEqual(["Circles", "Midnight 100% Flow"]);
    expect((await listSkins(db, { keymode: 9 })).total).toBe(0);

    const paged = await listSkins(db, { page: 1, pageSize: 2 });
    expect(paged.total).toBe(3);
    expect(paged.skins).toHaveLength(1);
  });

  it("hides and unhides skins, excluding hidden ones from the public list", async () => {
    const id = await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Soon Hidden" });
    expect(await setSkinHidden(db, id, true)).toBe(true);
    expect((await listSkins(db, {})).total).toBe(0);
    expect((await listSkins(db, { includeHidden: true })).total).toBe(1);
    expect(await setSkinHidden(db, id, false)).toBe(true);
    expect((await listSkins(db, {})).total).toBe(1);
    // pending rows cannot be hidden
    const created = await createPendingSkin(db, OWNER);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await setSkinHidden(db, created.id, true)).toBe(false);
  });

  it("deletes a skin and returns its storage keys", async () => {
    const id = await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Doomed" });
    await appendSkinScreenshot(db, id, { key: `skins/${id}/shot-0.webp`, url: "https://cdn.example/shot-0.webp", width: null, height: null });
    const deleted = await deleteSkin(db, id);
    expect(deleted?.keys).toHaveLength(3);
    expect(deleted?.keys.every((key) => key.startsWith("skins/"))).toBe(true);
    expect(await getSkin(db, id)).toBeNull();
    expect(await deleteSkin(db, id)).toBeNull();
  });

  it("counts downloads for published skins only", async () => {
    const id = await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Popular" });
    const { recordSkinDownload } = await import("../src/features/skins.js");
    expect(await recordSkinDownload(db, id)).toContain("skin.osk");
    expect(await recordSkinDownload(db, id)).toContain("skin.osk");
    expect((await getSkin(db, id))?.downloadCount).toBe(2);

    await setSkinHidden(db, id, true);
    expect(await recordSkinDownload(db, id)).toBeNull();
    expect((await getSkin(db, id))?.downloadCount).toBe(2);

    const pending = await createPendingSkin(db, OWNER);
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(await recordSkinDownload(db, pending.id)).toBeNull();
    expect(await recordSkinDownload(db, "missing")).toBeNull();
  });

  it("prunes only long-expired pending uploads through retention", async () => {
    const keep = await createPendingSkin(db, { ...OWNER, name: "Fresh pending" });
    const expired = await createPendingSkin(db, { ...OWNER, name: "Abandoned" });
    const published = await createPublishedSkin({ ownerUserId: 9, ownerUsername: "keeper", name: "Durable" });
    expect(keep.ok && expired.ok).toBe(true);
    if (!keep.ok || !expired.ok) return;
    await exec(db, "update skins set token_expires_at = ? where id = ?", [
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      expired.id,
    ]);

    expect((await listExpiredPendingSkins(db, new Date(Date.now() - 60 * 60 * 1000).toISOString())).map((skin) => skin.id))
      .toEqual([expired.id]);

    const results = await runRetention(db, {
      databaseUrl: `file:${join(dir, "test.db")}`,
      scoreEventRetentionDays: 14,
      liveEventRetentionDays: 7,
      doneJobRetentionDays: 2,
      apiCallLogRetentionDays: 7,
      replayVideoJobRetentionDays: 2,
      rankSnapshotRetentionDays: 14,
      activityRetentionYears: 2,
      replayVideoWorkDir: join(dir, "replay-video-jobs"),
      maxLocalDbBytes: Number.MAX_SAFE_INTEGER,
      targetLocalDbBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(results.skinsPendingExpired).toBe(1);
    expect(await getSkin(db, expired.id)).toBeNull();
    expect((await getSkin(db, keep.id))?.status).toBe("pending");
    expect((await getSkin(db, published))?.status).toBe("published");
  });
});

async function buildOsk(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

const VALID_SKIN_INI = `[General]
Name: Cloudy Skies
Author: sona

[Mania]
Keys: 4
ColourLight1: 255,102,170
NoteImage0: mania-note1

[Mania]
Keys: 7
Colour1: 12,12,12
`;

describe("validateOskBuffer", () => {
  it("accepts a real .osk and derives name, author, and sorted keymodes", async () => {
    const buffer = await buildOsk({ "skin.ini": VALID_SKIN_INI, "mania-note1.png": Buffer.from([0x89, 0x50]) });
    const result = await validateOskBuffer(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.name).toBe("Cloudy Skies");
    expect(result.info.author).toBe("sona");
    expect(result.info.keymodes).toEqual([4, 7]);
    expect(result.info.accentColor).toBe("#ff66aa");
    expect(result.info.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finds skin.ini nested in a folder and ignores case", async () => {
    const buffer = await buildOsk({ "My Skin/SKIN.INI": VALID_SKIN_INI });
    const result = await validateOskBuffer(buffer);
    expect(result.ok).toBe(true);
  });

  it("rejects non-zip bytes", async () => {
    expect(await validateOskBuffer(Buffer.from("plain text"))).toEqual({ ok: false, error: "not_a_zip" });
    expect(await validateOskBuffer(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toEqual({ ok: false, error: "not_a_zip" });
  });

  it("rejects a zip without skin.ini", async () => {
    const buffer = await buildOsk({ "readme.txt": "no skin here" });
    expect(await validateOskBuffer(buffer)).toEqual({ ok: false, error: "missing_skin_ini" });
  });

  it("rejects a skin.ini without valid mania keymodes", async () => {
    const noMania = await buildOsk({ "skin.ini": "[General]\nName: x\n" });
    expect(await validateOskBuffer(noMania)).toEqual({ ok: false, error: "no_mania_keymodes" });
    const badKeys = await buildOsk({ "skin.ini": "[Mania]\nKeys: 26\n\n[Mania]\nKeys: 0\n" });
    expect(await validateOskBuffer(badKeys)).toEqual({ ok: false, error: "no_mania_keymodes" });
  });

  it("neutralises crafted path-traversal entry names", async () => {
    // Patch the entry name bytes ("AA/" -> "../") after generating to mimic a
    // crafted zip. JSZip sanitises the name on load ("../escape.txt" loads as
    // "escape.txt"), so the archive validates without any traversal name ever
    // surfacing; the unsafe_paths guard in validateOskBuffer stays as
    // defense-in-depth should that behaviour change.
    const buffer = await buildOsk({ "skin.ini": VALID_SKIN_INI, "AA/escape.txt": "nope" });
    const patched = Buffer.from(buffer.toString("latin1").replaceAll("AA/escape.txt", "../escape.txt"), "latin1");
    const result = await validateOskBuffer(patched);
    expect(result.ok).toBe(true);
  });

  it("aborts on an oversized skin.ini instead of decompressing it", async () => {
    const buffer = await buildOsk({ "skin.ini": `${VALID_SKIN_INI}\n// ${"a".repeat(2 * 1024 * 1024)}` });
    expect(await validateOskBuffer(buffer)).toEqual({ ok: false, error: "skin_ini_too_large" });
  });

  it("skips near-black accent candidates", async () => {
    const buffer = await buildOsk({
      "skin.ini": "[Mania]\nKeys: 4\nColourLight1: 5,5,5\nColour1: 200,40,120\n",
    });
    const result = await validateOskBuffer(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.accentColor).toBe("#c82878");
  });
});

describe("sniffImage", () => {
  it("recognises png, jpeg, and webp magic bytes only", () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpeg");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))?.ext).toBe("webp");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(Buffer.from("GIF89a"))).toBeNull();
  });
});

describe("skin storage keys", () => {
  it("builds safe keys from user-controlled names", () => {
    expect(oskFilename("../../etc/passwd")).toBe("passwd.osk");
    expect(oskFilename("My Cool Skin v2.osk")).toBe("My Cool Skin v2.osk");
    expect(skinOskKey("abc-123", "x/y")).toBe("skins/abc-123/y.osk");
    expect(skinPreviewKey("abc-123", "svg")).toBe("skins/abc-123/preview.png");
  });
});
