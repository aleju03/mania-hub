import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec } from "../db.js";

const SNAPSHOT_TARGET_TOLERANCE_MS = 36 * 60 * 60 * 1000;

export interface RankDelta {
  userId: number;
  globalChange: number | null;
  countryChange: number | null;
  oldGlobalRank: number | null;
  oldCountryRank: number | null;
  capturedAt: string;
}

export interface RankDeltaSnapshot {
  country: string;
  windowDays: number;
  targetAt: string;
  deltas: Record<number, RankDelta>;
}

export async function getRankDeltaSnapshot(db: Db, country: string, userIds: number[], windowDays = 7): Promise<RankDeltaSnapshot> {
  const uniqueUserIds = [...new Set(userIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 100);
  const target = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const targetAt = new Date(target).toISOString();
  if (uniqueUserIds.length === 0) {
    return { country, windowDays, targetAt, deltas: {} };
  }

  const placeholders = uniqueUserIds.map(() => "?").join(",");
  const oldestAllowedAt = new Date(target - SNAPSHOT_TARGET_TOLERANCE_MS).toISOString();
  const rows = (await exec(
    db,
    `select
       old.user_id,
       old.country_rank as old_country_rank,
       old.global_rank as old_global_rank,
       old.captured_at,
       coalesce(current_roster.rank, current.country_rank) as current_country_rank,
       current.global_rank as current_global_rank
     from country_rank_snapshots old
     join (
       select user_id, max(captured_at) as captured_at
       from country_rank_snapshots
       where country = ?
         and user_id in (${placeholders})
         and captured_at <= ?
         and captured_at >= ?
       group by user_id
     ) picked on picked.user_id = old.user_id and picked.captured_at = old.captured_at
     left join users current on current.user_id = old.user_id
     left join country_rosters current_roster
       on current_roster.country = old.country
      and current_roster.user_id = old.user_id
      and current_roster.is_tracked = 1
     where old.country = ?`,
    [country, ...uniqueUserIds, targetAt, oldestAllowedAt, country],
  )).rows;

  const deltas: Record<number, RankDelta> = {};
  for (const row of rows) {
    const userId = Number(row.user_id);
    const oldGlobalRank = nullablePositiveInt(row.old_global_rank);
    const oldCountryRank = nullablePositiveInt(row.old_country_rank);
    const currentGlobalRank = nullablePositiveInt(row.current_global_rank);
    const currentCountryRank = nullablePositiveInt(row.current_country_rank);
    deltas[userId] = {
      userId,
      globalChange: oldGlobalRank != null && currentGlobalRank != null ? oldGlobalRank - currentGlobalRank : null,
      countryChange: oldCountryRank != null && currentCountryRank != null ? oldCountryRank - currentCountryRank : null,
      oldGlobalRank,
      oldCountryRank,
      capturedAt: String(row.captured_at),
    };
  }

  return { country, windowDays, targetAt, deltas };
}

function nullablePositiveInt(value: InValue | unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}
