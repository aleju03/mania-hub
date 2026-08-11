import { getCountryName, GLOBAL_SCOPE_CODE, isGlobalScope } from "#/lib/country";
import { HONORARY_PACK_POOL, type HonoraryPlayer } from "#/lib/honorary-players";

/* The card-album model: every tracked country gets its own album holding
   the country's entire tracked roster, nine slots a page; the Global album
   caps at the world top 100. Rosters load in rankings-API-sized chunks as
   the reader flips toward them. */

export const ALBUM_SLOTS_PER_PAGE = 9;
export const GLOBAL_ALBUM_CAP = 100;
/* The rankings snapshot endpoints cap pageSize at 50. */
export const ROSTER_CHUNK_SIZE = 50;

/* The GOATs album: a synthetic scope like GLOBAL, shelved as its own album
   because the honorary roster is not a country's ranking. Its roster is the
   checked-in list rather than a rankings snapshot, so it needs no chunk
   fetching at all, and it holds only the members a pack can actually deal - a
   slot nothing can ever fill is a dead end, not a mystery. */
export const GOAT_ALBUM_CODE = "GOAT";
export const GOAT_ALBUM_ROSTER: readonly HonoraryPlayer[] = HONORARY_PACK_POOL;

export function isGoatAlbum(code?: string | null): boolean {
  return code?.trim().toUpperCase() === GOAT_ALBUM_CODE;
}

/* The albums that are not a country. They head the shelf in either order. */
export function isPinnedAlbum(code: string): boolean {
  return isGlobalScope(code) || isGoatAlbum(code);
}

export interface AlbumSection {
  code: string;
  name: string;
}

export function buildAlbumSections(trackedCountries: readonly string[]): AlbumSection[] {
  const codes = [...new Set(trackedCountries.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  const countries = codes
    .map((code) => ({ code, name: getCountryName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    { code: GLOBAL_SCOPE_CODE, name: "Global" },
    { code: GOAT_ALBUM_CODE, name: "GOATs" },
    ...countries,
  ];
}

/* The optional "most cards" shelf order: the pinned albums stay up front,
   albums holding cards follow (biggest collection first, name breaking ties),
   and the empty countries keep their alphabetical order behind them. The
   default order is the alphabetical one buildAlbumSections returns. */
export function orderShelfSections(
  sections: readonly AlbumSection[],
  countByCode: ReadonlyMap<string, number>,
): AlbumSection[] {
  const owned: AlbumSection[] = [];
  const empty: AlbumSection[] = [];
  for (const section of sections) {
    if (isPinnedAlbum(section.code)) continue;
    ((countByCode.get(section.code) ?? 0) > 0 ? owned : empty).push(section);
  }
  owned.sort(
    (a, b) =>
      (countByCode.get(b.code) ?? 0) - (countByCode.get(a.code) ?? 0) ||
      a.name.localeCompare(b.name),
  );
  return [...sections.filter((section) => isPinnedAlbum(section.code)), ...owned, ...empty];
}

export function albumRosterLimit(code: string, total: number): number {
  const capped = isGlobalScope(code) ? Math.min(total, GLOBAL_ALBUM_CAP) : total;
  return Math.max(0, capped);
}

/* Slot pages come in pairs so every spread has two faces; tiny rosters
   still get one full spread. */
export function slotPagesForRoster(rosterSize: number): number {
  const pages = Math.max(2, Math.ceil(rosterSize / ALBUM_SLOTS_PER_PAGE));
  return pages % 2 === 0 ? pages : pages + 1;
}

/* Page indices as PageFlip counts them: 0 is the front cover, slot pages
   run 1..slotPages, and the last page is the back cover. */
export function albumPageCount(slotPages: number): number {
  return slotPages + 2;
}

export function slotOffsetForPage(pageIndex: number): number {
  return (pageIndex - 1) * ALBUM_SLOTS_PER_PAGE;
}

/* Which API page (1-based) holds a given slot index. */
export function chunkForSlot(slotIndex: number): number {
  return Math.floor(slotIndex / ROSTER_CHUNK_SIZE) + 1;
}
