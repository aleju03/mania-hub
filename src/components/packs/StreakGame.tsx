import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, Recycle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { maniaTierTextStyle } from "#/lib/maniacard";
import { useAuth } from "#/lib/auth-context";
import {
  fetchLiveGlobalRankings,
  fetchLiveStreakMetrics,
  isLiveBackendConfigured,
  warmLivePackPlayers,
  type LiveGlobalRankingEntry,
  type LiveStreakPlayerMetrics,
} from "#/lib/live-backend";
import { track } from "#/lib/analytics";
import { claimStreakShards, fetchPackGameAllowance } from "#/lib/pack-games";
import { fetchCachedPackPlayerScores } from "#/lib/packs";
import {
  isStreakGuessCorrect,
  nextStreakMilestone,
  pickStreakMetric,
  pickStreakPlayer,
  pickUnloadedPage,
  readBestStreak,
  STREAK_METRIC_COPY,
  STREAK_MILESTONE,
  STREAK_PAGE_SIZE,
  STREAK_REFILL_THRESHOLD,
  streakMetricValue,
  streakPageSlice,
  streakPoolEntries,
  streakRankPage,
  streakShardValue,
  writeBestStreak,
  type StreakGuess,
  type StreakMetric,
  type StreakPlayer,
  type StreakPool,
} from "#/lib/streak-game";
import { buildManiaCardRenderData } from "../player/maniacard3d/renderData";
import { avatarImageSrc } from "../ui/Avatar";
import { CountryFlag } from "../ui/CountryFlag";
import { renderCardThumbnail } from "./cardSnapshot";
import {
  playCardDraw,
  playRecycleClink,
  playStreakCorrect,
  playStreakMilestone,
  playStreakWrong,
  warmPackAudio,
} from "./packSfx";

// Higher or lower, hosted by the packs page: the board is the page's middle,
// so the pull ticker, the wallet and the shard count stay where they were
// while you play. The game owns its own run state and nothing else.

/* How long the answer sits on screen before the board moves on. Long enough to
   read the number that just beat you, short enough that a good run never waits
   on the animation. */
const REVEAL_HOLD_MS = 1250;
const COUNT_UP_MS = 700;

interface StreakCard {
  player: StreakPlayer;
  /* The real card front, minted from the player's stored plays. Null when
     those could not be read, which is a card without art rather than a round
     the game cannot play: the number being guessed at comes off the rankings
     snapshot, not off the card. */
  thumbnail: string | null;
  /* How the question prints this player's name: in the colour of the card
     under it. Null for a card that never minted, which falls back to white.
     Nothing leaks: both fronts are face up already, tier is printed on them,
     and tier tracks pp while the questions are about numbers the card front
     never shows. */
  nameStyle: CSSProperties | null;
}

/* One card's art, minted from the plays the backend already has stored. Only
   the cached read: a pack is paid for and may spend an osu! fetch on a cold
   player, but a free game should never spend that budget, so a player the
   backend has not fetched yet plays as an avatar and is warmed in the
   background for next time. */
const cardCache = new Map<number, StreakCard>();

/* The question numbers beyond the rankings snapshot (best-play stars, join
   date, playtime, ...), one batched read per page of the pool and kept for
   the session: runs re-draw the same players, and the server answers from
   its own cache behind an hour of browser cache anyway. A player the fetch
   failed for just plays on the snapshot questions. */
const metricsCache = new Map<number, LiveStreakPlayerMetrics>();

async function loadStreakMetrics(entries: readonly LiveGlobalRankingEntry[]): Promise<void> {
  const missing = entries.map((entry) => entry.user.id).filter((id) => !metricsCache.has(id));
  if (missing.length === 0) return;
  try {
    for (const [userId, metrics] of await fetchLiveStreakMetrics(missing)) metricsCache.set(userId, metrics);
  } catch {
    // The snapshot metrics carry the round; the extra questions return when
    // the backend does.
  }
}

async function mintStreakCard(player: StreakPlayer): Promise<StreakCard> {
  const cached = cardCache.get(player.userId);
  if (cached) return cached;
  let card: StreakCard = { player, thumbnail: null, nameStyle: null };
  try {
    const scores = await fetchCachedPackPlayerScores(player.userId);
    if (!scores) {
      void warmLivePackPlayers([player.userId]).catch(() => {});
      cardCache.set(player.userId, card);
      return card;
    }
    const data = buildManiaCardRenderData({
      user: {
        id: player.userId,
        username: player.username,
        avatar_url: player.avatarUrl,
        country_code: player.countryCode,
        statistics: { global_rank: player.globalRank, pp: player.pp },
      },
      scores,
    });
    if (data.status === "ready") {
      // Read before the thumbnail: art that fails to draw should still colour
      // the name, since the tier is known either way.
      card = {
        player,
        nameStyle: maniaTierTextStyle(data.tier, data.glowColor),
        thumbnail: await renderCardThumbnail(data, 300).catch(() => null),
      };
    }
  } catch {
    // A player the backend has never fetched still plays, just without art.
  }
  cardCache.set(player.userId, card);
  return card;
}

/* Counts from the number already on the board toward the one being revealed,
   so the moment it crosses is the moment you know. */
function useCountUp(from: number, to: number, active: boolean): number {
  const [value, setValue] = useState(to);
  useEffect(() => {
    if (!active) {
      setValue(to);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / COUNT_UP_MS);
      // Ease out, so it lands on the number rather than slamming into it.
      const eased = 1 - (1 - progress) ** 3;
      setValue(from + (to - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [from, to, active]);
  return value;
}

function CardFace({
  card,
  valueText,
  tone,
  caption,
}: {
  card: StreakCard;
  valueText: string;
  tone: "neutral" | "correct" | "wrong";
  caption: string;
}) {
  const player = card.player;
  return (
    <div className="flex w-full flex-col items-center">
      <motion.div
        className="relative w-[142px] overflow-hidden rounded-[12px] sm:w-[190px]"
        style={{ aspectRatio: "5 / 7", boxShadow: "0 12px 34px rgba(0,0,0,0.5)" }}
        animate={
          tone === "wrong"
            ? { x: [0, -7, 6, -4, 0] }
            : tone === "correct"
              ? { scale: [1, 1.035, 1] }
              : { x: 0, scale: 1 }
        }
        transition={{ duration: 0.42 }}
      >
        {card.thumbnail ? (
          <img
            src={card.thumbnail}
            alt={`${player.username} maniacard`}
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-osu-b4/70 px-3">
            <img
              src={avatarImageSrc(player.avatarUrl, player.userId) ?? `/api/avatar?u=${player.userId}`}
              alt=""
              className="h-16 w-16 rounded-lg object-cover"
              draggable={false}
            />
            <span className="text-center text-[12px] font-bold text-white">{player.username}</span>
          </div>
        )}
      </motion.div>
      <div className="mt-3 flex items-center gap-1.5">
        <CountryFlag code={player.countryCode} size="xs" decorative />
        <Link
          to="/player/$username"
          params={{ username: player.username }}
          className="truncate text-[14px] font-bold text-white hover:underline underline-offset-4 decoration-osu-f1/60"
        >
          {player.username}
        </Link>
        {/* Who they are is never the secret: the read is that rank tells you
            nothing about how much someone has played. */}
        <span className="text-[11px] text-osu-f1 tabular-nums">#{player.globalRank.toLocaleString()}</span>
      </div>
      <div
        className={`mt-1 flex items-baseline justify-center gap-2 text-2xl font-bold tabular-nums sm:text-3xl ${
          tone === "correct" ? "text-emerald-400" : tone === "wrong" ? "text-rose-400" : "text-white"
        }`}
      >
        {valueText}
        {/* Said in a word as well as a colour: the guess buttons are green and
            red too, and colour alone would leave the verdict ambiguous (and
            unreadable to anyone who cannot separate the two). */}
        {tone !== "neutral" && (
          <span className="text-[12px] font-bold uppercase tracking-wide">
            {tone === "correct" ? "right" : "wrong"}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-osu-f1">{caption}</div>
    </div>
  );
}

interface Round {
  left: StreakCard;
  right: StreakCard;
  metric: StreakMetric;
}

export function StreakGame({ onExit }: { onExit: () => void }) {
  const auth = useAuth();
  const [round, setRound] = useState<Round | null>(null);
  const [verdict, setVerdict] = useState<null | "correct" | "wrong">(null);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(0);
  const [over, setOver] = useState(false);
  /* How the run ended, which decides whether the summary reveals the card you
     were about to face. Cashing out should not show you the answer you walked
     away from. */
  const [endedBy, setEndedBy] = useState<null | "wrong" | "cashout">(null);
  const [newBest, setNewBest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dealing, setDealing] = useState(true);
  /* What the arcade paid for the run that just ended, and what is left of
     today's allowance. Null while signed out or with no backend, which is how
     the page knows not to promise shards. */
  const [earned, setEarned] = useState<number | null>(null);
  const [allowance, setAllowance] = useState<{ remainingToday: number; cap: number } | null>(null);
  /* Which slice of the pool the run draws from: the top 1000 the community can
     argue about, or the hard mode's whole tracked snapshot. Shadowed in a ref
     because the deal pipeline reads it from callbacks that would otherwise
     capture a stale value mid-run. */
  const [mode, setMode] = useState<StreakPool>("top");
  const modeRef = useRef<StreakPool>("top");

  /* The pool the game draws from, loaded a page at a time. Kept in a ref
     because it is bookkeeping the render never reads. */
  const pool = useRef<{ total: number; loaded: Set<number>; entries: LiveGlobalRankingEntry[] }>({
    total: 0,
    loaded: new Set(),
    entries: [],
  });
  /* Everyone this run has already put on the board, so a streak never asks the
     same card twice. */
  const seen = useRef<Set<number>>(new Set());
  /* The card after next, minted while the current one is being guessed at, so
     a right answer never waits on a fetch. */
  const upcoming = useRef<Promise<StreakCard | null> | null>(null);
  const busy = useRef(false);
  /* Which deal the board belongs to. Two deals can be in flight at once (React
     runs mount effects twice in development, and "Play again" is a button
     anyone can hit twice), and both used to reach setRound: the first pair
     landed, then the second replaced it a moment later, so the game opened by
     showing you two players it was not asking about. Only the newest deal is
     allowed to touch state now. */
  const deal = useRef(0);

  useEffect(() => setBest(readBestStreak(mode)), [mode]);

  useEffect(() => {
    if (!auth.viewer) {
      setAllowance(null);
      return;
    }
    void fetchPackGameAllowance()
      .then((result) => setAllowance(result ? { remainingToday: result.remainingToday, cap: result.cap } : null))
      .catch(() => setAllowance(null));
  }, [auth.viewer]);

  const fetchPage = useCallback(async (page: number): Promise<boolean> => {
    const snapshot = await fetchLiveGlobalRankings({ page, pageSize: STREAK_PAGE_SIZE, sort: "rank", dir: "desc" });
    // Awaited so every player is picked with their full question set in hand;
    // a failure inside just narrows the questions to the snapshot's two.
    await loadStreakMetrics(snapshot.ranking);
    pool.current.loaded.add(page);
    pool.current.total = Math.max(pool.current.total, snapshot.total);
    pool.current.entries = [...pool.current.entries, ...snapshot.ranking];
    return snapshot.ranking.length > 0;
  }, []);

  const loadPage = useCallback(async (): Promise<boolean> => {
    const page = pickUnloadedPage(pool.current.total, pool.current.loaded, Math.random, modeRef.current);
    if (page === null) return false;
    return fetchPage(page);
  }, [fetchPage]);

  /* The next player on the board. Pulls another page in when the loaded ones
     are running thin, and once the whole pool has been seen, lets it come
     round again rather than ending a run that was going well. */
  const nextCard = useCallback(async (keep?: number): Promise<StreakCard | null> => {
    let player: StreakPlayer | null = null;
    /* The hard mode's draw is aimed, not sifted: a uniformly random pool
       position, then the page that holds it. Picking from the pages already
       loaded would favour the top, since those load first (and the classic
       game shares them). One page fetch per round is the price of "literally
       anyone", and the backend answers it from its own snapshot. */
    if (modeRef.current === "anyone" && pool.current.total > 0) {
      const page = streakRankPage(1 + Math.floor(Math.random() * pool.current.total));
      if (!pool.current.loaded.has(page)) await fetchPage(page).catch(() => false);
      player = pickStreakPlayer(streakPageSlice(pool.current.entries, page), seen.current, Math.random, undefined, metricsCache);
    }
    if (!player) {
      // The classic draw, and the hard mode's fallback when its aimed page
      // failed to load or had nobody left: whoever is loaded, within the
      // mode's slice of the pool, so rank-8000 pages never deal into a
      // top-1000 game.
      const drawable = () => streakPoolEntries(pool.current.entries, modeRef.current);
      const unseen = drawable().filter((entry) => !seen.current.has(entry.user.id)).length;
      if (unseen < STREAK_REFILL_THRESHOLD) await loadPage();
      player = pickStreakPlayer(drawable(), seen.current, Math.random, undefined, metricsCache);
      if (!player) {
        seen.current = new Set(keep ? [keep] : []);
        player = pickStreakPlayer(drawable(), seen.current, Math.random, undefined, metricsCache);
      }
    }
    if (!player) return null;
    seen.current.add(player.userId);
    return mintStreakCard(player);
  }, [fetchPage, loadPage]);

  const start = useCallback(async () => {
    const token = (deal.current += 1);
    const stale = () => token !== deal.current;
    if (!isLiveBackendConfigured()) {
      setError("The higher or lower game needs the live backend.");
      setDealing(false);
      return;
    }
    setDealing(true);
    setError(null);
    setOver(false);
    setEndedBy(null);
    setNewBest(false);
    setVerdict(null);
    setStreak(0);
    setEarned(null);
    seen.current = new Set();
    upcoming.current = null;
    try {
      // The first page also tells the game how deep the pool goes, so it is
      // loaded before anything is drawn from it.
      if (pool.current.entries.length === 0) {
        const snapshot = await fetchLiveGlobalRankings({
          page: 1,
          pageSize: STREAK_PAGE_SIZE,
          sort: "rank",
          dir: "desc",
        });
        if (stale()) return;
        await loadStreakMetrics(snapshot.ranking);
        if (stale()) return;
        pool.current = { total: snapshot.total, loaded: new Set([1]), entries: snapshot.ranking };
        await loadPage();
        if (stale()) return;
      }
      const first = await nextCard();
      const second = await nextCard();
      if (stale()) return;
      const metric = first && second ? pickStreakMetric(first.player, second.player, Math.random) : null;
      if (!first || !second || !metric) {
        setError("The tracked player pool is too small to play right now.");
        return;
      }
      setRound({ left: first, right: second, metric });
      playCardDraw();
      upcoming.current = nextCard(second.player.userId);
    } catch {
      if (!stale()) setError("Could not reach the player pool. Try again in a moment.");
    } finally {
      if (!stale()) setDealing(false);
    }
  }, [loadPage, nextCard]);

  useEffect(() => {
    // Warmed here rather than on the first guess: building the context and its
    // noise buffer inside the click would land right where the verdict sound
    // is supposed to be. Arriving on this board is a tap either way.
    warmPackAudio();
    void start();
    // Started once on mount; "Play again" calls start() directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Changing the pool re-deals, so it is only offered while there is nothing
     on the line: switching mid-streak would either dump the run or let a
     top-1000 streak keep growing against easier or harder cards than it was
     earned on. */
  const switchMode = useCallback((next: StreakPool) => {
    if (next === modeRef.current || dealing) return;
    modeRef.current = next;
    setMode(next);
    void start();
  }, [dealing, start]);

  /* Cashing in happens at the end of a run rather than per correct guess, so
     one claim covers the whole streak. */
  const claim = useCallback((finalStreak: number, ending: "wrong" | "cashout") => {
    track("streak_run", {
      streak: finalStreak,
      ended: ending,
      pool: modeRef.current,
      streak_username: auth.viewer?.username,
    });
    if (!auth.viewer || finalStreak <= 0) return;
    void claimStreakShards({ data: { streak: finalStreak } })
      .then((result) => {
        if (!result) return;
        setEarned(result.granted);
        setAllowance({ remainingToday: result.remainingToday, cap: result.cap });
      })
      .catch(() => {});
  }, [auth.viewer]);

  const guess = useCallback(
    (choice: StreakGuess) => {
      if (busy.current || !round || verdict || over) return;
      const leftValue = streakMetricValue(round.left.player, round.metric);
      const rightValue = streakMetricValue(round.right.player, round.metric);
      if (leftValue === null || rightValue === null) return;
      busy.current = true;
      const token = deal.current;
      const correct = isStreakGuessCorrect(choice, leftValue, rightValue);
      setVerdict(correct ? "correct" : "wrong");
      if (!correct) {
        playStreakWrong();
        setOver(true);
        setEndedBy("wrong");
        setNewBest(streak > best);
        if (streak > best) {
          setBest(streak);
          writeBestStreak(streak, modeRef.current);
        }
        claim(streak, "wrong");
        busy.current = false;
        return;
      }
      const landed = streak + 1;
      playStreakCorrect(landed);
      if (landed % STREAK_MILESTONE === 0) playStreakMilestone();
      setStreak(landed);
      window.setTimeout(() => {
        void (async () => {
          const next = (await upcoming.current) ?? (await nextCard(round.right.player.userId));
          // A fresh deal started while this round was resolving: it owns the
          // board now.
          if (token !== deal.current) {
            busy.current = false;
            return;
          }
          const metric = next ? pickStreakMetric(round.right.player, next.player, Math.random) : null;
          if (!next || !metric) {
            setError("Ran out of players to draw.");
            busy.current = false;
            return;
          }
          setRound({ left: round.right, right: next, metric });
          setVerdict(null);
          playCardDraw();
          upcoming.current = nextCard(next.player.userId);
          busy.current = false;
        })();
      }, REVEAL_HOLD_MS);
    },
    [best, claim, nextCard, over, round, streak, verdict],
  );

  /* Stopping on purpose. A run had no exit before this: leaving mid-streak
     dropped everything it had earned, because the claim only fired on a wrong
     guess. Now the streak is banked the moment you decide it is. */
  const cashOut = useCallback(() => {
    if (busy.current || over || streak <= 0) return;
    // Shards clinking, the same sound recycling makes, but only for someone
    // who is actually being paid.
    if (auth.viewer) playRecycleClink(streakShardValue(streak));
    setOver(true);
    setEndedBy("cashout");
    setNewBest(streak > best);
    if (streak > best) {
      setBest(streak);
      writeBestStreak(streak, modeRef.current);
    }
    claim(streak, "cashout");
  }, [auth.viewer, best, claim, over, streak]);

  // The whole game is two choices, so the arrow keys should make them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp") guess("more");
      else if (event.key === "ArrowDown") guess("less");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guess]);

  const revealed = verdict !== null;
  const copy = round ? STREAK_METRIC_COPY[round.metric] : null;
  const leftValue = round ? streakMetricValue(round.left.player, round.metric) ?? 0 : 0;
  const rightValue = round ? streakMetricValue(round.right.player, round.metric) ?? 0 : 0;
  const counted = useCountUp(leftValue, rightValue, revealed);

  return (
    <div className="mx-auto w-full max-w-[860px]">
            {/* The question is the whole page, so it reads as the headline and
                sits over the two cards it is asking about. The streak pins to
                the corner on desktop and stacks under it on a phone. */}
            <div className="relative flex flex-col items-center">
              <div className="max-w-[580px] text-center text-[17px] leading-snug text-white sm:text-xl">
                {round && copy ? (
                  <>
                    {copy.q.prefix}
                    <span className="inline-block font-bold" style={round.right.nameStyle ?? undefined}>
                      {round.right.player.username}
                    </span>
                    {copy.q.middle}
                    <span className="inline-block font-bold" style={round.left.nameStyle ?? undefined}>
                      {round.left.player.username}
                    </span>
                    {copy.q.suffix}
                  </>
                ) : (
                  /* The question is still being dealt: hold its line with a
                     quiet bar instead of a slogan nobody asked to read. */
                  <span className="mx-auto block h-[1.2em] w-64 max-w-full animate-pulse rounded-full bg-osu-b4/60" />
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-osu-f1">
                {/* The pool the run draws from. Locked while a streak is
                    live, since switching re-deals and a streak should not be
                    carried between games of different difficulty. */}
                <div className="flex items-center gap-1.5">
                  {([["top", "Top 1000"], ["anyone", "Anyone"]] as const).map(([value, label]) => {
                    const locked = dealing || (!over && streak > 0);
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => switchMode(value)}
                        disabled={locked}
                        aria-pressed={mode === value}
                        className={`rounded-full border px-2.5 py-0.5 font-semibold transition-colors ${
                          mode === value
                            ? "border-osu-pink bg-osu-pink/15 text-white"
                            : locked
                              ? "border-osu-b3/30 text-osu-f1/60"
                              : "border-osu-b3/40 text-osu-f1 hover:border-osu-pink/50 hover:text-white cursor-pointer"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {!over && (
                  <span>
                    next bonus at {nextStreakMilestone(streak).at} in a row
                    <span className="ml-1 font-semibold text-white tabular-nums">
                      +{nextStreakMilestone(streak).bonus}
                    </span>
                  </span>
                )}
                {allowance && (
                  <span className="flex items-center gap-1.5">
                    <Recycle className="h-3 w-3" />
                    <span className="tabular-nums">{allowance.remainingToday}</span>
                    <span>of {allowance.cap} shards left today</span>
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-baseline gap-1.5 sm:absolute sm:right-0 sm:top-0 sm:mt-0 sm:flex-col sm:items-end sm:gap-0">
                <motion.div
                  key={streak}
                  initial={streak > 0 ? { scale: 1.35, color: "rgb(52, 211, 153)" } : false}
                  animate={{ scale: 1, color: "rgb(255, 255, 255)" }}
                  transition={{ duration: 0.32 }}
                  className="text-2xl font-bold tabular-nums text-white"
                >
                  {streak}
                </motion.div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1">
                  streak{best > 0 && <span className="ml-1.5 normal-case tracking-normal">best {best}</span>}
                </div>
              </div>
            </div>

            {error ? (
              <div className="py-20 text-center">
                <div className="text-sm font-bold text-white">{error}</div>
                <button
                  type="button"
                  onClick={onExit}
                  className="mt-5 inline-block rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white transition hover:brightness-110 cursor-pointer"
                >
                  Back to packs
                </button>
              </div>
            ) : dealing || !round || !copy ? (
              /* The board's own shape, face down: two card-sized blocks where
                 the cards will land, so dealing reads as the game arriving
                 rather than a page thinking. */
              <div className="mt-9 flex items-start justify-center gap-4 sm:gap-14" aria-hidden>
                {[0, 1].map((slot) => (
                  <div key={slot} className="flex flex-1 flex-col items-center">
                    <div
                      className="w-[142px] animate-pulse rounded-[12px] bg-osu-b4/60 sm:w-[190px]"
                      style={{ aspectRatio: "5 / 7" }}
                    />
                    <div className="mt-3 h-3.5 w-24 animate-pulse rounded-full bg-osu-b4/60" />
                    <div className="mt-2.5 h-6 w-32 animate-pulse rounded-full bg-osu-b4/60" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="mt-9 flex items-start justify-center gap-4 sm:gap-14">
                  <AnimatePresence initial={false} mode="popLayout">
                    <motion.div
                      key={round.left.player.userId}
                      layoutId={`streak-card-${round.left.player.userId}`}
                      className="flex-1"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.2 } }}
                      transition={{ duration: 0.3 }}
                    >
                      <CardFace
                        card={round.left}
                        valueText={copy.value(leftValue)}
                        tone="neutral"
                        caption={`${Math.round(round.left.player.pp).toLocaleString()}pp`}
                      />
                    </motion.div>
                    <motion.div
                      key={round.right.player.userId}
                      layoutId={`streak-card-${round.right.player.userId}`}
                      className="flex-1"
                      // A new card deals in from the right rather than appearing.
                      initial={{ opacity: 0, x: 90 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.2 } }}
                      transition={{ type: "spring", stiffness: 260, damping: 26 }}
                    >
                      <CardFace
                        card={round.right}
                        valueText={revealed ? copy.value(counted) : copy.unknown}
                        tone={verdict ?? "neutral"}
                        caption={`${Math.round(round.right.player.pp).toLocaleString()}pp`}
                      />
                    </motion.div>
                  </AnimatePresence>
                </div>

                <div className="mt-10 flex flex-col items-center gap-3">
                  {over ? (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25 }}
                      className="flex flex-col items-center gap-2"
                    >
                      <div className="text-sm font-bold text-white">
                        {endedBy === "cashout"
                          ? `You stopped at ${streak} in a row.`
                          : copy.reveal(round.right.player.username, rightValue)}
                      </div>
                      <div className="text-[12px] text-osu-f1">
                        {streak === 0
                          ? "No streak this time."
                          : `You got ${streak} right${newBest ? ", a new best" : ""}.`}
                      </div>
                      {earned !== null && earned > 0 && (
                        <div className="flex items-center gap-1.5 text-[12px] font-bold text-emerald-400">
                          <Recycle className="h-3.5 w-3.5" />
                          <span className="tabular-nums">+{earned}</span>
                          <span>shards</span>
                        </div>
                      )}
                      {earned === 0 && streak > 0 && (
                        <div className="text-[11px] text-osu-f1">
                          That is today's shard allowance spent. The streak still counts.
                        </div>
                      )}
                      {!auth.viewer && streak > 0 && auth.loginAvailable && (
                        <div className="text-[11px] text-osu-f1">Sign in and runs like that pay shards.</div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
                        <button
                          type="button"
                          onClick={() => void start()}
                          className="rounded-full bg-osu-pink px-7 py-2.5 text-sm font-bold text-white transition hover:brightness-110 cursor-pointer"
                        >
                          Play again
                        </button>
                      </div>
                    </motion.div>
                  ) : (
                    <div className="flex flex-col items-center gap-3">
                    <div className="flex items-center gap-3">
                      {/* Coloured by direction, not by preference: up is
                          green and down is red because that is what arrows
                          mean everywhere, and the two carry identical weight
                          (same fill, same border, same text) so neither reads
                          as the recommended answer on a coin-flip question. */}
                      {([
                        {
                          choice: "more" as StreakGuess,
                          label: copy.more,
                          Icon: ChevronUp,
                          idle: "border-emerald-400/50 bg-emerald-400/10 text-emerald-200 hover:border-emerald-400 hover:bg-emerald-400/20 hover:text-white",
                        },
                        {
                          choice: "less" as StreakGuess,
                          label: copy.less,
                          Icon: ChevronDown,
                          idle: "border-rose-400/50 bg-rose-400/10 text-rose-200 hover:border-rose-400 hover:bg-rose-400/20 hover:text-white",
                        },
                      ]).map(({ choice, label, Icon, idle }) => (
                        <button
                          key={choice}
                          type="button"
                          onClick={() => guess(choice)}
                          disabled={revealed}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-7 py-3 text-sm font-bold transition active:scale-95 ${
                            revealed ? "border-osu-b3/30 text-osu-f1/70" : `${idle} cursor-pointer`
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                          {label}
                        </button>
                      ))}
                    </div>
                      {/* Stopping is a move, not an escape hatch: the run
                          banks what it earned and the card you walked away
                          from stays face down. */}
                      {streak > 0 && (
                        <button
                          type="button"
                          onClick={cashOut}
                          disabled={revealed}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-5 py-2 text-[12px] font-bold transition active:scale-95 ${
                            revealed
                              ? "border-osu-b3/30 text-osu-f1/50"
                              : "border-osu-b3/70 text-osu-f1 hover:border-white/60 hover:text-white cursor-pointer"
                          }`}
                        >
                          {auth.viewer ? (
                            <>
                              <Recycle className="h-3.5 w-3.5" />
                              {`Claim ${streakShardValue(streak)} ${streakShardValue(streak) === 1 ? "shard" : "shards"}`}
                            </>
                          ) : (
                            "End the run"
                          )}
                        </button>
                      )}
                    </div>
                  )}
                  {/* There has to be a way out of a run that is not the
                      browser's back button. */}
                  <button
                    type="button"
                    onClick={onExit}
                    className="text-[11px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
                  >
                    Back to packs
                  </button>
                </div>
              </>
      )}
    </div>
  );
}

