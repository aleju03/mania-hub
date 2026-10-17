import type { SupporterCardSleeveId } from "#/lib/supporter-pack-style";
import type { CardMotif } from "#/lib/card-motif";
import type { SupporterLook } from "#/lib/supporter-card-looks";
import type { SupporterFoilId } from "#/lib/supporter-foils";
import type { ManiaCardTier, ManiaCardTierStyle, ManiaSkills, NextManiaCardTier } from "#/lib/maniacard";
import type { OsuScore, OsuUser } from "#/lib/types";

export interface ManiaCardPanelProps {
  user: Pick<OsuUser, "id" | "username" | "avatar_url" | "country_code"> & {
    statistics?: { global_rank: number | null; pp?: number };
  };
  scores: OsuScore[];
  /** Full-window skills supplied by surfaces that intentionally carry only a partial score list. */
  precomputedSkills?: ManiaSkills;
  loading: boolean;
  /** True only when the signed-in viewer is looking at their own card. Gates the "You" ladder badge. */
  isOwnProfile?: boolean;
  /** Forces a tier instead of deriving it from cardPower. Preview-only. */
  tierOverride?: ManiaCardTier;
  /** A team card: the banner face, and a rating explainer with only the ladder. */
  team?: ManiaCardTeamInput;
  /** Draws this supporter look instead of the one fetched for the player:
      a look object previews it, null previews the plain card. Undefined
      (the default) fetches the player's own. */
  supporterLookOverride?: SupporterLook | null;
  /** False leaves out the rating and next-tier progress beside the card. */
  showTierProgress?: boolean;
  /** The case the card is kept in (a supporter's sleeve), drawn around it in 3D. */
  sleeve?: SupporterCardSleeveId | null;
}

export interface ManiaCardTeamInput {
  /* The team flag and header, already CORS-safe (/api/team-image). */
  flagUrl: string | null;
  coverUrl: string | null;
  tag: string;
}

/* What the banner face draws for a team beyond the player card's fields. */
export interface ManiaCardTeamFace {
  tag: string;
  /* The team header for the banner; the flag (avatarUrl) then sits over the
     banner's edge. Null draws the flag as the banner. */
  coverUrl: string | null;
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
  /* Replaces whatever this tier would have floated in the background - the
     triangle flecks, or the cosmic tiers' starfield - with one image. Only a
     holding granted from /admin/collections has one. */
  motif: CardMotif | null;
  /* The player is an active supporter: the foil they picked plays over the
     card (flat surfaces bake the holo still for every foil). Independent of
     motif, which may be the holding's own art or the supporter's chosen one. */
  supporterFoil?: SupporterFoilId;
  /* Set on a team card, which draws the banner face instead of the player's. */
  team?: ManiaCardTeamFace | null;
}

export interface ManiaCardEmptyData {
  status: "empty";
  message: string;
}

export type ManiaCardRenderData = ManiaCardReadyData | ManiaCardEmptyData;

export interface ManiaCardRenderInput {
  user: ManiaCardPanelProps["user"];
  scores: OsuScore[];
  tierOverride?: ManiaCardTier;
  /* Badge text in place of the tier's name, for a holding that carries its
     own (a milestone card dealt by the server); see labelOverride below. */
  labelOverride?: string | null;
  motifOverride?: CardMotif | null;
  /* The player's supporter look; see buildManiaCardRenderDataFromSkills. */
  supporterLook?: SupporterLook | null;
}
