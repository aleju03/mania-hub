import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the persistent cache, the R2 artifact tier, and the .osr store so only
// the caching/refresh logic around describeUploadedReplayById is exercised,
// not the KV/R2 stores or the replay parser. vi.hoisted keeps these defined
// before the hoisted vi.mock factories run.
const { getPersistentCacheEntry, setPersistentCache, osuFetch, readUploadedReplay, uploadedReplaysUseR2, getJsonArtifact, putJsonArtifact, parseUploadedReplayBuffer, fetchBeatmapFileWithMeta } = vi.hoisted(() => ({
  getPersistentCacheEntry: vi.fn(),
  setPersistentCache: vi.fn(async () => {}),
  osuFetch: vi.fn(),
  readUploadedReplay: vi.fn(),
  // Production mode by default: uploads and their description artifacts go to R2.
  uploadedReplaysUseR2: vi.fn(() => true),
  getJsonArtifact: vi.fn(async () => null),
  putJsonArtifact: vi.fn(async () => true),
  parseUploadedReplayBuffer: vi.fn(),
  fetchBeatmapFileWithMeta: vi.fn(),
}));

vi.mock("./api", () => ({
  getPersistentCacheEntry,
  setPersistentCache,
  osuFetch,
  fetchBeatmapFileWithMeta,
}));
vi.mock("./uploaded-replay-store", async (importActual) => {
  const actual = await importActual<typeof import("./uploaded-replay-store")>();
  return { ...actual, readUploadedReplay, uploadedReplaysUseR2 };
});
vi.mock("./r2-cache", async (importActual) => {
  const actual = await importActual<typeof import("./r2-cache")>();
  return { ...actual, getJsonArtifact, putJsonArtifact };
});
vi.mock("./replay-upload", async (importActual) => {
  const actual = await importActual<typeof import("./replay-upload")>();
  return { ...actual, parseUploadedReplayBuffer };
});

import type { OsuMod } from "./types";
import type { UploadedReplayParseResult } from "./replay-upload";
import { DESCRIPTION_VERSION, describeUploadedReplayById, readUploadedReplayDescription, persistUploadedReplayDescription, type UploadedReplayDescription } from "./uploaded-replay-describe";

const VALID_ID = "abcdefghijklmnop"; // 16 chars, matches the id pattern
const DAY_MS = 24 * 60 * 60 * 1000;

function fakeParsed(beatmapHash: string, mods: OsuMod[] = [], gameVersion?: number): UploadedReplayParseResult {
  return {
    replay: {
      keyCount: 4,
      header: {
        playerName: "someone",
        beatmapHash,
        gameVersion,
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
    mods,
    scoreId: null,
  } as unknown as UploadedReplayParseResult;
}

// A 4K chart with enough notes to carry a rating; columns come from the x
// positions (512 / 4 keys), one note every 150ms.
const FOUR_KEY_OSU = ["osu file format v14", "", "[General]", "Mode: 3", "", "[Difficulty]",
  "CircleSize:4", "OverallDifficulty:8", "", "[TimingPoints]", "0,300,4,1,0,100,1,0", "", "[HitObjects]",
  ...Array.from({ length: 64 }, (_, index) => `${[64, 192, 320, 448][index % 4]},192,${index * 150},1,0,0:0:0:0:`)].join("\n");

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
    version: DESCRIPTION_VERSION,
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
    const cached = { id: VALID_ID, playerName: "someone", mods: [], beatmap: { beatmapId: 1 } };
    getPersistentCacheEntry.mockResolvedValue({ hit: true, value: cached });

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result).toBe(cached);
    expect(readUploadedReplay).not.toHaveBeenCalled();
    expect(setPersistentCache).not.toHaveBeenCalled();
  });

  it("reads an old gallery summary without decoding the replay or retrying osu!", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: false });
    const stored = unresolvedStored({ version: 1, computedAt: 0 });
    getJsonArtifact.mockResolvedValue(stored as never);
    expect(await readUploadedReplayDescription(VALID_ID)).toEqual(stored);
    expect(readUploadedReplay).not.toHaveBeenCalled();
    expect(osuFetch).not.toHaveBeenCalled();
    expect(putJsonArtifact).not.toHaveBeenCalled();
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

  // Artifacts written before mods came from the lazer block would otherwise
  // serve their bitfield-derived mods forever.
  it("re-derives an artifact written by an older build", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: false });
    getJsonArtifact.mockResolvedValue(unresolvedStored({ version: undefined, mods: ["DT"] }) as never);
    readUploadedReplay.mockResolvedValue({ buffer: Buffer.from([0]), originalFilename: null });
    parseUploadedReplayBuffer.mockResolvedValue(
      fakeParsed("c".repeat(32), [{ acronym: "DT", settings: { speed_change: 1.1 } }]),
    );
    osuFetch.mockRejectedValue(new Error("404"));

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result?.modRate).toBe(1.1);
    expect(result?.version).toBe(DESCRIPTION_VERSION);
    const [, written] = putJsonArtifact.mock.calls[0] as unknown as [string, UploadedReplayDescription];
    expect(written.modRate).toBe(1.1);
  });

  it("keeps serving an old artifact when its .osr can no longer be read", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: false });
    const stored = unresolvedStored({ version: undefined, beatmap: { beatmapId: 9 } as never });
    getJsonArtifact.mockResolvedValue(stored as never);
    readUploadedReplay.mockResolvedValue(null);

    const result = await describeUploadedReplayById(VALID_ID);

    expect(readUploadedReplay).toHaveBeenCalledWith(VALID_ID);
    expect(result).toEqual(stored);
    expect(putJsonArtifact).not.toHaveBeenCalled();
  });
});

describe("star rating at the play's rate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putJsonArtifact.mockResolvedValue(true);
    fetchBeatmapFileWithMeta.mockResolvedValue({ content: FOUR_KEY_OSU, checksumMatched: true });
  });

  const rateModded = (overrides: Partial<UploadedReplayDescription> = {}) => unresolvedStored({
    mods: ["DT"],
    beatmap: { beatmapId: 42, beatmapsetId: 7, artist: "a", title: "t", version: "v", creator: "c", starRating: 4.75, mode: "mania" },
    ...overrides,
  });

  it("fills in the rated-at-rate number for a stored description that predates it", async () => {
    const stored = rateModded();
    getPersistentCacheEntry.mockResolvedValue({ hit: true, value: stored });

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result?.starRatingAtRate).toBeGreaterThan(0);
    expect(fetchBeatmapFileWithMeta).toHaveBeenCalledWith(42, 7, stored.beatmapHash);
    expect(putJsonArtifact).toHaveBeenCalled();
  });

  it("rates a 1.5x play above the same chart at 1.0x", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: true, value: rateModded() });
    const fast = (await describeUploadedReplayById(VALID_ID))?.starRatingAtRate ?? 0;
    getPersistentCacheEntry.mockResolvedValue({ hit: true, value: rateModded({ mods: ["HT"] }) });
    const slow = (await describeUploadedReplayById(VALID_ID))?.starRatingAtRate ?? 0;
    expect(fast).toBeGreaterThan(slow);
  });

  it("leaves a play at the map's own speed alone, without fetching the chart", async () => {
    getPersistentCacheEntry.mockResolvedValue({ hit: true, value: rateModded({ mods: ["HD"] }) });

    const result = await describeUploadedReplayById(VALID_ID);

    expect(result?.starRatingAtRate).toBeUndefined();
    expect(fetchBeatmapFileWithMeta).not.toHaveBeenCalled();
  });

  it("stops asking for a chart that would not rate", async () => {
    fetchBeatmapFileWithMeta.mockRejectedValue(new Error("gone"));
    getPersistentCacheEntry.mockResolvedValue({ hit: true, value: rateModded({ id: VALID_ID }) });

    expect((await describeUploadedReplayById(VALID_ID))?.starRatingAtRate).toBeUndefined();
    expect((await describeUploadedReplayById(VALID_ID))?.starRatingAtRate).toBeUndefined();
    expect(fetchBeatmapFileWithMeta).toHaveBeenCalledTimes(1);
  });

  it("does not persist a rate-adjusted rating from a different chart revision", async () => {
    const stored = rateModded({ id: "mismatchedreplay1" });
    getPersistentCacheEntry.mockResolvedValue({ hit: true, value: stored });
    fetchBeatmapFileWithMeta.mockResolvedValue({ content: FOUR_KEY_OSU, checksumMatched: false });

    const result = await describeUploadedReplayById(stored.id);

    expect(fetchBeatmapFileWithMeta).toHaveBeenCalledWith(42, 7, stored.beatmapHash);
    expect(result).toEqual(stored);
    expect(result?.starRatingAtRate).toBeUndefined();
    expect(setPersistentCache).not.toHaveBeenCalled();
    expect(putJsonArtifact).not.toHaveBeenCalled();
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

  // A development upload lives on local disk; writing its description next to
  // the prod uploads in the shared bucket would leave a stray artifact there.
  it("writes no R2 artifact when uploads are not going to R2", async () => {
    uploadedReplaysUseR2.mockReturnValue(false);
    osuFetch.mockRejectedValue(new Error("404"));

    await persistUploadedReplayDescription(VALID_ID, fakeParsed("d".repeat(32)), "cool play.osr");

    expect(setPersistentCache).toHaveBeenCalledTimes(1);
    expect(putJsonArtifact).not.toHaveBeenCalled();
    uploadedReplaysUseR2.mockReturnValue(true);
  });

  // The stored mods are acronyms, so a lazer custom rate needs its own field or
  // the community list renders a 1.1x DT as the default 1.5x one.
  it("keeps a lazer custom rate alongside the acronym list", async () => {
    osuFetch.mockRejectedValue(new Error("404"));

    await persistUploadedReplayDescription(
      VALID_ID,
      fakeParsed("d".repeat(32), [{ acronym: "DT", settings: { speed_change: 1.1 } }, { acronym: "DA" }]),
      null,
    );

    const [, written] = putJsonArtifact.mock.calls[0] as unknown as [string, UploadedReplayDescription];
    expect(written.mods).toEqual(["DT", "DA"]);
    expect(written.modRate).toBe(1.1);
  });

  // The counts are identical either way; lazer just measures them against 305
  // per note instead of 300, which is what lazer itself shows the player.
  it("measures accuracy on the scale of the client that recorded the play", async () => {
    osuFetch.mockRejectedValue(new Error("404"));

    await persistUploadedReplayDescription(VALID_ID, fakeParsed("d".repeat(32), [], 30_000_019), null);
    const [, lazer] = putJsonArtifact.mock.calls[0] as unknown as [string, UploadedReplayDescription];

    await persistUploadedReplayDescription(VALID_ID, fakeParsed("d".repeat(32), [], 20_231_019), null);
    const [, stable] = putJsonArtifact.mock.calls[1] as unknown as [string, UploadedReplayDescription];

    expect(lazer.judgements).toEqual(stable.judgements);
    expect(lazer.accuracy).toBeLessThan(stable.accuracy);
  });

  it("stores no rate for a play at the mod's own default speed", async () => {
    osuFetch.mockRejectedValue(new Error("404"));

    await persistUploadedReplayDescription(
      VALID_ID,
      fakeParsed("d".repeat(32), [{ acronym: "DT", settings: { speed_change: 1.5 } }]),
      null,
    );

    const [, written] = putJsonArtifact.mock.calls[0] as unknown as [string, UploadedReplayDescription];
    expect(written.mods).toEqual(["DT"]);
    expect(written.modRate).toBeUndefined();
  });

  it("uses ScoreV2 accuracy for uploads recorded by stable", async () => {
    await persistUploadedReplayDescription(
      VALID_ID, fakeParsed("d".repeat(32), [{ acronym: "SV2" }], 20260820), null, null,
    );
    const [, written] = putJsonArtifact.mock.calls[0] as unknown as [string, UploadedReplayDescription];
    const expected = (100 * 305 + 50 * 300 + 10 * 200 + 5 * 100 + 50) / (168 * 305);
    expect(written.accuracy).toBeCloseTo(expected, 10);
    expect(written.version).toBe(DESCRIPTION_VERSION);
  });
});
