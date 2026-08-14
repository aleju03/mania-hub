import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  AVATAR_ACCENT_JOB,
  enrichPayloadAvatarAccents,
  extractDominantColors,
  getAvatarAccentForUrl,
  lookupAvatarAccents,
  normalizeAvatarAccentUrl,
  pickAccentColor,
  pruneAvatarAccents,
} from "../src/features/avatar-accents.js";
import type { JobQueue } from "../src/jobs/queue.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-avatar-accents-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function fakeQueue(): { queue: JobQueue; enqueued: Array<{ type: string; dedupeKey: string; payload: unknown }> } {
  const enqueued: Array<{ type: string; dedupeKey: string; payload: unknown }> = [];
  const queue = {
    enqueue: async (type: string, dedupeKey: string, payload: unknown) => {
      enqueued.push({ type, dedupeKey, payload });
    },
  } as unknown as JobQueue;
  return { queue, enqueued };
}

async function seedAccent(url: string, accent: string | null, status = "ok", computedAt = Date.now()): Promise<void> {
  await exec(
    db,
    "insert into avatar_accents (avatar_url, accent, status, computed_at) values (?, ?, ?, ?)",
    [url, accent, status, computedAt],
  );
}

describe("normalizeAvatarAccentUrl", () => {
  it("accepts only https a.ppy.sh urls", () => {
    expect(normalizeAvatarAccentUrl("https://a.ppy.sh/123?456.jpeg")).toBe("https://a.ppy.sh/123");
    expect(normalizeAvatarAccentUrl("http://a.ppy.sh/123")).toBeNull();
    expect(normalizeAvatarAccentUrl("https://evil.example/123")).toBeNull();
    expect(normalizeAvatarAccentUrl("")).toBeNull();
    expect(normalizeAvatarAccentUrl(42)).toBeNull();
  });

  it("collapses the cache-bust query so one avatar cannot mint many keys", () => {
    expect(normalizeAvatarAccentUrl("https://a.ppy.sh/2?n=1")).toBe("https://a.ppy.sh/2");
    expect(normalizeAvatarAccentUrl("https://a.ppy.sh/2?n=2")).toBe("https://a.ppy.sh/2");
    expect(normalizeAvatarAccentUrl("https://a.ppy.sh/2#frag")).toBe("https://a.ppy.sh/2");
  });

  it("rejects paths that are not a bare osu! user id", () => {
    expect(normalizeAvatarAccentUrl("https://a.ppy.sh/")).toBeNull();
    expect(normalizeAvatarAccentUrl("https://a.ppy.sh/2/x")).toBeNull();
    expect(normalizeAvatarAccentUrl("https://a.ppy.sh/avatar-guest.png")).toBeNull();
    expect(normalizeAvatarAccentUrl("https://a.ppy.sh/00000000000000000001")).toBeNull();
  });
});

describe("accent color pipeline", () => {
  it("picks a legible accent from a saturated image", () => {
    // 24x24 solid red block (RGB triplets).
    const pixels = Buffer.alloc(24 * 24 * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = 220;
      pixels[i + 1] = 30;
      pixels[i + 2] = 30;
    }
    const accent = pickAccentColor(extractDominantColors(pixels, 3));
    expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    // Normalized for text: lightness clamped up, so never the raw dark red.
    const r = parseInt(accent!.slice(1, 3), 16);
    expect(r).toBeGreaterThan(200);
  });

  it("stays neutral for grayscale images", () => {
    const pixels = Buffer.alloc(24 * 24 * 3);
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = 128;
      pixels[i + 1] = 128;
      pixels[i + 2] = 128;
    }
    const accent = pickAccentColor(extractDominantColors(pixels, 3));
    expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    const [r, g, b] = [accent!.slice(1, 3), accent!.slice(3, 5), accent!.slice(5, 7)].map((hex) => parseInt(hex, 16));
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("returns null for no pixels", () => {
    expect(pickAccentColor([])).toBeNull();
  });
});

describe("enrichPayloadAvatarAccents", () => {
  it("attaches accents in both key spellings and queues misses", async () => {
    // Stored rows are keyed by the normalized URL; payloads carry the raw
    // cache-busted one the osu! API hands out.
    await seedAccent("https://a.ppy.sh/1", "#ff8899");
    const { queue, enqueued } = fakeQueue();

    const payload = {
      ranking: [
        { user: { avatar_url: "https://a.ppy.sh/1?a.jpeg", username: "known" } },
        { avatarUrl: "https://a.ppy.sh/2?b.jpeg", username: "unknown" },
      ],
      nested: { deep: [{ avatar_url: "https://a.ppy.sh/1?a.jpeg" }] },
      offDomain: { avatarUrl: "https://example.com/x.png" },
    };
    await enrichPayloadAvatarAccents(db, queue, payload);

    expect(payload.ranking[0].user).toMatchObject({ avatar_accent: "#ff8899" });
    expect(payload.ranking[1]).toMatchObject({ avatarAccent: null });
    expect((payload.nested.deep[0] as Record<string, unknown>).avatar_accent).toBe("#ff8899");
    // Off-domain URLs get an explicit null and never a job.
    expect((payload.offDomain as Record<string, unknown>).avatarAccent).toBeNull();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ type: AVATAR_ACCENT_JOB, payload: { url: "https://a.ppy.sh/2" } });
  });

  it("does not re-queue fresh error rows but retries stale ones", async () => {
    await seedAccent("https://a.ppy.sh/3", null, "error", Date.now());
    await seedAccent("https://a.ppy.sh/4", null, "error", Date.now() - 25 * 60 * 60 * 1000);
    const { queue, enqueued } = fakeQueue();

    const payload = [
      { avatar_url: "https://a.ppy.sh/3?c.jpeg" },
      { avatar_url: "https://a.ppy.sh/4?d.jpeg" },
    ];
    await enrichPayloadAvatarAccents(db, queue, payload);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].payload).toEqual({ url: "https://a.ppy.sh/4" });
  });
});

describe("getAvatarAccentForUrl", () => {
  it("returns the stored accent and queues nothing", async () => {
    await seedAccent("https://a.ppy.sh/9", "#aabbcc");
    const { queue, enqueued } = fakeQueue();
    expect(await getAvatarAccentForUrl(db, queue, "https://a.ppy.sh/9?z.jpeg")).toBe("#aabbcc");
    expect(enqueued).toHaveLength(0);
  });

  it("returns null for a miss and queues extraction", async () => {
    const { queue, enqueued } = fakeQueue();
    expect(await getAvatarAccentForUrl(db, queue, "https://a.ppy.sh/10?y.jpeg")).toBeNull();
    expect(enqueued).toHaveLength(1);
  });
});

describe("pruneAvatarAccents", () => {
  it("prunes only rows older than the retention window", async () => {
    await seedAccent("https://a.ppy.sh/901", "#111111", "ok", Date.now() - 200 * 24 * 60 * 60 * 1000);
    await seedAccent("https://a.ppy.sh/902", "#222222", "ok", Date.now());
    expect(await pruneAvatarAccents(db)).toBe(1);
    const rows = await exec(db, "select avatar_url from avatar_accents");
    expect(rows.rows.map((row) => String(row.avatar_url))).toEqual(["https://a.ppy.sh/902"]);
  });
});

describe("lookupAvatarAccents", () => {
  it("returns accents keyed by the raw requested url", async () => {
    await seedAccent("https://a.ppy.sh/10", "#aabbcc");
    const accents = await lookupAvatarAccents(db, null, ["https://a.ppy.sh/10?1.jpeg", "https://a.ppy.sh/11?2.jpeg"]);
    expect(accents).toEqual({ "https://a.ppy.sh/10?1.jpeg": "#aabbcc" });
  });

  it("enqueues one job for many query variants of the same avatar", async () => {
    const { queue, enqueued } = fakeQueue();
    await lookupAvatarAccents(db, queue, [
      "https://a.ppy.sh/13?1.jpeg",
      "https://a.ppy.sh/13?2.jpeg",
      "https://a.ppy.sh/13?3.jpeg",
    ]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].payload).toEqual({ url: "https://a.ppy.sh/13" });
  });

  it("enqueues compute jobs for unknown urls and ignores foreign hosts", async () => {
    const { queue, enqueued } = fakeQueue();
    const accents = await lookupAvatarAccents(db, queue, [
      "https://a.ppy.sh/12?3.jpeg",
      "https://example.com/not-an-avatar.png",
      42,
    ]);
    expect(accents).toEqual({});
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].type).toBe(AVATAR_ACCENT_JOB);
    expect(enqueued[0].payload).toEqual({ url: "https://a.ppy.sh/12" });
  });

  it("tolerates a non-array payload", async () => {
    expect(await lookupAvatarAccents(db, null, { urls: "nope" })).toEqual({});
  });
});
