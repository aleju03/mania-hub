import { createFileRoute, Link, notFound, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { canSeeTeams } from "../lib/auth-shared";
import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { Search } from "lucide-react";
import { getI18n } from "../lib/i18n";
import { formatAccuracy, formatNumber } from "../lib/format";
import { pageSeo } from "../lib/seo";
import { fetchLiveTeamRankings, type LiveTeamRankingEntry, type LiveTeamRankingsPage, type LiveTeamRankingsSort } from "../lib/live-backend";
import { PageHeader } from "../components/layout/PageHeader";
import { Pagination } from "../components/ui/Pagination";
import { RankingRowSkeleton, Skeleton } from "../components/ui/LoadingSkeleton";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

type TeamsSearch = {
  page?: number;
  q?: string;
  sort?: LiveTeamRankingsSort;
  dir?: "asc" | "desc";
};

const TEAMS_SEARCH_DEFAULTS: Required<Pick<TeamsSearch, "page" | "q" | "sort" | "dir">> = {
  page: 1,
  q: "",
  sort: "performance",
  dir: "desc",
};

const SORTS: readonly LiveTeamRankingsSort[] = ["performance", "members", "plays", "accuracy", "combined", "ss", "s", "a"];
const GRADE_IMAGES = {
  ss: "/images/badges/score-ranks-v2019/GradeSmall-SS.svg",
  s: "/images/badges/score-ranks-v2019/GradeSmall-S.svg",
  a: "/images/badges/score-ranks-v2019/GradeSmall-A.svg",
} as const;

function parseSort(value: unknown): LiveTeamRankingsSort {
  return SORTS.includes(value as LiveTeamRankingsSort) ? value as LiveTeamRankingsSort : "performance";
}

function formatTeamAccuracy(accuracy: number | null): string {
  return accuracy != null && accuracy > 0 ? formatAccuracy(accuracy / 100) : "-";
}

function formatCombined(entry: LiveTeamRankingEntry): string {
  if (entry.pp_4k == null && entry.pp_7k == null) return "-";
  return formatNumber(Math.round((entry.pp_4k ?? 0) + (entry.pp_7k ?? 0)));
}

function combinedTitle(entry: LiveTeamRankingEntry): string | undefined {
  if (entry.pp_4k == null && entry.pp_7k == null) return undefined;
  return `4K ${formatNumber(Math.round(entry.pp_4k ?? 0))} / 7K ${formatNumber(Math.round(entry.pp_7k ?? 0))}`;
}

function parsePage(value: unknown): number {
  const page = Number(value ?? 1);
  return Number.isInteger(page) && page > 0 ? Math.min(page, 10_000) : 1;
}

export const Route = createFileRoute("/teams")({
  validateSearch: (search: Record<string, unknown>): TeamsSearch => ({
    page: parsePage(search.page),
    q: typeof search.q === "string" ? search.q.slice(0, 80) : "",
    sort: parseSort(search.sort),
    dir: search.dir === "asc" ? "asc" : "desc",
  }),
  search: {
    middlewares: [stripSearchParams(TEAMS_SEARCH_DEFAULTS)],
  },
  beforeLoad: ({ context }) => {
    if (!canSeeTeams(context.auth)) throw notFound();
  },
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    const { page = 1, q = "", sort = "performance", dir = "desc" } = match.search;
    return pageSeo({
      title: i18n._(msg`Mania team rankings`),
      description: i18n._(msg`osu!mania teams ranked by performance`),
      path: "/teams",
      noindex: page > 1 || q !== "" || sort !== "performance" || dir !== "desc",
      origin: match.context.origin,
      imageKind: "rankings",
    });
  },
  component: TeamsPage,
});

function teamPath(teamId: number): string {
  return `/team/${teamId}`;
}

function handleTeamAuxClick(event: MouseEvent<HTMLElement>, teamId: number): void {
  if (event.button !== 1) return;
  if ((event.target as Element | null)?.closest("a")) return;
  window.open(teamPath(teamId), "_blank", "noopener,noreferrer");
}

function TeamsPage() {
  const { t } = useLingui();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;
  const query = search.q ?? "";
  const sort = search.sort ?? "performance";
  const dir = search.dir ?? "desc";
  const [input, setInput] = useState(query);
  const [data, setData] = useState<LiveTeamRankingsPage | null>(null);
  /* The sort the rows on screen were read under. The URL moves first, and the
     old rows stay up dimmed while the new sort loads, so they must keep
     numbering the way they were ranked. */
  const [rowsSort, setRowsSort] = useState<LiveTeamRankingsSort>(sort);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // The URL follows the box after a pause, so typing does not stack history
  // entries or fire a request per key.
  useEffect(() => {
    if (input.trim() === query) return;
    const timer = setTimeout(() => {
      void navigate({ search: (prev) => ({ ...prev, q: input.trim(), page: 1 }), replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, navigate, query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchLiveTeamRankings({ page, pageSize: PAGE_SIZE, query, sort, dir })
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setRowsSort(sort);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [dir, page, query, sort]);

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  useEffect(() => {
    if (!data || data.total === 0 || page <= totalPages) return;
    void navigate({ search: (prev) => ({ ...prev, page: totalPages }), replace: true });
  }, [data, navigate, page, totalPages]);

  const handleSort = (field: LiveTeamRankingsSort) => {
    const next = sort !== field
      ? { sort: field, dir: "desc" as const }
      : dir === "desc"
        ? { sort: field, dir: "asc" as const }
        : { sort: "performance" as const, dir: "desc" as const };
    void navigate({ search: (prev) => ({ ...prev, ...next, page: 1 }), replace: true });
  };

  const rows = data?.ranking ?? [];
  const firstLoad = data == null && !failed;
  const dimmed = loading && data != null;
  const totalLabel = data && data.total > 0 ? (
    <span className="text-[11px] text-osu-f1">
      {query
        ? <Plural value={data.total} one="# matching team" other="# matching teams" />
        : <Plural value={data.total} one="# team" other="# teams" />}
    </span>
  ) : null;
  const emptyText = failed
    ? t`Couldn't load the team rankings.`
    : query
      ? t`No teams match "${query}".`
      : t`No teams yet.`;

  const mobileSortFields: Array<{ field: LiveTeamRankingsSort; label: string }> = [
    { field: "performance", label: "#" },
    { field: "members", label: t`Members` },
    { field: "accuracy", label: t`Acc` },
    { field: "plays", label: t`Plays` },
    { field: "combined", label: "4K+7K" },
  ];

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        iconSrc="/images/icons/rankings.svg"
        title={t`Mania team rankings`}
        rightInline
        right={totalLabel}
      />
      <div className="flex-1 bg-osu-b5">
        <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-5">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="relative w-full sm:w-[260px]">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
              <input
                type="search"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t`find a team...`}
                maxLength={80}
                className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/40 py-1.5 pl-8 pr-3 text-[13px] text-white placeholder:text-osu-f1/70 outline-none transition-colors focus:border-osu-pink/40"
              />
            </div>
            <p className="text-[11px] text-osu-f1">
              {t`Ranks can differ from osu! because some teams' pp only counts tracked members.`}
            </p>
            <div className="hidden sm:block sm:ml-auto">{totalLabel}</div>
          </div>

          {/* Mobile sort bar */}
          <div className="sm:hidden flex items-center gap-1.5 pb-3 overflow-x-auto scrollbar-hide">
            {mobileSortFields.map(({ field, label }) => {
              const active = sort === field;
              return (
                <button
                  key={field}
                  type="button"
                  onClick={() => handleSort(field)}
                  className={`flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                    active ? "bg-osu-pink/20 text-osu-pink-light" : "bg-osu-b4/60 text-osu-f1 hover:bg-osu-b4"
                  }`}
                >
                  {label}
                  {active && <span className="ml-0.5 text-[8px]">{dir === "desc" ? "▼" : "▲"}</span>}
                </button>
              );
            })}
            {(["ss", "s", "a"] as const).map((field) => {
              const active = sort === field;
              return (
                <button
                  key={field}
                  type="button"
                  onClick={() => handleSort(field)}
                  className={`flex-shrink-0 px-2 py-1 rounded-md transition-colors cursor-pointer ${active ? "bg-osu-pink/20" : "bg-osu-b4/60 hover:bg-osu-b4"}`}
                >
                  <div className="flex items-center gap-0.5">
                    <img src={GRADE_IMAGES[field]} alt={field.toUpperCase()} width={18} height={18} className={`transition-opacity ${active ? "opacity-100" : "opacity-60"}`} />
                    {active && <span className="text-osu-pink text-[8px]">{dir === "desc" ? "▼" : "▲"}</span>}
                  </div>
                </button>
              );
            })}
          </div>

          <div className={`sm:hidden space-y-2 transition-opacity duration-150 ${dimmed ? "opacity-50" : ""}`}>
            {firstLoad ? (
              Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg bg-osu-b4/50 p-3">
                  <Skeleton className="w-8 h-4" />
                  <Skeleton className="w-12 h-6 rounded" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))
            ) : rows.length > 0 ? (
              rows.map((entry) => <MobileTeamRow key={entry.team.id} entry={entry} sort={rowsSort} />)
            ) : (
              <div className="px-4 py-10 text-center text-[13px] text-osu-f1">{emptyText}</div>
            )}
          </div>

          <div className="hidden sm:block rounded-xl overflow-hidden border border-osu-b3/30">
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ width: rankColumnWidth(rows, rowsSort) }} />
                <col />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[6%]" />
                <col className="w-[6%]" />
                <col className="w-[6%]" />
              </colgroup>
              <thead>
                <tr className="bg-osu-b4 text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">
                  <th className="py-2.5 px-3 text-left">#</th>
                  <th className="py-2.5 px-3 text-left">{t`Team`}</th>
                  <SortableHeader label={t`Members`} active={sort === "members"} dir={dir} onSort={() => handleSort("members")} />
                  <SortableHeader label={t`Accuracy`} active={sort === "accuracy"} dir={dir} onSort={() => handleSort("accuracy")} />
                  <SortableHeader label={t`Play Count`} active={sort === "plays"} dir={dir} onSort={() => handleSort("plays")} />
                  {/* Only marked once it leaves the default order, like the player board's #. */}
                  <SortableHeader label={t`Performance`} active={sort === "performance" && dir === "asc"} dir={dir} onSort={() => handleSort("performance")} />
                  <SortableHeader label="4K+7K" active={sort === "combined"} dir={dir} onSort={() => handleSort("combined")} />
                  {(["ss", "s", "a"] as const).map((field) => (
                    <SortableHeader key={field} active={sort === field} dir={dir} onSort={() => handleSort(field)} align="center">
                      <img src={GRADE_IMAGES[field]} alt={field.toUpperCase()} width={20} height={20} className="inline-block align-middle" />
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody className={`transition-opacity duration-150 ${dimmed ? "opacity-50" : ""}`}>
                {firstLoad ? (
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="border-t border-osu-b3/20">
                      <td colSpan={10} className="px-3 py-1.5"><RankingRowSkeleton /></td>
                    </tr>
                  ))
                ) : rows.length > 0 ? (
                  rows.map((entry, i) => (
                    <tr
                      key={entry.team.id}
                      className="border-t border-osu-b3/20 hover:bg-osu-b4/80 transition-colors duration-[120ms] cursor-pointer"
                      style={{ background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent" }}
                      onClick={() => navigate({ to: "/team/$teamId", params: { teamId: String(entry.team.id) } })}
                      onAuxClick={(event) => handleTeamAuxClick(event, entry.team.id)}
                    >
                      <td className="py-2.5 px-3 text-sm font-bold text-osu-f1 whitespace-nowrap"><RankCell entry={entry} sort={rowsSort} inline /></td>
                      <td className="py-2.5 px-3">
                        <Link
                          to="/team/$teamId"
                          params={{ teamId: String(entry.team.id) }}
                          className="flex items-center gap-3 min-w-0"
                        >
                          <TeamFlag url={entry.team.flag_url} />
                          <span className="text-sm font-medium text-white truncate min-w-0">{entry.team.name}</span>
                          {entry.team.short_name ? (
                            <span className="shrink-0 text-[11px] font-semibold text-osu-f1">{entry.team.short_name}</span>
                          ) : null}
                        </Link>
                      </td>
                      <td className={cellClass(sort === "members")}>{formatNumber(entry.tracked_members)}</td>
                      <td className={cellClass(sort === "accuracy", "text-osu-l2")}>{formatTeamAccuracy(entry.accuracy)}</td>
                      <td className={cellClass(sort === "plays")}>{formatNumber(entry.play_count)}</td>
                      <td className="py-2.5 px-3 text-sm font-bold text-right text-white">{formatNumber(Math.round(entry.performance))}</td>
                      <td className={cellClass(sort === "combined")} title={combinedTitle(entry)}>{formatCombined(entry)}</td>
                      <td className={gradeCellClass(sort === "ss")}>{formatNumber(entry.grade_counts.ss)}</td>
                      <td className={gradeCellClass(sort === "s")}>{formatNumber(entry.grade_counts.s)}</td>
                      <td className={gradeCellClass(sort === "a")}>{formatNumber(entry.grade_counts.a)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10} className="px-4 py-10 text-center text-[13px] text-osu-f1">{emptyText}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <Pagination
              page={Math.min(page, totalPages) - 1}
              totalPages={totalPages}
              onPageChange={(nextPage) => {
                if (loading) return;
                void navigate({ search: (prev) => ({ ...prev, page: nextPage + 1 }) });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function cellClass(active: boolean, idle = "text-osu-f1"): string {
  return `py-2.5 px-3 text-sm text-right ${active ? "text-white font-semibold" : idle}`;
}

function gradeCellClass(active: boolean): string {
  return `py-2.5 px-3 text-xs text-center ${active ? "text-white font-semibold" : "text-osu-f1"}`;
}

/* The # column fits the ranks on this page rather than the widest one the
   board could show, so a first page is not a strip of empty space. Measured
   per character: text-sm bold digits for the row's number, 11px for the
   performance rank beside it off the performance sort. */
function rankColumnWidth(rows: LiveTeamRankingEntry[], sort: LiveTeamRankingsSort): number {
  const chars = (value: number | null) => (value == null ? 1 : `#${formatNumber(value)}`.length);
  let width = 0;
  for (const entry of rows) {
    const primary = chars(sort === "performance" ? entry.rank : entry.placement) * 9;
    const secondary = sort === "performance" ? 0 : 6 + chars(entry.rank) * 7;
    width = Math.max(width, primary + secondary);
  }
  return Math.max(56, width + 24);
}

/* On any sort but performance the row numbers by its place on that column
   and keeps its performance rank under it, like the player board's 4K+7K. */
function RankCell({ entry, sort, inline = false }: { entry: LiveTeamRankingEntry; sort: LiveTeamRankingsSort; inline?: boolean }) {
  const { t } = useLingui();
  if (sort === "performance") return <>#{formatNumber(entry.rank)}</>;
  // Inline on the table so a re-sorted row keeps the default row height.
  return (
    <>
      {entry.placement != null ? `#${formatNumber(entry.placement)}` : "-"}
      <span
        className={`${inline ? "ml-1.5" : "block"} text-[11px] font-normal text-osu-f1/70`}
        title={t`Performance rank`}
      >
        #{formatNumber(entry.rank)}
      </span>
    </>
  );
}

// osu! team flags are 2:1.
function TeamFlag({ url, large = false }: { url: string | null; large?: boolean }) {
  const size = large ? "h-6 w-12" : "h-[18px] w-9";
  if (!url) return <span className={`${size} shrink-0 rounded-sm bg-osu-b3/60`} />;
  return <img src={url} alt="" loading="lazy" className={`${size} shrink-0 rounded-sm object-cover`} />;
}

function MobileTeamRow({ entry, sort }: { entry: LiveTeamRankingEntry; sort: LiveTeamRankingsSort }) {
  const members = formatNumber(entry.tracked_members);
  const plays = formatNumber(entry.play_count);
  const performance = <>{formatNumber(Math.round(entry.performance))}pp</>;
  const value = (() => {
    switch (sort) {
      case "members": return <Trans>{members} members</Trans>;
      case "plays": return <Trans>{plays} plays</Trans>;
      case "accuracy": return <>{formatTeamAccuracy(entry.accuracy)}</>;
      case "combined": {
        const combined = formatCombined(entry);
        return combined === "-" ? <>{combined}</> : <>{combined}pp</>;
      }
      case "ss":
      case "s":
      case "a":
        return (
          <span className="flex items-center gap-1">
            <img src={GRADE_IMAGES[sort]} alt={sort.toUpperCase()} width={16} height={16} />
            {formatNumber(entry.grade_counts[sort])}
          </span>
        );
      default: return performance;
    }
  })();
  return (
    <Link
      to="/team/$teamId"
      params={{ teamId: String(entry.team.id) }}
      className="block rounded-lg bg-osu-b4/50 p-3 cursor-pointer hover:bg-osu-b4 transition-colors"
    >
      <div className="flex items-center gap-3">
        <span className="text-sm font-bold text-osu-f1 w-11 shrink-0"><RankCell entry={entry} sort={sort} /></span>
        <TeamFlag url={entry.team.flag_url} large />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-semibold text-white truncate">{entry.team.name}</span>
            {entry.team.short_name ? <span className="shrink-0 text-[11px] font-semibold text-osu-f1">{entry.team.short_name}</span> : null}
          </div>
          <div className="mt-0.5 text-[11px] text-osu-f1">
            {sort === "performance" ? <Trans>{members} members</Trans> : performance}
          </div>
        </div>
        <span className="text-sm font-bold text-right flex-shrink-0">{value}</span>
      </div>
    </Link>
  );
}

function SortableHeader({ label, children, active, dir, onSort, align = "right" }: {
  label?: string;
  children?: ReactNode;
  active: boolean;
  dir: "asc" | "desc";
  onSort: () => void;
  align?: "right" | "center";
}) {
  return (
    <th
      className={`py-2.5 px-3 ${align === "center" ? "text-center" : "text-right"} cursor-pointer select-none transition-colors ${active ? "bg-osu-pink/15 text-osu-pink-light" : "hover:bg-osu-b3/30"}`}
      onClick={onSort}
    >
      {children ?? label}
      {active && <span className="ml-1 text-osu-pink text-[8px]">{dir === "desc" ? "\u25BC" : "\u25B2"}</span>}
    </th>
  );
}
