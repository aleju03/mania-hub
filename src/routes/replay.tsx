import { createFileRoute, useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback, useMemo, type PointerEvent as ReactPointerEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Info, LoaderCircle, Maximize2, Minimize2, Pause, Play } from "lucide-react";
import { getReplayParsed, getBeatmapFile, getScore, getUserScoresBest, getUserScoresFirsts, getUserScoresPinned, getUserScoresRecent, searchUsers, searchBeatmaps, getBeatmapScores, getRankings, getBeatmapScoreLookupStatus, getPartialBeatmapScores } from "../lib/osu";
import { filterBeatmapSearchResults } from "../lib/beatmap-search";
import { getScoreDisplayValues, getScoreRate, modShiftsPitchWithRate, scoreHasReplay } from "../lib/score";
import { useAppStore, useSelectedCountry } from "../store";
import { PageHeader } from "../components/layout/PageHeader";
import { CLIENT_CACHE_TTL, isCacheStale } from "../lib/cache";
import { ReplayBrowseView } from "../components/replay/ReplayBrowseView";
import type { ReplayBrowseMode } from "../components/replay/ReplayBrowseView";
import { ReplayControls, ReplayProgressBar } from "../components/replay/ReplayControls";
import type { ReplayVideoExportOptions } from "../components/replay/ReplayControls";
import { ReplayInfo } from "../components/replay/ReplayInfo";
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
import { unpackReplayFrames } from "../lib/replay-frames";
import { buildKeypressHeatmap } from "../lib/replay-keypress-heatmap";
import { parseReplayScoreInput } from "../lib/replay-score-input";
import { getReplayScoreAvailability } from "../lib/replay-score-availability";
import { buildReplaySeoTitle, type ReplaySeoScore } from "../lib/replay-seo";
import { DEFAULT_REPLAY_SCROLL_SPEED, REPLAY_SCROLL_SPEED_CHANGE_EVENT, normalizeReplayScrollSpeed, readReplayScrollSpeed, writeReplayScrollSpeed } from "../lib/replay-scroll-speed";
import {
  REPLAY_OVERLAY_SETTINGS_CHANGE_EVENT,
  normalizeReplayOverlaySettings,
  readReplayOverlaySettings,
  writeReplayOverlaySettings,
} from "../lib/replay-overlays";
import { parseCachedManiaBeatmap } from "../lib/parsed-beatmap-cache";
import { startProgressPoll } from "../lib/progress-poll";
import { getLiveBackendUrl } from "../lib/live-backend";
import { useAuth } from "../lib/auth-context";
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
import type { BeatmapScoreLookupStatus, OsuScore, OsuBeatmapset, OsuBeatmap } from "../lib/types";
import type { ReplayRendererLike, ServerReplay } from "../lib/replay-types";
import { getScoreExpectedCounts } from "../lib/replay-types";
import { pageSeo, replayOgImagePath } from "../lib/seo";
import { withSearchParams } from "../lib/country-search";

interface ReplaySearch {
  scoreId?: number;
  beatmapsetId?: number;
  t?: number; // timestamp in seconds to seek to on load
  tab?: "player" | "beatmap";
  player?: string; // selected player username (for URL state)
}

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
const REPLAY_VIDEO_EXPORT_RESOLUTIONS: Record<ReplayVideoExportOptions["resolution"], { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};
const REPLAY_END_AUDIO_FADE_MS = 1500;

type ReplayVideoExportState = {
  exporting: boolean;
  progress: number;
  error: string | null;
  url: string | null;
  signed: boolean;
};

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
    headers: { "Content-Type": "video/mp4" },
    body: blob,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || "Replay video upload failed.");
  }
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

async function waitForReplayVideoJob(jobId: string, onProgress: (progress: number) => void): Promise<{ url: string; signed: boolean }> {
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    const job = await postReplayVideoJson<ReplayVideoJobPayload>("status", {}, jobId);
    if (job.status === "done" && job.url) return { url: job.url, signed: Boolean(job.signed) };
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(job.error || `Replay video job ${job.status}.`);
    }
    onProgress(Math.min(0.99, 0.94 + attempt * 0.0005));
  }
  throw new Error("Replay video export is still queued. Try again in a moment.");
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
  loader: async ({ deps }): Promise<{ seoScore: ReplaySeoScore | null }> => {
    if (typeof deps.scoreId !== "number") return { seoScore: null };

    try {
      const score = await getScore({ data: { scoreId: deps.scoreId } });
      return {
        seoScore: {
          username: score.user?.username ?? "",
          title: score.beatmapset?.title ?? "",
          version: score.beatmap?.version ?? "",
        },
      };
    } catch {
      return { seoScore: null };
    }
  },
  head: ({ match, loaderData }) => {
    const { scoreId, beatmapsetId, player } = match.search;
    const hasSharedScore = typeof scoreId === "number";
    const playerName = typeof player === "string" ? player.trim() : "";
    const title = hasSharedScore ? buildReplaySeoTitle(scoreId, loaderData?.seoScore, playerName) : "Replay viewer";

    return pageSeo({
      title,
      description: hasSharedScore
        ? ""
        : "Watch osu!mania .osr replays in your browser.",
      path: withSearchParams("/replay", {
        scoreId,
        beatmapsetId,
        player: playerName || undefined,
      }),
      origin: match.context.origin,
      image: hasSharedScore ? replayOgImagePath(scoreId) : undefined,
      social: hasSharedScore,
      noindex: true,
      appendSiteName: !hasSharedScore,
    });
  },
  component: ReplayPage,
  validateSearch: (s: Record<string, unknown>): ReplaySearch => ({
    scoreId: Number(s.scoreId) || undefined,
    beatmapsetId: Number(s.beatmapsetId) || undefined,
    t: Number(s.t) || undefined,
    tab: s.tab === "beatmap" ? "beatmap" : undefined,
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

function ReplayPage() {
  const { scoreId, beatmapsetId, t: initialTime, tab, player: playerParam } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const selectedCountry = useSelectedCountry();
  const cachedRankings = useAppStore((s) => s.rankingsByCountry[selectedCountry] ?? null);
  const rankingsFetchedAt = useAppStore((s) => s.rankingsFetchedAtByCountry[selectedCountry] ?? null);
  const setRankings = useAppStore((s) => s.setRankings);
  const [replay, setReplay] = useState<ServerReplay | null>(null);
  const [beatmap, setBeatmap] = useState<ManiaBeatmap | null>(null);
  const [scoreInfo, setScoreInfo] = useState<OsuScore | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playerSearchQuery, setPlayerSearchQuery] = useState("");
  const [scorePreview, setScorePreview] = useState<OsuScore | null>(null);
  const [scorePreviewLoading, setScorePreviewLoading] = useState(false);
  const [scorePreviewError, setScorePreviewError] = useState<string | null>(null);

  // Player browse state
  const [playerScoreGroups, setPlayerScoreGroups] = useState<{ best: OsuScore[]; firsts: OsuScore[]; pinned: OsuScore[]; recent: OsuScore[] } | null>(null);
  const [loadingScores, setLoadingScores] = useState(false);
  const [playerLookupUserId, setPlayerLookupUserId] = useState<number | null>(null);
  const [loadedPlayerParam, setLoadedPlayerParam] = useState<string | null>(null);
  const loadingPlayerParamRef = useRef<string | null>(null);

  // Browse mode
  const [browseMode, setBrowseMode] = useState<ReplayBrowseMode>(tab === "beatmap" ? "beatmap" : "player");

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
  const beatmapScoreRequestRef = useRef(0);
  const scorePreviewTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const visibleRawBeatmapScores = loadingBeatmapScores && partialBeatmapScores.length > 0
    ? mergeScoresById(beatmapScorePage > 1 ? rawBeatmapScores : [], partialBeatmapScores)
    : rawBeatmapScores;

  const beatmapScores = useMemo(
    () => visibleRawBeatmapScores.filter((s) => scoreHasReplay(s)),
    [visibleRawBeatmapScores],
  );
  const normalizedPlayerParam = normalizeReplayPlayerParam(playerParam);
  const playerSearchScoreId = parseReplayScoreInput(playerSearchQuery);

  const loadReplay = useCallback(async (sid: number) => {
    setError(null);
    setLoading(true);
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);

    try {
      // Fetch score first to get key count (beatmap.cs) for correct replay parsing
      const score = await getScore({ data: { scoreId: sid, mode: "mania" } }).catch(() => null);
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

      // Fetch replay with key count from score API, and beatmap file in parallel
      const keyCount = score?.beatmap?.cs ? Math.round(score.beatmap.cs) : undefined;
      const [parsed, bmResult] = await Promise.all([
        getReplayParsed({ data: { scoreId: sid, mode: "mania", keyCount } }),
        score?.beatmap?.id
          ? getBeatmapFile({ data: { beatmapId: score.beatmap.id } }).catch(() => null)
          : Promise.resolve(null),
      ]);

      setReplay({
        header: parsed.header,
        frames: unpackReplayFrames(parsed.framesPacked),
        lifeBarFrames: parsed.lifeBarFrames ?? [],
        keyCount: parsed.keyCount,
      });
      if (bmResult) {
        setBeatmap(parseCachedManiaBeatmap(score?.beatmap?.id ?? 0, bmResult.content));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load replay");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (scoreId) {
      loadReplay(scoreId);
      return;
    }

    setLoading(false);
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);
    setError(null);
    setPlayerSearchQuery("");
    setScorePreview(null);
    setScorePreviewLoading(false);
    setScorePreviewError(null);
  }, [scoreId, loadReplay]);

  useEffect(() => {
    if (scoreId) return;
    setBrowseMode(tab === "beatmap" ? "beatmap" : "player");
  }, [scoreId, tab]);

  // Debounced beatmap search
  useEffect(() => {
    if (browseMode !== "beatmap") return;
    if (beatmapQuery.length < 2) {
      setBeatmapResults([]);
      return;
    }
    setBeatmapSearchLoading(true);
    clearTimeout(beatmapTimerRef.current);
    beatmapTimerRef.current = setTimeout(async () => {
      try {
        const res = await searchBeatmaps({ data: { query: beatmapQuery, sort: "relevance_desc" } });
        setBeatmapResults(filterBeatmapSearchResults(res.beatmapsets, beatmapQuery).slice(0, 12));
      } catch {
        setBeatmapResults([]);
      } finally {
        setBeatmapSearchLoading(false);
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

  const loadPlayerScores = useCallback(async (userId: number) => {
    setLoadingScores(true);
    try {
      const [best, firsts, pinned, recent] = await Promise.all([
        getUserScoresBest({ data: { userId, limit: 100 } }).catch(() => [] as OsuScore[]),
        getUserScoresFirsts({ data: { userId, limit: 100 } }).catch(() => [] as OsuScore[]),
        getUserScoresPinned({ data: { userId, limit: 50 } }).catch(() => [] as OsuScore[]),
        getUserScoresRecent({ data: { userId, limit: 50, include_fails: true } }).catch(() => [] as OsuScore[]),
      ]);
      const filterReplayable = (scores: OsuScore[]) => scores.filter((s) => scoreHasReplay(s));
      const pinnedFiltered = filterReplayable(pinned);
      const pinnedIds = new Set(pinnedFiltered.map((s) => s.id));
      const bestFiltered = filterReplayable(best).filter((s) => !pinnedIds.has(s.id));
      const bestIds = new Set(bestFiltered.map((s) => s.id));
      const firstsFiltered = filterReplayable(firsts).filter((s) => !pinnedIds.has(s.id) && !bestIds.has(s.id));
      // Recent is intentionally NOT deduped against the others — a recent play
      // that is also a best score is exactly what you want to see as "new".
      const recentFiltered = filterReplayable(recent);
      const nextGroups = { best: bestFiltered, firsts: firstsFiltered, pinned: pinnedFiltered, recent: recentFiltered };
      setPlayerScoreGroups(nextGroups);
    } catch { setPlayerScoreGroups({ best: [], firsts: [], pinned: [], recent: [] }); }
    finally { setLoadingScores(false); }
  }, []);

  const handleSelectPlayer = async (user: { id: number; username: string }) => {
    navigate({ to: "/replay", search: { player: user.username } });
    setPlayerScoreGroups(null);
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
    if (browseMode !== "player") return;
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
  }, [browseMode, cachedRankings, rankingsFetchedAt, selectedCountry, setRankings]);

  const suggestionPlayers = useMemo(
    () => (cachedRankings?.ranking ?? [])
      .filter((entry) => entry.user.is_active !== false)
      .slice(0, 12)
      .map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
        avatar_url: entry.user.avatar_url,
        cover_url: entry.user.cover_url,
        global_rank: entry.global_rank,
      })),
    [cachedRankings],
  );

  // Auto-load player scores when arriving via URL with ?player=
  useEffect(() => {
    if (scoreId) return;
    if (!normalizedPlayerParam) {
      setPlayerScoreGroups(null);
      setPlayerLookupUserId(null);
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

    setPlayerScoreGroups(null);
    setLoadedPlayerParam(null);
    loadingPlayerParamRef.current = normalizedPlayerParam;
    let cancelled = false;
    (async () => {
      try {
        const res = await searchUsers({ data: { query: playerParam! } });
        const match = (res.user?.data ?? []).find(
          (u: { username: string }) => u.username.toLowerCase() === normalizedPlayerParam,
        );
        if (cancelled) return;

        if (match) {
          setPlayerLookupUserId(match.id);
          await loadPlayerScores(match.id);
          if (!cancelled) setLoadedPlayerParam(normalizedPlayerParam);
          return;
        }

        setPlayerLookupUserId(null);
        setPlayerScoreGroups({ best: [], firsts: [], pinned: [], recent: [] });
        setLoadedPlayerParam(normalizedPlayerParam);
      } catch { /* ignore */ }
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
    const requestId = beatmapScoreRequestRef.current + 1;
    beatmapScoreRequestRef.current = requestId;
    setSelectedDiffId(bm.id);
    setBeatmapScorePage(nextPage);
    setLoadingBeatmapScores(true);
    if (nextPage === 1) setRawBeatmapScores([]);
    setPartialBeatmapScores([]);
    setBeatmapScoreLookupStatus(null);
    try {
      const res = await getBeatmapScores({ data: { beatmapId: bm.id, country: selectedCountry, page: nextPage } });
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
      try {
        const [status, partial] = await Promise.all([
          getBeatmapScoreLookupStatus({ data: { beatmapId: selectedDiffId, country: selectedCountry, page: beatmapScorePage } }),
          getPartialBeatmapScores({ data: { beatmapId: selectedDiffId, country: selectedCountry, page: beatmapScorePage } }),
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
  }, [beatmapScorePage, loadingBeatmapScores, selectedDiffId, selectedCountry]);

  const handleClearReplay = () => {
    setReplay(null);
    setBeatmap(null);
    setScoreInfo(null);

    const backNavigation = getReplayBackNavigation({ canGoBack, playerParam, tab: tab === "beatmap" ? "beatmap" : undefined });
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
          title={
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="truncate">mania replay viewer</span>
              <button type="button" className="group relative inline-flex shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/70">
                <Info className="h-3.5 w-3.5 text-osu-f1/80 transition-colors group-hover:text-osu-pink-light" aria-hidden="true" />
                <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-64 -translate-x-1/2 rounded-md border border-osu-b3/70 bg-osu-d5 px-3 py-2 text-[11px] font-medium leading-snug text-osu-c1 opacity-0 shadow-xl shadow-black/30 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  Replay playback reconstructs old stable .osr input as closely as possible, but some stable scores can differ slightly from osu!'s original scoring.
                </span>
              </button>
            </span>
          }
        />
      </div>

      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="max-w-[1200px] mx-auto px-3 py-3 sm:px-5 sm:py-6">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-20">
                <div className="w-10 h-10 border-2 border-osu-pink/40 border-t-osu-pink rounded-full animate-spin mb-4" />
                <p className="text-sm text-osu-f1">Loading replay & beatmap...</p>
              </motion.div>
            ) : replay ? (
              <motion.div key="viewer" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                <ReplayInfo replay={replay} score={scoreInfo} beatmap={beatmap} onClear={handleClearReplay} />
                <ReplayViewer replay={replay} beatmap={beatmap} scoreInfo={scoreInfo} fallbackBeatmapsetId={beatmapsetId} initialTime={initialTime} />
              </motion.div>
            ) : (
              <ReplayBrowseView
                mode={browseMode}
                error={error}
                selectedCountry={selectedCountry}
                onModeChange={(mode) => {
                  setBrowseMode(mode);
                  setPlayerScoreGroups(null);
                  setBeatmapResults([]);
                  setRawBeatmapScores([]);
                  setPartialBeatmapScores([]);
                  setBeatmapScoreLookupStatus(null);
                  setBeatmapScorePage(1);
                  setSelectedBeatmapset(null);
                  setSelectedDiffId(null);
                  setBeatmapQuery("");
                  setError(null);
                  navigate({ to: "/replay", search: mode === "beatmap" ? { tab: "beatmap" } : {}, replace: true });
                }}
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
  fallbackBeatmapsetId,
  initialTime,
}: {
  replay: ServerReplay;
  beatmap: ManiaBeatmap | null;
  scoreInfo: OsuScore | null;
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
  const modAcronyms = useMemo(
    () => (scoreInfo?.mods ?? []).map((m: any) => (typeof m === "string" ? m : m.acronym ?? "").toUpperCase()),
    [scoreInfo?.mods],
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
  const modRate = getScoreRate(scoreInfo?.mods);
  const effectiveRate = speed * modRate;
  const audioPreservesPitch = !modShiftsPitchWithRate(scoreInfo?.mods);
  const [scrollSpeed, setScrollSpeed] = useState(readReplayScrollSpeed);
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
      applyScrollSpeed(readReplayScrollSpeed());
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
  }, [applyScrollSpeed]);

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

  // Build full audio URL from Sayobot CDN using beatmapset ID + audio filename from .osu
  const effectiveBeatmapsetId = scoreInfo?.beatmapset?.id ?? fallbackBeatmapsetId;
  const audioUrl = effectiveBeatmapsetId && beatmap?.audioFilename
    ? `/api/audio?beatmapsetId=${encodeURIComponent(String(effectiveBeatmapsetId))}&filename=${encodeURIComponent(beatmap.audioFilename)}`
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
            mods: modAcronyms,
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
  }, [replay, beatmap, initialTime, modRate, modAcronyms, replayUsesLazerScoring, scoreInfo?.beatmap?.convert, applyOverlaySettings]);

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

  const exportReplayVideo = useCallback(async (options: ReplayVideoExportOptions) => {
    const sourceCanvas = canvasRef.current;
    const sourceRenderer = rendererRef.current;
    if (!sourceRenderer || !sourceCanvas) return;

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
        return;
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
    let exportRenderer: ReplayRendererLike | null = null;
    let exportHost: HTMLDivElement | null = null;
    let jobId: string | null = null;

    setVideoExport({ exporting: true, progress: 0, error: null, url: null, signed: false });

    try {
      const resolution = REPLAY_VIDEO_EXPORT_RESOLUTIONS[options.resolution] ?? REPLAY_VIDEO_EXPORT_RESOLUTIONS["1080p"];
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
          showInputOverlay,
          mods: modAcronyms,
          speedMultiplier: modRate,
          transparentBackground: true,
          hidePerformanceStats: true,
          scrollVelocities: beatmap?.scrollVelocities,
          expectedCounts: getScoreExpectedCounts(scoreInfo, replay),
          lifeBarFrames: replay.lifeBarFrames,
          skinSettings,
          overlaySettings,
          inputOverlayOnly,
          inputOverlayColor,
          inputOverlayKeyHistory,
        },
      ) as ReplayRendererLike;

      await withTimeout(
        exportRenderer.ready(),
        8000,
        "Timed out starting the export renderer.",
      );
      exportRenderer.setScrollSpeed(scrollSpeed);
      exportRenderer.setSpeed(speed);

      const width = cssWidth;
      const height = cssHeight;
      const compositeCanvas = document.createElement("canvas");
      compositeCanvas.width = width;
      compositeCanvas.height = height;
      const ctx = compositeCanvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Couldn't create the video compositor.");

      let backgroundImage = bgDim >= 100
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

        ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0, Math.min(1, bgDim / 100))})`;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(exportCanvas, 0, 0, width, height);
      };

      const player = sanitizeReplayVideoFilename(replay.header.playerName || scoreInfo?.user?.username || "player");
      const title = sanitizeReplayVideoFilename(scoreInfo?.beatmapset?.title ?? "replay");
      const diff = sanitizeReplayVideoFilename(scoreInfo?.beatmap?.version ?? "mania");
      const scoreSuffix = scoreInfo?.id ? `-${scoreInfo.id}` : "";
      const job = await postReplayVideoJson<{ id: string }>("start", {
        scoreId: scoreInfo?.id ?? null,
        filename: `${player}-${title}-${diff}${scoreSuffix}.mp4`,
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
          });
      setVideoExport({
        exporting: false,
        progress: 1,
        error: null,
        url: uploaded.url,
        signed: uploaded.signed,
      });
    } catch (error) {
      if (jobId) {
        void postReplayVideoJson("cancel", {}, jobId).catch(() => {});
      }
      const message = error instanceof Error ? error.message : "Couldn't export the replay video.";
      setVideoExport({ exporting: false, progress: 0, error: message, url: null, signed: false });
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
    beatmap,
    beatmapBackgroundUrl,
    inputOverlayColor,
    inputOverlayKeyHistory,
    inputOverlayOnly,
    modAcronyms,
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
          applyScrollSpeed(nextSpeed, true);
          rendererRef.current?.setScrollSpeed(nextSpeed);
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
