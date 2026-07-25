// Detail for /skins pageviews: what was searched, which keymode was filtered
// to, how the grid was sorted, and which skin a detail page is about - so the
// admin activity feed reads `Skins · "arrow" · 7K · most downloaded` and
// `Skin · pl0x mix` instead of a bare `/skins`.
//
// Everything comes from the URL. The route strips defaults out of the query
// string (stripSearchParams(DEFAULT_SKINS_SEARCH)), so a param being there at
// all already means the visitor moved it off its default.

const SORT_LABELS: Record<string, string> = {
  newest: "newest",
  downloads: "most downloaded",
};

const MAX_QUERY_CHARS = 80;
const MAX_NAME_CHARS = 80;

// A skin URL carries a slug, not a name ("pl0x-aleju03-mix"), and the detail
// page's own data arrives after the pageview fires. The card that starts the
// navigation stashes the real name here and the pageview reads it back - the
// same trick the maps collection tiles use.
const SKIN_NAME_KEY_PREFIX = "mania-hub-skin-name-v1:";

export function rememberSkinName(ref: string, name: string): void {
  if (!ref || !name || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${SKIN_NAME_KEY_PREFIX}${ref}`, name.slice(0, MAX_NAME_CHARS));
  } catch {
    // sessionStorage can be unavailable; the slug still identifies the skin.
  }
}

function readSkinName(ref: string): string | null {
  if (!ref || typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(`${SKIN_NAME_KEY_PREFIX}${ref}`);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

/** The slug (or raw id) out of a /skins/<ref> path. */
export function skinRefFromPath(pathname: string): string {
  if (!pathname.startsWith("/skins/")) return "";
  const raw = pathname.slice("/skins/".length).split("/")[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Pageview properties for /skins, keyed the way the admin activity feed reads
 * them back (skins_query, skins_keys, skins_sort, skins_page).
 */
export function getSkinsPageviewProperties(params: URLSearchParams): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  const query = params.get("q")?.trim();
  if (query) props.skins_query = query.slice(0, MAX_QUERY_CHARS);

  const keys = Number(params.get("k"));
  if (Number.isInteger(keys) && keys >= 1 && keys <= 10) props.skins_keys = `${keys}K`;

  const sort = params.get("sort");
  if (sort) props.skins_sort = SORT_LABELS[sort] ?? sort;

  // The route's page param is 0-based; report the page the visitor sees.
  const page = Number(params.get("page"));
  if (Number.isFinite(page) && page > 0) props.skins_page = String(Math.round(page) + 1);

  return props;
}

/** Pageview properties for /skins/<slug>. */
export function getSkinDetailPageviewProperties(pathname: string): Record<string, unknown> {
  const ref = skinRefFromPath(pathname);
  if (!ref) return {};
  const props: Record<string, unknown> = { skin_ref: ref };
  const name = readSkinName(ref);
  if (name) props.skin_name = name;
  return props;
}

/** Shared identity for the skin events (download, upload outcome). */
export function skinEventProperties(skin: {
  id: string;
  slug: string | null;
  name: string;
  keymodes: number[];
  oskSizeBytes: number | null;
}): Record<string, unknown> {
  return {
    skin_ref: skin.slug ?? skin.id,
    skin_name: skin.name.slice(0, MAX_NAME_CHARS),
    skin_keymodes: skin.keymodes.map((keys) => `${keys}K`).join("/"),
    skin_size_bytes: skin.oskSizeBytes ?? undefined,
  };
}
