import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useLingui } from "@lingui/react/macro";
import { CountryFlag } from "#/components/ui/CountryFlag";
import {
  CHAIN_SCENE_COPY,
  CHAIN_SCENE_INK,
  CHAIN_SCENE_NAMES,
  CHAIN_TIER_COLOR,
  CHAIN_TIER_LABEL,
  CHAIN_VARIANT_COPY,
  chainCardColor,
  chainCardFace,
  chainCardRarityLabel,
  chainSkillEffectText,
  formatChainScore,
  chainCardBaseText,
  chainSceneMultiplier,
  formatChainX,
  isChainTier,
  type ChainCardInstance,
  type ChainLink,
  type ChainLinkTrait,
  type ChainSceneHeld,
} from "#/lib/chain-run";
import { CHAIN_FEEL } from "./chainFeel";
import { ChainCardFace } from "./ChainCardFace";
import { runSound } from "../runSound";
import { hasWysiText, WysiDigits } from "./Wysi";
import { firstWysiSight } from "./wysiSeen";

/* The one details card the table shows: a card's player, a scene card's full
   rule, or a link's traits. Hover (after a beat) on a mouse, long-press on
   touch. One module-level store so any piece of the table can raise it. */
export type ChainDetailsContent =
  | { kind: "card"; entry: ChainCardInstance }
  | { kind: "scene"; scene: ChainSceneHeld; ascension: number; startCombo: number; sell?: number }
  | { kind: "link"; link: ChainLink };

interface DetailsState {
  content: ChainDetailsContent;
  x: number;
  y: number;
  /* The element it is about, for placing a card's panel beside it. */
  rect: { left: number; right: number; top: number; bottom: number };
  key: number;
}

let current: DetailsState | null = null;
let nextKey = 0;
const listeners = new Set<() => void>();

function emit(next: DetailsState | null) {
  current = next;
  listeners.forEach((listener) => listener());
}

export function showChainDetails(content: ChainDetailsContent, rect: DOMRect) {
  emit({ content, x: rect.left + rect.width / 2, y: rect.top, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, key: ++nextKey });
}

export function hideChainDetails() {
  if (current) emit(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* Pointer handlers that raise `content` over the element: once a mouse has
   rested on it for a beat (moving restarts the wait), after a long-press on
   touch (which also swallows the tap that would follow). `disabled` stops
   both. */
export function useChainDetailsTrigger(content: () => ChainDetailsContent | null, disabled = false) {
  const timer = useRef(0);
  const pressed = useRef(false);
  const rest = useRef<{ x: number; y: number; element: Element } | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const raise = useCallback((element: Element) => {
    const value = contentRef.current();
    if (value) showChainDetails(value, element.getBoundingClientRect());
  }, []);
  const wait = useCallback(
    (element: Element) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        rest.current = null;
        raise(element);
      }, CHAIN_FEEL.move.hoverDetailsMs);
    },
    [raise],
  );
  const onPointerEnter = useCallback(
    (event: React.PointerEvent) => {
      if (disabled || event.pointerType === "touch") return;
      rest.current = { x: event.clientX, y: event.clientY, element: event.currentTarget };
      wait(event.currentTarget);
    },
    [disabled, wait],
  );
  /* Still waiting and the pointer moved on: wait again from here. */
  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const at = rest.current;
      if (!at || event.pointerType === "touch") return;
      if (Math.hypot(event.clientX - at.x, event.clientY - at.y) < CHAIN_FEEL.move.hoverStillPx) return;
      rest.current = { ...at, x: event.clientX, y: event.clientY };
      wait(at.element);
    },
    [wait],
  );
  const onPointerLeave = useCallback(() => {
    window.clearTimeout(timer.current);
    rest.current = null;
    hideChainDetails();
  }, []);
  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      pressed.current = false;
      rest.current = null;
      window.clearTimeout(timer.current);
      if (disabled || event.pointerType !== "touch") {
        hideChainDetails();
        return;
      }
      const element = event.currentTarget;
      timer.current = window.setTimeout(() => {
        pressed.current = true;
        raise(element);
      }, CHAIN_FEEL.move.longPressMs);
    },
    [disabled, raise],
  );
  const cancelPress = useCallback(() => window.clearTimeout(timer.current), []);
  /* True once, right after a long-press raised the details. */
  const consumeLongPress = useCallback(() => {
    const was = pressed.current;
    pressed.current = false;
    return was;
  }, []);
  return { onPointerEnter, onPointerMove, onPointerLeave, onPointerDown, onPointerUp: cancelPress, onPointerCancel: cancelPress, consumeLongPress };
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <span className="text-osu-f1">{label}</span>
      <span className="text-right font-bold tabular-nums">{children}</span>
    </>
  );
}

function TraitChip({ trait }: { trait: ChainLinkTrait }) {
  const { i18n } = useLingui();
  if (trait.trait === "scene" && trait.scene) {
    return (
      <span className="rounded px-1.5 py-0.5 text-[12px] font-black" style={{ background: CHAIN_SCENE_INK[trait.scene], color: "#120f1a" }}>
        {CHAIN_SCENE_NAMES[trait.scene]}
      </span>
    );
  }
  const label = trait.trait === "tier" && isChainTier(trait.value) ? i18n._(CHAIN_TIER_LABEL[trait.value]) : trait.value;
  const fill = trait.trait === "tier" && isChainTier(trait.value) ? CHAIN_TIER_COLOR[trait.value].ink : "#e9eef7";
  return (
    <span className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[12px] font-black" style={{ color: fill }}>
      {trait.trait === "cc" && <CountryFlag code={trait.value} size="xs" decorative />}
      {label}
    </span>
  );
}

export { TraitChip as ChainTraitChip };

function CardDetails({ entry }: { entry: ChainCardInstance }) {
  const { i18n } = useLingui();
  const card = chainCardFace(entry.card);
  const color = chainCardColor(card);
  /* The stats as shown; a 727 in any of them is lit, and the first sight of
     it in a run plays the stamp sound (no shards, no score). */
  const stats = {
    countryRank: card.countryRank ? `#${card.countryRank.toLocaleString("en-US")}` : card.cc,
    rank: card.rank !== null ? `#${card.rank.toLocaleString("en-US")}` : null,
    pp: Math.round(card.pp).toLocaleString("en-US"),
    plays: card.plays !== null ? card.plays.toLocaleString("en-US") : null,
    base: chainCardBaseText(card),
  };
  // What its skillset does, at its rarity's band.
  const skillEffect = chainSkillEffectText(card, i18n);
  const wysi = Object.values(stats).some((text) => text !== null && hasWysiText(text));
  useEffect(() => {
    if (wysi && firstWysiSight(card.id)) runSound.wysi(false);
  }, [card.id, wysi]);
  /* The card itself, bigger, in a frame of its rarity's colours, with its
     numbers beside it. */
  return (
    <div className="rounded-[14px] p-[3px]" style={{ background: `linear-gradient(150deg, ${color.ink}, ${color.fill} 45%, ${color.deep})` }}>
    <div className="flex gap-3 rounded-[11px] bg-[#0c0a10]/95 p-2.5">
    <div className="shrink-0" style={{ width: 132, height: 132 * 1.4 }}>
      <ChainCardFace card={entry.card} width={132} />
    </div>
    <div className="w-[200px] py-0.5">
      <div className="truncate text-[16px] font-black">{card.name}</div>
      <div className="text-[12px] font-bold" style={{ color: color.ink }}>
        {chainCardRarityLabel(card, i18n)}
      </div>
      {card.goat && (
        <div className="mt-1 text-[12px] text-osu-f1">
          <Trans>Links to the cards next to it on every trait. The first GOAT in a row doubles the combo.</Trans>
        </div>
      )}
      {card.eternal && !card.goat && (
        <div className="mt-1 text-[12px] text-osu-f1">
          <Trans>Never leaves your hand. Its base doubles every time it plays, for the rest of the run.</Trans>
          {(entry.card.doubled ?? 0) > 0 && (
            <span className="ml-1 font-black text-[#e9d5ff]">
              <Trans>Doubled {entry.card.doubled} times.</Trans>
            </span>
          )}
        </div>
      )}
      {card.variant && (
        <div className="mt-1.5 text-[12px] text-osu-f1">
          <span
            className="mr-1.5 inline-block rounded px-1 font-black italic"
            style={{ background: CHAIN_VARIANT_COPY[card.variant].fill, color: "#1a1020" }}
          >
            {CHAIN_VARIANT_COPY[card.variant].name}
          </span>
          {i18n._(CHAIN_VARIANT_COPY[card.variant].text)}
        </div>
      )}
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[12px]">
        <Row label={<Trans>Country</Trans>}>
          <span className="inline-flex items-center gap-1.5">
            <CountryFlag code={card.cc} size="xs" decorative />
            <WysiDigits text={stats.countryRank} />
          </span>
        </Row>
        {stats.rank !== null && (
          <Row label={<Trans>Global</Trans>}>
            <WysiDigits text={stats.rank} />
          </Row>
        )}
        <Row label={<Trans>Keymode</Trans>}>{card.key}K</Row>
        <Row label={<Trans>Top skillset</Trans>}>{card.skill}</Row>
        <Row label="pp">
          <WysiDigits text={stats.pp} />
        </Row>
        {stats.plays !== null && (
          <Row label={<Trans>Plays</Trans>}>
            <WysiDigits text={stats.plays} />
          </Row>
        )}
        {card.acc !== null && <Row label={<Trans>Accuracy</Trans>}>{card.acc.toLocaleString("en-US", { maximumFractionDigits: 2 })}%</Row>}
        <Row label={<Trans>Base</Trans>}>
          <WysiDigits text={stats.base} />
          {card.grown ? <span className="ml-1 text-[11px] font-bold text-[#8ff2b7]">(+{card.grown})</span> : null}
        </Row>
      </div>
      {skillEffect && (
        <div className="mt-2 border-t border-white/[0.07] pt-2 text-[12px] leading-snug text-white/85">
          <span className="mr-1.5 font-black text-[#8ff2b7]">{card.skill === "Speed" ? "Stream" : card.skill}</span>
          {skillEffect}
        </div>
      )}
      {entry.pack && (
        <div className="mt-2 border-t border-white/[0.07] pt-2 text-[11px] text-osu-f1">
          <Trans>From this round's pack. Used up once played.</Trans>
        </div>
      )}
    </div>
    </div>
    </div>
  );
}

function SceneDetails({ scene, ascension, startCombo, sell }: { scene: ChainSceneHeld; ascension: number; startCombo: number; sell?: number }) {
  const { i18n } = useLingui();
  return (
    <div className="w-[250px]">
      <div className="text-[16px] font-black" style={{ color: CHAIN_SCENE_INK[scene.id] }}>
        {CHAIN_SCENE_NAMES[scene.id]}
      </div>
      <div className="mt-1.5 text-[12px] leading-snug text-white/90">{i18n._(CHAIN_SCENE_COPY[scene.id].text)}</div>
      {scene.id === "ascension" && ascension > 0 && (
        <div className="mt-2 text-[12px] font-bold tabular-nums">
          <Trans>Now x{formatChainX(ascension)}</Trans>
        </div>
      )}
      {(scene.id === "galaxy" || scene.id === "sidetracked") && (
        <div className="mt-2 text-[12px] font-bold tabular-nums">
          <Trans>Now x{formatChainX(chainSceneMultiplier({ scenes: [scene] }, scene.id))}</Trans>
        </div>
      )}
      {scene.id === "forgotten" && startCombo > 1 && (
        <div className="mt-2 text-[12px] font-bold tabular-nums">
          <Trans>Rows start at combo {startCombo}</Trans>
        </div>
      )}
      {sell !== undefined && (
        <div className="mt-2 border-t border-white/[0.07] pt-2 text-[12px] font-bold text-osu-pink-light">
          <Trans>Sells for {sell} shards</Trans>
        </div>
      )}
    </div>
  );
}

function LinkDetails({ link }: { link: ChainLink }) {
  if (link.broken) {
    return (
      <div className="text-[12px] font-bold text-[#ff7a7a]">
        <Trans>These two share nothing.</Trans>
      </div>
    );
  }
  return (
    <div className="max-w-[240px]">
      <div className="flex flex-wrap gap-1">
        {link.traits.map((trait, index) => (
          <TraitChip key={`${trait.trait}-${index}`} trait={trait} />
        ))}
      </div>
      <div className="mt-1.5 text-[12px] font-bold tabular-nums text-osu-f1">
        <Trans>Combo +{formatChainScore(link.strength)}</Trans>
      </div>
      {link.fires > 1 && (
        <div className="text-[11px] text-osu-f1">
          <Trans>Fires {link.fires} times in a hand.</Trans>
        </div>
      )}
    </div>
  );
}

/* The details card itself, above whatever raised it, kept on screen. */
export function ChainDetailsLayer() {
  const state = useSyncExternalStore(subscribe, () => current, () => null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const hide = () => hideChainDetails();
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      hideChainDetails();
    };
  }, []);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !state) return;
    // The layout size, not the drawn one: the panel is still scaled down as
    // it pops in, and a tall one placed by that measure ran off the page.
    const rect = { width: box.offsetWidth, height: box.offsetHeight };
    let left: number;
    let top: number;
    if (state.content.kind === "card") {
      // Beside the card, on the side with more room, its top level with the
      // card's: never over the row's buttons above a hand card.
      const roomRight = window.innerWidth - state.rect.right;
      const roomLeft = state.rect.left;
      const fitsSide = Math.max(roomRight, roomLeft) >= rect.width + 16;
      if (fitsSide) {
        left = roomRight >= roomLeft ? state.rect.right + 12 : state.rect.left - rect.width - 12;
        top = Math.min(window.innerHeight - rect.height - 8, state.rect.top);
      } else {
        left = state.x - rect.width / 2;
        top = state.y - rect.height - 10 < 68 ? state.rect.bottom + 10 : state.y - rect.height - 10;
      }
    } else {
      left = state.x - rect.width / 2;
      top = state.y - rect.height - 10 < 68 ? state.y + 12 : state.y - rect.height - 10;
    }
    left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, left));
    // Never past the bottom of the page, whichever way it was placed.
    top = Math.min(window.innerHeight - rect.height - 10, top);
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(68, top)}px`;
    box.style.visibility = "visible";
  }, [state]);
  return (
    <AnimatePresence>
      {state && (
        <motion.div
          key={state.key}
          ref={boxRef}
          role="tooltip"
          className={`pointer-events-none fixed z-[80] text-white ${state.content.kind === "card" ? "" : "rounded-lg bg-[#0c0a10]/95 px-3 py-2.5"}`}
          style={{ left: 0, top: 0, visibility: "hidden" }}
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.08 } }}
          transition={{ type: "spring", stiffness: 600, damping: 32 }}
        >
          {state.content.kind === "card" && <CardDetails entry={state.content.entry} />}
          {state.content.kind === "scene" && (
            <SceneDetails scene={state.content.scene} ascension={state.content.ascension} startCombo={state.content.startCombo} sell={state.content.sell} />
          )}
          {state.content.kind === "link" && <LinkDetails link={state.content.link} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
