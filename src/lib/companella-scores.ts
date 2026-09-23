import { getScoreTimeMs } from "./score";
import type { LeanTrackerScore, OsuCovers, OsuScore } from "./types";

/* How far apart an import and the osu! row for the same play can be dated.
   The import is dated by the client's clock (clamped to when it arrived) and
   the osu! row by osu!'s, so the two rarely agree to the second. */
export const COMPANELLA_TWIN_WINDOW_MS = 5 * 60_000;

/**
 * A Companella row from the backend, shaped as the score object the profile
 * draws.
 *
 * The backend sends a lean tracker row. What it never had is left absent, the
 * way tracked plays do it: a chart that is not an official file has no id,
 * stars or BPM, and a zero there would read as a real measurement. An official
 * set gets the site's background for its banner when the row brought none.
 */
export function companellaRowToOsuScore(row: LeanTrackerScore): OsuScore {
  const setId = row.beatmapset?.id ?? 0;
  const beatmapId = row.beatmap?.id ?? 0;
  const background = setId > 0 ? `/api/background?beatmapsetId=${setId}` : null;
  const rowCovers: Partial<OsuCovers> = row.beatmapset?.covers ?? {};
  const covers = background ? { cover: background, "cover@2x": background, ...rowCovers } : rowCovers;
  return {
    ...row,
    mode: "mania",
    ruleset_id: 3,
    beatmap_id: beatmapId > 0 ? beatmapId : undefined,
    has_replay: false,
    beatmap: {
      ...row.beatmap,
      id: beatmapId,
      beatmapset_id: setId > 0 ? setId : undefined,
      mode: "mania",
      convert: false,
      difficulty_rating: positiveOrUndefined(row.beatmap?.difficulty_rating),
      bpm: positiveOrUndefined(row.beatmap?.bpm),
      max_combo: positiveOrUndefined(row.beatmap?.max_combo),
    },
    beatmapset: {
      ...row.beatmapset,
      id: setId,
      covers,
    },
    // Absent fields stay absent, which no full OsuScore shape can express.
  } as unknown as OsuScore;
}

/** The imports on a profile section, as score rows. A row without the mark is
 *  not one the contract describes, so it is dropped rather than guessed at. */
export function companellaImportsToScores(rows: LeanTrackerScore[] | null | undefined): OsuScore[] {
  return (rows ?? []).filter((row) => row.companella != null).map(companellaRowToOsuScore);
}

/** The import a row's Watch opens. Only a restricted player's counted plays
 *  have a replay anyone may watch. */
export function companellaReplayImportId(score: Pick<OsuScore, "companella">): string | undefined {
  return score.companella?.replay ? score.companella.importId : undefined;
}

/**
 * Whether an osu! row is the same play as an import: same player, same map,
 * same total, dated within a few minutes. The ids never match (the import has
 * no osu! id), so this is what keeps a play that later arrives from osu! from
 * being listed twice.
 */
type TwinScore = OsuScore | LeanTrackerScore;

export function isCompanellaOsuTwin(imported: TwinScore, official: TwinScore): boolean {
  if (!imported.companella || official.companella) return false;
  const beatmapId = imported.beatmap?.id ?? 0;
  if (beatmapId <= 0 || (official.beatmap?.id ?? official.beatmap_id) !== beatmapId) return false;
  if ((official.user_id ?? official.user?.id) !== (imported.user_id ?? imported.user?.id)) return false;
  const total = imported.legacy_total_score ?? imported.total_score ?? imported.score;
  if (!total) return false;
  const officialTotals = [official.legacy_total_score, official.classic_total_score, official.total_score, official.score];
  if (!officialTotals.includes(total)) return false;
  const importedAt = getScoreTimeMs(imported);
  const officialAt = getScoreTimeMs(official);
  if (!importedAt || !officialAt) return false;
  return Math.abs(importedAt - officialAt) <= COMPANELLA_TWIN_WINDOW_MS;
}

/** Drops each import that an osu! row in the same list already stands for. */
export function dropCompanellaOsuTwins<T extends TwinScore>(scores: T[]): T[] {
  const official = scores.filter((score) => !score.companella);
  if (official.length === 0 || official.length === scores.length) return scores;
  return scores.filter((score) => !score.companella || !official.some((candidate) => isCompanellaOsuTwin(score, candidate)));
}

function positiveOrUndefined(value: number | null | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined;
}
