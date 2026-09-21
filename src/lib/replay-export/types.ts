// Job, progress, and resource contracts for the local replay video exporter.
//
// Two objects with very different lifetimes live here. `ReplayExportJobView`
// is small, immutable, and safe for React to re-render on: it holds numbers
// and codes, never buffers. `LocalExportResources` holds the retained runtime
// objects (parsed arrays, Blobs, sample bytes, textures) and is owned by the
// manager, which is the only thing allowed to release them.

import type { ManiaNote, ManiaScrollVelocity, ManiaTimingPoint } from "../beatmap-parser";
import type { ReplayHitCounts } from "../replay-validation";
import type { ReplayStoryboardData } from "../storyboard/types";
import type { ReplayFrame, ReplayLifeBarFrame } from "../types";
import type { ReplayLeaderboardEntry, ReplayLeaderboardOptions } from "../replay-leaderboard";
import type { ReplayExportErrorCode } from "./errors";
import type { ReplayExportDestinationKind } from "./limits";
import type { ReplayExportSpecV1 } from "./render-spec";
import type { ReplayExportCapture } from "./snapshot";

export type ReplayExportPhase =
  | "preparing"
  | "rendering"
  | "finalizing"
  | "ready"
  | "saved-to-file"
  | "download-started"
  | "cancelling"
  | "cancelled"
  | "failed";

/** Phases where producers are still running and cancellation does something. */
export const ACTIVE_EXPORT_PHASES: ReadonlySet<ReplayExportPhase> = new Set<ReplayExportPhase>([
  "preparing",
  "rendering",
  "finalizing",
  "cancelling",
]);

export type ReplayExportWarningCode =
  | "audio-decode-skipped"
  | "hidden-while-exporting"
  | "container-fallback";

/**
 * What the UI subscribes to. Deliberately free of Blobs, handles, renderers,
 * and anything else whose identity changes every frame: pushing one of those
 * through React is what makes a progress panel expensive.
 */
export type ReplayExportJobView = {
  id: string;
  phase: ReplayExportPhase;
  /** 0-1 across the whole job, weighted across preparation/render/finalize. */
  progress: number;
  framesCompleted: number;
  frameCount: number;
  /** Output seconds of audio mixed so far. */
  audioSecondsProcessed: number;
  outputDurationSeconds: number;
  /** Highest byte offset written, where the destination can report it. */
  bytesWritten: number;
  estimatedBytes: number;
  /** Milliseconds the job has spent in an active phase. */
  elapsedMs: number;
  destination: ReplayExportDestinationKind;
  container: "mp4" | "webm";
  hasAudio: boolean;
  warnings: ReplayExportWarningCode[];
  errorCode: ReplayExportErrorCode | null;
  /** Populated once the output exists; a local file or Blob, never a URL. */
  result: ReplayExportResultView | null;
  /** Replay label for the panel; no identifiers beyond what the page shows. */
  title: string;
  filename: string;
};

export type ReplayExportResultView = {
  kind: "file" | "blob";
  filename: string;
  byteLength: number;
  /** Object URL for the Blob path only; the file path never has one. */
  downloadUrl: string | null;
  mimeType: string;
};

export type ReplayExportLeaderboardEntry = ReplayLeaderboardEntry;

/**
 * The job's own copy of every input byte. Anything in here is retained by the
 * manager for the job's lifetime: the replay route may unmount, revoke its own
 * object URLs, swap skins, or load another replay without touching these.
 */
export type LocalExportResources = {
  replayFrames: ReplayFrame[];
  lifeBarFrames: ReplayLifeBarFrame[];
  notes: ManiaNote[];
  timingPoints: ManiaTimingPoint[] | undefined;
  scrollVelocities: ManiaScrollVelocity[] | undefined;
  expectedCounts: ReplayHitCounts | undefined;
  realTotalScore: number | undefined;
  initialCombo: number;
  leaderboard: ReplayExportLeaderboardEntry[];
  leaderboardPlayerName: string;
  leaderboardOptions?: ReplayLeaderboardOptions;
  storyboard: ReplayStoryboardData | null;
  /** Encoded song bytes the job owns, independent of the viewer's audio tag. */
  songFile: Blob | null;
  /** Background source the compositor draws under the playfield. */
  backgroundImage: ImageBitmap | HTMLImageElement | null;
  /**
   * Raw hitsound bytes keyed exactly as `ReplayHitsoundPlayer` keys them
   * (`beatmap:`/`skin:`/`default:` prefixes), so the offline mixer resolves a
   * play through the same precedence the viewer uses.
   */
  hitsoundSamples: Map<string, ArrayBuffer>;
  /** Releases every handle this job holds. Idempotent. */
  release: () => void;
};

export type ReplayExportDestinationTarget =
  | { kind: "file"; handle: FileSystemFileHandle }
  | { kind: "buffer" };

export type ReplayExportStartRequest = {
  spec: ReplayExportSpecV1;
  /** Captured viewer state; its bytes are taken during the preparing phase. */
  capture: ReplayExportCapture;
  target: ReplayExportDestinationTarget;
  title: string;
};

export type ReplayExportSubscriber = (view: ReplayExportJobView | null) => void;
