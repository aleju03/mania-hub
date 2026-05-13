import type { Config } from "../config.js";
import type { OscScore } from "../shared/types.js";

export class TokenBucketLimiter {
  private starts: number[] = [];
  private recent: Array<{ startedAt: number; caller: string; path: string }> = [];
  private pausedUntil = 0;
  private nextStartAt = 0;

  constructor(
    private readonly hardPerMinute: number,
    private readonly targetPerMinute = hardPerMinute,
    private readonly onCall?: (entry: { caller: string; path: string; startedAt: number }) => void,
  ) {}

  async schedule<T>(caller: string, path: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (now < this.pausedUntil) {
      await new Promise((resolve) => setTimeout(resolve, this.pausedUntil - now));
      return this.schedule(caller, path, fn);
    }
    this.starts = this.starts.filter((startedAt) => now - startedAt < 60_000);
    if (this.starts.length >= this.hardPerMinute) {
      const waitMs = 60_000 - (now - this.starts[0]) + 1;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.schedule(caller, path, fn);
    }
    if (now < this.nextStartAt) {
      await new Promise((resolve) => setTimeout(resolve, this.nextStartAt - now));
      return this.schedule(caller, path, fn);
    }
    const startedAt = Date.now();
    this.starts.push(startedAt);
    this.nextStartAt = startedAt + Math.ceil(60_000 / Math.max(1, this.targetPerMinute));
    this.recent.push({ startedAt, caller, path });
    this.onCall?.({ caller, path, startedAt });
    this.recent = this.recent.filter((entry) => startedAt - entry.startedAt < 60_000);
    return fn();
  }

  pause(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  state() {
    const now = Date.now();
    this.starts = this.starts.filter((startedAt) => now - startedAt < 60_000);
    this.recent = this.recent.filter((entry) => now - entry.startedAt < 60_000);
    const byCaller = new Map<string, number>();
    const byPath = new Map<string, number>();
    for (const entry of this.recent) {
      byCaller.set(entry.caller, (byCaller.get(entry.caller) ?? 0) + 1);
      byPath.set(entry.path, (byPath.get(entry.path) ?? 0) + 1);
    }
    return {
      hardPerMinute: this.hardPerMinute,
      targetPerMinute: this.targetPerMinute,
      usedLastMinute: this.starts.length,
      pausedMs: Math.max(0, this.pausedUntil - now),
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
  readonly limiter: TokenBucketLimiter;

  constructor(
    private readonly config: Pick<Config, "osuClientId" | "osuClientSecret" | "osuApiTargetPerMinute" | "osuApiHardPerMinute">,
    private readonly fetchImpl: typeof fetch = fetch,
    onCall?: (entry: { caller: string; path: string; startedAt: number }) => void,
  ) {
    this.limiter = new TokenBucketLimiter(config.osuApiHardPerMinute, config.osuApiTargetPerMinute, onCall);
  }

  hasCredentials(): boolean {
    return !!this.config.osuClientId && !!this.config.osuClientSecret;
  }

  async getUser(userId: number, caller = "unknown"): Promise<Record<string, unknown>> {
    return this.getJson(`/users/${userId}/mania`, caller);
  }

  async getBeatmap(beatmapId: number, caller = "unknown"): Promise<Record<string, unknown>> {
    return this.getJson(`/beatmaps/${beatmapId}`, caller);
  }

  async getUserBestScores(userId: number, caller = "unknown"): Promise<OscScore[]> {
    return this.getJson(`/users/${userId}/scores/best?mode=mania&limit=100`, caller) as Promise<OscScore[]>;
  }

  async getUserBestScoresWindow(userId: number, totalLimit = 200, caller = "unknown"): Promise<OscScore[]> {
    const firstPage = await this.getJson<OscScore[]>(
      `/users/${userId}/scores/best?mode=mania&limit=${Math.min(totalLimit, 100)}&offset=0`,
      caller,
    );
    if (totalLimit <= 100 || firstPage.length < 100) return firstPage;
    const secondPage = await this.getJson<OscScore[]>(
      `/users/${userId}/scores/best?mode=mania&limit=${Math.min(totalLimit - 100, 100)}&offset=100`,
      caller,
    );
    return [...firstPage, ...secondPage];
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
    return this.limiter.schedule(caller, path, async () => {
      const token = await this.getAccessToken();
      const response = await this.fetchImpl(`https://osu.ppy.sh/api/v2${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if (response.status === 429) this.limiter.pause(retryAfterMs ?? 60_000);
        throw new OsuApiError(response.status, path, retryAfterMs);
      }
      return response.json() as Promise<T>;
    });
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

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}
