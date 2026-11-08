import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { KeysHint } from "./KeysHint";

/* The 7K board frame's secret, like DFJK's: pressing S D F Space J K L (by
   position) plays its keys. While the viewer plays, the looping video steps
   aside for the board drawn live exactly as the video draws it
   (~/Projects/foundry/designs/seven-key/page.html): caps sink and light, and
   every press leaves its own bar that rises away above the board, like a key
   overlay, so a played pattern reads as a chart. Once the last bar is gone,
   the loop takes over again.
   A lone Space still scrolls the page; it plays the board (and stops
   scrolling) only once one of the letter keys has woken it. */

const CODES = ["KeyS", "KeyD", "KeyF", "Space", "KeyJ", "KeyK", "KeyL"];
const LEGENDS = ["S", "D", "F", "", "J", "K", "L"];
const COLOURS = ["#f9fbff", "#6ec3ff", "#f9fbff", "#ffc53d", "#f9fbff", "#6ec3ff", "#f9fbff"];
const TINTS = ["#ffffff", "#bfe5ff", "#ffffff", "#ffe39a", "#ffffff", "#bfe5ff", "#ffffff"];
const U = 15.4, SPACE = 33, GAP = 2.2;
const widths = LEGENDS.map((_, i) => (i === 3 ? SPACE : U));
const total = widths.reduce((a, b) => a + b, 0) + GAP * 6;
const xs: number[] = [];
{
  let x = 92 - total / 2;
  for (const w of widths) {
    xs.push(x);
    x += w + GAP;
  }
}
const CASE_X = 92 - total / 2 - 4.2, CASE_W = total + 8.4, CASE_Y = 144, CASE_H = 24, LIP = 4.5;
const CAP_Y = CASE_Y + 3.4, CAP_H = 13.2, SKIRT = 3.2, TRAVEL = 2.2;
const FLASH = 14; // the light over a pressed key
// the stream of played bars above the board
const STREAM_BASE = 144, STREAM_SPEED = 70, STREAM_TOP = 40, STREAM_FADE = 30;
const STREAM_LIFE = (STREAM_BASE - STREAM_TOP) / STREAM_SPEED;
const IDLE_MS = 1600 + STREAM_LIFE * 1000;
const NS = "http://www.w3.org/2000/svg";

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  x = clamp(x);
  return x * x * (3 - 2 * x);
};
const f2 = (v: number) => v.toFixed(2);

interface Hit { at: number; col: number; release: number | null }

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

function startBoard(svg: SVGSVGElement, currentHits: () => Hit[]): () => void {
  const uid = `sk${Math.random().toString(36).slice(2, 8)}`;
  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  const grads = COLOURS.map((col, i) => `
    <linearGradient id="${id(`beam${i}`)}" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${col}" stop-opacity="0.85"/><stop offset="0.55" stop-color="${col}" stop-opacity="0.32"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient>
    <linearGradient id="${id(`lit${i}`)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TINTS[i]}"/><stop offset="1" stop-color="${col}"/></linearGradient>`).join("");
  svg.innerHTML = `<defs>
    <linearGradient id="${id("caseTop")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#666d7c"/><stop offset="0.5" stop-color="#4a505d"/><stop offset="1" stop-color="#3a3f4a"/></linearGradient>
    <linearGradient id="${id("caseLip")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2e37"/><stop offset="1" stop-color="#14161b"/></linearGradient>
    <linearGradient id="${id("plate")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0c10"/><stop offset="1" stop-color="#14161c"/></linearGradient>
    <linearGradient id="${id("cap")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a505e"/><stop offset="1" stop-color="#2f333d"/></linearGradient>
    <linearGradient id="${id("skirt")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#262932"/><stop offset="1" stop-color="#17191f"/></linearGradient>
    <linearGradient id="${id("chamfer")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2f6ff" stop-opacity="0.85"/><stop offset="0.5" stop-color="#f2f6ff" stop-opacity="0.18"/><stop offset="1" stop-color="#f2f6ff" stop-opacity="0.05"/></linearGradient>
    <filter id="${id("drop")}" x="-20%" y="-40%" width="140%" height="200%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="1.6" stdDeviation="1.4" flood-color="#000" flood-opacity="0.6"/></filter>
    <filter id="${id("glow")}" x="-100%" y="-50%" width="300%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter>
    ${grads}
  </defs><g></g><g filter="${url("drop")}"></g>`;
  const beams = svg.children[1] as SVGGElement, board = svg.children[2] as SVGGElement;
  const el = (tag: string, attrs: Record<string, string | number>, parent: Element) => {
    const node = document.createElementNS(NS, tag);
    for (const key in attrs) node.setAttribute(key, String(attrs[key]));
    parent.appendChild(node);
    return node;
  };

  let hits = currentHits();
  const holdOf = (n: Hit, t: number) => (n.release ?? t + 1) - n.at;
  function press(t: number, c: number) {
    let p = 0;
    for (const n of hits) {
      if (n.col !== c) continue;
      const d = t - n.at, hold = holdOf(n, t), up = 0.07;
      let k = 0;
      if (d >= 0 && d < hold) k = 1;
      else if (d >= hold && d < hold + up) k = 1 - (d - hold) / up;
      p = Math.max(p, smooth(k));
    }
    return p;
  }
  function beam(t: number, c: number) {
    let h = 0;
    for (const n of hits) {
      if (n.col !== c) continue;
      const d = t - n.at;
      if (d < -0.02) continue;
      const hold = holdOf(n, t);
      const rise = smooth((d + 0.02) / 0.07);
      const fall = d > hold ? Math.exp(-(d - hold) / 0.12) : 1;
      h = Math.max(h, rise * fall);
    }
    return h;
  }
  function draw(t: number) {
    beams.replaceChildren();
    board.replaceChildren();
    for (let c = 0; c < 7; c++) {
      const w = widths[c], x = xs[c];
      const h = beam(t, c) * FLASH;
      const bx = x + 2.2, bw = w - 4.4, base = CASE_Y + 1;
      if (h > 0.3) {
        el("rect", { x: f2(bx - 1.5), y: f2(base - h), width: f2(bw + 3), height: f2(h), fill: COLOURS[c], opacity: f2(0.35 * (h / FLASH)), filter: url("glow") }, beams);
        el("rect", { x: f2(bx), y: f2(base - h), width: f2(bw), height: f2(h), rx: 1.2, fill: url(`beam${c}`) }, beams);
        el("rect", { x: f2(x + w / 2 - 0.6), y: f2(base - h * 0.9), width: 1.2, height: f2(h * 0.9), rx: 0.6, fill: "#fff", opacity: f2(0.5 * (h / FLASH)) }, beams);
      }
    }
    // every press leaves its own bar: it grows while the key is held, then rises
    // away at a steady speed, so what was played reads like a chart
    for (const n of hits) {
      const c = n.col, w = widths[c], x = xs[c];
      const top = STREAM_BASE - (t - n.at) * STREAM_SPEED;
      const bottom = n.release === null ? STREAM_BASE : STREAM_BASE - (t - n.release) * STREAM_SPEED;
      if (bottom < STREAM_TOP) continue;
      const y0 = Math.max(top, STREAM_TOP), y1 = Math.max(bottom - 1.6, y0 + 1.6);
      const fade = clamp((bottom - STREAM_TOP) / STREAM_FADE);
      el("rect", { x: f2(x + 2), y: f2(y0), width: f2(w - 4), height: f2(y1 - y0), rx: 1.2, fill: COLOURS[c], opacity: f2(0.9 * fade), filter: url("drop") }, beams);
      el("rect", { x: f2(x + 2.6), y: f2(y0 + 0.5), width: f2(w - 5.2), height: 0.7, rx: 0.35, fill: "#fff", opacity: f2(0.8 * fade) }, beams);
    }
    el("rect", { x: f2(CASE_X), y: CASE_Y, width: f2(CASE_W), height: CASE_H + LIP, rx: 5.5, fill: url("caseLip") }, board);
    el("rect", { x: f2(CASE_X), y: CASE_Y, width: f2(CASE_W), height: CASE_H, rx: 5.5, fill: url("caseTop") }, board);
    el("rect", { x: f2(CASE_X + 0.5), y: CASE_Y + 0.5, width: f2(CASE_W - 1), height: CASE_H - 1, rx: 5, fill: "none", stroke: url("chamfer"), "stroke-width": 0.8 }, board);
    el("rect", { x: f2(CASE_X + 2.6), y: CASE_Y + 2.2, width: f2(CASE_W - 5.2), height: CASE_H - 4.4, rx: 3.4, fill: url("plate") }, board);
    for (let c = 0; c < 7; c++) {
      const w = widths[c], x = xs[c];
      const p = press(t, c);
      const glow = Math.max(p, beam(t, c) * 0.85);
      const dy = p * TRAVEL;
      if (glow > 0.02) el("rect", { x: f2(x - 1), y: CAP_Y - 1, width: f2(w + 2), height: CAP_H + SKIRT + 1, rx: 3, fill: COLOURS[c], opacity: f2(0.55 * glow), filter: url("glow") }, board);
      el("rect", { x: f2(x), y: f2(CAP_Y + dy), width: f2(w), height: f2(CAP_H + SKIRT - dy), rx: 2.6, fill: url("skirt") }, board);
      el("rect", { x: f2(x + 1.1), y: f2(CAP_Y + dy + 0.4), width: f2(w - 2.2), height: CAP_H - 1.4, rx: 2.1, fill: url("cap") }, board);
      if (glow > 0.02) el("rect", { x: f2(x + 1.1), y: f2(CAP_Y + dy + 0.4), width: f2(w - 2.2), height: CAP_H - 1.4, rx: 2.1, fill: url(`lit${c}`), opacity: f2(0.92 * glow) }, board);
      el("rect", { x: f2(x + 1.4), y: f2(CAP_Y + dy + 0.7), width: f2(w - 2.8), height: 1, rx: 0.5, fill: "#fff", opacity: f2(0.22 + 0.4 * glow) }, board);
      const ink = glow > 0.5 ? "#1a1d26" : "#c4cada";
      if (LEGENDS[c]) {
        const text = el("text", { x: f2(x + w / 2), y: f2(CAP_Y + dy + 8.4), "font-size": 6.4, "font-weight": 700, "text-anchor": "middle", fill: ink, opacity: glow > 0.5 ? 0.85 : 0.75 }, board);
        text.textContent = LEGENDS[c];
      }
      if (c === 2 || c === 4) el("rect", { x: f2(x + w / 2 - 2), y: f2(CAP_Y + dy + 10), width: 4, height: 0.9, rx: 0.45, fill: ink, opacity: 0.6 }, board);
    }
  }

  let frame = 0;
  const tick = () => {
    frame = requestAnimationFrame(tick);
    hits = currentHits();
    draw(performance.now() / 1000);
  };
  tick();
  return () => cancelAnimationFrame(frame);
}

export function LiveSevenKey({ style, hintTop, children }: { style: CSSProperties; hintTop: string; children: ReactNode }) {
  const [live, setLive] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const hits = useRef<Hit[]>([]);

  useEffect(() => {
    let idle = 0;
    let awake = 0; // when a letter key last woke the board, for Space
    const held = new Map<number, Hit>();
    const settle = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        setLive(false);
        hits.current = [];
      }, IDLE_MS);
    };
    const onDown = (event: KeyboardEvent) => {
      const col = CODES.indexOf(event.code);
      if (col < 0 || event.ctrlKey || event.metaKey || event.altKey || typingInto(event.target)) return;
      const now = performance.now();
      if (col === 3) {
        if (now - awake > IDLE_MS) return; // a lone Space scrolls as usual
        event.preventDefault();
      } else {
        awake = now;
      }
      window.clearTimeout(idle);
      setLive(true);
      if (event.repeat || held.has(col)) return;
      const hit = { at: now / 1000, col, release: null };
      held.set(col, hit);
      // keep only what can still be drawn
      hits.current = [...hits.current.filter((h) => h.release === null || now / 1000 - h.release < STREAM_LIFE + 0.5), hit];
    };
    const release = (col: number) => {
      const hit = held.get(col);
      if (!hit) return;
      hit.release = performance.now() / 1000;
      held.delete(col);
      if (col !== 3) awake = performance.now();
      if (held.size === 0) settle();
    };
    const onUp = (event: KeyboardEvent) => {
      const col = CODES.indexOf(event.code);
      if (col >= 0) release(col);
    };
    const onBlur = () => {
      for (const col of [...held.keys()]) release(col);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.clearTimeout(idle);
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!live || !svgRef.current) return;
    return startBoard(svgRef.current, () => hits.current);
  }, [live]);

  return (
    <div aria-hidden className="pointer-events-none absolute max-w-none select-none" style={style}>
      <div className="absolute inset-0" style={{ opacity: live ? 0 : 1, transition: "opacity 120ms" }}>{children}</div>
      {live && <svg ref={svgRef} viewBox="-12 0 208 204" className="absolute inset-0 h-full w-full" style={{ fontFamily: '"Inter", "DejaVu Sans", "Liberation Sans", sans-serif' }} />}
      <KeysHint keys={["S", "D", "F", " ", "J", "K", "L"]} live={live} top={hintTop} />
    </div>
  );
}
