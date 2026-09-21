import { fetchBeatmapFileWithMeta, fetchWithCacheLock, osuFetch } from "./api";
import { getCommunityBeatmapAssets, getCommunityBeatmapFile } from "./community-beatmap-store";
import type { BeatmapChecksumLookupResult } from "./osu/replay";
import { withTimeout } from "./promise-timeout";
import { getJsonArtifact, getUploadedReplayPackedStorageKey, putJsonArtifact } from "./r2-cache";
import { packReplayFrames } from "./replay-pack";
import { parseUploadedReplayBuffer, type UploadedReplayParseResult } from "./replay-upload";
import {
  UPLOADED_REPLAY_PACKED_VERSION,
  type UploadedReplayBeatmapResolution,
  type UploadedReplayPacked,
} from "./uploaded-replay-payload";
import { normalizeUploadedReplayId, readUploadedReplay, uploadedReplaysUseR2 } from "./uploaded-replay-store";

// Opening an uploaded replay used to cost the browser the raw .osr download,
// the LZMA decode, then the checksum lookup and the .osu fetch as two more
// round trips, one after the other. An ingested replay never pays any of
// that: the server parses it once, packs it, and caches the result. This
// module gives uploads the same treatment, plus the chart resolution in the
// same response, so a share link opens in one round trip and an upload opens
// straight off the POST that stored it.
//
// Server-only (it reads R2 and the local upload directory); the server
// functions in uploaded-replay-open.ts import it inside their handlers so
// none of this reaches the client bundle.

const PACKED_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const PACKED_LOCK_TTL_MS = 30_000;
const BEATMAP_LOOKUP_CACHE_TTL_MS = 5 * 60_000;
const COMMUNITY_LOOKUP_TIMEOUT_MS = 3_000;

export type StoredPackedUpload = { replay: UploadedReplayPacked; filename: string | null };

function packedCacheKey(id: string): string {
  return `uploaded-replay-packed:v${UPLOADED_REPLAY_PACKED_VERSION}:${id}`;
}

export function packUploadedReplay(parsed: UploadedReplayParseResult): UploadedReplayPacked {
  return {
    header: parsed.replay.header,
    lifeBarFrames: parsed.replay.lifeBarFrames,
    framesPacked: packReplayFrames(parsed.replay.frames),
    keyCount: parsed.replay.keyCount,
    ...(parsed.replay.stableScrollSpeedScale != null ? { stableScrollSpeedScale: parsed.replay.stableScrollSpeedScale } : {}),
    mods: parsed.mods,
    scoreId: parsed.scoreId,
  };
}

// Same artifact tiering as the description: the memory tier on this instance
// and a gzipped object next to the .osr for the other instances. The artifact
// is only written where uploads themselves go to R2, so a development upload
// leaves nothing in the shared bucket.
async function persistPacked(id: string, stored: StoredPackedUpload): Promise<void> {
  if (!uploadedReplaysUseR2()) return;
  await putJsonArtifact(getUploadedReplayPackedStorageKey(UPLOADED_REPLAY_PACKED_VERSION, id), stored);
}

// Upload-time seed: the POST has just parsed the file for validation, so the
// share link's first open finds the packed replay already there.
export async function persistUploadedReplayPacked(id: string, replay: UploadedReplayPacked, filename: string | null): Promise<void> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return;
  await persistPacked(normalized, { replay, filename });
}

// Node Buffers can be a view over a larger pooled ArrayBuffer, so copy out the
// exact bytes before handing them to the osu! replay decoder.
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export async function readUploadedReplayPacked(id: string): Promise<StoredPackedUpload | null> {
  const normalized = normalizeUploadedReplayId(id);
  if (!normalized) return null;
  return fetchWithCacheLock<StoredPackedUpload | null>(packedCacheKey(normalized), PACKED_CACHE_TTL, async () => {
    const artifact = await getJsonArtifact<StoredPackedUpload>(
      getUploadedReplayPackedStorageKey(UPLOADED_REPLAY_PACKED_VERSION, normalized),
    );
    if (artifact?.replay?.framesPacked) return artifact;

    const stored = await readUploadedReplay(normalized);
    if (!stored) return null;
    let parsed: UploadedReplayParseResult;
    try {
      parsed = await parseUploadedReplayBuffer(toArrayBuffer(stored.buffer));
    } catch {
      return null;
    }
    const packed: StoredPackedUpload = { replay: packUploadedReplay(parsed), filename: stored.originalFilename ?? null };
    await persistPacked(normalized, packed).catch(() => {});
    return packed;
  }, PACKED_LOCK_TTL_MS);
}

async function lookupBeatmapMeta(checksum: string): Promise<BeatmapChecksumLookupResult | null> {
  if (!/^[a-f0-9]{32}$/i.test(checksum)) return null;
  // The proxy caches successful responses only. Keep confirmed misses here
  // too, so reopening an unlisted replay doesn't queue another osu! request.
  // Wrap null because fetchWithCacheLock treats a bare null as a cache miss.
  const { meta } = await fetchWithCacheLock(
    `uploaded-replay-beatmap:v1:${checksum.toLowerCase()}`,
    BEATMAP_LOOKUP_CACHE_TTL_MS,
    async (): Promise<{ meta: BeatmapChecksumLookupResult | null }> => {
      try {
        const lookup = await osuFetch<BeatmapChecksumLookupResult>(
          "/beatmaps/lookup",
          { checksum },
          { caller: "uploadedReplayBeatmap", cacheTtlMs: 10 * 60 * 1000, expectedStatuses: [404] },
        );
        return { meta: lookup && Number.isFinite(lookup.id) && lookup.id > 0 ? lookup : null };
      } catch (error) {
        // Only a confirmed 404 is a missing map. Outages stay retryable and
        // must not be cached as a map the viewer has to supply.
        if (error instanceof Error && error.message.includes("] 404 ")) return { meta: null };
        throw error;
      }
    },
  );
  return meta;
}

async function readCommunityCopy(checksum: string): Promise<UploadedReplayBeatmapResolution["community"]> {
  const content = await withTimeout(
    getCommunityBeatmapFile(checksum),
    COMMUNITY_LOOKUP_TIMEOUT_MS,
    "Community beatmap lookup timed out",
  ).catch(() => null);
  // Asset probes cannot make a missing chart playable; don't wait for them
  // before showing the local map prompt. Never cache this miss: a contributor
  // can supply the chart at any time, even while the osu! miss is cached.
  if (!content) return null;
  const assets = await withTimeout(
    getCommunityBeatmapAssets(checksum),
    COMMUNITY_LOOKUP_TIMEOUT_MS,
    "Community beatmap asset lookup timed out",
  ).catch(() => ({ audio: false, background: false }));
  return { content, assets };
}

// The chart for a replay's checksum, as far as the server can take it. A
// contributed copy is only read when osu!'s is missing or is another revision:
// it is keyed by this exact checksum, so in those cases it is strictly better.
export async function resolveUploadedReplayBeatmap(checksum: string): Promise<UploadedReplayBeatmapResolution> {
  const meta = await lookupBeatmapMeta(checksum);
  let file: UploadedReplayBeatmapResolution["file"] = null;
  if (meta) {
    try {
      const result = await fetchBeatmapFileWithMeta(meta.id, meta.beatmapset_id ?? meta.beatmapset?.id ?? null, checksum);
      file = { content: result.content, cacheStatus: result.cacheStatus, checksumMatched: result.checksumMatched };
    } catch {
      file = null;
    }
  }
  const community = !meta || !file || file.checksumMatched === false ? await readCommunityCopy(checksum) : null;
  return { meta, file, community };
}
