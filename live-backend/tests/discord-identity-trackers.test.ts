import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "../src/db.js";
import { getUserLink, removeUserLink, setUserLink } from "../src/discord/identity.js";
import { getChannelMapContext, setChannelMapContext } from "../src/discord/channel-context.js";

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

describe("channel map context", () => {
  it("stores and reads the last map shown in a channel", async () => {
    await setChannelMapContext(db, "chan1", { beatmapId: 3729619, beatmapsetId: 1817883, title: "REOL - Makiba", version: "EXHAUST" });
    const ctx = await getChannelMapContext(db, "chan1");
    expect(ctx?.beatmapId).toBe(3729619);
    expect(ctx?.beatmapsetId).toBe(1817883);
    expect(ctx?.title).toBe("REOL - Makiba");
    expect(ctx?.version).toBe("EXHAUST");
  });

  it("overwrites the context on a new map", async () => {
    await setChannelMapContext(db, "chan1", { beatmapId: 1, beatmapsetId: null, title: null, version: null });
    await setChannelMapContext(db, "chan1", { beatmapId: 2, beatmapsetId: 9, title: "B", version: "X" });
    expect((await getChannelMapContext(db, "chan1"))?.beatmapId).toBe(2);
  });

  it("ignores a missing channel id and returns null when none is set", async () => {
    await setChannelMapContext(db, undefined, { beatmapId: 5, beatmapsetId: null, title: null, version: null });
    expect(await getChannelMapContext(db, undefined)).toBeNull();
    expect(await getChannelMapContext(db, "never-set")).toBeNull();
  });
});
