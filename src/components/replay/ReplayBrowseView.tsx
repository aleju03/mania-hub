import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Link2, LoaderCircle, Upload } from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { avatarImageSrc } from "#/components/ui/Avatar";
import { GradeImg } from "#/components/ui/GradeImg";
import { getManiaJudgementStats } from "#/components/ui/ManiaJudgementStats";
import { ModBadge } from "#/components/ui/ModBadge";
import { SearchInput } from "#/components/ui/SearchInput";
import { ReplayRecentlyViewed } from "#/components/replay/ReplayRecentlyViewed";
import { ReplaySideBySidePicker } from "#/components/replay/ReplaySideBySidePicker";
import { displayCountryName } from "#/lib/country";
import { useLocale } from "#/lib/locale-context";
import { formatAccuracy, formatNumber, formatPP, formatTimeAgo, formatTimeAgoTooltip } from "#/lib/format";
import { getDisplayedAccuracy, getDisplayedRank, getModDisplayList, getScoreTimestamp, scoreHasReplay, withModRate } from "#/lib/score";
import { getReplayScoreAvailability } from "#/lib/replay-score-availability";
import { searchBeatmaps, getUserBeatmapScores } from "#/lib/osu";
import { filterBeatmapSearchResults } from "#/lib/beatmap-search";
import { recentReplayUploadKey, type RecentReplayEntry } from "#/lib/replay-recent";
import { useAuth } from "#/lib/auth-context";
import { getRecentCommunityUploads, type CommunityUploadEntry } from "#/lib/uploaded-replay-community";
import type { BeatmapScoreLookupStatus, OsuBeatmap, OsuBeatmapset, OsuScore } from "#/lib/types";

export type ReplayBrowseMode = "player" | "beatmap" | "side-by-side" | "upload";

// "beatmap" is reachable by link only (opening a score from the maps search),
// so it has no tab of its own.
const BROWSE_TABS: { mode: ReplayBrowseMode; label: ReturnType<typeof msg> }[] = [
  { mode: "player", label: msg`By Player` },
  { mode: "side-by-side", label: msg`Side by Side` },
  { mode: "upload", label: msg`Upload` },
];
type PlayerReplaySectionKey = "pinned" | "best" | "firsts" | "recent";
type PlayerScoreGroups = { best: OsuScore[]; firsts: OsuScore[]; pinned: OsuScore[]; recent: OsuScore[] };
type PlayerScoreLoadingByGroup = Record<PlayerReplaySectionKey, boolean>;

const PLAYER_REPLAY_SECTIONS: { key: PlayerReplaySectionKey; label: ReturnType<typeof msg> }[] = [
  { key: "pinned", label: msg`Pinned` },
  { key: "best", label: msg`Best Scores` },
  { key: "firsts", label: msg`First Places` },
  { key: "recent", label: msg`Recent Plays` },
];
const PLAYER_BEATMAP_SEARCH_MIN_LENGTH = 3;
const PLAYER_BEATMAP_SEARCH_DEBOUNCE_MS = 650;

interface ReplayBrowseViewProps {
  mode: ReplayBrowseMode;
  error: string | null;
  selectedCountry: string;
  onModeChange: (mode: ReplayBrowseMode) => void;
  onUploadReplay: (file: File) => void;
  onStartSideBySide: (leftScoreId: number, rightScoreId: number) => void;
  onPlayerSearch: (query: string) => Promise<{ id: number; username: string; avatar_url: string; country_code: string }[]>;
  onSelectPlayer: (user: { id: number; username: string }) => void;
  onPlayerSearchSubmit: (query: string) => void;
  onPlayerQueryChange: (query: string) => void;
  playerSearchScoreId: number | null;
  scorePreview: OsuScore | null;
  scorePreviewLoading: boolean;
  scorePreviewError: string | null;
  onOpenScorePreview: () => void;
  loadingScores: boolean;
  playerScoreGroups: PlayerScoreGroups | null;
  playerScoreLoadingByGroup: PlayerScoreLoadingByGroup;
  playerLookupUserId: number | null;
  playerParam?: string;
  suggestionPlayers: {
    id: number;
    username: string;
    avatar_url: string;
    // Optional: a freshly-seen player may have no stored cover, and global_rank
    // can be missing too.
    cover_url?: string;
    global_rank?: number;
  }[];
  onOpenPlayerScore: (score: OsuScore) => void;
  beatmapQuery: string;
  beatmapResults: OsuBeatmapset[];
  beatmapSearchLoading: boolean;
  selectedBeatmapset: OsuBeatmapset | null;
  selectedDiffId: number | null;
  beatmapScores: OsuScore[];
  visibleRawBeatmapScores: OsuScore[];
  loadingBeatmapScores: boolean;
  beatmapScorePage: number;
  beatmapScoreLookupStatus: BeatmapScoreLookupStatus | null;
  onBeatmapQueryChange: (query: string) => void;
  onSelectBeatmapset: (beatmapset: OsuBeatmapset) => void;
  onSelectDifficulty: (beatmap: OsuBeatmap) => void;
  onOpenBeatmapScore: (score: OsuScore) => void;
  onLoadMoreBeatmapScores: () => void;
  recentReplays: RecentReplayEntry[];
  onOpenRecentReplay: (entry: RecentReplayEntry) => void;
  onRemoveRecentReplay: (key: string) => void;
  onClearRecentReplays: () => void;
}

export function ReplayBrowseView({
  mode,
  error,
  selectedCountry,
  onModeChange,
  onUploadReplay,
  onStartSideBySide,
  onPlayerSearch,
  onSelectPlayer,
  onPlayerSearchSubmit,
  onPlayerQueryChange,
  playerSearchScoreId,
  scorePreview,
  scorePreviewLoading,
  scorePreviewError,
  onOpenScorePreview,
  loadingScores,
  playerScoreGroups,
  playerScoreLoadingByGroup,
  playerLookupUserId,
  playerParam,
  suggestionPlayers,
  onOpenPlayerScore,
  beatmapQuery,
  beatmapResults,
  beatmapSearchLoading,
  selectedDiffId,
  beatmapScores,
  visibleRawBeatmapScores,
  loadingBeatmapScores,
  beatmapScorePage,
  beatmapScoreLookupStatus,
  onBeatmapQueryChange,
  onSelectBeatmapset,
  onSelectDifficulty,
  onOpenBeatmapScore,
  onLoadMoreBeatmapScores,
  recentReplays,
  onOpenRecentReplay,
  onRemoveRecentReplay,
  onClearRecentReplays,
}: ReplayBrowseViewProps) {
  const { i18n } = useLingui();
  return (
    <motion.div key="browse" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="flex justify-center mb-3">
        <div className="flex bg-osu-b4 rounded-lg border border-osu-b3/50 overflow-hidden">
          {BROWSE_TABS.map((tab) => (
            <button
              key={tab.mode}
              onClick={() => onModeChange(tab.mode)}
              className={`px-4 py-2 text-xs font-semibold uppercase tracking-wider cursor-pointer transition-colors sm:px-5 ${
                mode === tab.mode
                  ? "bg-osu-pink/20 text-osu-pink-light"
                  : "text-osu-f1 hover:text-white"
              }`}
            >
              {i18n._(tab.label)}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-xs text-osu-red-light bg-osu-red/10 px-4 py-2 rounded-lg text-center max-w-lg mx-auto mb-6">{error}</motion.p>
      )}

      {mode === "player" && (
        <PlayerReplayBrowser
          selectedCountry={selectedCountry}
          onPlayerSearch={onPlayerSearch}
          onSelectPlayer={onSelectPlayer}
          onPlayerSearchSubmit={onPlayerSearchSubmit}
          onPlayerQueryChange={onPlayerQueryChange}
          playerSearchScoreId={playerSearchScoreId}
          scorePreview={scorePreview}
          scorePreviewLoading={scorePreviewLoading}
          scorePreviewError={scorePreviewError}
          onOpenScorePreview={onOpenScorePreview}
          loadingScores={loadingScores}
          playerScoreGroups={playerScoreGroups}
          playerScoreLoadingByGroup={playerScoreLoadingByGroup}
          playerLookupUserId={playerLookupUserId}
          playerParam={playerParam}
          suggestionPlayers={suggestionPlayers}
          hasError={!!error}
          onOpenPlayerScore={onOpenPlayerScore}
          recentReplays={recentReplays}
          onOpenRecentReplay={onOpenRecentReplay}
          onRemoveRecentReplay={onRemoveRecentReplay}
          onClearRecentReplays={onClearRecentReplays}
        />
      )}

      {mode === "beatmap" && (
        <BeatmapReplayBrowser
          selectedCountry={selectedCountry}
          beatmapQuery={beatmapQuery}
          beatmapResults={beatmapResults}
          beatmapSearchLoading={beatmapSearchLoading}
          selectedDiffId={selectedDiffId}
          beatmapScores={beatmapScores}
          visibleRawBeatmapScores={visibleRawBeatmapScores}
          loadingBeatmapScores={loadingBeatmapScores}
          beatmapScorePage={beatmapScorePage}
          beatmapScoreLookupStatus={beatmapScoreLookupStatus}
          onBeatmapQueryChange={onBeatmapQueryChange}
          onSelectBeatmapset={onSelectBeatmapset}
          onSelectDifficulty={onSelectDifficulty}
          onOpenBeatmapScore={onOpenBeatmapScore}
          onLoadMoreBeatmapScores={onLoadMoreBeatmapScores}
        />
      )}

      {mode === "side-by-side" && (
        <ReplaySideBySidePicker recentReplays={recentReplays} onStart={onStartSideBySide} />
      )}

      {mode === "upload" && (
        <UploadReplayBrowser onUploadReplay={onUploadReplay} onOpenRecentReplay={onOpenRecentReplay} />
      )}
    </motion.div>
  );
}

type UploadBgTriangle = { points: string; opacity: number };

// The osu! triangle motif as a deliberate composition rather than scattered noise:
// a handful of large interlocking triangles, up and down, whose vertices all sit on
// one equilateral grid (side 256, height 222) so their edges line up cleanly. A few
// flat pink tones give depth; large shapes are listed first so they render behind.
const UPLOAD_BG_TRIANGLES: UploadBgTriangle[] = [
  // Large shapes that bleed off the edges and anchor the composition.
  { points: "128,-90 -128,354 384,354", opacity: 0.09 },
  { points: "256,-90 768,-90 512,354", opacity: 0.09 },
  // Mid shapes: the readable interlocking triangles.
  { points: "128,-90 0,132 256,132", opacity: 0.2 },
  { points: "384,-90 256,132 512,132", opacity: 0.11 },
  { points: "512,132 384,-90 640,-90", opacity: 0.16 },
  { points: "256,354 128,132 384,132", opacity: 0.15 },
  { points: "640,132 512,354 768,354", opacity: 0.18 },
  { points: "0,354 -128,132 128,132", opacity: 0.12 },
  // Small accents subdividing otherwise-empty cells, for scale variety.
  { points: "192,21 320,21 256,132", opacity: 0.2 },
  { points: "384,132 320,243 448,243", opacity: 0.17 },
];

// The same card shape ReplayRecentlyViewed renders, built from an uploaded
// replay's derived description instead of local watch history. viewedAt is
// repurposed as the upload time, which is exactly what the card's "x ago"
// column should read here.
function communityUploadToRecentEntry(upload: CommunityUploadEntry, unknownBeatmap: string): RecentReplayEntry {
  return {
    key: recentReplayUploadKey(upload.id),
    uploadId: upload.id,
    beatmapsetId: upload.beatmap?.beatmapsetId ?? undefined,
    title: upload.beatmap?.title || upload.originalFilename || unknownBeatmap,
    artist: upload.beatmap?.artist || undefined,
    version: upload.beatmap?.version || undefined,
    keyCount: upload.keyCount,
    playerName: upload.playerName,
    coverUrl: upload.beatmap?.beatmapsetId
      ? `https://assets.ppy.sh/beatmaps/${upload.beatmap.beatmapsetId}/covers/list.jpg`
      : undefined,
    grade: upload.grade,
    accuracy: upload.accuracy,
    mods: withModRate(upload.mods, upload.modRate),
    viewedAt: upload.uploadedAt,
    uploadedBy: upload.uploadedBy ?? undefined,
  };
}

// Survives tab switches so leaving Upload and coming back doesn't refetch;
// the server function caches the expensive part, this only skips the round trip.
let communityUploadsCache: { entries: RecentReplayEntry[]; fetchedAt: number } | null = null;
const COMMUNITY_UPLOADS_CLIENT_TTL = 60 * 1000;

// Drop-your-own-file plus what everyone else dropped: the tab is about
// uploaded replays, so recent community uploads belong here (unlike the
// watched-from-osu! history, which answers a different question).
function UploadReplayBrowser({
  onUploadReplay,
  onOpenRecentReplay,
}: Pick<ReplayBrowseViewProps, "onUploadReplay" | "onOpenRecentReplay">) {
  const { t } = useLingui();
  const auth = useAuth();
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [communityUploads, setCommunityUploads] = useState<RecentReplayEntry[]>(
    () => communityUploadsCache?.entries ?? [],
  );
  // Skeleton gate: only the very first fetch has nothing to show; a stale
  // cache keeps rendering its entries while the refresh runs behind them.
  const [communityUploadsLoading, setCommunityUploadsLoading] = useState(() => communityUploadsCache === null);

  useEffect(() => {
    if (communityUploadsCache && Date.now() - communityUploadsCache.fetchedAt < COMMUNITY_UPLOADS_CLIENT_TTL) return;
    let cancelled = false;
    getRecentCommunityUploads()
      .then((result) => {
        const entries = result.uploads.map((upload) => communityUploadToRecentEntry(upload, t`Unknown beatmap`));
        communityUploadsCache = { entries, fetchedAt: Date.now() };
        if (!cancelled) setCommunityUploads(entries);
      })
      .catch(() => {
        // The drop zone is the tab's job; the community list is a bonus.
      })
      .finally(() => {
        if (!cancelled) setCommunityUploadsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    onUploadReplay(file);
    if (inputRef.current) inputRef.current.value = "";
  }, [onUploadReplay]);

  return (
    <div>
      <div className="mx-auto max-w-xl">
        <h3 className="mb-3 text-center text-sm font-semibold uppercase tracking-wider text-osu-f1">
          <Trans>Drop your own .osr file</Trans>
        </h3>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            handleFiles(event.dataTransfer.files);
          }}
          className={`relative block w-full overflow-hidden rounded-xl border transition-colors cursor-pointer ${
            dragActive
              ? "border-osu-pink/70 bg-osu-b5"
              : "border-osu-b3/60 bg-osu-b4 hover:border-osu-pink/45"
          }`}
        >
          <svg
            viewBox="0 0 640 260"
            preserveAspectRatio="xMidYMid slice"
            className={`pointer-events-none absolute inset-0 h-full w-full transition-[color,opacity] duration-150 ${
              dragActive ? "text-osu-pink-light opacity-100" : "text-osu-pink opacity-80"
            }`}
            aria-hidden="true"
          >
            {UPLOAD_BG_TRIANGLES.map((triangle, index) => (
              <polygon
                key={index}
                points={triangle.points}
                fill="currentColor"
                fillOpacity={triangle.opacity}
              />
            ))}
          </svg>

          <div className="relative z-10 flex min-h-[244px] flex-col items-center justify-center gap-2.5 px-6 py-12 text-center">
            <Upload
              className={`h-8 w-8 transition-colors ${dragActive ? "text-osu-pink-light" : "text-osu-f1"}`}
              aria-hidden="true"
            />
            <div>
              <div className="text-sm font-semibold text-white">
                {dragActive ? t`Drop to load it` : t`Drag an .osr here, or click to browse`}
              </div>
              <div className="mt-1 text-[11px] text-osu-f1"><Trans>osu!mania replays only</Trans></div>
            </div>
          </div>
        </button>

        <input
          ref={inputRef}
          type="file"
          accept=".osr,application/octet-stream"
          className="sr-only"
          onChange={(event) => handleFiles(event.target.files)}
        />

        <div className="mt-3 flex items-start justify-center gap-2 text-[11px] text-osu-f1">
          <Link2 className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span><Trans>Uploading gives you a share link for the replay. Sign in with osu! to upload.</Trans></span>
        </div>

        {/* Everything you uploaded lives on its own page, with the deletes. */}
        {(auth.viewer || auth.canUseAdminFeatures) && (
          <div className="mt-4 flex justify-center">
            <Link
              to="/replay/uploads"
              className="inline-flex items-center gap-1 rounded-lg bg-osu-b4 px-3 py-1.5 text-xs font-semibold text-osu-f1 transition-colors hover:bg-osu-b3 hover:text-white"
            >
              <Trans>Your uploads</Trans>
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        )}
      </div>

      {communityUploads.length > 0 ? (
        <ReplayRecentlyViewed
          className="mt-10"
          entries={communityUploads}
          title={t`Recently Uploaded by the Community`}
          showRemove={false}
          onOpen={onOpenRecentReplay}
          onRemove={() => {}}
          onClear={() => {}}
        />
      ) : communityUploadsLoading ? (
        // Placeholder with the section's real header and card footprint, so
        // the community list doesn't pop into an already-settled page.
        <div className="mx-auto mt-10 max-w-5xl">
          <div className="mb-3 flex justify-center">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">
              <Trans>Recently Uploaded by the Community</Trans>
            </h4>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }, (_, index) => (
              <div
                key={index}
                className="h-[57px] animate-pulse rounded-xl border border-osu-b3/20 bg-osu-b4"
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Recovery screen for an uploaded .osr whose beatmap can't be fetched from
// osu! or the mirrors: explains why and takes the map as a local .osz/.osu.
export function MissingBeatmapPanel({
  reason,
  beatmapLabel,
  playerName,
  error,
  loading,
  onPickFile,
  onCancel,
}: {
  reason: "unlisted" | "file-unavailable";
  beatmapLabel: string | null;
  playerName: string;
  error: string | null;
  loading: boolean;
  onPickFile: (file: File) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    onPickFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }, [onPickFile]);

  const mapLabel = beatmapLabel ?? t`this map`;
  const detail = reason === "unlisted"
    ? playerName
      ? t`${playerName}'s replay loaded, but its beatmap isn't on osu! (unsubmitted or deleted), so the chart can't be downloaded.`
      : t`The replay loaded, but its beatmap isn't on osu! (unsubmitted or deleted), so the chart can't be downloaded.`
    : playerName
      ? t`${playerName}'s replay loaded, but the chart file for ${mapLabel} can't be downloaded right now.`
      : t`The replay loaded, but the chart file for ${mapLabel} can't be downloaded right now.`;

  return (
    <div className="mx-auto max-w-xl">
      <h3 className="mb-3 text-center text-sm font-semibold uppercase tracking-wider text-osu-f1">
        <Trans>This replay needs its beatmap</Trans>
      </h3>

      <p className="mb-4 text-center text-xs leading-relaxed text-osu-f1">
        {detail} <Trans>If you have the map, drop its .osz here and the replay plays from your copy.</Trans>
      </p>

      <button
        type="button"
        disabled={loading}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (!loading) handleFiles(event.dataTransfer.files);
        }}
        className={`relative block w-full overflow-hidden rounded-xl border transition-colors ${
          loading
            ? "cursor-wait border-osu-b3/60 bg-osu-b4"
            : dragActive
              ? "cursor-pointer border-osu-pink/70 bg-osu-b5"
              : "cursor-pointer border-osu-b3/60 bg-osu-b4 hover:border-osu-pink/45"
        }`}
      >
        <svg
          viewBox="0 0 640 260"
          preserveAspectRatio="xMidYMid slice"
          className={`pointer-events-none absolute inset-0 h-full w-full transition-[color,opacity] duration-150 ${
            dragActive ? "text-osu-pink-light opacity-100" : "text-osu-pink opacity-80"
          }`}
          aria-hidden="true"
        >
          {UPLOAD_BG_TRIANGLES.map((triangle, index) => (
            <polygon
              key={index}
              points={triangle.points}
              fill="currentColor"
              fillOpacity={triangle.opacity}
            />
          ))}
        </svg>

        <div className="relative z-10 flex min-h-[204px] flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
          {loading ? (
            <LoaderCircle className="h-8 w-8 animate-spin text-osu-pink-light" aria-hidden="true" />
          ) : (
            <Upload
              className={`h-8 w-8 transition-colors ${dragActive ? "text-osu-pink-light" : "text-osu-f1"}`}
              aria-hidden="true"
            />
          )}
          <div>
            <div className="text-sm font-semibold text-white">
              {loading
                ? t`Checking the difficulties`
                : dragActive
                  ? t`Drop to check it`
                  : t`Drag the map's .osz here, or click to browse`}
            </div>
            <div className="mt-1 text-[11px] text-osu-f1">
              {loading ? t`Matching against the replay's checksum.` : t`The exact .osu file works too.`}
            </div>
          </div>
        </div>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".osz,.olz,.osu,.zip,application/octet-stream"
        className="sr-only"
        onChange={(event) => handleFiles(event.target.files)}
      />

      <ExportBeatmapHelp />

      {error && (
        <p className="mt-3 rounded-lg bg-osu-red/10 px-4 py-2 text-center text-xs text-osu-red-light">{error}</p>
      )}

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer text-xs font-semibold text-osu-f1 transition-colors hover:text-white"
        >
          <Trans>Choose a different replay</Trans>
        </button>
      </div>
    </div>
  );
}

// Both clients can hand over a map, but neither calls it the same thing, and
// stable's is buried in the editor - so spell out the exact menu path rather
// than leaving "drop its .osz here" as the only instruction.
function ExportBeatmapHelp() {
  return (
    <div className="mt-5 text-[11px] leading-relaxed text-osu-f1">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-osu-f1">
        <Trans>Getting the map out of osu!</Trans>
      </h4>
      <p className="mb-1.5">
        <Trans>
          <span className="font-semibold text-osu-l2">osu!stable</span> keeps every map as plain files: open
          osu!/Songs, find the map's folder and drag the difficulty's .osu straight in. To get the whole
          thing instead, open the map in the editor and choose File &gt; Export package - the .osz appears
          in osu!/Exports.
        </Trans>
      </p>
      <p>
        <Trans>
          <span className="font-semibold text-osu-l2">osu!lazer</span> stores maps in its own database, so it
          has to export one: right-click the map at song select and choose Export, picking For compatibility
          (.osz) if it offers both. The file lands in the exports folder (Settings &gt; open osu! folder).
        </Trans>
      </p>
    </div>
  );
}

function PlayerReplayBrowser({
  selectedCountry,
  onPlayerSearch,
  onSelectPlayer,
  onPlayerSearchSubmit,
  onPlayerQueryChange,
  playerSearchScoreId,
  scorePreview,
  scorePreviewLoading,
  scorePreviewError,
  onOpenScorePreview,
  loadingScores,
  playerScoreGroups,
  playerScoreLoadingByGroup,
  playerLookupUserId,
  playerParam,
  suggestionPlayers,
  hasError,
  onOpenPlayerScore,
  recentReplays,
  onOpenRecentReplay,
  onRemoveRecentReplay,
  onClearRecentReplays,
}: Pick<ReplayBrowseViewProps,
  "selectedCountry" | "onPlayerSearch" | "onSelectPlayer" | "onPlayerSearchSubmit" | "onPlayerQueryChange" |
  "playerSearchScoreId" | "scorePreview" | "scorePreviewLoading" | "scorePreviewError" | "onOpenScorePreview" |
  "loadingScores" | "playerScoreGroups" | "playerScoreLoadingByGroup" | "playerLookupUserId" | "playerParam" |
  "suggestionPlayers" | "onOpenPlayerScore" | "recentReplays" | "onOpenRecentReplay" | "onRemoveRecentReplay" |
  "onClearRecentReplays"
> & { hasError: boolean }) {
  const { t } = useLingui();
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [activePlayerSection, setActivePlayerSection] = useState<PlayerReplaySectionKey>("pinned");

  const sections = useMemo(
    () => playerScoreGroups
      ? PLAYER_REPLAY_SECTIONS
        .map((section) => ({ ...section, scores: playerScoreGroups[section.key] }))
      : [],
    [playerScoreGroups],
  );

  useEffect(() => {
    setExpandedSections({});
    setActivePlayerSection("pinned");
  }, [playerLookupUserId, playerParam]);

  const hasAnyScores = playerScoreGroups
    ? playerScoreGroups.best.length > 0 || playerScoreGroups.firsts.length > 0 || playerScoreGroups.pinned.length > 0 || playerScoreGroups.recent.length > 0
    : false;
  const hasLoadingScoreSection = Object.values(playerScoreLoadingByGroup).some(Boolean);

  // Keep URL/player-search identity even when the replayable score sections are empty.
  const playerUserId = useMemo(() => {
    if (playerLookupUserId) return playerLookupUserId;
    if (!playerScoreGroups) return null;
    for (const group of [playerScoreGroups.pinned, playerScoreGroups.best, playerScoreGroups.recent, playerScoreGroups.firsts]) {
      if (group.length > 0) return group[0].user_id;
    }
    return null;
  }, [playerLookupUserId, playerScoreGroups]);
  const shouldShowPlayerSections = Boolean(playerScoreGroups && (hasAnyScores || hasLoadingScoreSection || playerUserId || playerParam));

  return (
    <>
      <div className="max-w-lg mx-auto mb-8">
        <h3 className="text-sm font-semibold text-osu-f1 uppercase tracking-wider mb-3 text-center">
          <Trans>Search a player, or paste a score ID</Trans>
        </h3>
        <SearchInput
          placeholder={t`Search player... or score ID`}
          onSearch={onPlayerSearch}
          onSelect={onSelectPlayer}
          onSubmit={onPlayerSearchSubmit}
          onQueryChange={onPlayerQueryChange}
        />
        {playerSearchScoreId && (
          <ScoreInputPreview
            scoreId={playerSearchScoreId}
            score={scorePreview}
            loading={scorePreviewLoading}
            error={scorePreviewError}
            onOpen={onOpenScorePreview}
          />
        )}
      </div>

      {loadingScores && !playerScoreGroups && (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
        </div>
      )}

      {shouldShowPlayerSections && (
        <>
          <PlayerScoreSections
            sections={sections}
            playerScoreLoadingByGroup={playerScoreLoadingByGroup}
            expandedSections={expandedSections}
            activePlayerSection={activePlayerSection}
            onSetActivePlayerSection={setActivePlayerSection}
            onToggleSection={(key) => setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }))}
            onOpenScore={onOpenPlayerScore}
            playerParam={playerParam}
          />
        </>
      )}

      {!hasLoadingScoreSection && playerScoreGroups && !hasAnyScores && (
        <>
          <div className="text-center py-8 text-osu-f1 text-sm">
            <Trans>No replays available for this player</Trans>
          </div>
        </>
      )}

      {playerUserId && playerScoreGroups && (hasAnyScores || !hasLoadingScoreSection) && (
        <PlayerBeatmapLookup
          userId={playerUserId}
          onOpenScore={onOpenPlayerScore}
        />
      )}

      {!loadingScores && !hasLoadingScoreSection && !playerScoreGroups && !hasError && (
        // Once the viewport has room for a rail beside the centred 5xl player
        // grid (512px half-width + gap + rail), the recent list floats out of
        // flow into that gutter, so the grid keeps its width and stays centred.
        // Narrower screens stack it above the grid instead.
        <div className="relative">
          <ReplayRecentlyViewed
            entries={recentReplays}
            onOpen={onOpenRecentReplay}
            onRemove={onRemoveRecentReplay}
            onClear={onClearRecentReplays}
            variant="sidebar"
            className="mb-8 min-[1650px]:absolute min-[1650px]:top-0 min-[1650px]:left-[calc(50%+528px)] min-[1650px]:mb-0 min-[1650px]:w-[280px]"
          />
          {suggestionPlayers.length > 0 ? (
            <PlayerSuggestions
              selectedCountry={selectedCountry}
              suggestionPlayers={suggestionPlayers}
              onSelectPlayer={onSelectPlayer}
            />
          ) : (
            <div className="text-center py-12 text-osu-f1 text-sm">
              <Trans>Search for a player above to browse their available replays</Trans>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function PlayerScoreSections({
  sections,
  playerScoreLoadingByGroup,
  expandedSections,
  activePlayerSection,
  onSetActivePlayerSection,
  onToggleSection,
  onOpenScore,
}: {
  sections: ({ key: PlayerReplaySectionKey; label: ReturnType<typeof msg>; scores: OsuScore[] })[];
  playerScoreLoadingByGroup: PlayerScoreLoadingByGroup;
  expandedSections: Record<string, boolean>;
  activePlayerSection: PlayerReplaySectionKey;
  onSetActivePlayerSection: (section: PlayerReplaySectionKey) => void;
  onToggleSection: (section: PlayerReplaySectionKey) => void;
  onOpenScore: (score: OsuScore) => void;
  playerParam?: string;
}) {
  const { t, i18n } = useLingui();
  if (sections.length === 0) return null;

  const mobileSection = sections.find((section) => section.key === activePlayerSection) ?? sections[0];
  const renderScorePanel = (
    section: typeof sections[number],
    sectionIndex: number,
    extraClassName = "",
    listClassName = "max-h-[370px]",
  ) => {
    const isExpanded = expandedSections[section.key];
    const hasMore = section.scores.length > 5;
    const isSectionLoading = playerScoreLoadingByGroup[section.key] && section.scores.length === 0;
    return (
      <motion.section
        key={section.key}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: sectionIndex * 0.03 }}
        className={`min-w-0 overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4 ${extraClassName}`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-osu-b3/25 bg-osu-b5/35 px-3 py-2.5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-osu-f1">
            {i18n._(section.label)}
          </h4>
          <span className="rounded bg-osu-pink/15 px-2 py-0.5 text-[10px] font-bold tabular-nums text-osu-pink-light">
            {isSectionLoading ? (
              <span className="block h-2.5 w-2.5 animate-spin rounded-full border border-osu-pink/35 border-t-osu-pink-light" />
            ) : section.scores.length}
          </span>
        </div>

        <div className={`replay-score-scroll overflow-x-hidden transition-[max-height] duration-150 ease-out ${isExpanded ? `${listClassName} overflow-y-auto overscroll-contain` : hasMore ? "max-h-[276px] [overflow-y:clip]" : "max-h-none overflow-y-visible"}`}>
          {section.scores.length > 0 ? (
            section.scores.map((score) => (
              <button
                key={score.id}
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors cursor-pointer hover:bg-osu-b3/65 focus:outline-none focus-visible:bg-osu-b3/65"
                onClick={() => onOpenScore(score)}
              >
                <GradeImg grade={getDisplayedRank(score)} size={24} />
                {score.beatmapset?.covers?.list && (
                  <img src={score.beatmapset.covers.list} alt="" className="h-8 w-12 flex-shrink-0 rounded object-cover" loading="lazy" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-white">{score.beatmapset?.title}</div>
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="truncate text-[10px] text-osu-f1">[{score.beatmap?.version}] {score.beatmap?.cs && `${score.beatmap.cs}K`}</div>
                    <ScoreModBadges score={score} className="hidden shrink-0 gap-0.5 sm:flex" hideWhenEmpty />
                  </div>
                  <ScoreModBadges score={score} className="mt-1 flex gap-0.5 sm:hidden" hideWhenEmpty />
                </div>
                <div className="hidden shrink-0 text-right sm:block">
                  <div className="text-xs font-semibold text-osu-l2">{formatAccuracy(getDisplayedAccuracy(score))}</div>
                  <div className="text-sm font-bold text-white">{formatPP(score.pp)}</div>
                </div>
                <div className="shrink-0 text-sm font-bold text-white sm:hidden">{formatPP(score.pp)}</div>
              </button>
            ))
          ) : (
            <div className="flex min-h-[156px] flex-col items-center justify-center gap-2 px-4 py-8 text-center text-xs text-osu-f1">
              {isSectionLoading ? (
                <>
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-osu-pink/40 border-t-osu-pink" />
                  <span><Trans>Loading scores...</Trans></span>
                </>
              ) : (
                <span><Trans>No replayable scores here</Trans></span>
              )}
            </div>
          )}
        </div>

        {hasMore && (
          <button
            onClick={() => onToggleSection(section.key)}
            className="replay-score-action w-full bg-osu-b5/25 px-3 py-2 text-xs font-semibold text-osu-f1 outline-none transition-colors cursor-pointer hover:bg-osu-b3/50 hover:text-white focus:outline-none focus-visible:bg-osu-b3/50 focus-visible:text-white active:outline-none"
          >
            {isExpanded ? t`Collapse` : t`Show ${section.scores.length - 5} More`}
          </button>
        )}
      </motion.section>
    );
  };

  return (
    <>
      <div className="sm:hidden">
        <div className="-mx-3 overflow-x-auto px-3 pb-2">
          <div className="flex min-w-max gap-1.5">
            {sections.map((section) => (
              <button
                key={section.key}
                type="button"
                onClick={() => onSetActivePlayerSection(section.key)}
                className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                  mobileSection.key === section.key
                    ? "bg-osu-pink/25 text-osu-pink-light"
                    : "bg-osu-b4 text-osu-f1 hover:bg-osu-b3 hover:text-white"
                }`}
              >
                {i18n._(section.label)}
                <span className="ml-1.5 text-[10px] opacity-70">{section.scores.length}</span>
              </button>
            ))}
          </div>
        </div>
        <AnimatePresence mode="wait">
          {renderScorePanel(mobileSection, 0, "", "max-h-[58dvh]")}
        </AnimatePresence>
      </div>

      <div className="hidden gap-3 sm:grid lg:grid-cols-2">
        {sections.map((section, sectionIndex) => {
          const shouldSpan = sections.length % 2 === 1 && sectionIndex === sections.length - 1;
          return renderScorePanel(section, sectionIndex, shouldSpan ? "lg:col-span-2" : "");
        })}
      </div>
    </>
  );
}

function PlayerBeatmapLookup({
  userId,
  onOpenScore,
}: {
  userId: number;
  onOpenScore: (score: OsuScore) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OsuBeatmapset[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedDiffId, setSelectedDiffId] = useState<number | null>(null);
  const [playerScores, setPlayerScores] = useState<OsuScore[]>([]);
  const [loadingScores, setLoadingScores] = useState(false);
  const [scoresLoaded, setScoresLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRequestRef = useRef(0);
  const scoreRequestRef = useRef(0);
  const lastSearchedQueryRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on player change
  useEffect(() => {
    searchRequestRef.current += 1;
    scoreRequestRef.current += 1;
    setQuery("");
    setResults([]);
    setSearching(false);
    setSelectedDiffId(null);
    setPlayerScores([]);
    setLoadingScores(false);
    setScoresLoaded(false);
  }, [userId]);

  // Debounced beatmap search
  useEffect(() => {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    if (normalizedQuery.length < PLAYER_BEATMAP_SEARCH_MIN_LENGTH) {
      searchRequestRef.current += 1;
      lastSearchedQueryRef.current = "";
      setResults([]);
      setSearching(false);
      setSelectedDiffId(null);
      setPlayerScores([]);
      setScoresLoaded(false);
      return;
    }
    if (normalizedQuery === lastSearchedQueryRef.current) return;
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setSearching(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      lastSearchedQueryRef.current = normalizedQuery;
      try {
        const res = await searchBeatmaps({ data: { query: normalizedQuery, sort: "relevance_desc" } });
        if (searchRequestRef.current !== requestId) return;
        setResults(filterBeatmapSearchResults(res.beatmapsets, normalizedQuery).slice(0, 8));
      } catch {
        if (searchRequestRef.current !== requestId) return;
        setResults([]);
      } finally {
        if (searchRequestRef.current === requestId) setSearching(false);
      }
    }, PLAYER_BEATMAP_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  // Reset diff selection when results change
  useEffect(() => {
    setSelectedDiffId(null);
    setPlayerScores([]);
    setScoresLoaded(false);
  }, [results]);

  const handleSelectDiff = useCallback(async (beatmapId: number) => {
    const requestId = scoreRequestRef.current + 1;
    scoreRequestRef.current = requestId;
    setSelectedDiffId(beatmapId);
    setPlayerScores([]);
    setScoresLoaded(false);
    setLoadingScores(true);
    try {
      const scores = await getUserBeatmapScores({ data: { beatmapId, userId } });
      if (scoreRequestRef.current !== requestId) return;
      setPlayerScores(scores);
    } catch {
      if (scoreRequestRef.current !== requestId) return;
      setPlayerScores([]);
    } finally {
      if (scoreRequestRef.current === requestId) {
        setLoadingScores(false);
        setScoresLoaded(true);
      }
    }
  }, [userId]);

  const replayableScores = useMemo(() => playerScores.filter((s) => scoreHasReplay(s)), [playerScores]);
  const renderSelectedScores = () => (
    <div className="relative border-t border-osu-b3/25 bg-osu-b4">
      {loadingScores ? (
        <div className="flex items-center justify-center gap-2 py-4">
          <div className="w-4 h-4 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
          <span className="text-xs text-osu-f1"><Trans>Checking scores...</Trans></span>
        </div>
      ) : scoresLoaded && replayableScores.length > 0 ? (
        <div>
          <div className="px-4 py-2 bg-osu-b5/30 border-b border-osu-b3/15">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
              <Plural value={replayableScores.length} one="# replay available" other="# replays available" />
            </span>
          </div>
          {replayableScores.map((score) => (
            <PlayerBeatmapScoreRow key={score.id} score={score} onOpen={() => onOpenScore(score)} />
          ))}
          {playerScores.length > replayableScores.length && (
            <div className="px-4 py-2 text-[10px] text-osu-f1/80 bg-osu-b5/10 border-t border-osu-b3/10">
              <Plural
                value={playerScores.length - replayableScores.length}
                one="# other score found, but no replay is available"
                other="# other scores found, but no replay is available"
              />
            </div>
          )}
        </div>
      ) : scoresLoaded ? (
        <div className="text-center py-4 text-osu-f1 text-xs">
          <Trans>No scores on this difficulty</Trans>
        </div>
      ) : null}
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="mt-6 rounded-xl border border-osu-b3/20 bg-osu-b4/50 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-osu-b3/25 bg-osu-b5/50 px-4 py-3">
        <svg className="w-4 h-4 text-osu-f1 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-osu-f1"><Trans>Beatmap Lookup</Trans></h4>
      </div>

      {/* Search input */}
      <div className="px-4 py-3">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t`Search any beatmap by title, artist, or mapper...`}
            className="w-full px-3.5 py-2 rounded-lg bg-osu-b5 text-sm text-osu-l2 placeholder:text-osu-f1 border border-osu-b3/30 focus:border-osu-h1/40 focus:outline-none transition-colors duration-[120ms] shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)]"
          />
          {searching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-3.5 h-3.5 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
            </div>
          )}
          {!searching && query && (
            <button
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-osu-f1 hover:text-white hover:bg-osu-b3/50 transition-colors cursor-pointer"
              aria-label={t`Clear search`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="border-t border-osu-b3/15">
          {results.map((beatmapset) => {
            const maniaDiffs = (beatmapset.beatmaps ?? [])
              .filter((bm) => bm.mode === "mania")
              .sort((a, b) => a.cs - b.cs || a.difficulty_rating - b.difficulty_rating);
            const coverUrl = beatmapset.covers?.["cover@2x"] || beatmapset.covers?.cover;
            const isActive = maniaDiffs.some((bm) => bm.id === selectedDiffId);
            return (
              <div
                key={beatmapset.id}
                className={`relative overflow-hidden transition-colors ${
                  isActive ? "bg-osu-b3/30" : "hover:bg-osu-b3/15"
                }`}
              >
                {coverUrl && (
                  <img src={coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover opacity-[0.08]" loading="lazy" />
                )}
                <div className="relative px-4 py-2.5">
                  <div className="mb-1.5">
                    <div className="text-sm font-medium text-white truncate">{beatmapset.title}</div>
                    <div className="text-[10px] text-osu-f1 truncate">{beatmapset.artist} // {beatmapset.creator}</div>
                  </div>
                  {maniaDiffs.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {maniaDiffs.map((bm) => (
                        <button
                          key={bm.id}
                          onClick={() => handleSelectDiff(bm.id)}
                          className={`px-2 py-0.5 rounded text-[10px] cursor-pointer transition-colors border ${
                            selectedDiffId === bm.id
                              ? "bg-osu-pink/25 border-osu-pink/50 text-white"
                              : "bg-osu-b5/50 hover:bg-osu-b5/80 border-osu-b3/20 text-white/80"
                          }`}
                        >
                          <span className="text-osu-yellow font-semibold">{bm.cs}K</span>{" "}
                          <span className="opacity-70">{bm.version.replace(/\s*\[\d+[Kk]\]\s*/g, " ").trim()}</span>{" "}
                          <span className="text-osu-l2">&#9733;{bm.difficulty_rating.toFixed(2)}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-osu-f1"><Trans>No mania difficulties</Trans></div>
                  )}
                </div>
                {isActive && selectedDiffId && renderSelectedScores()}
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {query.trim().length < PLAYER_BEATMAP_SEARCH_MIN_LENGTH && (
        <div className="px-4 pb-3 text-center text-[11px] text-osu-f1">
          <Trans>Search for any beatmap to see this player's scores on it</Trans>
        </div>
      )}
      {query.trim().length >= PLAYER_BEATMAP_SEARCH_MIN_LENGTH && !searching && results.length === 0 && (
        <div className="px-4 pb-3 text-center text-[11px] text-osu-f1">
          <Trans>No beatmaps found for "{query}"</Trans>
        </div>
      )}
    </motion.div>
  );
}

function PlayerBeatmapScoreRow({ score, onOpen }: { score: OsuScore; onOpen: () => void }) {
  const timestamp = getScoreTimestamp(score);
  const judgements = getManiaJudgementStats(score);
  const totalScore = score.total_score ?? score.classic_total_score ?? score.legacy_total_score ?? score.score;

  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors cursor-pointer hover:bg-osu-b3/50 focus:outline-none focus-visible:bg-osu-b3/50"
      onClick={onOpen}
    >
      <GradeImg grade={getDisplayedRank(score)} size={24} />
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="min-w-[90px] shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-osu-l2">{formatAccuracy(getDisplayedAccuracy(score))}</span>
            {timestamp && <span className="text-[10px] text-osu-f1" title={formatTimeAgoTooltip(timestamp)}>{formatTimeAgo(timestamp)}</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold text-osu-f1">
            <span>{formatNumber(score.max_combo)}x</span>
          </div>
        </div>
        <ScoreModBadges score={score} className="hidden shrink-0 gap-0.5 sm:flex" hideWhenEmpty />
        <div className="hidden min-w-0 flex-1 items-center gap-1.5 lg:flex">
          {judgements.map((judgement) => (
            <span key={judgement.label} className="whitespace-nowrap text-[10px] font-semibold text-osu-f1">
              <span className={judgement.className}>{formatNumber(judgement.value)}</span>{" "}
              <span>{judgement.label}</span>
            </span>
          ))}
        </div>
        <div className="hidden shrink-0 items-center gap-2 text-[10px] font-semibold text-osu-f1 sm:flex">
          {score.pp != null && <span>{formatPP(score.pp)}</span>}
          {totalScore > 0 && <span>{formatNumber(totalScore)}</span>}
        </div>
      </div>
      <span className="shrink-0 rounded bg-osu-pink/20 px-2 py-0.5 text-[10px] font-semibold text-osu-pink-light">
        <Trans>Watch</Trans>
      </span>
    </button>
  );
}

function PlayerSuggestions({
  selectedCountry,
  suggestionPlayers,
  onSelectPlayer,
}: Pick<ReplayBrowseViewProps, "selectedCountry" | "suggestionPlayers" | "onSelectPlayer">) {
  const { t } = useLingui();
  const locale = useLocale();
  const countryName = displayCountryName(selectedCountry, locale);
  const pageSize = 12;
  const [page, setPage] = useState(0);
  const pageCount = Math.ceil(suggestionPlayers.length / pageSize);
  const visiblePlayers = suggestionPlayers.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="relative mb-4 flex items-center justify-center">
        <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider text-center">
          <Trans>Top {countryName} Players</Trans>
        </h4>
        {pageCount > 1 && (
          <div className="absolute right-0 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label={t`Previous players`}
              className="p-1.5 rounded-lg bg-osu-b4 text-osu-f1 hover:bg-osu-b3 hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page === pageCount - 1}
              aria-label={t`Next players`}
              className="p-1.5 rounded-lg bg-osu-b4 text-osu-f1 hover:bg-osu-b3 hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visiblePlayers.map((player, index) => (
          <motion.button
            key={player.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.02 }}
            onClick={() => onSelectPlayer(player)}
            className="relative min-h-[86px] overflow-hidden flex items-center gap-4 p-4 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/20 text-left"
          >
            {player.cover_url && (
              <div
                className="absolute inset-0 bg-cover bg-center opacity-40"
                style={{ backgroundImage: `url(${player.cover_url})` }}
                aria-hidden="true"
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-r from-osu-b4/95 via-osu-b4/80 to-osu-b4/65" aria-hidden="true" />
            <img src={avatarImageSrc(player.avatar_url, player.id)} alt="" className="relative w-14 h-14 rounded-full flex-shrink-0 object-cover ring-2 ring-white/10" loading="lazy" />
            <div className="relative flex-1 min-w-0">
              <div className="text-base font-semibold text-white truncate">{player.username}</div>
              {player.global_rank != null && (
                <div className="mt-1 text-xs text-osu-f1">#{player.global_rank.toLocaleString("en-US")}</div>
              )}
            </div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function BeatmapReplayBrowser({
  selectedCountry,
  beatmapQuery,
  beatmapResults,
  beatmapSearchLoading,
  selectedDiffId,
  beatmapScores,
  visibleRawBeatmapScores,
  loadingBeatmapScores,
  beatmapScorePage,
  beatmapScoreLookupStatus,
  onBeatmapQueryChange,
  onSelectBeatmapset,
  onSelectDifficulty,
  onOpenBeatmapScore,
  onLoadMoreBeatmapScores,
}: Pick<ReplayBrowseViewProps,
  "selectedCountry" | "beatmapQuery" | "beatmapResults" | "beatmapSearchLoading" | "selectedDiffId" |
  "beatmapScores" | "visibleRawBeatmapScores" | "loadingBeatmapScores" | "beatmapScorePage" |
  "beatmapScoreLookupStatus" | "onBeatmapQueryChange" | "onSelectBeatmapset" | "onSelectDifficulty" |
  "onOpenBeatmapScore" | "onLoadMoreBeatmapScores"
>) {
  const { t } = useLingui();
  const countryCode = selectedCountry.toUpperCase();
  const replaysFound = beatmapScores.length;
  const checked = beatmapScoreLookupStatus?.current ?? 0;
  const toCheck = beatmapScoreLookupStatus?.total ?? 0;
  const beatmapScoreProgressLabel = beatmapScoreLookupStatus
    ? t`${checked}/${toCheck} players checked · ${replaysFound} replays found`
    : t`Checking players · ${replaysFound} replays found`;

  return (
    <>
      <div className="max-w-lg mx-auto mb-8">
        <h3 className="text-sm font-semibold text-osu-f1 uppercase tracking-wider mb-3 text-center">
          <Trans>Search a beatmap, then pick a difficulty</Trans>
        </h3>
        <div className="relative">
          <input
            type="text"
            value={beatmapQuery}
            onChange={(e) => onBeatmapQueryChange(e.target.value)}
            placeholder={t`Search beatmap...`}
            className="w-full px-4 py-2.5 rounded-lg bg-osu-b4 text-osu-c1 text-sm placeholder:text-osu-f1 border border-osu-b3/50 focus:border-osu-h1/40 focus:outline-none transition-colors duration-[120ms] shadow-[inset_0_1px_3px_rgba(0,0,0,0.3)]"
          />
          {beatmapSearchLoading && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
            </div>
          )}
        </div>
      </div>

      {beatmapResults.length > 0 && (
        <div className="space-y-3 mb-4">
          <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider mb-2">
            <Trans>Beatmaps ({beatmapResults.length})</Trans>
          </h4>
          {beatmapResults.map((beatmapset, index) => {
            const maniaDiffs = (beatmapset.beatmaps ?? [])
              .filter((beatmap) => beatmap.mode === "mania")
              .sort((a, b) => a.cs - b.cs || a.difficulty_rating - b.difficulty_rating);
            const coverUrl = beatmapset.covers?.["cover@2x"] || beatmapset.covers?.cover;
            return (
              <motion.div key={beatmapset.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }}
                className="relative rounded-xl overflow-hidden border border-osu-b3/20">
                {coverUrl && (
                  <img src={coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                )}
                <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/75 to-black/50" />
                <div className="relative z-10 px-4 py-3">
                  <div className="mb-2">
                    <div className="text-sm font-semibold text-white truncate drop-shadow-sm">{beatmapset.title}</div>
                    <div className="text-[10px] text-white/60 truncate">{beatmapset.artist} // {beatmapset.creator}</div>
                  </div>
                  {maniaDiffs.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {maniaDiffs.map((beatmap) => (
                        <button
                          key={beatmap.id}
                          onClick={() => {
                            onSelectBeatmapset(beatmapset);
                            onSelectDifficulty(beatmap);
                          }}
                          className={`px-2.5 py-1 rounded-md text-[11px] cursor-pointer transition-colors border backdrop-blur-sm ${
                            selectedDiffId === beatmap.id
                              ? "bg-osu-pink/30 border-osu-pink/60 text-white"
                              : "bg-black/40 hover:bg-black/60 border-white/10 text-white/90"
                          }`}
                        >
                          <span className="text-osu-yellow font-semibold">{beatmap.cs}K</span>{" "}
                          <span className="opacity-70">{beatmap.version.replace(/\s*\[\d+[Kk]\]\s*/g, " ").trim()}</span>{" "}
                          <span className="text-osu-l2">&#9733;{beatmap.difficulty_rating.toFixed(2)}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-white/40"><Trans>No mania difficulties</Trans></div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {loadingBeatmapScores && (
        <div className="flex flex-col items-center justify-center gap-3 py-8">
          <div className="w-6 h-6 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
          <div className="text-xs font-semibold uppercase tracking-wider text-osu-f1">
            {beatmapScoreProgressLabel}
          </div>
        </div>
      )}

      {selectedDiffId && beatmapScores.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-semibold text-osu-f1 uppercase tracking-wider mb-2">
            {loadingBeatmapScores ? t`Replays available so far` : t`Replays available`} ({beatmapScores.length})
          </h4>
          {beatmapScores.map((score, index) => (
            <motion.div key={score.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.02 }}
              className="flex items-center gap-3 py-2.5 px-4 rounded-xl bg-osu-b4 hover:bg-osu-b3 transition-colors cursor-pointer border border-osu-b3/20"
              onClick={() => onOpenBeatmapScore(score)}>
              <GradeImg grade={getDisplayedRank(score)} size={26} />
              <img src={avatarImageSrc(score.user?.avatar_url, score.user?.id)} alt="" className="w-7 h-7 rounded-full flex-shrink-0" loading="lazy" />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{score.user?.username}</div>
                <ScoreModBadges score={score} className="mt-1 flex gap-0.5 sm:hidden" hideWhenEmpty />
              </div>
              <ScoreModBadges score={score} className="hidden sm:flex w-28 flex-shrink-0 justify-end gap-0.5" />
              <span className="text-xs text-osu-l2 flex-shrink-0">{formatAccuracy(getDisplayedAccuracy(score))}</span>
              <span className="text-sm font-bold">{formatPP(score.pp)}</span>
              <span className="px-2 py-1 rounded bg-osu-pink/20 text-[10px] text-osu-pink-light font-semibold"><Trans>Watch</Trans></span>
            </motion.div>
          ))}
        </div>
      )}

      {!loadingBeatmapScores && selectedDiffId && beatmapScorePage < 2 && (
        <div className="flex justify-center py-4">
          <button
            onClick={onLoadMoreBeatmapScores}
            className="px-3 py-1.5 rounded-lg bg-osu-b4 hover:bg-osu-b3 border border-osu-b3/40 text-xs font-semibold text-osu-f1 hover:text-white transition-colors cursor-pointer"
          >
            <Trans>Load more</Trans>
          </button>
        </div>
      )}

      {!loadingBeatmapScores && selectedDiffId && beatmapScores.length === 0 && visibleRawBeatmapScores.length > 0 && (
        <div className="text-center py-6 text-osu-f1 text-sm">
          <Trans>No replays available from {countryCode} players on this difficulty</Trans>
        </div>
      )}
      {!loadingBeatmapScores && selectedDiffId && visibleRawBeatmapScores.length === 0 && (
        <div className="text-center py-6 text-osu-f1 text-sm">
          <Trans>No scores found from {countryCode} players on this difficulty</Trans>
        </div>
      )}

      {!beatmapSearchLoading && beatmapResults.length === 0 && beatmapQuery.length < 2 && !selectedDiffId && (
        <div className="text-center py-12 text-osu-f1 text-sm">
          <Trans>Search for a beatmap above to find replays</Trans>
        </div>
      )}
    </>
  );
}

function ScoreInputPreview({
  scoreId,
  score,
  loading,
  error,
  onOpen,
}: {
  scoreId: number;
  score: OsuScore | null;
  loading: boolean;
  error: string | null;
  onOpen: () => void;
}) {
  const { t, i18n } = useLingui();
  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-osu-b4/70 border border-osu-b3/30 px-3 py-2 text-xs text-osu-f1">
        <div className="w-3.5 h-3.5 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin" />
        <Trans>Looking up score #{scoreId}</Trans>
      </div>
    );
  }

  if (error) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="mt-2 w-full rounded-lg bg-osu-b4/70 hover:bg-osu-b3 border border-osu-b3/30 px-3 py-2 text-left text-xs text-osu-f1 hover:text-white transition-colors cursor-pointer"
      >
        <Trans>{error}. Press Enter or click to try replay #{scoreId}.</Trans>
      </button>
    );
  }

  if (!score) return null;

  const coverUrl = score.beatmapset?.covers?.list;
  const availability = getReplayScoreAvailability(score);
  const unavailable = !availability.available;
  return (
    <button
      type="button"
      onClick={unavailable ? undefined : onOpen}
      disabled={unavailable}
      className={`mt-2 w-full flex items-center gap-3 rounded-lg bg-osu-b4 border border-osu-b3/30 px-3 py-2 text-left transition-colors ${
        unavailable ? "cursor-default opacity-80" : "hover:bg-osu-b3 cursor-pointer"
      }`}
    >
      {coverUrl && (
        <img src={coverUrl} alt="" className="w-12 h-8 rounded object-cover flex-shrink-0" loading="lazy" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-white truncate">
          {score.beatmapset?.title ?? t`Score #${scoreId}`}
        </div>
        <div className="text-[10px] text-osu-f1 truncate">
          {unavailable
            ? i18n._(availability.message)
            : `${score.user?.username ?? t`Unknown player`}${score.beatmap?.version ? ` // [${score.beatmap.version}]` : ""}`}
        </div>
      </div>
      <ScoreModBadges score={score} className="hidden sm:flex flex-shrink-0 gap-0.5" hideWhenEmpty />
      <span className={`text-[10px] font-semibold uppercase tracking-wider flex-shrink-0 ${
        unavailable ? "text-osu-f1" : "text-osu-pink-light"
      }`}>
        {unavailable ? t`Unavailable` : t`Watch`}
      </span>
    </button>
  );
}

function ScoreModBadges({
  score,
  className,
  hideWhenEmpty = false,
}: {
  score: OsuScore;
  className: string;
  hideWhenEmpty?: boolean;
}) {
  const mods = getModDisplayList(score.mods);
  if (hideWhenEmpty && mods.length === 0) return null;

  return (
    <div className={className}>
      {mods.map((mod, index) => (
        <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.75} />
      ))}
    </div>
  );
}
