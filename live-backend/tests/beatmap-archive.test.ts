import { beforeEach, describe, expect, it } from "vitest";
import {
  __cooldownArchiveSourceForErrorForTest,
  __getArchiveSourceAttemptOrderForTest,
  __getArchiveSourceOrderForTest,
  __resetArchiveSourceOrderForTest,
  __setArchiveSourceStateForTest,
  __withArchiveSourceSlotForTest,
} from "../src/audio/beatmap-archive.js";

describe("beatmap archive mirror order", () => {
  beforeEach(() => {
    __resetArchiveSourceOrderForTest();
  });

  it("rotates the first archive mirror across attempts", () => {
    expect(__getArchiveSourceOrderForTest(1_000)).toEqual([
      "osudl",
      "osu.direct",
      "catboy",
      "hinai",
      "nerinyan",
      "sayobot",
    ]);
    expect(__getArchiveSourceOrderForTest(1_000)).toEqual([
      "osu.direct",
      "catboy",
      "hinai",
      "nerinyan",
      "sayobot",
      "osudl",
    ]);
  });

  it("prefers available mirrors over cooling down or rate-slotted mirrors", () => {
    __setArchiveSourceStateForTest("osudl", { nextAvailableAt: 2_000 });
    __setArchiveSourceStateForTest("catboy", { cooldownUntil: 60_000 });

    expect(__getArchiveSourceOrderForTest(1_000)).toEqual([
      "osu.direct",
      "hinai",
      "nerinyan",
      "sayobot",
      "osudl",
      "catboy",
    ]);
  });

  it("skips cooling mirrors while any is available, but tries all of them once none is", () => {
    const now = Date.now();
    const names = ["osudl", "osu.direct", "catboy", "hinai", "nerinyan", "sayobot"] as const;
    for (const name of names.slice(1)) __setArchiveSourceStateForTest(name, { cooldownUntil: now + 60_000 });
    expect(__getArchiveSourceAttemptOrderForTest()).toEqual(["osudl"]);

    __setArchiveSourceStateForTest("osudl", { cooldownUntil: now + 120_000 });
    const attempted = __getArchiveSourceAttemptOrderForTest();
    expect(attempted).toHaveLength(names.length);
    // Soonest to expire first; osudl carries the longest pause.
    expect(attempted[attempted.length - 1]).toBe("osudl");
  });

  it("pauses a mirror briefly on a timeout and for longer on a rejection", () => {
    const before = Date.now();
    const timeout = new Error("archive request timed out");
    timeout.name = "AbortError";
    __cooldownArchiveSourceForErrorForTest("catboy", timeout);
    __cooldownArchiveSourceForErrorForTest("hinai", new Error("hinai returned 429"));
    const order = __getArchiveSourceOrderForTest(before + 2 * 60_000);
    // Two minutes later the timed-out mirror is back ahead of the rejected one.
    expect(order.indexOf("catboy")).toBeLessThan(order.indexOf("hinai"));
  });
});

describe("archive source slot queue", () => {
  beforeEach(() => {
    __resetArchiveSourceOrderForTest();
  });

  it("releases the slot when the signal aborts even if the task never settles", async () => {
    const hungController = new AbortController();
    const hung = __withArchiveSourceSlotForTest("catboy", hungController.signal, () => new Promise<never>(() => {}));
    const hungOutcome = hung.catch((error: Error) => error);
    hungController.abort();
    expect(((await hungOutcome) as Error).name).toBe("AbortError");

    // The queue must be usable again after the hung task is abandoned.
    __setArchiveSourceStateForTest("catboy", { nextAvailableAt: 0 });
    const nextController = new AbortController();
    await expect(
      __withArchiveSourceSlotForTest("catboy", nextController.signal, async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("rejects queued callers whose signal aborts while waiting behind a hung task", async () => {
    const first = new AbortController();
    const hung = __withArchiveSourceSlotForTest("sayobot", first.signal, () => new Promise<never>(() => {}));
    const hungOutcome = hung.catch((error: Error) => error);

    const second = new AbortController();
    const queued = __withArchiveSourceSlotForTest("sayobot", second.signal, async () => "ok");
    const queuedOutcome = queued.catch((error: Error) => error);

    second.abort();
    first.abort();

    expect(((await hungOutcome) as Error).name).toBe("AbortError");
    expect(((await queuedOutcome) as Error).name).toBe("AbortError");
  });
});
