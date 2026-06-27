import type { Db } from "../db.js";
import type { Config } from "../config.js";
import { getCountryRegistry, GLOBAL_COUNTRY_CODE } from "../countries.js";
import { getUserLink } from "./identity.js";
import { focusedOption, invokerId, type DiscordInteraction } from "./commands.js";

export interface AutocompleteChoice {
  name: string;
  value: string;
}

// Discord caps an autocomplete response at 25 choices.
const MAX_CHOICES = 25;

interface AutocompleteDeps {
  db: Db;
  config: Config;
}

// Tracked-country list cached briefly: autocomplete fires on every keystroke, so
// even a cheap registry read is worth memoizing for a minute.
let countryCache: { at: number; codes: string[] } | null = null;
const COUNTRY_TTL_MS = 60_000;

async function trackedCountryCodes(deps: AutocompleteDeps): Promise<string[]> {
  const now = Date.now();
  if (countryCache && now - countryCache.at < COUNTRY_TTL_MS) return countryCache.codes;
  try {
    const registry = await getCountryRegistry(deps.db, deps.config);
    const codes = registry
      .filter((row) => row.status !== "paused")
      .map((row) => String(row.country).toUpperCase());
    countryCache = { at: now, codes };
    return codes;
  } catch {
    return countryCache?.codes ?? [];
  }
}

function filterByTyped(items: AutocompleteChoice[], typed: string): AutocompleteChoice[] {
  const needle = typed.trim().toLowerCase();
  const matched = needle
    ? items.filter((c) => c.value.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle))
    : items;
  return matched.slice(0, MAX_CHOICES);
}

async function countryChoices(deps: AutocompleteDeps, typed: string): Promise<AutocompleteChoice[]> {
  const codes = await trackedCountryCodes(deps);
  const choices: AutocompleteChoice[] = [{ name: "Global", value: GLOBAL_COUNTRY_CODE }];
  for (const code of codes) choices.push({ name: code, value: code });
  return filterByTyped(choices, typed);
}

async function usernameChoices(deps: AutocompleteDeps, interaction: DiscordInteraction, typed: string): Promise<AutocompleteChoice[]> {
  const id = invokerId(interaction);
  const choices: AutocompleteChoice[] = [];
  if (id) {
    const link = await getUserLink(deps.db, id).catch(() => null);
    if (link) choices.push({ name: `${link.osuUsername} (you)`, value: link.osuUsername });
  }
  // Always let the typed text be submittable as its own choice.
  const trimmed = typed.trim();
  if (trimmed && !choices.some((c) => c.value.toLowerCase() === trimmed.toLowerCase())) {
    choices.unshift({ name: trimmed, value: trimmed });
  }
  return filterByTyped(choices, typed);
}

// Builds up to 25 suggestions for whichever option the user is currently typing.
// Never throws: autocomplete must answer within Discord's 3s window, so callers
// get an empty list on any failure.
export async function handleAutocomplete(deps: AutocompleteDeps, interaction: DiscordInteraction): Promise<AutocompleteChoice[]> {
  const focused = focusedOption(interaction);
  if (!focused) return [];
  const typed = focused.value == null ? "" : String(focused.value);
  try {
    if (focused.name === "country") return await countryChoices(deps, typed);
    if (focused.name === "username" || focused.name === "player1" || focused.name === "player2") {
      return await usernameChoices(deps, interaction, typed);
    }
  } catch {
    return [];
  }
  return [];
}
