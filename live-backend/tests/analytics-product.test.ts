import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, exec, type Db } from "../src/db.js";
import { AnalyticsStore } from "../src/features/analytics.js";
import { advanceProductAnalytics, computeProductInsights, type ProductAnalyticsOptions } from "../src/features/analytics-product.js";
import { AnalyticsProductService } from "../src/features/analytics-product-service.js";

const NOW = Date.UTC(2026, 8, 21, 13);
const at = (day: number, hour = 12) => Date.UTC(2026, 8, day, hour);
const options: ProductAnalyticsOptions = { feedHosts: ["mania-tracker.com"], feedExcludedViewer: "aleju03", retentionDays: 90 };
let db: Db;
let dir: string;

async function event(visitor: string, day: number, path = "/packs", props: Record<string, unknown> = {}, name = "$pageview", extra: { bot?: boolean; host?: string; username?: string } = {}) {
  await exec(db, `insert into analytics_events (ts, event, distinct_id, host, path, is_bot, props, screen_width, viewer_username, referring_domain)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [at(day), name, visitor, extra.host ?? "mania-tracker.com", path, extra.bot ? 1 : 0, JSON.stringify(props), props.width === 390 ? 390 : 1920, extra.username ?? null, "discord.com"]);
}

async function report() {
  await advanceProductAnalytics(db, options, NOW);
  return computeProductInsights(db, options, NOW);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-product-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "analytics.db")}` });
  await new AnalyticsStore(db).ensureSchema();
  // Establish real traffic history before the periods/cohorts under test.
  await event("history-anchor", -20, "/");
});
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

describe("product analytics projections", () => {
  it("serves a warming response while a source-mode worker builds and caches the report", async () => {
    await event("worker-visitor", 15);
    const service = new AnalyticsProductService(db, `file:${join(dir, "analytics.db")}`, options);
    expect(service.read()).toEqual({ state: "warming", data: null });
    await vi.waitFor(() => {
      expect(service.read().state).toBe("fresh");
    }, { timeout: 10_000, interval: 25 });
    const response = service.read();
    expect(response.data?.historySince).not.toBeNull();
    expect(service.read()).toEqual(response);
    expect(Number((await exec(db, "select count(*) as n from analytics_product_visitors")).rows[0].n)).toBe(2);
  });
  it("counts browser/day usage, period comparisons and only mature retention cohorts", async () => {
    await event("a", 8);
    await event("a", 8, "/packs", {}, "pack_open");
    await event("a", 8, "/packs", {}, "pack_open");
    await event("a", 15);
    await event("a", 17);
    await event("a", 17, "/packs", { width: 390, app_version: "v2.200" }, "pack_open");
    await event("b", 9, "/replay");
    await event("c", 16, "/replay");
    const data = await report();
    expect(data.weeklyVisitors).toBe(2);
    expect(data.previousWeeklyVisitors).toBe(2);
    expect(data.newVisitors).toBe(1);
    expect(data.returningVisitors).toBe(1);
    expect(data.features.find((f) => f.feature === "packs")).toMatchObject({ visitors: 1, previousVisitors: 1, repeatVisitors: 1, actionVisitors: 1, retentionEligible: 1, retained: 1 });
    expect(data.cohorts.find((c) => c.week === at(7, 0))).toEqual({ week: at(7, 0), newcomers: 2, returned: 1 });
    expect(data.cohorts.find((c) => c.week === at(14, 0))).toEqual({ week: at(14, 0), newcomers: 1, returned: null });
    expect(data.daily.find((d) => d.day === at(17, 0))).toMatchObject({ visitors: 1, newVisitors: 0 });
  });

  it("keeps acquisition tied to the earliest event, including late arrivals and legacy URL tags", async () => {
    await event("a", 15, "/packs", { entry_path: "/maps", entry_referrer: "$direct", utm_source: "discord", utm_medium: "community", utm_campaign: "maps-launch" }, "pack_open");
    await report();
    await event("a", 8, "/replay", { $current_url: "https://mania-tracker.com/replay?utm_source=osu&utm_medium=profile&utm_campaign=signature" });
    // A newer source must not overwrite original acquisition.
    await event("a", 16, "/skins", { entry_path: "/skins", utm_source: "twitter" });
    const data = await report();
    expect(data.acquisition).toEqual([{ source: "osu", medium: "profile", campaign: "signature", landing: "/replay", visitors: 1, actionVisitors: 1, retentionEligible: 1, retained: 1 }]);
    expect(data.returningVisitors).toBe(1);
  });

  it("does not attribute later SPA campaign tags to an untagged document entry", async () => {
    await event("a", 15, "/maps", { entry_path: "/", entry_referrer: "$direct", utm_source: null, $current_url: "https://mania-tracker.com/maps?utm_source=someone" });
    expect((await report()).acquisition[0]).toMatchObject({ source: "Direct / unknown", landing: "/" });
  });

  it("excludes bots, owner, test hosts, admin pages and server events from all product reports", async () => {
    await event("bot", 15, "/packs", {}, "$pageview", { bot: true });
    await event("owner", 15, "/packs", {}, "$pageview", { username: "Aleju03" });
    await event("dev", 15, "/packs", {}, "$pageview", { host: "localhost:3000" });
    await event("admin", 15, "/admin/live-backend");
    await event("server", 15);
    await event("a", 15);
    await event("a", 16, "/packs", {}, "route_error");
    const data = await report();
    expect(data.weeklyVisitors).toBe(1);
    expect(data.acquisition[0]).toMatchObject({ visitors: 1, actionVisitors: 0 });
    expect(data.reliability).toEqual([expect.objectContaining({ visitors: 1, affectedVisitors: 1, errors: 1 })]);
  });

  it("resumes without double counting, survives raw pruning, and respects short retention", async () => {
    await event("a", 8, "/packs", {}, "pack_open");
    const first = await report();
    expect(await report()).toEqual(first);
    await exec(db, "delete from analytics_events");
    await event("a", 16, "/packs", {}, "pack_open");
    const second = await report();
    expect(second.newVisitors).toBe(0);
    expect(second.returningVisitors).toBe(1);
    expect(Number((await exec(db, "select sum(actions) as n from analytics_product_activity")).rows[0].n)).toBe(2);
    await advanceProductAnalytics(db, { ...options, retentionDays: 7 }, NOW);
    const short = await computeProductInsights(db, { ...options, retentionDays: 7 }, NOW);
    expect(short.cohorts).toEqual([]);
    expect(short.returningVisitors).toBe(1);
    expect(Number((await exec(db, "select sum(actions) as n from analytics_product_activity")).rows[0].n)).toBe(1);
  });

  it("checkpoints across backfill batches without losing or duplicating events", async () => {
    for (let i = 0; i < 260; i++) await event("a", 16, "/packs", {}, "pack_open");
    await report();
    await report();
    expect(Number((await exec(db, "select sum(actions) as n from analytics_product_activity")).rows[0].n)).toBe(260);
    expect(Number((await exec(db, "select value from analytics_product_state where key = 'cursor'")).rows[0].value)).toBe(261);
  });

  it("separates releases/devices and calculates failure denominators and successful percentiles", async () => {
    for (const [index, ms] of [100, 200, 300, 400].entries()) {
      await event(`a${index}`, 20, "/replay", { app_version: "v2.200", duration_ms: ms, success: true }, "replay_load_result");
    }
    for (let i = 0; i < 2; i++) await event("failed", 20, "/replay", { app_version: "v2.200", duration_ms: 5000, success: false }, "replay_load_result");
    await event("mobile", 21, "/replay", { app_version: "v2.201", duration_ms: 900, success: true, width: 390 }, "replay_load_result");
    await event("invalid", 20, "/replay", { duration_ms: -1, success: true }, "replay_load_result");
    const data = await report();
    expect(data.loads).toHaveLength(2);
    expect(data.loads[0]).toMatchObject({ device: "desktop", release: "v2.200", attempts: 6, failures: 2, affectedVisitors: 1, successfulSamples: 4, p50Ms: 200, p75Ms: 300, p95Ms: 400 });
    expect(data.loads[1]).toMatchObject({ device: "mobile", release: "v2.201", attempts: 1, failures: 0, p75Ms: 900 });
    expect(data.reliability.find((r) => r.release === "v2.200")).toMatchObject({ visitors: 5, affectedVisitors: 1, errors: 2 });
  });
});
