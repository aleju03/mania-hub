import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, exec, logApiCall, migrate, type Db } from "../src/db.js";
import { adoptJournalFromMain, drainJournalTablesFromMain, ensureJournalSchema, isJournalAdopted } from "../src/journal.js";
import { LiveEventLog } from "../src/live/event-log.js";
import { wipeUserProjections } from "../src/users.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function setup(): Promise<{ main: Db; journal: Db }> {
  const dir = await mkdtemp(join(tmpdir(), "mania-journal-"));
  dirs.push(dir);
  const main = await createDb({ databaseUrl: `file:${join(dir, "main.db")}` });
  await migrate(main);
  const journal = await createDb({ databaseUrl: `file:${join(dir, "journal.db")}` });
  await ensureJournalSchema(journal);
  return { main, journal };
}

describe("journal database", () => {
  it("adopts the main file's tail once, sequence numbers intact", async () => {
    const { main, journal } = await setup();
    const legacy = new LiveEventLog(main);
    for (let index = 0; index < 5; index += 1) await legacy.append("status", null, { index });
    await exec(main, "insert into api_call_targets (provider, caller, path) values ('osu', 'c', '/p')");
    await exec(main, "insert into api_call_log (provider, caller, path, target_id, started_at) values ('osu', '', '', 1, ?)", [new Date().toISOString()]);
    await exec(main, "insert into api_call_log (provider, caller, path, target_id, started_at) values ('osu', '', '', 1, ?)", ["2000-01-01T00:00:00.000Z"]);
    await exec(main, "insert into live_meta (key, value_json, updated_at) values (?, ?, ?)", ["control:osu_rate_limit_paused_until", '{"until":1,"at":0}', "x"]);

    expect(await isJournalAdopted(journal)).toBe(false);
    const adoption = await adoptJournalFromMain(main, journal);
    expect(adoption?.copied).toMatchObject({ live_event_log: 5, api_call_targets: 1, api_call_log: 1 });
    expect(await isJournalAdopted(journal)).toBe(true);
    expect(await adoptJournalFromMain(main, journal)).toBeNull();

    const seqs = (await exec(journal, "select sequence from live_event_log order by sequence")).rows.map((row) => Number(row.sequence));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    // A new append on the journal continues the main file's numbering.
    const events = new LiveEventLog(main, journal);
    const next = await events.append("status", null, { index: 5 });
    expect(next.sequence).toBe(6);
    expect(await events.latestSequence()).toBe(6);
    expect((await exec(journal, "select value_json from journal_meta where key = 'control:osu_rate_limit_paused_until'")).rows[0]?.value_json).toBe('{"until":1,"at":0}');

    const drained = await drainJournalTablesFromMain(main);
    expect(drained.live_event_log).toBe(5);
    expect(Number((await exec(main, "select count(*) as n from live_event_log")).rows[0].n)).toBe(0);
  });

  it("seeds the sequence even when nothing is worth copying", async () => {
    const { main, journal } = await setup();
    await exec(main, "insert into sqlite_sequence (name, seq) values ('live_event_log', 4200)");
    await adoptJournalFromMain(main, journal);
    const events = new LiveEventLog(main, journal);
    expect((await events.append("status", null, {})).sequence).toBe(4201);
  });

  it("keeps the event log, the call log and a user wipe on the journal handle", async () => {
    const { main, journal } = await setup();
    await adoptJournalFromMain(main, journal);
    const events = new LiveEventLog(main, journal);
    const received: number[] = [];
    events.subscribe((event) => received.push(event.sequence));
    const first = await events.append("goal_completed", "CR", { userId: 7 });
    const dup = await events.append("goal_completed", "CR", { userId: 7 }, first.event_id);
    expect(dup.sequence).toBe(first.sequence);
    expect(received).toEqual([first.sequence]);
    expect((await events.replay("CR", 0)).map((event) => event.sequence)).toEqual([first.sequence]);
    expect(Number((await exec(main, "select count(*) as n from live_event_log")).rows[0].n)).toBe(0);

    await logApiCall(journal, { provider: "osu", caller: "test", path: "/users/1", startedAt: new Date().toISOString(), durationMs: 5, status: 200 });
    expect(Number((await exec(journal, "select count(*) as n from api_call_log where target_id is not null")).rows[0].n)).toBe(1);

    await exec(main, "insert into users (user_id, username, avatar_url, country_code, is_active, updated_at) values (7, 'seven', 'https://a.ppy.sh/7', 'CR', 1, ?)", [new Date().toISOString()]);
    const result = await wipeUserProjections(main, 7, journal);
    expect(result.deleted.live_event_log).toBe(1);
    expect(Number((await exec(journal, "select count(*) as n from live_event_log")).rows[0].n)).toBe(0);
  });
});
