import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import type { EventSink } from "../live/event-log.js";
import type { CountryTopPlay, LiveEvent, SnipeEvent } from "../shared/types.js";
import { logInfo, logWarn } from "../logger.js";
import { DiscordRest, DiscordRestError, type DiscordMessageBody } from "./rest.js";
import { verifyDiscordSignature } from "./verify.js";
import {
  DISCORD_COMMANDS,
  FLAG_EPHEMERAL,
  hasManageGuild,
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_APPLICATION_COMMAND_AUTOCOMPLETE,
  INTERACTION_MESSAGE_COMPONENT,
  INTERACTION_MODAL_SUBMIT,
  INTERACTION_PING,
  invokerId,
  isEphemeralCommand,
  MANAGE_GUILD_COMMANDS,
  modalFieldValue,
  RESPONSE_AUTOCOMPLETE_RESULT,
  RESPONSE_CHANNEL_MESSAGE,
  RESPONSE_DEFERRED_CHANNEL_MESSAGE,
  RESPONSE_DEFERRED_UPDATE_MESSAGE,
  RESPONSE_MODAL,
  RESPONSE_PONG,
  type DiscordInteraction,
} from "./commands.js";
import { COMMAND_HANDLERS, type HandlerDeps } from "./handlers.js";
import { loadEmojiRegistry, registerEmojis, type EmojiRegistrationResult } from "./emojis.js";
import { helpEmbed, newMapAlertEmbed, snipeEmbed, topPlayEmbed, type NewMapAlert } from "./embeds.js";
import {
  countSubscriptions,
  countSubscriptionsByFeed,
  dedupeSubscriptionsByChannel,
  listMatchingSubscriptions,
  removeSubscriptionsForChannel,
  type FeedType,
} from "./subscriptions.js";
import { claimMapAlert, getBeatmapRankedInfo, getFarmMapSignal, isWithinRecency } from "./new-maps.js";
import { handleAutocomplete } from "./autocomplete.js";
import {
  componentToCommandInteraction,
  decodeActionId,
  decodeComponentId,
  LINK_MODAL_FIELD,
  LINK_MODAL_ID,
  linkModal,
  toComponentsV2Body,
} from "./components.js";
import { GLOBAL_COUNTRY_CODE } from "../countries.js";
import { mapWithConcurrency } from "./util.js";

// How many channel posts to keep in flight per event. Well under Discord's
// global ~50 req/s budget, and the REST client retries once on 429.
const FEED_POST_CONCURRENCY = 8;

const MAX_INTERACTION_BODY_BYTES = 256 * 1024;
const RECENT_INTERACTIONS_LIMIT = 25;

export interface DiscordStatus {
  enabled: boolean;
  configured: boolean;
  hasBotToken: boolean;
  feedsEnabled: boolean;
  applicationId: string | null;
  devGuildId: string | null;
  commandCount: number;
  recentInteractions: Array<{ command: string; userId: string | null; guildId: string | null; at: number }>;
  // Lightweight observability for the admin dashboard.
  commandCounts: Record<string, number>;
  errorCount: number;
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
}

export interface DiscordRuntime {
  handleInteraction(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  registerCommands(): Promise<{ global: number; guild: number | null }>;
  // Uploads the grade pill + mod icon emojis to the application so embeds can
  // render them inline. Idempotent; pass force to re-upload after changing the art.
  registerEmojis(force?: boolean): Promise<EmojiRegistrationResult>;
  // Which servers the bot is actually a member of (live from Discord, needs the
  // bot token). Distinct from feed subscriptions, which only cover channels that
  // opted into a feed.
  listGuilds(): Promise<DiscordGuildSummary[]>;
  feedSink: EventSink;
  // Posts one message to the owner's own channel (config.discordBugReportChannelId),
  // outside the subscription system entirely. Resolves false when no channel is
  // configured or the post failed; callers treat it as best effort.
  postOwnerNotice(body: DiscordMessageBody): Promise<boolean>;
  status(): DiscordStatus;
  // Lets out-of-band subscription mutations (admin removal) refresh the cached
  // "any subscriptions?" flag so the feed fast-path stays accurate.
  notifySubscriptionsChanged(): void;
}

export interface DiscordRuntimeOptions {
  db: Db;
  osu: OsuApiClient;
  queue: JobQueue;
  config: Config;
}

// Bot permissions requested by the guild-install invite: Send Messages (1<<11)
// + Embed Links (1<<14), which is all the live feeds need.
const INVITE_PERMISSIONS = (1 << 11) | (1 << 14);

export interface DiscordPublicInfo {
  configured: boolean;
  applicationId: string | null;
  inviteUrl: string | null;
  feedsEnabled: boolean;
  commands: Array<{ name: string; description: string }>;
}

// Public, secret-free info for the frontend tool page (no bot token, no keys).
// The application id is public; it appears in every invite link.
export function getDiscordPublicInfo(config: Config): DiscordPublicInfo {
  const applicationId = config.discordApplicationId ?? null;
  const configured = Boolean(config.enableDiscordBot && applicationId && config.discordPublicKey);
  const inviteUrl = configured && applicationId
    ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`
    : null;
  return {
    configured,
    applicationId: configured ? applicationId : null,
    inviteUrl,
    feedsEnabled: config.enableDiscordFeeds,
    commands: DISCORD_COMMANDS.map((command) => ({ name: command.name, description: command.description })),
  };
}

export function createDiscordRuntime(opts: DiscordRuntimeOptions): DiscordRuntime | null {
  const { config } = opts;
  if (!config.enableDiscordBot) return null;
  if (!config.discordApplicationId || !config.discordPublicKey) {
    logWarn("discord_disabled_missing_config", {
      hasApplicationId: Boolean(config.discordApplicationId),
      hasPublicKey: Boolean(config.discordPublicKey),
    });
    return null;
  }

  const publicKey = config.discordPublicKey;
  const rest = new DiscordRest(config.discordApplicationId, config.discordBotToken);
  const recent: DiscordStatus["recentInteractions"] = [];
  const counters = { commands: {} as Record<string, number>, errors: 0 };

  // Fast-path flag: when no channel anywhere is subscribed, skip the per-event
  // subscription lookup entirely. Starts pessimistic (false = do the query) until
  // the first count loads, and is refreshed on every subscription mutation, so it
  // never causes a missed post. No background timer is involved.
  let knownEmpty = false;
  // Whether any channel is subscribed to the new-map feed, so the per-top-play
  // hot path can skip the new-map evaluation entirely when nobody wants it.
  let wantsNewMaps = false;
  // Process-lifetime cache of beatmaps already evaluated for a new-map alert.
  const seenMapsForAlert = new Set<number>();

  async function refreshEmptyFlag(): Promise<void> {
    try {
      knownEmpty = (await countSubscriptions(opts.db)) === 0;
    } catch {
      knownEmpty = false;
    }
  }
  async function refreshNewMapFlag(): Promise<void> {
    try {
      wantsNewMaps = (await countSubscriptionsByFeed(opts.db, "new_map")) > 0;
    } catch (error) {
      // Keep the previous value on error rather than going dark.
      logWarn("discord_newmap_cache_refresh_failed", { error: errorMessage(error) });
    }
  }
  function notifySubscriptionsChanged(): void {
    void refreshEmptyFlag();
    void refreshNewMapFlag();
  }

  const deps: HandlerDeps = {
    db: opts.db,
    osu: opts.osu,
    queue: opts.queue,
    config,
    onSubscriptionsChanged: notifySubscriptionsChanged,
  };

  function recordInteraction(command: string, interaction: DiscordInteraction): void {
    recent.push({
      command,
      userId: invokerId(interaction) ?? null,
      guildId: interaction.guild_id ?? null,
      at: Date.now(),
    });
    if (recent.length > RECENT_INTERACTIONS_LIMIT) recent.splice(0, recent.length - RECENT_INTERACTIONS_LIMIT);
    counters.commands[command] = (counters.commands[command] ?? 0) + 1;
  }

  async function dispatchCommand(interaction: DiscordInteraction): Promise<void> {
    const name = interaction.data?.name ?? "";
    const handler = COMMAND_HANDLERS[name];
    let body;
    try {
      body = handler ? await handler(deps, interaction) : { content: `Unknown command: ${name}` };
    } catch (error) {
      counters.errors += 1;
      logWarn("discord_dispatch_failed", { command: name, error: errorMessage(error) });
      body = { content: "Something went wrong handling that command." };
    }
    try {
      const replyFlags = (isEphemeralCommand(interaction) ? FLAG_EPHEMERAL : 0) | ((interaction.message?.flags ?? 0) & FLAG_EPHEMERAL);
      await rest.editOriginalInteractionResponse(
        interaction.token,
        replyFlags ? { ...body, flags: (body.flags ?? 0) | replyFlags } : body,
      );
    } catch (error) {
      logWarn("discord_followup_failed", { command: name, error: errorMessage(error) });
    }
  }

  // Swaps the help message to a different category in place (deferred update).
  async function updateHelpView(interaction: DiscordInteraction, category: string): Promise<void> {
    try {
      await rest.editOriginalInteractionResponse(interaction.token, helpEmbed(config.discordSiteOrigin, category));
    } catch (error) {
      logWarn("discord_help_nav_failed", { error: errorMessage(error) });
    }
  }

  async function handleInteraction(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req, MAX_INTERACTION_BODY_BYTES);
    } catch {
      sendText(res, 413, "payload too large");
      return true;
    }
    const signature = headerValue(req, "x-signature-ed25519");
    const timestamp = headerValue(req, "x-signature-timestamp");
    if (!verifyDiscordSignature(publicKey, signature, timestamp, rawBody)) {
      sendText(res, 401, "invalid request signature");
      return true;
    }

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(rawBody.toString("utf8")) as DiscordInteraction;
    } catch {
      sendText(res, 400, "invalid json");
      return true;
    }

    if (interaction.type === INTERACTION_PING) {
      sendJson(res, 200, { type: RESPONSE_PONG });
      return true;
    }

    if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
      const name = interaction.data?.name ?? "";
      recordInteraction(name, interaction);
      // Cheap permission gate before deferring, so denials can be ephemeral.
      if (MANAGE_GUILD_COMMANDS.has(name) && !hasManageGuild(interaction)) {
        sendJson(res, 200, {
          type: RESPONSE_CHANNEL_MESSAGE,
          data: toComponentsV2Body({ content: "You need the Manage Server permission to use this.", flags: FLAG_EPHEMERAL, allowed_mentions: { parse: [] } }),
        });
        return true;
      }
      // ACK within Discord's 3s window, then do the real work and edit the
      // original message. Ephemerality is fixed here at defer time: it cannot be
      // added on the later edit.
      const ephemeral = isEphemeralCommand(interaction);
      sendJson(res, 200, { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE, data: ephemeral ? { flags: FLAG_EPHEMERAL } : undefined });
      void dispatchCommand(interaction);
      return true;
    }

    if (interaction.type === INTERACTION_MESSAGE_COMPONENT) {
      // Action buttons (open the link modal, swap the help view) come first; they
      // are not slash-command reruns.
      const action = decodeActionId(interaction.data?.custom_id);
      if (action?.kind === "link") {
        // Opening a modal must be the direct interaction response, never deferred.
        sendJson(res, 200, { type: RESPONSE_MODAL, data: linkModal() });
        return true;
      }
      if (action?.kind === "help") {
        recordInteraction("help", interaction);
        sendJson(res, 200, { type: RESPONSE_DEFERRED_UPDATE_MESSAGE });
        void updateHelpView(interaction, action.category);
        return true;
      }
      const decoded = decodeComponentId(interaction.data?.custom_id);
      if (!decoded) {
        sendJson(res, 200, {
          type: RESPONSE_CHANNEL_MESSAGE,
          data: toComponentsV2Body({ content: "This control is no longer available. Run the command again.", flags: FLAG_EPHEMERAL, allowed_mentions: { parse: [] } }),
        });
        return true;
      }
      // Defer an update to the existing message, then recompute it from the
      // button's encoded state and edit it in place.
      recordInteraction(decoded.cmd, interaction);
      sendJson(res, 200, { type: RESPONSE_DEFERRED_UPDATE_MESSAGE });
      void dispatchCommand(componentToCommandInteraction(interaction, decoded));
      return true;
    }

    if (interaction.type === INTERACTION_MODAL_SUBMIT) {
      if (interaction.data?.custom_id === LINK_MODAL_ID) {
        const key = modalFieldValue(interaction, LINK_MODAL_FIELD);
        recordInteraction("link", interaction);
        sendJson(res, 200, { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE, data: { flags: FLAG_EPHEMERAL } });
        // Reuse the /link handler exactly by synthesizing its command interaction.
        const synthetic: DiscordInteraction = {
          ...interaction,
          type: INTERACTION_APPLICATION_COMMAND,
          data: { name: "link", options: key ? [{ name: "username", type: 3, value: key }] : [] },
        };
        void dispatchCommand(synthetic);
        return true;
      }
      sendJson(res, 200, {
        type: RESPONSE_CHANNEL_MESSAGE,
        data: toComponentsV2Body({ content: "Unsupported form.", flags: FLAG_EPHEMERAL, allowed_mentions: { parse: [] } }),
      });
      return true;
    }

    if (interaction.type === INTERACTION_APPLICATION_COMMAND_AUTOCOMPLETE) {
      // Autocomplete must answer directly (no defer) and fast. handleAutocomplete
      // never throws; on any failure it yields an empty list.
      const choices = await handleAutocomplete(deps, interaction).catch(() => []);
      sendJson(res, 200, { type: RESPONSE_AUTOCOMPLETE_RESULT, data: { choices: choices.slice(0, 25) } });
      return true;
    }

    // Any other interaction type should not arrive; answer with an ephemeral
    // notice rather than erroring.
    sendJson(res, 200, {
      type: RESPONSE_CHANNEL_MESSAGE,
      data: toComponentsV2Body({ content: "Unsupported interaction.", flags: FLAG_EPHEMERAL, allowed_mentions: { parse: [] } }),
    });
    return true;
  }

  async function doRegisterEmojis(force = false): Promise<EmojiRegistrationResult> {
    return registerEmojis(rest, opts.db, config.discordSiteOrigin, { force });
  }

  async function registerCommands(): Promise<{ global: number; guild: number | null }> {
    if (!rest.hasBotToken()) {
      throw new Error("DISCORD_BOT_TOKEN is required to register commands.");
    }
    // With a dev guild set, register ONLY to that guild (instant propagation and
    // no duplicate listings). Without one, register globally for production.
    if (config.discordDevGuildId) {
      const guildResult = await rest.bulkOverwriteGuildCommands(config.discordDevGuildId, toGuildCommands(DISCORD_COMMANDS));
      const guild = Array.isArray(guildResult) ? guildResult.length : DISCORD_COMMANDS.length;
      logInfo("discord_commands_registered", { global: 0, guild, devGuild: config.discordDevGuildId });
      return { global: 0, guild };
    }
    const globalResult = await rest.bulkOverwriteGlobalCommands(DISCORD_COMMANDS);
    const global = Array.isArray(globalResult) ? globalResult.length : DISCORD_COMMANDS.length;
    logInfo("discord_commands_registered", { global, guild: null, devGuild: null });
    return { global, guild: null };
  }

  // --- Channel feeds (top plays / snipes) ----------------------------------

  async function postFeedEvent(event: LiveEvent): Promise<void> {
    const feedType: FeedType = event.type === "top_play" ? "top_play" : "snipe";
    const matched = await listMatchingSubscriptions(opts.db, feedType, event.country);
    if (matched.length === 0) return;

    // A channel can hold both a country-specific and a GLOBAL subscription for
    // the same feed; collapse to one post per channel, then drop channels whose
    // min_pp threshold this event doesn't clear.
    const pp = feedType === "top_play"
      ? (event.payload as CountryTopPlay).pp
      : ((event.payload as SnipeEvent).pp ?? null);
    const targets = dedupeSubscriptionsByChannel(matched)
      .filter((sub) => !(sub.minPp > 0 && (pp == null || pp < sub.minPp)));
    if (targets.length === 0) return;

    const body = feedType === "top_play"
      ? topPlayEmbed(event.payload as CountryTopPlay, event.country, config.discordSiteOrigin)
      : snipeEmbed(event.payload as SnipeEvent, event.country, config.discordSiteOrigin);

    await fanOutChannelPosts(targets.map((sub) => sub.channelId), body);
  }

  // Posts one body to many channels with bounded concurrency, self-healing
  // subscriptions whose channel is gone.
  async function fanOutChannelPosts(channelIds: string[], body: Parameters<DiscordRest["createChannelMessage"]>[1]): Promise<void> {
    let healed = false;
    await mapWithConcurrency(channelIds, FEED_POST_CONCURRENCY, async (channelId) => {
      try {
        await rest.createChannelMessage(channelId, body);
      } catch (error) {
        if (error instanceof DiscordRestError && isChannelGoneError(error)) {
          await removeSubscriptionsForChannel(opts.db, channelId).catch(() => {});
          healed = true;
          logInfo("discord_subscription_self_healed", { channelId, status: error.status });
        } else {
          logWarn("discord_channel_post_failed", { channelId, error: errorMessage(error) });
        }
      }
    });
    if (healed) notifySubscriptionsChanged();
  }

  // --- Owner notices ------------------------------------------------------

  // A bug report is not community content: it can quote whoever filed it, so it
  // goes to one channel the owner picked rather than through the subscription
  // feeds. Failures are logged and swallowed; nothing user-facing may depend on
  // Discord being up.
  async function postOwnerNotice(body: DiscordMessageBody): Promise<boolean> {
    const channelId = config.discordBugReportChannelId;
    if (!channelId) return false;
    try {
      await rest.createChannelMessage(channelId, body);
      return true;
    } catch (error) {
      logWarn("discord_owner_notice_failed", { channelId, error: errorMessage(error) });
      return false;
    }
  }

  // --- New farm map alerts ------------------------------------------------

  interface MapBearingScore {
    beatmap_id?: number;
    beatmap?: { id?: number; beatmapset_id?: number; cs?: number; difficulty_rating?: number; version?: string };
    beatmapset?: { id?: number; title?: string; artist?: string; covers?: Record<string, string | undefined> };
  }

  // Caches a stable decision so an already-evaluated beatmap is skipped without a
  // DB hit. Only call for terminal outcomes, never for un-enriched maps that
  // might still flip to a recent ranked state on a later play.
  function rememberMapDecision(beatmapId: number): void {
    seenMapsForAlert.add(beatmapId);
    if (seenMapsForAlert.size > 100_000) seenMapsForAlert.clear();
  }

  async function maybeAlertNewFarmMap(payload: CountryTopPlay): Promise<void> {
    if (!wantsNewMaps) return;
    const score = payload.score as MapBearingScore | undefined;
    const beatmapId = Number(score?.beatmap?.id ?? score?.beatmap_id ?? 0);
    const beatmapsetId = Number(score?.beatmap?.beatmapset_id ?? score?.beatmapset?.id ?? 0);
    if (!beatmapId) return;
    if (seenMapsForAlert.has(beatmapId)) return;

    const info = await getBeatmapRankedInfo(opts.db, beatmapId, beatmapsetId);
    // Unknown row: do not cache, the map may be enriched on a later play.
    if (!info) return;
    if (info.status !== "ranked") {
      // A qualified map can still become ranked, and a null status may just be
      // un-enriched; only cache clearly terminal non-ranked states.
      if (info.status && info.status !== "qualified") rememberMapDecision(beatmapId);
      return;
    }
    // Ranked but the ranked date is not populated yet (ingest omits it until an
    // enrich job fills it in). Re-check on a later play rather than caching a miss.
    if (info.rankedAtMs == null) return;
    if (!isWithinRecency(info.rankedAtMs, Date.now(), config.discordNewMapWindowDays)) {
      // Old ranked map being played: a stable negative, safe to cache.
      rememberMapDecision(beatmapId);
      return;
    }
    const signal = await getFarmMapSignal(opts.db, beatmapId, {
      windowHours: config.discordNewFarmMapSignalWindowHours,
      minUsers: config.discordNewFarmMapMinUsers,
      minPpGain: config.discordNewFarmMapMinPpGain,
    });
    if (!signal.qualifies) return;
    // Within the window. The persistent claim dedupes across restarts and
    // destinations; cache either way so this map stops re-querying the DB.
    const claimed = await claimMapAlert(opts.db, beatmapId);
    rememberMapDecision(beatmapId);
    if (!claimed) return;

    const covers = score?.beatmapset?.covers ?? {};
    const alert: NewMapAlert = {
      beatmapId,
      beatmapsetId: info.beatmapsetId,
      title: String(score?.beatmapset?.title ?? info.title ?? "Unknown"),
      artist: String(score?.beatmapset?.artist ?? info.artist ?? "Unknown"),
      version: String(score?.beatmap?.version ?? info.version ?? ""),
      difficultyRating: score?.beatmap?.difficulty_rating != null ? Number(score.beatmap.difficulty_rating) : info.difficultyRating,
      cs: score?.beatmap?.cs != null ? Number(score.beatmap.cs) : info.cs,
      coverUrl: covers["cover@2x"] ?? covers.cover ?? covers["card@2x"] ?? covers.card ?? info.coverUrl,
      rankedAtMs: info.rankedAtMs,
      farmedUserCount: signal.userCount,
      farmedPlayCount: signal.playCount,
      farmedTotalPpGain: signal.totalPpGain,
      farmedMaxPp: signal.maxPp,
      signalWindowHours: config.discordNewFarmMapSignalWindowHours,
    };
    logInfo("discord_new_farm_map_alert", {
      beatmapId,
      beatmapsetId: info.beatmapsetId,
      users: signal.userCount,
      plays: signal.playCount,
      totalPpGain: signal.totalPpGain,
    });
    await deliverNewMapAlert(alert);
  }

  async function deliverNewMapAlert(alert: NewMapAlert): Promise<void> {
    const body = newMapAlertEmbed(alert, config.discordSiteOrigin);
    // Channel feeds only (all stored under GLOBAL for new_map).
    const subs = await listMatchingSubscriptions(opts.db, "new_map", GLOBAL_COUNTRY_CODE);
    if (subs.length > 0) {
      await fanOutChannelPosts(dedupeSubscriptionsByChannel(subs).map((sub) => sub.channelId), body);
    }
  }

  // --- Event sink ----------------------------------------------------------

  // The channel feed and the new-map alert are independent surfaces; a failure in
  // one must not skip the other. They stay sequential to preserve rate-limit
  // friendliness.
  async function runIsolated(surface: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      logWarn("discord_feed_surface_failed", { surface, error: errorMessage(error) });
    }
  }

  async function handleEvent(event: LiveEvent): Promise<void> {
    if (event.type === "top_play") {
      if (!knownEmpty) await runIsolated("feed", () => postFeedEvent(event));
      await runIsolated("new_map", () => maybeAlertNewFarmMap(event.payload as CountryTopPlay));
    } else if (event.type === "snipe") {
      if (!knownEmpty) await runIsolated("feed", () => postFeedEvent(event));
    }
  }

  const feedSink: EventSink = (event) => {
    if (!config.enableDiscordFeeds) return;
    if (!rest.hasBotToken()) return;
    if (event.type !== "top_play" && event.type !== "snipe") return;
    void handleEvent(event).catch((error) => logWarn("discord_feed_failed", { error: errorMessage(error) }));
  };

  function status(): DiscordStatus {
    return {
      enabled: true,
      configured: Boolean(config.discordApplicationId && config.discordPublicKey),
      hasBotToken: rest.hasBotToken(),
      feedsEnabled: config.enableDiscordFeeds,
      applicationId: config.discordApplicationId ?? null,
      devGuildId: config.discordDevGuildId ?? null,
      commandCount: DISCORD_COMMANDS.length,
      recentInteractions: recent.slice(-RECENT_INTERACTIONS_LIMIT),
      commandCounts: { ...counters.commands },
      errorCount: counters.errors,
    };
  }

  async function listGuilds(): Promise<DiscordGuildSummary[]> {
    const guilds = await rest.listGuilds();
    return guilds
      .map((guild) => ({
        id: String(guild.id),
        name: typeof guild.name === "string" && guild.name ? guild.name : "(unknown server)",
        iconUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null,
        memberCount: typeof guild.approximate_member_count === "number" ? guild.approximate_member_count : null,
      }))
      .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
  }

  logInfo("discord_runtime_ready", {
    applicationId: config.discordApplicationId,
    hasBotToken: rest.hasBotToken(),
    feedsEnabled: config.enableDiscordFeeds,
  });

  // Load the fast-path caches once at startup (non-blocking); until they resolve
  // the feed takes the safe path of querying per event.
  void refreshEmptyFlag();
  void refreshNewMapFlag();
  // Load any previously-registered custom emojis so embeds can render them; until
  // this resolves (or if none are registered) embeds use their text fallbacks.
  void loadEmojiRegistry(opts.db);

  return { handleInteraction, registerCommands, registerEmojis: doRegisterEmojis, listGuilds, feedSink, postOwnerNotice, status, notifySubscriptionsChanged };
}

// Discord error codes that unambiguously mean the channel/guild no longer
// exists (so the subscription should be dropped). Permission conditions are
// intentionally excluded; both 50013 (missing permissions) and 50001 (missing
// access, e.g. the bot lost View Channel via a permission overwrite) are
// usually fixable and transient, so they must not silently wipe a feed config.
function isChannelGoneError(error: DiscordRestError): boolean {
  if (error.status === 404) return true;
  const code = discordErrorCode(error);
  return code === 10003 /* unknown channel */ || code === 10004 /* unknown guild */;
}

// integration_types / contexts are valid only on globally-scoped commands;
// strip them before a guild bulk-overwrite (guild commands are guild-scoped by
// definition, and Discord may reject the global-only fields).
function toGuildCommands(commands: typeof DISCORD_COMMANDS): typeof DISCORD_COMMANDS {
  return commands.map(({ integration_types: _integrationTypes, contexts: _contexts, ...rest }) => rest);
}

function discordErrorCode(error: DiscordRestError): number | null {
  try {
    const parsed = JSON.parse(error.body) as { code?: number };
    return typeof parsed.code === "number" ? parsed.code : null;
  } catch {
    return null;
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  // Reject an oversized declared length up front so a flood can't make us drain
  // a large body before bailing.
  const declared = Array.isArray(req.headers["content-length"]) ? req.headers["content-length"][0] : req.headers["content-length"];
  if (declared != null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > limit) throw new Error("payload too large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new Error("payload too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(Buffer.from(JSON.stringify(body), "utf8"));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
