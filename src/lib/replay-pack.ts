import type { ReplayFrame } from "./types";

export type PackedReplayFrames = { count: number; times: string; keys: string };

// Frames as two base64-packed typed arrays (Int32 times, Uint32 keys), ~20x
// smaller on the wire than JSON frame objects. Little-endian host is assumed
// on both ends (every x86/ARM server and client is LE); unpackReplayFrames in
// replay-frames.ts is the reader. Server-only: Buffer does the base64.
export function packReplayFrames(frames: ReplayFrame[]): PackedReplayFrames {
  const count = frames.length;
  const times = new Int32Array(count);
  const keys = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    times[i] = frames[i].time | 0;
    keys[i] = frames[i].keyState;
  }
  return {
    count,
    times: Buffer.from(times.buffer, times.byteOffset, times.byteLength).toString("base64"),
    keys: Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength).toString("base64"),
  };
}
