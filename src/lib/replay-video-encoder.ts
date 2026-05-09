import { ArrayBufferTarget, Muxer } from "mp4-muxer";

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

function getVideoEncoder(): typeof VideoEncoder {
  if (typeof VideoEncoder === "undefined") {
    throw new Error("This browser cannot export MP4 replays because WebCodecs VideoEncoder is unavailable.");
  }
  return VideoEncoder;
}

async function pickAvcCodec(width: number, height: number, bitrate: number, fps: number): Promise<string> {
  const encoder = getVideoEncoder();
  const candidates = [
    "avc1.64002A",
    "avc1.640028",
    "avc1.4D402A",
    "avc1.42E01F",
  ];

  for (const codec of candidates) {
    const support = await encoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: "prefer-hardware",
      avc: { format: "avc" },
    }).catch(() => null);
    if (support?.supported) return codec;
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
  const VideoEncoderCtor = getVideoEncoder();
  const codec = await pickAvcCodec(width, height, bitrate, fps);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: "avc",
      width,
      height,
      frameRate: fps,
    },
    fastStart: { expectedVideoChunks: frameCount },
  });
  const frameDurationUs = Math.round(1_000_000 / fps);
  let encodeError: Error | null = null;

  const encoder = new VideoEncoderCtor({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (error) => {
      encodeError = error instanceof Error ? error : new Error(String(error));
    },
  });

  encoder.configure({
    codec,
    width,
    height,
    bitrate,
    framerate: fps,
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "avc" },
  });

  try {
    for (let index = 0; index < frameCount; index++) {
      if (encodeError) throw encodeError;
      await renderFrame(index);
      const frame = new VideoFrame(canvas, {
        timestamp: index * frameDurationUs,
        duration: frameDurationUs,
      });
      encoder.encode(frame, { keyFrame: index === 0 || index % (fps * 2) === 0 });
      frame.close();
      if (encoder.encodeQueueSize > 4) {
        await encoder.flush();
      }
      onProgress?.((index + 1) / frameCount);
    }

    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    if (encoder.state !== "closed") {
      encoder.close();
    }
  }
}
