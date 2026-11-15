import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ReplayDownloadLimitError, resetReplayDownloadLimits, takeReplayDownloadSlot } from "./replay-download-limit";

beforeEach(() => resetReplayDownloadLimits());

describe("replay download limit", () => {
  it("refuses a client past its hourly ceiling and lets it back in after the hour", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) takeReplayDownloadSlot("1.2.3.4", now, 3);
    expect(() => takeReplayDownloadSlot("1.2.3.4", now + 1000, 3)).toThrow(ReplayDownloadLimitError);
    // Another client keeps its own ceiling.
    expect(() => takeReplayDownloadSlot("5.6.7.8", now + 1000, 3)).not.toThrow();
    expect(() => takeReplayDownloadSlot("1.2.3.4", now + 60 * 60_000, 3)).not.toThrow();
  });

  it("says how long until the window resets", () => {
    takeReplayDownloadSlot("1.2.3.4", 0, 1);
    try {
      takeReplayDownloadSlot("1.2.3.4", 10 * 60_000, 1);
      expect.unreachable();
    } catch (error) {
      expect((error as ReplayDownloadLimitError).retryAfterMs).toBe(50 * 60_000);
    }
  });

  it("is only spent after the cached copy misses, on both replay entry points", () => {
    const replay = fs.readFileSync(path.resolve(__dirname, "osu/replay.ts"), "utf8");
    const buffer = replay.match(/export async function getReplayBuffer[\s\S]*?\n\}/)?.[0] ?? "";
    expect(buffer.indexOf("if (cached) return cached.buffer;")).toBeGreaterThan(-1);
    expect(buffer.indexOf("takeReplayDownloadSlot(clientKey)")).toBeGreaterThan(buffer.indexOf("if (cached) return cached.buffer;"));
    expect(replay).toContain("getReplayBuffer(data, getAppRateLimitClientIp(getRequest()))");

    const route = fs.readFileSync(path.resolve(__dirname, "../routes/api/replay-file.ts"), "utf8");
    expect(route).toContain("getReplayBuffer({ scoreId, mode: \"mania\" }, getAppRateLimitClientIp(request))");
    expect(route).toContain("status: 429");
  });
});
