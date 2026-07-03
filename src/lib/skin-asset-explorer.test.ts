import { describe, expect, it } from "vitest";

import { buildSkinAssetGroups, extractSkinIniStageReferences } from "./skin-asset-explorer";

describe("buildSkinAssetGroups", () => {
  it("collapses @2x variants and animation frames into one entry", () => {
    const groups = buildSkinAssetGroups([
      { path: "mania-hit300-0.png", size: 100 },
      { path: "mania-hit300-1.png", size: 100 },
      { path: "mania-hit300-0@2x.png", size: 200 },
      { path: "aleju\\inst.png", size: 400 },
      { path: "aleju/inst@2x.png", size: 800 },
    ]);
    const judgements = groups.find((group) => group.key === "judgements");
    expect(judgements?.entries).toHaveLength(1);
    expect(judgements?.entries[0].frameCount).toBe(2);
    // @2x frame wins as the shown image
    expect(judgements?.entries[0].primaryPath).toBe("mania-hit300-0@2x.png");
    const other = groups.find((group) => group.key === "other");
    expect(other?.entries).toHaveLength(1);
    expect(other?.entries[0].primaryPath).toBe("aleju/inst@2x.png");
    expect(other?.entries[0].totalBytes).toBe(1200);
  });

  it("shows the real animation art over a blanked 1x1 still", () => {
    const groups = buildSkinAssetGroups([
      { path: "mania-hit300.png", size: 68 },
      { path: "mania-hit300-0.png", size: 909 },
    ]);
    const judgements = groups.find((group) => group.key === "judgements");
    expect(judgements?.entries).toHaveLength(1);
    expect(judgements?.entries[0].primaryPath).toBe("mania-hit300-0.png");
  });

  it("keeps font digits as separate glyphs instead of merging them as frames", () => {
    const groups = buildSkinAssetGroups([
      { path: "score-0.png", size: 10 },
      { path: "score-1.png", size: 10 },
      { path: "combo-7.png", size: 10 },
    ]);
    const hud = groups.find((group) => group.key === "hud");
    expect(hud?.entries.map((entry) => entry.name).sort()).toEqual(["combo-7", "score-0", "score-1"]);
  });

  it("categorizes stage pieces, pause overlay, keys, and sounds", () => {
    const groups = buildSkinAssetGroups([
      { path: "mania-stage-left.png", size: 10 },
      { path: "mania-stage-bottom.png", size: 10 },
      { path: "4k/stagehint.png", size: 10 },
      { path: "pause-overlay.png", size: 10 },
      { path: "pause-continue.png", size: 10 },
      { path: "mania-key1.png", size: 10 },
      { path: "normal-hitnormal.wav", size: 10 },
      { path: "combobreak.mp3", size: 10 },
    ]);
    const byKey = new Map(groups.map((group) => [group.key, group.entries.length]));
    expect(byKey.get("stage")).toBe(3);
    expect(byKey.get("gameplay")).toBe(2);
    expect(byKey.get("keys")).toBe(1);
    expect(byKey.get("sounds")).toBe(2);
  });

  it("ignores non-media files", () => {
    const groups = buildSkinAssetGroups([
      { path: "skin.ini", size: 10 },
      { path: "readme.txt", size: 10 },
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe("extractSkinIniStageReferences", () => {
  it("reads stage keys per mania block and skips commented lines", () => {
    const refs = extractSkinIniStageReferences([
      "[General]",
      "Name: test",
      "[Mania]",
      "Keys: 4",
      "//StageBottom: 4k\\stagehint",
      "StageLeft: 4k\\left",
      "[Mania]",
      "Keys: 8",
      "StageBottom: 8k\\hint",
    ].join("\n"));
    expect(refs).toEqual([
      { keys: 4, property: "StageLeft", reference: "4k/left" },
      { keys: 8, property: "StageBottom", reference: "8k/hint" },
    ]);
  });
});
