import { fetchLiveMapSearch, type LiveMapSearchParams } from "./live-backend";
import { SKIN_PREVIEW_BACKGROUND_SETS } from "./skin-preview-render";

// The pool of map covers offered as the backdrop behind rendered skin
// previews. It used to be exactly the fourteen hand-picked sets baked into
// public/images/skin-preview-backdrops, so every skin ever published shared
// the same handful of covers. The pool is now drawn live from the map catalog
// (a random page of the most-played ranked and loved charts), which makes each
// upload session - and each shuffle inside one - a different set of covers.
// The baked list stays as the offline fallback for when the catalog is
// unreachable, and its covers still load from the static copies.

export interface SkinBackdropCandidate {
  setId: number;
  // "Artist - Title" for the thumbnail tooltip. Empty for the baked fallback
  // ids, which carry no catalog metadata.
  label: string;
}

// A beatmapset cover, or the accent-tinted triangle backdrop the renderer
// falls back to.
export type PreviewBackdrop = number | "flat";

// Whether picking a backdrop retargets every keymode preview or only the one
// on screen.
export type BackdropScope = "all" | "keymode";

// Keymodes share one backdrop until a pick is scoped to a single one; the
// overrides map holds those exceptions, keyed by key count.
export interface BackdropSelection {
  shared: PreviewBackdrop;
  overrides: Map<number, PreviewBackdrop>;
}

export function backdropForKeymode(selection: BackdropSelection, keys: number): PreviewBackdrop {
  return selection.overrides.get(keys) ?? selection.shared;
}

// Resolves a click in the picker against the current selection.
//
// Scope "all" is the way back to one shared backdrop, so it drops the
// overrides as well as moving the shared pick; scope "keymode" touches only
// the keymode on screen, and choosing the shared backdrop there clears that
// keymode's override instead of recording one that matches everyone else.
export function applyBackdropPick(
  selection: BackdropSelection,
  input: { scope: BackdropScope; keymode: number; choice: PreviewBackdrop },
): BackdropSelection {
  if (input.scope === "all") return { shared: input.choice, overrides: new Map() };
  const overrides = new Map(selection.overrides);
  if (input.choice === selection.shared) overrides.delete(input.keymode);
  else overrides.set(input.keymode, input.choice);
  return { shared: selection.shared, overrides };
}

// A cover whose art turned out to be missing: everything pointing at it moves
// to the replacement, everything else is left alone.
export function replaceBackdrop(
  selection: BackdropSelection,
  dead: number,
  replacement: PreviewBackdrop,
): BackdropSelection {
  const overrides = new Map(selection.overrides);
  for (const [keys, choice] of overrides) {
    if (choice === dead) overrides.set(keys, replacement);
  }
  return { shared: selection.shared === dead ? replacement : selection.shared, overrides };
}

// How many thumbnails the picker offers per draw.
export const SKIN_BACKDROP_POOL_SIZE = 12;

// A draw that lands fewer than this many usable covers is treated as a failed
// draw and falls back to the baked list.
const MIN_POOL_SIZE = 4;

const CATALOG_PAGE_SIZE = 48;
// Pages are playcount-descending, so page N holds sets ranked N*48 and down;
// 40 pages is roughly the 2000 most-played sets - deep enough that draws stay
// varied, shallow enough that the covers are charts people recognise.
const CATALOG_MAX_PAGE = 40;

const CATALOG_QUERY: LiveMapSearchParams = {
  q: "",
  keys: [],
  keysExclude: [],
  // Ranked and loved only: those covers are curated art, unlike a lot of the
  // graveyard.
  statuses: ["ranked", "loved"],
  statusesExclude: [],
  patterns: [],
  patternsExclude: [],
  starMin: null,
  starMax: null,
  bpmMin: null,
  bpmMax: null,
  lenMin: null,
  lenMax: null,
  danMin: null,
  danMax: null,
  country: null,
  sort: "playcount",
  dir: "desc",
  page: 0,
  pageSize: CATALOG_PAGE_SIZE,
};

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out;
}

// Excluding the previous draw is what stops a shuffle from handing back the
// covers already on screen; if that leaves too little to draw from, the
// exclusion is dropped rather than the pool shrinking.
function fallbackPool(count: number, exclude: Set<number>): SkinBackdropCandidate[] {
  const fresh = SKIN_PREVIEW_BACKGROUND_SETS.filter((setId) => !exclude.has(setId));
  const pool = fresh.length >= MIN_POOL_SIZE ? fresh : SKIN_PREVIEW_BACKGROUND_SETS;
  return shuffle(pool)
    .slice(0, count)
    .map((setId) => ({ setId, label: "" }));
}

// Hands out covers one at a time without repeating until the pool runs dry:
// picking at random per skin means a run of seventeen lands on nine or ten
// distinct covers, with a few showing up three times. Dealing from a shuffled
// deck gives every skin its own until there are more skins than covers.
export class BackdropDealer {
  private deck: SkinBackdropCandidate[] = [];

  constructor(private readonly pool: readonly SkinBackdropCandidate[]) {}

  next(): SkinBackdropCandidate | null {
    if (this.pool.length === 0) return null;
    // Reshuffled on each pass, so a queue longer than the pool does not repeat
    // the same order twice.
    if (this.deck.length === 0) this.deck = shuffle(this.pool);
    return this.deck.pop() ?? null;
  }
}

export async function drawSkinPreviewBackdrops(
  options: { count?: number; exclude?: Iterable<number> } = {},
): Promise<SkinBackdropCandidate[]> {
  const count = Math.max(1, options.count ?? SKIN_BACKDROP_POOL_SIZE);
  const exclude = new Set(options.exclude ?? []);
  try {
    const page = Math.floor(Math.random() * (CATALOG_MAX_PAGE + 1));
    const result = await fetchLiveMapSearch({ ...CATALOG_QUERY, page });
    const seen = new Set<number>();
    const drawn: SkinBackdropCandidate[] = [];
    for (const entry of shuffle(result?.items ?? [])) {
      const setId = entry?.beatmapsetId;
      if (typeof setId !== "number" || !Number.isFinite(setId) || setId <= 0) continue;
      if (exclude.has(setId) || seen.has(setId)) continue;
      seen.add(setId);
      drawn.push({ setId, label: `${entry.artist ?? ""} - ${entry.title ?? ""}`.trim() });
      if (drawn.length >= count) break;
    }
    if (drawn.length >= MIN_POOL_SIZE) return drawn;
  } catch {
    // Catalog unreachable (or no live backend configured): baked covers it is.
  }
  return fallbackPool(count, exclude);
}
