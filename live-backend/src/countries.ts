import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { exec } from "./db.js";
import type { JobQueue } from "./jobs/queue.js";
import { nowIso } from "./shared/score.js";

export type CountryRegistryStatus = "active" | "warm" | "paused";

export interface CountryRegistryRow {
  country: string;
  status: CountryRegistryStatus;
  pinned: boolean;
  firstRequestedAt: string;
  lastRequestedAt: string;
  lastRosterRefreshAt: string | null;
  lastScoreAt: string | null;
  activeUsers: number;
  lastActiveAt: string | null;
  isWarm: boolean;
}

export async function ensurePinnedCountries(db: Db, config: Pick<Config, "trackedCountries">): Promise<void> {
  for (const country of config.trackedCountries) {
    await upsertCountry(db, country, { pinned: true, status: "warm", touch: false });
  }
}

export async function activateCountry(
  db: Db,
  queue: JobQueue,
  config: Pick<Config, "countryWarmTtlMs" | "trackedCountries" | "rosterRefreshIntervalMs">,
  country: string,
): Promise<CountryRegistryRow> {
  const normalized = normalizeCountry(country);
  await upsertCountry(db, normalized, {
    pinned: config.trackedCountries.includes(normalized),
    status: "active",
  });
  if (await shouldRefreshRoster(db, normalized, config.rosterRefreshIntervalMs)) {
    await queue.enqueue("refresh_country_roster", `roster:${normalized}`, { country: normalized }, { priority: 85, replaceDone: true });
  }
  const row = await getCountryRegistryRow(db, normalized, config);
  if (!row) throw new Error(`Could not activate country ${normalized}`);
  return row;
}

export async function setCountryPaused(
  db: Db,
  config: Pick<Config, "countryWarmTtlMs" | "trackedCountries">,
  country: string,
  paused: boolean,
): Promise<CountryRegistryRow> {
  const normalized = normalizeCountry(country);
  const now = nowIso();
  await ensurePinnedCountries(db, config);
  await exec(
    db,
    `insert into country_registry (country, status, pinned, first_requested_at, last_requested_at, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(country) do update set status = excluded.status, updated_at = excluded.updated_at`,
    [normalized, paused ? "paused" : "active", config.trackedCountries.includes(normalized) ? 1 : 0, now, now, now],
  );
  const row = await getCountryRegistryRow(db, normalized, config);
  if (!row) throw new Error(`Could not update country ${normalized}`);
  return row;
}

export async function markCountryRosterRefreshed(db: Db, country: string): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_registry (country, status, pinned, first_requested_at, last_requested_at, last_roster_refresh_at, updated_at)
     values (?, 'warm', 0, ?, ?, ?, ?)
     on conflict(country) do update set last_roster_refresh_at = excluded.last_roster_refresh_at, updated_at = excluded.updated_at`,
    [normalizeCountry(country), now, now, now, now],
  );
}

export async function markCountryScoreSeen(db: Db, country: string): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_registry (country, status, pinned, first_requested_at, last_requested_at, last_score_at, updated_at)
     values (?, 'warm', 0, ?, ?, ?, ?)
     on conflict(country) do update set last_score_at = excluded.last_score_at, updated_at = excluded.updated_at`,
    [normalizeCountry(country), now, now, now, now],
  );
}

export async function touchCountryRequest(db: Db, country: string): Promise<void> {
  const normalized = normalizeCountry(country);
  const now = nowIso();
  await exec(
    db,
    `insert into country_registry (country, status, pinned, first_requested_at, last_requested_at, updated_at)
     values (?, 'warm', 0, ?, ?, ?)
     on conflict(country) do update set last_requested_at = excluded.last_requested_at, updated_at = excluded.updated_at`,
    [normalized, now, now, now],
  );
}

export async function getActiveCountryCodes(db: Db, config: Pick<Config, "countryWarmTtlMs" | "trackedCountries">): Promise<string[]> {
  await ensurePinnedCountries(db, config);
  const cutoff = new Date(Date.now() - config.countryWarmTtlMs).toISOString();
  const rows = (await exec(
    db,
    `select country
     from country_registry
     where status != 'paused' and (pinned = 1 or last_requested_at >= ?)
     order by pinned desc, last_requested_at desc`,
    [cutoff],
  )).rows;
  const countries = new Set<string>();
  for (const row of rows) countries.add(String(row.country).toUpperCase());
  return [...countries];
}

export async function getCountryRegistry(db: Db, config: Pick<Config, "countryWarmTtlMs" | "trackedCountries">): Promise<CountryRegistryRow[]> {
  await ensurePinnedCountries(db, config);
  const rows = (await exec(
    db,
    `select *
     from country_registry
     order by pinned desc, last_requested_at desc, country asc`,
  )).rows;
  return rows.map((row) => rowToCountryRegistry(row, config));
}

async function getCountryRegistryRow(db: Db, country: string, config: Pick<Config, "countryWarmTtlMs" | "trackedCountries">): Promise<CountryRegistryRow | null> {
  const row = (await exec(db, "select * from country_registry where country = ?", [normalizeCountry(country)])).rows[0];
  return row ? rowToCountryRegistry(row, config) : null;
}

async function upsertCountry(db: Db, country: string, options: { pinned: boolean; status: CountryRegistryStatus; touch?: boolean }): Promise<void> {
  const normalized = normalizeCountry(country);
  const now = nowIso();
  const touch = options.touch !== false;
  await exec(
    db,
    `insert into country_registry (country, status, pinned, first_requested_at, last_requested_at, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(country) do update set
       status = case when country_registry.status = 'paused' then country_registry.status else excluded.status end,
       pinned = max(country_registry.pinned, excluded.pinned),
       last_requested_at = case when ? = 1 then excluded.last_requested_at else country_registry.last_requested_at end,
       updated_at = case when ? = 1 or country_registry.pinned < excluded.pinned then excluded.updated_at else country_registry.updated_at end`,
    [normalized, options.status, options.pinned ? 1 : 0, now, now, now, touch ? 1 : 0, touch ? 1 : 0],
  );
}

function rowToCountryRegistry(row: Record<string, unknown>, config: Pick<Config, "countryWarmTtlMs" | "trackedCountries">): CountryRegistryRow {
  const country = String(row.country).toUpperCase();
  const pinned = Number(row.pinned ?? 0) === 1 || config.trackedCountries.includes(country);
  const lastRequestedAt = String(row.last_requested_at);
  const warmCutoff = Date.now() - config.countryWarmTtlMs;
  return {
    country,
    status: String(row.status ?? "warm") as CountryRegistryStatus,
    pinned,
    firstRequestedAt: String(row.first_requested_at),
    lastRequestedAt,
    lastRosterRefreshAt: row.last_roster_refresh_at == null ? null : String(row.last_roster_refresh_at),
    lastScoreAt: row.last_score_at == null ? null : String(row.last_score_at),
    activeUsers: 0,
    lastActiveAt: lastRequestedAt,
    isWarm: pinned || new Date(lastRequestedAt).getTime() >= warmCutoff,
  };
}

function normalizeCountry(country: string): string {
  return country.trim().toUpperCase().slice(0, 2);
}

async function shouldRefreshRoster(db: Db, country: string, intervalMs: number): Promise<boolean> {
  const row = (await exec(
    db,
    `select cr.last_roster_refresh_at, count(ro.user_id) as users
     from country_registry cr
     left join country_rosters ro on ro.country = cr.country and ro.is_tracked = 1
     where cr.country = ?
     group by cr.country`,
    [country],
  )).rows[0];
  if (!row || Number(row.users ?? 0) === 0) return true;
  if (row.last_roster_refresh_at == null) return true;
  return new Date(String(row.last_roster_refresh_at)).getTime() < Date.now() - intervalMs;
}
