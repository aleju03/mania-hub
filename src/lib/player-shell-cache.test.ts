import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RECENT_PLAY_ONLINE_WINDOW_MS,
  playedWithinOnlineWindow,
  readPlayerRecentPlay,
  readPlayerShell,
  seedPlayerRecentPlay,
  seedPlayerShellFromRankingEntry,
  stripUntrackedProfilePresence,
} from "./player-shell-cache";
import type { LeanRankingEntry, OsuUser } from "./types";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

describe("playedWithinOnlineWindow", () => {
  it("counts a play from inside the window", () => {
    expect(playedWithinOnlineWindow(iso(-60_000), NOW)).toBe(true);
  });

  it("drops a play once the window has passed", () => {
    expect(playedWithinOnlineWindow(iso(-RECENT_PLAY_ONLINE_WINDOW_MS), NOW)).toBe(false);
    expect(playedWithinOnlineWindow(iso(-17 * 24 * 60 * 60_000), NOW)).toBe(false);
  });

  it("tolerates clock skew that dates a play slightly ahead of the browser", () => {
    expect(playedWithinOnlineWindow(iso(30_000), NOW)).toBe(true);
    expect(playedWithinOnlineWindow(iso(RECENT_PLAY_ONLINE_WINDOW_MS), NOW)).toBe(false);
  });

  it("rejects unparseable timestamps", () => {
    expect(playedWithinOnlineWindow("", NOW)).toBe(false);
    expect(playedWithinOnlineWindow("not a date", NOW)).toBe(false);
  });
});

describe("seedPlayerRecentPlay", () => {
  it("hands a fresh play back to the profile, case-insensitively", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    seedPlayerRecentPlay("Nostril", iso(-120_000));

    expect(readPlayerRecentPlay("nostril")).toBe(iso(-120_000));
    expect(readPlayerRecentPlay("  NOSTRIL  ")).toBe(iso(-120_000));
  });

  it("stops reporting the play once it ages out of the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    seedPlayerRecentPlay("staleplayer", iso(0));
    expect(readPlayerRecentPlay("staleplayer")).toBe(iso(0));

    vi.setSystemTime(NOW + RECENT_PLAY_ONLINE_WINDOW_MS + 1);
    expect(readPlayerRecentPlay("staleplayer")).toBeNull();
  });

  it("ignores scores with no usable timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    // getScoreTimestamp() returns "" when a score carries neither date.
    seedPlayerRecentPlay("timeless", "");

    expect(readPlayerRecentPlay("timeless")).toBeNull();
  });

  it("has nothing to say about a player who was never seen playing", () => {
    expect(readPlayerRecentPlay("neverseen")).toBeNull();
    expect(readPlayerRecentPlay("")).toBeNull();
  });
});

describe("seedPlayerShellFromRankingEntry", () => {
  const rankingEntry = (username: string, isOnline: boolean): LeanRankingEntry => ({
    user: {
      id: 4242,
      username,
      avatar_url: "https://a.ppy.sh/4242",
      cover_url: "",
      country_code: "CR",
      is_online: isOnline,
    },
    hit_accuracy: 98.5,
    play_count: 1234,
    pp: 5000,
    global_rank: 12,
    ranked_score: 1,
    grade_counts: { ss: 0, ssh: 0, s: 0, sh: 0, a: 0 },
  });

  it("does not carry the rankings page's osu! presence over to the profile", () => {
    seedPlayerShellFromRankingEntry(rankingEntry("OnlineRanker", true), 1);

    const shell = readPlayerShell("onlineranker");
    expect(shell?.username).toBe("OnlineRanker");
    // The profile's green dot means a tracked play inside the session window,
    // which only the backend snapshot knows about.
    expect(shell?.is_online).toBe(false);
    expect(shell?.last_visit).toBeNull();
  });
});

describe("stripUntrackedProfilePresence", () => {
  it("drops osu! presence while preserving fallback profile metadata", () => {
    const user = {
      id: 4242,
      username: "IdlePlayer",
      avatar_url: "https://a.ppy.sh/4242",
      is_online: true,
      last_visit: "2026-07-21T11:55:00.000Z",
      statistics: { pp: 5000 },
    } as OsuUser;

    const stripped = stripUntrackedProfilePresence(user);

    expect(stripped).not.toBe(user);
    expect(stripped.is_online).toBe(false);
    expect(stripped.last_visit).toBeNull();
    expect(stripped.username).toBe("IdlePlayer");
    expect(stripped.statistics?.pp).toBe(5000);
  });
});
