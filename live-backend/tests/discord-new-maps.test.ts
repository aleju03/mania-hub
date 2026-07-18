import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  claimMapAlert,
  getBeatmapRankedInfo,
  getBeatmapsetRankedAt,
  getFarmMapSignal,
  isWithinRecency,
} from "../src/discord/new-maps.js";

const DAY = 24 * 60 * 60 * 1000;

describe("isWithinRecency", () => {
  const now = Date.parse("2026-06-26T00:00:00Z");
  it("accepts a map ranked inside the window", () => {
    expect(isWithinRecency(now - 3 * DAY, now, 14)).toBe(true);
  });
  it("rejects a map ranked before the window", () => {
    expect(isWithinRecency(now - 20 * DAY, now, 14)).toBe(false);
  });
  it("rejects unknown ranked dates", () => {
    expect(isWithinRecency(null, now, 14)).toBe(false);
  });
  it("rejects a future ranked date beyond the skew guard", () => {
    expect(isWithinRecency(now + 5 * DAY, now, 14)).toBe(false);
  });
});

describe("new-map db helpers", () => {
  let dir = "";
  let db: Db;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mania-discord-maps-"));
    db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
    await migrate(db);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedBeatmap(beatmapId: number, beatmapsetId: number, status: string, rankedDate: string | null): Promise<void> {
    await exec(
      db,
      "insert into beatmaps (beatmap_id, beatmapset_id, mode, status, version, updated_at) values (?, ?, 'mania', ?, '4K', '2026-06-26')",
      [beatmapId, beatmapsetId, status],
    );
    const meta = rankedDate ? JSON.stringify({ ranked_date: rankedDate }) : JSON.stringify({});
    await exec(
      db,
      "insert into beatmapsets (beatmapset_id, title, artist, status, covers_json, metadata_json, updated_at) values (?, 'T', 'A', ?, '{}', ?, '2026-06-26')",
      [beatmapsetId, status, meta],
    );
  }

  async function seedTopPlay(params: {
    scoreId: number;
    userId: number;
    beatmapId: number;
    detectedAt: string;
    ppGain: number;
    pp?: number;
    nestedBeatmapId?: boolean;
  }): Promise<void> {
    const score = params.nestedBeatmapId
      ? { beatmap: { id: params.beatmapId } }
      : { beatmap_id: params.beatmapId };
    await exec(
      db,
      `insert into top_play_events (country, score_id, user_id, pp, weighted_pp, pp_gain, payload_json, detected_at, score_time, score_beatmap_id)
       values ('CR', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.scoreId,
        params.userId,
        params.pp ?? 600,
        params.pp ?? 600,
        params.ppGain,
        JSON.stringify({ score }),
        params.detectedAt,
        params.detectedAt,
        params.beatmapId,
      ],
    );
  }

  it("reads the ranked date from beatmapset metadata", async () => {
    await seedBeatmap(501, 9001, "ranked", "2026-06-20T00:00:00Z");
    expect(await getBeatmapsetRankedAt(db, 9001)).toBe(Date.parse("2026-06-20T00:00:00Z"));
    expect(await getBeatmapsetRankedAt(db, 9999)).toBeNull();
  });

  it("returns null ranked date when metadata lacks one", async () => {
    await seedBeatmap(502, 9002, "ranked", null);
    expect(await getBeatmapsetRankedAt(db, 9002)).toBeNull();
  });

  it("combines beatmap status with the beatmapset ranked date", async () => {
    await seedBeatmap(503, 9003, "ranked", "2026-06-22T00:00:00Z");
    const info = await getBeatmapRankedInfo(db, 503, 9003);
    expect(info?.status).toBe("ranked");
    expect(info?.rankedAtMs).toBe(Date.parse("2026-06-22T00:00:00Z"));
    expect(await getBeatmapRankedInfo(db, 404404, 9003)).toBeNull();
  });

  it("recovers beatmapset and display metadata from the beatmap id", async () => {
    await seedBeatmap(504, 9004, "ranked", "2026-06-23T00:00:00Z");
    const info = await getBeatmapRankedInfo(db, 504, 0);
    expect(info?.beatmapsetId).toBe(9004);
    expect(info?.title).toBe("T");
    expect(info?.artist).toBe("A");
    expect(info?.version).toBe("4K");
  });

  it("prefers the fresh metadata_json status over the stale beatmaps column", async () => {
    // Simulates a qualified-then-ranked map: the column was written once as
    // 'qualified', but ingest keeps rewriting metadata_json, now 'ranked'.
    await exec(
      db,
      "insert into beatmaps (beatmap_id, beatmapset_id, mode, status, version, metadata_json, updated_at) values (700, 9700, 'mania', 'qualified', '4K', ?, '2026-06-26')",
      [JSON.stringify({ status: "ranked" })],
    );
    await exec(
      db,
      "insert into beatmapsets (beatmapset_id, title, artist, status, covers_json, metadata_json, updated_at) values (9700, 'T', 'A', 'ranked', '{}', ?, '2026-06-26')",
      [JSON.stringify({ ranked_date: "2026-06-24T00:00:00Z" })],
    );
    const info = await getBeatmapRankedInfo(db, 700, 9700);
    expect(info?.status).toBe("ranked");
    expect(info?.rankedAtMs).toBe(Date.parse("2026-06-24T00:00:00Z"));
  });

  it("claims a map alert only once", async () => {
    expect(await claimMapAlert(db, 501)).toBe(true);
    expect(await claimMapAlert(db, 501)).toBe(false);
    expect(await claimMapAlert(db, 502)).toBe(true);
  });

  it("qualifies only after enough distinct users gain pp recently", async () => {
    const nowMs = Date.parse("2026-06-26T12:00:00Z");
    await seedTopPlay({ scoreId: 1, userId: 10, beatmapId: 801, detectedAt: "2026-06-26T10:00:00Z", ppGain: 12 });
    await seedTopPlay({ scoreId: 2, userId: 10, beatmapId: 801, detectedAt: "2026-06-26T11:00:00Z", ppGain: 18 });
    await seedTopPlay({ scoreId: 3, userId: 11, beatmapId: 801, detectedAt: "2026-06-26T11:30:00Z", ppGain: 5, nestedBeatmapId: true });
    await seedTopPlay({ scoreId: 4, userId: 12, beatmapId: 801, detectedAt: "2026-06-26T11:45:00Z", ppGain: 0.01 });
    await seedTopPlay({ scoreId: 5, userId: 13, beatmapId: 801, detectedAt: "2026-06-20T00:00:00Z", ppGain: 50 });
    await seedTopPlay({ scoreId: 6, userId: 14, beatmapId: 999, detectedAt: "2026-06-26T11:50:00Z", ppGain: 50 });

    const twoUsers = await getFarmMapSignal(db, 801, { windowHours: 48, minUsers: 3, minPpGain: 1, nowMs });
    expect(twoUsers.userCount).toBe(2);
    expect(twoUsers.playCount).toBe(3);
    expect(twoUsers.qualifies).toBe(false);

    await seedTopPlay({ scoreId: 7, userId: 15, beatmapId: 801, detectedAt: "2026-06-26T11:55:00Z", ppGain: 2 });
    const threeUsers = await getFarmMapSignal(db, 801, { windowHours: 48, minUsers: 3, minPpGain: 1, nowMs });
    expect(threeUsers.userCount).toBe(3);
    expect(threeUsers.playCount).toBe(4);
    expect(threeUsers.totalPpGain).toBe(37);
    expect(threeUsers.qualifies).toBe(true);
  });
});
