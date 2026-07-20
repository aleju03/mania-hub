import type { ManiaCardTier, ManiaCardTierStyle, ManiaSkills, NextManiaCardTier } from "#/lib/maniacard";
import type { OsuScore, OsuUser } from "#/lib/types";

export interface ManiaCardPanelProps {
  user: Pick<OsuUser, "id" | "username" | "avatar_url" | "country_code"> & {
    statistics?: { global_rank: number | null; pp?: number };
  };
  scores: OsuScore[];
  loading: boolean;
  /** True only when the signed-in viewer is looking at their own card. Gates the "You" ladder badge. */
  isOwnProfile?: boolean;
}

export interface ManiaCardStat {
  label: "Control" | "Speed" | "Precision";
  value: number;
}

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface GradientStop {
  color: string;
  offset: number;
}

export interface ManiaCardReadyData {
  status: "ready";
  user: ManiaCardPanelProps["user"];
  avatarUrl: string;
  scores: OsuScore[];
  skills: ManiaSkills;
  tier: ManiaCardTier;
  tierStyle: ManiaCardTierStyle;
  nextTier: NextManiaCardTier | null;
  stats: ManiaCardStat[];
  edgeColor: RgbaColor;
  glowColor: RgbaColor;
  badgeGradientStops: GradientStop[];
}

export interface ManiaCardEmptyData {
  status: "empty";
  message: string;
}

export type ManiaCardRenderData = ManiaCardReadyData | ManiaCardEmptyData;

export interface ManiaCardRenderInput {
  user: ManiaCardPanelProps["user"];
  scores: OsuScore[];
}
