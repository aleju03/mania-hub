// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  video: vi.fn(), audio: vi.fn(), support: vi.fn(), qualityStart: vi.fn(), canvasAdd: vi.fn(),
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
  CanvasSource: class {
    constructor(_canvas: unknown, private options: { codec: string; hardwareAcceleration: string }) {}
    async add() { await mocks.canvasAdd(this.options); }
    close() {}
  },
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
  mocks.canvasAdd.mockReset();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn() } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("export codec selection", () => {
  it("uses hardware H.264 for Fast export without starting the software AV1 encoder", async () => {
    const plan = await validateExportCodecs({ ...request, encodingMode: "fast" });
    expect(plan).toMatchObject({ videoCodec: "avc", hardwareAcceleration: "prefer-hardware", audioCodec: "aac" });
    expect(plan?.videoQuantizer).toBeUndefined();
    expect(mocks.qualityStart).not.toHaveBeenCalled();
    expect(mocks.support).not.toHaveBeenCalled();
    expect(mocks.canvasAdd).toHaveBeenCalledWith(expect.objectContaining({ hardwareAcceleration: "prefer-hardware" }));
  });

  it("can use hardware AV1 without opting into software quantizer mode", async () => {
    mocks.video.mockImplementation(async (codec: string) => codec === "av1");
    expect(await validateExportCodecs({ ...request, width: 2384, encodingMode: "fast" })).toMatchObject({
      videoCodec: "av1", hardwareAcceleration: "prefer-hardware", fullCodecString: "av01.0.12M.08",
    });
    expect(mocks.qualityStart).not.toHaveBeenCalled();
  });

  it("tries another hardware codec if the first advertises support but fails a real encode", async () => {
    mocks.canvasAdd.mockImplementation(async ({ codec }: { codec: string }) => {
      if (codec === "avc") throw new Error("Broken hardware H.264");
    });
    expect(await validateExportCodecs({ ...request, encodingMode: "fast" }))
      .toMatchObject({ videoCodec: "av1", hardwareAcceleration: "prefer-hardware" });
    expect(mocks.qualityStart).not.toHaveBeenCalled();
  });

  it("does not silently switch Fast export to software when hardware is unavailable", async () => {
    mocks.video.mockImplementation(async (_codec: string, options: { hardwareAcceleration?: string }) => options.hardwareAcceleration !== "prefer-hardware");
    await expect(validateExportCodecs({ ...request, encodingMode: "fast" })).rejects.toMatchObject({ code: "fast_export_unavailable" });
    expect(mocks.video).toHaveBeenCalledTimes(4);
    expect(mocks.canvasAdd).not.toHaveBeenCalled();
    expect(mocks.qualityStart).not.toHaveBeenCalled();
    expect(mocks.support).not.toHaveBeenCalled();
  });

  it("also refuses silent software fallback when every hardware smoke encode fails", async () => {
    mocks.canvasAdd.mockRejectedValue(new Error("Hardware failed"));
    await expect(validateExportCodecs({ ...request, encodingMode: "fast" })).rejects.toMatchObject({ code: "fast_export_unavailable" });
    expect(mocks.video.mock.calls.every(([, options]) => options.hardwareAcceleration === "prefer-hardware")).toBe(true);
    expect(mocks.qualityStart).not.toHaveBeenCalled();
  });

  it("keeps software AV1 available when Smaller file is explicitly selected", async () => {
    expect(await validateExportCodecs({ ...request, encodingMode: "compact" })).toMatchObject({
      videoCodec: "av1", videoQuantizer: 96, hardwareAcceleration: "prefer-software",
    });
  });

  it("uses the custom bitrate for AV1 instead of ignoring it in fixed-quantizer mode", async () => {
    const plan = await validateExportCodecs({ ...request, encodingMode: "compact", videoBitrateMode: "variable", videoBitrate: 2_000_000 });
    expect(plan).toMatchObject({ videoCodec: "av1", hardwareAcceleration: "prefer-software" });
    expect(plan?.videoQuantizer).toBeUndefined();
    expect(mocks.qualityStart).not.toHaveBeenCalled();
    expect(mocks.canvasAdd).toHaveBeenCalledWith(expect.objectContaining({ codec: "av1", bitrate: 2_000_000, bitrateMode: "variable" }));
  });

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
