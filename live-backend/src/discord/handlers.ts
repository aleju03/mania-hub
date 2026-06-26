import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { GLOBAL_COUNTRY_CODE, isGlobalCountry } from "../countries.js";
import type { JobQueue } from "../jobs/queue.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getPlayerProfileSnapshot, getPlayerRecentScores } from "../features/player-profiles.js";
import { getGlobalRankingsSnapshot } from "../features/global-rankings.js";
import { getTopPlaysSnapshot } from "../features/top-plays.js";
import { getSnipesSnapshot } from "../features/snipes.js";
import { getFarmHelperSnapshot, FarmHelperUserNotFoundError, type FarmHelperKeyMode } from "../features/farm-helper.js";
import { getDanEstimateBatch } from "../features/dan-estimates.js";
import { logWarn } from "../logger.js";
import type { OscScore } from "../shared/types.js";
import type { DiscordMessageBody } from "./rest.js";
import {
  hasManageGuild,
  invokerId,
  numberOption,
  stringOption,
  type DiscordInteraction,
} from "./commands.js";
import {
  addSubscription,
  FEED_LABELS,
  isFeedType,
  listSubscriptionsForGuild,
  normalizeFeedCountry,
  removeSubscription,
} from "./subscriptions.js";
import {
  compareEmbed,
  countryLabel,
  danEmbed,
  errorBody,
  farmEmbed,
  helpEmbed,
  maniacardEmbed,
  noticeBody,
  playerEmbed,
  rankingsEmbed,
  recentScoresEmbed,
  snipesListEmbed,
  topPlaysListEmbed,
} from "./embeds.js";

export interface HandlerDeps {
  db: Db;
  osu: OsuApiClient;
  queue: JobQueue;
  config: Config;
  // Called after a subscription is added/removed so the runtime can refresh its
  // cached "any subscriptions?" fast-path flag.
  onSubscriptionsChanged?: () => void;
}

export type CommandHandler = (deps: HandlerDeps, interaction: DiscordInteraction) => Promise<DiscordMessageBody>;

class UserFacingError extends Error {}

// Resolves the `country` option to a 2-letter code or GLOBAL. Without an
// argument, country-scoped commands default to the first tracked country and
// rankings defaults to Global.
function resolveCountry(deps: HandlerDeps, raw: string | undefined, fallbackGlobal: boolean): string {
  if (raw != null) {
    const code = normalizeFeedCountry(raw);
    if (!code) throw new UserFacingError(`\`${raw}\` is not a valid country code. Use a 2-letter code (e.g. CR) or 'global'.`);
    return code;
  }
  return fallbackGlobal ? GLOBAL_COUNTRY_CODE : (deps.config.trackedCountries[0] ?? "CR").toUpperCase();
}

function parseBeatmapId(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // Diff-specific links: .../beatmapsets/123#mania/456 -> the trailing id.
  const hash = trimmed.match(/#\w+\/(\d+)/);
  if (hash) return Number(hash[1]);
  const path = trimmed.match(/\/(?:beatmaps|b)\/(\d+)/);
  if (path) return Number(path[1]);
  const last = trimmed.match(/(\d+)\s*$/);
  return last ? Number(last[1]) : null;
}

function friendlyError(error: unknown, subject: string): DiscordMessageBody {
  if (error instanceof UserFacingError) return errorBody(error.message);
  if (error instanceof FarmHelperUserNotFoundError) return errorBody(`Couldn't find an osu! player matching \`${subject}\`.`);
  if (error instanceof OsuApiError) {
    if (error.status === 404) return errorBody(`Couldn't find an osu! player matching \`${subject}\`.`);
    if (error.status === 429) return errorBody("osu! API is busy right now, try again in a moment.");
    return errorBody("osu! API request failed. Try again shortly.");
  }
  logWarn("discord_handler_failed", { subject, error: error instanceof Error ? error.message : String(error) });
  return errorBody("Something went wrong handling that command.");
}

async function getCountryTopPlayers(db: Db, country: string, limit: number) {
  // `ro.rank is not null` is the shared "ranked roster member" discriminator used
  // by every other ranking surface; manual opt-in members are stored with a null
  // rank specifically so they stay off leaderboards. Order by the canonical
  // country rank so the displayed positions match the site.
  const result = await exec(
    db,
    `select u.user_id, u.username, u.avatar_url, u.country_code, u.pp, ro.rank as roster_rank
     from country_rosters ro
     join users u on u.user_id = ro.user_id
     where upper(ro.country) = ? and ro.is_tracked = 1 and ro.rank is not null and u.pp is not null
     order by ro.rank asc
     limit ?`,
    [country.toUpperCase(), limit],
  );
  return result.rows.map((row, index) => ({
    rank: row.roster_rank == null ? index + 1 : Number(row.roster_rank),
    user: {
      id: Number(row.user_id),
      username: String(row.username),
      country_code: String(row.country_code ?? country),
    },
    pp: Number(row.pp ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const playerHandler: CommandHandler = async (deps, interaction) => {
  const key = stringOption(interaction, "username");
  if (!key) return errorBody("Provide an osu! username.");
  try {
    const snapshot = await getPlayerProfileSnapshot(deps.db, deps.osu, key);
    return playerEmbed(snapshot, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, key);
  }
};

const maniacardHandler: CommandHandler = async (deps, interaction) => {
  const key = stringOption(interaction, "username");
  if (!key) return errorBody("Provide an osu! username.");
  try {
    const snapshot = await getPlayerProfileSnapshot(deps.db, deps.osu, key);
    return maniacardEmbed(snapshot, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, key);
  }
};

const recentHandler: CommandHandler = async (deps, interaction) => {
  const key = stringOption(interaction, "username");
  if (!key) return errorBody("Provide an osu! username.");
  try {
    const snapshot = await getPlayerProfileSnapshot(deps.db, deps.osu, key);
    const userId = Number((snapshot.user as { id?: number }).id ?? 0);
    const username = String((snapshot.user as { username?: string }).username ?? key);
    const section = await getPlayerRecentScores(deps.db, deps.osu, userId);
    const scores = (section.payload as OscScore[]) ?? [];
    return recentScoresEmbed(username, userId, scores, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, key);
  }
};

const rankingsHandler: CommandHandler = async (deps, interaction) => {
  const country = resolveCountry(deps, stringOption(interaction, "country"), true);
  try {
    if (isGlobalCountry(country)) {
      const snapshot = await getGlobalRankingsSnapshot(deps.db, { page: 1, pageSize: 15, sort: "pp", dir: "desc" });
      return rankingsEmbed(snapshot.ranking, GLOBAL_COUNTRY_CODE, deps.config.discordSiteOrigin);
    }
    const entries = await getCountryTopPlayers(deps.db, country, 15);
    if (entries.length === 0) return noticeBody(`No tracked mania players found for ${countryLabel(country)} yet.`);
    return rankingsEmbed(entries, country, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, country);
  }
};

const topHandler: CommandHandler = async (deps, interaction) => {
  const country = resolveCountry(deps, stringOption(interaction, "country"), false);
  try {
    const snapshot = await getTopPlaysSnapshot(deps.db, country, "7d", { page: 1, pageSize: 10 });
    return topPlaysListEmbed(snapshot.popoffs, country, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, country);
  }
};

const snipesHandler: CommandHandler = async (deps, interaction) => {
  const country = resolveCountry(deps, stringOption(interaction, "country"), false);
  if (isGlobalCountry(country)) return errorBody("Snipes are per-country. Use a 2-letter country code.");
  try {
    const snapshot = await getSnipesSnapshot(deps.db, country, 10);
    return snipesListEmbed(snapshot.events, country, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, country);
  }
};

const farmHandler: CommandHandler = async (deps, interaction) => {
  const key = stringOption(interaction, "username");
  if (!key) return errorBody("Provide an osu! username.");
  const keysRaw = stringOption(interaction, "keys");
  const keyMode: FarmHelperKeyMode = keysRaw === "4k" || keysRaw === "7k" ? keysRaw : "any";
  try {
    const snapshot = await getFarmHelperSnapshot(deps.db, deps.osu, key, { keyMode, view: "gain", limit: 8 });
    return farmEmbed(snapshot, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, key);
  }
};

const danHandler: CommandHandler = async (deps, interaction) => {
  const raw = stringOption(interaction, "beatmap");
  if (!raw) return errorBody("Provide a beatmap id or osu! beatmap URL.");
  const beatmapId = parseBeatmapId(raw);
  if (!beatmapId) return errorBody(`Couldn't read a beatmap id from \`${raw}\`.`);
  try {
    const batch = await getDanEstimateBatch(deps.db, deps.queue, deps.osu, [{ beatmapId, rate: 1 }], { computeMissing: true });
    const key = String(beatmapId);
    return danEmbed(beatmapId, batch.results[key] ?? null, batch.pending.includes(key), deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, raw);
  }
};

const compareHandler: CommandHandler = async (deps, interaction) => {
  const a = stringOption(interaction, "player1");
  const b = stringOption(interaction, "player2");
  if (!a || !b) return errorBody("Provide two osu! usernames.");
  try {
    const [snapA, snapB] = await Promise.all([
      getPlayerProfileSnapshot(deps.db, deps.osu, a),
      getPlayerProfileSnapshot(deps.db, deps.osu, b),
    ]);
    return compareEmbed(snapA, snapB, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, `${a} / ${b}`);
  }
};

const subscribeHandler: CommandHandler = async (deps, interaction) => {
  const channelId = interaction.channel_id ?? interaction.channel?.id;
  if (!channelId) return errorBody("This command must be used inside a server channel.");
  if (!hasManageGuild(interaction)) return errorBody("You need the Manage Server permission to manage feeds.");
  if (!deps.config.discordBotToken) return errorBody("Live feeds are not available (the bot token isn't configured).");
  const feed = stringOption(interaction, "feed");
  if (!isFeedType(feed)) return errorBody("Pick a feed: top plays or snipes.");
  const country = resolveCountry(deps, stringOption(interaction, "country"), false);
  if (feed === "snipe" && isGlobalCountry(country)) return errorBody("Snipes are per-country. Use a 2-letter country code.");
  const minPp = Math.max(0, Math.floor(numberOption(interaction, "min_pp") ?? 0));
  await addSubscription(deps.db, {
    guildId: interaction.guild_id ?? null,
    channelId,
    country,
    feedType: feed,
    minPp,
    createdBy: invokerId(interaction) ?? null,
  });
  deps.onSubscriptionsChanged?.();
  const ppNote = minPp > 0 ? ` (${minPp}pp and up)` : "";
  return noticeBody(`This channel will now receive **${FEED_LABELS[feed]}** for ${countryLabel(country)}${ppNote}. Make sure the bot can send messages here.`);
};

const unsubscribeHandler: CommandHandler = async (deps, interaction) => {
  const channelId = interaction.channel_id ?? interaction.channel?.id;
  if (!channelId) return errorBody("This command must be used inside a server channel.");
  if (!hasManageGuild(interaction)) return errorBody("You need the Manage Server permission to manage feeds.");
  const feed = stringOption(interaction, "feed");
  if (!isFeedType(feed)) return errorBody("Pick a feed: top plays or snipes.");
  const country = resolveCountry(deps, stringOption(interaction, "country"), false);
  const removed = await removeSubscription(deps.db, { channelId, feedType: feed, country });
  if (removed) deps.onSubscriptionsChanged?.();
  return removed
    ? noticeBody(`Stopped **${FEED_LABELS[feed]}** for ${countryLabel(country)} in this channel.`)
    : noticeBody(`No **${FEED_LABELS[feed]}** subscription for ${countryLabel(country)} was set up in this channel.`);
};

const subscriptionsHandler: CommandHandler = async (deps, interaction) => {
  const guildId = interaction.guild_id;
  if (!guildId) return errorBody("This command must be used inside a server.");
  const subs = await listSubscriptionsForGuild(deps.db, guildId);
  if (subs.length === 0) return noticeBody("No live feeds are set up in this server. Use `/subscribe` to add one.");
  // Discord caps message content at 2000 chars; show a bounded list with an
  // overflow note rather than letting a big server's list fail the response.
  const MAX_LINES = 25;
  const lines = subs.slice(0, MAX_LINES).map((s) => {
    const ppNote = s.minPp > 0 ? ` (${s.minPp}pp and up)` : "";
    return `<#${s.channelId}> • **${FEED_LABELS[s.feedType]}** • ${countryLabel(s.country)}${ppNote}`;
  });
  if (subs.length > MAX_LINES) lines.push(`…and ${subs.length - MAX_LINES} more`);
  return noticeBody(`**Live feeds in this server**\n${lines.join("\n")}`);
};

const helpHandler: CommandHandler = async (deps) => helpEmbed(deps.config.discordSiteOrigin);

export const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  player: playerHandler,
  maniacard: maniacardHandler,
  recent: recentHandler,
  rankings: rankingsHandler,
  top: topHandler,
  snipes: snipesHandler,
  farm: farmHandler,
  dan: danHandler,
  compare: compareHandler,
  subscribe: subscribeHandler,
  unsubscribe: unsubscribeHandler,
  subscriptions: subscriptionsHandler,
  help: helpHandler,
};
