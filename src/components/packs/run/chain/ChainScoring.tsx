import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  CHAIN_GOAT_COLOR,
  CHAIN_REEL_INK,
  CHAIN_SKILL_WORD,
  CHAIN_VARIANT,
  CHAIN_VARIANT_COPY,
  CHAIN_GOAT_LABEL,
  CHAIN_SCENE_INK,
  CHAIN_SCENE_NAMES,
  CHAIN_TIER_COLOR,
  CHAIN_TIER_LABEL,
  chainSkillShort,
  chainSkip727,
  formatChainScore,
  formatChainX,
  isChainSkill,
  isChainTier,
  type ChainRowEvent,
  type ChainRowResult,
  type ChainSceneId,
} from "#/lib/chain-run";
import { SceneArt } from "../sceneArt";
import { flameLevel } from "../RunFlame";
import { InkFlame } from "./InkFlame";
import { SceneMedallion } from "./chainKit";
import { SCENE_ART_ID } from "./ChainHud";
import { RUN_FEEL } from "../runFeel";
import { juice, punch } from "../runJuice";
import { runSound } from "../runSound";
import { playGoatFanfare } from "../../packSfx";
import type { LinkFx } from "./ChainBoard";
import { CHAIN_FEEL, chainStepMs } from "./chainFeel";
import { WYSI_INK, WysiDigits, WysiMoment } from "./Wysi";

/* The row playing out, one event at a time, from the server's own list:
   every trait of every link adds to the combo and lights its link, every
   card scores base x combo and pops its points, breaks shake their link red,
   hands and scene cards jiggle the scene card that fired, row multipliers
   land big, and Echoes' second pass sweeps the row again. A 727 (the
   engine's "wysi" event) freezes the chain, lights its digits, plays its
   clip and bursts before the combo jumps. The running total
   counts up over the row; at the end it holds, flies into the round score
   and slams. A tap or Enter speeds it up x3, a second one skips to the slam. */

const POINTS = "#fff3d6";
const COMBO = "#ff66aa";
const GOLD = "#ffd36b";
// MAX's word: the rainbow 300's colours.
const MAX_INK = "linear-gradient(100deg, #ff9fd8 0%, #ffe07a 30%, #a5f3c4 55%, #8fd8ff 78%, #d2c2ff 100%)";
const ECHO = "#8fe3ff";
const RED = "#ff5a5a";
const OUTLINE = "#120f1a";
const TRAIT_INK: Record<string, string> = { cc: "#7fd3ff", key: "#ffd36b", skill: "#8ff2b7" };

const msgBreak = msg`BREAK`;
const msgHand = msg`HAND`;
const msgHalf = msg`HALF`;
const msgWarmup = msg`Warm-up`;
const msgReplay = msg`REPLAY`;
const SKILL_INK = "#8ff2b7";

type FloatSize = "trait" | "points" | "word" | "big";

interface FloatItem {
  id: number;
  anchor: string;
  x: number;
  y: number;
  text: string;
  fill: string;
  size: FloatSize;
  lifeMs: number;
  place: "above" | "below" | "center";
}

const FLOAT_SIZE: Record<FloatSize, string> = {
  trait: "text-[15px] md:text-[22px]",
  points: "text-[22px] md:text-[38px]",
  word: "text-[22px] md:text-[34px]",
  big: "text-[54px] md:text-[96px]",
};
const FLOAT_STROKE: Record<FloatSize, number> = { trait: 4, points: 6, word: 6, big: 9 };

function Float({ item, reducedMotion }: { item: FloatItem; reducedMotion: boolean }) {
  const translate = item.place === "above" ? "-50%, -100%" : item.place === "below" ? "-50%, 0" : "-50%, -50%";
  const rise = item.place === "below" ? 14 : item.size === "big" ? -10 : -26;
  const gradient = item.fill.startsWith("linear-gradient");
  /* Kept inside the table: a word placed near an edge (MAX x2, GOAT x2
     beside a wide total) slides back in, with room for its 1.22 pop. */
  const boxRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    // The visible span: the page, narrowed by every clipping ancestor.
    let left = 0;
    let right = document.documentElement.clientWidth;
    for (let node = box.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === "visible") continue;
      const bounds = node.getBoundingClientRect();
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    const margin = 10 + rect.width * 0.11;
    left += margin;
    right -= margin;
    if (rect.right > right) setShift(right - rect.right);
    else if (rect.left < left) setShift(left - rect.left);
  }, []);
  return (
    <div
      ref={boxRef}
      data-float={item.anchor}
      className={`pointer-events-none absolute ${item.size === "big" ? "z-[8]" : "z-[6]"}`}
      style={{ left: item.x + shift, top: item.y, transform: `translate(${translate})` }}
    >
      <motion.div
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.35, y: 0 }}
        animate={reducedMotion ? { opacity: [0, 1, 1, 0] } : { opacity: [0, 1, 1, 0], scale: [0.35, 1.22, 1, 1], y: [0, rise * 0.25, rise * 0.7, rise] }}
        exit={{ opacity: 0, transition: { duration: 0.08 } }}
        transition={{ duration: item.lifeMs / 1000, times: [0, 0.14, 0.62, 1], ease: "easeOut" }}
        className={`whitespace-nowrap font-black italic leading-none tabular-nums ${FLOAT_SIZE[item.size]}`}
        style={gradient ? { position: "relative" } : { color: item.fill, WebkitTextStroke: `${FLOAT_STROKE[item.size]}px ${OUTLINE}`, paintOrder: "stroke fill" }}
      >
        {gradient ? (
          // A gradient word (MAX): the outline drawn under, the fill clipped
          // to the glyphs on top.
          <>
            {/* Padded, so the fill reaches the italic slant past the box. */}
            <span className="px-[0.14em]" style={{ color: OUTLINE, WebkitTextStroke: `${FLOAT_STROKE[item.size]}px ${OUTLINE}` }}>
              {item.text}
            </span>
            <span className="absolute inset-0 px-[0.14em]" style={{ backgroundImage: item.fill, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
              {item.text}
            </span>
          </>
        ) : (
          <WysiDigits text={item.text} />
        )}
      </motion.div>
    </div>
  );
}

export interface ChainScoringProps {
  row: ChainRowResult;
  /* The row's players by position, for the step's reason under the total. */
  names: string[];
  /* The round before the row: its score and target. */
  roundBefore: number;
  target: number;
  /* Where the row's total sits (viewport px): centred on this point. */
  readoutAt: () => { x: number; y: number; size: number; top?: number; narrow?: boolean } | null;
  reducedMotion: boolean;
  /* Dev fixtures: land on the slam straight away. */
  skip?: boolean;
  onLinkFx: (update: (current: Record<string, LinkFx>) => Record<string, LinkFx>) => void;
  onCardCombo: (index: number, combo: number) => void;
  onHandLit: (hand: number) => void;
  onShake: (amount: number) => void;
  /* The row's total landed on the round score. */
  onSlam: (roundScore: number) => void;
  /* The room heats as the chain builds: "mod" once the combo runs high,
     "fire" once the row has the round past its target. */
  onHeat: (heat: "mod" | "fire") => void;
  /* The running total, as it counts. */
  onRunning: (total: number) => void;
  /* The chain just carried the round past its target. */
  onCross: () => void;
  onDone: () => void;
}

type Stage = "steps" | "total" | "fly" | "landed";

function linkKey(event: { skip: boolean; link: number; to: number }): string {
  return event.skip ? `s${event.to}` : `l${event.link}`;
}

/* The link fx at rest before a pass: every link pending, nothing added. */
function pendingFx(row: ChainRowResult): Record<string, LinkFx> {
  const fx: Record<string, LinkFx> = {};
  row.links.forEach((_, index) => (fx[`l${index}`] = { state: "pending", value: 0, pulse: 0 }));
  row.skips.forEach((skip) => (fx[`s${skip.to}`] = { state: "pending", value: 0, pulse: 0 }));
  return fx;
}

/* Where the row ends up once every event has played. */
function finalState(row: ChainRowResult) {
  const lastPass = row.events.reduce((pass, event) => Math.max(pass, "pass" in event && typeof event.pass === "number" ? event.pass : 0), 0);
  const fx = pendingFx(row);
  const combos: Record<number, number> = {};
  for (const event of row.events) {
    if (event.kind === "link" && event.pass === lastPass) {
      const key = linkKey(event);
      fx[key] = { state: "lit", value: (fx[key]?.value ?? 0) + event.add, pulse: 0 };
    } else if (event.kind === "break" && event.pass === lastPass) {
      fx[`l${event.link}`] = { state: "broken", value: 0, pulse: 0 };
    } else if (event.kind === "card") {
      combos[event.index] = event.combo;
    }
  }
  return { fx, combos };
}

export function ChainScoring(props: ChainScoringProps) {
  const { row, roundBefore, target, reducedMotion, skip = false } = props;
  const { i18n } = useLingui();
  const [stage, setStage] = useState<Stage>("steps");
  // Warm-up is in the row's start; the combo shows it landing.
  const warmup = row.events.find((event) => event.kind === "boost" && event.id === "warmup");
  const [running, setRunning] = useState({ total: 0, combo: row.start - (warmup && warmup.kind === "boost" && warmup.id === "warmup" ? warmup.add : 0), broke: 0 });
  const [floats, setFloats] = useState<FloatItem[]>([]);
  const [totalW, setTotalW] = useState(0);
  const [reason, setReason] = useState<{ id: number; text: string; fill: string } | null>(null);
  const [stamps, setStamps] = useState<Array<{ id: number; scene: ChainSceneId; x: number; y: number; size: number }>>([]);
  const [sweep, setSweep] = useState<{ id: number; x: number; y: number; w: number; h: number; dx: number } | null>(null);
  const [wysi, setWysi] = useState<{ id: number; event: Extract<ChainRowEvent, { kind: "wysi" }>; holdMs: number } | null>(null);
  const [readout, setReadout] = useState<{ x: number; y: number; size: number; top?: number; narrow?: boolean } | null>(null);
  const [fly, setFly] = useState<{ x: number; y: number; scale: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const totalRef = useRef<HTMLDivElement>(null);
  const comboRef = useRef<HTMLSpanElement>(null);
  const clockRef = useRef({ speed: 1, skip, stage: "steps" as Stage });
  const propsRef = useRef(props);
  propsRef.current = props;

  /* A tap anywhere (bar the buttons) or Space/Enter: x3, then the slam. */
  useEffect(() => {
    const bump = () => {
      const clock = clockRef.current;
      if (clock.stage !== "steps" || clock.skip) return;
      if (clock.speed === 1) clock.speed = CHAIN_FEEL.chain.fastForward;
      else clock.skip = true;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, a, input, [role='dialog']")) return;
      bump();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      bump();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    const timers: number[] = [];
    const clock = clockRef.current;
    const feel = CHAIN_FEEL.chain;
    let floatId = 0;
    let sweepId = 0;
    let burstId = 0;
    const p = () => propsRef.current;

    const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const enter = (next: Stage) => {
      clock.stage = next;
      setStage(next);
    };
    const hold = (ms: number, skippable = true) =>
      new Promise<void>((resolve) => {
        if (ms <= 0) return resolve();
        let elapsed = 0;
        let last = performance.now();
        const tick = (now: number) => {
          if (cancelled) return resolve();
          elapsed += Math.max(0, now - last) * clock.speed;
          last = Math.max(last, now);
          if (elapsed >= ms || (skippable && clock.skip)) return resolve();
          frame = window.requestAnimationFrame(tick);
        };
        frame = window.requestAnimationFrame(tick);
      });
    const origin = () => overlayRef.current?.getBoundingClientRect() ?? null;
    const rectOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 ? { element, rect } : null;
    };
    const cardEl = (index: number) => rectOf(`[data-chain-card="${row.uids[index]}"]`);
    const sceneEl = (id: string) => {
      const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-chain-scene="${id}"]`)).filter((element) => element.offsetParent !== null);
      const element = all[0];
      return element ? { element, rect: element.getBoundingClientRect() } : null;
    };

    const pop = (item: Omit<FloatItem, "id">, crowded: boolean) => {
      if (!item.text) return;
      const id = ++floatId;
      setFloats((current) => [
        ...current.filter((entry) => entry.anchor !== item.anchor && (!crowded || entry.size === "big")).slice(-12),
        { ...item, id },
      ]);
      later(item.lifeMs + 40, () => setFloats((current) => current.filter((entry) => entry.id !== id)));
    };
    const popAt = (target: { rect: DOMRect } | null, anchor: string, text: string, fill: string, size: FloatSize, holdMs: number, place: FloatItem["place"] = "above") => {
      const base = origin();
      if (!base || !target) return;
      const life = holdMs >= 200 ? feel.floatMs : Math.max(feel.floatMinMs, Math.round(feel.floatMs - (200 - holdMs) * 3));
      const x = target.rect.left - base.left + target.rect.width / 2;
      const y = place === "below" ? target.rect.bottom - base.top + 4 : place === "center" ? target.rect.top - base.top + target.rect.height / 2 : target.rect.top - base.top - 4;
      pop({ anchor, x, y, text, fill, size, lifeMs: size === "big" ? Math.max(life, 900) : life, place }, holdMs < 240 || window.innerWidth < 700);
    };
    /* The box around every card in the row (the row snakes on a phone). */
    const rowBox = () => {
      const rects = row.uids.map((_, index) => cardEl(index)?.rect).filter(Boolean) as DOMRect[];
      if (!rects.length) return null;
      return {
        left: Math.min(...rects.map((rect) => rect.left)),
        right: Math.max(...rects.map((rect) => rect.right)),
        top: Math.min(...rects.map((rect) => rect.top)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
        cardW: rects[0].width,
      };
    };
    const popCentre = (text: string, fill: string, holdMs: number, beside = false) => {
      const base = origin();
      const box = rowBox();
      if (!base || !box) return;
      const readout = p().readoutAt();
      if (beside && readout && !readout.narrow) {
        // Beside the total and its combo, in the band above the row, so the
        // cards stay in view.
        const width = totalRef.current?.offsetWidth ?? readout.size * 3;
        const comboWidth = comboRef.current?.offsetWidth ?? readout.size;
        pop({ anchor: "centre", x: Math.min(base.width - 180, readout.x - base.left + width / 2 + comboWidth + 30 + 205), y: readout.y - base.top, text, fill, size: "big", lifeMs: Math.max(900, holdMs * 1.8), place: "center" }, false);
        return;
      }
      if (readout?.narrow) {
        // On a phone the big multiplier lands beside the total, off the cards.
        pop({ anchor: "centre", x: base.width - 46, y: readout.y - base.top, text, fill, size: "word", lifeMs: Math.max(720, holdMs * 1.6), place: "center" }, false);
        return;
      }
      pop({ anchor: "centre", x: (box.left + box.right) / 2 - base.left, y: (box.top + box.bottom) / 2 - base.top, text, fill, size: "big", lifeMs: Math.max(720, holdMs * 1.6), place: "center" }, false);
    };
    const fireScene = (id: string) => {
      const scene = sceneEl(id);
      if (scene && !reducedMotion) juice(scene.element, RUN_FEEL.juice.firingCharm);
      return scene;
    };
    const flashTrait = (index: number, trait: string) => {
      if (reducedMotion) return;
      const card = document.querySelector(`[data-chain-card="${row.uids[index]}"]`);
      const mark = card?.querySelector<HTMLElement>(`[data-trait="${trait}"]`);
      mark?.animate(
        [
          { transform: "scale(1)", filter: "brightness(1)" },
          // The tier mark is the card's whole edge, so it only brightens.
          { transform: trait === "tier" ? "scale(1)" : "scale(1.45)", filter: trait === "tier" ? "brightness(2.2)" : "brightness(1.7)" },
          { transform: "scale(1)", filter: "brightness(1)" },
        ],
        { duration: 300, easing: "ease-out" },
      );
    };
    const traitText = (trait: string, value: string, scene?: string) => {
      if (trait === "scene" && scene && scene in CHAIN_SCENE_NAMES) return CHAIN_SCENE_NAMES[scene as keyof typeof CHAIN_SCENE_NAMES];
      if (trait === "tier" && isChainTier(value)) return i18n._(CHAIN_TIER_LABEL[value]);
      if (trait === "skill" && isChainSkill(value)) return chainSkillShort(value);
      return value;
    };
    const traitFill = (trait: string, value: string, scene?: string) => {
      if (trait === "scene" && scene && scene in CHAIN_SCENE_INK) return CHAIN_SCENE_INK[scene as keyof typeof CHAIN_SCENE_INK];
      if (trait === "tier" && isChainTier(value)) return CHAIN_TIER_COLOR[value].ink;
      return TRAIT_INK[trait] ?? "#e9eef7";
    };
    const stepShake = (combo: number) => Math.min(feel.stepShakeMax, feel.stepShake + feel.stepShakePerCombo * combo);
    let shownTotal = 0;
    const countTo = (to: number, ms: number) => {
      p().onRunning(to);
      const from = shownTotal;
      shownTotal = to;
      if (ms <= 0 || reducedMotion) {
        setRunning((current) => ({ ...current, total: to }));
        return;
      }
      const start = performance.now();
      const tick = (now: number) => {
        if (cancelled) return;
        const k = Math.min(1, (now - start) / ms);
        // A count-up never shows a 727 the engine did not flag: it snaps past one.
        setRunning((current) => ({ ...current, total: chainSkip727(Math.round(from + (to - from) * (1 - (1 - k) ** 3)), to) }));
        if (k < 1) window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    };

    let reasonId = 0;
    const say = (text: string, fill: string) => setReason({ id: ++reasonId, text, fill });
    let stampId = 0;
    type StampAt = { kind: "card"; index: number } | { kind: "link"; key: string } | { kind: "row" };
    const stampOf = (event: ChainRowEvent): { key: string; scene: ChainSceneId; at: StampAt } | null => {
      switch (event.kind) {
        case "link":
          if (event.trait === "scene" && event.scene) return { key: `${event.scene}-${event.pass}`, scene: event.scene, at: { kind: "link", key: linkKey(event) } };
          if (event.scene === "duplicity") return { key: `duplicity-${event.pass}`, scene: "duplicity", at: { kind: "card", index: 1 } };
          if (event.scene === "foolMoon") return { key: `foolMoon-${event.pass}`, scene: "foolMoon", at: { kind: "card", index: row.fool ?? event.to } };
          if (event.skip) return { key: "tree", scene: "tree", at: { kind: "link", key: linkKey(event) } };
          return null;
        case "hand":
          return { key: `future-${event.pass}`, scene: "future", at: { kind: "card", index: event.cards[1] } };
        case "multiplier":
          return event.id === "dt" ? null : { key: `mult-${event.id}`, scene: event.id, at: { kind: "row" } };
        case "scene":
          return {
            key: `scene-${event.id}-${"pass" in event ? event.pass : 0}`,
            scene: event.id,
            at:
              event.id === "forgotten" || event.id === "halcyon"
                ? { kind: "card", index: 0 }
                : event.effect === "double"
                  ? { kind: "link", key: `l${event.link}` }
                  : { kind: "row" },
          };
        case "replay":
          return event.by === "freedomDive" ? { key: `freedomDive-${event.pass}`, scene: "freedomDive", at: { kind: "card", index: event.index } } : null;
        case "break":
          return event.scene ? { key: `${event.scene}-${event.pass}`, scene: event.scene, at: { kind: "link", key: `l${event.link}` } } : null;
        case "wysi":
          return null;
        case "card":
          if (event.halved) return { key: `makiba-half-${event.pass}`, scene: "makiba", at: { kind: "card", index: event.index } };
          return event.bonus ? { key: `lostRequiem-${event.pass}`, scene: "lostRequiem", at: { kind: "card", index: event.index } } : null;
        default:
          return null;
      }
    };
    /* The scene card's print stamps down onto what it touched. */
    const showStamp = (scene: ChainSceneId, at: StampAt) => {
      const base = origin();
      if (!base) return;
      const box = rowBox();
      let rect: { x: number; y: number } | null = null;
      let size = 0;
      const narrow = window.innerWidth < 700;
      const readout = p().readoutAt();
      if (narrow && readout) {
        // On a phone the prints stamp beside the total, never on the cards.
        rect = { x: base.left + 44, y: readout.y };
        size = 64;
      } else if (at.kind === "card") {
        const card = cardEl(at.index);
        if (card) {
          rect = { x: card.rect.left + card.rect.width / 2, y: card.rect.top + card.rect.height * 0.42 };
          size = Math.min(card.rect.width * 0.82, 130);
        }
      } else if (at.kind === "link") {
        const badge = rectOf(`[data-chain-link="${at.key}"]`);
        if (badge) {
          rect = { x: badge.rect.left + badge.rect.width / 2, y: badge.rect.top + badge.rect.height / 2 };
          size = narrow ? 72 : 104;
        }
      }
      if (!rect && box) {
        rect = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
        size = narrow ? 110 : 168;
      }
      if (!rect) return;
      const id = ++stampId;
      setStamps((current) => [...current.slice(-3), { id, scene, x: rect!.x - base.left, y: rect!.y - base.top, size }]);
      p().onShake(0.45);
      later(680, () => setStamps((current) => current.filter((entry) => entry.id !== id)));
    };

    /* The combo counting up to a doubling (a GOAT, a MAX card). */
    const riseCombo = (from: number, to: number, holdMs: number) => {
      if (reducedMotion) return;
      const start = performance.now();
      const span = Math.min(320, holdMs * 0.6);
      const tick = (now: number) => {
        if (cancelled) return;
        const k = Math.min(1, (now - start) / span);
        setRunning((current) => ({ ...current, combo: Math.round(from + (to - from) * (1 - (1 - k) ** 2)) }));
        if (k < 1) window.requestAnimationFrame(tick);
        else punch(comboRef.current, formatChainScore(to).length + 3);
      };
      window.requestAnimationFrame(tick);
    };

    const show = (event: ChainRowEvent, chain: number, holdMs: number) => {
      const fx = p();
      switch (event.kind) {
        case "link": {
          const key = linkKey(event);
          fx.onLinkFx((current) => {
            const entry = current[key] ?? { state: "pending", value: 0, pulse: 0 };
            // A link the first pass lit restarts its count when the second
            // pass reaches it.
            const from = entry.state === "half" ? 0 : entry.value;
            return { ...current, [key]: { state: "lit", value: from + event.add, pulse: entry.pulse + 1 } };
          });
          const badge = rectOf(`[data-chain-link="${key}"]`);
          popAt(badge, `link-${key}`, traitText(event.trait, event.value, event.scene), traitFill(event.trait, event.value, event.scene), "trait", holdMs, event.skip ? "below" : "center");
          say(traitText(event.trait, event.value, event.scene), traitFill(event.trait, event.value, event.scene));
          if (event.trait !== "scene") {
            flashTrait(event.from, event.trait);
            flashTrait(event.to, event.trait);
          }
          if (event.trait === "scene" && event.scene) {
            fireScene(event.scene);
            runSound.charmFire(chain);
          } else {
            runSound.stepCombo(chain);
          }
          if (event.fire > 0 && event.add === 1) fireScene("future");
          if (event.scene === "duplicity" && event.add === 1) fireScene("duplicity");
          fx.onShake(stepShake(event.combo));
          break;
        }
        case "break": {
          fx.onLinkFx((current) => ({ ...current, [`l${event.link}`]: { state: "broken", value: 0, pulse: (current[`l${event.link}`]?.pulse ?? 0) + 1 } }));
          const badge = rectOf(`[data-chain-link="l${event.link}"]`);
          popAt(badge, `link-l${event.link}`, i18n._(msgBreak), RED, "word", holdMs);
          say(i18n._(msgBreak), RED);
          if (event.anchor !== undefined) {
            // An Anchor card holds the combo it scored at.
            const anchor = cardEl(event.anchor);
            popAt(anchor, `anchor-${event.anchor}`, `${CHAIN_VARIANT_COPY.anchor.name} x${formatChainScore(event.combo)}`, CHAIN_VARIANT_COPY.anchor.ink, "trait", holdMs, "below");
          }
          runSound.stepMiss();
          fx.onShake(feel.breakShake);
          if (!reducedMotion) {
            const a = cardEl(event.from);
            const b = cardEl(event.to);
            if (a) juice(a.element, { amount: 0.12, rotateRad: 0.12 });
            if (b) juice(b.element, { amount: 0.12, rotateRad: 0.12 });
          }
          break;
        }
        case "card": {
          const card = cardEl(event.index);
          fx.onCardCombo(event.index, event.combo);
          popAt(card, `card-${event.index}`, `+${formatChainScore(event.points)}`, POINTS, "points", holdMs);
          say(p().names[event.index] ?? "", POINTS);
          if (event.halved) popAt(card, `half-${event.index}`, i18n._(msgHalf), CHAIN_SCENE_INK.makiba, "trait", holdMs, "below");
          else if (event.silver) popAt(card, `silver-${event.index}`, `SS x${formatChainX(event.silver)}`, CHAIN_VARIANT_COPY.silver.ink, "trait", holdMs, "below");
          else {
            // The card's skillset at work, under it: one word for what it did.
            const word = event.late
              ? i18n._(CHAIN_SKILL_WORD.late)
              : event.hits === 2
                ? i18n._(CHAIN_SKILL_WORD.twice)
                : event.borrowed
                  ? i18n._(CHAIN_SKILL_WORD.borrow)
                  : event.x && event.x !== 1
                    ? `x${formatChainX(event.x)}`
                    : null;
            if (word) popAt(card, `skill-${event.index}`, word, SKILL_INK, "trait", holdMs, "below");
          }
          if (card && !reducedMotion) juice(card.element, RUN_FEEL.juice.scoringCard);
          if (event.pass > 0) runSound.stepAgain(chain);
          else runSound.stepNotes(chain);
          countTo(event.total, Math.min(holdMs * 0.8, 240));
          fx.onShake(stepShake(event.combo) + 0.05);
          break;
        }
        case "hand": {
          fx.onHandLit(event.hand);
          const middle = cardEl(event.cards[1]);
          popAt(middle, `hand-${event.hand}`, i18n._(msgHand), CHAIN_SCENE_INK.future, "word", holdMs, "below");
          say(`${i18n._(msgHand)} ${traitText(event.trait, event.value)}`, CHAIN_SCENE_INK.future);
          for (const index of event.cards) {
            const card = cardEl(index);
            if (card && !reducedMotion) juice(card.element, { amount: 0.16, rotateRad: 0.06 });
          }
          const scene = fireScene("future");
          if (scene) popAt(scene, "scene-future", i18n._(msgHand), CHAIN_SCENE_INK.future, "trait", holdMs, "below");
          runSound.charmFire(chain);
          fx.onShake(stepShake(event.combo) + 0.15);
          break;
        }
        case "scene": {
          if (event.effect === "carry") {
            // Halcyon: the row picks up where the last one ended.
            const scene = fireScene("halcyon");
            popAt(scene, "scene-halcyon", `+${formatChainScore(event.add)}`, CHAIN_SCENE_INK.halcyon, "word", holdMs, "below");
            popCentre(`x${formatChainScore(event.combo)}`, CHAIN_SCENE_INK.halcyon, holdMs, true);
            say(CHAIN_SCENE_NAMES.halcyon, CHAIN_SCENE_INK.halcyon);
            runSound.charmFire(chain);
            fx.onShake(feel.multiplierShake * 0.8);
            riseCombo(event.combo - event.add, event.combo, holdMs);
          } else if (event.effect === "double") {
            // Blue Zenith: a full link doubles the combo.
            const badge = rectOf(`[data-chain-link="l${event.link}"]`);
            popAt(badge, `zenith-${event.link}`, "x2", CHAIN_SCENE_INK.blueZenith, "word", holdMs, "below");
            fireScene("blueZenith");
            say(`${CHAIN_SCENE_NAMES.blueZenith} x2`, CHAIN_SCENE_INK.blueZenith);
            runSound.stepMultiplier(chain);
            fx.onShake(feel.multiplierShake * 0.9);
            riseCombo(event.from, event.combo, holdMs);
          } else if (event.id === "forgotten") {
            const scene = fireScene("forgotten");
            popAt(scene, "scene-forgotten", `+${event.combo - 1}`, CHAIN_SCENE_INK.forgotten, "word", holdMs, "below");
            say(CHAIN_SCENE_NAMES.forgotten, CHAIN_SCENE_INK.forgotten);
            runSound.charmFire(chain);
          } else {
            fireScene("echoes");
            say(CHAIN_SCENE_NAMES.echoes, ECHO);
            // The first pass's links stay half lit until pass two restamps them.
            fx.onLinkFx((current) => {
              const next: Record<string, LinkFx> = {};
              for (const [key, entry] of Object.entries(current)) next[key] = entry.state === "lit" ? { ...entry, state: "half" } : entry;
              return next;
            });
            runSound.stepAgain(chain);
            fx.onShake(feel.secondPassShake);
            // The second pass sweeps the row from its first card to its last.
            const base = origin();
            const box = rowBox();
            if (base && box && !reducedMotion) {
              const id = ++sweepId;
              setSweep({ id, x: box.left - base.left, y: box.top - base.top, w: box.cardW, h: box.bottom - box.top, dx: box.right - box.left - box.cardW });
              later(700, () => setSweep((current) => (current?.id === id ? null : current)));
            }
            for (let index = 0; index < row.uids.length; index += 1) {
              later(index * 70, () => {
                const card = cardEl(index);
                if (card && !reducedMotion) juice(card.element, { amount: 0.14, rotateRad: 0.05 });
              });
            }
          }
          break;
        }
        case "replay": {
          // A card plays again: a Replay card, or FREEDOM DiVE.
          const card = cardEl(event.index);
          const ink = event.by === "replay" ? CHAIN_VARIANT_COPY.replay.ink : CHAIN_SCENE_INK.freedomDive;
          popAt(card, `replay-${event.index}-${event.n}`, i18n._(msgReplay), ink, "word", holdMs, "below");
          say(event.by === "replay" ? CHAIN_VARIANT_COPY.replay.name : CHAIN_SCENE_NAMES.freedomDive, ink);
          if (event.by === "freedomDive") fireScene("freedomDive");
          if (card && !reducedMotion) juice(card.element, { amount: 0.2, rotateRad: 0.1 });
          runSound.stepAgain(chain);
          fx.onShake(stepShake(event.combo) + 0.1);
          break;
        }
        case "goat": {
          // The row's first GOAT doubles the combo before it scores.
          // The rarest beat in the game: the big centre word, the GOAT card
          // shaken hard, and the combo counting up to its double.
          const card = cardEl(event.index);
          popCentre(`${i18n._(CHAIN_GOAT_LABEL)} x2`, CHAIN_GOAT_COLOR.ink, holdMs, true);
          say(i18n._(CHAIN_GOAT_LABEL), CHAIN_GOAT_COLOR.ink);
          if (card && !reducedMotion) juice(card.element, { amount: 0.28, rotateRad: 0.16 });
          runSound.stepMultiplier(chain);
          runSound.charmFire(chain);
          playGoatFanfare();
          fx.onShake(feel.multiplierShake * 1.3);
          riseCombo(event.from, event.combo, holdMs);
          break;
        }
        case "skill": {
          // Stream lifts the combo after the link.
          const badge = rectOf(`[data-chain-link="l${event.link}"]`);
          popAt(badge, `lift-${event.link}`, `+${formatChainScore(event.add)}`, SKILL_INK, "trait", holdMs, "below");
          say(`${i18n._(CHAIN_SKILL_WORD.stream)} +${formatChainScore(event.add)}`, SKILL_INK);
          runSound.stepCombo(chain);
          fx.onShake(stepShake(event.combo));
          break;
        }
        case "boost": {
          // The reel's first-row boost firing: Warm-up's start, 727's start
          // (the 727 moment follows on its own), NF holding a link.
          const look = CHAIN_REEL_INK[event.id];
          if (event.id === "nf") {
            const badge = rectOf(`[data-chain-link="l${event.link}"]`);
            popAt(badge, `link-l${event.link}`, "NF", look, "word", holdMs);
            say("NF", look);
          } else if (event.id === "warmup") {
            popCentre(`+${event.add}`, look, holdMs, true);
            say(i18n._(msgWarmup), look);
          } else {
            say("727", look);
          }
          runSound.charmFire(chain);
          fx.onShake(stepShake(event.combo));
          break;
        }
        case "variant": {
          const look = CHAIN_VARIANT_COPY[event.variant];
          const card = cardEl(event.index);
          if (event.variant === "max") {
            // MAX doubles the combo: the GOAT's beat in rainbow, every time.
            popCentre(`${look.name} x${CHAIN_VARIANT.maxCombo}`, MAX_INK, holdMs, true);
            say(look.name, "#e6dcff");
            if (card && !reducedMotion) juice(card.element, { amount: 0.26, rotateRad: 0.14 });
            runSound.stepMultiplier(chain);
            runSound.charmFire(chain);
            fx.onShake(feel.multiplierShake * 1.15);
            riseCombo(event.from, event.combo, holdMs);
          } else {
            // A PFC card holds the link that would have broken.
            const badge = rectOf(`[data-chain-link="l${event.link}"]`);
            popAt(badge, `link-l${event.link}`, look.name, look.ink, "word", holdMs);
            say(look.name, look.ink);
            if (card && !reducedMotion) juice(card.element, { amount: 0.16, rotateRad: 0.08 });
            runSound.charmFire(chain);
            fx.onShake(stepShake(event.combo));
          }
          break;
        }
        case "wysi": {
          // A 727: the chain holds, the clip plays and the moment (Wysi.tsx)
          // runs over it; the first one's combo jump lands when its +727
          // reaches the combo (onComboLand).
          runSound.wysi(event.add > 0);
          say(event.add > 0 ? `727 +${event.add}` : "727", WYSI_INK);
          setWysi({ id: ++burstId, event, holdMs });
          break;
        }
        case "multiplier": {
          if (event.id === "dt") {
            // The reel's DT: the mod's name over the doubling.
            popCentre(`DT x${formatChainX(event.x)}`, CHAIN_REEL_INK.dt, holdMs, true);
            say("DT", CHAIN_REEL_INK.dt);
            runSound.stepMultiplier(chain);
            countTo(event.total, Math.min(holdMs, 420));
            fx.onShake(feel.multiplierShake);
            break;
          }
          fireScene(event.id);
          popCentre(`x${formatChainX(event.x)}`, GOLD, holdMs);
          say(CHAIN_SCENE_NAMES[event.id], GOLD);
          runSound.stepMultiplier(chain);
          countTo(event.total, Math.min(holdMs, 420));
          fx.onShake(feel.multiplierShake);
          break;
        }
      }
      const deferCombo =
        ((event.kind === "wysi" && event.add > 0) ||
          event.kind === "goat" ||
          (event.kind === "variant" && event.variant === "max") ||
          (event.kind === "scene" && (event.effect === "double" || event.effect === "carry"))) &&
        !reducedMotion;
      setRunning((current) => ({ ...current, combo: deferCombo ? current.combo : event.combo, broke: event.kind === "break" ? current.broke + 1 : current.broke }));
      if (target > 0 && roundBefore + event.total >= target) fx.onHeat("fire");
      else if (event.combo >= 40) fx.onHeat("mod");
    };

    const finish = () => {
      const { fx, combos } = finalState(row);
      p().onLinkFx(() => fx);
      for (const [index, combo] of Object.entries(combos)) p().onCardCombo(Number(index), combo);
      row.hands.forEach((_, index) => p().onHandLit(index));
      const last = row.events[row.events.length - 1];
      shownTotal = row.total;
      p().onRunning(row.total);
      setRunning((current) => ({ ...current, total: row.total, combo: last?.combo ?? current.combo }));
    };

    const run = async () => {
      const at = p().readoutAt();
      setReadout(at);
      if (!clock.skip) await hold(reducedMotion ? 0 : feel.leadMs);
      if (cancelled) return;
      let chain = 0;
      let crossed = target <= 0 || roundBefore >= target;
      let lastMultiplier = -1;
      row.events.forEach((event, index) => {
        if (event.kind === "multiplier") lastMultiplier = index;
      });
      const stamped = new Set<string>();
      const moonGate = row.multipliers.some((multiplier) => multiplier.id === "moonGate");
      for (let index = 0; index < row.events.length && !clock.skip; index += 1) {
        const event = row.events[index];
        const kind = event.kind === "scene" && event.id === "echoes" ? "secondPass" : event.kind === "scene" ? "scene" : event.kind;
        let holdMs = chainStepMs(index, kind, reducedMotion);
        // Moon Gate's short rows play at a faster pace.
        if (moonGate) holdMs = Math.round(holdMs * 0.6);
        // A 727 freezes the chain for its beat, Moon Gate or not.
        if (event.kind === "wysi") holdMs = event.add > 0 ? feel.wysiMs : feel.wysiSmallMs;
        if (index === lastMultiplier) holdMs += feel.finalMultiplierMs;
        // A scene card's first firing in a pass stamps onto the row.
        const stamp = stampOf(event);
        if (stamp && !stamped.has(stamp.key)) {
          stamped.add(stamp.key);
          if (!reducedMotion) {
            showStamp(stamp.scene, stamp.at);
            holdMs += feel.stampMs;
          }
        }
        show(event, chain, holdMs / clock.speed);
        chain += 1;
        const reached = row.events[index];
        // The round passes its target mid-chain: its own beat.
        if (!crossed && target > 0 && roundBefore + reached.total >= target) {
          crossed = true;
          p().onCross();
          runSound.fireIgnite();
          runSound.fireLoopStart();
          if (!reducedMotion) p().onShake(feel.crossShake);
          holdMs += feel.crossHoldMs;
        }
        await hold(holdMs);
        if (cancelled) return;
      }
      finish();
      const skipped = clock.skip;
      if (!crossed && target > 0 && roundBefore + row.total >= target) {
        crossed = true;
        p().onCross();
        runSound.fireIgnite();
        runSound.fireLoopStart();
      }
      if (!skipped) await hold(feel.tailMs, false);
      if (cancelled) return;

      // The settled total punches where it stands, then flies straight into
      // the round score, the one time that box changes for this row.
      enter("total");
      runSound.finish();
      if (!reducedMotion) punch(totalRef.current, formatChainScore(row.total).length + 3);
      await hold(reducedMotion ? 200 : feel.holdMs, false);
      if (cancelled) return;
      let flown = false;
      const digits = [...document.querySelectorAll<HTMLElement>("[data-chain-score-digits]")].find((element) => element.offsetParent !== null) ?? null;
      const to = digits?.getBoundingClientRect();
      const totalEl = totalRef.current;
      if (!reducedMotion && digits && to && totalEl && at && to.height > 0) {
        // The row's total flies as "+N" to just under the round score and
        // fades there while the box counts up to the new round total: one
        // landing, one number change.
        const boxEl = digits.closest<HTMLElement>("[data-chain-score]") ?? digits;
        const boxRect = boxEl.getBoundingClientRect();
        const want = Math.max(18, boxRect.height * 0.62);
        const scale = Math.max(0.08, Math.min(1, want / Math.max(1, totalEl.offsetHeight), (boxRect.width * 1.3) / Math.max(1, totalEl.offsetWidth)));
        setFly({ x: boxRect.left + boxRect.width / 2 - at.x, y: boxRect.bottom + 6 + (totalEl.offsetHeight * scale) / 2 - at.y, scale });
        enter("fly");
        await hold(feel.flyMs * 0.7, false);
        if (cancelled) return;
        flown = true;
      }
      const after = roundBefore + row.total;
      const share = Math.min(1, row.total / Math.max(1, target));
      runSound.slam(share);
      p().onSlam(after);
      p().onShake(reducedMotion ? 0 : feel.slamShake + feel.slamShakePerShare * share);
      if (flown) await hold(feel.flyMs * 0.3, false);
      if (cancelled) return;
      enter("landed");
      await hold(after >= target ? feel.afterFireMs : feel.afterSlamMs, false);
      if (cancelled) return;
      p().onDone();
    };
    void run();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
    // One sequence per row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row]);

  useLayoutEffect(() => {
    const width = totalRef.current?.offsetWidth ?? 0;
    if (width !== totalW) setTotalW(width);
  });

  const base = overlayRef.current?.getBoundingClientRect();
  const showTotal = stage !== "landed" && readout && base;
  const comboText = `x${formatChainScore(running.combo)}`;
  const size = readout ? Math.round(readout.size * (1 + Math.min(0.45, running.combo / 260))) : 0;
  const totalAnimate = fly ? { x: fly.x, y: fly.y, scale: fly.scale, opacity: [1, 1, 0] } : { x: 0, y: 0, scale: 1, opacity: 1 };
  const burn = target > 0 ? flameLevel(roundBefore + running.total, target) : 0;
  const flameW = Math.max(size * 2.4, totalW * 1.25);
  const ratio = target > 0 ? (roundBefore + running.total) / target : 0;
  const flameLayer = typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-chain-flame-layer]") : null;
  /* The desktop fire's reach is a share of the room up to the table's top
     edge, growing with log(score / target): a bare crossing climbs about
     to the HUD, 2x licks around it, 10x fills the room. Its tips stay
     under the top edge so they never get cut flat. */
  const flameBase = readout && flameLayer ? readout.y - flameLayer.getBoundingClientRect().top + Math.round(size * 0.46) : 0;
  const flameReach = Math.min(1, 0.4 + 0.6 * Math.log10(Math.max(1, ratio)));
  const tallFlame = flameW > 0 ? Math.max(0.5, ((flameBase - 16) * flameReach) / (flameW * 0.6)) : 0.75;
  /* Room above the number for the flame: up to the board's top on a wide
     table, up to the progress bar's top on a phone. */
  let flameRoom: number | null = null;
  if (readout && readout.top !== undefined && typeof document !== "undefined") {
    // On a phone it may rise up to the progress bar's top, never over the
    // HUD lines above it.
    const meter = [...document.querySelectorAll<HTMLElement>("[data-chain-meter]")].find((element) => element.offsetParent !== null);
    const ceiling = meter ? (readout.narrow ? meter.getBoundingClientRect().top : meter.getBoundingClientRect().bottom + 6) : readout.top;
    flameRoom = Math.max(0, readout.y + size * 0.46 - ceiling);
  }
  return (
    <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-[50]" translate="no">
      {sweep && (
        <motion.div
          key={`sweep-${sweep.id}`}
          className="absolute rounded-[10px] bg-white"
          style={{ left: sweep.x, top: sweep.y, width: sweep.w, height: sweep.h }}
          initial={{ x: 0, opacity: 0 }}
          animate={{ x: sweep.dx, opacity: [0, 0.18, 0.18, 0] }}
          transition={{ duration: 0.62, ease: "easeInOut" }}
        />
      )}
      {/* The row's total sits centred on its point, the combo beside it. */}
      {showTotal && (
        <div className="absolute z-[9]" style={{ left: readout.x - base.left, top: readout.y - base.top }}>
          {/* The fire: under the number the round passed its target with. */}
          {/* The fire under the number: clipped at the top only (the HUD's
              score stays clear), its sides free, fading out as the total
              flies. */}
          <AnimatePresence>
            {burn > 0 && stage !== "fly" && readout.narrow && (
              <motion.div
                key="flame"
                className="absolute left-0 -translate-x-1/2 -translate-y-full"
                style={{
                  top: Math.round(size * 0.46),
                  transformOrigin: "50% 100%",
                  opacity: readout.narrow ? 0.9 : 1,
                  // A box twice the flame's width and as tall as the room it
                  // has, its top fading out: the tongues dissolve under the
                  // HUD instead of being cut, and the sides stay free.
                  ...(flameRoom !== null
                    ? {
                        width: flameW * 2,
                        height: flameRoom,
                        WebkitMaskImage: "linear-gradient(to top, black 55%, transparent)",
                        maskImage: "linear-gradient(to top, black 55%, transparent)",
                      }
                    : {}),
                }}
                initial={false}
                exit={{ scaleY: 0, opacity: 0, transition: { duration: 0.15 } }}
              >
                <div className={flameRoom !== null ? "absolute bottom-0 left-1/2 -translate-x-1/2" : undefined}>
                  <InkFlame level={burn} ratio={ratio} width={flameW} reducedMotion={reducedMotion} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <motion.div
            className="absolute left-0 top-0 h-0 w-0"
            animate={totalAnimate}
            transition={
              fly
                ? { duration: CHAIN_FEEL.chain.flyMs / 1000, ease: [0.5, 0, 0.9, 0.5], opacity: { duration: CHAIN_FEEL.chain.flyMs / 1000, times: [0, 0.7, 1] } }
                : stage === "total"
                  ? { type: "spring", stiffness: 420, damping: 22 }
                  : { duration: 0 }
            }
          >
            <div
              ref={totalRef}
              className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-black leading-none text-white tabular-nums"
              style={{ fontSize: size, WebkitTextStroke: `${Math.max(6, Math.round(size * 0.12))}px #120f1a`, paintOrder: "stroke fill" }}
            >
              <WysiDigits text={stage === "fly" ? `+${formatChainScore(running.total)}` : formatChainScore(running.total)} />
            </div>
          </motion.div>
          {reason && stage === "steps" && (
            <motion.div
              key={`reason-${reason.id}`}
              className="absolute left-0 -translate-x-1/2 whitespace-nowrap font-black italic leading-none"
              style={{
                top: Math.round(size * (readout.narrow ? 0.5 : 0.58)),
                fontSize: readout.narrow ? 13 : Math.max(15, Math.round((readout?.size ?? 40) * 0.36)),
                color: reason.fill,
                WebkitTextStroke: "5px #120f1a",
                paintOrder: "stroke fill",
              }}
              initial={reducedMotion ? false : { scale: 1.3, opacity: 0.4 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 800, damping: 24 }}
            >
              {reason.text}
            </motion.div>
          )}
          <motion.span
            ref={comboRef}
            key={`combo-${running.combo}`}
            className="absolute top-0 -translate-y-1/2 whitespace-nowrap font-black italic leading-none tabular-nums"
            style={{
              left: totalW / 2 + 8,
              transformOrigin: "0% 50%",
              fontSize: Math.round((readout?.size ?? 40) * 0.5),
              color: COMBO,
              opacity: stage === "steps" ? 1 : 0,
              WebkitTextStroke: "5px #120f1a",
              paintOrder: "stroke fill",
            }}
            initial={reducedMotion ? false : { scale: 1 + 0.12 * comboText.length }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 760, damping: 17 }}
          >
            <WysiDigits text={comboText} />
          </motion.span>
        </div>
      )}
      {wysi && stage === "steps" && (
        <WysiMoment
          key={`wysi-${wysi.id}`}
          hits={wysi.event.hits}
          add={wysi.event.add}
          holdMs={wysi.holdMs}
          reducedMotion={reducedMotion}
          overlay={overlayRef}
          total={totalRef}
          combo={comboRef}
          onImpact={(amount) => propsRef.current.onShake(amount)}
          onComboLand={() => setRunning((current) => ({ ...current, combo: Math.max(current.combo, wysi.event.combo) }))}
        />
      )}
      {stamps.map((stamp) => (
        <motion.div
          key={`stamp-${stamp.id}`}
          className="absolute z-[8]"
          style={{ left: stamp.x, top: stamp.y, width: stamp.size, height: stamp.size, marginLeft: -stamp.size / 2, marginTop: -stamp.size / 2 }}
          initial={{ scale: 2.3, rotate: -14, opacity: 0 }}
          animate={{ scale: [2.3, 0.9, 1, 1.04], rotate: [-14, 3, 0, 0], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 0.62, times: [0, 0.3, 0.55, 1], ease: "easeOut" }}
        >
          <SceneMedallion size={stamp.size}>
            <SceneArt id={SCENE_ART_ID[stamp.scene]} size={Math.round(stamp.size * 0.48)} />
          </SceneMedallion>
        </motion.div>
      ))}
      {/* Desktop: the fire stands in the layer under the HUD, tall, its
          height growing with log(score / target): a 2x crossing modest, a
          10x one huge. The HUD's numbers sit on opaque plates over it. */}
      {flameLayer &&
        readout &&
        !readout.narrow &&
        createPortal(
          <AnimatePresence>
            {burn > 0 && stage !== "fly" && stage !== "landed" && (
              <motion.div
                key="flame-desk"
                className="absolute -translate-x-1/2 -translate-y-full"
                style={{ left: readout.x - flameLayer.getBoundingClientRect().left, top: flameBase, transformOrigin: "50% 100%" }}
                initial={false}
                exit={{ scaleY: 0, opacity: 0, transition: { duration: 0.15 } }}
              >
                <InkFlame level={burn} ratio={ratio} width={flameW} height={tallFlame} reducedMotion={reducedMotion} />
              </motion.div>
            )}
          </AnimatePresence>,
          flameLayer,
        )}
      <AnimatePresence>
        {floats.map((item) => (
          <Float key={item.id} item={item} reducedMotion={reducedMotion} />
        ))}
      </AnimatePresence>
    </div>
  );
}
