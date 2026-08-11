import { describe, expect, it } from "vitest";
import { HONORARY_PLAYERS } from "#/lib/honorary-players";
import {
  albumPageCount,
  albumRosterLimit,
  buildAlbumSections,
  chunkForSlot,
  GOAT_ALBUM_ROSTER,
  isGoatAlbum,
  orderShelfSections,
  slotOffsetForPage,
  slotPagesForRoster,
} from "./albumModel";

describe("buildAlbumSections", () => {
  it("puts Global and the GOATs first, then countries sorted by name", () => {
    const sections = buildAlbumSections(["US", "CR", "DE"]);
    expect(sections.map((section) => section.code)).toEqual(["GLOBAL", "GOAT", "CR", "DE", "US"]);
    expect(sections[2].name).toBe("Costa Rica");
  });

  it("dedupes and normalizes codes", () => {
    const sections = buildAlbumSections(["cr", "CR", " cr ", ""]);
    expect(sections.map((section) => section.code)).toEqual(["GLOBAL", "GOAT", "CR"]);
  });
});

describe("the GOATs album", () => {
  it("holds the honorary members a pack can deal, so no slot is unfillable", () => {
    expect(GOAT_ALBUM_ROSTER.length).toBeGreaterThan(0);
    expect(GOAT_ALBUM_ROSTER.every((player) => player.cardReady)).toBe(true);
    expect(GOAT_ALBUM_ROSTER).toHaveLength(
      HONORARY_PLAYERS.filter((player) => player.cardReady).length,
    );
  });

  it("recognizes its scope however it is cased", () => {
    expect(isGoatAlbum("GOAT")).toBe(true);
    expect(isGoatAlbum(" goat ")).toBe(true);
    expect(isGoatAlbum("GLOBAL")).toBe(false);
    expect(isGoatAlbum(null)).toBe(false);
  });
});

describe("orderShelfSections", () => {
  it("shelves the pinned albums, then owned albums by count, then the empty tail alphabetically", () => {
    const sections = buildAlbumSections(["US", "CR", "DE", "JP", "AR"]);
    const counts = new Map([
      ["GLOBAL", 12],
      ["GOAT", 3],
      ["DE", 2],
      ["JP", 9],
      ["US", 2],
    ]);
    expect(orderShelfSections(sections, counts).map((section) => section.code)).toEqual([
      "GLOBAL",
      "GOAT", // pinned by its own count, never sorted into the countries
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
      "GOAT",
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
