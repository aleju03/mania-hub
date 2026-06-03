import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { calculateWeightedPpTotal, nowIso } from "../shared/score.js";

export type FarmHelperKeyCount = 4 | 7;

export interface FarmHelperKeyStat {
  userId: number;
  weightedPp: number;
  scoreCount: number;
}

const KEY_COUNTS: FarmHelperKeyCount[] = [4, 7];
const SEEDED_META_PREFIX = "farm_helper_key_stats_seeded:";

const seedLocks = new WeakMap<Db, Map<FarmHelperKeyCount, Promise<void>>>();

export async function ensureFarmHelperKeyStatsSeeded(db: Db, keyCount: FarmHelperKeyCount): Promise<void> {
  const existing = (await exec(
    db,
    "select 1 from farm_helper_user_key_stats where key_count = ? limit 1",
    [keyCount],
  )).rows[0];
  if (existing) return;

  const seeded = (await exec(db, "select 1 from live_meta where key = ? limit 1", [seededMetaKey(keyCount)])).rows[0];
  if (seeded) return;

  let locks = seedLocks.get(db);
  if (!locks) seedLocks.set(db, (locks = new Map()));
  const current = locks.get(keyCount);
  if (current) return current;

  const lock = rebuildFarmHelperKeyStats(db, keyCount).finally(() => {
    locks?.delete(keyCount);
  });
  locks.set(keyCount, lock);
  return lock;
}

export async function readFarmHelperKeyStatsForUsers(
  db: Db,
  keyCount: FarmHelperKeyCount,
  userIds: number[],
): Promise<Map<number, FarmHelperKeyStat>> {
  await ensureFarmHelperKeyStatsSeeded(db, keyCount);

  const ids = uniqueUserIds(userIds);
  const result = new Map<number, FarmHelperKeyStat>();
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = (await exec(
      db,
      `select user_id, weighted_pp, score_count
       from farm_helper_user_key_stats
       where key_count = ? and user_id in (${placeholders})`,
      [keyCount, ...chunk],
    )).rows;
    for (const row of rows) {
      const userId = Number(row.user_id);
      const weightedPp = Number(row.weighted_pp);
      const scoreCount = Number(row.score_count);
      if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isFinite(weightedPp) || weightedPp <= 0) continue;
      result.set(userId, { userId, weightedPp, scoreCount: Number.isFinite(scoreCount) ? scoreCount : 0 });
    }
  }
  return result;
}

export async function queryFarmHelperKeyPeersWithinBand(
  db: Db,
  keyCount: FarmHelperKeyCount,
  userId: number,
  subjectModePp: number,
  band: number,
  minScores: number,
): Promise<Array<{ userId: number; pp: number; modePp: number }>> {
  await ensureFarmHelperKeyStatsSeeded(db, keyCount);
  const minPp = Math.max(0, subjectModePp - band);
  const maxPp = subjectModePp + band;
  const rows = (await exec(
    db,
    `select s.user_id, u.pp, s.weighted_pp
     from farm_helper_user_key_stats s
     join users u on u.user_id = s.user_id
     where s.key_count = ?
       and s.score_count >= ?
       and s.weighted_pp between ? and ?
       and s.user_id != ?
       and u.pp is not null
       and u.pp > 0
     order by abs(s.weighted_pp - ?) asc`,
    [keyCount, minScores, minPp, maxPp, userId, subjectModePp],
  )).rows;
  return rowsToPeers(rows);
}

export async function queryFarmHelperKeyPeersByDistance(
  db: Db,
  keyCount: FarmHelperKeyCount,
  userId: number,
  subjectModePp: number,
  minScores: number,
): Promise<Array<{ userId: number; pp: number; modePp: number }>> {
  await ensureFarmHelperKeyStatsSeeded(db, keyCount);
  const rows = (await exec(
    db,
    `select s.user_id, u.pp, s.weighted_pp
     from farm_helper_user_key_stats s
     join users u on u.user_id = s.user_id
     where s.key_count = ?
       and s.score_count >= ?
       and s.user_id != ?
       and u.pp is not null
       and u.pp > 0
     order by abs(s.weighted_pp - ?) asc`,
    [keyCount, minScores, userId, subjectModePp],
  )).rows;
  return rowsToPeers(rows);
}

export async function refreshFarmHelperKeyStatsForUser(db: Db, userId: number, updatedAt = nowIso()): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  await exec(db, "delete from farm_helper_user_key_stats where user_id = ?", [userId]);
  const rows = (await exec(
    db,
    `select s.user_id, s.beatmap_id, s.pp, s.updated_at, round(coalesce(mb.cs, b.cs, 0)) as key_count
     from country_maps_farmed_scores s
     left join maps_beatmaps mb on mb.beatmap_id = s.beatmap_id
     left join beatmaps b on b.beatmap_id = s.beatmap_id
     where s.user_id = ?`,
    [userId],
  )).rows;
  await writeStats(db, collectStats(rows), updatedAt);
}

async function rebuildFarmHelperKeyStats(db: Db, keyCount: FarmHelperKeyCount): Promise<void> {
  const rows = (await exec(
    db,
    `select s.user_id, s.beatmap_id, s.pp, s.updated_at, round(coalesce(mb.cs, b.cs, 0)) as key_count
     from country_maps_farmed_scores s
     left join maps_beatmaps mb on mb.beatmap_id = s.beatmap_id
     left join beatmaps b on b.beatmap_id = s.beatmap_id
     where round(coalesce(mb.cs, b.cs, 0)) = ?`,
    [keyCount],
  )).rows;

  await exec(db, "delete from farm_helper_user_key_stats where key_count = ?", [keyCount]);
  await writeStats(db, collectStats(rows), nowIso());
  const updatedAt = nowIso();
  await exec(
    db,
    `insert into live_meta (key, value_json, updated_at)
     values (?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [seededMetaKey(keyCount), json(true), updatedAt],
  );
}

function collectStats(rows: Record<string, unknown>[]): Map<FarmHelperKeyCount, Map<number, { scores: Map<number, number>; sourceUpdatedAt: string }>> {
  const stats = new Map<FarmHelperKeyCount, Map<number, { scores: Map<number, number>; sourceUpdatedAt: string }>>();
  for (const row of rows) {
    const keyCount = Number(row.key_count);
    if (!isFarmHelperKeyCount(keyCount)) continue;
    const userId = Number(row.user_id);
    const beatmapId = Number(row.beatmap_id);
    const pp = Number(row.pp);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    if (!Number.isFinite(pp) || pp <= 0) continue;

    let byUser = stats.get(keyCount);
    if (!byUser) stats.set(keyCount, (byUser = new Map()));
    let userStats = byUser.get(userId);
    if (!userStats) {
      userStats = { scores: new Map(), sourceUpdatedAt: "" };
      byUser.set(userId, userStats);
    }

    const current = userStats.scores.get(beatmapId) ?? 0;
    if (pp > current) userStats.scores.set(beatmapId, pp);
    const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
    if (updatedAt > userStats.sourceUpdatedAt) userStats.sourceUpdatedAt = updatedAt;
  }
  return stats;
}

async function writeStats(
  db: Db,
  stats: Map<FarmHelperKeyCount, Map<number, { scores: Map<number, number>; sourceUpdatedAt: string }>>,
  updatedAt: string,
): Promise<void> {
  for (const keyCount of KEY_COUNTS) {
    const byUser = stats.get(keyCount);
    if (!byUser) continue;
    for (const [userId, userStats] of byUser) {
      const values = [...userStats.scores.values()];
      if (values.length === 0) continue;
      await exec(
        db,
        `insert into farm_helper_user_key_stats
           (key_count, user_id, weighted_pp, score_count, source_updated_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(key_count, user_id) do update set
           weighted_pp = excluded.weighted_pp,
           score_count = excluded.score_count,
           source_updated_at = excluded.source_updated_at,
           updated_at = excluded.updated_at`,
        [
          keyCount,
          userId,
          calculateWeightedPpTotal(values.map((pp) => ({ pp }))),
          values.length,
          userStats.sourceUpdatedAt || updatedAt,
          updatedAt,
        ],
      );
    }
  }
}

function rowsToPeers(rows: Record<string, unknown>[]): Array<{ userId: number; pp: number; modePp: number }> {
  return rows
    .map((row) => ({
      userId: Number(row.user_id),
      pp: Number(row.pp),
      modePp: Number(row.weighted_pp),
    }))
    .filter((peer) => (
      Number.isSafeInteger(peer.userId)
      && peer.userId > 0
      && Number.isFinite(peer.pp)
      && peer.pp > 0
      && Number.isFinite(peer.modePp)
      && peer.modePp > 0
    ));
}

function uniqueUserIds(userIds: number[]): number[] {
  return [...new Set(userIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function isFarmHelperKeyCount(value: number): value is FarmHelperKeyCount {
  return value === 4 || value === 7;
}

function seededMetaKey(keyCount: FarmHelperKeyCount): string {
  return `${SEEDED_META_PREFIX}${keyCount}`;
}
