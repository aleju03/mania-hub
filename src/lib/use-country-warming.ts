import { useEffect, useState } from "react";
import { activateLiveCountry, isLiveBackendConfigured, type LiveCountryActivation, type LiveCountryFeature, type LiveCountryFeatureTier } from "./live-backend";
import { isGlobalScope, normalizeCountryScope } from "./country";

const POLL_INTERVAL_MS = 6_000;
const COUNTRY_TIER_CACHE_KEY = "mania-hub-country-feature-tiers-v1";
const COUNTRY_WARMING_CACHE_KEY = "mania-hub-country-warming-v1";

// Last known feature tier per country, kept across re-renders and route
// changes. Lets the hook return a tier synchronously when a country has been
// seen before, so consumers (e.g. the nav Snipes tab) don't flicker while a
// fresh activation request is in flight.
const tierCache = readTierCache();
const warmingCache = readWarmingCache();
const activationRequests = new Map<string, Promise<LiveCountryActivation | null>>();

export function getCachedCountryTier(country: string): LiveCountryFeatureTier | null {
  return tierCache.get(normalizeCountryScope(country)) ?? null;
}

export function seedCountryTierCache(countries: LiveCountryFeature[] | null | undefined): void {
  if (!countries?.length) return;
  for (const entry of countries) {
    tierCache.set(normalizeCountryScope(entry.country), entry.featureTier);
  }
  writeTierCache(tierCache);
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
  const normalizedCountry = normalizeCountryScope(country);
  const liveBackendEnabled = isLiveBackendConfigured();
  const [warming, setWarmingState] = useState(() => liveBackendEnabled && warmingCache.has(normalizedCountry));
  const [checking, setChecking] = useState(liveBackendEnabled);
  const [featureTier, setFeatureTier] = useState<LiveCountryFeatureTier | null>(
    () => tierCache.get(normalizedCountry) ?? null,
  );
  const warmingFromCache = liveBackendEnabled && warmingCache.has(normalizedCountry);
  const setWarming = (value: boolean) => {
    setCachedCountryWarming(normalizedCountry, value);
    setWarmingState(value);
  };

  useEffect(() => {
    if (!liveBackendEnabled) {
      setWarming(false);
      setChecking(false);
      setFeatureTier(null);
      return;
    }
    if (isGlobalScope(normalizedCountry)) {
      tierCache.set(normalizedCountry, "maps_warm");
      writeTierCache(tierCache);
      setWarming(false);
      setChecking(false);
      setFeatureTier("maps_warm");
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    setChecking(true);
    // Seed from cache so a previously-seen country resolves with no flicker.
    setFeatureTier(tierCache.get(normalizedCountry) ?? null);
    setWarmingState(warmingCache.has(normalizedCountry));

    const check = () => {
      activateLiveCountryOnce(normalizedCountry).then((result) => {
        if (cancelled) return;
        setChecking(false);
        if (result?.featureTier) {
          tierCache.set(normalizedCountry, result.featureTier);
          writeTierCache(tierCache);
          setFeatureTier(result.featureTier);
        }
        const stillWarming = result ? result.warming === true : warmingCache.has(normalizedCountry);
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
  }, [liveBackendEnabled, normalizedCountry]);

  return { warming: warming || warmingFromCache, checking, featureTier };
}

function activateLiveCountryOnce(country: string): Promise<LiveCountryActivation | null> {
  const normalizedCountry = normalizeCountryScope(country);
  const existing = activationRequests.get(normalizedCountry);
  if (existing) return existing;
  const request = activateLiveCountry(normalizedCountry)
    .finally(() => activationRequests.delete(normalizedCountry));
  activationRequests.set(normalizedCountry, request);
  return request;
}

function readTierCache(): Map<string, LiveCountryFeatureTier> {
  const entries = new Map<string, LiveCountryFeatureTier>();
  if (typeof window === "undefined") return entries;
  try {
    const raw = window.localStorage.getItem(COUNTRY_TIER_CACHE_KEY);
    if (!raw) return entries;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return entries;
    for (const [country, tier] of Object.entries(parsed)) {
      if (isCountryFeatureTier(tier)) entries.set(normalizeCountryScope(country), tier);
    }
  } catch {
    // Best-effort cache only; activation will repair it.
  }
  return entries;
}

function writeTierCache(cache: Map<string, LiveCountryFeatureTier>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COUNTRY_TIER_CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Best-effort cache only.
  }
}

function readWarmingCache(): Set<string> {
  const entries = new Set<string>();
  if (typeof window === "undefined") return entries;
  try {
    const raw = window.localStorage.getItem(COUNTRY_WARMING_CACHE_KEY);
    if (!raw) return entries;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return entries;
    for (const country of parsed) {
      if (typeof country === "string") entries.add(normalizeCountryScope(country));
    }
  } catch {
    // Best-effort cache only; activation polling will repair it.
  }
  return entries;
}

function setCachedCountryWarming(country: string, warming: boolean): void {
  const normalizedCountry = normalizeCountryScope(country);
  if (warming) warmingCache.add(normalizedCountry);
  else warmingCache.delete(normalizedCountry);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COUNTRY_WARMING_CACHE_KEY, JSON.stringify([...warmingCache]));
  } catch {
    // Best-effort cache only.
  }
}

function isCountryFeatureTier(value: unknown): value is LiveCountryFeatureTier {
  return value === "indexed" || value === "maps_warm" || value === "live" || value === "snipes";
}
