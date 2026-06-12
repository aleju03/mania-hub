import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ManiaCardTier, ManiaSkills } from "#/lib/maniacard";
import { tierRank, type PulledCard } from "#/lib/pack-collection";
import { fetchPackPlayerScores, type PackPlayer } from "#/lib/packs";
import type { OsuScore } from "#/lib/types";
import { CountryFlag } from "../ui/CountryFlag";
import { ManiaCardRenderer } from "../player/maniacard3d/ManiaCardRenderer";
import { buildManiaCardRenderData } from "../player/maniacard3d/renderData";
import type { ManiaCardReadyData, RgbaColor } from "../player/maniacard3d/types";
import { renderCardThumbnail } from "./cardSnapshot";
import { createCardBackCanvas } from "./packArt";
import { playCardDraw, playFlipWhoosh, playRevealChime } from "./packSfx";
import { TierBurst } from "./TierBurst";

export interface PackCardState {
  player: PackPlayer;
  /* null = the score fetch failed; distinct from an empty list, which means
     the player has no usable ranked plays. */
  scoresPromise: Promise<OsuScore[] | null>;
}

export interface RevealedCard {
  player: PackPlayer;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
  glowColor: RgbaColor | null;
  thumbnail: string | null;
  isNew: boolean;
}

interface RevealStageProps {
  cards: PackCardState[];
  reducedMotion: boolean;
  /* Called once per card the moment it is revealed; returns whether this is
     the player's first copy in the viewer's collection. */
  onCardRevealed?: (pull: PulledCard) => boolean;
  onComplete: (revealed: RevealedCard[]) => void;
}

type RevealPhase = "stack" | "preparing" | "flipping" | "shown";

interface FlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/* The advance transition: the shown card's thumbnail flies from the big
   card's spot down into its tray slot, shrinking on the way. `to` is null
   until the tray tile exists to be measured. */
interface CardFlight {
  cardIndex: number;
  thumbnail: string;
  from: FlightRect;
  to: FlightRect | null;
}

// The WebGL card fills the host's height divided by the renderer's 1.05
// breathing-room factor. The DOM stack cards scale to the same apparent size
// so handing the top card to the canvas is seamless.
const STACK_CARD_SCALE = 1 / 1.05;

function isMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 640px)").matches
  );
}

function stackBackTransform(position: number, dragX = 0) {
  const x = position * 5 + dragX;
  const y = position * 6;
  const rotate = position * 1.4 + dragX * 0.035;
  return `translate3d(${x}px, ${y}px, 0) rotate(${rotate}deg) scale(${STACK_CARD_SCALE})`;
}

function DraggableStackBackCard({
  cardBack,
  position,
  zIndex,
  onDraw,
}: {
  cardBack: string;
  position: number;
  zIndex: number;
  onDraw: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    latestX: number;
    dragging: boolean;
  } | null>(null);

  const snapBack = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
    el.style.transform = stackBackTransform(position);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = "transform 180ms ease-out";
    el.style.transform = stackBackTransform(position);
  }, [position]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const el = event.currentTarget;
    suppressClickRef.current = false;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: 0,
      dragging: false,
    };
    el.style.transition = "none";
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.dragging) {
      if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
      gesture.dragging = true;
      suppressClickRef.current = true;
      if (typeof event.currentTarget.setPointerCapture === "function") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }

    event.preventDefault();
    gesture.latestX = dx;
    event.currentTarget.style.transform = stackBackTransform(position, dx);
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!gesture.dragging) {
      snapBack();
      return;
    }

    event.preventDefault();
    if (Math.abs(gesture.latestX) > 90) {
      onDraw();
      return;
    }
    snapBack();
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    snapBack();
  };

  const onClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onDraw();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onDraw();
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0 rounded-[18px] bg-cover bg-center cursor-grab active:cursor-grabbing select-none"
      style={{
        backgroundImage: `url(${cardBack})`,
        boxShadow: "0 14px 36px rgba(0,0,0,0.5)",
        zIndex,
        transform: stackBackTransform(position),
        transformOrigin: "center",
        touchAction: "pan-y",
        willChange: "transform",
        backfaceVisibility: "hidden",
        WebkitTapHighlightColor: "transparent",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
      aria-label="Draw the next card"
    />
  );
}

export function RevealStage({ cards, reducedMotion, onCardRevealed, onComplete }: RevealStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const backCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ManiaCardRenderer | null>(null);
  const onReadyRef = useRef<(() => void) | null>(null);
  const onErrorRef = useRef<((error: unknown) => void) | null>(null);
  const cancelledRef = useRef(false);
  const phaseRef = useRef<RevealPhase>("stack");
  const revealedRef = useRef<RevealedCard[]>([]);

  const [index, setIndex] = useState(0);
  const [phase, setPhaseState] = useState<RevealPhase>("stack");
  const [revealed, setRevealed] = useState<RevealedCard[]>([]);
  const [activeData, setActiveData] = useState<ManiaCardReadyData | null>(null);
  const [activeFallback, setActiveFallback] = useState<string | null>(null);
  const [mintFailure, setMintFailure] = useState<"no-data" | "fetch" | null>(null);
  /* A cold player's scores can take a while to fetch (osu! API queue on the
     backend); after a few seconds the draw label says so instead of looking
     stuck. */
  const [slowDraw, setSlowDraw] = useState(false);
  const [burst, setBurst] = useState<{ key: number; tier: ManiaCardTier; glowColor: RgbaColor } | null>(null);
  const [cardBack, setCardBack] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [flight, setFlight] = useState<CardFlight | null>(null);
  const trayRef = useRef<HTMLDivElement | null>(null);

  const setPhase = (next: RevealPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  useEffect(() => {
    setSlowDraw(false);
    if (phase !== "preparing") return;
    const timer = window.setTimeout(() => setSlowDraw(true), 4000);
    return () => window.clearTimeout(timer);
  }, [phase, index]);

  useEffect(() => {
    // Reset on every mount: StrictMode runs mount -> cleanup -> mount, and a
    // stale true here would silently abort every reveal.
    cancelledRef.current = false;
    const backCanvas = createCardBackCanvas();
    backCanvasRef.current = backCanvas;
    setCardBack(backCanvas.toDataURL("image/png"));
    return () => {
      cancelledRef.current = true;
      rendererRef.current?.dispose({ deferGpuRelease: true });
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => rendererRef.current?.resize());
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const ensureRendererReady = (data: ManiaCardReadyData) =>
    new Promise<void>((resolve, reject) => {
      const host = hostRef.current;
      if (!host) {
        reject(new Error("Card host is not mounted."));
        return;
      }
      onReadyRef.current = resolve;
      onErrorRef.current = reject;
      if (!rendererRef.current) {
        rendererRef.current = new ManiaCardRenderer({
          host,
          data,
          mobile: isMobileViewport(),
          reducedMotion,
          devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
          startFaceDown: true,
          // Pack reveals want a steady card; tilting the phone should not
          // swing it around (touch drag still works).
          gyro: false,
          onReady: () => onReadyRef.current?.(),
          onError: (error) => onErrorRef.current?.(error),
        });
        // Same neutral back as the DOM stack, so the canvas takeover is
        // invisible and the flip never spoils the tier.
        rendererRef.current.setBackOverride(backCanvasRef.current);
        rendererRef.current.resize();
      } else {
        rendererRef.current.setFaceDown();
        void rendererRef.current.setData(data);
      }
    });

  const recordRevealed = (entry: Omit<RevealedCard, "isNew">, skills: ManiaSkills | null) => {
    const isNew = onCardRevealed
      ? onCardRevealed({
          userId: entry.player.user.id,
          username: entry.player.user.username,
          avatarUrl: entry.player.user.avatar_url,
          countryCode: entry.player.user.country_code,
          tier: entry.tier,
          tierLabel: entry.tierLabel,
          skills,
          pp: entry.player.pp,
          globalRank: entry.player.globalRank,
        })
      : false;
    revealedRef.current = [...revealedRef.current, { ...entry, isNew }];
    setRevealed(revealedRef.current);
  };

  const updateThumbnail = (cardIndex: number, thumbnail: string) => {
    revealedRef.current = revealedRef.current.map((entry, position) =>
      position === cardIndex ? { ...entry, thumbnail } : entry,
    );
    setRevealed(revealedRef.current);
  };

  const reveal = async (position: number) => {
    if (skipping) return;
    if (phaseRef.current === "preparing" || phaseRef.current === "flipping") return;
    const card = cards[position];
    if (!card) return;
    setPhase("preparing");
    playCardDraw();

    let scores = await card.scoresPromise;
    if (cancelledRef.current) return;
    if (scores === null) {
      // The pre-deal fetch failed (flaky network, rate limit); one more try
      // now that the card is actually being revealed.
      scores = await fetchPackPlayerScores(card.player.user.id).catch(() => null);
      if (cancelledRef.current) return;
    }

    if (scores === null) {
      recordRevealed({ player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null }, null);
      setActiveData(null);
      setActiveFallback(null);
      setMintFailure("fetch");
      setPhase("shown");
      return;
    }

    const data = buildManiaCardRenderData({ user: card.player.user, scores });

    if (data.status !== "ready") {
      recordRevealed({ player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null }, null);
      setActiveData(null);
      setActiveFallback(null);
      setMintFailure("no-data");
      setPhase("shown");
      return;
    }

    recordRevealed(
      {
        player: card.player,
        tier: data.tier,
        tierLabel: data.tierStyle.label,
        glowColor: data.glowColor,
        thumbnail: null,
      },
      data.skills,
    );
    const cardIndex = revealedRef.current.length - 1;

    try {
      await ensureRendererReady(data);
      if (cancelledRef.current) return;
      setActiveData(data);
      setActiveFallback(null);
      setPhase("flipping");
      // A short beat while the canvas card (same neutral back as the stack)
      // takes over the top of the stack, then it turns.
      await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 60 : 220));
      if (cancelledRef.current) return;
      const flipMs = reducedMotion ? 240 : 980;
      playFlipWhoosh(flipMs);
      await rendererRef.current?.playRevealFlip(flipMs);
      if (cancelledRef.current) return;
      // Tray thumbnail comes from the front texture the renderer already
      // drew; rebuilding it through the full texture pipeline used to run
      // concurrently with the flip and stutter the animation.
      const thumbnail = rendererRef.current?.snapshotFrontCanvas();
      if (thumbnail) updateThumbnail(cardIndex, thumbnail);
      setPhase("shown");
      if (!reducedMotion) setBurst({ key: position, tier: data.tier, glowColor: data.glowColor });
      playRevealChime(tierRank(data.tier) / 8, revealedRef.current[cardIndex]?.isNew ?? false);
    } catch {
      // WebGL unavailable: fall back to the 2D front image.
      if (cancelledRef.current) return;
      rendererRef.current?.dispose();
      rendererRef.current = null;
      try {
        const thumbnail = await renderCardThumbnail(data, 600);
        if (cancelledRef.current) return;
        setActiveFallback(thumbnail);
        updateThumbnail(cardIndex, thumbnail);
      } catch {
        setActiveFallback(null);
      }
      setActiveData(data);
      setPhase("shown");
      playRevealChime(tierRank(data.tier) / 8, revealedRef.current[cardIndex]?.isNew ?? false);
    }
  };

  // One click: leave the shown card and immediately start drawing the next,
  // instead of dropping back to the stack and waiting for a second click.
  const advance = () => {
    if (phaseRef.current !== "shown" || skipping) return;
    setBurst(null);
    if (index + 1 >= cards.length) {
      onComplete(revealedRef.current);
      return;
    }
    // The leaving card flies into its tray slot while the next one prepares.
    const entry = revealedRef.current[index];
    const hostRect = hostRef.current?.getBoundingClientRect();
    if (!reducedMotion && entry?.thumbnail && hostRect) {
      setFlight({
        cardIndex: index,
        thumbnail: entry.thumbnail,
        from: { left: hostRect.left, top: hostRect.top, width: hostRect.width, height: hostRect.height },
        to: null,
      });
    }
    const next = index + 1;
    setActiveData(null);
    setActiveFallback(null);
    setMintFailure(null);
    setIndex(next);
    void reveal(next);
  };

  // Once the tray re-renders with the leaving card's slot, measure it so the
  // flight knows where to land. Layout effect: the measurement and the
  // overlay mount must happen before the browser paints the hidden tile.
  useLayoutEffect(() => {
    if (!flight || flight.to) return;
    const tile = trayRef.current?.querySelector(`[data-tray-index="${flight.cardIndex}"]`);
    if (!(tile instanceof HTMLElement)) {
      setFlight(null);
      return;
    }
    const rect = tile.getBoundingClientRect();
    setFlight({ ...flight, to: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
  }, [flight]);

  // The flight runs on the compositor via the Web Animations API: the next
  // card's texture build blocks the main thread mid-flight, and a rAF-driven
  // animation (framer-motion) visibly stutters there.
  const flightImgRef = useRef<HTMLImageElement | null>(null);
  useLayoutEffect(() => {
    if (!flight?.to) return;
    const el = flightImgRef.current;
    if (!el || typeof el.animate !== "function") {
      setFlight(null);
      return;
    }
    const dx = flight.to.left - flight.from.left;
    const dy = flight.to.top - flight.from.top;
    const sx = flight.to.width / flight.from.width;
    const sy = flight.to.height / flight.from.height;
    const animation = el.animate(
      [
        { transform: "translate(0px, 0px) scale(1, 1)" },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      ],
      { duration: 450, easing: "cubic-bezier(0.3, 0.7, 0.2, 1)", fill: "forwards" },
    );
    let cancelled = false;
    animation.finished
      .then(() => {
        if (!cancelled) setFlight(null);
      })
      .catch(() => {
        if (!cancelled) setFlight(null);
      });
    return () => {
      cancelled = true;
      animation.cancel();
    };
  }, [flight]);

  // Resolves every remaining card without the one-by-one ceremony.
  const revealRest = async () => {
    if (skipping || phaseRef.current === "preparing" || phaseRef.current === "flipping") return;
    setSkipping(true);
    playCardDraw();
    const startAt = phaseRef.current === "shown" ? index + 1 : index;
    for (let position = startAt; position < cards.length; position += 1) {
      const card = cards[position];
      let scores = await card.scoresPromise;
      if (cancelledRef.current) return;
      if (scores === null) {
        scores = await fetchPackPlayerScores(card.player.user.id).catch(() => null);
        if (cancelledRef.current) return;
      }
      if (scores === null) {
        recordRevealed({ player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null }, null);
        continue;
      }
      const data = buildManiaCardRenderData({ user: card.player.user, scores });
      if (data.status !== "ready") {
        recordRevealed({ player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null }, null);
        continue;
      }
      let thumbnail: string | null = null;
      try {
        thumbnail = await renderCardThumbnail(data);
      } catch {
        thumbnail = null;
      }
      if (cancelledRef.current) return;
      recordRevealed(
        {
          player: card.player,
          tier: data.tier,
          tierLabel: data.tierStyle.label,
          glowColor: data.glowColor,
          thumbnail,
        },
        data.skills,
      );
    }
    if (!cancelledRef.current) onComplete(revealedRef.current);
  };

  // While the active card is on the canvas, its DOM back leaves the stack.
  const firstBackCardIndex = phase === "flipping" || phase === "shown" ? index + 1 : index;
  const remainingBacks = Math.max(0, cards.length - firstBackCardIndex);

  /* Without activeData there is nothing valid on the canvas; keeping it
     visible would show the previous card's face behind a failure overlay. */
  const showCanvas = (phase === "flipping" || phase === "shown") && !activeFallback && activeData !== null;
  const current = revealed[index] ?? null;
  const tierColor = current?.glowColor
    ? `rgb(${current.glowColor.r}, ${current.glowColor.g}, ${current.glowColor.b})`
    : "rgb(226, 232, 240)";

  return (
    <div className="flex flex-col items-center">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-osu-f1 tabular-nums">
        card {Math.min(index + 1, cards.length)} / {cards.length}
      </div>

      <div
        className="relative mt-4 w-[min(340px,84vw)]"
        style={{ aspectRatio: "5 / 7" }}
      >
        {/* Face-down stack */}
        {cardBack &&
          Array.from({ length: remainingBacks }, (_, position) => position)
            .reverse()
            .map((position) => {
              const isTop = position === 0;
              const draggable = isTop && phase === "stack" && !skipping;
              if (draggable) {
                return (
                  <DraggableStackBackCard
                    key={`${firstBackCardIndex + position}`}
                    cardBack={cardBack}
                    position={position}
                    zIndex={10 - position}
                    onDraw={() => {
                      if (phaseRef.current === "stack") void reveal(index);
                    }}
                  />
                );
              }
              return (
                <motion.div
                  key={`${firstBackCardIndex + position}`}
                  className="absolute inset-0 rounded-[18px] bg-cover bg-center"
                  style={{
                    backgroundImage: `url(${cardBack})`,
                    boxShadow: "0 14px 36px rgba(0,0,0,0.5)",
                    zIndex: 10 - position,
                    willChange: "transform",
                    backfaceVisibility: "hidden",
                  }}
                  animate={{
                    x: position * 5,
                    y: position * 6,
                    rotate: position * 1.4,
                    scale:
                      isTop && phase === "preparing" && !reducedMotion
                        ? [STACK_CARD_SCALE, STACK_CARD_SCALE * 1.025, STACK_CARD_SCALE]
                        : STACK_CARD_SCALE,
                  }}
                  transition={
                    isTop && phase === "preparing" && !reducedMotion
                      ? { scale: { duration: 0.9, repeat: Infinity, ease: "easeInOut" }, default: { duration: 0.25 } }
                      : { duration: 0.25 }
                  }
                />
              );
            })}

        {/* Preparing ring */}
        <AnimatePresence>
          {phase === "preparing" && (
            <motion.div
              className="absolute inset-0 z-20 rounded-[18px] pointer-events-none"
              style={{
                boxShadow: "0 0 0 2px rgba(196,181,253,0.55), 0 0 34px rgba(167,139,250,0.45)",
                scale: STACK_CARD_SCALE,
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            />
          )}
        </AnimatePresence>

        {/* 3D card host */}
        {/* No fade: the canvas card wears the same neutral back as the DOM
            stack card it replaces, so the swap is invisible. */}
        <div
          ref={hostRef}
          className="absolute inset-0"
          style={{
            opacity: showCanvas ? 1 : 0,
            pointerEvents: showCanvas ? "auto" : "none",
            touchAction: "none",
            zIndex: 15,
          }}
          role="img"
          aria-label={
            activeData && phase === "shown"
              ? `${activeData.user.username} ${activeData.tierStyle.label} maniacard`
              : undefined
          }
        />

        {/* 2D fallback when WebGL is unavailable */}
        {activeFallback && phase === "shown" && (
          <img
            src={activeFallback}
            alt={activeData ? `${activeData.user.username} maniacard` : "Maniacard"}
            className="absolute inset-0 z-[15] h-full w-full rounded-[18px] object-cover"
            draggable={false}
          />
        )}

        {/* Mint failure (no usable card data, or the score fetch failed) */}
        {phase === "shown" && !activeData && (
          <div className="absolute inset-0 z-[15] grid place-items-center rounded-[18px] border-2 border-osu-b3/40 bg-osu-b4/90 px-6 text-center">
            <div>
              <div className="text-sm font-bold text-white">{cards[index]?.player.user.username}</div>
              <div className="mt-2 text-[12px] text-osu-f1">
                {mintFailure === "fetch"
                  ? "Couldn't load this player's plays right now. The card is in your collection and will mint itself there."
                  : "This player's card refused to mint. Not enough ranked play data."}
              </div>
            </div>
          </div>
        )}

        {burst && <TierBurst key={burst.key} tier={burst.tier} glowColor={burst.glowColor} />}
      </div>

      {/* Caption */}
      <div className="mt-5 h-[58px] text-center" aria-live="polite">
        <AnimatePresence mode="wait">
          {phase === "shown" && current ? (
            <motion.div
              key={`caption-${index}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
            >
              {/* New tab: an in-app navigation would unmount the reveal and
                  forfeit the still-unrevealed cards of an already-paid pack. */}
              <Link
                to="/player/$username"
                params={{ username: current.player.user.username }}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 hover:underline underline-offset-4 decoration-osu-f1/60"
                aria-label={`Open ${current.player.user.username}'s profile in a new tab`}
              >
                <img
                  src={current.player.user.avatar_url}
                  alt=""
                  className="h-6 w-6 rounded-full object-cover"
                  draggable={false}
                />
                <span className="text-base font-bold text-white">{current.player.user.username}</span>
                <CountryFlag code={current.player.user.country_code} size="sm" decorative />
              </Link>
              <div className="mt-1 flex items-center justify-center gap-2 text-[12px]">
                {current.isNew && (
                  <span className="rounded bg-osu-pink/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-osu-pink-light">
                    new
                  </span>
                )}
                {current.tierLabel && (
                  <span className="font-bold uppercase tracking-wide" style={{ color: tierColor }}>
                    {current.tierLabel}
                  </span>
                )}
                <span className="text-osu-f1 tabular-nums">#{current.player.globalRank.toLocaleString()}</span>
                <span className="text-osu-f1 tabular-nums">{Math.round(current.player.pp).toLocaleString()}pp</span>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={`hint-${index}-${phase}-${slowDraw}`}
              className="text-[12px] text-osu-f1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {phase === "preparing"
                ? slowDraw
                  ? "Warming this player up... first draws can take a moment"
                  : "Drawing player..."
                : skipping
                  ? "Revealing the rest..."
                  : "Tap the stack or drag the top card to draw"}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Controls */}
      <div className="mt-2 flex items-center gap-4">
        {phase === "stack" && !skipping && (
          <button
            type="button"
            onClick={() => void reveal(index)}
            className="rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white hover:brightness-110 transition cursor-pointer"
          >
            Draw card
          </button>
        )}
        {phase === "shown" && (
          <button
            type="button"
            onClick={advance}
            className="rounded-full bg-osu-pink px-6 py-2 text-sm font-bold text-white hover:brightness-110 transition cursor-pointer"
          >
            {index + 1 >= cards.length ? "See your pulls" : "Next card"}
          </button>
        )}
        {!skipping && index + 1 < cards.length && (phase === "stack" || phase === "shown") && (
          <button
            type="button"
            onClick={() => void revealRest()}
            className="text-[12px] text-osu-f1 hover:text-white transition-colors cursor-pointer"
          >
            reveal all
          </button>
        )}
      </div>

      {/* Tray of already revealed cards */}
      {revealed.length > (phase === "shown" ? 1 : 0) && (
        <div ref={trayRef} className="mt-6 flex items-center justify-center gap-2">
          {revealed.slice(0, phase === "shown" ? revealed.length - 1 : revealed.length).map((entry, position) => (
            <div
              key={`${entry.player.user.id}-${position}`}
              data-tray-index={position}
              className="w-11 overflow-hidden rounded-[6px]"
              // The slot stays invisible while its card is mid-flight; the
              // landing overlay is what the eye follows into place.
              style={{ aspectRatio: "5 / 7", opacity: flight?.cardIndex === position ? 0 : 1 }}
            >
              {entry.thumbnail ? (
                <img src={entry.thumbnail} alt={entry.player.user.username} className="h-full w-full object-cover" draggable={false} />
              ) : (
                <div className="h-full w-full bg-osu-b4/70" />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Flying card: the advanced card shrinking into its tray slot */}
      {flight?.to && (
        <img
          ref={flightImgRef}
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
      )}
    </div>
  );
}
