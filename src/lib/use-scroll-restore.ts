import { useCallback, useRef } from "react";
import { useElementScrollRestoration } from "@tanstack/react-router";

// The window is the scroll target. Guarded because the hook still runs during
// the server render, where there is no window and nothing to restore.
const getWindowElement = () => (typeof window === "undefined" ? undefined : window);

/* Lands a page at its scroll offset inside the commit that mounts it.

   The router already restores the offset it remembers for a location, and
   resets to the top when it remembers none, but it does that from its
   onRendered event, which fires a commit after the one that swapped the page
   in. That extra commit is a painted frame at the wrong offset, and it shows
   both ways: opening a skin from a scrolled grid paints the page already
   scrolled, with its own header hidden behind the navbar, because the document
   just got shorter and the browser clamped the offset it was holding; stepping
   back paints the grid at the top before it jumps to where it was left.

   A ref callback runs inside the mounting commit and before the browser paints,
   so applying the offset there is what removes the frame. It can only remove
   it: the router still runs a commit later and still has the last word, so a
   missing or stale entry just means the page lands where it landed before.

   Put the returned ref on the page's outermost element. */
export function useScrollRestoreRef() {
  const entry = useElementScrollRestoration({ getElement: getWindowElement });
  // Read once, for this mount. The entry is replaced as the reader scrolls, and
  // a ref callback that changed identity would be re-run by React, yanking the
  // page back to where it was opened.
  const target = useRef<number | null>(null);
  if (target.current === null) target.current = entry?.scrollY ?? 0;

  return useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const top = target.current ?? 0;
    if (window.scrollY !== top) window.scrollTo(0, top);
  }, []);
}
