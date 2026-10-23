import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useSpring, useTransform, type MotionValue } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CHAIN_SCENE_INK,
  CHAIN_SKILL_WORD,
  CHAIN_TIER_COLOR,
  chainEffectSkill,
  formatChainScore,
  formatChainX,
  isChainTier,
  type ChainCardInstance,
  type ChainLink,
  type ChainRowResult,
} from "#/lib/chain-run";
import { swayStyle } from "../RunCard";
import { RUN_FEEL } from "../runFeel";
import { runSound } from "../runSound";
import { ChainCardFace } from "./ChainCardFace";
import { hideChainDetails, useChainDetailsTrigger } from "./ChainDetails";
import { CHAIN_FEEL } from "./chainFeel";
import { connector, handPlaces, type BoardLayout, type Connector } from "./chainLayout";
import { WysiDigits } from "./Wysi";

export interface CardPlace {
  x: number;
  y: number;
  scale: number;
  rotate: number;
}

/* Where a card enters from (a pack's spread, the deck pile), in board px. */
export interface CardEnter extends CardPlace {
  delayMs?: number;
  /* Lands face down and turns over this long after it set off. */
  flipAtMs?: number;
}

/* A link's look while a row plays: dimmed before it fires, lit once it has,
   red when it broke. `value` is the combo it has added so far this pass. */
export interface LinkFx {
  /* "half": lit in the first pass, waiting to be restamped by the second. */
  state: "pending" | "lit" | "broken" | "half";
  value: number;
  pulse: number;
}

export type BoardMode = "arrange" | "locked";

const PINK = "#ff66aa";
const BREAK_RED = "#ff5a5a";
const HAND_TRAIT_INK: Record<string, string> = { cc: "#7fd3ff", key: "#ffd36b", skill: "#8ff2b7" };

function handInk(trait: string, value: string): string {
  if (trait === "tier" && isChainTier(value)) return CHAIN_TIER_COLOR[value].ink;
  return HAND_TRAIT_INK[trait] ?? "#e9eef7";
}

interface BoardCardProps {
  entry: ChainCardInstance;
  layout: BoardLayout;
  place: CardPlace;
  /* Instant moves (a card being dragged sits on its drag offset). */
  instant: boolean;
  offsetX: MotionValue<number> | null;
  offsetY: MotionValue<number> | null;
  z: number;
  index: number;
  inRow: boolean;
  enter: CardEnter | null;
  interactive: boolean;
  /* 0 none; 1..4 shared traits with the row's last card; -1 a link only a
     scene card makes. */
  outline: number;
  /* Marks on this card that a link matches, lit in their ink. */
  lit: ReadonlySet<string> | null;
  /* Would break the chain: shown quieter. */
  dim: boolean;
  backUrl: string | null;
  reducedMotion: boolean;
  onPointerDown: (uid: number, event: React.PointerEvent, longPressed: () => boolean, cancelLongPress: () => void) => void;
  /* Being dragged: lifted off the table. */
  dragging?: boolean;
  /* Leaving for the deck: fades out on the way, after this delay. */
  leaveDelayMs?: number | null;
  /* Where it leaves to (the deck); it travels there by transform, keeping
     the face laid out at its own size. */
  leaveTo?: CardPlace | null;
  /* Greyed out (the row a run failed on). */
  grey?: boolean;
  onKey: (uid: number) => void;
  /* Space on a focused card: toggle it in the selection. */
  onKeySelect: (uid: number) => void;
  hoverable: boolean;
  /* Its place in the selection (1-based), or 0 when not selected. */
  selectedOrder?: number;
}

/* One card on the board, in the row or the hand: springs to its place, sways
   on its own clock, tilts toward the pointer, and turns over when it came
   from the deck face down. */
const BoardCard = memo(function BoardCard({
  entry,
  layout,
  place,
  instant,
  offsetX,
  offsetY,
  z,
  index,
  inRow,
  enter,
  interactive,
  outline,
  lit,
  dim,
  backUrl,
  reducedMotion,
  onPointerDown,
  onKey,
  onKeySelect,
  hoverable,
  dragging = false,
  leaveDelayMs = null,
  leaveTo = null,
  grey = false,
  selectedOrder = 0,
}: BoardCardProps) {
  const { t } = useLingui();
  const [hovered, setHovered] = useState(false);
  const [faceUp, setFaceUp] = useState(!enter?.flipAtMs || reducedMotion);
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const springX = useSpring(pointerX, RUN_FEEL.hover.tiltSpring);
  const springY = useSpring(pointerY, RUN_FEEL.hover.tiltSpring);
  const rotateY = useTransform(springX, (value) => value * RUN_FEEL.hover.tiltDeg * 2);
  const rotateX = useTransform(springY, (value) => -value * RUN_FEEL.hover.tiltDeg * 2);
  const details = useChainDetailsTrigger(() => ({ kind: "card", entry }), !hoverable);
  const zeroX = useMotionValue(0);
  const zeroY = useMotionValue(0);

  /* The card back exists only while the card is face down or turning: a
     face-up card has no back to show through when a parent's opacity
     flattens its 3D (a dimmed, dragged or leaving card). */
  const [hasBack, setHasBack] = useState(!faceUp);
  useEffect(() => {
    if (!faceUp || !hasBack) return;
    const timer = window.setTimeout(() => setHasBack(false), (reducedMotion ? 0 : RUN_FEEL.flip.durationMs) + 60);
    return () => window.clearTimeout(timer);
  }, [faceUp, hasBack, reducedMotion]);
  /* An exiting card is a picture of where it was: never hit-testable. */
  const present = useIsPresent();
  useEffect(() => {
    if (faceUp || !enter?.flipAtMs) return;
    const timer = window.setTimeout(() => {
      setFaceUp(true);
      runSound.flip(index);
    }, enter.flipAtMs);
    return () => window.clearTimeout(timer);
    // Once, for the entry it mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = selectedOrder > 0;
  // On a phone a pick shows by its ring and badge only, never lifting into
  // the buttons above the hand.
  const lifted = (hovered && interactive && !inRow) || dragging || (selected && !layout.narrow);
  /* Sized as shown (not scaled), so the face's type has real px floors. */
  const box = (at: CardPlace) => {
    const w = layout.cardW * at.scale;
    return { x: at.x + (layout.cardW - w) / 2, y: at.y + (layout.cardH - w * 1.4) / 2, width: w, height: w * 1.4, rotate: at.rotate };
  };
  const target = box(place);
  /* Moves to or from a smaller place (the deck) go by scale, never by
     resizing the box, so the face never re-lays out mid-flight. */
  const toward = (at: CardPlace) => ({
    ...target,
    x: target.x + (at.x - place.x),
    y: target.y + (at.y - place.y),
    rotate: at.rotate,
    scale: at.scale / Math.max(0.01, place.scale),
  });
  return (
    <motion.div
      data-chain-card={present ? entry.uid : undefined}
      className="absolute left-0 top-0"
      style={{ zIndex: z, transformOrigin: "50% 50%", pointerEvents: present && !leaveTo ? undefined : "none" }}
      initial={enter && !reducedMotion ? { ...toward(enter), opacity: 1 } : { ...target, scale: 1, opacity: 1 }}
      animate={leaveTo ? { ...toward(leaveTo), opacity: 0 } : { ...target, scale: 1, opacity: leaveDelayMs !== null ? 0 : 1 }}
      exit={
        reducedMotion
          ? { opacity: 0, transition: { duration: 0.12 } }
          : {
              y: target.y + RUN_FEEL.discard.dropPx,
              rotate: place.rotate + (index % 2 ? 10 : -10),
              opacity: 0,
              transition: { duration: RUN_FEEL.discard.durationMs / 1000, delay: (index * RUN_FEEL.discard.staggerMs) / 1000, ease: [0.5, 0, 0.75, 0] },
            }
      }
      transition={
        instant
          ? { duration: 0 }
          : leaveDelayMs !== null
            ? { duration: 0.3, delay: leaveDelayMs / 1000, ease: [0.5, 0, 0.75, 0], opacity: { duration: 0.3, delay: leaveDelayMs / 1000 + 0.08 } }
            : { ...CHAIN_FEEL.move.spring, delay: enter?.delayMs ? enter.delayMs / 1000 : 0 }
      }
    >
      <motion.div className="relative h-full w-full" style={{ x: offsetX ?? zeroX, y: offsetY ?? zeroY }}>
        <div className="run-card-sway relative h-full w-full" style={swayStyle(index + (inRow ? 3 : 0), target.height, reducedMotion)}>
          <div
            data-run-juice=""
            className="relative h-full w-full"
          >
            <div
              className={`absolute inset-0 rounded-[10px] bg-black/45 transition-transform duration-150 ${dragging ? "translate-x-[8px] translate-y-[18px]" : "translate-x-[3px] translate-y-[7px]"}`}
            />
            <motion.div
              role="button"
              tabIndex={interactive ? 0 : -1}
              aria-label={inRow ? t`${entry.card.name}, in the row` : t`${entry.card.name}, in the hand`}
              aria-pressed={interactive ? selected : undefined}
              className={`relative h-full w-full touch-none outline-none ${interactive ? "cursor-pointer" : "cursor-default"}`}
              style={{ rotateX, rotateY, transformPerspective: RUN_FEEL.hover.perspectivePx }}
              animate={{ y: dragging ? 0 : lifted ? -target.height * 0.08 : 0, scale: dragging ? 1.08 : lifted ? RUN_FEEL.hover.scale : 1 }}
              transition={RUN_FEEL.deal.spring}
              onPointerEnter={(event) => {
                details.onPointerEnter(event);
                if (event.pointerType === "touch") return;
                setHovered(true);
                if (interactive) runSound.hover();
              }}
              onPointerLeave={() => {
                details.onPointerLeave();
                setHovered(false);
                pointerX.set(0);
                pointerY.set(0);
              }}
              onPointerMove={(event) => {
                details.onPointerMove(event);
                if (event.pointerType === "touch" || reducedMotion) return;
                const rect = event.currentTarget.getBoundingClientRect();
                pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
                pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
              }}
              onPointerDown={(event) => {
                details.onPointerDown(event);
                if (interactive) onPointerDown(entry.uid, event, details.consumeLongPress, details.onPointerCancel);
              }}
              onPointerUp={details.onPointerUp}
              onPointerCancel={details.onPointerCancel}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === " ") onKeySelect(entry.uid);
                else onKey(entry.uid);
              }}
            >
              <motion.div
                className="relative h-full w-full"
                style={{ transformStyle: "preserve-3d", transformPerspective: RUN_FEEL.hover.perspectivePx }}
                initial={false}
                animate={{ rotateY: faceUp ? 0 : 180 }}
                transition={{ duration: reducedMotion ? 0 : RUN_FEEL.flip.durationMs / 1000, ease: [...RUN_FEEL.flip.ease] as [number, number, number, number] }}
              >
                {/* Dimming and greying sit on the face itself, never on a 3D
                    ancestor (opacity there flattens the flip and shows the
                    back through the face). */}
                <div
                  className="absolute inset-0 transition-[opacity,filter] duration-200"
                  style={{ backfaceVisibility: "hidden", opacity: dim ? 0.5 : dragging ? 0.9 : 1, filter: grey ? "grayscale(1) brightness(0.55)" : undefined }}
                >
                  <ChainCardFace card={entry.card} width={target.width} lit={lit} />
                </div>
                {hasBack && (
                  <div
                    className="absolute inset-0 overflow-hidden rounded-[10px] bg-osu-b4"
                    style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
                  >
                    {backUrl && <img src={backUrl} alt="" draggable={false} className="h-full w-full object-cover" />}
                  </div>
                )}
              </motion.div>
              {selected && (
                <>
                  <div className="pointer-events-none absolute -inset-[3px] rounded-[12px] border-[3px] border-osu-pink" />
                  <motion.div
                    className={`pointer-events-none absolute z-[2] grid h-7 w-7 place-items-center rounded-full bg-osu-pink text-[14px] font-black tabular-nums text-[#120f1a] ${layout.narrow ? "-right-1.5 -top-2.5 !h-6 !w-6 !text-[12px]" : "-left-2 -top-2"}`}
                    initial={reducedMotion ? false : { scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 700, damping: 20 }}
                  >
                    {selectedOrder}
                  </motion.div>
                </>
              )}
              {/* Would break after the row's last card: half strength, with
                  a hairline, on any rarity's colour. */}
              {dim && <div className="pointer-events-none absolute -inset-[2px] rounded-[11px] border border-[#ff7a7a]/80" />}
              {outline !== 0 && (
                <div
                  className={`pointer-events-none absolute rounded-[12px] ${outline < 0 ? "border-dashed" : ""}`}
                  style={{
                    inset: -(outline < 0 ? 3 : 1 + outline),
                    borderWidth: outline < 0 ? 2 : 1 + outline,
                    borderColor: outline < 0 ? "rgba(255,102,170,0.7)" : PINK,
                    borderStyle: outline < 0 ? "dashed" : "solid",
                  }}
                />
              )}
            </motion.div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
});

interface ChainBoardProps {
  layout: BoardLayout;
  /* The hand as the server dealt it; row cards are among them. */
  hand: ChainCardInstance[];
  rowUids: number[];
  /* Cards not on the table yet (a round pack that has not joined). */
  hiddenUids: Set<number>;
  mode: BoardMode;
  preview: ChainRowResult | null;
  /* Hand cards that would link to the row's last card: their outline level
     (BoardCard `outline`) and the marks they share with it. */
  wouldLink: Map<number, { level: number; traits: Set<string> }>;
  /* Hand cards that would break the chain after the row's last card. */
  breakers: Set<number>;
  linkFx: Record<string, LinkFx> | null;
  cardCombo: Record<number, number>;
  handsLit: number[];
  enters: Map<number, CardEnter>;
  backUrl: string | null;
  reducedMotion: boolean;
  onToRow: (uid: number) => void;
  onToHand: (uid: number) => void;
  /* The row as committed (rowUids is what is shown, a drag included). */
  committedRow: number[];
  /* A drag's row as it would be if dropped now, or null for no change. */
  onDragRow: (row: number[] | null) => void;
  /* The drag let go: commit the row it last proposed. */
  /* `handIndex`: where among the other hand cards (left to right) the
     card was let go over the hand, or null when it was not. */
  onDragEnd: (uids: number[], handIndex: number | null) => void;
  /* The round is over: every card leaves for the deck, one after another. */
  leaving?: boolean;
  /* Selected cards in selection order (all in the row or all in the hand). */
  selected: number[];
  /* How many times each card was dealt anew (part of its key). */
  dealGen?: Record<number, number>;
  /* Taps select instead of moving (the hand's select toggle). */
  selectMode: boolean;
  /* Toggle a card in the selection; `range` adds every card between the
     last selected and this one. */
  onSelect: (uid: number, range: boolean) => void;
  /* Send the selection: hand cards to the row, row cards to the hand. */
  onSendGroup: () => void;
  onClearSelection: () => void;
  /* The run failed on this row: it greys out. */
  failed?: boolean;
}

/* The row (6 slots, link lines between placed neighbours with only their
   number) and the hand under it, on one board so a card flies between them
   on its spring. Tap a hand card to send it to the next free slot, tap a row
   card to send it back; drag any card into the row at any slot, along it,
   or back down to the hand. */
export function ChainBoard(props: ChainBoardProps) {
  const {
    layout,
    hand,
    rowUids,
    hiddenUids,
    mode,
    preview,
    wouldLink,
    breakers,
    linkFx,
    cardCombo,
    handsLit,
    enters,
    backUrl,
    reducedMotion,
    onToRow,
    onToHand,
    committedRow,
    onDragRow,
    onDragEnd,
    leaving = false,
    failed = false,
    selected,
    dealGen = {},
    selectMode,
    onSelect,
    onSendGroup,
    onClearSelection,
  } = props;
  const boardRef = useRef<HTMLDivElement>(null);
  /* `group`: every card moving, in selection order (the held one among
     them); the others stack behind the pointer. */
  /* `handFrom`: where in the hand a hand card was lifted from, held open
     until it lands so the hand never closes up and reopens under it. */
  const [drag, setDrag] = useState<{ uid: number; base: CardPlace; group: number[]; touch: boolean; handFrom: number | null } | null>(null);
  const [settling, setSettling] = useState<number[]>([]);
  const offsetX = useMotionValue(0);
  const offsetY = useMotionValue(0);
  const pressRef = useRef<{
    uid: number;
    x: number;
    y: number;
    dragging: boolean;
    moved: boolean;
    inRow: boolean;
    base: CardPlace | null;
    longPressed: () => boolean;
    cancelLongPress: () => void;
    sent: string;
    handDrop: number | null;
    group: number[];
    modifier: "none" | "toggle" | "range";
    touch: boolean;
  } | null>(null);
  const rowRef = useRef(rowUids);
  rowRef.current = rowUids;
  const committedRef = useRef(committedRow);
  committedRef.current = committedRow;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const handlersRef = useRef({ onToRow, onToHand, onDragRow, onDragEnd, onSelect, onSendGroup, onClearSelection });
  handlersRef.current = { onToRow, onToHand, onDragRow, onDragEnd, onSelect, onSendGroup, onClearSelection };
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  /* Where each card was drawn last, for a drag's starting point. */
  const placesRef = useRef(new Map<number, CardPlace>());
  const handOrderRef = useRef<number[]>([]);
  /* Where in the hand a held card would land (a gap opens there), or null
     while the pointer is not over the hand. */
  const [handDrop, setHandDrop] = useState<number | null>(null);
  const handBaseRef = useRef<number[]>([]);

  const arranging = mode === "arrange";
  /* Every card is drawn once: a uid already placed (row first) is never
     drawn again, whatever the inputs say. */
  const drawnUids = new Set<number>();
  const rowEntries = rowUids
    .map((uid) => hand.find((entry) => entry.uid === uid))
    .filter((entry): entry is ChainCardInstance => Boolean(entry) && !drawnUids.has(entry!.uid) && Boolean(drawnUids.add(entry!.uid)));
  const handEntries = hand.filter(
    (entry) => !rowUids.includes(entry.uid) && !hiddenUids.has(entry.uid) && !drawnUids.has(entry.uid) && Boolean(drawnUids.add(entry.uid)),
  );
  /* A row card dragged off the row holds no place in the hand until it is
     dropped, so the hand does not shift under the drop point. */
  /* The held card leaves the hand's layout while it is dragged; over the
     hand, the others slide apart to open a gap where it would land. */
  const handLaid = drag ? handEntries.filter((entry) => !drag.group.includes(entry.uid)) : handEntries;
  const gapFrom = handDrop ?? drag?.handFrom ?? null;
  const gapAt = drag && gapFrom !== null ? Math.min(gapFrom, handLaid.length) : null;
  const gapSize = drag ? drag.group.length : 0;
  const handPlaceList = handPlaces(handLaid.length + (gapAt !== null ? gapSize : 0), layout);
  const handPlaceOf = new Map(
    handLaid.map((entry, index) => [entry.uid, handPlaceList[gapAt !== null && index >= gapAt ? index + gapSize : index]] as const),
  );
  handOrderRef.current = handLaid.map((entry) => entry.uid);
  handBaseRef.current = hand.filter((entry) => !committedRow.includes(entry.uid) && !hiddenUids.has(entry.uid)).map((entry) => entry.uid);
  const deckPlace: CardPlace = {
    x: layout.deck.x + layout.deck.w / 2 - layout.cardW / 2,
    y: layout.deck.y + layout.deck.h / 2 - layout.cardH / 2,
    scale: Math.max(0.2, layout.deck.w / layout.cardW),
    rotate: 10,
  };
  /* While a card is dragged over the row, a ghost of it holds its slot and
     the links draw to the ghost. */
  const ghosts = drag ? rowEntries.map((entry, index) => ({ entry, index })).filter(({ entry }) => drag.group.includes(entry.uid)) : [];
  /* A follower in a group drag sits stacked and fanned behind the held card. */
  const stackPlace = (uid: number): CardPlace | null => {
    if (!drag || uid === drag.uid || !drag.group.includes(uid)) return null;
    const step = drag.group.filter((value) => value !== drag.uid).indexOf(uid) + 1;
    const fan = drag.touch ? 4 : 14;
    return { x: drag.base.x + step * fan, y: drag.base.y + step * (drag.touch ? 3 : 9), scale: drag.base.scale, rotate: drag.base.rotate + step * (drag.touch ? 2 : 5) };
  };
  /* Marks a link matches, lit on both its cards (the scoring chain flashes
     them; at rest they stay lit so the reason for a link is on the cards). */
  const rowLit = new Map<number, Set<string>>();
  if (preview) {
    for (const link of [...preview.links, ...preview.skips]) {
      if (link.broken || !link.strength) continue;
      for (const trait of link.traits) {
        if (trait.trait === "scene") continue;
        for (const index of [link.from, link.to]) {
          const set = rowLit.get(index) ?? new Set<string>();
          set.add(trait.trait);
          rowLit.set(index, set);
        }
      }
    }
  }

  const onPointerDown = useCallback(
    (uid: number, event: React.PointerEvent, longPressed: () => boolean, cancelLongPress: () => void) => {
      if (event.button !== 0) return;
      pressRef.current = {
        uid,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
        moved: false,
        inRow: committedRef.current.includes(uid),
        base: placesRef.current.get(uid) ?? null,
        longPressed,
        cancelLongPress,
        sent: "",
        handDrop: null,
        group: [uid],
        modifier: event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "none",
        touch: event.pointerType === "touch",
      };
      offsetX.set(0);
      offsetY.set(0);
    },
    [offsetX, offsetY],
  );

  /* Any card drags, on mouse and touch: a hand card into the row at any
     slot (its neighbours open a gap and the links preview live), a row card
     along the row or back down to the hand. A press that does not move is
     still a tap. */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const press = pressRef.current;
      if (!press || !press.base) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.dragging) {
        if (Math.hypot(dx, dy) < CHAIN_FEEL.move.dragPx) return;
        press.moved = true;
        press.dragging = true;
        press.cancelLongPress();
        hideChainDetails();
        // Dragging a selected card moves the whole selection.
        const chosen = selectedRef.current;
        press.group = chosen.length > 1 && chosen.includes(press.uid) ? chosen.slice() : [press.uid];
        // Under a finger, a group rides above the touch point, smaller, so
        // the slots it would land in stay in view.
        if (press.touch && press.group.length > 1) {
          const lay = layoutRef.current;
          press.base = { ...press.base, y: press.base.y - lay.cardH * press.base.scale * 0.7, scale: press.base.scale * 0.75 };
        }
        const from = handOrderRef.current.findIndex((uid) => press.group.includes(uid));
        setDrag({ uid: press.uid, base: press.base, group: press.group, touch: press.touch, handFrom: press.inRow || from < 0 ? null : from });
      }
      offsetX.set(dx);
      offsetY.set(dy);
      const lay = layoutRef.current;
      // Where the pointer is decides the target: the row band or the hand.
      const board = boardRef.current?.getBoundingClientRect();
      const cx = board ? event.clientX - board.left : press.base.x + lay.cardW / 2 + dx;
      const cy = board ? event.clientY - board.top : press.base.y + lay.cardH / 2 + dy;
      const group = press.group;
      const others = committedRef.current.filter((uid) => !group.includes(uid));
      const zoneTop = lay.rowTop - lay.cardH * 0.4;
      const zoneBottom = Math.min(lay.rowBottom + lay.cardH * 0.2, lay.actionsY + 10);
      let next: number[] | null = press.inRow ? others : null;
      // Over the hand: the nearest hand place, counting a gap for the card.
      let gap: number | null = null;
      if (cy > zoneBottom) {
        const base = handBaseRef.current.filter((uid) => !group.includes(uid));
        const spots = handPlaces(base.length + 1, lay);
        let bestDistance = Infinity;
        spots.forEach((spot, index) => {
          const distance = Math.hypot(spot.x + lay.cardW / 2 - cx, spot.y + lay.cardH / 2 - cy);
          if (distance < bestDistance) {
            bestDistance = distance;
            gap = index;
          }
        });
      }
      if (gap !== press.handDrop) {
        press.handDrop = gap;
        setHandDrop(gap);
        if (gap !== null) runSound.charmMove();
      }
      // As many as fit, in selection order; the rest stay in the hand.
      const fit = group.slice(0, Math.max(0, lay.slots.length - others.length));
      if (cy >= zoneTop && cy <= zoneBottom && fit.length) {
        let best = 0;
        let bestDistance = Infinity;
        for (let index = 0; index <= Math.min(others.length, lay.slots.length - 1); index += 1) {
          const slot = lay.slots[index];
          const distance = Math.hypot(slot.x + lay.cardW / 2 - cx, slot.y + (slot.h ?? lay.cardH) / 2 - cy);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
          }
        }
        next = [...others.slice(0, best), ...fit, ...others.slice(best)];
      }
      const key = next ? next.join(",") : "";
      if (key !== press.sent) {
        press.sent = key;
        handlersRef.current.onDragRow(next);
        runSound.charmMove();
      }
    };
    const onUp = () => {
      const press = pressRef.current;
      pressRef.current = null;
      if (!press) return;
      if (press.dragging) {
        // The card leaves its drag base for its new place while its offset
        // springs home on the same spring, so the move stays continuous.
        // Let go over the hand: it lands in the gap it opened.
        const handIndex = press.handDrop;
        setHandDrop(null);
        handlersRef.current.onDragEnd(press.group, handIndex);
        setDrag(null);
        setSettling(press.group);
        const spring = { type: "spring" as const, stiffness: CHAIN_FEEL.move.spring.stiffness, damping: CHAIN_FEEL.move.spring.damping, mass: CHAIN_FEEL.move.spring.mass };
        // Settled once both axes are home: a level drag's y spring ends at
        // once, and dropping the offset then would snap the card back.
        void Promise.all([animate(offsetX, 0, spring), animate(offsetY, 0, spring)]).then(() =>
          setSettling((current) => (current === press.group ? [] : current)),
        );
        return;
      }
      if (press.longPressed() || press.moved) return;
      const chosen = selectedRef.current;
      // A modifier click (or a tap with the select toggle on) selects.
      if (press.modifier !== "none" || (selectModeRef.current && !chosen.includes(press.uid))) {
        handlersRef.current.onSelect(press.uid, press.modifier === "range");
        return;
      }
      // A plain click on a selected card sends the whole selection.
      if (chosen.includes(press.uid)) {
        handlersRef.current.onSendGroup();
        return;
      }
      if (chosen.length) handlersRef.current.onClearSelection();
      if (press.inRow) handlersRef.current.onToHand(press.uid);
      else handlersRef.current.onToRow(press.uid);
    };
    const onCancel = () => {
      const press = pressRef.current;
      pressRef.current = null;
      if (press?.dragging) handlersRef.current.onDragRow(null);
      setHandDrop(null);
      setDrag(null);
      offsetX.set(0);
      offsetY.set(0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [offsetX, offsetY]);

  useEffect(() => {
    if (!arranging) pressRef.current = null;
  }, [arranging]);

  const onKeySelect = useCallback((uid: number) => handlersRef.current.onSelect(uid, false), []);
  const onKey = useCallback((uid: number) => {
    if (selectedRef.current.length) {
      handlersRef.current.onSendGroup();
      return;
    }
    if (rowRef.current.includes(uid)) handlersRef.current.onToHand(uid);
    else handlersRef.current.onToRow(uid);
  }, []);

  const filled = rowEntries.length;
  return (
    <div ref={boardRef} className="absolute inset-0" data-chain-board="">
      {/* Empty slots; the next one, where a tapped card goes, stands out. */}
      {layout.slots.map((slot, index) =>
        index >= filled && !leaving ? (
          <div
            key={`slot-${index}`}
            className={`absolute grid place-items-center rounded-[10px] border-2 border-dashed font-black tabular-nums ${
              index === filled && arranging ? "border-osu-pink/60 text-osu-pink/70" : "border-white/[0.08] text-white/15"
            }`}
            style={{ left: slot.x, top: slot.y, width: layout.cardW, height: slot.h ?? layout.cardH, fontSize: slot.h ? 16 : layout.narrow ? 22 : 30 }}
          >
            {index + 1}
          </div>
        ) : null,
      )}

      <ChainLinks layout={layout} preview={filled >= 2 && !leaving ? preview : null} fx={linkFx} handsLit={handsLit} under />

      {ghosts.map(({ entry, index }) => (
        <div
          key={`ghost-${entry.uid}`}
          className="pointer-events-none absolute z-[15] overflow-hidden rounded-[10px] border-2 border-dashed border-osu-pink/80"
          style={{ left: layout.slots[index].x, top: layout.slots[index].y, width: layout.cardW, height: layout.cardH }}
        >
          <div className="h-full w-full opacity-40">
            <ChainCardFace card={entry.card} width={layout.cardW} />
          </div>
        </div>
      ))}

      {/* Row and hand as one list in a fixed order (by uid; z sets the
          stacking): a card dragged between them must not reorder the
          others, which React remounted, replaying their entrance from
          where they were first dealt. */}
      <AnimatePresence>
        {[
          ...rowEntries.map((entry, index) => {
          const dragging = drag?.uid === entry.uid;
          const stacked = stackPlace(entry.uid);
          const moving = dragging || Boolean(stacked) || settling.includes(entry.uid);
          const slot = layout.slots[index];
          const own = { x: slot.x, y: slot.y, scale: 1, rotate: 0 };
          if (!dragging && !stacked) placesRef.current.set(entry.uid, own);
          return (
            <BoardCard
              key={`${entry.uid}:${dealGen[entry.uid] ?? 0}`}
              entry={entry}
              layout={layout}
              place={drag && dragging ? drag.base : stacked ?? own}
              leaveTo={leaving ? deckPlace : null}
              leaveDelayMs={leaving ? index * 40 : null}
              grey={failed}
              dragging={dragging || Boolean(stacked)}
              instant={dragging}
              offsetX={moving ? offsetX : null}
              offsetY={moving ? offsetY : null}
              z={dragging ? 60 : stacked ? 59 - drag!.group.indexOf(entry.uid) : 20 + index}
              selectedOrder={selected.indexOf(entry.uid) + 1}
              index={index}
              inRow
              enter={enters.get(entry.uid) ?? null}
              interactive={arranging}
              outline={0}
              dim={false}
              lit={rowLit.get(index) ?? null}
              backUrl={backUrl}
              reducedMotion={reducedMotion}
              onPointerDown={onPointerDown}
              onKey={onKey}
              onKeySelect={onKeySelect}
              hoverable={!drag}
            />
          );
        }),
          ...handEntries.map((entry, index) => {
          const dragging = drag?.uid === entry.uid;
          const stacked = stackPlace(entry.uid);
          const moving = dragging || Boolean(stacked) || settling.includes(entry.uid);
          const own = handPlaceOf.get(entry.uid) ?? drag?.base ?? handPlaceList[0];
          if (!dragging && !stacked && handPlaceOf.has(entry.uid)) placesRef.current.set(entry.uid, own);
          return (
          <BoardCard
            key={`${entry.uid}:${dealGen[entry.uid] ?? 0}`}
            entry={entry}
            layout={layout}
            place={drag && dragging ? drag.base : stacked ?? own}
            leaveTo={leaving ? deckPlace : null}
            leaveDelayMs={leaving ? (rowEntries.length + index) * 40 : null}
            dragging={dragging || Boolean(stacked)}
            instant={dragging}
            offsetX={moving ? offsetX : null}
            offsetY={moving ? offsetY : null}
            z={dragging ? 60 : stacked ? 59 - drag!.group.indexOf(entry.uid) : 10 + index}
            selectedOrder={selected.indexOf(entry.uid) + 1}
            index={index}
            inRow={false}
            enter={enters.get(entry.uid) ?? null}
            interactive={arranging}
            outline={0}
            dim={arranging && breakers.has(entry.uid)}
            lit={arranging ? wouldLink.get(entry.uid)?.traits ?? null : null}
            backUrl={backUrl}
            reducedMotion={reducedMotion}
            onPointerDown={onPointerDown}
            onKey={onKey}
            onKeySelect={onKeySelect}
            hoverable={!drag}
          />
          );
        }),
        ].sort((a, b) => Number.parseInt(String(a.key), 10) - Number.parseInt(String(b.key), 10))}
      </AnimatePresence>

      <ChainLinks layout={layout} preview={filled >= 2 && !leaving ? preview : null} fx={linkFx} handsLit={handsLit} raised={Boolean(drag)} />

      {/* The combo each card scored at, under it, once the row plays. */}
      {rowEntries.map((entry, index) => {
        const combo = cardCombo[index];
        if (combo === undefined || leaving) return null;
        const slot = layout.slots[index];
        return (
          <div
            key={`combo-${entry.uid}`}
            data-chain-combo={index}
            className="pointer-events-none absolute z-[40] text-center font-black italic tabular-nums"
            style={{
              left: slot.x,
              top: layout.narrow ? slot.y + layout.cardH + 1 : slot.y + layout.cardH + 6,
              width: layout.cardW,
              fontSize: layout.narrow ? 13 : 18,
              lineHeight: 1,
              color: PINK,
              WebkitTextStroke: "4px #120f1a",
              paintOrder: "stroke fill",
            }}
          >
            <WysiDigits text={`x${formatChainScore(combo)}`} />
          </div>
        );
      })}

      {/* Before it plays: what each card's skillset will do in this row,
          under it, and a bracket under each Bracket pair's span. */}
      {!leaving && preview && <SkillHints layout={layout} rowEntries={rowEntries} preview={preview} cardCombo={cardCombo} />}
    </div>
  );
}

const DAMPED = "#9aa4b2";
const SKILL_INK = "#8ff2b7";

function SkillHints({
  layout,
  rowEntries,
  preview,
  cardCombo,
}: {
  layout: BoardLayout;
  rowEntries: readonly ChainCardInstance[];
  preview: ChainRowResult;
  cardCombo: Record<number, number>;
}) {
  const { i18n } = useLingui();
  // The first pass's card events say what each card's effect does here.
  const hints = new Map<number, string>();
  for (const event of preview.events) {
    if (event.kind !== "card" || event.pass !== 0 || hints.has(event.index)) continue;
    const word = event.late
      ? i18n._(CHAIN_SKILL_WORD.late)
      : event.hits === 2
        ? i18n._(CHAIN_SKILL_WORD.twice)
        : event.borrowed
          ? i18n._(CHAIN_SKILL_WORD.borrow)
          : event.x && event.x !== 1
            ? `x${formatChainX(event.x)}`
            : "";
    hints.set(event.index, word);
  }
  // Bracket pairs, left to right, as the engine pairs them.
  const brackets = rowEntries.map((entry, index) => (chainEffectSkill(entry.card) === "Bracket" ? index : -1)).filter((index) => index >= 0);
  const spans: Array<[number, number]> = [];
  for (let k = 0; k + 1 < brackets.length; k += 2) spans.push([brackets[k], brackets[k + 1]]);
  const below = (index: number) => layout.slots[index].y + layout.cardH + (layout.narrow ? 1 : 6);
  return (
    <>
      {rowEntries.map((entry, index) => {
        const word = hints.get(index);
        // Once the row plays, the combo it scored at takes the spot.
        if (!word || cardCombo[index] !== undefined) return null;
        const slot = layout.slots[index];
        return (
          <div
            key={`hint-${entry.uid}`}
            className="pointer-events-none absolute z-[40] flex justify-center"
            style={{ left: slot.x, top: below(index), width: layout.cardW }}
          >
            <span
              className="rounded-md px-1.5 py-0.5 font-black italic leading-none"
              style={{ fontSize: layout.narrow ? 11 : 13, color: SKILL_INK, background: "rgba(143,242,183,0.12)", boxShadow: "inset 0 0 0 1px rgba(143,242,183,0.4)" }}
            >
              {word}
            </span>
          </div>
        );
      })}
      <svg className="pointer-events-none absolute inset-0 z-[39] overflow-visible" width={layout.width} height={layout.height} aria-hidden="true">
        {spans.map(([a, b]) => {
          const from = layout.slots[a];
          const to = layout.slots[b];
          // A span across a phone's two lines is not drawn; its cards' hints still show.
          if (Math.abs(from.y - to.y) > 2) return null;
          const y = below(a) + (layout.narrow ? 18 : 26);
          const x1 = from.x + layout.cardW / 2;
          const x2 = to.x + layout.cardW / 2;
          return (
            <path
              key={`bracket-${a}-${b}`}
              d={`M ${x1} ${y - 8} L ${x1} ${y} L ${x2} ${y} L ${x2} ${y - 8}`}
              fill="none"
              stroke={SKILL_INK}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.85}
            />
          );
        })}
      </svg>
    </>
  );
}

/* The link lines and their numbers. Drawn twice: the lines under the cards
   (`under`), the numbers over them. */
function ChainLinks({
  layout,
  preview,
  fx,
  handsLit,
  under = false,
  raised = false,
}: {
  layout: BoardLayout;
  preview: ChainRowResult | null;
  fx: Record<string, LinkFx> | null;
  handsLit: number[];
  under?: boolean;
  /* Over a card being dragged, so its links stay readable. */
  raised?: boolean;
}) {
  if (!preview) return null;
  const items: Array<{ key: string; link: ChainLink; path: Connector; skip: boolean }> = [];
  preview.links.forEach((link, index) => {
    items.push({ key: `l${index}`, link, path: connector(layout, link.from, link.to, false), skip: false });
  });
  preview.skips.forEach((link) => {
    if (!link.strength) return;
    // On a phone, two-back links across the two lines are not drawn: their
    // traits still light on the cards.
    if (layout.narrow && Math.floor(link.from / 3) !== Math.floor(link.to / 3)) return;
    items.push({ key: `s${link.to}`, link, path: connector(layout, link.from, link.to, true), skip: true });
  });

  if (under) {
    return (
      <svg className="pointer-events-none absolute inset-0 z-[5] overflow-visible" width={layout.width} height={layout.height} aria-hidden="true">
        {items.map(({ key, link, path, skip }) => {
          const state = fx?.[key]?.state;
          const broken = link.broken && (!fx || state === "broken");
          const pending = Boolean(fx) && (!state || state === "pending");
          const stroke = broken
            ? BREAK_RED
            : skip
              ? CHAIN_SCENE_INK.tree
              : link.scenes[0] && link.traits[0]?.trait === "scene"
                ? CHAIN_SCENE_INK[link.scenes[0]]
                : link.strength
                  ? PINK
                  : "#ffffff";
          const width = broken ? 3 : skip ? Math.min(5, 2 + link.strength * 0.2) : Math.min(7, 2.5 + link.strength * 0.25);
          const opacity = pending ? 0.22 : state === "half" ? 0.45 : link.strength || broken ? 0.92 : 0.25;
          return (
            <path
              key={key}
              d={path.d}
              fill="none"
              stroke={stroke}
              strokeWidth={width}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={broken ? "5 6" : undefined}
              opacity={opacity}
            />
          );
        })}
        {preview.hands.map((hand, index) =>
          hand.cards.map((card) => {
            const slot = layout.slots[card];
            const lit = handsLit.includes(index);
            return (
              <rect
                key={`h${index}-${card}`}
                x={slot.x + 8}
                y={slot.y + layout.cardH + (layout.narrow ? 2 : 4)}
                width={layout.cardW - 16}
                height={4}
                rx={2}
                fill={handInk(hand.trait, hand.value)}
                opacity={fx && !lit ? 0.25 : 0.9}
              />
            );
          }),
        )}
      </svg>
    );
  }

  return (
    <>
      {items.map(({ key, link, path, skip }) => {
        const entry = fx?.[key];
        const broken = link.broken && (!fx || entry?.state === "broken");
        if (!link.strength && !broken) return null;
        // Before the chain reaches a link it keeps its arranged number, dim;
        // the playback restamps it as it gets there.
        const pending = Boolean(fx) && (!entry || entry.state === "pending");
        const half = entry?.state === "half";
        // Into a Jack the link adds only its share: its pill shows what it gives.
        const value = fx && !pending ? entry?.value ?? 0 : link.value ?? link.strength;
        return (
          <LinkBadge
            key={key}
            id={key}
            link={link}
            x={path.x}
            y={path.y}
            broken={broken}
            pending={Boolean(pending)}
            value={value}
            pulse={entry?.pulse ?? 0}
            narrow={layout.narrow}
            skip={skip}
            raised={raised}
            half={half}
          />
        );
      })}
    </>
  );
}

function LinkBadge({
  id,
  link,
  x,
  y,
  broken,
  pending,
  value,
  pulse,
  narrow,
  skip,
  raised,
  half = false,
}: {
  half?: boolean;
  raised: boolean;
  skip: boolean;
  id: string;
  link: ChainLink;
  x: number;
  y: number;
  broken: boolean;
  pending: boolean;
  value: number;
  pulse: number;
  narrow: boolean;
}) {
  const details = useChainDetailsTrigger(() => ({ kind: "link", link }));
  const fill = broken
    ? BREAK_RED
    : link.damp !== undefined && link.damp < 1
      ? DAMPED
      : skip
        ? CHAIN_SCENE_INK.tree
        : link.traits[0]?.trait === "scene" && link.scenes[0]
          ? CHAIN_SCENE_INK[link.scenes[0]]
          : PINK;
  return (
    <div
      data-chain-link={id}
      className={`absolute -translate-x-1/2 -translate-y-1/2 ${raised ? "z-[70]" : "z-[45]"}`}
      style={{ left: x, top: y }}
      onPointerEnter={details.onPointerEnter}
      onPointerMove={details.onPointerMove}
      onPointerLeave={details.onPointerLeave}
      onPointerDown={details.onPointerDown}
      onPointerUp={details.onPointerUp}
    >
      <motion.div
        key={pulse}
        className={`rounded-full px-1.5 py-0.5 font-black leading-none tabular-nums ${narrow ? "text-[11px]" : "text-[14px]"}`}
        style={{
          background: pending ? "rgba(255,255,255,0.1)" : fill,
          color: pending ? "rgba(255,255,255,0.55)" : "#120f1a",
          opacity: half ? 0.5 : 1,
        }}
        initial={pulse ? { scale: 1.55 } : false}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 700, damping: 18 }}
      >
        {broken ? <Trans>break</Trans> : <WysiDigits text={`+${formatChainScore(value)}`} />}
      </motion.div>
    </div>
  );
}
