import { memo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import type { ManiaCardTier, ManiaSkills } from "#/lib/maniacard";
import type { RunEdition } from "#/lib/pack-run";
import { COLLECTION_CARD_THUMB_WIDTH, rememberCardThumbnailDataUrl } from "../cardThumbnailCache";
import { renderCardThumbnail } from "../cardSnapshot";
import { CollectionCardFacePlaceholder } from "../CardTile";
import { buildPackCardRenderData, resolveCardScores, type PackCardState, type RevealedCard } from "../RevealStage";
import { EditionSheen } from "./EditionSheen";
import { RUN_FEEL } from "./runFeel";
import { runSound } from "./runSound";

/* One dealt card in the run's hand, as the table draws it. */
export interface RunHandCard {
  key: string;
  thumbnail: string | null;
  tier: ManiaCardTier | null;
  edition: RunEdition | null;
  faceUp: boolean;
}

/* Where a card sits in the fanned hand, relative to the hand's centre top. */
export interface RunCardSlot {
  x: number;
  y: number;
  rotate: number;
}

export interface RunPreparedCard {
  entry: Omit<RevealedCard, "isNew" | "skills">;
  skills: ManiaSkills | null;
}

/* The face a dealt card turns over to: the flat thumbnail the collection grid
   draws (the same render pipeline the reveal's cascade uses), from the
   player's plays. `queuePaint` serializes the canvas work so two cards never
   paint in the same frame as the deal. A card whose plays or avatar will not
   load still turns, on its tier's sketch face. */
export async function prepareRunCard(
  card: PackCardState,
  queuePaint: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<RunPreparedCard> {
  const scores = await resolveCardScores(card);
  let entry: RunPreparedCard["entry"] = {
    player: card.player,
    tier: null,
    tierLabel: null,
    glowColor: null,
    thumbnail: null,
  };
  let skills: ManiaSkills | null = null;
  if (scores !== null || card.player.eternal) {
    const data = buildPackCardRenderData(card.player, scores ?? []);
    if (data.status === "ready") {
      let thumbnail: string | null = null;
      try {
        thumbnail = await queuePaint(() => renderCardThumbnail(data, COLLECTION_CARD_THUMB_WIDTH));
        void rememberCardThumbnailDataUrl(data, thumbnail, COLLECTION_CARD_THUMB_WIDTH);
      } catch {
        thumbnail = null;
      }
      if (thumbnail) await decodeImage(thumbnail);
      entry = { player: card.player, tier: data.tier, tierLabel: data.tierStyle.label, glowColor: data.glowColor, thumbnail };
      skills = data.skills;
    }
  }
  return { entry, skills };
}

/* An undecoded WebP paints blank for the first frames of a flip. */
export async function decodeImage(src: string): Promise<void> {
  if (typeof Image === "undefined") return;
  const image = new Image();
  image.src = src;
  if (typeof image.decode === "function") await image.decode().catch(() => undefined);
}

interface RunCardProps {
  card: RunHandCard;
  index: number;
  width: number;
  slot: RunCardSlot;
  /* Start offset for the deal (the pack's mouth, relative to the slot's
     origin), or null for a card that is already in hand. */
  dealFrom: { x: number; y: number } | null;
  dealDelayMs: number;
  zIndex: number;
  backUrl: string | null;
  reducedMotion: boolean;
  /* Touch screens: the card a tap lifted. */
  lifted: boolean;
  onHover: (index: number, hovering: boolean) => void;
  onTap: (index: number) => void;
  elementRef: (index: number, element: HTMLDivElement | null) => void;
}

const SWAY = RUN_FEEL.sway;
const HOVER = RUN_FEEL.hover;

/* The idle sway (feel §6): a rotation on one clock and a bob on a slower
   one, each phased by the card's place in the row so the hand ripples. */
export function swayStyle(index: number, height: number, reducedMotion: boolean): CSSProperties {
  if (reducedMotion) return {};
  const phase = (index * SWAY.phaseStep) % 1;
  return {
    animationDuration: `${SWAY.rotatePeriodMs}ms, ${SWAY.bobPeriodMs}ms`,
    animationDelay: `${-Math.round(SWAY.rotatePeriodMs * phase)}ms, ${-Math.round(SWAY.bobPeriodMs * phase)}ms`,
    ["--sway-r" as string]: `${SWAY.rotateDeg}deg`,
    ["--sway-y" as string]: `${Math.max(1, height * SWAY.bobFraction).toFixed(1)}px`,
  };
}

/* A card in the hand: dealt in from the pack on a spring that lands past its
   slot and settles back, turned over in sequence, swaying a little on its own
   clock, and tilting toward the pointer when hovered. Transforms only. */
export const RunCard = memo(function RunCard({
  card,
  index,
  width,
  slot,
  dealFrom,
  dealDelayMs,
  zIndex,
  backUrl,
  reducedMotion,
  lifted,
  onHover,
  onTap,
  elementRef,
}: RunCardProps) {
  const height = Math.round((width * 7) / 5);
  const [hovered, setHovered] = useState(false);
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, HOVER.tiltSpring);
  const springY = useSpring(pointerY, HOVER.tiltSpring);
  const rotateY = useTransform(springX, (value) => value * HOVER.tiltDeg * 2);
  const rotateX = useTransform(springY, (value) => -value * HOVER.tiltDeg * 2);
  const raised = hovered || lifted;

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" || reducedMotion) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
    pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
  };
  const onPointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    setHovered(true);
    onHover(index, true);
    runSound.hover();
  };
  const onPointerLeave = () => {
    setHovered(false);
    onHover(index, false);
    pointerX.set(0);
    pointerY.set(0);
  };

  const spin = (index % 2 === 0 ? -1 : 1) * RUN_FEEL.deal.flightSpinDeg;
  return (
    <motion.div
      ref={(element) => elementRef(index, element)}
      className="absolute left-1/2 top-0"
      style={{ width, height, marginLeft: -width / 2, zIndex }}
      initial={
        dealFrom && !reducedMotion
          ? { x: dealFrom.x, y: dealFrom.y, rotate: spin, scale: RUN_FEEL.deal.startScale, opacity: 0 }
          : false
      }
      animate={{ x: slot.x, y: slot.y, rotate: slot.rotate, scale: 1, opacity: 1 }}
      exit={
        reducedMotion
          ? { opacity: 0, transition: { duration: 0.12 } }
          : {
              y: slot.y + RUN_FEEL.discard.dropPx,
              rotate: slot.rotate + spin,
              opacity: 0,
              transition: {
                duration: RUN_FEEL.discard.durationMs / 1000,
                delay: (index * RUN_FEEL.discard.staggerMs) / 1000,
                ease: [0.5, 0, 0.75, 0],
              },
            }
      }
      transition={{
        ...RUN_FEEL.deal.spring,
        delay: dealFrom ? dealDelayMs / 1000 : 0,
        opacity: { duration: 0.06, delay: dealFrom ? dealDelayMs / 1000 : 0 },
      }}
    >
      <div className="run-card-sway relative h-full w-full" style={swayStyle(index, height, reducedMotion)}>
        {/* The scoring sequence wobbles this layer when the card fires
            (runJuice.ts), clear of the springs above and below it. The
            shadow rides inside it, so a squash never bares it. */}
        <div data-run-juice="" className="relative h-full w-full">
        {/* A flat shadow on the felt; the card lifts off it when raised. */}
        <div className="absolute inset-0 translate-x-[3px] translate-y-[7px] rounded-[10px] bg-black/45" />
        <motion.div
          className="relative h-full w-full cursor-pointer touch-manipulation"
          style={{ rotateX, rotateY, transformPerspective: HOVER.perspectivePx }}
          animate={{
            y: raised ? -height * (lifted ? HOVER.tapLiftFraction : HOVER.liftFraction) : 0,
            scale: raised ? HOVER.scale : 1,
          }}
          transition={RUN_FEEL.deal.spring}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onPointerMove={onPointerMove}
          onPointerDown={(event) => {
            if (event.pointerType === "touch") onTap(index);
          }}
        >
          <motion.div
            className="relative h-full w-full"
            style={{ transformStyle: "preserve-3d", transformPerspective: HOVER.perspectivePx }}
            initial={false}
            animate={{
              rotateY: card.faceUp ? 0 : 180,
              y: card.faceUp && !reducedMotion ? [0, -RUN_FEEL.flip.liftPx, 0] : 0,
            }}
            transition={{
              duration: reducedMotion ? 0 : RUN_FEEL.flip.durationMs / 1000,
              ease: [...RUN_FEEL.flip.ease] as [number, number, number, number],
            }}
          >
            <div className="absolute inset-0 overflow-hidden rounded-[10px]" style={{ backfaceVisibility: "hidden" }}>
              {card.thumbnail ? (
                <img src={card.thumbnail} alt="" draggable={false} className="h-full w-full object-cover" />
              ) : (
                <CollectionCardFacePlaceholder tier={card.tier} />
              )}
              <EditionSheen edition={card.edition} />
            </div>
            <div
              className="absolute inset-0 overflow-hidden rounded-[10px] bg-osu-b4"
              style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
            >
              {backUrl && <img src={backUrl} alt="" draggable={false} className="h-full w-full object-cover" />}
            </div>
          </motion.div>
        </motion.div>
        </div>
      </div>
    </motion.div>
  );
});
