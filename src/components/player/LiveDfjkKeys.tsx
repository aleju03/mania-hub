import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { KeysHint } from "./KeysHint";

/* The DFJK frame's secret: pressing D, F, J or K (by position, as mania binds
   them) plays its keycaps. While the viewer plays, the looping video steps
   aside for these caps, drawn exactly as the video draws them
   (local-notes/supporter-decorations/designs/dfjk-keys/page.html); a moment
   after the last key comes up, the loop takes over again. KeysHint shows
   which keys, where there is a keyboard. */

const CODES = ["KeyD", "KeyF", "KeyJ", "KeyK"];
const LEGENDS = ["D", "F", "J", "K"];
const KEY_W = 23, GAP = 4.5, TOP_H = 19, SKIRT = 6, TRAVEL = 3.6;
const LEFT = 92 - (4 * KEY_W + 3 * GAP) / 2;
const REST_Y = 143;
const IDLE_MS = 1600;

function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

export function LiveDfjkKeys({ style, hintTop, children }: { style: CSSProperties; hintTop: string; children: ReactNode }) {
  const [down, setDown] = useState([false, false, false, false]);
  const [hits, setHits] = useState([0, 0, 0, 0]);
  const [live, setLive] = useState(false);
  const held = useRef(new Set<number>());
  const uid = useId().replace(/:/g, "");

  useEffect(() => {
    let idle = 0;
    const sync = () => setDown([0, 1, 2, 3].map((col) => held.current.has(col)));
    const onDown = (event: KeyboardEvent) => {
      const col = CODES.indexOf(event.code);
      if (col < 0 || event.ctrlKey || event.metaKey || event.altKey || typingInto(event.target)) return;
      window.clearTimeout(idle);
      setLive(true);
      if (event.repeat || held.current.has(col)) return;
      held.current.add(col);
      sync();
      setHits((counts) => counts.map((count, i) => (i === col ? count + 1 : count)));
    };
    const release = (col: number | null) => {
      if (col === null) held.current.clear();
      else if (!held.current.delete(col)) return;
      sync();
      if (held.current.size === 0) {
        window.clearTimeout(idle);
        idle = window.setTimeout(() => setLive(false), IDLE_MS);
      }
    };
    const onUp = (event: KeyboardEvent) => {
      const col = CODES.indexOf(event.code);
      if (col >= 0) release(col);
    };
    const onBlur = () => release(null);
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

  return (
    <div aria-hidden className="pointer-events-none absolute max-w-none select-none" style={style}>
      <div className="absolute inset-0" style={{ opacity: live ? 0 : 1, transition: "opacity 120ms" }}>{children}</div>
      {live && (
        <svg viewBox="0 0 184 196" className="absolute inset-0 h-full w-full" style={{ fontFamily: '"DejaVu Sans", "Liberation Sans", sans-serif' }}>
          <defs>
            <linearGradient id={`${uid}top`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4a4a55" />
              <stop offset="1" stopColor="#34343d" />
            </linearGradient>
            <linearGradient id={`${uid}side`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#25252c" />
              <stop offset="1" stopColor="#18181d" />
            </linearGradient>
            <linearGradient id={`${uid}hit`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stopColor="#ff7ab6" stopOpacity="0.75" />
              <stop offset="1" stopColor="#ff7ab6" stopOpacity="0" />
            </linearGradient>
            <filter id={`${uid}drop`} x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="1.6" stdDeviation="1.3" floodColor="#000" floodOpacity="0.55" />
            </filter>
          </defs>
          {LEGENDS.map((legend, col) => {
            const x = LEFT + col * (KEY_W + GAP);
            const dy = down[col] ? TRAVEL : 0;
            const lit = down[col];
            return (
              <g key={legend}>
                {hits[col] > 0 && (
                  // the hit light, restarted on every press
                  <rect key={hits[col]} className="dfjk-hit" x={x + 1.5} y={REST_Y - 30} width={KEY_W - 3} height={32} fill={`url(#${uid}hit)`} />
                )}
                <g filter={`url(#${uid}drop)`}>
                  <rect x={x} y={REST_Y + dy} width={KEY_W} height={TOP_H + SKIRT - dy} rx={3.4} fill={`url(#${uid}side)`} />
                  <rect x={x + 1.6} y={REST_Y + dy + 0.6} width={KEY_W - 3.2} height={TOP_H - 1.6} rx={2.6} fill={`url(#${uid}top)`} />
                  <rect x={x + 1.6} y={REST_Y + dy + 0.6} width={KEY_W - 3.2} height={TOP_H - 1.6} rx={2.6} fill="none" stroke="#fff" strokeOpacity={0.08} strokeWidth={0.6} />
                  <text x={x + 6} y={REST_Y + dy + 9.2} fontSize={7.4} fontWeight={700} fill={lit ? "#ffd3e7" : "#a9a9b6"}>{legend}</text>
                  {(col === 1 || col === 2) && (
                    <rect x={x + KEY_W / 2 - 2.6} y={REST_Y + dy + TOP_H - 4.6} width={5.2} height={1.1} rx={0.55} fill={lit ? "#ffd3e7" : "#8a8a96"} />
                  )}
                </g>
              </g>
            );
          })}
        </svg>
      )}
      <KeysHint keys={LEGENDS} live={live} top={hintTop} />
    </div>
  );
}
