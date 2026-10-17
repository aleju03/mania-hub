import { useEffect, useState, useSyncExternalStore } from "react";
import { ensureSupporterNameStyles, fetchLiveSupporterProfileLook, getSupporterSleeve, peekLiveSupporterPackStyle, subscribeSupporterNameStyles } from "./live-backend";
import { NO_PACK_STYLE, type SupporterCardSleeveId, type SupporterPackStyle } from "./supporter-pack-style";
import { useHydrated } from "./use-hydrated";

/* A player's packs cosmetics, from the shared supporter look cache: what
   their own collection, binder and reveals wear. Nothing for anyone who is
   not an active supporter. */
export function useSupporterPackStyle(userId: number | null | undefined): SupporterPackStyle {
  const id = Math.floor(Number(userId) || 0);
  const [style, setStyle] = useState<SupporterPackStyle>(() => (id > 0 ? peekLiveSupporterPackStyle(id) : undefined) ?? NO_PACK_STYLE);
  useEffect(() => {
    if (id <= 0) {
      setStyle(NO_PACK_STYLE);
      return;
    }
    let alive = true;
    setStyle(peekLiveSupporterPackStyle(id) ?? NO_PACK_STYLE);
    void fetchLiveSupporterProfileLook(id).then((value) => {
      if (alive) setStyle(value.packStyle);
    });
    return () => {
      alive = false;
    };
  }, [id]);
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
