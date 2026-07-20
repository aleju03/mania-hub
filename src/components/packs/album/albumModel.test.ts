import { describe, expect, it } from "vitest";
import {
  albumPageCount,
  albumRosterLimit,
  buildAlbumSections,
  chunkForSlot,
  orderShelfSections,
  slotOffsetForPage,
  slotPagesForRoster,
} from "./albumModel";

describe("buildAlbumSections", () => {
  it("puts Global first, then countries sorted by name", () => {
    const sections = buildAlbumSections(["US", "CR", "DE"]);
    expect(sections.map((section) => section.code)).toEqual(["GLOBAL", "CR", "DE", "US"]);
    expect(sections[1].name).toBe("Costa Rica");
  });

  it("dedupes and normalizes codes", () => {
    const sections = buildAlbumSections(["cr", "CR", " cr ", ""]);
    expect(sections.map((section) => section.code)).toEqual(["GLOBAL", "CR"]);
  });
});

describe("orderShelfSections", () => {
  it("shelves Global, then owned albums by count, then the empty tail alphabetically", () => {
    const sections = buildAlbumSections(["US", "CR", "DE", "JP", "AR"]);
    const counts = new Map([
      ["GLOBAL", 12],
      ["DE", 2],
      ["JP", 9],
      ["US", 2],
    ]);
    expect(orderShelfSections(sections, counts).map((section) => section.code)).toEqual([
      "GLOBAL",
      "JP", // 9 cards
      "DE", // 2 cards, Germany before United States
      "US", // 2 cards
      "AR", // empty tail, alphabetical
      "CR",
    ]);
  });

  it("keeps the alphabetical shelf when nothing is owned", () => {
    const sections = buildAlbumSections(["US", "CR"]);
    expect(orderShelfSections(sections, new Map()).map((section) => section.code)).toEqual([
      "GLOBAL",
      "CR",
      "US",
    ]);
  });
});

describe("albumRosterLimit", () => {
  it("caps the Global album at 100 and leaves countries whole", () => {
    expect(albumRosterLimit("GLOBAL", 8129)).toBe(100);
    expect(albumRosterLimit("GLOBAL", 40)).toBe(40);
    expect(albumRosterLimit("CR", 638)).toBe(638);
  });
});

describe("page layout", () => {
  it("splits the roster into paired slot pages", () => {
    expect(slotPagesForRoster(100)).toBe(12); // 11 full pages + 1 partial, padded even
    expect(slotPagesForRoster(18)).toBe(2);
    expect(slotPagesForRoster(19)).toBe(4); // 3 pages padded to 4
    expect(slotPagesForRoster(0)).toBe(2);
    expect(albumPageCount(12)).toBe(14);
  });

  it("maps pages and slots to roster indices and API chunks", () => {
    expect(slotOffsetForPage(1)).toBe(0);
    expect(slotOffsetForPage(2)).toBe(9);
    expect(slotOffsetForPage(12)).toBe(99);
    expect(chunkForSlot(0)).toBe(1);
    expect(chunkForSlot(49)).toBe(1);
    expect(chunkForSlot(50)).toBe(2);
    expect(chunkForSlot(99)).toBe(2);
  });
});
