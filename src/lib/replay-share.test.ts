import { describe, expect, it } from "vitest";

import { buildReplayDownloadUrl, buildReplayShareUrl, replayDownloadFilename, roundShareSeconds, sanitizeReplayFilename, withReplayShareTime } from "./replay-share";

const ORIGIN = "https://mania-tracker.com";

describe("buildReplayShareUrl", () => {
  it("builds a clean score link, dropping the browse params the viewer was opened from", () => {
    expect(buildReplayShareUrl({ origin: ORIGIN, scoreId: 123 }))
      .toBe("https://mania-tracker.com/replay?scoreId=123");
  });

  it("prefers an uploaded replay's own link", () => {
    expect(buildReplayShareUrl({ origin: ORIGIN, scoreId: 123, uploadShareUrl: `${ORIGIN}/replay?uploadId=abc` }))
      .toBe("https://mania-tracker.com/replay?uploadId=abc");
  });

  it("strips a stale seek offset from the base link", () => {
    expect(buildReplayShareUrl({ origin: ORIGIN, uploadShareUrl: `${ORIGIN}/replay?uploadId=abc&t=12.5` }))
      .toBe("https://mania-tracker.com/replay?uploadId=abc");
  });

  it("returns null without a replay to point at", () => {
    expect(buildReplayShareUrl({ origin: ORIGIN })).toBeNull();
    expect(buildReplayShareUrl({ origin: ORIGIN, scoreId: Number.NaN })).toBeNull();
  });
});

describe("withReplayShareTime", () => {
  it("adds the seek offset in tenths of a second", () => {
    expect(withReplayShareTime(`${ORIGIN}/replay?scoreId=1`, 83.46))
      .toBe("https://mania-tracker.com/replay?scoreId=1&t=83.5");
  });

  it("leaves the start of the replay unmarked", () => {
    expect(withReplayShareTime(`${ORIGIN}/replay?scoreId=1`, 0)).toBe("https://mania-tracker.com/replay?scoreId=1");
    expect(withReplayShareTime(`${ORIGIN}/replay?scoreId=1`, null)).toBe("https://mania-tracker.com/replay?scoreId=1");
  });

  it("replaces an offset already on the link", () => {
    expect(withReplayShareTime(`${ORIGIN}/replay?scoreId=1&t=5`, 9))
      .toBe("https://mania-tracker.com/replay?scoreId=1&t=9");
  });

  it("hands back anything it cannot parse", () => {
    expect(withReplayShareTime("not a url", 5)).toBe("not a url");
  });
});

describe("roundShareSeconds", () => {
  it("rounds to the tenth the viewer seeks on, and refuses non-positive times", () => {
    expect(roundShareSeconds(1.24)).toBe(1.2);
    expect(roundShareSeconds(1.26)).toBe(1.3);
    expect(roundShareSeconds(0.04)).toBeNull();
    expect(roundShareSeconds(-3)).toBeNull();
    expect(roundShareSeconds(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("replay downloads", () => {
  it("links a score or an upload and nothing else", () => {
    expect(buildReplayDownloadUrl({ scoreId: 123 })).toBe("/api/replay-file?scoreId=123");
    expect(buildReplayDownloadUrl({ uploadId: "abc", scoreId: 123 })).toBe("/api/replay-file?uploadId=abc");
    expect(buildReplayDownloadUrl({})).toBeNull();
  });

  it("names the file like an osu! export", () => {
    expect(replayDownloadFilename({
      playerName: "player",
      artist: "Artist",
      title: "Song: Remix?",
      version: "Hard",
      playedAt: "2026-10-31T11:25:00Z",
    })).toBe("player - Artist - Song Remix [Hard] (2026-10-31_11-25) OsuMania.osr");
    expect(replayDownloadFilename({})).toBe("replay OsuMania.osr");
    expect(sanitizeReplayFilename("../x")).toBe("..x.osr");
  });
});
