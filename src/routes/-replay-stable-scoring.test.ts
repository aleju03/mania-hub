import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay stable scoring", () => {
  it("does not use lazer accuracy weighting for legacy Classic replays", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(source).toContain("const replayUsesLazerScoring = useMemo");
    expect(source).toContain("scoreInfo.legacy_score_id != null");
    expect(source).toContain("scoreInfo.legacy_total_score != null && scoreInfo.legacy_total_score > 0");
    expect(source).toContain("isLazer: replayUsesLazerScoring");
    expect(source).not.toContain("isLazer: displayScoreValues?.isLazer ?? false");
  });
});
