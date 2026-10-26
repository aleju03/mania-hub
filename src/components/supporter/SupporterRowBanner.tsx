import { useCallback, useEffect, useSyncExternalStore, type CSSProperties } from "react";

import { ensureSupporterNameStyles, getSupporterListThemes, subscribeSupporterNameStyles, type SupporterRowTheme } from "../../lib/live-backend";
import { useHydrated } from "../../lib/use-hydrated";
import { profileThemeStrip } from "./ProfileThemeBackdrop";

/* A supporter's profile theme carried into list rows: a still of it (the
   picker's thumb, faded in from clear on the left, a few KB and cached per
   theme) under the row's right side, so the rank, avatar and name stay on the
   row's own ground. Stills only: a list could never afford a live shader per
   row. A custom theme brings its own banner row image, made in the theme
   editor with the same fade. */

/* Who wears which theme, for a whole list at once; after hydration only, like
   styled names, so server and client markup agree. */
export function useSupporterRowThemes(): (userId: number | null | undefined) => SupporterRowTheme | null {
  const hydrated = useHydrated();
  const themes = useSyncExternalStore(subscribeSupporterNameStyles, () => (hydrated ? getSupporterListThemes() : null), () => null);
  useEffect(() => {
    ensureSupporterNameStyles();
  }, []);
  return useCallback((userId) => (themes && Number(userId) > 0 ? themes.get(Number(userId)) ?? null : null), [themes]);
}

/* The banner as the row's own background, over whatever colour it has. A
   card fills with it; a full-width table row takes a strip at its right end
   about as wide as the still, since stretched across the whole row it blurs
   into a few blown-up shapes. */
export function supporterRowBackground(theme: SupporterRowTheme | null, fit: "card" | "strip" = "card"): CSSProperties | undefined {
  if (!theme) return undefined;
  return {
    backgroundImage: `url("${typeof theme === "string" ? profileThemeStrip(theme) : theme.image}")`,
    backgroundSize: fit === "card" ? "cover" : "min(440px, 45%) auto",
    backgroundPosition: "right 45%",
    backgroundRepeat: "no-repeat",
  };
}
