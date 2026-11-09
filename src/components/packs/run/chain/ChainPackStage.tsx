import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  chainCardColor,
  CHAIN_TIERS,
  chainRecycleValue,
  type ChainCard,
  type ChainOffer,
  type ChainPackReason,
} from "#/lib/chain-run";
import { PACK_TYPES, type PackTypeId } from "#/lib/packs";
import type { SupporterBladeId } from "#/lib/supporter-pack-style";
import { PACK_ASPECT, PACK_TEAR_FRACTION } from "../../packArt";
import { PackStage } from "../../PackStage";
import { RUN_FEEL } from "../runFeel";
import type { PackLook } from "../RunTable";
import { ChainPack } from "./ChainPack";
import { crispPackUrl } from "./packArtCrisp";
import { runSound } from "../runSound";
import { useShudder } from "../shopMotion";
import { ChainCardFace } from "./ChainCardFace";
import { GoatBurst } from "../../GoatBurst";
import { EternalBurst } from "../../EternalBurst";
import { playEternalFanfare, playGoatFanfare, prefetchEternalFanfare } from "../../packSfx";
import { useChainDetailsTrigger } from "./ChainDetails";
import { CHAIN_FEEL } from "./chainFeel";
import type { BoardLayout } from "./chainLayout";
import { chainPackArtAccent, useChainPackArt, useChainPackStyle, type ChainPackArt } from "./chainPackArt";

/* A GOAT's flip: the biggest ceremony on the stage, with the maniacard GOAT's glow. */
const GOAT_CEREMONY = 8;
const GOAT_GLOW = { r: 245, g: 158, b: 11, a: 0.46 };
/* An Eternal turns after everything, a GOAT included, with the real packs'
   Eternal burst and fanfare. */
const ETERNAL_CEREMONY = 9;
const ETERNAL_GLOW = { r: 168, g: 85, b: 247, a: 0.52 };

/* Which wrapper a chain pack wears: the site's pack art, by kind. */
export function chainPackType(reason: ChainPackReason, offer?: Pick<ChainOffer, "kind"> | null): PackTypeId {
  if (reason !== "shop" || !offer) return "standard";
  if (offer.kind === "country") return "wild";
  if (offer.kind === "skill") return "elite";
  if (offer.kind === "key") return "7k";
  if (offer.kind === "big") return "legend";
  return "standard";
}

export interface PackKeepOutcome {
  kept: number[];
  recycled: number[];
  gained: number;
}

export interface ChainPackStageProps {
  layout: BoardLayout;
  title: string;
  packType: PackTypeId;
  packThumb: string | null;
  /* The run's own wrapper (what the pack deals, a country pack's flag). */
  art?: ChainPackArt | null;
  /* "keep": pick `keep` of the cards, the rest recycle. "join": the cards are
     this round's pack and go to the hand once they have turned over. */
  mode: "keep" | "join";
  sealed: boolean;
  /* Known cards (an open pack, or a round pack); null until opened. */
  cards: ChainCard[] | null;
  keep: number;
  backUrl: string | null;
  reducedMotion: boolean;
  /* Deck size shown on the pile the kept cards fly to. */
  deckCount: number;
  onOpen: () => Promise<ChainCard[] | null>;
  onKeep: (ids: number[]) => Promise<PackKeepOutcome | null>;
  /* join: the cards' rects (viewport), by index, as they leave for the hand. */
  onJoin: (rects: DOMRect[]) => void;
  /* keep: the kept cards have left and the shards are counted. */
  onKept: () => void;
  onShards: (delta: number) => void;
  shake: (amount: number) => void;
  /* Dev fixtures: open and pick on their own. */
  auto?: boolean;
  /* Tear as soon as it lands (a pack just bought). */
  autoTear?: boolean;
  /* An open pack whose cards were already seen (the round's, back for the
     keep): shown face up at once, no deal. */
  instant?: boolean;
  /* The deck so far, shown small while picking, so picks can be made for
     links. */
  deckCards?: ChainCard[];
  /* A later pack in a series (starting packs 2 and 3): a shorter build-up. */
  quick?: boolean;
  /* The table draws the title (one at a time across surfaces). */
  showTitle?: boolean;
  onStageChange?: (stage: StageName) => void;
  /* The viewer's own blade (a supporter's pick), for the cut. */
  blade?: SupporterBladeId | null;
}

export type StageName = "sealed" | "charging" | "dealing" | "flipping" | "open" | "leaving" | "gone";

interface Spread {
  w: number;
  h: number;
  spots: Array<{ x: number; y: number }>;
  captionH: number;
}

/* Five cards laid out in the stage: one line on a wide board, 3 + 2 on a
   narrow one, centred a little above the middle. */
function spreadOf(layout: BoardLayout, count: number): Spread {
  const narrow = layout.narrow;
  const captionH = narrow ? 6 : 10;
  const cols = narrow ? Math.min(3, count) : count;
  const lines = Math.ceil(count / cols);
  const gap = narrow ? 10 : 22;
  const maxH = (layout.height * (narrow ? 0.6 : 0.56)) / lines - captionH - gap;
  const w = Math.max(64, Math.min(narrow ? 116 : 188, (layout.width - 24 - gap * (cols - 1)) / cols, (maxH * 5) / 7));
  const h = (w * 7) / 5;
  const blockH = lines * (h + captionH) + (lines - 1) * gap;
  const top = Math.max(narrow ? 64 : 84, (layout.height - blockH) / 2 - (narrow ? 0 : 20));
  const spots = Array.from({ length: count }, (_, index) => {
    const line = Math.floor(index / cols);
    const inLine = Math.min(cols, count - line * cols);
    const col = index - line * cols;
    const lineW = inLine * w + (inLine - 1) * gap;
    return { x: (layout.width - lineW) / 2 + col * (w + gap), y: top + line * (h + captionH + gap) };
  });
  return { w, h, spots, captionH };
}

function StageCard({
  card,
  index,
  spread,
  from,
  faceUp,
  selected,
  kept,
  selectable,
  leaving,
  reducedMotion,
  backUrl,
  onTap,
  elementRef,
  shudderTick,
  tense,
  flashTick,
}: {
  shudderTick: number;
  tense: boolean;
  flashTick: number;
  card: ChainCard;
  index: number;
  spread: Spread;
  from: { x: number; y: number; scale: number } | null;
  faceUp: boolean;
  selected: boolean;
  /* Kept whatever is picked (an Eternal): ringed in its ink, not pickable. */
  kept: boolean;
  selectable: boolean;
  leaving: "kept" | "recycled" | "join" | null;
  reducedMotion: boolean;
  backUrl: string | null;
  onTap: () => void;
  elementRef: (element: HTMLDivElement | null) => void;
}) {
  const spot = spread.spots[index];
  const details = useChainDetailsTrigger(() => ({ kind: "card", entry: { uid: -1, card, pack: false } }), !faceUp);
  const [shudderX, shudder] = useShudder(reducedMotion);
  useEffect(() => {
    if (shudderTick) shudder();
  }, [shudder, shudderTick]);
  const spin = index % 2 === 0 ? -RUN_FEEL.deal.flightSpinDeg : RUN_FEEL.deal.flightSpinDeg;
  const lift = selected ? -CHAIN_FEEL.pack.keepLiftPx : 0;
  const target =
    leaving === "recycled"
      ? { x: spot.x, y: spot.y, scale: 0.6, rotate: spin, opacity: 0 }
      : { x: spot.x, y: spot.y + lift, scale: 1, rotate: 0, opacity: 1 };
  return (
    <motion.div
      ref={elementRef}
      className="absolute left-0 top-0"
      style={{ width: spread.w, height: spread.h + spread.captionH, zIndex: selected ? 20 : 10 + index }}
      initial={from && !reducedMotion ? { x: from.x, y: from.y, scale: from.scale, rotate: spin, opacity: 0 } : false}
      animate={target}
      transition={
        leaving === "recycled"
          ? { duration: 0.24, ease: [0.5, 0, 0.75, 0] }
          : { ...RUN_FEEL.deal.spring, delay: from ? (index * CHAIN_FEEL.pack.dealStaggerMs) / 1000 : 0, opacity: { duration: 0.06, delay: from ? (index * CHAIN_FEEL.pack.dealStaggerMs) / 1000 : 0 } }
      }
    >
      <motion.div
        style={{ x: shudderX }}
        animate={tense ? { rotate: [0, -2.5, 2.5, -2, 2, 0], scale: [1, 1.03, 1.03, 1.05, 1.05, 1.06] } : flashTick ? { rotate: 0, scale: [1.12, 0.97, 1] } : { rotate: 0, scale: 1 }}
        transition={tense ? { duration: 0.45, repeat: Infinity } : { duration: 0.42, ease: "easeOut" }}
      >
      <div className="run-card-sway relative" style={{ width: spread.w, height: spread.h }}>
        {/* A GOAT turns with the real packs' GOAT burst behind it. */}
        {card.goat && flashTick > 0 && !reducedMotion && (
          <div className="pointer-events-none absolute inset-0 z-[30]" style={{ transform: "scale(0.6)" }}>
            <GoatBurst key={flashTick} glowColor={GOAT_GLOW} />
          </div>
        )}
        {card.eternal && flashTick > 0 && !reducedMotion && (
          <>
            <div className="pointer-events-none absolute inset-0 -z-[1]" style={{ transform: "scale(0.7)" }}>
              <EternalBurst key={`behind-${flashTick}`} glowColor={ETERNAL_GLOW} layer="behind" />
            </div>
            <div className="pointer-events-none absolute inset-0 z-[30]" style={{ transform: "scale(0.7)" }}>
              <EternalBurst key={flashTick} glowColor={ETERNAL_GLOW} layer="front" />
            </div>
          </>
        )}
        <div className="absolute inset-0 translate-x-[3px] translate-y-[8px] rounded-[10px] bg-black/45" />
        <motion.div
          role="button"
          tabIndex={selectable ? 0 : -1}
          aria-pressed={selectable ? selected : undefined}
          aria-label={card.name}
          className={`relative h-full w-full ${selectable ? "cursor-pointer" : ""}`}
          style={{ transformStyle: "preserve-3d", transformPerspective: RUN_FEEL.hover.perspectivePx }}
          initial={false}
          animate={{ rotateY: faceUp ? 0 : 180, y: faceUp && !reducedMotion ? [0, -RUN_FEEL.flip.liftPx, 0] : 0 }}
          transition={{ duration: reducedMotion ? 0 : RUN_FEEL.flip.durationMs / 1000, ease: [...RUN_FEEL.flip.ease] as [number, number, number, number] }}
          whileHover={selectable && !reducedMotion ? { scale: 1.04 } : undefined}
          onPointerEnter={details.onPointerEnter}
          onPointerMove={details.onPointerMove}
          onPointerLeave={details.onPointerLeave}
          onPointerDown={details.onPointerDown}
          onPointerUp={details.onPointerUp}
          onClick={() => {
            if (details.consumeLongPress() || !selectable) return;
            onTap();
          }}
          onKeyDown={(event) => {
            if (!selectable || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            onTap();
          }}
        >
          <div className="absolute inset-0 overflow-hidden rounded-[10px]" style={{ backfaceVisibility: "hidden" }}>
            <ChainCardFace card={card} width={spread.w} />
            {flashTick > 0 && (
              <motion.div
                key={flashTick}
                className="pointer-events-none absolute inset-0 rounded-[10px]"
                style={{ background: chainCardColor(card).ink }}
                initial={{ opacity: 0.95 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            )}
          </div>
          <div className="absolute inset-0 overflow-hidden rounded-[10px] bg-osu-b4" style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}>
            {backUrl && <img src={backUrl} alt="" draggable={false} className="h-full w-full object-cover" />}
          </div>
        </motion.div>
        {kept && (
          <div className="pointer-events-none absolute -inset-[4px] rounded-[13px] border-[3px]" style={{ borderColor: chainCardColor(card).ink }} />
        )}
        {selected && (
          <>
            <div className="pointer-events-none absolute -inset-[4px] rounded-[13px] border-[3px] border-osu-pink" />
            <motion.div
              className="pointer-events-none absolute -right-2 -top-2 grid h-7 w-7 place-items-center rounded-full bg-osu-pink text-[#120f1a]"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 700, damping: 20 }}
            >
              <Check className="h-4 w-4" strokeWidth={3.5} />
            </motion.div>
          </>
        )}
      </div>
      </motion.div>
    </motion.div>
  );
}

interface Token {
  id: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  delayMs: number;
  value: number;
}

/* The pack as a moment: sealed in the middle, torn on a tap with the
   table's burst, its cards dealt out face down and turned over one by one
   to their real card faces. Then either a pick (keep N, the rest recycle into
   shards that fly to the counter) or, for a round pack, a flight into the
   hand. */
export function ChainPackStage(props: ChainPackStageProps) {
  const {
    layout,
    title,
    packType,
    packThumb,
    art = null,
    mode,
    sealed,
    cards: knownCards,
    keep,
    backUrl,
    reducedMotion,
    deckCount,
    onOpen,
    onKeep,
    onJoin,
    onKept,
    onShards,
    shake,
    auto = false,
    autoTear = false,
    instant = false,
    deckCards = [],
    quick = false,
    showTitle = true,
    onStageChange,
    blade = null,
  } = props;
  const { t } = useLingui();
  const [stage, setStageState] = useState<StageName>(sealed ? "sealed" : instant ? "open" : "dealing");
  const stageRef = useRef(stage);
  const setStage = useCallback(
    (next: StageName) => {
      stageRef.current = next;
      setStageState(next);
      onStageChange?.(next);
    },
    [onStageChange],
  );
  const [look, setLook] = useState<PackLook>("idle");
  const [sealedAtStart] = useState(sealed);
  const [cards, setCards] = useState<ChainCard[] | null>(sealed ? null : knownCards);
  const [faceUp, setFaceUp] = useState<boolean[]>(() => (instant && knownCards ? knownCards.map(() => true) : []));
  const [selected, setSelected] = useState<number[]>([]);
  const [leaving, setLeaving] = useState<Map<number, "kept" | "recycled" | "join">>(new Map());
  const [tokens, setTokens] = useState<Token[]>([]);
  const [shudders, setShudders] = useState<Record<number, number>>({});
  const [tense, setTense] = useState(-1);
  const [flash, setFlash] = useState<Record<number, number>>({});
  const [deckBump, setDeckBump] = useState(0);
  const [buttonShudderX, buttonShudder] = useShudder(reducedMotion);
  const packRef = useRef<HTMLElement | null>(null);
  /* The sealed pack is the site's 3D pack: it tilts under the pointer and
     opens to a blade across its perforation, or to a tap. `flat` is the
     stand-in where WebGL is missing. */
  const [flat, setFlat] = useState(false);
  const flatRef = useRef(flat);
  flatRef.current = flat;
  // Raised to have the 3D pack open itself (PackStage's openTick).
  const [openTick, setOpenTick] = useState(0);
  // A refused deal puts a fresh pack on the table.
  const [packEpoch, setPackEpoch] = useState(0);
  const dealRef = useRef<Promise<ChainCard[] | null> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const mountedRef = useRef(true);
  const startedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    onStageChange?.(stageRef.current);
    // Once, so the host knows where the stage starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const count = cards?.length ?? knownCards?.length ?? 5;
  const spread = useMemo(() => spreadOf(layout, Math.max(1, count)), [layout, count]);
  const packHeight = Math.max(150, Math.min(layout.height * 0.52, layout.narrow ? 260 : 340));
  /* A tap while the cards are dealing or turning finishes them at once. */
  const rushRef = useRef(false);
  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, reducedMotion || rushRef.current ? 0 : ms));

  /* Where the cards leave from: the pack's mouth, or the title when there
     is no pack on the table (an open pack coming back). */
  const dealFrom = useMemo(() => {
    const box = boxRef.current?.getBoundingClientRect();
    const pack = packRef.current?.getBoundingClientRect();
    if (box && pack && pack.width > 0) {
      return {
        x: pack.left + pack.width / 2 - box.left - spread.w / 2,
        y: pack.top + pack.height * (PACK_TEAR_FRACTION + 0.2) - box.top - spread.h / 2,
        scale: 0.5,
      };
    }
    return { x: layout.width / 2 - spread.w / 2, y: -spread.h * 0.6, scale: 0.6 };
    // Read when the cards arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, spread]);

  /* The round's own cards come back for the keep from the deck, face up. */
  const deckFrom = {
    x: layout.deck.x + layout.deck.w / 2 - spread.w / 2,
    y: layout.deck.y + layout.deck.h / 2 - spread.h / 2,
    scale: Math.max(0.15, layout.deck.w / spread.w),
  };

  const reveal = useCallback(
    async (dealt: ChainCard[]) => {
      setCards(dealt);
      if (instant) return;
      setFaceUp(dealt.map(() => false));
      setStage("dealing");
      const dealMs = (dealt.length - 1) * CHAIN_FEEL.pack.dealStaggerMs + RUN_FEEL.deal.settleMs;
      const landed = wait(dealMs);
      dealt.forEach((_, index) => window.setTimeout(() => mountedRef.current && runSound.deal(index), reducedMotion ? 0 : index * CHAIN_FEEL.pack.dealStaggerMs));
      window.setTimeout(() => mountedRef.current && setLook("gone"), reducedMotion ? 0 : dealMs * 0.6);
      await landed;
      await wait(RUN_FEEL.flip.leadMs);
      if (!mountedRef.current) return;
      setStage("flipping");
      /* Rarer cards turn with more ceremony, the rarest last: a longer,
         tenser hold, then a flash in the rarity's ink and a bigger sound. */
      // A GOAT ranks above World Class (6) and turns last.
      const rank = (card: ChainCard) => (card.eternal ? ETERNAL_CEREMONY : card.goat ? GOAT_CEREMONY : Math.max(0, CHAIN_TIERS.indexOf(card.tier) - 2));
      if (dealt.some((card) => card.eternal)) prefetchEternalFanfare();
      const order = dealt.map((_, index) => index);
      const best = order.reduce((top, index) => (rank(dealt[index]) > rank(dealt[top]) ? index : top), 0);
      if (rank(dealt[best]) > 0) order.push(...order.splice(order.indexOf(best), 1));
      for (const index of order) {
        const started = performance.now();
        if (!mountedRef.current) return;
        const ceremony = quick || rushRef.current || reducedMotion ? 0 : rank(dealt[index]);
        if (ceremony > 0) {
          setTense(index);
          await wait(ceremony >= GOAT_CEREMONY ? 1100 : Math.min(460, 80 + ceremony * 60));
          if (!mountedRef.current) return;
          setTense(-1);
        }
        setFaceUp((current) => current.map((value, position) => (position === index ? true : value)));
        if (!rushRef.current || index === dealt.length - 1) runSound.flip(index);
        if (ceremony > 0) {
          setFlash((current) => ({ ...current, [index]: (current[index] ?? 0) + 1 }));
          runSound.charmFire(ceremony * 3);
          if (ceremony >= 3) runSound.stepMultiplier(ceremony * 4);
          if (ceremony >= 5) runSound.fireIgnite();
          if (ceremony >= ETERNAL_CEREMONY) playEternalFanfare();
          else if (ceremony >= GOAT_CEREMONY) playGoatFanfare();
          shake(ceremony >= GOAT_CEREMONY ? 1.6 : Math.min(1.2, 0.15 + ceremony * 0.16));
        }
        const spent = performance.now() - started;
        // The GOAT burst runs about 2.5 s; the stage holds for most of it.
        const after = ceremony >= ETERNAL_CEREMONY ? 3600 : ceremony >= GOAT_CEREMONY ? 1800 : CHAIN_FEEL.pack.flipStaggerMs + ceremony * 50;
        await wait(Math.max(quick ? 20 : 40, (quick ? 40 : after) - spent));
      }
      await wait(RUN_FEEL.flip.durationMs + 60);
      rushRef.current = false;
      if (!mountedRef.current) return;
      setStage("open");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instant, reducedMotion, setStage, shake],
  );

  /* The 3D pack's cut has committed (a blade, a tap, or openTick): the deal
     starts under the rip. */
  const cut = useCallback(() => {
    if (stageRef.current !== "sealed") return;
    setStage("charging");
    setLook("charging");
    // A supporter's blade brings its own rip.
    if (!blade) runSound.packOpen();
    shake(RUN_FEEL.pack.burstShake);
    dealRef.current = Promise.resolve()
      .then(onOpen)
      .catch(() => null);
  }, [blade, onOpen, setStage, shake]);

  /* The rip has played: the cards come out, or the pack is refused. */
  const opened = useCallback(async () => {
    const dealt = await (dealRef.current ?? Promise.resolve(null));
    dealRef.current = null;
    if (!mountedRef.current) return;
    // The next pack on this stage starts sealed.
    setOpenTick(0);
    if (!dealt || dealt.length === 0) {
      setLook("idle");
      setStage("sealed");
      runSound.refuse();
      setPackEpoch((value) => value + 1);
      return;
    }
    setLook("torn");
    void reveal(dealt);
  }, [reveal, setStage]);

  const tear = useCallback(async () => {
    if (stageRef.current !== "sealed") return;
    if (!flatRef.current) {
      setOpenTick((value) => value + 1);
      return;
    }
    setStage("charging");
    setLook("charging");
    // The build: the pack shudders harder until it tears.
    const charge = wait(quick ? 360 : 800);
    let dealt: ChainCard[] | null = null;
    try {
      dealt = await onOpen();
    } catch {
      dealt = null;
    }
    await charge;
    if (!mountedRef.current) return;
    if (!dealt || dealt.length === 0) {
      setLook("idle");
      setStage("sealed");
      runSound.refuse();
      return;
    }
    setLook("torn");
    runSound.packOpen();
    shake(RUN_FEEL.pack.burstShake);
    await wait(RUN_FEEL.deal.leadMs);
    if (!mountedRef.current) return;
    void reveal(dealt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOpen, quick, reveal, setStage, shake]);

  /* An open pack (the round's, back for the keep) deals without a tear. */
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!sealed && knownCards) void reveal(knownCards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* join: once every card is up, they leave for the hand. */
  useEffect(() => {
    if (mode !== "join" || stage !== "open") return;
    const timer = window.setTimeout(() => {
      const rects = cardRefs.current.map((element) => element?.getBoundingClientRect() ?? new DOMRect());
      setStage("gone");
      onJoin(rects);
    }, reducedMotion ? 0 : CHAIN_FEEL.pack.joinHoldMs);
    return () => window.clearTimeout(timer);
  }, [mode, onJoin, reducedMotion, setStage, stage]);

  const selectedRef = useRef<number[]>([]);
  selectedRef.current = selected;
  const toggle = (index: number) => {
    if (stageRef.current !== "open" || mode !== "keep") return;
    // An Eternal is kept anyway; it is never one of the picks.
    if (cards?.[index]?.eternal) {
      setShudders((map) => ({ ...map, [index]: (map[index] ?? 0) + 1 }));
      return;
    }
    const current = selectedRef.current;
    let next: number[];
    if (current.includes(index)) next = current.filter((value) => value !== index);
    else if (keep === 1) next = [index];
    else if (current.length >= keep) {
      setShudders((map) => ({ ...map, [index]: (map[index] ?? 0) + 1 }));
      runSound.refuse();
      return;
    } else next = [...current, index];
    runSound.uiTap();
    selectedRef.current = next;
    setSelected(next);
  };

  const confirm = useCallback(async () => {
    if (stageRef.current !== "open" || !cards) return;
    if (selected.length !== Math.min(keep, cards.filter((card) => !card.eternal).length)) {
      buttonShudder();
      runSound.refuse();
      return;
    }
    setStage("leaving");
    runSound.buy();
    const ids = selected.map((index) => cards[index].id);
    const outcome = await onKeep(ids);
    if (!mountedRef.current) return;
    if (!outcome) {
      setStage("open");
      runSound.refuse();
      buttonShudder();
      return;
    }
    // The kept cards fly to the deck; the rest recycle into shards.
    const box = boxRef.current?.getBoundingClientRect();
    const shardsEl = [...document.querySelectorAll<HTMLElement>("[data-chain-shards]")].find((element) => element.offsetParent !== null);
    const shardsRect = shardsEl?.getBoundingClientRect();
    const next = new Map<number, "kept" | "recycled">();
    cards.forEach((card, index) => next.set(index, ids.includes(card.id) || card.eternal ? "kept" : "recycled"));
    setLeaving(next);
    runSound.sell();
    shake(0.35);
    const recycled = cards.map((card, index) => ({ card, index })).filter(({ card }) => !ids.includes(card.id) && !card.eternal);
    if (box && shardsRect) {
      const list: Token[] = [];
      let order = 0;
      for (const { card, index } of recycled) {
        const spot = spread.spots[index];
        const value = chainRecycleValue(card);
        for (let piece = 0; piece < value; piece += 1) {
          list.push({
            id: index * 10 + piece,
            from: { x: spot.x + spread.w / 2 + (piece - (value - 1) / 2) * 14, y: spot.y + spread.h / 2 },
            to: { x: shardsRect.left + shardsRect.width / 2 - box.left, y: shardsRect.top + shardsRect.height / 2 - box.top },
            delayMs: 160 + order * CHAIN_FEEL.pack.tokenStaggerMs,
            value: 1,
          });
          order += 1;
        }
      }
      setTokens(list);
      list.forEach((token, index) =>
        window.setTimeout(
          () => {
            if (!mountedRef.current) return;
            onShards(token.value);
            runSound.tallyLine(Math.min(6, index));
          },
          reducedMotion ? 0 : token.delayMs + CHAIN_FEEL.pack.tokenMs,
        ),
      );
      window.setTimeout(() => mountedRef.current && setDeckBump((value) => value + 1), reducedMotion ? 0 : CHAIN_FEEL.pack.keepFlyMs);
      await wait(CHAIN_FEEL.pack.keepFlyMs + CHAIN_FEEL.pack.afterKeepMs);
    } else {
      onShards(outcome.gained);
      await wait(CHAIN_FEEL.pack.afterKeepMs);
    }
    if (!mountedRef.current) return;
    setStage("gone");
    onKept();
  }, [buttonShudder, cards, keep, onKeep, onKept, onShards, reducedMotion, selected, setStage, shake, spread]);

  /* Dev fixtures: tear after a beat, pick the highest bases, confirm. */
  useEffect(() => {
    if (!auto && !(autoTear && stage === "sealed")) return;
    if (stage === "sealed") {
      // The 3D pack is seen sealed for a beat before it opens itself.
      const timer = window.setTimeout(() => void tear(), flat ? (autoTear ? 120 : 420) : quick ? 200 : 420);
      return () => window.clearTimeout(timer);
    }
    if (stage === "open" && mode === "keep" && cards) {
      const order = cards
        .map((card, index) => ({ card, index }))
        .filter(({ card }) => !card.eternal)
        .sort((a, b) => b.card.base - a.card.base);
      const picks = order.slice(0, keep).map((entry) => entry.index);
      const timers = picks.map((index, position) => window.setTimeout(() => toggle(index), 300 + position * 220));
      return () => timers.forEach((timer) => window.clearTimeout(timer));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, autoTear, flat, stage]);
  useEffect(() => {
    if (!auto || stage !== "open" || mode !== "keep" || !cards || selected.length !== Math.min(keep, cards.filter((card) => !card.eternal).length)) return;
    const timer = window.setTimeout(() => void confirm(), 320);
    return () => window.clearTimeout(timer);
  }, [auto, cards, confirm, keep, mode, selected.length, stage]);

  const artUrl = useChainPackArt(flat ? art : null);
  const packStyle = useChainPackStyle(art);
  const packTypeDef = PACK_TYPES.find((type) => type.id === packType);
  const accent = art ? chainPackArtAccent(art) : PACK_TYPES.find((type) => type.id === packType)?.accent ?? { r: 255, g: 102, b: 170 };
  // A country pack waits for its own wrapper rather than showing another's.
  const packArtUrl = artUrl ?? (art?.offer?.kind === "country" ? null : crispPackUrl(packType) ?? packThumb);
  // The pack stays on the table through the tear and the deal, after the
  // server has already opened it (its `sealed` flips on the answer).
  const showPack = stage === "sealed" || stage === "charging" || ((stage === "dealing" || stage === "flipping") && look !== "gone" && sealedAtStart);
  const deckRect = layout.deck;
  const pickable = stage === "open" && mode === "keep";
  const need = Math.min(keep, cards ? cards.filter((card) => !card.eternal).length : keep);

  return (
    <div
      ref={boxRef}
      className="absolute inset-0"
      onPointerDown={() => {
        if (stageRef.current === "dealing" || stageRef.current === "flipping") rushRef.current = true;
      }}
    >
      <AnimatePresence>
        {showTitle && stage !== "gone" && (
          <motion.div
            key="title"
            className="absolute inset-x-0 text-center"
            style={{ top: layout.narrow ? 14 : 26 }}
            initial={reducedMotion ? false : { opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <div className={`font-black italic uppercase leading-none ${layout.narrow ? "text-[22px]" : "text-[32px]"}`}>{title}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {showPack && flat && (
        <div className="absolute inset-0 grid place-items-center">
          <ChainPack
            thumb={packArtUrl}
            accent={accent}
            look={look}
            height={packHeight}
            chargeMs={quick ? 360 : 800}
            disabled={stage !== "sealed"}
            reducedMotion={reducedMotion}
            onOpen={() => void tear()}
            packRef={(element) => {
              packRef.current = element;
            }}
          />
        </div>
      )}
      {/* A country pack waits for its own wrapper rather than showing another's. */}
      {showPack && !flat && (packStyle || !art) && (
        <motion.div
          key={packEpoch}
          className="absolute inset-0"
          initial={reducedMotion ? false : { y: 70, opacity: 0, scale: 0.92 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 520, damping: 26 }}
        >
          <PackStage
            bare
            seamOnly
            tapToOpen
            width={Math.round(packHeight * PACK_ASPECT)}
            artStyle={packStyle ?? undefined}
            packType={packTypeDef}
            blade={blade}
            ripSound={blade !== null}
            openTick={openTick}
            openedAfterMs={quick ? 560 : undefined}
            reducedMotion={reducedMotion}
            onCut={cut}
            onOpened={() => void opened()}
            onUnavailable={() => setFlat(true)}
            hostRef={(element) => {
              packRef.current = element;
            }}
          />
          {/* The keyboard's way in; it shows when it has the focus. */}
          <button
            type="button"
            disabled={stage !== "sealed"}
            onClick={() => void tear()}
            className="sr-only rounded-full bg-osu-pink px-5 py-2 text-[14px] font-black text-[#120f1a] focus-visible:not-sr-only focus-visible:absolute focus-visible:bottom-6 focus-visible:left-1/2 focus-visible:-translate-x-1/2"
          >
            {t`Open the pack`}
          </button>
        </motion.div>
      )}

      {cards &&
        cards.map((card, index) => {
          const leave = leaving.get(index) ?? null;
          if (leave === "kept") {
            const spot = spread.spots[index];
            return (
              <motion.div
                key={`${card.id}-kept`}
                className="pointer-events-none absolute left-0 top-0"
                style={{ width: spread.w, height: spread.h, zIndex: 30 }}
                initial={{ x: spot.x, y: spot.y - CHAIN_FEEL.pack.keepLiftPx, scale: 1, rotate: 0, opacity: 1 }}
                animate={{
                  x: deckRect.x + deckRect.w / 2 - spread.w / 2,
                  y: deckRect.y + deckRect.h / 2 - spread.h / 2,
                  scale: deckRect.w / spread.w,
                  rotate: 8,
                  opacity: [1, 1, 0],
                }}
                transition={{ duration: CHAIN_FEEL.pack.keepFlyMs / 1000, ease: [0.4, 0, 0.6, 1], opacity: { times: [0, 0.85, 1], duration: CHAIN_FEEL.pack.keepFlyMs / 1000 } }}
              >
                <div className="h-full w-full overflow-hidden rounded-[10px]">
                  <ChainCardFace card={card} width={spread.w} />
                </div>
              </motion.div>
            );
          }
          return (
            <StageCard
              key={card.id}
              card={card}
              index={index}
              spread={spread}
              from={instant ? deckFrom : dealFrom}
              faceUp={faceUp[index] ?? false}
              selected={selected.includes(index)}
              kept={pickable && card.eternal === true}
              selectable={pickable && !card.eternal}
              leaving={leave}
              reducedMotion={reducedMotion}
              backUrl={backUrl}
              onTap={() => toggle(index)}
              shudderTick={shudders[index] ?? 0}
              tense={tense === index}
              flashTick={flash[index] ?? 0}
              elementRef={(element) => {
                cardRefs.current[index] = element;
              }}
            />
          );
        })}

      {mode === "keep" && cards && (stage === "open" || stage === "leaving") && (
        <motion.div
          className="absolute inset-x-0 flex justify-center"
          style={{ top: Math.max(...spread.spots.map((spot) => spot.y)) + spread.h + spread.captionH + (layout.narrow ? 14 : 22) }}
          initial={reducedMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: stage === "leaving" ? 0 : 1, y: 0 }}
        >
          <motion.button
            type="button"
            style={{ x: buttonShudderX }}
            disabled={stage !== "open"}
            onClick={() => void confirm()}
            className={`rounded-full px-8 py-3 text-[16px] font-black transition hover:brightness-110 ${
              selected.length === need ? "bg-osu-pink text-[#120f1a]" : "bg-white/10 text-white/70"
            }`}
          >
            {selected.length === need ? <Trans>Keep</Trans> : t`Pick ${need - selected.length}`}
          </motion.button>
        </motion.div>
      )}

      {/* The deck so far, small, while picking. */}
      {mode === "keep" && deckCards.length > 0 && (stage === "open" || stage === "flipping") && (
        <motion.div
          className="pointer-events-none absolute inset-x-0 flex justify-center gap-1.5"
          style={{ top: Math.max(...spread.spots.map((spot) => spot.y)) + spread.h + spread.captionH + (layout.narrow ? 66 : 84) }}
          initial={reducedMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {deckCards.slice(0, 12).map((card, index) => (
            <div key={`${card.id}-${index}`} style={{ width: layout.narrow ? 40 : 58, height: (layout.narrow ? 40 : 58) * 1.4 }}>
              <ChainCardFace card={card} width={layout.narrow ? 40 : 58} />
            </div>
          ))}
        </motion.div>
      )}

      {/* The deck the kept cards go to. */}
      {mode === "keep" && !layout.narrow && (
        <DeckPile layout={layout} count={deckCount} backUrl={backUrl} bump={deckBump} reducedMotion={reducedMotion} />
      )}

      {tokens.map((token) => (
        <ShardToken key={token.id} token={token} reducedMotion={reducedMotion} />
      ))}
    </div>
  );
}

function ShardToken({ token, reducedMotion }: { token: Token; reducedMotion: boolean }) {
  if (reducedMotion) return null;
  const midX = (token.from.x + token.to.x) / 2;
  const midY = Math.min(token.from.y, token.to.y) - 80;
  return (
    <motion.div
      className="pointer-events-none absolute left-0 top-0 z-[60] grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-osu-pink text-[14px] font-black text-[#120f1a]"
      initial={{ x: token.from.x, y: token.from.y, scale: 0, opacity: 0 }}
      animate={{ x: [token.from.x, midX, token.to.x], y: [token.from.y, midY, token.to.y], scale: [0.4, 1.15, 0.7], opacity: [1, 1, 0] }}
      transition={{ duration: CHAIN_FEEL.pack.tokenMs / 1000, delay: token.delayMs / 1000, ease: "easeIn", times: [0, 0.45, 1] }}
    >
      +1
    </motion.div>
  );
}

/* The face-down deck beside the hand: where draws come from and kept cards
   go. Pops when a card lands on it. */
export function DeckPile({
  layout,
  count,
  backUrl,
  bump,
  reducedMotion,
}: {
  layout: BoardLayout;
  count: number;
  backUrl: string | null;
  bump: number;
  reducedMotion: boolean;
}) {
  const { t } = useLingui();
  const { x, y, w, h } = layout.deck;
  return (
    <div data-chain-deck="" className="absolute" style={{ left: x, top: y, width: w, height: h }} title={t`${count} cards in the deck`}>
      <motion.div
        key={bump}
        className="relative h-full w-full"
        initial={bump && !reducedMotion ? { scale: 1.25, rotate: -6 } : false}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 600, damping: 16 }}
      >
        <div className="absolute inset-0 translate-x-[3px] translate-y-[3px] rounded-[6px] bg-black/50" />
        <div className="absolute inset-0 translate-x-[1.5px] translate-y-[1.5px] overflow-hidden rounded-[6px] bg-osu-b3" />
        <div className="absolute inset-0 overflow-hidden rounded-[6px] bg-osu-b4">
          {backUrl && <img src={backUrl} alt="" draggable={false} className="h-full w-full object-cover" />}
        </div>
      </motion.div>
      <div className={`absolute inset-x-0 text-center font-black tabular-nums ${layout.narrow ? "-bottom-4 text-[11px]" : "-bottom-6 text-[14px]"}`}>{count}</div>
    </div>
  );
}
