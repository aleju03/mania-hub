import { Link } from "@tanstack/react-router";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Skeleton } from "../../ui/LoadingSkeleton";
import { ModBadge } from "../../ui/ModBadge";
import { Pagination } from "../../ui/Pagination";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { listRateFlags, setRateFlagHeld, type RateFlag, type RateFlagFilter } from "../../../lib/companella-rate-flags";
import { formatNumber, formatTimeAgo } from "../../../lib/format";

const PAGE_SIZE = 50;

const FILTERS: { value: RateFlagFilter; label: string; hint: string }[] = [
  {
    value: "mismatch",
    label: "Read slower",
    hint: "The frames ran slower than the mods claim, which is what a NoMod replay relabelled DT looks like.",
  },
  {
    value: "unreadable",
    label: "Unreadable",
    hint: "The frames could not confirm the speed. Mostly honest DT on dense charts.",
  },
  {
    value: "all",
    label: "All",
    hint: "Every import whose frames did not confirm the speed its mods claim. Flagged plays still count until excluded.",
  },
];

const MISMATCH = new Set(["claimed_rate_too_high", "inconclusive_low"]);

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] sm:py-1 sm:text-[11px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";

const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;

const HOLD_CLASS = `${BUTTON_CLASS} border-amber-300/40 bg-amber-300/10 text-amber-200 hover:bg-amber-300/20`;

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatRate(rate: number): string {
  return `${rate.toFixed(2)}x`;
}

/* The verdict in words, under the rate column's numbers. */
function readingText(check: RateFlag["rateCheck"]): string {
  switch (check.verdict) {
    case "too_few_windows":
      return "Too few idle frames to read the speed";
    case "frame_locked":
      return "Game ran at 60 fps or below, so the frames can't tell the speed";
    case "not_stable":
      return "osu!lazer replay, which the check can't read";
    case "no_input":
      return "No key presses to read";
    case "claimed_rate_too_high":
      return "Frames read slower than the mods claim";
    case "inconclusive_low":
      return "Frames read somewhat slower than the mods claim";
    case "claimed_rate_too_low":
      return "Frames read faster than the mods claim";
    case "inconclusive_high":
      return "Frames read somewhat faster than the mods claim";
    default:
      return "Frames don't match the mods";
  }
}

function RateColumn({ check, mismatch }: { check: RateFlag["rateCheck"]; mismatch: boolean }) {
  return (
    <div className="w-[64px] flex-shrink-0 sm:w-[76px]">
      <div
        className={`text-[17px] font-bold leading-tight tabular-nums ${
          check.measuredRate == null ? "text-osu-f1" : mismatch ? "text-osu-red-light" : "text-white"
        }`}
        title="What the replay frames read"
      >
        {check.measuredRate == null ? "?" : formatRate(check.measuredRate)}
      </div>
      <div className="text-[11px] tabular-nums text-osu-f1" title="What the mods claim">
        claims {formatRate(check.claimedRate)}
      </div>
    </div>
  );
}

function RateFlagRow({ entry, busy, onHold }: { entry: RateFlag; busy: boolean; onHold: (held: boolean) => void }) {
  const mismatch = MISMATCH.has(entry.rateCheck.verdict);
  const held = entry.reviewState !== "clear";
  const when = entry.playedAt ?? entry.receivedAt;
  const chartName = [entry.chart.artist, entry.chart.title].filter(Boolean).join(" - ") || "Unknown chart";
  return (
    <div className={`flex items-start gap-3 px-3 py-3 sm:items-center ${held ? "bg-amber-300/[0.04]" : ""}`}>
      <RateColumn check={entry.rateCheck} mismatch={mismatch} />

      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to="/admin/companella"
            search={(previous) => ({ ...previous, tab: undefined, user: entry.userId, q: `#${entry.userId}`, filter: undefined, page: undefined })}
            className="min-w-0 truncate text-[14px] font-semibold text-white hover:text-osu-pink-light"
          >
            {entry.username || `#${entry.userId}`}
          </Link>
          {entry.mods.length ? (
            <span className="flex items-center gap-0.5">
              {entry.mods.map((mod) => <ModBadge key={mod} mod={mod} size={0.7} />)}
            </span>
          ) : (
            <span className="text-[11px] text-osu-f1">NM</span>
          )}
          {entry.chart.keyCount ? (
            <span className="rounded bg-osu-b4/80 px-1.5 py-0.5 text-[11px] font-semibold text-osu-yellow">{entry.chart.keyCount}K</span>
          ) : null}
          {held ? <span className="rounded bg-amber-300/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-200">Excluded</span> : null}
        </div>
        <div className="truncate text-[12px] text-osu-l2" title={entry.chart.version ? `${chartName} [${entry.chart.version}]` : chartName}>
          {chartName}
          {entry.chart.version ? <span className="text-osu-f1"> [{entry.chart.version}]</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-osu-f1">
          <span className={mismatch ? "text-osu-red-light" : undefined}>{readingText(entry.rateCheck)}</span>
          {when ? <span title={formatWhen(when)}>{formatTimeAgo(when)}</span> : null}
          <span className="hidden font-mono sm:inline">{entry.scoreId}</span>
        </div>
      </div>

      <button disabled={busy} onClick={() => onHold(!held)} className={`${held ? ACTION_CLASS : HOLD_CLASS} flex-shrink-0 sm:min-w-[92px]`}>
        {held ? "Restore" : "Exclude"}
      </button>
    </div>
  );
}

export function CompanellaFlagsPanel({ filter, page, onFilterChange, onPageChange }: {
  filter: RateFlagFilter;
  page: number;
  onFilterChange: (filter: RateFlagFilter) => void;
  onPageChange: (page: number) => void;
}) {
  const offset = page * PAGE_SIZE;
  const [entries, setEntries] = useState<RateFlag[] | null>(null);
  const [total, setTotal] = useState(0);
  // Each tab's last known count, so a tab switch never shows one list's count on another's tab.
  const [totals, setTotals] = useState<Partial<Record<RateFlagFilter, number>>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const page = await listRateFlags({ data: { filter, limit: PAGE_SIZE, offset } });
      if (request !== requestRef.current) return;
      setEntries(page.entries);
      setTotal(page.total);
      setTotals((current) => ({ ...current, [filter]: page.total }));
      setError(null);
    } catch {
      if (request !== requestRef.current) return;
      setEntries([]);
      setError("Could not load flags.");
    }
  }, [filter, offset]);

  useEffect(() => { void load(); }, [load]);

  const hold = useCallback(async (entry: RateFlag, held: boolean) => {
    setBusyId(entry.scoreId);
    try {
      await setRateFlagHeld({ data: { scoreId: entry.scoreId, held } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through.");
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const changeFilter = (next: RateFlagFilter) => {
    onFilterChange(next);
  };

  const changePage = (page: number) => {
    onPageChange(page);
    window.scrollTo({ top: 0 });
  };

  const filterOptions = FILTERS.map((option) => {
    const count = totals[option.value];
    return {
      value: option.value,
      label: <>{option.label}{count ? <span className="ml-1 tabular-nums opacity-70">{formatNumber(count)}</span> : null}</>,
    };
  });

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl id="companella-flags-filter" value={filter} options={filterOptions} onChange={changeFilter} />
          <button onClick={() => void load()} disabled={busyId != null} className={ACTION_CLASS} aria-label="Refresh">
            <RefreshCw size={13} />
            <span>Refresh</span>
          </button>
        </div>
        <p className="text-[12px] text-osu-f1">{FILTERS.find((option) => option.value === filter)?.hint}</p>
      </div>

      {error ? (
        <div className="flex items-start gap-2 text-[12px] text-osu-red-light">
          <p className="min-w-0 flex-1 pt-0.5">{error}</p>
          <button onClick={() => setError(null)} aria-label="Dismiss" className="grid h-6 w-6 flex-shrink-0 cursor-pointer place-items-center rounded text-osu-f1 hover:bg-osu-b4/60 hover:text-white">
            <X size={13} />
          </button>
        </div>
      ) : null}

      {entries === null ? (
        <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 divide-y divide-osu-b3/20">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="px-3 py-3 flex items-center gap-3">
              <Skeleton className="h-[34px] w-[64px] rounded" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-[15px] w-[180px] max-w-[70%] rounded" />
                <Skeleton className="h-[13px] w-[320px] max-w-[90%] rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 px-3 py-6 text-center text-[12px] text-osu-f1">
          Nothing flagged.
        </div>
      ) : (
        <>
          <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden divide-y divide-osu-b3/20">
            {entries.map((entry) => (
              <RateFlagRow
                key={entry.scoreId}
                entry={entry}
                busy={busyId === entry.scoreId}
                onHold={(held) => void hold(entry, held)}
              />
            ))}
          </div>

          <Pagination page={Math.floor(offset / PAGE_SIZE)} totalPages={Math.ceil(total / PAGE_SIZE)} onPageChange={changePage} />
        </>
      )}
    </div>
  );
}
