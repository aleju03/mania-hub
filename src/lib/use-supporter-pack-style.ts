import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ensureSupporterNameStyles, fetchLiveSupporterProfileLook, getSupporterSleeve, peekLiveSupporterPackStyle, subscribeSupporterNameStyles } from "./live-backend";
import { NO_PACK_STYLE, parsePackStyle, type SupporterCardSleeveId, type SupporterPackStyle } from "./supporter-pack-style";
import { useHydrated } from "./use-hydrated";

/* The viewer's own packs cosmetics as last read, kept in this browser: the
   look takes a request to arrive, and until it did a fresh page drew the plain
   wrapper and binder for half a second before the viewer's own. */
const OWN_STYLE_KEY = "mania-hub-own-pack-style:v1";

function readOwnPackStyle(id: number): SupporterPackStyle | undefined {
  try {
    const stored = JSON.parse(window.localStorage.getItem(OWN_STYLE_KEY) ?? "null") as { id?: unknown; style?: unknown } | null;
    return stored && stored.id === id ? parsePackStyle(stored.style) : undefined;
  } catch {
    return undefined;
  }
}

function writeOwnPackStyle(id: number, style: SupporterPackStyle): void {
  try {
    window.localStorage.setItem(OWN_STYLE_KEY, JSON.stringify({ id, style }));
  } catch {
    // Storage is full or blocked: the next visit just waits for the look.
  }
}

/* A player's packs cosmetics, from the shared supporter look cache: what
   their own collection, binder and reveals wear. Nothing for anyone who is
   not an active supporter. `own` marks the viewer's own, which is also
   remembered between visits. */
export function useSupporterPackStyle(userId: number | null | undefined, { own = false }: { own?: boolean } = {}): SupporterPackStyle {
  const id = Math.floor(Number(userId) || 0);
  const [style, setStyle] = useState<SupporterPackStyle>(() => (id > 0 ? peekLiveSupporterPackStyle(id) : undefined) ?? NO_PACK_STYLE);
  // A layout effect, so the remembered style is in before the first paint.
  useLayoutEffect(() => {
    if (id <= 0) {
      setStyle(NO_PACK_STYLE);
      return;
    }
    let alive = true;
    setStyle(peekLiveSupporterPackStyle(id) ?? (own ? readOwnPackStyle(id) : undefined) ?? NO_PACK_STYLE);
    void fetchLiveSupporterProfileLook(id).then((value) => {
      if (!alive) return;
      setStyle(value.packStyle);
      if (own) writeOwnPackStyle(id, value.packStyle);
    });
    return () => {
      alive = false;
    };
  }, [id, own]);
  return style;
}

/* The sleeve a holder's tiles wear, from the one shared map of active
   supporters (the name style map), so a page of many collectors' cards costs
   no request per collector. Joins after hydration, like the name styles. */
export function useSupporterSleeve(userId: number | null | undefined): SupporterCardSleeveId | null {
  const id = Math.floor(Number(userId) || 0);
  const hydrated = useHydrated();
  useEffect(() => {
    if (id > 0) ensureSupporterNameStyles();
  }, [id]);
  return useSyncExternalStore(
    subscribeSupporterNameStyles,
    () => (hydrated && id > 0 ? getSupporterSleeve(id) : null),
    () => null,
  );
}
