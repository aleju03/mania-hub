import type { DiscordCommandDefinition } from "./rest.js";

// Application command option types.
const OPT_SUB_COMMAND = 1;
const OPT_STRING = 3;
const OPT_BOOLEAN = 5;
const OPT_NUMBER = 10;

// Install/context model: integration_types [0,1] = guild + user install;
// contexts [0,1,2] = guild, bot DM, private channel. Lets the lookup commands
// run anywhere (including a user's DMs) while feeds still work in a guild.
const ANY_INSTALL = { integration_types: [0, 1], contexts: [0, 1, 2] };
// Subscription management only makes sense inside a guild channel.
const GUILD_ONLY = { integration_types: [0], contexts: [0] };

const FEED_CHOICES = [
  { name: "Top plays", value: "top_play" },
  { name: "Snipes", value: "snipe" },
  { name: "New farm maps", value: "new_map" },
];

const KEYS_CHOICES = [
  { name: "4K", value: "4k" },
  { name: "7K", value: "7k" },
  { name: "Any", value: "any" },
];

const RANGE_CHOICES = [
  { name: "Last 24 hours", value: "24h" },
  { name: "Last 3 days", value: "3d" },
  { name: "Last 7 days", value: "7d" },
  { name: "Last 30 days", value: "30d" },
];

const MAPS_TAB_CHOICES = [
  { name: "Most farmed", value: "farmed" },
  { name: "Most played", value: "popular" },
];

const RANKINGS_SORT_CHOICES = [
  { name: "Performance (pp)", value: "pp" },
  { name: "7-day rank gain", value: "7d" },
];

const STATUS_CHOICES = [
  { name: "Ranked", value: "ranked" },
  { name: "Loved", value: "loved" },
  { name: "Graveyard", value: "graveyard" },
  { name: "Other", value: "other" },
];

// Umbrella pattern buckets, matching the Maps random tab. Each expands to its
// sibling patterns in the handler (e.g. "jack" also matches chordjack/longjack).
const PATTERN_CHOICES = [
  { name: "Jack", value: "jack" },
  { name: "Chordjack", value: "chordjack" },
  { name: "Stream", value: "stream" },
  { name: "Jumpstream", value: "jumpstream" },
  { name: "Stamina", value: "stamina" },
  { name: "Tech", value: "tech" },
  { name: "LN", value: "ln" },
  { name: "SV", value: "sv" },
  { name: "Tournament", value: "tiebreaker" },
];

// A username option. Optional everywhere: when omitted, the command falls back
// to the caller's linked osu! account (see /link). Autocomplete surfaces the
// caller's own linked name so picking "yourself" is one keystroke.
const usernameOption = (description = "osu! username or id (defaults to your linked account)") => ({
  type: OPT_STRING,
  name: "username",
  description,
  required: false,
  autocomplete: true,
});

const countryOption = {
  type: OPT_STRING,
  name: "country",
  description: "2-letter country code (e.g. CR) or 'global'",
  required: false,
  autocomplete: true,
};

const keysOption = {
  type: OPT_STRING,
  name: "keys",
  description: "Key mode",
  required: false,
  choices: KEYS_CHOICES,
};

const statusOption = {
  type: OPT_STRING,
  name: "status",
  description: "Map status",
  required: false,
  choices: STATUS_CHOICES,
};

const starsMinOption = {
  type: OPT_NUMBER,
  name: "stars_min",
  description: "Minimum star rating",
  required: false,
};

const starsMaxOption = {
  type: OPT_NUMBER,
  name: "stars_max",
  description: "Maximum star rating",
  required: false,
};

// Lets a caller keep a reply private (only they see it). Off by default so
// results stay shareable, which is the point of a stats bot.
const hiddenOption = {
  type: OPT_BOOLEAN,
  name: "hidden",
  description: "Only you can see the reply (default: off)",
  required: false,
};

export const DISCORD_COMMANDS: DiscordCommandDefinition[] = [
  // --- Identity -----------------------------------------------------------
  {
    ...ANY_INSTALL,
    name: "link",
    description: "Tell the bot which osu! player you are, so commands work without a username",
    options: [{ type: OPT_STRING, name: "username", description: "Your osu! username or id", required: true }],
  },
  { ...ANY_INSTALL, name: "unlink", description: "Remove your saved osu! account", options: [] },
  { ...ANY_INSTALL, name: "whoami", description: "Show which osu! account is linked to you", options: [] },

  // --- Personal profile / lookups ----------------------------------------
  {
    ...ANY_INSTALL,
    name: "me",
    description: "Your personal dashboard: ranks, highlights and playstyle",
    options: [hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "player",
    description: "Show an osu!mania player's profile card",
    options: [usernameOption(), hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "maniacard",
    description: "Show a player's maniacard skill card",
    options: [usernameOption(), hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "recent",
    description: "Show a player's most recent mania plays",
    options: [usernameOption(), hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "activity",
    description: "Show a player's playstyle and activity breakdown",
    options: [usernameOption(), hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "goals",
    description: "Show a player's goals and progress",
    options: [usernameOption(), hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "farm",
    description: "Get pp-gain farm recommendations for a player",
    options: [usernameOption(), keysOption, hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "vs",
    // Both players are optional at the schema level: Discord rejects a required
    // option placed after an optional one (and the bulk command registration is
    // atomic, so one bad command 400s them all). player1 defaults to the caller's
    // linked account; the handler requires player2 and errors clearly if it's
    // missing.
    description: "Compare two mania players side by side",
    options: [
      { type: OPT_STRING, name: "player1", description: "First player (defaults to your linked account)", required: false, autocomplete: true },
      { type: OPT_STRING, name: "player2", description: "Other player's osu! username or id (required)", required: false, autocomplete: true },
      hiddenOption,
    ],
  },
  // Score lookup on the last map shown in the channel (from /recent, /map, ...).
  // Registered under three names so people can reach for whichever they know;
  // all run the same handler. /c is the quick alias, /pb and /compare are the
  // common osu!-bot spellings.
  {
    ...ANY_INSTALL,
    name: "pb",
    description: "Your best score on the last map shown in this channel",
    options: [usernameOption(), hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "c",
    description: "Your best score on the last map shown in this channel",
    options: [usernameOption(), hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "compare",
    description: "Your best score on the last map shown in this channel",
    options: [usernameOption(), hiddenOption],
  },

  // --- Browse (country / global) -----------------------------------------
  {
    ...ANY_INSTALL,
    name: "rankings",
    description: "Show the mania rankings for a country (or global)",
    options: [
      countryOption,
      { type: OPT_STRING, name: "sort", description: "How to sort (Global board only)", required: false, choices: RANKINGS_SORT_CHOICES },
      hiddenOption,
    ],
  },
  {
    ...ANY_INSTALL,
    name: "top",
    description: "Show recent notable top plays in a country",
    options: [
      countryOption,
      { type: OPT_STRING, name: "range", description: "Time window", required: false, choices: RANGE_CHOICES },
      keysOption,
      hiddenOption,
    ],
  },
  {
    ...ANY_INSTALL,
    name: "tracker",
    description: "Show the latest live mania scores in a country",
    options: [countryOption, hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "maps",
    description: "Show the most farmed or played maps in a country",
    options: [
      countryOption,
      { type: OPT_STRING, name: "tab", description: "Which list", required: false, choices: MAPS_TAB_CHOICES },
      keysOption,
      hiddenOption,
    ],
  },
  {
    ...ANY_INSTALL,
    name: "snipes",
    description: "Show recent snipes on a country's leaderboards",
    options: [countryOption, hiddenOption],
  },

  // --- Random map pickers -------------------------------------------------
  // Both default to the global board; an explicit country narrows the pool.
  {
    ...ANY_INSTALL,
    name: "randomfarm",
    description: "Pick a random popular farm map (defaults to the global farm board)",
    options: [countryOption, keysOption, statusOption, starsMinOption, starsMaxOption,
      { type: OPT_NUMBER, name: "min_pp", description: "Only maps farmed for at least this pp", required: false },
      hiddenOption],
  },
  {
    ...ANY_INSTALL,
    name: "randomfav",
    description: "Pick a random favourited map, like the Maps random tab",
    options: [countryOption, keysOption, statusOption,
      { type: OPT_STRING, name: "pattern", description: "Pattern type", required: false, choices: PATTERN_CHOICES },
      starsMinOption, starsMaxOption, hiddenOption],
  },

  // --- Beatmap tools ------------------------------------------------------
  {
    ...ANY_INSTALL,
    name: "dan",
    description: "Estimate the dan level of a beatmap",
    options: [
      { type: OPT_STRING, name: "beatmap", description: "Beatmap id or osu! beatmap URL", required: true },
      hiddenOption,
    ],
  },
  {
    ...ANY_INSTALL,
    name: "map",
    description: "Show a beatmap's details, dan estimate and farm value",
    options: [
      { type: OPT_STRING, name: "beatmap", description: "Beatmap id or osu! beatmap URL", required: true },
      hiddenOption,
    ],
  },
  {
    ...ANY_INSTALL,
    name: "replay",
    description: "Get a link to watch a score's replay, with a summary",
    options: [
      { type: OPT_STRING, name: "score", description: "Score id or osu! score URL", required: true },
      hiddenOption,
    ],
  },

  // --- Server feeds (Manage Server) --------------------------------------
  {
    ...GUILD_ONLY,
    name: "subscribe",
    default_member_permissions: "32",
    description: "Post a live feed to this channel (top plays / snipes / new maps)",
    options: [
      { type: OPT_STRING, name: "feed", description: "Which feed", required: true, choices: FEED_CHOICES },
      countryOption,
      { type: OPT_NUMBER, name: "min_pp", description: "Only post events at or above this pp", required: false },
    ],
  },
  {
    ...GUILD_ONLY,
    name: "unsubscribe",
    default_member_permissions: "32",
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

  // --- Meta ---------------------------------------------------------------
  { ...ANY_INSTALL, name: "help", description: "What can the Mania Hub bot do?", options: [] },
];

// Commands that require the Manage Server permission to run.
export const MANAGE_GUILD_COMMANDS = new Set(["subscribe", "unsubscribe"]);

// Replies that are always private to the caller (identity management).
// Everything else is public unless the caller passes hidden:true.
export const ALWAYS_EPHEMERAL_COMMANDS = new Set(["link", "unlink", "whoami"]);

// ---------------------------------------------------------------------------
// Interaction payload shapes (only what we read).
// ---------------------------------------------------------------------------

export interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: InteractionOption[];
  focused?: boolean;
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
  message?: { id?: string; flags?: number };
  data?: {
    id?: string;
    name?: string;
    type?: number;
    custom_id?: string;
    component_type?: number;
    options?: InteractionOption[];
    // Present on modal submits: action rows wrapping the submitted text inputs.
    components?: Array<{ type: number; components?: Array<{ type: number; custom_id?: string; value?: string }> }>;
  };
}

// Reads a submitted value from a modal interaction by its text-input custom_id.
export function modalFieldValue(interaction: DiscordInteraction, customId: string): string | undefined {
  for (const row of interaction.data?.components ?? []) {
    for (const field of row.components ?? []) {
      if (field.custom_id === customId) {
        const text = (field.value ?? "").trim();
        return text.length ? text : undefined;
      }
    }
  }
  return undefined;
}

// Interaction types
export const INTERACTION_PING = 1;
export const INTERACTION_APPLICATION_COMMAND = 2;
export const INTERACTION_MESSAGE_COMPONENT = 3;
export const INTERACTION_APPLICATION_COMMAND_AUTOCOMPLETE = 4;
export const INTERACTION_MODAL_SUBMIT = 5;
// Response types
export const RESPONSE_PONG = 1;
export const RESPONSE_CHANNEL_MESSAGE = 4;
export const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
export const RESPONSE_DEFERRED_UPDATE_MESSAGE = 6;
export const RESPONSE_UPDATE_MESSAGE = 7;
export const RESPONSE_AUTOCOMPLETE_RESULT = 8;
export const RESPONSE_MODAL = 9;
// Message flags
export const FLAG_EPHEMERAL = 1 << 6;
// Permissions
const PERMISSION_MANAGE_GUILD = 1n << 5n;
const PERMISSION_ADMINISTRATOR = 1n << 3n;

// Returns the subcommand name when a command is invoked with one (e.g.
// `/group sub`), otherwise undefined. No current command uses subcommands, but
// the option readers still descend through one so a future grouped command
// works without changes.
export function subcommandName(interaction: DiscordInteraction): string | undefined {
  const top = interaction.data?.options ?? [];
  const first = top[0];
  return first && first.type === OPT_SUB_COMMAND ? first.name : undefined;
}

// The effective option list for the invoked (sub)command. Descends one level
// into a subcommand so option readers work the same for flat and grouped
// commands.
function effectiveOptions(interaction: DiscordInteraction): InteractionOption[] {
  const top = interaction.data?.options ?? [];
  const first = top[0];
  if (first && first.type === OPT_SUB_COMMAND) return first.options ?? [];
  return top;
}

export function optionValue(interaction: DiscordInteraction, name: string): string | number | boolean | undefined {
  return effectiveOptions(interaction).find((o) => o.name === name)?.value;
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

export function booleanOption(interaction: DiscordInteraction, name: string): boolean {
  return optionValue(interaction, name) === true;
}

// The option the user is currently typing, for autocomplete responses.
export function focusedOption(interaction: DiscordInteraction): InteractionOption | undefined {
  return effectiveOptions(interaction).find((o) => o.focused);
}

export function invokerId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

// Whether the reply to this command should be ephemeral (private to the caller).
export function isEphemeralCommand(interaction: DiscordInteraction): boolean {
  const name = interaction.data?.name ?? "";
  if (ALWAYS_EPHEMERAL_COMMANDS.has(name)) return true;
  return booleanOption(interaction, "hidden");
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
