import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { exec } from "../db.js";
import { GLOBAL_COUNTRY_CODE, isGlobalCountry } from "../countries.js";
import type { JobQueue } from "../jobs/queue.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { getPlayerProfileSnapshot, getPlayerRecentScoresFromOsu } from "../features/player-profiles.js";
import { getGlobalRankingsSnapshot } from "../features/global-rankings.js";
import { getTopPlaysSnapshot } from "../features/top-plays.js";
import { getFarmHelperSnapshot, FarmHelperUserNotFoundError, type FarmHelperKeyMode } from "../features/farm-helper.js";
import { readFarmHelperKeyStatsForUsers, type FarmHelperKeyStat } from "../features/farm-helper-key-stats.js";
import { getDanEstimateBatch } from "../features/dan-estimates.js";
import { getGlobalMapsRandomFarmedMap, getMapsPageSnapshot, getMapsRandomDraw, getMapsSnapshot, mapsRandomDrawQuery } from "../features/maps.js";
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
import { getChannelMapContext, setChannelMapContext, type ChannelMapContext } from "./channel-context.js";
import { paginationRow, refreshRow, rerollRow, withNavRow } from "./components.js";
import {
  activityEmbed,
  beatmapEmbed,
  compareEmbed,
  countryLabel,
  type DanBeatmapRef,
  danEmbed,
  errorBody,
  farmEmbed,
  goalsEmbed,
  helpEmbed,
  linkPromptBody,
  maniacardEmbed,
  mapsListEmbed,
  meEmbed,
  noticeBody,
  pbEmbed,
  playerEmbed,
  randomFarmEmbed,
  randomFavEmbed,
  rankingsEmbed,
  recentScoresEmbed,
  replayEmbed,
  snipesListEmbed,
  topPlaysListEmbed,
  trackerListEmbed,
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

// The channel an interaction happened in, if any. Bot-DM / private-channel
// installs may lack a channel id; "last map" memory simply no-ops there.
function channelIdOf(interaction: DiscordInteraction): string | undefined {
  return interaction.channel_id ?? interaction.channel?.id;
}

interface BeatmapRef {
  kind: "beatmap" | "beatmapset";
  id: number;
}

// Classifies a beatmap input. A difficulty-specific URL (.../#mania/456) or a
// /beatmaps|/b/456 path is a beatmap (difficulty) id; a bare /beatmapsets/123
// with no diff hash is a set id. A bare number is treated as a beatmap id first,
// and the resolver falls back to a set lookup if that 404s.
function parseBeatmapRef(raw: string): BeatmapRef | null {
  const trimmed = raw.trim();
  const hash = trimmed.match(/#\w+\/(\d+)/);
  if (hash) return { kind: "beatmap", id: Number(hash[1]) };
  const beatmapPath = trimmed.match(/\/(?:beatmaps|b)\/(\d+)/);
  if (beatmapPath) return { kind: "beatmap", id: Number(beatmapPath[1]) };
  const setPath = trimmed.match(/\/beatmapsets\/(\d+)/);
  if (setPath) return { kind: "beatmapset", id: Number(setPath[1]) };
  if (/^\d+$/.test(trimmed)) return { kind: "beatmap", id: Number(trimmed) };
  const last = trimmed.match(/(\d+)\s*$/);
  return last ? { kind: "beatmap", id: Number(last[1]) } : null;
}

interface ResolvedBeatmap extends DanBeatmapRef {
  id: number;
  url: string;
  title: string | null;
  version: string | null;
  beatmapsetId: number | null;
  // The full beatmap record from /beatmaps/{id}, set only when the resolver
  // fetched it directly (bare id / difficulty URL), so /map can reuse it instead
  // of fetching the same beatmap twice.
  raw?: Record<string, unknown>;
}

function toResolvedBeatmap(beatmap: Record<string, unknown>): ResolvedBeatmap {
  const id = Number(beatmap.id ?? 0);
  const set = (beatmap.beatmapset ?? null) as { id?: number; title?: string; artist?: string } | null;
  const title = set?.title ? `${set.artist ?? ""} - ${set.title}`.trim().replace(/^- /, "") : null;
  return {
    id,
    url: typeof beatmap.url === "string" && beatmap.url ? beatmap.url : `${OSU_BASE}/b/${id}`,
    title,
    version: beatmap.version == null ? null : String(beatmap.version),
    beatmapsetId: beatmap.beatmapset_id == null ? (set?.id ?? null) : Number(beatmap.beatmapset_id),
  };
}

// Resolves a beatmapset to its single mania difficulty, or throws a guidance
// error listing the difficulty ids when there is more than one (so the user
// re-runs with the specific id) or none.
async function resolveFromBeatmapset(deps: HandlerDeps, beatmapsetId: number): Promise<ResolvedBeatmap> {
  const set = await deps.osu.getBeatmapset(beatmapsetId, "discord:resolve-beatmapset");
  const setMeta = { id: Number((set as { id?: number }).id ?? beatmapsetId), title: (set as { title?: string }).title, artist: (set as { artist?: string }).artist };
  const all = (Array.isArray((set as { beatmaps?: unknown[] }).beatmaps) ? (set as { beatmaps: Record<string, unknown>[] }).beatmaps : [])
    .filter((b) => b.mode === "mania" || Number(b.mode_int) === 3);
  if (all.length === 0) {
    throw new UserFacingError("That beatmapset has no osu!mania difficulties.");
  }
  if (all.length === 1) {
    return toResolvedBeatmap({ ...all[0], beatmapset: setMeta });
  }
  const sorted = [...all].sort((a, b) => Number(a.difficulty_rating ?? 0) - Number(b.difficulty_rating ?? 0));
  const lines = sorted.slice(0, 12).map((b) => {
    const stars = Number(b.difficulty_rating ?? 0).toFixed(2);
    const keys = b.cs == null ? "" : `${Math.round(Number(b.cs))}K `;
    return `\`${Number(b.id)}\` ${keys}${b.version ?? ""} (${stars}★)`;
  });
  throw new UserFacingError(
    `That's a beatmapset with several mania difficulties. Re-run with a difficulty id (the number after \`#mania/\` in the URL):\n${lines.join("\n")}`,
  );
}

// Turns whatever the user typed into a concrete mania beatmap, resolving set ids
// and validating the id against the API so the embed never links to a 404.
async function resolveBeatmapForTools(deps: HandlerDeps, raw: string): Promise<ResolvedBeatmap> {
  const ref = parseBeatmapRef(raw);
  if (!ref || !Number.isFinite(ref.id) || ref.id <= 0) {
    throw new UserFacingError(`Couldn't read a beatmap id from \`${raw}\`.`);
  }
  if (ref.kind === "beatmapset") {
    try {
      return await resolveFromBeatmapset(deps, ref.id);
    } catch (error) {
      if (error instanceof OsuApiError && error.status === 404) {
        throw new UserFacingError(`Couldn't find a beatmapset with id \`${ref.id}\`.`);
      }
      throw error;
    }
  }
  try {
    const beatmap = await deps.osu.getBeatmap(ref.id, "discord:resolve-beatmap");
    return { ...toResolvedBeatmap(beatmap), raw: beatmap };
  } catch (error) {
    if (error instanceof OsuApiError && error.status === 404) {
      // The number was not a beatmap id; it may be a beatmapset id.
      try {
        return await resolveFromBeatmapset(deps, ref.id);
      } catch (setError) {
        if (setError instanceof OsuApiError && setError.status === 404) {
          throw new UserFacingError(`Couldn't find a beatmap or beatmapset with id \`${ref.id}\`.`);
        }
        throw setError;
      }
    }
    throw error;
  }
}

// Resolves the target player for a score lookup to a numeric osu! user id plus a
// display name (the /pb family needs the id for the per-beatmap scores call).
async function resolveTargetUser(deps: HandlerDeps, interaction: DiscordInteraction): Promise<{ userId: number; username: string }> {
  const explicit = stringOption(interaction, "username");
  if (explicit) {
    const user = await deps.osu.getUserByKey(explicit, "discord:pb");
    const userId = Number((user as { id?: number }).id ?? 0);
    if (!userId) throw new UserFacingError(`Couldn't find an osu! player matching \`${explicit}\`.`);
    return { userId, username: String((user as { username?: string }).username ?? explicit) };
  }
  const discordId = invokerId(interaction);
  if (discordId) {
    const link = await getUserLink(deps.db, discordId);
    if (link) return { userId: link.osuUserId, username: link.osuUsername };
  }
  throw new NoLinkError("No osu! account linked yet. Run `/link <username>`, or pass a username.");
}

function pickBestScore(scores: OscScore[]): OscScore | null {
  if (!scores.length) return null;
  return [...scores].sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0) || getAcc(b) - getAcc(a))[0] ?? null;
}

function getAcc(score: OscScore): number {
  const value = Number(score.accuracy ?? 0);
  return value <= 1 ? value * 100 : value;
}

// Extracts the "last map shown" context from a score row, for the /pb family.
function scoreToContext(score: OscScore | undefined): ChannelMapContext | null {
  if (!score) return null;
  const beatmapId = Number(score.beatmap?.id ?? score.beatmap_id ?? 0);
  if (!beatmapId) return null;
  const set = score.beatmapset;
  return {
    beatmapId,
    beatmapsetId: Number(score.beatmap?.beatmapset_id ?? set?.id ?? 0) || null,
    title: set ? `${set.artist} - ${set.title}` : null,
    version: score.beatmap?.version ?? null,
  };
}

const OSU_BASE = "https://osu.ppy.sh";

function friendlyError(error: unknown, subject: string): DiscordMessageBody {
  // A missing link is a setup gap, not a failure: offer the one-click link button.
  if (error instanceof NoLinkError) return linkPromptBody(error.message);
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
  if (!link) return linkPromptBody("No osu! account linked yet. Link one with the button below, or run `/link <username>`.");
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
    const section = await getPlayerRecentScoresFromOsu(deps.db, deps.osu, userId);
    const scores = (section.payload as OscScore[]) ?? [];
    const slice = scores.slice((page - 1) * pageSize, page * pageSize);
    const hasNext = scores.length > page * pageSize;
    // Remember the top map on the page being shown so /pb, /c and /compare look
    // up scores on a map the channel is actually looking at (not always the most
    // recent play when the caller paged forward).
    const context = scoreToContext(slice[0]);
    if (context) await setChannelMapContext(deps.db, channelIdOf(interaction), context).catch(() => {});
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
    const snapshot = await getFarmHelperSnapshot(deps.db, deps.osu, key, { keyMode, view: "gain", limit: 8 }, deps.queue);
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
    if (!link) return linkPromptBody("Pass two usernames, or link your account with the button below and just give the other player.");
    keyA = String(link.osuUserId);
  }
  try {
    const [snapA, snapB] = await Promise.all([
      getPlayerProfileSnapshot(deps.db, deps.osu, keyA),
      getPlayerProfileSnapshot(deps.db, deps.osu, b),
    ]);
    // The 4K/7K weighted-pp split comes from the farm-helper projections.
    // Players outside the pool render as "-"; a failed read just drops the
    // keymode lines instead of failing the whole command.
    const idA = Number((snapA.user as { id?: number }).id ?? 0);
    const idB = Number((snapB.user as { id?: number }).id ?? 0);
    const empty = new Map<number, FarmHelperKeyStat>();
    const [k4, k7] = await Promise.all([
      readFarmHelperKeyStatsForUsers(deps.db, 4, [idA, idB]).catch(() => empty),
      readFarmHelperKeyStatsForUsers(deps.db, 7, [idA, idB]).catch(() => empty),
    ]);
    const keyPp = {
      four: { a: k4.get(idA)?.weightedPp ?? null, b: k4.get(idB)?.weightedPp ?? null },
      seven: { a: k7.get(idA)?.weightedPp ?? null, b: k7.get(idB)?.weightedPp ?? null },
    };
    return compareEmbed(snapA, snapB, deps.config.discordSiteOrigin, keyPp);
  } catch (error) {
    return friendlyError(error, `${a ?? "you"} / ${b}`);
  }
};

// /pb, /c, /compare: a player's best score on the last map shown in this channel.
const pbHandler: CommandHandler = async (deps, interaction) => {
  const context = await getChannelMapContext(deps.db, channelIdOf(interaction));
  if (!context) {
    return errorBody("No recent map in this channel yet. Run `/recent`, `/map` or `/dan` first, then use `/pb`.");
  }
  const subject = stringOption(interaction, "username") ?? "your linked account";
  try {
    const { userId, username } = await resolveTargetUser(deps, interaction);
    const scores = await deps.osu
      .getBeatmapUserScoresAll(context.beatmapId, userId, "discord:pb")
      .catch((error) => {
        // No score on the map reads as 404 from the osu! API; treat it as "no score".
        if (error instanceof OsuApiError && error.status === 404) return [] as OscScore[];
        throw error;
      });
    return pbEmbed({
      username,
      userId,
      beatmap: { id: context.beatmapId, title: context.title, version: context.version },
      score: pickBestScore(scores),
      siteOrigin: deps.config.discordSiteOrigin,
    });
  } catch (error) {
    return friendlyError(error, subject);
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
    const snapshot = await getMapsPageSnapshot(deps.db, deps.queue, country, MAPS_MAX_AGE_MS, {
      tab,
      page: page - 1,
      pageSize,
      key: keysRaw === "4k" ? "4k" : keysRaw === "7k" ? "7k" : "all",
      beatmapSort: "players",
      farmedSort: "players",
      dir: "desc",
      status: "all",
      pp: 0,
      mod: "all",
      q: "",
    });
    const data = snapshot.value;
    if (!data) return noticeBody(`Maps for ${countryLabel(country)} are still generating, try again shortly.`);
    const farmedSlice = tab === "farmed" ? data.items as Parameters<typeof mapsListEmbed>[0]["farmed"] : [];
    const popularSlice = tab === "popular" ? data.items as Parameters<typeof mapsListEmbed>[0]["popular"] : [];
    const hasNext = page * pageSize < data.total;
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
  try {
    const beatmap = await resolveBeatmapForTools(deps, raw);
    const beatmapId = beatmap.id;
    await setChannelMapContext(deps.db, channelIdOf(interaction), {
      beatmapId,
      beatmapsetId: beatmap.beatmapsetId,
      title: beatmap.title,
      version: beatmap.version,
    }).catch(() => {});
    const batch = await getDanEstimateBatch(deps.db, deps.queue, deps.osu, [{ beatmapId, rate: 1 }], { computeMissing: true });
    const key = String(beatmapId);
    return danEmbed(beatmap, batch.results[key] ?? null, batch.pending.includes(key), deps.config.discordSiteOrigin);
  } catch (error) {
    return friendlyError(error, raw);
  }
};

const mapHandler: CommandHandler = async (deps, interaction) => {
  const raw = stringOption(interaction, "beatmap");
  if (!raw) return errorBody("Provide a beatmap id or osu! beatmap URL.");
  try {
    const beatmap = await resolveBeatmapForTools(deps, raw);
    const beatmapId = beatmap.id;
    await setChannelMapContext(deps.db, channelIdOf(interaction), {
      beatmapId,
      beatmapsetId: beatmap.beatmapsetId,
      title: beatmap.title,
      version: beatmap.version,
    }).catch(() => {});
    // resolveBeatmapForTools already fetched the full beatmap for the common
    // bare-id / difficulty-URL path; reuse it and only fetch when it came from a
    // beatmapset resolution (where raw is unset).
    const full = beatmap.raw ?? await deps.osu.getBeatmap(beatmapId, "discord:map");
    const batch = await getDanEstimateBatch(deps.db, deps.queue, deps.osu, [{ beatmapId, rate: 1 }], { computeMissing: true }).catch(() => null);
    const estimate = batch?.results?.[String(beatmapId)] ?? null;
    return beatmapEmbed(full as unknown as Parameters<typeof beatmapEmbed>[0], estimate, deps.config.discordSiteOrigin);
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

// --- Random map pickers (/randomfarm, /randomfav) --------------------------

// Umbrella pattern buckets expand to their canonical siblings, matching the
// Maps random tab (RANDOM_PATTERN_MATCHES in src/routes/maps.tsx).
const RANDOM_PATTERN_MATCHES: Record<string, string[]> = {
  jack: ["jack", "chordjack", "longjack", "speedjack", "minijack"],
  chordjack: ["chordjack"],
  stream: ["stream", "jumpstream", "chordstream", "handstream", "dumpstream"],
  jumpstream: ["jumpstream"],
  stamina: ["stamina"],
  tech: ["tech"],
  ln: ["ln"],
  sv: ["sv"],
  tiebreaker: ["tiebreaker"],
};

function statusBucket(status: string | null | undefined): "ranked" | "loved" | "graveyard" | "other" {
  const s = (status ?? "").toLowerCase();
  if (s === "ranked" || s === "approved") return "ranked";
  if (s === "loved") return "loved";
  if (s === "graveyard") return "graveyard";
  return "other";
}

function weightedPick<T>(items: T[], weight: (item: T) => number): T {
  let total = 0;
  for (const item of items) total += Math.max(0, weight(item));
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (const item of items) {
    r -= Math.max(0, weight(item));
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function numStr(value: number | undefined): string {
  return value != null && Number.isFinite(value) ? String(value) : "";
}

function randomEmptyNotice(country: string): string {
  return `No maps match those filters in ${countryLabel(country)}. Loosen the filters and try again.`;
}

const randomFarmHandler: CommandHandler = async (deps, interaction) => {
  // No country defaults to the global farm board; an explicit code narrows it.
  const country = resolveCountry(deps, stringOption(interaction, "country"), true);
  const keysRaw = stringOption(interaction, "keys");
  const status = stringOption(interaction, "status");
  const starsMin = numberOption(interaction, "stars_min");
  const starsMax = numberOption(interaction, "stars_max");
  const minPp = numberOption(interaction, "min_pp");
  try {
    let pick;
    if (isGlobalCountry(country)) {
      pick = await getGlobalMapsRandomFarmedMap(deps.db, {
        key: keysRaw === "4k" ? "4k" : keysRaw === "7k" ? "7k" : "all",
        status: status === "ranked" || status === "loved" || status === "graveyard" ? status : status ? "other" : "all",
        starsMin: starsMin ?? null,
        starsMax: starsMax ?? null,
        minPp: minPp ?? 0,
      });
    } else {
      const snapshot = await getMapsSnapshot(deps.db, deps.queue, country, MAPS_MAX_AGE_MS);
      const data = snapshot.value;
      if (!data) return noticeBody(`Maps for ${countryLabel(country)} are still generating, try again shortly.`);
      const pool = data.farmed.filter((m) => {
        if (keysRaw === "4k" && Math.round(m.cs) !== 4) return false;
        if (keysRaw === "7k" && Math.round(m.cs) !== 7) return false;
        if (status && statusBucket(m.status) !== status) return false;
        if (starsMin != null && (m.difficultyRating ?? 0) < starsMin) return false;
        if (starsMax != null && (m.difficultyRating ?? Number.MAX_VALUE) > starsMax) return false;
        if (minPp != null && (m.maxPp ?? 0) < minPp) return false;
        return true;
      });
      // "Popular" bias: a map farmed by more players is likelier to surface.
      pick = pool.length > 0 ? weightedPick(pool, (m) => Math.max(1, m.playerCount)) : null;
    }
    if (!pick) return noticeBody(randomEmptyNotice(country));
    const params = {
      country, keys: keysRaw ?? "", status: status ?? "",
      stars_min: numStr(starsMin), stars_max: numStr(starsMax), min_pp: numStr(minPp),
    };
    return withNavRow(randomFarmEmbed(pick, country, deps.config.discordSiteOrigin), rerollRow("randomfarm", params));
  } catch (error) {
    return friendlyError(error, country);
  }
};

// Only the first hydrated pick is shown; the rest are spares for sets that
// cannot be rendered. Batch size costs nothing on the draw itself, which is
// dominated by scanning the eligible pool.
const RANDOM_FAV_DRAW_BATCH = 4;

const randomFavHandler: CommandHandler = async (deps, interaction) => {
  const country = resolveCountry(deps, stringOption(interaction, "country"), true);
  const keysRaw = stringOption(interaction, "keys");
  const status = stringOption(interaction, "status");
  const pattern = stringOption(interaction, "pattern");
  const starsMin = numberOption(interaction, "stars_min");
  const starsMax = numberOption(interaction, "stars_max");
  try {
    // SQLite samples eligible (player, favourited set) pairs and only those
    // pairs are hydrated. Sampling pairs uniformly makes each favourite equally
    // likely, mirroring the Maps random tab and surfacing widely-favourited
    // sets more often as a side-effect. The batch is a few wide because a set
    // whose beatmap rows have been pruned cannot be rendered and is dropped
    // during hydration; taking the first survivor keeps the pick uniform.
    const snapshot = await getMapsRandomDraw(deps.db, deps.queue, country, MAPS_MAX_AGE_MS, mapsRandomDrawQuery({
      count: RANDOM_FAV_DRAW_BATCH,
      // The command's filters are single-choice includes; "any" and an
      // unrecognized pattern mean "do not filter", as they did before.
      status: status ? [status] : [],
      keys: keysRaw === "4k" || keysRaw === "7k" ? [keysRaw] : [],
      patterns: pattern ? RANDOM_PATTERN_MATCHES[pattern] ?? [] : [],
      starMin: starsMin ?? 0,
      starMax: starsMax ?? 0,
    }));
    if (!snapshot.value) {
      return noticeBody(`Favourite maps for ${countryLabel(country)} are still generating, try again shortly.`);
    }
    const pick = snapshot.value.picks[0];
    if (!pick) return noticeBody(randomEmptyNotice(country));
    const params = {
      country, keys: keysRaw ?? "", status: status ?? "", pattern: pattern ?? "",
      stars_min: numStr(starsMin), stars_max: numStr(starsMax),
    };
    return withNavRow(
      randomFavEmbed(
        pick.beatmapset,
        pick.player.username,
        // The drawn player is one of them, so the count is never below 1.
        Math.max(1, pick.scopeFavCount),
        country,
        deps.config.discordSiteOrigin,
      ),
      rerollRow("randomfav", params),
    );
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
  vs: compareHandler,
  pb: pbHandler,
  c: pbHandler,
  compare: pbHandler,
  rankings: rankingsHandler,
  top: topHandler,
  tracker: trackerHandler,
  maps: mapsHandler,
  dan: danHandler,
  map: mapHandler,
  replay: replayHandler,
  subscribe: subscribeHandler,
  unsubscribe: unsubscribeHandler,
  subscriptions: subscriptionsHandler,
  snipes: snipesHandler,
  randomfarm: randomFarmHandler,
  randomfav: randomFavHandler,
  help: helpHandler,
};
