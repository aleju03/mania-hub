import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { GLOBAL_COUNTRY_CODE, isGlobalCountry } from "../countries.js";
import type { JobQueue } from "../jobs/queue.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getPlayerProfileSnapshot, getPlayerRecentScores } from "../features/player-profiles.js";
import { getGlobalRankingsSnapshot } from "../features/global-rankings.js";
import { getTopPlaysSnapshot } from "../features/top-plays.js";
import { getFarmHelperSnapshot, FarmHelperUserNotFoundError, type FarmHelperKeyMode } from "../features/farm-helper.js";
import { getDanEstimateBatch } from "../features/dan-estimates.js";
import { getMapsSnapshot } from "../features/maps.js";
import { getTrackerSnapshot } from "../features/tracker.js";
import { getPlayerActivitySnapshot } from "../features/activity.js";
import { listUserGoalsWithProgress } from "../features/goals.js";
import { getMyDataSummary } from "../features/my-data.js";
import { logWarn } from "../logger.js";
import type { OscScore } from "../shared/types.js";
import type { DiscordMessageBody } from "./rest.js";
import {
  hasManageGuild,
  invokerId,
  numberOption,
  stringOption,
  subcommandName,
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
import { getUserLink, removeUserLink, setUserLink } from "./identity.js";
import {
  addUserTracker,
  listUserTrackers,
  MAPS_TRACKER_TARGET,
  removeUserTracker,
} from "./trackers.js";
import { paginationRow, refreshRow, withNavRow } from "./components.js";
import {
  activityEmbed,
  beatmapEmbed,
  compareEmbed,
  countryLabel,
  danEmbed,
  errorBody,
  farmEmbed,
  goalsEmbed,
  helpEmbed,
  maniacardEmbed,
  mapsListEmbed,
  meEmbed,
  noticeBody,
  playerEmbed,
  rankingsEmbed,
  recentScoresEmbed,
  replayEmbed,
  snipesListEmbed,
  topPlaysListEmbed,
  trackerListEmbed,
  watchListEmbed,
  whoamiEmbed,
} from "./embeds.js";
import { getSnipesSnapshot } from "../features/snipes.js";

export interface HandlerDeps {
  db: Db;
  osu: OsuApiClient;
  queue: JobQueue;
  config: Config;
  // Called after a feed subscription is added/removed so the runtime can refresh
  // its cached "any subscriptions?" fast-path flag.
  onSubscriptionsChanged?: () => void;
  // Called after a personal tracker is added/removed so the runtime can refresh
  // its cached set of watched osu! user ids.
  onTrackersChanged?: () => void;
}

export type CommandHandler = (deps: HandlerDeps, interaction: DiscordInteraction) => Promise<DiscordMessageBody>;

class UserFacingError extends Error {}
// Thrown when a username-less lookup has no linked account to fall back to.
class NoLinkError extends UserFacingError {}

const MAPS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

// Resolves the target player for a lookup: the explicit `username` option if
// given, otherwise the caller's linked osu! account. Throws NoLinkError when
// neither is available so the caller gets a clear "link first" message.
async function resolveTargetKey(deps: HandlerDeps, interaction: DiscordInteraction, optionName = "username"): Promise<string> {
  const explicit = stringOption(interaction, optionName);
  if (explicit) return explicit;
  const id = invokerId(interaction);
  if (id) {
    const link = await getUserLink(deps.db, id);
    if (link) return String(link.osuUserId);
  }
  throw new NoLinkError("No osu! account linked yet. Run `/link <username>`, or pass a username.");
}

function pageOf(interaction: DiscordInteraction): number {
  const value = numberOption(interaction, "page");
  return value != null && value >= 1 ? Math.floor(value) : 1;
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
// Identity
// ---------------------------------------------------------------------------

const linkHandler: CommandHandler = async (deps, interaction) => {
  const key = stringOption(interaction, "username");
  if (!key) return errorBody("Provide your osu! username or id.");
  const id = invokerId(interaction);
  if (!id) return errorBody("Could not identify your Discord account.");
  try {
    const user = await deps.osu.getUserByKey(key, "discord:link");
    const osuUserId = Number((user as { id?: number }).id ?? 0);
    const osuUsername = String((user as { username?: string }).username ?? key);
    const countryCode = (user as { country_code?: string }).country_code ?? null;
    if (!osuUserId) return errorBody(`Couldn't find an osu! player matching \`${key}\`.`);
    await setUserLink(deps.db, { discordUserId: id, osuUserId, osuUsername, countryCode });
    return noticeBody(`Linked to **${osuUsername}**. Commands now default to this account. Use \`/unlink\` to change it.`);
  } catch (error) {
    return friendlyError(error, key);
  }
};

const unlinkHandler: CommandHandler = async (deps, interaction) => {
  const id = invokerId(interaction);
  if (!id) return errorBody("Could not identify your Discord account.");
  const removed = await removeUserLink(deps.db, id);
  return noticeBody(removed ? "Unlinked. Commands now need an explicit username again." : "You had no linked account.");
};

const whoamiHandler: CommandHandler = async (deps, interaction) => {
  const id = invokerId(interaction);
  if (!id) return errorBody("Could not identify your Discord account.");
  const link = await getUserLink(deps.db, id);
  if (!link) return noticeBody("No osu! account linked. Run `/link <username>` to set one.");
  return whoamiEmbed(link, deps.config.discordSiteOrigin);
};

// ---------------------------------------------------------------------------
// Profile / personal
// ---------------------------------------------------------------------------

const meHandler: CommandHandler = async (deps, interaction) => {
  const id = invokerId(interaction);
  if (!id) return errorBody("Could not identify your Discord account.");
  const link = await getUserLink(deps.db, id);
  if (!link) return errorBody("No osu! account linked. Run `/link <username>` first.");
  try {
    const summary = await getMyDataSummary(deps.db, link.osuUserId);
    return meEmbed(
      {
        userId: link.osuUserId,
        username: summary.username ?? link.osuUsername,
        avatarUrl: summary.avatarUrl,
        countryCode: summary.countryCode ?? link.countryCode,
        pp: summary.pp,
        globalRank: summary.globalRank,
        countryRank: summary.countryRank,
        tracked: summary.tracked,
        rankedMember: summary.rankedMember,
        activeDays: summary.activeDays,
        sessions: summary.sessions,
        topPlayCount: summary.topPlayCount,
        highlights: {
          biggestDay: summary.highlights.biggestDay,
          longestStreak: summary.highlights.longestStreak,
          ppGainedTracked: summary.highlights.ppGainedTracked,
        },
        goalsOpen: summary.goalsOpen,
        goalsCompleted: summary.goalsCompleted,
      },
      deps.config.discordSiteOrigin,
    );
  } catch (error) {
    return friendlyError(error, link.osuUsername);
  }
};

const playerHandler: CommandHandler = async (deps, interaction) => {
  const subject = stringOption(interaction, "username") ?? "your linked account";
  try {
    const key = await resolveTargetKey(deps, interaction);
    const snapshot = await getPlayerProfileSnapshot(deps.db, deps.osu, key);
    const username = String((snapshot.user as { username?: string }).username ?? key);
    return withNavRow(playerEmbed(snapshot, deps.config.discordSiteOrigin), refreshRow("player", { username }));
  } catch (error) {
    return friendlyError(error, subject);
  }
};

const maniacardHandler: CommandHandler = async (deps, interaction) => {
  const subject = stringOption(interaction, "username") ?? "your linked account";
  try {
    const key = await resolveTargetKey(deps, interaction);
    const snapshot = await getPlayerProfileSnapshot(deps.db, deps.osu, key);
    return maniacardEmbed(snapshot, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, subject);
  }
};

const recentHandler: CommandHandler = async (deps, interaction) => {
  const subject = stringOption(interaction, "username") ?? "your linked account";
  const page = pageOf(interaction);
  const pageSize = 5;
  try {
    const key = await resolveTargetKey(deps, interaction);
    const snapshot = await getPlayerProfileSnapshot(deps.db, deps.osu, key);
    const userId = Number((snapshot.user as { id?: number }).id ?? 0);
    const username = String((snapshot.user as { username?: string }).username ?? key);
    const section = await getPlayerRecentScores(deps.db, deps.osu, userId);
    const scores = (section.payload as OscScore[]) ?? [];
    const slice = scores.slice((page - 1) * pageSize, page * pageSize);
    const hasNext = scores.length > page * pageSize;
    const body = recentScoresEmbed(username, userId, slice, deps.config.discordSiteOrigin);
    return withNavRow(body, paginationRow("recent", page, hasNext, { username }));
  } catch (error) {
    return friendlyError(error, subject);
  }
};

const activityHandler: CommandHandler = async (deps, interaction) => {
  const subject = stringOption(interaction, "username") ?? "your linked account";
  try {
    const key = await resolveTargetKey(deps, interaction);
    const snapshot = await getPlayerProfileSnapshot(deps.db, deps.osu, key);
    const userId = Number((snapshot.user as { id?: number }).id ?? 0);
    const username = String((snapshot.user as { username?: string }).username ?? key);
    const country = String((snapshot.user as { country_code?: string }).country_code ?? "");
    const year = new Date().getUTCFullYear();
    const activity = await getPlayerActivitySnapshot(deps.db, deps.queue, userId, country, year);
    if (!activity.available) {
      return noticeBody(`No activity data for **${username}** yet. They need to be on a tracked country's roster.`);
    }
    return activityEmbed(username, userId, activity, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, subject);
  }
};

const goalsHandler: CommandHandler = async (deps, interaction) => {
  const subject = stringOption(interaction, "username") ?? "your linked account";
  try {
    const key = await resolveTargetKey(deps, interaction);
    const snapshot = await getPlayerProfileSnapshot(deps.db, deps.osu, key);
    const userId = Number((snapshot.user as { id?: number }).id ?? 0);
    const username = String((snapshot.user as { username?: string }).username ?? key);
    const goals = await listUserGoalsWithProgress(deps.db, userId);
    return goalsEmbed(username, userId, goals, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, subject);
  }
};

const farmHandler: CommandHandler = async (deps, interaction) => {
  const subject = stringOption(interaction, "username") ?? "your linked account";
  const keysRaw = stringOption(interaction, "keys");
  const keyMode: FarmHelperKeyMode = keysRaw === "4k" || keysRaw === "7k" ? keysRaw : "any";
  try {
    const key = await resolveTargetKey(deps, interaction);
    const snapshot = await getFarmHelperSnapshot(deps.db, deps.osu, key, { keyMode, view: "gain", limit: 8 });
    return farmEmbed(snapshot, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, subject);
  }
};

const compareHandler: CommandHandler = async (deps, interaction) => {
  const a = stringOption(interaction, "player1");
  const b = stringOption(interaction, "player2");
  if (!b) return errorBody("Provide a second osu! username.");
  let keyA: string;
  if (a) {
    keyA = a;
  } else {
    const id = invokerId(interaction);
    const link = id ? await getUserLink(deps.db, id) : null;
    if (!link) return errorBody("Provide two usernames, or `/link` your account and pass just the other player.");
    keyA = String(link.osuUserId);
  }
  try {
    const [snapA, snapB] = await Promise.all([
      getPlayerProfileSnapshot(deps.db, deps.osu, keyA),
      getPlayerProfileSnapshot(deps.db, deps.osu, b),
    ]);
    return compareEmbed(snapA, snapB, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, `${a ?? "you"} / ${b}`);
  }
};

// ---------------------------------------------------------------------------
// Browse (country / global)
// ---------------------------------------------------------------------------

const rankingsHandler: CommandHandler = async (deps, interaction) => {
  const country = resolveCountry(deps, stringOption(interaction, "country"), true);
  const sort = stringOption(interaction, "sort") === "7d" ? "7d" : "pp";
  const page = pageOf(interaction);
  const pageSize = 15;
  try {
    if (isGlobalCountry(country)) {
      const snapshot = await getGlobalRankingsSnapshot(deps.db, { page, pageSize, sort, dir: "desc" });
      const hasNext = page * pageSize < snapshot.total;
      const body = rankingsEmbed(snapshot.ranking, GLOBAL_COUNTRY_CODE, deps.config.discordSiteOrigin);
      return withNavRow(body, paginationRow("rankings", page, hasNext, { country: GLOBAL_COUNTRY_CODE, sort }));
    }
    const all = await getCountryTopPlayers(deps.db, country, page * pageSize + 1);
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    if (slice.length === 0) {
      if (page > 1) return noticeBody("No more players on that page.");
      return noticeBody(`No tracked mania players found for ${countryLabel(country)} yet.`);
    }
    const hasNext = all.length > page * pageSize;
    const body = rankingsEmbed(slice, country, deps.config.discordSiteOrigin);
    // The 7d sort only applies to the Global board; the country roster query is
    // always rank-ordered, so do not carry an inert sort through pagination.
    return withNavRow(body, paginationRow("rankings", page, hasNext, { country }));
  } catch (error) {
    return friendlyError(error, country);
  }
};

const topHandler: CommandHandler = async (deps, interaction) => {
  const country = resolveCountry(deps, stringOption(interaction, "country"), false);
  const rangeRaw = stringOption(interaction, "range");
  const range = rangeRaw === "24h" || rangeRaw === "3d" || rangeRaw === "30d" ? rangeRaw : "7d";
  const keysRaw = stringOption(interaction, "keys");
  // top-plays supports a 4K vs "other" split; treat 7K as the non-4K bucket.
  const keys = keysRaw === "4k" ? "4k" : keysRaw === "7k" ? "other" : undefined;
  const page = pageOf(interaction);
  const pageSize = 10;
  try {
    const snapshot = await getTopPlaysSnapshot(deps.db, country, range, { page, pageSize, keys });
    const hasNext = page * pageSize < snapshot.total;
    const body = topPlaysListEmbed(snapshot.popoffs, country, deps.config.discordSiteOrigin);
    return withNavRow(body, paginationRow("top", page, hasNext, { country, range, keys: keysRaw ?? "" }));
  } catch (error) {
    return friendlyError(error, country);
  }
};

const trackerHandler: CommandHandler = async (deps, interaction) => {
  const country = resolveCountry(deps, stringOption(interaction, "country"), false);
  const page = pageOf(interaction);
  const pageSize = 12;
  try {
    const snapshot = await getTrackerSnapshot(deps.db, country, pageSize, (page - 1) * pageSize, {
      sort: "recent",
      sortDirection: "desc",
    });
    // Compare against the raw total, not the post-filter page length: the
    // non-hydrated path can drop rows missing joined metadata, which would
    // otherwise let "Next" open an empty page.
    const hasNext = page * pageSize < snapshot.total;
    const body = trackerListEmbed(snapshot.scores, country, deps.config.discordSiteOrigin);
    return withNavRow(body, paginationRow("tracker", page, hasNext, { country }));
  } catch (error) {
    return friendlyError(error, country);
  }
};

const mapsHandler: CommandHandler = async (deps, interaction) => {
  const country = resolveCountry(deps, stringOption(interaction, "country"), false);
  const tab: "farmed" | "popular" = stringOption(interaction, "tab") === "popular" ? "popular" : "farmed";
  const keysRaw = stringOption(interaction, "keys");
  const page = pageOf(interaction);
  const pageSize = 10;
  try {
    const snapshot = await getMapsSnapshot(deps.db, deps.queue, country, MAPS_MAX_AGE_MS, "core");
    const data = snapshot.value;
    if (!data) return noticeBody(`Maps for ${countryLabel(country)} are still generating, try again shortly.`);
    const keyMatch = (cs: number): boolean =>
      keysRaw === "4k" ? Math.round(cs) === 4 : keysRaw === "7k" ? Math.round(cs) === 7 : true;
    const farmedAll = data.farmed.filter((m) => keyMatch(m.cs));
    const popularAll = data.mostPlayed;
    const total = tab === "popular" ? popularAll.length : farmedAll.length;
    const farmedSlice = farmedAll.slice((page - 1) * pageSize, page * pageSize);
    const popularSlice = popularAll.slice((page - 1) * pageSize, page * pageSize);
    const hasNext = page * pageSize < total;
    const body = mapsListEmbed({
      farmed: farmedSlice,
      popular: popularSlice,
      tab,
      country,
      // keys only filter farmed (popular aggregates lack a key count).
      keys: tab === "farmed" ? keysRaw ?? "" : "",
      siteOrigin: deps.config.discordSiteOrigin,
    });
    return withNavRow(body, paginationRow("maps", page, hasNext, { country, tab, keys: keysRaw ?? "" }));
  } catch (error) {
    return friendlyError(error, country);
  }
};

// ---------------------------------------------------------------------------
// Beatmap tools
// ---------------------------------------------------------------------------

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

const mapHandler: CommandHandler = async (deps, interaction) => {
  const raw = stringOption(interaction, "beatmap");
  if (!raw) return errorBody("Provide a beatmap id or osu! beatmap URL.");
  const beatmapId = parseBeatmapId(raw);
  if (!beatmapId) return errorBody(`Couldn't read a beatmap id from \`${raw}\`.`);
  try {
    const beatmap = await deps.osu.getBeatmap(beatmapId, "discord:map");
    const batch = await getDanEstimateBatch(deps.db, deps.queue, deps.osu, [{ beatmapId, rate: 1 }], { computeMissing: true }).catch(() => null);
    const estimate = batch?.results?.[String(beatmapId)] ?? null;
    return beatmapEmbed(beatmap as unknown as Parameters<typeof beatmapEmbed>[0], estimate, deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, raw);
  }
};

const replayHandler: CommandHandler = async (deps, interaction) => {
  const raw = stringOption(interaction, "score");
  if (!raw) return errorBody("Provide a score id or osu! score URL.");
  const match = raw.match(/(\d{3,})/);
  const scoreId = match ? Number(match[1]) : NaN;
  if (!Number.isFinite(scoreId) || scoreId <= 0) return errorBody(`Couldn't read a score id from \`${raw}\`.`);
  return replayEmbed(scoreId, deps.config.discordSiteOrigin);
};

// ---------------------------------------------------------------------------
// Personal alerts (/watch)
// ---------------------------------------------------------------------------

const watchHandler: CommandHandler = async (deps, interaction) => {
  const id = invokerId(interaction);
  if (!id) return errorBody("Could not identify your Discord account.");
  const sub = subcommandName(interaction);

  if (sub === "list") {
    const trackers = await listUserTrackers(deps.db, id);
    return watchListEmbed(trackers);
  }

  if (sub === "maps") {
    await addUserTracker(deps.db, { subscriberId: id, kind: "maps", targetOsuUserId: MAPS_TRACKER_TARGET, targetUsername: null, minPp: 0 });
    deps.onTrackersChanged?.();
    return noticeBody("You will get a DM when a new farm map starts producing pp gains. Make sure your DMs are open. Use `/watch stop` to cancel.");
  }

  if (sub === "stop") {
    const target = stringOption(interaction, "target");
    if (!target) return errorBody("Tell me what to stop: a player's name, or `maps`.");
    if (target.toLowerCase() === "maps" || target.toLowerCase() === "new ranked maps" || target.toLowerCase() === "new farm maps") {
      const removed = await removeUserTracker(deps.db, { subscriberId: id, kind: "maps", targetOsuUserId: MAPS_TRACKER_TARGET });
      if (removed) deps.onTrackersChanged?.();
      return noticeBody(removed ? "Stopped new-farm-map alerts." : "You were not watching new farm maps.");
    }
    const trackers = await listUserTrackers(deps.db, id);
    const match = trackers.find(
      (t) => t.kind === "user" && (t.targetUsername?.toLowerCase() === target.toLowerCase() || String(t.targetOsuUserId) === target),
    );
    if (!match) return errorBody(`You are not watching \`${target}\`.`);
    const removed = await removeUserTracker(deps.db, { subscriberId: id, kind: "user", targetOsuUserId: match.targetOsuUserId });
    if (removed) deps.onTrackersChanged?.();
    return noticeBody(removed ? `Stopped watching **${match.targetUsername ?? target}**.` : `You are not watching \`${target}\`.`);
  }

  // Default subcommand: user
  const key = stringOption(interaction, "username");
  if (!key) return errorBody("Provide the osu! player to watch.");
  const minPp = Math.max(0, Math.floor(numberOption(interaction, "min_pp") ?? 0));
  if (!deps.config.discordBotToken) return errorBody("Alerts need the bot token configured on the backend.");
  try {
    const user = await deps.osu.getUserByKey(key, "discord:watch");
    const osuUserId = Number((user as { id?: number }).id ?? 0);
    const osuUsername = String((user as { username?: string }).username ?? key);
    if (!osuUserId) return errorBody(`Couldn't find an osu! player matching \`${key}\`.`);
    await addUserTracker(deps.db, { subscriberId: id, kind: "user", targetOsuUserId: osuUserId, targetUsername: osuUsername, minPp });
    deps.onTrackersChanged?.();
    const ppNote = minPp > 0 ? ` and on any ranked play at or above ${minPp}pp` : "";
    return noticeBody(`Watching **${osuUsername}**. You will get a DM on each new top play${ppNote}. Keep your DMs open. Use \`/watch stop\` to cancel.`);
  } catch (error) {
    return friendlyError(error, key);
  }
};

// ---------------------------------------------------------------------------
// Server feeds (Manage Server)
// ---------------------------------------------------------------------------

const subscribeHandler: CommandHandler = async (deps, interaction) => {
  const channelId = interaction.channel_id ?? interaction.channel?.id;
  if (!channelId) return errorBody("This command must be used inside a server channel.");
  if (!hasManageGuild(interaction)) return errorBody("You need the Manage Server permission to manage feeds.");
  if (!deps.config.discordBotToken) return errorBody("Live feeds are not available (the bot token isn't configured).");
  const feed = stringOption(interaction, "feed");
  if (!isFeedType(feed)) return errorBody("Pick a feed: top plays, snipes or new maps.");
  // New-farm-map alerts are global (a map is ranked once, everywhere).
  const country = feed === "new_map" ? GLOBAL_COUNTRY_CODE : resolveCountry(deps, stringOption(interaction, "country"), false);
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
  const scope = feed === "new_map" ? "new farm maps" : countryLabel(country);
  return noticeBody(`This channel will now receive **${FEED_LABELS[feed]}** for ${scope}${ppNote}. Make sure the bot can send messages here.`);
};

const unsubscribeHandler: CommandHandler = async (deps, interaction) => {
  const channelId = interaction.channel_id ?? interaction.channel?.id;
  if (!channelId) return errorBody("This command must be used inside a server channel.");
  if (!hasManageGuild(interaction)) return errorBody("You need the Manage Server permission to manage feeds.");
  const feed = stringOption(interaction, "feed");
  if (!isFeedType(feed)) return errorBody("Pick a feed: top plays, snipes or new maps.");
  const country = feed === "new_map" ? GLOBAL_COUNTRY_CODE : resolveCountry(deps, stringOption(interaction, "country"), false);
  const removed = await removeSubscription(deps.db, { channelId, feedType: feed, country });
  if (removed) deps.onSubscriptionsChanged?.();
  const scope = feed === "new_map" ? "new farm maps" : countryLabel(country);
  return removed
    ? noticeBody(`Stopped **${FEED_LABELS[feed]}** for ${scope} in this channel.`)
    : noticeBody(`No **${FEED_LABELS[feed]}** subscription for ${scope} was set up in this channel.`);
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
    const scope = s.feedType === "new_map" ? "new maps" : countryLabel(s.country);
    return `<#${s.channelId}> • **${FEED_LABELS[s.feedType] ?? s.feedType}** • ${scope}${ppNote}`;
  });
  if (subs.length > MAX_LINES) lines.push(`...and ${subs.length - MAX_LINES} more`);
  return noticeBody(`**Live feeds in this server**\n${lines.join("\n")}`);
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

const helpHandler: CommandHandler = async (deps) => helpEmbed(deps.config.discordSiteOrigin);

export const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  link: linkHandler,
  unlink: unlinkHandler,
  whoami: whoamiHandler,
  me: meHandler,
  player: playerHandler,
  maniacard: maniacardHandler,
  recent: recentHandler,
  activity: activityHandler,
  goals: goalsHandler,
  farm: farmHandler,
  compare: compareHandler,
  rankings: rankingsHandler,
  top: topHandler,
  tracker: trackerHandler,
  maps: mapsHandler,
  dan: danHandler,
  map: mapHandler,
  replay: replayHandler,
  watch: watchHandler,
  subscribe: subscribeHandler,
  unsubscribe: unsubscribeHandler,
  subscriptions: subscriptionsHandler,
  snipes: snipesHandler,
  help: helpHandler,
};
