import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Swords } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatOrdinal } from "#/lib/format";
import { duplicateShardValueForTier, packCardKey, tierRank, type CollectedCard } from "#/lib/pack-collection";
import { CountryFlag } from "../ui/CountryFlag";
import { CardSpotlight, type CardSpotlightTarget } from "./CardSpotlight";
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
  /* Puts this hand up as a duel stake: opening a challenge, or answering one.
     Absent when duelling is unavailable (signed out, or no live backend). */
  onChallenge?: () => void;
  challengeBusy?: boolean;
  /* Who is being duelled, when this pack was opened to answer a challenge. */
  answeringUsername?: string | null;
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
  onChallenge,
  challengeBusy = false,
  answeringUsername = null,
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
  // What this pack's duplicates recycle into - the loop back to shard packs.
  // A card you already hold recycles at the duplicate rate, not its full tier
  // value, so this has to be the duplicate table or the summary promises more
  // than the collection pays.
  const dupeShards = cards
    .filter((card) => !card.isNew)
    .reduce((sum, card) => sum + duplicateShardValueForTier(card.tier), 0);

  // Clicking a card lifts it into the same spotlight the collection uses;
  // the profile lives behind the player's name and the spotlight's button.
  const [spotlight, setSpotlight] = useState<CardSpotlightTarget | null>(null);
  /* The lifted card's tile stays hidden until the close flight lands back
     in it, so the card never shows twice. */
  const [liftedCardId, setLiftedCardId] = useState<number | null>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const flightImgRefs = useRef<Map<number, HTMLImageElement>>(new Map());
  const [flights, setFlights] = useState<SummaryFlight[] | null>(null);

  /* Measured once on mount, before paint: pair each handed-off rect with its
     tile's final slot. The real tiles hide while their overlays are in the
     air, so the cards never show twice. */
  useLayoutEffect(() => {
    if (!flyFrom || flyFrom.size === 0 || reducedMotion) return;
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
        from,
        to: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
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
    <div className="flex flex-col items-center">
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
      </div>

      <div ref={gridRef} className="mt-7 flex flex-wrap items-start justify-center gap-4 sm:gap-5">
        {cards.map((card, position) => {
          const isBest = position === bestPosition;
          const glow = card.glowColor
            ? `rgba(${card.glowColor.r}, ${card.glowColor.g}, ${card.glowColor.b}, 0.55)`
            : "rgba(148, 163, 184, 0.35)";
          const tierColor = card.glowColor
            ? `rgb(${card.glowColor.r}, ${card.glowColor.g}, ${card.glowColor.b})`
            : "rgb(226, 232, 240)";
          return (
            <motion.div
              key={`${card.player.user.id}-${position}`}
              className="w-[128px] sm:w-[148px]"
              initial={reducedMotion || instant ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: reducedMotion || instant ? 0 : position * 0.07 }}
            >
              <button
                type="button"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setSpotlight({
                    card: toSpotlightCard(card),
                    thumbnail: card.thumbnail,
                    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                  });
                  setLiftedCardId(card.player.user.id);
                }}
                className="block w-full cursor-pointer"
                style={
                  liftedCardId === card.player.user.id || inFlight.has(position)
                    ? { visibility: "hidden" }
                    : undefined
                }
                aria-label={`View ${card.player.user.username}'s card`}
              >
                <div
                  data-pull-index={position}
                  className="relative overflow-hidden rounded-[10px] transition-transform duration-150 hover:-translate-y-1"
                  style={{
                    aspectRatio: "5 / 7",
                    boxShadow: isBest ? `0 0 0 2px ${tierColor}, 0 10px 34px ${glow}` : `0 10px 26px rgba(0,0,0,0.45)`,
                  }}
                >
                  {card.isNew && (
                    <span className="absolute left-1.5 top-1.5 z-10 rounded bg-osu-pink px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white">
                      new
                    </span>
                  )}
                  {card.thumbnail ? (
                    <img
                      src={card.thumbnail}
                      alt={`${card.player.user.username} maniacard`}
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center bg-osu-b4/70 px-3 text-center">
                      <span className="text-[12px] font-semibold text-white">{card.player.user.username}</span>
                    </div>
                  )}
                </div>
              </button>
              <div className="mt-2 text-center">
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
                  // a mint-#1 holding resurfacing months later must not read
                  // as if this pull were the card's first anywhere.
                  const first = mint.isFirstGlobal;
                  const heldMintOne = !first && mint.serial === 1;
                  return (
                    <div
                      className={`mt-0.5 text-[11px] tabular-nums ${first || heldMintOne ? "font-bold text-amber-300" : "text-osu-f1"}`}
                    >
                      {first
                        ? "first ever to pull this"
                        : heldMintOne
                          ? "you hold mint #1"
                          : `${formatOrdinal(mint.serial)} to pull this`}
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
        {onChallenge && (
          <button
            type="button"
            onClick={onChallenge}
            disabled={challengeBusy}
            className={`inline-flex items-center gap-1.5 rounded-full px-6 py-2.5 text-sm font-bold text-white transition-colors cursor-pointer ${
              answeringUsername ? "bg-osu-pink hover:brightness-110" : "bg-osu-h2 hover:bg-osu-pink-dark"
            }`}
          >
            <Swords className="h-4 w-4" />
            {challengeBusy
              ? answeringUsername
                ? "Putting them up..."
                : "Sealing the hand..."
              : answeringUsername
                ? `Play ${answeringUsername} for these`
                : "Duel this hand"}
          </button>
        )}
      </div>
      {onChallenge && (
        <div className="mt-3 text-[11px] text-osu-f1">
          {answeringUsername
            ? `Answering puts these ${cards.length} cards up against theirs. Win and you keep both hands.`
            : "Duelling stakes these cards: the winner keeps the loser's."}
        </div>
      )}
      {dupeShards > 0 && (
        <div className="mt-3 text-[11px] text-osu-f1 tabular-nums">
          Those duplicates recycle for {dupeShards} shard{dupeShards === 1 ? "" : "s"}.
        </div>
      )}

      <CardSpotlight
        target={spotlight}
        onClose={() => setSpotlight(null)}
        onExitComplete={() => setLiftedCardId(null)}
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
          className="pointer-events-none fixed z-40 rounded-[10px] object-cover"
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
