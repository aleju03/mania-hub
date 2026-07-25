import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay stable scoring", () => {
  it("does not use lazer accuracy weighting for legacy Classic replays", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    // The legacy checks live in scoreUsesLazerScoring (src/lib/score.ts, via
    // isLegacySubmittedScore); the viewer must judge with that flag (plus the
    // client what-if override) rather than the display flavor of the API
    // score shape.
    expect(source).toContain("const sourceIsLazer = useMemo(() => scoreUsesLazerScoring(scoreInfo)");
    expect(source).toContain("const judgeAsLazer = clientJudgeAsLazer ?? sourceIsLazer;");
    expect(source).toContain("isLazer: judgeAsLazer");
    expect(source).not.toContain("isLazer: displayScoreValues?.isLazer ?? false");
    // Cross-judging must not reconcile against the real score's counts, and
    // frame rounding follows the source replay, not the judging ruleset.
    expect(source).toContain("judgeAsLazer === sourceIsLazer ? getScoreExpectedCounts(scoreInfo, replay) : undefined");
    expect(source).toContain("legacyReplayFrameRounding: !sourceIsLazer");

    const scoreSource = fs.readFileSync(path.resolve(__dirname, "../lib/score.ts"), "utf8");
    expect(scoreSource).toContain("return score.legacy_score_id != null || !!(score.legacy_total_score && score.legacy_total_score > 0);");
    expect(scoreSource).toContain("export function scoreUsesLazerScoring");
  });
});
