export type BackendRole = "all" | "server" | "worker";

export interface Config {
  port: number;
  nodeEnv: string;
  // Process role. "all" (default) runs HTTP serving + ingest + workers in one
  // process (legacy single-process mode). "server" serves HTTP/SSE only and
  // tails live_event_log for live updates; "worker" runs ingest/jobs/schedulers
  // and writes to the shared DB but serves no public traffic. Splitting the two
  // keeps a heavy background query from blocking the request-serving event loop.
  role: BackendRole;
  // When the serving process does not run ingest itself, it learns about new
  // live events by polling live_event_log. Defaults on for role "server".
  enableEventLogTail: boolean;
  eventLogTailIntervalMs: number;
  // Optional internal HTTP port for the worker process (health/status only).
  // Null means the worker process does not listen at all.
  workerHttpPort: number | null;
  // SQLite/libsql pragmas applied per connection at boot.
  sqliteBusyTimeoutMs: number;
  sqliteSynchronous: string;
  sqliteCacheMb: number;
  sqliteMmapMb: number;
  databaseUrl: string;
  databaseAuthToken?: string;
  osuClientId?: string;
  osuClientSecret?: string;
  oscBaseUrl: string;
  oscSocketPath: string;
  trackedCountries: string[];
  prewarmCountries: string[];
  mapsWarmCountries: string[];
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
  oscGlobalBackfillPageLimit: number;
  oscSocketStaleMs: number;
  oscSocketWatchdogIntervalMs: number;
  topPlayMarginPp: number;
  rosterRefreshIntervalMs: number;
  rosterRankingPages: number;
  rosterSize: number;
  manualRosterMaxPerCountry: number;
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
  rankSnapshotRetentionDays: number;
  activityRetentionYears: number;
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
  enableWorkers: boolean;
  enableOsuApiJobs: boolean;
  enableStartupRosterRefresh: boolean;
  enableScheduledRefreshes: boolean;
  enableOscBackfill: boolean;
  enableOscSocket: boolean;
  enableOsuScoresFallback: boolean;
  osuScoresFallbackIntervalMs: number;
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

function readOptionalInt(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function readRole(): BackendRole {
  const raw = (process.env.LIVE_BACKEND_ROLE ?? process.env.BACKEND_ROLE ?? "all").trim().toLowerCase();
  return raw === "server" || raw === "worker" ? raw : "all";
}

function csv(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const TOP_50_MANIA_COUNTRIES = [
  "KR", "CN", "US", "JP", "PH", "ID", "VN", "TH", "RU", "CA",
  "BR", "CL", "GB", "MY", "MX", "AR", "TW", "PE", "HK", "AU",
  "PL", "FR", "ES", "DE", "SG", "CO", "IT", "VE", "SE", "NL",
  "FI", "EC", "UA", "TR", "NZ", "RO", "NO", "PT", "CZ", "DK",
  "CR", "BE", "SA", "KZ", "HU", "IL", "GR", "IE", "BO", "UY",
];

function uniqueCountries(countries: string[]): string[] {
  return [...new Set(
    countries
      .map((country) => country.trim().toUpperCase())
      .filter((country) => /^[A-Z]{2}$/.test(country)),
  )];
}

function countryCsv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw == null) return uniqueCountries(fallback);
  return uniqueCountries(raw.split(","));
}

export function readConfig(): Config {
  const trackedCountries = countryCsv("TRACKED_COUNTRIES", ["CR"]);
  const prewarmCountries = countryCsv("PREWARM_COUNTRIES", TOP_50_MANIA_COUNTRIES);
  const mapsWarmCountries = countryCsv("MAPS_WARM_COUNTRIES", [
    ...TOP_50_MANIA_COUNTRIES.slice(0, 20),
    ...trackedCountries,
  ]);

  const role = readRole();
  return {
    port: readInt("PORT", 7227),
    nodeEnv: process.env.NODE_ENV ?? "development",
    role,
    enableEventLogTail: readBool("ENABLE_EVENT_LOG_TAIL", role === "server"),
    eventLogTailIntervalMs: readBoundedInt("EVENT_LOG_TAIL_INTERVAL_MS", 250, 50, 5_000),
    workerHttpPort: readOptionalInt("WORKER_HTTP_PORT"),
    sqliteBusyTimeoutMs: readBoundedInt("SQLITE_BUSY_TIMEOUT_MS", 5_000, 0, 60_000),
    sqliteSynchronous: (process.env.SQLITE_SYNCHRONOUS || "NORMAL").toUpperCase(),
    sqliteCacheMb: readBoundedInt("SQLITE_CACHE_MB", 64, 0, 2_048),
    sqliteMmapMb: readBoundedInt("SQLITE_MMAP_MB", 256, 0, 8_192),
    databaseUrl: process.env.DATABASE_URL ?? "file:./data/mania-hub-live.db",
    databaseAuthToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    osuClientId: process.env.OSU_CLIENT_ID || undefined,
    osuClientSecret: process.env.OSU_CLIENT_SECRET || undefined,
    oscBaseUrl: process.env.OSC_BASE_URL ?? "https://osc.kaysting.dev",
    oscSocketPath: process.env.OSC_SOCKET_PATH ?? "/ws",
    trackedCountries,
    prewarmCountries,
    mapsWarmCountries,
    livePublicOrigin: process.env.LIVE_PUBLIC_ORIGIN ?? "http://localhost:7227",
    allowedOrigins: csv(process.env.ALLOWED_ORIGINS, "http://localhost:3000"),
    liveAdminToken: process.env.LIVE_ADMIN_TOKEN || undefined,
    trustProxyHeaders: readBool("TRUST_PROXY_HEADERS", false),
    countryWarmTtlMs: readInt("COUNTRY_WARM_TTL_MS", 72 * 60 * 60 * 1000),
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
    oscGlobalBackfillPageLimit: Math.min(readInt("OSC_GLOBAL_BACKFILL_PAGE_LIMIT", 100), 1000),
    oscSocketStaleMs: readInt("OSC_SOCKET_STALE_MS", 30 * 1000),
    oscSocketWatchdogIntervalMs: readInt("OSC_SOCKET_WATCHDOG_INTERVAL_MS", 10 * 1000),
    topPlayMarginPp: readInt("TOP_PLAY_MARGIN_PP", 5),
    rosterRefreshIntervalMs: readInt("ROSTER_REFRESH_INTERVAL_MS", 6 * 60 * 60 * 1000),
    rosterRankingPages: readInt("ROSTER_RANKING_PAGES", 2),
    rosterSize: readInt("ROSTER_SIZE", 100),
    manualRosterMaxPerCountry: readInt("MANUAL_ROSTER_MAX_PER_COUNTRY", 50),
    mapsRefreshIntervalMs: readInt("MAPS_REFRESH_INTERVAL_MS", 7 * 24 * 60 * 60 * 1000),
    oscBackfillMaxAgeMs: readInt("OSC_BACKFILL_MAX_AGE_MS", 24 * 60 * 60 * 1000),
    oscBackfillPageLimit: Math.min(readInt("OSC_BACKFILL_PAGE_LIMIT", 1000), 1000),
    oscBackfillMaxPages: readInt("OSC_BACKFILL_MAX_PAGES", 200),
    retentionIntervalMs: readInt("RETENTION_INTERVAL_MS", 60 * 60 * 1000),
    scoreEventRetentionDays: readInt("SCORE_EVENT_RETENTION_DAYS", 14),
    liveEventRetentionDays: readInt("LIVE_EVENT_RETENTION_DAYS", 7),
    doneJobRetentionDays: readInt("DONE_JOB_RETENTION_DAYS", 2),
    apiCallLogRetentionDays: readInt("API_CALL_LOG_RETENTION_DAYS", 7),
    replayVideoJobRetentionDays: readInt("REPLAY_VIDEO_JOB_RETENTION_DAYS", 2),
    rankSnapshotRetentionDays: readInt("RANK_SNAPSHOT_RETENTION_DAYS", 14),
    activityRetentionYears: readBoundedInt("ACTIVITY_RETENTION_YEARS", 2, 1, 10),
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
    enableWorkers: readBool("ENABLE_WORKERS", true),
    enableOsuApiJobs: readBool("ENABLE_OSU_API_JOBS", true),
    enableStartupRosterRefresh: readBool("ENABLE_STARTUP_ROSTER_REFRESH", true),
    enableScheduledRefreshes: readBool("ENABLE_SCHEDULED_REFRESHES", true),
    enableOscBackfill: readBool("ENABLE_OSC_BACKFILL", false),
    enableOscSocket: readBool("ENABLE_OSC_SOCKET", true),
    enableOsuScoresFallback: readBool("ENABLE_OSU_SCORES_FALLBACK", readBool("ENABLE_OSU_RECENT_FALLBACK", true)),
    osuScoresFallbackIntervalMs: readInt("OSU_SCORES_FALLBACK_INTERVAL_MS", readInt("OSU_RECENT_FALLBACK_INTERVAL_MS", 10_000)),
  };
}
