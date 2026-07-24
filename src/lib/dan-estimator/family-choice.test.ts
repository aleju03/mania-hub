import { describe, expect, it } from "vitest";
import type { ManiaBeatmap, ManiaNote } from "../beatmap-parser";
import { extractDanFeatures } from "./features";
import { chooseSkillFamily } from "./family-choice";
import { estimateFamilyScores } from "./scoring";

function makeMap(keyCount: number, rows: number[][], intervalMs = 100): ManiaBeatmap {
  const notes: ManiaNote[] = [];
  rows.forEach((columns, index) => {
    for (const column of columns) {
      notes.push({
        column,
        time: index * intervalMs,
        endTime: index * intervalMs,
        isHold: false,
      });
    }
  });
  return {
    title: "Synthetic",
    artist: "Test",
    version: `${keyCount}K`,
    creator: "mania-hub",
    keyCount,
    od: 8,
    bpm: 150,
    notes,
    totalLength: rows.length * intervalMs,
    audioFilename: "",
    previewTime: 0,
    backgroundFilename: "",
    breakPeriods: [],
    scrollVelocities: [],
  };
}

function repeatRows(pattern: number[][], times: number): number[][] {
  return Array.from({ length: times }).flatMap(() => pattern);
}

function familyFor(rows: number[][]): string {
  const map = makeMap(7, rows);
  const features = extractDanFeatures(map, {}, 1);
  const { skillScores } = estimateFamilyScores(features.metrics, 6.5, features.durationMs);
  return chooseSkillFamily(skillScores, features.metrics).family;
}

describe("chooseSkillFamily", () => {
  it("never picks chordjack for hand-alternating chords without column re-hits", () => {
    // Every row is a chord (chordRatio ~1) but consecutive chords never share
    // a column - dense 7K bracket motion. The density-driven chordjack score
    // tops the raw ranking here, so both the dense-chordjack rule and the
    // top-score fallback must treat the family as ineligible.
    const family = familyFor(repeatRows([[0, 1, 2], [4, 5, 6], [1, 2, 3], [4, 5, 6]], 30));
    expect(family).not.toBe("chordjack");
  });

  it("keeps chordjack reachable exactly when consecutive chords re-hit their columns", () => {
    const map = makeMap(7, repeatRows([[0, 2, 4], [0, 2, 4], [1, 3, 5], [1, 3, 5]], 30));
    const features = extractDanFeatures(map, {}, 1);
    const { skillScores } = estimateFamilyScores(features.metrics, 6.5, features.durationMs);
    // Force chordjack to the top of the raw ranking so the choice hinges on
    // eligibility alone.
    const boosted = { ...skillScores, chordjack: Math.max(...Object.values(skillScores)) + 1 };
    expect(features.metrics.chordColumnOverlapRatio).toBeGreaterThan(0.25);
    expect(chooseSkillFamily(boosted, features.metrics).family).toBe("chordjack");
    expect(chooseSkillFamily(boosted, { ...features.metrics, chordColumnOverlapRatio: 0.1 }).family).not.toBe("chordjack");
  });
});
