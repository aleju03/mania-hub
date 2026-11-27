import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, MessageSquare, RefreshCw, RotateCcw, X, type LucideIcon } from "lucide-react";

import { Avatar } from "../ui/Avatar";
import { Skeleton } from "../ui/LoadingSkeleton";

import { danScaleContextFor, danScaleLabel, getDanTierImageSrc } from "../../lib/dan-images";
import { DAN_SKILLSET_META } from "../../lib/skill-axes";
import { stripKeymodePrefix } from "../maps/SearchCard";
import {
  listChartLabelGroups,
  setChartLabelGroupStatus,
  type ChartLabelCount,
  type ChartLabelFiled,
  type ChartLabelGroup,
  type ChartLabelGroupReport,
  type ChartLabelKind,
  type ChartLabelPage,
  type ChartLabelSort,
  type ChartLabelStatus,
} from "../../lib/chart-label-reports";

/* The Labels tab of /admin/bug-reports: what players say charts are filed
   wrong as, one row per chart and rate, most reporters first. Filed-as is the
   verdict the reporters saw; when a later analysis moved it, the row says what
   it is now. A chart the models now file the way most reporters said leaves
   the open list on its own. Nothing here changes a verdict: the reports are a
   dataset (npm run label-reports:export), and acting on one means changing a
   model, never the chart. */

const STATUSES: Array<{ value: ChartLabelStatus; label: string; hint: string }> = [
  { value: "open", label: "Open", hint: "Charts the models still file differently from what players said" },
  {
    value: "resolved",
    label: "Fixed",
    hint: "Charts a later analysis now files the way most reporters said (these move here on their own), or that you marked fixed",
  },
  { value: "dismissed", label: "Dismissed", hint: "Charts where you decided the reporters were wrong" },
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

const FILED: Array<{ value: ChartLabelFiled; label: string }> = [
  { value: "rice", label: "Rice" },
  { value: "ln", label: "LN" },
  { value: "none", label: "No verdict" },
];

const PAGE_SIZE = 100;

interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

function MenuOption({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={`flex h-7 w-full cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 text-[13px] font-semibold transition-colors duration-[120ms] ${
        active ? "bg-white/[0.09] text-white" : "text-osu-l1 hover:bg-white/[0.05] hover:text-white"
      }`}
    >
      <span className="truncate">{label}</span>
      {count != null ? <span className="text-[12px] font-normal tabular-nums text-osu-f1">{count}</span> : null}
    </button>
  );
}

/** One dropdown of the filter bar. The first option clears it; more than one
    group lays the groups out as columns (Players say: Rice beside LN). */
function FilterMenu({ label, value, valueLabel, all, groups, onChange }: {
  label: string;
  value: string | null;
  valueLabel: string;
  all: string;
  groups: Array<{ title?: string; options: FilterOption[] }>;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = groups.filter((group) => group.options.length > 0);
  const columns = shown.length > 1;
  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  const active = value != null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[7px] pl-3 pr-2.5 text-[12.5px] font-semibold transition-colors duration-[120ms] ${
          active ? "bg-osu-pink/15 text-osu-pink-light hover:bg-osu-pink/20" : "bg-white/[0.05] text-white hover:bg-white/[0.08]"
        }`}
      >
        <span className={active ? "opacity-80" : "text-osu-f1"}>{label}</span>
        <span>{valueLabel}</span>
        <ChevronDown className={`h-3.5 w-3.5 opacity-60 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={label}
          className={`absolute left-0 top-full z-30 mt-1.5 max-w-[calc(100vw-2rem)] rounded-[10px] bg-osu-b5 p-2 shadow-[0_12px_32px_rgba(0,0,0,0.5)] ${columns ? "w-[380px]" : "w-[210px]"}`}
        >
          <MenuOption label={all} active={value == null} onClick={() => pick(null)} />
          <div className={columns ? "grid grid-cols-2 gap-x-2" : ""}>
            {shown.map((group) => (
              <div key={group.title ?? "options"}>
                {group.title ? <div className="px-2.5 pb-1 pt-2 text-[11px] text-osu-f1">{group.title}</div> : null}
                {group.options.map((option) => (
                  <MenuOption key={option.value} label={option.label} count={option.count} active={value === option.value} onClick={() => pick(option.value)} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const isLnTile = (value: string) => value === "ln" || value.startsWith("ln");

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

export function ChartLabelsBoard({ onShowReports }: { onShowReports: () => void }) {
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
  const [filed, setFiled] = useState<ChartLabelFiled | null>(null);
  const [says, setSays] = useState<string | null>(null);
  const [sort, setSort] = useState<ChartLabelSort>("reporters");

  const query = useMemo(() => ({ status, keys, kind, filed, says, withNote: commentsOnly, sort }), [status, keys, kind, filed, says, commentsOnly, sort]);
  // Any LN first, then the skillsets by how many charts ask for them; the picked one stays even at 0.
  const saysOptions = useMemo(() => {
    const list = [...(facets?.says ?? [])].sort((a, b) => Number(b.value === "ln") - Number(a.value === "ln"));
    if (says && !list.some((entry) => entry.value === says)) list.push({ value: says, count: 0 });
    return list;
  }, [facets, says]);

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

  const anyFilter = keys != null || kind != null || filed != null || says != null || commentsOnly;
  const clearFilters = () => {
    setKeys(null);
    setKind(null);
    setFiled(null);
    setSays(null);
    setCommentsOnly(false);
  };
  const saysLabel = (value: string, short: boolean) =>
    value === "ln" ? "Any LN" : short ? tileName(value).replace(/^LN /, "") : tileName(value);

  return (
    <div className="flex-1 bg-osu-b5 min-h-[calc(100vh-60px)]">
      <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-[18px]">
            <button
              type="button"
              onClick={onShowReports}
              className="cursor-pointer text-[19px] font-extrabold tracking-[-0.01em] text-osu-f1 transition-colors duration-[120ms] hover:text-osu-l1"
            >
              Reports
            </button>
            <h1 className="text-[19px] font-extrabold tracking-[-0.01em] text-white">Labels</h1>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Refresh"
            title="Refresh"
            className="inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md bg-white/[0.05] text-osu-f1 transition-colors duration-[120ms] hover:text-white"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${groups === null ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="mt-3.5 flex gap-[22px] border-b border-white/[0.07]">
          {STATUSES.map((option) => {
            const active = status === option.value;
            return (
              <button
                key={option.value}
                type="button"
                title={option.hint}
                onClick={() => setStatus(option.value)}
                className={`relative flex cursor-pointer items-baseline gap-[7px] pb-2.5 pt-2 text-[14px] font-semibold transition-colors duration-[120ms] ${
                  active ? "text-white" : "text-osu-f1 hover:text-osu-l1"
                }`}
              >
                {option.label}
                <span className="text-[13px] tabular-nums opacity-75">{counts[option.value]}</span>
                {active ? <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-osu-pink" /> : null}
              </button>
            );
          })}
        </div>

        <div className="mt-3.5 mb-4 flex flex-wrap items-center gap-1.5">
          <FilterMenu
            label="Keys"
            value={keys == null ? null : String(keys)}
            valueLabel={keys == null ? "All" : `${keys}K`}
            all="All keys"
            groups={[{
              options: (facets?.keys ?? []).filter((entry) => entry.value !== "unknown").map((entry) => ({ value: entry.value, label: `${entry.value}K`, count: entry.count })),
            }]}
            onChange={(value) => setKeys(value == null ? null : Number(value))}
          />
          <FilterMenu
            label="About"
            value={kind}
            valueLabel={KINDS.find((option) => option.value === kind)?.label ?? "Anything"}
            all="Anything"
            groups={[{
              options: KINDS.map((option) => ({ ...option, count: facets?.kinds.find((entry) => entry.value === option.value)?.count })),
            }]}
            onChange={(value) => setKind(value as ChartLabelKind | null)}
          />
          <FilterMenu
            label="Filed as"
            value={filed}
            valueLabel={FILED.find((option) => option.value === filed)?.label ?? "Any"}
            all="Any"
            groups={[{
              options: FILED.flatMap((option) => {
                const count = facets?.filed?.find((entry) => entry.value === option.value)?.count ?? 0;
                return count === 0 && filed !== option.value ? [] : [{ ...option, count }];
              }),
            }]}
            onChange={(value) => setFiled(value as ChartLabelFiled | null)}
          />
          <FilterMenu
            label="Players say"
            value={says}
            valueLabel={says == null ? "Anything" : saysLabel(says, false)}
            all="Anything"
            groups={[
              { title: "Rice", options: saysOptions.filter((entry) => !isLnTile(entry.value)).map((entry) => ({ value: entry.value, label: saysLabel(entry.value, true), count: entry.count })) },
              { title: "LN", options: saysOptions.filter((entry) => isLnTile(entry.value)).map((entry) => ({ value: entry.value, label: saysLabel(entry.value, true), count: entry.count })) },
            ]}
            onChange={setSays}
          />
          <button
            type="button"
            onClick={() => setCommentsOnly((value) => !value)}
            aria-pressed={commentsOnly}
            className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-semibold transition-colors duration-[120ms] ${
              commentsOnly ? "bg-osu-pink/15 text-osu-pink-light hover:bg-osu-pink/20" : "bg-white/[0.05] text-osu-f1 hover:bg-white/[0.08] hover:text-osu-l1"
            }`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            With a comment
            {facets ? <span className="tabular-nums opacity-60">{facets.withNote}</span> : null}
          </button>
          {anyFilter ? (
            <button
              type="button"
              onClick={clearFilters}
              className="cursor-pointer px-1.5 text-[12px] text-osu-f1 transition-colors duration-[120ms] hover:text-osu-l1"
            >
              Clear
            </button>
          ) : null}
          <div className="ml-auto flex items-center gap-3">
            <FilterMenu
              label="Sort"
              value={sort === "newest" ? "newest" : null}
              valueLabel={sort === "newest" ? "Newest" : "Most players"}
              all="Most players"
              groups={[{ options: [{ value: "newest", label: "Newest" }] }]}
              onChange={(value) => setSort(value === "newest" ? "newest" : "reporters")}
            />
            {groups !== null ? (
              <span className="text-[12px] text-osu-f1">
                <span className="text-[14px] font-bold tabular-nums text-white">{total}</span> {total === 1 ? "chart" : "charts"}
              </span>
            ) : null}
          </div>
        </div>

        {error && <p className="mb-3 text-[12px] text-osu-red-light">{error}</p>}

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
            {keys != null || kind != null || filed != null || says != null || commentsOnly ? "Nothing matches these filters." : status === "open" ? "No open reports." : "Nothing here."}
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
