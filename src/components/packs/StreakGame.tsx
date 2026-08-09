import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronUp, Dices, Recycle, Timer } from "lucide-react";
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
import {
  cashOutBlitzStreak,
  guessBlitzStreak,
  blitzClientDeadline,
  BLITZ_ROUND_GRACE_MS,
  startBlitzStreak,
  type BlitzStreakPlayer,
  type BlitzStreakRound,
} from "#/lib/streak-blitz";
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
  streakPageCount,
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
import { getCachedCardBackDataUrl } from "./packArt";
import { StreakLeaderboard, useStreakBoard } from "./StreakLeaderboard";
import {
  playCardDraw,
  playDiceRoll,
  playRecycleClink,
  playStreakCorrect,
  playStreakMilestone,
  playStreakWrong,
  warmPackAudio,
} from "./packSfx";

// Higher or lower, hosted by the packs page: the board is the page's middle,
// so the pull ticker, the wallet and the shard count stay where they were
// while you play. The game owns its own run state and nothing else.
//
// It plays two ways. Casual deals itself here, out of the rankings snapshot
// the packs pool already reads, and keeps its best in localStorage. Blitz is
// dealt by the backend a round at a time, with the answer held there and a
// clock on each guess, because the leaderboard next to it cannot be fed by a
// number the browser picked. The two share every pixel below the toggle.

/* How long the answer sits on screen before the board moves on. Long enough to
   read the number that just beat you, short enough that a good run never waits
   on the animation. Blitz deadlines are dealt with this hold added on top,
   so the round landing behind it is still worth its full twelve seconds; the
   opening deal carries the same hold, spent turning the two cards face up. */
const REVEAL_HOLD_MS = 1250;
const COUNT_UP_MS = 700;
/* How long the dice are in the air before the guess they picked is submitted.
   Long enough to hear them land and see which button they chose, short enough
   that it is not a meaningful bite out of a blitz clock. */
const DICE_SETTLE_MS = 620;
/* What a blitz round is worth on screen. Mirrors STREAK_ROUND_MS on the
   backend: the deadline arrives with the mint/reveal hold folded in, and if
   the cards were ready early the countdown must not show the surplus as
   thinking time - it runs twelve seconds and the rest is quiet grace. */
const BLITZ_ROUND_MS = 12_000;

/* The question prints each name in the colour of the card under it, and that
   colour only exists once the card mints, so let it arrive rather than snap. */
const NAME_TINT: CSSProperties = { transition: "color 300ms ease, text-shadow 300ms ease" };

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
  /* False while the art is still being minted. The board deals that card face
     down and turns it over when this goes true - including for a card that
     came back without art, so no card is left face down forever. */
  minted: boolean;
}

/* One card's art, minted from the plays the backend already has stored. Only
   the cached read: a pack is paid for and may spend an osu! fetch on a cold
   player, but a free game should never spend that budget, so a player the
   backend has not fetched yet plays as an avatar and is warmed in the
   background for next time. */
const cardCache = new Map<number, StreakCard>();

/* One mint per player, however many times the board asks: a blitz guess
   pre-mints the next pair while the reveal is still up, and the round showing
   asks again for whichever card has not landed yet. */
const mintsInFlight = new Map<number, Promise<StreakCard>>();

/* The question numbers beyond the rankings snapshot (best-play stars, join
   date, playtime, ...), one batched read per page of the pool and kept for
   the session: runs re-draw the same players, and the server answers from
   its own cache behind an hour of browser cache anyway. A player the fetch
   failed for just plays on the snapshot questions. Casual only - a blitz
   round arrives with its own numbers already decided. */
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
  const inFlight = mintsInFlight.get(player.userId);
  if (inFlight) return inFlight;
  const minting = mintStreakCardFresh(player);
  mintsInFlight.set(player.userId, minting);
  try {
    return await minting;
  } finally {
    mintsInFlight.delete(player.userId);
  }
}

async function mintStreakCardFresh(player: StreakPlayer): Promise<StreakCard> {
  let card: StreakCard = { player, thumbnail: null, nameStyle: null, minted: true };
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
        minted: true,
      };
    }
  } catch {
    // A player the backend has never fetched still plays, just without art.
  }
  cardCache.set(player.userId, card);
  return card;
}

/* A blitz card is a name, a face and a rank: the numbers behind it are the
   question, so the server sends none of them. It still mints the same art. */
function blitzStreakPlayer(player: BlitzStreakPlayer): StreakPlayer {
  return {
    ...player,
    plays: null,
    score: null,
    oldestTopAt: null,
    dtTop: null,
    k7Top: null,
    playTimeHours: null,
    joinedAt: null,
    followers: null,
    replayViews: null,
  };
}

function placeholderCard(player: StreakPlayer): StreakCard {
  return cardCache.get(player.userId) ?? { player, thumbnail: null, nameStyle: null, minted: false };
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

/* When the bar turns from pink to rose, which is the only thing about this
   clock that changes discretely. */
const CLOCK_URGENT_MS = 3000;

/* The blitz clock. Mounted fresh per round (the board keys it on the deadline),
   so the deadline it is given never changes under it.

   It draws itself rather than rendering itself: the bar's scale and the
   seconds text are written straight to the DOM inside one requestAnimationFrame
   loop, and React only hears about the moment it turns urgent. Ticking it
   through state was visibly steppy - a hundred-millisecond interval is ten
   positions a second, so the bar hopped rather than swept - and the fix is not
   a faster interval, which would re-render the whole board sixty times a
   second for one moving element. Scale rather than width, so the browser can
   move it without laying anything out again.

   It measures against the deadline rather than counting down from a duration,
   so a tab that was throttled comes back showing the truth. What happens when
   it runs out is the game's business, not this component's. */
function RoundClock({ deadlineAt, frozen }: { deadlineAt: number; frozen: boolean }) {
  const [total] = useState(() => Math.max(1, deadlineAt - Date.now()));
  const [urgent, setUrgent] = useState(() => deadlineAt - Date.now() <= CLOCK_URGENT_MS);
  const barRef = useRef<HTMLSpanElement>(null);
  const secondsRef = useRef<HTMLSpanElement>(null);
  /* The one re-render this component allows itself, so the frame loop is not
     calling setState sixty times a second to say the same thing. */
  const wentUrgent = useRef(urgent);

  useEffect(() => {
    if (frozen) return;
    let frame = 0;
    let painted = -1;
    const paint = () => {
      const left = Math.max(0, deadlineAt - Date.now());
      if (barRef.current) barRef.current.style.transform = `scaleX(${Math.min(1, left / total)})`;
      // The text only changes once a second; writing it every frame would
      // churn a text node sixty times over for no visible difference.
      const seconds = Math.ceil(left / 1000);
      if (seconds !== painted) {
        if (secondsRef.current) secondsRef.current.textContent = String(seconds);
        painted = seconds;
      }
      if (left <= CLOCK_URGENT_MS && !wentUrgent.current) {
        wentUrgent.current = true;
        setUrgent(true);
      }
      if (left > 0) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [deadlineAt, frozen, total]);

  return (
    // translate="no": the seconds text is rewritten straight to the DOM every
    // second; auto-translate's <font> rewrites would eat those writes and its
    // mutation-watching would re-translate the clock in a loop.
    <div translate="no" className="mt-3 flex w-full max-w-[360px] items-center gap-3">
      <span
        ref={secondsRef}
        className={`w-5 text-right text-[15px] font-bold tabular-nums ${urgent ? "text-rose-400" : "text-white"}`}
        aria-live="off"
      >
        {Math.ceil(Math.max(0, deadlineAt - Date.now()) / 1000)}
      </span>
      <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-osu-b4">
        <span
          ref={barRef}
          data-clock-bar=""
          className={`block h-full origin-left rounded-full will-change-transform ${
            urgent ? "bg-rose-400" : "bg-osu-pink"
          }`}
          style={{ transform: `scaleX(${Math.min(1, Math.max(0, deadlineAt - Date.now()) / total)})` }}
        />
      </span>
    </div>
  );
}

interface Round {
  left: StreakCard;
  right: StreakCard;
  metric: StreakMetric;
  leftValue: number;
  /* Known at the deal in casual, and only once the guess has been answered in
     blitz, where the server holds it until then. */
  rightValue: number | null;
  /* Blitz only, on this browser's clock. */
  deadlineAt: number | null;
}

/* The deck's own back: the same art the pack opening deals, so a card the game
   is still minting is a card lying face down rather than a placeholder. It is
   drawn on a canvas, so the first paint (and anything without one) gets the CSS
   twin instead of an empty rectangle. */
function CardBack({ src }: { src: string | null }) {
  return (
    <div
      data-streak-card-back=""
      className="absolute inset-0 overflow-hidden rounded-[12px] bg-[linear-gradient(140deg,#221a3d,#161029_55%,#0b0818)] bg-cover bg-center"
      style={{
        backgroundImage: src ? `url(${src})` : undefined,
        backfaceVisibility: "hidden",
        boxShadow: "0 12px 34px rgba(0,0,0,0.5)",
      }}
    >
      {!src && <div className="absolute inset-[6px] rounded-[8px] border border-white/20" />}
    </div>
  );
}

/* The front of a card that minted without art (a player the backend has no
   stored plays for). Built from the back's own frame and centre disc so it
   reads as a card in the same deck, not as a card that failed. */
function ArtlessCardFront({ player }: { player: StreakPlayer }) {
  const avatarSrc = avatarImageSrc(player.avatarUrl, player.userId) ?? `/api/avatar?u=${player.userId}`;
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  useEffect(() => setAvatarLoaded(false), [avatarSrc]);
  return (
    <div className="absolute inset-0 bg-[linear-gradient(140deg,#2a2050,#171130_55%,#0c0919)]">
      <div className="absolute inset-[6px] rounded-[8px] border border-white/20" />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative flex h-[62px] w-[62px] items-center justify-center overflow-hidden rounded-full border-2 border-white/25 bg-osu-b5 text-xl font-bold text-white/45 sm:h-[84px] sm:w-[84px] sm:text-2xl">
          <span aria-hidden>{player.username.trim().slice(0, 1).toUpperCase()}</span>
          <img
            src={avatarSrc}
            alt=""
            onLoad={() => setAvatarLoaded(true)}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
              avatarLoaded ? "opacity-100" : "opacity-0"
            }`}
            draggable={false}
          />
        </div>
      </div>
      <div className="absolute inset-x-3 bottom-4 truncate text-center text-[9px] font-bold uppercase tracking-[0.22em] text-white/45">
        {player.username}
      </div>
    </div>
  );
}

function CardFace({
  card,
  cardBack,
  valueText,
  tone,
  caption,
}: {
  card: StreakCard;
  cardBack: string | null;
  valueText: string;
  tone: "neutral" | "correct" | "wrong";
  caption: string;
}) {
  const player = card.player;
  const reducedMotion = useReducedMotion();
  return (
    <div className="flex w-full flex-col items-center">
      <motion.div
        className="relative w-[142px] sm:w-[190px]"
        style={{ aspectRatio: "5 / 7", perspective: 900 }}
        animate={
          tone === "wrong"
            ? { x: [0, -7, 6, -4, 0] }
            : tone === "correct"
              ? { scale: [1, 1.035, 1] }
              : { x: 0, scale: 1 }
        }
        transition={{ duration: 0.42 }}
      >
        {/* Minting is the only thing between the two faces, so it turns the
            card over exactly the way the pack reveal does. A card whose art was
            minted earlier in the session is already face up on mount
            (initial={false}), so a repeat player never re-flips. */}
        <motion.div
          className="relative h-full w-full"
          data-streak-card-face={card.minted ? "front" : "back"}
          style={{ transformStyle: "preserve-3d" }}
          initial={false}
          animate={{ rotateY: card.minted ? 180 : 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.44, ease: [0.3, 0.1, 0.3, 1] }}
        >
          <CardBack src={cardBack} />
          <div
            className="absolute inset-0 overflow-hidden rounded-[12px] bg-osu-b4"
            style={{
              transform: "rotateY(180deg)",
              backfaceVisibility: "hidden",
              boxShadow: "0 12px 34px rgba(0,0,0,0.5)",
            }}
          >
            {card.thumbnail ? (
              <img
                src={card.thumbnail}
                alt={`${player.username} maniacard`}
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <ArtlessCardFront player={player} />
            )}
          </div>
        </motion.div>
      </motion.div>
      <div className="mt-3 flex items-center gap-1.5">
        <CountryFlag code={player.countryCode} size="xs" decorative />
        {/* Not a link: the answer is one profile visit away, and a mid-round tap
            on a name would either leave the game or hand over the number. */}
        <span className="truncate text-[14px] font-bold text-white">{player.username}</span>
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

/* Waiting for the two data rows is part of dealing a game, not a half-built
   UI. Two backs land in exactly the footprint the cards will take, so the round
   arriving does not replace them: the same backs stay put and turn over. */
function DealingBoard({ cardBack }: { cardBack: string | null }) {
  return (
    <div
      className="mt-9 flex items-start justify-center gap-4 sm:gap-14"
      data-testid="streak-dealing-board"
      aria-hidden
    >
      {[0, 1].map((slot) => (
        <div key={slot} className="flex flex-1 flex-col items-center">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.26, delay: slot * 0.07, ease: "easeOut" }}
            className="relative w-[142px] sm:w-[190px]"
            style={{ aspectRatio: "5 / 7" }}
          >
            <CardBack src={cardBack} />
          </motion.div>
          {/* Reserve the metadata footprint so the reveal does not move the
              rest of the page; unlike the old bars, this space is invisible. */}
          <div className="h-[76px]" />
        </div>
      ))}
    </div>
  );
}

/* The back is a canvas the pack opening already builds and keeps; asking for it
   here covers the deep link that lands straight in the game, where the packs
   page never got its idle window to warm one. */
function useCardBackImage(): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    try {
      setSrc(getCachedCardBackDataUrl());
    } catch {
      // No 2D canvas here; the CSS back stands in.
    }
  }, []);
  return src;
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
  const [endedBy, setEndedBy] = useState<null | "wrong" | "cashout" | "timeout">(null);
  const [newBest, setNewBest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dealing, setDealing] = useState(true);
  const cardBack = useCardBackImage();
  /* What the arcade paid for the run that just ended, and what is left of
     today's allowance. Null while signed out or with no backend, which is how
     the page knows not to promise shards. */
  const [earned, setEarned] = useState<number | null>(null);
  const [allowance, setAllowance] = useState<{ remainingToday: number; cap: number } | null>(null);
  /* Which slice of the pool the run draws from: the top 1000 the community can
     argue about, or the hard mode's whole tracked snapshot. Shadowed in a ref
     because the deal pipeline reads it from callbacks that would otherwise
     capture a stale value mid-run. */
  const [mode, setMode] = useState<StreakPool>("top500");
  const modeRef = useRef<StreakPool>("top500");
  /* Blitz: the backend deals, holds the answer and runs the clock, and the
     result goes on the board. Shadowed for the same reason as the pool. */
  const [blitz, setBlitz] = useState(false);
  const blitzRef = useRef(false);
  const runId = useRef<string | null>(null);
  /* The clock ran out and the run is on its way to being closed. Held apart
     from `over` so the buttons die the instant the countdown does, without
     waiting on the round trip that makes it official. */
  const [timedOut, setTimedOut] = useState(false);
  /* Bumped whenever a blitz run ends, which is the only thing that can change
     the board next to it. */
  const [boardVersion, setBoardVersion] = useState(0);
  /* Which side the dice landed on, held so the button they chose can light up
     while they are still settling. Null means nobody rolled this round. */
  const [rolled, setRolled] = useState<StreakGuess | null>(null);
  /* Locks the board for as long as the dice are in the air. A ref rather than
     the state above, because the roll's own guess has to get through the same
     door it is holding shut for everyone else. */
  const rolling = useRef(false);

  /* The pool the game draws from, loaded a page at a time. Kept in a ref
     because it is bookkeeping the render never reads. Casual only. */
  const pool = useRef<{ total: number; loaded: Set<number>; entries: LiveGlobalRankingEntry[] }>({
    total: 0,
    loaded: new Set(),
    entries: [],
  });
  /* Everyone this run has already put on the board, so a streak never asks the
     same card twice. */
  const seen = useRef<Set<number>>(new Set());
  /* The card after next, minted while the current one is being guessed at, so
     a right answer never waits on a fetch. Casual only: blitz does not know
     who is next until the guess is in. */
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
  const nextPlayer = useCallback(async (keep?: number, aimedPage?: number): Promise<StreakPlayer | null> => {
    let player: StreakPlayer | null = null;
    /* The hard mode's draw is aimed, not sifted: a uniformly random pool
       position, then the page that holds it. Picking from the pages already
       loaded would favour the top, since those load first (and the classic
       game shares them). One page fetch per round is the price of "literally
       anyone", and the backend answers it from its own snapshot. */
    if (modeRef.current === "anyone" && pool.current.total > 0) {
      const page = aimedPage ?? streakRankPage(1 + Math.floor(Math.random() * pool.current.total));
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
    return player;
  }, [fetchPage, loadPage]);

  const nextCard = useCallback(async (keep?: number): Promise<StreakCard | null> => {
    const player = await nextPlayer(keep);
    return player ? mintStreakCard(player) : null;
  }, [nextPlayer]);

  /* A casual round is playable from its ranking + metric rows; full card art is
     presentation, not game state. Put the avatar fallback on the board first,
     then replace just that side when its stored-score card finishes minting.
     This is also how Blitz avoids spending its live clock on a thumbnail. */
  const hydrateRoundCard = useCallback((side: "left" | "right", player: StreakPlayer, token: number) => {
    void mintStreakCard(player).then((card) => {
      if (token !== deal.current) return;
      setRound((current) =>
        current && current[side].player.userId === player.userId ? { ...current, [side]: card } : current,
      );
    });
  }, []);

  /* Puts a server-dealt round on the board. The cards go up before their art
     does, so the question is answerable the moment the names are readable, but
     the countdown stays hidden until both have turned over: the deadline the
     server dealt includes a hold for exactly this wait. */
  const showBlitzRound = useCallback((payload: BlitzStreakRound, receivedAt: number, token: number) => {
    const left = blitzStreakPlayer(payload.left.player);
    const right = blitzStreakPlayer(payload.right.player);
    setRound({
      left: placeholderCard(left),
      right: placeholderCard(right),
      metric: payload.metric,
      leftValue: payload.left.value,
      rightValue: null,
      deadlineAt: blitzClientDeadline(payload, receivedAt),
    });
    setVerdict(null);
    setRolled(null);
    setTimedOut(false);
    setClockDeadline(null);
    playCardDraw();
    for (const [side, player] of [["left", left], ["right", right]] as const) {
      if (cardCache.has(player.userId)) continue;
      hydrateRoundCard(side, player, token);
    }
  }, [hydrateRoundCard]);

  const start = useCallback(async () => {
    const token = (deal.current += 1);
    const stale = () => token !== deal.current;
    if (!isLiveBackendConfigured()) {
      setError("Higher or lower is unavailable right now. Try again in a bit.");
      setDealing(false);
      return;
    }
    setDealing(true);
    setError(null);
    setOver(false);
    setEndedBy(null);
    setNewBest(false);
    setVerdict(null);
    setRolled(null);
    setStreak(0);
    setEarned(null);
    setTimedOut(false);
    seen.current = new Set();
    upcoming.current = null;
    runId.current = null;
    rolling.current = false;

    if (blitzRef.current) {
      /* Blitz is played as an account, because that is what a board is a list
         of. Nothing is dealt until there is one. */
      if (!auth.viewer) {
        setError("Sign in with osu! to play blitz.");
        setDealing(false);
        return;
      }
      try {
        const run = await startBlitzStreak({ data: { pool: modeRef.current } });
        const receivedAt = Date.now();
        if (stale()) return;
        if (!run?.round) {
          setError("Could not deal a blitz run. Try again in a moment.");
          return;
        }
        runId.current = run.runId;
        showBlitzRound(run.round, receivedAt, token);
      } catch {
        if (!stale()) setError("Could not deal a blitz run. Try again in a moment.");
      } finally {
        if (!stale()) setDealing(false);
      }
      return;
    }

    try {
      // One random page is ample for the opening board. Choosing it across the
      // mode's whole known depth keeps the first pair uniform without the old
      // page-1-then-random-page waterfall (which also over-weighted the top 50).
      // Anyone cannot know its last page before the response reports `total`,
      // but it is never the initial mode and keeps page 1 as a safe fallback.
      if (pool.current.entries.length === 0) {
        const initialPage = modeRef.current === "anyone"
          ? 1
          : 1 + Math.floor(Math.random() * streakPageCount(Number.MAX_SAFE_INTEGER, modeRef.current));
        let loadedPage = initialPage;
        let snapshot = await fetchLiveGlobalRankings({
          page: initialPage,
          pageSize: STREAK_PAGE_SIZE,
          sort: "rank",
          dir: "desc",
        });
        if (stale()) return;
        // Small/dev pools may not reach the mode's advertised depth. The empty
        // response still tells us the real total, so retry inside its last page.
        if (snapshot.ranking.length < 2 && snapshot.total >= 2) {
          loadedPage = 1 + Math.floor(Math.random() * streakPageCount(snapshot.total, modeRef.current));
          if (loadedPage !== initialPage) {
            snapshot = await fetchLiveGlobalRankings({
              page: loadedPage,
              pageSize: STREAK_PAGE_SIZE,
              sort: "rank",
              dir: "desc",
            });
            if (stale()) return;
          }
        }
        await loadStreakMetrics(snapshot.ranking);
        if (stale()) return;
        pool.current = { total: snapshot.total, loaded: new Set([loadedPage]), entries: snapshot.ranking };
      }

      /* Hard mode aims each draw at a uniformly random rank page. Prepare the
         two opening pages together so two independent network waterfalls do
         not sit between the click and the question. A repeated page is fetched
         once and the seen set still makes the two selected players distinct. */
      let aimedPages: [number, number] | null = null;
      if (modeRef.current === "anyone" && pool.current.total > 0) {
        aimedPages = [
          streakRankPage(1 + Math.floor(Math.random() * pool.current.total)),
          streakRankPage(1 + Math.floor(Math.random() * pool.current.total)),
        ];
        const missingPages = [...new Set(aimedPages)].filter((page) => !pool.current.loaded.has(page));
        await Promise.all(missingPages.map((page) => fetchPage(page).catch(() => false)));
        if (stale()) return;
      }

      const firstPlayer = await nextPlayer(undefined, aimedPages?.[0]);
      const secondPlayer = await nextPlayer(undefined, aimedPages?.[1]);
      if (stale()) return;
      const metric = firstPlayer && secondPlayer ? pickStreakMetric(firstPlayer, secondPlayer, Math.random) : null;
      if (!firstPlayer || !secondPlayer || !metric) {
        setError("The tracked player pool is too small to play right now.");
        return;
      }
      const first = placeholderCard(firstPlayer);
      const second = placeholderCard(secondPlayer);
      setRound({
        left: first,
        right: second,
        metric,
        leftValue: streakMetricValue(firstPlayer, metric) ?? 0,
        rightValue: streakMetricValue(secondPlayer, metric) ?? 0,
        deadlineAt: null,
      });
      playCardDraw();
      hydrateRoundCard("left", firstPlayer, token);
      hydrateRoundCard("right", secondPlayer, token);
      upcoming.current = nextCard(secondPlayer.userId);
    } catch {
      if (!stale()) setError("Could not reach the player pool. Try again in a moment.");
    } finally {
      if (!stale()) setDealing(false);
    }
  }, [auth.viewer, fetchPage, hydrateRoundCard, nextCard, nextPlayer, showBlitzRound]);

  useEffect(() => {
    // Warmed here rather than on the first guess: building the context and its
    // noise buffer inside the click would land right where the verdict sound
    // is supposed to be. Arriving on this board is a tap either way.
    warmPackAudio();
    void start();
    // Started once on mount; "Play again" calls start() directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Changing the game re-deals, so it is only offered while there is nothing
     on the line: switching mid-streak would either dump the run or let a
     top-1000 streak keep growing against easier or harder cards than it was
     earned on. */
  const settingsLocked = dealing || (!over && streak > 0);
  const switchPool = useCallback((next: StreakPool) => {
    if (next === modeRef.current || settingsLocked) return;
    modeRef.current = next;
    setMode(next);
    void start();
  }, [settingsLocked, start]);

  const toggleBlitz = useCallback(() => {
    if (settingsLocked) return;
    blitzRef.current = !blitzRef.current;
    setBlitz(blitzRef.current);
    void start();
  }, [settingsLocked, start]);

  /* Cashing in happens at the end of a run rather than per correct guess, so
     one claim covers the whole streak. Blitz runs are paid by the backend
     when it closes them - it counted the streak, so it does not need telling
     what one was worth. */
  const claim = useCallback((finalStreak: number, ending: "wrong" | "cashout" | "timeout") => {
    track("streak_run", {
      streak: finalStreak,
      ended: ending,
      pool: modeRef.current,
      blitz: blitzRef.current,
      streak_username: auth.viewer?.username,
    });
    if (blitzRef.current || !auth.viewer || finalStreak <= 0) return;
    void claimStreakShards({ data: { streak: finalStreak } })
      .then((result) => {
        if (!result) return;
        setEarned(result.granted);
        setAllowance({ remainingToday: result.remainingToday, cap: result.cap });
      })
      .catch(() => {});
  }, [auth.viewer]);

  /* A finished run, however it finished. Casual writes its own best; blitz
     has a board for that, and the number it puts there is the server's. */
  const finish = useCallback(
    (finalStreak: number, ending: "wrong" | "cashout" | "timeout") => {
      setOver(true);
      setEndedBy(ending);
      if (!blitzRef.current) {
        setNewBest(finalStreak > best);
        if (finalStreak > best) {
          setBest(finalStreak);
          writeBestStreak(finalStreak, modeRef.current);
        }
      } else {
        setBoardVersion((version) => version + 1);
      }
      claim(finalStreak, ending);
    },
    [best, claim],
  );

  const guessCasual = useCallback(
    (choice: StreakGuess) => {
      if (!round || round.rightValue === null) return;
      busy.current = true;
      const token = deal.current;
      const correct = isStreakGuessCorrect(choice, round.leftValue, round.rightValue);
      setVerdict(correct ? "correct" : "wrong");
      if (!correct) {
        playStreakWrong();
        finish(streak, "wrong");
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
          setRound({
            left: round.right,
            right: next,
            metric,
            leftValue: streakMetricValue(round.right.player, metric) ?? 0,
            rightValue: streakMetricValue(next.player, metric) ?? 0,
            deadlineAt: null,
          });
          setVerdict(null);
          setRolled(null);
          playCardDraw();
          upcoming.current = nextCard(next.player.userId);
          busy.current = false;
        })();
      }, REVEAL_HOLD_MS);
    },
    [finish, nextCard, round, streak],
  );

  const guessBlitz = useCallback(
    (choice: StreakGuess) => {
      const id = runId.current;
      if (!round || !id) return;
      busy.current = true;
      const token = deal.current;
      void (async () => {
        const result = await guessBlitzStreak({ data: { runId: id, guess: choice } }).catch(() => null);
        const receivedAt = Date.now();
        if (token !== deal.current) {
          busy.current = false;
          return;
        }
        if (!result) {
          setError("Lost the run. The board could not be reached.");
          busy.current = false;
          return;
        }
        // The number that was being guessed at, which is the first the browser
        // has seen of it.
        if (result.revealed) {
          setRound((current) => (current ? { ...current, rightValue: result.revealed?.value ?? null } : current));
        }
        setVerdict(result.correct ? "correct" : "wrong");
        setStreak(result.streak);
        if (result.reward) {
          setEarned(result.reward.granted);
          setAllowance({ remainingToday: result.reward.remainingToday, cap: result.reward.cap });
        }
        if (!result.correct || result.status === "ended") {
          if (result.correct) playStreakCorrect(result.streak);
          else playStreakWrong();
          /* A run can also end on a right answer, when the backend has no pair
             left to deal. That is the game stopping, not the player getting
             one wrong, so it is summarised the way stopping is. */
          finish(result.streak, result.correct ? "cashout" : result.expired ? "timeout" : "wrong");
          busy.current = false;
          return;
        }
        playStreakCorrect(result.streak);
        if (result.streak % STREAK_MILESTONE === 0) playStreakMilestone();
        const next = result.round;
        /* Mint the next pair while the reveal is still on screen: the hold the
           server pays for the reveal then covers the art too, so the next
           round usually lands face up with its countdown already showable. */
        if (next) {
          void mintStreakCard(blitzStreakPlayer(next.left.player));
          void mintStreakCard(blitzStreakPlayer(next.right.player));
        }
        window.setTimeout(() => {
          if (token !== deal.current) {
            busy.current = false;
            return;
          }
          if (!next) {
            setError("Ran out of players to draw.");
            busy.current = false;
            return;
          }
          showBlitzRound(next, receivedAt, token);
          busy.current = false;
        }, REVEAL_HOLD_MS);
      })();
    },
    [finish, round, showBlitzRound],
  );

  const guess = useCallback(
    (choice: StreakGuess) => {
      if (busy.current || rolling.current || !round || verdict || over || timedOut) return;
      if (blitzRef.current) guessBlitz(choice);
      else guessCasual(choice);
    },
    [guessCasual, guessBlitz, over, round, timedOut, verdict],
  );

  /* For a round nobody has a read on. Half the questions in this game are a
     coin flip to anyone who does not know the player, so rather than pretend
     otherwise, the game will flip it: the dice pick a side, that side lights
     up as though it had been pressed, and it is played as an ordinary guess.
     A wrong one still ends the run. */
  const rollDice = useCallback(() => {
    if (busy.current || rolling.current || !round || verdict || over || timedOut) return;
    const choice: StreakGuess = Math.random() < 0.5 ? "more" : "less";
    const token = deal.current;
    rolling.current = true;
    setRolled(choice);
    playDiceRoll();
    window.setTimeout(() => {
      rolling.current = false;
      // A re-deal landed while the dice were in the air (a pool switch, a
      // "play again"). They were thrown at a round that is gone.
      if (token !== deal.current) return;
      guess(choice);
    }, DICE_SETTLE_MS);
  }, [guess, over, round, timedOut, verdict]);

  /* Stopping on purpose. A run had no exit before this: leaving mid-streak
     dropped everything it had earned, because the claim only fired on a wrong
     guess. Now the streak is banked the moment you decide it is. */
  const cashOut = useCallback(() => {
    if (busy.current || over || streak <= 0) return;
    if (blitzRef.current) {
      const id = runId.current;
      if (!id) return;
      busy.current = true;
      void cashOutBlitzStreak({ data: { runId: id } })
        .then((result) => {
          if (result?.reward) {
            setEarned(result.reward.granted);
            setAllowance({ remainingToday: result.reward.remainingToday, cap: result.reward.cap });
          }
          if (auth.viewer && result?.reward?.granted) playRecycleClink(result.reward.granted);
          finish(result?.streak ?? streak, result?.endedBy === "timeout" ? "timeout" : "cashout");
        })
        .catch(() => finish(streak, "cashout"))
        .finally(() => {
          busy.current = false;
        });
      return;
    }
    // Shards clinking, the same sound recycling makes, but only for someone
    // who is actually being paid.
    if (auth.viewer) playRecycleClink(streakShardValue(streak));
    finish(streak, "cashout");
  }, [auth.viewer, finish, over, streak]);

  /* The countdown holds while either card is still face down: a timer running
     against two card backs reads as time stolen. The deadline is the server's
     and was dealt with a hold for this wait, so the hold here is bounded by
     the same amount - past it the clock appears anyway rather than hiding
     time that is running out regardless. */
  const cardsFaceUp = !!round && round.left.minted && round.right.minted;
  const [clockForced, setClockForced] = useState(false);
  useEffect(() => {
    if (!blitz || !round?.deadlineAt || cardsFaceUp) return;
    setClockForced(false);
    const show = window.setTimeout(() => setClockForced(true), REVEAL_HOLD_MS);
    return () => window.clearTimeout(show);
  }, [blitz, cardsFaceUp, round?.deadlineAt]);

  /* What the countdown (and the buttons it kills) runs against: armed the
     moment the cards are face up, twelve seconds, never more. Cards that
     minted early would otherwise show the leftover hold as a 13 on the clock.
     Capped at the server's deadline, so it can never promise time the server
     will not honour. */
  const [clockDeadline, setClockDeadline] = useState<number | null>(null);
  useEffect(() => {
    const deadline = round?.deadlineAt;
    if (!blitz || !deadline || !(cardsFaceUp || clockForced)) return;
    setClockDeadline((current) => current ?? Math.min(deadline, Date.now() + BLITZ_ROUND_MS));
  }, [blitz, cardsFaceUp, clockForced, round?.deadlineAt]);

  /* The clock. It kills the buttons the moment it hits zero, then waits out
     the grace the backend allows for the wire before closing the run, so the
     server agrees it was a timeout rather than ending it a second early as a
     cash-out. Stalling past it wins nothing either way: the streak banked is
     the same number. */
  useEffect(() => {
    const deadline = round?.deadlineAt;
    if (!blitz || over || verdict || !deadline) return;
    const id = runId.current;
    /* The buttons die with the countdown the player was shown, not with the
       server's later deadline; the close below still waits out the real one. */
    const hitZero = window.setTimeout(
      () => setTimedOut(true),
      Math.max(0, (clockDeadline ?? deadline) - Date.now()),
    );
    const close = window.setTimeout(() => {
      if (!id || busy.current) return;
      busy.current = true;
      void cashOutBlitzStreak({ data: { runId: id } })
        .then((result) => {
          if (result?.reward) {
            setEarned(result.reward.granted);
            setAllowance({ remainingToday: result.reward.remainingToday, cap: result.reward.cap });
          }
          setRound((current) =>
            current && result?.revealed ? { ...current, rightValue: result.revealed.value } : current,
          );
          finish(result?.streak ?? streak, "timeout");
        })
        .catch(() => finish(streak, "timeout"))
        .finally(() => {
          busy.current = false;
        });
    }, Math.max(0, deadline + BLITZ_ROUND_GRACE_MS + 250 - Date.now()));
    return () => {
      window.clearTimeout(hitZero);
      window.clearTimeout(close);
    };
  }, [finish, over, blitz, clockDeadline, round, streak, verdict]);

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
  const leftValue = round?.leftValue ?? 0;
  const rightValue = round?.rightValue ?? 0;
  const counted = useCountUp(leftValue, rightValue, revealed);
  const { board: boardData, failed: boardFailed } = useStreakBoard(mode, auth.viewer?.id ?? null, boardVersion);
  const board = (compact: boolean) => (
    <StreakLeaderboard
      board={boardData}
      failed={boardFailed}
      viewerId={auth.viewer?.id ?? null}
      compact={compact}
      /* Records are permanent, so removing one is the only moderation there is,
         and it belongs where the board is read. True admins only. */
      canModerate={auth.isAdmin === true}
      onRemoved={() => setBoardVersion((version) => version + 1)}
    />
  );

  return (
    /* Three columns, the outer two the same width: the board stays on the
       page's centre line, under the wallet strip it is played beneath, instead
       of being shoved left by the leaderboard. The left one is empty and only
       exists to hold that balance. Below xl there is no honest room for a rail
       beside two cards, so the board goes under the game instead. */
    <div className="mx-auto flex w-full max-w-[1320px] flex-col items-center gap-10 xl:flex-row xl:items-start xl:justify-center xl:gap-10">
      <div className="hidden w-[210px] shrink-0 xl:block" aria-hidden />
      <div className="w-full max-w-[860px] xl:flex-1">
            {/* The two things that decide what game this is, said once and at a
                size that reads as a choice rather than as a footnote. The
                streak they are being played for sits opposite. */}
            <div className="mb-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-3 sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-full bg-osu-b4/70 p-0.5 text-[12px] font-bold">
                  {([["top500", "Top 500"], ["top", "Top 1000"], ["anyone", "Anyone"]] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => switchPool(value)}
                      disabled={settingsLocked}
                      aria-pressed={mode === value}
                      className={`rounded-full px-4 py-1.5 transition-colors ${
                        mode === value
                          ? "bg-osu-pink text-white"
                          : settingsLocked
                            ? "text-osu-f1/50"
                            : "text-osu-f1 hover:text-white cursor-pointer"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {/* Blitz is the same game against a clock, for a place on the
                    board. Off by default: the casual run is the one you can
                    stop in the middle of. */}
                <button
                  type="button"
                  onClick={toggleBlitz}
                  disabled={settingsLocked}
                  aria-pressed={blitz}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12px] font-bold transition-colors ${
                    blitz
                      ? "border-osu-pink bg-osu-pink/15 text-white"
                      : settingsLocked
                        ? "border-osu-b3/30 text-osu-f1/50"
                        : "border-osu-b3/40 text-osu-f1 hover:border-osu-pink/50 hover:text-white cursor-pointer"
                  }`}
                >
                  <Timer className="h-3.5 w-3.5" />
                  Blitz
                </button>
              </div>
              <div className="flex items-baseline gap-1.5 sm:flex-col sm:items-end sm:gap-0">
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
                  streak
                  {!blitz && best > 0 && <span className="ml-1.5 normal-case tracking-normal">best {best}</span>}
                </div>
              </div>
            </div>

            {/* The question is the whole page, so it reads as the headline and
                sits over the two cards it is asking about. It goes with the
                board when something has gone wrong: the round it was asking
                about is not on the table any more, and leaving it up reads as
                a live question nobody is allowed to answer. */}
            <div className={`flex flex-col items-center ${error ? "hidden" : ""}`}>
              {/* translate="no": this sentence interleaves bare text with the
                  two name spans and is structurally replaced every round —
                  browser auto-translate merges and reorders exactly this kind
                  of run into <font> wrappers, and React's next commit over it
                  throws NotFoundError. */}
              <div translate="no" className="max-w-[580px] text-center text-[17px] leading-snug text-white sm:text-xl">
                {round && copy ? (
                  <>
                    {copy.q.prefix}
                    {/* The tier colour is only known once the card behind the
                        name mints, so it eases in with the flip instead of
                        snapping white to gold under the reader. */}
                    <span className="inline-block font-bold" style={{ ...NAME_TINT, ...round.right.nameStyle }}>
                      {round.right.player.username}
                    </span>
                    {copy.q.middle}
                    <span className="inline-block font-bold" style={{ ...NAME_TINT, ...round.left.nameStyle }}>
                      {round.left.player.username}
                    </span>
                    {copy.q.suffix}
                  </>
                ) : (
                  <span className="font-semibold text-osu-f1">Dealing a matchup…</span>
                )}
              </div>
              {blitz && clockDeadline !== null && !over && (
                <RoundClock key={clockDeadline} deadlineAt={clockDeadline} frozen={revealed} />
              )}
              {/* translate="no": both spans mount/unmount as runs start and
                  end, over numbers auto-translate likes to rewrite. */}
              <div translate="no" className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-osu-f1">
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
              <DealingBoard cardBack={cardBack} />
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
                        cardBack={cardBack}
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
                        cardBack={cardBack}
                        valueText={revealed && round.rightValue !== null ? copy.value(counted) : copy.unknown}
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
                          : endedBy === "timeout" && round.rightValue === null
                            ? "Out of time."
                            : copy.reveal(round.right.player.username, round.rightValue ?? 0)}
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
                          disabled={revealed || timedOut || rolled !== null}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-7 py-3 text-sm font-bold transition active:scale-95 ${
                            revealed || timedOut
                              ? "border-osu-b3/30 text-osu-f1/70"
                              : rolled === choice
                                ? // The one the dice landed on, lit as though
                                  // it had been pressed, because it was.
                                  `${idle} scale-105 brightness-150`
                                : rolled
                                  ? "border-osu-b3/30 text-osu-f1/70"
                                  : `${idle} cursor-pointer`
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                          {label}
                        </button>
                      ))}
                    </div>
                      {timedOut ? (
                        <div className="text-[12px] font-bold text-rose-400">Out of time.</div>
                      ) : (
                        <div className="flex flex-wrap items-center justify-center gap-3">
                          {/* For a round nobody has a read on. It is a coin
                              flip either way, so the game may as well flip it
                              and let you blame the dice. The label says what
                              you would say; the dice next to it say what the
                              button does, and the aria-label says it for
                              anyone who cannot see them. */}
                          <button
                            type="button"
                            onClick={rollDice}
                            aria-label="Guess at random"
                            disabled={revealed || rolled !== null}
                            className={`inline-flex items-center gap-1.5 rounded-full border px-5 py-2 text-[12px] font-bold transition active:scale-95 ${
                              revealed || rolled
                                ? "border-osu-b3/30 text-osu-f1/50"
                                : "border-osu-b3/70 text-osu-f1 hover:border-white/60 hover:text-white cursor-pointer"
                            }`}
                          >
                            <motion.span
                              animate={rolled ? { rotate: [0, -140, 190, -70, 0] } : { rotate: 0 }}
                              transition={{ duration: DICE_SETTLE_MS / 1000, ease: "easeOut" }}
                              className="inline-flex"
                            >
                              <Dices className="h-3.5 w-3.5" />
                            </motion.span>
                            idk
                          </button>
                          {/* Stopping is a move, not an escape hatch: the run
                              banks what it earned and the card you walked away
                              from stays face down. */}
                          {streak > 0 && (
                            <button
                              type="button"
                              onClick={cashOut}
                              disabled={revealed || rolled !== null}
                              className={`inline-flex items-center gap-1.5 rounded-full border px-5 py-2 text-[12px] font-bold transition active:scale-95 ${
                                revealed || rolled
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

        {/* Without room for a rail the board goes under the game: three rows
            and a way to open the rest, so it never pushes the two buttons the
            game is played with off the screen. */}
        <div className="mt-12 xl:hidden">{board(true)}</div>
      </div>

      <aside className="hidden w-[210px] shrink-0 xl:block">{board(false)}</aside>
    </div>
  );
}
