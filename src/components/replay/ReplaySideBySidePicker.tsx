import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { LoaderCircle, Plus, Search, Swords, X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";

import { avatarImageSrc } from "#/components/ui/Avatar";
import { CountryFlag } from "#/components/ui/CountryFlag";
import { GradeImg } from "#/components/ui/GradeImg";
import { ModBadge } from "#/components/ui/ModBadge";
import { useAuth } from "#/lib/auth-context";
import { formatAccuracy, formatPP, formatTimeAgo } from "#/lib/format";
import {
  fetchLiveMapsPlayersSnapshot,
  fetchLivePlayerCachedProfileSnapshotDirect,
  fetchLivePlayerReplayScoresDirect,
  isLiveBackendConfigured,
  LIVE_MAPS_PLAYERS_PAGE_SIZE,
  type LiveMapsDetailsPlayer,
} from "#/lib/live-backend";
import { getScore } from "#/lib/osu";
import { searchPlayers } from "#/lib/player-search";
import type { RecentReplayEntry } from "#/lib/replay-recent";
import { parseReplayScoreInput } from "#/lib/replay-score-input";
import { formatSideBySideIssue, getSideBySideCandidateIssue, getSideBySideIssue } from "#/lib/replay-side-by-side";
import { getDisplayedAccuracy, getDisplayedRank, getModDisplayList, getScoreTimestamp, scoreHasReplay } from "#/lib/score";
import type { OsuScore } from "#/lib/types";
import { useLocale } from "#/lib/locale-context";

/* Setup screen for the Side by Side tab: pick the two runs, then watch them on
   one clock. It is built as the matchup it produces, two cards facing each
   other in the colours the stages will use, so the screen reads as "these two"
   before anything is loaded.

   One card is active at a time and one search box fills it, because the ways
   people arrive here don't deserve a control each: type a name to browse that
   player's runs (the backend keeps their best scores plus replay-ready plays
   captured by the tracker, so nobody should have to go hunting for a score
   URL), paste a link you were
   sent, or take a row off the map the first pick locked in. Whatever is typed,
   the answer is a list of runs and picking one fills the active side. The pair
   rules live in replay-side-by-side.ts, so a row that can't work says why
   before it is clicked, not after. */

type SlotIndex = 0 | 1;
type SlotScores = [OsuScore | null, OsuScore | null];

const SLOT_META = [
  {
    label: msg`Left`,
    accent: "text-osu-pink-light",
    ring: "ring-osu-pink/45",
    border: "border-osu-pink/45",
    glow: "from-osu-pink/25",
  },
  {
    label: msg`Right`,
    accent: "text-osu-blue",
    ring: "ring-osu-blue/45",
    border: "border-osu-blue/45",
    glow: "from-osu-blue/25",
  },
] as const;

const PLAYER_SEARCH_DEBOUNCE_MS = 350;
const SCORE_LOOKUP_DEBOUNCE_MS = 300;
const PLAYER_SEARCH_MIN_LENGTH = 2;
const PLAYER_REPLAY_SCORES_PAGE_SIZE = 100;

interface PickerPlayer {
  id: number;
  username: string;
  avatar_url?: string;
  country_code?: string | null;
}

/* A run we know about from our own board rather than from osu!. The projection
   keeps who, what pp and which mod acronyms, but not the mod settings, so the
   rate a run was played at is not knowable from a row: that is why picking one
   resolves the score first (pickById) instead of trusting the row. */
interface BoardRun {
  scoreId: number;
  userId: number;
  username: string;
  avatarUrl: string;
  rank?: number;
  pp?: number;
  mods: string[];
  playedAt?: string | null;
}

function toBoardRuns(players: LiveMapsDetailsPlayer[]): BoardRun[] {
  return players.flatMap((player) => {
    const scoreId = player.scoreUrl ? parseReplayScoreInput(player.scoreUrl) : null;
    // A row with no score link can't be opened, so it is not offered.
    if (scoreId == null) return [];
    return [{
      scoreId,
      userId: player.id,
      username: player.username,
      avatarUrl: player.avatarUrl,
      rank: player.rank,
      pp: player.pp,
      mods: player.mods ?? [],
      playedAt: player.playedAt,
    }];
  });
}

export function ReplaySideBySidePicker({
  recentReplays,
  onStart,
}: {
  recentReplays: RecentReplayEntry[];
  onStart: (leftScoreId: number, rightScoreId: number) => void;
}) {
  const { t, i18n } = useLingui();
  const [slots, setSlots] = useState<SlotScores>([null, null]);
  // Which card the search fills. Clicking a card moves it, so replacing a run
  // is the same gesture as adding one.
  const [activeSlot, setActiveSlot] = useState<SlotIndex>(0);

  const [left, right] = slots;
  const anchor = left ?? right;
  const anchorBeatmapId = anchor?.beatmap?.id ?? null;
  const pairIssue = left && right ? getSideBySideIssue(left, right) : null;
  const canStart = Boolean(left && right && !pairIssue);
  const pickedIds = useMemo(
    () => new Set(slots.filter((score): score is OsuScore => score != null).map((score) => score.id)),
    [slots],
  );

  const pickScore = useCallback((score: OsuScore) => {
    setSlots((current) => {
      const next: SlotScores = [current[0], current[1]];
      next[activeSlot] = score;
      return next;
    });
    // The side that is still empty is what the search should fill next.
    const other: SlotIndex = activeSlot === 0 ? 1 : 0;
    if (!slots[other]) setActiveSlot(other);
  }, [activeSlot, slots]);

  const clearSlot = useCallback((index: SlotIndex) => {
    setSlots((current) => {
      const next: SlotScores = [current[0], current[1]];
      next[index] = null;
      return next;
    });
    setActiveSlot(index);
  }, []);

  return (
    <div className="mx-auto max-w-4xl">
      <h3 className="text-center text-sm font-semibold uppercase tracking-wider text-osu-f1">
        {t`Watch two runs of the same map at once`}
      </h3>
      {/* Said here rather than after the tap: on a phone this only plays in
          landscape, and it takes the whole screen when it does. */}
      <p className="mt-1 text-center text-[11px] text-osu-f1/70 sm:hidden">{t`Turn your phone sideways to watch.`}</p>

      <div className="mt-4 grid items-stretch gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-2">
        <SlotCard
          index={0}
          score={left}
          active={activeSlot === 0}
          onSelect={() => setActiveSlot(0)}
          onClear={() => clearSlot(0)}
        />
        <MatchupBadge />
        <SlotCard
          index={1}
          score={right}
          active={activeSlot === 1}
          onSelect={() => setActiveSlot(1)}
          onClear={() => clearSlot(1)}
        />
      </div>

      {pairIssue && (
        <p className="mx-auto mt-3 max-w-lg rounded-lg bg-osu-red/10 px-4 py-2 text-center text-xs text-osu-red-light">
          {formatSideBySideIssue(pairIssue, i18n)}
        </p>
      )}

      <div className="mt-5 flex justify-center">
        <button
          type="button"
          disabled={!canStart}
          onClick={() => {
            if (left && right) onStart(left.id, right.id);
          }}
          className={`rounded-full px-8 py-2.5 text-sm font-bold transition ${
            canStart
              ? "bg-osu-pink text-white hover:brightness-110 cursor-pointer"
              : "cursor-not-allowed bg-osu-b4 text-osu-f1/60"
          }`}
        >
          {t`Watch side by side`}
        </button>
      </div>

      {/* Keyed on the map: the first pick locks it, which changes what every
          row in the picker means, so it starts over rather than leaving a list
          of runs from other maps sitting there. */}
      <RunPicker
        key={anchorBeatmapId ?? "no-map"}
        slotIndex={activeSlot}
        anchor={anchor}
        pickedIds={pickedIds}
        recentReplays={recentReplays}
        onPick={pickScore}
      />
    </div>
  );
}

// The seam between the two cards, in the colours the stages will use. The
// rotation is what makes it read as a join rather than a third card.
function MatchupBadge() {
  return (
    <div className="flex items-center justify-center sm:px-1">
      <div className="relative flex h-11 w-11 rotate-45 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-osu-pink/30 to-osu-blue/30">
        <Swords className="h-4 w-4 -rotate-45 text-white/85" aria-hidden="true" />
      </div>
    </div>
  );
}

function SlotCard({ index, score, active, onSelect, onClear }: {
  index: SlotIndex;
  score: OsuScore | null;
  active: boolean;
  onSelect: () => void;
  onClear: () => void;
}) {
  const meta = SLOT_META[index];
  const { t, i18n } = useLingui();
  const label = i18n._(meta.label).toLowerCase();

  return (
    <div
      className={`relative flex min-h-[184px] min-w-0 flex-col overflow-hidden rounded-2xl border bg-osu-b4 transition-colors ${
        score
          ? `border-transparent ring-1 ${meta.ring}`
          : active
            ? `${meta.border} ring-1 ${meta.ring}`
            : "border-dashed border-osu-b3/70"
      }`}
    >
      {score?.beatmapset?.covers?.["cover@2x"] && (
        <img
          src={score.beatmapset.covers["cover@2x"]}
          alt=""
          loading="lazy"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[0.14]"
        />
      )}
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${meta.glow} to-transparent opacity-60`} />

      <button
        type="button"
        onClick={onSelect}
        aria-label={score ? t`Replace the ${label} run` : t`Fill the ${label} run`}
        title={score ? t`Replace the ${label} run` : t`Fill the ${label} run`}
        className="relative flex flex-1 flex-col text-left cursor-pointer"
      >
        <span className={`px-3.5 pt-3 text-[10px] font-bold uppercase tracking-[0.2em] ${meta.accent}`}>
          {label}
        </span>
        {score ? (
          <PickedScore score={score} />
        ) : (
          <span className="flex flex-1 flex-col items-center justify-center gap-2.5 px-4 pb-5 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-osu-b5 text-osu-f1">
              <Plus className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="text-[13px] font-semibold text-white">
              {active ? t`Fill the ${label} run below` : t`Add the ${label} run`}
            </span>
          </span>
        )}
      </button>

      {score && (
        <button
          type="button"
          onClick={onClear}
          aria-label={t`Clear the ${label} score`}
          className="absolute right-3 top-3 rounded-full bg-black/30 p-1 text-osu-f1 transition-colors hover:text-white cursor-pointer"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function PickedScore({ score }: { score: OsuScore }) {
  const { t } = useLingui();
  const mods = getModDisplayList(score.mods);
  return (
    <motion.span
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-3 text-center"
    >
      <img
        src={avatarImageSrc(score.user?.avatar_url, score.user?.id)}
        alt=""
        loading="lazy"
        className="h-12 w-12 rounded-full object-cover ring-2 ring-white/10"
      />
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <CountryFlag code={score.user?.country_code} size="xs" decorative />
        <span className="truncate text-[15px] font-bold text-white">{score.user?.username ?? t`Unknown`}</span>
      </span>
      <span className="flex items-center gap-2 tabular-nums">
        <GradeImg grade={getDisplayedRank(score)} size={20} />
        <span className="text-[12px] font-semibold text-osu-l2">{formatAccuracy(getDisplayedAccuracy(score))}</span>
        {score.pp != null && <span className="text-[12px] font-bold text-osu-pink-light">{formatPP(score.pp)}</span>}
        {mods.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5">
            {mods.map((mod, index) => (
              <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.55} />
            ))}
          </span>
        )}
      </span>
      <span className="max-w-full truncate text-[11px] text-osu-f1">
        {score.beatmapset?.title ?? ""}
        {score.beatmap?.version ? <span className="text-osu-f1/60"> [{score.beatmap.version}]</span> : null}
      </span>
    </motion.span>
  );
}

/* The one control that fills a side. What the box means follows from what is
   in it and from what has been picked already, so there is never a second
   input to notice: a link or score id resolves to that run, a name searches
   players, and with a player open it filters their runs. */
function RunPicker({ slotIndex, anchor, pickedIds, recentReplays, onPick }: {
  slotIndex: SlotIndex;
  anchor: OsuScore | null;
  pickedIds: Set<number>;
  recentReplays: RecentReplayEntry[];
  onPick: (score: OsuScore) => void;
}) {
  const meta = SLOT_META[slotIndex];
  const { t, i18n } = useLingui();
  const { viewer } = useAuth();
  const anchorBeatmapId = anchor?.beatmap?.id ?? null;

  const [query, setQuery] = useState("");
  const [player, setPlayer] = useState<PickerPlayer | null>(null);
  const [players, setPlayers] = useState<PickerPlayer[] | null>(null);
  const [playersLoading, setPlayersLoading] = useState(false);
  // Best scores come off the profile snapshot and ordinary replay-ready plays
  // come off retained tracker events. A locked map uses the thinner farmed
  // board instead (see BoardRun).
  const [runs, setRuns] = useState<OsuScore[] | null>(null);
  const [runsNextOffset, setRunsNextOffset] = useState(0);
  const [runsTrackedTotal, setRunsTrackedTotal] = useState(0);
  const [runsMoreLoading, setRunsMoreLoading] = useState(false);
  const [playerBoard, setPlayerBoard] = useState<BoardRun[] | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [linkScore, setLinkScore] = useState<OsuScore | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<BoardRun[] | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  // A row that is only a score id until it is clicked (recently watched).
  const [resolvingScoreId, setResolvingScoreId] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const runsRequestRef = useRef(0);
  const resolveRequestRef = useRef(0);

  const trimmedQuery = query.trim();
  const queryScoreId = parseReplayScoreInput(query);

  // A pasted link or score id: look it up so it lands in the list as a row
  // like everything else.
  useEffect(() => {
    if (queryScoreId == null) {
      setLinkScore(null);
      setLinkLoading(false);
      setLinkError(null);
      return;
    }
    let cancelled = false;
    setLinkLoading(true);
    setLinkError(null);
    setLinkScore(null);
    const timer = window.setTimeout(() => {
      getScore({ data: { scoreId: queryScoreId, mode: "mania" } })
        .then((score) => {
          if (cancelled) return;
          if (!score) throw new Error("missing");
          setLinkScore(score);
        })
        .catch(() => {
          if (cancelled) return;
          setLinkError(t`That score couldn't be loaded. Check the link and try again.`);
        })
        .finally(() => {
          if (!cancelled) setLinkLoading(false);
        });
    }, SCORE_LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [queryScoreId]);

  // Typing a name searches players, but only while no player is open: with one
  // open the same box filters their runs instead.
  useEffect(() => {
    if (player || queryScoreId != null || trimmedQuery.length < PLAYER_SEARCH_MIN_LENGTH) {
      setPlayers(null);
      setPlayersLoading(false);
      return;
    }
    let cancelled = false;
    setPlayersLoading(true);
    const timer = window.setTimeout(() => {
      // Stored players only: a player we hold nothing on has no runs to offer,
      // so spending an osu! search call to name them would buy nothing.
      searchPlayers(trimmedQuery, { fallbackToOsu: false })
        .then((found) => {
          if (cancelled) return;
          setPlayers(found);
        })
        .catch(() => {
          if (!cancelled) setPlayers([]);
        })
        .finally(() => {
          if (!cancelled) setPlayersLoading(false);
        });
    }, PLAYER_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [player, queryScoreId, trimmedQuery]);

  // An open player's runs: their stored best scores plus tracked replay-ready
  // plays while the map is open, or their row on the map's board once locked.
  useEffect(() => {
    if (!player) {
      setRuns(null);
      setRunsNextOffset(0);
      setRunsTrackedTotal(0);
      setRunsMoreLoading(false);
      setPlayerBoard(null);
      setRunsLoading(false);
      return;
    }
    const request = ++runsRequestRef.current;
    setRuns(null);
    setRunsNextOffset(0);
    setRunsTrackedTotal(0);
    setRunsMoreLoading(false);
    setPlayerBoard(null);
    setRunsLoading(true);
    const load = anchorBeatmapId != null
      // The board's own username filter, so a player far down it is one query
      // away rather than a page walk.
      ? fetchMapBoardRuns(anchorBeatmapId, player.username)
        .then((board) => setPlayerBoardIfCurrent(board.filter((run) => run.userId === player.id)))
      : fetchPlayerRuns(player.id)
        .then((result) => setRunsIfCurrent(result));

    function setRunsIfCurrent(result: PlayerRunsPage) {
      if (runsRequestRef.current !== request) return;
      setRuns(result.scores);
      setRunsNextOffset(result.nextOffset);
      setRunsTrackedTotal(result.trackedTotal);
    }
    function setPlayerBoardIfCurrent(board: BoardRun[]) {
      if (runsRequestRef.current !== request) return;
      setPlayerBoard(board);
    }

    load
      .catch(() => {
        if (runsRequestRef.current !== request) return;
        setRuns([]);
        setPlayerBoard([]);
      })
      .finally(() => {
        if (runsRequestRef.current === request) setRunsLoading(false);
      });
  }, [anchorBeatmapId, player]);

  const loadMoreRuns = useCallback(() => {
    if (!player || anchorBeatmapId != null || runsMoreLoading || runsNextOffset >= runsTrackedTotal) return;
    const request = runsRequestRef.current;
    setRunsMoreLoading(true);
    fetchLivePlayerReplayScoresDirect(player.id, {
      limit: PLAYER_REPLAY_SCORES_PAGE_SIZE,
      offset: runsNextOffset,
    })
      .then((page) => {
        if (runsRequestRef.current !== request) return;
        setRuns((current) => mergePlayerRuns(current ?? [], page.items));
        setRunsNextOffset(page.offset + page.limit);
        setRunsTrackedTotal(page.total);
      })
      .catch(() => {})
      .finally(() => {
        if (runsRequestRef.current === request) setRunsMoreLoading(false);
      });
  }, [anchorBeatmapId, player, runsMoreLoading, runsNextOffset, runsTrackedTotal]);

  // One side picked is enough to know the map, so our own board for it is what
  // the picker shows by default from then on.
  useEffect(() => {
    if (anchorBeatmapId == null) {
      setCandidates(null);
      return;
    }
    let cancelled = false;
    setCandidatesLoading(true);
    fetchMapBoardRuns(anchorBeatmapId)
      .then((board) => {
        if (!cancelled) setCandidates(board);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [anchorBeatmapId]);

  const pick = useCallback((score: OsuScore) => {
    const issue = getSideBySideCandidateIssue(score, anchor);
    if (issue) {
      setPickError(formatSideBySideIssue(issue, i18n));
      return;
    }
    setPickError(null);
    setQuery("");
    onPick(score);
  }, [anchor, onPick]);

  // Recently watched rows are score ids until they are clicked.
  const pickById = useCallback((scoreId: number) => {
    const request = ++resolveRequestRef.current;
    setResolvingScoreId(scoreId);
    setPickError(null);
    getScore({ data: { scoreId, mode: "mania" } })
      .then((score) => {
        if (resolveRequestRef.current !== request) return;
        if (!score) throw new Error("missing");
        pick(score);
      })
      .catch(() => {
        if (resolveRequestRef.current !== request) return;
        setPickError(t`That score couldn't be loaded.`);
      })
      .finally(() => {
        if (resolveRequestRef.current === request) setResolvingScoreId(null);
      });
  }, [pick]);

  const visibleRuns = useMemo(() => {
    if (!runs) return [];
    const needle = trimmedQuery.toLowerCase();
    if (!needle) return runs;
    return runs.filter((score) => [
      score.beatmapset?.title,
      score.beatmapset?.artist,
      score.beatmapset?.creator,
      score.beatmap?.version,
    ].filter(Boolean).join(" ").toLowerCase().includes(needle));
  }, [runs, trimmedQuery]);

  const recentScoreEntries = recentReplays.filter((entry) => entry.scoreId != null);
  const searching = playersLoading || linkLoading;
  const placeholder = player
    ? t`Filter ${player.username}'s runs...`
    : t`Search a player, or paste a score link...`;

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-osu-b3/30 bg-osu-b4">
      <div className="flex items-center gap-2.5 border-b border-osu-b3/30 bg-osu-b5/30 px-3 py-2.5">
        <span className={`shrink-0 text-[10px] font-bold uppercase tracking-[0.2em] ${meta.accent}`}>
          {i18n._(meta.label)}
        </span>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            enterKeyHint="search"
            // 16px on phones: anything smaller makes iOS Safari zoom the whole
            // page when the input gains focus.
            className="h-9 w-full rounded-lg border border-osu-b3/50 bg-osu-b5/80 pl-8 pr-8 text-[16px] text-white outline-none transition-colors placeholder:text-osu-f1/60 focus:border-osu-pink/40 sm:text-[13px]"
          />
          {searching ? (
            <LoaderCircle className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-osu-f1" aria-hidden="true" />
          ) : query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t`Clear the search`}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-osu-f1 transition-colors hover:text-white cursor-pointer"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {player && (
        <div className="flex items-center gap-2 border-b border-osu-b3/20 px-3 py-2">
          <img
            src={avatarImageSrc(player.avatar_url, player.id)}
            alt=""
            loading="lazy"
            className="h-6 w-6 rounded-full object-cover ring-1 ring-white/10"
          />
          <CountryFlag code={player.country_code ?? undefined} size="xs" decorative />
          <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-white">{player.username}</span>
          <button
            type="button"
            onClick={() => {
              setPlayer(null);
              setQuery("");
            }}
            aria-label={t`Stop browsing ${player.username}`}
            className="rounded-full p-1 text-osu-f1 transition-colors hover:text-white cursor-pointer"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {pickError && (
        <p className="border-b border-osu-b3/20 px-3 py-2 text-[11px] text-osu-red-light">{pickError}</p>
      )}

      <div className="replay-score-scroll max-h-[22rem] overflow-y-auto overscroll-contain p-1.5">
        <PickerBody
          anchor={anchor}
          pickedIds={pickedIds}
          slotLabel={i18n._(meta.label)}
          queryScoreId={queryScoreId}
          trimmedQuery={trimmedQuery}
          linkScore={linkScore}
          linkLoading={linkLoading}
          linkError={linkError}
          player={player}
          runs={runs}
          visibleRuns={visibleRuns}
          playerBoard={playerBoard}
          runsLoading={runsLoading}
          hasMoreRuns={runsNextOffset < runsTrackedTotal}
          runsMoreLoading={runsMoreLoading}
          players={players}
          playersLoading={playersLoading}
          candidates={candidates}
          candidatesLoading={candidatesLoading}
          recentEntries={recentScoreEntries}
          resolvingScoreId={resolvingScoreId}
          viewer={viewer}
          onOpenPlayer={(next) => {
            setPlayer(next);
            setQuery("");
          }}
          onPick={pick}
          onPickById={pickById}
          onLoadMoreRuns={loadMoreRuns}
        />
      </div>
    </section>
  );
}

function PickerBody({
  anchor,
  pickedIds,
  slotLabel,
  queryScoreId,
  trimmedQuery,
  linkScore,
  linkLoading,
  linkError,
  player,
  runs,
  visibleRuns,
  playerBoard,
  runsLoading,
  hasMoreRuns,
  runsMoreLoading,
  players,
  playersLoading,
  candidates,
  candidatesLoading,
  recentEntries,
  resolvingScoreId,
  viewer,
  onOpenPlayer,
  onPick,
  onPickById,
  onLoadMoreRuns,
}: {
  anchor: OsuScore | null;
  pickedIds: Set<number>;
  slotLabel: string;
  queryScoreId: number | null;
  trimmedQuery: string;
  linkScore: OsuScore | null;
  linkLoading: boolean;
  linkError: string | null;
  player: PickerPlayer | null;
  runs: OsuScore[] | null;
  visibleRuns: OsuScore[];
  playerBoard: BoardRun[] | null;
  runsLoading: boolean;
  hasMoreRuns: boolean;
  runsMoreLoading: boolean;
  players: PickerPlayer[] | null;
  playersLoading: boolean;
  candidates: BoardRun[] | null;
  candidatesLoading: boolean;
  recentEntries: RecentReplayEntry[];
  resolvingScoreId: number | null;
  viewer: { id: number; username: string; avatarUrl: string; countryCode: string | null } | null;
  onOpenPlayer: (player: PickerPlayer) => void;
  onPick: (score: OsuScore) => void;
  onPickById: (scoreId: number) => void;
  onLoadMoreRuns: () => void;
}) {
  const { t, i18n } = useLingui();
  const locale = useLocale();
  const anchorBeatmapId = anchor?.beatmap?.id ?? null;
  const slotLabelLower = slotLabel.toLowerCase();
  const useLabel = t`Use as the ${slotLabelLower} run`;

  const scoreRow = (score: OsuScore, options: { leading: ReactNode; primary: ReactNode }) => {
    const alreadyPicked = pickedIds.has(score.id);
    // Rate and map are checked against the side already chosen, so a row that
    // can't be watched next to it says why instead of failing later.
    const issue = alreadyPicked ? null : getSideBySideCandidateIssue(score, anchor);
    return (
      <PickRow
        key={score.id}
        leading={options.leading}
        primary={options.primary}
        mods={getModDisplayList(score.mods)}
        grade={getDisplayedRank(score)}
        accuracy={getDisplayedAccuracy(score)}
        pp={score.pp}
        disabled={alreadyPicked || issue != null}
        title={alreadyPicked ? t`Already picked` : issue ? formatSideBySideIssue(issue, i18n) : useLabel}
        onClick={() => onPick(score)}
      />
    );
  };

  /* A board row is our own projection, so it has no mod settings and no
     judgements: it is picked by resolving the score behind it, which is where
     the rate and the replay finally get checked. */
  const boardRow = (run: BoardRun, options: { leading: ReactNode; primary: ReactNode }) => {
    const alreadyPicked = pickedIds.has(run.scoreId);
    return (
      <PickRow
        key={run.scoreId}
        leading={options.leading}
        primary={options.primary}
        mods={run.mods.map((acronym) => ({ acronym }))}
        pp={run.pp}
        disabled={alreadyPicked}
        busy={resolvingScoreId === run.scoreId}
        title={alreadyPicked ? t`Already picked` : useLabel}
        onClick={() => onPickById(run.scoreId)}
      />
    );
  };

  const avatar = (url: string | undefined, id: number | undefined) => (
    <img
      src={avatarImageSrc(url, id)}
      alt=""
      loading="lazy"
      className="h-6 w-6 rounded-full object-cover ring-1 ring-white/10"
    />
  );

  const playerAvatar = (score: OsuScore) => avatar(score.user?.avatar_url, score.user?.id);

  const mapCover = (score: OsuScore) => (score.beatmapset?.covers?.list ? (
    <img src={score.beatmapset.covers.list} alt="" loading="lazy" className="h-6 w-10 rounded object-cover" />
  ) : (
    <span className="h-6 w-10 rounded bg-osu-b5" />
  ));

  const mapTitle = (score: OsuScore) => (
    <>
      {score.beatmapset?.title ?? t`Unknown map`}
      {score.beatmap?.version ? <span className="font-medium text-osu-f1"> [{score.beatmap.version}]</span> : null}
    </>
  );

  // A pasted link or id resolves to a single row.
  if (queryScoreId != null) {
    if (linkLoading) return <RowSkeleton />;
    if (linkError || !linkScore) {
      return <Hint>{linkError ?? t`No score found for #${queryScoreId}.`}</Hint>;
    }
    return scoreRow(linkScore, {
      leading: playerAvatar(linkScore),
      primary: (
        <>
          <span className="text-white">{linkScore.user?.username ?? t`Unknown`}</span>
          <span className="text-osu-f1"> // {linkScore.beatmapset?.title ?? t`Unknown map`}</span>
        </>
      ),
    });
  }

  // An open player: their runs, filtered by whatever else is typed.
  if (player) {
    if (runsLoading) return <RowSkeleton />;
    if (anchorBeatmapId != null) {
      if (!playerBoard || playerBoard.length === 0) {
        return <Hint><Trans>We have no run by {player.username} on this map. Paste a link to their score to use it.</Trans></Hint>;
      }
      return (
        <>
          <SectionLabel>{t`Their runs on this map`}</SectionLabel>
          {playerBoard.map((run) => boardRow(run, {
            leading: avatar(run.avatarUrl, run.userId),
            primary: run.playedAt ? t`Set ${formatTimeAgo(run.playedAt, locale)}` : t`This run`,
          }))}
        </>
      );
    }
    if (visibleRuns.length === 0) {
      if (trimmedQuery && runs && runs.length > 0) {
        return (
          <>
            <Hint><Trans>Nothing in the loaded plays matches "{trimmedQuery}".</Trans></Hint>
            {hasMoreRuns && <LoadMoreRuns busy={runsMoreLoading} onClick={onLoadMoreRuns} />}
          </>
        );
      }
      return <Hint><Trans>We have no replay-ready plays stored for {player.username} yet.</Trans></Hint>;
    }
    return (
      <>
        <SectionLabel>{player.id === viewer?.id ? t`Your plays` : t`Their plays`}</SectionLabel>
        {visibleRuns.map((score) => scoreRow(score, {
          leading: mapCover(score),
          primary: mapTitle(score),
        }))}
        {hasMoreRuns && <LoadMoreRuns busy={runsMoreLoading} onClick={onLoadMoreRuns} />}
      </>
    );
  }

  // A name: the players it could be.
  if (trimmedQuery.length >= PLAYER_SEARCH_MIN_LENGTH) {
    if (playersLoading && players == null) return <RowSkeleton />;
    if (!players || players.length === 0) return <Hint><Trans>No players found for "{trimmedQuery}".</Trans></Hint>;
    return (
      <>
        <SectionLabel>{t`Players`}</SectionLabel>
        {players.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onOpenPlayer(candidate)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-osu-b5 cursor-pointer sm:py-2"
          >
            <img
              src={avatarImageSrc(candidate.avatar_url, candidate.id)}
              alt=""
              loading="lazy"
              className="h-6 w-6 rounded-full object-cover ring-1 ring-white/10"
            />
            <CountryFlag code={candidate.country_code ?? undefined} size="xs" decorative />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">{candidate.username}</span>
          </button>
        ))}
      </>
    );
  }

  // Nothing typed, map already locked: our board for that map.
  if (anchorBeatmapId != null) {
    if (candidates == null) return candidatesLoading ? <RowSkeleton /> : <Hint>{t`Couldn't load who has played this map.`}</Hint>;
    if (candidates.length === 0) {
      return <Hint>{t`Nobody we track has a scored run on this map. Search a player, or paste a score link.`}</Hint>;
    }
    return (
      <>
        <SectionLabel>
          <Trans>Tracked runs on {anchor?.beatmapset?.title ?? t`this map`}</Trans>
          {anchor?.beatmap?.version ? ` [${anchor.beatmap.version}]` : ""}
        </SectionLabel>
        {candidates.map((run) => boardRow(run, {
          leading: (
            <span className="flex items-center gap-1.5">
              <span className="w-4 text-right text-[10px] font-semibold tabular-nums text-osu-f1">{run.rank ?? ""}</span>
              {avatar(run.avatarUrl, run.userId)}
            </span>
          ),
          primary: run.username,
        }))}
      </>
    );
  }

  // Nothing typed, nothing picked: the ways in that need no typing at all.
  return (
    <>
      {viewer && (
        <>
          <SectionLabel>{t`You`}</SectionLabel>
          <button
            type="button"
            onClick={() => onOpenPlayer({
              id: viewer.id,
              username: viewer.username,
              avatar_url: viewer.avatarUrl,
              country_code: viewer.countryCode,
            })}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-osu-b5 cursor-pointer sm:py-2"
          >
            <img
              src={avatarImageSrc(viewer.avatarUrl, viewer.id)}
              alt=""
              loading="lazy"
              className="h-6 w-6 rounded-full object-cover ring-1 ring-white/10"
            />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">
              {t`My plays`}
            </span>
          </button>
        </>
      )}

      {recentEntries.length > 0 && (
        <>
          <SectionLabel>{t`Recently watched`}</SectionLabel>
          {recentEntries.map((entry) => (
            <PickRow
              key={entry.key}
              leading={entry.coverUrl
                ? <img src={entry.coverUrl} alt="" loading="lazy" className="h-6 w-10 rounded object-cover" />
                : <span className="h-6 w-10 rounded bg-osu-b5" />}
              primary={(
                <>
                  {entry.title}
                  {entry.version ? <span className="font-medium text-osu-f1"> [{entry.version}]</span> : null}
                </>
              )}
              secondary={entry.playerName}
              mods={entry.mods ?? []}
              grade={entry.grade}
              accuracy={entry.accuracy}
              pp={entry.pp}
              busy={resolvingScoreId === entry.scoreId}
              title={useLabel}
              onClick={() => {
                if (entry.scoreId != null) onPickById(entry.scoreId);
              }}
            />
          ))}
        </>
      )}

      {!viewer && recentEntries.length === 0 && (
        <Hint>{t`Search a player to browse their plays, or paste a score link.`}</Hint>
      )}
    </>
  );
}

function PickRow({ leading, primary, secondary, mods, grade, accuracy, pp, disabled = false, busy = false, title, onClick }: {
  leading: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  mods?: { acronym: string; rate?: number }[];
  grade?: string;
  accuracy?: number;
  pp?: number | null;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      title={title}
      onClick={onClick}
      // Roomier rows on phones, where this list is picked with a thumb.
      className="grid w-full grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-osu-b5 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent cursor-pointer sm:py-2"
    >
      <span className="flex items-center justify-start">{leading}</span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[12px] font-semibold text-white">{primary}</span>
          {mods && mods.length > 0 && (
            <span className="flex shrink-0 items-center gap-0.5">
              {mods.map((mod, index) => (
                <ModBadge key={`${mod.acronym}-${index}`} mod={mod.acronym} rate={mod.rate} size={0.5} />
              ))}
            </span>
          )}
        </span>
        {secondary && <span className="truncate text-[10px] text-osu-f1">{secondary}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2 tabular-nums">
        {busy ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-osu-f1" aria-hidden="true" />
        ) : (
          <>
            {grade && <GradeImg grade={grade} size={18} />}
            {accuracy != null && (
              <span className="text-[11px] font-semibold text-osu-l2">{formatAccuracy(accuracy)}</span>
            )}
            {pp != null && (
              <span className="w-14 text-right text-[11px] font-bold text-osu-pink-light">{formatPP(pp)}</span>
            )}
          </>
        )}
      </span>
    </button>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="truncate px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
      {children}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-2 py-4 text-center text-[11px] text-osu-f1">{children}</p>;
}

function RowSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-1">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-9 rounded-lg bg-osu-b5/50" />
      ))}
    </div>
  );
}

function LoadMoreRuns({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-semibold text-osu-f1 transition-colors hover:bg-osu-b5 hover:text-white disabled:cursor-wait disabled:opacity-60 cursor-pointer"
    >
      {busy && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />}
      {busy ? t`Loading plays...` : t`Load more plays`}
    </button>
  );
}

interface PlayerRunsPage {
  scores: OsuScore[];
  nextOffset: number;
  trackedTotal: number;
}

/* Best scores remain useful even when they predate the tracker; retained
   tracker events add every other replay-ready run. Both sources are stored
   locally, so browsing never spends the shared osu! API budget. */
async function fetchPlayerRuns(userId: number): Promise<PlayerRunsPage> {
  if (!isLiveBackendConfigured()) return { scores: [], nextOffset: 0, trackedTotal: 0 };
  const [snapshot, tracked] = await Promise.all([
    fetchLivePlayerCachedProfileSnapshotDirect(String(userId)),
    fetchLivePlayerReplayScoresDirect(userId, { limit: PLAYER_REPLAY_SCORES_PAGE_SIZE }),
  ]);
  return {
    scores: mergePlayerRuns(tracked.items, snapshot?.bestScores ?? []),
    nextOffset: tracked.offset + tracked.limit,
    trackedTotal: tracked.total,
  };
}

function mergePlayerRuns(current: OsuScore[], additions: OsuScore[]): OsuScore[] {
  const byId = new Map<number, OsuScore>();
  for (const score of [...current, ...additions]) {
    if (score.id <= 0 || !scoreHasReplay(score) || score.beatmap?.id == null || byId.has(score.id)) continue;
    byId.set(score.id, score);
  }
  const playedAt = (score: OsuScore) => {
    const timestamp = Date.parse(getScoreTimestamp(score));
    return Number.isFinite(timestamp) ? timestamp : 0;
  };
  return [...byId.values()].sort((a, b) => playedAt(b) - playedAt(a));
}

/* Who among the players we track has a run on this map, from the farmed board
   the maps pages already read. `username` uses the board's own filter, so a
   player outside the first page is still one query away. */
async function fetchMapBoardRuns(beatmapId: number, username?: string): Promise<BoardRun[]> {
  if (!isLiveBackendConfigured()) return [];
  const snapshot = await fetchLiveMapsPlayersSnapshot("GLOBAL", "farmed", beatmapId, {
    pageSize: LIVE_MAPS_PLAYERS_PAGE_SIZE,
    q: username,
  });
  return toBoardRuns(snapshot.players ?? []);
}
