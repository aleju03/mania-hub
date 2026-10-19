import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CHAIN_RULES,
  CHAIN_SCENE_COPY,
  CHAIN_SCENE_INK,
  CHAIN_SCENE_NAMES,
  chainOfferName,
  chainRefusalMessage,
  type ChainAction,
  type ChainOffer,
  type ChainRunView,
  type ChainSceneId,
} from "#/lib/chain-run";
import { PACK_ASPECT } from "../../packArt";
import { runSound } from "../runSound";
import { SceneArt } from "../sceneArt";
import { SHOP_FEEL } from "../shopFeel";
import { useShardFloats, useShudder } from "../shopMotion";
import { Shards } from "../Shards";
import { ChainCardFace } from "./ChainCardFace";
import { SCENE_ART_ID } from "./ChainHud";
import type { BoardLayout } from "./chainLayout";
import { chainPackType } from "./ChainPackStage";
import { crispPackUrl } from "./packArtCrisp";
import { useChainPackArt } from "./chainPackArt";

export interface ShopActResult {
  ok: boolean;
  error?: string;
}

function PriceButton({
  price,
  label,
  disabled,
  onBuy,
  reducedMotion,
  big = false,
  affordable = true,
}: {
  affordable?: boolean;
  price: number;
  label: React.ReactNode;
  disabled: boolean;
  onBuy: (shudder: () => void, element: HTMLElement) => void;
  reducedMotion: boolean;
  big?: boolean;
}) {
  const [x, shudder] = useShudder(reducedMotion);
  return (
    <motion.button
      type="button"
      style={{ x }}
      disabled={disabled}
      onClick={(event) => onBuy(shudder, event.currentTarget)}
      aria-disabled={!affordable}
      className={`inline-flex items-center gap-2 rounded-full font-black transition disabled:opacity-40 ${affordable ? "bg-osu-pink text-[#120f1a] hover:brightness-110" : "bg-white/[0.07] text-white/40"} ${big ? "px-5 py-2.5 text-[15px]" : "px-4 py-2 text-[14px]"}`}
    >
      {label}
      <Shards value={price} />
    </motion.button>
  );
}

/* A pack offer: the wrapper itself, tilting toward the pointer, over its
   name and price. */
function PackOffer({ offer, thumb: fallback, height, reducedMotion }: { offer: ChainOffer; thumb: string | null; height: number; reducedMotion: boolean }) {
  const width = Math.round(height * PACK_ASPECT);
  // The run's own wrapper for this offer (a country pack's flag and colours).
  const thumb = useChainPackArt({ reason: "shop", offer }) ?? (offer.kind === "country" ? null : fallback);
  return (
    <motion.div
      className="relative"
      style={{ width, height }}
      whileHover={reducedMotion ? undefined : { rotate: -3, scale: 1.05, y: -4 }}
      transition={{ type: "spring", stiffness: 400, damping: 22 }}
    >
      <div className="absolute inset-0 translate-x-[3px] translate-y-[7px] rounded-[6px] bg-black/45" />
      <div className="run-pack-bob absolute inset-0 overflow-hidden rounded-[6px] bg-osu-b3">
        {thumb && <img src={thumb} alt="" draggable={false} className="h-full w-full object-cover" />}
      </div>
      {offer.keep > 1 && (
        <span className="absolute -right-2 -top-2 rounded-full bg-[#ffd36b] px-2 py-0.5 text-[11px] font-black text-[#120f1a]">
          <Trans>Keeps {offer.keep}</Trans>
        </span>
      )}
    </motion.div>
  );
}

export interface ChainShopProps {
  /* Held back while a pack's keep finishes over it, so its recycled cards
     never drift over the new stock. */
  enterDelayMs?: number;
  view: ChainRunView;
  layout: BoardLayout;
  busy: boolean;
  packThumbs: Partial<Record<string, string>>;
  reducedMotion: boolean;
  act: (action: ChainAction) => Promise<ShopActResult>;
  shake: (amount: number) => void;
}

/* The shop between rounds, shaped around buying: the three packs and the
   scene card on offer laid out on the table, each over one price button;
   removing a card and a reroll beside them; Play round N to leave. A buy that
   goes through thumps the table and the price rises off the shard count; a
   refused one shakes the button and says why. */
export function ChainShop({ view, layout, busy, packThumbs, reducedMotion, act, shake, enterDelayMs = 0 }: ChainShopProps) {
  const lead = enterDelayMs / 1000;
  const { i18n, t } = useLingui();
  const [floats, pushFloat] = useShardFloats();
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [rerolls, setRerolls] = useState(0);
  /* A bought scene card flies from the shop to its place among the held
     ones. */
  const sceneArtRef = useRef<HTMLDivElement>(null);
  const [flight, setFlight] = useState<{ key: number; scene: ChainSceneId; from: DOMRect; to: DOMRect | null } | null>(null);
  useEffect(() => {
    if (!flight || flight.to) return;
    const frame = window.requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>(`[data-chain-scene="${flight.scene}"]`)].find((element) => element.offsetParent !== null);
      const to = target?.getBoundingClientRect() ?? null;
      setFlight((current) => (current && current.key === flight.key ? (to ? { ...current, to } : null) : current));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flight]);
  const shop = view.shop;
  const narrow = layout.narrow;
  const packHeight = narrow ? 112 : Math.min(220, layout.height * 0.27);

  const floatAtShards = (value: number) => {
    const counter = [...document.querySelectorAll<HTMLElement>("[data-chain-shards]")].find((element) => element.offsetParent !== null);
    const box = document.querySelector<HTMLElement>("[data-chain-shop]")?.getBoundingClientRect();
    const rect = counter?.getBoundingClientRect();
    if (rect && box) pushFloat(rect.left + rect.width / 2 - box.left, rect.bottom - box.top + 6, value);
  };

  const run = async (action: ChainAction, price: number, shudder: () => void): Promise<boolean> => {
    if (busy) return false;
    if (price > view.shards) {
      shudder();
      runSound.refuse();
      return false;
    }
    const outcome = await act(action);
    if (!outcome.ok) {
      shudder();
      runSound.refuse();
      if (outcome.error !== "stale") {
        setMessage(chainRefusalMessage(outcome.error ?? "failed", i18n));
        window.setTimeout(() => setMessage(null), SHOP_FEEL.messageMs);
      }
      return false;
    }
    if (price) floatAtShards(-price);
    if (action.kind === "reroll") {
      runSound.reroll();
      shake(SHOP_FEEL.shake.reroll);
      setRerolls((value) => value + 1);
    } else if (action.kind === "sell") {
      runSound.sell();
      shake(SHOP_FEEL.shake.sell);
      floatAtShards(CHAIN_RULES.sceneSell);
    } else {
      runSound.buy();
      shake(SHOP_FEEL.shake.buy + 0.2);
    }
    return true;
  };

  if (!shop) return null;
  const deck = view.deck;
  return (
    <div data-chain-shop="" className="absolute inset-0">
      <motion.div
        className="absolute inset-x-0 flex flex-col items-center"
        style={{ top: narrow ? 8 : Math.max(20, layout.height * 0.08) }}
        initial={reducedMotion ? false : { y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SHOP_FEEL.panel.spring, delay: lead }}
      >
        {/* The title is the table's (one title at a time); this keeps its room. */}
        <div aria-hidden="true" className={`leading-none ${narrow ? "h-[22px]" : "h-[32px]"}`} />

        {/* Packs and the scene card on offer. */}
        {/* A fixed height on a phone, so the buttons under the stock do not
            jump while it rerolls. */}
        <div
          className={`mt-5 flex flex-wrap items-end justify-center ${narrow ? "content-start gap-x-4 gap-y-5" : "gap-12"}`}
          style={narrow ? { minHeight: 372 } : undefined}
        >
          {shop.offers.map((offer, index) => (
            <AnimatePresence key={`${rerolls}-${index}`} mode="popLayout">
              {!offer.sold && (
                <motion.div
                  key={`${rerolls}-${index}`}
                  className="flex flex-col items-center gap-2"
                  initial={reducedMotion ? false : { y: SHOP_FEEL.deal.fromY, rotateY: SHOP_FEEL.deal.fromRotateY, scale: SHOP_FEEL.deal.fromScale, opacity: 0 }}
                  animate={{ y: 0, rotateY: 0, scale: 1, opacity: 1 }}
                  exit={{ y: -60, scale: 0.6, opacity: 0, transition: { duration: 0.22 } }}
                  transition={{ ...SHOP_FEEL.deal.spring, delay: lead + (index * SHOP_FEEL.deal.staggerMs) / 1000 }}
                  onAnimationStart={() => runSound.shopIn(index)}
                >
                  <PackOffer offer={offer} thumb={crispPackUrl(chainPackType("shop", offer)) ?? packThumbs[chainPackType("shop", offer)] ?? null} height={packHeight} reducedMotion={reducedMotion} />
                  <div className={`font-black ${narrow ? "text-[12px]" : "text-[15px]"}`}>{chainOfferName(offer, i18n)}</div>
                  <PriceButton
                    affordable={offer.price <= view.shards}
                    price={offer.price}
                    label={<Trans>Buy</Trans>}
                    disabled={busy}
                    reducedMotion={reducedMotion}
                    onBuy={(shudder) => void run({ kind: "buy", item: "pack", index }, offer.price, shudder)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          ))}

          <AnimatePresence mode="popLayout">
            {shop.scene && (
              <motion.div
                key={`scene-${shop.scene}-${rerolls}`}
                className={`flex flex-col items-center gap-2 ${narrow ? "w-[150px]" : "w-[210px]"}`}
                initial={reducedMotion ? false : { y: SHOP_FEEL.deal.fromY, scale: SHOP_FEEL.deal.fromScale, opacity: 0 }}
                animate={{ y: 0, scale: 1, opacity: 1 }}
                exit={{ y: -80, scale: 0.5, opacity: 0, transition: { duration: 0.25 } }}
                transition={{ ...SHOP_FEEL.deal.spring, delay: lead + (3 * SHOP_FEEL.deal.staggerMs) / 1000 }}
              >
                <motion.div
                  ref={sceneArtRef}
                  className="overflow-hidden rounded-[10px]"
                  whileHover={reducedMotion ? undefined : { rotate: 3, scale: 1.05 }}
                  transition={{ type: "spring", stiffness: 400, damping: 22 }}
                >
                  <SceneArt id={SCENE_ART_ID[shop.scene]} size={narrow ? 84 : Math.round(packHeight * 0.68)} />
                </motion.div>
                <div className="text-center">
                  <div className={`font-black ${narrow ? "text-[13px]" : "text-[16px]"}`} style={{ color: CHAIN_SCENE_INK[shop.scene] }}>
                    {CHAIN_SCENE_NAMES[shop.scene]}
                  </div>
                  <div className="mt-0.5 text-[12px] leading-snug text-osu-f1">{i18n._(narrow ? CHAIN_SCENE_COPY[shop.scene].short : CHAIN_SCENE_COPY[shop.scene].text)}</div>
                </div>
                <PriceButton
                  affordable={CHAIN_RULES.scenePrice <= view.shards && view.scenes.length < CHAIN_RULES.sceneSlots}
                  price={CHAIN_RULES.scenePrice}
                  label={<Trans>Buy</Trans>}
                  disabled={busy}
                  reducedMotion={reducedMotion}
                  onBuy={(shudder) => {
                    const from = sceneArtRef.current?.getBoundingClientRect() ?? null;
                    const scene = shop.scene;
                    void run({ kind: "buy", item: "scene" }, CHAIN_RULES.scenePrice, shudder).then((ok) => {
                      if (ok && from && scene && !reducedMotion) setFlight({ key: Date.now(), scene, from, to: null });
                    });
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className={`mt-6 flex items-center justify-center gap-3 border-t border-white/[0.07] pt-5 ${narrow ? "w-full px-3" : "w-[620px]"}`}>
          <UtilityButton
            affordable={CHAIN_RULES.removePrice <= view.shards}
            label={<Trans>Remove a card</Trans>}
            price={CHAIN_RULES.removePrice}
            disabled={busy || deck.length <= CHAIN_RULES.minDeck}
            reducedMotion={reducedMotion}
            onClick={(shudder) => {
              if (CHAIN_RULES.removePrice > view.shards) {
                shudder();
                runSound.refuse();
                return;
              }
              runSound.uiTap();
              setRemoving(true);
            }}
          />
          <UtilityButton
            affordable={CHAIN_RULES.rerollPrice <= view.shards}
            label={<Trans>Reroll</Trans>}
            price={CHAIN_RULES.rerollPrice}
            disabled={busy}
            reducedMotion={reducedMotion}
            onClick={(shudder) => void run({ kind: "reroll" }, CHAIN_RULES.rerollPrice, shudder)}
          />
        </div>

        <motion.button
          type="button"
          disabled={busy}
          onClick={() => {
            runSound.uiTap();
            void act({ kind: "nextRound" });
          }}
          className={`mt-6 rounded-full bg-white font-black text-[#120f1a] transition hover:brightness-110 disabled:opacity-50 ${narrow ? "px-8 py-3 text-[16px]" : "px-12 py-4 text-[20px]"}`}
          initial={reducedMotion ? false : { scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 20, delay: 0.4 }}
        >
          <Trans>Play round {view.round + 1}</Trans>
        </motion.button>

        <AnimatePresence>
          {message && (
            <motion.div
              className="mt-3 text-[13px] font-bold text-[#ff8a8a]"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              {message}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Removing a card: the deck laid out, tap one to take it out. */}
      <AnimatePresence>
        {removing && (
          <motion.div
            className="absolute inset-0 z-[20] flex flex-col items-center justify-center bg-[#0c0a10]/90 px-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className={`font-black italic uppercase ${narrow ? "text-[20px]" : "text-[28px]"}`}>
              <Trans>Remove a card</Trans>
            </div>
            <div className={`mt-5 flex max-w-[1100px] flex-wrap justify-center ${narrow ? "gap-2" : "gap-4"}`}>
              <AnimatePresence>
                {deck.map((entry, index) => (
                  <motion.button
                    key={entry.uid}
                    type="button"
                    aria-label={t`Remove ${entry.card.name}`}
                    disabled={busy}
                    className="relative block"
                    style={{ width: narrow ? 68 : 110, height: (narrow ? 68 : 110) * 1.4 }}
                    initial={reducedMotion ? false : { y: 30, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ scale: 0.3, opacity: 0, rotate: 12, transition: { duration: 0.3 } }}
                    transition={{ type: "spring", stiffness: 520, damping: 26, delay: index * 0.025 }}
                    whileHover={reducedMotion ? undefined : { y: -6, scale: 1.05 }}
                    onClick={async (event) => {
                      const button = event.currentTarget;
                      if (deck.length <= CHAIN_RULES.minDeck) return;
                      await run({ kind: "removeCard", uid: entry.uid }, CHAIN_RULES.removePrice, () => {
                        button.animate([{ transform: "translateX(0)" }, { transform: "translateX(-8px)" }, { transform: "translateX(7px)" }, { transform: "translateX(0)" }], 300);
                      });
                      setRemoving(false);
                    }}
                  >
                    <ChainCardFace card={entry.card} width={narrow ? 68 : 110} />
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
            <div className="mt-6 flex items-center gap-4">
              <span className="text-[13px] font-bold text-osu-f1">
                <Shards value={CHAIN_RULES.removePrice} />
              </span>
              <button
                type="button"
                onClick={() => setRemoving(false)}
                className="rounded-full bg-white/10 px-5 py-2 text-[14px] font-bold transition hover:brightness-125"
              >
                <Trans>Cancel</Trans>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {flight?.to && (
        <FlightGhost key={flight.key} flight={{ scene: flight.scene, from: flight.from, to: flight.to }} onDone={() => setFlight(null)} />
      )}

      {floats.map((float) => (
        <motion.div
          key={float.key}
          className={`pointer-events-none absolute z-[30] -translate-x-1/2 text-[18px] font-black tabular-nums ${float.value < 0 ? "text-[#ff8a8a]" : "text-[#8ff2b7]"}`}
          style={{ left: float.x, top: float.y }}
          initial={{ opacity: 0, y: 0 }}
          animate={{ opacity: [0, 1, 1, 0], y: [0, 6, 14, SHOP_FEEL.float.risePx] }}
          transition={{ duration: SHOP_FEEL.float.durationMs / 1000 }}
        >
          {float.value > 0 ? "+" : ""}
          {float.value}
        </motion.div>
      ))}
    </div>
  );
}

function UtilityButton({
  label,
  price,
  disabled,
  reducedMotion,
  onClick,
  affordable = true,
}: {
  affordable?: boolean;
  label: React.ReactNode;
  price: number;
  disabled: boolean;
  reducedMotion: boolean;
  onClick: (shudder: () => void) => void;
}) {
  const [x, shudder] = useShudder(reducedMotion);
  return (
    <motion.button
      type="button"
      style={{ x }}
      disabled={disabled}
      onClick={() => onClick(shudder)}
      aria-disabled={!affordable}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-bold transition disabled:opacity-40 ${affordable ? "bg-white/10 text-white hover:brightness-125" : "bg-white/[0.05] text-white/35"}`}
    >
      {label}
      <Shards value={price} className={affordable ? "text-osu-pink-light" : ""} />
    </motion.button>
  );
}

/* The bought scene card's flight, drawn over the page from the shop to the
   scene card column, landing with a small pop. */
function FlightGhost({ flight, onDone }: { flight: { scene: ChainSceneId; from: DOMRect; to: DOMRect }; onDone: () => void }) {
  const { from, to } = flight;
  const box = document.querySelector<HTMLElement>("[data-chain-shop]")?.getBoundingClientRect();
  if (!box) return null;
  const size = from.width;
  return (
    <motion.div
      className="pointer-events-none absolute left-0 top-0 z-[40] overflow-hidden rounded-[10px]"
      style={{ width: size, height: size }}
      initial={{ x: from.left - box.left, y: from.top - box.top, scale: 1, rotate: 0 }}
      animate={{
        x: to.left - box.left + to.width / 2 - size / 2,
        y: to.top - box.top + to.height / 2 - size / 2,
        scale: to.width / size,
        rotate: [0, -10, 0],
      }}
      transition={{ type: "spring", stiffness: 220, damping: 22, rotate: { duration: 0.5 } }}
      onAnimationComplete={onDone}
    >
      <SceneArt id={SCENE_ART_ID[flight.scene]} size={size} />
    </motion.div>
  );
}
