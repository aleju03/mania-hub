import type { ReplayThumbHand } from "./replay-overlays";

export type ReplayHand = "left" | "right";

/**
 * Splits mania columns between hands. In odd keymodes the configurable thumb
 * owns the middle column, matching the replay viewer's L/R miss counter.
 */
export function getReplayHandForColumn(
  column: number,
  keyCount: number,
  middleLaneThumb: ReplayThumbHand,
): ReplayHand | null {
  if (column < 0 || column >= keyCount) return null;

  const leftCount = keyCount % 2 === 1 && middleLaneThumb === "left"
    ? Math.ceil(keyCount / 2)
    : Math.floor(keyCount / 2);
  return column < leftCount ? "left" : "right";
}
