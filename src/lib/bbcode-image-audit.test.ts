import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scanR2AdminPrefixWithMetadata = vi.fn();
const deleteR2AdminObject = vi.fn();
const osuFetch = vi.fn();

vi.mock("./r2-cache", () => ({
  scanR2AdminPrefixWithMetadata: (...args: unknown[]) => scanR2AdminPrefixWithMetadata(...args),
  deleteR2AdminObject: (...args: unknown[]) => deleteR2AdminObject(...args),
}));
vi.mock("./public-image-store", () => ({
  getPublicBucketBaseUrl: () => "https://cdn.mania-tracker.com",
}));
vi.mock("./api", () => ({
  osuFetch: (...args: unknown[]) => osuFetch(...args),
}));

const {
  auditBbcodeImages,
  checkBbcodeUploaderProfile,
  clearBbcodeProfileReads,
  deleteUnusedBbcodeImages,
  invalidateBbcodeImageListing,
} = await import("./bbcode-image-audit");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function object(hash: string, uploadedBy: string | null, sizeBytes = 1000) {
  return {
    key: `bbcode/${hash}.png`,
    sizeBytes,
    lastModified: "2026-08-01T00:00:00.000Z",
    contentType: "image/png",
    metadata: uploadedBy ? { "uploaded-by": uploadedBy } : {},
  };
}

function scanReturns(objects: ReturnType<typeof object>[], truncated = false) {
  scanR2AdminPrefixWithMetadata.mockResolvedValue({ configured: true, objects, truncated });
}

/** Profiles keyed by the id in the `/users/<id>/mania` path osuFetch is given. */
function profilesReturn(pages: Record<number, { username: string; raw: string } | Error>) {
  osuFetch.mockImplementation(async (path: string) => {
    const id = Number(/\/users\/(\d+)\//.exec(path)?.[1]);
    const page = pages[id];
    if (!page) throw new Error(`no stub for user ${id}`);
    if (page instanceof Error) throw page;
    return { username: page.username, page: { html: "", raw: page.raw } };
  });
}

const embeds = (hash: string) => `[img]https://cdn.mania-tracker.com/bbcode/${hash}.png[/img]`;

beforeEach(() => {
  vi.clearAllMocks();
  // Both are process-wide, so without this each test would be judging the
  // previous test's listing against the previous test's checks.
  invalidateBbcodeImageListing();
  clearBbcodeProfileReads();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("auditBbcodeImages", () => {
  it("spends no osu! budget, and claims nothing, until something is checked", async () => {
    scanReturns([object(HASH_A, "user:1")]);

    const audit = await auditBbcodeImages();

    expect(osuFetch).not.toHaveBeenCalled();
    expect(audit.objects[0]?.status).toBe("unknown");
    expect(audit.totals.unusedObjects).toBe(0);
    expect(audit.coverage).toEqual({ checked: 0, total: 1 });
    expect(audit.uploaders[0]).toMatchObject({ userId: 1, state: "unchecked", uploadCount: 1 });
  });

  it("reuses one listing across viewers", async () => {
    scanReturns([object(HASH_A, "user:1")]);

    await auditBbcodeImages();
    await auditBbcodeImages();

    expect(scanR2AdminPrefixWithMetadata).toHaveBeenCalledTimes(1);
  });

  it("does not keep serving a listing that threw", async () => {
    scanR2AdminPrefixWithMetadata.mockRejectedValueOnce(new Error("R2 down"));
    await expect(auditBbcodeImages()).rejects.toThrow("R2 down");

    scanReturns([object(HASH_A, "user:1")]);
    expect((await auditBbcodeImages()).objects).toHaveLength(1);
  });
});

describe("checkBbcodeUploaderProfile", () => {
  it("costs exactly one call and marks what that profile embeds", async () => {
    scanReturns([object(HASH_A, "user:1")]);
    profilesReturn({ 1: { username: "one", raw: embeds(HASH_A) } });

    const audit = await checkBbcodeUploaderProfile(1);

    expect(osuFetch).toHaveBeenCalledTimes(1);
    expect(audit.objects[0]?.status).toBe("in-use");
    expect(audit.objects[0]?.usedBy).toEqual([1]);
    expect(audit.uploaders[0]).toMatchObject({ username: "one", state: "checked", usedCount: 1 });
  });

  it("calls an image unused only once every uploader has been checked", async () => {
    scanReturns([object(HASH_A, "user:1"), object(HASH_B, "user:2")]);
    profilesReturn({
      1: { username: "one", raw: "nothing" },
      2: { username: "two", raw: "nothing" },
    });

    const partial = await checkBbcodeUploaderProfile(1);
    expect(partial.objects.every((row) => row.status === "unknown")).toBe(true);
    expect(partial.coverage).toEqual({ checked: 1, total: 2 });

    const full = await checkBbcodeUploaderProfile(2);
    expect(full.objects.every((row) => row.status === "unused")).toBe(true);
    expect(full.totals).toMatchObject({ unusedObjects: 2, unusedBytes: 2000 });
  });

  it("credits a shared file to the other uploader who still embeds it", async () => {
    // Content-addressed keys mean `uploaded-by` names only the last uploader,
    // so checking that one profile alone would call this file unused.
    scanReturns([object(HASH_A, "user:2"), object(HASH_B, "user:3")]);
    profilesReturn({
      2: { username: "two", raw: "nothing" },
      3: { username: "three", raw: embeds(HASH_A) },
    });

    await checkBbcodeUploaderProfile(2);
    const audit = await checkBbcodeUploaderProfile(3);
    const shared = audit.objects.find((row) => row.key.includes(HASH_A));

    expect(shared?.status).toBe("in-use");
    expect(shared?.usedBy).toEqual([3]);
  });

  it("finds an embed through an imagemap or a bare link, not just [img]", async () => {
    scanReturns([object(HASH_A, "user:1")]);
    profilesReturn({
      1: { username: "one", raw: `[imagemap]\nhttps://cdn.mania-tracker.com/bbcode/${HASH_A}.png\n0 0 50 50 # hi\n[/imagemap]` },
    });

    expect((await checkBbcodeUploaderProfile(1)).objects[0]?.status).toBe("in-use");
  });

  it("keeps a failed check as evidence of nothing", async () => {
    scanReturns([object(HASH_A, "user:1")]);
    profilesReturn({ 1: new Error("osu! API 503") });

    const audit = await checkBbcodeUploaderProfile(1);

    expect(audit.objects[0]?.status).toBe("unknown");
    expect(audit.uploaders[0]).toMatchObject({ state: "failed", error: "osu! API 503" });
    expect(audit.coverage.checked).toBe(0);
  });

  it("stops counting a check once it has expired", async () => {
    vi.useFakeTimers();
    scanReturns([object(HASH_A, "user:1")]);
    profilesReturn({ 1: { username: "one", raw: "nothing" } });

    expect((await checkBbcodeUploaderProfile(1)).objects[0]?.status).toBe("unused");

    vi.advanceTimersByTime(16 * 60_000);
    invalidateBbcodeImageListing();
    const later = await auditBbcodeImages();

    expect(later.objects[0]?.status).toBe("unknown");
    expect(later.uploaders[0]?.state).toBe("expired");
    expect(later.coverage.checked).toBe(0);
  });

  it("cannot vouch for an upload whose metadata names no osu! user", async () => {
    scanReturns([object(HASH_A, "local-dev"), object(HASH_B, "user:1")]);
    profilesReturn({ 1: { username: "one", raw: "nothing" } });

    const audit = await checkBbcodeUploaderProfile(1);
    const orphan = audit.objects.find((row) => row.key.includes(HASH_A));

    expect(orphan?.uploaderId).toBeNull();
    expect(orphan?.status).toBe("unknown");
    expect(audit.objects.find((row) => row.key.includes(HASH_B))?.status).toBe("unused");
  });

  it("refuses an id the bucket does not name, rather than fetching it", async () => {
    scanReturns([object(HASH_A, "user:1")]);

    await expect(checkBbcodeUploaderProfile(999)).rejects.toThrow(/No bbcode\/ upload names user 999/);
    expect(osuFetch).not.toHaveBeenCalled();
  });

  it("reads profiles fresh rather than from the user cache", async () => {
    scanReturns([object(HASH_A, "user:1")]);
    profilesReturn({ 1: { username: "one", raw: "" } });

    await checkBbcodeUploaderProfile(1);

    const options = osuFetch.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options?.cacheTtlMs).toBeUndefined();
    expect(options?.staleMs).toBeUndefined();
  });
});

describe("deleteUnusedBbcodeImages", () => {
  it("deletes only what the current checks still call unused", async () => {
    scanReturns([object(HASH_A, "user:6"), object(HASH_B, "user:6")]);
    profilesReturn({ 6: { username: "six", raw: embeds(HASH_B) } });
    await checkBbcodeUploaderProfile(6);

    const result = await deleteUnusedBbcodeImages([`bbcode/${HASH_A}.png`, `bbcode/${HASH_B}.png`]);

    expect(result.deleted).toEqual([`bbcode/${HASH_A}.png`]);
    expect(result.refused).toEqual([
      { key: `bbcode/${HASH_B}.png`, reason: "still embedded on profile 6" },
    ]);
    expect(result.freedBytes).toBe(1000);
    expect(deleteR2AdminObject).toHaveBeenCalledWith("public", `bbcode/${HASH_A}.png`);
  });

  it("deletes nothing while any uploader is unchecked", async () => {
    scanReturns([object(HASH_A, "user:1"), object(HASH_B, "user:2")]);
    profilesReturn({
      1: { username: "one", raw: "nothing" },
      2: { username: "two", raw: "nothing" },
    });
    await checkBbcodeUploaderProfile(1);

    const result = await deleteUnusedBbcodeImages([`bbcode/${HASH_A}.png`]);

    expect(result.deleted).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/1 uploader profile still unchecked/);
    expect(deleteR2AdminObject).not.toHaveBeenCalled();
  });

  it("does not re-read any profile of its own accord", async () => {
    scanReturns([object(HASH_A, "user:1")]);
    profilesReturn({ 1: { username: "one", raw: "nothing" } });
    await checkBbcodeUploaderProfile(1);
    osuFetch.mockClear();

    await deleteUnusedBbcodeImages([`bbcode/${HASH_A}.png`]);

    expect(osuFetch).not.toHaveBeenCalled();
  });

  it("re-lists the bucket, so the reload after a delete cannot show the deleted file", async () => {
    scanReturns([object(HASH_A, "user:1")]);
    profilesReturn({ 1: { username: "one", raw: "nothing" } });
    await checkBbcodeUploaderProfile(1);

    await deleteUnusedBbcodeImages([`bbcode/${HASH_A}.png`]);
    scanReturns([]);

    expect((await auditBbcodeImages()).objects).toEqual([]);
  });

  it("refuses a key the client made up", async () => {
    scanReturns([object(HASH_A, "user:1")]);
    profilesReturn({ 1: { username: "one", raw: "" } });
    await checkBbcodeUploaderProfile(1);

    const result = await deleteUnusedBbcodeImages(["maniacards/whatever.webp"]);

    expect(result.deleted).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/not found/);
    expect(deleteR2AdminObject).not.toHaveBeenCalled();
  });
});
