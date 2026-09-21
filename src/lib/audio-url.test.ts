import { describe, expect, it, vi } from "vitest";
import { getBeatmapAudioUrl } from "./audio-url";

const backend = vi.hoisted(() => ({ url: "http://localhost:7227" as string | null }));
vi.mock("./live-backend", () => ({ getLiveBackendUrl: () => backend.url }));

describe("beatmap playback audio URLs", () => {
  it("bypasses immutable Ogg responses from before the seek fix", () => {
    expect(getBeatmapAudioUrl(1900729, "audio.ogg"))
      .toBe("http://localhost:7227/api/audio?beatmapsetId=1900729&filename=audio.ogg&v=ogg-seek-v1");
    expect(getBeatmapAudioUrl(1, "folder/song.OGG")).toContain("filename=folder%2Fsong.OGG&v=ogg-seek-v1");
    expect(getBeatmapAudioUrl(1, "song.mp3")).toBe("http://localhost:7227/api/audio?beatmapsetId=1&filename=song.mp3");
  });

  it("keeps the cache version when routing through the same-origin proxy", () => {
    backend.url = null;
    try {
      expect(getBeatmapAudioUrl(1, "song.ogg")).toBe("/api/audio?beatmapsetId=1&filename=song.ogg&v=ogg-seek-v1");
    } finally {
      backend.url = "http://localhost:7227";
    }
  });
});
