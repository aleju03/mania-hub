/* Rankless tracked players enter through either a manual opt-in or a score
   discovery. This query is the final gate between a roster row and a card in
   everyone's binder: with no ranked mania play there are no scores to weigh,
   computeManiaSkills returns null, and the pull deals the renderer's blank
   empty state - which still takes a serial and cannot be un-dealt. `pp is not
   null` let a 0pp account through (August 2026); the pool wants pp above zero. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { readUnrankedPoolEntries } from "../src/features/global-rankings.js";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function makeDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-pool-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return db;
}

async function seedUser(db: Db, userId: number, username: string, pp: number | null): Promise<void> {
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, pp, is_active, updated_at)
     values (?, ?, '', 'VN', ?, 1, '2026-08-05T00:00:00Z')`,
    [userId, username, pp],
  );
}

async function seedRoster(db: Db, userId: number, source: string, rank: number | null): Promise<void> {
  await exec(
    db,
    `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
     values ('VN', ?, ?, ?, 1, '2026-08-05T00:00:00Z')`,
    [userId, rank, source],
  );
}

describe("pack pool unranked tracked members", () => {
  it("keeps tracked members with no ranked mania play out of the draw pool", async () => {
    const db = await makeDb();
    await seedUser(db, 1, "real_player", 1234.5);
    await seedRoster(db, 1, "manual", null);
    await seedUser(db, 2, "vbnmvbnvbmnvbmk", 0);
    await seedRoster(db, 2, "manual", null);
    await seedUser(db, 3, "never_enriched", null);
    await seedRoster(db, 3, "manual", null);

    const entries = await readUnrankedPoolEntries(db);

    expect(entries.map((entry) => entry.user.id)).toEqual([1]);
  });

  it("still admits a low-pp opt-in, since one ranked play is a real card", async () => {
    const db = await makeDb();
    await seedUser(db, 1, "barely_played", 0.4);
    await seedRoster(db, 1, "manual", null);

    const entries = await readUnrankedPoolEntries(db);

    expect(entries.map((entry) => entry.user.id)).toEqual([1]);
  });

  it("admits a score-discovered member without a ranked roster slot", async () => {
    const db = await makeDb();
    await seedUser(db, 1, "score_discovered", 1234.5);
    await seedRoster(db, 1, "score", null);

    const entries = await readUnrankedPoolEntries(db);

    expect(entries.map((entry) => entry.user.id)).toEqual([1]);
  });

  it("leaves a player who holds a ranked slot elsewhere to the ranked board", async () => {
    const db = await makeDb();
    await seedUser(db, 1, "ranked_elsewhere", 5000);
    await seedRoster(db, 1, "manual", null);
    await exec(
      db,
      `insert into country_rosters (country, user_id, rank, source, is_tracked, refreshed_at)
       values ('KR', 1, 12, 'ranking', 1, '2026-08-05T00:00:00Z')`,
    );

    expect(await readUnrankedPoolEntries(db)).toEqual([]);
  });
});
