import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import {
  addSubscription,
  dedupeSubscriptionsByChannel,
  listAllSubscriptions,
  listMatchingSubscriptions,
  listSubscriptionsForGuild,
  normalizeFeedCountry,
  removeSubscription,
  removeSubscriptionsForChannel,
} from "../src/discord/subscriptions.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-discord-subs-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("normalizeFeedCountry", () => {
  it("uppercases 2-letter codes and maps global aliases", () => {
    expect(normalizeFeedCountry("cr")).toBe("CR");
    expect(normalizeFeedCountry("global")).toBe("GLOBAL");
    expect(normalizeFeedCountry("all")).toBe("GLOBAL");
    expect(normalizeFeedCountry("usa")).toBeNull();
    expect(normalizeFeedCountry("")).toBeNull();
    expect(normalizeFeedCountry(undefined)).toBeNull();
  });
});

describe("subscriptions store", () => {
  it("adds and lists a subscription", async () => {
    await addSubscription(db, { guildId: "g1", channelId: "c1", country: "CR", feedType: "top_play", minPp: 500, createdBy: "u1" });
    const all = await listAllSubscriptions(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ channelId: "c1", country: "CR", feedType: "top_play", minPp: 500 });
  });

  it("upserts on the (channel, feed, country) unique key", async () => {
    await addSubscription(db, { guildId: "g1", channelId: "c1", country: "CR", feedType: "top_play", minPp: 100, createdBy: "u1" });
    await addSubscription(db, { guildId: "g1", channelId: "c1", country: "CR", feedType: "top_play", minPp: 800, createdBy: "u2" });
    const all = await listAllSubscriptions(db);
    expect(all).toHaveLength(1);
    expect(all[0].minPp).toBe(800);
  });

  it("returns both a channel's country and GLOBAL rows, which dedupe collapses to one post", async () => {
    await addSubscription(db, { guildId: "g1", channelId: "cBoth", country: "CR", feedType: "top_play", minPp: 300, createdBy: null });
    await addSubscription(db, { guildId: "g1", channelId: "cBoth", country: "GLOBAL", feedType: "top_play", minPp: 900, createdBy: null });

    const matched = await listMatchingSubscriptions(db, "top_play", "CR");
    expect(matched.filter((m) => m.channelId === "cBoth")).toHaveLength(2);

    const deduped = dedupeSubscriptionsByChannel(matched);
    expect(deduped.filter((m) => m.channelId === "cBoth")).toHaveLength(1);
    // Keeps the lowest threshold so an event passing either bound still posts.
    expect(deduped.find((m) => m.channelId === "cBoth")?.minPp).toBe(300);
  });

  it("matches exact country plus GLOBAL subscriptions for an event", async () => {
    await addSubscription(db, { guildId: "g1", channelId: "cCR", country: "CR", feedType: "top_play", minPp: 0, createdBy: null });
    await addSubscription(db, { guildId: "g2", channelId: "cGlobal", country: "GLOBAL", feedType: "top_play", minPp: 0, createdBy: null });
    await addSubscription(db, { guildId: "g3", channelId: "cUS", country: "US", feedType: "top_play", minPp: 0, createdBy: null });
    await addSubscription(db, { guildId: "g4", channelId: "cSnipe", country: "CR", feedType: "snipe", minPp: 0, createdBy: null });

    const matched = await listMatchingSubscriptions(db, "top_play", "CR");
    const channels = matched.map((m) => m.channelId).sort();
    expect(channels).toEqual(["cCR", "cGlobal"]);
  });

  it("removes a single subscription and a channel's subscriptions", async () => {
    await addSubscription(db, { guildId: "g1", channelId: "c1", country: "CR", feedType: "top_play", minPp: 0, createdBy: null });
    await addSubscription(db, { guildId: "g1", channelId: "c1", country: "CR", feedType: "snipe", minPp: 0, createdBy: null });

    expect(await removeSubscription(db, { channelId: "c1", feedType: "top_play", country: "CR" })).toBe(true);
    expect(await removeSubscription(db, { channelId: "c1", feedType: "top_play", country: "CR" })).toBe(false);
    expect(await listSubscriptionsForGuild(db, "g1")).toHaveLength(1);

    expect(await removeSubscriptionsForChannel(db, "c1")).toBe(1);
    expect(await listAllSubscriptions(db)).toHaveLength(0);
  });
});
