import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, RefreshCw, RotateCcw, X } from "lucide-react";

import { danScaleContextFor, danScaleLabel, getDanTierImageSrc } from "../../lib/dan-images";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { stripKeymodePrefix } from "../maps/SearchCard";
import {
  listChartLabelGroups,
  setChartLabelGroupStatus,
  type ChartLabelCount,
  type ChartLabelGroup,
  type ChartLabelStatus,
} from "../../lib/chart-label-reports";

/* The Labels tab of /admin/bug-reports: what players say charts are filed
   wrong as, one row per chart and rate, most reporters first. Filed-as is the
   verdict the reporters saw; when a later analysis moved it, the row says what
   it is now. A chart the models now file the way most reporters said leaves
   the open list on its own. Nothing here changes a verdict: the reports are a
   dataset (npm run label-reports:export), and acting on one means changing a
   model, never the chart. */

const STATUSES: Array<{ value: ChartLabelStatus; label: string }> = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

const REASON_LABELS: Record<string, string> = {
  vibro: "Vibro / mash",
  gimmick: "Gimmick",
  joke: "Joke or broken",
  rate_only: "Only at this rate",
};

function tileName(tile: string): string {
  if (tile === "chordstream") return "Chordstream";
  const label = DAN_SKILLSET_META[tile]?.label ?? tile;
  return tile !== "ln" && tile.startsWith("ln") ? `LN ${label}` : label;
}

/** "dan:12--" -> "Dan Azimuth--" on 7K. */
function levelName(value: string, keyCount: number | null): string {
  const match = /^(dan|ln):(\d+)([+-]*)$/.exec(value);
  if (!match) return value;
  const name = danScaleLabel(Number(match[2]), danScaleContextFor(keyCount, match[1] === "ln" ? "ln" : null));
  return `${match[1] === "ln" ? "LN" : "Dan"} ${name}${match[3]}`;
}

function verdictName(verdict: { label: string | null; family: string | null; tiles: string[] }): string {
  if (!verdict.label) return "No verdict";
  const tile = verdict.tiles[0];
  return `${verdict.family === "ln" ? "LN " : ""}${verdict.label}${tile && tile !== "ln" ? ` ${tileName(tile)}` : ""}`;
}

function Pills({ counts, name, strong }: { counts: ChartLabelCount[]; name: (value: string) => string; strong?: (value: string) => boolean }) {
  if (counts.length === 0) return <span className="text-osu-f1/40">-</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {counts.map((entry, index) => (
        <span
          key={entry.value}
          className={`rounded px-1.5 py-0.5 text-[11px] ${
            index === 0 || strong?.(entry.value) ? "bg-osu-pink/15 font-semibold text-osu-pink-light" : "bg-white/[0.05] text-osu-l2"
          }`}
        >
          {name(entry.value)} <span className="opacity-60">{entry.count}</span>
        </span>
      ))}
    </span>
  );
}

function rateName(rate: number): string {
  return rate === 1 ? "" : ` at ${rate}x`;
}

function GroupRow({ group, onStatus, busy }: { group: ChartLabelGroup; onStatus: (status: ChartLabelStatus) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const moved = group.current != null && (group.current.label !== group.seen.label || group.current.family !== group.seen.family || group.current.tiles[0] !== group.seen.tiles[0]);
  const image = group.seen.label && group.keyCount
    ? getDanTierImageSrc(group.seen.label, group.seen.family === "ln" ? "ln" : undefined, group.keyCount)
    : null;
  return (
    <div className="border-t border-white/5 first:border-t-0">
      <div className="grid grid-cols-[2rem_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_5.5rem_auto] items-center gap-3 px-3 py-2.5 text-[12px] max-lg:grid-cols-[2rem_minmax(0,1fr)_auto]">
        <span className="grid h-8 w-8 place-items-center">
          {image ? <img src={image} alt="" className="h-8 w-auto max-w-none object-contain" /> : null}
        </span>
        <button type="button" onClick={() => setOpen((value) => !value)} className="min-w-0 cursor-pointer text-left">
          <span className="flex items-center gap-1 truncate text-osu-l1">
            {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            <span className="truncate">{group.title ?? `Beatmap ${group.beatmapId}`} [{group.version ? stripKeymodePrefix(group.version) : "?"}]</span>
          </span>
          <span className="block truncate text-[10.5px] text-osu-f1/70">
            {group.keyCount ?? "?"}K{rateName(group.rate)}
            {group.seen.analysisVersion != null ? ` | analysis v${group.seen.analysisVersion}` : ""}
            {moved && group.current ? ` | now ${verdictName(group.current)}` : ""}
          </span>
        </button>
        <span className={`max-lg:hidden ${moved ? "text-osu-f1/60 line-through" : "text-osu-l1"}`}>
          {verdictName(group.seen)}
          {group.seen.vibro ? <span className="ml-1 text-[10px] text-[#ffcf70]">vibro</span> : null}
        </span>
        <span className="max-lg:hidden"><Pills counts={group.tiles} name={tileName} /></span>
        <span className="flex flex-wrap gap-1 max-lg:hidden">
          <Pills counts={group.levels} name={(value) => levelName(value, group.keyCount)} />
          {group.rateable.length > 0 && (
            <Pills
              counts={group.rateable}
              name={(value) => value === "no" ? (group.seen.vibro ? "Keep unrated" : "Shouldn't count") : (group.seen.vibro ? "Should be rated" : "Should count")}
              strong={(value) => value === "no"}
            />
          )}
        </span>
        <span className="text-osu-l1 max-lg:hidden">
          {group.reporters} <span className="text-[10.5px] text-osu-f1/70">({group.played} played)</span>
        </span>
        <span className="flex items-center gap-1">
          {group.status === "open" ? (
            <>
              <button type="button" disabled={busy} onClick={() => onStatus("resolved")} title="Resolve" aria-label="Resolve" className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-osu-f1 hover:bg-white/[0.06] hover:text-emerald-300">
                <Check className="h-3.5 w-3.5" />
              </button>
              <button type="button" disabled={busy} onClick={() => onStatus("dismissed")} title="Dismiss" aria-label="Dismiss" className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-osu-f1 hover:bg-white/[0.06] hover:text-red-300">
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => onStatus("open")} title="Reopen" aria-label="Reopen" className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-osu-f1 hover:bg-white/[0.06] hover:text-osu-l1">
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="space-y-1.5 bg-black/15 px-3 py-2.5 pl-14 text-[11.5px]">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-osu-f1/80 lg:hidden">
            <span>Filed as {verdictName(group.seen)}</span>
            <span>{group.reporters} reporters ({group.played} played)</span>
          </div>
          {group.reasons.length > 0 && (
            <div className="flex items-center gap-2 text-osu-f1/80">
              Reasons <Pills counts={group.reasons} name={(value) => REASON_LABELS[value] ?? value} />
            </div>
          )}
          {group.reports.map((report) => (
            <div key={report.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-osu-l2">
              <a href={`/profile/${report.userId}`} className="font-semibold text-osu-l1 hover:underline">{report.username ?? report.userId}</a>
              <span className="text-osu-f1/70">
                {report.reporterOverall != null ? `${report.reporterOverall.toFixed(2)} overall` : "no rating"}
                {report.played ? " | played it" : ""}
              </span>
              {report.suggestedTile && <span>{tileName(report.suggestedTile)}</span>}
              {report.suggestedLevel != null && <span>{levelName(`${report.suggestedFamily}:${report.suggestedLevel}${report.suggestedTier ?? ""}`, group.keyCount)}</span>}
              {report.rateable && <span>{report.rateable === "no" ? "No" : "Yes"} to ratings{report.rateableReasons.length ? ` (${report.rateableReasons.map((reason) => REASON_LABELS[reason] ?? reason).join(", ")})` : ""}</span>}
              {report.note && <span className="italic text-osu-f1">"{report.note}"</span>}
            </div>
          ))}
          <a
            href={`https://osu.ppy.sh/beatmaps/${group.beatmapId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-[11px] text-osu-pink-light hover:underline"
          >
            Open on osu!
          </a>
        </div>
      )}
    </div>
  );
}

export function ChartLabelsBoard({ viewSwitch }: { viewSwitch: ReactNode }) {
  const [status, setStatus] = useState<ChartLabelStatus>("open");
  const [groups, setGroups] = useState<ChartLabelGroup[] | null>(null);
  const [counts, setCounts] = useState<Record<ChartLabelStatus, number>>({ open: 0, resolved: 0, dismissed: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setGroups(null);
    setError(null);
    try {
      const page = await listChartLabelGroups({ data: { status, limit: 200 } });
      setGroups(page.groups);
      setCounts(page.counts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the label reports.");
      setGroups([]);
    }
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (group: ChartLabelGroup, next: ChartLabelStatus) => {
    const key = `${group.beatmapId}:${group.rate}`;
    setBusy(key);
    const result = await setChartLabelGroupStatus({ data: { beatmapId: group.beatmapId, rate: group.rate, status: next } }).catch(() => ({ ok: false }));
    setBusy(null);
    if (!result.ok) {
      setError("Could not update that chart.");
      return;
    }
    setGroups((list) => list?.filter((entry) => `${entry.beatmapId}:${entry.rate}` !== key) ?? list);
    setCounts((previous) => ({ ...previous, [group.status]: Math.max(0, previous[group.status] - 1), [next]: previous[next] + 1 }));
  };

  return (
    <div className="flex-1 bg-osu-b5 min-h-[calc(100vh-60px)]">
      <div className="mx-auto max-w-[1100px] space-y-4 px-4 py-6 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="h-4 w-1 rounded-full bg-osu-pink" />
              <h1 className="text-sm font-bold uppercase tracking-[0.14em] text-osu-l1">Chart labels</h1>
            </div>
            <p className="mt-1 text-[11px] text-osu-f1">
              {counts.open} {counts.open === 1 ? "chart" : "charts"} open | what players say a chart is filed wrong as. A dataset, never a switch.
            </p>
            {viewSwitch}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-osu-b3/50 bg-osu-b6/70 p-0.5">
              {STATUSES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setStatus(option.value)}
                  className={`h-[24px] cursor-pointer rounded px-2 text-[11px] font-semibold transition-colors duration-[120ms] ${
                    status === option.value ? "bg-osu-b4 text-white" : "text-osu-f1 hover:text-osu-l1"
                  }`}
                >
                  {option.label} {counts[option.value]}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void load()}
              aria-label="Refresh"
              title="Refresh"
              className="inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border border-osu-b3/50 bg-osu-b4/60 text-osu-f1 transition-colors duration-[120ms] hover:text-white"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${groups === null ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {error && <p className="rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</p>}

        <div className="overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b4/40">
          <div className="grid grid-cols-[2rem_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_5.5rem_auto] gap-3 border-b border-white/5 px-3 py-2 text-[10.5px] text-osu-f1/70 max-lg:hidden">
            <span />
            <span>Chart</span>
            <span>Filed as</span>
            <span>Players say (skillset)</span>
            <span>Players say (level / counts)</span>
            <span>Reporters</span>
            <span className="w-[60px]" />
          </div>
          {groups === null ? (
            <p className="px-3 py-6 text-center text-[12px] text-osu-f1">Loading...</p>
          ) : groups.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-osu-f1">Nothing here.</p>
          ) : (
            groups.map((group) => (
              <GroupRow
                key={`${group.beatmapId}:${group.rate}`}
                group={group}
                busy={busy === `${group.beatmapId}:${group.rate}`}
                onStatus={(next) => void act(group, next)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
