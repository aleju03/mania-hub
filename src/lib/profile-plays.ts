import type { LiveKeymodePpPlay } from "./live-backend";

/* The two plays under a supporter's profile stats: any play the site tracked
   of them in place of the newest or oldest top play, under a title of their
   own, showing its pp, MSD or dan. The backend copies the play whole when it
   is picked (features/supporter-profile-plays.ts); this mirrors its shape. */

export const PROFILE_PLAY_TITLE_MAX = 32;
export const PROFILE_PLAY_METRICS = ["pp", "msd", "dan"] as const;
export type ProfilePlayMetric = (typeof PROFILE_PLAY_METRICS)[number];
export const PROFILE_PLAY_SORTS = ["pp", "recent", "oldest", "accuracy"] as const;
export type ProfilePlaySort = (typeof PROFILE_PLAY_SORTS)[number];

export interface ProfilePlaySnapshot {
  beatmapId: number;
  beatmapsetId: number;
  day: string;
  scoreId: number | null;
  title: string;
  artist: string;
  version: string;
  keyCount: number;
  coverUrl: string | null;
  rank: string;
  mods: string[];
  accuracy: number | null;
  pp: number | null;
  playedAt: string | null;
  rate: number;
  msd: number | null;
  dan: { label: string; family: string } | null;
  /* For the score card; absent on a play saved before they were kept. */
  statistics?: Record<string, number> | null;
  maxCombo?: number | null;
  totalScore?: number | null;
  legacyScoreId?: number | null;
  hasReplay?: boolean | null;
  isLazer?: boolean | null;
}

export interface ProfilePlay {
  title: string;
  show: ProfilePlayMetric;
  play: ProfilePlaySnapshot;
}

export type ProfilePlays = [ProfilePlay | null, ProfilePlay | null];

/* A play in the picker's list, before its rate-adjusted numbers are known. */
export type ProfilePlayChoice = Omit<ProfilePlaySnapshot, "beatmapsetId" | "scoreId" | "rate" | "msd" | "dan" | "statistics" | "maxCombo" | "totalScore" | "legacyScoreId" | "hasReplay" | "isLazer"> & { status: string };

/* What a slot is saved as: the play by its map and day. */
export interface ProfilePlayPick {
  title: string;
  beatmapId: number;
  day: string;
  show: ProfilePlayMetric;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return value != null && value !== "" && Number.isFinite(n) ? n : null;
}

export function isProfilePlayMetric(value: unknown): value is ProfilePlayMetric {
  return typeof value === "string" && (PROFILE_PLAY_METRICS as readonly string[]).includes(value);
}

export function profilePlayHas(play: Pick<ProfilePlaySnapshot, "pp" | "msd" | "dan">, metric: ProfilePlayMetric): boolean {
  if (metric === "pp") return play.pp != null && play.pp > 0;
  if (metric === "msd") return play.msd != null && play.msd > 0;
  return play.dan != null;
}

export function parseProfilePlaySnapshot(value: unknown): ProfilePlaySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const beatmapId = finite(raw.beatmapId);
  if (beatmapId == null || typeof raw.title !== "string" || typeof raw.day !== "string") return null;
  const dan = raw.dan as Record<string, unknown> | null | undefined;
  return {
    beatmapId,
    beatmapsetId: finite(raw.beatmapsetId) ?? 0,
    day: raw.day,
    scoreId: finite(raw.scoreId),
    title: raw.title,
    artist: String(raw.artist ?? ""),
    version: String(raw.version ?? ""),
    keyCount: finite(raw.keyCount) ?? 0,
    coverUrl: typeof raw.coverUrl === "string" && raw.coverUrl.startsWith("https://") ? raw.coverUrl : null,
    rank: String(raw.rank ?? ""),
    mods: Array.isArray(raw.mods) ? raw.mods.map(String) : [],
    accuracy: finite(raw.accuracy),
    pp: finite(raw.pp),
    playedAt: typeof raw.playedAt === "string" ? raw.playedAt : null,
    rate: finite(raw.rate) ?? 1,
    msd: finite(raw.msd),
    dan: dan && typeof dan.label === "string" ? { label: dan.label, family: String(dan.family ?? "") } : null,
    statistics: raw.statistics && typeof raw.statistics === "object" ? raw.statistics as Record<string, number> : null,
    maxCombo: finite(raw.maxCombo),
    totalScore: finite(raw.totalScore),
    legacyScoreId: finite(raw.legacyScoreId),
    hasReplay: typeof raw.hasReplay === "boolean" ? raw.hasReplay : null,
    isLazer: typeof raw.isLazer === "boolean" ? raw.isLazer : null,
  };
}

export function parseProfilePlays(value: unknown): ProfilePlays | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const slots = value.map((slot): ProfilePlay | null => {
    if (!slot || typeof slot !== "object") return null;
    const raw = slot as Record<string, unknown>;
    const play = parseProfilePlaySnapshot(raw.play);
    if (!play || typeof raw.title !== "string" || !raw.title.trim() || !isProfilePlayMetric(raw.show)) return null;
    return { title: raw.title.slice(0, PROFILE_PLAY_TITLE_MAX * 2), show: raw.show, play };
  }) as ProfilePlays;
  return slots.some(Boolean) ? slots : null;
}

export function parseProfilePlayChoice(value: unknown): ProfilePlayChoice | null {
  const play = parseProfilePlaySnapshot({ beatmapsetId: 0, ...(value as object) });
  if (!play) return null;
  const { beatmapsetId: _set, scoreId: _score, rate: _rate, msd: _msd, dan: _dan, statistics: _stats, maxCombo: _combo, totalScore: _total, legacyScoreId: _legacy, hasReplay: _replay, isLazer: _lazer, ...rest } = play;
  return { ...rest, status: String((value as Record<string, unknown>).status ?? "") };
}

/* Where the play links: its score page when osu! has one, else the map. */
export function profilePlayHref(play: ProfilePlaySnapshot): string {
  return play.scoreId ? `https://osu.ppy.sh/scores/${play.scoreId}` : `https://osu.ppy.sh/beatmaps/${play.beatmapId}`;
}

/* The saved play as the tracked-play row the score card is built from. */
export function profilePlayAsTrackedPlay(play: ProfilePlaySnapshot): LiveKeymodePpPlay {
  return {
    beatmapId: play.beatmapId,
    keyCount: play.keyCount,
    pp: play.pp ?? 0,
    beatmapsetId: play.beatmapsetId || null,
    title: play.title,
    artist: play.artist,
    version: play.version,
    accuracy: play.accuracy,
    rank: play.rank || null,
    mods: play.mods,
    playedAt: play.playedAt,
    maxCombo: play.maxCombo ?? null,
    hasReplay: play.hasReplay ?? null,
    soloScoreId: play.scoreId,
    totalScore: play.totalScore ?? null,
    legacyScoreId: play.legacyScoreId ?? null,
    statistics: (play.statistics ?? null) as LiveKeymodePpPlay["statistics"],
    isLazer: play.isLazer ?? null,
    creator: null,
    stars: null,
    bpm: null,
  } as LiveKeymodePpPlay;
}
