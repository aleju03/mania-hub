// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  video: vi.fn(), audio: vi.fn(), support: vi.fn(), qualityStart: vi.fn(),
}));
vi.mock("mediabunny", () => ({
  canEncodeVideo: mocks.video,
  canEncodeAudio: mocks.audio,
  BufferTarget: class {},
  Mp4OutputFormat: class {},
  WebMOutputFormat: class {},
  Output: class {
    state = "pending";
    addVideoTrack() {}
    addAudioTrack() {}
    async start() { this.state = "started"; }
    async finalize() { this.state = "finalized"; }
    async cancel() { this.state = "canceled"; }
  },
  CanvasSource: class { async add() {} close() {} },
  AudioSampleSource: class { async add() {} close() {} },
  AudioSample: class { close() {} },
}));
vi.mock("./quality-video-source", () => ({
  QualityVideoSource: class {
    source = {};
    constructor() { mocks.qualityStart(); }
    async addFrame() {}
    async close() {}
    async cancel() {}
  },
}));

import { isOutputSizeAllowed, planExportCodecs, validateExportCodecs } from "./capabilities";

const request = {
  width: 1920, height: 1080, fps: 60, videoBitrate: 3_000_000,
  audioBitrate: 128_000, sampleRate: 48_000, channels: 2, wantsAudio: true,
};

beforeEach(() => {
  vi.stubGlobal("VideoEncoder", { isConfigSupported: mocks.support });
  mocks.support.mockReset().mockImplementation(async (config: VideoEncoderConfig) => ({ supported: true, config }));
  mocks.video.mockReset().mockResolvedValue(true);
  mocks.audio.mockReset().mockResolvedValue(true);
  mocks.qualityStart.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn() } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("export codec selection", () => {
  it.each([
    { width: 1590, height: 720, fps: 60, codec: "av01.0.08M.08" },
    { width: 2370, height: 1080, fps: 30, codec: "av01.0.12M.08" },
    { width: 2370, height: 1080, fps: 60, codec: "av01.0.12M.08" },
    { width: 4096, height: 1080, fps: 60, codec: "av01.0.12M.08" },
  ])("admits native-aspect $width × $height at $fps FPS with the right AV1 level", async ({ width, height, fps, codec }) => {
    expect(await planExportCodecs({ ...request, width, height, fps })).toMatchObject({ videoCodec: "av1" });
    expect(mocks.support).toHaveBeenCalledWith(expect.objectContaining({ codec, width, height, framerate: fps }));
  });

  it.each([
    [4098, 1080, 60], [3840, 2160, 30], [1920, 1080, 120],
    [0, 720, 60], [1591, 720, 60], [1590, 720.5, 60],
  ])("rejects unsupported output bounds %i × %i at %i FPS before codec probing", async (width, height, fps) => {
    expect(isOutputSizeAllowed(width, height, fps)).toBe(false);
    expect(await planExportCodecs({ ...request, width, height, fps })).toBeNull();
    expect(mocks.support).not.toHaveBeenCalled();
  });

  it("prefers quality-controlled AV1 with audio in MP4", async () => {
    expect(await validateExportCodecs(request)).toMatchObject({
      container: "mp4", videoCodec: "av1", videoQuantizer: 96,
      audioCodec: "aac", hardwareAcceleration: "prefer-software",
    });
    expect(mocks.support).toHaveBeenCalledWith(expect.objectContaining({
      codec: "av01.0.09M.08", width: 1920, height: 1080, framerate: 60, bitrateMode: "quantizer",
    }));
  });

  it("falls back if the browser ignores quality mode", async () => {
    mocks.support.mockResolvedValue({ supported: true, config: { bitrateMode: "variable" } });
    expect(await planExportCodecs(request)).toMatchObject({ videoCodec: "avc", container: "mp4" });
  });

  it("falls back if AV1 is advertised but fails to start encoding", async () => {
    mocks.qualityStart.mockImplementation(() => { throw new Error("AV1 init failed"); });
    expect(await validateExportCodecs(request)).toMatchObject({ videoCodec: "avc", audioCodec: "aac" });
  });

  it("keeps an explicitly H.264 spec on the compatibility path", async () => {
    expect(await planExportCodecs({ ...request, preferredVideoCodec: "avc" })).toMatchObject({ videoCodec: "avc" });
    expect(mocks.support).not.toHaveBeenCalled();
  });

  it("retains the WebM fallback when neither MP4 video encoder is supported", async () => {
    mocks.support.mockResolvedValue({ supported: false });
    mocks.video.mockImplementation(async (codec: string) => codec === "vp9");
    expect(await planExportCodecs(request)).toMatchObject({ videoCodec: "vp9", audioCodec: "opus", container: "webm" });
  });

  it("does not probe or add audio when the export is silent", async () => {
    expect(await planExportCodecs({ ...request, wantsAudio: false })).toMatchObject({ videoCodec: "av1", audioCodec: null });
    expect(mocks.audio).not.toHaveBeenCalled();
  });
});
