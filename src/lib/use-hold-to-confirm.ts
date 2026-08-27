import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Press and hold instead of a confirm step, the gesture the packs collection
 * uses for Recycle all.
 *
 * A destructive control that fires on one click can fire on a stray one, and a
 * click-then-click-again confirm has its own failure: the second click is armed
 * for a while, so a double click on the first one deletes. A hold is a single
 * deliberate gesture, with a fill that has to finish before anything happens
 * and an abort that costs nothing. Letting go early sets `hint` for a moment so
 * the button can say what it wanted, since a press that did nothing otherwise
 * reads as a dead button.
 */

export const HOLD_TO_CONFIRM_MS = 700;
const HINT_MS = 1600;

export interface HoldToConfirm {
  /** True while the press is running, for the fill's width. */
  holding: boolean;
  /** True for a moment after an aborted hold, for the "hold to ..." label. */
  hint: boolean;
  holdMs: number;
  /** Spread onto the button; pointer and keyboard both hold. */
  handlers: {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    onKeyUp: (event: React.KeyboardEvent) => void;
    onBlur: () => void;
  };
}

export function useHoldToConfirm(onConfirm: () => void, holdMs: number = HOLD_TO_CONFIRM_MS): HoldToConfirm {
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const hintTimer = useRef<number | null>(null);
  // Read at fire time, so a hold that started before the latest render still
  // runs the current handler rather than a stale closure.
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  const clearHold = useCallback(() => {
    if (holdTimer.current === null) return false;
    window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
    return true;
  }, []);

  const start = useCallback(() => {
    // Already holding: a key's auto-repeat must not restart the fill.
    if (holdTimer.current !== null) return;
    if (hintTimer.current !== null) {
      window.clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
    setHint(false);
    setHolding(true);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      setHolding(false);
      confirmRef.current();
    }, holdMs);
  }, [holdMs]);

  const cancel = useCallback(() => {
    if (!clearHold()) return;
    setHint(true);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => {
      hintTimer.current = null;
      setHint(false);
    }, HINT_MS);
  }, [clearHold]);

  useEffect(() => () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
  }, []);

  return {
    holding,
    hint,
    holdMs,
    handlers: {
      onPointerDown: (event) => {
        // Primary button only; a right-click opens a menu, not a delete.
        if (event.button !== 0) return;
        start();
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      onKeyDown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Both would otherwise fire the button's own click on release.
        event.preventDefault();
        start();
      },
      onKeyUp: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        cancel();
      },
      onBlur: cancel,
    },
  };
}
