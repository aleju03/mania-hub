import type { BeatmapChecksumLookupResult } from "./osu/replay";
import { getPersistentCacheEntry, osuFetch, setPersistentCache } from "./api";
import { parseUploadedReplayBuffer, type UploadedReplayParseResult } from "./replay-upload";
import { getJsonArtifact, getUploadedReplayDescStorageKey, getUploadedReplayStorageKey, putJsonArtifact } from "./r2-cache";
import { getManiaAccuracyFromCounts, getModDisplayList, scoreUsesLazerScoring } from "./score";
import {
  normalizeUploadedReplayId,
  normalizeUploadedReplayFilename,
  readUploadedReplay,
  uploadedReplaysUseR2,
} from "./uploaded-replay-store";

// Uploaded replays are content-addressed by a random id, so a parsed description
// never changes for a given id. Cache it so the community list and the R2 admin
// browser stop re-parsing the .osr and re-hitting the osu! beatmap lookup on
// every visit. Descriptions whose map isn't on osu! yet are stored too (the
// parse result is just as immutable); only the beatmap lookup is retried, at
// most once per retry window, so a later submission still resolves.
const DESCRIPTION_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
// The cross-instance artifact lives next to the .osr in R2, so it is only
// written when uploads go there; a development upload on local disk leaves no
// trace in the shared bucket and just re-parses from the memory tier.
async function putDescriptionArtifact(normalized: string, description: UploadedReplayDescription): Promise<void> {
  if (!uploadedReplaysUseR2()) return;
  await putJsonArtifact(getUploadedReplayDescStorageKey(normalized), description);
}
const DESCRIPTION_UNRESOLVED_CACHE_TTL = 24 * 60 * 60 * 1000;
const UNRESOLVED_BEATMAP_RETRY_MS = 24 * 60 * 60 * 1000;
// A stored description otherwise lives forever, so bump this whenever the
// derived fields change shape and each artifact re-parses its .osr once.
// v2: mods come from a lazer replay's own list, so they carry a custom rate and
// drop CL, where before they were whatever the legacy bitfield could express;
// accuracy and grade follow the client that recorded the play instead of always
// being measured on stable's scale.
export const DESCRIPTION_VERSION = 2;

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
  accuracy: number; // 0..1, on the scale the play's own client judges by
  grade: string;
  judgements: UploadedReplayJudgements;
  scoreId: number | null;
  originalFilename: string | null;
  beatmap: UploadedReplayBeatmap | null;
  // A lazer custom rate, since `mods` is acronyms only and a 1.1x DT must not
  // read back as the default 1.5x. Absent for every play at a default rate.
  modRate?: number;
  // Both optional: artifacts written before these fields existed lack them
  // (those are always resolved, so neither field is ever needed for them).
  // The hash lets an unresolved description retry its beatmap lookup without
  // re-reading the .osr; computedAt is when that lookup last ran.
  beatmapHash?: string;
  computedAt?: number;
  /** DESCRIPTION_VERSION at write time; absent means the original shape. */
  version?: number;
};

// Node Buffers can be a view over a larger pooled ArrayBuffer, so copy out the
// exact bytes before handing them to the osu! replay decoder.
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

// The .osr header counts are all the statistics an upload has, and lazer writes
// its own judgements into those same legacy fields - so the counts are right for
// either client and only the accuracy scale differs.
function maniaAccuracy(j: UploadedReplayJudgements, isLazer: boolean): number {
  return getManiaAccuracyFromCounts({
    count_geki: j.max,
    count_300: j.count300,
    count_katu: j.count200,
    count_100: j.count100,
    count_50: j.count50,
    count_miss: j.miss,
  }, isLazer);
}

// Grade off that accuracy; both clients use the same brackets, and silver ranks
// when a hidden-family mod is on. Uploaded replays are completed plays, so this
// only derives the pass grade.
function maniaGrade(accuracy: number, mods: string[]): string {
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
  return `uploaded-replay-desc:v${DESCRIPTION_VERSION}:${normalized}`;
}

// Memory tier + cross-instance R2 artifact, for resolved and unresolved
// descriptions alike; the memory TTL is what paces the unresolved retry.
async function persistDescription(normalized: string, description: UploadedReplayDescription): Promise<void> {
  const ttl = description.beatmap ? DESCRIPTION_CACHE_TTL : DESCRIPTION_UNRESOLVED_CACHE_TTL;
  await setPersistentCache(descriptionCacheKey(normalized), description, ttl);
  await putDescriptionArtifact(normalized, description);
}

// A description written by an older build: re-derive it from the .osr once and
// overwrite in place, since the derived fields have changed shape since. An
// unreadable or deleted file leaves the old artifact serving as-is.
async function upgradeStoredDescription(
  normalized: string,
  stored: UploadedReplayDescription,
): Promise<UploadedReplayDescription> {
  if ((stored.version ?? 1) >= DESCRIPTION_VERSION) return refreshStoredDescription(normalized, stored);
  const recomputed = await computeUploadedReplayDescription(normalized);
  if (!recomputed) return refreshStoredDescription(normalized, stored);
  await putDescriptionArtifact(normalized, recomputed);
  return recomputed;
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
  await putDescriptionArtifact(normalized, refreshed);
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
    const description = await upgradeStoredDescription(normalized, stored);
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
  const modDisplay = getModDisplayList(parsed.mods);
  const mods = modDisplay.map((mod) => mod.acronym);
  const modRate = modDisplay.find((mod) => mod.rate != null)?.rate;
  const isLazer = scoreUsesLazerScoring(null, header.gameVersion);
  const accuracy = maniaAccuracy(judgements, isLazer);

  return {
    id: normalized,
    playerName: header.playerName,
    mods,
    totalScore: header.totalScore,
    maxCombo: header.maxCombo,
    keyCount: parsed.replay.keyCount,
    accuracy,
    grade: maniaGrade(accuracy, mods),
    judgements,
    scoreId: parsed.scoreId,
    originalFilename,
    ...(modRate != null ? { modRate } : {}),
    beatmap: await lookupUploadedReplayBeatmap(header.beatmapHash ?? ""),
    beatmapHash: header.beatmapHash ?? "",
    computedAt: Date.now(),
    version: DESCRIPTION_VERSION,
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
