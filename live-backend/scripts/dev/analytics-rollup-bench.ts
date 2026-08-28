/* One-off local benchmark for the analytics monitor rollups: backfills the
   hourly tables on the local analytics DB (a prod snapshot, ideally), then
   times the 720h monitor read raw vs hybrid. Run from live-backend/:
   npx tsx scripts/dev/analytics-rollup-bench.ts */
import { createDb } from "../../src/db.js";
import { AnalyticsStore, computeMonitorSnapshot, type MonitorComputeOptions } from "../../src/features/analytics.js";

const DB_URL = process.env.ANALYTICS_DATABASE_URL ?? "file:./data/mania-hub-analytics.db";
const options: MonitorComputeOptions = {
  feedHosts: ["mania-tracker.com", "www.mania-tracker.com"],
  feedExcludedViewer: "aleju03",
  displayTimeZone: "America/Costa_Rica",
};

const db = await createDb({ databaseUrl: DB_URL, sqliteCacheMb: 8, sqliteMmapMb: 0 });
const store = new AnalyticsStore(db, { retentionDays: 90 });
await store.ensureSchema();

const backfillStart = Date.now();
await store.advanceRollups();
console.log(`advanceRollups: ${Date.now() - backfillStart}ms`);

for (const rangeHours of [168, 720]) {
  for (const [label, rollupBound] of [["raw", null], ["hybrid", undefined]] as const) {
    const started = Date.now();
    const data = await computeMonitorSnapshot(db, options, { rangeHours, now: Date.now(), rollupBound });
    console.log(`${rangeHours}h ${label}: ${Date.now() - started}ms  events=${data.eventsInRange} visitors=${data.uniqueVisitorsInRange} pageviews=${data.pageviewsInRange} bounce=${data.bounce.bounced}/${data.bounce.landers}`);
  }
}
db.close();
