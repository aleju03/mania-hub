import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Check, Recycle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatOrdinal } from "#/lib/format";
import {
  copiesShardValue,
  duplicateShardValueForTier,
  packCardKey,
  shardValueForTier,
  tierRank,
  type CollectedCard,
} from "#/lib/pack-collection";
import type { ManiaCardTier } from "#/lib/maniacard";
import { CountryFlag } from "../ui/CountryFlag";
import { CardSpotlight, type CardSpotlightTarget } from "./CardSpotlight";
import { playRecycleClink } from "./packSfx";
import type { FlightRect, RevealedCard } from "./RevealStage";

interface PackSummaryProps {
  cards: RevealedCard[];
  onOpenAnother: () => void;
  /* Deals and tears the next pack of the same type straight from here,
     skipping the trip back to the pack stage. */
  onOpenNext: () => void;
  canOpenNext: boolean;
  /* Shard price of that next pack, so a one-click purchase still shows its
     cost. Null for the charge-funded standard pack. */
  nextPackShardCost: number | null;
  /* Serials for this pack's cards, keyed by wallet card key. Arrives a beat
     after the summary does: the pull log is written in the background, and
     the numbers land when it answers. */
  serials: Map<string, { serial: number; mintedTotal: number; isFirstGlobal: boolean }> | null;
  /* Hands cards from this pack straight back for shards, one copy per tile:
     a card the pack was the first copy of leaves the collection, a duplicate
     gives up only the copy this pack added. Resolves with the shards paid. */
  onRecycleCopies: (entries: Array<{ cardKey: string; copies: number }>) => number | Promise<number>;
  reducedMotion: boolean;
  /* Reveal-all handoff: where each card's tile sat when the reveal finished,
     keyed by card position. Present = the viewer already saw every card, so
     the grid renders in place (no enter stagger) and each tile flies from
     its handed-off rect into its slot. */
  flyFrom?: Map<number, FlightRect> | null;
}

/* One card's journey from its reveal rect into its summary slot. */
interface SummaryFlight {
  position: number;
  thumbnail: string;
  from: FlightRect;
  to: FlightRect;
}

/* The tiles of this hand that are copies of one collected card. A pack can
   deal the same player twice, and both tiles are then the same wallet card:
   recycling has to price and address them together. */
interface HandGroup {
  cardKey: string;
  tier: ManiaCardTier | null;
  positions: number[];
  /* This pack dealt the collector their first copy, so once every tile of the
     group is recycled the card leaves the collection - which is what makes the
     last copy out worth the full tier value rather than the duplicate rate. */
  isFirstCopy: boolean;
}

function groupHand(cards: RevealedCard[]): HandGroup[] {
  const groups = new Map<string, HandGroup>();
  cards.forEach((card, position) => {
    const cardKey = packCardKey(card.player.user.id, card.tier);
    const group = groups.get(cardKey);
    if (group) group.positions.push(position);
    else groups.set(cardKey, { cardKey, tier: card.tier, positions: [position], isFirstCopy: card.isNew });
  });
  return [...groups.values()];
}

/* The spotlight speaks CollectedCard; a fresh pull maps onto one directly
   (a single copy, timestamps unused by the spotlight). */
function toSpotlightCard(card: RevealedCard): CollectedCard {
  return {
    userId: card.player.user.id,
    username: card.player.user.username,
    avatarUrl: card.player.user.avatar_url,
    countryCode: card.player.user.country_code,
    tier: card.tier,
    tierLabel: card.tierLabel,
    skills: card.skills,
    pp: card.player.pp,
    globalRank: card.player.globalRank,
    copies: 1,
    recycledCopies: 0,
    firstPulledAt: 0,
    lastPulledAt: 0,
  };
}

export function PackSummary({
  cards,
  onOpenAnother,
  onOpenNext,
  canOpenNext,
  nextPackShardCost,
  serials,
  onRecycleCopies,
  reducedMotion,
  flyFrom = null,
}: PackSummaryProps) {
  const instant = flyFrom !== null;
  /* The ring marks the best card in the hand, which is a tier question before
     it is a rank one: an honorary card carries no meaningful global rank, so
     picking by rank alone quietly ringed an ordinary card instead of the GOAT
     sitting next to it. Rank only breaks ties inside the same tier. */
  const bestPosition = cards.reduce((best, card, position) => {
    const candidate = cards[best];
    const byTier = tierRank(card.tier) - tierRank(candidate.tier);
    if (byTier !== 0) return byTier > 0 ? position : best;
    return card.player.globalRank < candidate.player.globalRank ? position : best;
  }, 0);
  const newCount = cards.filter((card) => card.isNew).length;
  const dupeCount = cards.length - newCount;

  // Clicking a card lifts it into the same spotlight the collection uses;
  // the profile lives behind the player's name and the spotlight's button.
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  /* The lifted card's tile stays hidden until the close flight lands back
     in it, so the card never shows twice. Keyed by grid position, like the
     handoff flights: one pull can hand back two cards of the same player. */
  const [liftedPosition, setLiftedPosition] = useState<number | null>(null);

  /* Recycling from here, so a hand of duplicates never needs a trip through
     the collection to find them again. Everything is keyed by grid position
     rather than by card: two tiles of the same player are two copies, and
     each of them recycles on its own. What a recycled tile paid is kept with
     it, so its slot can show its own number. */
  const [recycled, setRecycled] = useState<Map<number, number>>(new Map());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{ position: number; x: number; y: number } | null>(null);
  /* Only the menu's single-card recycle asks twice, the way the collection's
     does: it sits one mis-click away from a card worth keeping. Recycling a
     hand, or a selection out of one, is already a deliberate enough act. */
  const [menuConfirm, setMenuConfirm] = useState(false);
  const [recycleBusy, setRecycleBusy] = useState(false);
  // One-shot "+N" shard float spawned at the clicked control.
  const [shardBursts, setShardBursts] = useState<Array<{ id: number; x: number; y: number; amount: number }>>([]);
  const burstIdRef = useRef(0);

  const groups = useMemo(() => groupHand(cards), [cards]);
  const livePositions = cards.map((_, position) => position).filter((position) => !recycled.has(position));
  const recycledShards = [...recycled.values()].reduce((sum, value) => sum + value, 0);

  /* What handing these tiles back pays. A card this pack was the first copy
     of leaves the collection once its last tile goes, so that copy is worth
     the full tier value; every other copy pays the duplicate rate, because
     the collector keeps one either way. */
  const recycleValueOf = (positions: ReadonlySet<number>) => {
    let total = 0;
    for (const group of groups) {
      const live = group.positions.filter((position) => !recycled.has(position));
      const taken = live.filter((position) => positions.has(position)).length;
      if (taken === 0) continue;
      total += copiesShardValue(group.tier, taken, group.isFirstCopy ? live.length : live.length + 1);
    }
    return total;
  };

  /* The same price, tile by tile: when a batch takes a group's last live copy
     the card leaves the collection, so one of its tiles carries the full tier
     value and the rest the duplicate rate. Adds up to recycleValueOf. */
  const splitRecycleValues = (positions: ReadonlySet<number>) => {
    const split = new Map<number, number>();
    for (const group of groups) {
      const live = group.positions.filter((position) => !recycled.has(position));
      const taken = live.filter((position) => positions.has(position));
      if (taken.length === 0) continue;
      const leaves = taken.length >= (group.isFirstCopy ? live.length : live.length + 1);
      for (const [index, position] of taken.entries()) {
        split.set(
          position,
          leaves && index === 0 ? shardValueForTier(group.tier) : duplicateShardValueForTier(group.tier),
        );
      }
    }
    return split;
  };

  const recycleEntriesOf = (positions: ReadonlySet<number>) =>
    groups
      .map((group) => ({
        cardKey: group.cardKey,
        copies: group.positions.filter((position) => positions.has(position) && !recycled.has(position)).length,
      }))
      .filter((entry) => entry.copies > 0);

  const selectedLive = livePositions.filter((position) => selected.has(position));
  const selectedValue = recycleValueOf(new Set(selectedLive));
  const allLive = new Set(livePositions);
  const allValue = recycleValueOf(allLive);

  /* Same feedback the collection gives a recycle: a shard clink and a short
     "+N" float above the control that was clicked. */
  const celebrateRecycle = (gained: number, anchor: Element | null) => {
    if (gained <= 0) return;
    playRecycleClink(gained);
    if (reducedMotion) return;
    const rect = anchor?.getBoundingClientRect();
    if (!rect) return;
    burstIdRef.current += 1;
    const id = burstIdRef.current;
    setShardBursts((current) => [
      ...current.slice(-3),
      { id, x: rect.left + rect.width / 2, y: rect.top, amount: gained },
    ]);
    window.setTimeout(() => {
      setShardBursts((current) => current.filter((burst) => burst.id !== id));
    }, 800);
  };

  const runRecycle = (positions: ReadonlySet<number>, anchor: Element | null) => {
    const entries = recycleEntriesOf(positions);
    if (entries.length === 0 || recycleBusy) return;
    setRecycleBusy(true);
    void Promise.resolve(onRecycleCopies(entries))
      .then((gained) => {
        // Nothing paid means nothing moved (an unreachable backend falls back
        // to a wallet that no longer holds the cards), so the tiles stay.
        if (gained <= 0) return;
        const paid = splitRecycleValues(positions);
        setRecycled((current) => new Map([...current, ...paid]));
        setSelecting(false);
        setSelected(new Set());
        celebrateRecycle(gained, anchor);
      })
      .catch(() => {})
      .finally(() => setRecycleBusy(false));
  };

  const exitSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const toggleSelected = (position: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(position)) next.delete(position);
      else next.add(position);
      return next;
    });
  };

  const applySelect = (position: number, on: boolean) => {
    setSelected((previous) => {
      if (on === previous.has(position)) return previous;
      const next = new Set(previous);
      if (on) next.add(position);
      else next.delete(position);
      return next;
    });
  };

  /* Mouse drag-select, as in the collection grid: pressing a tile picks
     add-or-remove from that tile's state and the sweep carries it across the
     hand. The click that follows the press is swallowed so the tile pressed
     on isn't toggled twice. */
  const dragRef = useRef<{ mode: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  // Escape backs out of the menu first, then out of select mode.
  useEffect(() => {
    if (!menu && !selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menu) {
        setMenu(null);
        return;
      }
      exitSelecting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, selecting]);

  useEffect(() => {
    if (!selecting) return;
    // The sweep: whatever tile the pointer passes over takes the mode the
    // press started with.
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current || !(event.target instanceof Element)) return;
      const tile = event.target.closest("[data-pull-position]");
      const raw = tile?.getAttribute("data-pull-position");
      const position = raw === null || raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isInteger(position) || recycled.has(position)) return;
      applySelect(position, dragRef.current.mode);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    // Clicking anywhere that isn't part of the selection UI leaves select
    // mode, exactly as it does in the collection grid.
    const onDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-select-keep]")) return;
      exitSelecting();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("pointerdown", onDown);
      dragRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting, recycled]);

  useEffect(() => {
    if (!menuConfirm) return;
    const timer = setTimeout(() => setMenuConfirm(false), 3000);
    return () => clearTimeout(timer);
  }, [menuConfirm]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const flightImgRefs = useRef<Map<number, HTMLImageElement>>(new Map());
  const [flights, setFlights] = useState<SummaryFlight[] | null>(null);

  /* Measured once on mount, before paint: pair each handed-off rect with its
     tile's final slot, both converted into the root's space (the reveal ->
     summary swap is a same-frame re-render, so all three viewport rects share
     one scroll position). The overlays position absolute in the root rather
     than fixed: a scroll during the flight then moves them with the page,
     instead of leaving them pinned to the viewport while the grid they are
     landing in slides away underneath. The real tiles hide while their
     overlays are in the air, so the cards never show twice. */
  useLayoutEffect(() => {
    if (!flyFrom || flyFrom.size === 0 || reducedMotion) return;
    const rootRect = rootRef.current?.getBoundingClientRect();
    if (!rootRect) return;
    const next: SummaryFlight[] = [];
    cards.forEach((card, position) => {
      const from = flyFrom.get(position);
      if (!from || !card.thumbnail) return;
      const tile = gridRef.current?.querySelector(`[data-pull-index="${position}"]`);
      if (!(tile instanceof HTMLElement)) return;
      const rect = tile.getBoundingClientRect();
      if (rect.width <= 0) return;
      next.push({
        position,
        thumbnail: card.thumbnail,
        from: {
          left: from.left - rootRect.left,
          top: from.top - rootRect.top,
          width: from.width,
          height: from.height,
        },
        to: {
          left: rect.left - rootRect.left,
          top: rect.top - rootRect.top,
          width: rect.width,
          height: rect.height,
        },
      });
    });
    if (next.length > 0) setFlights(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Same trick as the reveal tray flight: the overlays move on the
  // compositor via the Web Animations API so nothing on the main thread
  // (thumbnail decodes, the collection panel mounting) can stutter them.
  useEffect(() => {
    if (!flights) return;
    const animations: Animation[] = [];
    for (const flight of flights) {
      const el = flightImgRefs.current.get(flight.position);
      if (!el || typeof el.animate !== "function") continue;
      const dx = flight.to.left - flight.from.left;
      const dy = flight.to.top - flight.from.top;
      const sx = flight.to.width / flight.from.width;
      const sy = flight.to.height / flight.from.height;
      animations.push(
        el.animate(
          [
            { transform: "translate(0px, 0px) scale(1, 1)" },
            { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          ],
          { duration: 420, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)", fill: "forwards" },
        ),
      );
    }
    if (animations.length === 0) {
      setFlights(null);
      return;
    }
    let cancelled = false;
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) setFlights(null);
    });
    return () => {
      cancelled = true;
      for (const animation of animations) animation.cancel();
    };
  }, [flights]);

  const inFlight = new Set(flights?.map((flight) => flight.position));

  return (
    <div ref={rootRef} className="relative flex flex-col items-center">
      {/* What the pack was worth, in figures rather than in a sentence under
          the grid where it used to sit. */}
      <div className="flex items-baseline justify-center gap-7 sm:gap-10">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-black leading-none text-white tabular-nums">{newCount}</span>
          <span className="text-[12px] text-osu-f1">new</span>
        </div>
        {dupeCount > 0 && (
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-black leading-none text-osu-f1 tabular-nums">{dupeCount}</span>
            <span className="text-[12px] text-osu-f1">
              duplicate{dupeCount === 1 ? "" : "s"}
            </span>
          </div>
        )}
        {/* The new and duplicate counts describe the pull, so they stand
            whatever is handed back; what recycling adds is a third figure. */}
        {recycledShards > 0 && (
          <motion.div
            className="flex items-baseline gap-2"
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <motion.span
              key={recycledShards}
              className="text-3xl font-black leading-none text-osu-pink-light tabular-nums"
              initial={reducedMotion ? false : { scale: 1.2 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              +{recycledShards}
            </motion.span>
            <span className="text-[12px] text-osu-f1">shards</span>
          </motion.div>
        )}
      </div>

      <div ref={gridRef} className="mt-7 flex flex-wrap items-start justify-center gap-4 sm:gap-5">
        {cards.map((card, position) => {
          const isBest = position === bestPosition;
          const recycledFor = recycled.get(position);
          const isRecycled = recycledFor !== undefined;
          const isSelected = selected.has(position);
          const glow = card.glowColor
            ? `rgba(${card.glowColor.r}, ${card.glowColor.g}, ${card.glowColor.b}, 0.55)`
            : "rgba(148, 163, 184, 0.35)";
          const tierColor = card.glowColor
            ? `rgb(${card.glowColor.r}, ${card.glowColor.g}, ${card.glowColor.b})`
            : "rgb(226, 232, 240)";
          return (
            <motion.div
              key={`${card.player.user.id}-${position}`}
              className={`w-[128px] sm:w-[148px] ${selecting ? "select-none" : ""}`}
              data-select-keep=""
              data-pull-position={position}
              onContextMenu={(event) => {
                if (isRecycled) return;
                event.preventDefault();
                setMenuConfirm(false);
                setMenu({
                  position,
                  x: Math.min(event.clientX, window.innerWidth - 216),
                  y: Math.min(event.clientY, window.innerHeight - 176),
                });
              }}
              initial={reducedMotion || instant ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: reducedMotion || instant ? 0 : position * 0.07 }}
            >
              <button
                type="button"
                onPointerDown={(event) => {
                  if (!selecting || isRecycled) return;
                  if (event.pointerType !== "mouse") {
                    suppressClickRef.current = false;
                    return;
                  }
                  if (event.button !== 0) return;
                  // Native drag and text selection would hijack the sweep.
                  event.preventDefault();
                  suppressClickRef.current = true;
                  dragRef.current = { mode: !isSelected };
                  applySelect(position, dragRef.current.mode);
                }}
                onClick={(event) => {
                  if (isRecycled) return;
                  if (selecting) {
                    // Touch taps and keyboard activation; a mouse press was
                    // already handled on pointer down.
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    toggleSelected(position);
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  setSpotlight({
                    card: toSpotlightCard(card),
                    thumbnail: card.thumbnail,
                    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                  });
                  setLiftedPosition(position);
                }}
                className={`block w-full ${isRecycled ? "cursor-default" : "cursor-pointer"}`}
                style={
                  liftedPosition === position || inFlight.has(position)
                    ? { visibility: "hidden" }
                    : undefined
                }
                aria-pressed={selecting ? isSelected : undefined}
                aria-label={
                  isRecycled
                    ? `${card.player.user.username}'s card, recycled for ${recycledFor} shards`
                    : selecting
                      ? `${isSelected ? "Deselect" : "Select"} ${card.player.user.username}`
                      : `View ${card.player.user.username}'s card`
                }
              >
                <div
                  data-pull-index={position}
                  className={`relative overflow-hidden rounded-[10px] transition-all duration-300 ${
                    isRecycled ? "scale-[0.94]" : "hover:-translate-y-1"
                  }`}
                  style={{
                    aspectRatio: "5 / 7",
                    boxShadow: isRecycled
                      ? "inset 0 0 0 1px rgba(148, 163, 184, 0.16)"
                      : isBest
                        ? `0 0 0 2px ${tierColor}, 0 10px 34px ${glow}`
                        : `0 10px 26px rgba(0,0,0,0.45)`,
                  }}
                >
                  {card.isNew && !isRecycled && (
                    <span className="absolute left-1.5 top-1.5 z-10 rounded bg-osu-pink px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white">
                      new
                    </span>
                  )}
                  {card.thumbnail ? (
                    <img
                      src={card.thumbnail}
                      alt={`${card.player.user.username} maniacard`}
                      className={`h-full w-full object-cover transition-all duration-500 ${
                        isRecycled ? "opacity-20 grayscale" : ""
                      }`}
                      draggable={false}
                    />
                  ) : (
                    <div
                      className={`grid h-full w-full place-items-center bg-osu-b4/70 px-3 text-center transition-all duration-500 ${
                        isRecycled ? "opacity-25 grayscale" : ""
                      }`}
                    >
                      <span className="text-[12px] font-semibold text-white">{card.player.user.username}</span>
                    </div>
                  )}
                  {selecting && !isRecycled && (
                    <>
                      <span
                        className={`pointer-events-none absolute inset-0 z-10 rounded-[10px] ${
                          isSelected ? "ring-2 ring-inset ring-osu-pink" : "bg-black/45"
                        }`}
                      />
                      {isSelected && (
                        <span className="absolute right-1.5 top-1.5 z-10 grid h-5 w-5 place-items-center rounded-full bg-osu-pink text-white">
                          <Check className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </>
                  )}
                  {/* What the slot has to say once the card is gone is what it
                      paid, so the shards take the card's place rather than a
                      word stamped over its face. */}
                  {isRecycled && (
                    <motion.span
                      className="absolute inset-0 z-20 grid place-items-center"
                      initial={reducedMotion ? false : { opacity: 0, scale: 0.75 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.3, ease: "easeOut" }}
                    >
                      <span className="flex flex-col items-center gap-1 text-osu-pink-light">
                        <Recycle className="h-4 w-4" />
                        <span className="text-[17px] font-bold leading-none tabular-nums">+{recycledFor}</span>
                      </span>
                    </motion.span>
                  )}
                </div>
              </button>
              <div className={`mt-2 text-center transition-opacity duration-300 ${isRecycled ? "opacity-40" : ""}`}>
                <Link
                  to="/player/$username"
                  params={{ username: card.player.user.username }}
                  className="flex items-center justify-center gap-1.5 hover:underline underline-offset-4 decoration-osu-f1/60"
                  aria-label={`Open ${card.player.user.username}'s profile`}
                >
                  <CountryFlag code={card.player.user.country_code} size="xs" decorative />
                  <span className="truncate text-[13px] font-bold text-white">{card.player.user.username}</span>
                </Link>
                <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[11px]">
                  {card.tierLabel && (
                    <span className="font-bold uppercase tracking-wide" style={{ color: tierColor }}>
                      {card.tierLabel}
                    </span>
                  )}
                  <span className="text-osu-f1 tabular-nums">#{card.player.globalRank.toLocaleString()}</span>
                </div>
                {(() => {
                  const mint = serials?.get(packCardKey(card.player.user.id, card.tier));
                  if (!mint) return null;
                  // "First ever" is the server's call, not serial 1: a repull
                  // of a card you already hold hands back your old serial, so
                  // a serial-1 holding resurfacing months later must not read
                  // as if this pull were the card's first anywhere. Everything
                  // short of first-global renders as a plain ordinal with the
                  // pull count ("1st of 97 to pull this"), so being an early
                  // number never masquerades as being the only one.
                  const first = mint.isFirstGlobal;
                  return (
                    <div
                      className={`mt-0.5 text-[11px] tabular-nums ${first ? "font-bold text-amber-300" : "text-osu-f1"}`}
                    >
                      {first
                        ? "first ever to pull this"
                        : `${formatOrdinal(mint.serial)} of ${mint.mintedTotal.toLocaleString()} to pull this`}
                    </div>
                  );
                })()}
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onOpenNext}
          disabled={!canOpenNext}
          className={`rounded-full px-7 py-2.5 text-sm font-bold transition ${
            canOpenNext
              ? "bg-osu-pink text-white hover:brightness-110 cursor-pointer"
              : "bg-osu-b4/60 text-osu-f1/70"
          }`}
        >
          Open another
          {nextPackShardCost !== null && (
            <span className="ml-1.5 font-semibold tabular-nums opacity-80">{nextPackShardCost} shards</span>
          )}
        </button>
        <button
          type="button"
          onClick={onOpenAnother}
          className="rounded-full bg-osu-h2 px-6 py-2.5 text-sm font-bold text-white transition-colors hover:bg-osu-pink-dark cursor-pointer"
        >
          Back to packs
        </button>
      </div>
      {livePositions.length > 0 && (
        <button
          type="button"
          data-select-keep=""
          disabled={recycleBusy}
          onClick={(event) => runRecycle(allLive, event.currentTarget)}
          className="mt-3 flex items-center gap-1.5 text-[11px] text-osu-f1 transition-colors cursor-pointer hover:text-white disabled:cursor-default disabled:opacity-50"
        >
          <Recycle className={`h-3.5 w-3.5 ${recycleBusy ? "animate-spin" : ""}`} />
          <span className="tabular-nums">
            {recycleBusy
              ? "Recycling..."
              : `${recycled.size > 0 ? "Recycle the rest" : "Recycle all"} +${allValue}`}
          </span>
        </button>
      )}

      {selecting && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
          <div
            className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-full border border-osu-b3/50 bg-osu-b5 px-5 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
            data-select-keep=""
          >
            <span className="text-[12px] text-osu-f1 tabular-nums">
              <span className="font-bold text-white">{selectedLive.length}</span> selected
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set(livePositions))}
              className="text-[12px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
            >
              select all
            </button>
            {selectedLive.length > 0 && (
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-[12px] text-osu-f1 transition-colors hover:text-white cursor-pointer"
              >
                clear
              </button>
            )}
            <button
              type="button"
              disabled={selectedLive.length === 0 || recycleBusy}
              onClick={(event) => runRecycle(new Set(selectedLive), event.currentTarget)}
              className="flex items-center gap-1.5 rounded-full bg-osu-pink px-4 py-1.5 text-[12px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-40"
            >
              <Recycle className={`h-3.5 w-3.5 ${recycleBusy ? "animate-spin" : ""}`} />
              {recycleBusy ? "Recycling..." : `Recycle +${selectedValue}`}
            </button>
          </div>
        </div>
      )}

      {menu && (() => {
        const card = cards[menu.position];
        const group = groups.find((entry) => entry.positions.includes(menu.position));
        if (!card || !group) return null;
        const live = group.positions.filter((position) => !recycled.has(position));
        // The last copy of a card this pack was the first of takes the card
        // out of the collection, so that one asks twice; a spare copy does not.
        const leavesCollection = group.isFirstCopy && live.length === 1;
        const value = recycleValueOf(new Set([menu.position]));
        return (
          <>
            <div
              className="fixed inset-0 z-40"
              data-select-keep=""
              onPointerDown={() => setMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu(null);
              }}
            />
            <div
              className="fixed z-50 w-[208px] rounded-lg border border-osu-b3/50 bg-osu-b5 py-1 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
              style={{ left: menu.x, top: menu.y }}
              role="menu"
              data-select-keep=""
            >
              <div className="flex items-center gap-2 px-3 py-1.5">
                <CountryFlag code={card.player.user.country_code} size="xs" decorative />
                <span className="truncate text-[12px] font-bold text-white">{card.player.user.username}</span>
              </div>
              <div className="mx-2 my-1 h-px bg-osu-b3/40" />
              <Link
                to="/player/$username"
                params={{ username: card.player.user.username }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white"
                role="menuitem"
                onClick={() => setMenu(null)}
              >
                Open profile
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSelecting(true);
                  setSelected(new Set([menu.position]));
                  setMenu(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-osu-f1 transition-colors hover:bg-osu-b4/60 hover:text-white cursor-pointer"
              >
                <Check className="h-3 w-3" />
                Select cards...
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={recycleBusy}
                onClick={(event) => {
                  if (leavesCollection && !menuConfirm) {
                    setMenuConfirm(true);
                    return;
                  }
                  runRecycle(new Set([menu.position]), event.currentTarget);
                  setMenu(null);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-osu-b4/60 cursor-pointer disabled:cursor-default disabled:opacity-40 ${
                  menuConfirm ? "font-bold text-osu-pink-light" : "text-osu-f1 hover:text-white"
                }`}
              >
                <Recycle className="h-3 w-3" />
                {menuConfirm
                  ? "Sure? The card leaves the collection"
                  : `${leavesCollection ? "Recycle card" : "Recycle this copy"} +${value}`}
              </button>
            </div>
          </>
        );
      })()}

      {shardBursts.map((burst) => (
        <div
          key={burst.id}
          className="pointer-events-none fixed z-50"
          style={{ left: burst.x, top: burst.y }}
          aria-hidden="true"
        >
          <motion.div
            className="flex -translate-x-1/2 items-center gap-1 text-[12px] font-bold text-osu-pink-light"
            style={{ textShadow: "0 1px 6px rgba(0,0,0,0.7)" }}
            initial={{ y: 2, opacity: 0, scale: 0.7 }}
            animate={{ y: -26, opacity: [0, 1, 1, 0], scale: 1 }}
            transition={{ duration: 0.65, ease: "easeOut" }}
          >
            <Recycle className="h-3.5 w-3.5" />
            +{burst.amount}
          </motion.div>
        </div>
      ))}

      <CardSpotlight
        target={spotlight}
        onClose={() => setSpotlight(null)}
        onExitComplete={() => setLiftedPosition(null)}
      />

      {/* Handoff flights: each card sliding from where the reveal left it
          into its grid slot */}
      {flights?.map((flight) => (
        <img
          key={flight.position}
          ref={(el) => {
            if (el) flightImgRefs.current.set(flight.position, el);
            else flightImgRefs.current.delete(flight.position);
          }}
          src={flight.thumbnail}
          alt=""
          className="pointer-events-none absolute z-40 rounded-[10px] object-cover"
          style={{
            left: flight.from.left,
            top: flight.from.top,
            width: flight.from.width,
            height: flight.from.height,
            transformOrigin: "top left",
            willChange: "transform",
          }}
          draggable={false}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
