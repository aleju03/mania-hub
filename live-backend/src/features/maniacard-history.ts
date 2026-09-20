import { exec, execBatch, json, parseJson, withWriteTurn, type Db, type DbStatement } from "../db.js";
import { unpackJson } from "../shared/compressed-json.js";
import { hydrateScoresDisplayMetadata, selectRowsByIntegerSet } from "../shared/score-storage.js";
import { calculateWeightedPpTotal, getModAcronyms, getScoreIdentity, getScoreTimestamp } from "../shared/score.js";
import { computeManiaSkills, getHonoraryTier, getManiaCardTier, resolveCardGlobalPp, type ManiaCardScore, type ManiaCardTier } from "../shared/maniacard.js";
import type { OscScore } from "../shared/types.js";

// Bump when the trait model changes; old snapshots keep their original values.
export const MANIACARD_HISTORY_VERSION = 1;

export interface ManiacardHistorySnapshot {
  rating: number;
  tier: ManiaCardTier;
  control: number;
  speed: number;
  precision: number;
  keyCount: number;
}

export interface ManiacardHistoryMap {
  beatmapId: number;
  /** Older snapshots resolve this from local map metadata when read. */
  beatmapsetId?: number | null;
  title: string;
  difficulty: string;
  mods: string[];
  playedAt: string;
  ratingChange: number;
}

export interface ManiacardHistoryEntry {
  id: number;
  recordedAt: string;
  version: number;
  reason: "baseline" | "session" | "refresh";
  snapshot: ManiacardHistorySnapshot;
  previous: ManiacardHistorySnapshot | null;
  maps: ManiacardHistoryMap[];
  otherRatingChange: number;
}

export interface ManiacardHistoryPage {
  items: ManiacardHistoryEntry[];
  nextBefore: number | null;
}

interface CardInput {
  scores: OscScore[];
  globalPp?: number | null;
  recordedAt: string;
  scoresFetchedAt?: string;
}

function skillsFor(input: CardInput) {
  // Hydrated profile scores carry the full beatmap metadata. The shared model
  // validates missing fields and drops unusable plays just as the card does.
  return computeManiaSkills(input.scores.map((score) => ({ ...score, statistics: score.statistics ?? {} })) as ManiaCardScore[], {
    globalPp: input.globalPp,
  });
}

function snapshotFor(userId: number, input: CardInput): ManiacardHistorySnapshot | null {
  const skills = skillsFor(input);
  return skills ? {
    rating: skills.cardPower,
    tier: getHonoraryTier(userId) ?? getManiaCardTier(skills.cardPower),
    control: skills.fingerControl,
    speed: skills.speed,
    precision: skills.accuracy,
    keyCount: skills.mainKeyMode,
  } : null;
}

async function storedInput(db: Db, userId: number): Promise<CardInput | null> {
  const row = (await exec(db, "select user_json, best_scores_json, fetched_at, user_fetched_at from profile_snapshots where user_id = ?", [userId])).rows[0];
  if (!row) return null;
  const user = unpackJson<{ statistics?: { pp?: number | null } }>(row.user_json, {});
  return {
    scores: await hydrateScoresDisplayMetadata(db, unpackJson<OscScore[]>(row.best_scores_json, [])),
    globalPp: user.statistics?.pp,
    recordedAt: [String(row.fetched_at), String(row.user_fetched_at ?? row.fetched_at)].sort().at(-1)!,
    scoresFetchedAt: String(row.fetched_at),
  };
}

/** Replay new top plays chronologically against the previous window. These
 * are marginal estimates: inserting a map also displaces/reweights other maps.
 * The pp estimate moves by the weighted-window difference; authoritative pp,
 * metadata corrections and model changes are accounted for separately. */
export function estimateManiacardMapChanges(previous: CardInput, current: CardInput): ManiacardHistoryMap[] {
  const known = new Set(previous.scores.map(getScoreIdentity));
  const changes = current.scores.filter((score) => score.beatmap?.id && !known.has(getScoreIdentity(score))
    && Date.parse(getScoreTimestamp(score)) > Date.parse(previous.scoresFetchedAt ?? previous.recordedAt))
    .sort((a, b) => getScoreTimestamp(a).localeCompare(getScoreTimestamp(b), "en-US") || a.id - b.id);
  let scores = [...previous.scores];
  const baseWeightedPp = calculateWeightedPpTotal(scores);
  const basePp = resolveCardGlobalPp(previous.globalPp, scores);
  let rating = skillsFor(previous)?.cardPower;
  if (rating == null) return [];
  const maps: ManiacardHistoryMap[] = [];
  for (const score of changes) {
    scores = [...scores.filter((old) => (old.beatmap?.id ?? old.beatmap_id) !== score.beatmap!.id), score]
      .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0) || a.id - b.id).slice(0, 200);
    const nextRating = skillsFor({
      ...current, scores, globalPp: Math.max(0, basePp + calculateWeightedPpTotal(scores) - baseWeightedPp),
    })?.cardPower;
    if (nextRating == null) continue;
    maps.push({
      beatmapId: score.beatmap!.id,
      beatmapsetId: score.beatmap!.beatmapset_id ?? score.beatmapset?.id ?? null,
      title: score.beatmapset?.title ?? `Beatmap ${score.beatmap!.id}`,
      difficulty: score.beatmap!.version ?? "",
      mods: getModAcronyms(score.mods),
      playedAt: getScoreTimestamp(score),
      ratingChange: nextRating - rating,
    });
    rating = nextRating;
  }
  return maps;
}

/** Store history atomically with a profile refresh, never from a browser's
 * claimed rating. Existing snapshots supply the first baseline. */
export async function writeProfileWithManiacardHistory(
  db: Db, userId: number, current: CardInput, reason: "session" | "refresh", statement: DbStatement,
): Promise<void> {
  await withWriteTurn(db, async () => {
    const previousInput = await storedInput(db, userId);
    const latest = (await exec(db, "select snapshot_json from player_maniacard_history where user_id = ? order by id desc limit 1", [userId])).rows[0];
    const previous = latest ? parseJson<ManiacardHistorySnapshot | null>(String(latest.snapshot_json), null)
      : previousInput ? snapshotFor(userId, previousInput) : null;
    const snapshot = snapshotFor(userId, current);
    const statements: DbStatement[] = [statement];
    const append = (value: ManiacardHistorySnapshot, at: string, why: ManiacardHistoryEntry["reason"], maps: ManiacardHistoryMap[], otherRatingChange: number) => {
      statements.push({
        sql: `insert into player_maniacard_history
          (user_id, recorded_at, model_version, reason, snapshot_json, maps_json, other_rating_change)
          select ?, ?, ?, ?, ?, ?, ? where exists
          (select 1 from profile_snapshots where user_id = ? and updated_at = ?)
          and not exists (select 1 from users where user_id = ? and is_active = 0)`,
        args: [userId, at, MANIACARD_HISTORY_VERSION, why, json(value), json(maps), otherRatingChange, userId, current.recordedAt, userId],
      });
    };
    if (!latest && previous && previousInput) append(previous, previousInput.recordedAt, "baseline", [], 0);
    if (snapshot) {
      const maps = previousInput ? estimateManiacardMapChanges(previousInput, current) : [];
      if (!previous || json(snapshot) !== json(previous) || maps.length > 0) {
        const total = previous ? snapshot.rating - previous.rating : 0;
        append(snapshot, current.recordedAt, previous ? reason : "baseline", maps,
          total - maps.reduce((sum, map) => sum + map.ratingChange, 0));
      }
    }
    await execBatch(db, statements);
  });
}

/** Public, read-only keyset pagination. The extra row supplies the boundary
 * delta, so a new session never shifts already-requested older pages. */
export async function getManiacardHistory(
  db: Db, userId: number, options: { before?: number; limit?: number } = {},
): Promise<ManiacardHistoryPage> {
  const limit = Math.max(1, Math.min(25, Math.floor(options.limit ?? 15)));
  const rows = (await exec(db, `select * from player_maniacard_history where user_id = ?
    ${options.before ? "and id < ?" : ""} order by id desc limit ?`,
  [userId, ...(options.before ? [options.before] : []), limit + 1])).rows;
  if (!rows.length && !options.before) {
    const input = await storedInput(db, userId);
    const snapshot = input ? snapshotFor(userId, input) : null;
    return { items: snapshot && input ? [{
      id: 0, recordedAt: input.recordedAt, version: MANIACARD_HISTORY_VERSION, reason: "baseline",
      snapshot, previous: null, maps: [], otherRatingChange: 0,
    }] : [], nextBefore: null };
  }
  const entries = rows.map((row) => ({
    id: Number(row.id), recordedAt: String(row.recorded_at), version: Number(row.model_version),
    reason: String(row.reason) as ManiacardHistoryEntry["reason"],
    snapshot: parseJson<ManiacardHistorySnapshot>(String(row.snapshot_json), {} as ManiacardHistorySnapshot),
    maps: parseJson<ManiacardHistoryMap[]>(String(row.maps_json), []), otherRatingChange: Number(row.other_rating_change),
  }));
  const items = entries.slice(0, limit).map((entry, i) => ({ ...entry, previous: entries[i + 1]?.snapshot ?? null }));
  const missingCoverIds = items.flatMap((entry) => entry.maps.filter((map) => !map.beatmapsetId).map((map) => map.beatmapId));
  if (missingCoverIds.length) {
    const metadata = await selectRowsByIntegerSet(db, "select beatmap_id, beatmapset_id from beatmaps where beatmap_id in", missingCoverIds);
    const setIds = new Map(metadata.map((row) => [Number(row.beatmap_id), Number(row.beatmapset_id)]));
    for (const entry of items) {
      for (const map of entry.maps) map.beatmapsetId ??= setIds.get(map.beatmapId) ?? null;
    }
  }
  return { items, nextBefore: entries.length > limit ? items[items.length - 1].id : null };
}
