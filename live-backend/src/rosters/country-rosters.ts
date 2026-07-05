import type { Db } from "../db.js";
import { exec, execBatch, json, variantPpUpdateStatement, type DbStatement } from "../db.js";
import { readConfig, type Config } from "../config.js";
import { getActiveCountryCodes, markCountryRosterRefreshed } from "../countries.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import { nowIso } from "../shared/score.js";

type RankingGradeCounts = { ss?: number | null; ssh?: number | null; s?: number | null; sh?: number | null; a?: number | null };
type RankingStats = {
  pp?: number | null;
  global_rank?: number | null;
  country_rank?: number | null;
  hit_accuracy?: number | null;
  play_count?: number | null;
  ranked_score?: number | null;
  total_score?: number | null;
  grade_counts?: RankingGradeCounts | null;
};
type RankingRow = RankingStats & {
  user: {
    id: number;
    username: string;
    avatar_url: string;
    country_code: string;
    statistics?: (RankingStats & Record<string, unknown>) | null;
    [key: string]: unknown;
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
  const statements: DbStatement[] = [
    // Ranked members are reset to untracked here and re-marked below if still in the top N.
    { sql: "update country_rosters set rank = null, is_tracked = 0, refreshed_at = ? where country = ? and source != 'manual'", args: [now, country] },
    // Manual opt-in members stay tracked across refreshes, but drop any stale rank so they only
    // re-enter ranking scope if the upsert below places them back in the top N this run.
    { sql: "update country_rosters set rank = null, refreshed_at = ? where country = ? and source = 'manual'", args: [now, country] },
  ];
  for (let index = 0; index < Math.min(rows.length, config.rosterSize); index++) {
    const row = rows[index];
    const user = row.user;
    const pp = nullableNumber(row.pp ?? user.statistics?.pp);
    const globalRank = nullablePositiveInt(row.global_rank ?? user.statistics?.global_rank);
    const countryRank = nullablePositiveInt(row.country_rank ?? user.statistics?.country_rank) ?? index + 1;
    const storedUser = buildStoredRankingUser(row, { pp, globalRank, countryRank });
    statements.push(
      {
        sql: `insert into users (user_id, username, avatar_url, country_code, is_active, pp, global_rank, country_rank, profile_json, updated_at)
              values (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
              on conflict(user_id) do update set username = excluded.username, avatar_url = excluded.avatar_url, country_code = excluded.country_code, pp = excluded.pp, global_rank = excluded.global_rank, country_rank = excluded.country_rank, profile_json = excluded.profile_json, updated_at = excluded.updated_at`,
        args: [user.id, user.username, user.avatar_url, user.country_code, pp, globalRank, countryRank, json(storedUser), now],
      },
      {
        sql: `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
              values (?, ?, ?, 'osu_rankings', 1, ?)
              on conflict(country, user_id) do update set rank = excluded.rank, is_tracked = 1, refreshed_at = excluded.refreshed_at`,
        args: [country, user.id, countryRank, now],
      },
      {
        sql: `insert into country_rank_snapshots (country, user_id, country_rank, global_rank, pp, captured_at)
              values (?, ?, ?, ?, ?, ?)`,
        args: [country, user.id, countryRank, globalRank, pp, now],
      },
    );
    // Rankings payloads usually omit statistics.variants, so this is normally a
    // no-op (leaves pp_4k/pp_7k untouched); it only writes when they are present.
    const variantStatement = variantPpUpdateStatement(user.id, user.statistics);
    if (variantStatement) statements.push(variantStatement);
    count++;
  }
  await execBatch(db, statements);
  await markCountryRosterRefreshed(db, country);
  return count;
}

export async function enqueueRosterRefreshes(queue: JobQueue, countries: string[]): Promise<void> {
  for (const country of countries) {
    await queue.enqueue("refresh_country_roster", `roster:${country}`, { country }, { priority: 10, replaceDone: true });
  }
}

/**
 * Ranked roster members carry a non-null country rank (the top-N pulled from osu! rankings).
 * Manual opt-in members and transient `score`-sourced members are tracked for activity but
 * rank null, so they are deliberately excluded from ranking surfaces (global rankings, the
 * country maps board, snipe boards, rank deltas). This is the shared discriminator for that.
 */
export async function isRankedRosterMember(db: Db, country: string, userId: number): Promise<boolean> {
  const row = (await exec(
    db,
    "select 1 from country_rosters where country = ? and user_id = ? and is_tracked = 1 and rank is not null limit 1",
    [country.toUpperCase(), userId],
  )).rows[0];
  return row != null;
}

export type ManualRosterMemberStatus =
  | "added"
  | "already_member"
  | "already_ranked"
  | "removed"
  | "not_member"
  | "country_not_tracked"
  | "country_full";

export interface ManualRosterMemberResult {
  ok: boolean;
  country: string;
  userId: number;
  status: ManualRosterMemberStatus;
}

/**
 * Opt a user into their country's roster as a durable `manual` member (rank null). They become
 * tracking-scope (scores ingested, activity analysed) but stay out of ranking surfaces until the
 * roster refresh ever places them in the real top N. The caller proves identity upstream: the
 * frontend server fn only ever forwards the osu!-verified viewer id.
 */
export async function addManualRosterMember(
  db: Db,
  queue: JobQueue,
  config: Config,
  country: string,
  userId: number,
): Promise<ManualRosterMemberResult> {
  const normalized = country.toUpperCase();
  const base = { country: normalized, userId };
  // The country must already be actively tracked, otherwise scores never ingest and nothing
  // would be recorded. Activating a cold country is a separate, rate-limited flow.
  const activeCountries = await getActiveCountryCodes(db, config);
  if (!activeCountries.includes(normalized)) {
    return { ...base, ok: false, status: "country_not_tracked" };
  }
  const existing = (await exec(
    db,
    "select rank, source, is_tracked from country_rosters where country = ? and user_id = ?",
    [normalized, userId],
  )).rows[0];
  // Already a ranked member (in the top N): they are tracked already, nothing to opt into.
  if (existing && existing.rank != null && Number(existing.is_tracked) === 1) {
    return { ...base, ok: true, status: "already_ranked" };
  }
  const alreadyManual = existing != null && String(existing.source) === "manual" && Number(existing.is_tracked) === 1;
  if (!alreadyManual) {
    // Optional emergency brake (off by default): manual rows are durable and never age out, so
    // this is the only unbounded roster growth path. Per-member recurring cost is otherwise
    // proportional to how much they play, not to roster size.
    const cap = Math.max(0, Math.floor(config.manualRosterMaxPerCountry));
    if (cap > 0) {
      const countRow = (await exec(
        db,
        "select count(*) as n from country_rosters where country = ? and source = 'manual' and is_tracked = 1 and rank is null",
        [normalized],
      )).rows[0];
      if (Number(countRow?.n ?? 0) >= cap) {
        return { ...base, ok: false, status: "country_full" };
      }
    }
  }
  const now = nowIso();
  await exec(
    db,
    `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
     values (?, ?, null, 'manual', 1, ?)
     on conflict(country, user_id) do update set rank = null, source = 'manual', is_tracked = 1, refreshed_at = excluded.refreshed_at`,
    [normalized, userId, now],
  );
  // Backfill so the activity tab fills in promptly instead of only tracking from the next play.
  // Both jobs dedupe on their keys, so repeated opt-in clicks collapse into one unit of work.
  await queue.enqueue("enrich_user", `user:${userId}`, { userId }, { priority: 100 });
  await queue.enqueue("reconcile_user_recent_scores", `recent:user:${userId}`, { userId }, { priority: 70, replaceDone: true });
  return { ...base, ok: true, status: alreadyManual ? "already_member" : "added" };
}

/** Opt a user back out: soft-untrack their manual row so refreshes keep ignoring it. */
export async function removeManualRosterMember(db: Db, country: string, userId: number): Promise<ManualRosterMemberResult> {
  const normalized = country.toUpperCase();
  const existing = (await exec(
    db,
    "select rank, is_tracked from country_rosters where country = ? and user_id = ? and source = 'manual'",
    [normalized, userId],
  )).rows[0];
  if (existing && existing.rank != null && Number(existing.is_tracked) === 1) {
    return {
      country: normalized,
      userId,
      ok: true,
      status: "already_ranked",
    };
  }
  const result = await exec(
    db,
    "update country_rosters set is_tracked = 0, refreshed_at = ? where country = ? and user_id = ? and source = 'manual' and rank is null",
    [nowIso(), normalized, userId],
  );
  return {
    country: normalized,
    userId,
    ok: true,
    status: Number(result.rowsAffected ?? 0) > 0 ? "removed" : "not_member",
  };
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

function nullableNonNegativeInt(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 0 ? numberValue : null;
}

function buildStoredRankingUser(
  row: RankingRow,
  ranks: { pp: number | null; globalRank: number | null; countryRank: number | null },
): Record<string, unknown> {
  const existingStatistics = isRecord(row.user.statistics) ? row.user.statistics : {};
  const statistics: Record<string, unknown> = {
    ...existingStatistics,
    pp: ranks.pp ?? nullableNumber(existingStatistics.pp),
    global_rank: ranks.globalRank ?? nullablePositiveInt(existingStatistics.global_rank),
    country_rank: ranks.countryRank ?? nullablePositiveInt(existingStatistics.country_rank),
  };

  setNumberIfPresent(statistics, "hit_accuracy", row.hit_accuracy ?? existingStatistics.hit_accuracy);
  setIntegerIfPresent(statistics, "play_count", row.play_count ?? existingStatistics.play_count);
  setIntegerIfPresent(statistics, "ranked_score", row.ranked_score ?? existingStatistics.ranked_score);
  setIntegerIfPresent(statistics, "total_score", row.total_score ?? existingStatistics.total_score);

  const gradeCounts = normalizeGradeCounts(row.grade_counts ?? existingStatistics.grade_counts);
  if (gradeCounts) statistics.grade_counts = gradeCounts;

  return {
    ...row.user,
    statistics,
  };
}

function setNumberIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  const numberValue = nullableNumber(value);
  if (numberValue != null) target[key] = numberValue;
}

function setIntegerIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  const numberValue = nullableNonNegativeInt(value);
  if (numberValue != null) target[key] = numberValue;
}

function normalizeGradeCounts(value: unknown): RankingGradeCounts | null {
  if (!isRecord(value)) return null;
  return {
    ss: nullableNonNegativeInt(value.ss) ?? 0,
    ssh: nullableNonNegativeInt(value.ssh) ?? 0,
    s: nullableNonNegativeInt(value.s) ?? 0,
    sh: nullableNonNegativeInt(value.sh) ?? 0,
    a: nullableNonNegativeInt(value.a) ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
