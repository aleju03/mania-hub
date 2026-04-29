import { describe, expect, test } from "vitest";
import { buildFaceLayout, type MeasureText } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

const measure: MeasureText = (text, size) => text.length * size * 0.55;

const data = {
  status: "ready",
  user: { id: 1, username: "LongLongLongLongLongName", country_code: "US", statistics: { global_rank: 10 } },
  avatarUrl: "/api/avatar?u=1",
  tier: "ultraRare",
  tierStyle: {
    label: "Ultra Rare",
    background: "",
    border: "",
    glow: "",
    edgeFill: "rgba(131, 24, 67, 0.94)",
    glowColor: "rgba(251, 113, 133, 0.4)",
    starColor: "text-amber-300",
    badgeColor: "text-rose-50",
    badgeGradient: "",
    badgeHalo: "rgba(251,113,133,0.58)",
    badgeGlyphShadow: "rgba(88,28,135,0.45)",
  },
  edgeColor: { r: 131, g: 24, b: 67, a: 0.94 },
  glowColor: { r: 251, g: 113, b: 133, a: 0.4 },
  badgeGradientStops: [
    { color: "#ff8ec4", offset: 0 },
    { color: "#ff3d8a", offset: 0.44 },
    { color: "#b81f68", offset: 1 },
  ],
  scores: [],
  skills: {
    starAvg: 6.45,
    fingerControl: 812,
    speed: 744,
    accuracy: 901,
    stamina: 650,
    versatility: 580,
    peak: 820,
    cardPower: 500,
    mainKeyMode: 4,
    archetype: "Hybrid",
    sampleSize: 1,
  },
  stats: [
    { label: "Control", value: 812 },
    { label: "Speed", value: 744 },
    { label: "Precision", value: 901 },
  ],
} as ManiaCardReadyData;

describe("buildFaceLayout", () => {
  test("builds front commands with fitted username and avatar mask metadata", () => {
    const layout = buildFaceLayout(data, measure);

    expect(layout.front.username.text.endsWith("...")).toBe(true);
    expect(layout.front.avatar).toEqual({ x: 185, y: 280, size: 630, radius: 32 });
    expect(layout.front.tierLabel.text).toBe("Ultra Rare");
    expect(layout.masks.avatar).toEqual({ x: 185, y: 280, width: 630, height: 630 });
    expect(layout.front.stats.map((stat) => stat.label)).toEqual(["Control", "Speed", "Precision"]);
  });

  test("builds back commands from the same tier label", () => {
    const layout = buildFaceLayout(data, measure);

    expect(layout.back.rarityLabel).toBe("ULTRA RARE");
    expect(layout.back.logoCenter).toEqual({ x: 500, y: 700 });
  });
});
