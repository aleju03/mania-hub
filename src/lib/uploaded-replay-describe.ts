import type { BeatmapChecksumLookupResult } from "./osu/replay";
import { fetchBeatmapFileWithMeta, getPersistentCacheEntry, osuFetch, setPersistentCache } from "./api";
import { parseManiaBeatmap } from "./beatmap-parser";
import { calculateManiaStarRating } from "./mania-star-rating";
import { parseUploadedReplayBuffer, type UploadedReplayParseResult } from "./replay-upload";
import { getJsonArtifact, getUploadedReplayDescStorageKey, getUploadedReplayStorageKey, putJsonArtifact } from "./r2-cache";
import { getManiaAccuracyFromCounts, getManiaKeyModCount, getModDisplayList, getModListRate, scoreUsesLazerScoring } from "./score";
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
// The retry window doubles with each lookup osu! answers 404 (1, 2, 4... days,
// capped at 30): most unknown checksums are local or unsubmitted charts that
// never arrive, so a flat daily retry spent the same ~90 calls every day. Each
// id also waits a fixed fraction of a day extra, so replays that missed
// together stop retrying as one burst.
const UNRESOLVED_BEATMAP_RETRY_MS = 24 * 60 * 60 * 1000;
const UNRESOLVED_BEATMAP_MAX_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
// A stored description otherwise lives forever, so bump this whenever the
// derived fields change shape and each artifact re-parses its .osr once.
// v2: mods come from a lazer replay's own list, so they carry a custom rate and
// drop CL, where before they were whatever the legacy bitfield could express;
// accuracy and grade follow the client that recorded the play instead of always
// being measured on stable's scale.
// v3: stable ScoreV2 also uses MAX=305 accuracy. Refresh existing artifacts.
export const DESCRIPTION_VERSION = 3;

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
  /** Retries in a row that osu! answered 404; paces the next one. */
  lookupMisses?: number;
  /** The chart's star rating at the rate the play ran at, which is what the
   *  viewer shows once it opens. Only stored for a rate-changing play; at 1.0x
   *  the map's own `beatmap.starRating` already is the rating. */
  starRatingAtRate?: number;
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
function maniaAccuracy(j: UploadedReplayJudgements, isLazer: boolean, mods: string[]): number {
  return getManiaAccuracyFromCounts({
    count_geki: j.max,
    count_300: j.count300,
    count_katu: j.count200,
    count_100: j.count100,
    count_50: j.count50,
    count_miss: j.miss,
  }, isLazer, mods);
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

export function toUploadedReplayBeatmap(lookup: BeatmapChecksumLookupResult): UploadedReplayBeatmap {
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
}

// null: osu! does not know the checksum (unsubmitted or deleted map).
// undefined: the lookup failed for another reason and says nothing about it.
// Either way the card shows the player + score without the map.
async function lookupUploadedReplayBeatmap(checksum: string): Promise<UploadedReplayBeatmap | null | undefined> {
  if (!checksum) return null;
  try {
    const lookup = await osuFetch<BeatmapChecksumLookupResult>(
      "/beatmaps/lookup",
      { checksum },
      { caller: "describeUploadedReplay", expectedStatuses: [404] },
    );
    if (!lookup) return null;
    return toUploadedReplayBeatmap(lookup);
  } catch (error) {
    return /\]\s+404\s/.test(error instanceof Error ? error.message : String(error)) ? null : undefined;
  }
}

function unresolvedRetryMs(description: UploadedReplayDescription): number {
  const base = Math.min(UNRESOLVED_BEATMAP_RETRY_MS * 2 ** (description.lookupMisses ?? 0), UNRESOLVED_BEATMAP_MAX_RETRY_MS);
  let hash = 0;
  for (const char of description.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return base + (hash % 1000) / 1000 * UNRESOLVED_BEATMAP_RETRY_MS;
}

// A chart that would not rate (deleted map, a .osu that never arrives) is tried
// once per process; without this the catalog would reach for it on every
// refresh, and a restart is enough of a retry for a transient outage.
const unratedAtRate = new Set<string>();

/** A play with a rate mod is rated at that rate, so the map's own rating (what
 *  the osu! lookup returns) is not the number to show. Nothing to do at 1.0x,
 *  or for a map osu! doesn't know: there is no chart to rate. */
export function needsStarRatingAtRate(description: UploadedReplayDescription): boolean {
  return description.starRatingAtRate === undefined
    && !unratedAtRate.has(description.id)
    && description.beatmap?.beatmapId != null
    && getModListRate(description.mods, description.modRate) !== 1;
}

// The same computation the viewer's info bar runs: the lazer diffcalc port over
// the parsed chart at the play's rate, so a card and the replay it opens agree.
// A failure leaves the field unset and follows the process-level retry guard.
async function computeStarRatingAtRate(description: UploadedReplayDescription): Promise<number | null> {
  const beatmap = description.beatmap;
  if (!beatmap?.beatmapId) return null;
  try {
    const file = await fetchBeatmapFileWithMeta(beatmap.beatmapId, beatmap.beatmapsetId, description.beatmapHash || null);
    // The fetch can return osu!'s current revision when the replay's original
    // chart is unavailable. Never persist that other chart's rating.
    if (file.checksumMatched === false) return null;
    // The same choice the viewer's getManiaParseKeyCount makes: a native mania
    // chart carries its own column count, a convert takes the xK keymod's and
    // otherwise lets the lazer convert formula decide.
    const chart = parseManiaBeatmap(file.content,
      beatmap.mode === "mania" ? {} : { keyCount: getManiaKeyModCount(description.mods.map((acronym) => ({ acronym }))) });
    if (chart.notes.length === 0) return null;
    const stars = calculateManiaStarRating(chart.notes, chart.keyCount, getModListRate(description.mods, description.modRate));
    return Number.isFinite(stars) ? stars : null;
  } catch {
    return null;
  }
}

// Fills the field in on an artifact written before it existed, in place. Reads
// nothing but the .osu file, so no .osr parse and no osu! lookup are repeated.
async function withStarRatingAtRate(
  normalized: string,
  description: UploadedReplayDescription,
): Promise<UploadedReplayDescription> {
  if (!needsStarRatingAtRate(description)) return description;
  const starRatingAtRate = await computeStarRatingAtRate(description);
  if (starRatingAtRate == null) {
    unratedAtRate.add(description.id);
    return description;
  }
  const filled = { ...description, starRatingAtRate };
  await persistDescription(normalized, filled);
  return filled;
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
// window's read retries again, and a 404 also widens that window.
async function refreshStoredDescription(
  normalized: string,
  stored: UploadedReplayDescription,
): Promise<UploadedReplayDescription> {
  if (stored.beatmap || !stored.beatmapHash) return stored;
  if (Date.now() - (stored.computedAt ?? 0) < unresolvedRetryMs(stored)) return stored;
  const beatmap = await lookupUploadedReplayBeatmap(stored.beatmapHash);
  const refreshed: UploadedReplayDescription = {
    ...stored,
    beatmap: beatmap ?? null,
    computedAt: Date.now(),
    ...(beatmap === null ? { lookupMisses: (stored.lookupMisses ?? 0) + 1 } : {}),
  };
  await putDescriptionArtifact(normalized, refreshed);
  return refreshed;
}

export async function describeUploadedReplayById(id: string): Promise<UploadedReplayDescription | null> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return null;

  const cacheKey = descriptionCacheKey(normalized);
  const cached = await getPersistentCacheEntry<UploadedReplayDescription>(cacheKey);
  if (cached.hit) return withStarRatingAtRate(normalized, cached.value);

  const stored = await getJsonArtifact<UploadedReplayDescription>(getUploadedReplayDescStorageKey(normalized));
  if (stored) {
    const description = await withStarRatingAtRate(normalized, await upgradeStoredDescription(normalized, stored));
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

// Catalog hydration reads the existing summary without decoding a replay or
// waiting on an osu! lookup. Old/unresolved summaries can be refreshed later.
export async function readUploadedReplayDescription(id: string): Promise<UploadedReplayDescription | null> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return null;
  const cached = await getPersistentCacheEntry<UploadedReplayDescription>(descriptionCacheKey(normalized));
  if (cached.hit) return cached.value;
  return getJsonArtifact<UploadedReplayDescription>(getUploadedReplayDescStorageKey(normalized));
}

// Upload-time fast path: the upload handler already fully parsed the replay
// during validation and usually resolved its map too, so the description
// costs no lookup here and the community list never has to re-download and
// re-parse the .osr it just saw. `beatmap` undefined means "look it up";
// null means the handler already learned osu! does not know the checksum.
export async function persistUploadedReplayDescription(
  id: string,
  parsed: UploadedReplayParseResult,
  originalFilename: string | null | undefined,
  beatmap?: BeatmapChecksumLookupResult | null,
): Promise<void> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return;
  const description = await buildUploadedReplayDescription(
    normalized,
    parsed,
    normalizeUploadedReplayFilename(originalFilename) ?? null,
    beatmap,
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
  resolvedBeatmap?: BeatmapChecksumLookupResult | null,
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
  const accuracy = maniaAccuracy(judgements, isLazer, mods);

  const described: UploadedReplayDescription = {
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
    beatmap: resolvedBeatmap === undefined
      ? await lookupUploadedReplayBeatmap(header.beatmapHash ?? "") ?? null
      : resolvedBeatmap && toUploadedReplayBeatmap(resolvedBeatmap),
    beatmapHash: header.beatmapHash ?? "",
    computedAt: Date.now(),
    version: DESCRIPTION_VERSION,
  };
  if (!needsStarRatingAtRate(described)) return described;
  const starRatingAtRate = await computeStarRatingAtRate(described);
  if (starRatingAtRate == null) {
    unratedAtRate.add(described.id);
    return described;
  }
  return { ...described, starRatingAtRate };
}

export async function describeUploadedReplayByKey(key: string): Promise<UploadedReplayDescription | null> {
  const base = key.split("/").pop() ?? "";
  if (!/\.osr$/i.test(base)) return null;
  const id = normalizeUploadedReplayId(base.slice(0, -4));
  // Only serve genuine uploaded-replay keys, not arbitrary bucket objects.
  if (!id || getUploadedReplayStorageKey(id) !== key) return null;
  return describeUploadedReplayById(id);
}
