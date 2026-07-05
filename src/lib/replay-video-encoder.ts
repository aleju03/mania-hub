import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, canEncodeVideo } from "mediabunny";

export type ReplayVideoEncodeOptions = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  bitrate: number;
  renderFrame: (index: number) => void | Promise<void>;
  onProgress?: (progress: number) => void;
};

async function pickHardwareAcceleration(
  width: number,
  height: number,
  bitrate: number,
): Promise<"prefer-hardware" | "no-preference"> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("This browser cannot export MP4 replays because WebCodecs VideoEncoder is unavailable.");
  }
  if (await canEncodeVideo("avc", { width, height, bitrate, hardwareAcceleration: "prefer-hardware" })) {
    return "prefer-hardware";
  }
  if (await canEncodeVideo("avc", { width, height, bitrate })) {
    return "no-preference";
  }
  throw new Error("This browser cannot export H.264 MP4 replays with WebCodecs.");
}

export async function encodeReplayCanvasToMp4({
  canvas,
  width,
  height,
  fps,
  frameCount,
  bitrate,
  renderFrame,
  onProgress,
}: ReplayVideoEncodeOptions): Promise<Blob> {
  const hardwareAcceleration = await pickHardwareAcceleration(width, height, bitrate);
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });
  const source = new CanvasSource(canvas, {
    codec: "avc",
    bitrate,
    keyFrameInterval: 2,
    hardwareAcceleration,
  });
  output.addVideoTrack(source, { frameRate: fps });

  try {
    await output.start();
    for (let index = 0; index < frameCount; index++) {
      await renderFrame(index);
      // Awaiting add() respects encoder and writer backpressure.
      await source.add(index / fps, 1 / fps);
      onProgress?.((index + 1) / frameCount);
    }
    source.close();
    await output.finalize();
  } catch (error) {
    if (output.state === "pending" || output.state === "started") {
      await output.cancel().catch(() => {});
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (!target.buffer) {
    throw new Error("MP4 muxing produced no output buffer.");
  }
  return new Blob([target.buffer], { type: "video/mp4" });
}
