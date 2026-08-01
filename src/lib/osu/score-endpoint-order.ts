export type ScoreEndpointKind = "legacy" | "modern";

// Stable mania score ids sit around 6.6e8 and grow slowly; lazer-era solo
// score ids (what tracker/top-plays links carry) are in the billions. Trying
// the endpoint that matches the id range first avoids a guaranteed 404 for
// the common case while keeping the other endpoint as a compatibility
// fallback.
export const LAZER_SCORE_ID_MIN = 1_000_000_000;

export function getScoreEndpointOrder(scoreId: number): ScoreEndpointKind[] {
  return scoreId >= LAZER_SCORE_ID_MIN ? ["modern", "legacy"] : ["legacy", "modern"];
}
