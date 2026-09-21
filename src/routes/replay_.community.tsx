import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { ArrowDownWideNarrow, ArrowLeft, ArrowUpWideNarrow, LoaderCircle, Search, Upload, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { getI18n } from "../lib/i18n";
import { PageHeader } from "../components/layout/PageHeader";
import { CommunityReplayCard } from "../components/replay/CommunityReplayCard";
import { StarRangePill } from "../components/maps/StarRangePill";
import { GradeImg } from "../components/ui/GradeImg";
import { FilterField, SegmentedControl } from "../components/ui/SegmentedControl";
import { COMMUNITY_STAR_MAX, normalizeCommunityUploadsQuery, type CommunityUploadGrade, type CommunityUploadsQuery } from "../lib/uploaded-replay-feed";
import { useCommunityUploadFeed } from "../lib/use-community-upload-feed";
import { pageSeo } from "../lib/seo";
import { formatNumber } from "../lib/format";
import { useLocale } from "../lib/locale-context";

type CommunitySearch = Partial<Pick<CommunityUploadsQuery, "q" | "keys" | "grade" | "starMin" | "starMax" | "sort">>;
const defaults: CommunitySearch = { q: "", keys: "all", grade: "all", starMin: 0, starMax: 0, sort: "newest" };
export const Route = createFileRoute("/replay_/community")({
  validateSearch: (search: Record<string, unknown>): CommunitySearch => {
    const { q, keys, grade, starMin, starMax, sort } = normalizeCommunityUploadsQuery(search);
    return { q, keys, grade, starMin, starMax, sort };
  },
  search: { middlewares: [stripSearchParams<CommunitySearch>(defaults)] },
  head: ({ match }) => {
    const i18n = getI18n(match.context.locale);
    return pageSeo({
      title: i18n._(msg`Community Replays`),
      description: i18n._(msg`Every osu!mania replay uploaded to Mania Hub, newest first. Open any of them in the replay watcher.`),
      path: "/replay/community",
      origin: match.context.origin,
      imageTitle: "Community Replays",
    });
  },
  component: CommunityReplaysPage,
});

function CommunityReplaysPage() {
  const { t } = useLingui();
  const locale = useLocale();
  const query = normalizeCommunityUploadsQuery(Route.useSearch());
  const navigate = Route.useNavigate();
  const [search, setSearch] = useState(query.q);
  const feed = useCommunityUploadFeed(query);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => setSearch(query.q), [query.q]);
  useEffect(() => {
    if (search.trim() === query.q) return;
    const timer = window.setTimeout(() => {
      void navigate({ search: (previous) => ({ ...previous, q: search.trim() }), replace: true, resetScroll: false });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, query.q, navigate]);

  useEffect(() => {
    if (!sentinel.current || !feed.nextCursor || feed.loading || feed.failed || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) feed.loadMore();
    }, { rootMargin: "700px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [feed.nextCursor, feed.loading, feed.failed, feed.indexing, feed.loadMore]);

  const filtered = query.q !== "" || query.keys !== "all" || query.grade !== "all" || query.starMin > 0 || query.starMax > 0;
  const clear = () => {
    setSearch("");
    void navigate({ search: { ...query, ...defaults, sort: query.sort }, resetScroll: false });
  };
  const count = formatNumber(feed.total, locale);

  return (
    <div className="flex-1">
      <PageHeader iconSrc="/images/icons/home.svg" title={t`Community Replays`} />
      <div className="min-h-[80vh] bg-osu-b5">
        <div className="mx-auto max-w-[1400px] px-3 py-4 sm:px-6 sm:py-6">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <Link to="/replay" search={{ tab: "upload" }} className="inline-flex items-center gap-1.5 text-xs font-semibold text-osu-f1 hover:text-white">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /><Trans>Replays</Trans>
            </Link>
            <Link to="/replay" search={{ tab: "upload" }} className="inline-flex items-center gap-2 rounded-lg bg-osu-b4 px-3 py-2 text-xs font-semibold text-white hover:bg-osu-b3">
              <Upload className="h-3.5 w-3.5" aria-hidden="true" /><Trans>Upload a replay</Trans>
            </Link>
          </div>

          <div className="mb-5 space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-osu-f1" aria-hidden="true" />
              <input
                type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={160}
                aria-label={t`Search replays`} placeholder={t`Search maps, players, uploaders or mods...`}
                className="w-full rounded-xl border border-osu-b3 bg-osu-b6 py-3 pl-10 pr-10 text-sm text-white outline-none placeholder:text-osu-f1 focus:border-osu-pink [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
              />
              {search && <button type="button" onClick={() => setSearch("")} aria-label={t`Clear search`} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-osu-f1 hover:text-white"><X className="h-4 w-4" /></button>}
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <FilterField label={t`Keys`}>
                <SegmentedControl
                  id="community-keys"
                  value={query.keys}
                  className="tabular-nums"
                  options={([["all", t`Any`], ["4", "4K"], ["7", "7K"], ["other", t`Other`]] as const).map(([keys, label]) => ({ value: keys, label }))}
                  onChange={(keys) => void navigate({ search: { ...query, keys }, resetScroll: false })}
                />
              </FilterField>
              <FilterField label={t`Grade`}>
                <SegmentedControl
                  id="community-grade"
                  size="icon"
                  dimInactive
                  value={query.grade}
                  options={(["all", "SS", "S", "A", "B"] as CommunityUploadGrade[]).map((grade) => ({
                    value: grade,
                    title: grade === "all" ? t`Any grade` : t`${grade} only`,
                    label: grade === "all"
                      ? <span className="px-1 text-[11px]"><Trans>Any</Trans></span>
                      : <GradeImg grade={grade} size={20} />,
                  }))}
                  onChange={(grade) => void navigate({ search: { ...query, grade }, resetScroll: false })}
                />
              </FilterField>
              <FilterField label={t`Difficulty`}>
                <StarRangePill
                  lo={0}
                  hi={COMMUNITY_STAR_MAX}
                  min={query.starMin}
                  max={query.starMax}
                  step={0.1}
                  ariaLabel={t`Star rating`}
                  onChange={(starMin, starMax) => void navigate({ search: { ...query, starMin, starMax }, resetScroll: false })}
                />
              </FilterField>
              {/* Not a filter, so it keeps the segmented track's weight without
                  its pink fill: one press flips the order. */}
              <button
                type="button"
                onClick={() => void navigate({ search: { ...query, sort: query.sort === "newest" ? "oldest" : "newest" }, resetScroll: false })}
                title={query.sort === "newest" ? t`Show oldest first` : t`Show newest first`}
                className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-osu-b3/25 bg-osu-b4/50 px-2.5 py-1.5 text-[11px] font-semibold text-osu-f1 transition-colors hover:text-osu-l2"
              >
                {query.sort === "newest"
                  ? <ArrowDownWideNarrow className="h-3.5 w-3.5" aria-hidden="true" />
                  : <ArrowUpWideNarrow className="h-3.5 w-3.5" aria-hidden="true" />}
                {query.sort === "newest" ? <Trans>Newest first</Trans> : <Trans>Oldest first</Trans>}
              </button>
            </div>
          </div>

          <div className="mb-4 flex min-h-5 flex-wrap items-center justify-between gap-2 text-xs text-osu-f1" aria-live="polite">
            <span>{!feed.loading || feed.uploads.length > 0 ? <Trans>{count} replays</Trans> : <Trans>Loading replays...</Trans>}</span>
            {filtered && <button type="button" onClick={clear} className="font-semibold text-osu-pink-light hover:text-white"><Trans>Clear filters</Trans></button>}
          </div>

          <div className="grid grid-cols-1 gap-x-5 gap-y-7 min-[540px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy={feed.loading}>
            {feed.uploads.map((upload) => <div key={upload.id} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 310px" }}><CommunityReplayCard upload={upload} /></div>)}
            {feed.loading && feed.uploads.length === 0 && Array.from({ length: 12 }, (_, index) => (
              <div key={index} className="motion-safe:animate-pulse" aria-hidden="true"><div className="aspect-video rounded-xl bg-osu-b4" /><div className="mt-3 h-4 w-3/4 rounded bg-osu-b4" /><div className="mt-2 h-3 w-1/2 rounded bg-osu-b4" /></div>
            ))}
          </div>

          {!feed.loading && !feed.failed && (!feed.indexing || filtered) && feed.uploads.length === 0 && (
            <div className="py-20 text-center"><Search className="mx-auto mb-4 h-8 w-8 text-osu-f1/50" aria-hidden="true" /><p className="text-sm text-osu-f1">{filtered ? <Trans>No replays match your search.</Trans> : <Trans>Nobody has uploaded a replay yet.</Trans>}</p></div>
          )}
          <div ref={sentinel} className="flex min-h-24 items-center justify-center py-6">
            {feed.failed ? (
              <div role="alert" className="text-center text-sm text-osu-f1"><p><Trans>Couldn't load the uploads.</Trans></p><button type="button" onClick={feed.retry} className="mt-2 rounded-lg bg-osu-b4 px-4 py-2 font-semibold text-white hover:bg-osu-b3"><Trans>Try again</Trans></button></div>
            ) : feed.loading || (feed.indexing && !feed.nextCursor) ? (
              <span role="status" className="flex items-center gap-2 text-xs text-osu-f1"><LoaderCircle className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />{feed.indexing ? <Trans>Finding more replays...</Trans> : <Trans>Loading...</Trans>}</span>
            ) : feed.nextCursor ? (
              <button type="button" onClick={feed.loadMore} className="rounded-lg bg-osu-b4 px-4 py-2 text-xs font-semibold text-osu-f1 hover:text-white"><Trans>Load more replays</Trans></button>
            ) : feed.uploads.length > 0 ? <p className="text-xs text-osu-f1"><Trans>You're all caught up.</Trans></p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
