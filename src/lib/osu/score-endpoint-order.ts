export type ScoreEndpointKind = "legacy" | "modern";

// Lazer-era solo score ids (what tracker/top-plays links carry) are in the
// billions, so ids above this line try the modern endpoint first. It is a
// routing heuristic only: stable's per-mode legacy ids have also crossed a
// billion, so the two namespaces overlap and an id can resolve on BOTH
// endpoints — to different plays. Callers must validate what comes back
// (getScore checks the ruleset; the upload viewer checks the beatmap).
export const LAZER_SCORE_ID_MIN = 1_000_000_000;

export function getScoreEndpointOrder(scoreId: number): ScoreEndpointKind[] {
  return scoreId >= LAZER_SCORE_ID_MIN ? ["modern", "legacy"] : ["legacy", "modern"];
}

const RULESET_ID_TO_MODE = ["osu", "taiko", "fruits", "mania"] as const;

// The play's own ruleset from whichever field the response shape carries
// (legacy: mode/mode_int, solo_score: ruleset_id). Never falls back to
// beatmap.mode — that reads "osu" for convert plays, which are still mania
// scores. Null when the response carries no usable signal.
export function getOsuScoreModeName(
  score: { mode?: string | null; mode_int?: number | null; ruleset_id?: number | null },
): string | null {
  if (typeof score.mode === "string" && score.mode) return score.mode;
  const rulesetId = score.ruleset_id ?? score.mode_int;
  if (typeof rulesetId !== "number") return null;
  return RULESET_ID_TO_MODE[rulesetId] ?? null;
}
