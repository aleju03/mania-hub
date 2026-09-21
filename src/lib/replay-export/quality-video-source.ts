import { EncodedPacket, EncodedVideoPacketSource } from "mediabunny";
import { ReplayExportError } from "./errors";
import { REPLAY_EXPORT_KEYFRAME_SECONDS, av1QualityEncoderConfig } from "./video-quality";

const MAX_QUEUED_FRAMES = 4;

/** Native quality-controlled AV1, feeding the same muxer and file writer as H.264. */
export class QualityVideoSource {
  readonly source = new EncodedVideoPacketSource("av1");
  private readonly encoder: VideoEncoder;
  private writes: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly fps: number,
    private readonly quantizer: number,
  ) {
    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (this.stopped) return;
        const packet = EncodedPacket.fromEncodedChunk(chunk);
        // Packet order and the writer's backpressure both matter. A slow
        // destination must hold up the producer instead of accumulating bytes.
        this.writes = this.writes.then(async () => {
          if (!this.stopped && !this.failure) await this.source.add(packet, metadata);
        }).catch((error) => this.fail(error));
      },
      error: (error) => this.fail(error),
    });
    try {
      this.encoder.configure(av1QualityEncoderConfig(canvas.width, canvas.height, fps));
    } catch (error) {
      this.encoder.close();
      throw error;
    }
  }

  private fail(error: unknown): void {
    this.failure ??= error;
    this.wake?.();
  }

  private check(): void {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new ReplayExportError("export_interrupted");
  }

  async addFrame(index: number): Promise<void> {
    this.check();
    while (this.encoder.encodeQueueSize >= MAX_QUEUED_FRAMES) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.encoder.removeEventListener("dequeue", wake);
          this.wake = null;
          resolve();
        };
        this.wake = wake;
        this.encoder.addEventListener("dequeue", wake, { once: true });
      });
      this.check();
    }
    await this.writes;
    this.check();
    const frame = new VideoFrame(this.canvas, {
      timestamp: Math.round(index * 1_000_000 / this.fps),
      duration: Math.round(1_000_000 / this.fps),
    });
    try {
      // AV1's WebCodecs extension uses a 0–255 quantizer index. The DOM
      // declarations don't yet include this codec-specific encode option.
      const options: VideoEncoderEncodeOptions & { av1: { quantizer: number } } = {
        keyFrame: index % (this.fps * REPLAY_EXPORT_KEYFRAME_SECONDS) === 0,
        av1: { quantizer: this.quantizer },
      };
      this.encoder.encode(frame, options);
    } finally {
      frame.close();
    }
  }

  async close(): Promise<void> {
    this.check();
    try {
      await this.encoder.flush();
      await this.writes;
      this.check();
      this.source.close();
    } finally {
      if (this.encoder.state !== "closed") this.encoder.close();
    }
  }

  async cancel(): Promise<void> {
    this.stopped = true;
    if (this.encoder.state !== "closed") this.encoder.close();
    this.wake?.();
    // Let an already-started write settle before the destination is aborted.
    await this.writes;
  }
}
