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
  trustProxyHeaders: boolean;
  countryWarmTtlMs: number;
  publicApiRatePerMinute: number;
  publicCostlyRatePerMinute: number;
  countryActivateRatePerMinute: number;
  countryActivateGlobalRatePerMinute: number;
  countryActivateNewPerHour: number;
  danEstimateRatePerMinute: number;
  sseConnectRatePerMinute: number;
  sseMaxConnectionsPerIp: number;
  sseMaxConnectionsTotal: number;
  replayVideoRatePerMinute: number;
  osuApiTargetPerMinute: number;
  osuApiHardPerMinute: number;
  oscJsonTargetPerMinute: number;
  topPlayMarginPp: number;
  rosterRefreshIntervalMs: number;
  rosterRankingPages: number;
  rosterSize: number;
  mapsRefreshIntervalMs: number;
  oscBackfillMaxAgeMs: number;
  oscBackfillPageLimit: number;
  oscBackfillMaxPages: number;
  retentionIntervalMs: number;
  scoreEventRetentionDays: number;
  liveEventRetentionDays: number;
  doneJobRetentionDays: number;
  apiCallLogRetentionDays: number;
  replayVideoJobRetentionDays: number;
  maxLocalDbBytes: number;
  targetLocalDbBytes: number;
  replayVideoPublicEnabled: boolean;
  replayVideoUploadMaxBytes: number;
  replayVideoOptimize: boolean;
  replayVideoOptimizeCrf: number;
  replayVideoOptimizePreset: string;
  replayVideoAudioBitrate: string;
  replayVideoRenderBaseUrl: string;
  replayVideoChromePath?: string;
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

function readBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, readInt(name, fallback)));
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
    trustProxyHeaders: readBool("TRUST_PROXY_HEADERS", false),
    countryWarmTtlMs: readInt("COUNTRY_WARM_TTL_MS", 24 * 60 * 60 * 1000),
    publicApiRatePerMinute: readInt("PUBLIC_API_RATE_PER_MINUTE", 120),
    publicCostlyRatePerMinute: readInt("PUBLIC_COSTLY_RATE_PER_MINUTE", 30),
    countryActivateRatePerMinute: readInt("COUNTRY_ACTIVATE_RATE_PER_MINUTE", 10),
    countryActivateGlobalRatePerMinute: readInt("COUNTRY_ACTIVATE_GLOBAL_RATE_PER_MINUTE", 120),
    countryActivateNewPerHour: readInt("COUNTRY_ACTIVATE_NEW_PER_HOUR", 12),
    danEstimateRatePerMinute: readInt("DAN_ESTIMATE_RATE_PER_MINUTE", 20),
    sseConnectRatePerMinute: readInt("SSE_CONNECT_RATE_PER_MINUTE", 30),
    sseMaxConnectionsPerIp: readInt("SSE_MAX_CONNECTIONS_PER_IP", 6),
    sseMaxConnectionsTotal: readInt("SSE_MAX_CONNECTIONS_TOTAL", 500),
    replayVideoRatePerMinute: readInt("REPLAY_VIDEO_RATE_PER_MINUTE", 2),
    osuApiTargetPerMinute: readInt("OSU_API_TARGET_PER_MINUTE", 45),
    osuApiHardPerMinute: readInt("OSU_API_HARD_PER_MINUTE", 60),
    oscJsonTargetPerMinute: readInt("OSC_JSON_TARGET_PER_MINUTE", 30),
    topPlayMarginPp: readInt("TOP_PLAY_MARGIN_PP", 5),
    rosterRefreshIntervalMs: readInt("ROSTER_REFRESH_INTERVAL_MS", 6 * 60 * 60 * 1000),
    rosterRankingPages: readInt("ROSTER_RANKING_PAGES", 2),
    rosterSize: readInt("ROSTER_SIZE", 100),
    mapsRefreshIntervalMs: readInt("MAPS_REFRESH_INTERVAL_MS", 7 * 24 * 60 * 60 * 1000),
    oscBackfillMaxAgeMs: readInt("OSC_BACKFILL_MAX_AGE_MS", 24 * 60 * 60 * 1000),
    oscBackfillPageLimit: Math.min(readInt("OSC_BACKFILL_PAGE_LIMIT", 1000), 1000),
    oscBackfillMaxPages: readInt("OSC_BACKFILL_MAX_PAGES", 30),
    retentionIntervalMs: readInt("RETENTION_INTERVAL_MS", 60 * 60 * 1000),
    scoreEventRetentionDays: readInt("SCORE_EVENT_RETENTION_DAYS", 14),
    liveEventRetentionDays: readInt("LIVE_EVENT_RETENTION_DAYS", 7),
    doneJobRetentionDays: readInt("DONE_JOB_RETENTION_DAYS", 2),
    apiCallLogRetentionDays: readInt("API_CALL_LOG_RETENTION_DAYS", 7),
    replayVideoJobRetentionDays: readInt("REPLAY_VIDEO_JOB_RETENTION_DAYS", 2),
    maxLocalDbBytes: readInt("MAX_LOCAL_DB_BYTES", 10 * 1024 * 1024 * 1024),
    targetLocalDbBytes: readInt("TARGET_LOCAL_DB_BYTES", 8 * 1024 * 1024 * 1024),
    replayVideoPublicEnabled: readBool("REPLAY_VIDEO_PUBLIC_ENABLED", false),
    replayVideoUploadMaxBytes: readInt("REPLAY_VIDEO_UPLOAD_MAX_BYTES", 600 * 1024 * 1024),
    replayVideoOptimize: readBool("REPLAY_VIDEO_OPTIMIZE", true),
    replayVideoOptimizeCrf: readBoundedInt("REPLAY_VIDEO_OPTIMIZE_CRF", 20, 16, 28),
    replayVideoOptimizePreset: process.env.REPLAY_VIDEO_OPTIMIZE_PRESET || "slow",
    replayVideoAudioBitrate: process.env.REPLAY_VIDEO_AUDIO_BITRATE || "160k",
    replayVideoRenderBaseUrl: process.env.REPLAY_VIDEO_RENDER_BASE_URL || process.env.FRONTEND_ORIGIN || "http://localhost:3000",
    replayVideoChromePath: process.env.REPLAY_VIDEO_CHROME_PATH || process.env.CHROME_PATH || undefined,
    replayVideoPublicOrigin: process.env.REPLAY_VIDEO_PUBLIC_ORIGIN ?? process.env.LIVE_PUBLIC_ORIGIN ?? "http://localhost:7227",
    replayVideoWorkDir: process.env.REPLAY_VIDEO_WORK_DIR ?? "./data/replay-video-jobs",
    r2Endpoint: process.env.R2_ENDPOINT || undefined,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || undefined,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || undefined,
    r2Bucket: process.env.R2_BUCKET || undefined,
    r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_URL || process.env.CLOUDFLARE_R2_PUBLIC_URL || undefined,
  };
}
