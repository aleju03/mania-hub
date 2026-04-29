import {
  computeManiaSkills,
  getManiaCardTier,
  MANIA_TIER_STYLES,
} from "../../../lib/maniacard";
import type {
  GradientStop,
  ManiaCardRenderData,
  ManiaCardRenderInput,
  RgbaColor,
} from "./types";

const EMPTY_CARD_MESSAGE = "Need at least one ranked play with full beatmap data to mint a card.";

export function buildManiaCardRenderData({ user, scores }: ManiaCardRenderInput): ManiaCardRenderData {
  const skills = computeManiaSkills(scores.map((score) => ({
    ...score,
    statistics: score.statistics ?? {},
  })));
  if (!skills) {
    return { status: "empty", message: EMPTY_CARD_MESSAGE };
  }

  const tier = getManiaCardTier(skills.cardPower);
  const tierStyle = MANIA_TIER_STYLES[tier];

  return {
    status: "ready",
    user,
    avatarUrl: `/api/avatar?u=${user.id}`,
    scores,
    skills,
    tier,
    tierStyle,
    stats: [
      { label: "Control", value: skills.fingerControl },
      { label: "Speed", value: skills.speed },
      { label: "Precision", value: skills.accuracy },
    ],
    edgeColor: parseCssRgba(tierStyle.edgeFill),
    glowColor: parseCssRgba(tierStyle.glowColor),
    badgeGradientStops: parseGradientStops(tierStyle.badgeGradient),
  };
}

export function parseCssRgba(value: string): RgbaColor {
  const [r = 168, g = 85, b = 247, a = 1] = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return { r, g, b, a };
}

export function parseGradientStops(value: string): GradientStop[] {
  const stopPattern = /(#[0-9a-fA-F]{3,8})\s+([\d.]+)%/g;
  const stops: GradientStop[] = [];
  let match: RegExpExecArray | null;
  while ((match = stopPattern.exec(value)) !== null) {
    stops.push({
      color: match[1]!,
      offset: Number(match[2]) / 100,
    });
  }
  return stops;
}
