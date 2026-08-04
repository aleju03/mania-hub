import type { BeatmapChecksumLookupResult } from "./osu/replay";
import { getPersistentCacheEntry, osuFetch, setPersistentCache } from "./api";
import { parseUploadedReplayBuffer, type UploadedReplayParseResult } from "./replay-upload";
import { getJsonArtifact, getUploadedReplayDescStorageKey, getUploadedReplayStorageKey, putJsonArtifact } from "./r2-cache";
import { normalizeUploadedReplayId, normalizeUploadedReplayFilename, readUploadedReplay } from "./uploaded-replay-store";

// Uploaded replays are content-addressed by a random id, so a parsed description
// never changes for a given id. Cache it so the community list and the R2 admin
// browser stop re-parsing the .osr and re-hitting the osu! beatmap lookup on
// every visit. Descriptions whose map isn't on osu! yet are stored too (the
// parse result is just as immutable); only the beatmap lookup is retried, at
// most once per retry window, so a later submission still resolves.
const DESCRIPTION_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const DESCRIPTION_UNRESOLVED_CACHE_TTL = 24 * 60 * 60 * 1000;
const UNRESOLVED_BEATMAP_RETRY_MS = 24 * 60 * 60 * 1000;

// Uploaded replays are stored anonymously and content-addressed by a random id,
// so there is no stored record of who uploaded them or which score they are.
// Everything human-readable here is derived on demand: parse the .osr header for
// the player + score, then resolve the map from its beatmap checksum. Powers the
// R2 admin browser's uploaded-replays rows.

export type UploadedReplayJudgements = {
  max: number;
  count300: number;
  count200: number;
  count100: number;
  count50: number;
  miss: number;
};

export type UploadedReplayBeatmap = {
  beatmapId: number | null;
  beatmapsetId: number | null;
  artist: string;
  title: string;
  version: string;
  creator: string | null;
  starRating: number | null;
  mode: string;
};

export type UploadedReplayDescription = {
  id: string;
  playerName: string;
  mods: string[];
  totalScore: number;
  maxCombo: number;
  keyCount: number;
  accuracy: number; // 0..1, stable 300-weighted scale
  grade: string;
  judgements: UploadedReplayJudgements;
  scoreId: number | null;
  originalFilename: string | null;
  beatmap: UploadedReplayBeatmap | null;
  // Both optional: artifacts written before these fields existed lack them
  // (those are always resolved, so neither field is ever needed for them).
  // The hash lets an unresolved description retry its beatmap lookup without
  // re-reading the .osr; computedAt is when that lookup last ran.
  beatmapHash?: string;
  computedAt?: number;
};

// Node Buffers can be a view over a larger pooled ArrayBuffer, so copy out the
// exact bytes before handing them to the osu! replay decoder.
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

// Stable osu!mania accuracy (300-weighted, MAX counts as 300), matching
// calculateStableAccuracy() in score.ts.
function stableManiaAccuracy(j: UploadedReplayJudgements): number {
  const total = j.max + j.count300 + j.count200 + j.count100 + j.count50 + j.miss;
  if (total <= 0) return 0;
  return (j.max * 300 + j.count300 * 300 + j.count200 * 200 + j.count100 * 100 + j.count50 * 50) / (total * 300);
}

// Grade off the stable accuracy; silver ranks when a hidden-family mod is on.
// Uploaded replays are completed plays, so this only derives the pass grade.
function stableManiaGrade(accuracy: number, mods: string[]): string {
  const silver = mods.some((mod) => mod === "HD" || mod === "FI" || mod === "FL");
  if (accuracy >= 1) return silver ? "XH" : "X";
  if (accuracy > 0.95) return silver ? "SH" : "S";
  if (accuracy > 0.9) return "A";
  if (accuracy > 0.8) return "B";
  if (accuracy > 0.7) return "C";
  return "D";
}

async function lookupUploadedReplayBeatmap(checksum: string): Promise<UploadedReplayBeatmap | null> {
  if (!checksum) return null;
  try {
    const lookup = await osuFetch<BeatmapChecksumLookupResult>(
      "/beatmaps/lookup",
      { checksum },
      { caller: "describeUploadedReplay" },
    );
    if (!lookup) return null;
    return {
      beatmapId: Number.isFinite(lookup.id) ? lookup.id : null,
      beatmapsetId: Number.isFinite(lookup.beatmapset_id) ? lookup.beatmapset_id : null,
      artist: lookup.beatmapset?.artist ?? "",
      title: lookup.beatmapset?.title ?? "",
      version: lookup.version ?? "",
      creator: lookup.beatmapset?.creator ?? null,
      starRating: Number.isFinite(lookup.difficulty_rating) ? lookup.difficulty_rating : null,
      mode: lookup.mode ?? "mania",
    };
  } catch {
    // 404 means the checksum is unknown to osu! (unsubmitted or deleted map);
    // any lookup failure just means we show the player + score without the map.
    return null;
  }
}

function descriptionCacheKey(normalized: string): string {
  return `uploaded-replay-desc:v1:${normalized}`;
}

// Memory tier + cross-instance R2 artifact, for resolved and unresolved
// descriptions alike; the memory TTL is what paces the unresolved retry.
async function persistDescription(normalized: string, description: UploadedReplayDescription): Promise<void> {
  const ttl = description.beatmap ? DESCRIPTION_CACHE_TTL : DESCRIPTION_UNRESOLVED_CACHE_TTL;
  await setPersistentCache(descriptionCacheKey(normalized), description, ttl);
  await putJsonArtifact(getUploadedReplayDescStorageKey(normalized), description);
}

// An unresolved stored description: retry just the beatmap lookup once the
// retry window has passed, never the .osr parse. On success the artifact
// upgrades in place; on another miss the timestamp advances so the next
// window's read retries again.
async function refreshStoredDescription(
  normalized: string,
  stored: UploadedReplayDescription,
): Promise<UploadedReplayDescription> {
  if (stored.beatmap || !stored.beatmapHash) return stored;
  if (Date.now() - (stored.computedAt ?? 0) < UNRESOLVED_BEATMAP_RETRY_MS) return stored;
  const refreshed: UploadedReplayDescription = {
    ...stored,
    beatmap: await lookupUploadedReplayBeatmap(stored.beatmapHash),
    computedAt: Date.now(),
  };
  await putJsonArtifact(getUploadedReplayDescStorageKey(normalized), refreshed);
  return refreshed;
}

export async function describeUploadedReplayById(id: string): Promise<UploadedReplayDescription | null> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return null;

  const cacheKey = descriptionCacheKey(normalized);
  const cached = await getPersistentCacheEntry<UploadedReplayDescription>(cacheKey);
  if (cached.hit) return cached.value;

  const stored = await getJsonArtifact<UploadedReplayDescription>(getUploadedReplayDescStorageKey(normalized));
  if (stored) {
    const description = await refreshStoredDescription(normalized, stored);
    const ttl = description.beatmap ? DESCRIPTION_CACHE_TTL : DESCRIPTION_UNRESOLVED_CACHE_TTL;
    await setPersistentCache(cacheKey, description, ttl);
    return description;
  }

  const description = await computeUploadedReplayDescription(normalized);
  // Skip caching a null: a missing/corrupt read is cheap to redo and we don't
  // want to pin a transient R2 hiccup for a day.
  if (description) {
    await persistDescription(normalized, description);
  }
  return description;
}

// Upload-time fast path: the upload handler already fully parsed the replay
// during validation, so the description costs one beatmap lookup here and the
// community list never has to re-download and re-parse the .osr it just saw.
export async function persistUploadedReplayDescription(
  id: string,
  parsed: UploadedReplayParseResult,
  originalFilename: string | null | undefined,
): Promise<void> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return;
  const description = await buildUploadedReplayDescription(
    normalized,
    parsed,
    normalizeUploadedReplayFilename(originalFilename) ?? null,
  );
  await persistDescription(normalized, description);
}

async function computeUploadedReplayDescription(normalized: string): Promise<UploadedReplayDescription | null> {
  const stored = await readUploadedReplay(normalized);
  if (!stored) return null;

  let parsed;
  try {
    parsed = await parseUploadedReplayBuffer(toArrayBuffer(stored.buffer));
  } catch {
    // Corrupt file, or not an osu!mania replay.
    return null;
  }

  return buildUploadedReplayDescription(normalized, parsed, stored.originalFilename ?? null);
}

async function buildUploadedReplayDescription(
  normalized: string,
  parsed: UploadedReplayParseResult,
  originalFilename: string | null,
): Promise<UploadedReplayDescription> {
  const header = parsed.replay.header;
  const judgements: UploadedReplayJudgements = {
    max: header.countGeki,
    count300: header.count300,
    count200: header.countKatu,
    count100: header.count100,
    count50: header.count50,
    miss: header.countMiss,
  };
  const mods = parsed.mods.map((mod) => mod.acronym);
  const accuracy = stableManiaAccuracy(judgements);

  return {
    id: normalized,
    playerName: header.playerName,
    mods,
    totalScore: header.totalScore,
    maxCombo: header.maxCombo,
    keyCount: parsed.replay.keyCount,
    accuracy,
    grade: stableManiaGrade(accuracy, mods),
    judgements,
    scoreId: parsed.scoreId,
    originalFilename,
    beatmap: await lookupUploadedReplayBeatmap(header.beatmapHash ?? ""),
    beatmapHash: header.beatmapHash ?? "",
    computedAt: Date.now(),
  };
}

export async function describeUploadedReplayByKey(key: string): Promise<UploadedReplayDescription | null> {
  const base = key.split("/").pop() ?? "";
  if (!/\.osr$/i.test(base)) return null;
  const id = normalizeUploadedReplayId(base.slice(0, -4));
  // Only serve genuine uploaded-replay keys, not arbitrary bucket objects.
  if (!id || getUploadedReplayStorageKey(id) !== key) return null;
  return describeUploadedReplayById(id);
}
