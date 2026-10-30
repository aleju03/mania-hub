import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { CHARM_BY_ID, CHARM_COPY, RARITY_TINT, rerollCost, rerollsLeft, type PackRunView, type ShopAction, type ShopOffer } from "#/lib/pack-run";
import { CharmArt } from "./charmArt";
import { CharmRule, ShardFloatLayer } from "./CharmCard";
import { NudgeGlyph, RerollGlyph } from "./charmGlyphs";
import { swayStyle } from "./RunCard";
import { runRefusalMessage } from "./RunView";
import { RUN_FEEL } from "./runFeel";
import { runSound } from "./runSound";
import { SHOP_FEEL } from "./shopFeel";
import { cancelGhost, confirmGhost, startGhost, useShardFloats, useShudder } from "./shopMotion";
import { Shards } from "./Shards";
import { scaledMediaQuery } from "#/lib/ui-scale-values";

function useWide(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia(scaledMediaQuery("(min-width: 768px)"));
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

/* The shop, in the play area between packs: the way on and the reroll beside
   the charms on offer. It eases in, the offers deal in once it has, and Next
   pack eases it out (RunTable wraps the mount in AnimatePresence). Buying starts a
   ghost over the card that flies to the rail once the server agrees
   (RunCharmRail draws and lands it); selling and reordering happen on the
   rail. A refusal shakes what was pressed. */
export function RunShop({
  view,
  shards,
  busy,
  act,
  onLeave,
  reducedMotion = false,
  shake,
}: {
  view: PackRunView;
  shards: number;
  busy: boolean;
  act: (action: ShopAction) => Promise<string | null>;
  onLeave: () => void;
  reducedMotion?: boolean;
  /* The table's shake, in RUN_FEEL.shake units. */
  shake?: (amount: number) => void;
}) {
  const { t, i18n } = useLingui();
  const wide = useWide();
  const { state, unlocks } = view;
  const offers = state.shop.offers;
  const cost = rerollCost(state);
  const rerolls = rerollsLeft(state);
  const over = Boolean(state.over);

  const panelRef = useRef<HTMLDivElement>(null);
  const artRefs = useRef<Array<HTMLElement | null>>([]);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const rerollRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [shudders, setShudders] = useState<Record<number, number>>({});
  const [rerollShudderX, shudderReroll] = useShudder(reducedMotion);
  const [rerollSpins, setRerollSpins] = useState(0);
  const [message, setMessage] = useState<{ key: number; text: string } | null>(null);
  const [floats, pushFloat] = useShardFloats();

  /* A new set of offers (the shop opening, or a reroll) deals in fresh: the
     first set waits for the shop to land, a reroll's follows the sweep. */
  const dealKey = `${state.runId}-${state.blind.ante}-${state.blind.blind}-${state.shop.rerolls}-${state.shop.free}-${offers.map((offer) => offer.id).join(".")}`;
  const firstDealKey = useRef(dealKey);
  const leadMs = dealKey === firstDealKey.current ? SHOP_FEEL.deal.leadMs : SHOP_FEEL.deal.rerollLeadMs;

  /* The shop arriving jiggles the table (feel §5: a panel arriving). */
  useEffect(() => {
    const timer = window.setTimeout(() => shake?.(SHOP_FEEL.shake.open), reducedMotion ? 0 : SHOP_FEEL.panel.landMs);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setReading(null), [dealKey]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), SHOP_FEEL.messageMs);
    return () => window.clearTimeout(timer);
  }, [message]);

  const say = useCallback(
    (reason: string) =>
      setMessage({ key: Date.now(), text: runRefusalMessage(reason, i18n, t`That did not go through. Please try again.`) }),
    [i18n, t],
  );

  /* "+N" / "-N" above an element, in the shop's box. `beside` puts it off
     the element's right end instead, clear of the button stacked above it. */
  const floatOver = (rect: DOMRect | undefined, value: number, beside = false) => {
    const panel = panelRef.current?.getBoundingClientRect();
    if (!panel || !rect) return;
    if (beside) pushFloat(rect.right - panel.left + 44, rect.top + rect.height / 2 - panel.top, value);
    else pushFloat(rect.left + rect.width / 2 - panel.left, rect.top - panel.top - 16, value);
  };

  const refuseOffer = (index: number, reason: string) => {
    runSound.refuse();
    setShudders((current) => ({ ...current, [index]: (current[index] ?? 0) + 1 }));
    say(reason);
  };

  const buy = async (index: number) => {
    const offer = offers[index];
    if (!offer || offer.sold || busy || pending !== null || over) return;
    if (state.charms.length >= unlocks.slots) return refuseOffer(index, "no_slot");
    if (shards < offer.cost) return refuseOffer(index, "no_shards");
    const art = artRefs.current[index]?.getBoundingClientRect();
    const card = cardRefs.current[index]?.getBoundingClientRect();
    /* The ghost starts on the press, over the card's art, and lifts there
       until the server answers. */
    const ghost = art
      ? startGhost(offer.id, CHARM_BY_ID.get(offer.id)?.rarity ?? "common", { x: art.left, y: art.top, w: art.width, h: art.height })
      : null;
    setPending(index);
    setReading(null);
    const refusal = await act({ kind: "buy", index });
    if (refusal) {
      if (ghost !== null) cancelGhost(ghost);
      setPending(null);
      refuseOffer(index, refusal);
      return;
    }
    if (ghost !== null) confirmGhost(ghost);
    setPending(null);
    setMessage(null);
    runSound.buy();
    shake?.(SHOP_FEEL.shake.buy);
    floatOver(card, -offer.cost);
  };

  const refuseReroll = (reason: string) => {
    runSound.refuse();
    shudderReroll();
    say(reason);
  };

  const reroll = async () => {
    if (busy || pending !== null || over) return;
    if (rerolls <= 0) return refuseReroll("no_rerolls");
    if (shards < cost) return refuseReroll("no_shards");
    const paid = cost;
    const refusal = await act({ kind: "reroll" });
    if (refusal) return refuseReroll(refusal);
    setMessage(null);
    runSound.reroll();
    shake?.(SHOP_FEEL.shake.reroll);
    setRerollSpins((spins) => spins + 1);
    if (paid > 0) floatOver(rerollRef.current?.getBoundingClientRect(), -paid, wide);
  };

  const rerollDim = rerolls <= 0 || shards < cost || over;
  const live = offers.flatMap((offer, index) => (offer.sold ? [] : [{ offer, index }]));
  const gap = wide ? 24 : 10;
  const cardMax = wide ? 212 : 150;
  const cardWidth = `min(${cardMax}px, calc((100% - ${Math.max(0, live.length - 1) * gap}px) / ${Math.max(1, live.length)}))`;

  return (
    <div className="absolute inset-0 flex items-center justify-center" translate="no">
      <motion.div
        ref={panelRef}
        className="relative w-full max-w-[1000px] px-1 md:px-4"
        initial={reducedMotion ? false : { opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={
          reducedMotion
            ? { opacity: 0, transition: { duration: 0.1 } }
            : { opacity: 0, y: 24, scale: 0.97, transition: { duration: SHOP_FEEL.panel.exitMs / 1000, ease: [0.5, 0, 0.75, 0] } }
        }
        transition={SHOP_FEEL.panel.spring}
      >
        <div className="flex flex-col-reverse items-stretch gap-5 md:flex-row md:items-center md:gap-9">
          {/* The way on and the reroll. */}
          <div className="flex shrink-0 gap-2.5 md:w-[240px] md:flex-col md:gap-3">
            <motion.button
              type="button"
              onClick={() => {
                runSound.uiTap();
                onLeave();
              }}
              whileTap={reducedMotion ? undefined : { scale: 0.94 }}
              className="inline-flex h-14 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-osu-pink px-3 text-[18px] font-black text-white transition-[filter] hover:brightness-110 md:h-[88px] md:flex-none md:text-[26px]"
            >
              <Trans>Next pack</Trans>
              <NudgeGlyph direction="right" size={wide ? 26 : 20} />
            </motion.button>
            <motion.button
              ref={rerollRef}
              type="button"
              onClick={() => void reroll()}
              style={{ x: rerollShudderX }}
              whileTap={reducedMotion ? undefined : { scale: 0.94 }}
              aria-disabled={rerollDim || busy}
              className={`flex h-14 flex-1 flex-col items-center justify-center whitespace-nowrap rounded-xl bg-[#2f9e63] px-2.5 text-white transition-[filter,opacity] hover:brightness-110 md:h-[76px] md:flex-none ${
                rerollDim ? "opacity-50" : ""
              }`}
            >
              <span className="inline-flex items-center gap-1.5 text-[16px] font-black leading-none md:text-[21px]">
                <motion.span
                  className="inline-grid"
                  animate={{ rotate: rerollSpins * 360 }}
                  transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 18 }}
                >
                  <RerollGlyph size={wide ? 22 : 18} />
                </motion.span>
                <Trans>Reroll</Trans>
              </span>
              <span className="mt-1 inline-flex items-center gap-2 text-[13px] font-bold leading-none text-white/85 md:text-[15px]">
                {cost === 0 ? <Trans>free</Trans> : <Shards value={cost} />}
                <span aria-hidden="true" className="h-3.5 w-px bg-white/35" />
                <Plural value={rerolls} one="# left" other="# left" />
              </span>
            </motion.button>
          </div>

          {/* The offers. */}
          <div className="min-w-0 flex-1">
            <AnimatePresence mode="wait" initial={!reducedMotion}>
              <motion.div key={dealKey} className="flex items-end justify-center pt-3" style={{ gap }}>
                {live.map(({ offer, index }, position) => (
                  <OfferCard
                    key={`${dealKey}-${index}`}
                    offer={offer}
                    position={position}
                    width={cardWidth}
                    wide={wide}
                    leadMs={leadMs}
                    affordable={shards >= offer.cost}
                    pending={pending === index}
                    reading={reading === index}
                    shudder={shudders[index] ?? 0}
                    reducedMotion={reducedMotion}
                    busy={busy || pending !== null || over}
                    artRef={(element) => {
                      artRefs.current[index] = element;
                    }}
                    cardRef={(element) => {
                      cardRefs.current[index] = element;
                    }}
                    onRead={(on) => setReading((current) => (on ? index : current === index ? null : current))}
                    onBuy={() => void buy(index)}
                  />
                ))}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <AnimatePresence>
          {message && (
            <motion.div
              key={message.key}
              className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-3 max-w-[92%] -translate-x-1/2 rounded-lg bg-osu-b6 px-3.5 py-2 text-center text-[13px] font-bold text-osu-pink-light"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.14 }}
              role="status"
            >
              {message.text}
            </motion.div>
          )}
        </AnimatePresence>
        <ShardFloatLayer floats={floats} />
      </motion.div>
    </div>
  );
}

/* One charm on offer: its price, its art big, its name, and Buy under it.
   Dealt in face up with an overshoot, tilting toward the pointer, showing
   its rule on hover or tap in place of its art. The others close up when
   one is bought. */
function OfferCard({
  offer,
  position,
  width,
  wide,
  leadMs,
  affordable,
  pending,
  reading,
  shudder,
  reducedMotion,
  busy,
  artRef,
  cardRef,
  onRead,
  onBuy,
}: {
  offer: ShopOffer;
  position: number;
  width: string;
  wide: boolean;
  leadMs: number;
  affordable: boolean;
  pending: boolean;
  reading: boolean;
  shudder: number;
  reducedMotion: boolean;
  busy: boolean;
  artRef: (element: HTMLElement | null) => void;
  cardRef: (element: HTMLElement | null) => void;
  onRead: (on: boolean) => void;
  onBuy: () => void;
}) {
  const { i18n } = useLingui();
  const def = CHARM_BY_ID.get(offer.id);
  const copy = CHARM_COPY[offer.id];
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const tiltX = useSpring(pointerX, RUN_FEEL.hover.tiltSpring);
  const tiltY = useSpring(pointerY, RUN_FEEL.hover.tiltSpring);
  const rotateY = useTransform(tiltX, (value) => value * SHOP_FEEL.hover.tiltDeg * 2);
  const rotateX = useTransform(tiltY, (value) => -value * SHOP_FEEL.hover.tiltDeg * 2);
  const [hovered, setHovered] = useState(false);
  const [shudderX, runShudder] = useShudder(reducedMotion);
  useEffect(() => {
    if (shudder > 0) runShudder();
  }, [runShudder, shudder]);

  const [dealDelay] = useState(() => (reducedMotion ? 0 : (leadMs + position * SHOP_FEEL.deal.staggerMs) / 1000));
  /* One materialize sound per card, on its beat (feel §11). */
  useEffect(() => {
    const timer = window.setTimeout(() => runSound.shopIn(position), dealDelay * 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const raised = hovered || reading || pending;
  const deal = SHOP_FEEL.deal;
  const sweep = SHOP_FEEL.sweep;
  return (
    <motion.div
      ref={cardRef}
      layout="position"
      className="flex shrink-0 flex-col items-center gap-2.5 md:gap-3"
      style={{ width, x: shudderX, transformPerspective: 800 }}
      initial={reducedMotion ? false : { y: deal.fromY, rotateY: deal.fromRotateY, scale: deal.fromScale, opacity: 0 }}
      animate={{ y: 0, rotateY: 0, scale: 1, opacity: 1 }}
      exit={
        reducedMotion
          ? { opacity: 0, transition: { duration: 0.08 } }
          : {
              y: sweep.toY,
              rotateY: sweep.toRotateY,
              opacity: 0,
              transition: { duration: sweep.durationMs / 1000, delay: (position * sweep.staggerMs) / 1000, ease: [0.5, 0, 0.75, 0] },
            }
      }
      transition={{ ...deal.spring, delay: dealDelay, opacity: { duration: 0.08, delay: dealDelay }, layout: SHOP_FEEL.recentre }}
    >
      <div className="run-card-sway relative w-full" style={swayStyle(position + 1, 240, reducedMotion)}>
        <motion.div
          className="relative w-full cursor-pointer touch-manipulation"
          style={{ rotateX, rotateY, transformPerspective: RUN_FEEL.hover.perspectivePx }}
          animate={{
            y: raised ? -SHOP_FEEL.hover.lift : 0,
            scale: pending ? [1, 0.94, 1.03] : raised ? SHOP_FEEL.hover.scale : 1,
          }}
          transition={{
            ...RUN_FEEL.deal.spring,
            /* feel §4: the press squashes, then the card holds lifted. */
            scale: pending ? { duration: SHOP_FEEL.ghost.pressMs / 1000, ease: "easeOut" } : RUN_FEEL.deal.spring,
          }}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            setHovered(true);
            runSound.hover();
          }}
          onPointerLeave={() => {
            setHovered(false);
            pointerX.set(0);
            pointerY.set(0);
          }}
          onPointerMove={(event) => {
            if (event.pointerType === "touch" || reducedMotion) return;
            const rect = event.currentTarget.getBoundingClientRect();
            pointerX.set((event.clientX - rect.left) / rect.width - 0.5);
            pointerY.set((event.clientY - rect.top) / rect.height - 0.5);
          }}
          onClick={() => {
            runSound.uiTap();
            onRead(!reading);
          }}
        >
          <div className="flex aspect-[236/290] w-full flex-col items-center justify-center rounded-xl bg-black/45 px-2 pb-2 pt-5">
            <span ref={artRef} className="block w-[74%]" style={{ opacity: pending ? 0 : 1 }}>
              <CharmArt id={offer.id} rarity={def?.rarity ?? "common"} size={wide ? 176 : 96} className="block h-auto w-full" />
            </span>
            <div
              className="mt-2 line-clamp-2 min-h-[2.3em] text-center text-[14px] font-bold leading-tight md:mt-3 md:text-[19px]"
              style={{ color: RARITY_TINT[def?.rarity ?? "common"] }}
            >
              {copy ? i18n._(copy.name) : offer.id}
            </div>
          </div>
          <AnimatePresence>
            {(hovered || reading) && !pending && (
              <motion.div
                className="absolute inset-0 flex flex-col justify-center overflow-hidden rounded-xl bg-osu-b6 px-3 py-4 text-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
              >
                <CharmRule id={offer.id} textClassName="text-[12px] md:text-[15px]" />
              </motion.div>
            )}
          </AnimatePresence>
          <span
            className={`absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded-md bg-osu-b6 px-2.5 py-1 text-[15px] font-black md:px-3 md:text-[20px] ${
              affordable ? "text-[#ffd36a]" : "text-osu-f1"
            }`}
          >
            <Shards value={offer.cost} />
          </span>
        </motion.div>
      </div>
      <motion.button
        type="button"
        onClick={onBuy}
        disabled={busy && !pending}
        whileTap={reducedMotion ? undefined : { scale: 0.92 }}
        aria-disabled={!affordable}
        className={`inline-flex h-11 w-full items-center justify-center rounded-lg bg-osu-pink text-[16px] font-black text-white transition-[filter,opacity] hover:brightness-110 md:h-12 md:text-[19px] ${
          affordable ? "" : "opacity-50"
        }`}
      >
        <Trans>Buy</Trans>
      </motion.button>
    </motion.div>
  );
}
