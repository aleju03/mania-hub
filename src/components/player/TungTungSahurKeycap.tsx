import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useLingui } from "@lingui/react/macro";

/* The Tung tung sahur keycap: a companion (lib/supporter-companions.ts) that
   presses down when held, lights up in a new colour and plays its sound. It
   fills the box it is put in. */

const TUNG_TUNG_SAHUR_AUDIO_SRC = "/audio/tung-tung-sahur-keycap.mp3";
const TUNG_TUNG_SAHUR_GLOW_COLORS = ["#38d9ff", "#ff3f57", "#8bff3f", "#b45cff", "#ffd53d", "#ff7a2f"];
const TUNG_TUNG_SAHUR_BASE_REST = { y: 0, scaleY: 1 };
const TUNG_TUNG_SAHUR_TOP_REST = { x: -3.25, y: 4, scaleY: 1, filter: "brightness(1)" };
const TUNG_TUNG_SAHUR_ACTUATION_MS = 49;

export function TungTungSahurKeycap() {
  const { t } = useLingui();
  const [pressed, setPressed] = useState(false);
  const [actuated, setActuated] = useState(false);
  const [glowColor, setGlowColor] = useState(TUNG_TUNG_SAHUR_GLOW_COLORS[0]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const actuationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearActuationTimer = useCallback(() => {
    if (!actuationTimerRef.current) return;
    clearTimeout(actuationTimerRef.current);
    actuationTimerRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      clearActuationTimer();
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      audio.currentTime = 0;
    };
  }, [clearActuationTimer]);

  const triggerActuation = useCallback(() => {
    actuationTimerRef.current = null;
    setActuated(true);
    setGlowColor((current) => {
      const choices = TUNG_TUNG_SAHUR_GLOW_COLORS.filter((color) => color !== current);
      return choices[Math.floor(Math.random() * choices.length)] ?? current;
    });

    const audio = audioRef.current ?? new Audio(TUNG_TUNG_SAHUR_AUDIO_SRC);
    audioRef.current = audio;
    audio.volume = 0.8;
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  }, []);

  const release = useCallback(() => {
    clearActuationTimer();
    setPressed(false);
    setActuated(false);
  }, [clearActuationTimer]);

  const press = useCallback(() => {
    clearActuationTimer();
    setPressed(true);
    setActuated(false);
    actuationTimerRef.current = setTimeout(triggerActuation, TUNG_TUNG_SAHUR_ACTUATION_MS);
  }, [clearActuationTimer, triggerActuation]);

  return (
    <button
      type="button"
      aria-label={t`Tung tung sahur keycap`}
      className="group relative block h-full w-full cursor-pointer touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-osu-pink/80 focus-visible:ring-offset-2 focus-visible:ring-offset-osu-b5"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onBlur={release}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) press();
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") release();
      }}
    >
      <span className="absolute inset-x-5 bottom-0 h-3 rounded-full bg-black/35 blur-md transition-opacity duration-200 group-hover:opacity-90" />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-base.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-0 z-10 mx-auto w-[61%] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.38)]"
        initial={TUNG_TUNG_SAHUR_BASE_REST}
        animate={{ y: pressed ? 1 : 0, scaleY: pressed ? 0.985 : 1 }}
        transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.65 }}
      />
      <motion.span
        className="absolute left-1/2 bottom-[37.5%] z-[18] h-3 w-8 -translate-x-1/2 rounded-full blur-sm"
        style={{
          background: `radial-gradient(ellipse, ${glowColor} 0%, ${glowColor}bb 38%, transparent 74%)`,
          boxShadow: `0 0 10px 3px ${glowColor}`,
        }}
        initial={{ opacity: 0, scale: 0.78 }}
        animate={{ opacity: actuated ? 1 : 0, scale: actuated ? 1.08 : 0.78 }}
        transition={{ duration: actuated ? 0.05 : 0.24, ease: "easeOut" }}
      />
      <motion.span
        className="absolute left-1/2 bottom-[38.6%] z-[19] h-1.5 w-6 -translate-x-1/2 rounded-full blur-[1px]"
        style={{
          background: `radial-gradient(ellipse, white 0%, ${glowColor} 45%, transparent 78%)`,
          boxShadow: `0 0 7px 2px ${glowColor}`,
        }}
        initial={{ opacity: 0, scaleX: 0.86 }}
        animate={{ opacity: actuated ? 1 : 0, scaleX: actuated ? 1.08 : 0.86 }}
        transition={{ duration: actuated ? 0.04 : 0.2, ease: "easeOut" }}
      />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-top.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-[35%] z-20 mx-auto w-[78%] object-contain drop-shadow-[0_8px_14px_rgba(0,0,0,0.42)]"
        initial={TUNG_TUNG_SAHUR_TOP_REST}
        animate={{
          x: -3.25,
          y: pressed ? 17 : 4,
          scaleY: pressed ? 0.972 : 1,
          filter: pressed ? "brightness(0.92)" : "brightness(1)",
        }}
        transition={{ type: "spring", stiffness: 640, damping: 31, mass: 0.55 }}
      />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-base.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-0 z-30 mx-auto w-[61%] object-contain"
        style={{ clipPath: "inset(12% 0 0 0)" }}
        initial={TUNG_TUNG_SAHUR_BASE_REST}
        animate={{ y: pressed ? 1 : 0, scaleY: pressed ? 0.985 : 1 }}
        transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.65 }}
      />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-top.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-[35%] z-40 mx-auto w-[78%] object-contain"
        style={{ clipPath: "inset(0 70% 0 0)" }}
        initial={TUNG_TUNG_SAHUR_TOP_REST}
        animate={{
          x: -3.25,
          y: pressed ? 17 : 4,
          scaleY: pressed ? 0.972 : 1,
          filter: pressed ? "brightness(0.92)" : "brightness(1)",
        }}
        transition={{ type: "spring", stiffness: 640, damping: 31, mass: 0.55 }}
      />
      <motion.img
        src="/images/easter-eggs/tung-tung-sahur-keycap-top.webp"
        alt=""
        draggable={false}
        className="absolute inset-x-0 bottom-[35%] z-40 mx-auto w-[78%] object-contain"
        style={{ clipPath: "inset(0 0 0 84%)" }}
        initial={TUNG_TUNG_SAHUR_TOP_REST}
        animate={{
          x: -3.25,
          y: pressed ? 17 : 4,
          scaleY: pressed ? 0.972 : 1,
          filter: pressed ? "brightness(0.92)" : "brightness(1)",
        }}
        transition={{ type: "spring", stiffness: 640, damping: 31, mass: 0.55 }}
      />
    </button>
  );
}
