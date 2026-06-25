import { beforeEach, describe, expect, it } from "vitest";
import {
  __getArchiveSourceOrderForTest,
  __resetArchiveSourceOrderForTest,
  __setArchiveSourceStateForTest,
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
});
