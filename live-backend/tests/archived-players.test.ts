import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { ensureArchivedPlayers, readArchivedPlayerSnapshots } from "../src/archived-players.js";
import { getCachedPlayerProfileSnapshot, getPlayerAbout, getPlayerProfileSnapshot } from "../src/features/player-profiles.js";

// Archived players are osu! accounts that no longer exist (deleted, or wiped to
// 0pp), reconstructed from Wayback captures and seeded on boot. Every osu! API
// call for them 404s, so the guarantee under test is that no serving path
// reaches the API and no path overwrites the reconstruction.

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-archived-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

// Any osu! client call from an archived-player path is a bug, so the stub
// throws rather than returning fixtures.
const throwingOsu = {
  getUser: () => { throw new Error("osu! API must not be called for an archived player"); },
  getUserByKey: () => { throw new Error("osu! API must not be called for an archived player"); },
  getUserBestScoresWindow: () => { throw new Error("osu! API must not be called for an archived player"); },
} as never;

describe("archived players", () => {
  it("ships at least one checked-in snapshot, and every snapshot is well formed", async () => {
    const snapshots = await readArchivedPlayerSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot.user_id).toBeGreaterThan(0);
      expect(snapshot.username_key).toBe(snapshot.username_key.toLowerCase());
      expect(snapshot.best_scores.length).toBeGreaterThan(0);
      expect((snapshot.user as { archived?: unknown }).archived).toBe(true);
    }
  });

  it("seeds profile_snapshots on first boot and no-ops on the next", async () => {
    await ensureArchivedPlayers(db);
    const seeded = (await exec(db, "select user_id, username_key from profile_snapshots")).rows;
    expect(seeded.length).toBeGreaterThan(0);

    const before = (await exec(db, "select updated_at from profile_snapshots order by user_id")).rows;
    await ensureArchivedPlayers(db);
    const after = (await exec(db, "select updated_at from profile_snapshots order by user_id")).rows;
    expect(after).toEqual(before);
  });

  it("re-seeds when the row is gone even though the sentinel survives", async () => {
    await ensureArchivedPlayers(db);
    await exec(db, "delete from profile_snapshots");
    await ensureArchivedPlayers(db);
    expect((await exec(db, "select count(*) as c from profile_snapshots")).rows[0]?.c).toBeGreaterThan(0);
  });

  it("skips a seed whose username is taken rather than failing the boot", async () => {
    const [seed, ...rest] = await readArchivedPlayerSnapshots();
    if (!seed || rest.length === 0) throw new Error("expected at least two seeded archived players");

    // `username_key` is unique, so a live player under that name occupies it.
    await exec(
      db,
      `insert into profile_snapshots
         (user_id, username_key, user_json, best_scores_json, best_scores_limit,
          fetched_at, user_fetched_at, updated_at)
       values (?, ?, '{}', '[]', 0, ?, ?, ?)`,
      [999999, seed.username_key, "2026-01-01", "2026-01-01", "2026-01-01"],
    );

    await expect(ensureArchivedPlayers(db)).resolves.toBeUndefined();
    const seeded = (await exec(db, "select user_id from profile_snapshots where user_id = ?", [seed.user_id])).rows;
    expect(seeded).toHaveLength(0);
    for (const other of rest) {
      const row = (await exec(db, "select user_id from profile_snapshots where user_id = ?", [other.user_id])).rows;
      expect(row).toHaveLength(1);
    }
  });

  it("never adds a users row, keeping archived players out of rankings and the pack pool", async () => {
    await ensureArchivedPlayers(db);
    expect((await exec(db, "select count(*) as c from users")).rows[0]?.c).toBe(0);
    expect((await exec(db, "select count(*) as c from country_rosters")).rows[0]?.c).toBe(0);
  });

  it("serves the seeded snapshot without touching the osu! API", async () => {
    await ensureArchivedPlayers(db);
    const [seed] = await readArchivedPlayerSnapshots();
    if (!seed) throw new Error("expected a seeded archived player");

    const cached = await getCachedPlayerProfileSnapshot(db, seed.username_key);
    expect(cached?.user.id).toBe(seed.user_id);
    expect(cached?.bestScores.length).toBe(seed.best_scores.length);

    // The refreshing path must short-circuit too, and must not mark it stale.
    const served = await getPlayerProfileSnapshot(db, throwingOsu, seed.username_key);
    expect(served.user.id).toBe(seed.user_id);
    expect(served.isStale).toBe(false);
  });

  it("serves the recovered about-me from the snapshot", async () => {
    await ensureArchivedPlayers(db);
    const [seed] = await readArchivedPlayerSnapshots();
    if (!seed) throw new Error("expected a seeded archived player");
    const page = (seed.user as { page?: { raw?: string } }).page;
    if (!page?.raw) return;

    const about = await getPlayerAbout(db, throwingOsu, seed.user_id);
    expect(about.section).toBe("about");
    expect((about.payload as { raw: string | null }).raw).toBe(page.raw);
  });
});
