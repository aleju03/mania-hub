import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { OsuApiClient } from "../osu/client.js";
import type { EventSink } from "../live/event-log.js";
import type { CountryTopPlay, LiveEvent, SnipeEvent } from "../shared/types.js";
import { logInfo, logWarn } from "../logger.js";
import { DiscordRest, DiscordRestError } from "./rest.js";
import { verifyDiscordSignature } from "./verify.js";
import {
  DISCORD_COMMANDS,
  FLAG_EPHEMERAL,
  hasManageGuild,
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_PING,
  invokerId,
  MANAGE_GUILD_COMMANDS,
  RESPONSE_CHANNEL_MESSAGE,
  RESPONSE_DEFERRED_CHANNEL_MESSAGE,
  RESPONSE_PONG,
  type DiscordInteraction,
} from "./commands.js";
import { COMMAND_HANDLERS, type HandlerDeps } from "./handlers.js";
import { snipeEmbed, topPlayEmbed } from "./embeds.js";
import {
  countSubscriptions,
  dedupeSubscriptionsByChannel,
  listMatchingSubscriptions,
  removeSubscriptionsForChannel,
  type FeedType,
} from "./subscriptions.js";
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
}

export interface DiscordRuntime {
  handleInteraction(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  registerCommands(): Promise<{ global: number; guild: number | null }>;
  feedSink: EventSink;
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

  // Fast-path flag: when no channel anywhere is subscribed, skip the per-event
  // subscription lookup entirely. Starts pessimistic (false = do the query) until
  // the first count loads, and is refreshed on every subscription mutation, so it
  // never causes a missed post. No background timer is involved.
  let knownEmpty = false;
  async function refreshEmptyFlag(): Promise<void> {
    try {
      knownEmpty = (await countSubscriptions(opts.db)) === 0;
    } catch {
      knownEmpty = false;
    }
  }
  function notifySubscriptionsChanged(): void {
    void refreshEmptyFlag();
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
  }

  async function dispatchCommand(interaction: DiscordInteraction): Promise<void> {
    const name = interaction.data?.name ?? "";
    const handler = COMMAND_HANDLERS[name];
    let body;
    try {
      body = handler ? await handler(deps, interaction) : { content: `Unknown command: ${name}` };
    } catch (error) {
      logWarn("discord_dispatch_failed", { command: name, error: errorMessage(error) });
      body = { content: "Something went wrong handling that command." };
    }
    try {
      await rest.editOriginalInteractionResponse(interaction.token, body);
    } catch (error) {
      logWarn("discord_followup_failed", { command: name, error: errorMessage(error) });
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
          data: { content: "You need the Manage Server permission to use this.", flags: FLAG_EPHEMERAL, allowed_mentions: { parse: [] } },
        });
        return true;
      }
      // ACK with a deferred public response within Discord's 3s window, then do
      // the real work and edit the original message.
      sendJson(res, 200, { type: RESPONSE_DEFERRED_CHANNEL_MESSAGE });
      void dispatchCommand(interaction);
      return true;
    }

    // We register no components/autocomplete, so other interaction types should
    // not arrive; answer with an ephemeral notice rather than erroring.
    sendJson(res, 200, {
      type: RESPONSE_CHANNEL_MESSAGE,
      data: { content: "Unsupported interaction.", flags: FLAG_EPHEMERAL, allowed_mentions: { parse: [] } },
    });
    return true;
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

  async function postFeedEvent(event: LiveEvent): Promise<void> {
    if (!rest.hasBotToken()) return;
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

    // Fan out across channels with bounded concurrency so a feed with many
    // subscribers posts quickly instead of one-at-a-time.
    let healed = false;
    await mapWithConcurrency(targets, FEED_POST_CONCURRENCY, async (sub) => {
      try {
        await rest.createChannelMessage(sub.channelId, body);
      } catch (error) {
        if (error instanceof DiscordRestError && isChannelGoneError(error)) {
          await removeSubscriptionsForChannel(opts.db, sub.channelId).catch(() => {});
          healed = true;
          logInfo("discord_subscription_self_healed", { channelId: sub.channelId, status: error.status });
        } else {
          logWarn("discord_channel_post_failed", { channelId: sub.channelId, error: errorMessage(error) });
        }
      }
    });
    if (healed) notifySubscriptionsChanged();
  }

  const feedSink: EventSink = (event) => {
    if (!config.enableDiscordFeeds) return;
    if (event.type !== "top_play" && event.type !== "snipe") return;
    // Skip the per-event DB lookup entirely while nothing is subscribed.
    if (knownEmpty) return;
    void postFeedEvent(event).catch((error) => logWarn("discord_feed_failed", { error: errorMessage(error) }));
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
    };
  }

  logInfo("discord_runtime_ready", {
    applicationId: config.discordApplicationId,
    hasBotToken: rest.hasBotToken(),
    feedsEnabled: config.enableDiscordFeeds,
  });

  // Load the empty-flag once at startup (non-blocking); until it resolves the
  // feed takes the safe path of querying per event.
  void refreshEmptyFlag();

  return { handleInteraction, registerCommands, feedSink, status, notifySubscriptionsChanged };
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
