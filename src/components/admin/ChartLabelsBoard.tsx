import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Inbox, MessageSquare, RefreshCw, RotateCcw, X, type LucideIcon } from "lucide-react";

import { Avatar } from "../ui/Avatar";
import { Skeleton } from "../ui/LoadingSkeleton";

import { danScaleContextFor, danScaleLabel, getDanTierImageSrc } from "../../lib/dan-images";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { stripKeymodePrefix } from "../maps/SearchCard";
import {
  listChartLabelGroups,
  setChartLabelGroupStatus,
  type ChartLabelCount,
  type ChartLabelGroup,
  type ChartLabelGroupReport,
  type ChartLabelKind,
  type ChartLabelPage,
  type ChartLabelStatus,
} from "../../lib/chart-label-reports";

/* The Labels tab of /admin/bug-reports: what players say charts are filed
   wrong as, one row per chart and rate, most reporters first. Filed-as is the
   verdict the reporters saw; when a later analysis moved it, the row says what
   it is now. A chart the models now file the way most reporters said leaves
   the open list on its own. Nothing here changes a verdict: the reports are a
   dataset (npm run label-reports:export), and acting on one means changing a
   model, never the chart. */

const STATUSES: Array<{ value: ChartLabelStatus; label: string; Icon: LucideIcon; text: string; hint: string }> = [
  { value: "open", label: "Open", Icon: Inbox, text: "text-osu-pink-light", hint: "Charts the models still file differently from what players said" },
  {
    value: "resolved",
    label: "Fixed",
    Icon: Check,
    text: "text-emerald-300",
    hint: "Charts a later analysis now files the way most reporters said (these move here on their own), or that you marked fixed",
  },
  { value: "dismissed", label: "Dismissed", Icon: X, text: "text-osu-f1", hint: "Charts where you decided the reporters were wrong" },
];

const REASON_LABELS: Record<string, string> = {
  vibro: "Vibro / mash",
  gimmick: "Gimmick",
  joke: "Joke or broken",
  rate_only: "Only at this rate",
};

const KINDS: Array<{ value: ChartLabelKind; label: string }> = [
  { value: "skillset", label: "Skillset" },
  { value: "level", label: "Dan level" },
  { value: "rateable", label: "Should count" },
];

const PAGE_SIZE = 100;

function FilterChip({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] font-semibold transition-colors duration-[120ms] ${
        active ? "bg-white/[0.1] text-white" : "text-osu-f1 hover:bg-white/[0.05] hover:text-osu-l1"
      }`}
    >
      {label}
      {count != null ? <span className="tabular-nums opacity-60">{count}</span> : null}
    </button>
  );
}

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

function Sep() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-white/15" />;
}

function Pill({ children, strong }: { children: ReactNode; strong?: boolean }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] ${strong ? "bg-osu-pink/15 font-semibold text-osu-pink-light" : "bg-white/[0.06] text-osu-l2"}`}>
      {children}
    </span>
  );
}

function Pills({ counts, name, strong }: { counts: ChartLabelCount[]; name: (value: string) => string; strong?: (value: string) => boolean }) {
  return (
    <>
      {counts.map((entry, index) => (
        <Pill key={entry.value} strong={index === 0 || strong?.(entry.value)}>
          {name(entry.value)} <span className="opacity-60">{entry.count}</span>
        </Pill>
      ))}
    </>
  );
}

function rateName(rate: number): string {
  return rate === 1 ? "" : ` at ${rate}x`;
}

function rateableName(value: string, vibro: boolean): string {
  if (value === "no") return vibro ? "Keep unrated" : "Shouldn't count";
  return vibro ? "Should be rated" : "Should count";
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ReportLine({ report, group }: { report: ChartLabelGroupReport; group: ChartLabelGroup }) {
  const says: string[] = [];
  if (report.suggestedTile) says.push(tileName(report.suggestedTile));
  if (report.suggestedLevel != null) says.push(levelName(`${report.suggestedFamily}:${report.suggestedLevel}${report.suggestedTier ?? ""}`, group.keyCount));
  if (report.rateable) {
    const reasons = report.rateableReasons.map((reason) => REASON_LABELS[reason] ?? reason).join(", ");
    says.push(`${rateableName(report.rateable, group.seen.vibro)}${reasons ? ` (${reasons})` : ""}`);
  }
  const nameClass = "text-[12.5px] font-semibold text-white transition-colors duration-[120ms] hover:text-osu-pink-light";
  return (
    <div className="flex gap-2.5 px-3.5 py-2.5">
      <Avatar userId={report.userId} size={22} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {report.username ? (
            <a href={`/player/${encodeURIComponent(report.username)}`} target="_blank" rel="noreferrer" className={nameClass}>{report.username}</a>
          ) : (
            <a href={`https://osu.ppy.sh/users/${report.userId}`} target="_blank" rel="noreferrer" className={nameClass}>{report.userId}</a>
          )}
          <span className="text-[11px] text-osu-f1">{report.reporterOverall != null ? `${report.reporterOverall.toFixed(2)} overall` : "no rating"}</span>
          <Sep />
          <span className="text-[11px] text-osu-f1">{report.played ? "played it" : "hasn't played it"}</span>
          <Sep />
          <span className="text-[11px] text-osu-f1">{formatDay(report.createdAt)}</span>
        </div>
        {says.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[11px] text-osu-f1">says</span>
            {says.map((value) => <Pill key={value}>{value}</Pill>)}
          </div>
        )}
        {report.note && <p className="whitespace-pre-wrap break-words text-[13px] leading-snug text-osu-l1">{report.note}</p>}
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, hint, tone, disabled, onClick }: {
  icon: LucideIcon;
  label: string;
  hint: string;
  tone: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={hint}
      className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-white/[0.05] px-2.5 text-[11.5px] font-semibold text-osu-l1 transition-colors duration-[120ms] hover:bg-white/[0.09] disabled:cursor-default disabled:opacity-50 ${tone}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function GroupCard({ group, onStatus, busy }: { group: ChartLabelGroup; onStatus: (status: ChartLabelStatus) => void; busy: boolean }) {
  const moved = group.current != null && (group.current.label !== group.seen.label || group.current.family !== group.seen.family || group.current.tiles[0] !== group.seen.tiles[0]);
  const image = group.seen.label && group.keyCount
    ? getDanTierImageSrc(group.seen.label, group.seen.family === "ln" ? "ln" : undefined, group.keyCount)
    : null;
  const closedText = group.status === "open" ? null
    : group.closedBy === "auto" ? `Moved here on its own${group.closedAt ? ` ${formatDay(group.closedAt)}` : ""}: a later analysis files it the way most reporters said`
    : group.closedBy == null ? null
    : `${group.status === "dismissed" ? "Dismissed" : "Marked fixed"} by you${group.closedAt ? ` ${formatDay(group.closedAt)}` : ""}`;
  return (
    <article className={`overflow-hidden rounded-xl bg-osu-b4/60 ${group.status === "open" ? "" : "opacity-80 hover:opacity-100"}`}>
      <div className="flex flex-wrap items-start gap-3 px-3.5 py-3">
        <span className="flex h-10 w-14 shrink-0 items-center justify-center">
          {image ? <img src={image} alt="" className="h-9 w-auto max-w-full object-contain" /> : null}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <Link
            to="/maps"
            search={{ map: group.beatmapId } as never}
            className="flex min-w-0 items-center text-[14px] font-bold text-white transition-colors duration-[120ms] hover:text-osu-pink-light"
          >
            <span className="truncate">{group.title ?? `Beatmap ${group.beatmapId}`} [{group.version ? stripKeymodePrefix(group.version) : "?"}]</span>
          </Link>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-osu-f1">
            <span>{group.keyCount ?? "?"}K{rateName(group.rate)}</span>
            <Sep />
            <span>
              Filed as <span className={moved ? "text-osu-f1 line-through" : "font-semibold text-osu-l1"}>{verdictName(group.seen)}</span>
              {group.seen.vibro ? <span className="ml-1 text-[#ffcf70]">vibro</span> : null}
            </span>
            {moved && group.current ? (
              <>
                <Sep />
                <span>now <span className="font-semibold text-osu-l1">{verdictName(group.current)}</span></span>
              </>
            ) : null}
          </div>
          {group.reporters > 1 && (
            <div className="flex flex-wrap items-center gap-1 pt-0.5">
              <span className="mr-1 text-[11px] text-osu-f1">{group.reporters} players say</span>
              <Pills counts={group.tiles} name={tileName} />
              <Pills counts={group.levels} name={(value) => levelName(value, group.keyCount)} />
              <Pills counts={group.rateable} name={(value) => rateableName(value, group.seen.vibro)} strong={(value) => value === "no"} />
            </div>
          )}
          {closedText && <p className="text-[11.5px] text-osu-f1">{closedText}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {group.status === "open" ? (
            <>
              <ActionButton
                icon={Check}
                label="Fixed"
                tone="hover:text-emerald-300"
                hint="Moves it to Fixed. Use it once you've changed a model for this; the chart itself doesn't change. A new report opens it again."
                disabled={busy}
                onClick={() => onStatus("resolved")}
              />
              <ActionButton
                icon={X}
                label="Dismiss"
                tone="hover:text-red-300"
                hint="Moves it to Dismissed: the reporters are wrong. The chart doesn't change. A new report opens it again."
                disabled={busy}
                onClick={() => onStatus("dismissed")}
              />
            </>
          ) : (
            <ActionButton icon={RotateCcw} label="Reopen" tone="" hint="Moves it back to Open" disabled={busy} onClick={() => onStatus("open")} />
          )}
        </div>
      </div>
      <div className="divide-y divide-white/[0.05] bg-osu-b6/45">
        {group.reports.map((report) => <ReportLine key={report.id} report={report} group={group} />)}
      </div>
    </article>
  );
}

export function ChartLabelsBoard({ viewSwitch }: { viewSwitch: ReactNode }) {
  const [status, setStatus] = useState<ChartLabelStatus>("open");
  const [groups, setGroups] = useState<ChartLabelGroup[] | null>(null);
  const [counts, setCounts] = useState<Record<ChartLabelStatus, number>>({ open: 0, resolved: 0, dismissed: 0 });
  const [facets, setFacets] = useState<ChartLabelPage["facets"] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [commentsOnly, setCommentsOnly] = useState(false);
  const [keys, setKeys] = useState<number | null>(null);
  const [kind, setKind] = useState<ChartLabelKind | null>(null);

  const query = useMemo(() => ({ status, keys, kind, withNote: commentsOnly }), [status, keys, kind, commentsOnly]);

  const load = useCallback(async () => {
    setGroups(null);
    setError(null);
    try {
      const page = await listChartLabelGroups({ data: { ...query, limit: PAGE_SIZE } });
      setGroups(page.groups);
      setCounts(page.counts);
      setFacets(page.facets);
      setTotal(page.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the label reports.");
      setGroups([]);
    }
  }, [query]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!groups) return;
    setLoadingMore(true);
    try {
      const page = await listChartLabelGroups({ data: { ...query, limit: PAGE_SIZE, offset: groups.length } });
      const seen = new Set(groups.map((group) => `${group.beatmapId}:${group.rate}`));
      setGroups([...groups, ...page.groups.filter((group) => !seen.has(`${group.beatmapId}:${group.rate}`))]);
      setTotal(page.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load more.");
    } finally {
      setLoadingMore(false);
    }
  };

  const shown = groups;

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
    setTotal((value) => Math.max(0, value - 1));
    setCounts((previous) => ({ ...previous, [group.status]: Math.max(0, previous[group.status] - 1), [next]: previous[next] + 1 }));
  };

  return (
    <div className="flex-1 bg-osu-b5 min-h-[calc(100vh-60px)]">
      <div className="mx-auto max-w-[1000px] space-y-4 px-4 py-6 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="h-4 w-1 rounded-full bg-osu-pink" />
              <h1 className="text-sm font-bold uppercase tracking-[0.14em] text-osu-l1">Chart labels</h1>
            </div>
            <p className="mt-1 text-[11px] text-osu-f1">
              What players say a chart is filed wrong as, from the map card. Nothing here changes a chart.
            </p>
            {viewSwitch}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCommentsOnly((value) => !value)}
              aria-pressed={commentsOnly}
              className={`inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-colors duration-[120ms] ${
                commentsOnly ? "border-osu-pink/45 bg-osu-pink/15 text-osu-pink-light" : "border-osu-b3/50 bg-osu-b6/70 text-osu-f1 hover:text-osu-l1"
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              With a comment {facets ? facets.withNote : ""}
            </button>
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

        <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-osu-b3/25 bg-osu-b5/40">
          {STATUSES.map((option) => {
            const active = status === option.value;
            return (
              <button
                key={option.value}
                type="button"
                title={option.hint}
                onClick={() => setStatus(option.value)}
                className={`relative cursor-pointer border-r border-osu-b3/20 px-3 py-2 text-left transition-colors duration-[120ms] last:border-r-0 ${
                  active ? "bg-osu-b4/45" : "hover:bg-osu-b4/25"
                }`}
              >
                {active ? <span className="absolute inset-x-0 top-0 h-[2px] bg-osu-pink" /> : null}
                <span className="flex items-center gap-1.5">
                  <option.Icon className={`h-3.5 w-3.5 shrink-0 ${option.text}`} />
                  <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-osu-f1">{option.label}</span>
                </span>
                <span className="mt-0.5 block text-[17px] font-bold tabular-nums text-white">{counts[option.value]}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-0.5">
            <FilterChip active={keys == null} label="All keys" onClick={() => setKeys(null)} />
            {facets?.keys.filter((entry) => entry.value !== "unknown").map((entry) => (
              <FilterChip
                key={entry.value}
                active={keys === Number(entry.value)}
                label={`${entry.value}K`}
                count={entry.count}
                onClick={() => setKeys(keys === Number(entry.value) ? null : Number(entry.value))}
              />
            ))}
          </div>
          <span aria-hidden className="hidden h-4 w-px bg-white/15 sm:block" />
          <div className="flex flex-wrap items-center gap-0.5">
            <FilterChip active={kind == null} label="Anything" onClick={() => setKind(null)} />
            {KINDS.map((option) => (
              <FilterChip
                key={option.value}
                active={kind === option.value}
                label={option.label}
                count={facets?.kinds.find((entry) => entry.value === option.value)?.count}
                onClick={() => setKind(kind === option.value ? null : option.value)}
              />
            ))}
          </div>
        </div>

        {error && <p className="text-[12px] text-osu-red-light">{error}</p>}

        {shown === null ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="space-y-2 rounded-xl border border-osu-b3/25 bg-osu-b5/40 p-3.5">
                <Skeleton className="h-[15px] w-[240px] rounded" />
                <Skeleton className="h-[13px] w-[420px] max-w-full rounded" />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-osu-b3/30 px-3 py-10 text-center text-[12px] text-osu-f1">
            {keys != null || kind != null || commentsOnly ? "Nothing matches these filters." : status === "open" ? "No open reports." : "Nothing here."}
          </div>
        ) : (
          <div className="space-y-4">
            {shown.map((group) => (
              <GroupCard
                key={`${group.beatmapId}:${group.rate}`}
                group={group}
                busy={busy === `${group.beatmapId}:${group.rate}`}
                onStatus={(next) => void act(group, next)}
              />
            ))}
            {shown.length < total ? (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="w-full cursor-pointer rounded-xl bg-osu-b4/60 py-2.5 text-[12px] font-semibold text-osu-l1 transition-colors duration-[120ms] hover:bg-osu-b4 disabled:cursor-default disabled:opacity-60"
              >
                {loadingMore ? "Loading..." : `Show more (${total - shown.length})`}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
