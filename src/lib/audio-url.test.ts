import { describe, expect, it, vi } from "vitest";
import { getBeatmapAudioUrl } from "./audio-url";

const backend = vi.hoisted(() => ({ url: "http://localhost:7227" as string | null }));
vi.mock("./live-backend", () => ({ getLiveBackendUrl: () => backend.url, getAssetsBaseUrl: () => backend.url }));

describe("beatmap playback audio URLs", () => {
  it("bypasses immutable Ogg responses from before the seek fix", () => {
    expect(getBeatmapAudioUrl(1900729, "audio.ogg"))
      .toBe("http://localhost:7227/api/audio?beatmapsetId=1900729&filename=audio.ogg&v=ogg-seek-v1");
    expect(getBeatmapAudioUrl(1, "folder/song.OGG")).toContain("filename=folder%2Fsong.OGG&v=ogg-seek-v1");
    expect(getBeatmapAudioUrl(1, "song.mp3")).toBe("http://localhost:7227/api/audio?beatmapsetId=1&filename=song.mp3");
  });

  it("asks for a plain MP3, or AAC where it is variable bitrate, when MP3 in MP4 cannot play", async () => {
    vi.resetModules();
    vi.stubGlobal("document", { createElement: () => ({ canPlayType: () => "" }) });
    try {
      const fresh = await import("./audio-url");
      expect(fresh.getBeatmapAudioUrl(1, "song.mp3"))
        .toBe("http://localhost:7227/api/audio?beatmapsetId=1&filename=song.mp3&format=mp3&vbr=aac");
      expect(fresh.getBeatmapAudioUrl(1, "song.ogg")).toBe("http://localhost:7227/api/audio?beatmapsetId=1&filename=song.ogg&v=ogg-seek-v1");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
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
