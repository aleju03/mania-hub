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
import { withTimeout } from "#/lib/promise-timeout";
import type { OsuScore } from "#/lib/types";
import { useWindowActive } from "#/lib/window-activity";
import { CountryFlag } from "../ui/CountryFlag";
import { ManiaCardRenderer } from "../player/maniacard3d/ManiaCardRenderer";
import { buildManiaCardRenderData, maniaCardAvatarUrl } from "../player/maniacard3d/renderData";
import type { ManiaCardReadyData, RgbaColor } from "../player/maniacard3d/types";
import { renderCardThumbnail } from "./cardSnapshot";
import {
  COLLECTION_CARD_THUMB_WIDTH,
  rememberCardThumbnailDataUrl,
} from "./cardThumbnailCache";
import { getCachedCardBackCanvas, getCachedCardBackDataUrl } from "./packArt";
import { playCardDraw, playFlipWhoosh, playGoatFanfare, playRevealChime } from "./packSfx";
import { GoatBurst } from "./GoatBurst";
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
  /* Skills snapshot from the mint, enough to redraw the live card offline
     (the summary's spotlight rebuilds the 3D card from it). */
  skills: ManiaSkills | null;
  isNew: boolean;
}

interface RevealStageProps {
  cards: PackCardState[];
  reducedMotion: boolean;
  /* Called once per card the moment it is revealed; returns whether this is
     the player's first copy in the viewer's collection. */
  onCardRevealed?: (pull: PulledCard) => boolean;
  /* A handoff means the viewer already saw the full grid (reveal-all): the
     summary should skip its enter ceremony and fly each card from its
     handed-off rect into the grid. */
  onComplete: (revealed: RevealedCard[], handoff?: RevealHandoff) => void;
}

type RevealPhase = "stack" | "preparing" | "flipping" | "shown";

export interface FlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/* Reveal-all handoff to the summary: where each card's tile sat (cascade
   slots plus the tray of earlier reveals) the moment the reveal completed,
   keyed by card position, so the summary can fly them into its grid. */
export interface RevealHandoff {
  sourceRects: Map<number, FlightRect>;
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

// If the card renderer never signals ready (a lost WebGL context or an rAF loop
// throttled to death after backgrounding on some phones), the reveal would sit
// on "Drawing player..." forever and the pack could never finish. Time out into
// the 2D fallback after this long so the last card always resolves.
const RENDERER_READY_TIMEOUT_MS = 8000;

// Reveal-all cascade: the remaining backs deal out of the stack into
// centered rows of face-down tiles, and each tile flips the moment its data
// lands. Rows may run wider than the stage; nothing clips them until the
// page-level overflow boundary.
const CASCADE_GAP = 12;
const CASCADE_MAX_SLOT_WIDTH = 152;
const CASCADE_MAX_ROW_WIDTH = 820;
// Breathing room the dealt grid keeps inside the stage, above and below.
const CASCADE_STAGE_PADDING = 56;
// Below this the tiles stop reading as cards, so wrapping to fix that needs
// no justification. Above it, the row shape is the better read of a hand and
// another row has to buy a real size jump.
const CASCADE_COMFY_SLOT_WIDTH = 96;
const CASCADE_EXTRA_ROW_GAIN = 1.15;
// Minimum spacing between consecutive flips when every card's data is
// already hot, so a cached pack still cascades instead of slapping all
// the faces over in the same frame.
const CASCADE_FLIP_GAP_MS = 170;

// A cold profile is allowed a useful window to finish, but it cannot hold an
// already-paid pack hostage forever. A failed card is still recorded in the
// wallet and mints itself later from the collection view.
const CARD_SCORE_WAIT_TIMEOUT_MS = 15_000;

/* How the remaining backs deal out: the row shape that makes the tiles as
   large as they fit, given the row's width and the vertical room the stage
   has. One row per pack (what this used to do up to six cards) shrank a
   five-card reveal into 60px slivers on a phone, right before the summary
   drew the same cards at 128px. The height budget is the footprint the stack
   already occupied, so the dealt grid never pushes the caption or tray down,
   and fewer rows win ties, which leaves desktop on its single row. */
function cascadeLayout(count: number, rowWidth: number, heightBudget: number) {
  let best = { rows: [count], slotWidth: 0 };
  for (let rowCount = 1; rowCount <= count; rowCount += 1) {
    const perRow = Math.ceil(count / rowCount);
    const byWidth = (rowWidth - (perRow - 1) * CASCADE_GAP) / perRow;
    const byHeight = ((heightBudget - (rowCount - 1) * CASCADE_GAP) / rowCount) * (5 / 7);
    const slotWidth = Math.min(CASCADE_MAX_SLOT_WIDTH, byWidth, byHeight);
    const gain = best.slotWidth >= CASCADE_COMFY_SLOT_WIDTH ? CASCADE_EXTRA_ROW_GAIN : 1;
    if (slotWidth <= best.slotWidth * gain) continue;
    // Rows split as evenly as they can: seven cards read better as 3/2/2
    // than as 3/3/1 with one card stranded on its own line.
    const base = Math.floor(count / rowCount);
    const extra = count % rowCount;
    best = {
      rows: Array.from({ length: rowCount }, (_, row) => base + (row < extra ? 1 : 0)),
      slotWidth,
    };
  }
  // Never zero: the deal-in scale divides by it, and a row overflowing the
  // stage is already allowed.
  return { rows: best.rows, slotWidth: Math.max(best.slotWidth, 32) };
}

async function resolveCardScores(card: PackCardState): Promise<OsuScore[] | null> {
  const deadline = Date.now() + CARD_SCORE_WAIT_TIMEOUT_MS;
  const wait = (promise: Promise<OsuScore[] | null>) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(null);
    return withTimeout(promise, remaining, "Pack card scores timed out").catch(() => null);
  };

  const prefetched = await wait(card.scoresPromise);
  if (prefetched !== null) return prefetched;
  return wait(fetchPackPlayerScores(card.player.user.id).catch(() => null));
}

function isMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 640px)").matches
  );
}

function stackBackTransform(position: number, dragX = 0) {
  // Mostly-horizontal fan: the rotated cards are taller than the stage, so a
  // steeper y/rotation step walks the buried cards' corners down over the
  // caption below the stack.
  const x = position * 7 + dragX;
  const y = position * 1;
  const rotate = position * 0.9 + dragX * 0.035;
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

interface CascadeTileProps {
  /* undefined until this card's data lands; landing is what flips the tile. */
  entry: RevealedCard | undefined;
  username: string;
  cardBack: string;
  /* True once the flip has landed (burst window). */
  landed: boolean;
  reducedMotion: boolean;
  onLanded: () => void;
  /* Fires the moment the flip swings past edge-on and the face becomes
     readable, which is halfway through the animation. Flips overlap, so the
     counter tracks this rather than the landing: by the time one flip
     completes the next card is already half turned. */
  onFaceVisible: () => void;
}

// How long a cascade tile's turn takes; face-visible (the counter's tick and
// what spoils the tier) is called at the halfway point, when the card passes
// edge-on.
const CASCADE_FLIP_MS = 360;

function CascadeTile({
  entry,
  username,
  cardBack,
  landed,
  reducedMotion,
  onLanded,
  onFaceVisible,
}: CascadeTileProps) {
  const flipRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const firedRef = useRef(false);
  const facedRef = useRef(false);
  const flipped = entry !== undefined;

  /* The flip runs on the compositor via the Web Animations API, like the
     advance flight below: the other cards' thumbnail paints land on the main
     thread all through the cascade, and a rAF-driven flip freezes mid-turn
     under them - on phones long enough to read as the card vanishing. The
     halfway callback rides a timer instead of a per-frame value, so a stalled
     main thread delays the counter, never the turn. */
  useLayoutEffect(() => {
    if (!flipped || startedRef.current) return;
    startedRef.current = true;
    const showFace = () => {
      if (facedRef.current) return;
      facedRef.current = true;
      onFaceVisible();
    };
    const fire = () => {
      if (firedRef.current) return;
      firedRef.current = true;
      showFace();
      onLanded();
    };
    const el = flipRef.current;
    if (!el || reducedMotion || typeof el.animate !== "function") {
      if (el) el.style.transform = "rotateY(180deg)";
      fire();
      return;
    }
    const animation = el.animate(
      [{ transform: "rotateY(0deg)" }, { transform: "rotateY(180deg)" }],
      { duration: CASCADE_FLIP_MS, easing: "cubic-bezier(0.3, 0.1, 0.3, 1)", fill: "forwards" },
    );
    let dead = false;
    const faceTimer = window.setTimeout(() => {
      if (!dead) showFace();
    }, CASCADE_FLIP_MS / 2);
    animation.finished
      .then(() => {
        if (!dead) fire();
      })
      .catch(() => {});
    return () => {
      dead = true;
      window.clearTimeout(faceTimer);
    };
    // The callbacks are per-render closures; startedRef makes the flip
    // one-shot regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipped, reducedMotion]);

  return (
    <div className="relative h-full w-full" style={{ perspective: 700 }}>
      <div ref={flipRef} className="relative h-full w-full" style={{ transformStyle: "preserve-3d" }}>
        <div
          className="absolute inset-0 rounded-[10px] bg-cover bg-center"
          style={{
            backgroundImage: `url(${cardBack})`,
            backfaceVisibility: "hidden",
            boxShadow: "0 10px 26px rgba(0,0,0,0.45)",
          }}
        />
        <div
          className="absolute inset-0 overflow-hidden rounded-[10px]"
          style={{ transform: "rotateY(180deg)", backfaceVisibility: "hidden" }}
        >
          {entry?.thumbnail ? (
            <img src={entry.thumbnail} alt={username} className="h-full w-full object-cover" draggable={false} />
          ) : (
            /* Mint failure: same dark tile the tray shows, plus the name so
               the slot isn't anonymous. */
            <div className="grid h-full w-full place-items-center bg-osu-b4 px-1 text-center">
              <span className="break-all text-[9px] font-semibold text-osu-f1">{flipped ? username : ""}</span>
            </div>
          )}
        </div>
      </div>

      {/* TierBurst animates in stage-sized pixels; the scale wrapper shrinks
          its whole coordinate space down to tile scale. */}
      {landed && !reducedMotion && entry?.tier && entry.glowColor && (
        <div className="pointer-events-none absolute inset-0" style={{ transform: "scale(0.5)" }}>
          {entry.tier === "goat"
            ? <GoatBurst glowColor={entry.glowColor} />
            : <TierBurst tier={entry.tier} glowColor={entry.glowColor} />}
        </div>
      )}
    </div>
  );
}

export function RevealStage({ cards, reducedMotion, onCardRevealed, onComplete }: RevealStageProps) {
  const windowActive = useWindowActive();
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
  /* Reveal-all row geometry; null while revealing one by one. scaleFrom is
     the stack-to-tile size ratio so the deal starts at full stack size. */
  const [cascade, setCascade] = useState<
    { start: number; slotWidth: number; scaleFrom: number; rows: number[] } | null
  >(null);
  /* Cascade positions whose flip has landed (chime fired, burst showing). */
  const [cascadeLanded, setCascadeLanded] = useState<number[]>([]);
  /* Cascade positions whose face has swung into view (what the counter counts). */
  const [cascadeFacesUp, setCascadeFacesUp] = useState<number[]>([]);
  const [flight, setFlight] = useState<CardFlight | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const trayRef = useRef<HTMLDivElement | null>(null);
  const cascadeRef = useRef<HTMLDivElement | null>(null);

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
    const backCanvas = getCachedCardBackCanvas();
    backCanvasRef.current = backCanvas;
    setCardBack(getCachedCardBackDataUrl());
    return () => {
      cancelledRef.current = true;
      rendererRef.current?.dispose({ deferGpuRelease: true });
      rendererRef.current = null;
    };
  }, []);

  // Warm the avatar cache while the cards are still face-down: the texture
  // pipeline fetches each avatar on first draw, and a fresh pack is mostly
  // new players. Same crossOrigin mode as the texture loader so the cached
  // response stays reusable for canvas work.
  useEffect(() => {
    for (const card of cards) {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.referrerPolicy = "no-referrer";
      image.src = maniaCardAvatarUrl(card.player.user);
    }
  }, [cards]);

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
      // Watchdog against a renderer that never fires onReady/onError (lost
      // GPU context, backgrounded rAF): reject so reveal()'s catch drops to the
      // 2D fallback instead of leaving the phase stuck on "preparing".
      let settled = false;
      const readyTimer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Card renderer timed out."));
      }, RENDERER_READY_TIMEOUT_MS);
      onReadyRef.current = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(readyTimer);
        resolve();
      };
      onErrorRef.current = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(readyTimer);
        reject(error);
      };
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

  const recordRevealed = (
    position: number,
    entry: Omit<RevealedCard, "isNew" | "skills">,
    skills: ManiaSkills | null,
  ) => {
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
    const next = revealedRef.current.slice();
    next[position] = { ...entry, skills, isNew };
    revealedRef.current = next;
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

    const scores = await resolveCardScores(card);
    if (cancelledRef.current) return;

    if (scores === null) {
      recordRevealed(position, { player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null }, null);
      setActiveData(null);
      setActiveFallback(null);
      setMintFailure("fetch");
      setPhase("shown");
      return;
    }

    const data = buildManiaCardRenderData({ user: card.player.user, scores });

    if (data.status !== "ready") {
      recordRevealed(position, { player: card.player, tier: null, tierLabel: null, glowColor: null, thumbnail: null }, null);
      setActiveData(null);
      setActiveFallback(null);
      setMintFailure("no-data");
      setPhase("shown");
      return;
    }

    recordRevealed(
      position,
      {
        player: card.player,
        tier: data.tier,
        tierLabel: data.tierStyle.label,
        glowColor: data.glowColor,
        thumbnail: null,
      },
      data.skills,
    );
    const cardIndex = position;

    try {
      await ensureRendererReady(data);
      if (cancelledRef.current) return;
      // PNG encoding is synchronous. Snapshot while the UI is still in its
      // preparing beat so the reveal flip and tier landing stay animation-only.
      const thumbnail = rendererRef.current?.snapshotFrontCanvas(COLLECTION_CARD_THUMB_WIDTH) ?? null;
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
      if (thumbnail) {
        updateThumbnail(cardIndex, thumbnail);
        void rememberCardThumbnailDataUrl(data, thumbnail, COLLECTION_CARD_THUMB_WIDTH);
      }
      setPhase("shown");
      if (!reducedMotion) setBurst({ key: position, tier: data.tier, glowColor: data.glowColor });
      if (data.tier === "goat") playGoatFanfare();
      else playRevealChime(tierRank(data.tier) / 8, revealedRef.current[cardIndex]?.isNew ?? false);
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
      if (data.tier === "goat") playGoatFanfare();
      else playRevealChime(tierRank(data.tier) / 8, revealedRef.current[cardIndex]?.isNew ?? false);
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
  // Both rects convert into the root's space here (captured and measured
  // within one frame, so they share one scroll position): the overlay
  // positions absolute in the root rather than fixed, so a scroll during
  // the flight carries it along with the tray instead of leaving it pinned
  // to the viewport.
  useLayoutEffect(() => {
    if (!flight || flight.to) return;
    const tile = trayRef.current?.querySelector(`[data-tray-index="${flight.cardIndex}"]`);
    const rootRect = rootRef.current?.getBoundingClientRect();
    if (!(tile instanceof HTMLElement) || !rootRect) {
      setFlight(null);
      return;
    }
    const rect = tile.getBoundingClientRect();
    setFlight({
      ...flight,
      from: {
        left: flight.from.left - rootRect.left,
        top: flight.from.top - rootRect.top,
        width: flight.from.width,
        height: flight.from.height,
      },
      to: {
        left: rect.left - rootRect.left,
        top: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height,
      },
    });
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

  /* Viewport rects of every on-screen card tile (tray thumbnails and cascade
     slots), for the summary handoff. Transforms are settled by the time this
     runs, so the rects are where the eye last saw each card. */
  const collectHandoffRects = (): Map<number, FlightRect> => {
    const sourceRects = new Map<number, FlightRect>();
    const collect = (root: HTMLElement | null, attribute: string) => {
      if (!root) return;
      root.querySelectorAll(`[${attribute}]`).forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        const position = Number(el.getAttribute(attribute));
        if (!Number.isFinite(position)) return;
        const rect = el.getBoundingClientRect();
        sourceRects.set(position, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      });
    };
    collect(trayRef.current, "data-tray-index");
    collect(cascadeRef.current, "data-cascade-index");
    return sourceRects;
  };

  const handleCascadeFaceVisible = (position: number) => {
    setCascadeFacesUp((current) => (current.includes(position) ? current : [...current, position]));
  };

  const handleCascadeLanded = (position: number) => {
    setCascadeLanded((current) => (current.includes(position) ? current : [...current, position]));
    const entry = revealedRef.current[position];
    if (!entry || entry.tier === null) return;
    if (entry.tier === "goat") playGoatFanfare();
    else playRevealChime(tierRank(entry.tier) / 8, entry.isNew);
  };

  // Resolves every remaining card without the one-by-one ceremony: the
  // remaining backs deal out of the stack into a row, and each tile flips
  // the moment its data lands. High tiers keep their held moment.
  const revealRest = async () => {
    if (skipping || phaseRef.current === "preparing" || phaseRef.current === "flipping") return;
    setSkipping(true);
    playCardDraw();
    const startAt = phaseRef.current === "shown" ? index + 1 : index;

    // No flight for a card still shown on the canvas: the stage compresses
    // while the backs deal out, so the tray is a moving target the flight
    // overlay would miss. Its tile simply joins the tray.
    setBurst(null);
    setActiveData(null);
    setActiveFallback(null);
    setMintFailure(null);
    setPhase("stack");
    /* The cascade never puts the canvas card back up, and on desktop the
       hidden renderer would keep drawing full-shader frames behind the deal
       for its whole run (idleMotion "continuous" ignores opacity 0). */
    rendererRef.current?.dispose({ deferGpuRelease: true });
    rendererRef.current = null;

    if (startAt >= cards.length) {
      onComplete(revealedRef.current, { sourceRects: collectHandoffRects() });
      return;
    }

    const count = cards.length - startAt;
    const stageRect = hostRef.current?.getBoundingClientRect();
    const stageWidth = stageRect?.width ?? 340;
    const stageHeight = stageRect?.height ?? (stageWidth * 7) / 5;
    const rowWidth = Math.min(
      CASCADE_MAX_ROW_WIDTH,
      typeof window !== "undefined" ? window.innerWidth * 0.94 : CASCADE_MAX_ROW_WIDTH,
    );
    const { rows, slotWidth } = cascadeLayout(
      count,
      rowWidth,
      Math.max(stageHeight - CASCADE_STAGE_PADDING, 120),
    );
    setCascade({ start: startAt, slotWidth, scaleFrom: (stageWidth * STACK_CARD_SCALE) / slotWidth, rows });

    // Flips wait for the deal-out to finish; the data fetches keep running
    // underneath it. After that, each flip waits only for its data, with a
    // minimum gap so hot data still cascades.
    const dealMs = reducedMotion ? 0 : 300 + count * 60;
    let nextFlipAt = performance.now() + dealMs;

    // Each card runs its whole pipeline (scores, then thumbnail render) in its
    // own chain, so no card's work waits on another's; rendering used to
    // happen serially between flips, which stacked avatar fetch + canvas +
    // WebP encode on top of the flip gap and made prod packs crawl. The flip
    // loop itself walks the row in position order: a reveal that jumps around
    // the grid reads as broken, so a cold card holds the line at its slot and
    // the cards behind it (already prepared) catch up at the normal gap.
    //
    // The paints themselves take turns, and none may start until the deal-out
    // has finished: each is a big synchronous canvas job, and on phones the
    // batch used to freeze the rAF-driven deal mid-flight - giant half-dealt
    // backs parked over the bottom row, hiding its tiles for a second or
    // more. Only the paint+encode is held back; the score fetches (the slow,
    // network-bound part) all run at once from the start, and the avatars
    // were warmed when the stack mounted.
    let lastPaint: Promise<void> =
      dealMs > 0
        ? new Promise((resolve) => setTimeout(resolve, dealMs + 150))
        : Promise.resolve();
    const queuePaint = <T,>(work: () => Promise<T>): Promise<T> => {
      const run = lastPaint.then(work);
      lastPaint = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const prepareCard = async (position: number) => {
      const card = cards[position];
      const scores = await resolveCardScores(card);
      let entry: Omit<RevealedCard, "isNew" | "skills"> = {
        player: card.player,
        tier: null,
        tierLabel: null,
        glowColor: null,
        thumbnail: null,
      };
      let skills: ManiaSkills | null = null;
      if (scores !== null && !cancelledRef.current) {
        const data = buildManiaCardRenderData({ user: card.player.user, scores });
        if (data.status === "ready") {
          let thumbnail: string | null = null;
          try {
            thumbnail = await queuePaint(() => renderCardThumbnail(data, COLLECTION_CARD_THUMB_WIDTH));
            void rememberCardThumbnailDataUrl(data, thumbnail, COLLECTION_CARD_THUMB_WIDTH);
          } catch {
            thumbnail = null;
          }
          if (thumbnail) {
            /* The flip mounts the face <img> the same instant this card's data
               lands, and an undecoded WebP paints as a blank tile for the
               first frames of the turn. Decode it into the image cache now so
               the face is there the moment it swings past edge-on. */
            const face = new Image();
            face.src = thumbnail;
            if (typeof face.decode === "function") await face.decode().catch(() => undefined);
          }
          entry = {
            player: card.player,
            tier: data.tier,
            tierLabel: data.tierStyle.label,
            glowColor: data.glowColor,
            thumbnail,
          };
          skills = data.skills;
        }
      }
      return { position, entry, skills };
    };

    const prepared: Array<ReturnType<typeof prepareCard>> = [];
    for (let position = startAt; position < cards.length; position += 1) {
      prepared.push(prepareCard(position));
    }

    for (const promise of prepared) {
      const { position, entry, skills } = await promise;
      if (cancelledRef.current) return;

      const holdMs = nextFlipAt - performance.now();
      if (holdMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        if (cancelledRef.current) return;
      }
      recordRevealed(position, entry, skills);
      nextFlipAt = performance.now() + (reducedMotion ? 0 : CASCADE_FLIP_GAP_MS);
    }
    if (cancelledRef.current) return;
    // A beat so the last flip and its burst land before the summary. The
    // cascade already showed every card, so instead of fading the grid out
    // and staggering it back in, the summary takes over in place and flies
    // each tile from the rect it occupies right now.
    await new Promise((resolve) => setTimeout(resolve, reducedMotion ? 150 : 700));
    if (!cancelledRef.current) onComplete(revealedRef.current, { sourceRects: collectHandoffRects() });
  };

  // While the active card is on the canvas, its DOM back leaves the stack.
  const firstBackCardIndex = phase === "flipping" || phase === "shown" ? index + 1 : index;
  const remainingBacks = Math.max(0, cards.length - firstBackCardIndex);

  /* Without activeData there is nothing valid on the canvas; keeping it
     visible would show the previous card's face behind a failure overlay. */
  const showCanvas = (phase === "flipping" || phase === "shown") && !activeFallback && activeData !== null;
  const current = revealed[index] ?? null;
  /* While the cascade runs, cards from `start` on live in the dealt-out row,
     not the tray; only the ones revealed before the skip stay below. */
  const trayEntries = revealed.slice(0, skipping ? (cascade?.start ?? revealed.length) : index);
  /* Cards showing their face during the cascade: the ones revealed before the
     skip plus the flips past edge-on. Counting recorded data instead would
     run a whole flip ahead, since recording the data is what starts the flip,
     and the last card would already read 5/5 while still face-down. */
  const cascadeShown = (cascade?.start ?? 0) + cascadeFacesUp.length;
  /* Deal order to grid slot: rows fill in order, and each row centers on its
     own width, so a short last row sits under the middle of the one above. */
  const cascadePlacements = (cascade?.rows ?? []).flatMap((rowLength, row) =>
    Array.from({ length: rowLength }, (_, column) => ({ row, column, rowLength })),
  );
  const tierColor = current?.glowColor
    ? `rgb(${current.glowColor.r}, ${current.glowColor.g}, ${current.glowColor.b})`
    : "rgb(226, 232, 240)";

  return (
    <div ref={rootRef} className="relative flex flex-col items-center">
      <div className="flex items-baseline gap-1.5 tabular-nums">
        {/* During the cascade the counter runs with the flips as they land. */}
        <span className="text-lg font-black leading-none text-white">
          {skipping ? Math.max(1, cascadeShown) : Math.min(index + 1, cards.length)}
        </span>
        <span className="text-[12px] text-osu-f1">/ {cards.length}</span>
      </div>

      {/* The stage holds the stack's 5/7 footprint while revealing one by
          one; during the cascade it compresses to the dealt row's height so
          the caption and tray pull up instead of orbiting an empty box.
          Inline height wins over aspect-ratio once the animation sets it. */}
      <motion.div
        className="relative mt-4 w-[min(340px,84vw)]"
        style={{ aspectRatio: "5 / 7" }}
        initial={false}
        animate={
          cascade
            ? {
                height:
                  cascade.rows.length * ((cascade.slotWidth * 7) / 5 + CASCADE_GAP) -
                  CASCADE_GAP +
                  CASCADE_STAGE_PADDING,
              }
            : {}
        }
        transition={{ duration: reducedMotion ? 0 : 0.45, ease: [0.3, 0.7, 0.2, 1] }}
      >
        {/* Face-down stack (the cascade row replaces it while skipping) */}
        {cardBack &&
          !cascade &&
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
                    // Only the top card casts the big drop shadow; the buried
                    // cards overlap almost fully, so per-card shadows compound
                    // into an opaque blob under the fan. Tight rim only.
                    boxShadow: isTop ? "0 14px 36px rgba(0,0,0,0.5)" : "0 2px 6px rgba(0,0,0,0.35)",
                    zIndex: 10 - position,
                    willChange: "transform",
                    backfaceVisibility: "hidden",
                  }}
                  animate={{
                    x: position * 7,
                    y: position * 1,
                    rotate: position * 0.9,
                    scale:
                      isTop && phase === "preparing" && !reducedMotion && windowActive
                        ? [STACK_CARD_SCALE, STACK_CARD_SCALE * 1.025, STACK_CARD_SCALE]
                        : STACK_CARD_SCALE,
                  }}
                  transition={
                    isTop && phase === "preparing" && !reducedMotion && windowActive
                      ? { scale: { duration: 0.9, repeat: Infinity, ease: "easeInOut" }, default: { duration: 0.25 } }
                      : { duration: 0.25 }
                  }
                />
              );
            })}

        {/* Reveal-all cascade: the remaining backs deal out of the stack into
            centered rows, each starting at full stack size and shrinking
            into its slot, then flipping in place as its data lands. */}
        {cascade && cardBack && (
          <div ref={cascadeRef} className="absolute inset-0" style={{ zIndex: 15 }}>
            {cascadePlacements.map(({ row, column, rowLength }, slot) => {
              const position = cascade.start + slot;
              const count = cascadePlacements.length;
              const rowCount = cascade.rows.length;
              const slotHeight = (cascade.slotWidth * 7) / 5;
              const targetX = (column - (rowLength - 1) / 2) * (cascade.slotWidth + CASCADE_GAP);
              const targetY = (row - (rowCount - 1) / 2) * (slotHeight + CASCADE_GAP);
              return (
                <motion.div
                  key={position}
                  data-cascade-index={position}
                  className="absolute left-1/2 top-1/2"
                  style={{
                    width: cascade.slotWidth,
                    height: slotHeight,
                    marginLeft: -cascade.slotWidth / 2,
                    marginTop: -slotHeight / 2,
                    // Top of the old stack deals first and stays above the
                    // cards still waiting their turn.
                    zIndex: count - slot,
                    willChange: "transform",
                  }}
                  // Initial transform mirrors the card's spot in the stack
                  // (same fanned offsets), so the deal visibly pulls each
                  // back out of the pile.
                  initial={
                    reducedMotion
                      ? false
                      : { x: slot * 7, y: slot * 1, rotate: slot * 0.9, scale: cascade.scaleFrom }
                  }
                  animate={{ x: targetX, y: targetY, rotate: 0, scale: 1 }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { delay: 0.05 + slot * 0.06, duration: 0.4, ease: [0.3, 0.7, 0.2, 1] }
                  }
                >
                  <CascadeTile
                    entry={revealed[position]}
                    username={cards[position]?.player.user.username ?? ""}
                    cardBack={cardBack}
                    landed={cascadeLanded.includes(position)}
                    reducedMotion={reducedMotion}
                    onLanded={() => handleCascadeLanded(position)}
                    onFaceVisible={() => handleCascadeFaceVisible(position)}
                  />
                </motion.div>
              );
            })}
          </div>
        )}

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

        {burst && (burst.tier === "goat"
          ? <GoatBurst key={burst.key} glowColor={burst.glowColor} />
          : <TierBurst key={burst.key} tier={burst.tier} glowColor={burst.glowColor} />)}
      </motion.div>

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
                  className="h-7 w-7 rounded-full object-cover"
                  draggable={false}
                />
                <span className="text-lg font-bold text-white">{current.player.user.username}</span>
                <CountryFlag code={current.player.user.country_code} size="sm" decorative />
              </Link>
              <div className="mt-1 flex items-center justify-center gap-2.5 text-[12px]">
                {/* Solid, not a tinted whisper: a card the collection has
                    never held is the thing worth noticing in this row. */}
                {current.isNew && (
                  <span className="rounded bg-osu-pink px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-white">
                    new
                  </span>
                )}
                {current.tierLabel && (
                  <span className="text-[13px] font-black uppercase tracking-wide" style={{ color: tierColor }}>
                    {current.tierLabel}
                  </span>
                )}
                {/* Honorary cards can carry no known rank or pp (accounts wiped
                    or deleted before the stats existed); an invented "#10,000
                    0pp" reads as real data, so show nothing instead. */}
                {current.player.user.statistics.global_rank !== null && (
                  <span className="text-osu-f1 tabular-nums">#{current.player.globalRank.toLocaleString()}</span>
                )}
                {current.player.pp > 0 && (
                  <span className="text-osu-f1 tabular-nums">{Math.round(current.player.pp).toLocaleString()}pp</span>
                )}
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

      {/* Tray of already revealed cards. Cut by index rather than by
          dropping the last entry: the in-progress card is recorded before
          its flip finishes, and letting that entry join the centered row
          mid-flight shifts every tile sideways, so the flying card would
          land beside its slot. While skipping, entries show as they land. */}
      {trayEntries.length > 0 && (
        <div ref={trayRef} className="mt-6 flex items-center justify-center gap-2">
          {trayEntries.map((entry, position) => (
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
      )}
    </div>
  );
}
