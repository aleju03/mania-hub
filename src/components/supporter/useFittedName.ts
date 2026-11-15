import { useCallback } from "react";

/* A big name that shrinks to fit its column instead of truncating: the
   returned ref goes on the name's direct parent (a plain element: motion
   components don't re-run a changed callback ref), and the name's font size
   multiplies by var(--name-scale, 1). A callback ref with its own cleanup,
   so a box that remounts is fitted as it lands. */

/* Smallest share of its full size a name shrinks to; past it, it truncates. */
const NAME_MIN_SCALE = 0.55;

export function useFittedName(deps: readonly unknown[]) {
  return useCallback((box: HTMLElement | null) => {
    if (!box) return;
    // Set straight on the element, so measuring never re-renders anything.
    const fit = () => {
      const text = box.firstElementChild as HTMLElement | null;
      if (!text) return;
      box.style.setProperty("--name-scale", "1");
      const full = text.scrollWidth, room = text.clientWidth;
      // a hair under the exact ratio: glyph widths round up, and one pixel over brings the ellipsis back
      if (full > room && full > 0) box.style.setProperty("--name-scale", String(Math.max(NAME_MIN_SCALE, (room / full) * 0.96)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    let alive = true;
    void document.fonts?.ready.then(() => alive && fit());
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}
