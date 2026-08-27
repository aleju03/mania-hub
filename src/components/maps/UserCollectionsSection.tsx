import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Heart, Plus, Search } from "lucide-react";
import { useAuth } from "../../lib/auth-context";
import { rememberMapsCollection } from "../../lib/analytics-maps";
import { formatNumber } from "../../lib/format";
import { avatarImageSrc } from "../ui/Avatar";
import { CoverStrip } from "./CollectionCovers";
import { UserCollectionEditor } from "./UserCollectionEditor";
import {
  EMPTY_USER_COLLECTIONS_LIST,
  collectionPath,
  favouriteMapCollection,
  fetchUserMapCollections,
  userCollectionKeyLabel,
  type UserCollectionSort,
  type UserCollectionsListResult,
  type UserMapCollectionSummary,
} from "../../lib/user-map-collections";

/*
 * The community half of the /maps Collections tab: collections players built
 * and posted, as opposed to the auto-rotating packs beside them.
 *
 * A collection appears the moment it is posted. There is no queue in front of
 * it because there is nothing here but beatmap ids, and every one of those
 * already passed osu!'s own moderation before it could be in the catalog this
 * picks from. Opening one leaves the tab for /collections/<slug>, which is the
 * link players actually share.
 */

const SORTS: Array<{ id: UserCollectionSort; label: MessageDescriptor }> = [
  { id: "recent", label: msg`Newest` },
  { id: "favourites", label: msg`Most liked` },
  { id: "maps", label: msg`Biggest` },
  { id: "title", label: msg`A-Z` },
];

const KEY_FILTERS = ["", "4k", "7k", "other"] as const;
type Scope = "all" | "mine" | "favourites";

/* One group of the filter bar. On a phone the groups sit on one horizontally
   scrollable line instead of stacking into three rows that push the
   collections themselves off the screen. */
function FilterGroup<T extends string>({
  options,
  value,
  onChange,
  render,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
  render: (option: T) => string;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-osu-b4/70 p-0.5">
      {options.map((option) => (
        <button
          key={option || "any"}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12px] font-bold transition-colors cursor-pointer ${
            value === option ? "bg-osu-pink/25 text-osu-pink-light" : "text-osu-f1 hover:text-osu-l2"
          }`}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}

function FavouriteButton({
  collection,
  onChange,
}: {
  collection: Pick<UserMapCollectionSummary, "id" | "favourited" | "favouriteCount">;
  onChange: (favourited: boolean, count: number) => void;
}) {
  const { t } = useLingui();
  const signedIn = useAuth().viewer != null;
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy || !signedIn) return;
    const next = !collection.favourited;
    setBusy(true);
    // Optimistic: the heart is the whole feedback, and a round trip's worth of
    // nothing reads as a dead button. A failed write puts the old state back.
    onChange(next, Math.max(0, collection.favouriteCount + (next ? 1 : -1)));
    try {
      const result = await favouriteMapCollection({ data: { id: collection.id, favourited: next } });
      if (result.ok) onChange(result.favourited, result.favouriteCount);
      else onChange(!next, collection.favouriteCount);
    } catch {
      onChange(!next, collection.favouriteCount);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={(event) => {
        // The tile is a link; liking it must not open it.
        event.preventDefault();
        event.stopPropagation();
        void toggle();
      }}
      disabled={!signedIn}
      aria-pressed={collection.favourited}
      title={signedIn ? t`Like this collection` : t`Sign in to like collections`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold transition-colors ${
        collection.favourited ? "bg-osu-pink/25 text-osu-pink-light" : "bg-osu-b3/50 text-osu-f1"
      } ${signedIn ? "cursor-pointer hover:text-osu-pink-light" : "cursor-not-allowed opacity-70"}`}
    >
      <Heart className="h-3 w-3" fill={collection.favourited ? "currentColor" : "none"} aria-hidden="true" />
      {formatNumber(collection.favouriteCount)}
    </button>
  );
}

function CollectionTile({
  collection,
  onFavouriteChange,
}: {
  collection: UserMapCollectionSummary;
  onFavouriteChange: (favourited: boolean, count: number) => void;
}) {
  const keyLabel = userCollectionKeyLabel(collection.keyCount);
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-osu-b3/20 bg-osu-b4 transition-colors hover:border-osu-pink/40">
      <Link
        to={collectionPath(collection)}
        onClick={() => {
          // Collection ids are opaque, so hand the title to the pageview the
          // navigation is about to fire.
          rememberMapsCollection(collection.id, collection.title);
        }}
        className="cursor-pointer"
      >
        <CoverStrip setIds={collection.coverSetIds} className="h-16 w-full" />
        <div className="min-w-0 px-3 pt-2.5">
          <div className="truncate text-[14px] font-extrabold leading-tight text-osu-l1">{collection.title}</div>
          <div className="mt-0.5 text-[10.5px] text-osu-f1">
            <Plural value={collection.memberCount} one="# map" other="# maps" />
            {keyLabel ? ` · ${keyLabel}` : ""}
          </div>
        </div>
      </Link>
      <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-2">
        <Link
          to="/player/$username"
          params={{ username: collection.owner.username }}
          className="flex min-w-0 items-center gap-1.5 text-[11px] text-osu-f1 transition-colors hover:text-osu-l2"
        >
          <img
            src={avatarImageSrc(collection.owner.avatarUrl ?? undefined, collection.owner.userId)}
            alt=""
            className="h-4 w-4 shrink-0 rounded-full object-cover"
            loading="lazy"
          />
          <span className="truncate">{collection.owner.username}</span>
        </Link>
        <FavouriteButton collection={collection} onChange={onFavouriteChange} />
      </div>
    </div>
  );
}

export function UserCollectionsSection({ liveBackendEnabled }: { liveBackendEnabled: boolean }) {
  const { t, i18n } = useLingui();
  const auth = useAuth();
  const navigate = useNavigate();
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<UserCollectionSort>("recent");
  const [keys, setKeys] = useState<string>("");
  const [tag, setTag] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<UserCollectionsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(queryInput.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    if (!liveBackendEnabled) {
      setResult(EMPTY_USER_COLLECTIONS_LIST);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchUserMapCollections({
      data: {
        q: query,
        sort,
        keys,
        tag,
        owner: scope === "mine" ? auth.viewer?.id ?? 0 : 0,
        favourited: scope === "favourites",
        page,
      },
    })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch(() => {
        if (!cancelled) setResult(EMPTY_USER_COLLECTIONS_LIST);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, sort, keys, tag, scope, page, reloadToken, liveBackendEnabled, auth.viewer?.id]);

  const patchCollection = useCallback((id: string, patch: Partial<UserMapCollectionSummary>) => {
    setResult((current) =>
      current
        ? { ...current, collections: current.collections.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }
        : current,
    );
  }, []);

  const collections = result?.collections ?? [];
  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? EMPTY_USER_COLLECTIONS_LIST.pageSize;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" aria-hidden="true" />
          <input
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder={t`Search collections`}
            className="w-full rounded-lg bg-osu-b4 py-2 pl-8 pr-3 text-[13px] text-osu-l1 outline-none ring-1 ring-white/5 placeholder:text-osu-f1/60 focus:ring-osu-pink/40"
          />
        </div>
        {auth.viewer && (
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            aria-label={t`New collection`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-osu-pink/25 px-2.5 py-2 text-[12px] font-bold text-osu-pink-light transition-colors cursor-pointer hover:bg-osu-pink/35 sm:px-3"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {/* The label is the first thing a narrow screen can spare. */}
            <span className="hidden sm:inline"><Trans>New collection</Trans></span>
          </button>
        )}
      </div>

      {/* Bleeding to the screen edge on a phone is what makes the scroll read
          as a scroll: a row that stops short of the edge looks like it ended. */}
      <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 scrollbar-hide sm:mx-0 sm:flex-wrap sm:px-0">
        <FilterGroup<UserCollectionSort>
          options={SORTS.map((option) => option.id)}
          value={sort}
          onChange={(next) => {
            setSort(next);
            setPage(0);
          }}
          render={(option) => i18n._(SORTS.find((entry) => entry.id === option)?.label ?? SORTS[0].label)}
        />
        <FilterGroup
          options={KEY_FILTERS}
          value={keys}
          onChange={(next) => {
            setKeys(next);
            setPage(0);
          }}
          render={(option) => (option === "" ? t`Any` : option === "other" ? t`Other` : option.toUpperCase())}
        />
        {auth.viewer && (
          <FilterGroup<Scope>
            options={["all", "mine", "favourites"]}
            value={scope}
            onChange={(next) => {
              setScope(next);
              setPage(0);
            }}
            render={(option) => (option === "all" ? t`Everyone` : option === "mine" ? t`Mine` : t`Liked`)}
          />
        )}
      </div>

      {(result?.facets.tags.length ?? 0) > 0 && (
        <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 scrollbar-hide sm:mx-0 sm:flex-wrap sm:px-0">
          {result?.facets.tags.map((facet) => (
            <button
              key={facet.value}
              type="button"
              onClick={() => {
                setTag(tag === facet.value ? "" : facet.value);
                setPage(0);
              }}
              aria-pressed={tag === facet.value}
              className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                tag === facet.value ? "bg-osu-pink/25 text-osu-pink-light" : "bg-osu-b4/70 text-osu-f1 hover:text-osu-l2"
              }`}
            >
              {facet.value} <span className="opacity-60">{formatNumber(facet.count)}</span>
            </button>
          ))}
        </div>
      )}

      {!liveBackendEnabled ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">{t`Collections are unavailable right now. Try again in a bit.`}</div>
      ) : loading && !result ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">{t`Loading collections...`}</div>
      ) : collections.length === 0 ? (
        <div className="py-16 text-center text-[13px] text-osu-f1">
          {scope === "mine"
            ? t`You haven't posted a collection yet.`
            : scope === "favourites"
              ? t`You haven't liked a collection yet.`
              : t`No collections here yet. Post the first one.`}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
            {collections.map((collection) => (
              <CollectionTile
                key={collection.id}
                collection={collection}
                onFavouriteChange={(favourited, favouriteCount) => patchCollection(collection.id, { favourited, favouriteCount })}
              />
            ))}
          </div>
          {lastPage > 0 && (
            <div className="flex items-center justify-center gap-3 pt-2 text-[12px] text-osu-f1">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0}
                className="rounded-lg bg-osu-b4 px-3 py-1.5 font-semibold transition-colors cursor-pointer hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trans>Previous</Trans>
              </button>
              <span>
                <Trans>Page {page + 1} of {lastPage + 1}</Trans>
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
                disabled={page >= lastPage}
                className="rounded-lg bg-osu-b4 px-3 py-1.5 font-semibold transition-colors cursor-pointer hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trans>Next</Trans>
              </button>
            </div>
          )}
        </>
      )}

      <UserCollectionEditor
        open={editorOpen}
        editing={null}
        onClose={() => setEditorOpen(false)}
        onSaved={(saved) => {
          setEditorOpen(false);
          // Straight to the new collection's own page, which is also the link
          // the author is about to want to share.
          if (saved.ok) void navigate({ to: collectionPath(saved.collection) });
          else setReloadToken((token) => token + 1);
        }}
      />
    </div>
  );
}
