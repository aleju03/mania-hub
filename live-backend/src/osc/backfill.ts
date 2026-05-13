import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { ScoreIngestor } from "../ingest/score-ingestor.js";
import type { JobQueue } from "../jobs/queue.js";
import { TokenBucketLimiter } from "../osu/client.js";
import type { OscScore } from "../shared/types.js";

export interface OscBackfillPayload {
  after?: number;
  pagesRemaining?: number;
}

export interface OscBackfillResult {
  fetched: number;
  inserted: number;
  skipped: number;
  after: number;
  nextAfter: number | null;
  hasMore: boolean;
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

export class OscBackfill {
  private readonly limiter: TokenBucketLimiter;

  constructor(
    private readonly config: Pick<Config, "oscBaseUrl" | "oscJsonTargetPerMinute" | "oscBackfillMaxAgeMs" | "oscBackfillPageLimit" | "oscBackfillMaxPages">,
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
    const url = new URL("/api/scores", this.config.oscBaseUrl);
    url.searchParams.set("mode", "mania");
    url.searchParams.set("limit", String(this.config.oscBackfillPageLimit));
    if (after > 0) url.searchParams.set("after", String(after));
    const responseBody = await this.limiter.schedule("osc_json_backfill", "/api/scores", async () => {
      const startedAt = new Date().toISOString();
      const response = await this.fetchImpl(url);
      if (!response.ok) throw new Error(`oSC JSON ${response.status}`);
      await exec(db, "insert into api_call_log (provider, caller, path, started_at) values ('osc', 'job:osc_backfill', ?, ?)", [
        `${url.pathname}${url.search}`,
        startedAt,
      ]).catch(() => {});
      return response.json() as Promise<OscScoresResponse>;
    });
    const scores = normalizeScores(responseBody);
    const result = await ingestor.ingestBatch(scores, "osc_json");
    const nextAfter = getNextAfter(responseBody, scores, after);
    const pagesRemaining = Math.max(0, payload.pagesRemaining ?? this.config.oscBackfillMaxPages);
    const metaHasMore = Array.isArray(responseBody) ? undefined : responseBody.meta?.has_more ?? responseBody.meta?.hasMore;
    const hasMore = (metaHasMore ?? scores.length >= this.config.oscBackfillPageLimit) && nextAfter != null && pagesRemaining > 1;
    if (hasMore) {
      await queue.enqueue(
        "osc_backfill",
        `osc-backfill:${nextAfter}`,
        { after: nextAfter, pagesRemaining: pagesRemaining - 1 } satisfies OscBackfillPayload,
        { priority: 5, runAfter: new Date(Date.now() + this.pageDelayMs()) },
      );
    }
    await exec(db, "insert or replace into live_meta (key, value_json, updated_at) values ('osc_backfill_last_result', ?, ?)", [
      json({ fetched: scores.length, inserted: result.inserted, skipped: result.skipped, after, nextAfter, hasMore }),
      new Date().toISOString(),
    ]);
    return { fetched: scores.length, inserted: result.inserted, skipped: result.skipped, after, nextAfter, hasMore };
  }

  private async resolveAfter(db: Db, payloadAfter: number | undefined): Promise<number> {
    if (Number.isFinite(payloadAfter) && Number(payloadAfter) > 0) return Number(payloadAfter);
    const row = (await exec(db, "select value_json from live_meta where key = 'osc_last_seen_ms'")).rows[0];
    const storedAfter = parseJson<number>(row?.value_json, 0);
    const boundedAfter = Date.now() - this.config.oscBackfillMaxAgeMs;
    return Math.max(storedAfter, boundedAfter);
  }

  private pageDelayMs(): number {
    return Math.ceil(60_000 / Math.max(1, this.config.oscJsonTargetPerMinute));
  }
}

export async function enqueueOscBackfill(queue: JobQueue, db: Db, config: Config): Promise<void> {
  await new OscBackfill(config).enqueueStartup(queue, db);
}

function normalizeScores(body: OscScoresResponse): OscScore[] {
  const scores = Array.isArray(body) ? body : body.scores ?? [];
  return scores.map((score) => ({ ...score, ruleset_id: score.ruleset_id ?? 3 }));
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
