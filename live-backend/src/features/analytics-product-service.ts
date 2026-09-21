import type { Db } from "../db.js";
import { errorContext, logWarn } from "../logger.js";
import { createModuleWorker } from "../module-worker.js";
import type { AnalyticsProductInsights, AnalyticsProductResponse } from "../shared/analytics-insights.js";
import { advanceProductAnalytics, computeProductInsights, type ProductAnalyticsOptions } from "./analytics-product.js";

// A single worker owns the cursor. Requests immediately receive the previous
// snapshot (or an explicit warming state), never a full raw-event scan. A slow
// backfill cannot create overlapping workers or be terminated inside libSQL.
export class AnalyticsProductService {
  private data: AnalyticsProductInsights | null = null;
  private running = false;
  private failed = false;
  private lastAttempt = 0;

  constructor(private readonly db: Db, private readonly databaseUrl: string | null, private readonly options: ProductAnalyticsOptions) {}

  read(): AnalyticsProductResponse {
    if (!this.running && Date.now() - this.lastAttempt >= 60_000) this.refresh();
    return { state: this.failed ? "error" : this.running ? this.data ? "refreshing" : "warming" : "fresh", data: this.data };
  }

  private refresh(): void {
    this.running = true;
    this.failed = false;
    this.lastAttempt = Date.now();
    const finish = (data: AnalyticsProductInsights | null, error?: unknown) => {
      this.running = false;
      this.lastAttempt = Date.now();
      if (data) this.data = data;
      this.failed = !data;
      if (error) logWarn("analytics_product_refresh_failed", errorContext(error));
    };
    if (!this.databaseUrl) {
      // In-memory test stores have no file the worker can open.
      void advanceProductAnalytics(this.db, this.options).then(() => computeProductInsights(this.db, this.options))
        .then((data) => finish(data), (error) => finish(null, error));
      return;
    }
    try {
      const worker = createModuleWorker(new URL("./analytics-product-worker.js", import.meta.url), {
        workerData: { databaseUrl: this.databaseUrl, options: this.options },
      });
      worker.unref();
      let received = false;
      worker.on("message", (result: { ok: boolean; data?: AnalyticsProductInsights; error?: string }) => {
        received = true;
        if (result.ok && result.data) this.data = result.data;
        this.failed = !result.ok;
        if (!result.ok) logWarn("analytics_product_refresh_failed", { error: result.error });
      });
      worker.on("error", (error) => {
        this.failed = true;
        logWarn("analytics_product_worker_failed", errorContext(error));
      });
      worker.on("exit", (code) => {
        this.running = false;
        this.lastAttempt = Date.now();
        if (!received || code !== 0) this.failed = true;
      });
    } catch (error) { finish(null, error); }
  }
}
