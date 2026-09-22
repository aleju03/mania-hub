import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { Skeleton } from "../../components/ui/LoadingSkeleton";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { listRateFlags, setRateFlagHeld, type RateFlag, type RateFlagFilter } from "../../lib/companella-rate-flags";

/* Companella imports whose replay frames did not confirm the speed their mods
 * claim. They count like any other play and the player is never told; this
 * list is the only place the flag shows. "Frames read slower" is the cheat's
 * signature (a NoMod replay relabelled DT reads 1.00x); "Unreadable" is mostly
 * honest DT on dense charts with too few idle frames to measure. Holding a
 * play takes it out of the owner's preview through the ordinary review route.
 */

export const Route = createFileRoute("/admin/companella-flags")({
  head: () => ({
    meta: [
      { title: "Companella flags - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: CompanellaFlagsAdminPage,
});

const PAGE_SIZE = 50;

const FILTERS: { value: RateFlagFilter; label: string }[] = [
  { value: "mismatch", label: "Frames read slower" },
  { value: "unreadable", label: "Unreadable" },
  { value: "all", label: "All" },
];

const MISMATCH = new Set(["claimed_rate_too_high", "inconclusive_low"]);

const ACTION_CLASS =
  "px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[11px] text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 cursor-pointer";

function chipClass(active: boolean): string {
  return `px-2.5 py-1 rounded-md border text-[12px] transition-colors duration-[120ms] cursor-pointer ${
    active
      ? "border-osu-pink/50 bg-osu-pink/15 text-osu-pink-light"
      : "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
  }`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatRate(rate: number): string {
  return `${rate.toFixed(2)}x`;
}

function readingText(check: RateFlag["rateCheck"]): string {
  switch (check.verdict) {
    case "too_few_windows":
      return "Too few idle frames to read the speed";
    case "frame_locked":
      return "Game ran at 60 fps or below, so the frames can't tell the speed";
    case "not_stable":
      return "osu!lazer replay, which the check can't read";
    default:
      return check.measuredRate == null
        ? check.verdict
        : `Frames read ${formatRate(check.measuredRate)}, mods claim ${formatRate(check.claimedRate)}`;
  }
}

function chartText(chart: RateFlag["chart"]): string {
  const name = [chart.artist, chart.title].filter(Boolean).join(" - ") || "Unknown chart";
  return chart.version ? `${name} [${chart.version}]` : name;
}

function RateFlagRow({ entry, busy, onHold }: { entry: RateFlag; busy: boolean; onHold: (held: boolean) => void }) {
  const mismatch = MISMATCH.has(entry.rateCheck.verdict);
  const held = entry.reviewState !== "clear";
  return (
    <div className="px-3 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/player/$username"
            params={{ username: String(entry.userId) }}
            className="truncate text-[14px] font-semibold text-white hover:text-osu-pink-light"
          >
            {entry.username || `#${entry.userId}`}
          </Link>
          <span className="rounded bg-osu-b4/80 px-1.5 py-0.5 text-[11px] font-semibold text-osu-l2">
            {entry.mods.length ? entry.mods.join("") : "NM"}
          </span>
          {entry.chart.keyCount ? <span className="text-[11px] text-osu-f1">{entry.chart.keyCount}K</span> : null}
          {held ? <span className="text-[11px] text-amber-300">Held</span> : null}
        </div>
        <div className="truncate text-[12px] text-osu-l2">{chartText(entry.chart)}</div>
        <div className={`text-[12px] ${mismatch ? "text-osu-red-light" : "text-osu-f1"}`}>{readingText(entry.rateCheck)}</div>
        <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-osu-f1">
          <span>{formatWhen(entry.playedAt ?? entry.receivedAt)}</span>
          <span className="font-mono">{entry.scoreId}</span>
        </div>
      </div>
      <button disabled={busy} onClick={() => onHold(!held)} className={ACTION_CLASS}>
        {held ? "Count it" : "Hold"}
      </button>
    </div>
  );
}

function CompanellaFlagsAdminPage() {
  const [filter, setFilter] = useState<RateFlagFilter>("mismatch");
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<RateFlag[] | null>(null);
  const [total, setTotal] = useState(0);
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
      setError(null);
    } catch {
      if (request !== requestRef.current) return;
      setEntries([]);
      setError("Could not load flags.");
    }
  }, [filter, offset]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setOffset(0); }, [filter]);

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

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1000px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
          <div className="relative flex-shrink-0">
            <span className="block w-2.5 h-2.5 rounded-full bg-amber-300" />
            {entries === null || busyId ? (
              <span className="absolute inset-0 rounded-full bg-amber-300 animate-ping opacity-75" />
            ) : null}
          </div>
          <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Companella flags</h2>
          <div className="ml-auto flex items-center gap-3 text-[11px] text-osu-f1">
            <span>{total} flagged</span>
            <button onClick={() => void load()} className={ACTION_CLASS}>Refresh</button>
          </div>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1000px] mx-auto px-4 sm:px-5 py-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((option) => (
              <button key={option.value} onClick={() => setFilter(option.value)} className={chipClass(filter === option.value)}>
                {option.label}
              </button>
            ))}
          </div>

          {error ? <p className="text-[12px] text-osu-red-light">{error}</p> : null}

          {entries === null ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 divide-y divide-osu-b3/20">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="px-3 py-3 space-y-2">
                  <Skeleton className="h-[15px] w-[180px] rounded" />
                  <Skeleton className="h-[13px] w-[320px] rounded" />
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

              {total > PAGE_SIZE ? (
                <div className="flex items-center gap-3 text-[11px] text-osu-f1">
                  <span>{from}-{to} of {total}</span>
                  <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className={ACTION_CLASS}>
                    Previous
                  </button>
                  <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)} className={ACTION_CLASS}>
                    Next
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
