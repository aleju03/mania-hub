import { createFileRoute, Link, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ExternalLink, Users, Target, TrendingUp, History, ArrowRight, X } from "lucide-react";
import {
  fetchLiveFarmHelperFarmers,
  fetchLiveFarmHelperSnapshot,
  isLiveBackendConfigured,
  type LiveFarmHelperFarmer,
  type LiveFarmHelperKeyMode,
  type LiveFarmHelperRec,
  type LiveFarmHelperSnapshot,
} from "../lib/live-backend";
import { searchUsers } from "../lib/osu";
import { PageHeader } from "../components/layout/PageHeader";
import { SearchInput } from "../components/ui/SearchInput";
import { Avatar } from "../components/ui/Avatar";
import { CountryFlag } from "../components/ui/CountryFlag";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { Pagination } from "../components/ui/Pagination";
import { ModBadge } from "../components/ui/ModBadge";
import { UsernameText } from "../components/ui/UsernameText";
import { useAuth } from "../lib/auth-context";
import { pageSeo } from "../lib/seo";

const PAGE_SIZE = 10;

type ReasonFilter = "all" | "missing" | "improve" | "stale";
type SortMode = "gain" | "popularity" | "players" | "difficulty";
type SortDirection = "asc" | "desc";

interface FarmHelperSearch {
  user?: string;
  key?: LiveFarmHelperKeyMode;
}

function parseKeyMode(value: unknown): LiveFarmHelperKeyMode | undefined {
  return value === "4k" || value === "7k" || value === "any" ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
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
  validateSearch: (search: Record<string, unknown>): FarmHelperSearch => ({
    user: typeof search.user === "string" && search.user.trim() ? search.user.trim().slice(0, 60) : undefined,
    key: parseKeyMode(search.key),
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

const REASON_META: Record<LiveFarmHelperRec["reason"], { label: string; accent: string; text: string }> = {
  missing: { label: "missing", accent: "bg-osu-blue", text: "text-osu-blue" },
  improve: { label: "improve", accent: "bg-osu-green-light", text: "text-osu-green-light" },
  stale: { label: "old pb", accent: "bg-osu-yellow", text: "text-osu-yellow" },
};

const FARM_MAP_CONTEXT_KEY_PREFIX = "mania-hub-farm-helper-map-context-v1:";

function FarmHelperLayout() {
  const matches = useMatches();
  const hasChildRoute = matches.some((match) => match.routeId === "/farm-helper/map/$beatmapId");
  if (hasChildRoute) return <Outlet />;
  return <FarmHelperPage />;
}

function FarmHelperPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const auth = useAuth();
  const liveEnabled = isLiveBackendConfigured();

  const [snapshot, setSnapshot] = useState<LiveFarmHelperSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonFilter, setReasonFilter] = useState<ReasonFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("gain");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const subjectKey = search.user ?? null;
  const keyMode: LiveFarmHelperKeyMode = search.key ?? "any";

  const setSubject = (key: string | null) => {
    navigate({ to: "/farm-helper", search: { user: key ?? undefined, key: keyMode === "any" ? undefined : keyMode }, replace: false });
  };

  const setKeyMode = (next: LiveFarmHelperKeyMode) => {
    navigate({ to: "/farm-helper", search: { user: subjectKey ?? undefined, key: next === "any" ? undefined : next }, replace: true });
  };

  useEffect(() => {
    if (!liveEnabled || !subjectKey) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchLiveFarmHelperSnapshot(subjectKey, { keyMode, signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        recordRecentPlayer({ userId: data.userId, username: data.username, avatarUrl: data.avatarUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isAbortError(err)) return;
        setSnapshot(null);
        const message = err instanceof Error ? err.message : String(err);
        setError(message.includes("404") ? "not-found" : "failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [liveEnabled, subjectKey, keyMode]);

  const [page, setPage] = useState(0);
  const [farmersFor, setFarmersFor] = useState<LiveFarmHelperRec | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recs = useMemo(() => {
    if (!snapshot) return [];
    const filtered = reasonFilter === "all" ? snapshot.recs : snapshot.recs.filter((rec) => rec.reason === reasonFilter);
    const sorted = [...filtered];
    const direction = sortDir === "desc" ? 1 : -1;
    sorted.sort((a, b) => {
      const byGain = b.estimatedPpGain - a.estimatedPpGain;
      const byFit = b.peerFraction - a.peerFraction;
      const byPlayers = b.peerCount - a.peerCount;
      const byStars = b.stars - a.stars;
      const bySelected =
        sortMode === "gain" ? byGain
          : sortMode === "popularity" ? byFit
            : sortMode === "players" ? byPlayers
              : byStars;
      return (bySelected || byGain || byFit || byPlayers || byStars) * direction;
    });
    return sorted;
  }, [snapshot, reasonFilter, sortMode, sortDir]);

  // Reset to the first page whenever the result set changes underneath us.
  useEffect(() => {
    setPage(0);
  }, [subjectKey, keyMode, reasonFilter, sortMode, sortDir]);

  const pageCount = Math.ceil(recs.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const pageRecs = recs.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const goToPage = (next: number) => {
    setPage(next);
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col bg-osu-b5">
        <PageHeader
          iconSrc="/images/icons/rankings.svg"
          title="Global mania farm helper"
        />

        <div className="mx-auto w-full max-w-[1280px] px-4 py-5 sm:px-5">
          {!liveEnabled ? (
            <EmptyNotice
              eyebrow="unavailable"
              title="Farm Helper needs the live backend"
              body="This tool reads cross-country farm data from the live backend, which isn't configured in this environment."
            />
          ) : !subjectKey ? (
            <PlayerPicker viewer={auth.viewer} onPick={setSubject} />
          ) : loading && !snapshot ? (
            <LoadingState />
          ) : error === "not-found" ? (
            <EmptyNotice
              eyebrow="not found"
              title={`Couldn't find "${subjectKey}"`}
              body="Check the spelling, or search for the player again."
              action={<ChangeSubjectButton onPick={setSubject} />}
            />
          ) : error ? (
            <EmptyNotice
              eyebrow="error"
              title="Couldn't build recommendations"
              body="Something went wrong loading this player's farm data. Try again in a moment."
              action={<ChangeSubjectButton onPick={setSubject} />}
            />
          ) : snapshot ? (
            <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
              <TargetPanel snapshot={snapshot} onChangePlayer={() => setSubject(null)} />

              <div ref={listRef} className="min-w-0 scroll-mt-4">
                <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
                  <div className="border-b border-osu-b3/20 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">recommendations</div>
                        <div className="mt-0.5 text-sm font-semibold text-osu-c1">
                          {formatPp(recs.length)} map{recs.length === 1 ? "" : "s"}
                          <span className="font-normal text-osu-f1"> · +{formatPp(totalGain(recs))}pp on the table</span>
                        </div>
                      </div>
                      <KeyModeControl requestedKeyMode={keyMode} onKeyMode={setKeyMode} />
                    </div>
                    <Filters
                      reasonFilter={reasonFilter}
                      onReason={setReasonFilter}
                      sortMode={sortMode}
                      sortDir={sortDir}
                      onSort={(next) => {
                        setSortDir(sortMode === next ? (sortDir === "desc" ? "asc" : "desc") : "desc");
                        setSortMode(next);
                      }}
                      counts={countReasons(snapshot.recs)}
                    />
                  </div>

                  {recs.length === 0 ? (
                    <EmptyNotice
                      eyebrow="all caught up"
                      title="Nothing left to farm at your level"
                      body="No farm maps match this filter. Try widening the key mode or clearing the reason filter."
                    />
                  ) : (
                    <div className="divide-y divide-osu-b3/20">
                      {pageRecs.map((rec) => (
                        <RecRow
                          key={`${rec.beatmapId}:${rec.speedBucket}`}
                          rec={rec}
                          userKey={String(snapshot.userId)}
                          keyMode={keyMode}
                          onShowFarmers={() => setFarmersFor(rec)}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {pageCount > 1 ? (
                  <div
                    className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-osu-b3/30 bg-osu-b5/90 px-4 py-2 backdrop-blur-sm after:absolute after:left-0 after:right-0 after:top-full after:h-4 after:bg-osu-b5/90 after:backdrop-blur-sm after:content-[''] sm:-mx-5 sm:px-5 [&>div]:!mt-0 relative"
                    style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
                  >
                    <Pagination page={safePage} totalPages={pageCount} onPageChange={goToPage} />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <FarmersModal
        rec={farmersFor}
        userKey={snapshot ? String(snapshot.userId) : null}
        onClose={() => setFarmersFor(null)}
      />
    </div>
  );
}

function PlayerPicker({ viewer, onPick }: { viewer: ReturnType<typeof useAuth>["viewer"]; onPick: (key: string) => void }) {
  const [recents, setRecents] = useState<RecentPlayer[]>([]);
  const viewerId = viewer?.id;

  useLayoutEffect(() => {
    const list = readRecentPlayers();
    setRecents(viewerId ? list.filter((p) => p.userId !== viewerId) : list);
  }, [viewerId]);

  const removeRecent = (userId: number) => {
    removeRecentPlayer(userId);
    setRecents((prev) => prev.filter((p) => p.userId !== userId));
  };

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center py-10 text-center">
      {viewer ? (
        <div className="flex flex-col items-center">
          <button
            type="button"
            onClick={() => onPick(String(viewer.id))}
            aria-label={`Plan ${viewer.username}'s farm`}
            className="inline-flex rounded-full ring-2 ring-osu-pink/30 transition-shadow hover:ring-osu-pink/60"
          >
            <Avatar url={viewer.avatarUrl} userId={viewer.id} size={88} />
          </button>
          <div className="mt-4 flex items-center justify-center gap-2">
            <h2 className="text-xl font-bold text-osu-c1">Hey, {viewer.username}</h2>
            {viewer.countryCode ? <CountryFlag code={viewer.countryCode} size="sm" decorative /> : null}
          </div>
          <p className="mt-1 text-sm text-osu-f1">Ready to find your next farm?</p>
          <button
            type="button"
            onClick={() => onPick(String(viewer.id))}
            className="group mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-osu-pink px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-osu-pink-light"
          >
            Plan my farm
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </button>

          <div className="mt-8 flex w-full items-center gap-3">
            <span className="h-px flex-1 bg-osu-b3/30" />
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-osu-f1">
              or look up someone else
            </span>
            <span className="h-px flex-1 bg-osu-b3/30" />
          </div>
        </div>
      ) : (
        <div>
          <h2 className="text-xl font-bold text-osu-c1">Ranked Map Finder</h2>
          <p className="mt-1 text-sm text-osu-f1">Maps worth farming, based on players near your pp.</p>
        </div>
      )}

      <div className={viewer ? "mt-4" : "mt-6"}>
        <SearchInput onSearch={searchPlayers} onSelect={(user) => onPick(user.username)} placeholder="enter your user..." />
      </div>

      {recents.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-osu-f1">recent</div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {recents.map((player) => (
              <div
                key={player.userId}
                className="flex items-center rounded-lg border border-osu-b3/30 bg-osu-b4 pl-1.5 pr-1 transition-colors duration-150 hover:border-osu-pink/40 hover:bg-osu-b3"
              >
                <button
                  type="button"
                  onClick={() => onPick(player.username)}
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

      <div className="mx-auto mt-10 flex max-w-xs flex-col gap-2 text-left">
        <PickerLegend
          icon={<Target className="h-3.5 w-3.5 shrink-0 text-osu-blue" />}
          label="missing"
          body="popular with nearby players"
        />
        <PickerLegend
          icon={<TrendingUp className="h-3.5 w-3.5 shrink-0 text-osu-green-light" />}
          label="improve"
          body="room to gain from your score"
        />
        <PickerLegend
          icon={<History className="h-3.5 w-3.5 shrink-0 text-osu-yellow" />}
          label="old pb"
          body="old pbs worth replaying for pp"
        />
      </div>
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

function TargetPanel({
  snapshot,
  onChangePlayer,
}: {
  snapshot: LiveFarmHelperSnapshot;
  onChangePlayer: () => void;
}) {
  const mapCount = snapshot.recs.length;
  const biggest = maxGain(snapshot.recs);
  return (
    <aside className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
        <div className="relative overflow-hidden">
          {snapshot.coverUrl ? (
            <>
              <div
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url(${snapshot.coverUrl})` }}
                aria-hidden="true"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-osu-b4 via-osu-b4/85 to-osu-b4/55" aria-hidden="true" />
            </>
          ) : null}
          <div className="relative flex items-center gap-3 p-4">
            <span className="inline-flex shrink-0 rounded-full ring-2 ring-white/10">
              <Avatar url={snapshot.avatarUrl} userId={snapshot.userId} size={52} />
            </span>
            <div className="min-w-0">
              <Link
                to="/player/$username"
                params={{ username: snapshot.username }}
                className="block truncate text-base font-bold text-osu-pink hover:brightness-110"
              >
                <UsernameText username={snapshot.username} avatarUrl={snapshot.avatarUrl} />
              </Link>
              <div className="text-[12px] font-semibold tabular-nums text-osu-c1">{formatPp(snapshot.pp)}pp</div>
              <div className="text-[11px] text-osu-f1">{peerBandRangeLabel(snapshot)}</div>
            </div>
          </div>
        </div>

        <div className="border-t border-osu-b3/20 px-4 py-4">
          <div className="text-[10px] font-bold uppercase tracking-wider text-osu-f1">potential pp gain</div>
          <div className="mt-1 text-3xl font-black leading-none tabular-nums text-osu-pink">
            +{formatPp(snapshot.totalPotentialPp)}
            <span className="ml-1 text-base font-bold text-osu-pink/70">pp</span>
          </div>
          {mapCount > 0 ? (
            <div className="mt-2 text-[11px] text-osu-f1">
              across {formatPp(mapCount)} map{mapCount === 1 ? "" : "s"}
              {biggest > 0 ? ` · biggest +${formatPp(biggest)}pp` : ""}
            </div>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={onChangePlayer}
        className="w-full rounded-xl border border-osu-b3/20 bg-osu-b4 px-3 py-2.5 text-xs font-medium text-osu-l2 transition-colors hover:bg-osu-b3"
      >
        change player
      </button>
    </aside>
  );
}

function maxGain(recs: LiveFarmHelperRec[]): number {
  return recs.reduce((max, rec) => Math.max(max, rec.estimatedPpGain), 0);
}

function totalGain(recs: LiveFarmHelperRec[]): number {
  return recs.reduce((sum, rec) => sum + Math.max(0, rec.estimatedPpGain), 0);
}

function peerBandRangeLabel(snapshot: LiveFarmHelperSnapshot): string {
  const { count, minPp, maxPp } = snapshot.peerBand;
  if (count <= 0 || minPp <= 0 || maxPp <= 0) return "no pp range";
  if (Math.round(minPp) === Math.round(maxPp)) return `compared to ${formatCompactPp(minPp)} pp`;
  return `compared to ${formatCompactPp(minPp)}-${formatCompactPp(maxPp)} pp`;
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

function Filters({
  reasonFilter,
  onReason,
  sortMode,
  sortDir,
  onSort,
  counts,
}: {
  reasonFilter: ReasonFilter;
  onReason: (next: ReasonFilter) => void;
  sortMode: SortMode;
  sortDir: SortDirection;
  onSort: (next: SortMode) => void;
  counts: Record<ReasonFilter, number>;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <ChipGroup label="show">
        <SegmentedControl>
          {(["all", "missing", "improve", "stale"] as const).map((reason) => (
            <SegmentButton key={reason} active={reasonFilter === reason} onClick={() => onReason(reason)}>
              {reason === "stale" ? "old" : reason}
              <span className={`tabular-nums ${reasonFilter === reason ? "text-osu-pink-light/70" : "text-osu-f1/70"}`}>
                {counts[reason]}
              </span>
            </SegmentButton>
          ))}
        </SegmentedControl>
      </ChipGroup>
      <ChipGroup label="sort">
        <SegmentedControl>
          {(
            [
              ["gain", "gain"],
              ["popularity", "fit"],
              ["players", "players"],
              ["difficulty", "stars"],
            ] as const
          ).map(([value, label]) => (
            <SegmentButton
              key={value}
              active={sortMode === value}
              onClick={() => onSort(value)}
              title={sortMode === value ? (sortDir === "desc" ? "Click to sort ascending" : "Click to sort descending") : undefined}
            >
              {label}
              {sortMode === value ? (
                <span aria-hidden className="text-[10px] leading-none opacity-90">
                  {sortDir === "desc" ? "↓" : "↑"}
                </span>
              ) : null}
            </SegmentButton>
          ))}
        </SegmentedControl>
      </ChipGroup>
    </div>
  );
}

function KeyModeControl({
  requestedKeyMode,
  onKeyMode,
}: {
  requestedKeyMode: LiveFarmHelperKeyMode;
  onKeyMode: (next: LiveFarmHelperKeyMode) => void;
}) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-lg border border-osu-b3/30" role="group" aria-label="Key mode">
      {(["any", "4k", "7k"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => onKeyMode(mode)}
          aria-pressed={requestedKeyMode === mode}
          className={`px-2.5 py-1.5 text-[11px] font-medium uppercase tabular-nums transition-colors duration-[120ms] ${
            requestedKeyMode === mode
              ? "bg-osu-b3 text-osu-l2"
              : "bg-osu-b4/50 text-osu-f1 hover:text-osu-l2"
          }`}
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[9px] font-bold uppercase tracking-wider text-osu-f1/70">{label}</span>
      <div className="flex items-center">{children}</div>
    </div>
  );
}

function SegmentedControl({ children }: { children: ReactNode }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b4/50">
      {children}
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`inline-flex items-center gap-1 border-r border-osu-b3/25 px-2.5 py-1.5 text-[11px] font-medium transition-colors duration-[120ms] last:border-r-0 ${
        active
          ? "bg-osu-pink/15 text-osu-pink-light"
          : "text-osu-f1 hover:bg-osu-b3/70 hover:text-osu-l2"
      }`}
    >
      {children}
    </button>
  );
}

function RecRow({
  rec,
  userKey,
  keyMode,
  onShowFarmers,
}: {
  rec: LiveFarmHelperRec;
  userKey: string;
  keyMode: LiveFarmHelperKeyMode;
  onShowFarmers: () => void;
}) {
  const meta = REASON_META[rec.reason];
  const bar = comparisonBar(rec);
  const fit = confidence(rec);
  const navigate = useNavigate();
  const detailContext = {
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
    keyMode,
    speed: rec.speedBucket,
    reason: rec.reason,
    gain: Math.round(rec.estimatedPpGain * 10) / 10,
    benchmark: Math.round(rec.benchmarkPp * 10) / 10,
    subjectPp: rec.subjectPp == null ? undefined : Math.round(rec.subjectPp * 10) / 10,
    peerCount: rec.peerCount,
    peerSampleSize: rec.peerSampleSize,
    peerFraction: Math.round(rec.peerFraction * 1000) / 1000,
    median: Math.round(rec.peerPpMedian * 10) / 10,
    p75: Math.round(rec.peerPpP75 * 10) / 10,
    playedAt: rec.subjectPlayedAt ?? undefined,
  };
  const rememberContext = () => {
    writeFarmMapContext(rec.beatmapId, detailContext);
  };
  const openDetails = () => {
    rememberContext();
    void navigate({
      to: "/farm-helper/map/$beatmapId",
      params: { beatmapId: String(rec.beatmapId) },
    });
  };
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={openDetails}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDetails();
        }
      }}
      aria-label={`Open details for ${rec.title} [${rec.version}]`}
      className="group relative cursor-pointer bg-osu-b4 transition-colors hover:bg-osu-b3/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/60"
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${meta.accent}`} />
      <div className="grid gap-3 p-2.5 pl-4 md:grid-cols-[56px_minmax(0,1fr)_118px] md:items-center md:gap-3.5 md:p-3 md:pl-5">
        <div className="h-14 w-full overflow-hidden rounded-md bg-osu-b6 md:h-[56px]">
          {rec.cover ? <img src={rec.cover} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
        </div>

        <div className="min-w-0">
          <div className="flex min-w-0 items-center justify-start gap-1.5">
            <div className="min-w-0 max-w-full truncate text-[14px] font-bold text-osu-c1">
              {rec.title}
              <span className="font-medium text-osu-f1"> [{rec.version}]</span>
            </div>
            <ModList mods={rec.recommendedMods ?? []} size={0.62} className="max-w-[120px]" />
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] leading-tight">
            <span className={`font-bold uppercase tracking-wide ${meta.text}`}>{farmStatusLabel(rec)}</span>
            <span className="tabular-nums text-osu-yellow">★{rec.stars.toFixed(2)}</span>
            <span className="tabular-nums text-osu-green-light">{fit}% fit</span>
            <span className="min-w-0 truncate text-osu-f1">
              {rec.artist} · {rec.creator}
              {rec.bpm ? ` · ${Math.round(rec.bpm)} bpm` : ""}
              {rec.lengthSec ? ` · ${formatLength(rec.lengthSec)}` : ""}
            </span>
          </div>

          <div className="mt-1.5 flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-osu-l2">{bar.left}</span>
                <span className="shrink-0 text-osu-f1">{bar.right}</span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-osu-b6">
                <div className={`h-full rounded-full ${meta.accent}`} style={{ width: `${bar.pct}%` }} />
              </div>
            </div>
            <PeerList rec={rec} onShowFarmers={onShowFarmers} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 md:flex-col md:items-end md:justify-center md:gap-1.5">
          <div className="md:text-right">
            <div className="text-xl font-black leading-none tabular-nums text-osu-pink">
              +{formatPp(rec.estimatedPpGain)}
              <span className="text-xs font-bold text-osu-pink/70">pp</span>
            </div>
            <div className="mt-1 text-[10px] text-osu-f1">{formatPp(rec.benchmarkPp)}pp benchmark</div>
          </div>
          <a
            href={rec.mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-osu-b6/70 text-osu-l2 transition-colors hover:bg-osu-b3 hover:text-osu-c1"
            aria-label="Open map"
            title="Open map"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

function writeFarmMapContext(beatmapId: number, context: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${FARM_MAP_CONTEXT_KEY_PREFIX}${beatmapId}`, JSON.stringify(context));
  } catch {
    /* ignore storage errors */
  }
}

function PeerList({ rec, onShowFarmers }: { rec: LiveFarmHelperRec; onShowFarmers: () => void }) {
  const shown = rec.topPeers.slice(0, 3);
  if (shown.length === 0) return null;
  const overflow = Math.max(0, rec.peerCount - shown.length);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onShowFarmers();
      }}
      className="group/farmers flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-osu-b3/50"
      title="See everyone who farmed this"
    >
      <Users className="h-3.5 w-3.5 shrink-0 text-osu-f1" />
      <div className="flex shrink-0 -space-x-1.5">
        {shown.map((peer) => (
          <span key={peer.userId} className="inline-flex rounded-full ring-2 ring-osu-b4">
            <Avatar url={peer.avatarUrl} userId={peer.userId} size={18} />
          </span>
        ))}
      </div>
      <span className="shrink-0 text-[11px] font-semibold text-osu-l2">
        {rec.peerCount}
        {overflow > 0 ? <span className="text-osu-f1"> players</span> : null}
      </span>
    </button>
  );
}

function farmStatusLabel(rec: LiveFarmHelperRec): string {
  if (rec.reason === "missing") return rec.peerFraction >= 0.45 ? "common pick" : "missing";
  if (rec.reason === "stale") return "old pb";
  if (rec.estimatedPpGain >= 70) return "large gap";
  return "improve";
}

function confidence(rec: LiveFarmHelperRec): number {
  const peerScore = clampPct(rec.peerFraction * 100);
  const reasonBoost = rec.reason === "missing" ? 14 : rec.reason === "improve" ? 7 : 0;
  const difficultyPenalty = Math.max(0, rec.stars - 6) * 5;
  return Math.round(clampPct(peerScore + reasonBoost - difficultyPenalty));
}

function LoadingState() {
  return (
    <div className="grid w-full gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="space-y-3">
        <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
          <div className="relative overflow-hidden">
            <Skeleton className="absolute inset-0 rounded-none opacity-50" />
            <div className="absolute inset-0 bg-gradient-to-t from-osu-b4 via-osu-b4/85 to-osu-b4/55" aria-hidden="true" />
            <div className="relative flex items-center gap-3 p-4">
              <Skeleton className="h-[52px] w-[52px] shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-24 max-w-full" />
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-2.5 w-28 max-w-full" />
              </div>
            </div>
          </div>
          <div className="space-y-2 border-t border-osu-b3/20 px-4 py-4">
            <Skeleton className="h-2.5 w-28" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-2.5 w-44 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-[38px] w-full rounded-xl" />
      </aside>

      <div className="min-w-0">
        <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
          <div className="border-b border-osu-b3/20 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <Skeleton className="h-2.5 w-24" />
                <Skeleton className="h-4 w-64 max-w-full" />
              </div>
              <div className="flex overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b4/50">
                <Skeleton className="h-7 w-12 rounded-none border-r border-osu-b3/25" />
                <Skeleton className="h-7 w-10 rounded-none border-r border-osu-b3/25" />
                <Skeleton className="h-7 w-10 rounded-none" />
              </div>
            </div>
            <div className="mt-3 hidden flex-wrap items-center gap-x-3 gap-y-2 sm:flex">
              <FilterGroupSkeleton labelWidth="w-8" buttonWidths={["w-14", "w-20", "w-20", "w-14"]} />
              <FilterGroupSkeleton labelWidth="w-7" buttonWidths={["w-14", "w-10", "w-16", "w-12"]} />
            </div>
          </div>
          <div className="divide-y divide-osu-b3/20">
            {Array.from({ length: 6 }).map((_, i) => (
              <RecRowSkeleton key={i} index={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterGroupSkeleton({ labelWidth, buttonWidths }: { labelWidth: string; buttonWidths: string[] }) {
  return (
    <div className="flex items-center gap-1.5">
      <Skeleton className={`h-2.5 ${labelWidth}`} />
      <div className="flex overflow-hidden rounded-lg border border-osu-b3/30 bg-osu-b4/50">
        {buttonWidths.map((width, index) => (
          <Skeleton key={index} className={`h-7 ${width} rounded-none border-r border-osu-b3/25 last:border-r-0`} />
        ))}
      </div>
    </div>
  );
}

function RecRowSkeleton({ index }: { index: number }) {
  const accents = ["bg-osu-yellow", "bg-osu-green-light", "bg-osu-blue"];
  return (
    <div className="relative bg-osu-b4">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${accents[index % accents.length]}`} />
      <div className="grid gap-3 p-2.5 pl-4 md:grid-cols-[56px_minmax(0,1fr)_118px] md:items-center md:gap-3.5 md:p-3 md:pl-5">
        <Skeleton className="h-14 w-full rounded-md md:h-[56px]" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <Skeleton className="h-3.5 w-80 max-w-[70%]" />
            <Skeleton className="h-4 w-6 rounded" />
          </div>
          <Skeleton className="mt-1.5 h-3 w-[460px] max-w-[80%]" />
          <div className="mt-1.5 flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-2.5 w-24" />
                <Skeleton className="h-2.5 w-28" />
              </div>
              <Skeleton className="mt-1 h-1 w-full rounded-full" />
            </div>
            <div className="hidden items-center gap-1.5 md:flex">
              <Skeleton className="h-3.5 w-3.5 rounded" />
              <div className="flex -space-x-1.5">
                <Skeleton className="h-[18px] w-[18px] rounded-full" />
                <Skeleton className="h-[18px] w-[18px] rounded-full" />
                <Skeleton className="h-[18px] w-[18px] rounded-full" />
              </div>
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 md:flex-col md:items-end md:justify-center md:gap-1.5">
          <div className="space-y-1.5 md:flex md:flex-col md:items-end">
            <Skeleton className="h-5 w-14" />
            <Skeleton className="h-2.5 w-20" />
          </div>
          <Skeleton className="h-7 w-7 rounded-lg" />
        </div>
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

function FarmersModal({
  rec,
  userKey,
  onClose,
}: {
  rec: LiveFarmHelperRec | null;
  userKey: string | null;
  onClose: () => void;
}) {
  const open = rec != null && userKey != null;
  const [farmers, setFarmers] = useState<LiveFarmHelperFarmer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [scrollLocked, setScrollLocked] = useState(false);
  const beatmapId = rec?.beatmapId ?? null;
  const speedBucket = rec?.speedBucket;

  useEffect(() => {
    if (!open || beatmapId == null || !userKey) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    setFarmers([]);
    setTotal(0);
    setQuery("");
    fetchLiveFarmHelperFarmers(userKey, beatmapId, speedBucket, { signal: controller.signal })
      .then((data) => {
        if (cancelled) return;
        setFarmers(data.farmers);
        setTotal(data.total);
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, beatmapId, speedBucket, userKey]);

  useLayoutEffect(() => {
    if (!open) return;
    setScrollLocked(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!scrollLocked) return;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    const prevScrollbarCompensation = document.documentElement.style.getPropertyValue("--modal-scrollbar-compensation");
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const hasStableScrollbarGutter =
      typeof CSS !== "undefined" && CSS.supports?.("scrollbar-gutter", "stable");
    document.body.style.overflow = "hidden";
    if (scrollbar > 0 && !hasStableScrollbarGutter) {
      const current = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${current + scrollbar}px`;
      document.documentElement.style.setProperty("--modal-scrollbar-compensation", `${scrollbar}px`);
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
      if (prevScrollbarCompensation) {
        document.documentElement.style.setProperty("--modal-scrollbar-compensation", prevScrollbarCompensation);
      } else {
        document.documentElement.style.removeProperty("--modal-scrollbar-compensation");
      }
    };
  }, [scrollLocked]);

  if (typeof document === "undefined") return null;

  const q = query.trim().toLowerCase();
  const visible = q ? farmers.filter((f) => f.username.toLowerCase().includes(q)) : farmers;

  return createPortal(
    <AnimatePresence onExitComplete={() => setScrollLocked(false)}>
      {open && rec ? (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-6 sm:pl-6 sm:pr-[calc(1.5rem+var(--modal-scrollbar-compensation,0px))]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/80" onClick={onClose} />
          <motion.div
            className="relative z-10 flex h-[min(34rem,calc(100vh-1.5rem))] w-full max-w-[360px] flex-col overflow-hidden rounded-xl bg-osu-b5 shadow-2xl ring-1 ring-white/10 sm:h-[min(34rem,calc(100vh-3rem))]"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative shrink-0 overflow-hidden border-b border-osu-b3/30 px-3 py-3">
              {rec.cover ? (
                <div
                  className="absolute inset-0 bg-cover bg-center opacity-[0.12]"
                  style={{ backgroundImage: `url(${rec.cover})` }}
                  aria-hidden="true"
                />
              ) : null}
              <div className="relative flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">who farms this</div>
                  <div className="mt-0.5 truncate text-[13px] font-bold text-osu-c1">{rec.title}</div>
                  <div className="truncate text-[11px] text-osu-f1">
                    [{rec.version}] · {rec.keys}K · {rec.stars.toFixed(2)}★
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="shrink-0 rounded-lg bg-osu-b3/60 px-2 py-1 text-[11px] text-osu-l2 transition-colors hover:bg-osu-b3"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="h-[42px] shrink-0 px-3 pt-2.5">
              {loading || total > 8 ? (
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="search player..."
                  disabled={loading}
                  className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4 px-3 py-1.5 text-[11px] text-osu-c1 placeholder:text-osu-f1 transition-colors focus:border-osu-h1/40 focus:outline-none"
                />
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
              {loading ? (
                <div className="space-y-1.5">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 rounded-lg" />
                  ))}
                </div>
              ) : failed ? (
                <div className="py-10 text-center text-sm text-osu-f1">Couldn't load the farmer list. Try again.</div>
              ) : visible.length === 0 ? (
                <div className="py-10 text-center text-sm text-osu-f1">
                  {q ? "No players match." : "No nearby players have farmed this yet."}
                </div>
              ) : (
                <div className="space-y-1">
                  {visible.map((farmer) => {
                    const rank = farmers.findIndex((candidate) => candidate.userId === farmer.userId) + 1;
                    return (
                      <Link
                        key={farmer.userId}
                        to="/player/$username"
                        params={{ username: farmer.username || String(farmer.userId) }}
                        className="flex items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-osu-b3/50"
                      >
                        <span className="w-6 shrink-0 text-right text-[11px] font-semibold tabular-nums text-osu-f1">
                          #{rank}
                        </span>
                        <Avatar url={farmer.avatarUrl} userId={farmer.userId} size={24} />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-osu-c1">
                          {farmer.username || `#${farmer.userId}`}
                        </span>
                        <ModList mods={farmer.mods ?? []} className="max-w-[112px]" />
                        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-osu-l2">{formatPp(farmer.pp)}pp</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-osu-b3/30 px-3 py-2 text-[10px] text-osu-f1">
              {loading
                ? "loading..."
                : `${formatPp(total)} player${total === 1 ? "" : "s"} farmed this${
                    farmers.length < total ? ` · showing top ${farmers.length}` : ""
                  }`}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
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
  if (rec.reason === "missing") {
    const pct = Math.round(rec.peerFraction * 100);
    return {
      left: `${pct}% of sampled nearby players farm this`,
      right: `they hit ${formatPp(rec.peerPpMedian)}pp`,
      pct: clampPct(pct),
    };
  }
  const subjectPp = rec.subjectPp ?? 0;
  const target = rec.reason === "stale" ? rec.peerPpP75 : rec.peerPpMedian;
  const pct = target > 0 ? clampPct(Math.round((subjectPp / target) * 100)) : 4;
  if (rec.reason === "stale") {
    return {
      left: `your ${formatPp(subjectPp)}pp · ${formatAge(rec.subjectPlayedAt)} old`,
      right: `sample reaches ${formatPp(target)}pp`,
      pct,
    };
  }
  return {
    left: `your ${formatPp(subjectPp)}pp`,
    right: `sample hits ${formatPp(target)}pp`,
    pct,
  };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(4, Math.min(100, value));
}

function countReasons(recs: LiveFarmHelperRec[]): Record<ReasonFilter, number> {
  const counts: Record<ReasonFilter, number> = { all: recs.length, missing: 0, improve: 0, stale: 0 };
  for (const rec of recs) counts[rec.reason] += 1;
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
