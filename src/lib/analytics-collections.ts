// Detail for /packs/collections: whose shelf was opened, which tab was on
// screen, and how the visitor moved through the lists once there - so the
// admin activity feed reads `viewed manolo's collection` and `filtered
// manolo's shelf · GOAT · page 2` instead of a bare
// `/packs/collections`.
//
// The page keeps its filters in component state rather than in the URL (only
// `?collector=` and `?tab=` are search params), so everything past the
// pageview arrives as its own event and this module is what shapes both.

const MAX_QUERY_CHARS = 60;
const MAX_NAME_CHARS = 60;

// The tabs, worded the way the page's own buttons are.
const TAB_LABELS: Record<string, string> = {
  showcase: "Showcase",
  stats: "Stats",
  collectors: "Collectors",
};

// Directory sorts are named by what they put on top rather than by the label
// on the chip, so a feed line says which way the list went.
const COLLECTOR_SORT_LABELS: Record<string, string> = {
  cards: "most cards",
  copies: "most copies",
  packs: "most packs",
  goats: "most GOATs",
  eternals: "exclusive holders",
};

function trimmed(value: string | null | undefined, max: number): string | null {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
}

/** Pageview properties for /packs/collections. */
export function getCollectionsPageviewProperties(params: URLSearchParams): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const collector = trimmed(params.get("collector"), MAX_NAME_CHARS);
  if (collector) {
    // A collector in the URL overrides the tabs entirely: what is on screen is
    // that one shelf, and `tab` is only where the back link goes.
    props.collections_collector = collector;
    return props;
  }
  const tab = params.get("tab") ?? "showcase";
  props.collections_tab = TAB_LABELS[tab] ?? tab;
  return props;
}

/** Properties for a move inside somebody's shelf (search, tier, page). */
export function collectionsShelfProperties(input: {
  collector: string;
  tierLabel: string | null;
  query: string;
  /** Zero-based, as the component holds it; reported as the page shown. */
  page: number;
}): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const collector = trimmed(input.collector, MAX_NAME_CHARS);
  if (collector) props.collections_collector = collector;
  // "All" is the tier filter sitting where it started, which says nothing.
  const tier = trimmed(input.tierLabel, MAX_NAME_CHARS);
  if (tier && tier !== "All") props.collections_tier = tier;
  const query = trimmed(input.query, MAX_QUERY_CHARS);
  if (query) props.collections_query = query;
  if (input.page > 0) props.collections_page = String(Math.round(input.page) + 1);
  return props;
}

/** Properties for a move inside the collector directory. */
export function collectionsDirectoryProperties(input: {
  query: string;
  sort: string;
  page: number;
}): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const query = trimmed(input.query, MAX_QUERY_CHARS);
  if (query) props.collections_query = query;
  if (input.sort) props.collections_sort = COLLECTOR_SORT_LABELS[input.sort] ?? input.sort;
  if (input.page > 0) props.collections_page = String(Math.round(input.page) + 1);
  return props;
}

/** Properties for opening one card, on a shelf or on the showcase wall. */
export function collectionsCardProperties(input: {
  /** The card's player, which is what the card is of. */
  player: string;
  tierLabel: string | null;
  /** Whose shelf or showcase it was opened from, when that is known. */
  collector?: string | null;
}): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const player = trimmed(input.player, MAX_NAME_CHARS);
  if (player) props.collections_card = player;
  const tier = trimmed(input.tierLabel, MAX_NAME_CHARS);
  if (tier) props.collections_tier = tier;
  const collector = trimmed(input.collector, MAX_NAME_CHARS);
  if (collector) props.collections_collector = collector;
  return props;
}
