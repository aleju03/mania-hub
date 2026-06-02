import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
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
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { SearchInput } from "../components/ui/SearchInput";
import { Avatar } from "../components/ui/Avatar";
import { CountryFlag } from "../components/ui/CountryFlag";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { Pagination } from "../components/ui/Pagination";
import { useAuth } from "../lib/auth-context";
import { canUseDevFeatures } from "../lib/auth-shared";

const PAGE_SIZE = 12;

type ReasonFilter = "all" | "missing" | "improve" | "stale";
type SortMode = "gain" | "popularity" | "difficulty";

interface FarmHelperSearch {
  user?: string;
  key?: LiveFarmHelperKeyMode;
}

function parseKeyMode(value: unknown): LiveFarmHelperKeyMode | undefined {
  return value === "4k" || value === "7k" || value === "any" ? value : undefined;
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
  // Dev-only for now: gated like the admin/dev routes (og-preview, dan-classifier).
  beforeLoad: ({ context }) => {
    if (!canUseDevFeatures(context.auth)) throw notFound();
  },
  validateSearch: (search: Record<string, unknown>): FarmHelperSearch => ({
    user: typeof search.user === "string" && search.user.trim() ? search.user.trim().slice(0, 60) : undefined,
    key: parseKeyMode(search.key),
  }),
  head: () => ({
    meta: [
      { title: "Farm Helper - Mania Hub" },
      {
        name: "description",
        content:
          "Personalised farm map recommendations: maps players at your skill level farm that you're missing, plus stale PBs worth re-running for pp.",
      },
    ],
  }),
  component: FarmHelperPage,
});

const REASON_META: Record<LiveFarmHelperRec["reason"], { label: string; accent: string; text: string }> = {
  missing: { label: "not farmed", accent: "bg-osu-blue", text: "text-osu-blue" },
  improve: { label: "beatable", accent: "bg-osu-green-light", text: "text-osu-green-light" },
  stale: { label: "stale pb", accent: "bg-osu-yellow", text: "text-osu-yellow" },
};

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

  const subjectKey = search.user ?? null;
  const keyMode = search.key;

  const setSubject = (key: string | null) => {
    navigate({ to: "/farm-helper", search: { user: key ?? undefined, key: keyMode }, replace: false });
  };

  const setKeyMode = (next: LiveFarmHelperKeyMode | undefined) => {
    navigate({ to: "/farm-helper", search: { user: subjectKey ?? undefined, key: next }, replace: true });
  };

  useEffect(() => {
    if (!liveEnabled || !subjectKey) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchLiveFarmHelperSnapshot(subjectKey, keyMode ? { keyMode } : undefined)
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        recordRecentPlayer({ userId: data.userId, username: data.username, avatarUrl: data.avatarUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSnapshot(null);
        const message = err instanceof Error ? err.message : String(err);
        setError(message.includes("404") ? "not-found" : "failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [liveEnabled, subjectKey, keyMode]);

  const [page, setPage] = useState(0);
  const [farmersFor, setFarmersFor] = useState<LiveFarmHelperRec | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const recs = useMemo(() => {
    if (!snapshot) return [];
    const filtered = reasonFilter === "all" ? snapshot.recs : snapshot.recs.filter((rec) => rec.reason === reasonFilter);
    const sorted = [...filtered];
    if (sortMode === "gain") sorted.sort((a, b) => b.estimatedPpGain - a.estimatedPpGain);
    else if (sortMode === "popularity") sorted.sort((a, b) => b.peerFraction - a.peerFraction);
    else sorted.sort((a, b) => b.stars - a.stars);
    return sorted;
  }, [snapshot, reasonFilter, sortMode]);

  // Reset to the first page whenever the result set changes underneath us.
  useEffect(() => {
    setPage(0);
  }, [subjectKey, keyMode, reasonFilter, sortMode]);

  const pageCount = Math.ceil(recs.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const pageRecs = recs.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const goToPage = (next: number) => {
    setPage(next);
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="relative min-h-screen">
      <OsuTriangleBackdrop />
      <div className="relative z-10">
        <PageHeader iconSrc="/images/icons/rankings.svg" title="farm helper" />

        <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-5">
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
            <div className="space-y-4">
              <SubjectHero snapshot={snapshot} onPick={setSubject} />
              <div ref={listRef} className="scroll-mt-4 space-y-4">
                <Filters
                  keyMode={snapshot.keyMode}
                  requestedKeyMode={keyMode}
                  onKeyMode={setKeyMode}
                  reasonFilter={reasonFilter}
                  onReason={setReasonFilter}
                  sortMode={sortMode}
                  onSort={setSortMode}
                  counts={countReasons(snapshot.recs)}
                />
                {recs.length === 0 ? (
                  <EmptyNotice
                    eyebrow="all caught up"
                    title="Nothing left to farm at your level"
                    body="No farm maps match this filter. Try widening the key mode or clearing the reason filter."
                  />
                ) : (
                  <>
                    <div className="space-y-2">
                      {pageRecs.map((rec, index) => (
                        <RecRow
                          key={rec.beatmapId}
                          rec={rec}
                          rank={safePage * PAGE_SIZE + index + 1}
                          index={index}
                          onShowFarmers={() => setFarmersFor(rec)}
                        />
                      ))}
                    </div>
                    <Pagination page={safePage} totalPages={pageCount} onPageChange={goToPage} />
                  </>
                )}
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
  const recents = useMemo(() => {
    const list = readRecentPlayers();
    return viewer ? list.filter((p) => p.userId !== viewer.id) : list;
  }, [viewer]);

  return (
    <div className="mx-auto max-w-xl space-y-3">
      {viewer ? (
        <button
          type="button"
          onClick={() => onPick(String(viewer.id))}
          className="flex w-full items-center gap-3.5 rounded-xl border border-osu-pink/30 bg-osu-pink/10 px-4 py-4 text-left transition-colors hover:bg-osu-pink/15"
        >
          <Avatar url={viewer.avatarUrl} userId={viewer.id} size={48} />
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-lg font-bold text-osu-c1">{viewer.username}</span>
            {viewer.countryCode ? (
              <CountryFlag code={viewer.countryCode} size="sm" decorative />
            ) : null}
            <span className="rounded-full bg-osu-pink/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-osu-pink">
              you
            </span>
          </div>
          <span className="ml-auto shrink-0 text-sm font-semibold text-osu-pink">plan my farm &rarr;</span>
        </button>
      ) : null}

      <SearchInput
        onSearch={searchPlayers}
        onSelect={(user) => onPick(user.username)}
        placeholder={viewer ? "or search another player..." : "search a player..."}
      />

      {recents.length > 0 ? (
        <div className="pt-1">
          <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-osu-f1">recent</div>
          <div className="space-y-1.5">
            {recents.map((player) => (
              <button
                key={player.userId}
                type="button"
                onClick={() => onPick(player.username)}
                className="flex w-full items-center gap-2.5 rounded-lg border border-osu-b3/20 bg-osu-b4 px-3 py-2 text-left transition-colors hover:bg-osu-b3/50"
              >
                <Avatar url={player.avatarUrl} userId={player.userId} size={30} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-osu-c1">{player.username}</span>
                <span className="shrink-0 text-[11px] text-osu-f1">&rarr;</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
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

function SubjectHero({ snapshot, onPick }: { snapshot: LiveFarmHelperSnapshot; onPick: (key: string) => void }) {
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-5">
        <Avatar url={snapshot.avatarUrl} userId={snapshot.userId} size={46} />
        <div className="min-w-0">
          <Link
            to="/player/$username"
            params={{ username: snapshot.username }}
            className="text-base font-bold text-osu-c1 hover:text-osu-pink"
          >
            {snapshot.username}
          </Link>
          <div className="text-[12px] text-osu-f1">
            {formatPp(snapshot.pp)}pp · vs {snapshot.peerBand.count} rivals around your pp
          </div>
        </div>
        <div className="ml-auto">
          <ChangeSubjectButton onPick={onPick} />
        </div>
      </div>
      <div className="grid grid-cols-3 divide-x divide-osu-b3/20 border-t border-osu-b3/20">
        <HeroStat label="potential pp" value={`+${formatPp(snapshot.totalPotentialPp)}`} accent />
        <HeroStat label="farm maps" value={String(snapshot.recs.length)} />
        <HeroStat label="biggest gain" value={`+${formatPp(maxGain(snapshot.recs))}`} accent />
      </div>
    </div>
  );
}

function maxGain(recs: LiveFarmHelperRec[]): number {
  return recs.reduce((max, rec) => Math.max(max, rec.estimatedPpGain), 0);
}

function HeroStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">{label}</div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${accent ? "text-osu-pink" : "text-osu-c1"}`}>{value}</div>
    </div>
  );
}

function ChangeSubjectButton({ onPick }: { onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <div className="w-full max-w-xs">
        <SearchInput onSearch={searchPlayers} onSelect={(user) => onPick(user.username)} placeholder="search a player..." />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="rounded-lg bg-osu-b3/60 px-3 py-2 text-xs font-medium text-osu-l2 transition-colors hover:bg-osu-b3"
    >
      change player
    </button>
  );
}

function Filters({
  keyMode,
  requestedKeyMode,
  onKeyMode,
  reasonFilter,
  onReason,
  sortMode,
  onSort,
  counts,
}: {
  keyMode: LiveFarmHelperKeyMode;
  requestedKeyMode: LiveFarmHelperKeyMode | undefined;
  onKeyMode: (next: LiveFarmHelperKeyMode | undefined) => void;
  reasonFilter: ReasonFilter;
  onReason: (next: ReasonFilter) => void;
  sortMode: SortMode;
  onSort: (next: SortMode) => void;
  counts: Record<ReasonFilter, number>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <ChipGroup label="keys">
        {(["4k", "7k", "any"] as const).map((mode) => (
          <Chip key={mode} active={(requestedKeyMode ?? keyMode) === mode} onClick={() => onKeyMode(mode)}>
            {mode}
          </Chip>
        ))}
      </ChipGroup>
      <ChipGroup label="show">
        {(["all", "missing", "improve", "stale"] as const).map((reason) => (
          <Chip key={reason} active={reasonFilter === reason} onClick={() => onReason(reason)}>
            {reason}
            <span className={`ml-1 ${reasonFilter === reason ? "text-osu-b6/55" : "text-osu-f1"}`}>{counts[reason]}</span>
          </Chip>
        ))}
      </ChipGroup>
      <ChipGroup label="sort">
        {(
          [
            ["gain", "pp gain"],
            ["popularity", "popularity"],
            ["difficulty", "difficulty"],
          ] as const
        ).map(([value, label]) => (
          <Chip key={value} active={sortMode === value} onClick={() => onSort(value)}>
            {label}
          </Chip>
        ))}
      </ChipGroup>
    </div>
  );
}

function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-f1">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
        active ? "bg-osu-h1 text-osu-b6" : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3"
      }`}
    >
      {children}
    </button>
  );
}

function RecRow({
  rec,
  rank,
  index,
  onShowFarmers,
}: {
  rec: LiveFarmHelperRec;
  rank: number;
  index: number;
  onShowFarmers: () => void;
}) {
  const meta = REASON_META[rec.reason];
  const bar = comparisonBar(rec);
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, delay: Math.min(index, 12) * 0.02 }}
      className="relative overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4 transition-colors hover:bg-osu-b3/40"
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] ${meta.accent}`} />
      <div className="flex gap-3 p-3 pl-4 sm:gap-4 sm:p-3.5 sm:pl-5">
        <a
          href={rec.mapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="relative h-14 w-20 shrink-0 overflow-hidden rounded-lg bg-osu-b6 sm:h-16 sm:w-28"
        >
          {rec.cover ? <img src={rec.cover} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
          <span className="absolute left-1 top-1 rounded bg-black/55 px-1 text-[10px] font-bold tabular-nums text-white">
            #{rank}
          </span>
        </a>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-bold uppercase tracking-wider ${meta.text}`}>{meta.label}</span>
                <span className="rounded bg-osu-b6/70 px-1.5 py-0.5 text-[10px] font-bold text-osu-l2">{rec.keys}K</span>
                <span className="text-[11px] font-semibold tabular-nums text-osu-yellow">{rec.stars.toFixed(2)}★</span>
              </div>
              <a
                href={rec.mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block truncate text-sm font-semibold text-osu-c1 hover:text-osu-pink"
              >
                {rec.title}
                <span className="font-normal text-osu-f1"> [{rec.version}]</span>
              </a>
              <div className="truncate text-[12px] text-osu-f1">
                {rec.artist} · mapped by {rec.creator}
                {rec.bpm ? ` · ${Math.round(rec.bpm)} bpm` : ""}
                {rec.lengthSec ? ` · ${formatLength(rec.lengthSec)}` : ""}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-lg font-bold leading-none tabular-nums text-osu-pink sm:text-xl">
                +{formatPp(rec.estimatedPpGain)}
                <span className="text-xs font-semibold text-osu-pink/70">pp</span>
              </div>
              <div className="mt-1 text-[10px] text-osu-f1">est. gain</div>
            </div>
          </div>

          <div className="mt-2.5 max-w-md">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-osu-l2">{bar.left}</span>
              <span className="text-osu-f1">{bar.right}</span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-osu-b6">
              <div className={`h-full rounded-full ${meta.accent}`} style={{ width: `${bar.pct}%` }} />
            </div>
          </div>

          <PeerList rec={rec} onShowFarmers={onShowFarmers} />
        </div>
      </div>
    </motion.div>
  );
}

function PeerList({ rec, onShowFarmers }: { rec: LiveFarmHelperRec; onShowFarmers: () => void }) {
  const shown = rec.topPeers.slice(0, 3);
  if (shown.length === 0) return null;
  const overflow = rec.peerCount - shown.length;
  const names = shown.map((peer) => peer.username || `#${peer.userId}`).join(", ");
  return (
    <button
      type="button"
      onClick={onShowFarmers}
      className="group/farmers mt-2.5 -ml-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-osu-b3/50"
      title="See everyone who farmed this"
    >
      <span className="shrink-0 text-[11px] text-osu-f1">farmed by</span>
      <div className="flex shrink-0 -space-x-1.5">
        {shown.map((peer) => (
          <span key={peer.userId} className="inline-flex rounded-full ring-2 ring-osu-b4">
            <Avatar url={peer.avatarUrl} userId={peer.userId} size={18} />
          </span>
        ))}
      </div>
      <span className="min-w-0 truncate text-[11px] font-medium text-osu-l2">
        {names}
        {overflow > 0 ? <span className="text-osu-f1"> +{overflow} more</span> : null}
      </span>
      <span className="ml-0.5 shrink-0 text-[11px] font-semibold text-osu-pink/80 group-hover/farmers:text-osu-pink">
        view &rsaquo;
      </span>
    </button>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-[120px] w-full rounded-xl" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
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
  const beatmapId = rec?.beatmapId ?? null;

  useEffect(() => {
    if (!open || beatmapId == null || !userKey) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setFarmers([]);
    setTotal(0);
    setQuery("");
    fetchLiveFarmHelperFarmers(userKey, beatmapId)
      .then((data) => {
        if (cancelled) return;
        setFarmers(data.farmers);
        setTotal(data.total);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, beatmapId, userKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) {
      const current = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = `${current + scrollbar}px`;
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  const q = query.trim().toLowerCase();
  const visible = q ? farmers.filter((f) => f.username.toLowerCase().includes(q)) : farmers;

  return createPortal(
    <AnimatePresence>
      {open && rec ? (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/80" onClick={onClose} />
          <motion.div
            className="relative z-10 flex max-h-[calc(100vh-1.5rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-osu-b5 shadow-2xl ring-1 ring-white/10 sm:max-h-[calc(100vh-3rem)]"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative shrink-0 overflow-hidden border-b border-osu-b3/30 p-4">
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
                  <div className="mt-0.5 truncate text-sm font-bold text-osu-c1">{rec.title}</div>
                  <div className="truncate text-[11px] text-osu-f1">
                    [{rec.version}] · {rec.keys}K · {rec.stars.toFixed(2)}★
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="shrink-0 rounded-lg bg-osu-b3/60 px-2 py-1 text-xs text-osu-l2 transition-colors hover:bg-osu-b3"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            {total > 8 ? (
              <div className="shrink-0 px-4 pt-3">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="search player..."
                  className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4 px-3 py-1.5 text-[12px] text-osu-c1 placeholder:text-osu-f1 transition-colors focus:border-osu-h1/40 focus:outline-none"
                />
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {loading ? (
                <div className="space-y-1.5">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 rounded-lg" />
                  ))}
                </div>
              ) : failed ? (
                <div className="py-10 text-center text-sm text-osu-f1">Couldn't load the farmer list. Try again.</div>
              ) : visible.length === 0 ? (
                <div className="py-10 text-center text-sm text-osu-f1">
                  {q ? "No players match." : "No rivals have farmed this yet."}
                </div>
              ) : (
                <div className="space-y-1">
                  {visible.map((farmer) => (
                    <Link
                      key={farmer.userId}
                      to="/player/$username"
                      params={{ username: farmer.username || String(farmer.userId) }}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-osu-b3/50"
                    >
                      <span className="w-6 shrink-0 text-right text-[11px] font-semibold tabular-nums text-osu-f1">
                        #{farmers.indexOf(farmer) + 1}
                      </span>
                      <Avatar url={farmer.avatarUrl} userId={farmer.userId} size={28} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-osu-c1">
                        {farmer.username || `#${farmer.userId}`}
                      </span>
                      <span className="shrink-0 text-[12px] font-semibold tabular-nums text-osu-l2">{formatPp(farmer.pp)}pp</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-osu-b3/30 px-4 py-2 text-[11px] text-osu-f1">
              {loading
                ? "loading..."
                : `${formatPp(total)} rival${total === 1 ? "" : "s"} farmed this${
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

function comparisonBar(rec: LiveFarmHelperRec): { left: string; right: string; pct: number } {
  if (rec.reason === "missing") {
    const pct = Math.round(rec.peerFraction * 100);
    return {
      left: `${pct}% of rivals farm this`,
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
      right: `rivals reach ${formatPp(target)}pp`,
      pct,
    };
  }
  return {
    left: `your ${formatPp(subjectPp)}pp`,
    right: `rivals hit ${formatPp(target)}pp`,
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
