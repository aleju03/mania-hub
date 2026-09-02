import { describe, expect, it } from "vitest";
import {
  bestListRowMatchesModFilter,
  getScoreRowLayout,
  matchesBestKeyFilter,
  matchesModAcronymFilter,
  selectVisibleKeyModes,
  sortBestListRows,
  type BestListRow,
} from "./player/$username";
import { KEY_PP_LIST_LIMIT } from "../lib/profile-insights";
import type { LiveKeymodePpPlay } from "../lib/live-backend";
import type { OsuScore } from "../lib/types";

function windowRow(id: number, pp: number, endedAt: string, convert = false): BestListRow {
  return {
    kind: "score",
    score: {
      id,
      pp,
      ended_at: endedAt,
      created_at: endedAt,
      mods: [],
      beatmap: { id: 1000 + id, cs: 6, mode: "mania", convert },
    } as unknown as OsuScore,
  };
}

function trackedRow(beatmapId: number, pp: number, playedAt: string | null, mods: string[] = []): BestListRow {
  return {
    kind: "tracked",
    play: {
      beatmapId,
      keyCount: 6,
      pp,
      beatmapsetId: beatmapId,
      title: `Map ${beatmapId}`,
      artist: "Tester",
      version: "[6K] Another",
      accuracy: 0.95,
      rank: "S",
      mods,
      playedAt,
      maxCombo: null,
      hasReplay: null,
      soloScoreId: null,
      totalScore: null,
      legacyScoreId: null,
      statistics: null,
      creator: null,
      stars: null,
      bpm: null,
    } satisfies LiveKeymodePpPlay,
  };
}

describe("Best Performance rows with tracked plays", () => {
  it("ranks window and tracked plays against each other by pp", () => {
    const rows = sortBestListRows(
      [windowRow(1, 400, "2026-01-01T00:00:00Z"), trackedRow(90, 500, "2026-02-01T00:00:00Z"), windowRow(2, 300, "2026-03-01T00:00:00Z")],
      "pp-desc",
    );

    expect(rows.map((row) => (row.kind === "score" ? `w${row.score.id}` : `t${row.play.beatmapId}`)))
      .toEqual(["t90", "w1", "w2"]);
  });

  it("sorts both kinds on one timeline when sorting by age", () => {
    const rows = sortBestListRows(
      [windowRow(1, 400, "2026-01-01T00:00:00Z"), trackedRow(90, 100, "2026-05-01T00:00:00Z")],
      "newest",
    );

    expect(rows[0].kind).toBe("tracked");
  });

  it("keeps a tracked play with no played-at date last rather than dropping it", () => {
    const rows = sortBestListRows([trackedRow(90, 100, null), windowRow(1, 400, "2026-01-01T00:00:00Z")], "newest");

    expect(rows.map((row) => row.kind)).toEqual(["score", "tracked"]);
  });

  it("filters tracked plays on their acronyms the way scores filter on their mods", () => {
    expect(matchesModAcronymFilter(["DT"], { DT: "include" })).toBe(true);
    expect(matchesModAcronymFilter([], { DT: "include" })).toBe(false);
    expect(matchesModAcronymFilter(["DT"], { DT: "exclude" })).toBe(false);
    expect(matchesModAcronymFilter([], {})).toBe(true);
  });

  it("filters either kind of row through one mod filter", () => {
    expect(bestListRowMatchesModFilter(trackedRow(90, 100, null, ["DT"]), { DT: "include" })).toBe(true);
    expect(bestListRowMatchesModFilter(trackedRow(91, 100, null), { DT: "include" })).toBe(false);
    expect(bestListRowMatchesModFilter(windowRow(1, 400, "2026-01-01T00:00:00Z"), { DT: "include" })).toBe(false);
  });

  it("cuts a merged keymode list at the same 200 the keymode total is built from", () => {
    // 150 window plays plus 150 tracked ones: the list the Best tab ranks has
    // to be the same 200 the Key Split modal's pp and count describe.
    const rows: BestListRow[] = [
      ...Array.from({ length: 150 }, (_, index) => windowRow(index + 1, 1000 - index, "2026-01-01T00:00:00Z")),
      ...Array.from({ length: 150 }, (_, index) => trackedRow(500 + index, 850 - index, "2026-02-01T00:00:00Z")),
    ];

    const ranked = sortBestListRows(rows, "pp-desc").slice(0, KEY_PP_LIST_LIMIT);

    expect(ranked).toHaveLength(200);
    expect(ranked.at(-1)).toMatchObject({ kind: "tracked" });
  });

  it("leaves converts out of a keymode's list, the way its total leaves them out", () => {
    const native = windowRow(1, 400, "2026-01-01T00:00:00Z");
    const convert = windowRow(2, 900, "2026-01-01T00:00:00Z", true);

    expect(matchesBestKeyFilter(native.kind === "score" ? native.score : ({} as never), "6k")).toBe(true);
    // High enough pp to displace a counted play, and the total never counted it.
    expect(matchesBestKeyFilter(convert.kind === "score" ? convert.score : ({} as never), "6k")).toBe(false);
    // Under "All" it is a play osu! does rank, so it stays.
    expect(matchesBestKeyFilter(convert.kind === "score" ? convert.score : ({} as never), "all")).toBe(true);
  });

  it("reads the row layout off tracked rows too, so an all-tracked list keeps its pp and mods", () => {
    const layout = getScoreRowLayout([trackedRow(90, 400, "2026-01-01T00:00:00Z", ["DT", "MR"])]);

    // Reading it off the window scores alone gave a tracked-only keymode list
    // modColumns: 0 and showPp: false, which dropped the mods and the
    // feature's own number on desktop.
    expect(layout.modColumns).toBe(2);
    expect(layout.showPp).toBe(true);
    // No stored replay id, so no button and no reserved slot for one.
    expect(layout.showReplay).toBe(false);
  });
});

describe("selectVisibleKeyModes", () => {
  const counts = { "4k": 180, "5k": 6, "6k": 88, "7k": 200, "8k": 3, "9k": 2, "10k": 40, "16k": 0, "18k": 0 };
  const all = ["4k", "5k", "6k", "7k", "8k", "9k", "10k", "16k", "18k"];

  it("leaves a short strip alone", () => {
    expect(selectVisibleKeyModes(["4k", "7k"], "all", counts, 5)).toEqual(["4k", "7k"]);
  });

  it("keeps the keymodes with the most plays, still in numeric order", () => {
    // 7K, 4K, 6K, 10K, 5K by volume; drawn low to high the way the strip reads.
    expect(selectVisibleKeyModes(all, "all", counts, 5)).toEqual(["4k", "5k", "6k", "7k", "10k"]);
  });

  it("keeps the active keymode inline even when it was picked from the overflow", () => {
    // Otherwise picking 18K hides the one chip that says 18K is on.
    expect(selectVisibleKeyModes(all, "18k", counts, 5)).toEqual(["4k", "5k", "6k", "7k", "10k", "18k"]);
  });

  it("falls back to numeric order when no keymode has a count yet", () => {
    expect(selectVisibleKeyModes(all, "all", {}, 3)).toEqual(["4k", "5k", "6k"]);
  });
});
