// @vitest-environment jsdom
/* The persisted thumbnail tier fails invisibly: both of its callers wrap the
   cache handle in a try/catch and fall back to a re-render, so a broken open
   costs every visitor a canvas mint per card per page load and reports
   nothing. It was broken exactly that way once, by a handle that awaited
   itself instead of caches.open, and nothing anywhere went red.

   So this asserts the two things the handle exists to do: hand back the
   current bucket, and drop the buckets earlier CACHE_VERSIONs left behind. */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The handle is opened once per module load and remembered, so each test takes
   a fresh copy of the module rather than the one the last test already
   opened and pruned. */
async function loadPersistedCardThumbnail(key: string) {
  vi.resetModules();
  return (await import("./cardThumbnailCache")).loadPersistedCardThumbnail(key);
}

const CURRENT_BUCKET = "mania-hub-maniacard-thumbs-v2";
const OLD_BUCKET = "mania-hub-maniacard-thumbs-v1";
const KEY = "v2-w240-u4242-18417ef331be097d";

class FakeCache {
  entries = new Map<string, { blob: () => Promise<Blob> }>();

  async match(request: { url: string }) {
    return this.entries.get(new URL(request.url).pathname);
  }

  async keys() {
    return [];
  }

  async put() {}

  async delete() {
    return true;
  }
}

const buckets = new Map<string, FakeCache>();

beforeEach(() => {
  buckets.clear();
  const current = new FakeCache();
  current.entries.set(`/__mania-card-thumbnails/${KEY}.webp`, {
    blob: async () => new Blob(["thumbnail"], { type: "image/webp" }),
  });
  buckets.set(CURRENT_BUCKET, current);
  buckets.set(OLD_BUCKET, new FakeCache());

  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async (name: string) => {
        if (!buckets.has(name)) buckets.set(name, new FakeCache());
        return buckets.get(name);
      },
      keys: async () => [...buckets.keys()],
      delete: async (name: string) => buckets.delete(name),
    },
  });
  URL.createObjectURL = () => "blob:stored-thumbnail";
});

describe("the persisted thumbnail bucket", () => {
  it("reads a stored face back instead of falling through to a re-render", async () => {
    expect(await loadPersistedCardThumbnail(KEY)).toBe("blob:stored-thumbnail");
  });

  it("drops what an earlier CACHE_VERSION left behind, and keeps the current one", async () => {
    await loadPersistedCardThumbnail(KEY);
    expect([...buckets.keys()]).toEqual([CURRENT_BUCKET]);
  });

  it("tries again after a failed open instead of giving the visit up", async () => {
    /* The handle is remembered for the life of the page. Remembering a
       rejected one would be the silent-failure shape all over again: storage
       blocked for a moment at load, and no card is persisted again until the
       tab is closed. */
    vi.resetModules();
    let attempts = 0;
    const real = (globalThis as { caches: CacheStorage }).caches.open;
    (globalThis as { caches: CacheStorage }).caches.open = ((name: string) => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("storage blocked")) : real(name);
    }) as CacheStorage["open"];

    const module = await import("./cardThumbnailCache");
    expect(await module.loadPersistedCardThumbnail(KEY)).toBeNull();
    expect(await module.loadPersistedCardThumbnail(KEY)).toBe("blob:stored-thumbnail");
    expect(attempts).toBe(2);
  });
});
