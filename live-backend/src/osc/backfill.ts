import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec, json, logApiCall, parseJson } from "../db.js";
import type { ScoreIngestor } from "../ingest/score-ingestor.js";
import type { JobQueue } from "../jobs/queue.js";
import { TokenBucketLimiter } from "../osu/client.js";
import type { OscScore } from "../shared/types.js";

export interface OscBackfillPayload {
  after?: number;
  pagesRemaining?: number;
  country?: string;
  // Identifies a country catch-up chain. A page only runs/re-enqueues while its
  // epoch matches the stored one; cancelling bumps the stored epoch so in-flight
  // pages stop re-spawning the chain.
  epoch?: number;
}

export interface OscBackfillResult {
  fetched: number;
  inserted: number;
  skipped: number;
  after: number;
  nextAfter: number | null;
  hasMore: boolean;
  country?: string;
}

type OscScoresResponse = OscScore[] | {
  scores?: OscScore[];
  meta?: {
    newest?: number | string | null;
    oldest?: number | string | null;
    has_more?: boolean;
    hasMore?: boolean;
  };
};

const COUNTRY_CATCHUP_OVERLAP_MS = 5 * 60_000;
const COUNTRY_CATCHUP_PAGE_LIMIT = 25;
const COUNTRY_CATCHUP_PAGE_DELAY_MS = 5_000;

export class OscBackfill {
  private readonly limiter: TokenBucketLimiter;

  constructor(
    private readonly config: Pick<Config, "oscBaseUrl" | "oscJsonTargetPerMinute" | "oscBackfillMaxAgeMs" | "oscBackfillPageLimit" | "oscBackfillMaxPages"> & Partial<Pick<Config, "oscGlobalBackfillPageLimit">>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.limiter = new TokenBucketLimiter(config.oscJsonTargetPerMinute);
  }

  async enqueueStartup(queue: JobQueue, db: Db): Promise<void> {
    const after = await this.resolveAfter(db, undefined);
    await queue.enqueue(
      "osc_backfill",
      "osc-backfill:startup",
      { after, pagesRemaining: this.config.oscBackfillMaxPages } satisfies OscBackfillPayload,
      { priority: 5, replaceDone: true },
    );
  }

  async runPage(db: Db, queue: JobQueue, ingestor: ScoreIngestor, payload: OscBackfillPayload = {}): Promise<OscBackfillResult> {
    const after = await this.resolveAfter(db, payload.after);
    const country = normalizeCountryPayload(payload.country);
    if (country && payload.epoch != null && await isCatchupCancelled(db, country, payload.epoch)) {
      return { fetched: 0, inserted: 0, skipped: 0, after, nextAfter: null, hasMore: false, country };
    }
    const pageLimit = country
      ? Math.min(this.config.oscBackfillPageLimit, COUNTRY_CATCHUP_PAGE_LIMIT)
      : Math.min(this.config.oscBackfillPageLimit, this.config.oscGlobalBackfillPageLimit ?? 100);
    const url = new URL("/api/scores", this.config.oscBaseUrl);
    url.searchParams.set("mode", "mania");
    url.searchParams.set("limit", String(pageLimit));
    if (after > 0) url.searchParams.set("after", String(after));
    const responseBody = await this.limiter.schedule("osc_json_backfill", "/api/scores", async () => {
      const startedAt = new Date().toISOString();
      const response = await this.fetchImpl(url);
      if (!response.ok) throw new Error(`oSC JSON ${response.status}`);
      await logApiCall(db, {
        provider: "osc",
        caller: "job:osc_backfill",
        path: `${url.pathname}${url.search}`,
        startedAt,
      }).catch(() => {});
      return response.json() as Promise<OscScoresResponse>;
    });
    const scores = normalizeScores(responseBody);
    const result = await ingestor.ingestBatch(scores, "osc_json", country ? { countryAllowlist: [country] } : {});
    const nextAfter = getNextAfter(responseBody, scores, after);
    const pagesRemaining = Math.max(0, payload.pagesRemaining ?? this.config.oscBackfillMaxPages);
    const metaHasMore = Array.isArray(responseBody) ? undefined : responseBody.meta?.has_more ?? responseBody.meta?.hasMore;
    const hasMore = (metaHasMore ?? scores.length >= pageLimit) && nextAfter != null && pagesRemaining > 1;
    const finishedAt = new Date().toISOString();
    if (nextAfter != null && !country) {
      await setGlobalCursor(db, nextAfter, finishedAt);
    }
    if (nextAfter != null && country) {
      await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
        `osc_country_catchup_cursor_ms:${country}`,
        json(nextAfter),
        finishedAt,
      ]);
    }
    if (hasMore) {
      const nextPayload = {
        after: nextAfter,
        pagesRemaining: pagesRemaining - 1,
        ...(country ? { country, ...(payload.epoch != null ? { epoch: payload.epoch } : {}) } : {}),
      } satisfies OscBackfillPayload;
      await queue.enqueue(
        country ? "osc_country_catchup" : "osc_backfill",
        country ? `osc-country-catchup:${country}:${nextAfter}` : `osc-backfill:${nextAfter}`,
        nextPayload,
        { priority: 5, runAfter: new Date(Date.now() + (country ? COUNTRY_CATCHUP_PAGE_DELAY_MS : this.pageDelayMs())), replaceDone: true },
      );
    }
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
      country ? `osc_country_catchup_last_result:${country}` : "osc_backfill_last_result",
      json({ fetched: scores.length, inserted: result.inserted, skipped: result.skipped, after, nextAfter, hasMore, ...(country ? { country } : {}) }),
      finishedAt,
    ]);
    return { fetched: scores.length, inserted: result.inserted, skipped: result.skipped, after, nextAfter, hasMore, ...(country ? { country } : {}) };
  }

  private async resolveAfter(db: Db, payloadAfter: number | undefined): Promise<number> {
    const boundedAfter = Date.now() - this.config.oscBackfillMaxAgeMs;
    if (Number.isFinite(payloadAfter) && Number(payloadAfter) > 0) return Math.max(Number(payloadAfter), boundedAfter);
    const storedAfter = await this.getStoredBackfillAfter(db);
    return Math.max(storedAfter, boundedAfter);
  }

  private async getStoredBackfillAfter(db: Db): Promise<number> {
    const rows = (await exec(
      db,
      "select key, value_json from live_meta where key in ('osc_backfill_cursor_ms', 'osc_backfill_last_result', 'osc_last_seen_ms')",
    )).rows;
    const byKey = new Map(rows.map((row) => [String(row.key), row.value_json]));
    const cursor = parseJson<number>(byKey.get("osc_backfill_cursor_ms"), 0);
    if (Number.isFinite(cursor) && cursor > 0) return cursor;

    const lastResult = parseJson<Partial<OscBackfillResult>>(byKey.get("osc_backfill_last_result"), {});
    const lastResultAfter = Number(lastResult.nextAfter);
    if (lastResult.hasMore && Number.isFinite(lastResultAfter) && lastResultAfter > 0) return lastResultAfter;

    const liveLastSeen = parseJson<number>(byKey.get("osc_last_seen_ms"), 0);
    return Number.isFinite(liveLastSeen) && liveLastSeen > 0 ? liveLastSeen : 0;
  }

  private pageDelayMs(): number {
    return Math.ceil(60_000 / Math.max(1, this.config.oscJsonTargetPerMinute));
  }
}

export async function enqueueOscBackfill(queue: JobQueue, db: Db, config: Config): Promise<void> {
  await new OscBackfill(config).enqueueStartup(queue, db);
}

export async function enqueueOscCountryCatchup(queue: JobQueue, db: Db, config: Config, country: string): Promise<{ country: string; after: number }> {
  const normalized = normalizeCountryPayload(country);
  if (!normalized) throw new Error("Invalid country.");
  const after = await getCountryCatchupAfter(db, config, normalized);
  const epoch = Date.now();
  await setCatchupEpoch(db, normalized, epoch);
  await queue.enqueue(
    "osc_country_catchup",
    `osc-country-catchup:${normalized}:${after}`,
    { country: normalized, after, pagesRemaining: config.oscBackfillMaxPages, epoch } satisfies OscBackfillPayload,
    { priority: 5, replaceDone: true },
  );
  return { country: normalized, after };
}

export async function cancelOscCountryCatchup(db: Db, country: string): Promise<{ country: string; cancelled: number }> {
  const normalized = normalizeCountryPayload(country);
  if (!normalized) throw new Error("Invalid country.");
  // Bump the epoch first so any page already running stops re-enqueuing its chain.
  await setCatchupEpoch(db, normalized, Date.now());
  const result = await exec(
    db,
    "delete from jobs where type = 'osc_country_catchup' and dedupe_key like ? and status in ('queued', 'failed', 'running')",
    [`osc-country-catchup:${normalized}:%`],
  );
  return { country: normalized, cancelled: Number(result.rowsAffected ?? 0) };
}

async function setCatchupEpoch(db: Db, country: string, epoch: number): Promise<void> {
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)", [
    `osc_country_catchup_epoch:${country}`,
    json(epoch),
    new Date().toISOString(),
  ]);
}

async function isCatchupCancelled(db: Db, country: string, epoch: number): Promise<boolean> {
  const row = (await exec(db, "select value_json from live_meta where key = ?", [`osc_country_catchup_epoch:${country}`])).rows[0];
  const stored = parseJson<number>(row?.value_json, Number.NaN);
  return Number.isFinite(stored) && stored !== epoch;
}

function normalizeScores(body: OscScoresResponse): OscScore[] {
  const scores = Array.isArray(body) ? body : body.scores ?? [];
  return scores.map((score) => ({ ...score, ruleset_id: score.ruleset_id ?? 3 }));
}

async function getCountryCatchupAfter(db: Db, config: Pick<Config, "oscBackfillMaxAgeMs">, country: string): Promise<number> {
  const row = (await exec(db, "select max(ended_at) as ended_at from score_events where country = ?", [country])).rows[0];
  const lastScoreMs = row?.ended_at == null ? NaN : new Date(String(row.ended_at)).getTime();
  if (Number.isFinite(lastScoreMs) && lastScoreMs > 0) return Math.max(0, lastScoreMs - COUNTRY_CATCHUP_OVERLAP_MS);
  return Math.max(0, Date.now() - config.oscBackfillMaxAgeMs);
}

async function setGlobalCursor(db: Db, nextAfter: number, updatedAt: string): Promise<void> {
  const row = (await exec(db, "select value_json from live_meta where key = 'osc_backfill_cursor_ms'")).rows[0];
  const current = parseJson<number>(row?.value_json, 0);
  await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values ('osc_backfill_cursor_ms', ?, ?)", [
    json(Math.max(Number.isFinite(current) ? current : 0, nextAfter)),
    updatedAt,
  ]);
}

function normalizeCountryPayload(country: string | undefined): string | null {
  if (typeof country !== "string") return null;
  const normalized = country.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function getNextAfter(body: OscScoresResponse, scores: OscScore[], after: number): number | null {
  const metaNewest = Array.isArray(body) ? null : parseCursor(body.meta?.newest);
  const newestScore = scores.reduce((newest, score) => {
    const time = new Date(score.ended_at ?? score.created_at ?? 0).getTime();
    return Number.isFinite(time) ? Math.max(newest, time) : newest;
  }, after);
  const newest = Math.max(after, metaNewest ?? 0, newestScore);
  return newest > after ? newest + 1 : null;
}

function parseCursor(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}
