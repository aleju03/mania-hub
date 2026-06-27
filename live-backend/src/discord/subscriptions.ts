import type { Db } from "../db.js";
import { exec } from "../db.js";
import { GLOBAL_COUNTRY_CODE } from "../countries.js";
import { nowIso } from "../shared/score.js";

export type FeedType = "top_play" | "snipe" | "new_map";

export const FEED_TYPES: FeedType[] = ["top_play", "snipe", "new_map"];

export function isFeedType(value: string | undefined): value is FeedType {
  return value === "top_play" || value === "snipe" || value === "new_map";
}

export const FEED_LABELS: Record<FeedType, string> = {
  top_play: "Top plays",
  snipe: "Snipes",
  new_map: "New farm maps",
};

export interface DiscordSubscription {
  id: number;
  guildId: string | null;
  channelId: string;
  country: string;
  feedType: FeedType;
  minPp: number;
  createdBy: string | null;
  createdAt: string;
}

// Normalizes a country argument for a subscription: a 2-letter code (uppercased)
// or the synthetic GLOBAL scope. Returns null for anything else.
export function normalizeFeedCountry(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value) return null;
  if (value === GLOBAL_COUNTRY_CODE || value === "ALL" || value === "GLOBAL") return GLOBAL_COUNTRY_CODE;
  return /^[A-Z]{2}$/.test(value) ? value : null;
}

function rowToSubscription(row: Record<string, unknown>): DiscordSubscription {
  return {
    id: Number(row.id),
    guildId: row.guild_id == null ? null : String(row.guild_id),
    channelId: String(row.channel_id),
    country: String(row.country),
    feedType: String(row.feed_type) as FeedType,
    minPp: Number(row.min_pp ?? 0),
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: String(row.created_at),
  };
}

export async function addSubscription(
  db: Db,
  params: { guildId: string | null; channelId: string; country: string; feedType: FeedType; minPp: number; createdBy: string | null },
): Promise<void> {
  await exec(
    db,
    `insert into discord_subscriptions (guild_id, channel_id, country, feed_type, min_pp, created_by, created_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(channel_id, feed_type, country)
     do update set min_pp = excluded.min_pp, guild_id = excluded.guild_id, created_by = excluded.created_by`,
    [params.guildId, params.channelId, params.country, params.feedType, Math.max(0, params.minPp), params.createdBy, nowIso()],
  );
}

export async function removeSubscription(
  db: Db,
  params: { channelId: string; feedType: FeedType; country: string },
): Promise<boolean> {
  const result = await exec(
    db,
    "delete from discord_subscriptions where channel_id = ? and feed_type = ? and country = ?",
    [params.channelId, params.feedType, params.country],
  );
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function removeSubscriptionById(db: Db, id: number): Promise<boolean> {
  const result = await exec(db, "delete from discord_subscriptions where id = ?", [id]);
  return Number(result.rowsAffected ?? 0) > 0;
}

// Removes every subscription tied to a channel (used when Discord tells us the
// channel is gone / the bot lost access, so feeds self-heal).
export async function removeSubscriptionsForChannel(db: Db, channelId: string): Promise<number> {
  const result = await exec(db, "delete from discord_subscriptions where channel_id = ?", [channelId]);
  return Number(result.rowsAffected ?? 0);
}

export async function listSubscriptionsForChannel(db: Db, channelId: string): Promise<DiscordSubscription[]> {
  const result = await exec(
    db,
    "select * from discord_subscriptions where channel_id = ? order by feed_type, country",
    [channelId],
  );
  return result.rows.map(rowToSubscription);
}

export async function listSubscriptionsForGuild(db: Db, guildId: string): Promise<DiscordSubscription[]> {
  const result = await exec(
    db,
    "select * from discord_subscriptions where guild_id = ? order by channel_id, feed_type, country",
    [guildId],
  );
  return result.rows.map(rowToSubscription);
}

// Subscriptions that should receive an event for (feedType, country): an exact
// country match plus any GLOBAL subscriptions.
export async function listMatchingSubscriptions(
  db: Db,
  feedType: FeedType,
  country: string | null,
): Promise<DiscordSubscription[]> {
  const code = (country ?? "").trim().toUpperCase();
  const result = await exec(
    db,
    "select * from discord_subscriptions where feed_type = ? and (country = ? or country = ?)",
    [feedType, code, GLOBAL_COUNTRY_CODE],
  );
  return result.rows.map(rowToSubscription);
}

// Collapses subscriptions to one per channel (a channel may hold both a
// country-specific and a GLOBAL row for the same feed). Keeps the lowest min_pp
// so an event passing either threshold still posts exactly once per channel.
export function dedupeSubscriptionsByChannel(subs: DiscordSubscription[]): DiscordSubscription[] {
  const byChannel = new Map<string, DiscordSubscription>();
  for (const sub of subs) {
    const existing = byChannel.get(sub.channelId);
    if (!existing || sub.minPp < existing.minPp) byChannel.set(sub.channelId, sub);
  }
  return [...byChannel.values()];
}

export async function listAllSubscriptions(db: Db): Promise<DiscordSubscription[]> {
  const result = await exec(db, "select * from discord_subscriptions order by guild_id, channel_id, feed_type, country");
  return result.rows.map(rowToSubscription);
}

export async function countSubscriptions(db: Db): Promise<number> {
  const result = await exec(db, "select count(*) as n from discord_subscriptions");
  return Number(result.rows[0]?.n ?? 0);
}

export async function countSubscriptionsByFeed(db: Db, feedType: FeedType): Promise<number> {
  const result = await exec(db, "select count(*) as n from discord_subscriptions where feed_type = ?", [feedType]);
  return Number(result.rows[0]?.n ?? 0);
}
