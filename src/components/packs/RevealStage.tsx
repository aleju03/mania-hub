import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { ManiaCardTier } from "#/lib/maniacard";
import type { PackPlayer } from "#/lib/packs";
import type { OsuScore } from "#/lib/types";
import { CountryFlag } from "../ui/CountryFlag";
import { ManiaCardRenderer } from "../player/maniacard3d/ManiaCardRenderer";
import { buildManiaCardRenderData } from "../player/maniacard3d/renderData";
import type { ManiaCardReadyData, RgbaColor } from "../player/maniacard3d/types";
import { renderCardThumbnail } from "./cardSnapshot";
import { createCardBackCanvas } from "./packArt";
import { TierBurst } from "./TierBurst";

export interface PackCardState {
  player: PackPlayer;
  scoresPromise: Promise<OsuScore[]>;
}

export interface RevealedCard {
  player: PackPlayer;
  tier: ManiaCardTier | null;
  tierLabel: string | null;
  glowColor: RgbaColor | null;
  thumbnail: string | null;
}

interface RevealStageProps {
  cards: PackCardState[];
  reducedMotion: boolean;
  onComplete: (revealed: RevealedCard[]) => void;
}

type RevealPhase = "stack" | "preparing" | "flipping" | "shown";

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

export function RevealStage({ cards, reducedMotion, onComplete }: RevealStageProps) {
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
  const [burst, setBurst] = useState<{ key: number; tier: ManiaCardTier; glowColor: RgbaColor } | null>(null);
  const [cardBack, setCardBack] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);

  const setPhase = (next: RevealPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  useEffect(() => {
    // Reset on every mount: StrictMode runs mount -> cleanup -> mount, and a
    // stale true here would silently abort every reveal.
    cancelledRef.current = false;
    const backCanvas = createCardBackCanvas();
    backCanvasRef.current = backCanvas;
    setCardBack(backCanvas.toDataURL("image/png"));
    return () => {
      cancelledRef.current = true;
      rendererRef.current?.dispose();
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

  const recordRevealed = (entry: RevealedCard) => {
    revealedRef.current = [...revealedRef.current, entry];
    setRevealed(revealedRef.current);
  };

  const updateThumbnail = (cardIndex: number, thumbnail: string) => {
    revealedRef.current = revealedRef.current.map((entry, position) =>
      position === cardIndex ? { ...entry, thumbnail } : entry,
    );
    setRevealed(revealedRef.current);
  };

  const reveal = async () => {
    if (phaseRef.current !== "stack" || skipping) return;
    const card = cards[index];
    if (!card) return;
    setPhase("preparing");

    const scores = await card.scoresPromise;
    if (cancelledRef.current) return;
    const data = buildManiaCardRenderData({ user: card.player.user, scores });

    if (data.status !== "ready") {
      recordRevealed({ player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null });
      setActiveData(null);
      setActiveFallback(null);
      setPhase("shown");
      return;
    }

    recordRevealed({
      player: card.player,
      tier: data.tier,
      tierLabel: data.tierStyle.label,
      glowColor: data.glowColor,
      thumbnail: null,
    });
    const cardIndex = revealedRef.current.length - 1;
    void renderCardThumbnail(data)
      .then((thumbnail) => {
        if (!cancelledRef.current) updateThumbnail(cardIndex, thumbnail);
      })
      .catch(() => {});

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
      await rendererRef.current?.playRevealFlip(reducedMotion ? 240 : 980);
      if (cancelledRef.current) return;
      setPhase("shown");
      if (!reducedMotion) setBurst({ key: index, tier: data.tier, glowColor: data.glowColor });
    } catch {
      // WebGL unavailable: fall back to the 2D front image.
      if (cancelledRef.current) return;
      rendererRef.current?.dispose();
      rendererRef.current = null;
      try {
        const thumbnail = await renderCardThumbnail(data, 600);
        if (cancelledRef.current) return;
        setActiveFallback(thumbnail);
      } catch {
        setActiveFallback(null);
      }
      setActiveData(data);
      setPhase("shown");
    }
  };

  const advance = () => {
    if (phaseRef.current !== "shown") return;
    setBurst(null);
    if (index + 1 >= cards.length) {
      onComplete(revealedRef.current);
      return;
    }
    setActiveData(null);
    setActiveFallback(null);
    setIndex(index + 1);
    setPhase("stack");
  };

  // Resolves every remaining card without the one-by-one ceremony.
  const revealRest = async () => {
    if (skipping || phaseRef.current === "preparing" || phaseRef.current === "flipping") return;
    setSkipping(true);
    const startAt = phaseRef.current === "shown" ? index + 1 : index;
    for (let position = startAt; position < cards.length; position += 1) {
      const card = cards[position];
      const scores = await card.scoresPromise;
      if (cancelledRef.current) return;
      const data = buildManiaCardRenderData({ user: card.player.user, scores });
      if (data.status !== "ready") {
        recordRevealed({ player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null });
        continue;
      }
      let thumbnail: string | null = null;
      try {
        thumbnail = await renderCardThumbnail(data);
      } catch {
        thumbnail = null;
      }
      if (cancelledRef.current) return;
      recordRevealed({
        player: card.player,
        tier: data.tier,
        tierLabel: data.tierStyle.label,
        glowColor: data.glowColor,
        thumbnail,
      });
    }
    if (!cancelledRef.current) onComplete(revealedRef.current);
  };

  // While the active card is on the canvas, its DOM back leaves the stack.
  const firstBackCardIndex = phase === "flipping" || phase === "shown" ? index + 1 : index;
  const remainingBacks = Math.max(0, cards.length - firstBackCardIndex);

  const showCanvas = (phase === "flipping" || phase === "shown") && !activeFallback;
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
              return (
                <motion.div
                  key={`${firstBackCardIndex + position}`}
                  className={`absolute inset-0 rounded-[18px] bg-cover bg-center ${
                    isTop && phase === "stack" && !skipping ? "cursor-pointer" : ""
                  }`}
                  style={{
                    backgroundImage: `url(${cardBack})`,
                    boxShadow: "0 14px 36px rgba(0,0,0,0.5)",
                    zIndex: 10 - position,
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
                  onClick={isTop ? () => void reveal() : undefined}
                  role={isTop && phase === "stack" ? "button" : undefined}
                  aria-label={isTop && phase === "stack" ? "Draw the next card" : undefined}
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

        {/* Mint failure (player without usable card data) */}
        {phase === "shown" && !activeData && (
          <div className="absolute inset-0 z-[15] grid place-items-center rounded-[18px] border-2 border-osu-b3/40 bg-osu-b4/70 px-6 text-center">
            <div>
              <div className="text-sm font-bold text-white">{cards[index]?.player.user.username}</div>
              <div className="mt-2 text-[12px] text-osu-f1">
                This player's card refused to mint. Not enough ranked play data.
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
              <Link
                to="/player/$username"
                params={{ username: current.player.user.username }}
                className="inline-flex items-center justify-center gap-2 hover:underline underline-offset-4 decoration-osu-f1/60"
                aria-label={`Open ${current.player.user.username}'s profile`}
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
              key={`hint-${index}-${phase}`}
              className="text-[12px] text-osu-f1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {phase === "preparing" ? "Drawing player..." : skipping ? "Revealing the rest..." : "Tap the stack to draw"}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Controls */}
      <div className="mt-2 flex items-center gap-4">
        {phase === "stack" && !skipping && (
          <button
            type="button"
            onClick={() => void reveal()}
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
        <div className="mt-6 flex items-center justify-center gap-2">
          {revealed.slice(0, phase === "shown" ? revealed.length - 1 : revealed.length).map((entry, position) => (
            <div key={`${entry.player.user.id}-${position}`} className="w-11 overflow-hidden rounded-[6px]" style={{ aspectRatio: "5 / 7" }}>
              {entry.thumbnail ? (
                <img src={entry.thumbnail} alt={entry.player.user.username} className="h-full w-full object-cover" draggable={false} />
              ) : (
                <div className="h-full w-full bg-osu-b4/70" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
