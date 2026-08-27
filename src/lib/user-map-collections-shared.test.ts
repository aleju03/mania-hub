import { describe, expect, it } from "vitest";
import {
  USER_COLLECTION_TAG_MAX_LENGTH,
  groupCollectionItemsBySet,
  normalizeUserCollectionTag,
  userCollectionKeyLabel,
} from "./user-map-collections-shared";

describe("normalizeUserCollectionTag", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeUserCollectionTag("  Hand   Stream ")).toBe("hand stream");
  });

  it("drops the characters the LIKE filter cannot survive", () => {
    // Quotes and commas are what the backend's `%"tag"%` match keys on; a tag
    // that could contain them would let a longer tag half-match a shorter one.
    expect(normalizeUserCollectionTag('ln, "dump"')).toBe("ln dump");
  });

  it("keeps the marks keymode and difficulty tags actually use", () => {
    expect(normalizeUserCollectionTag("4k+")).toBe("4k+");
    expect(normalizeUserCollectionTag("dan-training")).toBe("dan-training");
    expect(normalizeUserCollectionTag("c#")).toBe("c#");
  });

  it("truncates to the stored length", () => {
    expect(normalizeUserCollectionTag("a".repeat(80))).toHaveLength(USER_COLLECTION_TAG_MAX_LENGTH);
  });

  it("returns empty for a tag that was only punctuation", () => {
    expect(normalizeUserCollectionTag("!!!")).toBe("");
  });
});

describe("userCollectionKeyLabel", () => {
  it("labels a single-keymode collection", () => {
    expect(userCollectionKeyLabel(7)).toBe("7K");
  });

  it("says nothing for a collection that mixes keymodes", () => {
    expect(userCollectionKeyLabel(null)).toBeNull();
  });
});

describe("groupCollectionItemsBySet", () => {
  const entry = (beatmapId: number, beatmapsetId: number, stars: number) =>
    ({ beatmapId, beatmapsetId, stars } as unknown as Parameters<typeof groupCollectionItemsBySet>[0][number]);

  it("folds several charts of one set into a single card, easiest first", () => {
    const grouped = groupCollectionItemsBySet([entry(3, 10, 5.9), entry(1, 10, 2.5), entry(2, 10, 4.1)]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].beatmapId).toBe(1);
    expect(grouped[0].diffs?.map((diff) => diff.beatmapId)).toEqual([1, 2, 3]);
    expect(grouped[0].diffCount).toBe(3);
  });

  it("keeps the author's order by where each set first appears", () => {
    const grouped = groupCollectionItemsBySet([entry(1, 10, 3), entry(5, 20, 3), entry(2, 10, 4)]);
    expect(grouped.map((card) => card.beatmapsetId)).toEqual([10, 20]);
  });

  it("leaves a lone chart exactly as it was", () => {
    const [card] = groupCollectionItemsBySet([entry(1, 10, 3)]);
    expect(card.diffs).toBeUndefined();
    expect(card.diffCount).toBeUndefined();
  });

  it("does not merge charts that simply have no set id", () => {
    expect(groupCollectionItemsBySet([entry(1, 0, 3), entry(2, 0, 4)])).toHaveLength(2);
  });
});
