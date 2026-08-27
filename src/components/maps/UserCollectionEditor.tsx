import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, ChevronUp, Disc3, Layers, ListMusic, Loader2, Plus, Search, X } from "lucide-react";
import { fetchLiveMapSearch, type LiveMapSearchEntry, type LiveMapSearchParams } from "../../lib/live-backend";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";
import {
  USER_COLLECTION_DESCRIPTION_MAX_LENGTH,
  USER_COLLECTION_MAX_ITEMS,
  USER_COLLECTION_MAX_TAGS,
  USER_COLLECTION_MIN_ITEMS,
  USER_COLLECTION_TITLE_MAX_LENGTH,
  createMapCollection,
  normalizeUserCollectionTag,
  updateMapCollection,
  type UserCollectionWriteResult,
  type UserMapCollectionDetail,
} from "../../lib/user-map-collections";
import { formatNumber } from "../../lib/format";
import { mapCoverUrl } from "./SearchCard";
import { starRatingColor } from "../ui/StarRating";

/*
 * The build-a-collection form: title, a few words, tags, and the map list.
 *
 * Maps are picked out of the same catalog the Search tab reads, one diff at a
 * time. The search here deliberately returns one row per beatmapset with its
 * diffs listed under it, exactly as the search endpoint answers, because a
 * collection is about which chart you meant rather than which song: adding
 * "the 4K Insane" and "the 7K Another" of one set are two different picks.
 *
 * Nothing is written until Save. The list is local state until then, so
 * reordering and second thoughts cost no round trips, and a failed save leaves
 * the form exactly as it was rather than half-applied.
 */

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PAGE_SIZE = 12;

/*
 * A pasted osu! link is understood by the search endpoint itself (any of the
 * /beatmapsets/, /b/, /s/ spellings, with or without the difficulty fragment),
 * so it needs nothing here. A bare number does not: the endpoint reads it as a
 * search term and finds a song called "1234567". These queries turn it into the
 * endpoint's own id token, difficulty first and then the set, and only fall
 * back to the plain text search when neither matched - a number that really is
 * a song title still finds it, one round trip later.
 */
function idQueryLadder(query: string): string[] {
  return /^\d{4,10}$/.test(query) ? [`id=${query}`, `set=${query}`, query] : [query];
}

async function searchPickerMaps(query: string): Promise<LiveMapSearchEntry[]> {
  for (const attempt of idQueryLadder(query)) {
    const result = await fetchLiveMapSearch(emptySearchParams(attempt));
    if (result.items.length > 0) return result.items;
  }
  return [];
}

function emptySearchParams(query: string): LiveMapSearchParams {
  return {
    q: query,
    keys: [],
    keysExclude: [],
    statuses: [],
    statusesExclude: [],
    patterns: [],
    patternsExclude: [],
    starMin: null,
    starMax: null,
    bpmMin: null,
    bpmMax: null,
    lenMin: null,
    lenMax: null,
    danMin: null,
    danMax: null,
    country: null,
    sort: "playcount",
    dir: "desc",
    page: 0,
    pageSize: SEARCH_PAGE_SIZE,
  };
}

/** The set row's diffs, or the row itself for a set with a single one. */
function entryDiffs(entry: LiveMapSearchEntry): LiveMapSearchEntry[] {
  return entry.diffs && entry.diffs.length > 0 ? entry.diffs : [entry];
}

/* One chart already in the collection. Cover art on the left so the list reads
   as the maps rather than as a table of names, its star colour on the pill, and
   the reorder/remove controls only on hover so a long list stays calm. */
function MapRow({
  entry,
  index,
  total,
  onRemove,
  onMove,
}: {
  entry: LiveMapSearchEntry;
  index: number;
  total: number;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const { t } = useLingui();
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
      className="group relative flex shrink-0 items-center gap-2 overflow-hidden rounded-lg bg-osu-b4/70 pr-1.5 ring-1 ring-white/5"
    >
      <div
        className="relative h-11 w-16 shrink-0 bg-osu-b3/60 bg-cover bg-center"
        style={{ backgroundImage: `url(${mapCoverUrl(entry)})` }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-black/45 to-osu-b4/80" />
        <span className="absolute inset-0 grid place-items-center text-[11px] font-extrabold text-white/90 drop-shadow">
          {index + 1}
        </span>
      </div>
      <div className="min-w-0 flex-1 py-1">
        <div className="truncate text-[12.5px] font-semibold leading-tight text-osu-l1">{entry.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-osu-f1">
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-bold text-black"
            style={{ background: starRatingColor(entry.stars) }}
          >
            {entry.keyCount}K {entry.stars.toFixed(2)}
          </span>
          <span className="truncate">{entry.version}</span>
        </div>
      </div>
      {/* Focus-visible as well as hover: the controls are reachable by keyboard
          even while they are invisible to a pointer that has not arrived. */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={t`Move up`}
          className="grid h-6 w-6 place-items-center rounded text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          aria-label={t`Move down`}
          className="grid h-6 w-6 place-items-center rounded text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t`Remove from the collection`}
          className="grid h-6 w-6 place-items-center rounded text-osu-f1 transition-colors cursor-pointer hover:bg-osu-red/25 hover:text-osu-red"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </motion.li>
  );
}

/* One beatmapset in the picker: its own artwork as the card, the diffs as
   pills coloured by star rating. The pill is the add button, so picking a
   chart is one click on the thing you are looking at rather than a click on a
   row and then a click on a plus.

   "Add all" sits on the banner for the other way of thinking about it: plenty
   of people mean the mapset rather than one chart of it, and picking six diffs
   one at a time to say so is busywork. It adds every difficulty the search
   matched, which is the whole set unless a filter narrowed it. */
function ResultCard({
  entry,
  addedIds,
  full,
  onAdd,
  onAddAll,
}: {
  entry: LiveMapSearchEntry;
  addedIds: Set<number>;
  full: boolean;
  onAdd: (diff: LiveMapSearchEntry) => void;
  onAddAll: (diffs: LiveMapSearchEntry[]) => void;
}) {
  const { t } = useLingui();
  const diffs = entryDiffs(entry);
  const missing = diffs.filter((diff) => !addedIds.has(diff.beatmapId));
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
      /* shrink-0 matters: these are flex children of a scrolling column, and
         without it a full result list squeezes every card down to a sliver. */
      className="shrink-0 overflow-hidden rounded-xl bg-osu-b4/80 ring-1 ring-white/5"
    >
      {/* The artwork is a banner strip with the song title on it rather than the
          card's whole background: over a full-bleed cover the pills below had
          to fight the art for contrast, and lost. */}
      <div className="relative h-[52px] w-full">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${mapCoverUrl(entry)})` }}
          aria-hidden="true"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/70 to-black/40" aria-hidden="true" />
        <div className="relative flex h-full items-center gap-2 px-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-extrabold leading-tight text-white">{entry.title}</div>
            <div className="truncate text-[10.5px] text-white/70">
              {entry.artist} · {entry.creator}
            </div>
          </div>
          {diffs.length > 1 && (
            <button
              type="button"
              onClick={() => onAddAll(missing)}
              disabled={full || missing.length === 0}
              title={t`Add every difficulty of this mapset`}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10.5px] font-bold backdrop-blur-sm transition-transform ${
                full || missing.length === 0
                  ? "cursor-not-allowed bg-white/10 text-white/50"
                  : "cursor-pointer bg-white/15 text-white hover:scale-[1.04] hover:bg-osu-pink/40 active:scale-95"
              }`}
            >
              <Layers className="h-3 w-3" aria-hidden="true" />
              <Trans>Add all {diffs.length}</Trans>
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 p-2">
        {diffs.map((diff) => {
          const added = addedIds.has(diff.beatmapId);
          return (
            <button
              key={diff.beatmapId}
              type="button"
              onClick={() => onAdd(diff)}
              disabled={added || full}
              title={added ? t`Already in the collection` : diff.version}
              className={`inline-flex max-w-full items-center gap-1 rounded-full py-1 pl-1 pr-2 text-[10.5px] font-bold transition-transform ${
                added
                  ? "cursor-default bg-osu-b3/50 text-osu-f1"
                  : full
                    ? "cursor-not-allowed bg-osu-b3/50 text-osu-f1/60"
                    : "cursor-pointer bg-osu-b3/80 text-osu-l1 hover:scale-[1.04] hover:bg-osu-pink/25 hover:text-osu-pink-light active:scale-95"
              }`}
            >
              <span
                className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-black"
                style={{ background: added ? "#8f8fa6" : starRatingColor(diff.stars) }}
              >
                {added ? <Check className="h-2.5 w-2.5" strokeWidth={3.5} /> : <Plus className="h-2.5 w-2.5" strokeWidth={3.5} />}
              </span>
              <span className="shrink-0">{diff.keyCount}K</span>
              <span className="shrink-0 opacity-70">{diff.stars.toFixed(2)}★</span>
              <span className="truncate opacity-70">{diff.version}</span>
            </button>
          );
        })}
      </div>
    </motion.div>
  );
}

export function UserCollectionEditor({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The collection being edited, or null to post a new one. */
  editing: UserMapCollectionDetail | null;
  onClose: () => void;
  onSaved: (result: UserCollectionWriteResult) => void;
}) {
  const { t } = useLingui();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [items, setItems] = useState<LiveMapSearchEntry[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LiveMapSearchEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bodyLockActive, setBodyLockActive] = useState(false);
  useBodyScrollLock(bodyLockActive);

  // Reset to whatever is being edited every time the modal opens, so a closed
  // form never carries the last collection's maps into the next one.
  useEffect(() => {
    if (!open) return;
    setBodyLockActive(true);
    setTitle(editing?.title ?? "");
    setDescription(editing?.description ?? "");
    setTags(editing?.tags ?? []);
    setTagDraft("");
    setItems(editing?.items ?? []);
    setQuery("");
    setResults(null);
    setError(null);
  }, [open, editing]);

  const itemIds = useMemo(() => new Set(items.map((entry) => entry.beatmapId)), [items]);
  const enoughMaps = items.length >= USER_COLLECTION_MIN_ITEMS;

  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!open || trimmedQuery.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchPickerMaps(trimmedQuery)
        .then((items) => {
          if (cancelled) return;
          setResults(items);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, trimmedQuery]);

  const addMap = useCallback((entry: LiveMapSearchEntry) => {
    setItems((current) => {
      if (current.length >= USER_COLLECTION_MAX_ITEMS) return current;
      if (current.some((item) => item.beatmapId === entry.beatmapId)) return current;
      return [...current, entry];
    });
  }, []);

  /* A whole mapset at once. Easiest first, since that is the order a set is
     played in, and the cap truncates rather than refusing: adding eight diffs
     with four slots left should leave the four, not nothing. */
  const addMaps = useCallback((entries: LiveMapSearchEntry[]) => {
    setItems((current) => {
      const have = new Set(current.map((item) => item.beatmapId));
      const room = USER_COLLECTION_MAX_ITEMS - current.length;
      if (room <= 0) return current;
      const fresh = entries
        .filter((entry) => !have.has(entry.beatmapId))
        .sort((a, b) => a.stars - b.stars)
        .slice(0, room);
      return fresh.length === 0 ? current : [...current, ...fresh];
    });
  }, []);

  const moveMap = useCallback((index: number, delta: number) => {
    setItems((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const commitTag = useCallback(() => {
    const tag = normalizeUserCollectionTag(tagDraft);
    setTagDraft("");
    if (!tag) return;
    setTags((current) => (current.includes(tag) || current.length >= USER_COLLECTION_MAX_TAGS ? current : [...current, tag]));
  }, [tagDraft]);

  const handleSave = async () => {
    if (saving) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError(t`Give the collection a title.`);
      return;
    }
    if (items.length < USER_COLLECTION_MIN_ITEMS) {
      setError(t`Add at least ${USER_COLLECTION_MIN_ITEMS} maps before posting.`);
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      title: cleanTitle,
      description,
      tags,
      beatmapIds: items.map((entry) => entry.beatmapId),
    };
    try {
      const result = editing
        ? await updateMapCollection({ data: { id: editing.id, ...payload } })
        : await createMapCollection({ data: payload });
      if (!result.ok) {
        setError(
          result.error === "limit_reached"
            ? t`You already have the maximum number of collections.`
            : result.error === "too_few_maps"
              ? t`Add at least ${USER_COLLECTION_MIN_ITEMS} maps before posting.`
              : result.error === "no_access"
                ? t`Sign in to post a collection.`
                : t`Couldn't save the collection.`,
        );
        return;
      }
      onSaved(result);
    } catch {
      setError(t`Couldn't save the collection.`);
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    if (saving) return;
    onClose();
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => setBodyLockActive(false)}>
      {open && (
        <motion.div
          key="collection-editor"
          className="fixed inset-0 z-[120] flex items-center justify-center py-3 pl-3 sm:py-6 sm:pl-6 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:pr-[calc(1.5rem+var(--modal-scrollbar-compensation,0px))]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/85" onClick={dismiss} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={editing ? t`Edit collection` : t`New collection`}
            className="modal-card-mobile-safe relative isolate z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[880px] flex-col overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-osu-b3/30 px-4 py-3 sm:px-5">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-osu-pink-light">
                {editing ? <Trans>edit collection</Trans> : <Trans>new collection</Trans>}
              </span>
              <button
                type="button"
                onClick={dismiss}
                aria-label={t`Close`}
                className="grid h-7 w-7 place-items-center rounded-full text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/50 hover:text-white"
              >
                <X className="h-4 w-4" strokeWidth={2.4} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-osu-f1" htmlFor="collection-title">
                    <Trans>Title</Trans>
                  </label>
                  <input
                    id="collection-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value.slice(0, USER_COLLECTION_TITLE_MAX_LENGTH))}
                    className="w-full rounded-lg bg-osu-b4 px-3 py-2 text-[13px] text-osu-l1 outline-none ring-1 ring-white/5 placeholder:text-osu-f1/60 focus:ring-osu-pink/40"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-osu-f1" htmlFor="collection-description">
                    <Trans>Description <span className="normal-case tracking-normal text-osu-f1/70">(optional)</span></Trans>
                  </label>
                  <textarea
                    id="collection-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value.slice(0, USER_COLLECTION_DESCRIPTION_MAX_LENGTH))}
                    rows={3}
                    className="w-full resize-y rounded-lg bg-osu-b4 px-3 py-2 text-[13px] text-osu-l1 outline-none ring-1 ring-white/5 placeholder:text-osu-f1/60 focus:ring-osu-pink/40"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-osu-f1" htmlFor="collection-tags">
                    <Trans>Tags</Trans>
                  </label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {tags.map((tag) => (
                      <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-osu-pink/20 px-2.5 py-1 text-[11px] font-semibold text-osu-pink-light">
                        {tag}
                        <button
                          type="button"
                          onClick={() => setTags((current) => current.filter((entry) => entry !== tag))}
                          aria-label={t`Remove tag`}
                          className="cursor-pointer text-osu-pink-light/70 hover:text-white"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    {tags.length < USER_COLLECTION_MAX_TAGS && (
                      <input
                        id="collection-tags"
                        value={tagDraft}
                        onChange={(event) => setTagDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === ",") {
                            event.preventDefault();
                            commitTag();
                          }
                        }}
                        onBlur={commitTag}
                        placeholder={t`jumpstream, warmup, ...`}
                        className="min-w-[160px] flex-1 rounded-lg bg-osu-b4 px-3 py-1.5 text-[12px] text-osu-l1 outline-none ring-1 ring-white/5 placeholder:text-osu-f1/60 focus:ring-osu-pink/40"
                      />
                    )}
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  {/* The list, in the order it will be shown. */}
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-osu-f1"><Trans>Maps</Trans></span>
                      <span className="text-[11px] tabular-nums text-osu-f1">
                        {formatNumber(items.length)} / {formatNumber(USER_COLLECTION_MAX_ITEMS)}
                      </span>
                    </div>
                    {/* How full the collection is, as a bar rather than only a
                        ratio: the cap matters most exactly when it is close. */}
                    <div className="h-1 overflow-hidden rounded-full bg-osu-b4">
                      <motion.div
                        className="h-full rounded-full bg-osu-pink/70"
                        // A width-only animate() starts from the element's own
                        // width, which is the full track; `initial={false}`
                        // puts it at the real value on mount instead.
                        initial={false}
                        animate={{ width: `${Math.min(100, (items.length / USER_COLLECTION_MAX_ITEMS) * 100)}%` }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                      />
                    </div>
                    {items.length === 0 ? (
                      <div className="flex flex-col items-center gap-1.5 rounded-xl bg-osu-b4/40 px-3 py-10 text-center ring-1 ring-white/5">
                        <ListMusic className="h-6 w-6 text-osu-f1/60" aria-hidden="true" />
                        <p className="text-[12px] text-osu-f1"><Trans>Nothing in here yet</Trans></p>
                        <p className="text-[11px] text-osu-f1/70"><Trans>Search on the right, then tap a difficulty to drop it in. Three maps minimum</Trans></p>
                      </div>
                    ) : (
                      <ul className="flex max-h-[340px] flex-col gap-1 overflow-y-auto pr-1">
                        <AnimatePresence initial={false}>
                          {items.map((entry, index) => (
                            <MapRow
                              key={entry.beatmapId}
                              entry={entry}
                              index={index}
                              total={items.length}
                              onRemove={() => setItems((current) => current.filter((item) => item.beatmapId !== entry.beatmapId))}
                              onMove={(delta) => moveMap(index, delta)}
                            />
                          ))}
                        </AnimatePresence>
                      </ul>
                    )}
                  </div>

                  {/* The picker. */}
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-osu-f1"><Trans>Add maps</Trans></span>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" aria-hidden="true" />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t`Song, artist or mapper`}
                        className="w-full rounded-lg bg-osu-b4 py-2 pl-8 pr-3 text-[13px] text-osu-l1 outline-none ring-1 ring-white/5 placeholder:text-osu-f1/60 focus:ring-osu-pink/40"
                      />
                      {searching && (
                        <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-osu-pink-light" aria-hidden="true" />
                      )}
                    </div>
                    <div className="flex max-h-[340px] flex-col gap-2 overflow-y-auto pr-1">
                      {results == null && !searching && (
                        <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
                          <Disc3 className="h-6 w-6 text-osu-f1/60" aria-hidden="true" />
                          <p className="text-[12px] text-osu-f1"><Trans>Search the whole mania catalog</Trans></p>
                        </div>
                      )}
                      {results?.length === 0 && !searching && (
                        <p className="py-10 text-center text-[12px] text-osu-f1"><Trans>Nothing matched that</Trans></p>
                      )}
                      <AnimatePresence initial={false}>
                        {results?.map((entry) => (
                          <ResultCard
                            key={entry.beatmapsetId || entry.beatmapId}
                            entry={entry}
                            addedIds={itemIds}
                            full={items.length >= USER_COLLECTION_MAX_ITEMS}
                            onAdd={addMap}
                            onAddAll={addMaps}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>

                {error && <p className="text-[12px] font-semibold text-osu-red">{error}</p>}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-osu-b3/30 px-4 py-3 sm:px-5">
              {!enoughMaps && (
                <span className="mr-auto text-[11px] text-osu-f1">
                  <Trans>{USER_COLLECTION_MIN_ITEMS} maps minimum</Trans>
                </span>
              )}
              <button
                type="button"
                onClick={dismiss}
                disabled={saving}
                className="rounded-lg px-3 py-1.5 text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trans>Cancel</Trans>
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !enoughMaps}
                title={enoughMaps ? undefined : t`A collection needs at least ${USER_COLLECTION_MIN_ITEMS} maps`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-osu-pink/25 px-3.5 py-1.5 text-[12px] font-bold text-osu-pink-light transition-colors cursor-pointer hover:bg-osu-pink/35 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {editing ? <Trans>Save changes</Trans> : <Trans>Post collection</Trans>}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
