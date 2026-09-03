import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the packing and the chart-resolution rules are under test; the osu!
// proxy, the .osu fetch and the community store are stubbed.
const { osuFetch, fetchBeatmapFileWithMeta, getCommunityBeatmapFile, getCommunityBeatmapAssets } = vi.hoisted(() => ({
  osuFetch: vi.fn(),
  fetchBeatmapFileWithMeta: vi.fn(),
  getCommunityBeatmapFile: vi.fn(async () => null as string | null),
  getCommunityBeatmapAssets: vi.fn(async () => ({ audio: false, background: false })),
}));

vi.mock("./api", async (importActual) => {
  const actual = await importActual<typeof import("./api")>();
  return { ...actual, osuFetch, fetchBeatmapFileWithMeta };
});
vi.mock("./community-beatmap-store", () => ({ getCommunityBeatmapFile, getCommunityBeatmapAssets }));
vi.mock("./osu/server", () => ({ edgeCache: () => {}, noStore: () => {} }));

import type { UploadedReplayParseResult } from "./replay-upload";
import { packUploadedReplay, resolveUploadedReplayBeatmap } from "./uploaded-replay-open-server";
import { unpackUploadedReplay } from "./uploaded-replay-payload";

const CHECKSUM = "0123456789abcdef0123456789abcdef";

function parsed(): UploadedReplayParseResult {
  return {
    replay: {
      header: {
        playerName: "tester",
        gameMode: 3,
        gameVersion: 20240101,
        beatmapHash: CHECKSUM,
        modsUsed: 64,
        totalScore: 900_000,
        maxCombo: 500,
        count300: 400,
        count100: 20,
        count50: 3,
        countGeki: 300,
        countKatu: 10,
        countMiss: 2,
        isPerfect: false,
      },
      frames: [
        { time: 0, keyState: 0 },
        { time: 16, keyState: 0b0101 },
        { time: 33, keyState: 0b1000 },
        { time: 1_000_000, keyState: (1 << 19) | 1 },
      ],
      lifeBarFrames: [{ time: 0, health: 1 }, { time: 500, health: 0.8 }],
      keyCount: 7,
      stableScrollSpeedScale: 1.25,
    },
    mods: [{ acronym: "DT", settings: { speed_change: 1.3 } }],
    scoreId: 12345,
  };
}

describe("packUploadedReplay / unpackUploadedReplay", () => {
  it("round-trips the parse result through the packed wire shape", () => {
    const original = parsed();
    const packed = packUploadedReplay(original);
    expect(packed.framesPacked.count).toBe(4);
    // Packed, not JSON frame objects.
    expect(typeof packed.framesPacked.times).toBe("string");

    const restored = unpackUploadedReplay(JSON.parse(JSON.stringify(packed)));
    expect(restored.replay.frames).toEqual(original.replay.frames);
    expect(restored.replay.header).toEqual(original.replay.header);
    expect(restored.replay.lifeBarFrames).toEqual(original.replay.lifeBarFrames);
    expect(restored.replay.keyCount).toBe(7);
    expect(restored.replay.stableScrollSpeedScale).toBe(1.25);
    expect(restored.mods).toEqual(original.mods);
    expect(restored.scoreId).toBe(12345);
  });

  it("leaves the scroll-speed scale absent when the replay has none", () => {
    const original = parsed();
    delete original.replay.stableScrollSpeedScale;
    const packed = packUploadedReplay(original);
    expect("stableScrollSpeedScale" in packed).toBe(false);
    expect(unpackUploadedReplay(packed).replay.stableScrollSpeedScale).toBeUndefined();
  });
});

describe("resolveUploadedReplayBeatmap", () => {
  beforeEach(() => {
    osuFetch.mockReset();
    fetchBeatmapFileWithMeta.mockReset();
    getCommunityBeatmapFile.mockReset();
    getCommunityBeatmapFile.mockResolvedValue(null);
    getCommunityBeatmapAssets.mockReset();
    getCommunityBeatmapAssets.mockResolvedValue({ audio: false, background: false });
  });

  it("returns osu!'s copy and skips the community store when the revision matches", async () => {
    osuFetch.mockResolvedValue({ id: 42, beatmapset_id: 7, mode: "mania", cs: 7 });
    fetchBeatmapFileWithMeta.mockResolvedValue({ content: "osu file format v14", cacheStatus: "hit", checksumMatched: true, source: "osu", cachedAt: 0 });

    const resolved = await resolveUploadedReplayBeatmap(CHECKSUM);
    expect(resolved.meta?.id).toBe(42);
    expect(fetchBeatmapFileWithMeta).toHaveBeenCalledWith(42, 7, CHECKSUM);
    expect(resolved.file).toEqual({ content: "osu file format v14", cacheStatus: "hit", checksumMatched: true });
    expect(resolved.community).toBeNull();
    expect(getCommunityBeatmapFile).not.toHaveBeenCalled();
  });

  it("reads the community copy when osu! serves another revision", async () => {
    osuFetch.mockResolvedValue({ id: 42, beatmapset_id: 7, mode: "mania", cs: 7 });
    fetchBeatmapFileWithMeta.mockResolvedValue({ content: "old revision", cacheStatus: "miss", checksumMatched: false, source: "osu", cachedAt: 0 });
    getCommunityBeatmapFile.mockResolvedValue("contributed");
    getCommunityBeatmapAssets.mockResolvedValue({ audio: true, background: false });

    const resolved = await resolveUploadedReplayBeatmap(CHECKSUM);
    expect(resolved.file?.checksumMatched).toBe(false);
    expect(resolved.community).toEqual({ content: "contributed", assets: { audio: true, background: false } });
  });

  it("treats a 404 lookup as a map osu! does not know and tries the community store", async () => {
    osuFetch.mockRejectedValue(new Error("[lookup] 404 Not Found"));
    getCommunityBeatmapFile.mockResolvedValue("contributed");

    const resolved = await resolveUploadedReplayBeatmap(CHECKSUM);
    expect(resolved.meta).toBeNull();
    expect(resolved.file).toBeNull();
    expect(fetchBeatmapFileWithMeta).not.toHaveBeenCalled();
    expect(resolved.community?.content).toBe("contributed");
  });

  it("surfaces an osu! outage instead of mistaking it for an unknown map", async () => {
    osuFetch.mockRejectedValue(new Error("[lookup] 503 upstream"));
    await expect(resolveUploadedReplayBeatmap(CHECKSUM)).rejects.toThrow("503");
    expect(getCommunityBeatmapFile).not.toHaveBeenCalled();
  });

  it("falls back to the community copy when the .osu itself cannot be fetched", async () => {
    osuFetch.mockResolvedValue({ id: 42, beatmapset_id: 7, mode: "mania", cs: 7 });
    fetchBeatmapFileWithMeta.mockRejectedValue(new Error("every source failed"));

    const resolved = await resolveUploadedReplayBeatmap(CHECKSUM);
    expect(resolved.meta?.id).toBe(42);
    expect(resolved.file).toBeNull();
    expect(resolved.community).toBeNull();
    expect(getCommunityBeatmapFile).toHaveBeenCalledWith(CHECKSUM);
  });

  it("does not ask osu! about a malformed checksum", async () => {
    const resolved = await resolveUploadedReplayBeatmap("");
    expect(resolved).toEqual({ meta: null, file: null, community: null });
    expect(osuFetch).not.toHaveBeenCalled();
  });
});
