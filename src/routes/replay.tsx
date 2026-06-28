import { createFileRoute, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback, useMemo, type PointerEvent as ReactPointerEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LoaderCircle, Maximize2, Minimize2, Pause, Play } from "lucide-react";
import { getReplayParsed, getBeatmapFile, getScore, getUser, getUserScoresBest, getUserScoresFirsts, getUserScoresPinned, getUserScoresRecent, searchUsers, searchBeatmaps, getBeatmapScores, getRankings, getBeatmapScoreLookupStatus, getPartialBeatmapScores, lookupBeatmapByChecksum } from "../lib/osu";
import { filterBeatmapSearchResults } from "../lib/beatmap-search";
import { getEffectiveManiaKeyCount, getScoreDisplayValues, getScoreRate, modShiftsPitchWithRate, scoreHasReplay } from "../lib/score";
import { useAppStore, useHiddenUserIds, useSelectedCountry } from "../store";
import { PageHeader } from "../components/layout/PageHeader";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { ReplayBrowseView } from "../components/replay/ReplayBrowseView";
import type { ReplayBrowseMode } from "../components/replay/ReplayBrowseView";
import { ReplayControls, ReplayProgressBar } from "../components/replay/ReplayControls";
import type { ReplayVideoExportOptions } from "../components/replay/ReplayControls";
import { ReplayInfo } from "../components/replay/ReplayInfo";
import type { ReplayPlayerProfile } from "../components/replay/ReplayInfo";
import { ReplaySkinSettingsModal } from "../components/replay/ReplaySkinSettingsModal";
import { track } from "../lib/posthog";
import { withTimeout } from "../lib/promise-timeout";
import {
  REPLAY_SKIN_SETTINGS_CHANGE_EVENT,
  normalizeReplaySkinSettings,
  readReplaySkinSettings,
  writeReplaySkinSettings,
} from "../lib/replay-skin";
import { normalizeReplayPlayerParam, shouldStartReplayPlayerLoad } from "../lib/replay-player-autoload";
import { getReplayBackNavigation } from "../lib/replay-navigation";
import { resolveStableManiaReplayScrollSpeed, unpackReplayFrames } from "../lib/replay-frames";
import { buildKeypressHeatmap } from "../lib/replay-keypress-heatmap";
import { parseReplayScoreInput } from "../lib/replay-score-input";
import { getReplayScoreAvailability } from "../lib/replay-score-availability";
import { buildReplaySeoTitle, type ReplaySeoScore } from "../lib/replay-seo";
import { getBeatmapAudioUrl } from "../lib/audio-url";
import { DEFAULT_REPLAY_SCROLL_SPEED, REPLAY_SCROLL_SPEED_CHANGE_EVENT, normalizeReplayScrollSpeed, readReplayScrollSpeed, writeReplayScrollSpeed } from "../lib/replay-scroll-speed";
import {
  REPLAY_OVERLAY_SETTINGS_CHANGE_EVENT,
  normalizeReplayOverlaySettings,
  readReplayOverlaySettings,
  writeReplayOverlaySettings,
} from "../lib/replay-overlays";
import { parseCachedManiaBeatmap } from "../lib/parsed-beatmap-cache";
import { extractReplayScoreIdFromFilename, parseUploadedReplayBuffer } from "../lib/replay-upload";
import { startProgressPoll } from "../lib/progress-poll";
import {
  fetchLiveGlobalRankings,
  fetchLivePlayerCachedProfileSnapshotDirect,
  fetchLivePlayerRecentScoresDirect,
  getLiveBackendUrl,
  isLiveBackendConfigured,
  type LiveGlobalRankingEntry,
  type LivePlayerProfileSnapshot,
} from "../lib/live-backend";
import { isGlobalScope } from "../lib/country";
import { useAuth } from "../lib/auth-context";
import { readGlobalTopPlayersCache, readGlobalTopPlayersMemoryCache, writeGlobalTopPlayersCache } from "../lib/global-top-players-cache";
import {
  normalizeReplayBackgroundDim,
  normalizeReplayInputColor,
  normalizeReplayVolume,
  readReplayBackgroundDim,
  readReplayInputColor,
  readReplayInputKeyHistory,
  readReplayInputOnly,
  readReplayInputOverlay,
  readReplayVolume,
  writeReplayBackgroundDim,
  writeReplayInputColor,
  writeReplayInputKeyHistory,
  writeReplayInputOnly,
  writeReplayInputOverlay,
  writeReplayVolume,
} from "../lib/replay-preferences";
import type { ManiaBeatmap } from "../lib/beatmap-parser";
import type { ReplaySkinSettings } from "../lib/replay-skin";
import type { ReplayOverlaySettings } from "../lib/replay-overlays";
import type { BeatmapScoreLookupStatus, OsuMod, OsuScore, OsuBeatmapset, OsuBeatmap } from "../lib/types";
import type { ReplayRendererLike, ServerReplay } from "../lib/replay-types";
import { getScoreExpectedCounts } from "../lib/replay-types";
import { pageSeo, replayOgImagePath } from "../lib/seo";
import { withSearchParams } from "../lib/country-search";

interface ReplaySearch {
  scoreId?: number;
  beatmapsetId?: number;
  uploadId?: string;
  t?: number; // timestamp in seconds to seek to on load
  tab?: "player" | "beatmap" | "upload";
  player?: string; // selected player username (for URL state)
}

type PlayerScoreGroups = { best: OsuScore[]; firsts: OsuScore[]; pinned: OsuScore[]; recent: OsuScore[] };
type PlayerScoreGroupLoading = Record<keyof PlayerScoreGroups, boolean>;
type ReplayBeatmapFileStatus = "unknown" | "cached" | "fetched" | "unavailable";

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenTarget = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const MOBILE_FULLSCREEN_BUTTON_HIDE_MS = 2000;
const FULLSCREEN_POINTER_CHROME_HIDE_MS = 1800;
const FULLSCREEN_TAP_CHROME_HIDE_MS = 3000;
const REPLAY_VIDEO_EXPORT_CLIP_SECONDS = 20;
const MAX_UPLOAD_REPLAY_BYTES = 25 * 1024 * 1024;
const REPLAY_PLAYER_LIVE_CACHE_TIMEOUT_MS = 900;
const REPLAY_PLAYER_INITIAL_SCORE_TARGET_MS = 2000;
const REPLAY_PLAYER_BEST_DISPLAY_LIMIT = 100;
const REPLAY_PLAYER_BEST_FALLBACK_LIMIT = 50;
const REPLAY_PLAYER_RECENT_LIMIT = 25;
const REPLAY_PLAYER_PINNED_LIMIT = 25;
const REPLAY_PLAYER_FIRSTS_LIMIT = 50;
const REPLAY_LANDING_SEO_TITLE = "osu!mania replay watcher";
const REPLAY_LANDING_SEO_DESCRIPTION =
  "Browser-based osu!mania replay watcher and viewer for .osr files, score replays, keypress overlays, skins, and MP4 export.";
const REPLAY_VIDEO_EXPORT_RESOLUTIONS: Record<ReplayVideoExportOptions["resolution"], { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};
const REPLAY_END_AUDIO_FADE_MS = 1500;
const UPLOADED_REPLAY_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

type ReplayVideoExportState = {
  exporting: boolean;
  progress: number;
  error: string | null;
  url: string | null;
  signed: boolean;
};

type ReplayVideoExportRequest = ReplayVideoExportOptions & {
  forceClientRender?: boolean;
  bgDim?: number;
  scrollSpeed?: number;
  showInputOverlay?: boolean;
  inputOverlayOnly?: boolean;
  inputOverlayColor?: string;
  inputOverlayKeyHistory?: boolean;
  skinSettings?: ReplaySkinSettings;
  overlaySettings?: ReplayOverlaySettings;
};

type ReplayUploadResponse = {
  id: string;
  url: string;
  storage?: "r2" | "local";
  error?: string;
};

type UploadedReplayDownload = {
  buffer: ArrayBuffer;
  filename: string | null;
};

type ReplayLoadingStep = "score" | "assets" | "viewer" | "upload" | "shared-upload";

declare global {
  interface Window {
    __maniaHubExportReplayVideo?: (options: ReplayVideoExportRequest) => Promise<ReplayVideoJobPayload | null>;
  }
}

function getReplayVideoBitrate(width: number, height: number, fps: ReplayVideoExportOptions["fps"]): number {
  const baseBitrate = height >= 1080 ? 5_000_000 : 3_000_000;
  const fpsScale = fps <= 30 ? 1 : fps / 30 * 0.82;
  const pixelScale = Math.max(0.7, Math.min(1.2, (width * height) / (1920 * 1080)));
  return Math.round(baseBitrate * fpsScale * pixelScale);
}

function isLocalReplayVideoExportHost(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  const hostname = window.location.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function getNativeFullscreenElement() {
  if (typeof document === "undefined") return null;
  const doc = document as FullscreenDocument;
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function requestNativeFullscreen(element: HTMLElement) {
  const target = element as FullscreenTarget;
  if (target.requestFullscreen) {
    await target.requestFullscreen({ navigationUI: "hide" } as FullscreenOptions);
    return true;
  }
  if (target.webkitRequestFullscreen) {
    await target.webkitRequestFullscreen();
    return true;
  }
  return false;
}

async function exitNativeFullscreen() {
  if (typeof document === "undefined") return;
  const doc = document as FullscreenDocument;
  if (document.exitFullscreen) {
    await document.exitFullscreen();
  } else if (doc.webkitExitFullscreen) {
    await doc.webkitExitFullscreen();
  }
}

function isMobileReplayPointer(event: ReactPointerEvent<HTMLElement>) {
  if (event.pointerType === "touch") return true;
  if (event.pointerType === "mouse" || event.pointerType === "pen") return false;
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
}

function drawCoverImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number) {
  const imgAspect = image.naturalWidth / image.naturalHeight;
  const canvasAspect = width / height;
  let drawWidth = width;
  let drawHeight = height;
  if (imgAspect > canvasAspect) {
    drawHeight = height;
    drawWidth = height * imgAspect;
  } else {
    drawWidth = width;
    drawHeight = width / imgAspect;
  }
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function loadExportBackground(src: string | null): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

async function loadFirstExportBackground(sources: Array<string | null | undefined>): Promise<HTMLImageElement | null> {
  const seen = new Set<string>();
  for (const source of sources) {
    const url = getExportBackgroundUrl(source ?? null);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const image = await loadExportBackground(url);
    if (image) return image;
  }
  return null;
}

function getExportBackgroundUrl(src: string | null): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, window.location.origin);
    if (url.origin === window.location.origin && url.pathname === "/api/background") {
      url.searchParams.set("inline", "1");
      return `${url.pathname}${url.search}`;
    }
  } catch {
    // Fall through and try the original value.
  }
  return src;
}

function sanitizeReplayVideoFilename(value: string): string {
  return value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "replay";
}

type ReplayVideoJobPayload = {
  id: string;
  status?: "started" | "uploaded" | "queued" | "running" | "done" | "failed" | "cancelled";
  scoreId?: number | null;
  url?: string | null;
  signed?: boolean;
  error?: string | null;
};

function getReplayVideoJobUrl(action: string, id?: string, params: Record<string, string | number | null | undefined> = {}): URL {
  const base = getLiveBackendUrl() ?? window.location.origin;
  const url = new URL("/api/replay-video-job", base);
  url.searchParams.set("action", action);
  if (id) url.searchParams.set("id", id);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function postReplayVideoJson<T>(action: string, body: unknown, id?: string): Promise<T> {
  const url = getReplayVideoJobUrl(action, id);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `Replay video job ${action} failed.`);
  }
  return payload;
}

async function postReplayVideoBlob(jobId: string, blob: Blob): Promise<void> {
  const url = getReplayVideoJobUrl("upload-video", jobId);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": blob.type || "video/mp4" },
    body: blob,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || "Replay video upload failed.");
  }
}

async function postUploadedReplay(buffer: ArrayBuffer, filename?: string): Promise<ReplayUploadResponse> {
  const response = await fetch("/api/replay-upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      ...(filename ? { "X-Replay-Filename": encodeURIComponent(filename) } : {}),
    },
    body: buffer,
  });
  const payload = await response.json().catch(() => null) as ReplayUploadResponse | null;
  if (!response.ok || !payload?.id || !payload.url) {
    throw new Error(payload?.error || "Failed to save replay upload.");
  }
  return payload;
}

async function fetchUploadedReplayBuffer(uploadId: string): Promise<UploadedReplayDownload> {
  const response = await fetch(`/api/replay-upload?id=${encodeURIComponent(uploadId)}`);
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || "Failed to load shared replay.");
  }
  const filenameHeader = response.headers.get("x-replay-filename");
  return {
    buffer: await response.arrayBuffer(),
    filename: filenameHeader ? decodeURIComponent(filenameHeader) : null,
  };
}

async function getRecentReplayVideoJob(scoreId: number): Promise<ReplayVideoJobPayload | null> {
  const url = getReplayVideoJobUrl("recent", undefined, { scoreId });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const payload = await response.json().catch(() => null) as ReplayVideoJobPayload | { url?: null; error?: string } | null;
  if (!response.ok || !payload || payload.url == null) return null;
  return payload as ReplayVideoJobPayload;
}

async function waitForReplayVideoJob(
  jobId: string,
  onProgress: (progress: number) => void,
  options: { minProgress?: number; maxProgress?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ url: string; signed: boolean }> {
  const minProgress = options.minProgress ?? 0.94;
  const maxProgress = options.maxProgress ?? 0.99;
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    const job = await postReplayVideoJson<ReplayVideoJobPayload>("status", {}, jobId);
    if (job.status === "done" && job.url) return { url: job.url, signed: Boolean(job.signed) };
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error || `Replay video job ${job.status}.`);
    }
    const elapsedRatio = Math.min(1, (Date.now() - startedAt) / timeoutMs);
    onProgress(Math.min(maxProgress, minProgress + (maxProgress - minProgress) * elapsedRatio));
  }
  throw new Error("Replay video export is still running in the background. Try again in a moment.");
}

function shouldUseServerReplayVideoRender(): boolean {
  return import.meta.env.VITE_REPLAY_VIDEO_SERVER_RENDER === "1";
}

function getReplayLoadingCopy(step: ReplayLoadingStep, elapsedMs: number, beatmapFileStatus: ReplayBeatmapFileStatus): { title: string; detail: string } {
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const elapsedLabel = elapsedSeconds >= 4 ? ` (${elapsedSeconds}s)` : "";
  const slowDetail = elapsedMs >= 12_000
    ? beatmapFileStatus === "cached"
      ? "Still waiting on replay data. The chart file is already cached."
      : "Still waiting on replay data. First-time loads are slower, but cached files open faster next time."
    : elapsedMs >= 6_000
      ? beatmapFileStatus === "cached"
        ? "Still working. The chart file came from cache; the replay data is taking a moment."
        : "Still working. This usually means replay data or the beatmap file is taking a moment."
      : null;

  if (slowDetail) {
    return {
      title: `Loading replay${elapsedLabel}`,
      detail: slowDetail,
    };
  }

  switch (step) {
    case "score":
      return {
        title: `Checking score details${elapsedLabel}`,
        detail: "Confirming replay availability and key count.",
      };
    case "assets":
      if (beatmapFileStatus === "cached") {
        return {
          title: `Loading replay and cached beatmap${elapsedLabel}`,
          detail: "Reading the chart from cache while the replay data is parsed.",
        };
      }
      if (beatmapFileStatus === "fetched") {
        return {
          title: `Loading replay${elapsedLabel}`,
          detail: "The chart file is ready; parsing replay data and preparing the viewer.",
        };
      }
      if (beatmapFileStatus === "unavailable") {
        return {
          title: `Loading replay${elapsedLabel}`,
          detail: "Parsing replay data; the chart file is not available yet.",
        };
      }
      return {
        title: `Loading replay and beatmap${elapsedLabel}`,
        detail: "Fetching the .osr, parsing frames, and checking the chart file.",
      };
    case "viewer":
      return {
        title: `Preparing replay viewer${elapsedLabel}`,
        detail: "Unpacking frames and getting the renderer ready.",
      };
    case "upload":
      if (beatmapFileStatus === "cached") {
        return {
          title: `Reading replay and cached beatmap${elapsedLabel}`,
          detail: "Parsing the upload and reading the chart file from cache.",
        };
      }
      return {
        title: `Reading replay file${elapsedLabel}`,
        detail: "Parsing the upload and matching it to a beatmap.",
      };
    case "shared-upload":
      if (beatmapFileStatus === "cached") {
        return {
          title: `Loading shared replay and cached beatmap${elapsedLabel}`,
          detail: "Opening the shared replay and reading the chart file from cache.",
        };
      }
      return {
        title: `Loading shared replay${elapsedLabel}`,
        detail: "Opening the shared replay and matching it to a beatmap.",
      };
  }
}

// Browsers default `preservesPitch` to true (the DT/HT behavior). NC/DC need
// it off so pitch tracks playbackRate. Vendor prefixes cover Safari/Firefox.
function setAudioPreservesPitch(audio: HTMLAudioElement, preservesPitch: boolean): void {
  const pitchAudio = audio as HTMLAudioElement & {
    mozPreservesPitch?: boolean;
    preservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  pitchAudio.preservesPitch = preservesPitch;
  pitchAudio.mozPreservesPitch = preservesPitch;
  pitchAudio.webkitPreservesPitch = preservesPitch;
}

export const Route = createFileRoute("/replay")({
  loaderDeps: ({ search }) => ({ scoreId: search.scoreId }),
  loader: async ({ deps }): Promise<{ seoScore: ReplaySeoScore | null; score: OsuScore | null }> => {
    if (typeof deps.scoreId !== "number") return { seoScore: null, score: null };

    try {
      const score = await getScore({ data: { scoreId: deps.scoreId } });
      return {
        score,
        seoScore: {
          username: score.user?.username ?? "",
          title: score.beatmapset?.title ?? "",
          version: score.beatmap?.version ?? "",
        },
      };
    } catch {
      return { seoScore: null, score: null };
    }
  },
  head: ({ match, loaderData }) => {
    const { scoreId, beatmapsetId, uploadId, player } = match.search;
    const hasSharedScore = typeof scoreId === "number";
    const hasSharedUpload = typeof uploadId === "string" && uploadId.length > 0;
    const playerName = typeof player === "string" ? player.trim() : "";
    const isReplayLanding = !hasSharedScore
      && !hasSharedUpload
      && typeof beatmapsetId !== "number"
      && !playerName
      && !match.search.tab
      && typeof match.search.t !== "number";
    const title = hasSharedScore
      ? buildReplaySeoTitle(scoreId, loaderData?.seoScore, playerName)
      : hasSharedUpload
        ? "Shared replay"
        : REPLAY_LANDING_SEO_TITLE;

    return pageSeo({
      title,
      description: hasSharedScore
        ? ""
        : REPLAY_LANDING_SEO_DESCRIPTION,
      path: withSearchParams("/replay", {
        scoreId,
        beatmapsetId,
        uploadId,
        player: playerName || undefined,
      }),
      origin: match.context.origin,
      image: hasSharedScore ? replayOgImagePath(scoreId) : undefined,
      social: true,
      noindex: !isReplayLanding,
      appendSiteName: !hasSharedScore,
    });
  },
  component: ReplayPage,
  validateSearch: (s: Record<string, unknown>): ReplaySearch => ({
    scoreId: Number(s.scoreId) || undefined,
    beatmapsetId: Number(s.beatmapsetId) || undefined,
    uploadId: typeof s.uploadId === "string" && UPLOADED_REPLAY_ID_PATTERN.test(s.uploadId) ? s.uploadId : undefined,
    t: Number(s.t) || undefined,
    tab: s.tab === "beatmap" || s.tab === "upload" ? s.tab : undefined,
    player: (s.player as string) || undefined,
  }),
});

function mergeScoresById(...groups: OsuScore[][]): OsuScore[] {
  const byId = new Map<number, OsuScore>();
  for (const group of groups) {
    for (const score of group) byId.set(score.id, score);
  }
  return Array.from(byId.values());
}

function createEmptyPlayerScoreGroups(): PlayerScoreGroups {
  return { best: [], firsts: [], pinned: [], recent: [] };
}

function createPlayerScoreGroupLoading(isLoading: boolean): PlayerScoreGroupLoading {
  return { best: isLoading, firsts: isLoading, pinned: isLoading, recent: isLoading };
}

function hasAnyPlayerScore(groups: PlayerScoreGroups): boolean {
  return groups.best.length > 0 || groups.firsts.length > 0 || groups.pinned.length > 0 || groups.recent.length > 0;
}

function buildPlayerScoreGroups(raw: PlayerScoreGroups): PlayerScoreGroups {
  const filterReplayable = (scores: OsuScore[]) => scores.filter((s) => scoreHasReplay(s));
  const pinned = filterReplayable(raw.pinned);
  const pinnedIds = new Set(pinned.map((score) => score.id));
  const best = filterReplayable(raw.best).filter((score) => !pinnedIds.has(score.id));
  const bestIds = new Set(best.map((score) => score.id));
  const firsts = filterReplayable(raw.firsts).filter((score) => !pinnedIds.has(score.id) && !bestIds.has(score.id));
  // Recent is intentionally not deduped against the others: a recent play that
  // is also a best score is exactly what you want to see as "new".
  const recent = filterReplayable(raw.recent);
  return { best, firsts, pinned, recent };
}

function getSnapshotUserId(snapshot: LivePlayerProfileSnapshot | null): number | null {
  const userId = Number(snapshot?.user?.id);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function getSnapshotBestScores(snapshot: LivePlayerProfileSnapshot | null): OsuScore[] {
  return Array.isArray(snapshot?.bestScores)
    ? snapshot.bestScores.slice(0, REPLAY_PLAYER_BEST_DISPLAY_LIMIT)
    : [];
}

async function fetchReplayCachedProfileSnapshot(key: string): Promise<LivePlayerProfileSnapshot | null> {
  if (!isLiveBackendConfigured()) return null;
  try {
    return await withTimeout(
      fetchLivePlayerCachedProfileSnapshotDirect(key),
      REPLAY_PLAYER_LIVE_CACHE_TIMEOUT_MS,
      "Timed out loading cached profile snapshot",
    );
  } catch {
    return null;
  }
}

function ReplayPage() {
  const { scoreId, beatmapsetId, uploadId, t: initialTime, tab, player: playerParam } = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const selectedCountry = useSelectedCountry();
  const hiddenUserIds = useHiddenUserIds();
  const cachedRankings = useAppStore((s) => s.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((s) => s.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((s) => s.setRankings);
  const selectedIsGlobal = isGlobalScope(selectedCountry);
  const [globalSuggestions, setGlobalSuggestions] = useState<LiveGlobalRankingEntry[] | null>(
    () => readGlobalTopPlayersMemoryCache()?.data ?? null,
  );
  const [replay, setReplay] = useState<ServerReplay | null>(null);
  const [beatmap, setBeatmap] = useState<ManiaBeatmap | null>(null);
  const [scoreInfo, setScoreInfo] = useState<OsuScore | null>(null);
  const [playerProfile, setPlayerProfile] = useState<ReplayPlayerProfile | null>(null);
  const [uploadedReplayMods, setUploadedReplayMods] = useState<OsuMod[]>([]);
  const [uploadedBeatmapsetId, setUploadedBeatmapsetId] = useState<number | undefined>(undefined);
  const [uploadedReplayShareUrl, setUploadedReplayShareUrl] = useState<string | null>(null);
  const [loadedUploadId, setLoadedUploadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [replayLoadingStep, setReplayLoadingStep] = useState<ReplayLoadingStep>("score");
  const [replayBeatmapFileStatus, setReplayBeatmapFileStatus] = useState<ReplayBeatmapFileStatus>("unknown");
  const [replayLoadingStartedAt, setReplayLoadingStartedAt] = useState(0);
  const [replayLoadingElapsedMs, setReplayLoadingElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [playerSearchQuery, setPlayerSearchQuery] = useState("");
  const [scorePreview, setScorePreview] = useState<OsuScore | null>(null);
  const [scorePreviewLoading, setScorePreviewLoading] = useState(false);
  const [scorePreviewError, setScorePreviewError] = useState<string | null>(null);

  // Player browse state
  const [playerScoreGroups, setPlayerScoreGroups] = useState<PlayerScoreGroups | null>(null);
  const [loadingScores, setLoadingScores] = useState(false);
  const [playerScoreLoadingByGroup, setPlayerScoreLoadingByGroup] = useState<PlayerScoreGroupLoading>(() => createPlayerScoreGroupLoading(false));
  const [playerLookupUserId, setPlayerLookupUserId] = useState<number | null>(null);
  const [loadedPlayerParam, setLoadedPlayerParam] = useState<string | null>(null);
  const loadingPlayerParamRef = useRef<string | null>(null);
  const playerScoreRequestRef = useRef(0);
  const playerIdsByParamRef = useRef<Map<string, number>>(new Map());

  // Browse mode
  const [browseMode, setBrowseMode] = useState<ReplayBrowseMode>(tab === "beatmap" || tab === "upload" ? tab : "player");

  // Beatmap browse state
  const [beatmapQuery, setBeatmapQuery] = useState("");
  const [beatmapResults, setBeatmapResults] = useState<OsuBeatmapset[]>([]);
  const [beatmapSearchLoading, setBeatmapSearchLoading] = useState(false);
  const [selectedBeatmapset, setSelectedBeatmapset] = useState<OsuBeatmapset | null>(null);
  const [selectedDiffId, setSelectedDiffId] = useState<number | null>(null);
  const [rawBeatmapScores, setRawBeatmapScores] = useState<OsuScore[]>([]);
  const [partialBeatmapScores, setPartialBeatmapScores] = useState<OsuScore[]>([]);
  const [beatmapScoreLookupStatus, setBeatmapScoreLookupStatus] = useState<BeatmapScoreLookupStatus | null>(null);
  const [beatmapScorePage, setBeatmapScorePage] = useState(1);
  const [loadingBeatmapScores, setLoadingBeatmapScores] = useState(false);
  const beatmapTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const beatmapSearchRequestRef = useRef(0);
  const beatmapScoreRequestRef = useRef(0);
  const scorePreviewTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const visibleRawBeatmapScores = useMemo(() => {
    const scores = loadingBeatmapScores && partialBeatmapScores.length > 0
      ? mergeScoresById(beatmapScorePage > 1 ? rawBeatmapScores : [], partialBeatmapScores)
      : rawBeatmapScores;
    return scores.filter((score) => !hiddenUserIds.has(score.user_id));
  }, [beatmapScorePage, hiddenUserIds, loadingBeatmapScores, partialBeatmapScores, rawBeatmapScores]);

  const beatmapScores = useMemo(
    () => visibleRawBeatmapScores.filter((s) => scoreHasReplay(s)),
    [visibleRawBeatmapScores],
  );
  const normalizedPlayerParam = normalizeReplayPlayerParam(playerParam);
  const playerSearchScoreId = parseReplayScoreInput(playerSearchQuery);
  const replayLoadingCopy = getReplayLoadingCopy(replayLoadingStep, replayLoadingElapsedMs, replayBeatmapFileStatus);

  useEffect(() => {
    if (!loading || replayLoadingStartedAt <= 0) {
      setReplayLoadingElapsedMs(0);
      return;
    }

    const updateElapsed = () => setReplayLoadingElapsedMs(Date.now() - replayLoadingStartedAt);
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [loading, replayLoadingStartedAt]);

  // Resolve the replay player's avatar + profile banner for the info bar. Seed
  // from the score's embedded user (instant avatar), then fetch the full profile
  // to pull the cover image. Falls back to a name-only header if lookup fails.
  const scoreUserId = scoreInfo?.user?.id;
  const scoreUserName = scoreInfo?.user?.username;
  const scoreUserAvatar = scoreInfo?.user?.avatar_url;
  useEffect(() => {
    if (!replay) {
      setPlayerProfile(null);
      return;
    }
    const lookupKey = scoreUserId
      ? String(scoreUserId)
      : (scoreUserName || replay.header.playerName || "").trim();
    if (!lookupKey) {
      setPlayerProfile(null);
      return;
    }

    setPlayerProfile({
      id: scoreUserId ?? null,
      username: scoreUserName || replay.header.playerName,
      avatarUrl: scoreUserAvatar,
      coverUrl: undefined,
    });

    let cancelled = false;
    getUser({ data: { key: lookupKey } })
      .then((user) => {
        if (cancelled || !user) return;
        setPlayerProfile({
          id: user.id ?? scoreUserId ?? null,
          username: user.username || scoreUserName || replay.header.playerName,
          avatarUrl: user.avatar_url || scoreUserAvatar,
          coverUrl: user.cover_url || user.cover?.custom_url || undefined,
        });
      })
      .catch(() => { /* keep the score-seeded avatar/name */ });
    return () => { cancelled = true; };
  }, [replay, scoreUserId, scoreUserName, scoreUserAvatar]);

  const loadReplay = useCallback(async (sid: number, initialScore?: OsuScore | null) => {
    setError(null);
    setReplayLoadingStep("score");
    setReplayBeatmapFileStatus("unknown");
    setReplayLoadingStartedAt(Date.now());
    setReplayLoadingElapsedMs(0);
    setLoading(true);
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);
    setUploadedReplayMods([]);
    setUploadedBeatmapsetId(undefined);
    setUploadedReplayShareUrl(null);
    setLoadedUploadId(null);

    try {
      // Fetch score first to get key count (beatmap.cs) for correct replay parsing
      const score = initialScore?.id === sid
        ? initialScore
        : await getScore({ data: { scoreId: sid, mode: "mania" } }).catch(() => null);
      if (score) {
        const availability = getReplayScoreAvailability(score);
        if (!availability.available) {
          throw new Error(availability.message);
        }

        setScoreInfo(score);
        track("replay_view", {
          replay_score_id: String(sid),
          replay_beatmapset_id: score.beatmapset?.id,
          replay_beatmap_id: score.beatmap?.id,
          replay_title: score.beatmapset?.title,
          replay_artist: score.beatmapset?.artist,
          replay_difficulty: score.beatmap?.version,
          replay_creator: score.beatmapset?.creator,
          replay_player: score.user?.username,
          replay_cover_url: score.beatmapset?.covers?.list,
        });
      }

      setReplayLoadingStep("assets");
      // Fetch replay with the effective key count from score API, and beatmap file in parallel.
      // xK mods only apply to converted beatmaps, matching osu!lazer's ManiaKeyMod converter hook.
      const keyCount = score?.beatmap ? getEffectiveManiaKeyCount(score.beatmap, score.mods) ?? undefined : undefined;
      if (!score?.beatmap?.id) {
        setReplayBeatmapFileStatus("unavailable");
      }
      const beatmapFilePromise = score?.beatmap?.id
        ? getBeatmapFile({ data: { beatmapId: score.beatmap.id, beatmapsetId: score.beatmapset?.id } })
          .then((result) => {
            setReplayBeatmapFileStatus(result.cacheStatus === "hit" ? "cached" : "fetched");
            return result;
          })
          .catch(() => {
            setReplayBeatmapFileStatus("unavailable");
            return null;
          })
        : Promise.resolve(null);
      const [parsed, bmResult] = await Promise.all([
        getReplayParsed({ data: { scoreId: sid, mode: "mania", keyCount } }),
        beatmapFilePromise,
      ]);

      setReplayLoadingStep("viewer");
      setReplay({
        header: parsed.header,
        frames: unpackReplayFrames(parsed.framesPacked),
        lifeBarFrames: parsed.lifeBarFrames ?? [],
        keyCount: keyCount ?? parsed.keyCount,
        stableScrollSpeedScale: parsed.stableScrollSpeedScale,
      });
      if (bmResult) {
        setBeatmap(parseCachedManiaBeatmap(score?.beatmap?.id ?? 0, bmResult.content, { keyCount }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load replay");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (scoreId) {
      playerScoreRequestRef.current += 1;
      setLoadingScores(false);
      setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(false));
      loadReplay(scoreId, loaderData.score);
      return;
    }
    if (uploadId) return;

    setLoading(false);
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);
    setUploadedReplayMods([]);
    setUploadedBeatmapsetId(undefined);
    setUploadedReplayShareUrl(null);
    setLoadedUploadId(null);
    setError(null);
    setPlayerSearchQuery("");
    setScorePreview(null);
    setScorePreviewLoading(false);
    setScorePreviewError(null);
    setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(false));
  }, [scoreId, uploadId, loadReplay, loaderData.score]);

  useEffect(() => {
    if (scoreId) return;
    setBrowseMode(tab === "beatmap" || tab === "upload" ? tab : "player");
  }, [scoreId, tab]);

  // Debounced beatmap search
  useEffect(() => {
    const normalizedQuery = beatmapQuery.trim().replace(/\s+/g, " ");
    if (browseMode !== "beatmap" || normalizedQuery.length < 2) {
      beatmapSearchRequestRef.current += 1;
      clearTimeout(beatmapTimerRef.current);
      setBeatmapResults([]);
      setBeatmapSearchLoading(false);
      return;
    }
    const requestId = beatmapSearchRequestRef.current + 1;
    beatmapSearchRequestRef.current = requestId;
    setBeatmapSearchLoading(true);
    clearTimeout(beatmapTimerRef.current);
    beatmapTimerRef.current = setTimeout(async () => {
      try {
        const res = await searchBeatmaps({ data: { query: normalizedQuery, sort: "relevance_desc" } });
        if (beatmapSearchRequestRef.current !== requestId) return;
        setBeatmapResults(filterBeatmapSearchResults(res.beatmapsets, normalizedQuery).slice(0, 12));
      } catch {
        if (beatmapSearchRequestRef.current !== requestId) return;
        setBeatmapResults([]);
      } finally {
        if (beatmapSearchRequestRef.current === requestId) setBeatmapSearchLoading(false);
      }
    }, 350);
    return () => clearTimeout(beatmapTimerRef.current);
  }, [beatmapQuery, browseMode]);

  const handlePlayerSearch = async (q: string) => {
    if (parseReplayScoreInput(q)) return [];

    const res = await searchUsers({ data: { query: q } });
    return (res.user?.data ?? []).slice(0, 6).map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id, username: u.username, avatar_url: u.avatar_url, country_code: u.country_code,
    }));
  };

  const loadPlayerScores = useCallback(async (
    userId: number,
    options: { profileKey?: string; cachedSnapshot?: LivePlayerProfileSnapshot | null } = {},
  ) => {
    const requestId = playerScoreRequestRef.current + 1;
    playerScoreRequestRef.current = requestId;
    const isCurrentRequest = () => playerScoreRequestRef.current === requestId;
    let rawGroups = createEmptyPlayerScoreGroups();
    let visibleGroups = createEmptyPlayerScoreGroups();
    let initialResolved = false;
    let initialTimeout: number | null = null;
    let resolveInitial: () => void = () => {};

    const finishInitial = () => {
      if (initialResolved) return;
      initialResolved = true;
      if (initialTimeout) window.clearTimeout(initialTimeout);
      if (isCurrentRequest()) setLoadingScores(false);
      resolveInitial();
    };

    const setScoreGroupLoading = (key: keyof PlayerScoreGroups, isLoading: boolean) => {
      if (!isCurrentRequest()) return;
      setPlayerScoreLoadingByGroup((current) => ({ ...current, [key]: isLoading }));
    };

    const applyGroups = () => {
      if (!isCurrentRequest()) return;
      visibleGroups = buildPlayerScoreGroups(rawGroups);
      setPlayerScoreGroups(visibleGroups);
      if (hasAnyPlayerScore(visibleGroups)) finishInitial();
    };

    const runScoreTask = (
      key: keyof PlayerScoreGroups,
      promise: Promise<OsuScore[]>,
      options: { initialTimeoutMs?: number } = {},
    ): Promise<void> => {
      const updatePromise = promise
        .then((scores) => {
          rawGroups = { ...rawGroups, [key]: scores };
          applyGroups();
        })
        .catch(() => {})
        .finally(() => setScoreGroupLoading(key, false));

      if (!options.initialTimeoutMs) return updatePromise;
      return Promise.race([
        updatePromise,
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, options.initialTimeoutMs);
        }),
      ]);
    };

    const fetchRecentScores = async (): Promise<OsuScore[]> => {
      if (isLiveBackendConfigured()) {
        try {
          const section = await withTimeout(
            fetchLivePlayerRecentScoresDirect(userId),
            REPLAY_PLAYER_LIVE_CACHE_TIMEOUT_MS,
            "Timed out loading cached recent scores",
          );
          return Array.isArray(section.payload) ? section.payload.slice(0, REPLAY_PLAYER_RECENT_LIMIT) : [];
        } catch {
          // Fall back to the existing osu! score-list cache below.
        }
      }
      return getUserScoresRecent({ data: { userId, limit: REPLAY_PLAYER_RECENT_LIMIT, include_fails: true } }).catch(() => [] as OsuScore[]);
    };

    const profileKey = options.profileKey?.trim() || String(userId);
    const snapshotPromise = options.cachedSnapshot !== undefined
      ? Promise.resolve(options.cachedSnapshot)
      : fetchReplayCachedProfileSnapshot(profileKey);
    const bestPromise = snapshotPromise.then(async (snapshot) => {
      const snapshotBest = getSnapshotBestScores(snapshot);
      if (snapshotBest.length > 0) return snapshotBest;
      return getUserScoresBest({ data: { userId, limit: REPLAY_PLAYER_BEST_FALLBACK_LIMIT } }).catch(() => [] as OsuScore[]);
    });

    setLoadingScores(true);
    setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(true));
    setPlayerScoreGroups(createEmptyPlayerScoreGroups());

    const initialReady = new Promise<void>((resolve) => {
      resolveInitial = resolve;
      initialTimeout = window.setTimeout(() => {
        if (hasAnyPlayerScore(visibleGroups)) finishInitial();
      }, REPLAY_PLAYER_INITIAL_SCORE_TARGET_MS);
    });

    const primaryTasks = [
      runScoreTask("best", bestPromise, { initialTimeoutMs: REPLAY_PLAYER_INITIAL_SCORE_TARGET_MS }),
      runScoreTask("recent", fetchRecentScores(), { initialTimeoutMs: REPLAY_PLAYER_INITIAL_SCORE_TARGET_MS }),
      runScoreTask("pinned", getUserScoresPinned({ data: { userId, limit: REPLAY_PLAYER_PINNED_LIMIT } }).catch(() => [] as OsuScore[]), {
        initialTimeoutMs: REPLAY_PLAYER_INITIAL_SCORE_TARGET_MS,
      }),
    ];

    void Promise.allSettled(primaryTasks).then(() => {
      if (!isCurrentRequest()) return;
      finishInitial();
      void runScoreTask("firsts", getUserScoresFirsts({ data: { userId, limit: REPLAY_PLAYER_FIRSTS_LIMIT } }).catch(() => [] as OsuScore[]));
    });

    await initialReady;
  }, []);

  const handleSelectPlayer = async (user: { id: number; username: string }) => {
    const normalizedUsername = normalizeReplayPlayerParam(user.username);
    if (normalizedUsername) playerIdsByParamRef.current.set(normalizedUsername, user.id);
    playerScoreRequestRef.current += 1;
    navigate({ to: "/replay", search: { player: user.username } });
    setPlayerScoreGroups(createEmptyPlayerScoreGroups());
    setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(true));
    setLoadingScores(true);
    setPlayerLookupUserId(user.id);
    setLoadedPlayerParam(null);
  };

  const handlePlayerSearchSubmit = (query: string) => {
    const parsedScoreId = parseReplayScoreInput(query);
    if (!parsedScoreId) return;
    navigate({ to: "/replay", search: { scoreId: parsedScoreId } });
  };

  const handleOpenScorePreview = () => {
    const parsedScoreId = parseReplayScoreInput(playerSearchQuery);
    if (!parsedScoreId) return;
    navigate({ to: "/replay", search: { scoreId: parsedScoreId } });
  };

  const openUploadedReplayBuffer = useCallback(async (
    buffer: ArrayBuffer,
    options: { uploadId: string; shareUrl: string; source: "owner" | "shared"; filename?: string | null },
  ) => {
    const uploaded = await parseUploadedReplayBuffer(buffer);
    const checksum = uploaded.replay.header.beatmapHash;
    if (!checksum) {
      throw new Error("This replay does not include a beatmap checksum.");
    }

    const beatmapMeta = await lookupBeatmapByChecksum({ data: { checksum } });
    const beatmapsetId = beatmapMeta.beatmapset_id ?? beatmapMeta.beatmapset?.id;
    const fallbackScoreId = extractReplayScoreIdFromFilename(options.filename);
    const scoreId = uploaded.scoreId ?? fallbackScoreId;
    const beatmapFilePromise = getBeatmapFile({ data: { beatmapId: beatmapMeta.id, beatmapsetId } })
      .then((result) => {
        setReplayBeatmapFileStatus(result.cacheStatus === "hit" ? "cached" : "fetched");
        return result;
      })
      .catch((error) => {
        setReplayBeatmapFileStatus("unavailable");
        throw error;
      });
    const [bmResult, uploadedScore] = await Promise.all([
      beatmapFilePromise,
      scoreId
        ? getScore({ data: { scoreId, mode: "mania" } }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const uploadedMods = uploadedScore?.mods ?? uploaded.mods;
    const effectiveKeyCount = getEffectiveManiaKeyCount(beatmapMeta, uploadedMods) ?? uploaded.replay.keyCount;
    setReplay({
      ...uploaded.replay,
      keyCount: effectiveKeyCount,
    });
    setBeatmap(parseCachedManiaBeatmap(beatmapMeta.id, bmResult.content, { keyCount: effectiveKeyCount }));
    setScoreInfo(uploadedScore);
    setUploadedReplayMods(uploadedMods);
    setUploadedBeatmapsetId(beatmapsetId);
    setUploadedReplayShareUrl(options.shareUrl);
    setLoadedUploadId(options.uploadId);
    track(options.source === "owner" ? "replay_upload_view" : "replay_upload_shared_view", {
      replay_upload_id: options.uploadId,
      replay_score_id: scoreId ? String(scoreId) : null,
      replay_beatmap_id: beatmapMeta.id,
      replay_beatmapset_id: beatmapsetId,
      replay_player: uploaded.replay.header.playerName,
    });
  }, []);

  const loadSharedUploadedReplay = useCallback(async (id: string) => {
    setError(null);
    setReplayLoadingStep("shared-upload");
    setReplayBeatmapFileStatus("unknown");
    setReplayLoadingStartedAt(Date.now());
    setReplayLoadingElapsedMs(0);
    setLoading(true);
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);
    setUploadedReplayMods([]);
    setUploadedBeatmapsetId(undefined);
    setUploadedReplayShareUrl(null);

    try {
      const upload = await fetchUploadedReplayBuffer(id);
      const shareUrl = new URL(`/replay?uploadId=${encodeURIComponent(id)}`, window.location.origin).toString();
      await openUploadedReplayBuffer(upload.buffer, { uploadId: id, shareUrl, source: "shared", filename: upload.filename });
    } catch (e) {
      setReplay(null);
      setBeatmap(null);
      setScoreInfo(null);
      setUploadedReplayMods([]);
      setUploadedBeatmapsetId(undefined);
      setUploadedReplayShareUrl(null);
      setLoadedUploadId(null);
      setError(e instanceof Error ? e.message : "Failed to load shared replay");
    } finally {
      setLoading(false);
    }
  }, [openUploadedReplayBuffer]);

  const handleUploadReplay = async (file: File) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".osr")) {
      setError("Please choose an .osr replay file.");
      return;
    }
    if (file.size > MAX_UPLOAD_REPLAY_BYTES) {
      setError("That replay file is too large to open in the browser.");
      return;
    }

    setReplayLoadingStep("upload");
    setReplayBeatmapFileStatus("unknown");
    setReplayLoadingStartedAt(Date.now());
    setReplayLoadingElapsedMs(0);
    setLoading(true);
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);
    setUploadedReplayMods([]);
    setUploadedBeatmapsetId(undefined);
    setUploadedReplayShareUrl(null);
    setLoadedUploadId(null);

    try {
      const buffer = await file.arrayBuffer();
      await parseUploadedReplayBuffer(buffer.slice(0));
      const saved = await postUploadedReplay(buffer, file.name);
      await openUploadedReplayBuffer(buffer.slice(0), { uploadId: saved.id, shareUrl: saved.url, source: "owner", filename: file.name });
      navigate({ to: "/replay", search: { uploadId: saved.id }, replace: true });
    } catch (e) {
      setReplay(null);
      setBeatmap(null);
      setScoreInfo(null);
      setUploadedReplayMods([]);
      setUploadedBeatmapsetId(undefined);
      setUploadedReplayShareUrl(null);
      setLoadedUploadId(null);
      setError(e instanceof Error ? e.message : "Failed to load uploaded replay");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (scoreId || !uploadId) return;
    if (loadedUploadId === uploadId && replay) return;
    void loadSharedUploadedReplay(uploadId);
  }, [loadedUploadId, loadSharedUploadedReplay, replay, scoreId, uploadId]);

  useEffect(() => {
    clearTimeout(scorePreviewTimerRef.current);

    if (!playerSearchScoreId || scoreId || browseMode !== "player") {
      setScorePreview(null);
      setScorePreviewLoading(false);
      setScorePreviewError(null);
      return;
    }

    setScorePreview(null);
    setScorePreviewError(null);
    setScorePreviewLoading(true);

    let cancelled = false;
    scorePreviewTimerRef.current = setTimeout(async () => {
      try {
        const score = await getScore({ data: { scoreId: playerSearchScoreId, mode: "mania" } });
        if (cancelled) return;
        setScorePreview(score);
        setScorePreviewError(null);
      } catch {
        if (cancelled) return;
        setScorePreview(null);
        setScorePreviewError("Couldn't find score details");
      } finally {
        if (!cancelled) setScorePreviewLoading(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(scorePreviewTimerRef.current);
    };
  }, [browseMode, playerSearchScoreId, scoreId]);

  // Fetch country rankings to power the player suggestions grid (cached in store).
  useEffect(() => {
    if (browseMode !== "player" || selectedIsGlobal) return;
    const stale = !cachedRankings || isCacheStale(rankingsFetchedAt, CLIENT_CACHE_TTL.rankings);
    if (!stale) return;
    let cancelled = false;
    getRankings({ data: { type: "performance", page: 1, country: selectedCountry } })
      .then((data) => {
        if (cancelled) return;
        setRankings(selectedCountry, data);
      })
      .catch(() => { /* suggestions are non-critical */ });
    return () => { cancelled = true; };
  }, [browseMode, cachedRankings, rankingsFetchedAt, selectedCountry, setRankings, selectedIsGlobal]);

  // Global: suggestions come from the combined top-players board instead.
  useEffect(() => {
    if (browseMode !== "player" || !selectedIsGlobal || !isLiveBackendConfigured()) return;
    const cached = readGlobalTopPlayersCache();
    const fresh = cached && !isCacheStale(cached.fetchedAt, CLIENT_CACHE_TTL.rankings);
    if (cached) setGlobalSuggestions(cached.data);
    if (fresh) return;

    let cancelled = false;
    fetchLiveGlobalRankings(48)
      .then((snapshot) => {
        writeGlobalTopPlayersCache(snapshot.ranking);
        if (!cancelled) setGlobalSuggestions(snapshot.ranking);
      })
      .catch(() => { if (!cancelled) setGlobalSuggestions((prev) => prev ?? []); });
    return () => { cancelled = true; };
  }, [browseMode, selectedIsGlobal]);

  const suggestionPlayers = useMemo(
    () => {
      if (selectedIsGlobal) {
        // Global: the top 24 tracked players worldwide (by pp).
        return (globalSuggestions ?? [])
          .filter((entry) => !hiddenUserIds.has(entry.user.id))
          .slice(0, 24)
          .map((entry) => ({
            id: entry.user.id,
            username: entry.user.username,
            avatar_url: entry.user.avatar_url,
            cover_url: entry.user.cover_url || undefined,
            global_rank: entry.global_rank ?? undefined,
          }));
      }
      return (cachedRankings?.ranking ?? [])
        .filter((entry) => entry.user.is_active !== false)
        .filter((entry) => !hiddenUserIds.has(entry.user.id))
        .slice(0, 24)
        .map((entry) => ({
          id: entry.user.id,
          username: entry.user.username,
          avatar_url: entry.user.avatar_url,
          cover_url: entry.user.cover_url,
          global_rank: entry.global_rank,
        }));
    },
    [cachedRankings, hiddenUserIds, selectedIsGlobal, globalSuggestions],
  );

  // Auto-load player scores when arriving via URL with ?player=
  useEffect(() => {
    if (scoreId) return;
    if (!normalizedPlayerParam) {
      playerScoreRequestRef.current += 1;
      setPlayerScoreGroups(null);
      setPlayerLookupUserId(null);
      setLoadingScores(false);
      setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(false));
      setLoadedPlayerParam(null);
      loadingPlayerParamRef.current = null;
      return;
    }
    if (!shouldStartReplayPlayerLoad({
      normalizedPlayerParam,
      loadedPlayerParam,
      loadingPlayerParam: loadingPlayerParamRef.current,
      hasScoreId: Boolean(scoreId),
    })) return;

    playerScoreRequestRef.current += 1;
    setPlayerScoreGroups(createEmptyPlayerScoreGroups());
    setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(true));
    setLoadedPlayerParam(null);
    loadingPlayerParamRef.current = normalizedPlayerParam;
    let cancelled = false;
    (async () => {
      try {
        const loadResolvedUser = async (userId: number, cachedSnapshot?: LivePlayerProfileSnapshot | null) => {
          if (cancelled) return;
          setPlayerLookupUserId(userId);
          await loadPlayerScores(userId, {
            profileKey: cachedSnapshot ? playerParam! : String(userId),
            cachedSnapshot,
          });
          if (!cancelled) setLoadedPlayerParam(normalizedPlayerParam);
        };

        const knownUserId = playerIdsByParamRef.current.get(normalizedPlayerParam);
        if (knownUserId) {
          await loadResolvedUser(knownUserId);
          return;
        }

        const cachedSnapshot = await fetchReplayCachedProfileSnapshot(playerParam!);
        const snapshotUserId = getSnapshotUserId(cachedSnapshot);
        if (cancelled) return;
        if (snapshotUserId) {
          playerIdsByParamRef.current.set(normalizedPlayerParam, snapshotUserId);
          await loadResolvedUser(snapshotUserId, cachedSnapshot);
          return;
        }

        const res = await searchUsers({ data: { query: playerParam! } });
        const match = (res.user?.data ?? []).find(
          (u: { username: string }) => u.username.toLowerCase() === normalizedPlayerParam,
        );
        if (cancelled) return;

        if (match) {
          playerIdsByParamRef.current.set(normalizedPlayerParam, match.id);
          await loadResolvedUser(match.id);
          return;
        }

        setPlayerLookupUserId(null);
        setPlayerScoreGroups(createEmptyPlayerScoreGroups());
        setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(false));
        setLoadingScores(false);
        setLoadedPlayerParam(normalizedPlayerParam);
      } catch {
        if (!cancelled) {
          setPlayerLookupUserId(null);
          setPlayerScoreGroups(createEmptyPlayerScoreGroups());
          setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(false));
          setLoadingScores(false);
          setLoadedPlayerParam(normalizedPlayerParam);
        }
      }
      finally {
        if (loadingPlayerParamRef.current === normalizedPlayerParam) {
          loadingPlayerParamRef.current = null;
        }
      }
    })();
    return () => {
      cancelled = true;
      if (loadingPlayerParamRef.current === normalizedPlayerParam) {
        loadingPlayerParamRef.current = null;
      }
    };
  }, [normalizedPlayerParam, playerParam, scoreId, loadedPlayerParam, loadPlayerScores]);

  const loadBeatmapScorePage = async (bm: OsuBeatmap, nextPage: number) => {
    const scoreCountry = selectedIsGlobal ? undefined : selectedCountry;
    const requestId = beatmapScoreRequestRef.current + 1;
    beatmapScoreRequestRef.current = requestId;
    setSelectedDiffId(bm.id);
    setBeatmapScorePage(nextPage);
    setLoadingBeatmapScores(true);
    if (nextPage === 1) setRawBeatmapScores([]);
    setPartialBeatmapScores([]);
    setBeatmapScoreLookupStatus(null);
    try {
      const res = await getBeatmapScores({ data: { beatmapId: bm.id, country: scoreCountry, page: nextPage } });
      if (beatmapScoreRequestRef.current !== requestId) return;
      setRawBeatmapScores((current) => nextPage > 1 ? mergeScoresById(current, res.scores) : res.scores);
    } catch {
      if (beatmapScoreRequestRef.current !== requestId) return;
      if (nextPage === 1) setRawBeatmapScores([]);
    } finally {
      if (beatmapScoreRequestRef.current === requestId) {
        setLoadingBeatmapScores(false);
        setBeatmapScoreLookupStatus(null);
      }
    }
  };

  const handleSelectDifficulty = async (bm: OsuBeatmap) => {
    await loadBeatmapScorePage(bm, 1);
  };

  const handleLoadMoreBeatmapScores = async () => {
    const beatmap = selectedBeatmapset?.beatmaps?.find((b) => b.id === selectedDiffId);
    if (!beatmap || beatmapScorePage >= 2 || loadingBeatmapScores) return;
    const nextPage = 2;
    await loadBeatmapScorePage(beatmap, nextPage);
  };

  useEffect(() => {
    if (!loadingBeatmapScores || !selectedDiffId) return;

    let cancelled = false;
    const requestId = beatmapScoreRequestRef.current;
    const poll = async () => {
      const scoreCountry = selectedIsGlobal ? undefined : selectedCountry;
      try {
        const [status, partial] = await Promise.all([
          getBeatmapScoreLookupStatus({ data: { beatmapId: selectedDiffId, country: scoreCountry, page: beatmapScorePage } }),
          getPartialBeatmapScores({ data: { beatmapId: selectedDiffId, country: scoreCountry, page: beatmapScorePage } }),
        ]);
        if (cancelled || beatmapScoreRequestRef.current !== requestId) return;
        setBeatmapScoreLookupStatus(status);
        if (partial.length > 0) {
          setPartialBeatmapScores(partial);
        }
      } catch {
        // The full lookup is still authoritative; polling is just progressive UI.
      }
    };

    const stopPolling = startProgressPoll(poll);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [beatmapScorePage, loadingBeatmapScores, selectedDiffId, selectedCountry, selectedIsGlobal]);

  const handleClearReplay = () => {
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);
    setUploadedReplayMods([]);
    setUploadedBeatmapsetId(undefined);
    setUploadedReplayShareUrl(null);
    setLoadedUploadId(null);
    setReplayBeatmapFileStatus("unknown");

    const backNavigation = getReplayBackNavigation({ canGoBack, playerParam, tab: tab === "beatmap" || tab === "upload" ? tab : undefined });
    if (backNavigation.type === "history") {
      router.history.back();
      return;
    }

    navigate({ to: "/replay", search: backNavigation.search });
  };

  return (
    <div className="flex-1">
      <div className={replay ? "hidden sm:block" : ""}>
        <PageHeader
          iconSrc="/images/icons/home.svg"
          title={REPLAY_LANDING_SEO_TITLE}
        />
      </div>

      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="max-w-[1200px] mx-auto px-3 py-3 sm:px-5 sm:py-6">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center px-4 py-20 text-center">
                <div className="mb-4 h-10 w-10 rounded-full border-2 border-osu-pink/40 border-t-osu-pink animate-spin" />
                <p className="text-sm font-semibold text-osu-l2">{replayLoadingCopy.title}</p>
                <p className="mt-1 max-w-md text-xs leading-relaxed text-osu-f1">{replayLoadingCopy.detail}</p>
              </motion.div>
            ) : replay ? (
              <motion.div key="viewer" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                <ReplayInfo replay={replay} score={scoreInfo} beatmap={beatmap} fallbackBeatmapsetId={uploadedBeatmapsetId ?? beatmapsetId} shareUrl={uploadedReplayShareUrl ?? undefined} playerProfile={playerProfile} onClear={handleClearReplay} />
                <ReplayViewer replay={replay} beatmap={beatmap} scoreInfo={scoreInfo} replayMods={uploadedReplayMods} fallbackBeatmapsetId={uploadedBeatmapsetId ?? beatmapsetId} initialTime={initialTime} />
              </motion.div>
            ) : (
              <ReplayBrowseView
                mode={browseMode}
                error={error}
                selectedCountry={selectedCountry}
                onModeChange={(mode) => {
                  setBrowseMode(mode);
                  playerScoreRequestRef.current += 1;
                  setPlayerScoreGroups(null);
                  setLoadingScores(false);
                  setPlayerScoreLoadingByGroup(createPlayerScoreGroupLoading(false));
                  setBeatmapResults([]);
                  setRawBeatmapScores([]);
                  setPartialBeatmapScores([]);
                  setBeatmapScoreLookupStatus(null);
                  setBeatmapScorePage(1);
                  setSelectedBeatmapset(null);
                  setSelectedDiffId(null);
                  setBeatmapQuery("");
                  setBeatmapSearchLoading(false);
                  setUploadedReplayShareUrl(null);
                  setLoadedUploadId(null);
                  setReplayBeatmapFileStatus("unknown");
                  clearTimeout(beatmapTimerRef.current);
                  beatmapSearchRequestRef.current += 1;
                  setError(null);
                  navigate({ to: "/replay", search: mode === "beatmap" || mode === "upload" ? { tab: mode } : {}, replace: true });
                }}
                onUploadReplay={handleUploadReplay}
                onPlayerSearch={handlePlayerSearch}
                onSelectPlayer={handleSelectPlayer}
                onPlayerSearchSubmit={handlePlayerSearchSubmit}
                onPlayerQueryChange={setPlayerSearchQuery}
                playerSearchScoreId={playerSearchScoreId}
                scorePreview={scorePreview}
                scorePreviewLoading={scorePreviewLoading}
                scorePreviewError={scorePreviewError}
                onOpenScorePreview={handleOpenScorePreview}
                loadingScores={loadingScores}
                playerScoreGroups={playerScoreGroups}
                playerScoreLoadingByGroup={playerScoreLoadingByGroup}
                playerLookupUserId={playerLookupUserId}
                playerParam={playerParam}
                suggestionPlayers={suggestionPlayers}
                onOpenPlayerScore={(score) => navigate({ to: "/replay", search: { scoreId: score.id, beatmapsetId: score.beatmapset?.id, player: playerParam } })}
                beatmapQuery={beatmapQuery}
                beatmapResults={beatmapResults}
                beatmapSearchLoading={beatmapSearchLoading}
                selectedBeatmapset={selectedBeatmapset}
                selectedDiffId={selectedDiffId}
                beatmapScores={beatmapScores}
                visibleRawBeatmapScores={visibleRawBeatmapScores}
                loadingBeatmapScores={loadingBeatmapScores}
                beatmapScorePage={beatmapScorePage}
                beatmapScoreLookupStatus={beatmapScoreLookupStatus}
                onBeatmapQueryChange={(query) => {
                  setBeatmapQuery(query);
                  setSelectedDiffId(null);
                  setRawBeatmapScores([]);
                  setPartialBeatmapScores([]);
                  setBeatmapScoreLookupStatus(null);
                  setBeatmapScorePage(1);
                }}
                onSelectBeatmapset={setSelectedBeatmapset}
                onSelectDifficulty={handleSelectDifficulty}
                onOpenBeatmapScore={(score) => navigate({ to: "/replay", search: { scoreId: score.id, beatmapsetId: selectedBeatmapset?.id, tab: "beatmap" } })}
                onLoadMoreBeatmapScores={handleLoadMoreBeatmapScores}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function ReplayViewer({
  replay,
  beatmap,
  scoreInfo,
  replayMods,
  fallbackBeatmapsetId,
  initialTime,
}: {
  replay: ServerReplay;
  beatmap: ManiaBeatmap | null;
  scoreInfo: OsuScore | null;
  replayMods?: OsuMod[];
  fallbackBeatmapsetId?: number;
  initialTime?: number;
}) {
  const auth = useAuth();
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReplayRendererLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const [showFullscreenChrome, setShowFullscreenChrome] = useState(false);
  const [speed, setSpeed] = useState(1);
  const effectiveReplayMods = useMemo(() => scoreInfo?.mods ?? replayMods ?? [], [replayMods, scoreInfo?.mods]);
  const replayStableScrollSpeed = useMemo(
    () => resolveStableManiaReplayScrollSpeed(
      replay.stableScrollSpeedScale,
      beatmap?.stableScrollBpm ?? beatmap?.bpm ?? scoreInfo?.beatmap?.bpm,
    ),
    [beatmap?.bpm, beatmap?.stableScrollBpm, replay.stableScrollSpeedScale, scoreInfo?.beatmap?.bpm],
  );
  const displayScoreValues = useMemo(
    () => (scoreInfo ? getScoreDisplayValues(scoreInfo) : null),
    [scoreInfo],
  );
  const replayUsesLazerScoring = useMemo(() => {
    if (!scoreInfo) return false;
    if (scoreInfo.legacy_score_id != null || (scoreInfo.legacy_total_score != null && scoreInfo.legacy_total_score > 0)) {
      return false;
    }
    return displayScoreValues?.isLazer ?? false;
  }, [displayScoreValues?.isLazer, scoreInfo]);
  const keypressHeatmap = useMemo(() => {
    const frames = replay.frames;
    if (frames.length < 2) return [];
    const lastTime = frames[frames.length - 1].time;
    return buildKeypressHeatmap(frames, lastTime);
  }, [replay.frames]);
  const modRate = getScoreRate(effectiveReplayMods);
  const effectiveRate = speed * modRate;
  const audioPreservesPitch = !modShiftsPitchWithRate(effectiveReplayMods);
  const [scrollSpeed, setScrollSpeed] = useState(() => replayStableScrollSpeed ?? readReplayScrollSpeed());
  const [bgDim, setBgDim] = useState(readReplayBackgroundDim);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [volume, setVolume] = useState(readReplayVolume);
  const [showInputOverlay, setShowInputOverlay] = useState(readReplayInputOverlay);
  const [inputOverlayOnly, setInputOverlayOnly] = useState(readReplayInputOnly);
  const [inputOverlayKeyHistory, setInputOverlayKeyHistory] = useState(readReplayInputKeyHistory);
  const [inputOverlayColor, setInputOverlayColor] = useState(readReplayInputColor);
  const [skinSettings, setSkinSettings] = useState(readReplaySkinSettings);
  const [overlaySettings, setOverlaySettings] = useState(readReplayOverlaySettings);
  const [skinSettingsOpen, setSkinSettingsOpen] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [pendingPlay, setPendingPlay] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [bgSrc, setBgSrc] = useState<string | null>(null);
  const [localReplayVideoExportAvailable, setLocalReplayVideoExportAvailable] = useState(false);
  const [videoExport, setVideoExport] = useState<ReplayVideoExportState>({
    exporting: false,
    progress: 0,
    error: null,
    url: null,
    signed: false,
  });
  const scrubbingRef = useRef(false);
  const scrubResumeOnReleaseRef = useRef(false);
  const fullscreenChromeTimeoutRef = useRef<number | null>(null);
  const suppressNextMobileCanvasPointerUpRef = useRef(false);
  // Refs mirror state for the renderer's external clock callback so it always
  // reads the latest values without needing to be re-registered on every
  // React re-render.
  const audioEnabledRef = useRef(true);
  const audioUrlActiveRef = useRef(false);
  const showInputOverlayRef = useRef(false);
  const inputOverlayOnlyRef = useRef(false);
  const inputOverlayKeyHistoryRef = useRef(false);
  const inputOverlayColorRef = useRef("#a855f7");
  const scrollSpeedUserOverrideRef = useRef(false);
  const scrollSpeedRef = useRef(DEFAULT_REPLAY_SCROLL_SPEED);
  const skinSettingsRef = useRef<ReplaySkinSettings>(skinSettings);
  const overlaySettingsRef = useRef<ReplayOverlaySettings>(overlaySettings);
  const shouldResumeAudioRef = useRef(false);
  const volumeRef = useRef(volume);
  const recoveredVideoScoreIdRef = useRef<number | null>(null);
  const replayEndAudioFadeActiveRef = useRef(false);
  const replayEndAudioFadeFrameRef = useRef<number | null>(null);
  const isCanvasFullscreen = isNativeFullscreen || isPseudoFullscreen;
  const replayVideoExportAvailable = auth.canUseAdminFeatures && localReplayVideoExportAvailable;

  useEffect(() => {
    const scoreId = scoreInfo?.id;
    if (!replayVideoExportAvailable || !scoreId || videoExport.exporting) return;
    if (recoveredVideoScoreIdRef.current === scoreId) return;
    recoveredVideoScoreIdRef.current = scoreId;
    let cancelled = false;
    getRecentReplayVideoJob(scoreId)
      .then((job) => {
        if (cancelled || !job?.url) return;
        setVideoExport((current) => current.exporting || current.url
          ? current
          : { exporting: false, progress: 1, error: null, url: job.url ?? null, signed: Boolean(job.signed) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [replayVideoExportAvailable, scoreInfo?.id, videoExport.exporting]);

  const cancelReplayEndAudioFade = useCallback((restoreVolume = true) => {
    replayEndAudioFadeActiveRef.current = false;
    if (replayEndAudioFadeFrameRef.current != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(replayEndAudioFadeFrameRef.current);
    }
    replayEndAudioFadeFrameRef.current = null;
    if (restoreVolume && audioRef.current) {
      audioRef.current.volume = volumeRef.current;
    }
  }, []);

  const startReplayEndAudioFade = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audioEnabled || audio.ended) return false;
    if (replayEndAudioFadeActiveRef.current) return true;

    const startVolume = audio.volume;
    replayEndAudioFadeActiveRef.current = true;
    shouldResumeAudioRef.current = false;

    if (startVolume <= 0 || typeof window === "undefined") {
      cancelReplayEndAudioFade(true);
      audio.pause();
      return true;
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      if (!replayEndAudioFadeActiveRef.current) return;
      const progress = Math.min(1, Math.max(0, (now - startedAt) / REPLAY_END_AUDIO_FADE_MS));
      audio.volume = startVolume * (1 - progress);

      if (progress < 1 && !audio.paused && !audio.ended) {
        replayEndAudioFadeFrameRef.current = window.requestAnimationFrame(step);
        return;
      }

      replayEndAudioFadeActiveRef.current = false;
      replayEndAudioFadeFrameRef.current = null;
      audio.pause();
      audio.volume = volumeRef.current;
    };

    if (audio.paused && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      audio.play().catch(() => {});
    }
    replayEndAudioFadeFrameRef.current = window.requestAnimationFrame(step);
    return true;
  }, [audioEnabled, cancelReplayEndAudioFade]);

  useEffect(() => {
    setLocalReplayVideoExportAvailable(isLocalReplayVideoExportHost());
  }, []);

  const applyScrollSpeed = useCallback((next: number, persist = false) => {
    const normalized = normalizeReplayScrollSpeed(next);
    setScrollSpeed(normalized);
    if (persist) writeReplayScrollSpeed(normalized);
  }, []);

  useEffect(() => {
    scrollSpeedUserOverrideRef.current = false;
    applyScrollSpeed(replayStableScrollSpeed ?? readReplayScrollSpeed());
  }, [applyScrollSpeed, replay, replayStableScrollSpeed]);

  const applySkinSettings = useCallback((next: ReplaySkinSettings) => {
    const normalized = normalizeReplaySkinSettings(next);
    skinSettingsRef.current = normalized;
    setSkinSettings(normalized);
    rendererRef.current?.setSkinSettings(normalized);
    writeReplaySkinSettings(normalized);
  }, []);

  const applyOverlaySettings = useCallback((next: ReplayOverlaySettings) => {
    const normalized = normalizeReplayOverlaySettings(next);
    overlaySettingsRef.current = normalized;
    setOverlaySettings(normalized);
    rendererRef.current?.setOverlaySettings(normalized);
    writeReplayOverlaySettings(normalized);
  }, []);

  useEffect(() => {
    const refreshSharedReplaySettings = () => {
      if (replayStableScrollSpeed == null || scrollSpeedUserOverrideRef.current) {
        applyScrollSpeed(readReplayScrollSpeed());
      }
      setSkinSettings(readReplaySkinSettings());
      setOverlaySettings(readReplayOverlaySettings());
    };
    window.addEventListener("storage", refreshSharedReplaySettings);
    window.addEventListener(REPLAY_SCROLL_SPEED_CHANGE_EVENT, refreshSharedReplaySettings);
    window.addEventListener(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, refreshSharedReplaySettings);
    window.addEventListener(REPLAY_OVERLAY_SETTINGS_CHANGE_EVENT, refreshSharedReplaySettings);
    window.addEventListener("focus", refreshSharedReplaySettings);
    return () => {
      window.removeEventListener("storage", refreshSharedReplaySettings);
      window.removeEventListener(REPLAY_SCROLL_SPEED_CHANGE_EVENT, refreshSharedReplaySettings);
      window.removeEventListener(REPLAY_SKIN_SETTINGS_CHANGE_EVENT, refreshSharedReplaySettings);
      window.removeEventListener(REPLAY_OVERLAY_SETTINGS_CHANGE_EVENT, refreshSharedReplaySettings);
      window.removeEventListener("focus", refreshSharedReplaySettings);
    };
  }, [applyScrollSpeed, replayStableScrollSpeed]);

  const resizeReplayRenderer = useCallback(() => {
    requestAnimationFrame(() => rendererRef.current?.resize());
    window.setTimeout(() => rendererRef.current?.resize(), 180);
  }, []);

  const clearFullscreenChromeTimeout = useCallback(() => {
    if (fullscreenChromeTimeoutRef.current == null) return;
    window.clearTimeout(fullscreenChromeTimeoutRef.current);
    fullscreenChromeTimeoutRef.current = null;
  }, []);

  const showFullscreenChromeTemporarily = useCallback((autoHide = true, durationMs = FULLSCREEN_POINTER_CHROME_HIDE_MS) => {
    setShowFullscreenChrome(true);
    clearFullscreenChromeTimeout();
    if (!autoHide) return;
    fullscreenChromeTimeoutRef.current = window.setTimeout(() => {
      fullscreenChromeTimeoutRef.current = null;
      if (!scrubbingRef.current) setShowFullscreenChrome(false);
    }, durationMs);
  }, [clearFullscreenChromeTimeout]);

  const toggleReplayFullscreen = () => {
    void (async () => {
      const container = canvasContainerRef.current;
      if (!container) return;

      if (isCanvasFullscreen) {
        setIsPseudoFullscreen(false);
        if (isNativeFullscreen || getNativeFullscreenElement() === container) {
          await exitNativeFullscreen().catch(() => {});
        }
        return;
      }

      setIsPseudoFullscreen(true);
      resizeReplayRenderer();

      try {
        const entered = await requestNativeFullscreen(container);
        if (!entered) resizeReplayRenderer();
      } catch {
        setIsPseudoFullscreen(true);
      }
    })();
  };

  const handleReplayCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isCanvasFullscreen) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const bottomDistance = rect.bottom - event.clientY;
    if (bottomDistance <= 190 || showFullscreenChrome) {
      showFullscreenChromeTemporarily();
    }
  }, [isCanvasFullscreen, showFullscreenChrome, showFullscreenChromeTemporarily]);

  const handleReplayCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isMobileReplayPointer(event)) return;
    if (isCanvasFullscreen && showFullscreenChrome) {
      suppressNextMobileCanvasPointerUpRef.current = true;
      clearFullscreenChromeTimeout();
      setShowFullscreenChrome(false);
      return;
    }
    suppressNextMobileCanvasPointerUpRef.current = false;
    showFullscreenChromeTemporarily(
      true,
      isCanvasFullscreen ? FULLSCREEN_TAP_CHROME_HIDE_MS : MOBILE_FULLSCREEN_BUTTON_HIDE_MS,
    );
  }, [clearFullscreenChromeTimeout, isCanvasFullscreen, showFullscreenChrome, showFullscreenChromeTemporarily]);

  const handleReplayCanvasPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isCanvasFullscreen || !isMobileReplayPointer(event)) return;
    if (suppressNextMobileCanvasPointerUpRef.current) {
      suppressNextMobileCanvasPointerUpRef.current = false;
      return;
    }
    showFullscreenChromeTemporarily(true, FULLSCREEN_TAP_CHROME_HIDE_MS);
  }, [isCanvasFullscreen, showFullscreenChromeTemporarily]);

  const handleReplayCanvasPointerLeave = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isCanvasFullscreen || scrubbingRef.current) return;
    if (isMobileReplayPointer(event)) return;
    clearFullscreenChromeTimeout();
    setShowFullscreenChrome(false);
  }, [clearFullscreenChromeTimeout, isCanvasFullscreen]);

  // Build full audio URL from the server archive extractor using beatmapset ID + audio filename from .osu.
  const effectiveBeatmapsetId = scoreInfo?.beatmapset?.id ?? fallbackBeatmapsetId;
  const audioUrl = effectiveBeatmapsetId && beatmap?.audioFilename
    ? getBeatmapAudioUrl(effectiveBeatmapsetId, beatmap.audioFilename)
    : null;
  const coverUrl = scoreInfo?.beatmapset?.covers?.["cover@2x"] || scoreInfo?.beatmapset?.covers?.cover || null;
  const coverProxyUrl = effectiveBeatmapsetId
    ? `/api/background?beatmapsetId=${encodeURIComponent(String(effectiveBeatmapsetId))}`
    : null;
  const beatmapBackgroundUrl = effectiveBeatmapsetId && beatmap?.backgroundFilename
    ? `/api/background?beatmapsetId=${encodeURIComponent(String(effectiveBeatmapsetId))}&filename=${encodeURIComponent(beatmap.backgroundFilename)}`
    : null;

  // Prefer the map's real background from the beatmap archive, then fall back to the set cover.
  useEffect(() => {
    let cancelled = false;

    if (!beatmapBackgroundUrl && !coverUrl) {
      setBgSrc(null);
      return () => {
        cancelled = true;
      };
    }

    if (coverUrl) {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (!cancelled) setBgSrc((current) => current ?? coverUrl);
      };
      img.src = coverUrl;
    }

    if (beatmapBackgroundUrl) {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        if (!cancelled) setBgSrc(beatmapBackgroundUrl);
      };
      img.src = beatmapBackgroundUrl;
    }

    return () => {
      cancelled = true;
    };
  }, [beatmapBackgroundUrl, coverUrl]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const updateFullscreenState = () => {
      const active = getNativeFullscreenElement() === canvasContainerRef.current;
      setIsNativeFullscreen(active);
      if (!getNativeFullscreenElement()) setIsPseudoFullscreen(false);
      resizeReplayRenderer();
    };

    updateFullscreenState();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    document.addEventListener("webkitfullscreenchange", updateFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreenState);
      document.removeEventListener("webkitfullscreenchange", updateFullscreenState);
    };
  }, [resizeReplayRenderer]);

  useEffect(() => {
    if (!isCanvasFullscreen) {
      clearFullscreenChromeTimeout();
      setShowFullscreenChrome(false);
      return;
    }
    showFullscreenChromeTemporarily();
  }, [clearFullscreenChromeTimeout, isCanvasFullscreen, showFullscreenChromeTemporarily]);

  useEffect(() => () => clearFullscreenChromeTimeout(), [clearFullscreenChromeTimeout]);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeReplayRenderer);
    observer.observe(container);
    return () => observer.disconnect();
  }, [resizeReplayRenderer]);

  useEffect(() => {
    if (!isPseudoFullscreen || typeof document === "undefined") return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousOverscroll = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overscrollBehavior = previousOverscroll;
    };
  }, [isPseudoFullscreen]);

  useEffect(() => {
    if (!isPseudoFullscreen || typeof window === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsPseudoFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPseudoFullscreen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    resizeReplayRenderer();
    const orientation = window.screen.orientation;
    window.addEventListener("orientationchange", resizeReplayRenderer);
    orientation?.addEventListener("change", resizeReplayRenderer);
    return () => {
      window.removeEventListener("orientationchange", resizeReplayRenderer);
      orientation?.removeEventListener("change", resizeReplayRenderer);
    };
  }, [isCanvasFullscreen, resizeReplayRenderer]);

  useEffect(() => {
    cancelReplayEndAudioFade(false);
    setAudioError(null);
    setAudioReady(false);
    setBuffering(false);
    shouldResumeAudioRef.current = false;
    audioUrlActiveRef.current = !!audioUrl;
  }, [audioUrl, cancelReplayEndAudioFade]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    return () => cancelReplayEndAudioFade(false);
  }, [cancelReplayEndAudioFade]);

  useEffect(() => {
    audioEnabledRef.current = audioEnabled;
  }, [audioEnabled]);

  useEffect(() => {
    showInputOverlayRef.current = showInputOverlay;
    if (rendererRef.current) {
      rendererRef.current.setShowInputOverlay(showInputOverlay);
    }
  }, [showInputOverlay]);

  useEffect(() => {
    inputOverlayOnlyRef.current = inputOverlayOnly;
    inputOverlayKeyHistoryRef.current = inputOverlayKeyHistory;
    inputOverlayColorRef.current = inputOverlayColor;
    rendererRef.current?.setInputOverlayOptions({
      only: inputOverlayOnly,
      color: inputOverlayColor,
      keyHistory: inputOverlayKeyHistory,
    });
  }, [inputOverlayOnly, inputOverlayKeyHistory, inputOverlayColor]);

  useEffect(() => {
    scrollSpeedRef.current = scrollSpeed;
    if (rendererRef.current) {
      rendererRef.current.setScrollSpeed(scrollSpeed);
    }
  }, [scrollSpeed]);

  useEffect(() => {
    skinSettingsRef.current = skinSettings;
    if (rendererRef.current) {
      rendererRef.current.setSkinSettings(skinSettings);
    }
  }, [skinSettings]);

  useEffect(() => {
    overlaySettingsRef.current = overlaySettings;
    rendererRef.current?.setOverlaySettings(overlaySettings);
  }, [overlaySettings]);

  // Create renderer
  useEffect(() => {
    if (!canvasRef.current || replay.frames.length === 0) return;

    let cancelled = false;
    let renderer: ReplayRendererLike | null = null;
    let handleResize: (() => void) | null = null;
    setRendererError(null);

    void (async () => {
      try {
        const { ManiaReplayRenderer } = await withTimeout(
          import("../components/replay/ReplayCanvas"),
          8000,
          "Timed out loading the replay renderer.",
        );
        if (cancelled || !canvasRef.current) return;

        renderer = new ManiaReplayRenderer(
          canvasRef.current,
          replay.frames,
          replay.keyCount,
          beatmap?.notes ?? [],
          {
            isConvert: scoreInfo?.beatmap?.convert ?? false,
            isLazer: replayUsesLazerScoring,
            od: beatmap?.od,
            showInputOverlay: showInputOverlayRef.current,
            mods: effectiveReplayMods,
            speedMultiplier: modRate,
            transparentBackground: true,
            scrollVelocities: beatmap?.scrollVelocities,
            expectedCounts: getScoreExpectedCounts(scoreInfo, replay),
            lifeBarFrames: replay.lifeBarFrames,
            skinSettings: skinSettingsRef.current,
            overlaySettings: overlaySettingsRef.current,
            onOverlaySettingsChange: applyOverlaySettings,
            inputOverlayOnly: inputOverlayOnlyRef.current,
            inputOverlayColor: inputOverlayColorRef.current,
            inputOverlayKeyHistory: inputOverlayKeyHistoryRef.current,
          },
        ) as ReplayRendererLike;

        await withTimeout(
          renderer.ready(),
          8000,
          "Timed out starting the replay renderer.",
        );

        if (cancelled) {
          renderer.destroy();
          return;
        }

        renderer.setScrollSpeed(scrollSpeedRef.current);
        renderer.setShowInputOverlay(showInputOverlayRef.current);
        renderer.setInputOverlayOptions({
          only: inputOverlayOnlyRef.current,
          color: inputOverlayColorRef.current,
          keyHistory: inputOverlayKeyHistoryRef.current,
        });
        renderer.setSkinSettings(skinSettingsRef.current);
        renderer.setOverlaySettings(overlaySettingsRef.current);
        rendererRef.current = renderer;

        // Install the audio-driven clock. When audio is enabled and actually
        // making sound, the renderer derives currentTime from audio.currentTime
        // (i.e. audio is the master). When audio is seeking/buffering we
        // freeze the renderer so it can't drift ahead of the song. When audio
        // is disabled we return null and the renderer falls back to wall clock.
        renderer.setExternalClock(() => {
          if (!audioEnabledRef.current || !audioUrlActiveRef.current) return null;
          const audio = audioRef.current;
          if (!audio) return null;
          const stalled =
            audio.paused ||
            audio.seeking ||
            audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
          return { time: audio.currentTime * 1000, stalled };
        });

        if (initialTime != null && initialTime > 0) {
          const gameTimeMs = initialTime * 1000 * modRate;
          renderer.seek(gameTimeMs);
          // ReplayProgressBar polls the renderer on an interval, so it will pick
          // up the seeked position on its next tick.
        }

        handleResize = () => renderer?.resize();
        window.addEventListener("resize", handleResize);
      } catch (e) {
        const message = e instanceof Error ? e.message : "Failed to start the replay renderer.";
        console.error("Replay renderer failed to start", e);
        renderer?.destroy();
        renderer = null;
        if (!cancelled) {
          rendererRef.current = null;
          setIsPlaying(false);
          setRendererError(message);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (handleResize) window.removeEventListener("resize", handleResize);
      if (rendererRef.current) {
        rendererRef.current.destroy();
        rendererRef.current = null;
      }
    };
  }, [replay, beatmap, initialTime, modRate, effectiveReplayMods, replayUsesLazerScoring, scoreInfo?.beatmap?.convert, applyOverlaySettings]);

  // Detect when the renderer reaches the end on its own (no more frames) and
  // flip isPlaying back. ReplayProgressBar polls the renderer independently
  // for its slider; this effect just handles the "playback ended" transition.
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      if (!r.isPlaying) {
        if (r.time >= r.duration) startReplayEndAudioFade();
        setIsPlaying(false);
      }
    }, 250);
    return () => clearInterval(id);
  }, [isPlaying, startReplayEndAudioFade]);

  // Sync audio with replay play/pause/seek
  useEffect(() => {
    if (!audioRef.current || !audioEnabled) return;
    if (!replayEndAudioFadeActiveRef.current) audioRef.current.volume = volume;
    if (isPlaying) {
      cancelReplayEndAudioFade();
      audioRef.current.playbackRate = effectiveRate;
      setAudioPreservesPitch(audioRef.current, audioPreservesPitch);
      if (audioRef.current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        audioRef.current.play().catch(() => {});
      } else {
        shouldResumeAudioRef.current = true;
      }
    } else {
      shouldResumeAudioRef.current = false;
      if (!replayEndAudioFadeActiveRef.current) audioRef.current.pause();
    }
  }, [isPlaying, audioEnabled, speed, volume, cancelReplayEndAudioFade]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeReplayVolume(volume);
  }, [volume]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeReplayInputOverlay(showInputOverlay);
  }, [showInputOverlay]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeReplayInputOnly(inputOverlayOnly);
  }, [inputOverlayOnly]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeReplayInputKeyHistory(inputOverlayKeyHistory);
  }, [inputOverlayKeyHistory]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeReplayInputColor(inputOverlayColor);
  }, [inputOverlayColor]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    writeReplayBackgroundDim(bgDim);
  }, [bgDim]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const resumeAudioIfNeeded = () => {
      if (!audioEnabled || !isPlaying) return;
      const renderer = rendererRef.current;
      if (audio.ended || !renderer?.isPlaying || renderer.time >= renderer.duration) {
        if (!audio.ended && renderer?.isPlaying && renderer.time >= renderer.duration) {
          startReplayEndAudioFade();
          setBuffering(false);
          setIsPlaying(false);
          return;
        }
        shouldResumeAudioRef.current = false;
        setBuffering(false);
        setIsPlaying(false);
        audio.pause();
        return;
      }
      if (!audio.paused) return;
      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
      shouldResumeAudioRef.current = false;
      audio.playbackRate = effectiveRate;
      setAudioPreservesPitch(audio, audioPreservesPitch);
      audio.volume = volume;
      audio.play().catch(() => {
        shouldResumeAudioRef.current = true;
      });
    };

    const updateBuffering = () => {
      if (!isPlaying || !audioEnabled) {
        setBuffering(false);
        return;
      }
      setBuffering(
        audio.paused ||
          audio.seeking ||
          audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      );
    };

    const handleCanPlay = () => { resumeAudioIfNeeded(); updateBuffering(); };
    const handleCanPlayThrough = () => { resumeAudioIfNeeded(); updateBuffering(); };
    const handleSeeked = () => { resumeAudioIfNeeded(); updateBuffering(); };
    const handleLoadedData = () => { resumeAudioIfNeeded(); updateBuffering(); };
    const handleLoadedMetadata = () => { setAudioReady(true); updateBuffering(); };
    const handlePlaying = () => updateBuffering();
    const handleWaiting = () => updateBuffering();
    const handleStalled = () => updateBuffering();
    const handleSeeking = () => updateBuffering();
    const handleEnded = () => {
      cancelReplayEndAudioFade();
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.seek(renderer.duration);
        renderer.pause();
      }
      shouldResumeAudioRef.current = false;
      setBuffering(false);
      setIsPlaying(false);
    };
    // We deliberately don't try to auto-resume from the "pause" event — user
    // pauses (togglePlay, scrub) fire this synchronously, and resuming here
    // would immediately undo them. Browser-initiated background-tab pauses
    // are picked up by the visibilitychange handler below instead.
    const handlePause = () => updateBuffering();

    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("canplaythrough", handleCanPlayThrough);
    audio.addEventListener("seeked", handleSeeked);
    audio.addEventListener("loadeddata", handleLoadedData);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("stalled", handleStalled);
    audio.addEventListener("seeking", handleSeeking);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("pause", handlePause);

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) setAudioReady(true);
    updateBuffering();

    // When the tab becomes visible again, some browsers leave the audio
    // paused. Resume it so the renderer (which waits on the audio clock)
    // can start advancing again.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      resumeAudioIfNeeded();
      updateBuffering();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("canplaythrough", handleCanPlayThrough);
      audio.removeEventListener("seeked", handleSeeked);
      audio.removeEventListener("loadeddata", handleLoadedData);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("stalled", handleStalled);
      audio.removeEventListener("seeking", handleSeeking);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("pause", handlePause);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [audioEnabled, isPlaying, effectiveRate, volume, audioUrl, startReplayEndAudioFade, cancelReplayEndAudioFade]);

  // Sync audio time on seek — pause first to force re-buffer, then resume
  const syncAudioTime = (timeMs: number) => {
    if (!audioRef.current || !audioEnabled) return;
    cancelReplayEndAudioFade();
    const wasPlaying = !audioRef.current.paused;
    shouldResumeAudioRef.current = wasPlaying || isPlaying;
    audioRef.current.pause();
    audioRef.current.currentTime = timeMs / 1000;
    if ((wasPlaying || isPlaying) && audioRef.current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      shouldResumeAudioRef.current = false;
      audioRef.current.play().catch(() => {});
    }
  };

  const startPlayback = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    cancelReplayEndAudioFade();
    if (r.time >= r.duration) r.seek(0);
    r.play();
    setIsPlaying(true);
    // Play audio directly from user gesture so browsers don't block it
    if (audioRef.current && audioEnabled) {
      audioRef.current.currentTime = r.time / 1000;
      audioRef.current.playbackRate = effectiveRate;
      setAudioPreservesPitch(audioRef.current, audioPreservesPitch);
      audioRef.current.volume = volume;
      audioRef.current.play().catch(() => {
        shouldResumeAudioRef.current = true;
      });
    }
  }, [audioEnabled, audioPreservesPitch, effectiveRate, volume, cancelReplayEndAudioFade]);

  const togglePlay = () => {
    const r = rendererRef.current;
    if (!r) return;
    if (isPlaying) {
      cancelReplayEndAudioFade();
      r.pause();
      setIsPlaying(false);
      setPendingPlay(false);
      return;
    }
    // Second click while already queued cancels the pending start
    if (pendingPlay) {
      setPendingPlay(false);
      return;
    }
    // Audio is expected but hasn't loaded metadata yet — queue the play.
    if (audioEnabled && audioUrl && !audioReady && !audioError) {
      setPendingPlay(true);
      return;
    }
    startPlayback();
  };

  // Auto-start playback once the audio has metadata (or failed, or audio was
  // disabled) after the user already clicked play.
  useEffect(() => {
    if (!pendingPlay || isPlaying) return;
    if (audioEnabled && audioUrl && !audioReady && !audioError) return;
    setPendingPlay(false);
    startPlayback();
  }, [pendingPlay, isPlaying, audioEnabled, audioUrl, audioReady, audioError, startPlayback]);

  const toggleAudio = () => {
    if (!audioRef.current) return;
    cancelReplayEndAudioFade();
    if (audioEnabled) {
      audioRef.current.pause();
      setAudioEnabled(false);
    } else {
      // Sync audio to current replay time
      const r = rendererRef.current;
      if (r) audioRef.current.currentTime = r.time / 1000;
      audioRef.current.playbackRate = effectiveRate;
      setAudioPreservesPitch(audioRef.current, audioPreservesPitch);
      shouldResumeAudioRef.current = isPlaying;
      if (isPlaying && audioRef.current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        shouldResumeAudioRef.current = false;
        audioRef.current.play().catch(() => {});
      }
      setAudioEnabled(true);
    }
  };


  const handleAudioError = () => {
    cancelReplayEndAudioFade();
    setAudioError("Couldn't load the song audio for this replay.");
    shouldResumeAudioRef.current = false;
  };

  const handleProgressPointerDown = () => {
    const r = rendererRef.current;
    if (!r) return;
    cancelReplayEndAudioFade();
    if (isCanvasFullscreen) showFullscreenChromeTemporarily(false);
    scrubbingRef.current = true;
    scrubResumeOnReleaseRef.current = r.isPlaying;
    if (r.isPlaying) {
      r.pause();
      setIsPlaying(false);
    }
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  };

  const handleProgressPointerUp = () => {
    const r = rendererRef.current;
    if (!r) {
      scrubbingRef.current = false;
      scrubResumeOnReleaseRef.current = false;
      if (isCanvasFullscreen) showFullscreenChromeTemporarily();
      return;
    }
    scrubbingRef.current = false;
    if (isCanvasFullscreen) showFullscreenChromeTemporarily();
    if (audioRef.current && audioEnabled) {
      audioRef.current.currentTime = r.time / 1000;
      audioRef.current.playbackRate = effectiveRate;
      setAudioPreservesPitch(audioRef.current, audioPreservesPitch);
      audioRef.current.volume = volume;
    }
    if (scrubResumeOnReleaseRef.current) {
      scrubResumeOnReleaseRef.current = false;
      r.play();
      setIsPlaying(true);
      if (audioRef.current && audioEnabled) {
        if (audioRef.current.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          audioRef.current.play().catch(() => {
            shouldResumeAudioRef.current = true;
          });
        } else {
          shouldResumeAudioRef.current = true;
        }
      }
    }
  };

  const handleProgressSeek = (timeMs: number) => {
    rendererRef.current?.seek(timeMs);
    // During an active pointer scrub, don't touch audio — it's synced once on
    // release. Keyboard/accessibility scrubs still go through the audio sync.
    if (!scrubbingRef.current) {
      syncAudioTime(timeMs);
    }
  };

  const exportReplayVideo = useCallback(async (options: ReplayVideoExportRequest): Promise<ReplayVideoJobPayload | null> => {
    const sourceCanvas = canvasRef.current;
    const sourceRenderer = rendererRef.current;
    if (!sourceRenderer || !sourceCanvas) return null;

    const replayDuration = Math.max(0, sourceRenderer.duration);
    let startTime = 0;
    let endTime = replayDuration;

    if (options.kind === "custom") {
      const markedStart = Math.max(0, Math.min(replayDuration, options.startTimeMs ?? 0));
      const markedEnd = Math.max(0, Math.min(replayDuration, options.endTimeMs ?? 0));
      startTime = Math.min(markedStart, markedEnd);
      endTime = Math.max(markedStart, markedEnd);
      if (endTime - startTime < 500) {
        setVideoExport({ exporting: false, progress: 0, error: "Mark a longer custom clip range.", url: null, signed: false });
        return null;
      }
    } else if (options.kind === "clip") {
      const clipSeconds = Math.max(1, Math.min(120, Math.round(options.durationSeconds ?? REPLAY_VIDEO_EXPORT_CLIP_SECONDS)));
      startTime = sourceRenderer.time >= replayDuration - 500 ? 0 : sourceRenderer.time;
      endTime = Math.min(
        replayDuration,
        startTime + clipSeconds * 1000 * Math.max(0.01, effectiveRate),
      );
    }

    const sourceDurationMs = Math.max(1, endTime - startTime);
    const outputDurationSeconds = sourceDurationMs / (1000 * Math.max(0.01, effectiveRate));
    const exportFps = options.fps ?? 48;
    const frameCount = Math.max(1, Math.ceil(outputDurationSeconds * exportFps));
    const exportBgDim = options.bgDim ?? bgDim;
    const exportScrollSpeed = options.scrollSpeed ?? scrollSpeed;
    const exportShowInputOverlay = options.showInputOverlay ?? showInputOverlay;
    const exportInputOverlayOnly = options.inputOverlayOnly ?? inputOverlayOnly;
    const exportInputOverlayColor = options.inputOverlayColor ?? inputOverlayColor;
    const exportInputOverlayKeyHistory = options.inputOverlayKeyHistory ?? inputOverlayKeyHistory;
    const exportSkinSettings = options.skinSettings ?? skinSettings;
    const exportOverlaySettings = options.overlaySettings ?? overlaySettings;
    let exportRenderer: ReplayRendererLike | null = null;
    let exportHost: HTMLDivElement | null = null;
    let jobId: string | null = null;

    setVideoExport({ exporting: true, progress: 0, error: null, url: null, signed: false });

    try {
      const resolution = REPLAY_VIDEO_EXPORT_RESOLUTIONS[options.resolution] ?? REPLAY_VIDEO_EXPORT_RESOLUTIONS["1080p"];
      const player = sanitizeReplayVideoFilename(replay.header.playerName || scoreInfo?.user?.username || "player");
      const title = sanitizeReplayVideoFilename(scoreInfo?.beatmapset?.title ?? "replay");
      const diff = sanitizeReplayVideoFilename(scoreInfo?.beatmap?.version ?? "mania");
      const scoreSuffix = scoreInfo?.id ? `-${scoreInfo.id}` : "";
      const filename = `${player}-${title}-${diff}${scoreSuffix}.mp4`;

      if (!options.forceClientRender && getLiveBackendUrl() && shouldUseServerReplayVideoRender()) {
        const job = await postReplayVideoJson<ReplayVideoJobPayload>("server-render", {
          scoreId: scoreInfo?.id ?? null,
          beatmapsetId: effectiveBeatmapsetId ?? null,
          filename,
          kind: options.kind,
          startTimeMs: options.startTimeMs,
          endTimeMs: options.endTimeMs,
          resolution: options.resolution,
          fps: exportFps,
          width: resolution.width,
          height: resolution.height,
          frameCount,
          audioStartSeconds: startTime / 1000,
          sourceDurationSeconds: sourceDurationMs / 1000,
          effectiveRate,
          bgDim: exportBgDim,
          scrollSpeed: exportScrollSpeed,
          showInputOverlay: exportShowInputOverlay,
          inputOverlayOnly: exportInputOverlayOnly,
          inputOverlayColor: exportInputOverlayColor,
          inputOverlayKeyHistory: exportInputOverlayKeyHistory,
          skinSettings: exportSkinSettings,
          overlaySettings: exportOverlaySettings,
        });
        jobId = job.id;
        const uploaded = await waitForReplayVideoJob(job.id, (progress) => {
          setVideoExport({ exporting: true, progress, error: null, url: null, signed: false });
        }, {
          minProgress: 0.04,
          maxProgress: 0.98,
          timeoutMs: 30 * 60_000,
          intervalMs: 3_000,
        });
        const done = { ...job, status: "done" as const, url: uploaded.url, signed: uploaded.signed };
        setVideoExport({ exporting: false, progress: 1, error: null, url: uploaded.url, signed: uploaded.signed });
        return done;
      }

      const cssWidth = resolution.width;
      const cssHeight = resolution.height;
      exportHost = document.createElement("div");
      exportHost.dataset.replayFullscreen = "true";
      exportHost.style.cssText = [
        "position:fixed",
        "left:-10000px",
        "top:0",
        `width:${cssWidth}px`,
        `height:${cssHeight}px`,
        "overflow:hidden",
        "pointer-events:none",
        "opacity:0",
      ].join(";");

      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = cssWidth;
      exportCanvas.height = cssHeight;
      exportCanvas.style.width = `${cssWidth}px`;
      exportCanvas.style.height = `${cssHeight}px`;
      exportHost.appendChild(exportCanvas);
      document.body.appendChild(exportHost);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const { ManiaReplayRenderer } = await withTimeout(
        import("../components/replay/ReplayCanvas"),
        8000,
        "Timed out loading the replay renderer.",
      );

      exportRenderer = new ManiaReplayRenderer(
        exportCanvas,
        replay.frames,
        replay.keyCount,
        beatmap?.notes ?? [],
        {
          isConvert: scoreInfo?.beatmap?.convert ?? false,
          isLazer: replayUsesLazerScoring,
          od: beatmap?.od,
          showInputOverlay: exportShowInputOverlay,
          mods: effectiveReplayMods,
          speedMultiplier: modRate,
          transparentBackground: true,
          hidePerformanceStats: true,
          scrollVelocities: beatmap?.scrollVelocities,
          expectedCounts: getScoreExpectedCounts(scoreInfo, replay),
          lifeBarFrames: replay.lifeBarFrames,
          skinSettings: exportSkinSettings,
          overlaySettings: exportOverlaySettings,
          inputOverlayOnly: exportInputOverlayOnly,
          inputOverlayColor: exportInputOverlayColor,
          inputOverlayKeyHistory: exportInputOverlayKeyHistory,
        },
      ) as ReplayRendererLike;

      await withTimeout(
        exportRenderer.ready(),
        8000,
        "Timed out starting the export renderer.",
      );
      exportRenderer.setScrollSpeed(exportScrollSpeed);
      exportRenderer.setSpeed(speed);

      const width = cssWidth;
      const height = cssHeight;
      const compositeCanvas = document.createElement("canvas");
      compositeCanvas.width = width;
      compositeCanvas.height = height;
      const ctx = compositeCanvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Couldn't create the video compositor.");

      let backgroundImage = exportBgDim >= 100
        ? null
        : await loadFirstExportBackground([beatmapBackgroundUrl, bgSrc, coverProxyUrl, coverUrl]);
      const drawCompositeFrame = () => {
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, "#0a0a18");
        gradient.addColorStop(0.5, "#1a1016");
        gradient.addColorStop(1, "#0c0c14");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        if (backgroundImage) {
          try {
            ctx.save();
            ctx.globalAlpha = 1;
            drawCoverImage(ctx, backgroundImage, width, height);
            ctx.restore();
          } catch {
            backgroundImage = null;
          }
        }

        ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0, Math.min(1, exportBgDim / 100))})`;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(exportCanvas, 0, 0, width, height);
      };

      const job = await postReplayVideoJson<{ id: string }>("start", {
        scoreId: scoreInfo?.id ?? null,
        filename,
        fps: exportFps,
        width,
        height,
        frameCount,
        audioUrl: audioEnabled && audioUrl && !audioError ? new URL(audioUrl, window.location.origin).toString() : null,
        audioStartSeconds: startTime / 1000,
        sourceDurationSeconds: sourceDurationMs / 1000,
        effectiveRate,
      });
      jobId = job.id;

      const { encodeReplayCanvasToMp4 } = await import("../lib/replay-video-encoder");
      const encodedVideo = await encodeReplayCanvasToMp4({
        canvas: compositeCanvas,
        width,
        height,
        fps: exportFps,
        frameCount,
        bitrate: getReplayVideoBitrate(width, height, exportFps),
        renderFrame: async (index) => {
          const gameTime = Math.min(endTime, startTime + (index / exportFps) * 1000 * effectiveRate);
          await exportRenderer?.renderFrameAt?.(gameTime);
          drawCompositeFrame();
        },
        onProgress: (progress) => {
          setVideoExport({
            exporting: true,
            progress: Math.min(0.86, progress * 0.86),
            error: null,
            url: null,
            signed: false,
          });
        },
      });

      setVideoExport({
        exporting: true,
        progress: 0.9,
        error: null,
        url: null,
        signed: false,
      });
      await postReplayVideoBlob(jobId, encodedVideo);

      setVideoExport({
        exporting: true,
        progress: 0.94,
        error: null,
        url: null,
        signed: false,
      });
      const finished = await postReplayVideoJson<ReplayVideoJobPayload>("finish", {}, jobId);
      const uploaded = finished.status === "done" && finished.url
        ? { url: finished.url, signed: Boolean(finished.signed) }
        : await waitForReplayVideoJob(jobId, (progress) => {
            setVideoExport({
              exporting: true,
              progress,
              error: null,
              url: null,
              signed: false,
            });
          }, { minProgress: 0.94, maxProgress: 0.99, timeoutMs: 20 * 60_000 });
      setVideoExport({
        exporting: false,
        progress: 1,
        error: null,
        url: uploaded.url,
        signed: uploaded.signed,
      });
      return { id: jobId, status: "done", url: uploaded.url, signed: uploaded.signed };
    } catch (error) {
      if (jobId && options.forceClientRender) {
        void postReplayVideoJson("cancel", {}, jobId).catch(() => {});
      }
      const message = error instanceof Error ? error.message : "Couldn't export the replay video.";
      setVideoExport({ exporting: false, progress: 0, error: message, url: null, signed: false });
      throw error;
    } finally {
      exportRenderer?.destroy();
      exportRenderer = null;
      exportHost?.remove();
    }
  }, [
    audioEnabled,
    audioError,
    audioUrl,
    bgDim,
    bgSrc,
    effectiveRate,
    effectiveBeatmapsetId,
    beatmap,
    beatmapBackgroundUrl,
    inputOverlayColor,
    inputOverlayKeyHistory,
    inputOverlayOnly,
    effectiveReplayMods,
    modRate,
    overlaySettings,
    replay.header.playerName,
    replay.frames,
    replay.keyCount,
    replay.lifeBarFrames,
    replayUsesLazerScoring,
    scoreInfo,
    scoreInfo?.beatmap?.version,
    scoreInfo?.beatmapset?.title,
    scoreInfo?.id,
    scoreInfo?.user?.username,
    scrollSpeed,
    showInputOverlay,
    skinSettings,
    speed,
  ]);

  useEffect(() => {
    window.__maniaHubExportReplayVideo = async (options) => {
      const startedAt = Date.now();
      while ((!rendererRef.current || !canvasRef.current) && Date.now() - startedAt < 120_000) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      return exportReplayVideo({ ...options, forceClientRender: true });
    };
    return () => {
      if (window.__maniaHubExportReplayVideo) delete window.__maniaHubExportReplayVideo;
    };
  }, [exportReplayVideo]);

  const fullscreenChromeVisible = isCanvasFullscreen && showFullscreenChrome;
  const mobileFullscreenButtonVisible = !isCanvasFullscreen && showFullscreenChrome;

  return (
    <div className="space-y-3">
      {/* Canvas */}
      <div
        ref={canvasContainerRef}
        data-replay-fullscreen={isCanvasFullscreen ? "true" : undefined}
        onPointerMove={handleReplayCanvasPointerMove}
        onPointerUp={handleReplayCanvasPointerUp}
        onPointerLeave={handleReplayCanvasPointerLeave}
        className={`group/replay-canvas relative overflow-hidden bg-[#0a0a18] ${
          isCanvasFullscreen
            ? `${isPseudoFullscreen ? "fixed inset-0 z-[100]" : ""} h-[100dvh] w-screen max-w-none rounded-none border-0`
            : "rounded-xl border border-osu-b3/20"
        }`}
        style={isCanvasFullscreen ? { width: "100vw", height: "100dvh", maxWidth: "none" } : undefined}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: "linear-gradient(180deg, #0a0a18 0%, #1a1016 50%, #0c0c14 100%)" }}
        />
        <AnimatePresence>
          {bgSrc && (
            <motion.img
              key={bgSrc}
              src={bgSrc}
              alt=""
              className="absolute inset-0 h-full w-full scale-[1.02] object-cover pointer-events-none select-none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6, ease: "easeInOut" }}
            />
          )}
        </AnimatePresence>
        <div
          className="absolute inset-0 pointer-events-none bg-black transition-opacity"
          style={{ opacity: bgDim / 100 }}
        />
        <canvas
          ref={canvasRef}
          onPointerDown={handleReplayCanvasPointerDown}
          className={`relative z-10 w-full ${
            isCanvasFullscreen
              ? "h-[100dvh] min-h-0 max-h-none"
              : "h-[calc(100dvh-315px)] min-h-[390px] max-h-[560px] sm:h-[min(70vh,600px)] sm:min-h-0 sm:max-h-none"
          }`}
        />
        <button
          type="button"
          onClick={toggleReplayFullscreen}
          aria-label={isCanvasFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          title={isCanvasFullscreen ? "Exit fullscreen" : "Fullscreen"}
          className={`absolute bottom-3 right-3 z-30 flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm text-white/70 drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)] transition hover:bg-white/10 hover:text-white hover:opacity-100 focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/50 active:scale-95 sm:h-9 sm:w-9 ${
            isCanvasFullscreen
              ? fullscreenChromeVisible ? "opacity-90" : "opacity-0"
              : mobileFullscreenButtonVisible ? "opacity-90" : "opacity-0 group-hover/replay-canvas:opacity-90"
          }`}
          style={isCanvasFullscreen ? {
            bottom: "max(0.75rem, env(safe-area-inset-bottom))",
            right: "max(0.75rem, env(safe-area-inset-right))",
          } : undefined}
        >
          {isCanvasFullscreen ? <Minimize2 className="h-[18px] w-[18px]" /> : <Maximize2 className="h-[18px] w-[18px]" />}
        </button>
        {isCanvasFullscreen && (
          <div
            className={`absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-2 pb-3 pt-14 transition-opacity duration-150 ${
              fullscreenChromeVisible
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0"
            }`}
            style={{
              paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
              paddingLeft: "max(0.5rem, env(safe-area-inset-left))",
              paddingRight: "max(0.5rem, env(safe-area-inset-right))",
            }}
            onPointerEnter={() => showFullscreenChromeTemporarily(false)}
            onPointerLeave={() => {
              if (!scrubbingRef.current) showFullscreenChromeTemporarily();
            }}
            onFocusCapture={() => showFullscreenChromeTemporarily(false)}
            onBlurCapture={() => showFullscreenChromeTemporarily()}
          >
            <div className="flex items-center gap-2 px-2 pr-10 sm:gap-3">
              <button
                type="button"
                onClick={togglePlay}
                aria-label={isPlaying ? "Pause replay" : "Play replay"}
                title={pendingPlay ? "Waiting for audio to load..." : isPlaying && buffering ? "Buffering..." : isPlaying ? "Pause" : "Play"}
                className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-osu-pink text-white shadow-lg shadow-black/30 transition hover:bg-osu-pink-light focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 active:scale-95"
              >
                {pendingPlay || (isPlaying && buffering) ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" strokeWidth={2.4} />
                ) : isPlaying ? (
                  <Pause className="h-4 w-4" fill="currentColor" strokeWidth={2.4} />
                ) : (
                  <Play className="ml-0.5 h-4 w-4" fill="currentColor" strokeWidth={2.4} />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <ReplayProgressBar
                  rendererRef={rendererRef}
                  heatmap={keypressHeatmap}
                  sliderClass="!h-1 !bg-white/30 [&::-webkit-slider-thumb]:!h-3 [&::-webkit-slider-thumb]:!w-3 [&::-webkit-slider-thumb]:!bg-white"
                  className="!px-0 !pb-0 !pt-0"
                  onPointerDown={handleProgressPointerDown}
                  onPointerUp={handleProgressPointerUp}
                  onSeek={handleProgressSeek}
                  onContextMenu={() => {}}
                />
              </div>
            </div>
          </div>
        )}
        {rendererError && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 px-6 text-center">
            <div className="max-w-md rounded-lg border border-red-400/30 bg-red-950/70 px-4 py-3 text-sm font-semibold text-red-100">
              {rendererError}
            </div>
          </div>
        )}
      </div>

      {/* Audio element (hidden) — streamed from /api/audio with Range requests so the browser only pulls what it plays */}
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          onError={handleAudioError}
        />
      )}

      <ReplayControls
        rendererRef={rendererRef}
        heatmap={keypressHeatmap}
        audioUrl={audioUrl}
        audioError={audioError}
        isPlaying={isPlaying}
        buffering={buffering}
        pendingPlay={pendingPlay}
        speed={speed}
        modRate={modRate}
        audioEnabled={audioEnabled}
        volume={volume}
        showInputOverlay={showInputOverlay}
        inputOverlayOnly={inputOverlayOnly}
        inputOverlayKeyHistory={inputOverlayKeyHistory}
        inputOverlayColor={inputOverlayColor}
        keypressOverlayEnabled={overlaySettings.keypresses.enabled}
        skinSettingsOpen={skinSettingsOpen}
        scrollSpeed={scrollSpeed}
        bgDim={bgDim}
        videoExporting={videoExport.exporting}
        videoExportProgress={videoExport.progress}
        videoExportError={videoExport.error}
        videoExportUrl={videoExport.url}
        onTogglePlay={togglePlay}
        onExportVideo={replayVideoExportAvailable ? exportReplayVideo : undefined}
        onSetSpeed={(nextSpeed) => {
          setSpeed(nextSpeed);
          rendererRef.current?.setSpeed(nextSpeed);
          if (audioRef.current) {
            audioRef.current.playbackRate = nextSpeed * modRate;
            setAudioPreservesPitch(audioRef.current, audioPreservesPitch);
          }
        }}
        onToggleAudio={toggleAudio}
        onSetVolume={(nextVolume) => {
          const normalized = normalizeReplayVolume(nextVolume);
          volumeRef.current = normalized;
          setVolume(normalized);
          if (!audioEnabled && normalized > 0) setAudioEnabled(true);
          if (audioRef.current && !replayEndAudioFadeActiveRef.current) audioRef.current.volume = normalized;
        }}
        onToggleInputOverlay={() => setShowInputOverlay((value) => !value)}
        onToggleInputOverlayOnly={() => setInputOverlayOnly((value) => !value)}
        onToggleInputOverlayKeyHistory={() => setInputOverlayKeyHistory((value) => !value)}
        onSetInputOverlayColor={(color) => setInputOverlayColor(normalizeReplayInputColor(color))}
        onOpenSkinSettings={() => setSkinSettingsOpen(true)}
        onSetScrollSpeed={(nextSpeed) => {
          const normalized = normalizeReplayScrollSpeed(nextSpeed);
          scrollSpeedUserOverrideRef.current = true;
          applyScrollSpeed(normalized, true);
          rendererRef.current?.setScrollSpeed(normalized);
        }}
        onSetBgDim={(nextDim) => {
          const normalized = normalizeReplayBackgroundDim(nextDim);
          setBgDim(normalized);
          rendererRef.current?.setBackgroundDim(normalized);
        }}
        onPointerDown={handleProgressPointerDown}
        onPointerUp={handleProgressPointerUp}
        onSeek={handleProgressSeek}
        onContextMenu={() => {}}
      />

      <AnimatePresence>
        {skinSettingsOpen && (
          <ReplaySkinSettingsModal
            settings={skinSettings}
            overlaySettings={overlaySettings}
            keyCount={replay.keyCount}
            onSave={applySkinSettings}
            onSaveOverlays={applyOverlaySettings}
            onClose={() => setSkinSettingsOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
