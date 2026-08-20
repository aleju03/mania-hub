import { useEffect, useRef, useState } from "react";
import { formatNumber } from "#/lib/format";

/* A number that counts to its new value instead of swapping to it.
 *
 * The stats on this page move while you are looking at them now: the totals a
 * pull changes are advanced off the live pull stream between snapshot
 * refreshes, and a refresh can land a bigger jump. Counting is what makes
 * either of those something you notice rather than a number that was quietly
 * different the next time you looked.
 *
 * The first render is the real value, never a count from zero: this renders
 * during SSR, and animating in from nothing would be a hydration mismatch as
 * well as a page that appears to be loading when it is not. */

/* Long enough that a single pull reads as a tick rather than a flicker, short
   enough that a jump of a few hundred after a snapshot refresh is over before
   it becomes something to sit through. */
const MS_PER_STEP = 40;
const MIN_DURATION_MS = 200;
const MAX_DURATION_MS = 900;

function durationFor(delta: number): number {
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.abs(delta) * MS_PER_STEP));
}

export function CountingNumber({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value) return;
    // Somebody who has asked for less motion gets the number, not the journey.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const duration = durationFor(value - from);
    const startedAt = performance.now();
    let frame = requestAnimationFrame(function tick(now: number) {
      const progress = Math.min(1, (now - startedAt) / duration);
      // Ease out, so it lands on the number rather than slamming into it.
      const eased = 1 - (1 - progress) ** 3;
      setShown(progress < 1 ? from + (value - from) * eased : value);
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <span translate="no" className={className}>
      {formatNumber(Math.round(shown))}
    </span>
  );
}
