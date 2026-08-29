/* The admin analytics feed's reading layer: turns a captured event row into a
   short sentence ("searched \"camellia\" in Maps"), groups rows into visitor
   sessions, and formats the clock bits around them. Kept free of React and of
   server imports so it stays unit-testable. */

import { getCountryName, isGlobalScope, isSupportedCountryCode } from "./country";
import { REGION_DEFS } from "./regions.generated";
import { DAN_SKILLSET_META, skillAxisMeta } from "./skill-axes";
import { DEFAULT_DAN_SKILLSET } from "./skill-leaderboards";

export type AnalyticsDeviceKind = "mobile" | "desktop" | "unknown";

export interface AnalyticsRecentEventRow {
  eventId: string | null;
  /* Display label from the backend, in the site owner's timezone. */
  timestamp: string;
  /* Epoch ms; drives ageing, ordering and session stitching. */
  ts: number;
  event: string;
  path: string;
  country: string | null;
  selectedCountry: string | null;
  deviceKind: AnalyticsDeviceKind;
  distinctId: string;
  mapsTab: string | null;
  mapsQuery: string | null;
  mapsFilters: string | null;
  mapsSort: string | null;
  mapsCollection: string | null;
  mapsPage: string | null;
  mapsBeatmapId: string | null;
  rankingsPage: string | null;
  rankingsTab: string | null;
  rankingsKeys: string | null;
  rankingsAxis: string | null;
  rankingsSide: string | null;
  rankingsSkillset: string | null;
  profileUsername: string | null;
  replayPlayer: string | null;
  replayScoreId: string | null;
  replayTitle: string | null;
  replayArtist: string | null;
  replayDifficulty: string | null;
  viewUrl: string | null;
  farmHelperUser: string | null;
  farmMapTitle: string | null;
  farmMapUser: string | null;
  packType: string | null;
  packUsername: string | null;
  skinsQuery: string | null;
  skinsKeys: string | null;
  skinsFilters: string | null;
  skinsSort: string | null;
  skinsPage: string | null;
  skinRef: string | null;
  skinName: string | null;
  skinKeymodes: string | null;
  skinUploadError: string | null;
  communitiesQuery: string | null;
  communitiesCountry: string | null;
  communitiesLanguage: string | null;
  communitiesTag: string | null;
  communitiesSort: string | null;
  communitiesPage: string | null;
  communityId: string | null;
  communityName: string | null;
  collectionsCollector: string | null;
  collectionsTab: string | null;
  collectionsTier: string | null;
  collectionsSort: string | null;
  collectionsQuery: string | null;
  collectionsPage: string | null;
  collectionsCard: string | null;
  collectionsCards: string | null;
  addScorePlayer: string | null;
  addScoreMap: string | null;
  addScoreRepeat: string | null;
  addScoreReason: string | null;
  viewerUsername: string | null;
  referrer: string | null;
}

/* One bucket per kind of thing a visitor can be doing. Drives the feed's
   colour, icon and quick filters. */
export type AnalyticsActivityKind =
  | "visit"
  | "search"
  | "replay"
  | "profile"
  | "ranking"
  | "farm"
  | "pack"
  | "skin"
  | "community"
  | "error";

export const ANALYTICS_ACTIVITY_KINDS: AnalyticsActivityKind[] = [
  "visit",
  "search",
  "replay",
  "profile",
  "ranking",
  "farm",
  "pack",
  "skin",
  "community",
  "error",
];

export interface AnalyticsActivity {
  kind: AnalyticsActivityKind;
  /* "searched", "watched", ... - the sentence's verb. */
  verb: string;
  /* The thing acted on; rendered bright. */
  subject: string;
  /* Trailing context; rendered dim. */
  detail: string | null;
}

const ANALYTICS_MAPS_TAB_LABELS: Record<string, string> = {
  search: "Search",
  collections: "Collections",
  farmed: "Most farmed",
  popular: "Widely played",
  favourites: "Community favorites",
  random: "Random picks",
};

const ANALYTICS_PACK_TYPE_LABELS: Record<string, string> = {
  standard: "Standard",
  wild: "Wild",
  "4k": "4K",
  "7k": "7K",
  elite: "Elite",
  legend: "Legend",
};

/* Pages whose content follows the selected country scope, so the feed line
   says which tracker/rankings/etc. the visitor was actually looking at. */
const COUNTRY_SCOPED_PATHS = new Set(["/tracker", "/top-plays", "/snipes"]);

const SIMPLE_PAGE_LABELS: Record<string, string> = {
  "/tracker": "the tracker",
  "/top-plays": "top plays",
  "/snipes": "snipes",
  "/packs": "card packs",
  "/settings": "settings",
  "/bbcode": "the BBCode editor",
  "/discord": "the Discord page",
  "/dan-estimates": "the dan explainer",
};

/* The country scope the visitor had selected when the event fired, as a name
   ("Brazil", "Southeast Asia", "Global"). Capture stores the scope cut to 8
   characters, so long region codes arrive truncated ("R-NAMERI"); every region
   code is still unique at 8 characters, so a prefix match recovers them. */
export function formatAnalyticsSelectedScope(scope: string | null): string | null {
  const code = scope?.trim().toUpperCase();
  if (!code) return null;
  if (isGlobalScope(code)) return "Global";
  if (code.startsWith("R-")) {
    const region = REGION_DEFS.find((def) => def.code === code) ?? REGION_DEFS.find((def) => def.code.startsWith(code));
    return region?.name ?? code;
  }
  return isSupportedCountryCode(code) ? getCountryName(code) : code;
}

export function formatAnalyticsMapsTab(tab: string | null): string {
  // No tab recorded means the default view, which is search.
  if (!tab) return ANALYTICS_MAPS_TAB_LABELS.search;
  return ANALYTICS_MAPS_TAB_LABELS[tab] ?? tab;
}

export function formatAnalyticsPackType(type: string | null): string {
  if (!type) return "pack";
  return ANALYTICS_PACK_TYPE_LABELS[type] ?? type;
}

// Pull a query param off the captured $current_url. Used as a fallback so the
// inline label (e.g. who farm help was viewed for) still resolves for events
// captured before the dedicated property existed.
export function analyticsUrlParam(url: string | null, key: string): string | null {
  if (!url) return null;
  try {
    const value = new URL(url).searchParams.get(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export interface AnalyticsReplayMapInfo {
  title: string | null;
  artist: string | null;
  difficulty: string | null;
}

export type AnalyticsReplayMapIndex = Map<string, AnalyticsReplayMapInfo>;

export function analyticsReplayScoreId(row: AnalyticsRecentEventRow): string | null {
  return row.replayScoreId || analyticsUrlParam(row.viewUrl, "scoreId");
}

// The /replay pageview fires while the score is still loading, so only the
// follow-up replay_view event knows the map. Both carry the same score id, so
// the feed borrows the map details from whichever event in view has them.
export function buildAnalyticsReplayMapIndex(rows: AnalyticsRecentEventRow[]): AnalyticsReplayMapIndex {
  const index: AnalyticsReplayMapIndex = new Map();
  for (const row of rows) {
    if (!row.replayTitle) continue;
    const scoreId = analyticsReplayScoreId(row);
    if (!scoreId || index.has(scoreId)) continue;
    index.set(scoreId, { title: row.replayTitle, artist: row.replayArtist, difficulty: row.replayDifficulty });
  }
  return index;
}

function joinDetail(parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part && part.trim()));
  return kept.length ? kept.join(" · ") : null;
}

function replayMapName(row: AnalyticsRecentEventRow, mapIndex?: AnalyticsReplayMapIndex): string | null {
  const scoreId = analyticsReplayScoreId(row);
  const borrowed = scoreId ? mapIndex?.get(scoreId) : undefined;
  const title = row.replayTitle || borrowed?.title || null;
  if (!title) return null;
  const artist = row.replayArtist || borrowed?.artist || null;
  const difficulty = row.replayDifficulty || borrowed?.difficulty || null;
  return `${artist ? `${artist} - ` : ""}${title}${difficulty ? ` [${difficulty}]` : ""}`;
}

function describeMaps(row: AnalyticsRecentEventRow): AnalyticsActivity {
  const scope = formatAnalyticsSelectedScope(row.selectedCountry);
  const where = joinDetail([
    `in Maps · ${formatAnalyticsMapsTab(row.mapsTab)}`,
    row.mapsCollection,
    row.mapsFilters,
    row.mapsSort ? `sort: ${row.mapsSort}` : null,
    row.mapsPage ? `page ${row.mapsPage}` : null,
    scope,
  ]);
  // Every keystroke lands as its own pageview, so the typed query is the story;
  // without one this is plain browsing of a tab.
  if (row.mapsQuery) {
    return { kind: "search", verb: "searched", subject: `"${row.mapsQuery}"`, detail: where };
  }
  if (row.mapsBeatmapId) {
    return { kind: "visit", verb: "opened", subject: `map #${row.mapsBeatmapId}`, detail: where };
  }
  return {
    kind: "visit",
    verb: "browsed",
    subject: `Maps · ${formatAnalyticsMapsTab(row.mapsTab)}`,
    detail: joinDetail([
      row.mapsCollection,
      row.mapsFilters,
      row.mapsSort ? `sort: ${row.mapsSort}` : null,
      row.mapsPage ? `page ${row.mapsPage}` : null,
      scope,
    ]),
  };
}

/* The dan board's two ladders, named the way its own control names them. */
const RANKINGS_SIDE_LABELS: Record<string, string> = { rc: "Regular", ln: "LN" };

/* Three boards sit behind /rankings - the pp table, the MSD skill leaderboard
   and the dan one - so the path alone cannot say which one a visitor is on.
   The tab and its facets ride in the pageview; a row captured before they were
   recorded has none of them, and keeps the old undifferentiated line. */
function describeRankings(row: AnalyticsRecentEventRow, scope: string | null): AnalyticsActivity {
  const page = row.rankingsPage ? `page ${row.rankingsPage}` : null;
  const keys = row.rankingsKeys ? `${row.rankingsKeys}K` : null;
  if (row.rankingsTab === "skills") {
    const axis = row.rankingsAxis ? skillAxisMeta(row.rankingsAxis)?.label ?? row.rankingsAxis : null;
    return {
      kind: "ranking",
      verb: "browsed",
      subject: "the MSD leaderboard",
      detail: joinDetail([keys, axis, scope, page]),
    };
  }
  if (row.rankingsTab === "dan") {
    const side = row.rankingsSide ? RANKINGS_SIDE_LABELS[row.rankingsSide] ?? row.rankingsSide : null;
    const skillset = !row.rankingsSkillset || row.rankingsSkillset === DEFAULT_DAN_SKILLSET
      ? null
      : DAN_SKILLSET_META[row.rankingsSkillset]?.label ?? row.rankingsSkillset;
    return {
      kind: "ranking",
      verb: "browsed",
      subject: "the dan leaderboard",
      detail: joinDetail([[keys, side].filter(Boolean).join(" "), skillset, scope, page]),
    };
  }
  return {
    kind: "ranking",
    verb: "browsed",
    subject: row.rankingsTab === "pp" ? "the pp rankings" : "the rankings",
    detail: joinDetail([scope, page]),
  };
}

function describeSkinsList(row: AnalyticsRecentEventRow): AnalyticsActivity {
  const facets = joinDetail([
    row.skinsKeys,
    row.skinsFilters,
    row.skinsSort ? `sort: ${row.skinsSort}` : null,
    row.skinsPage ? `page ${row.skinsPage}` : null,
  ]);
  if (row.skinsQuery) {
    return {
      kind: "search",
      verb: "searched",
      subject: `"${row.skinsQuery}"`,
      detail: joinDetail(["in Skins", facets]),
    };
  }
  return { kind: "skin", verb: "browsed", subject: "Skins", detail: facets };
}

function describeCommunitiesList(row: AnalyticsRecentEventRow): AnalyticsActivity {
  const facets = joinDetail([
    row.communitiesCountry,
    row.communitiesLanguage,
    row.communitiesTag,
    row.communitiesSort ? `sort: ${row.communitiesSort}` : null,
    row.communitiesPage ? `page ${row.communitiesPage}` : null,
  ]);
  if (row.communitiesQuery) {
    return {
      kind: "search",
      verb: "searched",
      subject: `"${row.communitiesQuery}"`,
      detail: joinDetail(["in Discord servers", facets]),
    };
  }
  return { kind: "community", verb: "browsed", subject: "Discord servers", detail: facets };
}

// A listing is identified by a uuid, so the name the card stashed is the whole
// difference between a readable line and one nobody can place. Without it the
// short id is offered as context rather than shown as a title.
function describeCommunity(row: AnalyticsRecentEventRow, verb: string, id: string | null): AnalyticsActivity {
  const shortId = id ? id.slice(0, 8) : null;
  return {
    kind: "community",
    verb,
    subject: row.communityName || "a Discord server",
    detail: row.communityName ? null : shortId ? `#${shortId}` : null,
  };
}

/* The collections page's own lines. Its lists keep their filters in component
   state rather than in the URL, so each move arrives as an event carrying the
   state it landed on; the sentence reads that back the way the page shows it
   ("filtered manolo's shelf · GOAT · newest first · page 2"). */
function collectionsFacets(row: AnalyticsRecentEventRow): string | null {
  return joinDetail([
    row.collectionsTier,
    row.collectionsSort,
    row.collectionsPage ? `page ${row.collectionsPage}` : null,
  ]);
}

function describeCollectionsShelf(row: AnalyticsRecentEventRow): AnalyticsActivity {
  const whose = row.collectionsCollector ? `${row.collectionsCollector}'s shelf` : "a shelf";
  if (row.collectionsQuery) {
    return {
      kind: "search",
      verb: "searched",
      subject: `"${row.collectionsQuery}"`,
      detail: joinDetail([`in ${whose}`, collectionsFacets(row)]),
    };
  }
  return { kind: "pack", verb: "filtered", subject: whose, detail: collectionsFacets(row) };
}

function describeCollectionsDirectory(row: AnalyticsRecentEventRow): AnalyticsActivity {
  if (row.collectionsQuery) {
    return {
      kind: "search",
      verb: "searched",
      subject: `"${row.collectionsQuery}"`,
      detail: joinDetail(["in collectors", collectionsFacets(row)]),
    };
  }
  return { kind: "pack", verb: "browsed", subject: "the collector list", detail: collectionsFacets(row) };
}

function describeCollectionsCard(row: AnalyticsRecentEventRow): AnalyticsActivity {
  return {
    kind: "pack",
    verb: "opened",
    subject: row.collectionsCard ? `${row.collectionsCard}'s card` : "a card",
    detail: joinDetail([
      row.collectionsTier,
      row.collectionsCollector ? `on ${row.collectionsCollector}'s shelf` : null,
    ]),
  };
}

/* Why a paste was turned down, in the words the feed can read at a glance.
   The keys are the backend's own failure reasons. */
const ADD_SCORE_FAILURE_LABELS: Record<string, string> = {
  invalid_link: "not a score link",
  score_not_found: "no score at that link",
  not_mania: "not a mania score",
  not_owned: "someone else's score",
  not_passed: "a fail",
  player_untracked: "country not tracked",
  player_not_found: "player can't receive scores",
  osu_unavailable: "osu! didn't answer",
  rate_limited: "rate limited",
  failed: "request failed",
};

/* What an event says about itself, before its page is consulted. Null for an
   event this file has never been taught, which the caller can either describe
   by page (the feed) or name outright (the event lookup, where describing a
   streak_run as "visited card packs" would be describing the wrong thing). */
function describeNamedAnalyticsEvent(
  row: AnalyticsRecentEventRow,
  replayMaps?: AnalyticsReplayMapIndex,
): AnalyticsActivity | null {
  switch (row.event) {
    case "changelog_open":
      return { kind: "visit", verb: "opened", subject: "the changelog", detail: null };
    /* The dan explainer fires both: the open, and the read once the end of the
       article has been on screen. A visitor who bounced has only the first. */
    case "dan_estimates_view":
      return { kind: "visit", verb: "opened", subject: "the dan explainer", detail: null };
    case "dan_estimates_read":
      return { kind: "visit", verb: "read", subject: "the dan explainer", detail: "to the end" };
    /* The two things on the page that are hidden until someone goes looking:
       the folded ScoreV2 note, and the tooltip on the one-player top of the
       4K ladder. */
    case "dan_estimates_note":
      return { kind: "visit", verb: "opened", subject: "the ScoreV2 note", detail: "on the dan explainer" };
    case "dan_estimates_saragi":
      return { kind: "visit", verb: "found", subject: "the saragi tooltip", detail: "on the dan explainer" };
    case "replay_view": {
      const map = replayMapName(row, replayMaps);
      return {
        kind: "replay",
        verb: "watched",
        subject: map ?? "a replay",
        detail: row.replayPlayer ? `by ${row.replayPlayer}` : null,
      };
    }
    case "skin_download":
      return { kind: "skin", verb: "downloaded", subject: row.skinName || row.skinRef || "a skin", detail: row.skinKeymodes };
    case "skin_upload_published":
      return { kind: "skin", verb: "published", subject: row.skinName || row.skinRef || "a skin", detail: null };
    case "skin_previews_edited":
      return { kind: "skin", verb: "edited previews on", subject: row.skinName || row.skinRef || "a skin", detail: null };
    case "skin_file_updated":
      return { kind: "skin", verb: "shipped a new build of", subject: row.skinName || row.skinRef || "a skin", detail: row.skinKeymodes };
    // The invite is a link out, so this is the click and not a confirmed join:
    // what happens on Discord's side is not ours to see.
    case "community_join":
      return describeCommunity(row, "opened the invite for", row.communityId);
    // The submit funnel, in the order the modal walks it: the consent screen,
    // the picker (or its no-postable-servers dead end), the details form, and
    // the submit. Which of these a visitor stops at is the point of tracking
    // them, so each gets its own line rather than a shared one.
    case "community_post_start":
      return { kind: "community", verb: "opened", subject: "the post-a-server form", detail: null };
    case "community_post_connect":
      return { kind: "community", verb: "clicked", subject: "Continue with Discord", detail: null };
    case "community_post_pick":
      return { kind: "community", verb: "reached", subject: "the server picker", detail: null };
    case "community_post_no_servers":
      return { kind: "community", verb: "had", subject: "no servers they can post", detail: null };
    case "community_post_details":
      return { kind: "community", verb: "started describing", subject: row.communityName || "a server", detail: null };
    case "community_post_submitted":
      return describeCommunity(row, "submitted", row.communityId);
    // The collections page: three tabs, anyone's shelf, and the cards on both.
    case "packs_collections_stats":
      return { kind: "pack", verb: "read", subject: "the pack stats", detail: null };
    case "packs_collections_shelf":
      return describeCollectionsShelf(row);
    case "packs_collections_directory":
      return describeCollectionsDirectory(row);
    case "packs_collections_wall":
      return {
        kind: "pack",
        verb: "browsed",
        subject: "the showcase wall",
        detail: row.collectionsPage ? `page ${row.collectionsPage}` : null,
      };
    case "packs_collections_card":
      return describeCollectionsCard(row);
    /* Adding a missing score to a profile: the bar being opened, whatever a
       paste resolved to, and the ones the backend turned down. The turn-downs
       are the reason the reason is carried - a run of "someone else's score"
       is people misreading the bar, a run of "country not tracked" is not. */
    case "add_score_open":
      return {
        kind: "profile",
        verb: "opened",
        subject: "the add-a-score bar",
        detail: row.addScorePlayer ? `on ${row.addScorePlayer}'s profile` : null,
      };
    case "add_score_submitted":
      return {
        kind: "profile",
        verb: row.addScoreRepeat === "1" ? "re-sent" : "added",
        subject: row.addScoreMap || "a score",
        detail: joinDetail([
          row.addScorePlayer ? `to ${row.addScorePlayer}` : null,
          row.addScoreRepeat === "1" ? "already tracked" : null,
        ]),
      };
    case "add_score_failed":
      return {
        kind: "profile",
        verb: "could not add",
        subject: "a score",
        detail: joinDetail([
          row.addScorePlayer ? `to ${row.addScorePlayer}` : null,
          row.addScoreReason ? ADD_SCORE_FAILURE_LABELS[row.addScoreReason] ?? row.addScoreReason : null,
        ]),
      };
    case "packs_showcase_edit":
      return { kind: "pack", verb: "opened", subject: "their showcase picker", detail: null };
    case "packs_showcase_saved":
      return {
        kind: "pack",
        verb: "put up",
        subject: row.collectionsCards === "1" ? "1 card on their showcase" : `${row.collectionsCards ?? "0"} cards on their showcase`,
        detail: null,
      };
    case "skin_upload_failed":
      return { kind: "error", verb: "failed", subject: "a skin upload", detail: row.skinUploadError };
    /* A cut pack is also an open, so both lines land for the same pack: the
       open records the spend, the cut records that the blade went through the
       cards and the hand came out ruined. */
    case "pack_open":
    case "pack_cut": {
      const packType = formatAnalyticsPackType(row.packType);
      return {
        kind: "pack",
        verb: row.event === "pack_cut" ? "cut through" : "opened",
        subject: `${/^[aeiou]/i.test(packType) ? "an" : "a"} ${packType} pack`,
        detail: row.packUsername ? `as ${row.packUsername}` : "as a guest",
      };
    }
    case "replay_watch_crash":
    case "replay_renderer_error":
      return { kind: "error", verb: "crashed", subject: "the replay viewer", detail: replayMapName(row, replayMaps) };
    case "replay_load_slow":
      return { kind: "error", verb: "waited on", subject: "a slow replay load", detail: replayMapName(row, replayMaps) };
    case "replay_upload_beatmap_missing":
      return { kind: "error", verb: "uploaded", subject: "a replay with no matching map", detail: null };
    case "replay_upload_community_beatmap":
    case "replay_upload_local_beatmap":
      return { kind: "replay", verb: "uploaded", subject: "a replay of their own", detail: null };
    case "route_error":
    case "react_recoverable_error":
      return { kind: "error", verb: "hit", subject: "a page error", detail: row.path || null };
    default:
      return null;
  }
}

/* Whether the event carries its own meaning, or only the page it happened on.
   A pageview is the page it happened on, so it counts as described. */
export function analyticsEventHasOwnDescription(event: string): boolean {
  if (event === "$pageview") return true;
  return describeNamedAnalyticsEvent({ event } as AnalyticsRecentEventRow) != null;
}

/* One captured row as a sentence the admin can skim: verb, subject, context. */
export function describeAnalyticsEvent(
  row: AnalyticsRecentEventRow,
  replayMaps?: AnalyticsReplayMapIndex,
): AnalyticsActivity {
  // What the event says about itself first: it says more than the page it
  // happened on.
  const named = describeNamedAnalyticsEvent(row, replayMaps);
  if (named) return named;

  const path = row.path || "";
  const scope = formatAnalyticsSelectedScope(row.selectedCountry);
  if (!path || path === "/") return { kind: "visit", verb: "landed on", subject: "the home page", detail: scope };
  if (path === "/maps") return describeMaps(row);
  if (path === "/skins") return describeSkinsList(row);
  if (path.startsWith("/skins/")) {
    return {
      kind: "skin",
      verb: "opened",
      subject: row.skinName || row.skinRef || decodeURIComponent(path.slice("/skins/".length)) || "a skin",
      detail: row.skinKeymodes,
    };
  }
  if (path === "/packs/collections") {
    // A collector in the URL is one shelf; without one it is whichever tab the
    // visitor landed on, which is the showcase unless the URL says otherwise.
    const collector = row.collectionsCollector || analyticsUrlParam(row.viewUrl, "collector");
    if (collector) {
      return { kind: "pack", verb: "viewed", subject: `${collector}'s collection`, detail: null };
    }
    return { kind: "pack", verb: "browsed", subject: "collections", detail: row.collectionsTab };
  }
  if (path === "/communities") return describeCommunitiesList(row);
  if (path === "/communities/review") {
    return { kind: "community", verb: "opened", subject: "the server review queue", detail: null };
  }
  if (path.startsWith("/communities/")) {
    const id = row.communityId || decodeURIComponent(path.slice("/communities/".length).split("/")[0] ?? "");
    return describeCommunity(row, "opened", id || null);
  }
  if (path.startsWith("/player/")) {
    const username = row.profileUsername || decodeURIComponent(path.slice("/player/".length));
    return { kind: "profile", verb: "viewed", subject: username ? `${username}'s profile` : "a profile", detail: null };
  }
  if (path === "/replay") {
    const map = replayMapName(row, replayMaps);
    const scoreId = analyticsReplayScoreId(row);
    return {
      kind: "replay",
      verb: "opened",
      subject: map ?? (scoreId ? `replay #${scoreId.slice(-6)}` : "a replay"),
      detail: row.replayPlayer ? `by ${row.replayPlayer}` : null,
    };
  }
  if (path === "/farm-helper") {
    const user = row.farmHelperUser || analyticsUrlParam(row.viewUrl, "user");
    return {
      kind: "farm",
      verb: "checked",
      subject: user ? `farm help for ${user}` : "the farm helper",
      detail: null,
    };
  }
  if (path.startsWith("/farm-helper/map/")) {
    const beatmapId = path.slice("/farm-helper/map/".length).split("/")[0];
    return {
      kind: "farm",
      verb: "opened",
      subject: row.farmMapTitle || (beatmapId ? `farm map #${beatmapId}` : "a farm map"),
      detail: row.farmMapUser ? `for ${row.farmMapUser}` : null,
    };
  }
  if (path === "/rankings") return describeRankings(row, scope);
  if (path === "/my-stats" || path === "/my-data") {
    return { kind: "profile", verb: "opened", subject: "their own stats", detail: row.viewerUsername ? `as ${row.viewerUsername}` : null };
  }
  if (path === "/goals") {
    return { kind: "profile", verb: "opened", subject: "their goals", detail: row.viewerUsername ? `as ${row.viewerUsername}` : null };
  }
  const simple = SIMPLE_PAGE_LABELS[path];
  if (simple) {
    return { kind: "visit", verb: "visited", subject: simple, detail: COUNTRY_SCOPED_PATHS.has(path) ? scope : null };
  }
  return { kind: "visit", verb: "visited", subject: path, detail: null };
}

/* Flat text of a described event, for tooltips and the compact trail lines. */
export function formatAnalyticsActivityText(activity: AnalyticsActivity): string {
  return joinDetail([`${activity.verb} ${activity.subject}`, activity.detail]) ?? activity.subject;
}

const ADMIN_ANALYTICS_INSPECT_PARAM = "mh_admin_inspect";
const ANALYTICS_PRIMARY_HOSTS = new Set(["mania-tracker.com", "www.mania-tracker.com"]);

function isAnalyticsViewHostAllowed(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  if (typeof window !== "undefined" && host === window.location.host.toLowerCase()) return true;
  if (ANALYTICS_PRIMARY_HOSTS.has(hostname)) return true;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

// Turn the captured absolute $current_url into a same-origin link so the admin
// can open exactly what the visitor saw (e.g. /farm-helper?user=X). Admin and
// off-site URLs are dropped so we never link out of the dashboard or to nothing.
export function analyticsViewHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!isAnalyticsViewHostAllowed(parsed)) return null;
    const href = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (!href.startsWith("/") || href.startsWith("/admin")) return null;
    return href;
  } catch {
    return null;
  }
}

/* Marks a link as an admin peek so the visited page does not capture a
   pageview of its own (see isAdminAnalyticsInspection in lib/analytics.ts). */
export function analyticsInspectionHref(href: string): string {
  try {
    const parsed = new URL(href, "https://mania-tracker.local");
    const marker = `${ADMIN_ANALYTICS_INSPECT_PARAM}=1`;
    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    const hashParts = hash ? hash.split("&").filter(Boolean) : [];
    if (!hashParts.some((part) => part === ADMIN_ANALYTICS_INSPECT_PARAM || part.startsWith(`${ADMIN_ANALYTICS_INSPECT_PARAM}=`))) {
      hashParts.push(marker);
    }
    parsed.hash = hashParts.length > 0 ? `#${hashParts.join("&")}` : "";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return href;
  }
}

export function analyticsEventHref(row: AnalyticsRecentEventRow): string | null {
  const href = analyticsViewHref(row.viewUrl);
  return href ? analyticsInspectionHref(href) : null;
}

/* A visitor is "here now" while their last event is inside this window; it
   matches the backend's active-visitor definition. */
export const ANALYTICS_ONLINE_WINDOW_MS = 5 * 60_000;

export interface AnalyticsSession {
  distinctId: string;
  /* Stable index in arrival order; the UI derives a colour and a V-number. */
  slot: number;
  label: string;
  country: string | null;
  deviceKind: AnalyticsDeviceKind;
  viewerUsername: string | null;
  referrer: string | null;
  firstTs: number;
  lastTs: number;
  durationMs: number;
  online: boolean;
  events: AnalyticsRecentEventRow[];
}

/* Rows arrive newest-first, so sessions come out ordered by most recent
   activity and each trail reads top-down from latest to earliest. */
export function buildAnalyticsSessions(rows: AnalyticsRecentEventRow[], now: number): AnalyticsSession[] {
  const sessions = new Map<string, AnalyticsSession>();
  for (const row of rows) {
    const id = row.distinctId || "unknown";
    let session = sessions.get(id);
    if (!session) {
      const slot = sessions.size;
      session = {
        distinctId: id,
        slot,
        label: `V${slot + 1}`,
        country: row.country,
        deviceKind: row.deviceKind,
        viewerUsername: row.viewerUsername,
        referrer: null,
        firstTs: row.ts,
        lastTs: row.ts,
        durationMs: 0,
        online: false,
        events: [],
      };
      sessions.set(id, session);
    }
    if (!session.country && row.country) session.country = row.country;
    if (session.deviceKind === "unknown" && row.deviceKind !== "unknown") session.deviceKind = row.deviceKind;
    if (!session.viewerUsername && row.viewerUsername) session.viewerUsername = row.viewerUsername;
    // Rows run newest to oldest, so the last referrer seen is the entry one.
    if (row.referrer) session.referrer = row.referrer;
    if (Number.isFinite(row.ts)) {
      if (row.ts > session.lastTs) session.lastTs = row.ts;
      if (row.ts < session.firstTs) session.firstTs = row.ts;
    }
    session.events.push(row);
  }
  return Array.from(sessions.values()).map((session) => {
    const timed = Number.isFinite(session.firstTs) && Number.isFinite(session.lastTs);
    return {
      ...session,
      durationMs: timed ? Math.max(0, session.lastTs - session.firstTs) : 0,
      online: timed && now - session.lastTs <= ANALYTICS_ONLINE_WINDOW_MS,
    };
  });
}

/* Compact age for feed rows: "now", "42s", "7m", "3h 20m", "2d". Rows from a
   backend too old to send epoch timestamps age to "—" rather than lying. */
export function formatAnalyticsAgo(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 0) return "now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/* Session length, which reads better spelled out than aged. */
export function formatAnalyticsDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const restSeconds = seconds % 60;
    return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

const FRIENDLY_REFERRER_LABELS: Record<string, string> = {
  $direct: "Direct visit",
  "google.com": "Google Search",
  "www.google.com": "Google Search",
  "google.co.uk": "Google Search",
  "google.com.br": "Google Search",
  "duckduckgo.com": "DuckDuckGo",
  "bing.com": "Bing",
  "osu.ppy.sh": "osu! site",
  "old.reddit.com": "Reddit",
  "www.reddit.com": "Reddit",
  "reddit.com": "Reddit",
  "out.reddit.com": "Reddit link out",
  "t.co": "Twitter / X",
  "x.com": "Twitter / X",
  "twitter.com": "Twitter / X",
  "discord.com": "Discord",
  "discordapp.com": "Discord",
  "www.youtube.com": "YouTube",
  "youtube.com": "YouTube",
  "m.youtube.com": "YouTube mobile",
  "github.com": "GitHub",
};

export function formatReferrerLabel(domain: string): string {
  const friendly = FRIENDLY_REFERRER_LABELS[domain];
  if (friendly) return friendly;
  if (/-aleju03s-projects\.vercel\.app$/.test(domain)) {
    return `${domain.replace(/^maniacr-tracker-/, "")} preview`;
  }
  if (domain.endsWith(".vercel.app")) return `${domain} vercel`;
  return domain.replace(/^www\./, "");
}
