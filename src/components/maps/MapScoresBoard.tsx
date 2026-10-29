import { useEffect, useMemo, useState } from "react";
import { Plural, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { fetchLiveMapScores, type LiveMapScoreEntry, type LiveMapScoresSnapshot, type LiveMapSearchEntry } from "../../lib/live-backend";
import { formatAccuracy, formatTimeAgo, formatTimeAgoTooltip } from "../../lib/format";
import { getManiaGradeFromAccuracy } from "../../lib/score";
import { useLocale } from "../../lib/locale-context";
import { useAuth } from "../../lib/auth-context";
import { displayCountryName } from "../../lib/country";
import { forgetMyFriends, getMyFriendSync, getMyFriendsMapScores, type FriendSync } from "../../lib/map-friends";
import type { OsuScore } from "../../lib/types";
import { Avatar } from "../ui/Avatar";
import { ScoreVideoMark, VideoMark } from "../ui/CompanellaMark";
import { CountryFlag } from "../ui/CountryFlag";
import { GradeImg } from "../ui/GradeImg";
import { ModBadge } from "../ui/ModBadge";
import { SelectMenu, type SelectMenuOption } from "../ui/SelectMenu";
import { FriendsLoadButton } from "./FriendsLoadButton";
import { Skeleton } from "../ui/LoadingSkeleton";
import { UsernameText } from "../ui/UsernameText";

// Keyed by beatmap and viewer, so switching diffs back and forth stays warm.
// Kept a minute, like the endpoint's own cache.
const BOARD_CACHE_TTL_MS = 60_000;
const boardCache = new Map<string, { snapshot: LiveMapScoresSnapshot; at: number }>();

function cachedBoard(key: string): LiveMapScoresSnapshot | null {
  const hit = boardCache.get(key);
  return hit && Date.now() - hit.at < BOARD_CACHE_TTL_MS ? hit.snapshot : null;
}

// The picker's Friends entry; country codes are two letters, so this never collides.
const FRIENDS = "@friends";
// The map whose Friends board to open on return from the friends sign-in.
const FRIENDS_RETURN_KEY = "mh-map-scores-friends";

/** The map a friends sign-in left from, which its modal opens on the Scores tab. */
export function pendingFriendsBoard(): number {
  if (typeof window === "undefined") return 0;
  try {
    return Number(window.sessionStorage.getItem(FRIENDS_RETURN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function clearFriendBoards(): void {
  for (const key of boardCache.keys()) if (key.includes(`:${FRIENDS}:`)) boardCache.delete(key);
}

/** A board row as the score the play card reads. */
export function mapScoreEntryScore(entry: LiveMapScoreEntry, map: LiveMapSearchEntry): OsuScore {
  return {
    id: entry.soloScoreId ?? entry.scoreId,
    type: "solo_score",
    user_id: entry.user.id,
    user: { id: entry.user.id, username: entry.user.username, avatar_url: entry.user.avatar_url, country_code: entry.user.country_code },
    accuracy: entry.accuracy,
    mods: entry.mods.map((acronym) => ({ acronym })),
    score: entry.totalScore ?? 0,
    total_score: entry.totalScore ?? 0,
    // An app import has no osu! score id: its mark carries the import, which
    // the play card shares and opens the replay of.
    ...(entry.companella
      ? { companella: entry.companella, ...(entry.isLazer ? {} : { legacy_total_score: entry.totalScore ?? 0 }) }
      : entry.isLazer ? {} : { legacy_score_id: entry.scoreId, legacy_total_score: entry.totalScore ?? 0 }),
    pp: entry.pp,
    rank: entry.grade,
    passed: true,
    // Unknown stays unknown: the card shows a dash rather than 0x.
    max_combo: entry.maxCombo ?? undefined,
    statistics: entry.statistics ?? {},
    has_replay: entry.hasReplay,
    ended_at: entry.playedAt ?? "",
    created_at: entry.playedAt ?? "",
    beatmap: { id: map.beatmapId, beatmapset_id: map.beatmapsetId, version: map.version, difficulty_rating: map.stars, cs: map.keyCount, mode: "mania" },
    beatmapset: { id: map.beatmapsetId, title: map.title, artist: map.artist, creator: map.creator, covers: map.covers ?? {} },
  } as unknown as OsuScore;
}

/** The top tracked plays on one chart, ranked by lazer accuracy. */
export function MapScoresBoard({ beatmapId, onOpen }: { beatmapId: number; onOpen: (entry: LiveMapScoreEntry) => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  const viewer = useAuth().viewer;
  const viewerId = viewer?.id ?? null;
  const viewerCountry = viewer?.countryCode ?? null;
  // Back from the friends sign-in, which opens straight on the Friends board.
  const [returning] = useState(() => viewerId != null && pendingFriendsBoard() === beatmapId);
  const [country, setCountry] = useState(returning ? FRIENDS : "");
  // undefined until read; null when the viewer has not loaded their friends.
  const [friendSync, setFriendSync] = useState<FriendSync | null | undefined>(undefined);
  const [friendsBusy, setFriendsBusy] = useState(false);
  const [queryInput, setQueryInput] = useState("");
  const [name, setName] = useState("");
  const cacheKey = `${beatmapId}:${viewerId ?? ""}:${country}:${name}`;
  // Tagged with its filters: a new filter keeps the old rows up until its own arrive.
  const [loaded, setLoaded] = useState<{ key: string; snapshot: LiveMapScoresSnapshot } | null>(() => {
    const snapshot = cachedBoard(cacheKey);
    return snapshot ? { key: cacheKey, snapshot } : null;
  });
  const board = loaded?.snapshot ?? null;
  const current = loaded?.key === cacheKey;
  // The country list comes with the unfiltered board and stays while a filter is on.
  const [countries, setCountries] = useState<Array<{ code: string; count: number }>>(() => cachedBoard(cacheKey)?.countries ?? []);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (pendingFriendsBoard() === beatmapId) {
      try {
        window.sessionStorage.removeItem(FRIENDS_RETURN_KEY);
      } catch {
        // Private mode: the flag only picks the opening tab.
      }
    }
    if (!viewerId) return;
    let cancelled = false;
    getMyFriendSync()
      .then((sync) => {
        if (!cancelled) setFriendSync(sync);
      })
      .catch(() => {
        if (!cancelled) setFriendSync(null);
      });
    return () => {
      cancelled = true;
    };
  }, [beatmapId, viewerId]);

  const friends = country === FRIENDS;
  const fetchPage = (offset: number) => friends
    ? getMyFriendsMapScores({ data: { beatmapId, offset, name } })
    : fetchLiveMapScores(beatmapId, viewerId, { offset, country, name });

  useEffect(() => {
    const timer = setTimeout(() => setName(queryInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    const cached = cachedBoard(cacheKey);
    setError(false);
    setLoadingMore(false);
    if (cached) {
      setLoaded({ key: cacheKey, snapshot: cached });
      if (cached.countries) setCountries(cached.countries);
      return;
    }
    // The friends board waits for the list; without one it is the sign-in note.
    if (friends && !friendSync) return;
    let cancelled = false;
    fetchPage(0)
      .then((snapshot) => {
        boardCache.set(cacheKey, { snapshot, at: Date.now() });
        if (cancelled) return;
        setLoaded({ key: cacheKey, snapshot });
        if (snapshot.countries) setCountries(snapshot.countries);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
    // fetchPage reads only the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatmapId, cacheKey, viewerId, country, name, friendSync]);

  // A board opened on a filter (back from the friends sign-in) still needs the
  // country list, which only the unfiltered board carries; it also warms that board.
  const needCountries = countries.length === 0 && (country !== "" || name !== "");
  useEffect(() => {
    if (!needCountries) return;
    const key = `${beatmapId}:${viewerId ?? ""}::`;
    const cached = cachedBoard(key);
    if (cached?.countries) {
      setCountries(cached.countries);
      return;
    }
    let cancelled = false;
    fetchLiveMapScores(beatmapId, viewerId)
      .then((snapshot) => {
        boardCache.set(key, { snapshot, at: Date.now() });
        if (!cancelled && snapshot.countries) setCountries(snapshot.countries);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [needCountries, beatmapId, viewerId]);

  // The viewer's own country sits right under "All countries", lifted out of the count order.
  const countryOptions = useMemo<SelectMenuOption<string>[]>(() => {
    const own = countries.find(({ code }) => code === viewerCountry);
    return [
      { value: "", label: t`All countries` },
      ...(viewerId ? [{ value: FRIENDS, label: t`Friends` }] : []),
      ...[...(own ? [own] : []), ...countries.filter((entry) => entry !== own)].map(({ code, count }) => ({
        value: code,
        label: `${displayCountryName(code, locale)} (${count})`,
        leading: <CountryFlag code={code} size="sm" decorative />,
      })),
    ];
  }, [countries, viewerCountry, viewerId, locale, t]);

  const loadMore = () => {
    if (!board || !current || loadingMore) return;
    const key = cacheKey;
    setLoadingMore(true);
    fetchPage(board.entries.length)
      .then((page) => {
        // The board can shift between pages; a player who moved keeps one row.
        const seen = new Set(board.entries.map((entry) => entry.user.id));
        const fresh = page.entries.filter((entry) => !seen.has(entry.user.id));
        const entries = [...board.entries, ...fresh];
        // A page with nothing new is the end, also past the deepest offset the endpoint reads.
        const next = { ...board, entries, total: fresh.length > 0 ? page.total : entries.length };
        boardCache.set(key, { snapshot: next, at: Date.now() });
        setLoaded((held) => (held?.snapshot === board ? { key, snapshot: next } : held));
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  const startFriendsSignIn = () => {
    try {
      window.sessionStorage.setItem(FRIENDS_RETURN_KEY, String(beatmapId));
    } catch {
      // Without it the return lands on the map's info tab.
    }
    window.location.assign(`/api/auth/osu?friends=1&next=${encodeURIComponent(`/maps?map=${beatmapId}`)}`);
  };

  const forgetFriends = () => {
    setFriendsBusy(true);
    forgetMyFriends()
      .then((ok) => {
        if (!ok) return;
        clearFriendBoards();
        setFriendSync(null);
        setCountry("");
      })
      .catch(() => {})
      .finally(() => setFriendsBusy(false));
  };

  const filtered = country !== "" || name !== "";
  // Up from the first frame, so the search row never pops in; only a board
  // known to be empty goes without it.
  const emptyBoard = current && board != null && board.entries.length === 0 && !filtered;
  const controls = !emptyBoard ? (
    <div className="mb-2 flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" aria-hidden="true" />
        <input
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          placeholder={t`Search players`}
          maxLength={32}
          className="w-full rounded-lg bg-osu-b4 py-1.5 pl-8 pr-3 text-[13px] text-osu-l1 outline-none ring-1 ring-white/5 placeholder:text-osu-f1/60 focus:ring-osu-pink/40"
        />
      </div>
      {countries.length > 1 || viewerId || !board ? (
        <SelectMenu
          value={country}
          options={countryOptions}
          onChange={setCountry}
          ariaLabel={t`Country`}
          align="right"
          searchable
          searchPlaceholder={t`Search countries`}
        />
      ) : null}
    </div>
  ) : null;

  const reloadAt = friendSync ? friendSync.nextSyncAt : 0;
  const friendsLine = friends && friendSync ? (
    <div className="mb-2 flex items-center gap-2.5 text-[11px] text-osu-f1">
      <span><Plural value={friendSync.count} one="# friend loaded" other="# friends loaded" /></span>
      <span className="h-3 w-px bg-white/[0.12]" aria-hidden="true" />
      <button
        type="button"
        onClick={startFriendsSignIn}
        disabled={Date.now() < reloadAt}
        title={Date.now() < reloadAt ? t`You can reload your friends again in a few minutes.` : undefined}
        className="font-semibold text-osu-pink-light transition-colors hover:text-white disabled:text-osu-f1/60"
      >
        {t`Reload`}
      </button>
      <span className="h-3 w-px bg-white/[0.12]" aria-hidden="true" />
      <button
        type="button"
        onClick={forgetFriends}
        disabled={friendsBusy}
        className="font-semibold text-osu-f1 transition-colors hover:text-white"
      >
        {t`Forget friends`}
      </button>
    </div>
  ) : null;

  const friendsMissing = friends && friendSync === null;

  return (
    <div className="flex flex-col">
      {controls}
      {friendsLine}
      {friendsMissing ? (
        <div className="flex flex-col items-center gap-2 py-6 text-[11.5px] text-osu-f1">
          {/* Back from the sign-in without a list: osu! refused or the read failed. */}
          {returning ? <span>{t`Could not load your friends.`}</span> : null}
          <FriendsLoadButton label={t`Load your osu! friends`} onClick={startFriendsSignIn} />
        </div>
      ) : (
      <div className={board && !current ? "opacity-60 transition-opacity" : "transition-opacity"}>
        <MapScoresList
          board={board}
          error={error}
          filtered={filtered}
          viewerId={viewerId}
          loadingMore={loadingMore || !current}
          onLoadMore={loadMore}
          onOpen={onOpen}
        />
      </div>
      )}
    </div>
  );
}

function MapScoresList({
  board,
  error,
  filtered,
  viewerId,
  loadingMore,
  onLoadMore,
  onOpen,
}: {
  board: LiveMapScoresSnapshot | null;
  error: boolean;
  filtered: boolean;
  viewerId: number | null;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (entry: LiveMapScoreEntry) => void;
}) {
  const { t } = useLingui();
  if (error) return <span className="text-[11.5px] text-osu-f1">{t`Could not load the scores.`}</span>;
  if (!board) {
    return (
      // As tall as the card allows, like a loaded board, so the centered card
      // does not shrink and jump for the frames before the scores arrive.
      <div className="flex min-h-[100dvh] flex-col overflow-hidden" aria-busy="true">
        {Array.from({ length: 24 }, (_, index) => (
          <div key={index} className="flex items-center gap-2.5 border-t border-white/[0.07] py-2 first:border-t-0">
            <Skeleton className="h-3 w-5" />
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="ml-auto h-3.5 w-14" />
          </div>
        ))}
      </div>
    );
  }
  if (board.entries.length === 0) {
    return (
      <span className="text-[11.5px] text-osu-f1">
        {filtered ? t`No tracked plays match.` : t`No tracked plays on this difficulty yet.`}
      </span>
    );
  }

  return (
    <div className="flex flex-col">
      {board.entries.map((entry) => (
        <MapScoreRow key={entry.user.id} entry={entry} own={entry.user.id === viewerId} onOpen={onOpen} />
      ))}
      {board.entries.length < board.total ? (
        <div className="flex justify-center border-t border-white/[0.07] pt-2">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="rounded px-3 py-1 text-[12px] font-semibold text-osu-pink-light transition-colors hover:text-white disabled:text-osu-f1"
          >
            {loadingMore ? t`Loading...` : t`Load more`}
          </button>
        </div>
      ) : null}
      {board.self && !board.entries.some((entry) => entry.user.id === board.self?.user.id) ? (
        <div className="mt-1 border-t border-white/[0.07] pt-1">
          <MapScoreRow entry={board.self} own onOpen={onOpen} />
        </div>
      ) : null}
    </div>
  );
}

function MapScoreRow({ entry, own, onOpen }: { entry: LiveMapScoreEntry; own: boolean; onOpen: (entry: LiveMapScoreEntry) => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  // The grade follows the accuracy shown, so a stable SS with 300s reads as the S it is on this scale.
  const grade = getManiaGradeFromAccuracy(entry.accuracy, entry.mods.map((acronym) => ({ acronym }))) ?? entry.grade;
  return (
    // A div, not a button, so the player's name can be a link inside it.
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onOpen(entry);
      }}
      title={t`Open ${entry.user.username}'s play`}
      className={`grid cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded border-t border-white/[0.07] py-1.5 pr-1.5 text-left first:border-t-0 hover:bg-white/[0.03] sm:grid-cols-[1.75rem_minmax(0,1fr)_auto_4.5rem] ${own ? "bg-osu-pink/10" : ""}`}
    >
      <span className={`text-right text-[11px] font-bold tabular-nums ${own ? "text-osu-pink-light" : "text-osu-f1"}`}>#{entry.position}</span>
      <span className="flex min-w-0 items-center gap-2">
        <Link
          to="/player/$username"
          params={{ username: entry.user.username }}
          onClick={(event) => event.stopPropagation()}
          title={t`View profile`}
          className="flex min-w-0 items-center gap-2 hover:brightness-110"
        >
          <Avatar url={entry.user.avatar_url} size={24} />
          <CountryFlag code={entry.user.country_code} size="xs" decorative />
          <UsernameText
            username={entry.user.username}
            avatarUrl={entry.user.avatar_url}
            accent={entry.user.avatar_accent}
            className="truncate text-[12.5px] font-semibold text-white hover:underline"
          />
        </Link>
        {entry.companella ? (entry.companella.video ? <VideoMark video={entry.companella.video} className="h-[15px] w-[15px]" /> : null)
          : <ScoreVideoMark ids={[entry.soloScoreId, entry.scoreId]} className="h-[15px] w-[15px]" />}
        {entry.mods.map((mod) => (
          <ModBadge key={mod} mod={mod} size={0.55} />
        ))}
      </span>
      <span className="flex items-center gap-2">
        <GradeImg grade={grade} size={20} />
        <span className="w-[4.25rem] text-right text-[14px] font-bold tabular-nums text-white">{formatAccuracy(entry.accuracy)}</span>
      </span>
      <span
        className="hidden text-right text-[11px] text-osu-f1 sm:block"
        title={entry.playedAt ? formatTimeAgoTooltip(entry.playedAt, locale) : undefined}
      >
        {entry.playedAt ? formatTimeAgo(entry.playedAt, locale) : ""}
      </span>
    </div>
  );
}
