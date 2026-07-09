import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the persistent cache and the .osr store so only the caching wrapper around
// describeUploadedReplayById is exercised, not Turso/R2 or the replay parser.
// vi.hoisted keeps these defined before the hoisted vi.mock factories run.
const { getPersistentCacheEntry, setPersistentCache, readUploadedReplay } = vi.hoisted(() => ({
  getPersistentCacheEntry: vi.fn(),
  setPersistentCache: vi.fn(async () => {}),
  readUploadedReplay: vi.fn(),
}));

vi.mock("./api", () => ({
  getPersistentCacheEntry,
  setPersistentCache,
  osuFetch: vi.fn(),
}));
vi.mock("./uploaded-replay-store", async (importActual) => {
  const actual = await importActual<typeof import("./uploaded-replay-store")>();
  return { ...actual, readUploadedReplay };
});

import { describeUploadedReplayById } from "./uploaded-replay-describe";

const VALID_ID = "abcdefghijklmnop"; // 16 chars, matches the id pattern

describe("describeUploadedReplayById caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the cached description without re-reading the replay", async () => {
    const cached = { id: VALID_ID, playerName: "someone", beatmap: { beatmapId: 1 } };
    getPersistentCacheEntry.mockResolvedValue({ hit: true, value: cached });

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result).toBe(cached);
    expect(readUploadedReplay).not.toHaveBeenCalled();
    expect(setPersistentCache).not.toHaveBeenCalled();
  });

  it("does not cache a null description so a transient miss isn't pinned", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: false });
    readUploadedReplay.mockResolvedValue(null); // compute short-circuits to null

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result).toBeNull();
    expect(setPersistentCache).not.toHaveBeenCalled();
  });
});
