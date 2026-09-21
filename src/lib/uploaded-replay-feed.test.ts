import { describe, expect, it } from "vitest";
import { normalizeCommunityUploadsQuery, queryCommunityUploads } from "./uploaded-replay-feed";
import type { CommunityUploadEntry } from "./uploaded-replay-payload";

function upload(id: number, extra: Partial<CommunityUploadEntry> = {}): CommunityUploadEntry {
  return {
    id: `replay_${String(id).padStart(10, "0")}`, playerName: "player", mods: [], totalScore: 1, maxCombo: 1,
    keyCount: 4, accuracy: .98, grade: "S", judgements: { max: 1, count300: 0, count200: 0, count100: 0, count50: 0, miss: 0 },
    scoreId: null, originalFilename: null, beatmap: null, uploadedAt: id, uploadedBy: null, communityBackground: false, ...extra,
  };
}
const query = normalizeCommunityUploadsQuery();

describe("community replay browsing", () => {
  it("searches the whole catalog, including uploader, artist, difficulty, and mods", () => {
    const target = upload(1, { playerName: "ReY", uploadedBy: { userId: 7, username: "Alice" }, mods: ["DT"],
      beatmap: { beatmapId: 1, beatmapsetId: 1, title: "Mare Aeterna", artist: "Camellia", version: "Extra", creator: "Bob", starRating: 5, mode: "mania" } });
    const entries = [...Array.from({ length: 80 }, (_, i) => upload(i + 2)), target];
    for (const q of ["mare", "ＣＡＭＥＬＬＩＡ", "extra alice", "rey dt", "bob"]) {
      expect(queryCommunityUploads(entries, { ...query, q }).uploads.map((entry) => entry.id)).toEqual([target.id]);
    }
  });

  it("filters keys", () => {
    const entries = [upload(1), upload(2, { keyCount: 7, accuracy: 1 }), upload(3, { keyCount: 6 }), upload(4)];
    expect(queryCommunityUploads(entries, { ...query, keys: "7" }).uploads.map((e) => e.id)).toEqual([entries[1].id]);
    expect(queryCommunityUploads(entries, { ...query, keys: "other" }).uploads.map((e) => e.id)).toEqual([entries[2].id]);
  });

  it("filters grades by letter, silver ranks included", () => {
    const entries = [upload(1, { grade: "X" }), upload(2, { grade: "SH" }), upload(3, { grade: "A" }), upload(4, { grade: "C" })];
    expect(queryCommunityUploads(entries, { ...query, grade: "SS" }).uploads.map((e) => e.id)).toEqual([entries[0].id]);
    expect(queryCommunityUploads(entries, { ...query, grade: "S" }).uploads.map((e) => e.id)).toEqual([entries[1].id]);
    expect(queryCommunityUploads(entries, { ...query, grade: "A" }).uploads.map((e) => e.id)).toEqual([entries[2].id]);
    expect(queryCommunityUploads(entries, { ...query, grade: "B" }).uploads).toHaveLength(0);
    expect(queryCommunityUploads(entries, query).uploads).toHaveLength(4);
  });

  it("filters a star range on either end and drops uploads with no rating", () => {
    const entries = [upload(1), upload(2, { beatmap: { starRating: 4 } as never }), upload(3, { beatmap: { starRating: 8 } as never })];
    expect(queryCommunityUploads(entries, { ...query, starMin: 5, starMax: 0 }).uploads.map((e) => e.id)).toEqual([entries[2].id]);
    expect(queryCommunityUploads(entries, { ...query, starMin: 0, starMax: 5 }).uploads.map((e) => e.id)).toEqual([entries[1].id]);
    expect(queryCommunityUploads(entries, { ...query, starMin: 3, starMax: 9 }).uploads.map((e) => e.id)).toEqual([entries[2].id, entries[1].id]);
    expect(queryCommunityUploads(entries, query).uploads).toHaveLength(3);
  });

  it.each(["newest", "oldest"] as const)("keeps %s pagination stable across insertions and deletion of the boundary", (sort) => {
    const entries = Array.from({ length: 50 }, (_, i) => upload(i + 1, { accuracy: (i + 1) / 50 }));
    const ordered = queryCommunityUploads(entries, { ...query, sort }, false, 100).uploads;
    const first = queryCommunityUploads(entries, { ...query, sort });
    const boundary = first.uploads.at(-1)!;
    const changed = entries.filter((entry) => entry.id !== boundary.id);
    changed.push(upload(99, { accuracy: 1.01, uploadedAt: sort === "oldest" ? -1 : 99 }));
    const second = queryCommunityUploads(changed, { ...query, sort, cursor: first.nextCursor! });
    expect(second.uploads.map((entry) => entry.id)).toEqual(ordered.slice(24, 48).map((entry) => entry.id));
  });

  it("normalizes untrusted controls and ignores malformed cursors", () => {
    expect(normalizeCommunityUploadsQuery({ q: " a ", keys: "0", grade: "F", starMin: "x", starMax: 99, sort: "sql", cursor: {} }))
      .toEqual({ q: "a", keys: "all", grade: "all", starMin: 0, starMax: 15, sort: "newest" });
    expect(queryCommunityUploads([upload(1)], { ...query, cursor: "broken" }).uploads).toHaveLength(1);
    expect(queryCommunityUploads([], query, true)).toMatchObject({ uploads: [], total: 0, nextCursor: null, indexing: true });
  });
});
