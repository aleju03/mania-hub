import { createFileRoute, Link, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ExternalLink,
  Users,
  Target,
  TrendingUp,
  History,
  ArrowRight,
  ArrowUpRight,
  X,
  Search,
  Check,
  ChevronDown,
  Gauge,
} from "lucide-react";
import {
  isLiveBackendConfigured,
  type LiveFarmHelperKeyMode,
  type LiveFarmHelperRec,
  type LiveFarmHelperSnapshot,
  type LiveFarmHelperView,
} from "../lib/live-backend";
import {
  clearMyFarmHelperFeedback,
  getMyFarmHelperFeedback,
  setMyFarmHelperFeedback,
  type FarmHelperFeedbackFailReason,
  type FarmHelperFeedbackVerdict,
} from "../lib/farm-helper-feedback";
import {
  invalidateFarmHelperSubject,
  loadFarmHelperSnapshot,
  peekFarmHelperSnapshot,
  prefetchFarmHelperSnapshot,
} from "../lib/farm-helper-snapshot-cache";
import { searchUsers } from "../lib/osu";
import { PageHeader } from "../components/layout/PageHeader";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { FarmersList } from "../components/farm-helper/FarmersList";
import { NeighborhoodGraph } from "../components/farm-helper/NeighborhoodGraph";
import { SearchInput } from "../components/ui/SearchInput";
import { Avatar } from "../components/ui/Avatar";
import { CountryFlag } from "../components/ui/CountryFlag";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { Pagination } from "../components/ui/Pagination";
import { ModBadge } from "../components/ui/ModBadge";
import { UsernameText } from "../components/ui/UsernameText";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";

const PAGE_SIZE = 20;
// Ask for the server max so the reason filters ("missing", "old") see the full
// ranked list instead of whatever cracked the overall top of a shorter slice.
const SNAPSHOT_LIMIT = 200;
const FARM_HELPER_KEY_MODES = ["any", "4k", "7k"] as const;
const FARM_HELPER_VIEWS = ["gain", "popular"] as const;

type ReasonFilter = "all" | "missing" | "improve" | "stale" | "push";
type SortMode = "gain" | "popularity" | "players" | "difficulty" | "recent";
type SortDirection = "asc" | "desc";

interface FarmHelperSearch {
  user?: string;
  key?: LiveFarmHelperKeyMode;
  view?: LiveFarmHelperView;
  reason?: ReasonFilter;
  sort?: SortMode;
  dir?: SortDirection;
  page?: number;
}

function parseKeyMode(value: unknown): LiveFarmHelperKeyMode | undefined {
  return value === "4k" || value === "7k" || value === "any" ? value : undefined;
}

function parseView(value: unknown): LiveFarmHelperView | undefined {
  return value === "popular" ? "popular" : value === "gain" ? "gain" : undefined;
}

function defaultSortForView(view: LiveFarmHelperView): SortMode {
  return view === "popular" ? "popularity" : "gain";
}

function parseReasonFilter(value: unknown): ReasonFilter {
  return value === "missing" || value === "improve" || value === "stale" || value === "push" ? value : "all";
}

function parseSortMode(value: unknown): SortMode | undefined {
  return value === "gain" || value === "popularity" || value === "players" || value === "difficulty" || value === "recent"
    ? value
    : undefined;
}

function parseSortDirection(value: unknown): SortDirection {
  return value === "asc" ? "asc" : "desc";
}

// URL pages are 1-based ("?page=2" is the second page); internal state keeps
// the 0-based index. Legacy 0 or absent both parse as the first page.
function parsePage(value: unknown): number {
  const page = Math.floor(Number(value));
  return Number.isFinite(page) && page > 1 ? page - 1 : 0;
}

function buildFarmHelperSearch({
  user,
  key,
  view,
  reason,
  sort,
  dir,
  page,
}: {
  user?: string | null;
  key?: LiveFarmHelperKeyMode;
  view?: LiveFarmHelperView;
  reason?: ReasonFilter;
  sort?: SortMode;
  dir?: SortDirection;
  page?: number;
}): FarmHelperSearch {
  const effectiveView = view ?? "gain";
  const defaultSort = defaultSortForView(effectiveView);
  return {
    user: user ?? undefined,
    key: key && key !== "any" ? key : undefined,
    view: effectiveView !== "gain" ? effectiveView : undefined,
    reason: reason && reason !== "all" ? reason : undefined,
    sort: sort && sort !== defaultSort ? sort : undefined,
    dir: dir && dir !== "desc" ? dir : undefined,
    // Serialized 1-based: internal index 1 writes ?page=2.
    page: page && page > 0 ? Math.floor(page) + 1 : undefined,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function farmHelperRequestKey(subjectKey: string | null, keyMode: LiveFarmHelperKeyMode, view: LiveFarmHelperView): string {
  return `${subjectKey?.trim().toLowerCase() ?? ""}\u0000${keyMode}\u0000${view}`;
}

function orderedUnique<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function getFarmHelperShellSnapshot(
  snapshots: Map<string, LiveFarmHelperSnapshot>,
  subjectKey: string | null,
  keyMode: LiveFarmHelperKeyMode,
  view: LiveFarmHelperView,
): LiveFarmHelperSnapshot | null {
  const keyModes = orderedUnique([keyMode, ...FARM_HELPER_KEY_MODES]);
  const views = orderedUnique([view, ...FARM_HELPER_VIEWS]);
  for (const candidateKeyMode of keyModes) {
    for (const candidateView of views) {
      const snapshot = snapshots.get(farmHelperRequestKey(subjectKey, candidateKeyMode, candidateView));
      if (snapshot) return snapshot;
    }
  }
  return null;
}

const searchPlayers = async (q: string) => {
  const res = await searchUsers({ data: { query: q } });
  return (res.user?.data ?? [])
    .slice(0, 6)
    .map((u: { id: number; username: string; avatar_url: string; country_code: string }) => ({
      id: u.id,
      username: u.username,
      avatar_url: u.avatar_url,
      country_code: u.country_code,
    }));
};

export const Route = createFileRoute("/farm-helper")({
  validateSearch: (search: Record<string, unknown>): FarmHelperSearch => buildFarmHelperSearch({
    user: typeof search.user === "string" && search.user.trim() ? search.user.trim().slice(0, 60) : undefined,
    key: parseKeyMode(search.key),
    view: parseView(search.view),
    reason: parseReasonFilter(search.reason),
    sort: parseSortMode(search.sort),
    dir: parseSortDirection(search.dir),
    page: parsePage(search.page),
  }),
  head: ({ match }) => pageSeo({
    title: "Farm Helper",
    description: "Find osu!mania farm maps worth playing, based on nearby players, missing clears, improvable scores, and old PBs.",
    path: "/farm-helper",
    origin: match.context.origin,
    imageKind: "farm-helper",
  }),
  component: FarmHelperLayout,
});

const REASON_META: Record<
  LiveFarmHelperRec["reason"],
  { label: string; accent: string; text: string; soft: string; wash: string; Icon: typeof Target }
> = {
  missing: {
    label: "missing",
    accent: "bg-osu-blue",
    text: "text-osu-blue",
    soft: "bg-osu-blue/15",
    wash: "bg-gradient-to-l from-osu-blue/20 to-transparent",
    Icon: Target,
  },
  improve: {
    label: "improve",
    accent: "bg-osu-green-light",
    text: "text-osu-green-light",
    soft: "bg-osu-green-light/15",
    wash: "bg-gradient-to-l from-osu-green-light/20 to-transparent",
    Icon: TrendingUp,
  },
  stale: {
    label: "old pb",
    accent: "bg-osu-yellow",
    text: "text-osu-yellow",
    soft: "bg-osu-yellow/15",
    wash: "bg-gradient-to-l from-osu-yellow/20 to-transparent",
    Icon: History,
  },
  owned: {
    label: "cleared",
    accent: "bg-osu-pink",
    text: "text-osu-pink",
    soft: "bg-osu-pink/15",
    wash: "bg-gradient-to-l from-osu-pink/20 to-transparent",
    Icon: Check,
  },
  push: {
    label: "push acc",
    accent: "bg-osu-purple",
    text: "text-osu-purple",
    soft: "bg-osu-purple/15",
    wash: "bg-gradient-to-l from-osu-purple/20 to-transparent",
    Icon: Gauge,
  },
};

const SORT_OPTIONS: Array<{ value: SortMode; label: string; hint: string }> = [
  { value: "gain", label: "pp gain", hint: "biggest jump first" },
  { value: "popularity", label: "popularity", hint: "how many players near you farm it" },
  { value: "recent", label: "recent", hint: "what players near you played last" },
  { value: "players", label: "players", hint: "how many players near you have it" },
  { value: "difficulty", label: "stars", hint: "raw difficulty" },
];

// The detail page rebuilds this exact key from its URL search params
// (beatmapId path param + speed + user), so the key components must match what
// useOpenFarmMapDetail puts in the URL.
const FARM_MAP_CONTEXT_KEY_PREFIX = "mania-hub-farm-helper-map-context-v2:";

// SSR renders without a window, where useLayoutEffect warns; fall back to
// useEffect there (same timing once hydrated on the client).
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Live media-query state with a change listener, so crossing a breakpoint
// while mounted updates the tree (SSR-safe: false until a window exists).
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function FarmHelperLayout() {
  const matches = useMatches();
  const hasChildRoute = matches.some((match) => match.routeId === "/farm-helper/map/$beatmapId");
  if (hasChildRoute) return <Outlet />;
  return <FarmHelperPage />;
}

function recKey(rec: LiveFarmHelperRec): string {
  return `${rec.beatmapId}:${rec.speedBucket}`;
}

// What we already know about a subject before their snapshot arrives, from the
// signed-in viewer or the recent-players list. Enough for the header; never a
// substitute for the snapshot's own numbers.
type KnownSubject = RecentPlayer;

function findKnownSubject(subjectKey: string | null, viewer: ReturnType<typeof useAuth>["viewer"]): KnownSubject | null {
  if (!subjectKey) return null;
  const normalized = subjectKey.trim().toLowerCase();
  if (viewer && (String(viewer.id) === normalized || viewer.username.trim().toLowerCase() === normalized)) {
    return { userId: viewer.id, username: viewer.username, avatarUrl: viewer.avatarUrl };
  }
  return readRecentPlayers().find(
    (player) => String(player.userId) === normalized || player.username.trim().toLowerCase() === normalized,
  ) ?? null;
}

// Every still-fresh view of this subject the module cache already holds. Runs
// once at mount, which is what makes back-navigation from a map detail paint
// the board immediately (the cache is a no-op during SSR).
function seedSnapshotsFromCache(subjectKey: string | null): Map<string, LiveFarmHelperSnapshot> {
  const seeded = new Map<string, LiveFarmHelperSnapshot>();
  if (!subjectKey) return seeded;
  for (const keyMode of FARM_HELPER_KEY_MODES) {
    for (const view of FARM_HELPER_VIEWS) {
      const cached = peekFarmHelperSnapshot({ subjectKey, keyMode, view, limit: SNAPSHOT_LIMIT });
      if (cached) seeded.set(farmHelperRequestKey(subjectKey, keyMode, view), cached);
    }
  }
  return seeded;
}

function FarmHelperPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const auth = useAuth();
  const liveEnabled = isLiveBackendConfigured();

  // Seeded from the module cache so returning from a map detail (which unmounts
  // this component) repaints the board it was already showing instead of the
  // initial skeleton.
  const [snapshotsByRequestKey, setSnapshotsByRequestKey] = useState<Map<string, LiveFarmHelperSnapshot>>(
    () => seedSnapshotsFromCache(search.user ?? null),
  );
  const [error, setError] = useState<string | null>(null);

  const subjectKey = search.user ?? null;
  const keyMode: LiveFarmHelperKeyMode = search.key ?? "any";
  const view: LiveFarmHelperView = search.view ?? "gain";
  const reasonFilter: ReasonFilter = view === "gain" ? (search.reason ?? "all") : "all";
  const sortMode: SortMode = search.sort ?? defaultSortForView(view);
  const sortDir: SortDirection = search.dir ?? "desc";
  // search.page is the serialized 1-based value; work with the 0-based index.
  const page = search.page && search.page > 0 ? search.page - 1 : 0;
  const [query, setQuery] = useState("");
  const isXl = useMediaQuery("(min-width: 1280px)");
  const requestKey = farmHelperRequestKey(subjectKey, keyMode, view);
  const subjectNorm = subjectKey?.trim().toLowerCase() ?? "";
  const subjectPrefix = `${subjectNorm}\u0000`;
  // Per-subject freshness epochs: once the owner mutates a mark, every cached
  // HTTP body for that subject may be pre-mark (the endpoint serves
  // max-age=60), so all further fetches carry the epoch as a stable
  // cache-buster until the page is reloaded.
  const [freshEpochs, setFreshEpochs] = useState<Map<string, number>>(() => new Map());
  const visibleSnapshot = snapshotsByRequestKey.get(requestKey) ?? null;
  const shellSnapshot = visibleSnapshot ?? getFarmHelperShellSnapshot(snapshotsByRequestKey, subjectKey, keyMode, view);
  // Resolved in a layout effect rather than during render: it reads
  // localStorage, which does not exist during SSR and would otherwise make the
  // first client render disagree with the server's.
  const [knownSubject, setKnownSubject] = useState<KnownSubject | null>(null);
  useIsoLayoutEffect(() => {
    setKnownSubject(findKnownSubject(subjectKey, auth.viewer));
  }, [subjectKey, auth.viewer]);
  const waitingForCurrentSnapshot = liveEnabled && !!subjectKey && !visibleSnapshot && !error;
  const waitingForInitialSnapshot = waitingForCurrentSnapshot && !shellSnapshot;

  const navigateFarmHelper = (
    patch: {
      user?: string | null;
      key?: LiveFarmHelperKeyMode;
      view?: LiveFarmHelperView;
      reason?: ReasonFilter;
      sort?: SortMode;
      dir?: SortDirection;
      page?: number;
      replace?: boolean;
    } = {},
  ) => {
    const { replace = true, ...changes } = patch;
    // Spread merges onto the raw search params, so an explicit `undefined`
    // (e.g. sort) clears that param rather than falling back to its current value.
    const next = {
      user: subjectKey,
      key: keyMode,
      view: search.view,
      reason: reasonFilter,
      sort: search.sort,
      dir: sortDir,
      page,
      ...changes,
    };
    navigate({
      to: "/farm-helper",
      search: buildFarmHelperSearch(next),
      replace,
      resetScroll: false,
    });
  };

  const setSubject = (key: string | null) => {
    navigateFarmHelper({ user: key, page: 0, replace: false });
  };

  const setKeyMode = (next: LiveFarmHelperKeyMode) => {
    // Drop the open preview: keeping it across the switch would pop it back
    // open with the new snapshot's different numbers.
    setSelectedKey(null);
    navigateFarmHelper({ key: next, page: 0 });
  };

  const setView = (next: LiveFarmHelperView) => {
    setSelectedKey(null);
    // Reset the sort so each mode lands on its natural default ordering.
    navigateFarmHelper({ view: next, reason: undefined, sort: undefined, page: 0 });
  };

  useEffect(() => {
    if (!liveEnabled || !subjectKey) {
      setSnapshotsByRequestKey(new Map());
      return;
    }
    let cancelled = false;
    setError(null);
    // Through the module cache: it dedupes an in-flight request (so React's
    // Strict Mode double-mount still issues one), and it survives this
    // component's unmount when the map-detail child route takes over. The
    // `cancelled` flag below is what keeps a late response for a subject the
    // user has already left from ever being rendered as current.
    loadFarmHelperSnapshot({
      subjectKey,
      keyMode,
      view,
      limit: SNAPSHOT_LIMIT,
      // Post-mark epoch (undefined until the owner mutates a mark): bypasses
      // the browser HTTP cache without busting it on every call. Not an
      // effect dep on purpose; the mutation flow does its own fresh refetch.
      fresh: freshEpochs.get(subjectNorm),
    })
      .then((data) => {
        if (cancelled) return;
        setSnapshotsByRequestKey((current) => {
          const next = new Map(current);
          next.set(requestKey, data);
          return next;
        });
        recordRecentPlayer({ userId: data.userId, username: data.username, avatarUrl: data.avatarUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message.includes("404") ? "not-found" : "failed");
      })
    return () => {
      cancelled = true;
    };
  }, [liveEnabled, subjectKey, keyMode, view, requestKey]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [retainedSelection, setRetainedSelection] = useState<{ requestKey: string; rec: LiveFarmHelperRec } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Per-player feedback: only the logged-in player looking at their own board
  // can mark lanes, and everything below stays invisible to anyone else.
  const isOwner = auth.viewer != null && visibleSnapshot != null && auth.viewer.id === visibleSnapshot.userId;
  const [feedbackMarks, setFeedbackMarks] = useState<Map<string, FarmHelperFeedbackVerdict>>(() => new Map());
  // True once a marks load actually succeeded; a failed load keeps this false
  // so the preview-open retry below can kick in.
  const feedbackLoadedRef = useRef(false);
  const [feedbackPendingKey, setFeedbackPendingKey] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<{ key: string; message: string } | null>(null);

  const loadOwnerMarks = () => {
    let cancelled = false;
    getMyFarmHelperFeedback()
      .then((result) => {
        if (cancelled || !result.ok) return;
        const next = new Map<string, FarmHelperFeedbackVerdict>();
        for (const mark of result.marks) {
          if (mark.resolvedAt == null) next.set(`${mark.beatmapId}:${mark.speedBucket}`, mark.verdict);
        }
        // Wholesale replace: the server list is the ground truth for active
        // marks, so entries it resolved (a new score landed) drop out here.
        setFeedbackMarks(next);
        feedbackLoadedRef.current = true;
      })
      .catch(() => {
        /* keep the previous map; the next snapshot arrival or preview open retries */
      });
    return () => {
      cancelled = true;
    };
  };

  // Marks staleness, part 1: every fresh snapshot arrival for the owner also
  // synchronously reconciles the local map against the authoritative per-rec
  // feedback tags, then reloads the owner's marks (cheap, owner-only).
  //
  // Reconciliation rules: prefer the local map, but on a rec visible in this
  // snapshot the tag is authoritative where its absence can only mean the mark
  // was resolved server-side:
  // - a present tag always wins over the local entry;
  // - too_easy: presence/absence is authoritative in both views, so a visible
  //   untagged rec drops a local too_easy entry;
  // - too_hard: the gain view hides genuinely marked lanes, so a visible
  //   untagged gain-view rec drops a local too_hard entry. In the popular view
  //   absence proves nothing for too_hard and the local entry stays.
  useEffect(() => {
    if (!isOwner || !visibleSnapshot) return;
    setFeedbackMarks((current) => {
      let changed = false;
      const next = new Map(current);
      for (const rec of visibleSnapshot.recs) {
        const key = recKey(rec);
        const local = next.get(key) ?? null;
        const server = rec.feedback ?? null;
        if (server != null) {
          if (local !== server) {
            next.set(key, server);
            changed = true;
          }
          continue;
        }
        if (local === "too_easy" || (local === "too_hard" && visibleSnapshot.view === "gain")) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    return loadOwnerMarks();
  }, [isOwner, visibleSnapshot]);

  // Marks staleness, part 2: if no load has succeeded yet, retry when the
  // owner opens a preview so the tune panel reflects real mark state.
  useEffect(() => {
    if (!isOwner || selectedKey == null || feedbackLoadedRef.current) return;
    return loadOwnerMarks();
  }, [isOwner, selectedKey]);

  // Optimistic mark toggle: clicking the active verdict clears the mark. On
  // success the whole subject goes into a fresh epoch (every cached view may
  // be pre-mark) and the current view is refetched so hidden lanes drop out
  // and adjusted targets appear; on failure the previous mark is restored.
  const handleFeedback = async (
    lane: { beatmapId: number; speedBucket: string },
    verdict: FarmHelperFeedbackVerdict,
    rec?: LiveFarmHelperRec,
  ) => {
    if (!subjectKey) return;
    const key = `${lane.beatmapId}:${lane.speedBucket}`;
    const previous = feedbackMarks.get(key) ?? null;
    const clearing = previous === verdict;
    setFeedbackError(null);
    setFeedbackPendingKey(key);
    setFeedbackMarks((current) => {
      const next = new Map(current);
      if (clearing) next.delete(key);
      else next.set(key, verdict);
      return next;
    });
    // A too_hard mark on the open preview is about to drop that rec from the
    // refetched snapshot; retain a copy so the panel stays up as an undo path.
    if (!clearing && verdict === "too_hard" && rec && selectedKey === key) {
      setRetainedSelection({ requestKey, rec });
    }
    const revertMark = () =>
      setFeedbackMarks((current) => {
        const next = new Map(current);
        if (previous) next.set(key, previous);
        else next.delete(key);
        return next;
      });
    try {
      const result = clearing
        ? await clearMyFarmHelperFeedback({ data: { beatmapId: lane.beatmapId, speedBucket: lane.speedBucket } })
        : await setMyFarmHelperFeedback({ data: { beatmapId: lane.beatmapId, speedBucket: lane.speedBucket, verdict } });
      if (!result.ok) {
        revertMark();
        setFeedbackError({ key, message: feedbackFailMessage(result.reason) });
        return;
      }
      const epoch = Date.now();
      setFreshEpochs((current) => new Map(current).set(subjectNorm, epoch));
      // The module cache holds pre-mark bodies for every view of this subject
      // and outlives this component, so it has to be dropped alongside the
      // component's own map below.
      invalidateFarmHelperSubject(subjectKey);
      try {
        const data = await loadFarmHelperSnapshot({ subjectKey, keyMode, view, limit: SNAPSHOT_LIMIT, fresh: epoch });
        setSnapshotsByRequestKey((current) => {
          const next = new Map<string, LiveFarmHelperSnapshot>();
          // Drop every other cached view of this subject: the browser may
          // still hold pre-mark bodies for them and they refetch on demand.
          for (const [cachedKey, snapshot] of current) {
            if (!cachedKey.startsWith(subjectPrefix)) next.set(cachedKey, snapshot);
          }
          next.set(requestKey, data);
          return next;
        });
      } catch {
        // The mark itself is saved: keep the current view's snapshot but drop
        // the subject's other cached views so a switch refetches them fresh.
        setSnapshotsByRequestKey((current) => {
          const next = new Map<string, LiveFarmHelperSnapshot>();
          for (const [cachedKey, snapshot] of current) {
            if (cachedKey === requestKey || !cachedKey.startsWith(subjectPrefix)) next.set(cachedKey, snapshot);
          }
          return next;
        });
      }
    } catch {
      revertMark();
      setFeedbackError({ key, message: feedbackFailMessage("failed") });
    } finally {
      setFeedbackPendingKey((current) => (current === key ? null : current));
    }
  };

  // Query-filtered but not reason-filtered: this is what the reason tabs count
  // against, so each tab's number matches what clicking it will show.
  const queryFilteredRecs = useMemo(() => {
    if (!visibleSnapshot) return [];
    const q = query.trim().toLowerCase();
    if (!q) return visibleSnapshot.recs;
    return visibleSnapshot.recs.filter(
      (rec) =>
        rec.title.toLowerCase().includes(q)
        || rec.artist.toLowerCase().includes(q)
        || rec.creator.toLowerCase().includes(q)
        || rec.version.toLowerCase().includes(q),
    );
  }, [visibleSnapshot, query]);

  const recs = useMemo(() => {
    const filtered =
      reasonFilter === "all" ? queryFilteredRecs : queryFilteredRecs.filter((rec) => rec.reason === reasonFilter);
    const sorted = [...filtered];
    const direction = sortDir === "desc" ? 1 : -1;
    sorted.sort((a, b) => {
      const aRecent = timestampMs(a.peerRecencyPlayedAt);
      const bRecent = timestampMs(b.peerRecencyPlayedAt);
      // Unknown recency always sorts last, in either direction.
      if (sortMode === "recent" && (aRecent > 0) !== (bRecent > 0)) return aRecent > 0 ? -1 : 1;
      const byGain = b.estimatedPpGain - a.estimatedPpGain;
      const byFit = b.peerFraction - a.peerFraction;
      const byPlayers = b.peerCount - a.peerCount;
      const byStars = b.stars - a.stars;
      const byRecent = bRecent - aRecent;
      const bySelected =
        sortMode === "gain" ? byGain
          : sortMode === "popularity" ? byFit
            : sortMode === "players" ? byPlayers
              : sortMode === "recent" ? byRecent
                : byStars;
      return (bySelected || byGain || byFit || byPlayers || byStars) * direction;
    });
    return sorted;
  }, [queryFilteredRecs, reasonFilter, sortMode, sortDir]);

  // Only meaningful when no client-side filter narrows the list; then recs is
  // exactly the server's (possibly truncated) slice and "X of Y" is honest.
  const isClientFiltered = reasonFilter !== "all" || query.trim().length > 0;
  const totalQualifying = visibleSnapshot?.totalQualifying ?? 0;
  const serverTruncated = !isClientFiltered && totalQualifying > (visibleSnapshot?.recs.length ?? 0);

  const pageCount = Math.ceil(recs.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const pageRecs = recs.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // Bars are scaled against the whole filtered set, so paging deeper visibly
  // shows the drop-off instead of re-normalising every page back to full width.
  const barBasis = useMemo(() => {
    if (recs.length === 0) return 1;
    return recs.reduce(
      (max, rec) => Math.max(max, view === "popular" ? rec.peerFraction : Math.max(0, rec.estimatedPpGain)),
      0,
    ) || 1;
  }, [recs, view]);

  const selectedFromList = selectedKey ? recs.find((rec) => recKey(rec) === selectedKey) ?? null : null;
  // Keep the previewed rec renderable when a too_hard mark drops it from the
  // refetched snapshot: the panel keeps showing the retained copy (with the
  // mark active as an undo path) until the user closes it. Only the feedback
  // mutation flow sets this, so a rec that merely falls out of the search
  // filter closes its preview naturally. The retained copy is scoped to the
  // request key so switching subject/keys/view never resurrects it.
  const selected =
    selectedFromList
    ?? (selectedKey != null
      && retainedSelection != null
      && retainedSelection.requestKey === requestKey
      && recKey(retainedSelection.rec) === selectedKey
      ? retainedSelection.rec
      : null);
  const gainUnit = gainUnitLabel(visibleSnapshot);

  const previewFeedback = (rec: LiveFarmHelperRec): RecFeedbackControls | null =>
    isOwner
      ? {
          activeVerdict: feedbackMarks.get(recKey(rec)) ?? null,
          pending: feedbackPendingKey === recKey(rec),
          error: feedbackError?.key === recKey(rec) ? feedbackError.message : null,
          onVerdict: (verdict) => {
            void handleFeedback(rec, verdict, rec);
          },
        }
      : null;
  const openDetail = useOpenFarmMapDetail();

  // Owner-only marks manager data: the local map already holds exactly the
  // active marks (key = beatmapId:speedBucket), so no extra fetch is needed.
  const activeMarks = useMemo<ActiveFeedbackMark[]>(() => {
    if (!isOwner) return [];
    return Array.from(feedbackMarks.entries()).map(([key, verdict]) => {
      const sep = key.indexOf(":");
      return { key, beatmapId: Number(key.slice(0, sep)), speedBucket: key.slice(sep + 1), verdict };
    });
  }, [isOwner, feedbackMarks]);

  const markTitles = useMemo(() => {
    const titles = new Map<number, string>();
    for (const rec of visibleSnapshot?.recs ?? []) {
      if (!titles.has(rec.beatmapId)) titles.set(rec.beatmapId, `${rec.title} [${rec.version}]`);
    }
    return titles;
  }, [visibleSnapshot]);

  const marksManager =
    isOwner && activeMarks.length > 0 ? (
      <MarksManager
        marks={activeMarks}
        titles={markTitles}
        pendingKey={feedbackPendingKey}
        error={feedbackError}
        onClear={(mark) => {
          void handleFeedback({ beatmapId: mark.beatmapId, speedBucket: mark.speedBucket }, mark.verdict);
        }}
      />
    ) : null;

  // Reason-tab counts follow the search box (fix: tabs must count what
  // clicking them will show); the rail guide describes the whole board.
  const tabCounts = countReasons(queryFilteredRecs);
  const boardCounts = visibleSnapshot ? countReasons(visibleSnapshot.recs) : null;
  // Whether the backend actually had a cohort to compare against: without one,
  // an empty board is missing data, not an achievement.
  const hasCohortData =
    visibleSnapshot != null
    && (visibleSnapshot.peerBand.count > 0
      || Object.values(visibleSnapshot.peerBands ?? {}).some((band) => band != null && band.count > 0));

  const goToPage = (next: number) => {
    navigateFarmHelper({ page: next });
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const renderRow = (rec: LiveFarmHelperRec, rank: number) => (
    <RecRow
      key={recKey(rec)}
      rec={rec}
      rank={rank}
      barPct={((view === "popular" ? rec.peerFraction : Math.max(0, rec.estimatedPpGain)) / barBasis) * 100}
      gainUnit={gainUnit}
      view={view}
      selected={selectedKey === recKey(rec)}
      onSelect={() => setSelectedKey(recKey(rec))}
      markedVerdict={isOwner ? feedbackMarks.get(recKey(rec)) ?? null : null}
    />
  );

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
        <PageHeader
          iconSrc="/images/icons/rankings.svg"
          title="Global mania farm helper"
        />

        <div className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-5 sm:px-5">
          {!liveEnabled ? (
            <EmptyNotice
              eyebrow="unavailable"
              title="Farm Helper needs the server"
              body="This tool reads cross-country farm data from the server, which isn't configured in this environment."
            />
          ) : !subjectKey ? (
            <PlayerPicker viewer={auth.viewer} onPick={setSubject} keyMode={keyMode} view={view} />
          ) : waitingForInitialSnapshot ? (
            <LoadingState subject={knownSubject} />
          ) : error === "not-found" && !shellSnapshot ? (
            <EmptyNotice
              eyebrow="not found"
              title={`Couldn't find "${subjectKey}"`}
              body="Check the spelling, or search for the player again."
              action={<ChangeSubjectButton onPick={setSubject} />}
            />
          ) : error && !shellSnapshot ? (
            <EmptyNotice
              eyebrow="error"
              title="Couldn't build recommendations"
              body="Something went wrong loading this player's farm data. Try again in a moment."
              action={<ChangeSubjectButton onPick={setSubject} />}
            />
          ) : shellSnapshot ? (
            <>
              <SubjectBar
                snapshot={shellSnapshot}
                visibleSnapshot={visibleSnapshot}
                refreshing={waitingForCurrentSnapshot}
                loadFailed={!!error && !visibleSnapshot}
                view={view}
                keyMode={keyMode}
                onView={setView}
                onKeyMode={setKeyMode}
                onChangePlayer={() => setSubject(null)}
              />

              <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_352px]">
                <div ref={listRef} className="min-w-0 scroll-mt-20">
                  <BoardToolbar
                    query={query}
                    onQuery={(next) => {
                      setQuery(next);
                      // Typing must not strand the user on a deep page of the
                      // narrowed list.
                      if (page !== 0) navigateFarmHelper({ page: 0 });
                    }}
                    showReason={view === "gain"}
                    reasonFilter={reasonFilter}
                    onReason={(next) => {
                      navigateFarmHelper({ reason: next, page: 0 });
                      setSelectedKey(null);
                    }}
                    counts={tabCounts}
                    sortMode={sortMode}
                    sortDir={sortDir}
                    onSort={(next) => {
                      navigateFarmHelper({
                        sort: next,
                        dir: sortMode === next ? (sortDir === "desc" ? "asc" : "desc") : "desc",
                        page: 0,
                      });
                    }}
                    countLabel={
                      !visibleSnapshot
                        ? null
                        : serverTruncated
                          ? `${formatPp(recs.length)} of ${formatPp(totalQualifying)}`
                          : `${formatPp(recs.length)} map${recs.length === 1 ? "" : "s"}`
                    }
                  />

                  {!visibleSnapshot ? (
                    error ? (
                      <EmptyNotice
                        eyebrow={error === "not-found" ? "not found" : "error"}
                        title={error === "not-found" ? "Couldn't load this view" : "Couldn't build recommendations"}
                        body={
                          error === "not-found"
                            ? "The player panel can stay here, but this view did not return fresh map data."
                            : "Something went wrong loading these maps. Try the toggle again in a moment."
                        }
                      />
                    ) : (
                      <BoardSkeleton />
                    )
                  ) : recs.length === 0 ? (
                    query.trim() ? (
                      <EmptyNotice
                        eyebrow="no matches"
                        title="No maps match your search"
                        body="Try a different title, artist, or difficulty name."
                      />
                    ) : reasonFilter !== "all" && queryFilteredRecs.length > 0 ? (
                      // The reason filter narrowed a non-empty board to zero:
                      // that is a filter result, not an achievement.
                      <EmptyNotice
                        eyebrow="filtered out"
                        title={`No ${REASON_META[reasonFilter].label} maps right now`}
                        body="Nothing qualifies under this filter at the moment, but other reasons still have maps."
                        action={
                          <button
                            type="button"
                            onClick={() => {
                              navigateFarmHelper({ reason: "all", page: 0 });
                              setSelectedKey(null);
                            }}
                            className="rounded-lg bg-osu-b3/60 px-3 py-2 text-xs font-medium text-osu-l2 transition-colors hover:bg-osu-b3"
                          >
                            show everything
                          </button>
                        }
                      />
                    ) : !hasCohortData ? (
                      // Empty because the cohort itself is empty: be honest
                      // instead of congratulating the player.
                      <EmptyNotice
                        eyebrow="no data"
                        title="Not enough data near your pp yet"
                        body="We don't have enough data on players near your pp to build recommendations. Try another key mode, or check back once more nearby players are tracked."
                      />
                    ) : view === "gain" && (visibleSnapshot.belowGainFloorCount ?? 0) > 0 ? (
                      // Peers have farm data, but every lane's estimated gain
                      // fell under the visibility floor: explain that instead
                      // of implying there is nothing to see.
                      <EmptyNotice
                        eyebrow="no gains here"
                        title="Nothing here would move your total"
                        body="Players near your pp are farming maps, but right now every one of them would add less than 1pp for you. The popular view still shows what they play."
                        action={
                          <button
                            type="button"
                            onClick={() => setView("popular")}
                            className="rounded-lg bg-osu-b3/60 px-3 py-2 text-xs font-medium text-osu-l2 transition-colors hover:bg-osu-b3"
                          >
                            show popular maps
                          </button>
                        }
                      />
                    ) : (
                      <EmptyNotice
                        eyebrow="all caught up"
                        title={view === "popular" ? "No popular maps at your level yet" : "Nothing left to farm at your level"}
                        body={
                          view === "popular"
                            ? "No nearby players have farm data here yet. Try a different key mode."
                            : "Try the popular view to browse every farm map around your level, or widen the key mode."
                        }
                      />
                    )
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4/60">
                      <div className="divide-y divide-osu-b3/15">
                        {pageRecs.map((rec, index) => renderRow(rec, safePage * PAGE_SIZE + index + 1))}
                      </div>
                    </div>
                  )}

                  {visibleSnapshot && pageCount > 1 ? (
                    <Pagination page={safePage} totalPages={pageCount} onPageChange={goToPage} />
                  ) : null}

                  {/* Below xl the rail is CSS-hidden, so the marks manager
                      lives under the list instead. */}
                  {marksManager ? <div className="mt-4 xl:hidden">{marksManager}</div> : null}
                </div>

                <aside className="hidden xl:block">
                  <div className="sticky top-[76px]">
                    {/* Only the active preview surface mounts (isXl gate):
                        otherwise each row click would mount two FarmersLists
                        and fire the farmers request twice. */}
                    {selected && visibleSnapshot && isXl ? (
                      <RecPreview
                        rec={selected}
                        snapshot={visibleSnapshot}
                        gainUnit={gainUnit}
                        feedback={previewFeedback(selected)}
                        onOpenDetail={() =>
                          openDetail(selected, visibleSnapshot, farmersKeyMode(visibleSnapshot, selected), gainUnit)
                        }
                        onClose={() => setSelectedKey(null)}
                        className="max-h-[calc(100dvh-104px)]"
                      />
                    ) : (
                      <>
                        <ReadingGuide
                          snapshot={shellSnapshot}
                          view={view}
                          refreshing={waitingForCurrentSnapshot}
                          counts={boardCounts}
                          hiddenByMarks={isOwner && view === "gain" ? visibleSnapshot?.feedbackHiddenCount ?? 0 : 0}
                        />
                        {marksManager ? <div className="mt-4">{marksManager}</div> : null}
                      </>
                    )}
                  </div>
                </aside>
              </div>
            </>
          ) : null}
        </div>
        </div>
      </div>

      {isXl ? null : (
        <PreviewSheet
          rec={selected}
          snapshot={visibleSnapshot}
          gainUnit={gainUnit}
          feedback={selected ? previewFeedback(selected) : null}
          onOpenDetail={
            selected && visibleSnapshot
              ? () => openDetail(selected, visibleSnapshot, farmersKeyMode(visibleSnapshot, selected), gainUnit)
              : undefined
          }
          onClose={() => setSelectedKey(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Command bar                                                         */
/* ------------------------------------------------------------------ */

function SubjectBar({
  snapshot,
  visibleSnapshot,
  refreshing,
  loadFailed = false,
  view,
  keyMode,
  onView,
  onKeyMode,
  onChangePlayer,
}: {
  snapshot: LiveFarmHelperSnapshot;
  visibleSnapshot: LiveFarmHelperSnapshot | null;
  refreshing: boolean;
  /** The current view's fetch failed and there is no fresh snapshot: the shell
      snapshot may belong to another keymode, so its cohort must not show. */
  loadFailed?: boolean;
  view: LiveFarmHelperView;
  keyMode: LiveFarmHelperKeyMode;
  onView: (next: LiveFarmHelperView) => void;
  onKeyMode: (next: LiveFarmHelperKeyMode) => void;
  onChangePlayer: () => void;
}) {
  const unit = gainUnitLabel(visibleSnapshot ?? snapshot);
  const mapCount = visibleSnapshot?.recs.length ?? 0;
  const biggest = visibleSnapshot ? maxGain(visibleSnapshot.recs) : 0;

  return (
    <div className="overflow-hidden rounded-2xl border border-osu-b3/25 bg-osu-b4">
      <div className="relative">
        {snapshot.coverUrl ? (
          <>
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: `url(${snapshot.coverUrl})` }}
              aria-hidden="true"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-osu-b4 via-osu-b4/92 to-osu-b4/70" aria-hidden="true" />
          </>
        ) : null}

        {/* Stacked on mobile: side by side, the gain block squeezes the name
            row until the username truncates away and "change" rams into the
            gain eyebrow. One block per row under sm. */}
        <div className="relative flex flex-col gap-4 px-4 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-3 sm:flex-1">
            <span className="inline-flex shrink-0 rounded-full ring-2 ring-white/10">
              <Avatar url={snapshot.avatarUrl} userId={snapshot.userId} size={48} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link
                  to="/player/$username"
                  params={{ username: snapshot.username }}
                  className="min-w-0 truncate text-[15px] font-bold text-osu-c1 hover:text-osu-pink"
                >
                  <UsernameText username={snapshot.username} avatarUrl={snapshot.avatarUrl} />
                </Link>
                <span className="shrink-0 text-[12px] font-semibold tabular-nums text-osu-l2">{formatPp(snapshot.pp)}pp</span>
                <button
                  type="button"
                  onClick={onChangePlayer}
                  className="shrink-0 rounded-full border border-osu-b3/40 px-2 py-[3px] text-[10px] font-semibold uppercase tracking-wide text-osu-f1 transition-colors hover:border-osu-pink/50 hover:text-osu-c1"
                >
                  change
                </button>
              </div>
              {refreshing ? (
                <Skeleton className="mt-1.5 h-2.5 w-48 max-w-full" />
              ) : loadFailed ? (
                <div className="mt-0.5 text-[11px] text-osu-red-light">couldn't load this view</div>
              ) : (
                <div className="mt-0.5 truncate text-[11px] text-osu-f1">{peerBandRangeLabel(snapshot)}</div>
              )}
            </div>
          </div>

          <div className="shrink-0 sm:border-l sm:border-osu-b3/25 sm:pl-5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">
              {view === "popular" ? "popular near you" : "you could gain"}
            </div>
            {loadFailed ? (
              <div className="mt-1 text-[13px] font-bold text-osu-f1">unavailable</div>
            ) : refreshing || !visibleSnapshot ? (
              <div className="mt-1.5 space-y-1.5">
                <Skeleton className="h-7 w-32" />
                <Skeleton className="h-2.5 w-40" />
              </div>
            ) : view === "popular" ? (
              <>
                <div className="text-2xl font-black leading-tight tabular-nums text-osu-c1">
                  {formatPp(visibleSnapshot.totalQualifying || mapCount)}
                  <span className="ml-1.5 text-sm font-bold text-osu-f1">maps</span>
                </div>
                <div className="text-[11px] text-osu-f1">what nearby players actually farm</div>
              </>
            ) : (
              <>
                <div className="text-2xl font-black leading-tight tabular-nums text-osu-pink">
                  +{formatPp(visibleSnapshot.totalPotentialPp)}
                  <span className="ml-1.5 text-sm font-bold text-osu-pink/70">{unit}</span>
                </div>
                <div className="text-[11px] text-osu-f1">
                  across {formatPp(mapCount)} map{mapCount === 1 ? "" : "s"}
                  {biggest > 0 ? ` · biggest ${formatGainWithUnit(biggest, unit)}` : ""}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-osu-b3/20 bg-osu-b5/40 px-3 py-2 sm:px-4">
        <div className="flex items-center gap-1" role="group" aria-label="View mode">
          {([["gain", "for you"], ["popular", "popular"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onView(value)}
              aria-pressed={view === value}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-bold transition-colors duration-[120ms] ${
                view === value
                  ? "bg-osu-pink/20 text-osu-pink-light"
                  : "text-osu-f1 hover:bg-osu-b3/60 hover:text-osu-l2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="hidden h-4 w-px bg-osu-b3/40 sm:block" />

        <div className="ml-auto flex items-center gap-2 sm:ml-0">
          <span className="text-[9px] font-bold uppercase tracking-wider text-osu-f1/70">keys</span>
          <div className="flex overflow-hidden rounded-lg border border-osu-b3/30" role="group" aria-label="Key mode">
            {(["any", "4k", "7k"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onKeyMode(mode)}
                aria-pressed={keyMode === mode}
                className={`px-2.5 py-1 text-[11px] font-semibold uppercase tabular-nums transition-colors duration-[120ms] ${
                  keyMode === mode ? "bg-osu-b3 text-osu-l2" : "bg-transparent text-osu-f1 hover:text-osu-l2"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

function BoardToolbar({
  query,
  onQuery,
  showReason,
  reasonFilter,
  onReason,
  counts,
  sortMode,
  sortDir,
  onSort,
  countLabel,
}: {
  query: string;
  onQuery: (next: string) => void;
  showReason: boolean;
  reasonFilter: ReasonFilter;
  onReason: (next: ReasonFilter) => void;
  counts: Record<ReasonFilter, number>;
  sortMode: SortMode;
  sortDir: SortDirection;
  onSort: (next: SortMode) => void;
  countLabel: string | null;
}) {
  const tabs: Array<{ value: ReasonFilter; label: string; dot: string }> = [
    { value: "all", label: "everything", dot: "bg-osu-f1" },
    { value: "missing", label: "missing", dot: REASON_META.missing.accent },
    { value: "improve", label: "improve", dot: REASON_META.improve.accent },
    { value: "stale", label: "old pb", dot: REASON_META.stale.accent },
    { value: "push", label: "push acc", dot: REASON_META.push.accent },
  ];

  return (
    <div className="sticky top-[60px] z-20 -mx-1 mb-3 rounded-xl border border-osu-b3/20 bg-osu-b5/85 px-1 backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2">
        {showReason ? (
          /* Phones give the tabs their own row: sharing one with the search and
             sort left them ~90px, so three of the five scrolled out of sight. */
          <div className="flex w-full min-w-0 items-center gap-0.5 overflow-x-auto sm:w-auto sm:flex-1">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => onReason(tab.value)}
                aria-pressed={reasonFilter === tab.value}
                className={`group flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors duration-[120ms] ${
                  reasonFilter === tab.value ? "bg-osu-b3/70 text-osu-c1" : "text-osu-f1 hover:bg-osu-b3/35 hover:text-osu-l2"
                }`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tab.dot}`} aria-hidden="true" />
                {tab.label}
                <span className="tabular-nums text-osu-f1/70">{formatPp(counts[tab.value])}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="w-full min-w-0 text-[12px] font-semibold text-osu-l2 sm:w-auto sm:flex-1">
            maps players near you farm
            {countLabel ? <span className="ml-1.5 font-normal text-osu-f1">{countLabel}</span> : null}
          </div>
        )}

        <div className="flex w-full items-center gap-2 sm:w-auto">
          {showReason && countLabel ? (
            <span className="hidden text-[11px] tabular-nums text-osu-f1 lg:inline">{countLabel}</span>
          ) : null}
          <ToolbarSearch value={query} onChange={onQuery} />
          <SortMenu sortMode={sortMode} sortDir={sortDir} onSort={onSort} />
        </div>
      </div>
    </div>
  );
}

function ToolbarSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="relative min-w-0 flex-1 sm:w-[200px] sm:flex-none">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="filter maps..."
        aria-label="Filter maps"
        className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4/70 py-1.5 pl-8 pr-7 text-[12px] text-osu-c1 placeholder:text-osu-f1 transition-colors focus:border-osu-h1/40 focus:outline-none"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-osu-f1 transition-colors hover:text-osu-l2"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function SortMenu({
  sortMode,
  sortDir,
  onSort,
}: {
  sortMode: SortMode;
  sortDir: SortDirection;
  onSort: (next: SortMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = SORT_OPTIONS.find((option) => option.value === sortMode) ?? SORT_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1.5 rounded-lg border border-osu-b3/30 bg-osu-b4/70 px-2.5 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors hover:border-osu-b3/60 hover:text-osu-c1"
      >
        <span className="text-osu-f1">sort</span>
        {active.label}
        <span aria-hidden className="text-osu-pink">{sortDir === "desc" ? "↓" : "↑"}</span>
        <ChevronDown className={`h-3 w-3 text-osu-f1 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-56 overflow-hidden rounded-xl border border-osu-b3/40 bg-osu-b5 py-1 shadow-2xl"
        >
          {SORT_OPTIONS.map((option) => {
            const isActive = option.value === sortMode;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                onClick={() => {
                  onSort(option.value);
                  if (!isActive) setOpen(false);
                }}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                  isActive ? "bg-osu-pink/10" : "hover:bg-osu-b3/50"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block text-[12px] font-semibold ${isActive ? "text-osu-pink-light" : "text-osu-c1"}`}>
                    {option.label}
                  </span>
                  <span className="block text-[10px] leading-tight text-osu-f1">{option.hint}</span>
                </span>
                {isActive ? (
                  <span aria-hidden className="shrink-0 text-[13px] leading-5 text-osu-pink">
                    {sortDir === "desc" ? "↓" : "↑"}
                  </span>
                ) : null}
              </button>
            );
          })}
          <div className="border-t border-osu-b3/30 px-3 py-1.5 text-[10px] text-osu-f1">
            pick the active one again to flip direction
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

function RecRow({
  rec,
  rank,
  barPct,
  gainUnit,
  view,
  selected,
  onSelect,
  markedVerdict = null,
}: {
  rec: LiveFarmHelperRec;
  rank: number;
  barPct: number;
  gainUnit: string;
  view: LiveFarmHelperView;
  selected: boolean;
  onSelect: () => void;
  /** Owner-only: the viewer's active feedback mark on this lane. */
  markedVerdict?: FarmHelperFeedbackVerdict | null;
}) {
  const meta = REASON_META[rec.reason];
  const cover = rec.listCover || rec.cover;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-label={`Preview ${rec.title} [${rec.version}]`}
      className={`group relative cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-osu-pink/60 ${
        selected ? "bg-osu-b3/50" : "hover:bg-osu-b3/25"
      }`}
    >
      {/* Value wash: anchored to the right edge under the +pp column and fading
          leftward, so its length visibly belongs to the value it encodes. */}
      <span
        className={`pointer-events-none absolute inset-y-0 right-0 ${meta.wash}`}
        style={{ width: `${clampPct(barPct)}%` }}
        aria-hidden="true"
      />
      <span
        className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] transition-opacity ${meta.accent} ${
          selected ? "opacity-100" : "opacity-45 group-hover:opacity-80"
        }`}
        aria-hidden="true"
      />

      <div className="relative flex items-center gap-3 py-2 pl-3 pr-3 sm:pl-4">
        <span className="w-6 shrink-0 text-right text-[11px] font-bold tabular-nums text-osu-f1/70">{rank}</span>

        <div className="h-9 w-14 shrink-0 overflow-hidden rounded bg-osu-b6 sm:h-10 sm:w-16">
          {cover ? <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[13.5px] font-bold text-osu-c1">
              {rec.title}
              <span className="font-medium text-osu-f1"> [{rec.version}]</span>
            </span>
            <ModList mods={rec.recommendedMods ?? []} size={0.58} className="max-w-[92px]" />
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-x-2 text-[11px] leading-tight">
            <span className={`shrink-0 font-bold uppercase tracking-wide ${meta.text}`}>{farmStatusLabel(rec)}</span>
            {markedVerdict ? (
              <span
                className={`shrink-0 font-bold uppercase tracking-wide ${
                  markedVerdict === "too_hard" ? "text-osu-orange" : "text-osu-green-light"
                }`}
                title={markedVerdict === "too_hard" ? "You marked this too hard" : "You marked this too easy"}
              >
                {markedVerdict === "too_hard" ? "marked hard" : "marked easy"}
              </span>
            ) : null}
            {rec.clearRisk ? (
              <span
                className="shrink-0 font-bold uppercase tracking-wide text-osu-orange"
                title="Finishing this looks risky for you; treat it as a clear attempt, not a farm"
              >
                clear attempt
              </span>
            ) : null}
            <span className="shrink-0 tabular-nums text-osu-yellow">★{rec.stars.toFixed(2)}</span>
            <span className="shrink-0 tabular-nums text-osu-f1">{rec.keys}K</span>
            <span className="min-w-0 truncate text-osu-f1">
              {rec.artist}
              {rec.bpm ? ` · ${Math.round(rec.bpm)} bpm` : ""}
              {rec.lengthSec ? ` · ${formatLength(rec.lengthSec)}` : ""}
            </span>
          </div>
        </div>

        <div className="hidden w-[86px] shrink-0 items-center gap-1.5 md:flex">
          <Users className="h-3 w-3 shrink-0 text-osu-f1/70" />
          <span className="flex shrink-0 -space-x-1.5">
            {rec.topPeers.slice(0, 3).map((peer) => (
              <span key={peer.userId} className="inline-flex rounded-full ring-2 ring-osu-b4">
                <Avatar url={peer.avatarUrl} userId={peer.userId} size={16} />
              </span>
            ))}
          </span>
          <span className="text-[11px] font-semibold tabular-nums text-osu-l2">{formatPp(rec.peerCount)}</span>
        </div>

        <div className="w-[74px] shrink-0 text-right sm:w-[88px]">
          {view === "popular" && rec.estimatedPpGain <= 0 ? (
            <>
              <div className="text-[15px] font-black leading-none tabular-nums text-osu-c1">
                {Math.round(rec.peerFraction * 100)}%
              </div>
              <div className="mt-0.5 text-[9px] uppercase tracking-wide text-osu-f1">play this</div>
              <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-osu-b6">
                <div className="h-full rounded-full bg-osu-blue/60" style={{ width: `${clampPct(barPct)}%` }} />
              </div>
            </>
          ) : (
            <>
              <div className="text-[16px] font-black leading-none tabular-nums text-osu-pink">
                +{formatPp(rec.estimatedPpGain)}
              </div>
              <div className="mt-0.5 text-[9px] uppercase tracking-wide text-osu-pink/60">{gainUnit}</div>
              {/* The bar encodes the view's ranking share: popularity share in
                  the popular view, gain share in the gain view. */}
              <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-osu-b6">
                <div className="h-full rounded-full bg-osu-pink/70" style={{ width: `${clampPct(barPct)}%` }} />
              </div>
            </>
          )}
        </div>

        <ArrowUpRight
          className={`hidden h-4 w-4 shrink-0 transition-colors sm:block ${
            selected ? "text-osu-pink" : "text-osu-f1/40 group-hover:text-osu-l2"
          }`}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

function ReasonPill({ rec }: { rec: LiveFarmHelperRec }) {
  const meta = REASON_META[rec.reason];
  const { Icon } = meta;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-wide ${meta.soft} ${meta.text}`}
    >
      <Icon className="h-3 w-3" />
      {farmStatusLabel(rec)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Preview rail                                                        */
/* ------------------------------------------------------------------ */

// Owner-only wiring for the "tune your recs" block. Null for logged-out
// viewers and anyone browsing someone else's board, which hides the block.
interface RecFeedbackControls {
  activeVerdict: FarmHelperFeedbackVerdict | null;
  pending: boolean;
  error: string | null;
  onVerdict: (verdict: FarmHelperFeedbackVerdict) => void;
}

function RecPreview({
  rec,
  snapshot,
  gainUnit,
  feedback = null,
  onOpenDetail,
  onClose,
  className = "",
}: {
  rec: LiveFarmHelperRec;
  snapshot: LiveFarmHelperSnapshot;
  gainUnit: string;
  feedback?: RecFeedbackControls | null;
  onOpenDetail: () => void;
  onClose: () => void;
  className?: string;
}) {
  const bar = comparisonBar(rec);
  const meta = REASON_META[rec.reason];
  const cover = rec.cover || rec.listCover;

  return (
    <div className={`flex flex-col overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b4 ${className}`}>
      <div className="relative shrink-0">
        {cover ? (
          <>
            <img src={cover} alt="" className="h-[86px] w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-osu-b4 via-osu-b4/70 to-osu-b4/20" aria-hidden="true" />
          </>
        ) : (
          <div className="h-[86px] w-full bg-osu-b6" />
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-lg bg-black/50 text-white/80 transition-colors hover:bg-black/70 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="absolute inset-x-0 bottom-0 px-3.5 pb-2.5">
          <div className="truncate text-[14px] font-black leading-tight text-osu-c1">{rec.title}</div>
          <div className="truncate text-[11px] text-osu-l2">
            [{rec.version}] · {rec.creator}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-3.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <ReasonPill rec={rec} />
            {rec.clearRisk ? (
              <span
                className="rounded-full bg-osu-orange/15 px-2 py-[3px] text-[10px] font-bold uppercase tracking-wide text-osu-orange"
                title="Finishing this looks risky for you; treat it as a clear attempt, not a farm"
              >
                clear attempt
              </span>
            ) : null}
            <span className="tabular-nums text-osu-yellow">★{rec.stars.toFixed(2)}</span>
            <span className="tabular-nums text-osu-l2">{rec.keys}K</span>
            {rec.bpm ? <span className="tabular-nums text-osu-f1">{Math.round(rec.bpm)} bpm</span> : null}
            {rec.lengthSec ? <span className="tabular-nums text-osu-f1">{formatLength(rec.lengthSec)}</span> : null}
            <ModList mods={rec.recommendedMods ?? []} size={0.6} />
          </div>

          <p className="text-[12px] leading-snug text-osu-l2">{whySentence(rec)}</p>

          <div className="rounded-lg bg-osu-b5/70 p-3">
            {rec.estimatedPpGain <= 0 ? (
              // Zero-gain owned rows: the owned benchmark can degenerate to the
              // player's own score, so "gain +0 / target" would be misleading.
              // Show the peer play share instead.
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-[9px] font-bold uppercase tracking-wider text-osu-f1">of players near you</div>
                  <div className="mt-0.5 text-2xl font-black leading-none tabular-nums text-osu-c1">
                    {Math.round(rec.peerFraction * 100)}%
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-osu-f1">your best</div>
                  <div className="mt-0.5 text-[14px] font-bold tabular-nums text-osu-c1">
                    {rec.subjectPp != null ? `${formatPp(rec.subjectPp)}pp` : "never played"}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-[9px] font-bold uppercase tracking-wider text-osu-f1">estimated gain</div>
                  <div className="mt-0.5 text-2xl font-black leading-none tabular-nums text-osu-pink">
                    +{formatPp(rec.estimatedPpGain)}
                    <span className="ml-1 text-[13px] font-bold text-osu-pink/70">{gainUnit}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-osu-f1">target score</div>
                  <div className="mt-0.5 text-[14px] font-bold tabular-nums text-osu-c1">{formatPp(rec.benchmarkPp)}pp</div>
                </div>
              </div>
            )}

            <div className="mt-3">
              <div className="flex items-center justify-between gap-2 text-[10.5px]">
                <span className="truncate text-osu-l2">{bar.left}</span>
                <span className="shrink-0 text-osu-f1">{bar.right}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-osu-b6">
                <div className={`h-full rounded-full ${meta.accent}`} style={{ width: `${bar.pct}%` }} />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <PreviewStat label="play this" value={`${Math.round(rec.peerFraction * 100)}%`} tone="text-osu-blue" />
            <PreviewStat label="median" value={`${formatPp(rec.peerPpMedian)}pp`} tone="text-osu-c1" />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onOpenDetail}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-osu-pink px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-osu-pink-light"
            >
              full breakdown
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
            <a
              href={rec.mapUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open map on osu!"
              title="Open map on osu!"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-osu-b3/40 text-osu-l2 transition-colors hover:border-osu-b3/70 hover:text-osu-c1"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </div>

        {feedback ? (
          <div className="border-t border-osu-b3/25 px-3.5 py-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">tune your recs</div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={feedback.pending}
                onClick={() => feedback.onVerdict("too_hard")}
                aria-pressed={feedback.activeVerdict === "too_hard"}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold transition-colors ${
                  feedback.activeVerdict === "too_hard"
                    ? "border-osu-orange/60 bg-osu-orange/15 text-osu-orange"
                    : "border-osu-b3/40 text-osu-f1 hover:border-osu-orange/50 hover:text-osu-l2"
                } ${feedback.pending ? "cursor-default opacity-60" : ""}`}
              >
                too hard
              </button>
              <button
                type="button"
                disabled={feedback.pending}
                onClick={() => feedback.onVerdict("too_easy")}
                aria-pressed={feedback.activeVerdict === "too_easy"}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-bold transition-colors ${
                  feedback.activeVerdict === "too_easy"
                    ? "border-osu-green-light/60 bg-osu-green-light/15 text-osu-green-light"
                    : "border-osu-b3/40 text-osu-f1 hover:border-osu-green-light/50 hover:text-osu-l2"
                } ${feedback.pending ? "cursor-default opacity-60" : ""}`}
              >
                too easy
              </button>
            </div>
            <p className="mt-1.5 text-[10.5px] leading-snug text-osu-f1">
              {feedback.activeVerdict === "too_hard"
                ? "hidden from your recs until you clear it or set a score on it"
                : feedback.activeVerdict === "too_easy"
                  ? "targets on this chart will aim higher until you set the score"
                  : "feels off for your level? mark it and your recs will adjust"}
            </p>
            {feedback.error ? <p className="mt-1 text-[10.5px] leading-snug text-osu-red-light">{feedback.error}</p> : null}
          </div>
        ) : null}

        <div className="border-t border-osu-b3/25">
          <div className="px-3.5 pt-2.5 text-[10px] font-bold uppercase tracking-wider text-osu-f1">who farms this</div>
          <FarmersList
            userKey={String(snapshot.userId)}
            beatmapId={rec.beatmapId}
            speedBucket={rec.speedBucket}
            keyMode={farmersKeyMode(snapshot, rec)}
            className="h-[280px]"
          />
        </div>
      </div>
    </div>
  );
}

function PreviewStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg bg-osu-b5/70 px-2 py-1.5 text-center">
      <div className={`text-[13px] font-bold tabular-nums ${tone}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-wide text-osu-f1">{label}</div>
    </div>
  );
}

// Default rail content: what the numbers on the board actually mean, plus the
// cohort this player is being measured against.
function ReadingGuide({
  snapshot,
  view,
  counts,
  refreshing = false,
  hiddenByMarks = 0,
}: {
  snapshot: LiveFarmHelperSnapshot;
  view: LiveFarmHelperView;
  /** Null while the current view's snapshot is missing: hides the counts so
      the guide never pairs a stale cohort with all-zero numbers. */
  counts: Record<ReasonFilter, number> | null;
  /** A keymode/view switch is loading: the shell snapshot's cohort numbers
      belong to the previous view, so skeleton them like SubjectBar does. */
  refreshing?: boolean;
  /** Owner-only, gain view: lanes the player's too_hard marks removed from the board. */
  hiddenByMarks?: number;
}) {
  const sample = snapshot.peerBand.count || snapshot.peerBand.farmDataCount;
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b4">
      <div className="border-b border-osu-b3/20 px-3.5 py-2.5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">who you're compared to</div>
        {refreshing ? (
          <div className="mt-1.5 space-y-1.5">
            <Skeleton className="h-3 w-44 max-w-full" />
            <Skeleton className="h-2.5 w-36 max-w-full" />
          </div>
        ) : (
          <>
            <div className="mt-0.5 text-[12px] font-semibold text-osu-c1">{peerBandRangeLabel(snapshot)}</div>
            {sample > 0 ? (
              <div className="text-[11px] text-osu-f1">
                {formatPp(sample)} player{sample === 1 ? "" : "s"} sampled around your pp
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="space-y-2.5 px-3.5 py-3">
        <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">
          {view === "popular" ? "what you're browsing" : "why a map shows up"}
        </div>
        {view === "popular" ? (
          <p className="text-[12px] leading-snug text-osu-l2">
            Every farm map the players around your pp actually play, ranked by how many of them have it. Cleared maps stay
            in, so you can see where you already stand.
          </p>
        ) : (
          <>
            <GuideItem
              reason="missing"
              count={counts?.missing ?? null}
              body="Popular with the players around you, and you've never played it."
            />
            <GuideItem
              reason="improve"
              count={counts?.improve ?? null}
              body="You have a score, but players near you score higher on it."
            />
            <GuideItem reason="stale" count={counts?.stale ?? null} body="An old PB you could probably beat." />
            <GuideItem
              reason="push"
              count={counts?.push ?? null}
              body="You already beat the players near you here, but a higher-acc rerun is still worth pp."
            />
            {hiddenByMarks > 0 ? (
              <p className="text-[11px] leading-snug text-osu-orange">
                {formatPp(hiddenByMarks)} map{hiddenByMarks === 1 ? "" : "s"} hidden by your marks
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="space-y-2 border-t border-osu-b3/20 px-3.5 py-3 text-[11px] leading-snug text-osu-f1">
        <p>
          <span className="font-bold text-osu-pink">+pp</span> is the estimated gain if you hit the target score, after weighting
          against your current top plays.
        </p>
        {snapshot.modelsReady === false ? (
          <p className="text-osu-yellow">estimates are rough until we've analyzed more of this player's plays</p>
        ) : null}
        <p className="text-osu-f1/80">Pick any map on the left to preview it here.</p>
      </div>
    </div>
  );
}

function GuideItem({ reason, count, body }: { reason: Exclude<ReasonFilter, "all">; count: number | null; body: string }) {
  const meta = REASON_META[reason];
  const { Icon } = meta;
  return (
    <div className="flex gap-2">
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded ${meta.soft}`}>
        <Icon className={`h-3 w-3 ${meta.text}`} />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className={`text-[11px] font-bold uppercase tracking-wide ${meta.text}`}>{meta.label}</span>
          {count != null ? <span className="text-[11px] tabular-nums text-osu-f1">{formatPp(count)}</span> : null}
        </div>
        <p className="text-[11px] leading-snug text-osu-f1">{body}</p>
      </div>
    </div>
  );
}

// An active mark parsed back out of the local marks map (key = beatmapId:speedBucket).
interface ActiveFeedbackMark {
  key: string;
  beatmapId: number;
  speedBucket: string;
  verdict: FarmHelperFeedbackVerdict;
}

function speedBucketLabel(bucket: string): string {
  if (bucket === "ht") return "HT";
  if (bucket === "dt") return "DT";
  return "NM";
}

function feedbackFailMessage(reason: FarmHelperFeedbackFailReason | undefined): string {
  if (reason === "too_many_marks") return "you have too many active marks, clear some first";
  if (reason === "not_logged_in") return "you're logged out, log in again to save marks";
  return "Couldn't save that. Try again in a moment.";
}

// Owner-only management surface for active marks: a too_hard mark hides its
// lane from every gain view, so without this list there would be no undo path
// after a reload. Marks whose beatmap is in the current snapshot show its
// title; the rest link out to osu! by id.
function MarksManager({
  marks,
  titles,
  pendingKey,
  error,
  onClear,
}: {
  marks: ActiveFeedbackMark[];
  titles: Map<number, string>;
  pendingKey: string | null;
  error: { key: string; message: string } | null;
  onClear: (mark: ActiveFeedbackMark) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b4">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-osu-b3/25"
      >
        <span className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">
          your marks
          <span className="ml-1.5 tabular-nums text-osu-f1/70">{formatPp(marks.length)}</span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-osu-f1 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="border-t border-osu-b3/20">
          <div className="divide-y divide-osu-b3/15">
            {marks.map((mark) => {
              const pending = pendingKey === mark.key;
              return (
                <div key={mark.key} className="px-3.5 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 text-[9px] font-bold uppercase tracking-wide ${
                        mark.verdict === "too_hard" ? "text-osu-orange" : "text-osu-green-light"
                      }`}
                    >
                      {mark.verdict === "too_hard" ? "hard" : "easy"}
                    </span>
                    <a
                      href={`https://osu.ppy.sh/beatmaps/${mark.beatmapId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 flex-1 truncate text-[12px] font-semibold text-osu-c1 transition-colors hover:text-osu-pink"
                    >
                      {titles.get(mark.beatmapId) ?? `beatmap #${mark.beatmapId}`}
                    </a>
                    <span className="shrink-0 text-[10px] font-semibold uppercase tabular-nums text-osu-f1">
                      {speedBucketLabel(mark.speedBucket)}
                    </span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onClear(mark)}
                      className={`shrink-0 rounded-md border border-osu-b3/40 px-2 py-[3px] text-[10px] font-semibold text-osu-f1 transition-colors hover:border-osu-pink/50 hover:text-osu-c1 ${
                        pending ? "cursor-default opacity-60" : ""
                      }`}
                    >
                      clear
                    </button>
                  </div>
                  {error?.key === mark.key ? (
                    <p className="mt-1 text-[10.5px] leading-snug text-osu-red-light">{error.message}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
          <p className="border-t border-osu-b3/20 px-3.5 py-2 text-[10px] leading-snug text-osu-f1">
            too hard hides the lane from your gain views; setting a real score also clears a mark
          </p>
        </div>
      ) : null}
    </div>
  );
}

// Below xl the rail has nowhere to live, so the same preview slides up as a sheet.
function PreviewSheet({
  rec,
  snapshot,
  gainUnit,
  feedback = null,
  onOpenDetail,
  onClose,
}: {
  rec: LiveFarmHelperRec | null;
  snapshot: LiveFarmHelperSnapshot | null;
  gainUnit: string;
  feedback?: RecFeedbackControls | null;
  onOpenDetail?: () => void;
  onClose: () => void;
}) {
  const open = rec != null && snapshot != null;
  // The lock is imperative rather than state-driven: driving it from state
  // meant the sheet re-rendered synchronously in a layout effect on the very
  // commit its enter animation started, which is enough to make framer
  // re-read the entry styles and blink the sheet.
  const lockedOverflowRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const releaseScroll = () => {
    if (lockedOverflowRef.current == null) return;
    document.body.style.overflow = lockedOverflowRef.current;
    lockedOverflowRef.current = null;
  };

  useIsoLayoutEffect(() => {
    if (!open) return;
    if (lockedOverflowRef.current == null) {
      lockedOverflowRef.current = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    // The close handler is a fresh arrow on every parent render, so it is read
    // through a ref here: as a dependency it re-ran this whole effect (and the
    // lock with it) on renders that had nothing to do with the sheet.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // The lock outlives the close so the page behind cannot scroll mid-exit;
  // AnimatePresence releases it below. Crossing the xl breakpoint unmounts the
  // sheet outright, so unmount has to release it too.
  useEffect(() => releaseScroll, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence onExitComplete={releaseScroll}>
      {open && rec && snapshot ? (
        <motion.div
          key="farm-preview-sheet"
          className="fixed inset-0 z-[120] flex items-end justify-center xl:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/70" onClick={onClose} />
          <motion.div
            className="relative z-10 w-full max-w-[520px] px-2 pb-2 will-change-transform"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            onClick={(event) => event.stopPropagation()}
            style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
          >
            <RecPreview
              rec={rec}
              snapshot={snapshot}
              gainUnit={gainUnit}
              feedback={feedback}
              onOpenDetail={onOpenDetail ?? onClose}
              onClose={onClose}
              // Keep the clipped, scrollable card on its own paint layer while
              // its parent translates. Without this, mobile compositors can
              // briefly drop only the card's inner tiles during the enter.
              className="modal-card-mobile-safe max-h-[86dvh] shadow-2xl ring-1 ring-white/10"
            />
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Landing picker (unchanged surface)                                  */
/* ------------------------------------------------------------------ */

// A prefetch is only worth it if the visitor is likely to click, so hovering
// waits out a short dwell: sweeping the mouse across the recent-players row
// must not fire one uncached build per chip crossed. Pointer-down skips the
// wait - by then the click is committed.
const PREFETCH_DWELL_MS = 140;

// Intent handlers for a picker button. Deliberately only for the two lists
// naming a player the visitor has an established relationship with (themselves,
// and someone they looked up before); putting this on every search result would
// fire a costly build per keystroke result.
//
// keyMode/view come from the current search params because picking a player
// preserves them (see navigateFarmHelper), so warming the defaults instead
// would prefetch a board the click never asks for.
function usePickIntent(keyMode: LiveFarmHelperKeyMode, view: LiveFarmHelperView) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => cancel, []);

  return (subjectKey: string) => {
    const warm = () => prefetchFarmHelperSnapshot({ subjectKey, keyMode, view, limit: SNAPSHOT_LIMIT });
    const warmAfterDwell = () => {
      cancel();
      timerRef.current = setTimeout(warm, PREFETCH_DWELL_MS);
    };
    return {
      onPointerEnter: warmAfterDwell,
      onPointerLeave: cancel,
      onFocus: warmAfterDwell,
      onBlur: cancel,
      onPointerDown: () => {
        cancel();
        warm();
      },
    };
  };
}

function PlayerPicker({ viewer, onPick, keyMode, view }: {
  viewer: ReturnType<typeof useAuth>["viewer"];
  onPick: (key: string) => void;
  keyMode: LiveFarmHelperKeyMode;
  view: LiveFarmHelperView;
}) {
  const [recents, setRecents] = useState<RecentPlayer[]>([]);
  const pickIntentProps = usePickIntent(keyMode, view);
  const viewerId = viewer?.id;

  useIsoLayoutEffect(() => {
    const list = readRecentPlayers();
    setRecents(viewerId ? list.filter((p) => p.userId !== viewerId) : list);
  }, [viewerId]);

  const removeRecent = (userId: number) => {
    removeRecentPlayer(userId);
    setRecents((prev) => prev.filter((p) => p.userId !== userId));
  };

  return (
    <div className="mx-auto grid min-h-[70vh] w-full max-w-5xl content-center gap-10 py-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center lg:gap-14">
      <div className="text-center lg:text-left">
        {viewer ? (
          <div>
            <div className="text-3xl font-black leading-tight text-osu-c1">
              <div>maps worth farming</div>
              <div className="mt-3 flex items-center justify-center gap-3 lg:justify-start">
                <span>for</span>
                <button
                  type="button"
                  onClick={() => onPick(String(viewer.id))}
                  {...pickIntentProps(String(viewer.id))}
                  aria-label={`Find farm maps for ${viewer.username}`}
                  className="group inline-flex items-center gap-2.5 rounded-xl border border-osu-b3/30 bg-osu-b4 py-1.5 pl-2 pr-3 text-lg font-bold text-osu-c1 transition-colors duration-150 hover:border-osu-pink/60 hover:bg-osu-b3"
                >
                  <Avatar url={viewer.avatarUrl} userId={viewer.id} size={30} />
                  <span className="max-w-44 truncate">{viewer.username}</span>
                  {viewer.countryCode ? <CountryFlag code={viewer.countryCode} size="sm" decorative /> : null}
                  <ArrowRight className="h-4 w-4 shrink-0 text-osu-pink transition-transform group-hover:translate-x-0.5" />
                </button>
              </div>
            </div>

            <div className="mt-7 flex w-full items-center gap-3">
              <span className="h-px flex-1 bg-osu-b3/30" />
              <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-osu-f1">
                or someone else
              </span>
              <span className="h-px flex-1 bg-osu-b3/30" />
            </div>
          </div>
        ) : (
          <div className="text-3xl font-black leading-tight text-osu-c1">
            <div>maps worth farming</div>
            <div className="mt-3 flex items-center justify-center gap-3 lg:justify-start">
              <span>for</span>
              <SearchInput
                onSearch={searchPlayers}
                onSelect={(user) => onPick(user.username)}
                placeholder="username..."
                className="w-full max-w-60 font-normal"
              />
            </div>
          </div>
        )}

        {viewer ? (
          <div className="mx-auto mt-4 w-full max-w-md lg:mx-0">
            <SearchInput onSearch={searchPlayers} onSelect={(user) => onPick(user.username)} placeholder="username..." />
          </div>
        ) : null}

        {recents.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-osu-f1">recent</div>
            <div className="flex flex-wrap justify-center gap-1.5 lg:justify-start">
              {recents.map((player) => (
                <div
                  key={player.userId}
                  className="flex items-center rounded-lg border border-osu-b3/30 bg-osu-b4 pl-1.5 pr-1 transition-colors duration-150 hover:border-osu-pink/40 hover:bg-osu-b3"
                >
                  <button
                    type="button"
                    onClick={() => onPick(player.username)}
                    {...pickIntentProps(player.username)}
                    className="flex items-center gap-2 py-1.5 pr-1"
                  >
                    <Avatar url={player.avatarUrl} userId={player.userId} size={24} />
                    <span className="max-w-[120px] truncate text-[13px] font-medium text-osu-c1">{player.username}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRecent(player.userId)}
                    aria-label={`Remove ${player.username} from recent`}
                    className="flex h-5 w-5 shrink-0 items-center justify-center text-osu-f1 transition-colors hover:text-osu-c1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mx-auto mt-9 w-fit space-y-2 text-left lg:mx-0">
          <p className="mb-2.5 text-xs text-osu-f1">
            based on what players near the same pp are farming:
          </p>
          <PickerLegend
            icon={<Target className="h-3.5 w-3.5 shrink-0 text-osu-blue" />}
            label="missing"
            body="popular nearby, you haven't played it"
          />
          <PickerLegend
            icon={<TrendingUp className="h-3.5 w-3.5 shrink-0 text-osu-green-light" />}
            label="improve"
            body="nearby players outscore you"
          />
          <PickerLegend
            icon={<History className="h-3.5 w-3.5 shrink-0 text-osu-yellow" />}
            label="old pb"
            body="an old score you could probably beat"
          />
        </div>
      </div>

      <NeighborhoodGraph viewer={viewer} />
    </div>
  );
}

function PickerLegend({ icon, label, body }: { icon: ReactNode; label: string; body: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {icon}
      <span className="w-16 shrink-0 font-bold uppercase tracking-wide text-osu-c1">{label}</span>
      <span className="text-osu-f1">{body}</span>
    </div>
  );
}

interface RecentPlayer {
  userId: number;
  username: string;
  avatarUrl: string;
}

const RECENT_KEY = "mania-hub-farm-helper-recent-v1";
const RECENT_MAX = 8;

function readRecentPlayers(): RecentPlayer[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is RecentPlayer =>
          !!p && typeof p === "object" && Number.isFinite(p.userId) && typeof p.username === "string" && p.username.length > 0,
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function recordRecentPlayer(player: RecentPlayer): void {
  if (typeof window === "undefined" || !player.username) return;
  try {
    const existing = readRecentPlayers().filter((p) => p.userId !== player.userId);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([player, ...existing].slice(0, RECENT_MAX)));
  } catch {
    /* ignore quota / serialization errors */
  }
}

function removeRecentPlayer(userId: number): void {
  if (typeof window === "undefined") return;
  try {
    const existing = readRecentPlayers().filter((p) => p.userId !== userId);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(existing));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function maxGain(recs: LiveFarmHelperRec[]): number {
  return recs.reduce((max, rec) => Math.max(max, rec.estimatedPpGain), 0);
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

// The who-farms list must sample the same cohort that generated the row. On the
// merged Any view that is the row's own keymode cohort (decision 8); the total-pp
// fallback and concrete views keep the snapshot keyMode.
function farmersKeyMode(snapshot: LiveFarmHelperSnapshot | null, rec: LiveFarmHelperRec): LiveFarmHelperKeyMode {
  if (!snapshot) return "any";
  if (snapshot.keyMode !== "any" || snapshot.peerBand.mode === "total_pp_fallback") return snapshot.keyMode;
  if (rec.keys === 7) return "7k";
  if (rec.keys === 4) return "4k";
  return "any";
}

// Concrete-keymode snapshots measure gain in that keymode's variant pp, not
// overall profile pp (snapshot.gainBasis === "keymode"), so a 7K main reading
// the 4K tab knows what the numbers actually move. Older backends omit
// gainBasis and always send overall-pp gains, which keeps the plain "pp" label.
function gainUnitLabel(snapshot: LiveFarmHelperSnapshot | null | undefined): string {
  if (snapshot?.gainBasis !== "keymode") return "pp";
  if (snapshot.keyMode === "4k") return "4K pp";
  if (snapshot.keyMode === "7k") return "7K pp";
  return "pp";
}

// "+123pp" when the unit is plain pp, "+123 4K pp" for variant-pp gains.
function formatGainWithUnit(gain: number, gainUnit: string): string {
  return `+${formatPp(gain)}${gainUnit === "pp" ? "pp" : ` ${gainUnit}`}`;
}

function peerBandRange(band: { count: number; minPp: number; maxPp: number }): string | null {
  if (band.count <= 0 || band.minPp <= 0 || band.maxPp <= 0) return null;
  if (Math.round(band.minPp) === Math.round(band.maxPp)) return formatCompactPp(band.minPp);
  return `${formatCompactPp(band.minPp)}-${formatCompactPp(band.maxPp)}`;
}

function peerBandRangeLabel(snapshot: LiveFarmHelperSnapshot): string {
  // Merged Any view: show each keymode's own range (e.g. "4K 12.9k-15.6k · 7K
  // 13.9k-16.9k") so a hybrid sees both cohorts they are compared against.
  const perMode = snapshot.peerBands
    ? (["4k", "7k"] as const)
        .map((mode) => {
          const band = snapshot.peerBands?.[mode];
          const range = band ? peerBandRange(band) : null;
          return range ? `${mode === "7k" ? "7K" : "4K"} ${range}` : null;
        })
        .filter((part): part is string => part != null)
    : [];
  if (perMode.length > 0) return `compared to ${perMode.join(" · ")} pp`;
  const range = peerBandRange(snapshot.peerBand);
  return range ? `compared to ${range} pp` : "no pp range";
}

function ChangeSubjectButton({ onPick }: { onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (open) {
    return (
      <div ref={ref} className="w-full">
        <SearchInput onSearch={searchPlayers} onSelect={(user) => onPick(user.username)} placeholder="search a player..." />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="w-full rounded-lg bg-osu-b3/60 px-3 py-2 text-xs font-medium text-osu-l2 transition-colors hover:bg-osu-b3"
    >
      change player
    </button>
  );
}

// The key components (beatmapId, speedBucket, userKey) are exactly the detail
// page's URL params ($beatmapId, speed, user), so the reader can rebuild the
// same key from its URL alone.
function writeFarmMapContext(
  beatmapId: number,
  speedBucket: string,
  userKey: string,
  context: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `${FARM_MAP_CONTEXT_KEY_PREFIX}${beatmapId}:${speedBucket}:${userKey}`,
      JSON.stringify({ ...context, writtenAt: Date.now() }),
    );
  } catch {
    /* ignore storage errors */
  }
}

function buildFarmMapDetailContext(
  rec: LiveFarmHelperRec,
  userKey: string,
  userName: string,
  keyMode: LiveFarmHelperKeyMode,
  gainUnit: string,
): Record<string, unknown> {
  return {
    beatmapsetId: rec.beatmapsetId,
    title: rec.title,
    artist: rec.artist,
    creator: rec.creator,
    version: rec.version,
    cover: rec.cover,
    status: rec.status,
    stars: rec.stars,
    keys: rec.keys,
    bpm: rec.bpm,
    lengthSec: rec.lengthSec,
    mapUrl: rec.mapUrl,
    userKey,
    userName,
    keyMode,
    speed: rec.speedBucket,
    reason: rec.reason,
    clearRisk: rec.clearRisk === true ? true : undefined,
    gain: Math.round(rec.estimatedPpGain * 10) / 10,
    gainUnit,
    benchmark: Math.round(rec.benchmarkPp * 10) / 10,
    subjectPp: rec.subjectPp == null ? undefined : Math.round(rec.subjectPp * 10) / 10,
    peerCount: rec.peerCount,
    peerSampleSize: rec.peerSampleSize,
    peerFraction: Math.round(rec.peerFraction * 1000) / 1000,
    median: Math.round(rec.peerPpMedian * 10) / 10,
    p75: Math.round(rec.peerPpP75 * 10) / 10,
    playedAt: rec.subjectPlayedAt ?? undefined,
  };
}

// Stash the rec context, then open the dedicated map detail page (which
// rehydrates the context for its farm verdict).
function useOpenFarmMapDetail() {
  const navigate = useNavigate();
  return (
    rec: LiveFarmHelperRec,
    snapshot: LiveFarmHelperSnapshot | null,
    keyMode: LiveFarmHelperKeyMode,
    gainUnit: string,
  ) => {
    if (!snapshot) return;
    const userKey = String(snapshot.userId);
    writeFarmMapContext(
      rec.beatmapId,
      rec.speedBucket,
      userKey,
      buildFarmMapDetailContext(rec, userKey, snapshot.username, keyMode, gainUnit),
    );
    void navigate({
      to: "/farm-helper/map/$beatmapId",
      params: { beatmapId: String(rec.beatmapId) },
      search: {
        user: userKey,
        key: keyMode,
        speed: rec.speedBucket,
      },
    });
  };
}

function farmStatusLabel(rec: LiveFarmHelperRec): string {
  if (rec.reason === "owned") return "cleared";
  if (rec.reason === "missing") return rec.peerFraction >= 0.45 ? "common pick" : "missing";
  if (rec.reason === "stale") return "old pb";
  if (rec.reason === "push") return "push acc";
  if (rec.estimatedPpGain >= 70) return "large gap";
  return "improve";
}

// One plain-language line explaining why this map is on the board. The
// improve/stale/push/owned templates all quote the player's own score, so they
// only run with a real one; a null subjectPp (never played) falls back to a
// sentence that does not invent a 0pp best.
function whySentence(rec: LiveFarmHelperRec): string {
  const pct = Math.round(rec.peerFraction * 100);
  const nearYou = `${pct}% of the players around your pp`;
  if (rec.reason === "missing") {
    return `${nearYou} farm this and you have never played it. They average ${formatPp(rec.peerPpMedian)}pp on it.`;
  }
  const subjectPp = rec.subjectPp;
  if (subjectPp == null) {
    return `You haven't set a score here yet. ${nearYou} farm this, averaging ${formatPp(rec.peerPpMedian)}pp on it.`;
  }
  if (rec.reason === "stale") {
    return `Your ${formatPp(subjectPp)}pp score is ${formatAge(rec.subjectPlayedAt)} old. The top quarter of players near you sits at ${formatPp(rec.peerPpP75)}pp.`;
  }
  if (rec.reason === "push") {
    return `You already beat the typical score here with ${formatPp(subjectPp)}pp. A cleaner acc run is worth about ${formatPp(rec.benchmarkPp)}pp.`;
  }
  if (rec.reason === "owned") {
    return `${nearYou} farm this. You already have ${formatPp(subjectPp)}pp here against their ${formatPp(rec.peerPpMedian)}pp median.`;
  }
  return `You sit at ${formatPp(subjectPp)}pp while players near you average ${formatPp(rec.peerPpMedian)}pp, so there is headroom on a rerun.`;
}

/* ------------------------------------------------------------------ */
/* Loading / empty states                                              */
/* ------------------------------------------------------------------ */

// `subject` is whatever the click already told us about the player (their own
// account, or a recent pick). Painting it straight away means the board is the
// only thing waiting on the request, not the whole surface.
function LoadingState({ subject }: { subject?: KnownSubject | null }) {
  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-osu-b3/25 bg-osu-b4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-4 px-4 py-4 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {subject ? (
              <Avatar url={subject.avatarUrl} userId={subject.userId} size={48} />
            ) : (
              <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
            )}
            <div className="min-w-0 flex-1 space-y-2">
              {subject ? (
                <div className="truncate text-base font-bold leading-none text-osu-c1">{subject.username}</div>
              ) : (
                <Skeleton className="h-4 w-40 max-w-full" />
              )}
              <Skeleton className="h-2.5 w-56 max-w-full" />
            </div>
          </div>
          <div className="shrink-0 space-y-2 sm:border-l sm:border-osu-b3/25 sm:pl-5">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-2.5 w-40" />
          </div>
        </div>
        <div className="flex items-center gap-2 border-t border-osu-b3/20 bg-osu-b5/40 px-3 py-2 sm:px-4">
          <Skeleton className="h-7 w-20 rounded-lg" />
          <Skeleton className="h-7 w-20 rounded-lg" />
          <Skeleton className="ml-auto h-6 w-28 rounded-lg" />
        </div>
      </div>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_352px]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-osu-b3/20 px-3 py-2">
            <Skeleton className="h-7 w-24 rounded-lg" />
            <Skeleton className="h-7 w-20 rounded-lg" />
            <Skeleton className="h-7 w-20 rounded-lg" />
            <Skeleton className="ml-auto h-7 w-[200px] rounded-lg" />
            <Skeleton className="h-7 w-24 rounded-lg" />
          </div>
          <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4/60">
            <div className="divide-y divide-osu-b3/15">
              {Array.from({ length: 8 }).map((_, i) => (
                <RecRowSkeleton key={i} index={i} />
              ))}
            </div>
          </div>
        </div>
        <div className="hidden xl:block">
          <Skeleton className="h-[420px] w-full rounded-xl" />
        </div>
      </div>
    </>
  );
}

function BoardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4/60">
      <div className="divide-y divide-osu-b3/15">
        {Array.from({ length: 10 }).map((_, i) => (
          <RecRowSkeleton key={i} index={i} />
        ))}
      </div>
    </div>
  );
}

function RecRowSkeleton({ index }: { index: number }) {
  const accents = ["bg-osu-blue", "bg-osu-green-light", "bg-osu-yellow"];
  const widths = ["78%", "62%", "50%", "43%", "36%", "30%", "25%", "20%", "16%", "12%"];
  return (
    <div className="relative bg-osu-b4/40">
      <span
        className={`absolute inset-y-0 right-0 opacity-[0.08] ${accents[index % accents.length]}`}
        style={{ width: widths[index % widths.length] }}
      />
      <span
        className={`absolute inset-y-0 left-0 w-[3px] opacity-40 ${accents[index % accents.length]}`}
      />
      <div className="relative flex items-center gap-3 py-2 pl-3 pr-3 sm:pl-4">
        <Skeleton className="h-3 w-4 shrink-0" />
        <Skeleton className="h-9 w-14 shrink-0 rounded sm:h-10 sm:w-16" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-[300px] max-w-[70%]" />
          <Skeleton className="h-2.5 w-[220px] max-w-[55%]" />
        </div>
        <Skeleton className="hidden h-4 w-[86px] shrink-0 md:block" />
        <Skeleton className="h-5 w-[74px] shrink-0 sm:w-[88px]" />
      </div>
    </div>
  );
}

function EmptyNotice({
  eyebrow,
  title,
  body,
  action,
}: {
  eyebrow: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-osu-f1">{eyebrow}</div>
      <h2 className="mt-1 text-lg font-bold text-osu-c1">{title}</h2>
      <p className="mt-2 text-sm text-osu-f1">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

function ModList({ mods, size = 0.58, className = "" }: { mods: string[]; size?: number; className?: string }) {
  if (mods.length === 0) return null;
  return (
    <div className={`flex shrink-0 items-center justify-end gap-0.5 overflow-hidden ${className}`}>
      {mods.map((mod) => (
        <ModBadge key={mod} mod={mod} size={size} />
      ))}
    </div>
  );
}

function comparisonBar(rec: LiveFarmHelperRec): { left: string; right: string; pct: number } {
  // Missing rows, and any row without a recorded score, compare peers only:
  // there is no real subject score to anchor the other templates on, and a
  // fake "your 0pp" would be worse than the popularity framing.
  if (rec.reason === "missing" || rec.subjectPp == null) {
    const pct = Math.round(rec.peerFraction * 100);
    return {
      left: `${pct}% of players near you farm this`,
      right: `median ${formatPp(rec.peerPpMedian)}pp`,
      pct: clampPct(pct),
    };
  }
  const subjectPp = rec.subjectPp;
  if (rec.reason === "push") {
    // Self-improvement target: the peer median sits at or below the player's
    // own score, so compare against the accuracy-rescaled benchmark instead.
    const pushTarget = rec.benchmarkPp;
    return {
      left: `your ${formatPp(subjectPp)}pp`,
      right: `acc push ${formatPp(pushTarget)}pp`,
      pct: pushTarget > 0 ? clampPct(Math.round((subjectPp / pushTarget) * 100)) : 4,
    };
  }
  const target = rec.reason === "stale" ? rec.peerPpP75 : rec.peerPpMedian;
  const pct = target > 0 ? clampPct(Math.round((subjectPp / target) * 100)) : 4;
  if (rec.reason === "stale") {
    return {
      left: `your ${formatPp(subjectPp)}pp · ${formatAge(rec.subjectPlayedAt)} old`,
      right: `top 25% ${formatPp(target)}pp`,
      pct,
    };
  }
  return {
    left: `your ${formatPp(subjectPp)}pp`,
    right: `median ${formatPp(target)}pp`,
    pct,
  };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(4, Math.min(100, value));
}

function countReasons(recs: LiveFarmHelperRec[]): Record<ReasonFilter, number> {
  const counts: Record<ReasonFilter, number> = { all: recs.length, missing: 0, improve: 0, stale: 0, push: 0 };
  // "owned" only appears in the popular view, where the reason filter is hidden.
  for (const rec of recs) {
    if (rec.reason !== "owned") counts[rec.reason] += 1;
  }
  return counts;
}

function formatPp(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCompactPp(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/, "")}k`;
  return formatPp(value);
}

function formatLength(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatAge(iso: string | null): string {
  if (!iso) return "a while";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return "a while";
  const months = Math.floor(ms / (30 * 86_400_000));
  if (months >= 12) return `${Math.floor(months / 12)}y`;
  if (months >= 1) return `${months}mo`;
  const days = Math.max(1, Math.floor(ms / 86_400_000));
  return `${days}d`;
}
