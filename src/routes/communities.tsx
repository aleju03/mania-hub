import { createFileRoute, Link, stripSearchParams, useLocation, useNavigate } from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OsuTriangleBackdrop } from "../components/layout/OsuTriangleBackdrop";
import { PageHeader } from "../components/layout/PageHeader";
import { CommunityCard } from "../components/communities/CommunityCard";
import { CommunityEditModal } from "../components/communities/CommunityEditModal";
import { CommunitySubmitModal } from "../components/communities/CommunitySubmitModal";
import { Pagination } from "../components/ui/Pagination";
import { Skeleton } from "../components/ui/LoadingSkeleton";
import { useAuth } from "../lib/auth-context";
import { getCountryName } from "../lib/country";
import { CountryFlag } from "../components/ui/CountryFlag";
import { DiscordLogo, DISCORD_BLURPLE } from "../components/ui/DiscordLogo";
import { OsuLogo } from "../components/ui/OsuLogo";
import {
  COMMUNITIES_PAGE_SIZE,
  COMMUNITY_INTERNATIONAL,
  COMMUNITY_LANGUAGES,
  canModerateCommunities,
  clearCommunitiesCache,
  communitiesListCacheKey,
  communityLanguageLabel,
  normalizeCommunityTag,
  fetchCommunities,
  fetchCommunityQueueCount,
  fetchMyCommunities,
  readCachedCommunities,
  readCachedMyCommunities,
  writeCachedCommunities,
  writeCachedMyCommunities,
  type CommunitiesListResult,
  type CommunityFacet,
  type CommunitySort,
  type CommunitySummary,
} from "../lib/communities";
import { pageSeo } from "../lib/seo";

/*
 * The Discord server directory.
 *
 * Open to anyone, signed in or not: reading it asks nothing. Posting a server
 * needs an osu! login and a Discord connection, and the header says so instead
 * of the page hiding itself. Which restricted listings a reader is shown still
 * depends on their osu!-verified country, which the server functions read from
 * the session rather than from the browser.
 */

// All fields optional at the type level so a plain <Link to="/communities">
// needs no search object; validateSearch normalizes every field on read.
interface CommunitiesSearch {
  q?: string;
  page?: number;
  sort?: CommunitySort;
  country?: string;
  lang?: string;
  tag?: string;
  // How the Discord connection went, handed back by /api/auth/discord/callback.
  discord?: DiscordFlag;
}

// Part of the validated search on purpose. Read off window.location it was
// unreliable, because validateSearch drops anything not in the schema before an
// effect gets a chance to look.
type DiscordFlag = "" | "connected" | "failed" | "signin";
const DISCORD_FLAGS: readonly string[] = ["connected", "failed", "signin"];

const DEFAULT_COMMUNITIES_SEARCH = {
  q: "",
  page: 0,
  sort: "members" as CommunitySort,
  country: "",
  lang: "",
  tag: "",
  discord: "" as DiscordFlag,
};

export function parseCommunitiesSearch(search: Record<string, unknown>): CommunitiesSearch {
  const page = Number(search.page);
  const sort = search.sort === "newest" || search.sort === "name" ? search.sort : DEFAULT_COMMUNITIES_SEARCH.sort;
  const country = typeof search.country === "string" ? search.country.trim().toUpperCase() : "";
  const lang = typeof search.lang === "string" ? search.lang.trim().toLowerCase() : "";
  return {
    q: typeof search.q === "string" ? search.q.slice(0, 80) : DEFAULT_COMMUNITIES_SEARCH.q,
    page: Number.isInteger(page) && page > 0 ? page : DEFAULT_COMMUNITIES_SEARCH.page,
    sort,
    // Every filter is checked against its vocabulary here, so a hand-edited URL
    // cannot put a value in the querystring that the page then echoes back.
    country: country === COMMUNITY_INTERNATIONAL || /^[A-Z]{2}$/.test(country) ? country : "",
    lang: (COMMUNITY_LANGUAGES as readonly string[]).includes(lang) ? lang : "",
    // Tags are free text, so there is no vocabulary to check against; the same
    // cleaning the input box does is what makes a hand-edited one safe.
    tag: typeof search.tag === "string" ? normalizeCommunityTag(search.tag) : "",
    discord: (typeof search.discord === "string" && DISCORD_FLAGS.includes(search.discord)
      ? search.discord
      : "") as DiscordFlag,
  };
}

export const Route = createFileRoute("/communities")({
  head: ({ match }) => pageSeo({
    title: "osu!mania Discord servers",
    description: "Find an osu!mania Discord server to join, or post your own.",
    path: "/communities",
    origin: match.context.origin,
  }),
  search: {
    middlewares: [stripSearchParams(DEFAULT_COMMUNITIES_SEARCH)],
  },
  validateSearch: parseCommunitiesSearch,
  component: CommunitiesPage,
});

// The beatmapsets-listing filter row: micro-label on the left, options as plain
// text, the active one white. Same shape /skins uses.
function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="w-14 shrink-0 text-[10px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3.5 gap-y-1">{children}</div>
    </div>
  );
}

function FilterOption({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-[12.5px] font-semibold tabular-nums transition-colors cursor-pointer ${
        active ? "text-white" : "text-osu-f1 hover:text-osu-pink-light"
      }`}
    >
      {children}
    </button>
  );
}

/*
 * How many values a filter row shows before the rest go behind a count. The
 * rows are the directory describing itself, which reads well at a handful of
 * countries and stops working entirely at a hundred: every country listed put
 * "where" at ten lines on a laptop and thirty on a phone, with the servers
 * themselves pushed off the screen. Facets arrive most-listed first, so the
 * cut keeps the ones most people are looking for.
 */
const FILTER_ROW_LIMIT = 12;
// Country names carry a flag and run long, so that row cuts sooner to stay on
// about one line, and pins the viewer's own country into what it keeps.
const COUNTRY_ROW_LIMIT = 8;

/**
 * The values a collapsed filter row shows, most-listed first.
 *
 * Two of them earn a place wherever they landed: the one that is picked, so a
 * filter is never on with nothing on screen saying so, and the viewer's own
 * country, which is the answer far more often than the eighth-biggest country
 * is. Only when they fall past the cut, so clicking something already in the
 * row never reshuffles it under the cursor.
 */
export function visibleFacets(
  facets: CommunityFacet[],
  { active, pin, limit }: { active?: string | null; pin?: string | null; limit: number },
): CommunityFacet[] {
  const head = facets.slice(0, limit);
  const wanted = [...new Set([active ?? "", pin ?? ""])].filter(
    (value) => value && !head.some((facet) => facet.value === value),
  );
  const lead = wanted
    .map((value) => facets.find((facet) => facet.value === value))
    .filter((facet): facet is CommunityFacet => facet != null);
  if (lead.length === 0) return head;
  return [...lead, ...head.slice(0, Math.max(0, limit - lead.length))];
}

function FacetRow({
  label,
  anyLabel,
  facets,
  active,
  pin,
  limit = FILTER_ROW_LIMIT,
  onPick,
  children,
}: {
  label: string;
  anyLabel: string;
  facets: CommunityFacet[];
  active: string;
  pin?: string | null;
  limit?: number;
  onPick: (value: string) => void;
  children: (facet: CommunityFacet) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = useMemo(
    () => (expanded ? facets : visibleFacets(facets, { active, pin, limit })),
    [expanded, facets, active, pin, limit],
  );
  const hidden = facets.length - shown.length;

  return (
    <FilterRow label={label}>
      <FilterOption active={active === ""} onClick={() => onPick("")}>
        {anyLabel}
      </FilterOption>
      {shown.map((facet) => (
        <FilterOption
          key={facet.value}
          active={active === facet.value}
          onClick={() => onPick(active === facet.value ? "" : facet.value)}
        >
          {children(facet)}
        </FilterOption>
      ))}
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="text-[12.5px] font-semibold text-osu-f1/60 transition-colors cursor-pointer hover:text-osu-pink-light"
        >
          {expanded ? "less" : `+${hidden} more`}
        </button>
      )}
    </FilterRow>
  );
}

function CommunityCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4">
      {/* The same darker band the card puts its icon and name in, so the grid
          does not jump when the real cards land. */}
      <div className="flex items-center gap-2.5 border-b border-black/20 bg-osu-b5 p-3">
        <Skeleton className="h-10 w-10 shrink-0 rounded-2xl" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <div className="space-y-2 p-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
  );
}

function CommunitiesPage() {
  const search = Route.useSearch();
  const { q = "", page = 0, sort = "members", country = "", lang = "", tag = "", discord = "" } = search;
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();

  // Seeded from the in-memory list, so walking back from a server's page paints
  // the grid it left rather than a screen of skeletons.
  const [data, setData] = useState<CommunitiesListResult | null>(
    () => readCachedCommunities(communitiesListCacheKey({ q, page, sort, country, lang, tag })),
  );
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [searchInput, setSearchInput] = useState(q);
  const [mine, setMine] = useState<CommunitySummary[]>(() => readCachedMyCommunities() ?? []);
  const [discordUsername, setDiscordUsername] = useState<string | null>(null);
  const [discordAvatarUrl, setDiscordAvatarUrl] = useState<string | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  const [editing, setEditing] = useState<CommunitySummary | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [queueCount, setQueueCount] = useState(0);
  const moderator = canModerateCommunities(auth);

  const applySearch = useCallback(
    (next: Partial<CommunitiesSearch>) => {
      void navigate({
        to: "/communities",
        // Any filter change lands on the first page; staying on page 4 of a
        // narrower result set reads as an empty directory.
        search: (prev: Record<string, unknown>) => ({ ...prev, page: 0, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  // Search box into the URL, debounced, so the address bar stays shareable
  // without a request per keystroke.
  useEffect(() => {
    if (searchInput === q) return;
    const timer = setTimeout(() => applySearch({ q: searchInput }), 350);
    return () => clearTimeout(timer);
  }, [searchInput, q, applySearch]);

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = communitiesListCacheKey({ q, page, sort, country, lang, tag });
    // A page already in hand shows straight away and the fetch behind it only
    // swaps the rows in; without one this is a cold load and the skeletons are
    // honest. After a change of your own the cache is gone, but the rows on
    // screen stay put, so that refresh is quiet too.
    const cached = readCachedCommunities(cacheKey);
    if (cached) setData(cached);
    setLoading(true);
    setFailed(false);
    fetchCommunities({ data: { q, page, sort, country, lang, tag } })
      .then((result) => {
        writeCachedCommunities(cacheKey, result);
        if (cancelled) return;
        setData(result);
      })
      .catch(() => {
        // With a cached page on screen, a failed revalidation stays silent.
        if (!cancelled && !cached) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q, page, sort, country, lang, tag, reloadTick]);

  // Your own listings, and whether a Discord connection is already in hand.
  useEffect(() => {
    if (!auth.viewer) return;
    let cancelled = false;
    fetchMyCommunities()
      .then((result) => {
        // Your own listings are merged into the grid, so they are cached with
        // it: without that the cards only you can see pop in a beat later.
        writeCachedMyCommunities(result.communities);
        if (cancelled) return;
        setMine(result.communities);
        setDiscordUsername(result.discordUsername);
        setDiscordAvatarUrl(result.discordAvatarUrl);
      })
      .catch(() => {
        // The directory itself still works without this.
      });
    return () => {
      cancelled = true;
    };
  }, [auth.viewer, reloadTick]);

  // How much is waiting on the review page, for the count on its button. Posting
  // or editing a listing puts one there too, so it rides reloadTick with the
  // rest: a moderator who just posted their own server sees the queue it joined.
  useEffect(() => {
    if (!moderator) return;
    let cancelled = false;
    fetchCommunityQueueCount()
      .then((count) => {
        if (!cancelled) setQueueCount(count);
      })
      .catch(() => {
        // No count is better than a wrong one; the button still opens the page.
      });
    return () => {
      cancelled = true;
    };
  }, [moderator, reloadTick]);

  // Coming back from the Discord connection, open the modal straight away
  // rather than making someone click Post again, and say what went wrong when
  // it did not work. The flag is cleared from the URL once it has been read, so
  // a refresh does not reopen the modal.
  useEffect(() => {
    if (!discord) return;
    setShowSubmit(true);
    setConnectError(
      discord === "failed"
        ? "Discord did not finish connecting. Try again."
        : discord === "signin"
          ? "Sign in with osu! first, then connect Discord."
          : null,
    );
    void navigate({
      to: "/communities",
      search: (prev: Record<string, unknown>) => ({ ...prev, discord: "" as DiscordFlag }),
      replace: true,
    });
  }, [discord, navigate]);

  /*
   * Your own listings and everyone else's, in one grid.
   *
   * An approved listing of yours is already in the page the backend sent, so
   * the owner copy replaces it in place: same position in the sort, but now
   * carrying the pencil and anything only you can see, like an invite about to
   * expire. The ones nobody else can see yet - waiting for approval, turned
   * down, or hidden because the invite died - are not in that page at all, so
   * they go on the front of it. Only on the first page of an unfiltered view:
   * a filtered grid that shows a card not matching the filter is a bug report
   * waiting to happen, and page 3 is not where you look for your own server.
   */
  const communities = useMemo(() => {
    const listed = data?.communities ?? [];
    if (mine.length === 0) return listed;
    const own = new Map(mine.map((row) => [row.id, row]));
    const merged = listed.map((row) => own.get(row.id) ?? row);
    if (page > 0 || q || country || lang || tag) return merged;
    const shown = new Set(listed.map((row) => row.id));
    return [...mine.filter((row) => !shown.has(row.id)), ...merged];
  }, [data, mine, page, q, country, lang, tag]);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / (data?.pageSize ?? COMMUNITIES_PAGE_SIZE)));
  const filtered = Boolean(q || country || lang || tag);
  // A facet the current filter itself produced still belongs in the row, so the
  // active option never vanishes from under the person who picked it.
  const countryFacets = data?.facets.countries ?? [];
  const languageFacets = data?.facets.languages ?? [];
  const tagFacets = data?.facets.tags ?? [];

  const headerAction = auth.viewer ? (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      {/* The review queue lives on the directory rather than under /admin:
          moderating servers is its own hand-kept list and implies nothing else.
          The count on the button is so a listing waiting on a decision is not
          something you have to open the page to find out about. */}
      {moderator && (
        <Link
          to="/communities/review"
          className="relative inline-flex items-center justify-center gap-2 rounded-full bg-osu-b4 px-3.5 py-1.5 text-[12.5px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3"
        >
          <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Review
          {queueCount > 0 && (
            <span
              aria-label={`${queueCount} waiting`}
              className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-osu-red px-1 text-center text-[10px] font-bold leading-[18px] text-white tabular-nums"
            >
              {queueCount > 99 ? "99+" : queueCount}
            </span>
          )}
        </Link>
      )}
      <button
        type="button"
        onClick={() => setShowSubmit(true)}
        className="inline-flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110 sm:flex-none"
        style={{ backgroundColor: DISCORD_BLURPLE }}
      >
        <DiscordLogo className="h-3.5 w-3.5" aria-hidden="true" />
        Post your server
      </button>
    </div>
  ) : auth.loginAvailable ? (
    // Signed out, the button used to just vanish, which reads as the directory
    // being something you only look at. Posting starts with an osu! login - the
    // Discord entry route refuses without one - so say that instead of hiding it.
    <a
      href={`/api/auth/osu?next=${encodeURIComponent(`${location.pathname}${location.searchStr}`)}`}
      className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-osu-pink/45 bg-osu-pink/15 px-4 py-1.5 text-[12.5px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white sm:w-auto"
      title="Log in with osu! to post your server"
    >
      <OsuLogo className="h-3.5 w-3.5" />
      Log in to post
    </a>
  ) : null;

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="relative z-10 flex flex-1 flex-col overflow-clip bg-osu-b5">
        <OsuTriangleBackdrop />
        <div className="relative z-10 flex flex-1 flex-col">
          <PageHeader iconSrc="/images/icons/chat.svg" title="osu!mania Discord servers" right={headerAction} />

          <div className="border-b border-osu-b3/30">
            <div className="mx-auto w-full max-w-[1200px] px-4 py-3.5 sm:px-5">
              <input
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search servers"
                aria-label="Search Discord servers"
                className="w-full rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2.5 text-[14px] text-osu-l1 transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none"
              />

              {/* Country and language are drawn from what is actually listed,
                  so the row is short, matches the sort row, and can never offer
                  a filter that comes back empty. Both rows disappear entirely
                  until there is more than one thing to choose between. */}
              <div className="mt-3 flex flex-col gap-1.5">
                {countryFacets.length > 1 && (
                  <FacetRow
                    label="where"
                    anyLabel="anywhere"
                    facets={countryFacets}
                    active={country}
                    pin={auth.viewer?.countryCode}
                    limit={COUNTRY_ROW_LIMIT}
                    onPick={(value) => applySearch({ country: value })}
                  >
                    {(facet) => (
                      <span className="inline-flex items-center gap-1.5">
                        {facet.value !== COMMUNITY_INTERNATIONAL && (
                          <CountryFlag code={facet.value} size="sm" decorative />
                        )}
                        {facet.value === COMMUNITY_INTERNATIONAL ? "international" : getCountryName(facet.value)}
                      </span>
                    )}
                  </FacetRow>
                )}

                {/* "all" rather than "any", which is now a language a server can
                    pick: two chips reading "any" side by side, one of them
                    meaning "do not filter", is a riddle. Matches the tags row. */}
                {languageFacets.length > 1 && (
                  <FacetRow
                    label="language"
                    anyLabel="all"
                    facets={languageFacets}
                    active={lang}
                    onPick={(value) => applySearch({ lang: value })}
                  >
                    {(facet) => communityLanguageLabel(facet.value)}
                  </FacetRow>
                )}

                {/* Tags are typed by the people posting, so this row is the
                    directory describing itself rather than a vocabulary anyone
                    had to guess at. */}
                {tagFacets.length > 1 && (
                  <FacetRow
                    label="tags"
                    anyLabel="all"
                    facets={tagFacets}
                    active={tag}
                    onPick={(value) => applySearch({ tag: value })}
                  >
                    {(facet) => facet.value}
                  </FacetRow>
                )}

                <FilterRow label="sort by">
                  <FilterOption active={sort === "members"} onClick={() => applySearch({ sort: "members" })}>
                    members
                  </FilterOption>
                  <FilterOption active={sort === "newest"} onClick={() => applySearch({ sort: "newest" })}>
                    newest
                  </FilterOption>
                  <FilterOption active={sort === "name"} onClick={() => applySearch({ sort: "name" })}>
                    name
                  </FilterOption>
                  {data && (
                    <span
                      className={`ml-auto text-[12px] text-osu-f1 tabular-nums transition-opacity ${loading ? "opacity-45" : ""}`}
                      role="status"
                      aria-live="polite"
                    >
                      {total.toLocaleString()} {total === 1 ? "server" : "servers"}
                    </span>
                  )}
                </FilterRow>
              </div>
            </div>
          </div>

          <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 sm:px-5">
            {loading && !data ? (
              <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }, (_, index) => (
                  <CommunityCardSkeleton key={index} />
                ))}
              </div>
            ) : failed ? (
              <div className="mx-auto max-w-md px-4 py-16 text-center">
                <div className="text-sm font-bold text-white">Servers are unavailable right now</div>
                <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">The servers could not be loaded.</p>
                <button
                  type="button"
                  onClick={() => setReloadTick((tick) => tick + 1)}
                  className="mt-4 rounded-full bg-osu-pink px-5 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110"
                >
                  Retry
                </button>
              </div>
            ) : communities.length === 0 ? (
              <div className="mx-auto max-w-md px-4 py-16 text-center">
                <div className="text-sm font-bold text-white">
                  {filtered ? "No servers match" : "No servers yet"}
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-osu-f1">
                  {filtered
                    ? country
                      ? `Nothing listed for ${country === COMMUNITY_INTERNATIONAL ? "international servers" : getCountryName(country)} yet.`
                      : "Try a wider filter."
                    : "Run an osu!mania server? Post it and it shows up here once it is approved."}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {communities.map((community) => (
                    <CommunityCard
                      key={community.id}
                      community={community}
                      onEdit={
                        community.ownerUserId === auth.viewer?.id ? () => setEditing(community) : undefined
                      }
                    />
                  ))}
                </div>
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  onPageChange={(next) => applySearch({ page: next })}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <CommunityEditModal
          community={editing}
          onChanged={(updated) => {
            clearCommunitiesCache();
            setMine((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
            setReloadTick((tick) => tick + 1);
          }}
          onRemoved={(id) => {
            clearCommunitiesCache();
            setMine((rows) => rows.filter((row) => row.id !== id));
            setReloadTick((tick) => tick + 1);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {showSubmit && (
        <CommunitySubmitModal
          discordUsername={discordUsername}
          discordAvatarUrl={discordAvatarUrl}
          ownerUsername={auth.viewer?.username ?? "you"}
          initialError={connectError}
          onClose={() => {
            setShowSubmit(false);
            setConnectError(null);
          }}
          onDisconnected={() => {
            setDiscordUsername(null);
            setDiscordAvatarUrl(null);
          }}
          onSubmitted={(community) => {
            clearCommunitiesCache();
            setMine((rows) => [community, ...rows]);
            // The connection is revoked and dropped on a successful submit, so
            // posting a second server starts from Connect again.
            setDiscordUsername(null);
            setDiscordAvatarUrl(null);
          }}
        />
      )}
    </div>
  );
}
