import { describe, expect, it } from "vitest";
import {
  companellaImportsToScores,
  companellaReplayImportId,
  companellaRowToOsuScore,
  dropCompanellaOsuTwins,
  isCompanellaOsuTwin,
} from "./companella-scores";
import { getBeatmapUrl, getScoreDisplayValues, getScoreIdentity, getScoreUrl, scoreHasReplay } from "./score";
import type { LeanTrackerScore, OsuCovers, OsuScore } from "./types";

function importRow(overrides: Partial<LeanTrackerScore> = {}): LeanTrackerScore {
  return {
    id: -101,
    user_id: 7,
    accuracy: 0.9966666666666667,
    beatmap_id: 100,
    mods: [{ acronym: "HD" }],
    score: 987_654,
    total_score: 987_654,
    legacy_total_score: 987_654,
    max_combo: 1_200,
    passed: true,
    rank: "SH",
    statistics: { count_geki: 900, count_300: 90, count_katu: 10, count_100: 0, count_50: 0, count_miss: 0 },
    pp: 312.5,
    beatmap: {
      id: 100,
      beatmapset_id: 50,
      difficulty_rating: 4.2,
      mode: "mania",
      cs: 4,
      bpm: 180,
      max_combo: 1_500,
      version: "Hard",
      url: "https://osu.ppy.sh/beatmaps/100",
    },
    beatmapset: { id: 50, title: "Title", artist: "Artist", covers: {} as OsuCovers },
    user: { id: 7, username: "someone", avatar_url: "https://a.ppy.sh/7", country_code: "CR" },
    created_at: "2026-09-01T10:00:00.000Z",
    ended_at: "2026-09-01T10:00:00.000Z",
    has_replay: false,
    companella: { importId: "import-0001", replay: false },
    ...overrides,
  };
}

/* A synthesized chart: the uploaded file matched no official one. */
function unofficialRow(overrides: Partial<LeanTrackerScore> = {}): LeanTrackerScore {
  return importRow({
    id: -102,
    beatmap_id: undefined,
    pp: null,
    beatmap: {
      id: 0,
      beatmapset_id: 0,
      difficulty_rating: 0,
      mode: "mania",
      cs: 7,
      bpm: 0,
      max_combo: 0,
      version: "Custom",
      url: "",
    },
    beatmapset: { id: 0, title: "Own Chart", artist: "Someone", covers: {} as OsuCovers },
    companella: { importId: "import-0002", replay: false },
    ...overrides,
  });
}

function osuRow(overrides: Partial<OsuScore> = {}): OsuScore {
  return {
    id: 5_000_000_001,
    legacy_score_id: 4_000_001,
    user_id: 7,
    accuracy: 0.9966666666666667,
    mods: [{ acronym: "HD" }],
    score: 912_000,
    total_score: 912_000,
    legacy_total_score: 987_654,
    max_combo: 1_200,
    passed: true,
    rank: "SH",
    statistics: {},
    pp: 312.5,
    beatmap: { id: 100, cs: 4, mode: "mania" },
    beatmapset: { id: 50, title: "Title", artist: "Artist", covers: {} as OsuCovers },
    user: { id: 7, username: "someone", avatar_url: "", country_code: "CR" },
    ended_at: "2026-09-01T10:02:00.000Z",
    has_replay: true,
    ...overrides,
  } as unknown as OsuScore;
}

describe("companellaRowToOsuScore", () => {
  it("reads as a stable play with its own accuracy, grade and total", () => {
    const score = companellaRowToOsuScore(importRow());
    const display = getScoreDisplayValues(score);
    expect(display.isLazer).toBe(false);
    expect(display.accuracy).toBeCloseTo(0.9966666666666667, 10);
    expect(display.rank).toBe("SH");
    expect(display.totalScore).toBe(987_654);
    expect(score.pp).toBe(312.5);
  });

  it("keeps the mark, and a row identity no osu! play can share", () => {
    const score = companellaRowToOsuScore(importRow());
    expect(score.companella).toEqual({ importId: "import-0001", replay: false });
    expect(getScoreIdentity(score)).toBe("companella:import-0001");
    expect(getScoreUrl(score)).toBeNull();
    // Watch comes only from the mark, never from the osu! replay path.
    expect(scoreHasReplay(score)).toBe(false);
    expect(companellaReplayImportId(score)).toBeUndefined();
    expect(companellaReplayImportId(companellaRowToOsuScore(importRow({ companella: { importId: "import-0001", replay: true } }))))
      .toBe("import-0001");
  });

  it("links an official chart and gives its set the site's background", () => {
    const score = companellaRowToOsuScore(importRow());
    expect(getBeatmapUrl(score)).toBe("https://osu.ppy.sh/beatmaps/100");
    expect(score.beatmap.difficulty_rating).toBe(4.2);
    expect(score.beatmapset.covers.cover).toBe("/api/background?beatmapsetId=50");
    expect(score.beatmapset.covers["cover@2x"]).toBe("/api/background?beatmapsetId=50");
  });

  it("keeps the covers an official row brought", () => {
    const score = companellaRowToOsuScore(importRow({
      beatmapset: { id: 50, title: "Title", artist: "Artist", covers: { cover: "https://assets.ppy.sh/c.jpg", list: "https://assets.ppy.sh/l.jpg" } as OsuCovers },
    }));
    expect(score.beatmapset.covers.cover).toBe("https://assets.ppy.sh/c.jpg");
    expect(score.beatmapset.covers.list).toBe("https://assets.ppy.sh/l.jpg");
  });

  it("leaves what an unofficial chart never had absent, not zero", () => {
    const score = companellaRowToOsuScore(unofficialRow());
    expect(score.beatmap.cs).toBe(7);
    expect(score.beatmap.version).toBe("Custom");
    expect(score.beatmap.difficulty_rating).toBeUndefined();
    expect(score.beatmap.bpm).toBeUndefined();
    expect(score.beatmap_id).toBeUndefined();
    expect(score.beatmapset.covers).toEqual({});
    expect(score.beatmapset.title).toBe("Own Chart");
    // No map page to open.
    expect(getBeatmapUrl(score)).toBeFalsy();
  });

  it("drops a row the contract does not mark", () => {
    expect(companellaImportsToScores([importRow(), importRow({ companella: undefined })])).toHaveLength(1);
    expect(companellaImportsToScores(undefined)).toEqual([]);
  });
});

describe("osu! twins", () => {
  const imported = companellaRowToOsuScore(importRow());

  it("matches the osu! row for the same play by map, player, total and time", () => {
    expect(isCompanellaOsuTwin(imported, osuRow())).toBe(true);
    // A lazer total is compared too.
    expect(isCompanellaOsuTwin(imported, osuRow({ legacy_total_score: undefined, total_score: 987_654 }))).toBe(true);
  });

  it("tells apart plays that only look alike", () => {
    expect(isCompanellaOsuTwin(imported, osuRow({ legacy_total_score: 987_000 }))).toBe(false);
    expect(isCompanellaOsuTwin(imported, osuRow({ beatmap: { id: 101 } as OsuScore["beatmap"] }))).toBe(false);
    expect(isCompanellaOsuTwin(imported, osuRow({ user_id: 8, user: { id: 8, username: "x", avatar_url: "", country_code: "" } }))).toBe(false);
    expect(isCompanellaOsuTwin(imported, osuRow({ ended_at: "2026-09-01T10:30:00.000Z" }))).toBe(false);
    // An unofficial chart has no map to share.
    expect(isCompanellaOsuTwin(companellaRowToOsuScore(unofficialRow()), osuRow({ beatmap: { id: 0 } as OsuScore["beatmap"] }))).toBe(false);
  });

  it("drops the import once the osu! row is in the list, whichever arrived first", () => {
    const official = osuRow();
    expect(dropCompanellaOsuTwins([imported, official])).toEqual([official]);
    expect(dropCompanellaOsuTwins([official, imported])).toEqual([official]);
  });

  it("leaves imports without a twin alone", () => {
    const other = osuRow({ beatmap: { id: 101 } as OsuScore["beatmap"] });
    const unofficial = companellaRowToOsuScore(unofficialRow());
    expect(dropCompanellaOsuTwins([imported, unofficial, other])).toEqual([imported, unofficial, other]);
  });
});
