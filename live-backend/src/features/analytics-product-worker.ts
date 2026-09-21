import { parentPort, workerData } from "node:worker_threads";
import { createRuntimeDb, type Db } from "../db.js";
import { advanceProductAnalytics, computeProductInsights, type ProductAnalyticsOptions } from "./analytics-product.js";

const port = parentPort;
if (!port) throw new Error("analytics-product-worker requires a worker thread");

void (async () => {
  let db: Db | null = null;
  try {
    const { databaseUrl, options } = workerData as { databaseUrl: string; options: ProductAnalyticsOptions };
    db = await createRuntimeDb({ databaseUrl, sqliteCacheMb: 8, sqliteMmapMb: 0 });
    await advanceProductAnalytics(db, options);
    port.postMessage({ ok: true, data: await computeProductInsights(db, options) });
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    db?.close();
    port.close();
  }
})();
