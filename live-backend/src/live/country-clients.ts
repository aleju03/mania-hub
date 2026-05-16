import { nowIso } from "../shared/score.js";

export interface CountryClientStats {
  country: string;
  activeUsers: number;
  lastActiveAt: string | null;
}

export class CountryClientTracker {
  private readonly countries = new Map<string, CountryClientStats>();

  open(country: string): () => void {
    const normalized = normalizeCountry(country);
    const current = this.countries.get(normalized) ?? { country: normalized, activeUsers: 0, lastActiveAt: null };
    current.activeUsers += 1;
    current.lastActiveAt = nowIso();
    this.countries.set(normalized, current);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.countries.get(normalized);
      if (!next) return;
      next.activeUsers = Math.max(0, next.activeUsers - 1);
      next.lastActiveAt = nowIso();
      this.countries.set(normalized, next);
    };
  }

  snapshot(): CountryClientStats[] {
    return [...this.countries.values()].map((entry) => ({ ...entry }));
  }
}

function normalizeCountry(country: string): string {
  return country.trim().toUpperCase().slice(0, 2);
}
