import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";

import { highwayKeyLegend, type HighwayJudgement } from "../../lib/highway-play";
import type { HighwayHud } from "./use-highway-play";

/* What a visitor playing the Note highway sees over its playfield: the last
   judgement, the combo and the accuracy above the judgement line. Nothing
   stays on the page otherwise: the row of keycaps saying which keys play it
   (with a way to change them) shows only while the pointer is over the
   playfield, for a few seconds on a first visit, and while keys are being
   changed. It sits where the shader draws the playfield
   (profile-theme-shaders.ts, `highway`) and scrolls away with the page as the
   playfield does: the judgement line is 32% down a screen-high box and
   centred 80% across, half as wide there as 0.16 * sqrt(lanes / 4) of the
   height. The lanes run up to a vanishing point further left that follows
   the pointer. The combo, accuracy and judgement lie on the track itself, in
   its perspective, laid out as osu!mania does: the combo furthest up, the
   judgement just above the line. The keycaps stay flat, centred on the lanes
   at their height (`across`). Only where there is a keyboard to press. */

const JUDGEMENT_COLOURS: Record<HighwayJudgement, string> = {
  MAX: "#fff6c9",
  "300": "#ffd84a",
  "200": "#86e26f",
  "100": "#62baff",
  "50": "#b9bac8",
  MISS: "#ff5d6c",
};

/* Where the playfield's middle is at a height `down` the box (0..1): its CSS
   `left`, leaning with the pointer as the shader's vanishing point does
   (--hw-lean is that lean in px at the vanishing point, set on the box). */
function across(down: number): string {
  const k = (0.22 + down) / 0.54;
  return `calc(${(50 + 20 + 10 * k).toFixed(2)}% + var(--hw-lean, 0px) * ${(1 - k).toFixed(3)})`;
}
/* The shader eases its lean toward the pointer; this follows at about that pace. */
const LEAN = "left 450ms ease-out";

const PLAYED_KEY = "mt-highway-played";
const FIRST_VISIT_MS = 7000;
const LEAVE_MS = 700;

function Keycap({ code, filled = true }: { code: string | null; filled?: boolean }) {
  const legend = code ? highwayKeyLegend(code) : "";
  return (
    <kbd
      className={`grid h-[18px] place-items-center rounded-[4px] border border-b-white/5 font-sans text-[10px] font-bold leading-none shadow-[0_1px_0_rgba(0,0,0,0.5)] ${code === "Space" ? "w-8" : "min-w-[18px] px-1"} ${filled ? "border-white/20 bg-white/12 text-white/85" : "border-white/10 bg-white/5 text-white/30"}`}
    >
      {legend === " " ? "" : legend}
    </kbd>
  );
}

export function HighwayPlayHud({ playing, hud, keys, lanes, binding, onChangeKeys }: {
  playing: boolean;
  hud: HighwayHud;
  keys: string[];
  lanes: number;
  /** The keys pressed so far while rebinding; null when not. */
  binding: string[] | null;
  onChangeKeys: () => void;
}) {
  const { t } = useLingui();
  const boxRef = useRef<HTMLDivElement>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [near, setNear] = useState(false);
  const [firstVisit, setFirstVisit] = useState(false);

  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    setKeyboard(true);
    let played = false;
    try {
      played = window.localStorage.getItem(PLAYED_KEY) === "1";
    } catch {
      // private mode: the keys show once per visit
    }
    if (played) return;
    setFirstVisit(true);
    const timer = window.setTimeout(() => setFirstVisit(false), FIRST_VISIT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!playing) return;
    setFirstVisit(false);
    try {
      window.localStorage.setItem(PLAYED_KEY, "1");
    } catch {
      // private mode
    }
  }, [playing]);

  // the pointer over the playfield, worked out from where the shader draws it:
  // no element lies there to take the page's clicks
  useEffect(() => {
    if (!keyboard) return;
    let leave = 0;
    const onMove = (event: PointerEvent) => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box || box.height === 0) return;
      boxRef.current!.style.setProperty("--hw-lean", `${(((event.clientX - box.left) / box.width - 0.5) * 0.2 * box.height).toFixed(1)}px`);
      const half = 0.16 * Math.sqrt(lanes / 4) * box.height * 1.25 + 24;
      const inside = Math.abs(event.clientX - (box.left + box.width * 0.8)) < half && event.clientY > box.top && event.clientY < box.top + box.height * 0.44;
      if (inside) {
        window.clearTimeout(leave);
        leave = 0;
        setNear(true);
      } else if (!leave) {
        leave = window.setTimeout(() => {
          leave = 0;
          setNear(false);
        }, LEAVE_MS);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.clearTimeout(leave);
      window.removeEventListener("pointermove", onMove);
    };
  }, [keyboard, lanes]);

  if (!keyboard || keys.length !== lanes) return null;
  const hint = binding !== null || (!playing && (near || firstVisit));
  /* The playfield's width at the judgement line, in vh. */
  const floor = 32 * Math.sqrt(lanes / 4);

  return (
    <div
      ref={boxRef}
      className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-screen select-none overflow-hidden"
      // the shader's camera: its vanishing point sits 70% across (plus the lean) and 22% of the height above the box, 54% of the height from the judgement line
      style={{ perspective: "54vh", perspectiveOrigin: "calc(70% + var(--hw-lean, 0px)) -22%", transition: "perspective-origin 450ms ease-out" }}
    >
      {playing && (
        /* The track itself, as a floor in the page's own 3D: the box's
           perspective puts the eye where the shader's vanishing point is, so
           what lies on this floor recedes, narrows and leans exactly as the
           lanes do. Its near edge is the judgement line; a distance L up it
           is the shader's depth s = L / 54vh. */
        <div
          className="absolute left-[80%] top-[-8%] h-[40%]"
          style={{ width: `${floor}vh`, marginLeft: `${-floor / 2}vh`, transformOrigin: "50% 100%", transform: "rotateX(90deg)" }}
        >
          {hud.combo > 1 && (
            <div className="absolute bottom-[19vh] left-1/2 -translate-x-1/2 text-[50px] font-black leading-none text-white/90 tabular-nums" style={{ textShadow: "0 2px 12px rgba(0,0,0,0.75)" }}>
              {hud.combo}
            </div>
          )}
          <div className="absolute bottom-[11vh] left-1/2 -translate-x-1/2 text-[20px] font-bold leading-none text-white/60 tabular-nums" style={{ textShadow: "0 1px 6px rgba(0,0,0,0.8)" }}>
            {hud.accuracy.toFixed(2)}%
          </div>
          {hud.judgement && (
            <div key={hud.tick} className="highway-judge absolute bottom-[3.2vh] left-1/2 text-[26px] font-black leading-none tracking-wide" style={{ color: JUDGEMENT_COLOURS[hud.judgement], textShadow: "0 2px 10px rgba(0,0,0,0.7)" }}>
              {hud.judgement}
            </div>
          )}
        </div>
      )}
      <div
        // at the top of the lanes, clear of the mascot that stands at the playfield's foot
        style={{ left: across(0.045), transition: `${LEAN}, opacity 200ms` }}
        className={`absolute top-[4.5%] flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-black/55 px-2 py-1 text-[10.5px] font-semibold leading-none text-white/80 backdrop-blur-sm ${hint ? "opacity-100" : "opacity-0"}`}
      >
        {binding ? (
          <>
            <span>{t`Press ${lanes} keys, left to right`}</span>
            {Array.from({ length: lanes }, (_, lane) => (
              <Keycap key={lane} code={binding[lane] ?? null} filled={lane < binding.length} />
            ))}
          </>
        ) : (
          <>
            <span>{t`Play with`}</span>
            {keys.map((code, lane) => (
              <Keycap key={lane} code={code} />
            ))}
            <button type="button" tabIndex={hint ? 0 : -1} onClick={onChangeKeys} className={`cursor-pointer rounded-full px-1 text-white/60 underline decoration-white/25 underline-offset-2 transition-colors hover:text-white ${hint ? "pointer-events-auto" : ""}`}>
              {t`change keys`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
