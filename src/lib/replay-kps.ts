// Peak KPS at each keypress, in game time. Build once per chart/rate so a HUD
// refresh or backwards seek only needs a binary search, not a replay-wide scan.
export function buildReplayPeakKps(
  sortedPresses: readonly number[],
  windowMs: number,
  rate: number,
): Uint32Array {
  const peaks = new Uint32Array(sortedPresses.length);
  let start = 0;
  let peak = 0;
  for (let end = 0; end < sortedPresses.length; end++) {
    const windowStart = Math.max(0, sortedPresses[end] - windowMs * rate);
    while (start <= end && sortedPresses[start] < windowStart) start++;
    peak = Math.max(peak, end - start + 1);
    peaks[end] = peak;
  }
  return peaks;
}

export function replayPeakKpsAt(
  sortedPresses: readonly number[],
  peaks: Uint32Array,
  time: number,
  windowMs: number,
): number {
  let lo = 0;
  let hi = sortedPresses.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedPresses[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : peaks[lo - 1] * (1000 / windowMs);
}
