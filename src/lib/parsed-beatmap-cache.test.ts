import { describe, expect, it } from "vitest";
import { clearParsedBeatmapCache, parseCachedManiaBeatmap } from "./parsed-beatmap-cache";

const BEATMAP_CONTENT = `
osu file format v14

[General]
PreviewTime: 1000

[Metadata]
Title:Cache Test
Artist:mania-hub
Creator:test
Version:4K

[Difficulty]
CircleSize:4

[HitObjects]
64,192,1000,1,0,0:0:0:0:
192,192,1500,128,0,2000:0:0:0:0:
`;

describe("parseCachedManiaBeatmap", () => {
  it("reuses parsed beatmaps for the same beatmap file", () => {
    clearParsedBeatmapCache();
    const first = parseCachedManiaBeatmap(1, BEATMAP_CONTENT);
    const second = parseCachedManiaBeatmap(1, BEATMAP_CONTENT);

    expect(second).toBe(first);
    expect(second.keyCount).toBe(4);
  });

  it("reparses when the cached content changes", () => {
    clearParsedBeatmapCache();
    const first = parseCachedManiaBeatmap(1, BEATMAP_CONTENT);
    const second = parseCachedManiaBeatmap(1, BEATMAP_CONTENT.replace("CircleSize:4", "CircleSize:7"));

    expect(second).not.toBe(first);
    expect(second.keyCount).toBe(7);
  });

  it("caches replay key-count overrides separately", () => {
    clearParsedBeatmapCache();
    const fourKey = parseCachedManiaBeatmap(1, BEATMAP_CONTENT, { keyCount: 4 });
    const sevenKey = parseCachedManiaBeatmap(1, BEATMAP_CONTENT, { keyCount: 7 });
    const fourKeyAgain = parseCachedManiaBeatmap(1, BEATMAP_CONTENT, { keyCount: 4 });

    expect(fourKey.keyCount).toBe(4);
    expect(sevenKey.keyCount).toBe(7);
    expect(fourKeyAgain).toBe(fourKey);
  });
});
