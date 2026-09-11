import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, as render state.
 *
 * Null until the browser answers: on the server and during hydration there is
 * no viewport to ask, and a component that renders both its mobile and desktop
 * layouts under `sm:hidden` / `hidden sm:block` can keep doing so for exactly
 * that pass, then drop the one nobody can see. Halving a 50-row table's render
 * is the point; the markup the visitor sees does not change.
 */
export function useMediaQuery(query: string): boolean | null {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => null,
  );
}

/** Tailwind's `sm` breakpoint, the one the boards split their layouts on. */
export const SM_MEDIA_QUERY = "(min-width: 640px)";
