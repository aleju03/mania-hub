import { Link } from "@tanstack/react-router";
import { ChevronDown, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmModal } from "../../ui/ConfirmModal";
import { CountryFlag } from "../../ui/CountryFlag";
import { Skeleton } from "../../ui/LoadingSkeleton";
import { ModBadge } from "../../ui/ModBadge";
import { Pagination } from "../../ui/Pagination";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { setCompanellaAccountBlocked } from "../../../lib/banned-users";
import {
  listCompanellaAccountPlays,
  listCompanellaAccounts,
  type CompanellaAccount,
  type CompanellaAccountFilter,
  type CompanellaAccountPlay,
  type Paged,
} from "../../../lib/companella-accounts";
import { setRateFlagHeld } from "../../../lib/companella-rate-flags";
import { formatAccuracy, formatNumber, formatTimeAgo } from "../../../lib/format";

const PAGE_SIZE = 50;
const PLAYS_PAGE_SIZE = 20;

const FILTERS: { value: CompanellaAccountFilter; label: string }[] = [
  { value: "recent", label: "All players" },
  { value: "blocked", label: "Blocked" },
];

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] sm:py-1 sm:text-[11px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";

const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;

const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;

/* Undefined while loading; "error" when the fetch failed. */
type Loadable<T> = T | "error" | undefined;

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function plural(count: number, noun: string): string {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function When({ iso, prefix }: { iso: string; prefix: string }) {
  return <span title={formatWhen(iso)}>{prefix} {formatTimeAgo(iso)}</span>;
}

function AccountRow({
  entry,
  open,
  busy,
  plays,
  playsPage,
  onToggle,
  onBlock,
  onHold,
  onPlaysPage,
  onRetry,
}: {
  entry: CompanellaAccount;
  open: boolean;
  busy: boolean;
  plays: Loadable<Paged<CompanellaAccountPlay>>;
  playsPage: number;
  onToggle: () => void;
  onBlock: () => void;
  onHold: (play: CompanellaAccountPlay, held: boolean) => void;
  onPlaysPage: (page: number) => void;
  onRetry: () => void;
}) {
  const blocked = entry.blockedAt != null;
  return (
    <div className={open ? "bg-osu-b4/25" : undefined}>
      <div
        onClick={onToggle}
        className={`flex cursor-pointer items-start gap-3 px-3 py-3 transition-colors duration-[120ms] sm:items-center ${open ? "" : "hover:bg-osu-b4/20"}`}
      >
        {entry.avatarUrl ? (
          <img src={entry.avatarUrl} alt="" className="h-9 w-9 flex-shrink-0 rounded-full object-cover" />
        ) : (
          <span className="block h-9 w-9 flex-shrink-0 rounded-full bg-osu-b4" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link
              to="/player/$username"
              params={{ username: String(entry.userId) }}
              onClick={(event) => event.stopPropagation()}
              className="min-w-0 truncate text-[14px] font-semibold text-white hover:text-osu-pink-light"
            >
              {entry.username}
            </Link>
            {entry.countryCode ? <CountryFlag code={entry.countryCode} size="xs" decorative /> : null}
            {blocked ? <span className="rounded bg-osu-red/15 px-1.5 py-0.5 text-[11px] font-semibold text-osu-red-light">blocked</span> : null}
            <span className="font-mono text-[11px] text-osu-f1">#{entry.userId}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-osu-f1">
            <span className="text-osu-l2">{plural(entry.plays, "play")}</span>
            {entry.heldPlays > 0 ? <span className="text-amber-300">{formatNumber(entry.heldPlays)} excluded</span> : null}
            {entry.flaggedPlays > 0 ? <span className="text-osu-red-light">{formatNumber(entry.flaggedPlays)} rate flagged</span> : null}
            <span>{plural(entry.activeConnections, "connection")}</span>
            {entry.lastPlayAt ? <When iso={entry.lastPlayAt} prefix="last play" /> : null}
            {entry.blockedAt ? <When iso={entry.blockedAt} prefix="blocked" /> : null}
          </div>
        </div>
        <button
          onClick={(event) => { event.stopPropagation(); onToggle(); }}
          aria-expanded={open}
          aria-label={open ? "Close" : "Open"}
          className="grid h-8 w-8 flex-shrink-0 cursor-pointer place-items-center rounded-md text-osu-f1 transition-colors duration-[120ms] hover:bg-osu-b4/60 hover:text-white"
        >
          <ChevronDown size={16} className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {open ? (
        <div className="space-y-4 px-3 pb-4 sm:pl-[60px]">
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={busy} onClick={onBlock} className={blocked ? ACTION_CLASS : DANGER_CLASS}>
              {blocked ? "Unblock Companella" : "Block Companella"}
            </button>
          </div>
          <PlaysList plays={plays} page={playsPage} busy={busy} onHold={onHold} onPage={onPlaysPage} onRetry={onRetry} />
        </div>
      ) : null}
    </div>
  );
}

function PlaysList({
  plays,
  page,
  busy,
  onHold,
  onPage,
  onRetry,
}: {
  plays: Loadable<Paged<CompanellaAccountPlay>>;
  page: number;
  busy: boolean;
  onHold: (play: CompanellaAccountPlay, held: boolean) => void;
  onPage: (page: number) => void;
  onRetry: () => void;
}) {
  if (plays === undefined) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-[14px] w-[260px] max-w-full rounded" />)}
      </div>
    );
  }
  if (plays === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-osu-red-light">
        <span>Could not load the plays.</span>
        <button onClick={onRetry} className={ACTION_CLASS}>Retry</button>
      </div>
    );
  }
  if (plays.total === 0) return <p className="text-[12px] text-osu-f1">No plays.</p>;
  return (
    <div className="space-y-2">
      <div className="divide-y divide-osu-b3/15">
        {plays.entries.map((play) => {
          const excluded = play.reviewState !== "clear";
          const chartName = [play.chart.artist, play.chart.title].filter(Boolean).join(" - ") || "Unknown chart";
          const when = play.playedAt ?? play.receivedAt;
          return (
            <div key={play.scoreId} className="flex items-center gap-3 py-2">
              <div className={`min-w-0 flex-1 ${excluded ? "opacity-50" : ""}`}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[12px] font-semibold text-white" title={chartName}>{chartName}</span>
                  {play.chart.keyCount ? <span className="flex-shrink-0 text-[11px] font-semibold text-osu-yellow">{play.chart.keyCount}K</span> : null}
                  {play.mods.length ? (
                    <span className="flex flex-shrink-0 items-center gap-0.5">
                      {play.mods.map((mod) => <ModBadge key={mod} mod={mod} size={0.6} />)}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-osu-f1">
                  {play.chart.version ? <span className="truncate">[{play.chart.version}]</span> : null}
                  {play.accuracy != null ? <span className="tabular-nums text-osu-l2">{formatAccuracy(play.accuracy)}</span> : null}
                  {when ? <span title={formatWhen(when)}>{formatTimeAgo(when)}</span> : null}
                  {play.rateSuspicious ? <span className="text-osu-red-light">rate flagged</span> : null}
                  {excluded ? <span className="text-amber-300">Excluded</span> : null}
                </div>
              </div>
              <button
                disabled={busy}
                onClick={() => onHold(play, !excluded)}
                aria-label={excluded ? "Restore" : "Exclude"}
                className={`${excluded ? ACTION_CLASS : DANGER_CLASS} flex-shrink-0 sm:min-w-[76px]`}
              >
                {excluded ? <RotateCcw size={13} /> : <X size={13} />}
                <span className="hidden sm:inline">{excluded ? "Restore" : "Exclude"}</span>
              </button>
            </div>
          );
        })}
      </div>
      <Pagination page={page} totalPages={Math.ceil(plays.total / PLAYS_PAGE_SIZE)} onPageChange={onPage} />
    </div>
  );
}

export function CompanellaPlayersPanel({
  filter, query, page, userId, onQueryChange, onFilterChange, onPageChange,
}: {
  filter: CompanellaAccountFilter;
  query: string;
  page: number;
  userId?: number;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: CompanellaAccountFilter) => void;
  onPageChange: (page: number) => void;
}) {
  const [searchInput, setSearchInput] = useState(query);
  const offset = page * PAGE_SIZE;
  const [entries, setEntries] = useState<CompanellaAccount[] | null>(null);
  const [total, setTotal] = useState(0);
  const [openId, setOpenId] = useState<number | null>(userId ?? null);
  const [plays, setPlays] = useState<Record<number, Loadable<Paged<CompanellaAccountPlay>>>>({});
  const [playsPage, setPlaysPage] = useState<Record<number, number>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [blockAsk, setBlockAsk] = useState<CompanellaAccount | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => { setSearchInput(query); }, [query]);

  useEffect(() => {
    if (searchInput.trim() === query) return;
    const timer = setTimeout(() => onQueryChange(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput, query, onQueryChange]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const page = await listCompanellaAccounts({ data: { filter, query, limit: PAGE_SIZE, offset } });
      if (request !== requestRef.current) return;
      setEntries(page.entries);
      setTotal(page.total);
      setError(null);
    } catch {
      if (request !== requestRef.current) return;
      setEntries([]);
      setError("Could not load Companella players.");
    }
  }, [filter, query, offset]);

  useEffect(() => { void load(); }, [load]);

  const loadPlays = useCallback(async (userId: number, page: number) => {
    try {
      const result = await listCompanellaAccountPlays({ data: { userId, limit: PLAYS_PAGE_SIZE, offset: page * PLAYS_PAGE_SIZE } });
      setPlays((current) => ({ ...current, [userId]: result }));
    } catch {
      setPlays((current) => ({ ...current, [userId]: "error" }));
    }
  }, []);

  useEffect(() => {
    setOpenId(userId ?? null);
    if (userId != null) void loadPlays(userId, 0);
  }, [userId, loadPlays]);

  const toggle = (entry: CompanellaAccount) => {
    if (openId === entry.userId) {
      setOpenId(null);
      return;
    }
    setOpenId(entry.userId);
    setPlays((current) => current[entry.userId] === "error" ? { ...current, [entry.userId]: undefined } : current);
    void loadPlays(entry.userId, playsPage[entry.userId] ?? 0);
  };

  const act = async (userId: number, run: () => Promise<unknown>, done?: string) => {
    setBusyId(userId);
    setMessage(null);
    try {
      await run();
      if (done) setMessage(done);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through.");
    } finally {
      setBusyId(null);
    }
  };

  const setBlocked = (entry: CompanellaAccount, blocked: boolean) =>
    act(
      entry.userId,
      () => setCompanellaAccountBlocked({ data: { userId: entry.userId, blocked } }),
      blocked ? `Blocked ${entry.username} from Companella.` : `${entry.username} can connect Companella again.`,
    );

  const hold = (entry: CompanellaAccount, play: CompanellaAccountPlay, held: boolean) =>
    act(entry.userId, async () => {
      await setRateFlagHeld({ data: { scoreId: play.scoreId, held } });
      await loadPlays(entry.userId, playsPage[entry.userId] ?? 0);
    });

  const changePlaysPage = (entry: CompanellaAccount, page: number) => {
    setPlaysPage((current) => ({ ...current, [entry.userId]: page }));
    void loadPlays(entry.userId, page);
  };

  const changeFilter = (next: CompanellaAccountFilter) => {
    onFilterChange(next);
    setOpenId(null);
  };

  const changePage = (page: number) => {
    onPageChange(page);
    setOpenId(null);
    window.scrollTo({ top: 0 });
  };

  const refresh = () => {
    void load();
    if (openId != null) void loadPlays(openId, playsPage[openId] ?? 0);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl id="companella-players-filter" value={filter} options={FILTERS} onChange={changeFilter} />
        <div className="relative order-3 w-full min-w-0 sm:order-none sm:ml-auto sm:w-[260px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setSearchInput(""); }}
            placeholder="Username or #id"
            aria-label="Find a Companella player"
            className="w-full rounded-md border border-osu-b3/50 bg-osu-b6/70 py-1.5 pl-8 pr-8 text-xs text-osu-l1 outline-none transition-colors placeholder:text-osu-f1/60 focus:border-osu-pink/45"
          />
          {searchInput ? (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-osu-l1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <button onClick={refresh} disabled={busyId != null} className={`${ACTION_CLASS} ml-auto sm:ml-0`} aria-label="Refresh">
          <RefreshCw size={13} />
          <span>Refresh</span>
        </button>
      </div>
      <p className="text-[12px] text-osu-f1">Exclude keeps a play out of Companella results without deleting it. Restore lets it count again.</p>

      {error ? <Notice text={error} tone="error" onDismiss={() => setError(null)} /> : null}
      {message ? <Notice text={message} onDismiss={() => setMessage(null)} /> : null}

      {entries === null ? (
        <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 divide-y divide-osu-b3/20">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="px-3 py-3 flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-full" />
              <Skeleton className="h-[15px] w-[220px] max-w-[60%] rounded" />
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 px-3 py-6 text-center text-[12px] text-osu-f1">
          {query ? "Nobody matches." : filter === "blocked" ? "Nobody is blocked." : "Nobody has used Companella yet."}
        </div>
      ) : (
        <>
          <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden divide-y divide-osu-b3/20">
            {entries.map((entry) => (
              <AccountRow
                key={entry.userId}
                entry={entry}
                open={openId === entry.userId}
                busy={busyId === entry.userId}
                plays={plays[entry.userId]}
                playsPage={playsPage[entry.userId] ?? 0}
                onToggle={() => toggle(entry)}
                onBlock={() => entry.blockedAt != null ? void setBlocked(entry, false) : setBlockAsk(entry)}
                onHold={(play, held) => void hold(entry, play, held)}
                onPlaysPage={(page) => changePlaysPage(entry, page)}
                onRetry={() => void loadPlays(entry.userId, playsPage[entry.userId] ?? 0)}
              />
            ))}
          </div>

          <Pagination page={Math.floor(offset / PAGE_SIZE)} totalPages={Math.ceil(total / PAGE_SIZE)} onPageChange={changePage} />
        </>
      )}

      {blockAsk ? (
        <ConfirmModal
          title={`Block ${blockAsk.username} from Companella?`}
          body="Disconnects Companella on every computer they connected, and they can't connect it again or send plays until you unblock them. Existing plays keep their current status. Exclude individual plays separately."
          confirmLabel="Block"
          danger
          onConfirm={() => void setBlocked(blockAsk, true)}
          onClose={() => setBlockAsk(null)}
        />
      ) : null}
    </div>
  );
}

function Notice({ text, tone, onDismiss }: { text: string; tone?: "error"; onDismiss: () => void }) {
  return (
    <div className={`flex items-start gap-2 text-[12px] ${tone === "error" ? "text-osu-red-light" : "text-osu-l2"}`}>
      <p className="min-w-0 flex-1 pt-0.5">{text}</p>
      <button onClick={onDismiss} aria-label="Dismiss" className="grid h-6 w-6 flex-shrink-0 cursor-pointer place-items-center rounded text-osu-f1 hover:bg-osu-b4/60 hover:text-white">
        <X size={13} />
      </button>
    </div>
  );
}
