import { useEffect, useState } from "react";
import { activateLiveCountry, isLiveBackendConfigured } from "./live-backend";

const POLL_INTERVAL_MS = 6_000;

export interface CountryWarmingState {
  /** True while the live backend is still building this country's first roster. */
  warming: boolean;
  /** True until the first activation response for the current country lands. */
  checking: boolean;
}

/**
 * Activates `country` on the live backend and tracks whether it is still cold
 * (no roster projection yet). While warming, it polls until the backend reports
 * the country ready, then flips `warming` to false so the page can load data.
 *
 * Returns `{ warming: false, checking: false }` when the live backend is not
 * configured, so callers can treat it as a no-op fallback.
 */
export function useCountryWarming(country: string): CountryWarmingState {
  const liveBackendEnabled = isLiveBackendConfigured();
  const [warming, setWarming] = useState(false);
  const [checking, setChecking] = useState(liveBackendEnabled);

  useEffect(() => {
    if (!liveBackendEnabled) {
      setWarming(false);
      setChecking(false);
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    setChecking(true);

    const check = () => {
      activateLiveCountry(country).then((result) => {
        if (cancelled) return;
        setChecking(false);
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

  return { warming, checking };
}
