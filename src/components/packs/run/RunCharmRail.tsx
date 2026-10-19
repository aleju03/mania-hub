import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { animate, AnimatePresence, motion, Reorder, useMotionValue, useSpring, useTransform, useVelocity } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { sellValue, type RunCharm, type ShopAction } from "#/lib/pack-run";
import { CharmArt } from "./charmArt";
import { CharmKey, CharmRule, EmptyKey, ShardFloatLayer } from "./CharmCard";
import { NudgeGlyph } from "./charmGlyphs";
import { swayStyle } from "./RunCard";
import { runRefusalMessage } from "./RunView";
import { RUN_FEEL } from "./runFeel";
import { runSound } from "./runSound";
import { SHOP_FEEL } from "./shopFeel";
import {
  claimGhost,
  finishGhost,
  getGhosts,
  subscribeGhosts,
  useShardFloats,
  useShudder,
  type CharmGhost,
} from "./shopMotion";
import { Shards } from "./Shards";

const POPOVER_WIDTH = 236;
const COUNT_WIDTH = 46;
const NO_GHOSTS: CharmGhost[] = [];

export interface RunCharmRailProps {
  charms: RunCharm[];
  /* The charms that count right now (liveCharms(state)): a mod can switch
     one off, and sell prices read Refund from these. */
  liveCharms?: RunCharm[];
  slots: number;
  /* The size the table asks for; the rail draws charms SHOP_FEEL.railScale
     times that, fitted to its width. */
  size: number;
  reducedMotion: boolean;
  /* Selling and reordering are open (the table is at rest, the run is on). */
  editable: boolean;
  busy: boolean;
  act: (action: ShopAction) => Promise<string | null>;
  /* The table's shake, in RUN_FEEL.shake units. */
  shake?: (amount: number) => void;
  /* Each charm's element by uid, for the scoring sequence to aim at. */
  elementRef: (uid: number, element: HTMLDivElement | null) => void;
}

interface Leaving {
  charm: RunCharm;
  index: number;
}

/* The charms held, left to right in the order they fire, and the open slots. Drag a charm along the rail to reorder; tap or click
   one for its rule, a sell button and nudges. A charm bought in the shop
   arrives as a ghost flown over the table (the layer at the end of this
   file) and its slot stays an empty outline until it lands. */
export function RunCharmRail({ charms, liveCharms = charms, slots, size: askedSize, reducedMotion, editable, busy, act, shake, elementRef }: RunCharmRailProps) {
  const { t, i18n } = useLingui();
  const railRef = useRef<HTMLDivElement>(null);
  const [railWidth, setRailWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /* The order while a drag is under way, until the server answers the move. */
  const [localOrder, setLocalOrder] = useState<number[] | null>(null);
  const draggingRef = useRef<number | null>(null);
  const [shudders, setShudders] = useState<Record<number, number>>({});
  const [wobbles, setWobbles] = useState<Record<number, number>>({});
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const bodiesRef = useRef(new Map<number, HTMLDivElement>());
  const [popoverAt, setPopoverAt] = useState<{ left: number; top: number } | null>(null);
  const [floats, pushFloat] = useShardFloats();
  const [countX, shudderCount] = useShudder(reducedMotion);
  const ghosts = useSyncExternalStore(subscribeGhosts, getGhosts, () => NO_GHOSTS);

  useLayoutEffect(() => {
    const element = railRef.current;
    if (!element) return;
    const measure = () => setRailWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const gap = askedSize >= 60 ? 12 : 8;
  const fit = railWidth > 0 ? Math.floor((railWidth - 8 - COUNT_WIDTH - gap * slots) / Math.max(1, slots)) : askedSize;
  const size = Math.max(36, Math.min(Math.round(askedSize * SHOP_FEEL.railScale), fit));

  const uids = charms.map((charm) => charm.uid);
  const byUid = new Map(charms.map((charm) => [charm.uid, charm] as const));
  const order =
    localOrder && localOrder.length === uids.length && localOrder.every((uid) => byUid.has(uid)) ? localOrder : uids;
  const awaiting = new Set(ghosts.flatMap((ghost) => (ghost.uid !== null ? [ghost.uid] : [])));
  const canEdit = editable && !busy && !leaving;
  const openUid = selected ?? (draggingRef.current === null ? hovered : null);
  const openCharm = openUid !== null && !awaiting.has(openUid) ? byUid.get(openUid) ?? null : null;
  const shown = charms.filter((charm) => !awaiting.has(charm.uid)).length;

  const setBody = useCallback(
    (uid: number, element: HTMLDivElement | null) => {
      if (element) bodiesRef.current.set(uid, element);
      else bodiesRef.current.delete(uid);
      elementRef(uid, element);
    },
    [elementRef],
  );
  const bodyOf = useCallback((uid: number) => bodiesRef.current.get(uid) ?? null, []);

  /* A selected or hovered charm that left (sold, or the run reset) lets go. */
  useEffect(() => {
    if (selected !== null && !byUid.has(selected)) setSelected(null);
    if (hovered !== null && !byUid.has(hovered)) setHovered(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uids.join(",")]);
  useEffect(() => {
    if (!editable) setSelected(null);
  }, [editable]);
  useEffect(() => setMessage(null), [selected]);

  /* Tapping anywhere off the rail closes the popover. */
  useEffect(() => {
    if (selected === null) return;
    const close = (event: PointerEvent) => {
      if (railRef.current && event.target instanceof Node && railRef.current.contains(event.target)) return;
      setSelected(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [selected]);

  /* The popover sits under its charm, kept inside the rail's own bounds. */
  useLayoutEffect(() => {
    const body = openUid !== null ? bodiesRef.current.get(openUid) : null;
    const rail = railRef.current;
    if (!body || !rail) {
      setPopoverAt(null);
      return;
    }
    const rect = body.getBoundingClientRect();
    const box = rail.getBoundingClientRect();
    const half = Math.min(POPOVER_WIDTH, box.width) / 2;
    const center = rect.left + rect.width / 2 - box.left;
    const clamped = Math.max(half, Math.min(box.width - half, center));
    setPopoverAt({ left: clamped, top: box.height + 8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openUid, order.join(","), size]);

  const refuse = useCallback(
    (uid: number | null, reason: string) => {
      runSound.refuse();
      if (uid !== null) setShudders((current) => ({ ...current, [uid]: (current[uid] ?? 0) + 1 }));
      else shudderCount();
      setMessage(runRefusalMessage(reason, i18n, t`That did not go through. Please try again.`));
    },
    [i18n, shudderCount, t],
  );

  const move = useCallback(
    async (uid: number, to: number, finalOrder: number[]) => {
      setLocalOrder(finalOrder);
      const refusal = await act({ kind: "move", uid, to });
      setLocalOrder(null);
      if (refusal) refuse(uid, refusal);
    },
    [act, refuse],
  );

  const onDragEnd = (uid: number) => {
    draggingRef.current = null;
    const to = order.indexOf(uid);
    const from = uids.indexOf(uid);
    if (to < 0 || to === from) {
      setLocalOrder(null);
      return;
    }
    void move(uid, to, order);
  };

  const nudge = (uid: number, direction: -1 | 1) => {
    const from = uids.indexOf(uid);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= uids.length || !canEdit) return;
    const next = [...uids];
    next.splice(from, 1);
    next.splice(to, 0, uid);
    runSound.charmMove();
    void move(uid, to, next);
  };

  /* Selling (feel §11): the charm wobbles on the press, then once the server
     agrees it dissolves to gold in its slot, the +N rises under it, and the
     neighbours close the gap after it has gone. */
  const sell = async (charm: RunCharm) => {
    if (!canEdit) return;
    const value = sellValue(charm, liveCharms);
    const index = uids.indexOf(charm.uid);
    const startedAt = performance.now();
    setWobbles((current) => ({ ...current, [charm.uid]: (current[charm.uid] ?? 0) + 1 }));
    const rail = railRef.current?.getBoundingClientRect();
    const rect = bodiesRef.current.get(charm.uid)?.getBoundingClientRect();
    const refusal = await act({ kind: "sell", uid: charm.uid });
    if (refusal) {
      refuse(charm.uid, refusal);
      return;
    }
    setSelected(null);
    setHovered(null);
    setLeaving({ charm, index });
    const hold = Math.max(0, SHOP_FEEL.sell.holdMs - (performance.now() - startedAt));
    window.setTimeout(() => {
      runSound.sell();
      shake?.(SHOP_FEEL.shake.sell);
      if (rail && rect) pushFloat(rect.left + rect.width / 2 - rail.left, rect.bottom - rail.top + 6, value);
    }, hold);
    window.setTimeout(() => setLeaving(null), hold + SHOP_FEEL.sell.dissolveMs + 60);
  };

  const items: Array<{ kind: "charm"; charm: RunCharm } | { kind: "leaving"; charm: RunCharm }> = order.flatMap((uid) => {
    const charm = byUid.get(uid);
    return charm ? [{ kind: "charm" as const, charm }] : [];
  });
  if (leaving) items.splice(Math.min(leaving.index, items.length), 0, { kind: "leaving", charm: leaving.charm });
  const empties = Math.max(0, slots - charms.length - (leaving ? 1 : 0));

  return (
    <div
      ref={railRef}
      className="relative z-20 flex shrink-0 items-start px-1 pt-1"
      style={{ gap }}
    >
      <Reorder.Group
        as="div"
        axis="x"
        values={order}
        onReorder={(next: number[]) => {
          if (draggingRef.current === null) return;
          runSound.charmMove();
          setLocalOrder(next);
        }}
        className="relative flex items-start"
        style={{ gap }}
      >
        {items.map((item, index) =>
          item.kind === "leaving" ? (
            <LeavingCharm key={`leaving-${item.charm.uid}`} charm={item.charm} size={size} reducedMotion={reducedMotion} />
          ) : (
            <RailCharm
              key={item.charm.uid}
              charm={item.charm}
              index={index}
              count={order.length}
              size={size}
              reducedMotion={reducedMotion}
              editable={canEdit && !awaiting.has(item.charm.uid)}
              awaiting={awaiting.has(item.charm.uid)}
              raised={openUid === item.charm.uid}
              shudder={shudders[item.charm.uid] ?? 0}
              wobble={wobbles[item.charm.uid] ?? 0}
              bodyRef={setBody}
              onHover={(on) => setHovered((current) => (on ? item.charm.uid : current === item.charm.uid ? null : current))}
              onSelect={() => setSelected((current) => (current === item.charm.uid ? null : item.charm.uid))}
              onDragStart={() => {
                draggingRef.current = item.charm.uid;
                setSelected(null);
                setHovered(null);
              }}
              onDragEnd={() => onDragEnd(item.charm.uid)}
              onNudge={(direction) => nudge(item.charm.uid, direction)}
            />
          ),
        )}
      </Reorder.Group>
      {Array.from({ length: empties }, (_, index) => (
        <EmptyKey key={`empty-${index}`} size={size} />
      ))}
      <motion.span
        style={{ x: countX, width: COUNT_WIDTH }}
        className="ml-auto shrink-0 self-center text-right text-[13px] font-black text-osu-f1 tabular-nums md:text-[15px]"
      >
        {shown}/{slots}
      </motion.span>
      <ShardFloatLayer floats={floats} />

      <AnimatePresence>
        {openCharm && popoverAt && (
          <motion.div
            key={openCharm.uid}
            className={`absolute z-[70] rounded-lg bg-osu-b6 px-3 py-2.5 text-center ${selected === openCharm.uid ? "" : "pointer-events-none"}`}
            style={{ width: POPOVER_WIDTH, maxWidth: "100%", left: popoverAt.left, top: popoverAt.top, translateX: "-50%" }}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
          >
            <CharmRule id={openCharm.id} />
            {selected === openCharm.uid && editable && (
              <div className="mt-2.5 flex items-center justify-center gap-1 border-t border-white/[0.07] pt-2.5">
                <button
                  type="button"
                  aria-label={t`Move left`}
                  disabled={!canEdit || order.indexOf(openCharm.uid) === 0}
                  onClick={() => nudge(openCharm.uid, -1)}
                  className="grid h-9 w-9 place-items-center rounded-md text-osu-f1 hover:bg-white/5 hover:text-white disabled:opacity-30"
                >
                  <NudgeGlyph direction="left" />
                </button>
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => void sell(openCharm)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#d4a03a] px-4 text-[14px] font-black text-[#2a1a00] transition hover:brightness-110 disabled:opacity-60"
                >
                  <Trans>Sell</Trans>
                  <Shards value={sellValue(openCharm, liveCharms)} />
                </button>
                <button
                  type="button"
                  aria-label={t`Move right`}
                  disabled={!canEdit || order.indexOf(openCharm.uid) === order.length - 1}
                  onClick={() => nudge(openCharm.uid, 1)}
                  className="grid h-9 w-9 place-items-center rounded-md text-osu-f1 hover:bg-white/5 hover:text-white disabled:opacity-30"
                >
                  <NudgeGlyph direction="right" />
                </button>
              </div>
            )}
            {selected === openCharm.uid && message && <div className="mt-2 text-[12px] text-osu-pink-light">{message}</div>}
          </motion.div>
        )}
      </AnimatePresence>

      <GhostLayer ghosts={ghosts} bodyOf={bodyOf} reducedMotion={reducedMotion} />
    </div>
  );
}

/* `ref` reaches the item so Reorder can measure it. */
function RailCharm({
  ref,
  charm,
  index,
  count,
  size,
  reducedMotion,
  editable,
  awaiting,
  raised,
  shudder,
  wobble,
  bodyRef,
  onHover,
  onSelect,
  onDragStart,
  onDragEnd,
  onNudge,
}: {
  ref?: React.Ref<HTMLDivElement>;
  charm: RunCharm;
  index: number;
  count: number;
  size: number;
  reducedMotion: boolean;
  editable: boolean;
  awaiting: boolean;
  raised: boolean;
  shudder: number;
  wobble: number;
  bodyRef: (uid: number, element: HTMLDivElement | null) => void;
  onHover: (on: boolean) => void;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onNudge: (direction: -1 | 1) => void;
}) {
  const { t } = useLingui();
  const [dragging, setDragging] = useState(false);
  const draggedRef = useRef(false);
  /* Bought just now: a ghost is flying in for it, so it neither pops in
     nor shows until the ghost lands. */
  const [arriving] = useState(() =>
    getGhosts().some((ghost) => ghost.id === charm.id && ghost.uid === null && ghost.phase !== "back"),
  );
  useLayoutEffect(() => {
    if (arriving) claimGhost(charm.id, charm.uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const hidden = awaiting;

  const juiceScale = useMotionValue(1);
  const juiceRotate = useMotionValue(0);
  const [shudderX, runShudder] = useShudder(reducedMotion);
  useEffect(() => {
    if (shudder > 0) runShudder();
  }, [runShudder, shudder]);
  /* Sell wobble (feel §4: 0.12 / 0.16). */
  useEffect(() => {
    if (wobble === 0 || reducedMotion) return;
    const options = { duration: SHOP_FEEL.sell.wobbleMs / 1000, ease: "easeOut" } as const;
    const controls = [animate(juiceScale, [...SHOP_FEEL.sell.wobbleScale], options), animate(juiceRotate, [...SHOP_FEEL.sell.wobbleRotate], options)];
    return () => controls.forEach((control) => control.stop());
  }, [juiceRotate, juiceScale, reducedMotion, wobble]);
  /* Landing: the ghost hands over and the slot pops (feel §4). */
  const wasAwaiting = useRef(awaiting);
  useEffect(() => {
    if (wasAwaiting.current && !awaiting) {
      runSound.charmMove();
      if (!reducedMotion) {
        const options = { duration: SHOP_FEEL.ghost.popMs / 1000, ease: "easeOut" } as const;
        animate(juiceScale, [...SHOP_FEEL.ghost.popScale], options);
        animate(juiceRotate, [...SHOP_FEEL.ghost.popRotate], options);
      }
    }
    wasAwaiting.current = awaiting;
  }, [awaiting, juiceRotate, juiceScale, reducedMotion]);

  /* Drag: the charm leans by its horizontal speed (feel §2). */
  const dragX = useMotionValue(0);
  const dragVelocity = useVelocity(dragX);
  const dragLean = useSpring(
    useTransform(dragVelocity, (velocity) =>
      Math.max(-SHOP_FEEL.drag.leanMaxDeg, Math.min(SHOP_FEEL.drag.leanMaxDeg, velocity * SHOP_FEEL.drag.leanPerVelocity)),
    ),
    { stiffness: 380, damping: 26 },
  );
  /* Tilt toward the pointer while hovered, as the hand's cards do. */
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const tiltX = useSpring(pointerX, RUN_FEEL.hover.tiltSpring);
  const tiltY = useSpring(pointerY, RUN_FEEL.hover.tiltSpring);
  const rotateY = useTransform(tiltX, (value) => value * SHOP_FEEL.hover.tiltDeg * 2);
  const rotateX = useTransform(tiltY, (value) => -value * SHOP_FEEL.hover.tiltDeg * 2);

  return (
    <Reorder.Item
      ref={ref}
      as="div"
      value={charm.uid}
      drag={editable ? "x" : false}
      style={{ x: dragX }}
      className={`relative outline-none ${editable ? "cursor-grab touch-none active:cursor-grabbing" : ""}`}
      initial={arriving || reducedMotion ? false : { scale: 0.3, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={RUN_FEEL.deal.spring}
      whileDrag={{ scale: SHOP_FEEL.drag.scale, zIndex: 40 }}
      onDragStart={() => {
        draggedRef.current = true;
        setDragging(true);
        onDragStart();
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragEnd();
      }}
      onPointerDown={() => {
        draggedRef.current = false;
      }}
      onTap={() => {
        if (draggedRef.current || hidden) return;
        runSound.uiTap();
        onSelect();
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch" || hidden) return;
        onHover(true);
        runSound.hover();
      }}
      onPointerLeave={() => {
        onHover(false);
        pointerX.set(0);
        pointerY.set(0);
      }}
      onPointerMove={(event) => {
        if (event.pointerType === "touch" || reducedMotion) return;
        const rect = event.currentTarget.getBoundingClientRect();
        pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
        pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
      }}
      tabIndex={0}
      aria-label={t`Charm ${index + 1} of ${count}`}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        } else if (event.key === "ArrowLeft" && editable) {
          onNudge(-1);
        } else if (event.key === "ArrowRight" && editable) {
          onNudge(1);
        }
      }}
    >
      {hidden && (
        <span className="absolute inset-0">
          <EmptyKey size={size} />
        </span>
      )}
      {/* The element the scoring sequence aims its juice at, and the ghost
          lands on: plain, so its transforms never fight the drag's. */}
      <div ref={(element) => bodyRef(charm.uid, element)} style={{ opacity: hidden ? 0 : 1 }}>
        <motion.div style={{ rotate: dragLean }}>
          <motion.div style={{ x: shudderX, scale: juiceScale, rotate: juiceRotate }}>
            <div className="run-card-sway" style={dragging ? undefined : swayStyle(index + 3, size, reducedMotion)}>
              <motion.div
                style={{ rotateX, rotateY, transformPerspective: RUN_FEEL.hover.perspectivePx }}
                animate={{ y: raised ? -6 : 0, scale: raised ? 1.06 : 1 }}
                transition={{ type: "spring", stiffness: 420, damping: 22 }}
              >
                <CharmKey id={charm.id} charm={charm} size={size} titled={false} />
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </Reorder.Item>
  );
}

/* A sold charm dissolving to gold in its slot (feel §11) before the
   neighbours close the gap. */
function LeavingCharm({ charm, size, reducedMotion }: { charm: RunCharm; size: number; reducedMotion: boolean }) {
  const dissolve = SHOP_FEEL.sell.dissolveMs / 1000;
  const hold = SHOP_FEEL.sell.holdMs / 1000;
  return (
    <div aria-hidden="true" className="relative shrink-0" style={{ width: size, height: size }}>
      <motion.div
        initial={false}
        animate={
          reducedMotion
            ? { opacity: 0 }
            : {
                filter: [
                  "sepia(0) saturate(1) brightness(1)",
                  "sepia(1) saturate(3.2) brightness(1.15)",
                  "sepia(1) saturate(4) brightness(1.7)",
                ],
                opacity: [1, 1, 0],
                y: [0, -4, -12],
                scale: [1, 1.05, 0.88],
              }
        }
        transition={reducedMotion ? { duration: 0.1 } : { duration: dissolve, delay: hold, times: [0, 0.45, 1], ease: "easeIn" }}
      >
        <CharmKey id={charm.id} charm={charm} size={size} titled={false} />
      </motion.div>
    </div>
  );
}

/* Bought charms in flight, drawn fixed over the whole table so nothing on
   the way (the shaking table, the rail's own layout) can bend their path. */
function GhostLayer({
  ghosts,
  bodyOf,
  reducedMotion,
}: {
  ghosts: CharmGhost[];
  bodyOf: (uid: number) => HTMLElement | null;
  reducedMotion: boolean;
}) {
  if (typeof document === "undefined" || ghosts.length === 0) return null;
  return createPortal(
    <>
      {ghosts.map((ghost) => (
        <GhostFlight key={ghost.key} ghost={ghost} bodyOf={bodyOf} reducedMotion={reducedMotion} />
      ))}
    </>,
    document.body,
  );
}

function GhostFlight({
  ghost,
  bodyOf,
  reducedMotion,
}: {
  ghost: CharmGhost;
  bodyOf: (uid: number) => HTMLElement | null;
  reducedMotion: boolean;
}) {
  const feel = SHOP_FEEL.ghost;
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const opacity = useMotionValue(1);
  const velocity = useVelocity(x);
  const rotate = useSpring(
    useTransform(velocity, (value) => Math.max(-feel.leanMaxDeg, Math.min(feel.leanMaxDeg, value * feel.leanPerVelocity))),
    { stiffness: 300, damping: 24 },
  );

  /* The press: squash, then lifted over its card while the server answers. */
  useEffect(() => {
    if (reducedMotion) return;
    const controls = [
      animate(scale, [...feel.pressScale], { duration: feel.pressMs / 1000, ease: "easeOut" }),
      animate(y, -feel.liftPx, feel.spring),
    ];
    return () => controls.forEach((control) => control.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ghost.phase === "back") {
      const control = animate(opacity, 0, { duration: feel.backMs / 1000 });
      const timer = window.setTimeout(() => finishGhost(ghost.key), feel.backMs);
      return () => {
        control.stop();
        window.clearTimeout(timer);
      };
    }
    if (ghost.phase !== "flying") return;
    const target = ghost.uid !== null ? bodyOf(ghost.uid) : null;
    if (!target) {
      /* No slot to land on (the rail never took it): let it fade. */
      const timer = window.setTimeout(() => {
        animate(opacity, 0, { duration: feel.backMs / 1000 });
        window.setTimeout(() => finishGhost(ghost.key), feel.backMs);
      }, 700);
      return () => window.clearTimeout(timer);
    }
    const rect = target.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - (ghost.from.x + ghost.from.w / 2);
    const dy = rect.top + rect.height / 2 - (ghost.from.y + ghost.from.h / 2);
    const landScale = rect.width / Math.max(1, ghost.from.w);
    if (reducedMotion) {
      finishGhost(ghost.key);
      return;
    }
    const controls = [animate(x, dx, feel.spring), animate(scale, landScale, feel.spring)];
    const flight = animate(y, dy, feel.spring);
    controls.push(flight);
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      finishGhost(ghost.key);
    };
    /* Hand over once it is in the slot, before the spring's long tail. */
    const unsubscribe = y.on("change", (value) => {
      if (Math.abs(value - dy) < 3 && Math.abs(x.get() - dx) < 3) land();
    });
    void flight.then(land);
    return () => {
      unsubscribe();
      controls.forEach((control) => control.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost.phase, ghost.uid]);

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed z-[200]"
      style={{ left: ghost.from.x, top: ghost.from.y, width: ghost.from.w, height: ghost.from.h, x, y, scale, rotate, opacity }}
    >
      <CharmArt id={ghost.id} rarity={ghost.rarity} size={ghost.from.w} className="h-full w-full" />
    </motion.div>
  );
}
