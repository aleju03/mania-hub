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
  clearSimilarSkinsCache,
  createPendingSkin,
  deleteSkin,
  findPublishedSkinByOskSha256,
  finishSkin,
  finishSkinEdit,
  getSkin,
  getSkinByRef,
  getSkinForEdit,
  getSkinForUpload,
  listExpiredPendingSkins,
  listSimilarSkins,
  listSkins,
  privateSkinSecretMatches,
  recordSkinDownload,
  renameSkin,
  replaceSkinOsk,
  setSkinVisibility,
  setSkinAccent,
  setSkinCoverKeymode,
  setSkinHidden,
  setSkinSpecialKeymodes,
  SKIN_DESCRIPTION_MAX_LENGTH,
  SKIN_MAX_PENDING_PER_USER,
  SKIN_MAX_PER_USER,
  SKIN_MAX_SCREENSHOTS,
  startSkinEdit,
  toSkinSummary,
  upsertSkinKeymodePreview,
} from "../src/features/skins.js";
import { runRetention } from "../src/retention.js";
import { hasSpecialColumnSeparator, sniffImage, validateOskBuffer } from "../src/skins/validate-osk.js";
import { backfillSkinSpecialKeymodes } from "../src/skins/special-backfill.js";
import { copySkinObject, deleteSkinObjects, isPrivateSkinKey, nextSkinOskRevision, nextSkinPreviewRevision, oskFilename, privateSkinKey, skinKeymodePreviewKey, skinObjectDeletesEnabled, skinOskKey, skinPreviewKey } from "../src/skins/r2.js";
import { collectReplaySkinAssetPaths, replaySkinBundleVersion } from "../src/skins/replay-bundle.js";
import { slugifySkinName } from "../src/skins/slug.js";

let dir = "";
let db: Db;

const OWNER = { ownerUserId: 101, ownerUsername: "delta", name: "Cloudy Skies" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-skins-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  // The similar-skins caches live in the process, not the database, so a
  // fresh database per test needs them dropped or one test's catalog answers
  // the next one's questions.
  clearSimilarSkinsCache();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function createPublishedSkin(input: {
  ownerUserId: number;
  ownerUsername: string;
  name: string;
  keymodes?: number[];
  specialKeymodes?: number[];
  sha256?: string;
  visibility?: "public" | "private";
  author?: string | null;
  accent?: string | null;
}): Promise<string> {
  const created = await createPendingSkin(db, {
    ownerUserId: input.ownerUserId,
    ownerUsername: input.ownerUsername,
    name: input.name,
    visibility: input.visibility,
  });
  if (!created.ok) throw new Error(`createPendingSkin failed: ${created.error}`);
  const pendingRow = await getSkin(db, created.id);
  if (!pendingRow) throw new Error("pending skin row missing");
  await attachSkinOsk(db, pendingRow, {
    key: skinOskKey(created.id, input.name),
    url: `https://cdn.example/skins/${created.id}/skin.osk`,
    sizeBytes: 1024,
    sha256: input.sha256 ?? "ab".repeat(32),
    keymodes: input.keymodes ?? [4],
    specialKeymodes: input.specialKeymodes ?? [],
    accentColor: input.accent === undefined ? "#ff66aa" : input.accent,
    iniAuthor: input.author ?? null,
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
      specialKeymodes: [],
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
      specialKeymodes: [],
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
      specialKeymodes: [],
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
      specialKeymodes: [],
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
      specialKeymodes: [],
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
      expect(upserted.ok).toBe(true);
    }
    const row = await getSkin(db, created.id);
    expect(row?.previews.map((preview) => preview.keys)).toEqual([4, 7]);
    // the cover follows the entry uploaded with isCover
    expect(row?.previewUrl).toBe("https://cdn.example/preview-7k.webp");
    expect(toSkinSummary(row!).previews).toHaveLength(2);

    // downloads sort puts the most-downloaded first regardless of recency
    await exec(db, "delete from skins");
    const first = await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Old But Gold" });
    const fresh = await createPublishedSkin({ ownerUserId: 2, ownerUsername: "bravo", name: "Fresh" });
    await exec(db, "update skins set download_count = 50 where id = ?", [first]);
    // A day apart, so the date sorts below cannot tie on the publish clock.
    await exec(db, "update skins set published_at = ? where id = ?", ["2026-01-01T00:00:00.000Z", first]);
    await exec(db, "update skins set published_at = ? where id = ?", ["2026-01-02T00:00:00.000Z", fresh]);
    const byDownloads = await listSkins(db, { sort: "downloads" });
    expect(byDownloads.skins.map((skin) => skin.name)).toEqual(["Old But Gold", "Fresh"]);
    const byFewestDownloads = await listSkins(db, { sort: "downloads-asc" });
    expect(byFewestDownloads.skins.map((skin) => skin.name)).toEqual(["Fresh", "Old But Gold"]);

    // the date option's own flip: publish order, earliest first
    const byOldest = await listSkins(db, { sort: "oldest" });
    expect(byOldest.skins.map((skin) => skin.name)).toEqual(["Old But Gold", "Fresh"]);

    // size sort is largest .osk first, whatever the recency or downloads say;
    // a row with no stored file sinks to the bottom rather than erroring.
    const small = await createPublishedSkin({ ownerUserId: 3, ownerUsername: "charlie", name: "Tiny" });
    await exec(db, "update skins set osk_size_bytes = 99999 where id != ?", [first]);
    await exec(db, "update skins set osk_size_bytes = 10 where id = ?", [small]);
    await exec(db, "update skins set osk_size_bytes = null where id = ?", [first]);
    const bySize = await listSkins(db, { sort: "size" });
    expect(bySize.skins.map((skin) => skin.name)).toEqual(["Fresh", "Tiny", "Old But Gold"]);

    // the same option flipped: smallest first, and the file-less row stays at
    // the bottom instead of counting as the smallest of all.
    const bySizeAsc = await listSkins(db, { sort: "size-asc" });
    expect(bySizeAsc.skins.map((skin) => skin.name)).toEqual(["Tiny", "Fresh", "Old But Gold"]);
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

  it("narrows the list to one uploader without widening what it may show", async () => {
    await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Alpha One", sha256: "a1".repeat(32) });
    await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Alpha Two", sha256: "a2".repeat(32) });
    await createPublishedSkin({ ownerUserId: 2, ownerUsername: "bravo", name: "Bravo One", sha256: "b1".repeat(32) });
    await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Alpha Secret", visibility: "private", sha256: "a3".repeat(32) });

    const mine = await listSkins(db, { ownerUserId: 1 });
    expect(mine.total).toBe(2);
    expect(mine.skins.map((skin) => skin.name).sort()).toEqual(["Alpha One", "Alpha Two"]);
    // The owner filter is public: asking for someone else's uploads still gets
    // only their public catalog.
    expect((await listSkins(db, { ownerUserId: 2 })).skins.map((skin) => skin.name)).toEqual(["Bravo One"]);
    // Their private skin joins the list only where the caller was already
    // vouched for as that owner (the shelf's own read).
    expect((await listSkins(db, { ownerUserId: 1, privateOwnerUserId: 1 })).total).toBe(3);
    // And it stays out of an owner filter with no viewer behind it.
    expect((await listSkins(db, { ownerUserId: 1, privateOwnerUserId: 2 })).total).toBe(2);
    // Filters compose rather than replace each other.
    expect((await listSkins(db, { ownerUserId: 1, q: "two" })).total).toBe(1);
    expect((await listSkins(db, { ownerUserId: 999 })).total).toBe(0);
    expect((await listSkins(db, { ownerUserId: 0 })).total).toBe(3);
  });

  it("splits an 8K keymode filter into real 8K and 7K+1 via keymodeVariant", async () => {
    await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "True Eight", keymodes: [4, 8] });
    await createPublishedSkin({ ownerUserId: 2, ownerUsername: "bravo", name: "Scratch Eight", keymodes: [4, 8], specialKeymodes: [8] });

    expect((await listSkins(db, { keymode: 8 })).total).toBe(2);
    expect((await listSkins(db, { keymode: 8, keymodeVariant: "regular" })).skins.map((skin) => skin.name)).toEqual(["True Eight"]);
    expect((await listSkins(db, { keymode: 8, keymodeVariant: "special" })).skins.map((skin) => skin.name)).toEqual(["Scratch Eight"]);
    // The variant only refines a keymode filter; 4K sees both skins.
    expect((await listSkins(db, { keymode: 4, keymodeVariant: "special" })).total).toBe(0);
    expect((await listSkins(db, { keymode: 4, keymodeVariant: "regular" })).total).toBe(2);
    // And the summary carries the layout for the cards to label.
    const special = (await listSkins(db, { keymode: 8, keymodeVariant: "special" })).skins[0];
    expect(special.specialKeymodes).toEqual([8]);
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
      nodeEnv: "test",
      livePublicOrigin: "http://localhost:7227",
    });

    expect(results.skinsPendingExpired).toBe(1);
    expect(await getSkin(db, expired.id)).toBeNull();
    expect((await getSkin(db, keep.id))?.status).toBe("pending");
    expect((await getSkin(db, published))?.status).toBe("published");
  });
});

describe("similar skins", () => {
  it("ranks the catalog by accent, keymodes and author, and trims the junk", async () => {
    const target = await createPublishedSkin({
      ownerUserId: 1, ownerUsername: "delta", name: "Target",
      keymodes: [4], accent: "#ff66aa", author: "sona", sha256: "01".repeat(32),
    });
    // Same hand, near colour: the skinner's own series should lead the strip.
    await createPublishedSkin({
      ownerUserId: 2, ownerUsername: "echo", name: "Series Two",
      keymodes: [4], accent: "#ff5599", author: "sona", sha256: "02".repeat(32),
    });
    // Someone else's near-identical colourway lands behind it.
    await createPublishedSkin({
      ownerUserId: 3, ownerUsername: "foxtrot", name: "Lookalike",
      keymodes: [4], accent: "#ff77bb", author: "nova", sha256: "03".repeat(32),
    });
    // Different keymode, different hand, far colour: under the floor, absent.
    await createPublishedSkin({
      ownerUserId: 4, ownerUsername: "golf", name: "Unrelated",
      keymodes: [10], accent: "#113322", author: "nova", sha256: "04".repeat(32),
    });

    const row = await getSkin(db, target);
    expect(row).not.toBeNull();
    if (!row) return;
    const strip = await listSimilarSkins(db, row, 6);
    expect(strip.map((skin) => skin.name)).toEqual(["Series Two", "Lookalike"]);
    // The target never recommends itself.
    expect(strip.some((skin) => skin.id === target)).toBe(false);

    expect((await listSimilarSkins(db, row, 1)).map((skin) => skin.name)).toEqual(["Series Two"]);
  });

  it("caches the strip but notices the catalog moving under it", async () => {
    const target = await createPublishedSkin({
      ownerUserId: 1, ownerUsername: "delta", name: "Target",
      keymodes: [4], accent: "#ff66aa", author: "sona", sha256: "01".repeat(32),
    });
    const row = await getSkin(db, target);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(await listSimilarSkins(db, row, 6)).toEqual([]);

    // A publish has to reach a strip that was cached as empty.
    await createPublishedSkin({
      ownerUserId: 2, ownerUsername: "echo", name: "Newcomer",
      keymodes: [4], accent: "#ff5599", author: "sona", sha256: "02".repeat(32),
    });
    expect((await listSimilarSkins(db, row, 6)).map((skin) => skin.name)).toEqual(["Newcomer"]);

    // So does a moderation hide, which changes no count the strip itself
    // holds - only the row's status and updated_at.
    const hidden = (await exec(db, "select id from skins where name = 'Newcomer'")).rows[0];
    await setSkinHidden(db, String(hidden.id), true);
    expect(await listSimilarSkins(db, row, 6)).toEqual([]);
  });

  it("only ever recommends what the public catalog shows", async () => {
    const target = await createPublishedSkin({
      ownerUserId: 1, ownerUsername: "delta", name: "Target",
      keymodes: [4], accent: "#ff66aa", author: "sona", sha256: "01".repeat(32),
    });
    // A private twin and a hidden twin would both top the ranking; neither may
    // appear, no matter how similar.
    await createPublishedSkin({
      ownerUserId: 2, ownerUsername: "echo", name: "Hoarded Twin",
      keymodes: [4], accent: "#ff66aa", author: "sona", sha256: "02".repeat(32),
      visibility: "private",
    });
    const hidden = await createPublishedSkin({
      ownerUserId: 3, ownerUsername: "foxtrot", name: "Hidden Twin",
      keymodes: [4], accent: "#ff66aa", author: "sona", sha256: "03".repeat(32),
    });
    await setSkinHidden(db, hidden, true);

    const row = await getSkin(db, target);
    expect(row).not.toBeNull();
    if (!row) return;
    expect(await listSimilarSkins(db, row, 6)).toEqual([]);
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

describe("bulk upload limits", () => {
  it("lets an admin seeding run past the per-user caps, duplicates aside", async () => {
    // Fill the account to the cap, with one known .osk hash among them.
    for (let index = 0; index < SKIN_MAX_PER_USER - 1; index += 1) {
      await createPublishedSkin({
        ownerUserId: OWNER.ownerUserId,
        ownerUsername: OWNER.ownerUsername,
        name: `Seed ${index}`,
        sha256: index.toString(16).padStart(2, "0").repeat(32),
      });
    }
    const alreadyHere = await createPublishedSkin({ ...OWNER, name: "Already here", sha256: "ee".repeat(32) });

    expect((await createPendingSkin(db, OWNER))).toMatchObject({ ok: false, error: "skin_limit" });

    // The seeding run keeps going, and past the pending cap too: a run leaves
    // half-finished rows behind whenever a file fails mid-upload.
    for (let index = 0; index <= SKIN_MAX_PENDING_PER_USER; index += 1) {
      expect((await createPendingSkin(db, { ...OWNER, bypassLimits: true })).ok).toBe(true);
    }

    // Uploading a file the site already has is still refused, caps or not.
    const duplicate = await createPendingSkin(db, { ...OWNER, bypassLimits: true, oskSha256: "ee".repeat(32) });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok || duplicate.error !== "duplicate") throw new Error("expected a duplicate rejection");
    expect(duplicate.duplicate.id).toBe(alreadyHere);
  });
});

describe("duplicate .osk guard", () => {
  const HASH = "1f".repeat(32);

  it("refuses a ticket for bytes a published skin already carries", async () => {
    const existing = await createPublishedSkin({ ownerUserId: 7, ownerUsername: "sona", name: "Frost", sha256: HASH });

    const result = await createPendingSkin(db, { ...OWNER, oskSha256: HASH });

    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "duplicate") throw new Error("expected a duplicate rejection");
    expect(result.duplicate).toMatchObject({ id: existing, name: "Frost", slug: "frost", ownerUsername: "sona" });
  });

  it("matches case-insensitively and lets unrelated bytes through", async () => {
    await createPublishedSkin({ ownerUserId: 7, ownerUsername: "sona", name: "Frost", sha256: HASH });

    expect((await createPendingSkin(db, { ...OWNER, oskSha256: HASH.toUpperCase() })).ok).toBe(false);
    expect((await createPendingSkin(db, { ...OWNER, oskSha256: "0c".repeat(32) })).ok).toBe(true);
    // No hash sent (an insecure context, say): the ticket is minted and the
    // check falls to the server-hashed archive at upload time.
    expect((await createPendingSkin(db, OWNER)).ok).toBe(true);
  });

  it("only blocks on published skins, and never on the row doing the upload", async () => {
    const pending = await createPendingSkin(db, { ...OWNER, oskSha256: HASH });
    if (!pending.ok) throw new Error("pending failed");
    const pendingRow = await getSkin(db, pending.id);
    if (!pendingRow) throw new Error("pending row missing");
    await attachSkinOsk(db, pendingRow, {
      key: "k", url: "https://cdn.example/skin.osk", sizeBytes: 1, sha256: HASH,
      keymodes: [4], specialKeymodes: [], accentColor: null, iniAuthor: null,
    });

    // Its own half-finished row must not look like somebody else's upload.
    expect(await findPublishedSkinByOskSha256(db, HASH, pending.id)).toBeNull();
    // Nor should a pending row block a different uploader.
    expect(await findPublishedSkinByOskSha256(db, HASH)).toBeNull();

    const published = await createPublishedSkin({ ownerUserId: 9, ownerUsername: "kite", name: "Nova", sha256: HASH });
    expect((await findPublishedSkinByOskSha256(db, HASH))?.id).toBe(published);
    // Hidden is a moderation state; a public upload error must not expose it.
    await setSkinHidden(db, published, true);
    expect(await findPublishedSkinByOskSha256(db, HASH)).toBeNull();
  });

  it("frees the hash when the owner deletes the skin", async () => {
    const id = await createPublishedSkin({ ownerUserId: 7, ownerUsername: "sona", name: "Frost", sha256: HASH });
    expect((await createPendingSkin(db, { ...OWNER, oskSha256: HASH })).ok).toBe(false);

    await deleteSkin(db, id);

    expect((await createPendingSkin(db, { ...OWNER, oskSha256: HASH })).ok).toBe(true);
  });

  it("ignores a malformed hash instead of matching on it", async () => {
    await createPublishedSkin({ ownerUserId: 7, ownerUsername: "sona", name: "Frost", sha256: HASH });

    expect(await findPublishedSkinByOskSha256(db, "not-a-hash")).toBeNull();
    expect((await createPendingSkin(db, { ...OWNER, oskSha256: "zz" })).ok).toBe(true);
  });
});

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

  it("flags an 8K block with a scratch-lane separator as 7K+1", async () => {
    // A line only on the right side of the first column: 7K+1. The plain 4K
    // block stays regular.
    const buffer = await buildOsk({
      "skin.ini": "[Mania]\nKeys: 4\n\n[Mania]\nKeys: 8\nColumnLineWidth: 0,4,0,0,0,0,0,0,0\n",
    });
    const result = await validateOskBuffer(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.keymodes).toEqual([4, 8]);
    expect(result.info.specialKeymodes).toEqual([8]);
  });

  it("merges a repeated ColumnLineWidth the way osu! fills its slots", async () => {
    // A block can declare the key twice (the 4K block of "moj skin zielony"
    // does), and osu! only rewrites the slots the later list names. Reading
    // last-wins buried the scratch separator under the padded 2-unit default.
    const buffer = await buildOsk({
      "skin.ini": "[Mania]\nKeys: 8\nColumnLineWidth: 0,0,0,0,0,0,0,4,0\n//Keys\nColumnLineWidth: 0,0\n",
    });
    const result = await validateOskBuffer(buffer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.specialKeymodes).toEqual([8]);
  });
});

describe("hasSpecialColumnSeparator", () => {
  const block = (columnLineWidth?: string): Record<string, string> =>
    columnLineWidth == null ? {} : { ColumnLineWidth: columnLineWidth };

  it("detects a separator on either inside edge of the field", () => {
    // Right side of the first column (left-hand scratch)...
    expect(hasSpecialColumnSeparator(block("0,4,0,0,0,0,0,0,0"), 8)).toBe(true);
    // ...or left side of the last column (right-hand scratch).
    expect(hasSpecialColumnSeparator(block("0,0,0,0,0,0,0,4,0"), 8)).toBe(true);
    // An edge line still counts at any width when it is the only line drawn
    // (pl0x marks its scratch lane with a single 1-unit line).
    expect(hasSpecialColumnSeparator(block("0,2,0,0,0,0,0,0,0"), 8)).toBe(true);
    expect(hasSpecialColumnSeparator(block("0,1,0,0,0,0,0,0,0"), 8)).toBe(true);
    // Doubled-up against stable's 2-unit default everywhere else.
    expect(hasSpecialColumnSeparator(block("2,4,2,2,2,2,2,2,2"), 8)).toBe(true);
  });

  it("keeps uniform grids and undeclared widths as regular layouts", () => {
    // No ColumnLineWidth at all: stable's uniform default.
    expect(hasSpecialColumnSeparator(block(), 8)).toBe(false);
    // Every boundary equal is a grid, not a scratch separator.
    expect(hasSpecialColumnSeparator(block("2,2,2,2,2,2,2,2,2"), 8)).toBe(false);
    expect(hasSpecialColumnSeparator(block("0,0,0,0,0,0,0,0,0"), 8)).toBe(false);
    // A short list pads with the 2-unit default, burying the first entry.
    expect(hasSpecialColumnSeparator(block("3"), 8)).toBe(false);
    // Symmetric heavy edges read as decoration, not a scratch lane.
    expect(hasSpecialColumnSeparator(block("0,4,0,0,0,0,0,4,0"), 8)).toBe(false);
    expect(hasSpecialColumnSeparator(block("0,1,0,0,0,0,0,1,0"), 8)).toBe(false);
    // A faint edge line does not stand out against other drawn lines.
    expect(hasSpecialColumnSeparator(block("0,1,1,1,1,1,1,1,0"), 8)).toBe(false);
    // A line between middle columns is not an edge separator.
    expect(hasSpecialColumnSeparator(block("0,0,0,0,4,0,0,0,0"), 8)).toBe(false);
  });
});

describe("backfillSkinSpecialKeymodes", () => {
  it("classifies stored .osk archives once and skips rows on later boots", async () => {
    const special = await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Scratch Eight", keymodes: [8] });
    const regular = await createPublishedSkin({ ownerUserId: 2, ownerUsername: "bravo", name: "True Eight", keymodes: [8] });
    const archives: Record<string, Buffer> = {
      [(await getSkin(db, special))!.oskKey!]: await buildOsk({
        "skin.ini": "[Mania]\nKeys: 8\nColumnLineWidth: 0,4,0,0,0,0,0,0,0\n",
      }),
      [(await getSkin(db, regular))!.oskKey!]: await buildOsk({ "skin.ini": "[Mania]\nKeys: 8\n" }),
    };
    const reads: string[] = [];
    const readOsk = async (key: string) => {
      reads.push(key);
      return archives[key] ?? null;
    };

    expect(await backfillSkinSpecialKeymodes(db, readOsk)).toBe(1);
    expect((await getSkin(db, special))?.specialKeymodes).toEqual([8]);
    expect((await getSkin(db, regular))?.specialKeymodes).toEqual([]);

    // The one-shot marker holds: a second boot downloads nothing.
    reads.length = 0;
    expect(await backfillSkinSpecialKeymodes(db, readOsk)).toBe(0);
    expect(reads).toEqual([]);
  });

  it("retries on the next boot when every read failed (storage down)", async () => {
    await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Unreachable", keymodes: [8] });
    expect(await backfillSkinSpecialKeymodes(db, async () => null)).toBe(0);
    // No marker was written, so the next boot scans again.
    const meta = (await exec(db, "select 1 from live_meta where key like 'skin_special_keymodes_backfill:%'")).rows;
    expect(meta).toHaveLength(0);
  });
});

describe("setSkinSpecialKeymodes", () => {
  it("lets the owner correct the 7K+1 label and keeps everyone else out", async () => {
    const id = await createPublishedSkin({ ownerUserId: 101, ownerUsername: "delta", name: "Mislabelled", keymodes: [4, 8] });
    expect((await getSkin(db, id))?.specialKeymodes).toEqual([]);

    const foreign = await setSkinSpecialKeymodes(db, id, [8], 202);
    expect(foreign).toEqual({ ok: false, error: "forbidden" });

    const set = await setSkinSpecialKeymodes(db, id, [8], 101);
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.skin.specialKeymodes).toEqual([8]);
    expect((await getSkin(db, id))?.specialKeymodesManual).toBe(true);

    // Clearing the label back to plain 8K is also a manual correction.
    const cleared = await setSkinSpecialKeymodes(db, id, [], 101);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.skin.specialKeymodes).toEqual([]);
    expect((await getSkin(db, id))?.specialKeymodesManual).toBe(true);
  });

  it("lets a keymode moderator correct anyone's public skin, but never a private one", async () => {
    const id = await createPublishedSkin({ ownerUserId: 101, ownerUsername: "delta", name: "Mislabelled Eight", keymodes: [4, 8] });
    const set = await setSkinSpecialKeymodes(db, id, [8], null, { keymodeModerator: true });
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.skin.specialKeymodes).toEqual([8]);
    expect((await getSkin(db, id))?.specialKeymodesManual).toBe(true);

    // A private skin is a 404 for anyone but its uploader, moderator included.
    const hidden = await createPublishedSkin({
      ownerUserId: 101, ownerUsername: "delta", name: "Hidden Eight",
      keymodes: [8], visibility: "private", sha256: "cd".repeat(32),
    });
    expect(await setSkinSpecialKeymodes(db, hidden, [8], null, { keymodeModerator: true }))
      .toEqual({ ok: false, error: "not_found" });
    // The uploader themself still can.
    const byOwner = await setSkinSpecialKeymodes(db, hidden, [8], 101);
    expect(byOwner.ok).toBe(true);
  });

  it("rejects keymodes the skin does not ship", async () => {
    const id = await createPublishedSkin({ ownerUserId: 101, ownerUsername: "delta", name: "Four Only", keymodes: [4] });
    expect(await setSkinSpecialKeymodes(db, id, [8], 101)).toEqual({ ok: false, error: "invalid_keymodes" });
    expect(await setSkinSpecialKeymodes(db, id, [1], 101)).toEqual({ ok: false, error: "invalid_keymodes" });
  });

  it("survives a .osk replacement, minus keymodes the new build dropped", async () => {
    const id = await createPublishedSkin({ ownerUserId: 101, ownerUsername: "delta", name: "Corrected", keymodes: [6, 8] });
    await setSkinSpecialKeymodes(db, id, [6, 8], 101);
    const before = await getSkin(db, id);
    if (!before) throw new Error("skin row missing");

    // The new archive detects nothing special, and no longer ships 6K; the
    // manual 8 holds, the manual 6 goes with its keymode.
    await replaceSkinOsk(db, before, {
      key: `skins/${id}/skin-r1.osk`,
      url: `https://cdn.example/skins/${id}/skin-r1.osk`,
      sizeBytes: 2048,
      sha256: "ba".repeat(32),
      keymodes: [4, 8],
      specialKeymodes: [],
      iniAuthor: null,
    });
    const updated = await getSkin(db, id);
    expect(updated?.keymodes).toEqual([4, 8]);
    expect(updated?.specialKeymodes).toEqual([8]);
    expect(updated?.specialKeymodesManual).toBe(true);
  });

  it("is skipped by the special-keymodes backfill", async () => {
    const corrected = await createPublishedSkin({ ownerUserId: 1, ownerUsername: "alpha", name: "Hand Fixed", keymodes: [8] });
    await setSkinSpecialKeymodes(db, corrected, [], 1);
    const scanned = await createPublishedSkin({ ownerUserId: 2, ownerUsername: "bravo", name: "Auto Scanned", keymodes: [8] });
    const archives: Record<string, Buffer> = {
      // Both archives read as 7K+1, but only the untouched row may change.
      [(await getSkin(db, corrected))!.oskKey!]: await buildOsk({
        "skin.ini": "[Mania]\nKeys: 8\nColumnLineWidth: 0,4,0,0,0,0,0,0,0\n",
      }),
      [(await getSkin(db, scanned))!.oskKey!]: await buildOsk({
        "skin.ini": "[Mania]\nKeys: 8\nColumnLineWidth: 0,4,0,0,0,0,0,0,0\n",
      }),
    };
    expect(await backfillSkinSpecialKeymodes(db, async (key) => archives[key] ?? null)).toBe(1);
    expect((await getSkin(db, corrected))?.specialKeymodes).toEqual([]);
    expect((await getSkin(db, scanned))?.specialKeymodes).toEqual([8]);
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

  it("moves a re-rendered preview onto a new key so caches cannot serve the old image", () => {
    const first = skinKeymodePreviewKey("abc-123", 4, "webp");
    expect(first).toBe("skins/abc-123/preview-4k.webp");
    const second = skinKeymodePreviewKey("abc-123", 4, "webp", nextSkinPreviewRevision(first));
    expect(second).toBe("skins/abc-123/preview-4k-r1.webp");
    const third = skinKeymodePreviewKey("abc-123", 4, "webp", nextSkinPreviewRevision(second));
    expect(third).toBe("skins/abc-123/preview-4k-r2.webp");
    // An unreadable or missing previous key still moves off the original name.
    expect(nextSkinPreviewRevision(null)).toBe(1);
    expect(nextSkinPreviewRevision("skins/abc-123/preview.webp")).toBe(1);
  });

  it("moves a replaced .osk onto a new key, keeping the download filename clean", () => {
    const first = skinOskKey("abc-123", "My Cool Skin");
    expect(first).toBe("skins/abc-123/My Cool Skin.osk");
    const second = skinOskKey("abc-123", "My Cool Skin", nextSkinOskRevision(first));
    expect(second).toBe("skins/abc-123/My Cool Skin-r1.osk");
    expect(skinOskKey("abc-123", "My Cool Skin", nextSkinOskRevision(second))).toBe("skins/abc-123/My Cool Skin-r2.osk");
    // The stored object is versioned; what the browser saves is not.
    expect(oskFilename("My Cool Skin")).toBe("My Cool Skin.osk");
    expect(nextSkinOskRevision(null)).toBe(1);
  });
});

// Local dev holds production R2 credentials and (usually) a prod DB snapshot,
// so destructive object operations are only armed for the real deployment.
describe("skin storage delete guard", () => {
  const storage = {
    r2Endpoint: "https://r2.example.invalid",
    r2AccessKeyId: "key",
    r2SecretAccessKey: "secret",
    r2Bucket: "mania-hub-replay-cache",
    r2PublicBaseUrl: undefined,
  };

  it("arms deletes only for a production build behind a non-loopback origin", () => {
    expect(skinObjectDeletesEnabled({ ...storage, nodeEnv: "production", livePublicOrigin: "https://api.mania-tracker.com" })).toBe(true);
    expect(skinObjectDeletesEnabled({ ...storage, nodeEnv: "development", livePublicOrigin: "http://localhost:7227" })).toBe(false);
    expect(skinObjectDeletesEnabled({ ...storage, nodeEnv: "development", livePublicOrigin: "https://api.mania-tracker.com" })).toBe(false);
    expect(skinObjectDeletesEnabled({ ...storage, nodeEnv: "production", livePublicOrigin: "http://localhost:7227" })).toBe(false);
    expect(skinObjectDeletesEnabled({ ...storage, nodeEnv: "production", livePublicOrigin: "http://127.0.0.1:7227" })).toBe(false);
    expect(skinObjectDeletesEnabled({ ...storage, nodeEnv: "production", livePublicOrigin: "http://[::1]:7227" })).toBe(false);
    expect(skinObjectDeletesEnabled({ ...storage, nodeEnv: "production", livePublicOrigin: "not a url" })).toBe(false);
  });

  it("no-ops delete and move when disarmed, even with storage fully configured", async () => {
    // The bogus endpoint proves the guard: reaching the S3 client would reject.
    const config = { ...storage, nodeEnv: "development", livePublicOrigin: "http://localhost:7227" };
    await expect(deleteSkinObjects(config, ["skins/abc-123/file.osk"])).resolves.toBeUndefined();
    await expect(copySkinObject(config, "skins/abc-123/a.osk", "skins/abc-123/p-s3cret/a.osk", "application/octet-stream", "a.osk")).resolves.toBeNull();
  });
});

describe("editing a published skin's previews", () => {
  async function previewedSkin(): Promise<string> {
    const id = await createPublishedSkin({ ...OWNER, keymodes: [4, 7] });
    for (const keys of [4, 7]) {
      await upsertSkinKeymodePreview(db, id, {
        keys,
        key: `skins/${id}/preview-${keys}k.webp`,
        url: `https://cdn.example/skins/${id}/preview-${keys}k.webp`,
        width: 1280,
        height: 720,
      }, keys === 4);
    }
    return id;
  }

  it("repoints the card cover at another keymode's stored preview", async () => {
    const id = await previewedSkin();
    expect((await getSkin(db, id))?.previewUrl).toContain("preview-4k");

    const moved = await setSkinCoverKeymode(db, id, 7, OWNER.ownerUserId);
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(moved.skin.previewUrl).toContain("preview-7k");

    // Keymodes the skin has no render for, and other people's skins, are out.
    expect(await setSkinCoverKeymode(db, id, 5, OWNER.ownerUserId)).toEqual({ ok: false, error: "no_preview" });
    expect(await setSkinCoverKeymode(db, id, 4, OWNER.ownerUserId + 1)).toEqual({ ok: false, error: "forbidden" });
    // The admin path skips the ownership check.
    expect((await setSkinCoverKeymode(db, id, 4, null)).ok).toBe(true);
  });

  it("mints an edit ticket that leaves the skin published", async () => {
    const id = await previewedSkin();
    const started = await startSkinEdit(db, id, OWNER.ownerUserId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const row = await getSkin(db, id);
    expect(row?.status).toBe("published");
    expect(row?.publishedAt).not.toBeNull();
    // An edit ticket is not a publish ticket: the upload flow refuses it.
    expect(await getSkinForUpload(db, id, started.token)).toBeNull();
    expect((await getSkinForEdit(db, id, started.token))?.id).toBe(id);
    expect(await getSkinForEdit(db, id, "wrong-token-of-same-length!")).toBeNull();

    const finished = await finishSkinEdit(db, id, started.token);
    expect(finished.ok).toBe(true);
    expect((await getSkin(db, id))?.uploadToken).toBeNull();
    // A spent ticket cannot be replayed.
    expect(await getSkinForEdit(db, id, started.token)).toBeNull();
  });

  it("refuses an edit ticket for someone else's skin, and expires like an upload ticket", async () => {
    const id = await previewedSkin();
    expect(await startSkinEdit(db, id, OWNER.ownerUserId + 1)).toEqual({ ok: false, error: "forbidden" });

    const started = await startSkinEdit(db, id, null);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await exec(db, "update skins set token_expires_at = ? where id = ?", [new Date(Date.now() - 1000).toISOString(), id]);
    expect(await getSkinForEdit(db, id, started.token)).toBeNull();
  });

  it("keeps the cover on a keymode that is re-rendered, and reports the displaced object", async () => {
    const id = await previewedSkin();
    const replacement = {
      keys: 4,
      key: `skins/${id}/preview-4k-r1.webp`,
      url: `https://cdn.example/skins/${id}/preview-4k-r1.webp`,
      width: 1280,
      height: 720,
    };
    // isCover false: the cover was already this keymode, so it has to follow
    // the new object rather than point at the one about to be deleted.
    const upserted = await upsertSkinKeymodePreview(db, id, replacement, false);
    expect(upserted).toEqual({ ok: true, replaced: expect.objectContaining({ key: `skins/${id}/preview-4k.webp` }) });

    const row = await getSkin(db, id);
    expect(row?.previewUrl).toBe(replacement.url);
    expect(row?.previewKey).toBe(replacement.key);
    expect(row?.previews.map((preview) => preview.key)).toEqual([replacement.key, `skins/${id}/preview-7k.webp`]);
  });

  it("renames a published skin, keeping its slug and refreshing what search matches", async () => {
    const id = await createPublishedSkin({ ...OWNER, name: "Untitled Skin" });
    const slug = (await getSkin(db, id))?.slug;
    expect(slug).toBe("untitled-skin");

    const renamed = await renameSkin(db, id, "  Aqua   Mania  ", OWNER.ownerUserId);
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(renamed.skin.name).toBe("Aqua Mania");

    const row = await getSkin(db, id);
    // The slug is what shared links point at, so a rename must not move it.
    expect(row?.slug).toBe(slug);
    expect((await getSkinByRef(db, "untitled-skin"))?.id).toBe(id);
    // Search follows the new title, and stops matching the old one.
    expect((await listSkins(db, { q: "aqua" })).skins.map((skin) => skin.id)).toEqual([id]);
    expect((await listSkins(db, { q: "untitled" })).total).toBe(0);
    // The uploader stays searchable after the retitle.
    expect((await listSkins(db, { q: OWNER.ownerUsername })).total).toBe(1);
  });

  it("refuses a rename from a non-owner or with an empty name", async () => {
    const id = await createPublishedSkin({ ...OWNER, name: "Keep This" });

    expect(await renameSkin(db, id, "Stolen", OWNER.ownerUserId + 1)).toEqual({ ok: false, error: "forbidden" });
    expect(await renameSkin(db, id, "   ", OWNER.ownerUserId)).toEqual({ ok: false, error: "invalid_name" });
    expect(await renameSkin(db, "no-such-skin", "Whatever", OWNER.ownerUserId)).toEqual({ ok: false, error: "not_found" });
    expect((await getSkin(db, id))?.name).toBe("Keep This");

    // The admin path skips the ownership check, and the name is trimmed to the
    // same cap the upload form enforces.
    const long = await renameSkin(db, id, "z".repeat(200), null);
    expect(long.ok).toBe(true);
    if (long.ok) expect(long.skin.name).toHaveLength(80);
  });

  it("swaps the .osk of a published skin for a newer build", async () => {
    const id = await previewedSkin();
    const before = await getSkin(db, id);
    if (!before) throw new Error("skin row missing");
    expect(before.oskUpdatedAt).toBeNull();

    const started = await startSkinEdit(db, id, OWNER.ownerUserId, "replace");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.scope).toBe("replace");
    expect((await getSkinForEdit(db, id, started.token))?.tokenScope).toBe("replace");

    await replaceSkinOsk(db, before, {
      key: `skins/${id}/skin-r1.osk`,
      url: `https://cdn.example/skins/${id}/skin-r1.osk`,
      sizeBytes: 4096,
      sha256: "cd".repeat(32),
      keymodes: [4, 5],
      specialKeymodes: [],
      iniAuthor: "someone else",
    });

    const updated = await getSkin(db, id);
    // The new archive decides the keymodes outright, and the swap is stamped.
    expect(updated?.keymodes).toEqual([4, 5]);
    expect(updated?.oskSizeBytes).toBe(4096);
    expect(updated?.oskSha256).toBe("cd".repeat(32));
    expect(updated?.oskUpdatedAt).not.toBeNull();
    expect(updated?.publishedAt).toBe(before.publishedAt);
    expect(updated?.status).toBe("published");
    // The bytes are now findable as the duplicate of this very skin, for
    // anyone else trying to publish them.
    expect((await findPublishedSkinByOskSha256(db, "cd".repeat(32)))?.id).toBe(id);
  });

  it("drops previews for keymodes a replacement .osk no longer ships", async () => {
    const id = await previewedSkin();
    const before = await getSkin(db, id);
    if (!before) throw new Error("skin row missing");
    // The cover sat on 4K; the new build is 7K only, so the card has to move.
    await replaceSkinOsk(db, before, {
      key: `skins/${id}/skin-r1.osk`,
      url: `https://cdn.example/skins/${id}/skin-r1.osk`,
      sizeBytes: 2048,
      sha256: "ef".repeat(32),
      keymodes: [7],
      specialKeymodes: [],
      iniAuthor: null,
    });
    const started = await startSkinEdit(db, id, OWNER.ownerUserId, "replace");
    if (!started.ok) throw new Error("ticket failed");

    const finished = await finishSkinEdit(db, id, started.token);
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.staleKeys).toEqual([`skins/${id}/preview-4k.webp`]);
    expect(finished.skin.previews.map((preview) => preview.keys)).toEqual([7]);
    expect(finished.skin.previewUrl).toContain("preview-7k");
    expect((await getSkin(db, id))?.tokenScope).toBeNull();
  });

  it("leaves the previews alone when the ticket only re-renders them", async () => {
    const id = await previewedSkin();
    // A 4K/7K skin whose row somehow lists a preview for a keymode it does not
    // ship: a previews ticket must not take that as licence to prune.
    await exec(db, "update skins set keymodes_json = ? where id = ?", ["[4]", id]);
    const started = await startSkinEdit(db, id, OWNER.ownerUserId);
    if (!started.ok) throw new Error("ticket failed");

    const finished = await finishSkinEdit(db, id, started.token);
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.staleKeys).toEqual([]);
    expect(finished.skin.previews.map((preview) => preview.keys)).toEqual([4, 7]);
  });

  it("leaves a published skin carrying a stale edit ticket alone at retention time", async () => {
    const id = await previewedSkin();
    expect((await startSkinEdit(db, id, OWNER.ownerUserId)).ok).toBe(true);
    // An edit abandoned two days ago: the ticket is long expired, but the row
    // is a published skin, and retention only sweeps pending ones.
    await exec(db, "update skins set token_expires_at = ? where id = ?", [new Date(Date.now() - 48 * 3600_000).toISOString(), id]);

    expect(await listExpiredPendingSkins(db, new Date().toISOString())).toEqual([]);
  });
});

describe("private skins", () => {
  it("redacts everything that addresses a private skin, and only for other readers", async () => {
    const id = await createPublishedSkin({ ...OWNER, visibility: "private" });
    const row = (await getSkin(db, id))!;

    expect(row.visibility).toBe("private");
    expect(row.privateSecret).toBeTruthy();

    const stranger = toSkinSummary(row);
    expect(stranger).toMatchObject({
      id,
      name: "Cloudy Skies",
      visibility: "private",
      slug: null,
      oskUrl: null,
      oskSha256: null,
      oskSizeBytes: null,
      previewUrl: null,
      downloadCount: 0,
    });
    // The credit a replay shows survives: name, author, keymodes, accent.
    expect(stranger.keymodes).toEqual([4]);
    expect(stranger.accentColor).toBe("#ff66aa");

    // The owner's copy is whole, with the capability on the URLs the backend
    // itself serves.
    await exec(db, "update skins set osk_url = ?, preview_url = ? where id = ?", [
      `https://live.test/api/skins/file/${id}/skin.osk`,
      `https://live.test/api/skins/file/${id}/preview.webp`,
      id,
    ]);
    const owner = toSkinSummary((await getSkin(db, id))!, { asOwner: true });
    expect(owner.slug).toBe("cloudy-skies");
    expect(owner.oskUrl).toBe(`https://live.test/api/skins/file/${id}/skin.osk?t=${encodeURIComponent(row.privateSecret!)}`);
    expect(owner.previewUrl).toContain("?t=");
  });

  it("keeps private skins out of the catalog and its duplicate guard", async () => {
    const sha256 = "cd".repeat(32);
    const secret = await createPublishedSkin({ ...OWNER, name: "Secret Mix", sha256, visibility: "private" });
    await createPublishedSkin({ ownerUserId: 202, ownerUsername: "echo", name: "Open Mix" });

    expect((await listSkins(db, {})).skins.map((skin) => skin.name)).toEqual(["Open Mix"]);
    // Its own uploader sees it; another signed-in reader does not.
    expect((await listSkins(db, { privateOwnerUserId: 101 })).total).toBe(2);
    expect((await listSkins(db, { privateOwnerUserId: 202 })).total).toBe(1);
    expect((await listSkins(db, { privateOwnerUserId: 101, onlyPrivate: true })).skins.map((skin) => skin.id)).toEqual([secret]);
    // The shelf query is meaningless without an owner and must not fall back
    // to "every private skin".
    expect((await listSkins(db, { onlyPrivate: true })).total).toBe(0);

    // A private skin is never named as the duplicate behind someone else's
    // upload, and never counted as one.
    expect(await findPublishedSkinByOskSha256(db, sha256)).toBeNull();
    const copy = await createPendingSkin(db, { ownerUserId: 303, ownerUsername: "foxtrot", name: "Same Bytes", oskSha256: sha256 });
    expect(copy.ok).toBe(true);

    // And it has no counted download.
    expect(await recordSkinDownload(db, secret)).toBeNull();
  });

  it("hands a true admin every uploader's private skins, whole", async () => {
    const mine = await createPublishedSkin({ ...OWNER, name: "Mine Only", visibility: "private" });
    const theirs = await createPublishedSkin({ ownerUserId: 202, ownerUsername: "echo", name: "Theirs Only", visibility: "private" });
    await createPublishedSkin({ ownerUserId: 303, ownerUsername: "foxtrot", name: "Open Mix" });

    const shelf = await listSkins(db, { onlyPrivate: true, privateOwnerUserId: 101, adminAllPrivate: true });
    expect(shelf.total).toBe(2);
    expect([...shelf.skins.map((skin) => skin.id)].sort()).toEqual([mine, theirs].sort());
    // Whole, so the shelf renders someone else's preview and its card opens
    // that skin's page (which grants an admin the same read).
    const other = shelf.skins.find((skin) => skin.id === theirs)!;
    expect(other.slug).toBe("theirs-only");
    expect(other.previewUrl).not.toBeNull();
    expect(other.oskUrl).not.toBeNull();

    // The flag only widens the shelf: the browse grid stays public-only, and
    // an owner-scoped shelf without it still sees just its own.
    expect((await listSkins(db, { adminAllPrivate: true })).skins.map((skin) => skin.name)).toEqual(["Open Mix"]);
    expect((await listSkins(db, { onlyPrivate: true, privateOwnerUserId: 101 })).skins.map((skin) => skin.id)).toEqual([mine]);
  });

  it("rotates the secret every time a skin turns private", async () => {
    const id = await createPublishedSkin({ ...OWNER });
    expect((await getSkin(db, id))?.privateSecret).toBeNull();

    const first = await setSkinVisibility(db, id, "private", 101);
    expect(first.ok && first.changed).toBe(true);
    const firstSecret = (await getSkin(db, id))!.privateSecret!;
    expect(firstSecret).toBeTruthy();

    // Someone else's skin is not theirs to hide.
    const foreign = await setSkinVisibility(db, id, "public", 202);
    expect(foreign).toMatchObject({ ok: false, error: "forbidden" });

    await setSkinVisibility(db, id, "public", 101);
    expect((await getSkin(db, id))?.privateSecret).toBeNull();
    await setSkinVisibility(db, id, "private", 101);
    const secondSecret = (await getSkin(db, id))!.privateSecret!;
    // A capability handed out before the public spell must not come back to
    // life with it.
    expect(secondSecret).not.toBe(firstSecret);

    const row = (await getSkin(db, id))!;
    expect(privateSkinSecretMatches(row, secondSecret)).toBe(true);
    expect(privateSkinSecretMatches(row, firstSecret)).toBe(false);
    expect(privateSkinSecretMatches(row, null)).toBe(false);
  });

  it("hides a private skin's objects behind an unguessable key", () => {
    const key = skinOskKey("sk_1", "Cloudy Skies");
    expect(key).toBe("skins/sk_1/Cloudy Skies.osk");
    expect(isPrivateSkinKey(key)).toBe(false);
    const secret = "AbC-123_xyz";
    expect(privateSkinKey(key, secret)).toBe(`skins/sk_1/p-${secret}/Cloudy Skies.osk`);
    expect(isPrivateSkinKey(privateSkinKey(key, secret))).toBe(true);
    // A secret that tried to climb out of its folder is scrubbed, not escaped.
    expect(privateSkinKey(key, "../../etc")).toBe("skins/sk_1/p-etc/Cloudy Skies.osk");
    // Going private, public and private again rotates the folder rather than
    // nesting a second one inside the first.
    expect(privateSkinKey(privateSkinKey(key, secret), "next-secret")).toBe("skins/sk_1/p-next-secret/Cloudy Skies.osk");
    // A skin whose own name starts with the marker is not a private object.
    expect(isPrivateSkinKey(skinOskKey("sk_1", "p-rojekt"))).toBe(false);
  });

  it("collects the asset paths a stored payload draws, and versions the bundle by them", () => {
    const payload = {
      v: 1,
      settings: {
        keymodeProfiles: {
          4: {
            assets: {
              columns: [
                { tap: { name: "note1.png", src: "", path: "mania/note1.png" } },
                { tap: { name: "note1.png", src: "", path: "mania/note1.png" } },
              ],
              judgements: { hit300: { name: "hit300.png", src: "", path: "hit300.png" } },
              combo: { digits: [{ name: "score-0.png", src: "", path: "score-0.png" }, null] },
              stage: { hint: { name: "hint.png", src: "", path: "mania-stage-hint.png" } },
            },
          },
        },
      },
    };
    expect(collectReplaySkinAssetPaths(payload).sort()).toEqual([
      "hit300.png",
      "mania-stage-hint.png",
      "mania/note1.png",
      "score-0.png",
    ]);
    // A path that tries to climb out of the archive never becomes a lookup.
    expect(collectReplaySkinAssetPaths({ path: "../../secrets.png" })).toEqual([]);

    const version = replaySkinBundleVersion({ oskKey: "skins/a/x.osk", oskSha256: "ab", settingsUpdatedAt: "2026-08-03" });
    expect(version).toHaveLength(16);
    // A newer .osk or a re-saved payload has to land on a different URL.
    expect(replaySkinBundleVersion({ oskKey: "skins/a/x-r1.osk", oskSha256: "ab", settingsUpdatedAt: "2026-08-03" })).not.toBe(version);
    expect(replaySkinBundleVersion({ oskKey: "skins/a/x.osk", oskSha256: "ab", settingsUpdatedAt: "2026-08-04" })).not.toBe(version);
  });
});
