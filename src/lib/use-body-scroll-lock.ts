import { useLayoutEffect } from "react";

/* One ref-counted body scroll lock for every modal on the site.
 *
 * Each modal used to capture document.body.style.overflow itself and restore
 * that value on close, which breaks the moment two locks overlap. The skin
 * settings modal hands off to the preview editor and the file updater in one
 * tick (setSettingsOpen(false) + setEditingPreviews(true)), so the second
 * modal captured "hidden" from the first one and wrote it back on close -
 * leaving the page unscrollable until a reload. Counting the locks and saving
 * the real page styles once, on the first acquire, is what makes a handoff
 * safe: the styles only come back when the last modal is gone.
 */

interface SavedStyles {
  overflow: string;
  paddingRight: string;
  compensation: string;
}

let lockCount = 0;
let saved: SavedStyles | null = null;

function applyLock(): void {
  const body = document.body;
  const root = document.documentElement;
  saved = {
    overflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
    compensation: root.style.getPropertyValue("--modal-scrollbar-compensation"),
  };
  // Hiding the scrollbar reflows the page underneath unless we hand its width
  // back as padding. Browsers with scrollbar-gutter: stable already reserve it.
  const scrollbarWidth = window.innerWidth - root.clientWidth;
  const hasStableScrollbarGutter = typeof CSS !== "undefined" && CSS.supports?.("scrollbar-gutter", "stable");
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0 && !hasStableScrollbarGutter) {
    const currentPaddingRight = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
    body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
    // Modal shells add this to their own right padding so the card does not
    // drift when the scrollbar disappears.
    root.style.setProperty("--modal-scrollbar-compensation", `${scrollbarWidth}px`);
  }
}

function restoreLock(): void {
  if (!saved) return;
  const body = document.body;
  const root = document.documentElement;
  body.style.overflow = saved.overflow;
  body.style.paddingRight = saved.paddingRight;
  if (saved.compensation) {
    root.style.setProperty("--modal-scrollbar-compensation", saved.compensation);
  } else {
    root.style.removeProperty("--modal-scrollbar-compensation");
  }
  saved = null;
}

/* Locks the body until the returned release is called. Safe to call from a
   non-hook context (a modal that locks outside React's lifecycle); the
   release is idempotent, so a double call cannot unbalance the count. */
export function acquireBodyScrollLock(): () => void {
  if (typeof document === "undefined") return () => {};
  if (lockCount === 0) applyLock();
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) restoreLock();
  };
}

/* Holds the lock for as long as `active` is true. Modals that fade out pass
   the state they clear in onExitComplete, so the page stays still until the
   overlay is actually gone. */
export function useBodyScrollLock(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    return acquireBodyScrollLock();
  }, [active]);
}

/* Test-only: module state outlives a component tree, so a suite that renders
   a locked modal would leak the count into the next test. */
export function resetBodyScrollLockForTests(): void {
  lockCount = 0;
  saved = null;
}
