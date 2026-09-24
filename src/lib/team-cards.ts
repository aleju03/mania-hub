/* Pure team card display helpers: usable by thumbnail caches without loading
   pack drawing, profile fetching or server functions. */
import { MANIA_TIER_STYLES, type ManiaCardTier, type ManiaSkills } from "./maniacard";
import { teamImageProxyUrl } from "./team-image";

export interface PackTeamCard {
  teamId: number;
  name: string;
  shortName: string;
  flagUrl: string | null;
  coverUrl: string | null;
  tier: ManiaCardTier;
  skills: {
    cardPower: number;
    fingerControl: number;
    speed: number;
    accuracy: number;
    starAvg: number;
    mainKeyMode: number;
  };
}

export function teamPackCardKey(teamId: number, tier?: string): string {
  return `team:${teamId}${tier === "eternal" ? ":eternal" : ""}`;
}

/* The team id a "team:<id>" key addresses, or null for any other key. */
export function parseTeamPackCardKey(key: string): number | null {
  const match = /^team:(\d{1,12})(:eternal)?$/.exec(key);
  const teamId = match ? Number(match[1]) : 0;
  return teamId > 0 ? teamId : null;
}

/* The skills shape the card renderer reads, filled from a team's card. The
   fields a team card does not have stay at zero, as on the team page. */
export function teamCardSkills(team: PackTeamCard): ManiaSkills {
  return {
    starAvg: team.skills.starAvg,
    fingerControl: team.skills.fingerControl,
    speed: team.skills.speed,
    accuracy: team.skills.accuracy,
    stamina: 0,
    versatility: 0,
    peak: 0,
    cardPower: team.skills.cardPower,
    mainKeyMode: team.skills.mainKeyMode,
    archetype: "",
    sampleSize: 0,
  };
}

/* The banner face a team card draws with: flag in place of the avatar, the
   team header behind it. Both go through /api/team-image so the canvas can
   read them back. */
export function teamCardFace(team: Pick<PackTeamCard, "flagUrl" | "coverUrl" | "shortName" | "name">) {
  return {
    flagUrl: teamImageProxyUrl(team.flagUrl),
    coverUrl: teamImageProxyUrl(team.coverUrl),
    tag: team.shortName || team.name,
  };
}

export function teamCardUser(team: Pick<PackTeamCard, "teamId" | "name">) {
  return {
    id: -team.teamId,
    username: team.name,
    avatar_url: "",
    country_code: "",
    statistics: { global_rank: null, pp: 0 },
  };
}

/* A team slot from the draw response or a resumed pending pack, bounded: an
   unknown tier or a missing id drops the slot rather than drawing a card
   nobody dealt. Display-only either way; the server holds the real card. */
export function parsePackTeamCard(value: unknown): PackTeamCard | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PackTeamCard>;
  const teamId = Math.floor(Number(raw.teamId) || 0);
  if (teamId <= 0 || typeof raw.tier !== "string" || !Object.prototype.hasOwnProperty.call(MANIA_TIER_STYLES, raw.tier)) return null;
  const skills: Record<string, unknown> = raw.skills && typeof raw.skills === "object" ? raw.skills : {};
  const number = (key: keyof PackTeamCard["skills"]) => {
    const value = Number(skills[key]);
    return Number.isFinite(value) ? value : 0;
  };
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 80) : "");
  return {
    teamId,
    name: text(raw.name) || `Team ${teamId}`,
    shortName: text(raw.shortName),
    flagUrl: typeof raw.flagUrl === "string" ? raw.flagUrl : null,
    coverUrl: typeof raw.coverUrl === "string" ? raw.coverUrl : null,
    tier: raw.tier as ManiaCardTier,
    skills: {
      cardPower: number("cardPower"),
      fingerControl: number("fingerControl"),
      speed: number("speed"),
      accuracy: number("accuracy"),
      starAvg: number("starAvg"),
      mainKeyMode: number("mainKeyMode") || 4,
    },
  };
}

