import type { Config } from "../config.js";
import type { OscScore } from "../shared/types.js";

const BEATMAP_FILE_FETCH_TIMEOUT_MS = 15_000;
const USER_RECENT_SCORES_LIMIT = 100;
const BEATMAP_FILE_FETCH_HEADERS = {
  "user-agent": "mania-hub/1.0 (+https://mania-tracker.com)",
  accept: "text/plain,*/*;q=0.8",
} as const;

export type LimiterLane = "interactive" | "job" | "bulk" | "default";

// A 429 pause freezes background lanes for its full duration, but interactive
// calls (a person waiting on a replay or profile) resume after this cap.
export const INTERACTIVE_PAUSE_CAP_MS = 10_000;

export type LimiterCallLog = {
  caller: string;
  path: string;
  startedAt: number;
  durationMs: number;
  // 200 for any successful response; the osu! error status when known; null
  // for network-level failures.
  status: number | null;
};

export interface SharedLimiter {
  reserve(caller: string, path: string, lane: LimiterLane): Promise<number>;
  pause?(ms: number): void | Promise<void>;
}

type PendingLimiterCall<T = unknown> = {
  caller: string;
  path: string;
  fn: () => Promise<T>;
  lane: LimiterLane;
  priority: number;
  seq: number;
  queuedAt: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type LimiterOptions = {
  interactiveBurstCapacity?: number;
  maxPendingCalls?: number;
  sharedLimiter?: SharedLimiter;
};

export interface OsuScoresResponse {
  scores?: OscScore[];
  cursor_string?: string | null;
}

const DEFAULT_MAX_PENDING_CALLS = 500;

/* How long the interactive burst bucket takes to refill from empty.
 *
 * This used to refill at targetPerMinute, which is not a burst at all: the
 * interactive lane got the paced target rate AND a token stream arriving at
 * that same rate, so sustained interactive demand ran at ~2x target until the
 * hard ceiling stopped it. On 2026-08-06 a pack burst over two freshly
 * activated countries held 120/120 for six minutes that way against a target
 * of 55. Refilling the whole bucket over a minute keeps the spike absorption
 * a page load needs (a handful of instant calls) while capping the sustained
 * overage at interactiveBurstCapacity per minute. */
const INTERACTIVE_BURST_REFILL_MS = 60_000;

/* Interactive requests normally win because a person is waiting, but strict
   priority made a sustained public-request stream capable of leaving every job
   behind it forever. Once background work has waited this long, the oldest
   background call receives the next local slot. The shared SQLite limiter has
   a separate per-minute reservation below, so this also works when server and
   worker run in different processes. */
export const BACKGROUND_LANE_MAX_WAIT_MS = 5_000;

/* Filling a card that nobody is waiting on is background work, not a page
   load. Under the old "api:profile_snapshot" caller it classified as
   interactive, which is how pack warms came to share the burst allowance with
   real page loads and helped hold the budget at its hard ceiling. */
export const PACK_WARM_CALLER = "job:warm_pack_player";

export class TokenBucketLimiter {
  private starts: number[] = [];
  private recent: Array<{ startedAt: number; caller: string; path: string }> = [];
  private pending: PendingLimiterCall[] = [];
  private pausedUntil = 0;
  private pausedAt = 0;
  private nextStartAt = 0;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly interactiveBurstCapacity: number;
  private readonly maxPendingCalls: number;
  private readonly sharedLimiter?: SharedLimiter;
  private interactiveBurstTokens: number;
  private interactiveBurstUpdatedAt = Date.now();

  constructor(
    private readonly hardPerMinute: number,
    private readonly targetPerMinute = hardPerMinute,
    private readonly onCall?: (entry: LimiterCallLog) => void,
    options: LimiterOptions = {},
  ) {
    this.interactiveBurstCapacity = Math.max(0, Math.floor(options.interactiveBurstCapacity ?? 0));
    this.maxPendingCalls = Math.max(1, Math.floor(options.maxPendingCalls ?? DEFAULT_MAX_PENDING_CALLS));
    this.sharedLimiter = options.sharedLimiter;
    this.interactiveBurstTokens = this.interactiveBurstCapacity;
  }

  async schedule<T>(caller: string, path: string, fn: () => Promise<T>): Promise<T> {
    const lane = classifyLimiterLane(caller, path);
    if (this.pending.length >= this.maxPendingCalls) {
      throw new Error(`osu! API limiter queue is full (${this.pending.length}/${this.maxPendingCalls})`);
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        caller,
        path,
        fn,
        lane,
        priority: lanePriority(lane),
        seq: this.sequence++,
        queuedAt: Date.now(),
        resolve,
        reject,
      } as PendingLimiterCall);
      this.pump(true);
    });
  }

  private pump(reschedule = false): void {
    if (this.timer) {
      if (!reschedule) return;
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextIndex = this.bestPendingIndex();
    if (nextIndex < 0) return;

    const next = this.pending[nextIndex];
    const waitMs = this.nextWaitMs(next);
    if (waitMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, waitMs);
      this.timer.unref?.();
      return;
    }

    this.pending.splice(nextIndex, 1);

    const startedAt = Date.now();
    const usedInteractiveBurst = startedAt < this.nextStartAt && next.lane === "interactive";
    if (usedInteractiveBurst) this.consumeInteractiveBurstToken(startedAt);
    this.starts.push(startedAt);
    this.nextStartAt = startedAt + Math.ceil(60_000 / Math.max(1, this.targetPerMinute));
    this.run(next).then(next.resolve, next.reject).finally(() => this.pump());
    this.pump();
  }

  private async run<T>(next: PendingLimiterCall<T>): Promise<T> {
    const startedAt = this.sharedLimiter
      ? await this.sharedLimiter.reserve(next.caller, next.path, next.lane)
      : Date.now();
    this.recent.push({ startedAt, caller: next.caller, path: next.path });
    this.recent = this.recent.filter((entry) => startedAt - entry.startedAt < 60_000);
    try {
      const result = await (next.fn() as Promise<T>);
      this.onCall?.({ caller: next.caller, path: next.path, startedAt, durationMs: Date.now() - startedAt, status: 200 });
      return result;
    } catch (error) {
      this.onCall?.({
        caller: next.caller,
        path: next.path,
        startedAt,
        durationMs: Date.now() - startedAt,
        status: error instanceof OsuApiError ? error.status : null,
      });
      throw error;
    }
  }

  private nextWaitMs(next: PendingLimiterCall): number {
    if (this.pending.length === 0) return 0;
    const now = Date.now();
    const pausedUntil = next.lane === "interactive"
      ? Math.min(this.pausedUntil, this.pausedAt + INTERACTIVE_PAUSE_CAP_MS)
      : this.pausedUntil;
    if (now < pausedUntil) {
      return pausedUntil - now;
    }
    this.starts = this.starts.filter((startedAt) => now - startedAt < 60_000);
    if (this.starts.length >= this.hardPerMinute) {
      return 60_000 - (now - this.starts[0]) + 1;
    }
    if (now < this.nextStartAt) {
      if (this.canUseInteractiveBurst(next, now)) return 0;
      return this.nextStartAt - now;
    }
    return 0;
  }

  private bestPendingIndex(): number {
    if (this.pending.length === 0) return -1;
    const now = Date.now();
    let oldestStarvedBackground = -1;
    // A 429 pause deliberately lets interactive work resume early. Do not let
    // an aged background call that is still paused become the selected call
    // and park the whole local scheduler until the longer pause expires.
    if (now >= this.pausedUntil) {
      for (let i = 0; i < this.pending.length; i++) {
        const current = this.pending[i];
        if ((current.lane !== "job" && current.lane !== "bulk")
          || now - current.queuedAt < BACKGROUND_LANE_MAX_WAIT_MS) continue;
        if (oldestStarvedBackground < 0
          || current.seq < this.pending[oldestStarvedBackground].seq) {
          oldestStarvedBackground = i;
        }
      }
    }
    if (oldestStarvedBackground >= 0) return oldestStarvedBackground;

    let bestIndex = 0;
    for (let i = 1; i < this.pending.length; i++) {
      const current = this.pending[i];
      const best = this.pending[bestIndex];
      if (current.priority > best.priority || (current.priority === best.priority && current.seq < best.seq)) {
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private canUseInteractiveBurst(next: PendingLimiterCall, now: number): boolean {
    if (next.lane !== "interactive" || this.interactiveBurstCapacity <= 0) return false;
    this.refillInteractiveBurst(now);
    return this.interactiveBurstTokens >= 1;
  }

  private consumeInteractiveBurstToken(now: number): void {
    if (this.interactiveBurstCapacity <= 0) return;
    this.refillInteractiveBurst(now);
    this.interactiveBurstTokens = Math.max(0, this.interactiveBurstTokens - 1);
  }

  private refillInteractiveBurst(now: number): void {
    if (this.interactiveBurstCapacity <= 0) return;
    const elapsedMs = Math.max(0, now - this.interactiveBurstUpdatedAt);
    if (elapsedMs > 0) {
      const refill = elapsedMs * (this.interactiveBurstCapacity / INTERACTIVE_BURST_REFILL_MS);
      this.interactiveBurstTokens = Math.min(this.interactiveBurstCapacity, this.interactiveBurstTokens + refill);
      this.interactiveBurstUpdatedAt = now;
    }
  }

  pause(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const now = Date.now();
    if (now + ms > this.pausedUntil) {
      this.pausedUntil = now + ms;
      this.pausedAt = now;
    }
    void this.sharedLimiter?.pause?.(ms);
  }

  state() {
    const now = Date.now();
    this.refillInteractiveBurst(now);
    this.starts = this.starts.filter((startedAt) => now - startedAt < 60_000);
    this.recent = this.recent.filter((entry) => now - entry.startedAt < 60_000);
    const byCaller = new Map<string, number>();
    const byPath = new Map<string, number>();
    const pendingByLane = new Map<LimiterLane, number>();
    for (const entry of this.recent) {
      byCaller.set(entry.caller, (byCaller.get(entry.caller) ?? 0) + 1);
      byPath.set(entry.path, (byPath.get(entry.path) ?? 0) + 1);
    }
    for (const entry of this.pending) {
      pendingByLane.set(entry.lane, (pendingByLane.get(entry.lane) ?? 0) + 1);
    }
    return {
      hardPerMinute: this.hardPerMinute,
      targetPerMinute: this.targetPerMinute,
      maxPending: this.maxPendingCalls,
      usedLastMinute: this.starts.length,
      interactiveBurstCapacity: this.interactiveBurstCapacity,
      interactiveBurstTokens: Math.floor(this.interactiveBurstTokens),
      pausedMs: Math.max(0, this.pausedUntil - now),
      pending: this.pending.length,
      pendingByLane: [...pendingByLane.entries()]
        .map(([lane, count]) => ({ lane, count }))
        .sort((a, b) => lanePriority(b.lane) - lanePriority(a.lane)),
      byCaller: [...byCaller.entries()]
        .map(([caller, count]) => ({ caller, count }))
        .sort((a, b) => b.count - a.count),
      byPath: [...byPath.entries()]
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    };
  }
}

function classifyLimiterLane(caller: string, path: string): LimiterLane {
  if (caller.startsWith("job:seed_snipe_board") || caller.startsWith("job:refresh_country_maps") || caller.startsWith("job:refresh_user_maps_farmed_scores") || caller.startsWith("job:refresh_country_roster") || caller.startsWith(PACK_WARM_CALLER)) {
    return "bulk";
  }
  if (caller.startsWith("job:")) return "job";
  if (caller === "osc_json_backfill") return "bulk";
  if (path.startsWith("/scores/") && path.endsWith("/download")) return "interactive";
  if (
    caller.startsWith("api:")
    || caller.startsWith("admin:")
    || caller.startsWith("get")
    || caller.startsWith("search")
    || caller.startsWith("fetchUserBestScoresWindow")
    || caller.startsWith("trackerBeatmapMetadata")
    || caller.startsWith("fetchUserRecentPlays")
  ) {
    return "interactive";
  }
  return "default";
}

function lanePriority(lane: LimiterLane): number {
  switch (lane) {
    case "interactive": return 40;
    case "default": return 30;
    case "job": return 20;
    case "bulk": return 10;
  }
}

export class OsuApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`osu! API ${status} for ${path}`);
    this.name = "OsuApiError";
  }
}

export class OsuApiClient {
  private token: { accessToken: string; expiresAt: number } | null = null;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  readonly limiter: TokenBucketLimiter;

  constructor(
    private readonly config: Pick<Config, "osuClientId" | "osuClientSecret" | "osuApiTargetPerMinute" | "osuApiHardPerMinute">,
    private readonly fetchImpl: typeof fetch = fetch,
    onCall?: (entry: LimiterCallLog) => void,
    options: { sharedLimiter?: SharedLimiter } = {},
  ) {
    this.limiter = new TokenBucketLimiter(config.osuApiHardPerMinute, config.osuApiTargetPerMinute, onCall, {
      // 8 covers ~97% of observed interactive fan-outs (a cold profile page is
      // 6-8 calls); sustained overage stays at target + 8 per minute.
      interactiveBurstCapacity: 8,
      sharedLimiter: options.sharedLimiter,
    });
  }

  hasCredentials(): boolean {
    return !!this.config.osuClientId && !!this.config.osuClientSecret;
  }

  async getUser(userId: number, caller = "unknown"): Promise<Record<string, unknown>> {
    return this.getJson(`/users/${userId}/mania`, caller);
  }

  async getUserByKey(key: string, caller = "unknown", lookup?: "id" | "username"): Promise<Record<string, unknown>> {
    const userParam = lookup === "username" ? `@${key}` : key;
    return this.getJson(`/users/${encodeURIComponent(userParam)}/mania`, caller);
  }

  async getBeatmap(beatmapId: number, caller = "unknown"): Promise<Record<string, unknown>> {
    return this.getJson(`/beatmaps/${beatmapId}`, caller);
  }

  async getBeatmapset(beatmapsetId: number, caller = "unknown"): Promise<Record<string, unknown>> {
    return this.getJson(`/beatmapsets/${beatmapsetId}`, caller);
  }

  async searchBeatmapsets(params: Record<string, string | number | undefined>, caller = "unknown"): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const suffix = query.toString();
    return this.getJson(`/beatmapsets/search${suffix ? `?${suffix}` : ""}`, caller);
  }

  async getBeatmapFile(beatmapId: number, caller = "unknown"): Promise<string> {
    const safeBeatmapId = Math.floor(beatmapId);
    if (!Number.isFinite(safeBeatmapId) || safeBeatmapId <= 0) throw new Error("Invalid beatmap ID");
    return this.coalesce(`beatmap-file:${safeBeatmapId}`, async () => this.getBeatmapFileUncached(safeBeatmapId, caller));
  }

  private async getBeatmapFileUncached(safeBeatmapId: number, caller: string): Promise<string> {
    const errors: string[] = [];
    const sources = [
      { name: "osu", url: `https://osu.ppy.sh/osu/${safeBeatmapId}`, path: `/osu/${safeBeatmapId}` },
      { name: "catboy", url: `https://catboy.best/osu/${safeBeatmapId}`, path: `catboy:/osu/${safeBeatmapId}` },
    ];

    for (const source of sources) {
      try {
        return await this.fetchBeatmapFileFromSource(source.url, source.path, caller);
      } catch (error) {
        errors.push(`${source.name} (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    throw new Error(`Failed to fetch .osu file for beatmap ${safeBeatmapId}: ${errors.join("; ")}`);
  }

  async getUserBestScores(userId: number, caller = "unknown"): Promise<OscScore[]> {
    return this.getJson(`/users/${userId}/scores/best?mode=mania&limit=100`, caller) as Promise<OscScore[]>;
  }

  async getUserBestScoresWindow(userId: number, totalLimit = 200, caller = "unknown"): Promise<OscScore[]> {
    const firstPagePromise = this.getJson<OscScore[]>(
      `/users/${userId}/scores/best?mode=mania&limit=${Math.min(totalLimit, 100)}&offset=0`,
      caller,
    );
    const secondPagePromise = totalLimit > 100
      ? this.getJson<OscScore[]>(
        `/users/${userId}/scores/best?mode=mania&limit=${Math.min(totalLimit - 100, 100)}&offset=100`,
        caller,
      )
        .then((value) => ({ ok: true, value }) as const)
        .catch((error) => ({ ok: false, error }) as const)
      : null;

    const firstPage = await firstPagePromise;
    if (totalLimit <= 100 || firstPage.length < 100) return firstPage;
    const secondPage = await secondPagePromise;
    if (!secondPage?.ok) throw secondPage?.error ?? new Error("Failed to fetch second best-score page");
    return [...firstPage, ...secondPage.value];
  }

  async getUserRecentScores(userId: number, caller = "unknown"): Promise<OscScore[]> {
    const apiScores = await this.getJson<OscScore[]>(
      `/users/${userId}/scores/recent?mode=mania&include_fails=1&limit=${USER_RECENT_SCORES_LIMIT}`,
      caller,
    );
    if (!apiScores.some((score) => score.id <= 0)) return apiScores;

    try {
      const webScores = await this.getUserRecentScoresWeb(userId, caller);
      return mergeRecentScoreIds(apiScores, webScores);
    } catch (error) {
      console.warn("[osu] failed to resolve id-zero recent scores from web endpoint", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return apiScores;
    }
  }

  async getScores(ruleset = "mania", cursorString?: string | null, caller = "unknown"): Promise<OsuScoresResponse> {
    const params = new URLSearchParams({ ruleset });
    if (cursorString) params.set("cursor_string", cursorString);
    return this.getJson(`/scores?${params.toString()}`, caller);
  }

  async getUserMostPlayed(userId: number, caller = "unknown"): Promise<unknown[]> {
    return this.getJson(`/users/${userId}/beatmapsets/most_played?limit=100&offset=0`, caller);
  }

  async getUserFavourites(userId: number, maxPages = 10, caller = "unknown"): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.getJson<unknown[]>(
        `/users/${userId}/beatmapsets/favourite?limit=100&offset=${page * 100}`,
        caller,
      );
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  async getBeatmapUserScoresAll(beatmapId: number, userId: number, caller = "unknown"): Promise<OscScore[]> {
    const body = await this.getJson<{ scores?: OscScore[] } | OscScore[]>(`/beatmaps/${beatmapId}/scores/users/${userId}/all?mode=mania`, caller);
    return Array.isArray(body) ? body : body.scores ?? [];
  }

  async getRanking(country: string, page = 1, caller = "unknown"): Promise<Record<string, unknown>> {
    return this.getJson(`/rankings/mania/performance?country=${encodeURIComponent(country)}&page=${page}`, caller);
  }

  async getJson<T = unknown>(path: string, caller = "unknown"): Promise<T> {
    if (!this.hasCredentials()) {
      throw new Error("OSU_CLIENT_ID and OSU_CLIENT_SECRET are required for osu! API calls");
    }
    return this.coalesce(`json:${path}`, () => this.limiter.schedule(caller, path, async () => {
      const token = await this.getAccessToken();
      const response = await this.fetchImpl(`https://osu.ppy.sh/api/v2${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-api-version": "20220705",
        },
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if (response.status === 429) this.limiter.pause(retryAfterMs ?? 60_000);
        throw new OsuApiError(response.status, path, retryAfterMs);
      }
      return response.json() as Promise<T>;
    }));
  }

  // Some v2 endpoints (e.g. /beatmaps/{id}/attributes) are POST-only despite
  // being pure reads; coalesce on path+body so identical lookups share a call.
  async postJson<T = unknown>(path: string, body: Record<string, unknown>, caller = "unknown"): Promise<T> {
    if (!this.hasCredentials()) {
      throw new Error("OSU_CLIENT_ID and OSU_CLIENT_SECRET are required for osu! API calls");
    }
    const bodyJson = JSON.stringify(body);
    return this.coalesce(`json:POST:${path}:${bodyJson}`, () => this.limiter.schedule(caller, path, async () => {
      const token = await this.getAccessToken();
      const response = await this.fetchImpl(`https://osu.ppy.sh/api/v2${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
          "x-api-version": "20220705",
        },
        body: bodyJson,
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if (response.status === 429) this.limiter.pause(retryAfterMs ?? 60_000);
        throw new OsuApiError(response.status, path, retryAfterMs);
      }
      return response.json() as Promise<T>;
    }));
  }

  async getBinary(path: string, caller = "unknown"): Promise<ArrayBuffer> {
    if (!this.hasCredentials()) {
      throw new Error("OSU_CLIENT_ID and OSU_CLIENT_SECRET are required for osu! API calls");
    }
    return this.coalesce(`binary:${path}`, () => this.limiter.schedule(caller, path, async () => {
      const token = await this.getAccessToken();
      const response = await this.fetchImpl(`https://osu.ppy.sh/api/v2${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if (response.status === 429) this.limiter.pause(retryAfterMs ?? 60_000);
        throw new OsuApiError(response.status, path, retryAfterMs);
      }
      return response.arrayBuffer();
    }));
  }

  private async getUserRecentScoresWeb(userId: number, caller: string): Promise<OscScore[]> {
    const path = `/users/${userId}/scores/recent?mode=mania&include_fails=1&limit=${USER_RECENT_SCORES_LIMIT}`;
    return this.coalesce(`web:${path}`, () => this.limiter.schedule(caller, `web:${path}`, async () => {
      const response = await this.fetchImpl(`https://osu.ppy.sh${path}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if (response.status === 429) this.limiter.pause(retryAfterMs ?? 60_000);
        throw new Error(`osu! web ${response.status} for ${path}`);
      }
      const body = await response.json() as unknown;
      if (!Array.isArray(body)) throw new Error(`osu! web recent scores returned ${typeof body}`);
      return body as OscScore[];
    }));
  }

  private async fetchBeatmapFileFromSource(url: string, path: string, caller: string): Promise<string> {
    return this.limiter.schedule(caller, path, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), BEATMAP_FILE_FETCH_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: BEATMAP_FILE_FETCH_HEADERS,
        });
        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          if (response.status === 429) this.limiter.pause(retryAfterMs ?? 60_000);
          throw new Error(`${response.status}`);
        }
        const text = await response.text();
        if (!isLikelyBeatmapFile(text)) throw new Error("invalid .osu file");
        return text;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  private coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const request = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.accessToken;
    const response = await this.fetchImpl("https://osu.ppy.sh/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: Number(this.config.osuClientId),
        client_secret: this.config.osuClientSecret,
        grant_type: "client_credentials",
        scope: "public",
      }),
    });
    if (!response.ok) throw new Error(`osu! OAuth ${response.status}`);
    const body = await response.json() as { access_token: string; expires_in: number };
    this.token = { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.accessToken;
  }
}

function mergeRecentScoreIds(apiScores: OscScore[], webScores: OscScore[]): OscScore[] {
  const usedWebIndexes = new Set<number>();
  return apiScores.map((apiScore) => {
    if (apiScore.id > 0) return apiScore;
    const webIndex = webScores.findIndex((webScore, index) => webScore.id > 0 && !usedWebIndexes.has(index) && isSameRecentScore(apiScore, webScore));
    if (webIndex < 0) return apiScore;
    usedWebIndexes.add(webIndex);
    const webScore = webScores[webIndex];
    return {
      ...apiScore,
      id: webScore.id,
      type: webScore.type ?? apiScore.type,
      legacy_score_id: webScore.legacy_score_id ?? apiScore.legacy_score_id,
      legacy_total_score: webScore.legacy_total_score ?? apiScore.legacy_total_score,
      classic_total_score: webScore.classic_total_score ?? apiScore.classic_total_score,
      total_score: webScore.total_score ?? apiScore.total_score,
      replay: webScore.replay ?? apiScore.replay,
      has_replay: webScore.has_replay ?? apiScore.has_replay,
    };
  });
}

function isSameRecentScore(left: OscScore, right: OscScore): boolean {
  return left.user_id === right.user_id
    && getBeatmapId(left) === getBeatmapId(right)
    && normalizeTimestamp(left.ended_at ?? left.created_at) === normalizeTimestamp(right.ended_at ?? right.created_at)
    && left.passed === right.passed
    && left.max_combo === right.max_combo
    && getTotalScoreKey(left) === getTotalScoreKey(right);
}

function getBeatmapId(score: OscScore): number | undefined {
  return score.beatmap_id ?? score.beatmap?.id;
}

function normalizeTimestamp(value: string | undefined): string {
  if (!value) return "";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

function getTotalScoreKey(score: OscScore): number {
  return score.legacy_total_score ?? score.classic_total_score ?? score.total_score ?? score.score ?? 0;
}

export function isLikelyBeatmapFile(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("osu file format") && content.includes("[HitObjects]");
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}
