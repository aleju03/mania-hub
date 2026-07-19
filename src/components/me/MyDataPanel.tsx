import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, Search, X } from "lucide-react";

import { PageHeader } from "../layout/PageHeader";
import { Avatar } from "../ui/Avatar";
import { CountryFlag } from "../ui/CountryFlag";
import { OsuLogo } from "../ui/OsuLogo";
import { useAuth } from "../../lib/auth-context";
import {
  fetchMyDataDashboard,
  fetchMyDataFeed,
  fetchMyDataSkills,
  fetchMyDataTopPlays,
  MY_DATA_PAGE_SIZE,
  type MyDataArchiveFilter,
  type MyDataModFilter,
  type MyDataSkillBreakdown,
  type MyDataSummary,
  type MyDataPage,
  type MyDataTopPlay,
  type MyDataTopPlaysParams,
  type MyDataTopPlaySort,
  type MyDataTrackedFeedParams,
  type MyDataTrackedPlay,
  type MyDataTrackedSort,
} from "../../lib/my-data";
import { openLiveEventSource } from "../../lib/live-backend";
import { SkillBreakdownBody, qualifyingSkillModes, skillRatingAccent } from "../player/SkillBreakdown";
import { getScoreTimestamp } from "../../lib/score";
import { MeScoreRow } from "./MeScoreRow";
import { ModBadge } from "../ui/ModBadge";
import { RosterOptInCard } from "./RosterOptInCard";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const KEY_LABEL: Record<number, string> = { 1: "1K", 2: "2K", 3: "3K", 4: "4K", 5: "5K", 6: "6K", 7: "7K", 8: "8K", 9: "9K", 10: "10K" };
type FeedTabId = "tracked" | "top";

const MOD_FILTER_OPTIONS: Array<{ value: MyDataModFilter; label: string }> = [
  { value: "all", label: "All mods" },
  { value: "nomod", label: "No mods" },
  { value: "modded", label: "Modded" },
];

const ARCHIVE_FILTER_OPTIONS: Array<{ value: MyDataArchiveFilter; label: string }> = [
  { value: "all", label: "All rows" },
  { value: "current", label: "Current" },
  { value: "archived", label: "Archived" },
];

const TRACKED_SORT_OPTIONS: Array<{ value: MyDataTrackedSort; label: string }> = [
  { value: "recent_desc", label: "Newest" },
  { value: "recent_asc", label: "Oldest" },
  { value: "pp_desc", label: "PP" },
  { value: "accuracy_desc", label: "Accuracy" },
  { value: "stars_desc", label: "Stars" },
];

const TOP_SORT_OPTIONS: Array<{ value: MyDataTopPlaySort; label: string }> = [
  { value: "pp_desc", label: "PP" },
  { value: "pp_asc", label: "Low PP" },
  { value: "recent_desc", label: "Newest" },
  { value: "recent_asc", label: "Oldest" },
  { value: "gain_desc", label: "PP gain" },
  { value: "accuracy_desc", label: "Accuracy" },
];

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <PageHeader iconSrc="/images/icons/profile.svg" title="my stats" />
      <div className="bg-osu-b5 min-h-[80vh]">
        <div className="mx-auto max-w-[1080px] px-3 py-5 sm:px-5 sm:py-7 space-y-5">{children}</div>
      </div>
    </div>
  );
}

function InsightCard({ title, children, right, accent = "#e173a6" }: { title: string; children: React.ReactNode; right?: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-3.5 w-1 rounded-full" style={{ backgroundColor: accent }} />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-osu-l3">{title}</span>
        {right ? <span className="ml-auto text-[10px] text-osu-f1">{right}</span> : null}
      </div>
      {children}
    </div>
  );
}

function HighlightStat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-osu-b3/20 bg-osu-b4 px-2.5 py-2.5 sm:px-3">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-osu-l3">{label}</div>
      <div className="mt-0.5 truncate text-[15px] font-bold leading-none tabular-nums sm:text-[18px]" style={{ color: accent }} title={value}>{value}</div>
      {sub ? <div className="mt-1 truncate text-[10px] text-osu-f1">{sub}</div> : null}
    </div>
  );
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDayRange(range: { startDay: string; endDay: string } | null | undefined): string | undefined {
  if (!range) return undefined;
  const start = formatDay(range.startDay);
  const end = formatDay(range.endDay);
  return start === end ? start : `${start} - ${end}`;
}

function compact(n: number): string {
  return n >= 10_000 ? n.toLocaleString() : String(n);
}

function formatHour(h: number): string {
  const period = h < 12 ? "am" : "pm";
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base}${period}`;
}

function normalizedQuery(value: string): string | undefined {
  const query = value.trim().toLowerCase();
  return query ? query : undefined;
}

function feedFilterKey(filters: MyDataTrackedFeedParams | MyDataTopPlaysParams): string {
  return [
    filters.query ?? "",
    filters.key ?? "all",
    filters.mods ?? "all",
    "archive" in filters ? filters.archive ?? "all" : "all",
    filters.sort ?? "",
  ].join("|");
}

function scoreHasMods(score: MyDataTrackedPlay): boolean {
  return (score.mods ?? []).length > 0;
}

function scoreMatchesTrackedFilters(score: MyDataTrackedPlay, filters: MyDataTrackedFeedParams): boolean {
  if (filters.archive === "archived" && !score.archived) return false;
  if (filters.archive === "current" && score.archived) return false;
  if (filters.key && filters.key !== "all" && Math.round(score.beatmap?.cs ?? 0) !== Number(filters.key)) return false;
  if (filters.mods === "nomod" && scoreHasMods(score)) return false;
  if (filters.mods === "modded" && !scoreHasMods(score)) return false;
  const query = normalizedQuery(filters.query ?? "");
  if (!query) return true;
  const haystack = [
    score.beatmapset?.title,
    score.beatmapset?.artist,
    score.beatmap?.version,
    score.beatmap?.id,
    score.beatmapset?.id,
  ].filter((part) => part != null).join(" ").toLowerCase();
  return haystack.includes(query);
}

export function MyDataPanel() {
  const auth = useAuth();
  const location = useLocation();
  const viewer = auth.viewer;

  const [summary, setSummary] = useState<MyDataSummary | null>(null);
  const [feed, setFeed] = useState<MyDataTrackedPlay[]>([]);
  const [topPlays, setTopPlays] = useState<MyDataTopPlay[]>([]);
  const [feedTab, setFeedTab] = useState<FeedTabId>("tracked");
  const [feedQuery, setFeedQuery] = useState("");
  const [debouncedFeedQuery, setDebouncedFeedQuery] = useState("");
  const [keyFilter, setKeyFilter] = useState("all");
  const [modFilter, setModFilter] = useState<MyDataModFilter>("all");
  const [archiveFilter, setArchiveFilter] = useState<MyDataArchiveFilter>("all");
  const [trackedSort, setTrackedSort] = useState<MyDataTrackedSort>("recent_desc");
  const [topSort, setTopSort] = useState<MyDataTopPlaySort>("pp_desc");
  const [trackedPageIndex, setTrackedPageIndex] = useState(0);
  const [topPageIndex, setTopPageIndex] = useState(0);
  const [trackedTotal, setTrackedTotal] = useState(0);
  const [topTotal, setTopTotal] = useState(0);
  const [trackedLimit, setTrackedLimit] = useState(MY_DATA_PAGE_SIZE);
  const [topLimit, setTopLimit] = useState(MY_DATA_PAGE_SIZE);
  const [pageLoading, setPageLoading] = useState<"tracked" | "top" | null>(null);
  const [skills, setSkills] = useState<MyDataSkillBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const newKeysRef = useRef<Set<string>>(new Set());
  const filterFetchReadyRef = useRef(false);
  const trackedFiltersRef = useRef<MyDataTrackedFeedParams>({ key: "all", mods: "all", archive: "all", sort: "recent_desc" });

  const applyTrackedPage = useCallback((page: MyDataPage<MyDataTrackedPlay>) => {
    setFeed(page.items);
    setTrackedTotal(page.total);
    setTrackedLimit(page.limit);
    setTrackedPageIndex(Math.floor(page.offset / Math.max(1, page.limit)));
  }, []);

  const applyTopPage = useCallback((page: MyDataPage<MyDataTopPlay>) => {
    setTopPlays(page.items);
    setTopTotal(page.total);
    setTopLimit(page.limit);
    setTopPageIndex(Math.floor(page.offset / Math.max(1, page.limit)));
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedFeedQuery(feedQuery.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [feedQuery]);

  useEffect(() => {
    filterFetchReadyRef.current = false;
  }, [viewer?.id]);

  const keyFilterOptions = useMemo(() => {
    const keys = new Set<number>([4, 7]);
    for (const stat of summary?.keyStats ?? []) keys.add(stat.keyCount);
    return [
      { value: "all", label: "All keys" },
      ...[...keys].sort((a, b) => a - b).map((key) => ({ value: String(key), label: KEY_LABEL[key] ?? `${key}K` })),
    ];
  }, [summary?.keyStats]);

  const trackedFilters = useMemo<MyDataTrackedFeedParams>(() => ({
    query: debouncedFeedQuery || undefined,
    key: keyFilter,
    mods: modFilter,
    archive: archiveFilter,
    sort: trackedSort,
  }), [archiveFilter, debouncedFeedQuery, keyFilter, modFilter, trackedSort]);

  const topFilters = useMemo<MyDataTopPlaysParams>(() => ({
    query: debouncedFeedQuery || undefined,
    key: keyFilter,
    mods: modFilter,
    sort: topSort,
  }), [debouncedFeedQuery, keyFilter, modFilter, topSort]);

  const trackedFiltersKey = useMemo(() => feedFilterKey(trackedFilters), [trackedFilters]);
  const topFiltersKey = useMemo(() => feedFilterKey(topFilters), [topFilters]);
  const activeFiltersKey = feedTab === "tracked" ? trackedFiltersKey : topFiltersKey;
  const hasActiveFeedControls = feedTab === "tracked"
    ? !!debouncedFeedQuery || keyFilter !== "all" || modFilter !== "all" || archiveFilter !== "all" || trackedSort !== "recent_desc"
    : !!debouncedFeedQuery || keyFilter !== "all" || modFilter !== "all" || topSort !== "pp_desc";

  useEffect(() => {
    trackedFiltersRef.current = trackedFilters;
  }, [trackedFilters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dashboard = await fetchMyDataDashboard();
      const next = dashboard.summary;
      setSummary(next);
      applyTrackedPage(dashboard.trackedPage);
      applyTopPage(dashboard.topPlayPage);
      setSkills(dashboard.skills);
      filterFetchReadyRef.current = false;
      if (next?.tracked) {
        // Default to the tab that actually has something to show.
        if (dashboard.trackedPage.total === 0 && dashboard.topPlayPage.total > 0) setFeedTab("top");
      } else {
        setFeedTab("tracked");
      }
    } catch {
      setSummary(null);
      setSkills(null);
      applyTrackedPage({ items: [], total: 0, limit: MY_DATA_PAGE_SIZE, offset: 0 });
      applyTopPage({ items: [], total: 0, limit: MY_DATA_PAGE_SIZE, offset: 0 });
      filterFetchReadyRef.current = false;
    } finally {
      setLoading(false);
    }
  }, [applyTopPage, applyTrackedPage]);

  const loadTrackedPage = useCallback(async (pageIndex: number) => {
    setPageLoading("tracked");
    try {
      applyTrackedPage(await fetchMyDataFeed({ data: { pageIndex, ...trackedFilters } }));
    } finally {
      setPageLoading(null);
    }
  }, [applyTrackedPage, trackedFilters]);

  const loadTopPage = useCallback(async (pageIndex: number) => {
    setPageLoading("top");
    try {
      applyTopPage(await fetchMyDataTopPlays({ data: { pageIndex, ...topFilters } }));
    } finally {
      setPageLoading(null);
    }
  }, [applyTopPage, topFilters]);

  useEffect(() => {
    if (!viewer) {
      setLoading(false);
      return;
    }
    void load();
  }, [viewer, load]);

  useEffect(() => {
    if (!viewer || !summary?.tracked || loading) return;
    if (!filterFetchReadyRef.current) {
      filterFetchReadyRef.current = true;
      return;
    }
    if (feedTab === "tracked") void loadTrackedPage(0);
    else void loadTopPage(0);
  }, [activeFiltersKey, feedTab, loading, summary?.tracked, viewer?.id]);

  // Live feed: tracker_score events for the viewer's country, filtered to their own plays.
  useEffect(() => {
    if (!viewer || !summary?.tracked || !viewer.countryCode) return;
    const source = openLiveEventSource(viewer.countryCode);
    if (!source) return;
    const onScore = (event: Event) => {
      try {
        const score = JSON.parse((event as MessageEvent).data) as MyDataTrackedPlay;
        if (score.user_id !== viewer.id || !score.passed) return;
        const filters = trackedFiltersRef.current;
        if (!scoreMatchesTrackedFilters(score, filters)) return;
        const key = `${score.beatmap?.id}-${getScoreTimestamp(score)}-${score.pp}`;
        setFeed((prev) => {
          if (prev.some((s) => `${s.beatmap?.id}-${getScoreTimestamp(s)}-${s.pp}` === key)) return prev;
          newKeysRef.current.add(key);
          setTrackedTotal((total) => total + 1);
          if (trackedPageIndex !== 0 || filters.sort !== "recent_desc") return prev;
          return [score, ...prev].slice(0, trackedLimit);
        });
      } catch {
        // ignore malformed events
      }
    };
    source.addEventListener("tracker_score", onScore);
    return () => source.close();
  }, [viewer, summary?.tracked, trackedLimit, trackedPageIndex]);

  const skillModes = useMemo(() => qualifyingSkillModes(skills), [skills]);
  const [skillModeKey, setSkillModeKey] = useState<number | null>(null);
  const activeSkillMode = useMemo(
    () => (skillModes.length > 0 ? skillModes.find((mode) => mode.keyCount === skillModeKey) ?? skillModes[0] : null),
    [skillModes, skillModeKey],
  );

  // The first compute after a deploy (or a fresh top-play stack) runs as a
  // background job; poll until it lands instead of asking for a page reload.
  useEffect(() => {
    if (!viewer || !summary?.tracked || skills?.status !== "pending") return;
    let attempts = 0;
    let cancelled = false;
    const interval = window.setInterval(() => {
      attempts += 1;
      if (attempts > 24) {
        window.clearInterval(interval);
        return;
      }
      void fetchMyDataSkills().then((next) => {
        if (cancelled || !next) return;
        setSkills(next);
      }).catch(() => {});
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [viewer, summary?.tracked, skills?.status]);
  const highlightStats = useMemo(() => {
    if (!summary) return [];
    const stats: Array<{ key: string; label: string; value: string; sub?: string; accent: string }> = [];
    if (summary.highlights.biggestDay) {
      stats.push({
        key: "biggest-day",
        label: "Biggest day",
        value: `${compact(summary.highlights.biggestDay.count)} plays`,
        sub: formatDay(summary.highlights.biggestDay.day),
        accent: "#d8a657",
      });
    }
    if (summary.highlights.longestStreak > 0) {
      stats.push({
        key: "longest-streak",
        label: "Longest streak",
        value: `${summary.highlights.longestStreak} ${summary.highlights.longestStreak === 1 ? "day" : "days"}`,
        sub: formatDayRange(summary.highlights.longestStreakRange),
        accent: "#7fb89a",
      });
    }
    if (summary.highlights.ppGainedTracked >= 1) {
      stats.push({
        key: "pp-gained",
        label: "PP gained",
        value: `+${Math.round(summary.highlights.ppGainedTracked)}pp`,
        sub: "while tracked",
        accent: "#e173a6",
      });
    }
    return stats;
  }, [summary]);
  const highlightGridClass = highlightStats.length >= 3 ? "grid-cols-3" : highlightStats.length === 2 ? "grid-cols-2" : "grid-cols-1";

  if (!viewer) {
    const loginHref = `/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`;
    return (
      <PageShell>
        <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-8 text-center">
          <div className="text-sm font-semibold text-osu-l2">Log in to see your data</div>
          <div className="mx-auto mt-1.5 max-w-md text-[13px] text-osu-f1">
            A live feed of your tracked plays, your playstyle fingerprint, when you play, and records the osu! profile never shows you.
          </div>
          <a href={loginHref} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 px-4 py-2 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white">
            <OsuLogo className="h-4 w-4" />
            Log in with osu!
          </a>
        </div>
      </PageShell>
    );
  }

  if (loading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-osu-f1">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading your data…
        </div>
      </PageShell>
    );
  }

  const username = summary?.username ?? viewer.username;
  const country = summary?.countryCode ?? viewer.countryCode ?? null;
  const tracked = summary?.tracked ?? false;

  return (
    <PageShell>
      <div className="relative overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
        {summary?.coverUrl ? (
          <>
            <img src={summary.coverUrl} alt="" className="absolute inset-x-0 top-0 h-32 w-full object-cover" />
            {/* Single gradient fades the cover into the card color, so it dissolves smoothly with no
                hard bottom edge. The content below is padded down to sit over the faded region. */}
            <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-transparent via-osu-b4/45 to-osu-b4" />
          </>
        ) : null}
        <div className={`relative flex items-end gap-3.5 px-4 pb-3 ${summary?.coverUrl ? "pt-16" : "pt-4"}`}>
          <Avatar url={summary?.avatarUrl ?? viewer.avatarUrl} userId={viewer.id} size={68} />
          <div className="min-w-0 flex-1 pb-0.5">
            <div className="flex items-center gap-2">
              <Link to="/player/$username" params={{ username }} className="truncate text-[17px] font-bold text-white hover:text-osu-pink-light">
                {username}
              </Link>
              {country ? <CountryFlag code={country} size="md" decorative /> : null}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-osu-f1 tabular-nums">
              {summary?.pp != null ? <span className="font-semibold text-osu-pink-light">{Math.round(summary.pp).toLocaleString()}pp</span> : null}
              {summary?.globalRank != null ? <span>#{summary.globalRank.toLocaleString()} global</span> : null}
              {summary?.countryRank != null && country ? <span>#{summary.countryRank.toLocaleString()} {country}</span> : null}
            </div>
          </div>
          <div className="hidden shrink-0 gap-4 pb-0.5 pr-1 text-right sm:flex">
            <HeaderStat label="plays" value={compact(summary?.totalScores ?? 0)} />
            <HeaderStat label="active days" value={compact(summary?.activeDays ?? 0)} />
            <HeaderStat label="top plays" value={compact(summary?.topPlayCount ?? 0)} />
          </div>
        </div>
        {/* The header stat trio doesn't fit next to the avatar on phones; give it its own strip. */}
        <div className="relative grid grid-cols-3 gap-3 border-t border-osu-b3/25 px-4 py-2.5 sm:hidden">
          <HeaderStat label="plays" value={compact(summary?.totalScores ?? 0)} />
          <HeaderStat label="active days" value={compact(summary?.activeDays ?? 0)} />
          <HeaderStat label="top plays" value={compact(summary?.topPlayCount ?? 0)} />
        </div>
      </div>

      {!tracked ? (
        <RosterOptInCard
          description="Your plays aren't being recorded yet because you're not in your country's top 100. Add yourself to the tracker and this page comes alive: a live feed of your plays, your playstyle, and records. Then you can set goals that auto-complete as you play."
          onTracked={load}
        />
      ) : (
        <>
          {highlightStats.length > 0 ? (
            <div className={`grid gap-2 sm:gap-2.5 ${highlightGridClass}`}>
              {highlightStats.map((stat) => (
                <HighlightStat key={stat.key} label={stat.label} value={stat.value} sub={stat.sub} accent={stat.accent} />
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <div className="mb-2 space-y-2">
                <div className="flex items-center gap-1.5">
                  <FeedTab active={feedTab === "tracked"} onClick={() => setFeedTab("tracked")}>Tracked</FeedTab>
                  <FeedTab active={feedTab === "top"} onClick={() => setFeedTab("top")}>Top plays</FeedTab>
                </div>
                <FeedControls
                  tab={feedTab}
                  query={feedQuery}
                  keyFilter={keyFilter}
                  keyOptions={keyFilterOptions}
                  modFilter={modFilter}
                  archiveFilter={archiveFilter}
                  trackedSort={trackedSort}
                  topSort={topSort}
                  onQueryChange={setFeedQuery}
                  onKeyFilterChange={setKeyFilter}
                  onModFilterChange={setModFilter}
                  onArchiveFilterChange={setArchiveFilter}
                  onTrackedSortChange={setTrackedSort}
                  onTopSortChange={setTopSort}
                />
              </div>
              {feedTab === "tracked" ? (
                feed.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-osu-b3/30 bg-osu-b4/40 p-8 text-center text-[13px] text-osu-f1">
                    {hasActiveFeedControls ? "No tracked plays match those controls." : <>No tracked plays. Play some ranked maps and they show up here live{topTotal > 0 ? ", or check your top plays" : ""}.</>}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {feed.map((score) => {
                      const key = `${score.beatmap?.id}-${getScoreTimestamp(score)}-${score.pp}`;
                      return <MeScoreRow key={key} score={score} isNew={newKeysRef.current.has(key)} />;
                    })}
                    <Pagination
                      pageIndex={trackedPageIndex}
                      total={trackedTotal}
                      limit={trackedLimit}
                      loading={pageLoading === "tracked"}
                      onPageChange={loadTrackedPage}
                    />
                  </div>
                )
              ) : topPlays.length === 0 ? (
                <div className="rounded-xl border border-dashed border-osu-b3/30 bg-osu-b4/40 p-8 text-center text-[13px] text-osu-f1">
                  {hasActiveFeedControls ? "No top plays match those controls." : "No top plays recorded yet. As you set new personal bests while tracked, they're saved here."}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {topPlays.map((tp, i) => (
                    <MeScoreRow key={`${tp.score.beatmap?.id}-${getScoreTimestamp(tp.score)}-${topPageIndex * topLimit + i}`} score={tp.score} ppGain={tp.ppGain} />
                  ))}
                  <Pagination
                    pageIndex={topPageIndex}
                    total={topTotal}
                    limit={topLimit}
                    loading={pageLoading === "top"}
                    onPageChange={loadTopPage}
                  />
                </div>
              )}
            </div>

            <div className="space-y-4">
              <InsightCard
                title="Skill rating"
                accent={skillRatingAccent(activeSkillMode)}
                right={skillModes.length > 1 ? <KeymodeToggle modes={skillModes} active={activeSkillMode?.keyCount ?? null} onChange={setSkillModeKey} /> : undefined}
              >
                <SkillBreakdownBody skills={skills} mode={activeSkillMode} own />
              </InsightCard>

              {summary && summary.rhythm.sampleSize > 0 ? (
                <InsightCard title="When you play" accent="#57aeba" right={summary.rhythm.timezone}>
                  <RhythmChart byHour={summary.rhythm.byHour} peakHour={summary.rhythm.peakHour} peakDay={summary.rhythm.peakDay} />
                </InsightCard>
              ) : null}

              {summary && summary.mods.sample > 0 ? (
                <InsightCard title="Mods" accent="#d8a657">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <ModUsage mod="NM" pct={summary.mods.noModPct} />
                    {summary.mods.top.map((m) => (
                      <ModUsage key={m.mod} mod={m.mod} pct={m.pct} />
                    ))}
                  </div>
                </InsightCard>
              ) : null}

            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link to="/player/$username/activity" params={{ username }} className="inline-flex items-center rounded-lg border border-osu-b3/40 bg-osu-b5/60 px-3.5 py-2 text-[12px] font-semibold text-osu-l2 transition-colors hover:border-osu-pink/40 hover:bg-osu-pink/10 hover:text-osu-pink-light">
              Full activity
            </Link>
            <Link to="/goals" className="inline-flex items-center rounded-lg border border-osu-b3/40 bg-osu-b5/60 px-3.5 py-2 text-[12px] font-semibold text-osu-l2 transition-colors hover:border-osu-pink/40 hover:bg-osu-pink/10 hover:text-osu-pink-light">
              {`Goals${summary?.goalsOpen ? ` (${summary.goalsOpen} open)` : ""}`}
            </Link>
          </div>
        </>
      )}
    </PageShell>
  );
}

function FeedControls({
  tab,
  query,
  keyFilter,
  keyOptions,
  modFilter,
  archiveFilter,
  trackedSort,
  topSort,
  onQueryChange,
  onKeyFilterChange,
  onModFilterChange,
  onArchiveFilterChange,
  onTrackedSortChange,
  onTopSortChange,
}: {
  tab: FeedTabId;
  query: string;
  keyFilter: string;
  keyOptions: Array<{ value: string; label: string }>;
  modFilter: MyDataModFilter;
  archiveFilter: MyDataArchiveFilter;
  trackedSort: MyDataTrackedSort;
  topSort: MyDataTopPlaySort;
  onQueryChange: (value: string) => void;
  onKeyFilterChange: (value: string) => void;
  onModFilterChange: (value: MyDataModFilter) => void;
  onArchiveFilterChange: (value: MyDataArchiveFilter) => void;
  onTrackedSortChange: (value: MyDataTrackedSort) => void;
  onTopSortChange: (value: MyDataTopPlaySort) => void;
}) {
  const sortOptions = tab === "tracked" ? TRACKED_SORT_OPTIONS : TOP_SORT_OPTIONS;
  const sortValue = tab === "tracked" ? trackedSort : topSort;
  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border border-osu-b3/20 bg-osu-b4 p-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="relative col-span-2 min-w-0 sm:col-span-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="search maps..."
          aria-label="Search maps"
          className="h-8 w-full rounded-md border border-osu-b3/30 bg-osu-b5/70 pl-8 pr-8 text-[12px] text-white outline-none transition-colors placeholder:text-osu-f1/70 focus:border-osu-pink/40"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQueryChange("")}
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5 sm:col-span-1 sm:justify-end">
        <ControlDropdown ariaLabel="Keymode filter" value={keyFilter} options={keyOptions} onChange={onKeyFilterChange} />
        <ControlDropdown ariaLabel="Mod filter" value={modFilter} options={MOD_FILTER_OPTIONS} onChange={(value) => onModFilterChange(value as MyDataModFilter)} />
        {tab === "tracked" ? (
          <ControlDropdown ariaLabel="Archive filter" value={archiveFilter} options={ARCHIVE_FILTER_OPTIONS} onChange={(value) => onArchiveFilterChange(value as MyDataArchiveFilter)} />
        ) : null}
        <ControlDropdown
          ariaLabel="Sort plays"
          value={sortValue}
          options={sortOptions}
          onChange={(value) => {
            if (tab === "tracked") onTrackedSortChange(value as MyDataTrackedSort);
            else onTopSortChange(value as MyDataTopPlaySort);
          }}
        />
      </div>
    </div>
  );
}

function ControlDropdown({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const active = options.find((option) => option.value === value) ?? options[0];
  const isFiltered = value !== options[0]?.value;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
        className={`flex h-8 min-w-[96px] max-w-[132px] items-center justify-between gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition-colors duration-[120ms] cursor-pointer ${
          isFiltered
            ? "border-osu-pink/40 bg-osu-pink/15 text-white"
            : "border-osu-b3/30 bg-osu-b5/70 text-osu-l2 hover:border-osu-pink/30 hover:text-white"
        }`}
      >
        <span className="truncate">{active?.label ?? "Any"}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-osu-f1 transition-transform duration-150 ${open ? "rotate-180" : ""}`} strokeWidth={2.4} />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute right-0 top-full z-50 mt-1 min-w-full overflow-hidden rounded-lg border border-osu-b3/50 bg-osu-b5 py-1 shadow-[0_12px_26px_rgba(0,0,0,0.48)]"
        >
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex h-8 w-full min-w-[116px] items-center gap-2 px-2.5 text-left text-[11px] font-semibold transition-colors duration-[120ms] cursor-pointer ${
                  selected
                    ? "bg-osu-pink/15 text-osu-pink-light"
                    : "text-osu-l2 hover:bg-osu-b4 hover:text-white"
                }`}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {selected ? <Check className="h-3.5 w-3.5" strokeWidth={2.6} /> : null}
                </span>
                <span className="whitespace-nowrap">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function paginationPages(pageIndex: number, pageCount: number): Array<number | "gap"> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);
  const pages = new Set([0, pageCount - 1, pageIndex - 1, pageIndex, pageIndex + 1]);
  const sorted = [...pages]
    .filter((page) => page >= 0 && page < pageCount)
    .sort((a, b) => a - b);
  const out: Array<number | "gap"> = [];
  for (const page of sorted) {
    const previous = out[out.length - 1];
    if (typeof previous === "number" && page - previous > 1) out.push("gap");
    out.push(page);
  }
  return out;
}

function Pagination({
  pageIndex,
  total,
  limit,
  loading,
  onPageChange,
}: {
  pageIndex: number;
  total: number;
  limit: number;
  loading: boolean;
  onPageChange: (pageIndex: number) => void | Promise<void>;
}) {
  const safeLimit = Math.max(1, limit);
  const pageCount = Math.max(1, Math.ceil(total / safeLimit));
  if (pageCount <= 1) return null;
  const first = pageIndex * safeLimit + 1;
  const last = Math.min(total, (pageIndex + 1) * safeLimit);
  const go = (next: number) => {
    if (next < 0 || next >= pageCount || next === pageIndex || loading) return;
    void onPageChange(next);
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
      <div className="text-[10px] font-semibold text-osu-f1 tabular-nums">
        {first}-{last} of {total.toLocaleString()}
      </div>
      <div className="flex items-center gap-1">
        <PaginationIconButton label="Previous page" disabled={loading || pageIndex === 0} onClick={() => go(pageIndex - 1)}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </PaginationIconButton>
        {paginationPages(pageIndex, pageCount).map((page, i) => page === "gap" ? (
          <span key={`gap-${i}`} className="px-1 text-[10px] font-semibold text-osu-f1">...</span>
        ) : (
          <button
            key={page}
            type="button"
            disabled={loading || page === pageIndex}
            onClick={() => go(page)}
            className={`h-7 min-w-7 rounded-md px-2 text-[11px] font-semibold transition-colors ${
              page === pageIndex
                ? "bg-osu-pink/15 text-osu-pink-light"
                : "bg-osu-b4 text-osu-l2 hover:bg-osu-pink/10 hover:text-osu-pink-light"
            } disabled:cursor-default disabled:opacity-80`}
          >
            {page + 1}
          </button>
        ))}
        <PaginationIconButton label="Next page" disabled={loading || pageIndex >= pageCount - 1} onClick={() => go(pageIndex + 1)}>
          <ChevronRight className="h-3.5 w-3.5" />
        </PaginationIconButton>
      </div>
    </div>
  );
}

function PaginationIconButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex h-7 w-7 items-center justify-center rounded-md bg-osu-b4 text-osu-l2 transition-colors hover:bg-osu-pink/10 hover:text-osu-pink-light disabled:cursor-default disabled:opacity-40"
      >
        {children}
      </button>
  );
}

function FeedTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors cursor-pointer ${
        active ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-l3 hover:text-osu-l1"
      }`}
    >
      {children}
    </button>
  );
}

function KeymodeToggle({ modes, active, onChange }: { modes: Array<{ keyCount: number | null }>; active: number | null; onChange: (keyCount: number | null) => void }) {
  return (
    <span className="inline-flex gap-1">
      {modes.map((mode) => {
        const label = mode.keyCount == null ? "?" : KEY_LABEL[mode.keyCount] ?? `${mode.keyCount}K`;
        return (
          <button
            key={mode.keyCount ?? "unknown"}
            type="button"
            onClick={() => onChange(mode.keyCount)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition-colors cursor-pointer ${
              mode.keyCount === active ? "bg-osu-pink/15 text-osu-pink-light" : "text-osu-l3 hover:text-osu-l1"
            }`}
          >
            {label}
          </button>
        );
      })}
    </span>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[16px] font-bold leading-none text-white tabular-nums">{value}</div>
      <div className="mt-0.5 text-[10px] text-osu-f1">{label}</div>
    </div>
  );
}

function ModUsage({ mod, pct }: { mod: string; pct: number }) {
  return (
    <div className="flex items-center gap-1.5" title={`${mod === "NM" ? "No mod" : mod}: ${pct}% of plays`}>
      <ModBadge mod={mod} size={0.85} color={mod === "NM" ? "#a8b2bf" : undefined} />
      <span className="text-[11px] text-osu-l2 tabular-nums">{pct}%</span>
    </div>
  );
}

function RhythmChart({ byHour, peakHour, peakDay }: { byHour: number[]; peakHour: number | null; peakDay: number | null }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...byHour);
  const total = byHour.reduce((sum, count) => sum + count, 0);
  return (
    <div onMouseLeave={() => setHovered(null)}>
      <div className="flex h-12 items-stretch gap-[2px]">
        {byHour.map((count, hour) => (
          <button
            type="button"
            key={hour}
            className="flex flex-1 cursor-pointer items-end outline-none"
            onMouseEnter={() => setHovered(hour)}
            onFocus={() => setHovered(hour)}
            onBlur={() => setHovered((prev) => (prev === hour ? null : prev))}
            aria-label={`${formatHour(hour)}: ${count} ${count === 1 ? "play" : "plays"}`}
          >
            <div
              className={`w-full rounded-sm ${hovered === hour ? "bg-osu-pink" : "bg-osu-pink/45"}`}
              style={{ height: `${Math.max(4, (count / max) * 100)}%` }}
            />
          </button>
        ))}
      </div>
      <div className="mt-2 text-[12px] text-osu-l2">
        {hovered != null ? (
          <>
            <span className="font-semibold text-white">{formatHour(hovered)}</span>
            {" "}&middot; {byHour[hovered]} {byHour[hovered] === 1 ? "play" : "plays"}
            {total > 0 ? <span className="text-osu-f1"> ({Math.round((byHour[hovered] / total) * 100)}%)</span> : null}
          </>
        ) : (
          <>
            {peakHour != null ? (
              <>Most active around <span className="font-semibold text-white">{formatHour(peakHour)}</span></>
            ) : null}
            {peakDay != null ? (
              <>, mostly on <span className="font-semibold text-white">{DAY_NAMES[peakDay]}s</span></>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
