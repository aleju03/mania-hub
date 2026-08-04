import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the persistent cache, the R2 artifact tier, and the .osr store so only
// the caching/refresh logic around describeUploadedReplayById is exercised,
// not the KV/R2 stores or the replay parser. vi.hoisted keeps these defined
// before the hoisted vi.mock factories run.
const { getPersistentCacheEntry, setPersistentCache, osuFetch, readUploadedReplay, getJsonArtifact, putJsonArtifact } = vi.hoisted(() => ({
  getPersistentCacheEntry: vi.fn(),
  setPersistentCache: vi.fn(async () => {}),
  osuFetch: vi.fn(),
  readUploadedReplay: vi.fn(),
  getJsonArtifact: vi.fn(async () => null),
  putJsonArtifact: vi.fn(async () => true),
}));

vi.mock("./api", () => ({
  getPersistentCacheEntry,
  setPersistentCache,
  osuFetch,
}));
vi.mock("./uploaded-replay-store", async (importActual) => {
  const actual = await importActual<typeof import("./uploaded-replay-store")>();
  return { ...actual, readUploadedReplay };
});
vi.mock("./r2-cache", async (importActual) => {
  const actual = await importActual<typeof import("./r2-cache")>();
  return { ...actual, getJsonArtifact, putJsonArtifact };
});

import type { UploadedReplayParseResult } from "./replay-upload";
import { describeUploadedReplayById, persistUploadedReplayDescription, type UploadedReplayDescription } from "./uploaded-replay-describe";

const VALID_ID = "abcdefghijklmnop"; // 16 chars, matches the id pattern
const DAY_MS = 24 * 60 * 60 * 1000;

function fakeParsed(beatmapHash: string): UploadedReplayParseResult {
  return {
    replay: {
      keyCount: 4,
      header: {
        playerName: "someone",
        beatmapHash,
        countGeki: 100,
        count300: 50,
        countKatu: 10,
        count100: 5,
        count50: 1,
        countMiss: 2,
        totalScore: 900000,
        maxCombo: 150,
      },
      frames: [],
    },
    mods: [],
    scoreId: null,
  } as unknown as UploadedReplayParseResult;
}

function unresolvedStored(overrides: Partial<UploadedReplayDescription> = {}): UploadedReplayDescription {
  return {
    id: VALID_ID,
    playerName: "someone",
    mods: [],
    totalScore: 900000,
    maxCombo: 150,
    keyCount: 4,
    accuracy: 0.97,
    grade: "S",
    judgements: { max: 100, count300: 50, count200: 10, count100: 5, count50: 1, miss: 2 },
    scoreId: null,
    originalFilename: null,
    beatmap: null,
    beatmapHash: "c".repeat(32),
    computedAt: Date.now(),
    ...overrides,
  };
}

describe("describeUploadedReplayById caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getJsonArtifact.mockResolvedValue(null);
    putJsonArtifact.mockResolvedValue(true);
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
    expect(putJsonArtifact).not.toHaveBeenCalled();
  });

  it("serves a fresh unresolved artifact without retrying the beatmap lookup", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: false });
    const stored = unresolvedStored({ computedAt: Date.now() - 60_000 });
    getJsonArtifact.mockResolvedValue(stored as never);

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result).toEqual(stored);
    expect(osuFetch).not.toHaveBeenCalled();
    expect(readUploadedReplay).not.toHaveBeenCalled();
    expect(putJsonArtifact).not.toHaveBeenCalled();
  });

  it("retries only the beatmap lookup for a stale unresolved artifact and upgrades it in place", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: false });
    const stored = unresolvedStored({ computedAt: Date.now() - 2 * DAY_MS });
    getJsonArtifact.mockResolvedValue(stored as never);
    osuFetch.mockResolvedValue({
      id: 42,
      beatmapset_id: 7,
      version: "Insane",
      difficulty_rating: 5.1,
      mode: "mania",
      beatmapset: { artist: "artist", title: "title", creator: "creator" },
    });

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result?.beatmap).toMatchObject({ beatmapId: 42, beatmapsetId: 7, title: "title" });
    expect(readUploadedReplay).not.toHaveBeenCalled(); // never the .osr again
    expect(putJsonArtifact).toHaveBeenCalledTimes(1);
    const [, written] = putJsonArtifact.mock.calls[0] as unknown as [string, UploadedReplayDescription];
    expect(written.beatmap?.beatmapId).toBe(42);
  });

  it("advances the retry timestamp when a stale unresolved artifact still doesn't resolve", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: false });
    const oldComputedAt = Date.now() - 2 * DAY_MS;
    const stored = unresolvedStored({ computedAt: oldComputedAt });
    getJsonArtifact.mockResolvedValue(stored as never);
    osuFetch.mockRejectedValue(new Error("404"));

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result?.beatmap).toBeNull();
    expect(putJsonArtifact).toHaveBeenCalledTimes(1);
    const [, written] = putJsonArtifact.mock.calls[0] as unknown as [string, UploadedReplayDescription];
    expect(written.computedAt).toBeGreaterThan(oldComputedAt);
  });
});

describe("persistUploadedReplayDescription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putJsonArtifact.mockResolvedValue(true);
  });

  it("stores the artifact from an already-parsed replay, resolved or not", async () => {
    osuFetch.mockRejectedValue(new Error("404")); // map not on osu! yet

    await persistUploadedReplayDescription(VALID_ID, fakeParsed("d".repeat(32)), "cool play.osr");

    expect(readUploadedReplay).not.toHaveBeenCalled();
    expect(setPersistentCache).toHaveBeenCalledTimes(1);
    expect(putJsonArtifact).toHaveBeenCalledTimes(1);
    const [, written] = putJsonArtifact.mock.calls[0] as unknown as [string, UploadedReplayDescription];
    expect(written).toMatchObject({
      id: VALID_ID,
      playerName: "someone",
      originalFilename: "cool play.osr",
      beatmap: null,
      beatmapHash: "d".repeat(32),
    });
    expect(written.computedAt).toBeGreaterThan(0);
  });
});
