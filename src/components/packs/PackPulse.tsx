import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLivePackPulledStats,
  fetchLivePackRecentPulls,
  isLiveBackendConfigured,
  openLiveEventSource,
  type LivePackPulledStats,
  type LivePackPullFeedEntry,
} from "#/lib/live-backend";
import { DEFAULT_COUNTRY_CODE } from "#/lib/country";
import { useDocumentVisible } from "#/lib/window-activity";
import { formatPreciseTimeAgo } from "#/lib/format";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { CountryFlag } from "../ui/CountryFlag";
import { useAuth } from "#/lib/auth-context";
import { canUseAdminFeatures } from "#/lib/auth-shared";
import { CardCollectorsButton } from "./CardCollectors";

/* People spam-open packs all day, so the feed is an ambient live ticker at
   the page's edge, not a section of the page: every pull that lands while you
   are watching (not just the rare ones) slides in at the top left, lingers for a moment and fades away.
   Notable tiers glow, commons stay dim. The "players own your card" number
   is a fun fact, so it sits quietly on the opposite side. Both rails only
   exist on viewports wide enough to have true margins. */

// Pulls arrive live over the shared /api/live stream the moment the backend
// logs them; the poll is only the first-load seed and the catch-up backstop
// for whatever a dropped or hidden-tab stream missed.
const FEED_POLL_MS = 60_000;
const FEED_LIMIT = 20;
// How long one entry stays on screen once it has entered. Live entries enter
// one at a time from a drip queue, so their exits stagger on their own; a busy
// rail is the point, it should read as "this page is alive".
const ENTRY_TTL_MS = 75_000;
// Backlog placed instantly on the first poll to give the rail a starting
// state. These are old pulls, so they never animate; see RailEntry.instant.
const SEED_COUNT = 5;
// Entries fade out in place, so however many retire in one sweep tick is how
// far the survivors below them travel. A batch of seeds placed in one frame
// (or a burst dripped in at 80ms apart) would share a tick and drop the rail
// by the whole stack at once. Keeping retirements more than one sweep tick
// apart means one entry leaves at a time and the trip below it is a single row.
const RETIRE_STAGGER_MS = 2_000;
/* How tall the rail is allowed to get. It grows downward from under the
   header, so the honest limit is the window itself: the cap is however many
   entries fit above the bottom of the screen, re-measured on resize. The
   ceiling keeps a tall monitor from turning the page edge into a wall of
   text, the floor keeps a short one reading as a feed. */
// The rail's top offset plus the caption, which is where entries really begin.
const RAIL_TOP_PX = 102;
const RAIL_BOTTOM_GAP_PX = 72;
// A 24px avatar in a py-1 row, plus the column's 8px gap.
const RAIL_ROW_PX = 40;
// Lands the bottom around the middle of the pack shelf on a laptop window.
const MAX_VISIBLE_CEILING = 16;
const MIN_VISIBLE = 4;
function visibleCapForViewport(windowHeight: number): number {
  const usable = windowHeight - RAIL_TOP_PX - RAIL_BOTTOM_GAP_PX;
  return Math.max(MIN_VISIBLE, Math.min(MAX_VISIBLE_CEILING, Math.floor(usable / RAIL_ROW_PX)));
}
// The drip: buffered pulls enter one at a time so nothing lands in the same
// frame, but the rhythm follows the backlog on purpose. A clump rushes in as
// a rapid burst (that energy is the point), a pair rolls in quick, a lone
// pull ambles in. Constant-speed smoothing made every session look the same.
const DRIP_TICK_MS = 50;
function dripGapMs(queueLength: number): number {
  if (queueLength >= 4) return 80;
  if (queueLength >= 2) return 200;
  return 500;
}
// Reading an entry (or aiming at its link) is impossible while the rail keeps
// sliding, so pointing at it freezes the drip and the expiry sweep. The rail is
// click-through, which means the gaps between entries belong to the page behind
// it: crossing one fires a leave, so resuming waits out a short grace instead of
// letting the list jump while the pointer travels down it.
const HOVER_RESUME_GRACE_MS = 200;

const NOTABLE_TIERS = new Set<string>([
  "ultraRare",
  "legendary",
  "mythic",
  "ascendant",
  "worldClass",
  "goat",
]);

interface RailEntry {
  pull: LivePackPullFeedEntry;
  expiresAt: number;
  // Placed as pre-existing history (first-poll seed, or a restore), so it
  // renders where it is instead of sliding in. The flow-in belongs to pulls
  // that actually land while you are watching.
  instant?: boolean;
}

/* Session-lifetime feed state at module scope (like the pack-art thumb
   cache): the packs route unmounts on navigation, and per-component state
   would replay the whole seed cascade on every return. With this, coming
   back resumes the rail where it truly is; only pulls that happened while
   away enter as new. */
const seenPullIds = new Set<number>();
let feedSeeded = false;
const pullQueue: LivePackPullFeedEntry[] = [];
let lastEmitMs = 0;
let savedRailEntries: RailEntry[] = [];

/* And one layer further: a reload (F5) resets module scope too, so the feed
   snapshots itself to sessionStorage on pagehide and restores once per page
   load. Per tab, dies with the tab: only a genuinely fresh visit gets the
   seed cascade. */
const FEED_STATE_KEY = "mania-hub-pack-pulse-v1";
let feedStateRestored = false;

/* Your own pack normally reaches the rail through the live stream like
   everyone else's, but the packs route still pings this right after
   recording: it is instant even when the stream is down or reconnecting,
   and the dedupe makes the overlap free. Pulls enter through the normal
   drip either way. */
let pollFeedNow: (() => void) | null = null;
export function refreshPackPulseFeed(): void {
  pollFeedNow?.();
}

/* Admin-only rail rehearsal: fake pulls pushed straight into the drip queue
   to watch the animation behave under a fast global inflow without waiting
   for real traffic. Ids count down from -1 so they can never collide with a
   real pull, are trivially recognizable, and get stripped from the
   sessionStorage snapshot on save. */
let simPullId = 0;
const SIM_TIERS: Array<string | null> = [
  null,
  "common",
  "common",
  "rare",
  "elite",
  "superRare",
  "ultraRare",
  "legendary",
  "mythic",
  "ascendant",
  "worldClass",
  "goat",
];
/* Drops every simulated pull still waiting in the drip queue and out of the
   saved rail, so stopping the sim cannot leave fakes to trickle in later or
   survive into a restore. */
function purgeSimulatedPulls(): void {
  for (let index = pullQueue.length - 1; index >= 0; index -= 1) {
    if (pullQueue[index].id < 0) pullQueue.splice(index, 1);
  }
  savedRailEntries = savedRailEntries.filter((entry) => entry.pull.id > 0);
}

function pushSimulatedPull(): void {
  simPullId -= 1;
  pullQueue.push({
    id: simPullId,
    ownerUserId: 2,
    ownerUsername: "simulator",
    cardUserId: 2,
    cardUsername: `simmed pull ${-simPullId}`,
    cardCountryCode: "CR",
    cardAvatarUrl: null,
    tier: SIM_TIERS[Math.floor(Math.random() * SIM_TIERS.length)] ?? null,
    packType: "standard",
    isNew: false,
    isFirstGlobal: Math.random() < 0.12,
    pulledAt: Date.now(),
  });
}

function restoreFeedStateOnce(): void {
  if (feedStateRestored || typeof window === "undefined") return;
  feedStateRestored = true;
  try {
    const raw = window.sessionStorage.getItem(FEED_STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      seenIds?: number[];
      seeded?: boolean;
      entries?: RailEntry[];
      queue?: LivePackPullFeedEntry[];
    };
    for (const id of parsed.seenIds ?? []) {
      if (Number.isFinite(id)) seenPullIds.add(id);
    }
    feedSeeded = parsed.seeded === true;
    const now = Date.now();
    savedRailEntries = (parsed.entries ?? [])
      .filter((entry) => entry?.pull && entry.expiresAt > now)
      .slice(0, MAX_VISIBLE_CEILING);
    const restoredIds = new Set(savedRailEntries.map((entry) => entry.pull.id));
    for (const pull of parsed.queue ?? []) {
      if (!pull || !Number.isFinite(pull.id) || restoredIds.has(pull.id)) continue;
      restoredIds.add(pull.id);
      pullQueue.push(pull);
    }
  } catch {
    // Corrupt or unavailable storage: start the session fresh.
  }
}

function saveFeedState(): void {
  try {
    window.sessionStorage.setItem(
      FEED_STATE_KEY,
      JSON.stringify({
        seenIds: [...seenPullIds].slice(-200),
        seeded: feedSeeded,
        // Simulated pulls (negative ids) are an admin toy for this page view;
        // they never survive into the snapshot.
        entries: savedRailEntries.filter((entry) => entry.pull.id > 0),
        queue: pullQueue.filter((pull) => pull.id > 0),
      }),
    );
  } catch {
    // Quota or private mode: worst case is a replayed cascade.
  }
}

function tierStyle(tier: string | null) {
  return tier && tier in MANIA_TIER_STYLES ? MANIA_TIER_STYLES[tier as ManiaCardTier] : null;
}

/* The vivid rgb triplet of a tier's palette, same extraction the spotlight
   and collection filter chips use. */
function tierAccentRgb(tier: string | null): string {
  const style = tierStyle(tier);
  const match = style?.badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184";
}

/* revealing marks the pack reveal. The pull ticker keeps running and stays
   on screen through it (the rail lives well outside the reveal column, and
   watching other people's pulls land while your own cards flip is half the
   fun); only the your-card fun fact steps aside, since it is static trivia
   that would just compete with the cards. */
function PulledStatsLine({ stats }: { stats: LivePackPulledStats }) {
  return (
    <>
      <Users className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">
        {stats.owners === 1
          ? "1 person has your card"
          : `${stats.owners.toLocaleString()} people have your card`}
      </span>
    </>
  );
}

export function PackPulse({ viewerId, revealing = false }: { viewerId: number | null; revealing?: boolean }) {
  // Admins get the collector list (a prototype; the fun fact itself stays
  // visible to everyone) and the rail's inflow simulator.
  const isAdmin = canUseAdminFeatures(useAuth());
  // While on, a timer keeps the drip queue topped up with fake pulls so the
  // rail runs at its fast-burst pace.
  const [simulating, setSimulating] = useState(false);

  // Resume from the saved rail, dropping whatever expired while away. On a
  // full page load this is empty (matching the server-rendered HTML); the
  // sessionStorage restore happens post-hydration in the effect below.
  const [entries, setEntriesState] = useState<RailEntry[]>(() =>
    typeof window === "undefined" ? [] : savedRailEntries.filter((entry) => entry.expiresAt > Date.now()),
  );
  const [pulledStats, setPulledStats] = useState<LivePackPulledStats | null>(null);
  // Drives the "Xs ago" labels; ticked by the 1s sweep interval below. Safe
  // against hydration mismatch because entries render [] on the server.
  const [now, setNow] = useState(() => Date.now());

  // When the pointer went onto the rail, or null while it is running. Held in a
  // ref so the drip and the sweep can read it without restarting their timers.
  const hoverPausedAtRef = useRef<number | null>(null);
  const resumeTimerRef = useRef<number | null>(null);
  // How many entries fit above the bottom of the window. A ref for the same
  // reason: the drip reads it every tick and must not restart on a resize.
  const maxVisibleRef = useRef(MAX_VISIBLE_CEILING);

  const setEntries = useCallback((updater: (current: RailEntry[]) => RailEntry[]) => {
    setEntriesState((current) => {
      const next = updater(current);
      savedRailEntries = next;
      return next;
    });
  }, []);

  const pauseRail = useCallback(() => {
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    if (hoverPausedAtRef.current === null) hoverPausedAtRef.current = Date.now();
  }, []);

  const resumeRail = useCallback(() => {
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = window.setTimeout(() => {
      resumeTimerRef.current = null;
      const pausedAt = hoverPausedAtRef.current;
      hoverPausedAtRef.current = null;
      if (pausedAt === null) return;
      // Entries are owed the time they spent held under the cursor, otherwise
      // everything that ran out while you were reading it leaves the instant
      // you look away.
      const held = Date.now() - pausedAt;
      if (held <= 0) return;
      setEntries((current) => current.map((entry) => ({ ...entry, expiresAt: entry.expiresAt + held })));
    }, HOVER_RESUME_GRACE_MS);
  }, [setEntries]);

  useEffect(
    () => () => {
      if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const measure = () => {
      const cap = visibleCapForViewport(window.innerHeight);
      if (cap === maxVisibleRef.current) return;
      maxVisibleRef.current = cap;
      // Shrinking the window drops the entries that no longer fit; growing it
      // just leaves room the next pulls will fill.
      setEntries((current) => (current.length > cap ? current.slice(0, cap) : current));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [setEntries]);

  useEffect(() => {
    restoreFeedStateOnce();
    const alive = savedRailEntries
      .filter((entry) => entry.expiresAt > Date.now())
      .map((entry) => ({ ...entry, instant: true }));
    savedRailEntries = alive;
    if (alive.length > 0) {
      setEntriesState((current) => (current.length > 0 ? current : alive));
    }
    const onPageHide = () => saveFeedState();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Hidden tabs release everything, stream included, and get a fresh
  // catch-up poll the moment they come back; a reopened stream starts at the
  // live head, so that poll is what fills the gap.
  const documentVisible = useDocumentVisible();

  useEffect(() => {
    if (!isLiveBackendConfigured() || !documentVisible) return;
    let cancelled = false;
    const load = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void fetchLivePackRecentPulls(FEED_LIMIT, { includeAll: true })
        .then((pulls) => {
          if (cancelled) return;
          const wasSeeded = feedSeeded;
          // Marking each id seen as it is accepted also drops a duplicate id
          // inside one response, which a plain filter-then-mark would let
          // through as two rail entries sharing a React key.
          const fresh = pulls.filter((pull) => {
            if (!Number.isFinite(pull?.id) || seenPullIds.has(pull.id)) return false;
            seenPullIds.add(pull.id);
            return true;
          });
          feedSeeded = true;
          if (!wasSeeded) {
            // The first poll of the session fills the rail with a taste of
            // recent history. That history is minutes or hours old, so it is
            // placed in one frame, already there when you look: nothing
            // slides in. Newest first, matching the live prepend order.
            const seedNow = Date.now();
            const seeds = fresh
              .slice(0, SEED_COUNT)
              .map((pull, index) => ({
                pull,
                expiresAt: seedNow + ENTRY_TTL_MS - index * RETIRE_STAGGER_MS,
                instant: true,
              }));
            if (seeds.length > 0) {
              setEntries((current) => {
                // Belt and braces against duplicate React keys: whatever is
                // already on the rail wins over an incoming seed of the same
                // pull.
                const have = new Set(current.map((entry) => entry.pull.id));
                return [...current, ...seeds.filter((seed) => !have.has(seed.pull.id))].slice(0, maxVisibleRef.current);
              });
            }
            return;
          }
          // Afterwards only unseen pulls enter, through the drip queue,
          // oldest first, so a batch streams in with the newest landing on
          // top last.
          if (fresh.length > 0) {
            pullQueue.push(...[...fresh].reverse());
          }
        })
        .catch(() => {});
    };
    load();
    pollFeedNow = load;
    const pollInterval = window.setInterval(load, FEED_POLL_MS);
    // The live path: every pull lands on the shared /api/live stream as a
    // global (country-less) event the moment the backend logs it, and enters
    // the rail through the same drip queue as polled pulls. The country here
    // is only the connection anchor the endpoint requires; observe keeps a
    // packs visit from touching the country registry.
    const source = openLiveEventSource(DEFAULT_COUNTRY_CODE, { observe: true });
    const onPackPull = (event: MessageEvent) => {
      try {
        const pull = JSON.parse(event.data) as LivePackPullFeedEntry;
        if (!Number.isFinite(pull?.id) || seenPullIds.has(pull.id)) return;
        seenPullIds.add(pull.id);
        pullQueue.push(pull);
      } catch {
        // Malformed frame: the poll backstop will carry this pull instead.
      }
    };
    source?.addEventListener("pack_pull", onPackPull);
    const dripInterval = window.setInterval(() => {
      if (pullQueue.length === 0 || hoverPausedAtRef.current !== null) return;
      const now = Date.now();
      if (now - lastEmitMs < dripGapMs(pullQueue.length)) return;
      lastEmitMs = now;
      const pull = pullQueue.shift();
      if (!pull) return;
      setEntries((current) => {
        // The newest entry outlives everything already on the rail, and by
        // enough that it does not share a sweep tick with the one before it.
        // Capped at a full rail's worth of spacing, so a long fast stream (which
        // evicts from the bottom on the visible cap anyway) cannot push retirement
        // minutes past the TTL and leave a stale rail once it goes quiet.
        const lastOut = current.reduce((latest, entry) => Math.max(latest, entry.expiresAt), 0);
        const expiresAt = Math.min(
          Math.max(now + ENTRY_TTL_MS, lastOut + RETIRE_STAGGER_MS),
          now + ENTRY_TTL_MS + MAX_VISIBLE_CEILING * RETIRE_STAGGER_MS,
        );
        // Same pull already on the rail (however it got there): replace it
        // instead of rendering two children under one React key.
        return [{ pull, expiresAt }, ...current.filter((entry) => entry.pull.id !== pull.id)].slice(
          0,
          maxVisibleRef.current,
        );
      });
    }, DRIP_TICK_MS);
    const sweepInterval = window.setInterval(() => {
      const now = Date.now();
      // The clock keeps running under the cursor (the labels are text, they do
      // not move anything), only the retirement waits.
      setNow(now);
      if (hoverPausedAtRef.current !== null) return;
      setEntries((current) => {
        const alive = current.filter((entry) => entry.expiresAt > now);
        return alive.length === current.length ? current : alive;
      });
    }, 1_000);
    return () => {
      cancelled = true;
      if (pollFeedNow === load) pollFeedNow = null;
      window.clearInterval(pollInterval);
      window.clearInterval(dripInterval);
      window.clearInterval(sweepInterval);
      source?.close();
    };
  }, [documentVisible, setEntries]);

  useEffect(() => {
    if (!simulating) return;
    const interval = window.setInterval(() => {
      // Keep the backlog deep enough for the drip's fastest cadence without
      // letting an unwatched toggle grow the queue unbounded.
      if (pullQueue.length < 12) pushSimulatedPull();
    }, 120);
    return () => {
      window.clearInterval(interval);
      // Stopping is immediate. Without this the rail would keep ticking for a
      // while after the button says "sim pulls" again: a dozen fake pulls are
      // still queued, and the ones already placed hold their slot for the full
      // entry TTL. Both go now, so the rail drops straight back to real pulls.
      purgeSimulatedPulls();
      setEntries((current) => current.filter((entry) => entry.pull.id > 0));
    };
  }, [simulating, setEntries]);

  useEffect(() => {
    if (!viewerId || !isLiveBackendConfigured()) {
      setPulledStats(null);
      return;
    }
    let cancelled = false;
    void fetchLivePackPulledStats(viewerId)
      .then((stats) => {
        if (!cancelled) setPulledStats(stats);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [viewerId]);

  const showPulledStats = pulledStats !== null && pulledStats.owners > 0;

  return (
    <>
      {/* Live pull ticker, top left. No boxes or glows: floating avatar +
          text, tier carried by the avatar ring and the tier word alone.

          translate="no" because browser auto-translate replaces text nodes
          with <font> wrappers and React then throws NotFoundError committing
          over them — and this rail is nothing but committing: entries mount,
          exit and re-sort constantly, and every row's "Ns ago" rewrites each
          second. Usernames and tier words are not translatable content. */}
      <div translate="no" className="pointer-events-none absolute left-12 top-[84px] z-20 hidden w-[190px] flex-col gap-2 min-[1450px]:flex">
        {/* Above the feed and outside the pause zone below, on purpose: the
            list grows and shrinks constantly under a sim, so a toggle sitting
            under it would slide away from the cursor, and hovering it at all
            would freeze the rail you are trying to watch. */}
        {isAdmin && (
          <button
            type="button"
            onClick={() => setSimulating((on) => !on)}
            className={`pointer-events-auto self-start text-[9px] font-semibold uppercase tracking-[0.14em] transition-colors cursor-pointer ${
              simulating ? "text-osu-pink" : "text-osu-f1/40 hover:text-osu-f1"
            }`}
            title="Admin: flood the rail with fake pulls to preview the animation"
            aria-pressed={simulating}
          >
            {simulating ? "stop sim" : "sim pulls"}
          </button>
        )}
        <div
          className="flex flex-col gap-2"
          onMouseEnter={pauseRail}
          onMouseLeave={resumeRail}
          onFocusCapture={pauseRail}
          onBlurCapture={resumeRail}
        >
          {/* Retiring entries pop out of the flow rather than fading in place:
              in place they keep their row for the length of the fade, so a fast
              inflow stacks ghosts under the live ones and the rail grows down
              the page. Popped, only the live entries take height and the
              survivors slide up one row at a time (see RETIRE_STAGGER_MS). */}
          <AnimatePresence initial={false} mode="popLayout">
            {entries.length > 0 && (
              <motion.div
                key="caption"
                className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-osu-f1/50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4 }}
              >
                <span className="relative flex h-1 w-1">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-osu-pink opacity-50" />
                  <span className="relative inline-flex h-1 w-1 rounded-full bg-osu-pink" />
                </span>
                recent global pulls
              </motion.div>
            )}
            {entries.map(({ pull, instant }) => {
              const notable = pull.isFirstGlobal || (pull.tier !== null && NOTABLE_TIERS.has(pull.tier));
              const style = tierStyle(pull.tier);
              const accent = tierAccentRgb(pull.tier);
              return (
                <motion.div
                  key={pull.id}
                  layout
                  initial={instant ? false : { opacity: 0, x: -10 }}
                  animate={{ opacity: notable ? 0.95 : 0.6, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  {/* The rail itself stays anonymous (it shows what was pulled,
                      not who pulled it), but each entry links to that pull's
                      permalink so you can go look at the card that just landed.
                      The pull page names the owner. */}
                  <Link
                    to="/pull/$ownerId/$cardId"
                    params={{ ownerId: String(pull.ownerUserId), cardId: String(pull.cardUserId) }}
                    className="pointer-events-auto -mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-white/5 hover:opacity-100"
                    aria-label={`${pull.cardUsername} was pulled`}
                  >
                    {pull.cardAvatarUrl ? (
                      <img
                        src={pull.cardAvatarUrl}
                        alt=""
                        className="h-6 w-6 shrink-0 rounded-full object-cover"
                        style={{ boxShadow: `0 0 0 1.5px rgba(${accent}, ${notable ? 0.8 : 0.35})` }}
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <span
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-osu-b3"
                        style={{ boxShadow: `0 0 0 1.5px rgba(${accent}, ${notable ? 0.8 : 0.35})` }}
                      >
                        <CountryFlag code={pull.cardCountryCode} size="xs" decorative />
                      </span>
                    )}
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1 leading-tight">
                        <span className="truncate text-[11px] font-semibold text-white/90">{pull.cardUsername}</span>
                        {pull.isFirstGlobal && (
                          <span title="First time anyone pulled this card" className="flex shrink-0">
                            <Sparkles className="h-2.5 w-2.5 text-osu-pink" aria-label="first time anyone pulled this card" />
                          </span>
                        )}
                      </span>
                      <span className="truncate text-[9px] leading-tight">
                        {style ? (
                          <span className="font-bold uppercase tracking-wide" style={{ color: `rgba(${accent}, 0.9)` }}>
                            {style.label}
                          </span>
                        ) : (
                          <span className="text-osu-f1/70">pulled</span>
                        )}
                        {pull.pulledAt > 0 && (
                          <span className="tabular-nums text-osu-f1/50"> · {formatPreciseTimeAgo(pull.pulledAt, now)}</span>
                        )}
                      </span>
                    </span>
                  </Link>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Fun fact, top right: how the community holds your own card. Admins
          can click it to put names to the number, which is admin-gated while
          the collector list is being tried out; for everyone else the line
          stays what it always was, a fact you cannot open. */}
      {showPulledStats && pulledStats && (
        <div className={`pointer-events-none absolute right-12 top-[84px] z-20 hidden max-w-[200px] ${revealing ? "" : "min-[1450px]:block"}`}>
          {isAdmin ? (
            <CardCollectorsButton className="pointer-events-auto flex items-start justify-end gap-1.5 text-right text-[11px] leading-snug text-osu-f1/80 transition-colors hover:text-white cursor-pointer">
              <PulledStatsLine stats={pulledStats} />
            </CardCollectorsButton>
          ) : (
            <div className="flex items-start justify-end gap-1.5 text-right text-[11px] leading-snug text-osu-f1/80">
              <PulledStatsLine stats={pulledStats} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
