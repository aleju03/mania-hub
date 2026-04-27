import { describe, expect, it } from "vitest";
import { filterBeatmapSearchResults } from "./beatmap-search";
import type { OsuBeatmapset } from "./types";

function createBeatmapset(overrides: Partial<OsuBeatmapset>): OsuBeatmapset {
  return {
    artist: "DJ SHARPNEL",
    beatmaps: [],
    bpm: 210,
    covers: {
      "card@2x": "",
      "cover@2x": "",
      "list@2x": "",
      "slimcover@2x": "",
      card: "",
      cover: "",
      list: "",
      slimcover: "",
    },
    creator: "IcyWorld",
    favourite_count: 0,
    id: 1,
    last_updated: "2023-01-02T06:42:06Z",
    play_count: 0,
    preview_url: "",
    ranked_date: "2023-01-10T02:00:51Z",
    status: "ranked",
    submitted_date: "2022-12-01T00:00:00Z",
    title: "CYBER INDUCTANCE",
    user_id: 1,
    ...overrides,
  };
}

describe("filterBeatmapSearchResults", () => {
  it("keeps only strict phrase matches when the upstream API returns fuzzy results", () => {
    const results = filterBeatmapSearchResults([
      createBeatmapset({
        id: 2253773,
        title: "One Good Reason",
        artist: "Celldweller",
        creator: "elexire",
        beatmaps: [{ id: 1, beatmapset_id: 2253773, difficulty_rating: 4.7, mode: "mania", status: "ranked", total_length: 120, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 200, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] Rockport", url: "" }],
      }),
      createBeatmapset({
        id: 1240883,
        status: "loved",
        creator: "kasam53",
        beatmaps: [{ id: 2, beatmapset_id: 1240883, difficulty_rating: 5.6, mode: "mania", status: "loved", total_length: 130, cs: 7, drain: 8, accuracy: 8, ar: 8, bpm: 210, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[7K] AAA", url: "" }],
      }),
      createBeatmapset({
        id: 1877490,
        beatmaps: [{ id: 3, beatmapset_id: 1877490, difficulty_rating: 5.2, mode: "mania", status: "ranked", total_length: 125, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 210, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] Icy X2", url: "" }],
      }),
      createBeatmapset({
        id: 827679,
        title: "Cyber Inductance (Speed Up Ver.)",
        status: "loved",
        beatmaps: [{ id: 4, beatmapset_id: 827679, difficulty_rating: 5.4, mode: "mania", status: "loved", total_length: 120, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 230, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] NB4", url: "" }],
      }),
      createBeatmapset({
        id: 1892814,
        title: "Cyber Attack",
        artist: "Laur",
        creator: "Logan636",
        beatmaps: [{ id: 5, beatmapset_id: 1892814, difficulty_rating: 6.1, mode: "mania", status: "ranked", total_length: 125, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 220, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] Abandonment of Peace", url: "" }],
      }),
    ], "cyber inductance");

    expect(results.map((beatmapset) => beatmapset.id)).toEqual([1240883, 1877490, 827679]);
  });

  it("keeps title-prefix variants in upstream relevance order", () => {
    const results = filterBeatmapSearchResults([
      createBeatmapset({
        id: 1877490,
        beatmaps: [{ id: 3, beatmapset_id: 1877490, difficulty_rating: 5.2, mode: "mania", status: "ranked", total_length: 125, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 210, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] Icy X2", url: "" }],
      }),
      createBeatmapset({
        id: 827679,
        title: "Cyber Inductance (Speed Up Ver.)",
        status: "loved",
        beatmaps: [{ id: 1938169, beatmapset_id: 827679, difficulty_rating: 6.92, mode: "mania", status: "loved", total_length: 120, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 230, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] NB4 1.4x", url: "" }],
      }),
      createBeatmapset({
        id: 1240883,
        status: "loved",
        creator: "kasam53",
        beatmaps: [{ id: 2, beatmapset_id: 1240883, difficulty_rating: 5.6, mode: "mania", status: "loved", total_length: 130, cs: 7, drain: 8, accuracy: 8, ar: 8, bpm: 210, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[7K] AAA", url: "" }],
      }),
    ], "cyber inductance");

    expect(results.map((beatmapset) => beatmapset.id)).toEqual([1877490, 827679, 1240883]);
  });

  it("falls back to broader metadata matching when there is no strict title or version phrase hit", () => {
    const results = filterBeatmapSearchResults([
      createBeatmapset({
        id: 1877490,
        beatmaps: [{ id: 3, beatmapset_id: 1877490, difficulty_rating: 5.2, mode: "mania", status: "ranked", total_length: 125, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 210, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] Icy X2", url: "" }],
      }),
      createBeatmapset({
        id: 827679,
        title: "Cyber Inductance (Speed Up Ver.)",
        status: "loved",
        beatmaps: [{ id: 4, beatmapset_id: 827679, difficulty_rating: 5.4, mode: "mania", status: "loved", total_length: 120, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 230, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] NB4", url: "" }],
      }),
      createBeatmapset({
        id: 1939331,
        title: "Cybernetic Mastermind No.7",
        artist: "Normal1zer vs. Broken Nerdz",
        creator: "_Stan",
        beatmaps: [{ id: 6, beatmapset_id: 1939331, difficulty_rating: 6.3, mode: "mania", status: "ranked", total_length: 135, cs: 7, drain: 8, accuracy: 8, ar: 8, bpm: 215, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[7K] Supremacy", url: "" }],
      }),
    ], "sharpnel icyworld");

    expect(results.map((beatmapset) => beatmapset.id)).toEqual([1877490, 827679]);
  });

  it("matches on mania difficulty names when searching for a specific diff", () => {
    const results = filterBeatmapSearchResults([
      createBeatmapset({
        id: 827679,
        title: "Cyber Inductance (Speed Up Ver.)",
        status: "loved",
        beatmaps: [{ id: 4, beatmapset_id: 827679, difficulty_rating: 5.4, mode: "mania", status: "loved", total_length: 120, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 230, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] NB4 1.4x", url: "" }],
      }),
      createBeatmapset({
        id: 1877490,
        beatmaps: [{ id: 3, beatmapset_id: 1877490, difficulty_rating: 5.2, mode: "mania", status: "ranked", total_length: 125, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 210, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] Icy X2", url: "" }],
      }),
    ], "nb4 1.4x");

    expect(results.map((beatmapset) => beatmapset.id)).toEqual([827679]);
  });

  it("prefers mapper-owned sets over pack diffs that only mention the mapper", () => {
    const results = filterBeatmapSearchResults([
      createBeatmapset({
        id: 1362856,
        title: "suckawa's Epsilon Chordjack practice paq",
        artist: "Various Artists",
        creator: "suckawa",
        beatmaps: [{ id: 7, beatmapset_id: 1362856, difficulty_rating: 7.6, mode: "mania", status: "graveyard", total_length: 90, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 210, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] The Quick Brown Fox | Break 1.3 (beary605)", url: "" }],
      }),
      createBeatmapset({
        id: 500905,
        title: "Break",
        artist: "The Quick Brown Fox",
        creator: "beary605",
        status: "loved",
        beatmaps: [{ id: 3065262, beatmapset_id: 500905, difficulty_rating: 6.54, mode: "mania", status: "loved", total_length: 90, cs: 4, drain: 8, accuracy: 8, ar: 8, bpm: 210, convert: false, count_circles: 0, count_sliders: 0, count_spinners: 0, version: "[4K] Smash 1.1x", url: "" }],
      }),
    ], "Break beary605");

    expect(results.map((beatmapset) => beatmapset.id)).toEqual([500905, 1362856]);
  });
});
