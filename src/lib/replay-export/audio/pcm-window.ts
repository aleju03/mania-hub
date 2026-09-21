// A bounded sliding view over decoded PCM.
//
// The resampler and the time stretcher both read the song by absolute source
// frame index, a little ahead of where they are writing and never far behind.
// This class is what makes that possible without holding the whole decoded
// song: chunks are pulled in on demand and dropped once the readers have
// moved past them.

import type { PcmWindow } from "./resample";

export type DecodedPcmChunk = {
  /** Absolute source frame index of the chunk's first sample. */
  startFrame: number;
  /** Planar Float32 data, one array per channel. */
  data: Float32Array[];
};

export type PcmChunkPuller = () => Promise<DecodedPcmChunk | null>;

export class SlidingPcmWindow implements PcmWindow {
  private chunks: DecodedPcmChunk[] = [];
  private from = 0;
  private to = 0;
  private done = false;
  private cursor = 0;
  private pulling: Promise<void> | null = null;

  constructor(
    readonly channels: number,
    private readonly pull: PcmChunkPuller,
    /** Absolute frame the stream is expected to start at. */
    startFrame = 0,
  ) {
    this.from = startFrame;
    this.to = startFrame;
  }

  get availableFrom(): number {
    return this.from;
  }

  get availableTo(): number {
    return this.to;
  }

  get ended(): boolean {
    return this.done;
  }

  /** Frames currently held in memory, across every retained chunk. */
  get bufferedFrames(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.data[0]?.length ?? 0;
    return total;
  }

  /** Pulls until frame `untilFrame` is readable or the source runs out. */
  async ensure(untilFrame: number): Promise<void> {
    while (!this.done && this.to < untilFrame) {
      if (!this.pulling) {
        this.pulling = this.pull().then((chunk) => {
          this.pulling = null;
          if (!chunk) {
            this.done = true;
            return;
          }
          if (this.chunks.length === 0) this.from = chunk.startFrame;
          this.chunks.push(chunk);
          this.to = chunk.startFrame + (chunk.data[0]?.length ?? 0);
        });
      }
      await this.pulling;
    }
  }

  /** Adds a chunk without a pull; used for PCM that is already decoded. */
  push(chunk: DecodedPcmChunk): void {
    if (this.chunks.length === 0) this.from = chunk.startFrame;
    this.chunks.push(chunk);
    this.to = chunk.startFrame + (chunk.data[0]?.length ?? 0);
  }

  /** Marks the source exhausted; later reads fall back to silence. */
  end(): void {
    this.done = true;
  }

  /** Drops chunks that end before `frame`; everything after stays readable. */
  discardBefore(frame: number): void {
    let dropped = 0;
    while (dropped < this.chunks.length) {
      const chunk = this.chunks[dropped];
      const end = chunk.startFrame + (chunk.data[0]?.length ?? 0);
      if (end > frame) break;
      dropped++;
    }
    if (dropped === 0) return;
    this.chunks = this.chunks.slice(dropped);
    this.cursor = 0;
    this.from = this.chunks[0]?.startFrame ?? this.to;
  }

  sample(channel: number, frame: number): number {
    if (frame < this.from || frame >= this.to) return 0;
    const chunks = this.chunks;
    // Reads walk forward, so start from where the last one landed.
    let index = this.cursor;
    if (index >= chunks.length) index = 0;
    for (let step = 0; step < chunks.length; step++) {
      const candidate = chunks[(index + step) % chunks.length];
      const offset = frame - candidate.startFrame;
      if (offset >= 0 && offset < (candidate.data[0]?.length ?? 0)) {
        this.cursor = (index + step) % chunks.length;
        const plane = candidate.data[Math.min(channel, candidate.data.length - 1)];
        return plane ? plane[offset] : 0;
      }
    }
    return 0;
  }

  release(): void {
    this.chunks = [];
    this.done = true;
    this.cursor = 0;
  }
}

/** A window over PCM that is already fully in memory. */
export function staticPcmWindow(data: Float32Array[], startFrame = 0): SlidingPcmWindow {
  const window = new SlidingPcmWindow(data.length, async () => null, startFrame);
  window.push({ startFrame, data });
  window.end();
  return window;
}
