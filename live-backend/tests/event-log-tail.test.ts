import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, migrate } from "../src/db.js";
import { LiveEventLog } from "../src/live/event-log.js";
import type { LiveEvent } from "../src/shared/types.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

async function tempDbUrl(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mania-eventlog-"));
  dirs.push(dir);
  return `file:${join(dir, "test.db")}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("live event log tail (server/worker split)", () => {
  it("delivers events appended on a separate worker connection to a tailing server connection", async () => {
    const url = await tempDbUrl();
    const writerDb = await createDb({ databaseUrl: url });
    await migrate(writerDb);
    const readerDb = await createDb({ databaseUrl: url });

    const writer = new LiveEventLog(writerDb); // worker process: appends, no tailing
    const reader = new LiveEventLog(readerDb); // server process: tails for SSE

    const received: LiveEvent[] = [];
    reader.subscribe((event) => received.push(event));
    const stop = reader.startTail(25);
    // Let the tailer pin its cursor at the current head before we append.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await writer.append("snipe", "CR", { hello: "world" }, "evt-1");

    await waitFor(() => received.some((event) => event.event_id === "evt-1"));
    // Exactly one delivery: the cross-connection write is forwarded once.
    expect(received.filter((event) => event.event_id === "evt-1")).toHaveLength(1);
    expect(received.find((event) => event.event_id === "evt-1")?.payload).toMatchObject({ hello: "world" });
    expect(received.find((event) => event.event_id === "evt-1")?.country).toBe("CR");

    stop();
  });

  it("does not double-deliver when the tailing connection also appends", async () => {
    const url = await tempDbUrl();
    const db = await createDb({ databaseUrl: url });
    await migrate(db);

    const log = new LiveEventLog(db);
    const received: LiveEvent[] = [];
    log.subscribe((event) => received.push(event));
    const stop = log.startTail(25);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // While tailing, append() must skip its in-process dispatch so the poller is
    // the single delivery path (otherwise events would be sent twice).
    await log.append("snipe", "CR", { n: 1 }, "evt-x");

    await waitFor(() => received.some((event) => event.event_id === "evt-x"));
    await new Promise((resolve) => setTimeout(resolve, 75)); // allow a second poll to (not) re-send
    expect(received.filter((event) => event.event_id === "evt-x")).toHaveLength(1);

    stop();
  });

  it("forwards only events created after the tail starts", async () => {
    const url = await tempDbUrl();
    const writerDb = await createDb({ databaseUrl: url });
    await migrate(writerDb);
    const readerDb = await createDb({ databaseUrl: url });
    const writer = new LiveEventLog(writerDb);
    const reader = new LiveEventLog(readerDb);

    // Pre-existing history must not be replayed to live sinks (SSE clients get
    // their own backlog via replay-on-connect, not the tailer).
    await writer.append("snipe", "CR", { old: true }, "evt-old");

    const received: LiveEvent[] = [];
    reader.subscribe((event) => received.push(event));
    const stop = reader.startTail(25);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await writer.append("snipe", "CR", { fresh: true }, "evt-new");
    await waitFor(() => received.some((event) => event.event_id === "evt-new"));

    expect(received.some((event) => event.event_id === "evt-old")).toBe(false);
    expect(received.some((event) => event.event_id === "evt-new")).toBe(true);

    stop();
  });
});
