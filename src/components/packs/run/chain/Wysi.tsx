import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { motion } from "framer-motion";
import type { ChainWysiHit } from "#/lib/chain-run";
import { CHAIN_FEEL } from "./chainFeel";

/* The 727 on the table. Every number the engine shows that reads 727 is one
   it flagged (backend/src/shared/chain-run.ts, CHAIN_WYSI), so any 727 in a
   number's text is lit wherever it appears.

   The moment itself is played as an osu! hit object: an approach circle
   closes on the 727 in time with the clip and it bursts on contact. The
   first one in a row also stops time (the table dims, the triangles stall),
   slams and foils the digits, and flies its +727 into the combo; the table
   snaps back as the combo takes it. */

export const WYSI_INK = "#ffd36b";
const OUTLINE = "#120f1a";

/* wysi.mp3 ("seven two SEVEN!!"), from its RMS envelope and spectrogram: the
   first "seven" is voiced from about 100 ms, "two" from 300 ms (its "t" at
   290), and the last "SEVEN" from 535 ms, its loudest stretch 540-620 ms.
   The clip ends at 920 ms. Times are from the clip's start, which is the
   moment's start (runSound.wysi plays in the same tick). */
export const WYSI_SYNC = {
  /* Each digit pops on its own syllable. */
  syllablesMs: [100, 300, 540],
  /* The approach circle lands on the last "SEVEN". */
  hitMs: 540,
  /* A later 727 in the row holds only 420 ms: it lands on "two". */
  smallHitMs: 300,
  /* The +727 leaves the digits, then lands in the combo, and time resumes. */
  flyAtMs: 860,
  flyMs: 220,
  /* The chain's hold this timeline was laid out for (CHAIN_FEEL.chain). */
  bigMs: 1200,
  smallMs: 420,
} as const;

/* The triangles backdrop reads this every frame: 0 holds them still. */
export const wysiTime = { scale: 1 };

/* "727" as a whole digit group of an en-US number: "1,727,004" and "+727",
   never the 727 inside "7270" or "17,270". */
const GROUP = /(^|\D)(727)(?=\D|$)/g;

export function hasWysiText(text: string): boolean {
  GROUP.lastIndex = 0;
  return GROUP.test(text);
}

/* A number's text with its 727 lit. */
export function WysiDigits({ text }: { text: string }) {
  if (!hasWysiText(text)) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  GROUP.lastIndex = 0;
  for (let match = GROUP.exec(text); match; match = GROUP.exec(text)) {
    const at = match.index + match[1].length;
    parts.push(text.slice(last, at));
    parts.push(
      // inline-block so a moment can slam the digits in place.
      <span key={at} data-wysi="" style={{ display: "inline-block", color: WYSI_INK }}>
        727
      </span>,
    );
    last = at + 3;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/* ------------------------------------------------------------------ burst */

const SHARD_INKS = ["#ffffff", "#fff0bf", WYSI_INK, "#ffb547"];
const SPARK_INKS = ["#ffffff", "#fff3c9", WYSI_INK];

interface BurstProps {
  x: number;
  y: number;
  /* The hit circle's radius: the rings start on it. */
  r: number;
  /* 1 for the chain's first 727, smaller for the short ones. */
  power: number;
}

/* The hit explosion, in one canvas: the hit circle's rim blowing out, a thin
   outer ring, hard-edged shards of the ring and spark streaks with drag and
   a little gravity. Runs about 0.75 s and stops drawing. */
function HitBurst({ x, y, r, power }: BurstProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reach = Math.round(r * 1.9 + 300 * power);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const side = reach * 2;
    canvas.width = Math.round(side * dpr);
    canvas.height = Math.round(side * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rand = Math.random;
    const shardCount = Math.round(6 + 8 * power);
    const shards = Array.from({ length: shardCount }, (_, index) => {
      const angle = ((index + rand() * 0.6) / shardCount) * Math.PI * 2;
      return {
        angle,
        speed: (420 + rand() * 420) * (0.55 + 0.45 * power),
        spin: (rand() - 0.5) * 14,
        length: (20 + rand() * 22) * (0.55 + 0.45 * power),
        width: (6 + rand() * 6) * (0.6 + 0.4 * power),
        life: 0.42 + rand() * 0.28,
        ink: SHARD_INKS[index % SHARD_INKS.length],
      };
    });
    const sparkCount = Math.round(10 + 42 * power);
    const sparks = Array.from({ length: sparkCount }, (_, index) => ({
      angle: rand() * Math.PI * 2,
      speed: (600 + rand() * 1000) * (0.5 + 0.5 * power),
      life: 0.22 + rand() * 0.38,
      width: 1.5 + rand() * 1.5 * power,
      ink: SPARK_INKS[index % SPARK_INKS.length],
    }));
    const start = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const t = (now - start) / 1000;
      ctx.clearRect(0, 0, side, side);
      const c = reach;
      // The hit circle's rim blows out.
      if (t < 0.26) {
        const p = t / 0.26;
        const e = 1 - (1 - p) ** 3;
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = "#fff6dc";
        ctx.lineWidth = Math.max(1, r * 0.2 * (1 - p));
        ctx.beginPath();
        ctx.arc(c, c, r * (1 + 0.42 * e), 0, Math.PI * 2);
        ctx.stroke();
      }
      // Two thin rings run out past it, the second a beat behind.
      for (const [delay, dur, grow, width] of [
        [0, 0.48, 2.1, 2.5],
        [0.06, 0.56, 3.0, 1.5],
      ] as const) {
        const local = t - delay;
        if (local < 0 || local > dur) continue;
        const p = local / dur;
        const e = 1 - (1 - p) ** 4;
        ctx.globalAlpha = (1 - p) * 0.95;
        ctx.strokeStyle = WYSI_INK;
        ctx.lineWidth = width * (0.6 + 0.4 * power);
        ctx.beginPath();
        ctx.arc(c, c, r * (1 + grow * power * e), 0, Math.PI * 2);
        ctx.stroke();
      }
      // Shards: thin blades off the ring, spinning out under drag.
      let alive = t < 0.62;
      for (const shard of shards) {
        if (t > shard.life) continue;
        alive = true;
        const drag = 4.2;
        const dist = (shard.speed / drag) * (1 - Math.exp(-drag * t));
        const px = c + Math.cos(shard.angle) * (r + dist);
        const py = c + Math.sin(shard.angle) * (r + dist) + 140 * t * t;
        const fade = t > shard.life * 0.55 ? 1 - (t - shard.life * 0.55) / (shard.life * 0.45) : 1;
        const rot = shard.angle + shard.spin * t;
        const half = shard.length / 2;
        const w = (shard.width / 2) * (1 - (t / shard.life) * 0.4);
        ctx.globalAlpha = Math.max(0, fade);
        ctx.fillStyle = shard.ink;
        ctx.beginPath();
        ctx.moveTo(px + Math.cos(rot) * half, py + Math.sin(rot) * half);
        ctx.lineTo(px + Math.cos(rot + Math.PI / 2) * w, py + Math.sin(rot + Math.PI / 2) * w);
        ctx.lineTo(px - Math.cos(rot) * half * 0.6, py - Math.sin(rot) * half * 0.6);
        ctx.lineTo(px - Math.cos(rot + Math.PI / 2) * w, py - Math.sin(rot + Math.PI / 2) * w);
        ctx.closePath();
        ctx.fill();
      }
      // Sparks: streaks along their velocity, quick to slow, falling a little.
      ctx.lineCap = "butt";
      for (const spark of sparks) {
        if (t > spark.life) continue;
        alive = true;
        const drag = 6.5;
        const decay = Math.exp(-drag * t);
        const dist = (spark.speed / drag) * (1 - decay);
        const gravity = 520;
        const dx = Math.cos(spark.angle);
        const dy = Math.sin(spark.angle);
        const px = c + dx * (r * 0.85 + dist);
        const py = c + dy * (r * 0.85 + dist) + 0.5 * gravity * t * t;
        const vx = dx * spark.speed * decay;
        const vy = dy * spark.speed * decay + gravity * t;
        const tail = 0.022;
        ctx.globalAlpha = 1 - (t / spark.life) ** 2;
        ctx.strokeStyle = spark.ink;
        ctx.lineWidth = spark.width * (1 - (t / spark.life) * 0.5);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - vx * tail, py - vy * tail);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (alive) frame = window.requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, side, side);
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [r, power, reach]);
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute"
      style={{ left: x - reach, top: y - reach, width: reach * 2, height: reach * 2 }}
    />
  );
}

/* Mount-time keyframes through WAAPI rather than framer-motion: the HUD's
   numbers sit under an AnimatePresence with initial={false}, which makes a
   framer child mounted later skip straight to its end state. */
function useKeyframes<T extends Element>(frames: Keyframe[], options: KeyframeAnimationOptions) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof element.animate !== "function") return;
    const animation = element.animate(frames, { fill: "both", ...options });
    return () => animation.cancel();
    // Plays once, from mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/* The approach circle closing on the hit circle's rim, as osu! draws a hit
   object: fades in over its first third, lands at `ms` and is gone. */
function Approach({ x, y, r, ms, from = 3.2 }: { x: number; y: number; r: number; ms: number; from?: number }) {
  const border = Math.max(3, Math.round(r * 0.07));
  const box = { left: x - r, top: y - r, width: r * 2, height: r * 2 };
  const rim = useKeyframes<HTMLDivElement>(
    [{ opacity: 0 }, { opacity: 0.55, offset: 0.6 }, { opacity: 0.55, offset: 0.995 }, { opacity: 0 }],
    { duration: ms, easing: "linear" },
  );
  const circle = useKeyframes<HTMLDivElement>(
    [
      { transform: `scale(${from})`, opacity: 0 },
      { opacity: 1, offset: 0.34 },
      { opacity: 1, offset: 0.995 },
      { transform: "scale(1)", opacity: 0 },
    ],
    { duration: ms, easing: "linear" },
  );
  return (
    <>
      <div ref={rim} className="pointer-events-none absolute rounded-full" style={{ ...box, opacity: 0, border: `${Math.max(2, Math.round(border * 0.6))}px solid #fff6dc` }} />
      <div ref={circle} className="pointer-events-none absolute rounded-full" style={{ ...box, opacity: 0, border: `${border}px solid ${WYSI_INK}` }} />
    </>
  );
}

/* A hard-edged four-point glint. */
function Glint({ x, y, size, delayMs, holdMs }: { x: number; y: number; size: number; delayMs: number; holdMs: number }) {
  const ref = useKeyframes<SVGSVGElement>(
    [
      { transform: "scale(0) rotate(0deg)", opacity: 0 },
      { transform: "scale(1.25) rotate(45deg)", opacity: 1, offset: 0.18 },
      { transform: "scale(0.75) rotate(70deg)", opacity: 1, offset: 0.4 },
      { transform: "scale(1) rotate(90deg)", opacity: 1, offset: 0.7 },
      { transform: "scale(0.6) rotate(110deg)", opacity: 0 },
    ],
    { delay: delayMs, duration: Math.max(300, holdMs), easing: "ease-out" },
  );
  return (
    <svg
      ref={ref}
      aria-hidden="true"
      viewBox="-1 -1 2 2"
      className="pointer-events-none absolute"
      style={{ left: x - size / 2, top: y - size / 2, width: size, height: size, opacity: 0 }}
    >
      <path d="M0 -1 L0.16 -0.16 L1 0 L0.16 0.16 L0 1 L-0.16 0.16 L-1 0 L-0.16 -0.16 Z" fill="#ffffff" />
    </svg>
  );
}

/* The old gold tag, for a stamp whose number shows no lit 727 to slam yet. */
function StampTag({ x, y }: { x: number; y: number }) {
  const ref = useKeyframes<HTMLSpanElement>(
    [
      { transform: "translate(-50%, -50%) scale(1.6) rotate(-10deg)", opacity: 1 },
      { transform: "translate(-50%, -50%) scale(0.92) rotate(3deg)", offset: 0.15 },
      { transform: "translate(-50%, -50%) scale(1) rotate(-5deg)", opacity: 1, offset: 0.3 },
      { transform: "translate(-50%, -50%) scale(1) rotate(-5deg)", opacity: 0 },
    ],
    { duration: 1000, easing: "ease-out" },
  );
  return (
    <span
      ref={ref}
      className="absolute whitespace-nowrap rounded-[6px] px-1.5 py-0.5 text-[15px] font-black italic leading-none tabular-nums"
      style={{ left: x, top: y, color: OUTLINE, background: WYSI_INK }}
    >
      727
    </span>
  );
}

/* A ring that shows and goes without moving (reduced motion). */
function StillRing({ x, y, r }: { x: number; y: number; r: number }) {
  const ref = useKeyframes<HTMLSpanElement>([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 1400 });
  return <span ref={ref} className="absolute rounded-full" style={{ left: x - r, top: y - r, width: r * 2, height: r * 2, opacity: 0, border: `3px solid ${WYSI_INK}` }} />;
}

/* ----------------------------------------------------------------- lifting */

/* Gold foil with a hard horizon, and the chromatic sheen that sweeps it. */
const FOIL = "linear-gradient(180deg, #fff8dc 0%, #ffe39a 48%, #ffc64a 52%, #f09d32 100%)";
const SHEEN = "linear-gradient(100deg, transparent 0 41%, #ffffff 45%, #c2f6ff 48.5%, #ffbdf3 52%, transparent 56% 100%)";
const CLIP_TEXT: CSSProperties = { color: "transparent", WebkitTextStroke: "0px transparent", backgroundClip: "text", WebkitBackgroundClip: "text" };

interface Lifted {
  x: number;
  y: number;
  w: number;
  h: number;
  font: CSSProperties;
  stroke: string;
}

function lift(element: HTMLElement, base: DOMRect): Lifted {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  // A number caught mid-punch is scaled: carry the scale into the font.
  const scale = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
  const px = (value: string) => `${(parseFloat(value) || 0) * scale}px`;
  return {
    x: rect.left - base.left,
    y: rect.top - base.top,
    w: rect.width,
    h: rect.height,
    font: {
      fontFamily: style.fontFamily,
      fontSize: px(style.fontSize),
      fontWeight: style.fontWeight as CSSProperties["fontWeight"],
      fontStyle: style.fontStyle,
      letterSpacing: style.letterSpacing === "normal" ? undefined : px(style.letterSpacing),
      fontVariantNumeric: style.fontVariantNumeric,
      lineHeight: `${rect.height}px`,
    },
    stroke: `${px(style.webkitTextStrokeWidth || "0")} ${OUTLINE}`,
  };
}

/* One digit of the lifted 727: outline, foil, sheen, and a white flash when
   its syllable lands. */
function FoilDigit({ char, popMs, sheenMs, stroke }: { char: string; popMs: number; sheenMs: number; stroke: string }) {
  return (
    <motion.span
      className="relative inline-block"
      animate={{ scale: [1, 1.3, 1] }}
      transition={{ delay: popMs / 1000, duration: 0.18, times: [0, 0.22, 1], ease: "easeOut" }}
    >
      <span style={{ color: OUTLINE, WebkitTextStroke: stroke, paintOrder: "stroke fill" }}>{char}</span>
      <span className="absolute inset-0" style={{ ...CLIP_TEXT, backgroundImage: FOIL }}>
        {char}
      </span>
      <motion.span
        className="absolute inset-0"
        style={{ ...CLIP_TEXT, backgroundImage: SHEEN, backgroundSize: "330% 100%", backgroundRepeat: "no-repeat" }}
        initial={{ backgroundPosition: "100% 0%" }}
        animate={{ backgroundPosition: "0% 0%" }}
        transition={{ delay: sheenMs / 1000, duration: 0.3, ease: "easeInOut" }}
      >
        {char}
      </motion.span>
      <motion.span
        className="absolute inset-0"
        style={{ color: "#ffffff" }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 0] }}
        transition={{ delay: popMs / 1000, duration: 0.2, times: [0, 0.08, 1] }}
      >
        {char}
      </motion.span>
    </motion.span>
  );
}

/* The digits on the page slamming where they stand (WysiDigits renders
   them inline-block). */
function slam(element: HTMLElement) {
  if (typeof element.animate !== "function") return;
  element.animate(
    [
      { transform: "scale(1.5)", filter: "brightness(2)" },
      { transform: "scale(0.9)", filter: "brightness(1.4)", offset: 0.35 },
      { transform: "scale(1.06)", offset: 0.7 },
      { transform: "scale(1)", filter: "brightness(1)" },
    ],
    { duration: 260, easing: "ease-out" },
  );
}

/* ------------------------------------------------------------------ moment */

/* Where the hit's 727s are on screen: the running total, the combo, a card's
   points float (data-float="card-<index>") or a link's number. */
function findTargets(hits: ChainWysiHit[], overlay: HTMLElement, total: HTMLElement | null, combo: HTMLElement | null): HTMLElement[] {
  const order = ["total", "points", "link", "combo"];
  const sorted = [...hits].sort((a, b) => order.indexOf(a.on) - order.indexOf(b.on));
  const found: HTMLElement[] = [];
  const take = (scope: Element | null | undefined) => {
    scope?.querySelectorAll<HTMLElement>("[data-wysi]").forEach((element) => {
      if (element.getClientRects().length && !found.includes(element)) found.push(element);
    });
  };
  for (const hit of sorted) {
    if (hit.on === "total") take(total);
    else if (hit.on === "combo") take(combo);
    else if (hit.on === "points") take(overlay.querySelector(`[data-float="card-${hit.index}"]`));
    else if (hit.on === "link" && hit.link) take(document.querySelector(`[data-chain-link="${hit.link}"]`));
  }
  if (!found.length) take(overlay);
  return found;
}

export interface WysiMomentProps {
  hits: ChainWysiHit[];
  /* What the combo jumps by: 727 on the row's first, 0 after. */
  add: number;
  /* The chain's hold for this beat (already sped up by a tap). */
  holdMs: number;
  reducedMotion: boolean;
  /* The scoring overlay (coordinates are its own), the total and combo. */
  overlay: RefObject<HTMLElement | null>;
  total: RefObject<HTMLElement | null>;
  combo: RefObject<HTMLElement | null>;
  onImpact: (amount: number) => void;
  /* The +727 reached the combo: show the jumped combo now. */
  onComboLand: () => void;
}

interface Scene {
  lifts: Lifted[];
  hit: { x: number; y: number; r: number } | null;
  to: { x: number; y: number } | null;
  size: number;
}

/* A 727 mid-chain. Mounted (keyed) in the scoring overlay, which shakes with
   the table, as the clip starts. */
export function WysiMoment({ hits, add, holdMs, reducedMotion, overlay, total, combo, onImpact, onComboLand }: WysiMomentProps) {
  const big = add > 0;
  const [scene, setScene] = useState<Scene | null>(null);
  const [phase, setPhase] = useState<"approach" | "hit" | "fly" | "released">("approach");
  const targetsRef = useRef<HTMLElement[]>([]);
  const callbacks = useRef({ onImpact, onComboLand });
  callbacks.current = { onImpact, onComboLand };

  // Timeline, squeezed if a tap already sped the chain up.
  const k = Math.min(1, holdMs / (big ? WYSI_SYNC.bigMs : WYSI_SYNC.smallMs));
  const hitMs = (big ? WYSI_SYNC.hitMs : WYSI_SYNC.smallHitMs) * k;
  const flyAt = WYSI_SYNC.flyAtMs * k;
  const landMs = (WYSI_SYNC.flyAtMs + WYSI_SYNC.flyMs) * k;

  useLayoutEffect(() => {
    const root = overlay.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const targets = findTargets(hits, root, total.current, combo.current);
    targetsRef.current = targets;
    const lifts = targets.map((element) => lift(element, base));
    const first = lifts[0];
    const hit = first ? { x: first.x + first.w / 2, y: first.y + first.h / 2, r: Math.max(first.w * 0.62, first.h * 0.78, 22) } : null;
    const comboEl = combo.current;
    const comboRect = comboEl?.getBoundingClientRect();
    const to = comboRect && comboRect.width > 0 ? { x: comboRect.left - base.left + Math.min(comboRect.width / 2, comboRect.height * 0.9), y: comboRect.top - base.top + comboRect.height / 2 } : null;
    setScene({ lifts, hit, to, size: first ? first.h : 40 });
    // Measured once, as the clip starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      const timer = window.setTimeout(() => callbacks.current.onComboLand(), 0);
      return () => window.clearTimeout(timer);
    }
    const timers: number[] = [];
    timers.push(
      window.setTimeout(() => {
        setPhase("hit");
        callbacks.current.onImpact(big ? CHAIN_FEEL.chain.wysiShake : CHAIN_FEEL.chain.wysiShake * 0.35);
        // The short one has no lifted copy: its own digits slam.
        if (!big) for (const element of targetsRef.current) slam(element);
      }, hitMs),
    );
    if (big) {
      timers.push(window.setTimeout(() => setPhase("fly"), flyAt));
      timers.push(
        window.setTimeout(() => {
          setPhase("released");
          callbacks.current.onComboLand();
          callbacks.current.onImpact(0.6);
        }, landMs),
      );
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [big, flyAt, hitMs, landMs, reducedMotion]);

  // Time stops: the triangles ease to a standstill, then kick back in fast
  // as the table snaps back, settling to their own pace.
  useEffect(() => {
    if (!big || reducedMotion) return;
    const start = performance.now();
    let frame = 0;
    const stallMs = 320 * k;
    const tick = (now: number) => {
      const t = now - start;
      if (t < landMs) {
        const p = Math.min(1, t / stallMs);
        wysiTime.scale = (1 - p) ** 2;
      } else {
        const after = t - landMs;
        wysiTime.scale = 1 + 2.4 * Math.exp(-after / 170);
        if (after > 800) {
          wysiTime.scale = 1;
          return;
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      wysiTime.scale = 1;
    };
  }, [big, k, landMs, reducedMotion]);

  if (!scene) return null;
  const { lifts, hit, to, size } = scene;

  if (reducedMotion) {
    // A still gold flash on the 727, nothing moving.
    return (
      <div className="pointer-events-none absolute inset-0 z-[10]">
        <motion.div className="absolute -inset-[80px]" style={{ background: WYSI_INK }} initial={{ opacity: 0 }} animate={{ opacity: [0, 0.14, 0] }} transition={{ duration: 0.5 }} />
      </div>
    );
  }

  const released = phase === "released";
  const flying = phase === "fly" || released;
  return (
    <div className="pointer-events-none absolute inset-0 z-[10]">
      {/* Time stops: everything but the 727 dims and greys a little. */}
      {big && (
        <motion.div
          className="absolute -inset-[80px]"
          style={{ background: "rgba(9, 7, 16, 0.58)", backdropFilter: "saturate(0.35)", WebkitBackdropFilter: "saturate(0.35)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: released ? 0 : 1 }}
          transition={{ duration: released ? 0.12 : 0.16, ease: "easeOut" }}
        />
      )}

      {/* The 727 lifted above the dim, slammed and foiled. */}
      {big &&
        lifts.map((lifted, index) => (
          <motion.div
            key={index}
            className="absolute"
            style={{ left: lifted.x, top: lifted.y, width: lifted.w, height: lifted.h }}
            initial={{ opacity: 1 }}
            animate={{ opacity: released ? 0 : 1 }}
            transition={{ duration: 0.08 }}
          >
            <motion.div
              className="whitespace-nowrap"
              style={{ ...lifted.font, height: lifted.h, transformOrigin: "50% 58%" }}
              animate={{ scale: [1, 1.16, 0.9, 1.04, 1] }}
              transition={{
                duration: (hitMs + 260) / 1000,
                times: [0, hitMs / (hitMs + 260), (hitMs + 70) / (hitMs + 260), (hitMs + 150) / (hitMs + 260), 1],
                ease: ["easeIn", "easeOut", "easeOut", "easeOut"],
              }}
            >
              {"727".split("").map((char, digit) => (
                <FoilDigit key={digit} char={char} popMs={WYSI_SYNC.syllablesMs[digit] * k} sheenMs={hitMs + 70 + digit * 45} stroke={lifted.stroke} />
              ))}
            </motion.div>
            {index === 0 && <Glint x={lifted.w * 0.94} y={lifted.h * 0.14} size={Math.max(16, lifted.h * 0.5)} delayMs={hitMs + 200} holdMs={landMs - hitMs - 200} />}
          </motion.div>
        ))}

      {/* The hit object: approach circle, then the burst on contact. */}
      {hit && phase === "approach" && <Approach x={hit.x} y={hit.y} r={hit.r} ms={hitMs} from={big ? 3.4 : 2.6} />}
      {hit && phase !== "approach" && <HitBurst x={hit.x} y={hit.y} r={hit.r} power={big ? 1 : 0.45} />}

      {/* The +727 flies into the combo. */}
      {big && hit && to && flying && !released && (
        <div className="absolute" style={{ left: hit.x, top: hit.y }}>
          <motion.div
            initial={{ x: 0, y: 0, scale: 0.6, opacity: 0 }}
            animate={{
              x: [0, (to.x - hit.x) * 0.45, to.x - hit.x],
              y: [0, (to.y - hit.y) * 0.45 - Math.max(36, size * 0.6), to.y - hit.y],
              scale: [0.6, 1.15, 0.7],
              opacity: [0, 1, 1],
            }}
            transition={{ duration: (WYSI_SYNC.flyMs * k) / 1000, times: [0, 0.4, 1], ease: ["easeOut", "easeIn"] }}
          >
            <span
              className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-black italic leading-none tabular-nums"
              style={{
                fontSize: Math.round(Math.min(56, Math.max(20, size * 0.55))),
                color: WYSI_INK,
                WebkitTextStroke: `${Math.max(4, Math.round(size * 0.07))}px ${OUTLINE}`,
                paintOrder: "stroke fill",
              }}
            >
              +{add}
            </span>
          </motion.div>
        </div>
      )}

      {/* Time resumes: the combo takes the +727 and a shockwave clears the room. */}
      {big && released && to && <HitBurst x={to.x} y={to.y} r={Math.max(18, size * 0.32)} power={0.3} />}
      {big && released && hit && (
        <motion.div
          className="absolute rounded-full"
          style={{ left: hit.x - 450, top: hit.y - 450, width: 900, height: 900, border: `3px solid ${WYSI_INK}` }}
          initial={{ scale: 0.06, opacity: 0.7 }}
          animate={{ scale: 1, opacity: 0 }}
          transition={{ duration: 0.42, ease: [0.2, 0.7, 0.3, 1] }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- stamp */

/* The mini 727 dropped on a table number (the round, target, round score,
   shards): an approach circle onto the number's 727, a small burst, the
   digits slam and glint. Keyed by the caller so each one plays once, and
   cleared by it after 1.8 s. */
export function WysiStamp({ reducedMotion }: { reducedMotion: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; r: number; h: number; digits: boolean } | null>(null);
  const [hit, setHit] = useState(false);

  // The number's own 727 if it shows yet (a count-up may still be on its
  // way), else the box's middle.
  const measure = () => {
    const box = ref.current?.parentElement;
    if (!box) return null;
    const base = box.getBoundingClientRect();
    const digits = box.querySelector<HTMLElement>("[data-wysi]");
    const rect = digits?.getBoundingClientRect();
    if (digits && rect && rect.width > 0) {
      return { x: rect.left - base.left + rect.width / 2, y: rect.top - base.top + rect.height / 2, r: Math.max(rect.width * 0.62, rect.height * 0.8, 16), h: rect.height, digits: true };
    }
    return { x: base.width / 2, y: base.height / 2, r: Math.max(18, Math.min(base.width, base.height) * 0.5), h: 18, digits: false };
  };

  useLayoutEffect(() => {
    setAt(measure());
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setTimeout(() => {
      setAt(measure());
      setHit(true);
      const digits = ref.current?.parentElement?.querySelector<HTMLElement>("[data-wysi]");
      if (digits) slam(digits);
    }, WYSI_SYNC.hitMs);
    return () => window.clearTimeout(timer);
  }, [reducedMotion]);

  return (
    <span ref={ref} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 z-[5] h-0 w-0">
      {at && reducedMotion && <StillRing x={at.x} y={at.y} r={at.r} />}
      {at && !reducedMotion && !hit && <Approach x={at.x} y={at.y} r={at.r} ms={WYSI_SYNC.hitMs} from={2.8} />}
      {at && !reducedMotion && hit && (
        <>
          <HitBurst x={at.x} y={at.y} r={at.r} power={0.38} />
          {at.digits ? (
            <Glint x={at.x + at.r * 0.75} y={at.y - at.h * 0.45} size={Math.max(12, at.h * 0.7)} delayMs={120} holdMs={700} />
          ) : (
            // Nothing lit to slam yet: the old gold tag stands in for it.
            <StampTag x={at.x} y={at.y} />
          )}
        </>
      )}
    </span>
  );
}
