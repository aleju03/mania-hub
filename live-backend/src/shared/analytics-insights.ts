export const ANALYTICS_DAY_MS = 86_400_000;
export const ANALYTICS_WEEK_MS = 7 * ANALYTICS_DAY_MS;

export const ANALYTICS_FEATURES: Record<string, string> = {
  home: "Home", player: "Profiles", replay: "Replays", maps: "Maps", rankings: "Rankings",
  tracker: "Tracker", "top-plays": "Top plays", snipes: "Snipes", "farm-helper": "Farm helper",
  packs: "Packs", collections: "Collections", skins: "Skins", communities: "Communities",
  goals: "Goals", "my-stats": "My stats", bbcode: "BBCode", "dan-estimates": "Dan explainer",
  other: "Other pages",
};

export interface AnalyticsRetentionRow {
  week: number;
  newcomers: number;
  returned: number | null;
}

export interface AnalyticsFeatureUsage {
  feature: string;
  visitors: number;
  previousVisitors: number;
  repeatVisitors: number;
  actionVisitors: number;
  retentionEligible: number;
  retained: number;
}

export interface AnalyticsAcquisitionRow {
  source: string;
  medium: string;
  campaign: string;
  landing: string;
  visitors: number;
  actionVisitors: number;
  retentionEligible: number;
  retained: number;
}

export interface AnalyticsReliabilityRow {
  feature: string;
  device: string;
  release: string;
  visitors: number;
  affectedVisitors: number;
  errors: number;
}

export interface AnalyticsLoadHealth {
  operation: string;
  device: string;
  release: string;
  attempts: number;
  failures: number;
  affectedVisitors: number;
  successfulSamples: number;
  p50Ms: number | null;
  p75Ms: number | null;
  p95Ms: number | null;
}

export interface AnalyticsProductInsights {
  generatedAt: number;
  historySince: number | null;
  coverageSince: number;
  weekStart: number;
  weekEnd: number;
  acquisitionStart: number;
  weeklyVisitors: number;
  previousWeeklyVisitors: number;
  newVisitors: number;
  returningVisitors: number;
  daily: Array<{ day: number; visitors: number; newVisitors: number }>;
  cohorts: AnalyticsRetentionRow[];
  features: AnalyticsFeatureUsage[];
  acquisition: AnalyticsAcquisitionRow[];
  reliability: AnalyticsReliabilityRow[];
  loads: AnalyticsLoadHealth[];
}

export interface AnalyticsProductResponse {
  state: "warming" | "fresh" | "refreshing" | "error";
  data: AnalyticsProductInsights | null;
}

export function analyticsFeature(path: string): string {
  if (path === "/") return "home";
  if (path === "/packs/collections" || path.startsWith("/packs/collections/")) return "collections";
  const part = path.split("/")[1] || "other";
  return Object.hasOwn(ANALYTICS_FEATURES, part) ? part : "other";
}

export function analyticsWeekStart(ts: number): number {
  const day = Math.floor(ts / ANALYTICS_DAY_MS) * ANALYTICS_DAY_MS;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * ANALYTICS_DAY_MS;
}
