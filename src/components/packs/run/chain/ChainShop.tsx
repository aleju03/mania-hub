import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CHAIN_RULES,
  chainInterestFor,
  CHAIN_SCENE_COPY,
  CHAIN_SCENE_INK,
  CHAIN_SCENE_NAMES,
  CHAIN_TRAIT_WORD,
  CHAIN_TRAITS,
  CHAIN_MODS,
  chainModLook,
  chainOfferName,
  chainPracticeText,
  chainRefusalMessage,
  type ChainAction,
  type ChainActionResult,
  type ChainContract,
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
import { ShopContracts } from "./ChainContracts";
import { ModChip } from "./ModPin";
import { SCENE_ART_ID } from "./ChainHud";
import type { BoardLayout } from "./chainLayout";
import { chainPackType } from "./ChainPackStage";
import { crispPackUrl } from "./packArtCrisp";
import { useChainPackArt } from "./chainPackArt";
import { ChainButtons, IconCut, IconSwap, KIT, KitGem, MARKER, SceneMedallion } from "./chainKit";

export interface ShopActResult {
  ok: boolean;
  error?: string;
  result?: ChainActionResult;
}

const TAG_CLIP = "polygon(14px 0, 100% 0, 100% 100%, 14px 100%, 0 50%)";

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
      disabled={disabled}
      onClick={(event) => onBuy(shudder, event.currentTarget)}
      aria-disabled={!affordable}
      className={`relative inline-flex items-center gap-1.5 leading-none transition hover:brightness-105 disabled:opacity-40 ${big ? "py-2 pl-7 pr-4 text-[22px]" : "py-1.5 pl-6 pr-3 text-[19px]"}`}
      style={{ x, fontFamily: MARKER, color: KIT.dark }}
    >
      {/* The tag and its shadow as two clipped shapes: a drop-shadow filter on
         a clipped element made phone browsers drop it for a frame while the
         shop animated in. */}
      <span aria-hidden="true" className="absolute inset-0 translate-y-[3px] bg-black/40" style={{ clipPath: TAG_CLIP }} />
      <span aria-hidden="true" className="absolute inset-0" style={{ clipPath: TAG_CLIP, background: affordable ? KIT.cream : "#8f887f" }} />
      {/* The tag's punched hole. */}
      <span aria-hidden="true" className="absolute left-[11px] top-1/2 h-[8px] w-[8px] -translate-y-1/2 rounded-full" style={{ background: KIT.dark }} />
      <span className="relative">{label}</span>
      <span className="relative inline-flex">
        <KitGem size={big ? 22 : 18} />
      </span>
      <span className="relative tabular-nums">{price}</span>
    </motion.button>
  );
}

/* The practice on offer: a paper tag with the trait and the level it takes
   that trait to. */
function PracticeTag({ trait, level, height }: { trait: (typeof CHAIN_TRAITS)[number]; level: number; height: number }) {
  const { i18n } = useLingui();
  return (
    <div
      className="flex flex-col items-center justify-center rounded-[10px] px-3 text-center"
      style={{ height, minWidth: height * 1.15, background: KIT.cream, color: KIT.dark, boxShadow: "0 4px 0 rgba(0,0,0,0.35)" }}
    >
      <div className="leading-none" style={{ fontFamily: MARKER, fontSize: Math.round(height * 0.24) }}>
        {i18n._(CHAIN_TRAIT_WORD[trait])}
      </div>
      <div className="mt-1 leading-none tabular-nums" style={{ fontFamily: MARKER, fontSize: Math.round(height * 0.2) }}>
        +{level}{" "}
        <svg width="0.9em" height="0.6em" viewBox="0 0 18 12" aria-hidden="true" className="inline-block align-middle opacity-50">
          <path d="M1 6 H15 M10 1.5 L15.5 6 L10 10.5" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>{" "}
        +{level + 1}
      </div>
    </div>
  );
}

/* A dark halo round the offers' names and lines, so the garland's thread
   (drawn behind them) never runs through a letter. */
const SHOP_TEXT_HALO = "0 0 3px #120c18, 0 0 6px #120c18, 0 0 10px rgba(18,12,24,0.8)";

/* Where the desktop shop's scroll box starts: under the table's title
   (top 26, 38px marker). */
const SHOP_TOP = 72;

/* The cord the offers hang from, drawn as a thread: a thin cream strand
   with a darker twist running along it and a soft shadow under it. */
function Thread({ d }: { d: string }) {
  return (
    <g fill="none">
      <path d={d} stroke="rgba(0,0,0,0.35)" strokeWidth={2.6} strokeLinecap="round" transform="translate(0 3)" />
      <path d={d} stroke="#e9dcc2" strokeWidth={2} strokeLinecap="round" />
      <path d={d} stroke="#a8946f" strokeWidth={2} strokeDasharray="1.4 2.6" />
    </g>
  );
}

/* Where an offer hangs from the shop's chain: a short cord and the ring the
   garland passes through. `reach` runs the cord that much further down, into
   a charm's bail: the offer paints over it, so it shows only through the
   bail's hole. */
function Hanger({ reach = 0 }: { reach?: number }) {
  const end = 30 + reach;
  return (
    <svg width={20} height={30} viewBox="0 0 20 30" className="-mb-1 shrink-0 overflow-visible" aria-hidden="true">
      <Thread d={`M10 6 L10 ${end}`} />
      <circle data-hanger="" cx={10} cy={6} r={5.5} fill={KIT.dark} stroke={KIT.cream} strokeWidth={2.2} />
    </svg>
  );
}

/* The chain the offers hang from: sagging arcs between their rings, out to
   both edges, measured from the rings so it follows the stock as it deals,
   sells and rerolls. */
function Garland({ deps }: { deps: unknown[] }) {
  const [path, setPath] = useState<{ d: string; w: number; h: number; top: number } | null>(null);
  /* Measured from its own row (the parent): a parent's ref is not set yet
     when a child's layout effect first runs. */
  const anchorRef = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const row = anchorRef.current?.parentElement;
    if (!row) return;
    let frame = 0;
    const measure = () => {
      const box = row.getBoundingClientRect();
      const points = [...row.querySelectorAll<SVGCircleElement>("[data-hanger]")]
        .map((ring) => ring.getBoundingClientRect())
        .filter((rect) => rect.width > 0)
        .map((rect) => [rect.left + rect.width / 2 - box.left, rect.top + rect.height / 2 - box.top] as const)
        .sort((a, b) => a[0] - b[0]);
      if (points.length < 2) {
        setPath(null);
        return;
      }
      const top = Math.min(...points.map((point) => point[1]));
      const ends = [[points[0][0] - 120, top - 18] as const, ...points, [points[points.length - 1][0] + 120, top - 18] as const];
      let d = `M${ends[0][0]} ${ends[0][1]}`;
      for (let index = 1; index < ends.length; index += 1) {
        const [x0, y0] = ends[index - 1];
        const [x1, y1] = ends[index];
        d += ` Q ${(x0 + x1) / 2} ${Math.max(y0, y1) + 26} ${x1} ${y1}`;
      }
      setPath({ d, w: box.width, h: box.height, top });
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    schedule();
    // The stock deals in with springs; follow it until it settles.
    const settle = window.setInterval(measure, 120);
    const stop = window.setTimeout(() => window.clearInterval(settle), 1600);
    const observer = new ResizeObserver(schedule);
    observer.observe(row);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(settle);
      window.clearTimeout(stop);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return (
    <svg ref={anchorRef} className="pointer-events-none absolute left-0 top-0 -z-10 overflow-visible" width={path?.w ?? 0} height={path?.h ?? 0} aria-hidden="true">
      {path && <Thread d={path.d} />}
    </svg>
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
      {/* The pouch is cut to its own shape, so its shadow follows it. */}
      <div className="run-pack-bob absolute inset-0" style={{ filter: "drop-shadow(3px 8px 6px rgba(0,0,0,0.55))" }}>
        {thumb && <img src={thumb} alt="" draggable={false} className="h-full w-full object-contain" />}
        {/* A chart pack wears its map's cover on the front. */}
        {offer.kind === "chart" && offer.chartCover && (
          <img
            src={offer.chartCover}
            alt=""
            draggable={false}
            className="absolute left-1/2 top-[34%] -translate-x-1/2 rounded-[6px] object-cover"
            style={{ width: width * 0.62, height: width * 0.62, boxShadow: "0 0 0 2px #ffd36b, 0 4px 10px rgba(0,0,0,0.5)" }}
          />
        )}
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
  /* The charms and mods in the table's bottom-left corner sit over the
     shop; scrolled to the end, the stock's last line (the buttons) clears
     them. */
  const [cornerHeight, setCornerHeight] = useState(0);
  useEffect(() => {
    if (layout.narrow) return;
    const corner = document.querySelector<HTMLElement>("[data-chain-corner]");
    if (!corner) return;
    const read = () => setCornerHeight(corner.getBoundingClientRect().height);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(corner);
    return () => observer.disconnect();
  }, [layout.narrow]);
  const [floats, pushFloat] = useShardFloats();
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [rerolls, setRerolls] = useState(0);
  /* A contract tap shows signed (or unsigned) at once; the server's answer
     takes over once every tap has landed. */
  const [signedNow, setSignedNow] = useState<{ contract: ChainContract | null } | null>(null);
  const signsInFlight = useRef(0);
  /* The reel playing over the shop after a bought spin. */
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
  const [removeX, shudderRemove] = useShudder(reducedMotion);
  const [rerollX, shudderReroll] = useShudder(reducedMotion);
  const packHeight = narrow ? 112 : Math.min(200, layout.height * 0.22);

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
      if (outcome.error !== "stale" && outcome.error !== "coach") {
        setMessage(chainRefusalMessage(outcome.error ?? "failed", i18n));
        window.setTimeout(() => setMessage(null), SHOP_FEEL.messageMs);
      }
      return false;
    }
    if (price) floatAtShards(-price);
    if (action.kind === "sign") {
      runSound.uiTap();
      shake(0.3);
      return true;
    }
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

  const sign = async (index: number) => {
    const picked = shop?.contracts?.[index];
    if (!picked) return;
    // The engine's toggle: the same contract again unsigns it.
    const current = signedNow ? signedNow.contract : view.contract;
    const same = current && current.id === picked.id && JSON.stringify(current.prize) === JSON.stringify(picked.prize);
    setSignedNow({ contract: same ? null : { id: picked.id, prize: { ...picked.prize } } });
    runSound.uiTap();
    shake(0.3);
    signsInFlight.current += 1;
    const outcome = await act({ kind: "sign", index });
    signsInFlight.current -= 1;
    if (signsInFlight.current === 0) setSignedNow(null);
    if (!outcome.ok && outcome.error !== "stale" && outcome.error !== "coach") {
      runSound.refuse();
      setMessage(chainRefusalMessage(outcome.error ?? "failed", i18n));
      window.setTimeout(() => setMessage(null), SHOP_FEEL.messageMs);
    }
  };

  if (!shop) return null;
  const deck = view.deck;
  return (
    <div data-chain-shop="" className="absolute inset-0">

      {/* Scrolls when the stock runs taller than the screen. It starts under
          the table's title, so the stock scrolls beneath it instead of over
          it. */}
      <div
        className="absolute inset-x-0 bottom-0 overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,transparent,black_14px)]"
        style={{ top: narrow ? 40 : SHOP_TOP }}
      >
        <motion.div
          className="absolute inset-x-0 flex flex-col items-center"
          style={{ top: narrow ? 0 : Math.max(0, Math.max(20, layout.height * 0.08) + 32 - SHOP_TOP), paddingBottom: 24 + cornerHeight }}
          initial={reducedMotion ? false : { y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ ...SHOP_FEEL.panel.spring, delay: lead }}
        >

          {/* Packs and the scene card on offer. */}
          {/* A fixed height on a phone, so the buttons under the stock do not
              jump while it rerolls. */}
          <div
            className={`relative isolate mt-5 flex flex-wrap items-end justify-center ${narrow ? "content-start gap-x-4 gap-y-5" : "gap-12"}`}
            style={narrow ? { minHeight: 372 } : undefined}
          >
            {!narrow && <Garland deps={[rerolls, shop.offers.map((offer) => offer.sold).join(), shop.scene, layout.width]} />}
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
                    {!narrow && <Hanger />}
                    <PackOffer offer={offer} thumb={crispPackUrl(chainPackType("shop", offer)) ?? packThumbs[chainPackType("shop", offer)] ?? null} height={packHeight} reducedMotion={reducedMotion} />
                    <div className="leading-none text-[#f3e9d8]" style={{ fontFamily: MARKER, fontSize: narrow ? 14 : 19, textShadow: SHOP_TEXT_HALO }}>
                      {chainOfferName(offer, i18n)}
                    </div>
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
                  {/* The gap to the medallion (gap-2 less the hanger's -mb-1),
                      then down to the middle of its bail's hole. */}
                  {!narrow && <Hanger reach={4 + Math.round(packHeight * 0.92 * 0.135)} />}
                  <motion.div
                    ref={sceneArtRef}
                    whileHover={reducedMotion ? undefined : { rotate: 3, scale: 1.05 }}
                    transition={{ type: "spring", stiffness: 400, damping: 22 }}
                  >
                    <SceneMedallion size={narrow ? 104 : Math.round(packHeight * 0.92)}>
                      <SceneArt id={SCENE_ART_ID[shop.scene]} size={Math.round((narrow ? 104 : packHeight * 0.92) * 0.48)} />
                    </SceneMedallion>
                  </motion.div>
                  <div className="text-center" style={{ textShadow: SHOP_TEXT_HALO }}>
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

            <AnimatePresence mode="popLayout">
              {shop.practice && !shop.practice.sold && (
                <motion.div
                  key={`practice-${shop.practice.trait}-${rerolls}`}
                  className={`flex flex-col items-center gap-2 ${narrow ? "w-[150px]" : "w-[190px]"}`}
                  initial={reducedMotion ? false : { y: SHOP_FEEL.deal.fromY, scale: SHOP_FEEL.deal.fromScale, opacity: 0 }}
                  animate={{ y: 0, scale: 1, opacity: 1 }}
                  exit={{ y: -80, scale: 0.5, opacity: 0, transition: { duration: 0.25 } }}
                  transition={{ ...SHOP_FEEL.deal.spring, delay: lead + (3.5 * SHOP_FEEL.deal.staggerMs) / 1000 }}
                >
                  {!narrow && <Hanger />}
                  <PracticeTag trait={shop.practice.trait} level={view.levels[shop.practice.trait] ?? 0} height={narrow ? 84 : Math.round(packHeight * 0.68)} />
                  <div className="text-center" style={{ textShadow: SHOP_TEXT_HALO }}>
                    <div className={`font-black ${narrow ? "text-[13px]" : "text-[16px]"}`} style={{ color: KIT.gold }}>
                      <Trans>Practice</Trans>
                    </div>
                    <div className="mt-0.5 text-[12px] leading-snug text-osu-f1">{chainPracticeText(shop.practice.trait, i18n)}</div>
                  </div>
                  <PriceButton
                    affordable={CHAIN_RULES.practicePrice <= view.shards}
                    price={CHAIN_RULES.practicePrice}
                    label={<Trans>Buy</Trans>}
                    disabled={busy}
                    reducedMotion={reducedMotion}
                    onBuy={(shudder) => void run({ kind: "buy", item: "practice" }, CHAIN_RULES.practicePrice, shudder)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            {(shop.mods ?? []).map((offer, index) => (
              <AnimatePresence key={`mod-${index}-${rerolls}`} mode="popLayout">
                {!offer.sold && (
                  <motion.div
                    key={`mod-${offer.id}-${index}-${rerolls}`}
                    className={`flex flex-col items-center gap-2 ${narrow ? "w-[150px]" : "w-[170px]"}`}
                    initial={reducedMotion ? false : { y: SHOP_FEEL.deal.fromY, scale: SHOP_FEEL.deal.fromScale, opacity: 0 }}
                    animate={{ y: 0, scale: 1, opacity: 1 }}
                    exit={{ y: -80, scale: 0.5, opacity: 0, transition: { duration: 0.25 } }}
                    transition={{ ...SHOP_FEEL.deal.spring, delay: lead + ((4 + index * 0.5) * SHOP_FEEL.deal.staggerMs) / 1000 }}
                  >
                    {!narrow && <Hanger />}
                    <ModChip id={offer.id} size={narrow ? 76 : Math.round(packHeight * 0.58)} />
                    <div className="text-center" style={{ textShadow: SHOP_TEXT_HALO }}>
                      <div className={`font-black ${narrow ? "text-[13px]" : "text-[16px]"}`} style={{ color: chainModLook(offer.id, i18n).ink }}>
                        {chainModLook(offer.id, i18n).name}
                      </div>
                      <div className="mt-0.5 text-[12px] leading-snug text-osu-f1">{chainModLook(offer.id, i18n).text}</div>
                    </div>
                    <PriceButton
                      affordable={CHAIN_MODS.price[offer.id] <= view.shards && view.mods.length < CHAIN_MODS.slots}
                      price={CHAIN_MODS.price[offer.id]}
                      label={<Trans>Buy</Trans>}
                      disabled={busy}
                      reducedMotion={reducedMotion}
                      onBuy={(shudder) => void run({ kind: "buy", item: "mod", index }, CHAIN_MODS.price[offer.id], shudder)}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            ))}
          </div>

          {/* Mods held, waiting for a round. */}
          {view.mods.length > 0 && (
            <div className="mt-4 flex items-center gap-3 text-[13px] font-bold text-[#f3e9d8]/80">
              <Trans>Your mods</Trans>
              {view.mods.map((id, index) => (
                <ModChip key={`${id}-${index}`} id={id} size={28} />
              ))}
            </div>
          )}

          {/* The run's practice levels so far. */}
          {CHAIN_TRAITS.some((trait) => (view.levels[trait] ?? 0) > 0) && (
            <div className="mt-4 flex items-center gap-3 text-[13px] font-bold text-[#f3e9d8]/80">
              <Trans>Practice</Trans>
              {CHAIN_TRAITS.filter((trait) => (view.levels[trait] ?? 0) > 0).map((trait, index) => (
                <span key={trait} className="flex items-center gap-3">
                  {index > 0 && <span aria-hidden="true" className="h-3 w-px bg-[#f3e9d8]/30" />}
                  <span title={t`${i18n._(CHAIN_TRAIT_WORD[trait])} links add +${view.levels[trait] ?? 0} more each time they trigger.`}>
                    <Trans>
                      {i18n._(CHAIN_TRAIT_WORD[trait])} links <span style={{ color: KIT.gold }}>+{view.levels[trait]}</span>
                    </Trans>
                  </span>
                </span>
              ))}
            </div>
          )}

          {/* Interest paid when the next round is beaten. */}
          <div className="mt-4 text-[13px] font-bold text-[#f3e9d8]/80">
            {chainInterestFor(view.shards) > 0 ? (
              <Trans>
                Interest after the next round: <span style={{ color: KIT.gold }}>+{chainInterestFor(view.shards)}</span> (1 per {CHAIN_RULES.interestPer} shards, up to {CHAIN_RULES.interestMax})
              </Trans>
            ) : (
              <Trans>
                Hold {CHAIN_RULES.interestPer} shards to earn interest after the next round.
              </Trans>
            )}
          </div>

          {/* Next round's contracts. */}
          <div className={narrow ? "mt-6 w-full" : "mt-5"}>
            <ShopContracts
              contracts={shop.contracts ?? []}
              signed={signedNow ? signedNow.contract : view.contract}
              nextRound={view.round + 1}
              narrow={narrow}
              busy={false}
              delay={lead + (4 * SHOP_FEEL.deal.staggerMs) / 1000}
              reducedMotion={reducedMotion}
              onSign={(index) => void sign(index)}
            />
          </div>

          {/* Removing a card, the next round and a reroll, chained. */}
          <motion.div
            className="mt-6"
            initial={reducedMotion ? false : { scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 20, delay: lead + 0.4 }}
          >
            <ChainButtons
              compact={narrow}
              items={[
                {
                  key: "remove",
                  title: t`Remove a card (${CHAIN_RULES.removePrice} shards)`,
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Trans>Remove a card</Trans> <KitGem size={18} /> {CHAIN_RULES.removePrice}
                    </span>
                  ),
                  icon: <IconCut size={narrow ? 26 : 30} />,
                  badge: CHAIN_RULES.removePrice,
                  muted: CHAIN_RULES.removePrice > view.shards,
                  disabled: busy || deck.length <= CHAIN_RULES.minDeck,
                  style: { x: removeX },
                  onClick: () => {
                    if (CHAIN_RULES.removePrice > view.shards) {
                      shudderRemove();
                      runSound.refuse();
                      return;
                    }
                    runSound.uiTap();
                    setRemoving(true);
                  },
                },
                {
                  key: "next",
                  primary: true,
                  title: t`Play round ${view.round + 1}`,
                  label: <Trans>Play round {view.round + 1}</Trans>,
                  disabled: busy,
                  onClick: () => {
                    runSound.uiTap();
                    void act({ kind: "nextRound" });
                  },
                },
                {
                  key: "reroll",
                  title: t`Reroll (${CHAIN_RULES.rerollPrice} shards)`,
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Trans>Reroll</Trans> <KitGem size={18} /> {CHAIN_RULES.rerollPrice}
                    </span>
                  ),
                  icon: <IconSwap ink={KIT.mint} size={narrow ? 26 : 30} />,
                  tone: KIT.mint,
                  badge: CHAIN_RULES.rerollPrice,
                  muted: CHAIN_RULES.rerollPrice > view.shards,
                  disabled: busy,
                  style: { x: rerollX },
                  onClick: () => void run({ kind: "reroll" }, CHAIN_RULES.rerollPrice, shudderReroll),
                },
              ]}
            />
          </motion.div>

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
      </div>

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
                    aria-label={entry.card.eternal ? entry.card.name : t`Remove ${entry.card.name}`}
                    disabled={busy || entry.card.eternal}
                    className="relative block"
                    style={{ width: narrow ? 68 : 110, height: (narrow ? 68 : 110) * 1.4 }}
                    initial={reducedMotion ? false : { y: 30, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ scale: 0.3, opacity: 0, rotate: 12, transition: { duration: 0.3 } }}
                    transition={{ type: "spring", stiffness: 520, damping: 26, delay: index * 0.025 }}
                    whileHover={reducedMotion ? undefined : { y: -6, scale: 1.05 }}
                    onClick={async (event) => {
                      const button = event.currentTarget;
                      if (deck.length <= CHAIN_RULES.minDeck || entry.card.eternal) return;
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

/* The bought scene card's flight, drawn over the page from the shop to the
   scene card column, landing with a small pop. */
function FlightGhost({ flight, onDone }: { flight: { scene: ChainSceneId; from: DOMRect; to: DOMRect }; onDone: () => void }) {
  const { from, to } = flight;
  const box = document.querySelector<HTMLElement>("[data-chain-shop]")?.getBoundingClientRect();
  if (!box) return null;
  const size = from.width;
  return (
    <motion.div
      className="pointer-events-none absolute left-0 top-0 z-[40]"
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
      <SceneMedallion size={size}>
        <SceneArt id={SCENE_ART_ID[flight.scene]} size={Math.round(size * 0.48)} />
      </SceneMedallion>
    </motion.div>
  );
}
