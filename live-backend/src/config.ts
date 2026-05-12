export interface Config {
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  databaseAuthToken?: string;
  osuClientId?: string;
  osuClientSecret?: string;
  oscBaseUrl: string;
  oscSocketPath: string;
  trackedCountries: string[];
  livePublicOrigin: string;
  allowedOrigins: string[];
  liveAdminToken?: string;
  osuApiTargetPerMinute: number;
  osuApiHardPerMinute: number;
  oscJsonTargetPerMinute: number;
  topPlayMarginPp: number;
  rosterRefreshIntervalMs: number;
  rosterRankingPages: number;
  rosterSize: number;
  oscBackfillMaxAgeMs: number;
  retentionIntervalMs: number;
  scoreEventRetentionDays: number;
  liveEventRetentionDays: number;
  doneJobRetentionDays: number;
  apiCallLogRetentionDays: number;
  replayVideoJobRetentionDays: number;
  replayVideoPublicOrigin: string;
  replayVideoWorkDir: string;
  r2Endpoint?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2Bucket?: string;
  r2PublicBaseUrl?: string;
}

function readInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function csv(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function readConfig(): Config {
  return {
    port: readInt("PORT", 7227),
    nodeEnv: process.env.NODE_ENV ?? "development",
    databaseUrl: process.env.DATABASE_URL ?? "file:./data/mania-hub-live.db",
    databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    osuClientId: process.env.OSU_CLIENT_ID || undefined,
    osuClientSecret: process.env.OSU_CLIENT_SECRET || undefined,
    oscBaseUrl: process.env.OSC_BASE_URL ?? "https://osc.kaysting.dev",
    oscSocketPath: process.env.OSC_SOCKET_PATH ?? "/ws",
    trackedCountries: csv(process.env.TRACKED_COUNTRIES, "CR").map((country) => country.toUpperCase()),
    livePublicOrigin: process.env.LIVE_PUBLIC_ORIGIN ?? "http://localhost:7227",
    allowedOrigins: csv(process.env.ALLOWED_ORIGINS, "http://localhost:3000"),
    liveAdminToken: process.env.LIVE_ADMIN_TOKEN || undefined,
    osuApiTargetPerMinute: readInt("OSU_API_TARGET_PER_MINUTE", 45),
    osuApiHardPerMinute: readInt("OSU_API_HARD_PER_MINUTE", 60),
    oscJsonTargetPerMinute: readInt("OSC_JSON_TARGET_PER_MINUTE", 30),
    topPlayMarginPp: readInt("TOP_PLAY_MARGIN_PP", 5),
    rosterRefreshIntervalMs: readInt("ROSTER_REFRESH_INTERVAL_MS", 6 * 60 * 60 * 1000),
    rosterRankingPages: readInt("ROSTER_RANKING_PAGES", 2),
    rosterSize: readInt("ROSTER_SIZE", 100),
    oscBackfillMaxAgeMs: readInt("OSC_BACKFILL_MAX_AGE_MS", 2 * 60 * 60 * 1000),
    retentionIntervalMs: readInt("RETENTION_INTERVAL_MS", 60 * 60 * 1000),
    scoreEventRetentionDays: readInt("SCORE_EVENT_RETENTION_DAYS", 14),
    liveEventRetentionDays: readInt("LIVE_EVENT_RETENTION_DAYS", 7),
    doneJobRetentionDays: readInt("DONE_JOB_RETENTION_DAYS", 2),
    apiCallLogRetentionDays: readInt("API_CALL_LOG_RETENTION_DAYS", 7),
    replayVideoJobRetentionDays: readInt("REPLAY_VIDEO_JOB_RETENTION_DAYS", 2),
    replayVideoPublicOrigin: process.env.REPLAY_VIDEO_PUBLIC_ORIGIN ?? process.env.LIVE_PUBLIC_ORIGIN ?? "http://localhost:7227",
    replayVideoWorkDir: process.env.REPLAY_VIDEO_WORK_DIR ?? "./data/replay-video-jobs",
    r2Endpoint: process.env.R2_ENDPOINT || undefined,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || undefined,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || undefined,
    r2Bucket: process.env.R2_BUCKET || undefined,
    r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_URL || process.env.CLOUDFLARE_R2_PUBLIC_URL || undefined,
  };
}
