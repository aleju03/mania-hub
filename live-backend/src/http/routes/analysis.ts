import type { IncomingMessage, ServerResponse } from "node:http";
import { lnAdjustedMsd } from "../../dan/msd.js";
import { exec, parseJson } from "../../db.js";
import { lookupAvatarAccents } from "../../features/avatar-accents.js";
import { CHART_ANALYSIS_VERSION } from "../../features/chart-analysis.js";
import { getDanEstimateBatch, getRateAdjustedChartAnalysis } from "../../features/dan-estimates.js";
import { parseDtRateVerdict } from "../../features/map-search.js";
import type { HttpContext } from "../context.js";
import { readBody } from "../request.js";
import { checkRate, sendJson } from "../respond.js";

export async function handleAnalysisRoutes(req: IncomingMessage, res: ServerResponse, ctx: HttpContext, url: URL): Promise<boolean> {
  if (url.pathname === "/api/avatar-accents") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    // Unauthenticated, and every miss buys a queue insert on the single SQLite
    // writer, so it charges the costly bucket like the sibling batch route.
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    sendJson(req, res, ctx, 200, { accents: await lookupAvatarAccents(ctx.db, ctx.queue ?? null, body.urls) });
    return true;
  }
  if (url.pathname === "/api/dan-estimates") {
    if (req.method !== "POST") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    if (!checkRate(req, res, ctx, "danEstimate")) return true;
    const body = parseJson<Record<string, unknown>>((await readBody(req)) || "{}", {});
    const items = Array.isArray(body.items) ? body.items : [];
    sendJson(req, res, ctx, 200, await getDanEstimateBatch(ctx.serveWriteDb ?? ctx.db, ctx.queue, ctx.osu, items, {
      computeMissing: body.computeMissing !== false,
    }));
    return true;
  }
  if (url.pathname === "/api/chart-analysis/rate") {
    // The same chart at the rate a play was set on (DT/NC, HT/DC): MSD and the
    // dan verdict recomputed at that speed. The 1.5x answer is already stored
    // by the DT sweep, so it costs a single indexed read; every other rate runs
    // MinaCalc plus the estimator inline, which is why it charges the costly
    // buckets the dan-estimate batch does.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const beatmapId = Number(url.searchParams.get("beatmapId"));
    const rate = Number(url.searchParams.get("rate"));
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap_id" });
      return true;
    }
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) {
      sendJson(req, res, ctx, 400, { error: "invalid_rate" });
      return true;
    }
    const ratePercent = Math.round(rate * 100);
    if (ratePercent === 150) {
      const row = (await exec(
        ctx.db,
        `select msd_dt_json, dan_dt_json from beatmap_chart_analysis
         where beatmap_id = ? and analysis_version = ? limit 1`,
        [beatmapId, CHART_ANALYSIS_VERSION],
      )).rows[0];
      const { danDt, msdDt } = parseDtRateVerdict(row);
      if (msdDt || danDt) {
        sendJson(req, res, ctx, 200, {
          beatmapId,
          rate: 1.5,
          ratePercent,
          status: "ready",
          dan: danDt,
          msd: msdDt,
        });
        return true;
      }
    }
    if (!checkRate(req, res, ctx, "publicCostly")) return true;
    if (!checkRate(req, res, ctx, "danEstimate")) return true;
    const analysis = await getRateAdjustedChartAnalysis(ctx.serveWriteDb ?? ctx.db, ctx.osu, beatmapId, rate);
    if (!analysis) {
      sendJson(req, res, ctx, 400, { error: "invalid_rate" });
      return true;
    }
    sendJson(req, res, ctx, 200, analysis);
    return true;
  }
  if (url.pathname === "/api/chart-analysis") {
    // The stored lean classification for one beatmap: detected pattern hits in
    // the in-house vocabulary plus the LeoBlack cluster readout. Feeds the map
    // detail modal's keymode-honest pattern strip (MSD skillset names are 4K
    // vocabulary). Single-PK read; the global publicApi limiter covers it.
    if (req.method !== "GET") {
      sendJson(req, res, ctx, 405, { error: "method_not_allowed" });
      return true;
    }
    const beatmapId = Number(url.searchParams.get("beatmapId"));
    if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
      sendJson(req, res, ctx, 400, { error: "invalid_beatmap_id" });
      return true;
    }
    const row = (await exec(
      ctx.db,
      `select status, key_count, classification_json, msd_json, msd_ln_json from beatmap_chart_analysis
       where beatmap_id = ? and analysis_version = ? limit 1`,
      [beatmapId, CHART_ANALYSIS_VERSION],
    )).rows[0];
    const classification = row?.status === "ready"
      ? parseJson<Record<string, unknown> | null>(String(row.classification_json ?? ""), null)
      : null;
    const readMsdValues = (raw: unknown): Record<string, number> | null => {
      if (raw == null) return null;
      const parsed = parseJson<{ values?: Record<string, number> } | null>(String(raw), null);
      return parsed && parsed.values && typeof parsed.values === "object" ? parsed.values : null;
    };
    const msdLn = row?.status === "ready"
      ? lnAdjustedMsd(readMsdValues(row.msd_json), readMsdValues(row.msd_ln_json), Number(row.key_count ?? 0))
      : null;
    sendJson(req, res, ctx, 200, {
      beatmapId,
      status: row ? String(row.status) : "missing",
      keyCount: row?.key_count == null ? null : Number(row.key_count),
      patterns: Array.isArray(classification?.patterns) ? classification.patterns : [],
      clusters: Array.isArray(classification?.clusters) ? classification.clusters : [],
      clusterCategory: typeof classification?.clusterCategory === "string" ? classification.clusterCategory : null,
      modeTag: typeof classification?.modeTag === "string" ? classification.modeTag : null,
      verdictText: typeof classification?.verdictText === "string" ? classification.verdictText : null,
      lnRatio: Number.isFinite(Number(classification?.lnRatio)) ? Number(classification?.lnRatio) : null,
      // LN-adjusted (tail-aware, keymode-blended) MSD; null for rice charts or
      // until the LN MSD sweep covers this chart.
      msdLn,
    });
    return true;
  }
  return false;
}
