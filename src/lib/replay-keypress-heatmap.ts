import type { ReplayFrame } from "./types";

const DEFAULT_BUCKETS = 120;

function popcount(n: number): number {
  let v = n | 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function buildKeypressHeatmap(
  frames: ReplayFrame[],
  duration: number,
  buckets: number = DEFAULT_BUCKETS,
): number[] {
  if (duration <= 0 || frames.length < 2 || buckets <= 0) return [];

  const counts = new Array<number>(buckets).fill(0);
  let prev = frames[0].keyState;
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    const rising = frame.keyState & ~prev;
    if (rising !== 0) {
      const t = frame.time;
      if (t >= 0 && t <= duration) {
        const idx = Math.min(buckets - 1, Math.floor((t / duration) * buckets));
        counts[idx] += popcount(rising);
      }
    }
    prev = frame.keyState;
  }

  let smoothed = counts;
  for (let pass = 0; pass < 4; pass++) {
    const next = new Array<number>(buckets);
    for (let i = 0; i < buckets; i++) {
      const a = i > 0 ? smoothed[i - 1] : smoothed[i];
      const b = smoothed[i];
      const c = i < buckets - 1 ? smoothed[i + 1] : smoothed[i];
      next[i] = (a + b + c) / 3;
    }
    smoothed = next;
  }

  let max = 0;
  for (let i = 0; i < buckets; i++) if (smoothed[i] > max) max = smoothed[i];
  if (max <= 0) return [];

  for (let i = 0; i < buckets; i++) smoothed[i] = smoothed[i] / max;
  return smoothed;
}
