import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export function RouteLoadingBar() {
  const isPending = useRouterState({
    select: (state) => state.status === "pending",
  });
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const delayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => {
      if (delayTimeoutRef.current) clearTimeout(delayTimeoutRef.current);
      if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;

    if (delayTimeoutRef.current) clearTimeout(delayTimeoutRef.current);
    if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);

    if (isPending) {
      delayTimeoutRef.current = setTimeout(() => {
        setVisible(true);
        setProgress(14);

        intervalRef.current = setInterval(() => {
          setProgress((current) => {
            if (current >= 90) return current;
            if (current >= 75) return Math.min(90, current + 1.5);
            return Math.min(90, current + Math.max(3, (90 - current) * 0.18));
          });
        }, 160);
      }, 140);

      return;
    }

    if (!visible) {
      setProgress(0);
      return;
    }

    setProgress(100);
    finishTimeoutRef.current = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 220);
  }, [isPending, mounted, visible]);

  if (!mounted) return null;

  return (
    <div
      className={`fixed top-[60px] left-0 right-0 z-40 h-[2px] overflow-hidden transition-opacity duration-200 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      aria-hidden="true"
    >
      <div
        className="h-full rounded-r-full bg-osu-pink shadow-[0_0_12px_rgba(255,102,170,0.45)] transition-[width] duration-150 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
