import { createServerFn } from "@tanstack/react-start";
import { osuFetch, osuFetchBinary, fetchBeatmapFile, getCached, setCache } from "./api";
import { calculateApproxPpGainMap } from "./score";
import type {
  OsuUser,
  OsuScore,
  RankingsResponse,
  BeatmapsetSearchResponse,
  UserSearchResponse,
} from "./types";

const RANK_HISTORY_CONCURRENCY = 20;
const rankHistoryPromiseCache = new Map<number, Promise<number[] | null>>();

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) return;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

async function getUserRankHistory(userId: number): Promise<number[] | null> {
  const cacheKey = `rank-history:user:${userId}`;
  const cached = getCached<number[]>(cacheKey);
  if (cached) return cached;

  const pending = rankHistoryPromiseCache.get(userId);
  if (pending) return pending;

  const request = osuFetch<OsuUser>(`/users/${userId}/mania`)
    .then((user) => {
      const history = user.rank_history?.data ?? null;
      if (history) {
        setCache(cacheKey, history);
      }
      return history;
    })
    .finally(() => {
      rankHistoryPromiseCache.delete(userId);
    });

  rankHistoryPromiseCache.set(userId, request);
  return request;
}

// ── User ────────────────────────────────────────────────────────────────────

export const getUser = createServerFn({ method: "GET" })
  .inputValidator((data: { key: string }) => data)
  .handler(async ({ data }: { data: { key: string } }) => {
    return osuFetch<OsuUser>(`/users/${encodeURIComponent(data.key)}/mania`);
  });

export const getUserScoresBest = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; limit?: number; offset?: number }) => data)
  .handler(async ({ data }: { data: { userId: number; limit?: number; offset?: number } }) => {
    return osuFetch<OsuScore[]>(`/users/${data.userId}/scores/best`, {
      mode: "mania",
      limit: data.limit ?? 20,
      offset: data.offset ?? 0,
    });
  });

export const getUserScoresRecent = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number; limit?: number; include_fails?: boolean }) => data)
  .handler(async ({ data }: { data: { userId: number; limit?: number; include_fails?: boolean } }) => {
    return osuFetch<OsuScore[]>(`/users/${data.userId}/scores/recent`, {
      mode: "mania",
      limit: data.limit ?? 10,
      include_fails: data.include_fails ? 1 : 0,
    });
  });

export const getUserApproxPpGains = createServerFn({ method: "GET" })
  .inputValidator((data: { userId: number }) => data)
  .handler(async ({ data }: { data: { userId: number } }) => {
    const cacheKey = `pp-gains:${data.userId}`;
    const cached = getCached<Record<number, number>>(cacheKey);
    if (cached) return cached;

    const [firstPage, secondPage] = await Promise.all([
      osuFetch<OsuScore[]>(`/users/${data.userId}/scores/best`, {
        mode: "mania",
        limit: 100,
        offset: 0,
      }),
      osuFetch<OsuScore[]>(`/users/${data.userId}/scores/best`, {
        mode: "mania",
        limit: 100,
        offset: 100,
      }),
    ]);

    const gains = calculateApproxPpGainMap([...firstPage, ...secondPage]);
    setCache(cacheKey, gains);
    return gains;
  });

// ── Rankings ────────────────────────────────────────────────────────────────

export const getRankings = createServerFn({ method: "GET" })
  .inputValidator((data: { type?: string; page?: number; country?: string }) => data)
  .handler(async ({ data }: { data: { type?: string; page?: number; country?: string } }) => {
    const type = data.type ?? "performance";
    const cacheKey = `rankings:${type}:${data.page ?? 1}:${data.country ?? ""}`;
    const cached = getCached<RankingsResponse>(cacheKey);
    if (cached) return cached;
    const result = await osuFetch<RankingsResponse>(`/rankings/mania/${type}`, {
      "cursor[page]": data.page ?? 1,
      country: data.country,
    });
    setCache(cacheKey, result);
    return result;
  });

// ── Batch user rank history ────────────────────────────────────────────────

export const getUsersRankHistory = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[] }) => data)
  .handler(async ({ data }: { data: { userIds: number[] } }) => {
    const uniqueUserIds = [...new Set(data.userIds)];

    const results = await mapWithConcurrency(
      uniqueUserIds,
      RANK_HISTORY_CONCURRENCY,
      async (userId) => {
        try {
          const history = await getUserRankHistory(userId);
          return { userId, history };
        } catch {
          return { userId, history: null };
        }
      },
    );

    const out: Record<number, number[]> = {};

    results.forEach(({ userId, history }) => {
      if (history?.length) {
        out[userId] = history;
      }
    });

    return out;
  });

// ── Beatmaps ────────────────────────────────────────────────────────────────

export const searchBeatmaps = createServerFn({ method: "GET" })
  .inputValidator((data: { query?: string; sort?: string; cursor_string?: string; status?: string }) => data)
  .handler(async ({ data }: { data: { query?: string; sort?: string; cursor_string?: string; status?: string } }) => {
    return osuFetch<BeatmapsetSearchResponse>("/beatmapsets/search", {
      m: 3, // mania
      q: data.query,
      sort: data.sort ?? "ranked_desc",
      cursor_string: data.cursor_string,
      s: data.status,
    });
  });

// ── Search ──────────────────────────────────────────────────────────────────

export const searchUsers = createServerFn({ method: "GET" })
  .inputValidator((data: { query: string }) => data)
  .handler(async ({ data }: { data: { query: string } }) => {
    return osuFetch<UserSearchResponse>("/search", {
      mode: "user",
      query: data.query,
    });
  });

// ── Score Feed (CR top players' recent scores) ─────────────────────────────

export const getCountryRecentScores = createServerFn({ method: "GET" })
  .inputValidator((data: { userIds: number[]; batchSize?: number; batchIndex?: number }) => data)
  .handler(async ({ data }: { data: { userIds: number[]; batchSize?: number; batchIndex?: number } }) => {
    const size = data.batchSize ?? 5;
    const start = ((data.batchIndex ?? 0) * size) % data.userIds.length;
    const batch = data.userIds.slice(start, start + size);

    const results = await Promise.allSettled(
      batch.map((uid: number) =>
        osuFetch<OsuScore[]>(`/users/${uid}/scores/recent`, {
          mode: "mania",
          limit: 5,
          include_fails: 1,
        })
      )
    );

    return results
      .filter((r): r is PromiseFulfilledResult<OsuScore[]> => r.status === "fulfilled")
      .flatMap((r) => r.value);
  });

// ── Replay (parsed server-side via osu-parsers) ────────────────────────────

export const getReplayParsed = createServerFn({ method: "GET" })
  .inputValidator((data: { scoreId: number; mode: string }) => data)
  .handler(async ({ data }: { data: { scoreId: number; mode: string } }) => {
    const { ScoreDecoder } = await import("osu-parsers");
    const buffer = await osuFetchBinary(`/scores/${data.mode}/${data.scoreId}/download`);
    const decoder = new ScoreDecoder();
    const score = await decoder.decodeFromBuffer(Buffer.from(buffer));

    const info = score.info;
    const frames = (score.replay?.frames ?? []).map((f: any) => ({
      time: f.startTime,
      keyState: f.buttonState,
    }));

    // Detect key count from max bit used
    let maxBit = 0;
    for (const f of frames) {
      let s = f.keyState;
      let bit = 0;
      while (s > 0) { bit++; s >>= 1; }
      if (bit > maxBit) maxBit = bit;
    }

    return {
      header: {
        playerName: info?.username ?? "Unknown",
        gameMode: info?.rulesetId ?? 3,
        totalScore: info?.totalScore ?? 0,
        maxCombo: info?.maxCombo ?? 0,
        count300: info?.count300 ?? 0,
        count100: info?.count100 ?? 0,
        count50: info?.count50 ?? 0,
        countGeki: info?.countGeki ?? 0,
        countKatu: info?.countKatu ?? 0,
        countMiss: info?.countMiss ?? 0,
        isPerfect: info?.perfect ?? false,
      },
      frames,
      keyCount: Math.max(maxBit, 4),
    };
  });

export const getBeatmapFile = createServerFn({ method: "GET" })
  .inputValidator((data: { beatmapId: number }) => data)
  .handler(async ({ data }: { data: { beatmapId: number } }) => {
    const osuFile = await fetchBeatmapFile(data.beatmapId);
    return { content: osuFile };
  });

export const getScore = createServerFn({ method: "GET" })
  .inputValidator((data: { scoreId: number }) => data)
  .handler(async ({ data }: { data: { scoreId: number } }) => {
    return osuFetch<OsuScore>(`/scores/${data.scoreId}`);
  });
