import type { CommunityBeatmapAssets } from "./community-beatmap-store";
import type { BeatmapChecksumLookupResult } from "./osu/replay";
import { unpackReplayFrames } from "./replay-frames";
import type { PackedReplayFrames } from "./replay-pack";
import type { ServerReplay } from "./replay-types";
import type { UploadedReplayParseResult } from "./replay-upload";
import type { OsuMod } from "./types";
import type { UploadedReplayDescription } from "./uploaded-replay-describe";

// The wire shape an uploaded replay travels in, shared by the upload response
// and the share-link open call. Everything the viewer needs arrives in one
// round trip: the replay already parsed and packed server-side (the same
// packing ingested replays use, so the browser never loads the .osr decoder),
// and the chart resolved as far as the server could take it. Isomorphic on
// purpose: the client unpacks here, the server packs in uploaded-replay-open.

// Bump when the packed shape changes; every artifact re-parses its .osr once.
// Mirror any bump in UPLOADED_REPLAY_PACKED_VERSIONS (r2-cache.ts) so deletes
// sweep the old artifacts too.
export const UPLOADED_REPLAY_PACKED_VERSION = 1;

export type UploadedReplayPacked = {
  header: ServerReplay["header"];
  lifeBarFrames: ServerReplay["lifeBarFrames"];
  framesPacked: PackedReplayFrames;
  keyCount: number;
  stableScrollSpeedScale?: number;
  mods: OsuMod[];
  scoreId: number | null;
};

// How far the server got with the replay's chart. `file` is osu!'s copy when
// the checksum is a map osu! knows and the file could be fetched; `community`
// is a contributor's copy, only looked up when the osu! copy is missing or is
// a different revision than the replay was played on. The client decides
// between them with the same rules it always had.
export type UploadedReplayBeatmapResolution = {
  meta: BeatmapChecksumLookupResult | null;
  file: { content: string; cacheStatus: "hit" | "miss"; checksumMatched: boolean | null } | null;
  community: { content: string; assets: CommunityBeatmapAssets } | null;
};

export type UploadedReplayOpenData = {
  id: string;
  filename: string | null;
  replay: UploadedReplayPacked;
  beatmap: UploadedReplayBeatmapResolution;
};

export function unpackUploadedReplay(packed: UploadedReplayPacked): UploadedReplayParseResult {
  return {
    replay: {
      header: packed.header,
      frames: unpackReplayFrames(packed.framesPacked),
      lifeBarFrames: packed.lifeBarFrames ?? [],
      keyCount: packed.keyCount,
      stableScrollSpeedScale: packed.stableScrollSpeedScale,
    },
    mods: packed.mods,
    scoreId: packed.scoreId,
  };
}

// One card of the community lists: an upload's derived description plus who
// uploaded it. The uploader's name is deliberately public: the card names the
// player in the replay, and without the uploader beside it viewers would have
// to assume the two are always the same person.
export type CommunityUploadEntry = UploadedReplayDescription & {
  uploadedAt: number;
  /** Null when the owner index has no row (pre-index upload, or index down). */
  uploadedBy: { userId: number; username: string } | null;
  /** A map osu! doesn't know whose background a contributor supplied; the
   *  card draws it where a submitted map's cover would go. */
  communityBackground: boolean;
};
