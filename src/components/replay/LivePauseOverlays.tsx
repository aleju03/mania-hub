import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

/*
 * What a spectator sees while the player they watch is paused on osu!lazer,
 * and the 3, 2, 1 the game counts before it carries on. Sizes, colours and
 * timings are lazer's own (GameplayMenuOverlay, DialogButton,
 * DelayedResumeOverlay), in its 768-unit-tall screen: one unit is 1/768 of
 * the stage's height, so everything lands at the size it has in game.
 * Nothing here takes a click; the menu belongs to the player.
 */

const u = (units: number) => `calc(${units} * 100cqh / 768)`;
const TORUS = '"Torus", "Outfit", sans-serif';
// OsuGame.SHEAR is (0.2, 0): the top edge sits 0.2 of the height to the right.
const SHEAR = "skewX(-11.31deg)";

const BUTTONS = [
  { label: "Continue", colour: "#88b300" },
  { label: "Retry", colour: "#eeaa00" },
  { label: "Quit", colour: "rgb(170, 27, 39)" },
];

export function LazerPauseOverlay({ retries, progress, accuracy }: { retries: number; progress: number | null; accuracy: number | null }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeIn" }}
      className="pointer-events-none absolute inset-0 z-[15] grid select-none"
      style={{ containerType: "size", gridTemplateRows: "1fr auto 1fr auto", fontFamily: TORUS }}
    >
      <div className="absolute inset-0 bg-black/75" />
      <div className="relative flex items-center justify-center">
        <span style={{ fontSize: u(48), fontWeight: 600, letterSpacing: u(5), color: "#ffcc22", lineHeight: 1 }}>paused</span>
      </div>
      <div className="relative flex flex-col" style={{ gap: u(2), padding: `0 ${u(50)}` }}>
        {BUTTONS.map((button) => (
          <div key={button.label} className="relative flex items-center justify-center" style={{ height: u(80) }}>
            <div
              className="absolute inset-y-0 left-[10%] w-[80%]"
              style={{ background: button.colour, borderRadius: u(5), transform: SHEAR, boxShadow: `0 0 ${u(6)} rgba(0, 0, 0, 0.05)` }}
            />
            <span className="relative text-white" style={{ fontSize: u(28), fontWeight: 800, textShadow: `0 ${u(1)} 0 rgba(0, 0, 0, 0.1)` }}>
              {button.label}
            </span>
          </div>
        ))}
      </div>
      <div className="relative flex items-center justify-center text-center text-white" style={{ fontSize: u(18), lineHeight: 1.25 }}>
        <div>
          <div>Retry count: <b>{retries}</b></div>
          {progress != null ? <div>Song progress: <b>{progress}%</b></div> : null}
          {accuracy != null ? <div>Accuracy: <b>{accuracy.toFixed(2)}%</b></div> : null}
        </div>
      </div>
      <div />
    </motion.div>
  );
}

const COUNTDOWN_LEAD_MS = 200;
const COUNTDOWN_MS = 2000;
const COUNTDOWN_OUT_MS = 300;
const TOTAL_COUNT = 3;
const OUTER = 200;
const INNER = 150;
const STROKE = 7;
const RING = INNER + STROKE / 2;
// OverlayColourProvider's purple scheme (hue 255, saturation 0.1).
const BACKGROUND_6 = "hsl(255, 10%, 10%)";
const BACKGROUND_4 = "hsl(255, 10%, 20%)";
const BACKGROUND_3 = "hsl(255, 10%, 25%)";

/**
 * Lazer's resume countdown. `startAt` is when it opened, in performance.now()
 * time; counting starts 200 ms later and runs two seconds, like the game's.
 */
export function LazerResumeCountdown({ startAt }: { startAt: number }) {
  const [now, setNow] = useState(() => performance.now());
  const frame = useRef(0);
  useEffect(() => {
    const tick = () => {
      setNow(performance.now());
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, []);

  const sinceOpen = now - startAt;
  const counted = Math.max(0, Math.min(1, (sinceOpen - COUNTDOWN_LEAD_MS) / COUNTDOWN_MS));
  const count = Math.max(0, Math.min(TOTAL_COUNT, TOTAL_COUNT - Math.floor(counted * TOTAL_COUNT)));
  const done = sinceOpen >= COUNTDOWN_LEAD_MS + COUNTDOWN_MS;
  const sinceDone = sinceOpen - COUNTDOWN_LEAD_MS - COUNTDOWN_MS;
  if (sinceOpen < 0 || sinceDone > COUNTDOWN_OUT_MS) return null;

  const started = sinceOpen >= COUNTDOWN_LEAD_MS;
  const circumference = Math.PI * (RING - STROKE);
  const outQuint = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 5;
  // The ring grows and fades once the count is done; everything else goes at once.
  const out = done ? outQuint(sinceDone / COUNTDOWN_OUT_MS) : 0;
  const sinceCount = started ? (sinceOpen - COUNTDOWN_LEAD_MS) % (COUNTDOWN_MS / TOTAL_COUNT) : 0;
  const textScale = 0.25 + 0.75 * outQuint(sinceCount / 200);
  const outerPulse = sinceCount < 25 ? 1 : sinceCount < 125 ? 1 + 0.05 * ((sinceCount - 25) / 100) : sinceCount < 325 ? 1.05 - 0.05 * ((sinceCount - 125) / 200) : 1;
  const flash = started && !done && sinceCount < 400 ? 1 - sinceCount / 400 : 0;

  return (
    <div className="pointer-events-none absolute inset-0 z-[15] flex select-none items-center justify-center" style={{ containerType: "size", fontFamily: TORUS }}>
      <div
        className="relative flex items-center justify-center"
        style={{ width: u(OUTER), height: u(OUTER), opacity: done ? 1 : 0.2 + (0.8 * count) / TOTAL_COUNT }}
      >
        {!done && (
          <div
            className="absolute rounded-full"
            style={{ width: u(OUTER), height: u(OUTER), background: BACKGROUND_6, transform: `scale(${outQuint(sinceOpen / 200) * (started ? outerPulse : 1)})` }}
          />
        )}
        <div className="absolute flex items-center justify-center" style={{ width: u(OUTER), height: u(OUTER), transform: `scale(${outQuint(sinceOpen / 400)})` }}>
          {!done && (
            <div className="absolute rounded-full" style={{ width: u(INNER), height: u(INNER), background: BACKGROUND_4 }}>
              <div className="absolute inset-0 rounded-full" style={{ background: BACKGROUND_3, opacity: flash }} />
            </div>
          )}
          <svg
            viewBox={`0 0 ${RING} ${RING}`}
            className="absolute"
            style={{ width: u(RING), height: u(RING), transform: `rotate(-90deg) scale(${1 + out})`, opacity: 1 - out }}
          >
            <circle
              cx={RING / 2}
              cy={RING / 2}
              r={(RING - STROKE) / 2}
              fill="none"
              stroke="#fff"
              strokeWidth={STROKE / (1 + out)}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - counted)}
            />
          </svg>
          {!done && started && (
            <span className="relative text-white" style={{ fontSize: u(70), fontWeight: 300, lineHeight: 1, transform: `scale(${textScale})` }}>
              {Math.max(1, count)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Stable's spectator notice: a disc in the middle of the stage with one line
 * over it ("Host is selecting a song."). Stable draws its own logo there; this
 * one holds the player's avatar instead.
 */
export function SpectatorNotice({ text, avatarUrl, dim = true }: { text: string; avatarUrl?: string | null; dim?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="pointer-events-none absolute inset-0 z-[15] flex select-none items-center justify-center"
      style={{ containerType: "size" }}
    >
      {dim ? <div className="absolute inset-0 bg-black/60" /> : null}
      <div
        className="relative flex items-center justify-center overflow-hidden rounded-full bg-[#b03a6c]"
        style={{ width: "39cqh", height: "39cqh", border: "2.6cqh solid rgba(190, 190, 190, 0.85)" }}
      >
        {avatarUrl ? <img src={avatarUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover opacity-45" /> : null}
      </div>
      <span className="absolute whitespace-nowrap text-white" style={{ fontSize: "max(15px, 3.4cqh)", textShadow: "0 1px 3px rgba(0, 0, 0, 0.8)" }}>
        {text}
      </span>
    </motion.div>
  );
}
