import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { getCachedBeatmapAudioMetadata } from "../audio/beatmap-audio.js";
import { readCachedBeatmapFile } from "../osu/beatmap-file-cache.js";

// Maps offered for the skin page's "try it on a map" player. Only charts that
// are already fully cached qualify: the .osu text sits in beatmap_osu_files
// and the extracted audio sits in R2, so a preview never triggers a beatmap
// archive download. Candidates come from the maps projections (they carry
// searchable title/artist columns); audio state is probed once and memoized.

export interface SkinPreviewMap {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string | null;
  version: string;
  keys: number;
  difficultyRating: number;
  totalLength: number;
  audioFilename: string;
}

const CANDIDATE_POOL = 100;
const MAX_RESULTS = 40;
// Probing R2 for audio is the expensive part; cap fresh probes per request so
// a cold cache cannot stall the endpoint, and remember both outcomes.
const MAX_AUDIO_PROBES_PER_REQUEST = 40;
const AUDIO_PROBE_CONCURRENCY = 8;
const AUDIO_STATE_TTL_MS = 10 * 60 * 1000;
const AUDIO_FILENAME_NEGATIVE = "";
// Both memos are fed by a public, search-driven endpoint whose key space is every cached mania
// beatmap (~121k on prod), so an IP varying `q` could walk the lot into memory. Cap them, and
// only sweep/evict on a miss that is already paying for a DB read or an R2 probe. No TTL is
// needed on the filename memo: the AudioFilename of a cached .osu never changes.
const AUDIO_FILENAME_CACHE_MAX_ENTRIES = 4_000;
const AUDIO_STATE_CACHE_MAX_ENTRIES = 4_000;

const audioFilenameCache = new Map<number, string>();
const audioCachedState = new Map<string, { cached: boolean; expiresAt: number }>();

interface CandidateRow {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string | null;
  version: string;
  keys: number;
  difficultyRating: number;
  totalLength: number;
}

export async function listSkinPreviewMaps(
  db: Db,
  config: Config,
  options: { q?: string; keys?: number | null; limit?: number } = {},
): Promise<SkinPreviewMap[]> {
  const q = (options.q ?? "").trim().slice(0, 80);
  const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(options.limit ?? 24)));

  const args: (string | number)[] = [];
  let where = "mb.mode = 'mania' and bof.error is null and bof.raw_bytes > 0";
  if (options.keys != null && Number.isInteger(options.keys) && options.keys >= 1 && options.keys <= 10) {
    // cs carries the key count for mania rows.
    where += " and mb.cs >= ? and mb.cs < ?";
    args.push(options.keys - 0.5, options.keys + 0.5);
  }
  if (q) {
    const like = `%${q.replace(/[%_]/g, " ")}%`;
    where += " and (ms.title like ? or ms.artist like ? or ms.creator like ? or mb.version like ?)";
    args.push(like, like, like, like);
  }
  const rows = (await exec(
    db,
    `select mb.beatmap_id as beatmapId, mb.beatmapset_id as beatmapsetId, mb.version as version,
            mb.difficulty_rating as difficultyRating, mb.cs as keyCount, mb.total_length as totalLength,
            ms.title as title, ms.artist as artist, ms.creator as creator
       from maps_beatmaps mb
       join maps_beatmapsets ms on ms.beatmapset_id = mb.beatmapset_id
       join beatmap_osu_files bof on bof.beatmap_id = mb.beatmap_id
      where ${where}
      order by ms.global_play_count desc, mb.difficulty_rating asc
      limit ?`,
    [...args, CANDIDATE_POOL],
  )).rows;

  const candidates: CandidateRow[] = rows.map((row) => ({
    beatmapId: Number(row.beatmapId),
    beatmapsetId: Number(row.beatmapsetId),
    title: String(row.title ?? ""),
    artist: String(row.artist ?? ""),
    creator: row.creator == null ? null : String(row.creator),
    version: String(row.version ?? ""),
    keys: Math.round(Number(row.keyCount) || 0),
    difficultyRating: Number(row.difficultyRating) || 0,
    totalLength: Math.max(0, Math.floor(Number(row.totalLength) || 0)),
  })).filter((row) => row.beatmapId > 0 && row.beatmapsetId > 0 && row.keys >= 1 && row.keys <= 10);

  const results: SkinPreviewMap[] = [];
  let probes = 0;
  for (let index = 0; index < candidates.length && results.length < limit; index += AUDIO_PROBE_CONCURRENCY) {
    if (probes >= MAX_AUDIO_PROBES_PER_REQUEST) break;
    const chunk = candidates.slice(index, index + AUDIO_PROBE_CONCURRENCY);
    const resolved = await Promise.all(chunk.map(async (candidate) => {
      const audioFilename = await resolveAudioFilename(db, candidate.beatmapId);
      if (!audioFilename) return null;
      const state = audioCachedState.get(audioStateKey(candidate.beatmapsetId, audioFilename));
      if (!state || state.expiresAt < Date.now()) probes += 1;
      const cached = await isAudioCached(config, candidate.beatmapsetId, audioFilename);
      return cached ? { ...candidate, audioFilename } : null;
    }));
    for (const entry of resolved) {
      if (entry && results.length < limit) results.push(entry);
    }
  }
  return results;
}

// AudioFilename lives in the [General] header of the cached .osu; a regex
// beats decompress-and-fully-parse for a listing endpoint.
async function resolveAudioFilename(db: Db, beatmapId: number): Promise<string | null> {
  const cached = audioFilenameCache.get(beatmapId);
  if (cached != null) return cached === AUDIO_FILENAME_NEGATIVE ? null : cached;
  let filename: string | null = null;
  try {
    const content = await readCachedBeatmapFile(db, beatmapId);
    const match = content ? /^AudioFilename\s*:\s*(.+)$/m.exec(content.slice(0, 4000)) : null;
    filename = match ? match[1].trim().replace(/\\/g, "/") : null;
  } catch {
    filename = null;
  }
  if (audioFilenameCache.size >= AUDIO_FILENAME_CACHE_MAX_ENTRIES) {
    const oldest = audioFilenameCache.keys().next().value;
    if (oldest !== undefined) audioFilenameCache.delete(oldest);
  }
  audioFilenameCache.set(beatmapId, filename ?? AUDIO_FILENAME_NEGATIVE);
  return filename;
}

function audioStateKey(beatmapsetId: number, filename: string): string {
  return `${beatmapsetId}/${filename.toLowerCase()}`;
}

async function isAudioCached(config: Config, beatmapsetId: number, filename: string): Promise<boolean> {
  const key = audioStateKey(beatmapsetId, filename);
  const now = Date.now();
  const state = audioCachedState.get(key);
  if (state && state.expiresAt > now) return state.cached;
  let cached = false;
  try {
    cached = (await getCachedBeatmapAudioMetadata(config, String(beatmapsetId), filename)) != null;
  } catch {
    cached = false;
  }
  for (const [entryKey, entry] of audioCachedState) {
    if (entry.expiresAt <= now) audioCachedState.delete(entryKey);
  }
  audioCachedState.set(key, { cached, expiresAt: now + AUDIO_STATE_TTL_MS });
  while (audioCachedState.size > AUDIO_STATE_CACHE_MAX_ENTRIES) {
    const oldest = audioCachedState.keys().next().value;
    if (oldest === undefined) break;
    audioCachedState.delete(oldest);
  }
  return cached;
}
