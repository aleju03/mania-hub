import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { readConfig } from "../config.js";
import { markCountryRosterRefreshed } from "../countries.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";

type RankingStats = { pp?: number | null; global_rank?: number | null; country_rank?: number | null };
type RankingRow = RankingStats & {
  user: {
    id: number;
    username: string;
    avatar_url: string;
    country_code: string;
    statistics?: RankingStats | null;
  };
};

export async function refreshCountryRoster(db: Db, osu: Pick<OsuApiClient, "getRanking">, country: string, caller = "refresh_country_roster"): Promise<number> {
  const config = readConfig();
  const rows: RankingRow[] = [];
  for (let page = 1; page <= config.rosterRankingPages && rows.length < config.rosterSize; page++) {
    const ranking = await osu.getRanking(country, page, caller) as { ranking?: RankingRow[] };
    const pageRows = ranking.ranking ?? [];
    rows.push(...pageRows);
    if (pageRows.length === 0) break;
  }
  const now = nowIso();
  let count = 0;
  await exec(db, "update country_rosters set is_tracked = 0, refreshed_at = ? where country = ?", [now, country]);
  for (let index = 0; index < Math.min(rows.length, config.rosterSize); index++) {
    const row = rows[index];
    const user = row.user;
    const pp = nullableNumber(row.pp ?? user.statistics?.pp);
    const globalRank = nullablePositiveInt(row.global_rank ?? user.statistics?.global_rank);
    const countryRank = nullablePositiveInt(row.country_rank ?? user.statistics?.country_rank) ?? index + 1;
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, is_active, pp, global_rank, country_rank, profile_json, updated_at)
       values (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       on conflict(user_id) do update set username = excluded.username, avatar_url = excluded.avatar_url, country_code = excluded.country_code, pp = excluded.pp, global_rank = excluded.global_rank, country_rank = excluded.country_rank, profile_json = excluded.profile_json, updated_at = excluded.updated_at`,
      [user.id, user.username, user.avatar_url, user.country_code, pp, globalRank, countryRank, json(user), now],
    );
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values (?, ?, ?, 'osu_rankings', 1, ?)
       on conflict(country, user_id) do update set rank = excluded.rank, is_tracked = 1, refreshed_at = excluded.refreshed_at`,
      [country, user.id, countryRank, now],
    );
    await exec(
      db,
      `insert into country_rank_snapshots (country, user_id, country_rank, global_rank, pp, captured_at)
       values (?, ?, ?, ?, ?, ?)`,
      [country, user.id, countryRank, globalRank, pp, now],
    );
    count++;
  }
  await markCountryRosterRefreshed(db, country);
  return count;
}

export async function enqueueRosterRefreshes(queue: JobQueue, countries: string[]): Promise<void> {
  for (const country of countries) {
    await queue.enqueue("refresh_country_roster", `roster:${country}`, { country }, { priority: 10, replaceDone: true });
  }
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function nullablePositiveInt(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}
