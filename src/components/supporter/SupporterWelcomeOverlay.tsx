import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

/* The supporter thank-you itself (SupporterWelcome decides when). Drawn as
   if by hand: a pen flourish loops in from the side and its last stretch
   draws a heart, which gets coloured in with marker off the line, presses
   down like a sticker and then floats; the thank-you comes up under it. It closes on its own, or on a click, Esc
   or Enter, and the heart flies off to the viewer's avatar in the nav.
   Every line is a filled ribbon whose width and path drift with noise and
   re-roll a few times a second, so it boils like redrawn frames. */

const INK = "#fbeef2";
const PINK = "#ff7ab2";
const AUTO_CLOSE_MS = 7200;
/* when the text starts, measured from the start */
const TEXT_AT = 2000;
const DRAW_AT = 280;
const DRAW_MS = 1320;

type Pt = [number, number, number];

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
const easeInOut = (x: number) => {
  const k = clamp(x);
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
};
const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};
const noise = (x: number, seed: number) => {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(hash(i + seed * 57.3), hash(i + 1 + seed * 57.3), u);
};

/* Evenly spaced [x, y, length] along an SVG path. */
function sample(d: string, step: number): Pt[] {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  document.body.appendChild(svg);
  const total = path.getTotalLength();
  const out: Pt[] = [];
  for (let l = 0; l <= total; l += step) {
    const p = path.getPointAtLength(l);
    out.push([p.x, p.y, l]);
  }
  svg.remove();
  return out;
}

/* The heart in units, tip near (0, 1). Drawn by hand: the right lobe sits a
   little higher and fuller, the notch is off centre, and the pen runs on past
   the tip where it started. It runs tip, right lobe, notch, left lobe, so the
   trace coming in from the left keeps going the way it was heading. */
const HEART_D = "M0 1 C0.4 0.7 1.06 0.28 1.04 -0.28 C1.02 -0.72 0.66 -0.96 0.38 -0.92 C0.18 -0.89 0.07 -0.74 0.03 -0.57 C-0.04 -0.72 -0.19 -0.84 -0.4 -0.82 C-0.7 -0.8 -0.98 -0.56 -0.96 -0.18 C-0.94 0.3 -0.38 0.68 0.02 1.0";
const OVERSHOOT = " L0.13 1.09";

/* Marker colouring: loose back-and-forth strokes across the heart, in units. */
const SCRIBBLE: [number, number][] = (() => {
  const pts: [number, number][] = [];
  const a = -0.62, ca = Math.cos(a), sa = Math.sin(a);
  for (let k = 0; k < 8; k++) {
    const y = -1.45 + k * 0.4;
    for (const x of k % 2 ? [1.6, -1.6] : [-1.6, 1.6]) pts.push([x * ca - y * sa, x * sa + y * ca + 0.05]);
  }
  return pts;
})();
const SCRIBBLE_LEN = SCRIBBLE.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - SCRIBBLE[i - 1][0], p[1] - SCRIBBLE[i - 1][1]) : 0), 0);

/* Comic marks where the heart presses down, in heart units. */
const PRESS_AT = DRAW_AT + DRAW_MS + 380;
const MARKS: [number, number, number, number][] = [[1.22, -0.78, 1.52, -1.06], [1.36, -0.24, 1.74, -0.3], [-1.18, -0.9, -1.38, -1.18], [-1.3, -0.36, -1.66, -0.46]];

/* How the heart sits: one press as the colour finishes (a squash and a
   rocking tilt that settles), then a slow float with a little sway. */
function poseAt(t: number) {
  const p = t - PRESS_AT;
  const press = p > 0 ? Math.exp(-p / 260) : 0;
  const scale = 1 - 0.07 * Math.exp(-Math.pow((p - 40) / 70, 2)) + 0.03 * Math.exp(-Math.pow((p - 200) / 110, 2));
  const settle = p > 0 ? -0.1 * press * Math.sin(p / 95) : 0;
  const idle = clamp((t - PRESS_AT - 500) / 900);
  const ph = ((t - PRESS_AT) / 2600) * Math.PI * 2;
  return { scale, rotate: settle + idle * 0.035 * Math.sin(ph), dy: idle * -3.5 * Math.sin(ph + 0.9) };
}

interface Layout {
  w: number;
  h: number;
  cx: number;
  cy: number;
  s: number;
  path: Pt[];
  iEcg: number;
  heart: Pt[];
  fill: Pt[];
}

function layoutFor(w: number, h: number): Layout {
  const s = Math.round(Math.max(40, Math.min(64, w * 0.12)));
  const cx = w / 2;
  const cy = Math.max(s + 24, Math.min(h * 0.34, h - 230 - s));
  const tip = cy + s;
  // a pen flourish laid out back from the tip: a small loop, a larger one,
  // then a sweep up into the heart, a little uneven like handwriting
  const k = Math.min(1, (cx - 12) / 330);
  const x = (back: number) => (cx - back * k).toFixed(1);
  const y = (dy: number) => (tip + dy).toFixed(1);
  const ecg = `M-30 ${y(4)} C${x(560)} ${y(-6)} ${x(470)} ${y(8)} ${x(392)} ${y(2)} C${x(318)} ${y(-62)} ${x(452)} ${y(-70)} ${x(360)} ${y(-2)} C${x(318)} ${y(18)} ${x(266)} ${y(10)} ${x(232)} ${y(-4)} C${x(118)} ${y(-112)} ${x(318)} ${y(-120)} ${x(196)} ${y(-6)} C${x(150)} ${y(26)} ${x(62)} ${y(22)} ${cx} ${tip}`;
  const ecgPts = sample(ecg, 2);
  const ecgLen = ecgPts[ecgPts.length - 1][2];
  const heart = sample(HEART_D + OVERSHOOT, 0.01);
  const heartWorld = heart.map(([hx, hy, l]): Pt => [cx + hx * s, cy + hy * s, ecgLen + l * s]);
  return { w, h, cx, cy, s, path: ecgPts.concat(heartWorld.slice(1)), iEcg: ecgPts.length - 1, heart, fill: sample(HEART_D + " Z", 0.02) };
}

export function SupporterWelcomeOverlay({ username, expiresAt, giftFrom, onDone }: { username: string; expiresAt: number | null; giftFrom: string | null; onDone: () => void }) {
  const { t, i18n } = useLingui();
  const reduced = useReducedMotion() ?? false;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [leaving, setLeaving] = useState(false);
  const leaveAt = useRef<number>(Infinity);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  // a friend's gift code gets a welcome instead of a thank-you
  const title = giftFrom ? t`Welcome to supporter, ${username}` : t`Thank you for supporting, ${username}`;
  const until = expiresAt ? new Date(expiresAt).toLocaleDateString(i18n.locale, { month: "short", day: "numeric", year: "numeric" }) : null;
  // the words before the name rise one by one; the name goes last, in pink
  const parts = useMemo(() => {
    const at = title.lastIndexOf(username);
    const before = at >= 0 ? title.slice(0, at) : title;
    return { words: before.split(/(?<=\s)/).filter(Boolean), after: at >= 0 ? title.slice(at + username.length) : "" };
  }, [title, username]);

  useEffect(() => setLayout(layoutFor(window.innerWidth, window.innerHeight)), []);

  const leave = () => {
    if (leaveAt.current !== Infinity) return;
    leaveAt.current = performance.now();
    setLeaving(true);
  };

  useEffect(() => {
    const timer = setTimeout(leave, AUTO_CLOSE_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter") leave();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!layout || !canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(layout.w * dpr);
    canvas.height = Math.round(layout.h * dpr);
    const { cx, cy, s: S, path, iEcg } = layout;
    const avatar = document.querySelector<HTMLElement>("[data-supporter-welcome-target]")?.getBoundingClientRect();
    const target = avatar && avatar.width > 0 && avatar.bottom > 0 ? { x: avatar.right - 4, y: avatar.bottom - 4, cx: avatar.left + avatar.width / 2, cy: avatar.top + avatar.height / 2, r: avatar.width / 2 } : null;
    let seed = 0;
    let underline: { x0: number; x1: number; y: number } | null = null;

    const ribbon = (pts: Pt[], { width = 4.2, wob = 1.1, taperIn = 18, taperOut = 18, salt = 0, color = INK } = {}) => {
      if (pts.length < 2) return;
      const l0 = pts[0][2], l1 = pts[pts.length - 1][2];
      const left: [number, number][] = [], right: [number, number][] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let nx = -(b[1] - a[1]), ny = b[0] - a[0];
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl;
        ny /= nl;
        const l = pts[i][2];
        const off = (noise(l / 46, seed + salt + 3) - 0.5) * 2 * wob;
        const taper = Math.sqrt(clamp((l - l0) / taperIn)) * Math.sqrt(clamp((l1 - l) / taperOut));
        const half = (width * (0.72 + 0.56 * noise(l / 34, seed + salt)) * Math.max(0.12, taper)) / 2;
        const x = pts[i][0] + nx * off, y = pts[i][1] + ny * off;
        left.push([x + nx * half, y + ny * half]);
        right.push([x - nx * half, y - ny * half]);
      }
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(left[0][0], left[0][1]);
      for (const p of left) g.lineTo(p[0], p[1]);
      for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
      g.closePath();
      g.fill();
    };
    const dash = (x0: number, y0: number, x1: number, y1: number, k0: number, k1: number, width: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const pts: Pt[] = [];
      for (let i = 0; i <= 12; i++) {
        const k = lerp(k0, k1, i / 12);
        pts.push([lerp(x0, x1, k), lerp(y0, y1, k), k * len]);
      }
      ribbon(pts, { width, wob: 0.4, taperIn: len * 0.3, taperOut: len * 0.3 });
    };

    const t0 = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = now - t0;
      const ex = leaveAt.current === Infinity ? -1 : now - leaveAt.current;
      seed = reduced ? 0 : Math.floor(t / 125) % 3;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, layout.w, layout.h);
      const inA = easeOut(t / 420);
      const outA = ex < 0 ? 0 : easeInOut((ex - (reduced ? 0 : 420)) / 520);
      if (dimRef.current) dimRef.current.style.opacity = String(inA * (1 - outA));

      // the pen: trace in, its tail lifting off behind it, then round the heart
      const drawn = reduced || t >= DRAW_AT + DRAW_MS;
      if (!drawn && t > DRAW_AT) {
        const head = Math.min(path.length - 1, Math.floor(easeInOut((t - DRAW_AT) / DRAW_MS) * (path.length - 1)));
        const tail = Math.floor(easeInOut((t - 320 - DRAW_AT) / DRAW_MS) * (path.length - 1));
        if (tail < iEcg) ribbon(path.slice(Math.max(0, tail), Math.min(head, iEcg) + 1), { taperIn: 120, taperOut: 6, salt: 1 });
        if (head > iEcg) ribbon(path.slice(iEcg, head + 1), { taperIn: 4, taperOut: 6, salt: 2 });
      }

      if (drawn) {
        const fly = ex < 0 || !target || reduced ? 0 : easeInOut((ex - 120) / 720);
        const small = 8;
        const qx = target ? (1 - fly) ** 2 * cx + 2 * fly * (1 - fly) * lerp(cx, target.x, 0.3) + fly ** 2 * target.x : cx;
        const qy = target ? (1 - fly) ** 2 * cy + 2 * fly * (1 - fly) * Math.min(cy, target.y + 80) + fly ** 2 * target.y : cy;
        const pose = ex < 0 && !reduced ? poseAt(t) : { scale: 1, rotate: 0, dy: 0 };
        const s = S * pose.scale * (1 - fly * (1 - small / S));
        const k = s / S;
        // without an avatar to land on, the heart just goes with the dim
        const alpha = target && !reduced ? (ex > 1500 ? 1 - clamp((ex - 1500) / 400) : 1) : 1 - outA;
        g.globalAlpha = alpha;
        g.save();
        g.translate(qx, qy + pose.dy);
        g.rotate(pose.rotate);
        g.translate(-qx, -qy);
        // colour first, off register, then the ink line on top
        const fe = reduced ? 1 : clamp((t - DRAW_AT - DRAW_MS - 40) / 420);
        if (fe > 0) {
          g.save();
          const ox = qx + 0.07 * s, oy = qy + 0.06 * s;
          g.beginPath();
          layout.fill.forEach(([x, y, l], i) => {
            const w = (noise(l * 3, seed + 7) - 0.5) * 0.05;
            const px = ox + x * s * (0.97 + w), py = oy + y * s * (0.97 + w);
            if (i) g.lineTo(px, py);
            else g.moveTo(px, py);
          });
          g.closePath();
          g.clip();
          g.strokeStyle = PINK;
          g.lineWidth = 0.5 * s;
          g.lineCap = "round";
          g.lineJoin = "round";
          g.beginPath();
          SCRIBBLE.forEach(([x, y], i) => (i ? g.lineTo(ox + x * s, oy + y * s) : g.moveTo(ox + x * s, oy + y * s)));
          const total = SCRIBBLE_LEN * s + 1;
          g.setLineDash([fe * total, total]);
          g.stroke();
          g.setLineDash([]);
          g.restore();
        }
        ribbon(layout.heart.map(([x, y, l]): Pt => [qx + x * s, qy + y * s, l * s]), { width: Math.max(1.7, 4.2 * Math.sqrt(k)), wob: 1.1 * k, taperIn: 6 * k + 2, taperOut: 10 * k + 2, salt: 2 });

        if (ex < 0 && !reduced) {
          const e = (t - PRESS_AT) / 330;
          if (e > 0 && e < 1) {
            for (const [x0, y0, x1, y1] of MARKS) dash(qx + x0 * s, qy + y0 * s, qx + x1 * s, qy + y1 * s, easeOut((e - 0.45) / 0.55), easeOut(e / 0.45), 3.4);
          }
        }
        g.restore();
        if (target && !reduced && ex > 840 && ex < 1140) {
          const e = (ex - 840) / 300;
          for (const [x0, y0, x1, y1] of [[1.5, -1.2, 2.3, -1.9], [1.9, -0.2, 2.8, -0.3]]) {
            dash(target.x + x0 * small, target.y + y0 * small, target.x + x1 * small, target.y + y1 * small, easeOut((e - 0.45) / 0.55), easeOut(e / 0.45), 2);
          }
        }
        g.globalAlpha = 1;
      }

      // a pen underline under the name
      if (t > TEXT_AT + 1000 && (ex < 0 || ex < 300)) {
        if (!underline && nameRef.current) {
          const r = nameRef.current.getBoundingClientRect();
          underline = { x0: r.left - 3, x1: r.right + 8, y: r.bottom - 2 };
        }
        if (underline) {
          const e = reduced ? 1 : easeOut((t - TEXT_AT - 1000) / 380);
          const { x0, x1, y } = underline;
          const pts: Pt[] = [];
          for (let i = 0; i <= 60 * e; i++) {
            const k = i / 60;
            pts.push([lerp(x0, x1, k), y + Math.sin(k * 3.1) * 2.5 - k * k * 6, k * (x1 - x0)]);
          }
          g.globalAlpha = ex < 0 ? 1 : 1 - ex / 300;
          ribbon(pts, { width: 3.6, wob: 0.6, taperIn: 10, taperOut: 22, color: PINK, salt: 4 });
          g.globalAlpha = 1;
        }
      }

      if (ex > (target && !reduced ? 1950 : 1000)) {
        doneRef.current();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [layout, reduced]);

  if (!layout) return null;
  const textTop = layout.cy + layout.s + 44;
  const rise = (delay: number, y = 8, rotate = 0) => ({
    initial: reduced ? { opacity: 0 } : { opacity: 0, y, rotate },
    animate: leaving ? { opacity: 0, y: 6, transition: { duration: 0.24, ease: "easeIn" as const } } : { opacity: 1, y: 0, rotate: 0 },
    transition: reduced ? { duration: 0.3, delay: delay / 1000 } : { duration: 0.5, delay: delay / 1000, ease: [0.2, 0.8, 0.3, 1.15] as [number, number, number, number] },
  });
  const tilts = [-2.5, 1.5, -1, 2, -1.5, 1];
  const textAt = reduced ? 200 : TEXT_AT;

  return createPortal(
    <div
      role="dialog"
      aria-label={title}
      onClick={leave}
      className="fixed inset-0 z-[300] select-none"
      style={{ pointerEvents: leaving ? "none" : "auto" }}
    >
      <div ref={dimRef} className="absolute inset-0 opacity-0 backdrop-blur-[6px]" style={{ background: "rgba(16, 9, 12, 0.84)" }} />
      <div className="absolute inset-x-0 px-5 text-center" style={{ top: textTop, color: INK }}>
        {until ? (
          <motion.div {...rise(textAt, 6)} className="mb-2.5 text-[13px] font-semibold text-[#b7a3ab]">
            {t`Supporter until ${until}`}
          </motion.div>
        ) : null}
        <h2 className="m-0 mb-3.5 text-[26px] font-extrabold leading-tight sm:text-[36px]">
          {parts.words.map((word, i) => (
            <motion.span key={i} {...rise(textAt + 80 + i * 85, 12, tilts[i % tilts.length])} className="inline-block whitespace-pre">
              {word}
            </motion.span>
          ))}
          <motion.span ref={nameRef} {...rise(textAt + 80 + parts.words.length * 85, 12, -1.5)} className="inline-block" style={{ color: PINK }}>
            {username}
          </motion.span>
          {parts.after ? <motion.span {...rise(textAt + 80 + parts.words.length * 85)} className="inline-block whitespace-pre">{parts.after}</motion.span> : null}
        </h2>
        <motion.p {...rise(textAt + 640, 6)} className="mx-auto m-0 max-w-[680px] text-[14px] leading-[1.55] text-[#d9c5cd] sm:text-[15px]">
          {giftFrom ? t`${giftFrom} gave you a week of supporter.` : t`Your support keeps the servers running and gives me the time to keep building the site.`}
          <br />
          {t`Profile themes, avatar frames, name styles and card foils are all yours now.`}
        </motion.p>
      </div>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>,
    document.body,
  );
}
