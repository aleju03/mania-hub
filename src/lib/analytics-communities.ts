// Detail for the /communities pageviews: what the directory was filtered to,
// and which server a detail page is about - so the admin activity feed reads
// `Discord servers · France · 7k` and `Server · 7K VSRG FR` instead of a bare
// path and a uuid.
//
// The list side comes entirely from the URL. The route strips defaults out of
// the query string (stripSearchParams(DEFAULT_COMMUNITIES_SEARCH)), so a param
// being there at all already means the visitor moved it off its default.
import { getCountryName } from "./country";
import { COMMUNITY_INTERNATIONAL, communityLanguageLabel } from "./communities-shared";

const SORT_LABELS: Record<string, string> = {
  members: "biggest",
  newest: "newest",
  name: "by name",
};

const MAX_QUERY_CHARS = 80;
const MAX_NAME_CHARS = 80;

// A listing's id is a uuid and the detail page's own data arrives after the
// pageview fires, so a card hands the real name forward the way the skin cards
// do. Without it the feed can only say that some server was opened.
const COMMUNITY_NAME_KEY_PREFIX = "mania-hub-community-name-v1:";

export function rememberCommunityName(id: string, name: string): void {
  if (!id || !name || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(`${COMMUNITY_NAME_KEY_PREFIX}${id}`, name.slice(0, MAX_NAME_CHARS));
  } catch {
    // sessionStorage can be unavailable; the id still identifies the listing.
  }
}

function readCommunityName(id: string): string | null {
  if (!id || typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(`${COMMUNITY_NAME_KEY_PREFIX}${id}`);
    return stored && stored.trim() ? stored : null;
  } catch {
    return null;
  }
}

/* The id out of a /communities/<id> path. The review queue lives at
   /communities/review, which is a page and not a listing. */
export function communityIdFromPath(pathname: string): string {
  if (!pathname.startsWith("/communities/")) return "";
  const raw = pathname.slice("/communities/".length).split("/")[0] ?? "";
  if (raw === "review") return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Pageview properties for /communities, keyed the way the admin activity feed
 * reads them back (communities_query, communities_country, ...).
 */
export function getCommunitiesPageviewProperties(params: URLSearchParams): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  const query = params.get("q")?.trim();
  if (query) props.communities_query = query.slice(0, MAX_QUERY_CHARS);

  // Both filters are named rather than coded, because the feed line is read by
  // a person and "FR" beside "french" reads as two of the same thing.
  const country = params.get("country")?.trim().toUpperCase();
  if (country) {
    props.communities_country = country === COMMUNITY_INTERNATIONAL ? "international" : getCountryName(country);
  }

  const language = params.get("lang")?.trim().toLowerCase();
  if (language) props.communities_language = communityLanguageLabel(language);

  const tag = params.get("tag")?.trim();
  if (tag) props.communities_tag = tag.slice(0, MAX_QUERY_CHARS);

  const sort = params.get("sort");
  if (sort) props.communities_sort = SORT_LABELS[sort] ?? sort;

  // The route's page param is 0-based; report the page the visitor sees.
  const page = Number(params.get("page"));
  if (Number.isFinite(page) && page > 0) props.communities_page = String(Math.round(page) + 1);

  return props;
}

/** Pageview properties for /communities/<id>. */
export function getCommunityDetailPageviewProperties(pathname: string): Record<string, unknown> {
  const id = communityIdFromPath(pathname);
  if (!id) return {};
  const props: Record<string, unknown> = { community_id: id };
  const name = readCommunityName(id);
  if (name) props.community_name = name;
  return props;
}

/** Shared identity for the community events (so far: the invite click). */
export function communityEventProperties(community: {
  id: string;
  name: string;
  countryCode: string | null;
}): Record<string, unknown> {
  return {
    community_id: community.id,
    community_name: community.name.slice(0, MAX_NAME_CHARS),
    community_country: community.countryCode
      ? community.countryCode === COMMUNITY_INTERNATIONAL
        ? "international"
        : getCountryName(community.countryCode)
      : undefined,
  };
}
