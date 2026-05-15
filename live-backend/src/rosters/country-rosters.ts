import type { Db } from "../db.js";
import { exec, json } from "../db.js";
import { readConfig } from "../config.js";
import { markCountryRosterRefreshed } from "../countries.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";

type RankingRow = { user: { id: number; username: string; avatar_url: string; country_code: string; statistics?: { pp?: number; global_rank?: number; country_rank?: number } } };

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
    const user = rows[index].user;
    await exec(
      db,
      `insert into users (user_id, username, avatar_url, country_code, is_active, pp, global_rank, country_rank, profile_json, updated_at)
       values (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       on conflict(user_id) do update set username = excluded.username, avatar_url = excluded.avatar_url, country_code = excluded.country_code, pp = excluded.pp, global_rank = excluded.global_rank, country_rank = excluded.country_rank, profile_json = excluded.profile_json, updated_at = excluded.updated_at`,
      [user.id, user.username, user.avatar_url, user.country_code, user.statistics?.pp ?? null, user.statistics?.global_rank ?? null, user.statistics?.country_rank ?? null, json(user), now],
    );
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values (?, ?, ?, 'osu_rankings', 1, ?)
       on conflict(country, user_id) do update set rank = excluded.rank, is_tracked = 1, refreshed_at = excluded.refreshed_at`,
      [country, user.id, index + 1, now],
    );
    await exec(
      db,
      `insert into country_rank_snapshots (country, user_id, country_rank, global_rank, pp, captured_at)
       values (?, ?, ?, ?, ?, ?)`,
      [country, user.id, index + 1, user.statistics?.global_rank ?? null, user.statistics?.pp ?? null, now],
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
