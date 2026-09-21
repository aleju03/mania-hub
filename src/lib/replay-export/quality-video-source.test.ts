import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const packets = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn() }));
vi.mock("mediabunny", () => ({
  EncodedPacket: { fromEncodedChunk: (chunk: unknown) => chunk },
  EncodedVideoPacketSource: class {
    add = packets.add;
    close = packets.close;
  },
}));

import { QualityVideoSource } from "./quality-video-source";

class FakeEncoder extends EventTarget {
  static current: FakeEncoder;
  state: CodecState = "unconfigured";
  encodeQueueSize = 0;
  configure = vi.fn(() => { this.state = "configured"; });
  encode = vi.fn((_frame: unknown, _options: VideoEncoderEncodeOptions) => { this.encodeQueueSize++; });
  flush = vi.fn(async () => {});
  close = vi.fn(() => { this.state = "closed"; });
  constructor(readonly callbacks: VideoEncoderInit) {
    super();
    FakeEncoder.current = this;
  }
  dequeue() {
    this.encodeQueueSize--;
    this.dispatchEvent(new Event("dequeue"));
  }
  emit(timestamp: number) {
    this.callbacks.output({ timestamp } as EncodedVideoChunk, { decoderConfig: { codec: "av01.0.08M.08" } });
  }
}

const frames: { timestamp: number; duration: number; close: ReturnType<typeof vi.fn> }[] = [];
const canvas = { width: 1920, height: 1080 } as HTMLCanvasElement;

beforeEach(() => {
  frames.length = 0;
  packets.add.mockReset().mockResolvedValue(undefined);
  packets.close.mockReset();
  vi.stubGlobal("VideoEncoder", FakeEncoder);
  vi.stubGlobal("VideoFrame", class {
    close = vi.fn();
    constructor(_canvas: unknown, readonly options: VideoFrameInit) {
      frames.push({ timestamp: options.timestamp!, duration: options.duration!, close: this.close });
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("quality-controlled video", () => {
  it("derives timestamps from frame indices and releases raw frames", async () => {
    const video = new QualityVideoSource(canvas, 60, 96);
    await video.addFrame(0);
    await video.addFrame(120);
    expect(frames.map((frame) => frame.timestamp)).toEqual([0, 2_000_000]);
    expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
    expect(FakeEncoder.current.encode.mock.calls[1][1]).toMatchObject({ keyFrame: true, av1: { quantizer: 96 } });
    await video.cancel();
  });

  it("bounds queued native frames and resumes on dequeue", async () => {
    const video = new QualityVideoSource(canvas, 60, 96);
    for (let i = 0; i < 4; i++) await video.addFrame(i);
    let settled = false;
    const fifth = video.addFrame(4).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(FakeEncoder.current.encode).toHaveBeenCalledTimes(4);
    FakeEncoder.current.dequeue();
    await fifth;
    expect(FakeEncoder.current.encode).toHaveBeenCalledTimes(5);
    await video.cancel();
  });

  it("waits for the writer before accepting another frame", async () => {
    const video = new QualityVideoSource(canvas, 60, 96);
    let release!: () => void;
    packets.add.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    FakeEncoder.current.emit(0);
    const add = video.addFrame(1);
    await Promise.resolve();
    expect(FakeEncoder.current.encode).not.toHaveBeenCalled();
    release();
    await add;
    expect(FakeEncoder.current.encode).toHaveBeenCalledOnce();
    await video.cancel();
  });

  it("flushes late packets before closing the track", async () => {
    const video = new QualityVideoSource(canvas, 60, 96);
    FakeEncoder.current.flush.mockImplementation(async () => { FakeEncoder.current.emit(123); });
    await video.close();
    expect(packets.add).toHaveBeenCalledWith({ timestamp: 123 }, expect.objectContaining({ decoderConfig: expect.any(Object) }));
    expect(packets.add.mock.invocationCallOrder[0]).toBeLessThan(packets.close.mock.invocationCallOrder[0]);
    expect(FakeEncoder.current.state).toBe("closed");
  });

  it("surfaces write failures instead of successfully finalizing a partial track", async () => {
    const video = new QualityVideoSource(canvas, 60, 96);
    packets.add.mockRejectedValue(new Error("disk full"));
    FakeEncoder.current.emit(0);
    await expect(video.close()).rejects.toThrow("disk full");
    expect(packets.close).not.toHaveBeenCalled();
    expect(FakeEncoder.current.state).toBe("closed");
  });

  it("unblocks a saturated producer on cancellation", async () => {
    const video = new QualityVideoSource(canvas, 60, 96);
    for (let i = 0; i < 4; i++) await video.addFrame(i);
    const pending = expect(video.addFrame(4)).rejects.toMatchObject({ code: "export_interrupted" });
    await video.cancel();
    await pending;
    expect(FakeEncoder.current.encode).toHaveBeenCalledTimes(4);
  });

  it("unblocks a saturated producer when the native encoder fails", async () => {
    const video = new QualityVideoSource(canvas, 60, 96);
    for (let i = 0; i < 4; i++) await video.addFrame(i);
    const pending = expect(video.addFrame(4)).rejects.toThrow("codec failed");
    FakeEncoder.current.callbacks.error(new DOMException("codec failed"));
    await pending;
    await video.cancel();
  });
});
