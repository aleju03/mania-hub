import { useEffect, useState } from "react";
import { activateLiveCountry, isLiveBackendConfigured, type LiveCountryFeatureTier } from "./live-backend";

const POLL_INTERVAL_MS = 6_000;

// Last known feature tier per country, kept across re-renders and route
// changes. Lets the hook return a tier synchronously when a country has been
// seen before, so consumers (e.g. the nav Snipes tab) don't flicker while a
// fresh activation request is in flight.
const tierCache = new Map<string, LiveCountryFeatureTier>();

export function getCachedCountryTier(country: string): LiveCountryFeatureTier | null {
  return tierCache.get(country) ?? null;
}

export interface CountryWarmingState {
  /** True while the live backend is still building this country's first roster. */
  warming: boolean;
  /** True until the first activation response for the current country lands. */
  checking: boolean;
  /** Feature tier of the country, or null until the first activation lands. */
  featureTier: LiveCountryFeatureTier | null;
}

/**
 * Activates `country` on the live backend and tracks whether it is still cold
 * (no roster projection yet). While warming, it polls until the backend reports
 * the country ready, then flips `warming` to false so the page can load data.
 *
 * Also surfaces the country's feature tier (cached per country, so repeat
 * visits resolve synchronously without a flicker).
 *
 * Returns inert values when the live backend is not configured, so callers can
 * treat it as a no-op fallback.
 */
export function useCountryWarming(country: string): CountryWarmingState {
  const liveBackendEnabled = isLiveBackendConfigured();
  const [warming, setWarming] = useState(false);
  const [checking, setChecking] = useState(liveBackendEnabled);
  const [featureTier, setFeatureTier] = useState<LiveCountryFeatureTier | null>(
    () => tierCache.get(country) ?? null,
  );

  useEffect(() => {
    if (!liveBackendEnabled) {
      setWarming(false);
      setChecking(false);
      setFeatureTier(null);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    setChecking(true);
    // Seed from cache so a previously-seen country resolves with no flicker.
    setFeatureTier(tierCache.get(country) ?? null);

    const check = () => {
      activateLiveCountry(country).then((result) => {
        if (cancelled) return;
        setChecking(false);
        if (result?.featureTier) {
          tierCache.set(country, result.featureTier);
          setFeatureTier(result.featureTier);
        }
        const stillWarming = result?.warming === true;
        setWarming(stillWarming);
        if (stillWarming) {
          pollTimer = setTimeout(check, POLL_INTERVAL_MS);
        }
      });
    };

    check();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [country, liveBackendEnabled]);

  return { warming, checking, featureTier };
}
