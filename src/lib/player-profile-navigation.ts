import type { ParsedHistoryState } from "@tanstack/history";

declare module "@tanstack/history" {
  interface HistoryState {
    showPlayerCountryFlag?: boolean;
  }
}

export function showPlayerCountryFlagState(prev: ParsedHistoryState) {
  return { ...prev, showPlayerCountryFlag: true };
}

export function preservePlayerCountryFlagState(showCountryFlag: boolean) {
  return (prev: ParsedHistoryState) => ({
    ...prev,
    showPlayerCountryFlag: showCountryFlag || undefined,
  });
}
