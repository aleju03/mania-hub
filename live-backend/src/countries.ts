import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { exec } from "./db.js";
import type { JobQueue } from "./jobs/queue.js";
import { nowIso } from "./shared/score.js";

export type CountryRegistryStatus = "active" | "warm" | "paused";
export type CountryFeatureTier = "indexed" | "maps_warm" | "live" | "snipes";

export interface CountryRegistryRow {
  country: string;
  status: CountryRegistryStatus;
  featureTier: CountryFeatureTier;
  pinned: boolean;
  firstRequestedAt: string;
  lastRequestedAt: string;
  lastRosterRefreshAt: string | null;
  lastScoreAt: string | null;
  activeUsers: number;
  lastActiveAt: string | null;
  isWarm: boolean;
}

type CountryFeatureConfig = Pick<Config, "trackedCountries"> & Partial<Pick<Config, "prewarmCountries" | "mapsWarmCountries">>;
type CountryWarmConfig = CountryFeatureConfig & Pick<Config, "countryWarmTtlMs">;

export async function ensurePinnedCountries(db: Db, config: CountryFeatureConfig): Promise<void> {
  for (const country of config.prewarmCountries ?? []) {
    await upsertCountry(db, country, { pinned: false, status: "warm", featureTier: "indexed", touch: false });
  }
  for (const country of config.mapsWarmCountries ?? []) {
    await upsertCountry(db, country, { pinned: false, status: "warm", featureTier: "maps_warm", touch: false });
  }
  for (const country of config.trackedCountries) {
    await upsertCountry(db, country, { pinned: true, status: "warm", featureTier: "snipes", touch: false });
  }
}

export async function activateCountry(
  db: Db,
  queue: JobQueue,
  config: CountryWarmConfig & Pick<Config, "rosterRefreshIntervalMs">,
  country: string,
): Promise<CountryRegistryRow> {
  const normalized = normalizeCountry(country);
  const configuredTier = getConfiguredCountryFeatureTier(config, normalized);
  const existing = await getCountryRegistryRow(db, normalized, config);
  await upsertCountry(db, normalized, {
    pinned: config.trackedCountries.includes(normalized),
    status: existing?.status === "warm" && existing.isWarm ? "warm" : "active",
    featureTier: existing && existing.featureTier !== configuredTier
      ? existing.featureTier
      : maxCountryFeatureTier(configuredTier, config.trackedCountries.includes(normalized) ? "snipes" : "live"),
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
  config: CountryWarmConfig,
  country: string,
  paused: boolean,
): Promise<CountryRegistryRow> {
  return setCountryStatus(db, config, country, paused ? "paused" : "active");
}

export async function setCountryStatus(
  db: Db,
  config: CountryWarmConfig,
  country: string,
  status: CountryRegistryStatus,
): Promise<CountryRegistryRow> {
  const normalized = normalizeCountry(country);
  const now = nowIso();
  await ensurePinnedCountries(db, config);
  const configuredTier = getConfiguredCountryFeatureTier(config, normalized) ?? "indexed";
  await exec(
    db,
    `insert into country_registry (country, status, feature_tier, pinned, first_requested_at, last_requested_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(country) do update set
       status = excluded.status,
       last_requested_at = case when excluded.status = 'paused' then country_registry.last_requested_at else excluded.last_requested_at end,
       updated_at = excluded.updated_at`,
    [normalized, status, configuredTier, config.trackedCountries.includes(normalized) ? 1 : 0, now, now, now],
  );
  const row = await getCountryRegistryRow(db, normalized, config);
  if (!row) throw new Error(`Could not update country ${normalized}`);
  return row;
}

export async function setCountryFeatureTier(
  db: Db,
  config: CountryWarmConfig,
  country: string,
  tier: CountryFeatureTier,
): Promise<CountryRegistryRow> {
  const normalized = normalizeCountry(country);
  const now = nowIso();
  await ensurePinnedCountries(db, config);
  const pinned = config.trackedCountries.includes(normalized) || tier === "snipes";
  await exec(
    db,
    `insert into country_registry (country, status, feature_tier, pinned, first_requested_at, last_requested_at, updated_at)
     values (?, 'warm', ?, ?, ?, ?, ?)
     on conflict(country) do update set
       feature_tier = excluded.feature_tier,
       pinned = excluded.pinned,
       last_requested_at = excluded.last_requested_at,
       updated_at = excluded.updated_at`,
    [normalized, tier, pinned ? 1 : 0, now, now, now],
  );
  const row = await getCountryRegistryRow(db, normalized, config);
  if (!row) throw new Error(`Could not update country ${normalized}`);
  return row;
}

export async function deleteCountryData(db: Db, country: string): Promise<Record<string, number>> {
  const normalized = normalizeCountry(country);
  const deleted: Record<string, number> = {};
  const deleteFrom = async (table: string, column = "country") => {
    deleted[table] = Number((await exec(db, `delete from ${table} where ${column} = ?`, [normalized])).rowsAffected ?? 0);
  };

  await deleteFrom("country_registry");
  await deleteFrom("country_rosters");
  await deleteFrom("country_rank_snapshots");
  await deleteFrom("score_events");
  await deleteFrom("country_beatmap_scores");
  await deleteFrom("top_play_events");
  await deleteFrom("snipe_events");
  await deleteFrom("country_maps_snapshots");
  await deleteFrom("country_maps_farmed_scores");
  await deleteFrom("live_event_log");
  deleted.live_meta = Number((await exec(db, "delete from live_meta where key = ?", [`maps_farmed_overlay_updated_at:${normalized}`])).rowsAffected ?? 0);

  const jobCountryJson = `%"country":"${normalized}"%`;
  deleted.jobs = Number((await exec(
    db,
    `delete from jobs
     where dedupe_key like ?
        or dedupe_key like ?
        or dedupe_key like ?
        or dedupe_key like ?
        or payload_json like ?`,
    [`roster:${normalized}`, `maps:${normalized}`, `maps-farmed:${normalized}:%`, `snipe-seed:${normalized}:%`, jobCountryJson],
  )).rowsAffected ?? 0);

  return deleted;
}

export async function markCountryRosterRefreshed(db: Db, country: string): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_registry (country, status, feature_tier, pinned, first_requested_at, last_requested_at, last_roster_refresh_at, updated_at)
     values (?, 'warm', 'indexed', 0, ?, ?, ?, ?)
     on conflict(country) do update set last_roster_refresh_at = excluded.last_roster_refresh_at, updated_at = excluded.updated_at`,
    [normalizeCountry(country), now, now, now, now],
  );
}

export async function markCountryScoreSeen(db: Db, country: string): Promise<void> {
  const now = nowIso();
  await exec(
    db,
    `insert into country_registry (country, status, feature_tier, pinned, first_requested_at, last_requested_at, last_score_at, updated_at)
     values (?, 'warm', 'live', 0, ?, ?, ?, ?)
     on conflict(country) do update set last_score_at = excluded.last_score_at, updated_at = excluded.updated_at`,
    [normalizeCountry(country), now, now, now, now],
  );
}

export async function touchCountryRequest(db: Db, country: string): Promise<void> {
  const normalized = normalizeCountry(country);
  const now = nowIso();
  await exec(
    db,
    `insert into country_registry (country, status, feature_tier, pinned, first_requested_at, last_requested_at, updated_at)
     values (?, 'warm', 'indexed', 0, ?, ?, ?)
     on conflict(country) do update set last_requested_at = excluded.last_requested_at, updated_at = excluded.updated_at`,
    [normalized, now, now, now],
  );
}

export async function getIndexedCountryCodes(db: Db, config: CountryWarmConfig): Promise<string[]> {
  return getCountryCodesWithFeature(db, config, "indexed");
}

export async function getMapsWarmCountryCodes(db: Db, config: CountryWarmConfig): Promise<string[]> {
  return getCountryCodesWithFeature(db, config, "maps_warm");
}

export async function getActiveCountryCodes(db: Db, config: CountryWarmConfig): Promise<string[]> {
  return getCountryCodesWithFeature(db, config, "live");
}

export async function canSeedSnipesForCountry(db: Db, config: CountryWarmConfig, country: string): Promise<boolean> {
  const row = await getCountryRegistryRow(db, country, config);
  if (!row) return config.trackedCountries.includes(normalizeCountry(country));
  return row.status !== "paused" && row.isWarm && isCountryFeatureAtLeast(row.featureTier, "snipes");
}

export async function getCountryRegistry(db: Db, config: CountryWarmConfig): Promise<CountryRegistryRow[]> {
  await ensurePinnedCountries(db, config);
  const rows = (await exec(
    db,
    `select *
     from country_registry
     order by pinned desc, last_requested_at desc, country asc`,
  )).rows;
  return rows.map((row) => rowToCountryRegistry(row, config));
}

async function getCountryRegistryRow(db: Db, country: string, config: CountryWarmConfig): Promise<CountryRegistryRow | null> {
  const row = (await exec(db, "select * from country_registry where country = ?", [normalizeCountry(country)])).rows[0];
  return row ? rowToCountryRegistry(row, config) : null;
}

async function upsertCountry(db: Db, country: string, options: { pinned: boolean; status: CountryRegistryStatus; featureTier: CountryFeatureTier; touch?: boolean }): Promise<void> {
  const normalized = normalizeCountry(country);
  const now = nowIso();
  const touch = options.touch !== false;
  await exec(
    db,
    `insert into country_registry (country, status, feature_tier, pinned, first_requested_at, last_requested_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(country) do update set
       status = case when country_registry.status in ('active', 'paused') then country_registry.status else excluded.status end,
       feature_tier = case when ? = 1 then excluded.feature_tier else country_registry.feature_tier end,
       pinned = max(country_registry.pinned, excluded.pinned),
       last_requested_at = case when ? = 1 then excluded.last_requested_at else country_registry.last_requested_at end,
       updated_at = case when ? = 1 or country_registry.pinned < excluded.pinned then excluded.updated_at else country_registry.updated_at end`,
    [normalized, options.status, options.featureTier, options.pinned ? 1 : 0, now, now, now, touch ? 1 : 0, touch ? 1 : 0, touch ? 1 : 0],
  );
}

function rowToCountryRegistry(row: Record<string, unknown>, config: CountryWarmConfig): CountryRegistryRow {
  const country = String(row.country).toUpperCase();
  const pinned = Number(row.pinned ?? 0) === 1 || config.trackedCountries.includes(country);
  const featureTier = parseCountryFeatureTier(row.feature_tier);
  const lastRequestedAt = String(row.last_requested_at);
  const warmCutoff = Date.now() - config.countryWarmTtlMs;
  const lastRequestedMs = new Date(lastRequestedAt).getTime();
  const isConfigured = getConfiguredCountryFeatureTier(config, country) != null;
  return {
    country,
    status: String(row.status ?? "warm") as CountryRegistryStatus,
    featureTier,
    pinned,
    firstRequestedAt: String(row.first_requested_at),
    lastRequestedAt,
    lastRosterRefreshAt: row.last_roster_refresh_at == null ? null : String(row.last_roster_refresh_at),
    lastScoreAt: row.last_score_at == null ? null : String(row.last_score_at),
    activeUsers: 0,
    lastActiveAt: lastRequestedAt,
    isWarm: pinned || isConfigured || (Number.isFinite(lastRequestedMs) && lastRequestedMs >= warmCutoff),
  };
}

function normalizeCountry(country: string): string {
  return country.trim().toUpperCase().slice(0, 2);
}

async function getCountryCodesWithFeature(db: Db, config: CountryWarmConfig, minimumTier: CountryFeatureTier): Promise<string[]> {
  await ensurePinnedCountries(db, config);
  const countries = new Set<string>();
  const rows = (await exec(
    db,
    `select country, status, feature_tier, pinned, last_requested_at
     from country_registry
     order by pinned desc, last_requested_at desc`,
  )).rows;
  for (const row of rows) {
    const registry = rowToCountryRegistry(row, config);
    if (registry.status === "paused") {
      countries.delete(registry.country);
      continue;
    }
    if (!registry.isWarm) continue;
    if (isCountryFeatureAtLeast(registry.featureTier, minimumTier)) countries.add(registry.country);
  }
  return [...countries];
}

function getConfiguredCountryFeatureTier(config: CountryFeatureConfig, country: string): CountryFeatureTier | null {
  const normalized = normalizeCountry(country);
  if (config.trackedCountries.includes(normalized)) return "snipes";
  if ((config.mapsWarmCountries ?? []).includes(normalized)) return "maps_warm";
  if ((config.prewarmCountries ?? []).includes(normalized)) return "indexed";
  return null;
}

function parseCountryFeatureTier(value: unknown): CountryFeatureTier {
  return value === "snipes" || value === "live" || value === "maps_warm" || value === "indexed"
    ? value
    : "indexed";
}

export function isCountryFeatureAtLeast(tier: CountryFeatureTier, minimumTier: CountryFeatureTier): boolean {
  return tierRank(tier) >= tierRank(minimumTier);
}

function maxCountryFeatureTier(...tiers: Array<CountryFeatureTier | null | undefined>): CountryFeatureTier {
  return tiers.reduce<CountryFeatureTier>((best, tier) => {
    if (!tier) return best;
    return tierRank(tier) > tierRank(best) ? tier : best;
  }, "indexed");
}

function tierRank(tier: CountryFeatureTier): number {
  switch (tier) {
    case "snipes": return 3;
    case "live": return 2;
    case "maps_warm": return 1;
    case "indexed": return 0;
  }
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
