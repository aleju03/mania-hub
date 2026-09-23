import { describe, expect, test } from "vitest";
import { buildFaceLayout, type MeasureText } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

const measure: MeasureText = (text, size) => text.length * size * 0.55;

const data = {
  status: "ready",
  user: { id: 1, username: "LongLongLongLongLongName", avatar_url: "", country_code: "US", statistics: { global_rank: 10 } },
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
  nextTier: {
    tier: "legendary",
    label: "Legendary",
    currentTier: "ultraRare",
    currentLabel: "Ultra Rare",
    threshold: 470,
    remaining: 70,
    progress: 0.6,
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
} as unknown as ManiaCardReadyData;

describe("buildFaceLayout", () => {
  test("builds front commands with fitted username and avatar mask metadata", () => {
    const layout = buildFaceLayout(data, measure);

    expect(layout.front.username.text.endsWith("...")).toBe(true);
    expect(layout.front.avatar).toEqual({ x: 185, y: 280, size: 630, radius: 32 });
    expect(layout.front.tierLabel.text).toBe("Ultra Rare");
    expect(layout.masks.avatar).toEqual({ x: 185, y: 280, width: 630, height: 630 });
    expect(layout.masks.flag).toBeNull();
    expect(layout.front.team).toBeNull();
    expect(layout.front.stats.map((stat) => stat.label)).toEqual(["Control", "Speed", "Precision"]);
  });

  test("lays a team card out as a spine with the tag down it", () => {
    const layout = buildFaceLayout(
      { ...data, user: { ...data.user, username: "7k LOVERS" }, team: { tag: "7LUV", coverUrl: "/api/team-image?path=x" } },
      measure,
    );
    const team = layout.front.team!;

    expect(team.spine).toEqual({ x: 0, y: 0, width: 270, height: 1400 });
    expect(team.tag.letters.map((letter) => letter.text)).toEqual(["7", "L", "U", "V"]);
    for (const letter of team.tag.letters) {
      expect(letter.x).toBe(135);
      expect(measure(letter.text, team.tag.fontSize, "Torus", 900)).toBeLessThanOrEqual(270);
    }
    const ys = team.tag.letters.map((letter) => letter.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[0] - team.tag.fontSize / 2).toBeGreaterThan(0);
    expect(ys[ys.length - 1] + team.tag.fontSize / 2).toBeLessThan(1400);
    expect(team.name.lines).toEqual(["7k LOVERS"]);
    expect(layout.front.tierLabel.align).toBe("left");
    expect(layout.masks.avatar).toEqual(team.spine);
    expect(layout.masks.flag?.rect).toEqual(team.flag);
    // The three numbers stay apart at their size.
    const [first, second] = layout.front.stats;
    const widest = Math.max(...layout.front.stats.map((stat) => measure(String(stat.value), team.statValueSize, "Torus", 900)));
    expect(second.x - first.x - widest).toBeGreaterThanOrEqual(40);
  });

  test("wraps a long team name onto two lines and truncates the rest", () => {
    const layout = buildFaceLayout(
      {
        ...data,
        user: { ...data.user, username: "Seguidores de la Llanta Muy Larga Que No Cabe En Dos Lineas" },
        team: { tag: "LLNT", coverUrl: null },
      },
      measure,
    );
    const name = layout.front.team!.name;

    expect(name.lines).toHaveLength(2);
    expect(name.lines[1].endsWith("...")).toBe(true);
    for (const line of name.lines) expect(measure(line, name.fontSize, "Torus", 800)).toBeLessThanOrEqual(646);
    expect(layout.front.tierLabel.y).toBe(name.y + name.lineHeight + 76);
  });

  test("builds back commands from the same tier label", () => {
    const layout = buildFaceLayout(data, measure);

    expect(layout.back.rarityLabel).toBe("ULTRA RARE");
    expect(layout.back.logoCenter).toEqual({ x: 500, y: 700 });
  });
});
