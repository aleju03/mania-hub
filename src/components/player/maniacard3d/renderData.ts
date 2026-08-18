import { avatarImageSrc } from "#/components/ui/Avatar";
import { cardMotifSignature, type CardMotif } from "#/lib/card-motif";
import { honoraryAvatarUrl, honoraryPlayerById } from "#/lib/honorary-players";
import {
  computeManiaSkills,
  getHonoraryTier,
  getManiaCardTier,
  getNextManiaCardTier,
  MANIA_TIER_STYLES,
  type ManiaCardTier,
  type ManiaSkills,
} from "#/lib/maniacard";
import type {
  GradientStop,
  ManiaCardRenderData,
  ManiaCardRenderInput,
  ManiaCardReadyData,
  RgbaColor,
} from "./types";

const EMPTY_CARD_MESSAGE = "Need at least one ranked play with full beatmap data to mint a card.";

/* The CORS-proxied avatar URL the card textures draw from. Exported so reveal
   flows can warm the browser cache before the texture pipeline needs it. */
export function maniaCardAvatarUrl(user: { id: number; avatar_url?: string }): string {
  // A pack card renders from the identity the catalog stored, which for the
  // archived roster is empty or osu!'s guest default, so the checked-in
  // portrait is reapplied here rather than on each surface. Same-origin, so it
  // skips the proxy and is already CORS-safe for the canvas.
  const archived = honoraryAvatarUrl(user.id);
  if (archived) return archived;
  return avatarImageSrc(user.avatar_url, user.id, { proxy: true }) ?? `/api/avatar?u=${user.id}`;
}

export function buildManiaCardRenderData({ user, scores, tierOverride, motifOverride }: ManiaCardRenderInput): ManiaCardRenderData {
  const skills = computeManiaSkills(
    scores.map((score) => ({
      ...score,
      statistics: score.statistics ?? {},
    })),
    { globalPp: user.statistics?.pp },
  );
  if (!skills) {
    return { status: "empty", message: EMPTY_CARD_MESSAGE };
  }

  return buildManiaCardRenderDataFromSkills({ user, skills, scores, tierOverride, motifOverride });
}

/* Rebuilds renderable card data from an already computed skills snapshot.
   The texture pipeline never reads scores, so surfaces that persist skills
   (the pack collection) can redraw the exact card front without refetching
   the player's plays. */
export function buildManiaCardRenderDataFromSkills({
  user,
  skills,
  scores = [],
  tierOverride,
  labelOverride,
  motifOverride,
}: {
  user: ManiaCardRenderInput["user"];
  skills: ManiaSkills;
  scores?: ManiaCardRenderInput["scores"];
  tierOverride?: ManiaCardTier;
  /* Badge text for one holding, from /admin/collections. Same slot the
     honorary roster's cardTierLabel uses and wins over it, because it names
     one collector's own copy rather than the player: a GOAT card given to one
     person reading something else must not reword everyone else's. */
  labelOverride?: string | null;
  /* Background art for one holding, from /admin/collections. Same shape of
     override as the badge text above: it belongs to this collector's copy, so
     it is passed in per card rather than read off the tier. */
  motifOverride?: CardMotif | null;
}): ManiaCardReadyData {
  const honoraryTier = getHonoraryTier(user.id);
  const tier = tierOverride ?? honoraryTier ?? getManiaCardTier(skills.cardPower);
  const baseStyle = MANIA_TIER_STYLES[tier];
  // Card-art overrides for the honorary roster: a name the community knows the
  // player by, and a personalised badge. They apply to the card only - the
  // profile link keeps the real username - and never to a forced tier.
  const honorary = tier === honoraryTier ? honoraryPlayerById(user.id) : null;
  const label = labelOverride?.trim() || honorary?.cardTierLabel;
  const tierStyle = label ? { ...baseStyle, label } : baseStyle;
  const cardUser = honorary?.cardName ? { ...user, username: honorary.cardName } : user;
  // An honorary tier sits off the cardPower ladder, so there is nothing to
  // progress toward and the ladder strip stays hidden.
  const nextTier = tierOverride || honoraryTier ? null : getNextManiaCardTier(skills.cardPower);

  return {
    status: "ready",
    user: cardUser,
    // Card textures go onto a canvas, so they need the CORS-bearing proxy
    // rather than a.ppy.sh directly. Passing the stored avatar URL through
    // carries osu!'s version token into the proxy URL, which makes each one
    // immutable and lets the CDN hold it instead of re-fetching per render.
    avatarUrl: maniaCardAvatarUrl(user),
    scores,
    skills,
    tier,
    tierStyle,
    nextTier,
    stats: [
      { label: "Control", value: skills.fingerControl },
      { label: "Speed", value: skills.speed },
      { label: "Precision", value: skills.accuracy },
    ],
    edgeColor: parseCssRgba(tierStyle.edgeFill),
    glowColor: parseCssRgba(tierStyle.glowColor),
    badgeGradientStops: parseGradientStops(tierStyle.badgeGradient),
    motif: motifOverride ?? null,
  };
}

export function getManiaCardRenderDataSignature(data: ManiaCardRenderData): string {
  if (data.status === "empty") return ["empty", data.message].join("|");

  return [
    "ready",
    data.user.id,
    data.user.username,
    data.user.country_code ?? "",
    data.avatarUrl,
    data.tier,
    data.tierStyle.label,
    data.tierStyle.edgeFill,
    data.tierStyle.glowColor,
    data.tierStyle.badgeGradient,
    signatureSkills(data),
    signatureNextTier(data),
    data.stats.map((stat) => `${stat.label}:${signatureNumber(stat.value)}`).join(","),
    signatureColor(data.edgeColor),
    signatureColor(data.glowColor),
    data.badgeGradientStops.map((stop) => `${stop.color}:${signatureNumber(stop.offset)}`).join(","),
    cardMotifSignature(data.motif),
  ].join("|");
}

function signatureSkills(data: ManiaCardReadyData): string {
  const skills = data.skills;
  return [
    skills.starAvg,
    skills.fingerControl,
    skills.speed,
    skills.accuracy,
    skills.stamina,
    skills.versatility,
    skills.peak,
    skills.cardPower,
    skills.mainKeyMode,
    skills.sampleSize,
  ].map(signatureNumber).join(",");
}

function signatureNextTier(data: ManiaCardReadyData): string {
  const nextTier = data.nextTier;
  if (!nextTier) return "";
  return [
    nextTier.tier,
    nextTier.label,
    nextTier.currentTier,
    nextTier.currentLabel,
    signatureNumber(nextTier.threshold),
    signatureNumber(nextTier.remaining),
    signatureNumber(nextTier.progress),
  ].join(":");
}

function signatureColor(color: RgbaColor): string {
  return [
    signatureNumber(color.r),
    signatureNumber(color.g),
    signatureNumber(color.b),
    signatureNumber(color.a),
  ].join(",");
}

function signatureNumber(value: number | null | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(6) : "";
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
