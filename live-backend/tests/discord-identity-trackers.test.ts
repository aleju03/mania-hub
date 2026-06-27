import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import { getUserLink, removeUserLink, setUserLink } from "../src/discord/identity.js";
import {
  addUserTracker,
  countMapTrackers,
  getTrackedOsuUserIds,
  listMapTrackers,
  listTrackersForOsuUser,
  listUserTrackers,
  MAPS_TRACKER_TARGET,
  removeTrackersForSubscriber,
  removeUserTracker,
} from "../src/discord/trackers.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-discord-id-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("identity links", () => {
  it("upserts and reads a link, preserving created_at on relink", async () => {
    await setUserLink(db, { discordUserId: "d1", osuUserId: 124493, osuUsername: "Kalkai", countryCode: "KR" });
    const first = await getUserLink(db, "d1");
    expect(first?.osuUserId).toBe(124493);
    expect(first?.osuUsername).toBe("Kalkai");
    expect(first?.countryCode).toBe("KR");

    await setUserLink(db, { discordUserId: "d1", osuUserId: 2, osuUsername: "rrtyui", countryCode: "JP" });
    const second = await getUserLink(db, "d1");
    expect(second?.osuUserId).toBe(2);
    expect(second?.osuUsername).toBe("rrtyui");
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  it("removes a link", async () => {
    await setUserLink(db, { discordUserId: "d1", osuUserId: 1, osuUsername: "a", countryCode: null });
    expect(await removeUserLink(db, "d1")).toBe(true);
    expect(await getUserLink(db, "d1")).toBeNull();
    expect(await removeUserLink(db, "d1")).toBe(false);
  });
});

describe("personal trackers", () => {
  it("adds a user tracker and finds it by osu user id", async () => {
    await addUserTracker(db, { subscriberId: "d1", kind: "user", targetOsuUserId: 7, targetUsername: "x", minPp: 500 });
    const forUser = await listTrackersForOsuUser(db, 7);
    expect(forUser).toHaveLength(1);
    expect(forUser[0].subscriberId).toBe("d1");
    expect(forUser[0].minPp).toBe(500);
    expect(await getTrackedOsuUserIds(db)).toEqual(new Set([7]));
  });

  it("upserts a user tracker on (subscriber, kind, target) and updates min_pp", async () => {
    await addUserTracker(db, { subscriberId: "d1", kind: "user", targetOsuUserId: 7, targetUsername: "x", minPp: 0 });
    await addUserTracker(db, { subscriberId: "d1", kind: "user", targetOsuUserId: 7, targetUsername: "x", minPp: 800 });
    const list = await listUserTrackers(db, "d1");
    expect(list).toHaveLength(1);
    expect(list[0].minPp).toBe(800);
  });

  it("collapses duplicate maps trackers per subscriber via the sentinel target", async () => {
    await addUserTracker(db, { subscriberId: "d1", kind: "maps", targetOsuUserId: MAPS_TRACKER_TARGET, targetUsername: null, minPp: 0 });
    await addUserTracker(db, { subscriberId: "d1", kind: "maps", targetOsuUserId: MAPS_TRACKER_TARGET, targetUsername: null, minPp: 0 });
    expect(await countMapTrackers(db)).toBe(1);
    const maps = await listMapTrackers(db);
    expect(maps).toHaveLength(1);
    expect(maps[0].subscriberId).toBe("d1");
  });

  it("keeps a user tracker and a maps tracker separate for one subscriber", async () => {
    await addUserTracker(db, { subscriberId: "d1", kind: "user", targetOsuUserId: 7, targetUsername: "x", minPp: 0 });
    await addUserTracker(db, { subscriberId: "d1", kind: "maps", targetOsuUserId: MAPS_TRACKER_TARGET, targetUsername: null, minPp: 0 });
    expect(await listUserTrackers(db, "d1")).toHaveLength(2);
  });

  it("removes a single tracker and all of a subscriber's trackers", async () => {
    await addUserTracker(db, { subscriberId: "d1", kind: "user", targetOsuUserId: 7, targetUsername: "x", minPp: 0 });
    await addUserTracker(db, { subscriberId: "d1", kind: "maps", targetOsuUserId: MAPS_TRACKER_TARGET, targetUsername: null, minPp: 0 });
    expect(await removeUserTracker(db, { subscriberId: "d1", kind: "user", targetOsuUserId: 7 })).toBe(true);
    expect(await listUserTrackers(db, "d1")).toHaveLength(1);
    expect(await removeTrackersForSubscriber(db, "d1")).toBe(1);
    expect(await listUserTrackers(db, "d1")).toHaveLength(0);
  });

  it("tracks multiple subscribers watching the same player", async () => {
    await addUserTracker(db, { subscriberId: "d1", kind: "user", targetOsuUserId: 7, targetUsername: "x", minPp: 0 });
    await addUserTracker(db, { subscriberId: "d2", kind: "user", targetOsuUserId: 7, targetUsername: "x", minPp: 300 });
    expect(await listTrackersForOsuUser(db, 7)).toHaveLength(2);
    expect(await getTrackedOsuUserIds(db)).toEqual(new Set([7]));
  });
});
