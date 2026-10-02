import { msg } from "@lingui/core/macro";

export const SETTINGS_TABS = [
  { id: "skin", label: msg`skin & layout` },
  { id: "viewer", label: msg`playback` },
  { id: "preferences", label: msg`preferences` },
  { id: "appearance", label: msg`appearance` },
] as const;

export type SettingsTabId = typeof SETTINGS_TABS[number]["id"];

// Search validation is part of the eager route definition. Keep it separate
// from the panel so it cannot pull the settings UI into the shared shell.
export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return SETTINGS_TABS.some((tab) => tab.id === value);
}
