import type { DiscordCommandDefinition } from "./rest.js";

// Application command option types (subset we use).
const OPT_STRING = 3;
const OPT_NUMBER = 10;

// Install/context model: integration_types [0,1] = guild + user install;
// contexts [0,1,2] = guild, bot DM, private channel. Lets the lookup commands
// run anywhere while feeds still work when installed to a guild.
const ANY_INSTALL = { integration_types: [0, 1], contexts: [0, 1, 2] };
// Subscription management only makes sense inside a guild channel.
const GUILD_ONLY = { integration_types: [0], contexts: [0] };

const FEED_CHOICES = [
  { name: "Top plays", value: "top_play" },
  { name: "Snipes", value: "snipe" },
];

const KEYS_CHOICES = [
  { name: "4K", value: "4k" },
  { name: "7K", value: "7k" },
  { name: "Any", value: "any" },
];

const usernameOption = (required = true) => ({
  type: OPT_STRING,
  name: "username",
  description: "osu! username or user id",
  required,
});

const countryOption = {
  type: OPT_STRING,
  name: "country",
  description: "2-letter country code (e.g. CR) or 'global'",
  required: false,
};

export const DISCORD_COMMANDS: DiscordCommandDefinition[] = [
  {
    ...ANY_INSTALL,
    name: "player",
    description: "Show an osu!mania player's profile card",
    options: [usernameOption()],
  },
  {
    ...ANY_INSTALL,
    name: "maniacard",
    description: "Show a player's maniacard skill card",
    options: [usernameOption()],
  },
  {
    ...ANY_INSTALL,
    name: "recent",
    description: "Show a player's most recent mania plays",
    options: [usernameOption()],
  },
  {
    ...ANY_INSTALL,
    name: "rankings",
    description: "Show the mania rankings for a country (or global)",
    options: [countryOption],
  },
  {
    ...ANY_INSTALL,
    name: "top",
    description: "Show recent notable top plays in a country",
    options: [countryOption],
  },
  {
    ...ANY_INSTALL,
    name: "snipes",
    description: "Show recent snipes on a country's leaderboards",
    options: [countryOption],
  },
  {
    ...ANY_INSTALL,
    name: "farm",
    description: "Get PP-gain farm recommendations for a player",
    options: [
      usernameOption(),
      { type: OPT_STRING, name: "keys", description: "Key mode", required: false, choices: KEYS_CHOICES },
    ],
  },
  {
    ...ANY_INSTALL,
    name: "dan",
    description: "Estimate the dan level of a beatmap",
    options: [
      { type: OPT_STRING, name: "beatmap", description: "Beatmap id or osu! beatmap URL", required: true },
    ],
  },
  {
    ...ANY_INSTALL,
    name: "compare",
    description: "Compare two mania players head to head",
    options: [
      { type: OPT_STRING, name: "player1", description: "First osu! username or id", required: true },
      { type: OPT_STRING, name: "player2", description: "Second osu! username or id", required: true },
    ],
  },
  {
    ...GUILD_ONLY,
    name: "subscribe",
    description: "Post a live feed (top plays / snipes) to this channel",
    options: [
      { type: OPT_STRING, name: "feed", description: "Which feed", required: true, choices: FEED_CHOICES },
      countryOption,
      { type: OPT_NUMBER, name: "min_pp", description: "Only post events at or above this pp", required: false },
    ],
  },
  {
    ...GUILD_ONLY,
    name: "unsubscribe",
    description: "Stop a live feed in this channel",
    options: [
      { type: OPT_STRING, name: "feed", description: "Which feed", required: true, choices: FEED_CHOICES },
      countryOption,
    ],
  },
  {
    ...GUILD_ONLY,
    name: "subscriptions",
    description: "List the live feeds configured in this server",
    options: [],
  },
  {
    ...ANY_INSTALL,
    name: "help",
    description: "What can the Mania Hub bot do?",
    options: [],
  },
];

// Commands that require the Manage Server permission to run.
export const MANAGE_GUILD_COMMANDS = new Set(["subscribe", "unsubscribe"]);

// ---------------------------------------------------------------------------
// Interaction payload shapes (only what we read).
// ---------------------------------------------------------------------------

export interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id?: string };
  member?: { permissions?: string; user?: { id?: string; username?: string } };
  user?: { id?: string; username?: string };
  data?: {
    id?: string;
    name?: string;
    type?: number;
    options?: InteractionOption[];
  };
}

// Interaction types
export const INTERACTION_PING = 1;
export const INTERACTION_APPLICATION_COMMAND = 2;
// Response types
export const RESPONSE_PONG = 1;
export const RESPONSE_CHANNEL_MESSAGE = 4;
export const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
// Message flags
export const FLAG_EPHEMERAL = 1 << 6;
// Permissions
const PERMISSION_MANAGE_GUILD = 1n << 5n;
const PERMISSION_ADMINISTRATOR = 1n << 3n;

export function optionValue(interaction: DiscordInteraction, name: string): string | number | boolean | undefined {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}

export function stringOption(interaction: DiscordInteraction, name: string): string | undefined {
  const value = optionValue(interaction, name);
  if (value == null) return undefined;
  const text = String(value).trim();
  return text.length ? text : undefined;
}

export function numberOption(interaction: DiscordInteraction, name: string): number | undefined {
  const value = optionValue(interaction, name);
  if (value == null) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

export function invokerId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

export function hasManageGuild(interaction: DiscordInteraction): boolean {
  const raw = interaction.member?.permissions;
  if (!raw) return false;
  let bits: bigint;
  try {
    bits = BigInt(raw);
  } catch {
    return false;
  }
  return (bits & PERMISSION_MANAGE_GUILD) !== 0n || (bits & PERMISSION_ADMINISTRATOR) !== 0n;
}
