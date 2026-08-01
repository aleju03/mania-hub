import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, Users } from "lucide-react";
import { useEffect, useState } from "react";
import {
  fetchLivePackPulledStats,
  fetchLivePackRecentPulls,
  isLiveBackendConfigured,
  type LivePackPulledStats,
  type LivePackPullFeedEntry,
} from "#/lib/live-backend";
import { formatPreciseTimeAgo } from "#/lib/format";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "#/lib/maniacard";
import { CountryFlag } from "../ui/CountryFlag";

/* People spam-open packs all day, so the feed is an ambient live ticker at
   the page's edge, not a section of the page: every pull that lands while you
   are watching (not just the rare ones) slides in at the top left, lingers for a moment and fades away.
   Notable tiers glow, commons stay dim. The "players own your card" number
   is a fun fact, so it sits quietly on the opposite side. Both rails only
   exist on viewports wide enough to have true margins. */

const FEED_POLL_MS = 15_000;
const FEED_LIMIT = 20;
// How long one entry stays on screen once it has entered. Live entries enter
// one at a time from a drip queue, so their exits stagger on their own; a busy
// rail is the point, it should read as "this page is alive".
const ENTRY_TTL_MS = 75_000;
// Backlog placed instantly on the first poll to give the rail a starting
// state. These are old pulls, so they never animate; see RailEntry.instant.
const SEED_COUNT = 15;
const MAX_VISIBLE = 15;
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

const NOTABLE_TIERS = new Set<string>(["ultraRare", "legendary", "mythic", "ascendant", "worldClass"]);

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
    savedRailEntries = (parsed.entries ?? []).filter((entry) => entry?.pull && entry.expiresAt > now);
    pullQueue.push(...(parsed.queue ?? []).filter((pull) => pull && Number.isFinite(pull.id)));
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
        entries: savedRailEntries,
        queue: pullQueue,
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

/* hidden visually conceals the rails (during the pack reveal) while the
   feed keeps running underneath, so returning shows the current state
   instead of replaying the entrance cascade. */
export function PackPulse({ viewerId, hidden = false }: { viewerId: number | null; hidden?: boolean }) {
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

  useEffect(() => {
    if (!isLiveBackendConfigured()) return;
    let cancelled = false;
    const setEntries = (updater: (current: RailEntry[]) => RailEntry[]) => {
      setEntriesState((current) => {
        const next = updater(current);
        savedRailEntries = next;
        return next;
      });
    };
    const load = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void fetchLivePackRecentPulls(FEED_LIMIT, { includeAll: true })
        .then((pulls) => {
          if (cancelled) return;
          const fresh = pulls.filter((pull) => !seenPullIds.has(pull.id));
          const wasSeeded = feedSeeded;
          for (const pull of pulls) seenPullIds.add(pull.id);
          feedSeeded = true;
          if (!wasSeeded) {
            // The first poll of the session fills the rail with a taste of
            // recent history. That history is minutes or hours old, so it is
            // placed in one frame, already there when you look: nothing
            // slides in. Newest first, matching the live prepend order.
            const seedNow = Date.now();
            const seeds = fresh
              .slice(0, SEED_COUNT)
              .map((pull) => ({ pull, expiresAt: seedNow + ENTRY_TTL_MS, instant: true }));
            if (seeds.length > 0) {
              setEntries((current) => [...current, ...seeds].slice(0, MAX_VISIBLE));
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
    const pollInterval = window.setInterval(load, FEED_POLL_MS);
    const dripInterval = window.setInterval(() => {
      if (pullQueue.length === 0) return;
      const now = Date.now();
      if (now - lastEmitMs < dripGapMs(pullQueue.length)) return;
      lastEmitMs = now;
      const pull = pullQueue.shift();
      if (!pull) return;
      setEntries((current) => [{ pull, expiresAt: now + ENTRY_TTL_MS }, ...current].slice(0, MAX_VISIBLE));
    }, DRIP_TICK_MS);
    const sweepInterval = window.setInterval(() => {
      const now = Date.now();
      setNow(now);
      setEntries((current) => {
        const alive = current.filter((entry) => entry.expiresAt > now);
        return alive.length === current.length ? current : alive;
      });
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(pollInterval);
      window.clearInterval(dripInterval);
      window.clearInterval(sweepInterval);
    };
  }, []);

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
          text, tier carried by the avatar ring and the tier word alone. */}
      <div className={`pointer-events-none absolute left-12 top-[84px] z-20 hidden w-[190px] flex-col gap-2 ${hidden ? "" : "min-[1450px]:flex"}`}>
        <AnimatePresence initial={false}>
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
                {/* Deliberately anonymous: the ticker shows what was pulled,
                    never who pulled it (and links to the card's player, not
                    the pull permalink, which would name the owner). Owners
                    only get named when they share their own pull link. */}
                <Link
                  to="/player/$username"
                  params={{ username: pull.cardUsername }}
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

      {/* Fun fact, top right: how the community holds your own card. */}
      {showPulledStats && pulledStats && (
        <div className={`pointer-events-none absolute right-12 top-[84px] z-20 hidden max-w-[200px] ${hidden ? "" : "min-[1450px]:block"}`}>
          <div className="flex items-start justify-end gap-1.5 text-right text-[11px] leading-snug text-osu-f1/80">
            <Users className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="tabular-nums">
              {pulledStats.owners === 1
                ? "1 person has your card"
                : `${pulledStats.owners.toLocaleString()} people have your card`}
              {pulledStats.pullEvents7d > 0 && (
                <span className="text-osu-f1/60">, pulled {pulledStats.pullEvents7d.toLocaleString()}x this week</span>
              )}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
