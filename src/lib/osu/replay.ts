import { createServerFn } from "@tanstack/react-start";
import {
  acquireCacheLock,
  fetchBeatmapFile,
  fetchWithCacheLock,
  osuFetch,
  osuFetchBinary,
  releaseCacheLock,
  runWithCacheLockRenewal
} from "../api";
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
  parseBoundedInt
} from "./validators";
import { decodeStableManiaReplayFrames, getStableManiaReplayScrollSpeedScale } from "../replay-frames";

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
    : ["legacy", "modern"];
  let firstError: unknown = null;
  let lastError: unknown = null;

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
      lastError = error;
    }
  }

  throw (preferredEndpointKind ? firstError : lastError) ?? new Error("Failed to download replay");
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
  .inputValidator(normalizeReplayParsedPayload)
  .handler(async ({ data }: { data: { scoreId: number; mode: string; keyCount?: number } }) => {
    edgeCache(86400, 604800);
    const cacheKey = [
      `replay-parsed:v${REPLAY_PARSED_CACHE_VERSION}`,
      data.scoreId,
      data.mode,
      data.keyCount ?? 0,
    ].join(":");

    return fetchWithCacheLock<ParsedReplayResponse>(cacheKey, REPLAY_PARSED_CACHE_TTL, async () => {
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

      // Pack frames into typed arrays to shrink the wire payload ~20x vs JSON.
      // Little-endian host is assumed (every x86/ARM server and client is LE).
      // For mania, column bitmask is in mouseX (position.x), NOT buttonState.
      const frameCount = frames.length;
      const times = new Int32Array(frameCount);
      const keys = new Uint32Array(frameCount);
      for (let i = 0; i < frameCount; i++) {
        const frame = frames[i];
        times[i] = frame.time | 0;
        keys[i] = frame.keyState;
      }

      // Detect key count: prefer beatmap CS from score API, fall back to OR of all frames
      let keyCount = data.keyCount ?? 0;
      if (!keyCount) {
        let allBits = 0;
        for (let i = 0; i < frameCount; i++) allBits |= keys[i];
        let maxBit = 0;
        let tmp = allBits;
        while (tmp > 0) { maxBit++; tmp >>= 1; }
        keyCount = Math.max(maxBit, 4);
      }

      const timesB64 = Buffer.from(times.buffer, times.byteOffset, times.byteLength).toString("base64");
      const keysB64 = Buffer.from(keys.buffer, keys.byteOffset, keys.byteLength).toString("base64");

      return {
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
        framesPacked: { count: frameCount, times: timesB64, keys: keysB64 },
        keyCount,
        stableScrollSpeedScale: stableScrollSpeedScale ?? undefined,
      };
    }, REPLAY_CACHE_LOCK_TTL_MS);
  });

export const lookupBeatmapByChecksum = createServerFn({ method: "GET" })
  .inputValidator(normalizeBeatmapChecksumPayload)
  .handler(async ({ data }: { data: { checksum: string } }) => {
    edgeCache(300, 3600);
    return osuFetch<BeatmapChecksumLookupResult>(
      "/beatmaps/lookup",
      { checksum: data.checksum },
      { caller: "lookupBeatmapByChecksum" },
    );
  });

export const getBeatmapFile = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const data = normalizeBeatmapPayload(input);
    const beatmapsetIdRaw = typeof input === "object" && input !== null && "beatmapsetId" in input
      ? (input as { beatmapsetId?: unknown }).beatmapsetId
      : undefined;
    const beatmapsetId = beatmapsetIdRaw == null || beatmapsetIdRaw === ""
      ? null
      : parseBoundedInt(beatmapsetIdRaw, "beatmapsetId", { min: 1, max: 10_000_000 });
    return { ...data, beatmapsetId };
  })
  .handler(async ({ data }: { data: { beatmapId: number; beatmapsetId: number | null } }) => {
    noStore();
    const osuFile = await fetchBeatmapFile(data.beatmapId, data.beatmapsetId);
    return { content: osuFile };
  });

export const getScore = createServerFn({ method: "GET" })
  .inputValidator(normalizeScorePayload)
  .handler(async ({ data }: { data: { scoreId: number; mode?: string } }) => {
    edgeCache(300, 1800);
    const mode = data.mode ?? "mania";

    try {
      const legacyScore = await osuFetch<OsuScore>(
        `/scores/${mode}/${data.scoreId}`,
        undefined,
        { caller: "getScore:legacy" },
      );
      const resolvedMode = legacyScore.beatmap?.mode ?? mode;
      if (resolvedMode === mode) {
        return legacyScore;
      }
    } catch {
      // Fall back to modern score lookup below.
    }

    return osuFetch<OsuScore>(`/scores/${data.scoreId}`, undefined, {
      caller: "getScore:modern",
    });
  });
