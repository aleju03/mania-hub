import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import type { ScoreIngestor } from "../ingest/score-ingestor.js";
import { TokenBucketLimiter } from "../osu/client.js";
import type { OscScore } from "../shared/types.js";

export class OscBackfill {
  private readonly limiter: TokenBucketLimiter;

  constructor(private readonly config: Pick<Config, "oscBaseUrl" | "oscJsonTargetPerMinute" | "oscBackfillMaxAgeMs">, private readonly fetchImpl: typeof fetch = fetch) {
    this.limiter = new TokenBucketLimiter(config.oscJsonTargetPerMinute);
  }

  async run(db: Db, ingestor: ScoreIngestor): Promise<number> {
    const row = (await exec(db, "select value_json from live_meta where key = 'osc_last_seen_ms'")).rows[0];
    const storedAfter = parseJson<number>(row?.value_json, 0);
    const boundedAfter = Date.now() - this.config.oscBackfillMaxAgeMs;
    const after = Math.max(storedAfter, boundedAfter);
    const url = new URL("/api/scores", this.config.oscBaseUrl);
    url.searchParams.set("mode", "mania");
    url.searchParams.set("limit", "1000");
    if (after > 0) url.searchParams.set("after", String(after));
    const scores = await this.limiter.schedule("osc_json_backfill", "/api/scores", async () => {
      const response = await this.fetchImpl(url);
      if (!response.ok) throw new Error(`oSC JSON ${response.status}`);
      const body = await response.json() as OscScore[] | { scores?: OscScore[] };
      const scores = Array.isArray(body) ? body : body.scores ?? [];
      return scores.map((score) => ({ ...score, ruleset_id: score.ruleset_id ?? 3 }));
    });
    const result = await ingestor.ingestBatch(scores, "osc_json");
    return result.inserted;
  }
}
