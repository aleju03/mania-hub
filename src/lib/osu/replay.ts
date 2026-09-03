import { createServerFn } from "@tanstack/react-start";
import {
  acquireCacheLock,
  fetchBeatmapFileWithMeta,
  fetchWithCacheLock,
  osuFetch,
  osuFetchBinary,
  releaseCacheLock,
  runWithCacheLockRenewal
} from "../api";
import {
  getCommunityBeatmapAssets,
  getCommunityBeatmapFile as readCommunityBeatmap,
  putCommunityBeatmap,
  type CommunityBeatmapAssets,
  type CommunityBeatmapSubmitResult,
} from "../community-beatmap-store";
import type { ReplayEndpointKind } from "../r2-cache";
import type { OsuBeatmap, OsuBeatmapset, OsuScore } from "../types";
import {
  edgeCache,
  noStore
} from "./server";
import {
  normalizeBeatmapPayload,
  normalizeBeatmapChecksumPayload,
  normalizeReplayParsedPayload,
  normalizeScorePayload,
  parseBoundedInt,
  parseOptionalBeatmapChecksum
} from "./validators";
import { getOsuScoreModeName, getScoreEndpointOrder } from "./score-endpoint-order";
import { decodeStableManiaReplayFrames, getStableManiaReplayScrollSpeedScale } from "../replay-frames";
import { packReplayFrames } from "../replay-pack";

// ── Replay (parsed server-side via osu-parsers) ────────────────────────────

const REPLAY_CACHE_LOCK_TTL_MS = 30_000;
const REPLAY_CACHE_LOCK_WAIT_MS = 500;
const REPLAY_CACHE_LOCK_WAIT_RETRIES = 8;
const REPLAY_PARSED_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const REPLAY_PARSED_CACHE_VERSION = 4;

type ReplayDownload = {
  buffer: Buffer;
  endpointKind: ReplayEndpointKind;
};

type ParsedReplayResponse = {
  header: {
    playerName: string;
    gameMode: number;
    gameVersion?: number;
    beatmapHash?: string;
    modsUsed?: number;
    totalScore: number;
    maxCombo: number;
    count300: number;
    count100: number;
    count50: number;
    countGeki: number;
    countKatu: number;
    countMiss: number;
    isPerfect: boolean;
  };
  lifeBarFrames: Array<{ time: number; health: number }>;
  framesPacked: { count: number; times: string; keys: string };
  keyCount: number;
  stableScrollSpeedScale?: number;
};

export type BeatmapChecksumLookupResult = OsuBeatmap & {
  checksum?: string;
  beatmapset?: OsuBeatmapset;
};

type ReplayCacheModule = typeof import("../r2-cache");

function getReplayCacheModule(): Promise<ReplayCacheModule> {
  return import("../r2-cache");
}

function replayCacheLockKey(scoreId: number): string {
  return `replay-osr:v1:${scoreId}`;
}

function replayEndpointPath(endpointKind: ReplayEndpointKind, mode: string, scoreId: number): string {
  return endpointKind === "legacy"
    ? `/scores/${mode}/${scoreId}/download`
    : `/scores/${scoreId}/download`;
}

function replaySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadReplay(
  data: { scoreId: number; mode: string },
  preferredEndpointKind: ReplayEndpointKind | null,
): Promise<ReplayDownload> {
  const endpointKinds: ReplayEndpointKind[] = preferredEndpointKind
    ? [preferredEndpointKind, preferredEndpointKind === "legacy" ? "modern" : "legacy"]
    : getScoreEndpointOrder(data.scoreId);
  let firstError: unknown = null;

  for (const endpointKind of endpointKinds) {
    try {
      const buffer = await osuFetchBinary(replayEndpointPath(endpointKind, data.mode, data.scoreId), {
        caller: `getReplayParsed:${endpointKind}`,
      });
      return {
        buffer: Buffer.from(buffer),
        endpointKind,
      };
    } catch (error) {
      firstError ??= error;
    }
  }

  // The first endpoint tried is the one expected to match the score id, so
  // its error is the informative one; the fallback usually just 404s.
  throw firstError ?? new Error("Failed to download replay");
}

async function getReplayBuffer(data: { scoreId: number; mode: string }): Promise<Buffer> {
  const {
    getCachedReplay,
    getCachedReplayEndpointKind,
    isR2ReplayCacheConfigured,
    putCachedReplay,
  } = await getReplayCacheModule();
  const cached = await getCachedReplay(data.scoreId);
  if (cached) return cached.buffer;

  const preferredEndpointKind = await getCachedReplayEndpointKind(data.scoreId);
  if (!isR2ReplayCacheConfigured()) {
    return (await downloadReplay(data, preferredEndpointKind)).buffer;
  }

  const lockKey = replayCacheLockKey(data.scoreId);
  const lockOwner = await acquireCacheLock(lockKey, REPLAY_CACHE_LOCK_TTL_MS);

  if (lockOwner) {
    try {
      return await runWithCacheLockRenewal(lockKey, lockOwner, REPLAY_CACHE_LOCK_TTL_MS, async () => {
        const rechecked = await getCachedReplay(data.scoreId);
        if (rechecked) return rechecked.buffer;

        const download = await downloadReplay(data, preferredEndpointKind);
        const stored = await putCachedReplay(data.scoreId, download.endpointKind, download.buffer);
        return stored?.buffer ?? download.buffer;
      });
    } finally {
      await releaseCacheLock(lockKey, lockOwner);
    }
  }

  for (let i = 0; i < REPLAY_CACHE_LOCK_WAIT_RETRIES; i++) {
    await replaySleep(REPLAY_CACHE_LOCK_WAIT_MS);
    const polled = await getCachedReplay(data.scoreId);
    if (polled) return polled.buffer;
  }

  const download = await downloadReplay(data, preferredEndpointKind);
  await putCachedReplay(data.scoreId, download.endpointKind, download.buffer).catch(() => null);
  return download.buffer;
}

export const getReplayParsed = createServerFn({ method: "GET" })
  .validator(normalizeReplayParsedPayload)
  .handler(async ({ data }: { data: { scoreId: number; mode: string; keyCount?: number } }) => {
    edgeCache(86400, 604800);
    const cacheKey = [
      `replay-parsed:v${REPLAY_PARSED_CACHE_VERSION}`,
      data.scoreId,
      data.mode,
      data.keyCount ?? 0,
    ].join(":");

    return fetchWithCacheLock<ParsedReplayResponse>(cacheKey, REPLAY_PARSED_CACHE_TTL, async () => {
      // Cross-instance tier: parsing is the most expensive replay-viewer step, so
      // the packed result lives in R2 (a miss on this instance is usually a hit
      // there). Age-expired objects just re-parse.
      const { getJsonArtifact, getParsedReplayStorageKey, putJsonArtifact } = await getReplayCacheModule();
      const storageKey = getParsedReplayStorageKey(REPLAY_PARSED_CACHE_VERSION, data.scoreId, data.mode, data.keyCount ?? 0);
      const stored = await getJsonArtifact<ParsedReplayResponse>(storageKey);
      if (stored) return stored;

      const { ScoreDecoder } = await import("osu-parsers");
      const buffer = await getReplayBuffer(data);
      const decoder = new ScoreDecoder();
      const score = await decoder.decodeFromBuffer(buffer);

      const info = score.info;
      const rawFrames = (score.replay?.frames ?? []) as any[];
      const frames = decodeStableManiaReplayFrames(rawFrames);
      const stableScrollSpeedScale = getStableManiaReplayScrollSpeedScale(rawFrames);
      const lifeBarFrames = (score.replay?.lifeBar ?? [])
        .map((frame: any) => ({
          time: Math.round(Number(frame.startTime ?? frame.time ?? 0)),
          health: Math.max(0, Math.min(1, Number(frame.health ?? 0))),
        }))
        .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.health))
        .sort((a, b) => a.time - b.time);

      // For mania, column bitmask is in mouseX (position.x), NOT buttonState.
      const framesPacked = packReplayFrames(frames);

      // Detect key count: prefer beatmap CS from score API, fall back to OR of all frames
      let keyCount = data.keyCount ?? 0;
      if (!keyCount) {
        let allBits = 0;
        for (const frame of frames) allBits |= frame.keyState;
        let maxBit = 0;
        let tmp = allBits;
        while (tmp > 0) { maxBit++; tmp >>= 1; }
        keyCount = Math.max(maxBit, 4);
      }

      const response: ParsedReplayResponse = {
        header: {
          playerName: info?.username ?? "Unknown",
          gameMode: info?.rulesetId ?? 3,
          gameVersion: Number(score.replay?.gameVersion ?? 0) || undefined,
          beatmapHash: info?.beatmapHashMD5 ?? "",
          modsUsed: Number(info?.rawMods ?? info?.mods?.bitwise ?? 0) || 0,
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
        lifeBarFrames,
        framesPacked,
        keyCount,
        stableScrollSpeedScale: stableScrollSpeedScale ?? undefined,
      };
      await putJsonArtifact(storageKey, response);
      return response;
    }, REPLAY_CACHE_LOCK_TTL_MS);
  });

export const lookupBeatmapByChecksum = createServerFn({ method: "GET" })
  .validator(normalizeBeatmapChecksumPayload)
  .handler(async ({ data }: { data: { checksum: string } }): Promise<BeatmapChecksumLookupResult | null> => {
    edgeCache(300, 3600);
    try {
      return await osuFetch<BeatmapChecksumLookupResult>(
        "/beatmaps/lookup",
        { checksum: data.checksum },
        { caller: "lookupBeatmapByChecksum" },
      );
    } catch (error) {
      // 404 means the checksum is unknown to osu! (unsubmitted or deleted
      // map), which callers handle by asking for a local .osz instead.
      if (error instanceof Error && error.message.includes("] 404 ")) return null;
      throw error;
    }
  });

export const getBeatmapFile = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const data = normalizeBeatmapPayload(input);
    const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const beatmapsetId = record.beatmapsetId == null || record.beatmapsetId === ""
      ? null
      : parseBoundedInt(record.beatmapsetId, "beatmapsetId", { min: 1, max: 10_000_000 });
    const checksum = parseOptionalBeatmapChecksum(record.checksum);
    return { ...data, beatmapsetId, checksum };
  })
  .handler(async ({ data }: { data: { beatmapId: number; beatmapsetId: number | null; checksum: string | null } }) => {
    const result = await fetchBeatmapFileWithMeta(data.beatmapId, data.beatmapsetId, data.checksum);
    if (result.checksumMatched === false) {
      // Wrong revision (backend refresh throttled/failed, or an old backend
      // that ignores the param). Don't pin it under this checksum URL for the
      // full hour, but a `.osu` is a fat body to re-stream through the
      // function on every viewer of the same replay: a minute is short enough
      // that the next refresh still gets its chance, and no stale window on
      // top of it so the corrected file is never served late.
      edgeCache(60, 0);
    } else {
      // The checksum rides in the URL, so an updated map busts this edge cache
      // as soon as callers start sending the new value.
      edgeCache(3600, 86400);
    }
    return result;
  });

// Community-supplied .osu for a replay whose map osu! can't serve. Keyed only by
// the replay's beatmap checksum, so it also covers unsubmitted maps that have no
// beatmap id at all.
export const getCommunityBeatmapFile = createServerFn({ method: "GET" })
  .validator(normalizeBeatmapChecksumPayload)
  .handler(async ({ data }: { data: { checksum: string } }): Promise<{ content: string; assets: CommunityBeatmapAssets } | null> => {
    const [content, assets] = await Promise.all([
      readCommunityBeatmap(data.checksum),
      getCommunityBeatmapAssets(data.checksum),
    ]);
    if (!content) {
      // A miss flips to a hit the moment someone contributes this map, so never
      // let a CDN pin the empty answer and keep asking the next viewer.
      noStore();
      return null;
    }
    // A contributed .osu is immutable for its checksum, but its song and
    // background can still arrive later, so the answer only caches briefly.
    edgeCache(assets.audio && assets.background ? 86400 : 120, 604800);
    return { content, assets };
  });

export const submitCommunityBeatmap = createServerFn({ method: "POST" })
  .validator((input: unknown): { checksum: string; content: string } => {
    const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const checksum = String(record.checksum ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(checksum)) {
      throw new Error("Invalid beatmap checksum.");
    }
    const content = typeof record.content === "string" ? record.content : "";
    if (!content) {
      throw new Error("Missing beatmap file content.");
    }
    return { checksum, content };
  })
  .handler(async ({ data }: { data: { checksum: string; content: string } }): Promise<CommunityBeatmapSubmitResult> => {
    return putCommunityBeatmap(data.checksum, data.content);
  });

export const getScore = createServerFn({ method: "GET" })
  .validator(normalizeScorePayload)
  .handler(async ({ data }: { data: { scoreId: number; mode?: string } }) => {
    edgeCache(300, 1800);
    const mode = data.mode ?? "mania";
    let firstError: unknown = null;

    for (const endpointKind of getScoreEndpointOrder(data.scoreId)) {
      try {
        if (endpointKind === "modern") {
          const modernScore = await osuFetch<OsuScore>(`/scores/${data.scoreId}`, undefined, {
            caller: "getScore:modern",
            expectedStatuses: [404],
          });
          // The unified /scores/{id} namespace overlaps stable's per-mode
          // legacy ids, so a stable .osr's embedded id can 200 here as a
          // completely unrelated play in another ruleset. Only a hit whose
          // own ruleset matches counts; otherwise fall through to legacy.
          const modernMode = getOsuScoreModeName(modernScore) ?? mode;
          if (modernMode === mode) return modernScore;
          continue;
        }

        const legacyScore = await osuFetch<OsuScore>(
          `/scores/${mode}/${data.scoreId}`,
          undefined,
          { caller: "getScore:legacy", expectedStatuses: [404] },
        );
        const resolvedMode = legacyScore.beatmap?.mode ?? mode;
        if (resolvedMode === mode) return legacyScore;
      } catch (error) {
        firstError ??= error;
      }
    }

    throw firstError instanceof Error ? firstError : new Error("Failed to fetch score");
  });
