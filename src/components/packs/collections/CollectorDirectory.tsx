import { Link } from "@tanstack/react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { track } from "#/lib/analytics";
import { collectionsDirectoryProperties } from "#/lib/analytics-collections";
import { formatNumber } from "#/lib/format";
import {
  fetchLivePackCollectors,
  packCollectorParam,
  type LivePackCollector,
  type LivePackCollectorPage,
  type LivePackCollectorSort,
} from "#/lib/live-backend";
import { getI18n } from "#/lib/i18n";
import { CountryFlag } from "../../ui/CountryFlag";
import { HeadingCount, ListSurface, RowSkeleton, SectionHeading } from "./chrome";
import { useDebounced } from "./useDebounced";

/* Everyone who has ever opened a pack, searchable. The boards are the ten
   people worth a headline; this is how you find the other few thousand,
   including yourself. */

const PAGE_SIZE = 24;

/* Pages of the directory, held for as long as the tab is open and warmed one
   page ahead of wherever the visitor is. Paging is the whole interaction here
   and every turn was a round trip you could feel: the list kept showing the
   page you had just left until the next one landed. The read is public and the
   backend serves it with a minute of cache-control, so keeping the pages that
   were walked costs a map and nothing else. Bounded because a long session
   with a search box can key a lot of them. Same handling the shelf uses. */
const DIRECTORY_PAGE_CACHE_LIMIT = 60;
const directoryPageCache = new Map<string, LivePackCollectorPage>();

function directoryPageKey(page: number, sort: LivePackCollectorSort, query: string) {
  return `${page}:${sort}:${query}`;
}

function rememberDirectoryPage(key: string, page: LivePackCollectorPage) {
  // Re-inserted so the map's order is least-recently-used, which is what the
  // eviction below reads.
  directoryPageCache.delete(key);
  directoryPageCache.set(key, page);
  while (directoryPageCache.size > DIRECTORY_PAGE_CACHE_LIMIT) {
    const oldest = directoryPageCache.keys().next().value;
    if (oldest === undefined) break;
    directoryPageCache.delete(oldest);
  }
}

/* Pages already on the wire, so a turn taken before the warm behind it lands
   joins that read instead of opening a second one for the same page. */
const directoryPageRequests = new Map<string, Promise<LivePackCollectorPage>>();

function loadDirectoryPage(
  page: number,
  sort: LivePackCollectorSort,
  query: string,
): Promise<LivePackCollectorPage> {
  const key = directoryPageKey(page, sort, query);
  const held = directoryPageCache.get(key);
  if (held) return Promise.resolve(held);
  const inFlight = directoryPageRequests.get(key);
  if (inFlight) return inFlight;
  const request = fetchLivePackCollectors({ page, pageSize: PAGE_SIZE, query, sort })
    .then((next) => {
      rememberDirectoryPage(key, next);
      return next;
    })
    .finally(() => {
      directoryPageRequests.delete(key);
    });
  directoryPageRequests.set(key, request);
  return request;
}

const SORTS: Array<{ id: LivePackCollectorSort; label: ReturnType<typeof msg> }> = [
  { id: "cards", label: msg`Cards` },
  { id: "copies", label: msg`Copies` },
  { id: "packs", label: msg`Packs` },
  { id: "goats", label: msg`GOATs` },
  // Holders only: the backend drops everyone without one from this ordering.
  { id: "eternals", label: msg`Exclusives` },
];

/* Whichever column the list is ordered by is the one it prints. Showing the
   card count while sorted by packs opened reads as a broken sort. */
function sortedValue(
  collector: LivePackCollector,
  sort: LivePackCollectorSort,
  i18n: ReturnType<typeof getI18n>,
): string {
  switch (sort) {
    case "copies":
      return formatNumber(collector.copies);
    case "packs":
      return collector.packsOpened === null ? i18n._(msg`unknown`) : formatNumber(collector.packsOpened);
    case "goats":
      return `${collector.goats}/${collector.completion.goatsTotal}`;
    case "eternals":
      return formatNumber(collector.eternals);
    default:
      return formatNumber(collector.cards);
  }
}

function DirectoryRow({ collector, sort }: { collector: LivePackCollector; sort: LivePackCollectorSort }) {
  const { i18n } = useLingui();
  return (
    <Link
      to="/packs/collections"
      // The tab rides along so the shelf's back link comes back here.
      search={{ collector: packCollectorParam(collector), tab: "collectors" as const }}
      preload="intent"
      className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-osu-b3/40"
    >
      <img
        src={collector.avatarUrl}
        alt=""
        width={28}
        height={28}
        loading="lazy"
        className="h-7 w-7 shrink-0 rounded-full object-cover"
        draggable={false}
      />
      {collector.countryCode ? (
        <CountryFlag code={collector.countryCode} size="xs" decorative className="shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-osu-l2">{collector.username}</span>
      {sort !== "goats" && collector.goats > 0 && (
        <span translate="no" className="hidden shrink-0 text-[11px] font-semibold text-amber-200 tabular-nums sm:block">
          <Trans>{collector.goats} GOAT</Trans>
        </span>
      )}
      <span translate="no" className="w-20 shrink-0 text-right text-[14px] font-bold text-white tabular-nums">
        {sortedValue(collector, sort, i18n)}
      </span>
    </Link>
  );
}

export function CollectorDirectory() {
  const { t, i18n } = useLingui();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LivePackCollectorSort>("cards");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<LivePackCollectorPage | null>(null);
  const [failed, setFailed] = useState(false);
  const debounced = useDebounced(query, 250);

  /* A search or a sort starts over at the first page. Done while rendering
     rather than in an effect because an effect leaves one commit pairing the
     new filter with the old page index, which is a request (and a tracked
     move) spent on a page already on its way out. Same handling the shelf
     uses. */
  const filterKey = `${debounced}:${sort}`;
  const [pagedFilter, setPagedFilter] = useState(filterKey);
  if (pagedFilter !== filterKey) {
    setPagedFilter(filterKey);
    setPage(0);
  }

  const requestKey = directoryPageKey(page, sort, debounced);
  /* Read during the render that the click causes, so a page already in hand
     paints in the same commit instead of a frame later. */
  const cached = directoryPageCache.get(requestKey) ?? null;

  useEffect(() => {
    let cancelled = false;

    /* One page ahead, once the page on screen is settled. The prefetch keeps
       writing to the cache after this effect is torn down: whoever asks for
       that page next is who it was for. */
    const warmNextPage = (current: LivePackCollectorPage) => {
      const nextPage = page + 1;
      if (nextPage * PAGE_SIZE >= current.total) return;
      // A page nobody asked for yet is not worth a failure state.
      loadDirectoryPage(nextPage, sort, debounced).catch(() => {});
    };

    const held = directoryPageCache.get(requestKey);
    if (held) {
      setFailed(false);
      warmNextPage(held);
      return () => {
        cancelled = true;
      };
    }

    setFailed(false);
    loadDirectoryPage(page, sort, debounced)
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        warmNextPage(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, sort, page, requestKey]);

  /* Searching, sorting and paging the list, reported as the state the move
     landed on. The list as opened is skipped; the pageview already has it. */
  const browseKey = `${debounced}:${sort}:${page}`;
  const browsedKey = useRef(browseKey);
  useEffect(() => {
    if (browsedKey.current === browseKey) return;
    browsedKey.current = browseKey;
    track("packs_collections_directory", collectionsDirectoryProperties({ query: debounced, sort, page }));
    // The key is the whole state; its parts are read off it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseKey]);

  const shown = cached ?? result;
  const total = shown?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);

  return (
    <ListSurface>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <SectionHeading>
          <Trans>every collector</Trans>
          <HeadingCount value={shown ? total : null} />
        </SectionHeading>
        <label className="relative flex min-w-[180px] flex-1 items-center sm:max-w-[260px]">
          <Search size={13} className="pointer-events-none absolute left-2 text-osu-f1" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t`Find a collector`}
            className="w-full rounded-lg border border-osu-b3/40 bg-osu-b5/60 py-1.5 pl-7 pr-2 text-[12px] text-white outline-none transition-colors placeholder:text-osu-f1 focus:border-osu-pink/50"
          />
        </label>
        <div className="flex items-center gap-1">
          {SORTS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setSort(option.id)}
              className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                sort === option.id ? "bg-osu-pink/20 text-white" : "text-osu-f1 hover:text-white"
              }`}
            >
              {i18n._(option.label)}
            </button>
          ))}
        </div>
      </div>

      {/* The list is never faded while the next page loads: an opacity
          transition over a tall list leaves a compositing seam across one of
          the rows in Chrome, which reads as a white line flashing through the
          table. Rows are swapped, or replaced by skeletons the same height. */}
      <div className="mt-2 -mx-2">
        {failed && !shown ? (
          <div className="py-10 text-center text-[12px] text-osu-f1"><Trans>Could not load the collector list.</Trans></div>
        ) : !shown ? (
          Array.from({ length: PAGE_SIZE }, (_, index) => <RowSkeleton key={index} variant="directory" />)
        ) : shown.collectors.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-osu-f1">
            {debounced
              ? t`Nobody here is called "${debounced}".`
              : sort === "eternals"
                ? t`Nobody holds an exclusive card yet.`
                : t`Nobody has opened a pack yet.`}
          </div>
        ) : (
          shown.collectors.map((collector) => (
            <DirectoryRow key={collector.userId} collector={collector} sort={sort} />
          ))
        )}
      </div>

      {/* The pager's row is held open while the rows load. A page is 24 of a
          few thousand collectors, so it is all but certain to be there, and
          the surface would otherwise grow by its height the moment they
          land. */}
      {!shown && <div className="mt-3 h-[26px]" />}

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3 text-[12px]">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
            className="cursor-pointer px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
          >
            <Trans>Previous</Trans>
          </button>
          <span translate="no" className="text-osu-f1 tabular-nums">
            {currentPage + 1} / {formatNumber(totalPages)}
          </span>
          <button
            type="button"
            disabled={currentPage >= totalPages - 1}
            onClick={() => setPage(currentPage + 1)}
            className="cursor-pointer px-2 py-1 font-semibold text-osu-f1 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
          >
            <Trans>Next</Trans>
          </button>
        </div>
      )}
    </ListSurface>
  );
}
