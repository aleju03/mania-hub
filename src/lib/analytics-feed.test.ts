import { describe, expect, it } from "vitest";
import {
  buildAnalyticsReplayMapIndex,
  buildAnalyticsSessions,
  describeAnalyticsEvent,
  formatAnalyticsActivityText,
  formatAnalyticsAgo,
  formatAnalyticsDuration,
  type AnalyticsRecentEventRow,
} from "./analytics-feed";

const NOW = 1_800_000_000_000;

function row(overrides: Partial<AnalyticsRecentEventRow> = {}): AnalyticsRecentEventRow {
  return {
    eventId: "e1",
    timestamp: "02:31:45 PM",
    ts: NOW,
    event: "$pageview",
    path: "/tracker",
    country: "CR",
    selectedCountry: null,
    deviceKind: "desktop",
    distinctId: "visitor-1",
    mapsTab: null,
    mapsQuery: null,
    mapsFilters: null,
    mapsSort: null,
    mapsCollection: null,
    mapsPage: null,
    mapsBeatmapId: null,
    rankingsPage: null,
    profileUsername: null,
    replayPlayer: null,
    replayScoreId: null,
    replayTitle: null,
    replayArtist: null,
    replayDifficulty: null,
    viewUrl: null,
    farmHelperUser: null,
    farmMapTitle: null,
    farmMapUser: null,
    packType: null,
    packUsername: null,
    skinsQuery: null,
    skinsKeys: null,
    skinsFilters: null,
    skinsSort: null,
    skinsPage: null,
    skinRef: null,
    skinName: null,
    skinKeymodes: null,
    skinUploadError: null,
    communitiesQuery: null,
    communitiesCountry: null,
    communitiesLanguage: null,
    communitiesTag: null,
    communitiesSort: null,
    communitiesPage: null,
    communityId: null,
    communityName: null,
    collectionsCollector: null,
    collectionsTab: null,
    collectionsTier: null,
    collectionsSort: null,
    collectionsQuery: null,
    collectionsPage: null,
    collectionsCard: null,
    collectionsCards: null,
    viewerUsername: null,
    referrer: null,
    ...overrides,
  };
}

describe("describeAnalyticsEvent", () => {
  it("reads a plain pageview as a visit", () => {
    expect(describeAnalyticsEvent(row())).toEqual({
      kind: "visit",
      verb: "visited",
      subject: "the tracker",
      detail: null,
    });
  });

  it("shows changelog clicks as their own activity", () => {
    expect(describeAnalyticsEvent(row({ event: "changelog_open", path: "/skins" }))).toEqual({
      kind: "visit",
      verb: "opened",
      subject: "the changelog",
      detail: null,
    });
  });

  it("separates opening the dan explainer from reading it", () => {
    expect(describeAnalyticsEvent(row({ event: "dan_estimates_view", path: "/dan-estimates" }))).toEqual({
      kind: "visit",
      verb: "opened",
      subject: "the dan explainer",
      detail: null,
    });
    expect(describeAnalyticsEvent(row({ event: "dan_estimates_read", path: "/dan-estimates" }))).toEqual({
      kind: "visit",
      verb: "read",
      subject: "the dan explainer",
      detail: "to the end",
    });
    expect(describeAnalyticsEvent(row({ event: "$pageview", path: "/dan-estimates" })).subject).toBe(
      "the dan explainer",
    );
  });

  it("reads the collections page as a shelf or as a tab", () => {
    expect(
      describeAnalyticsEvent(row({ path: "/packs/collections", collectionsCollector: "manolo" })),
    ).toEqual({ kind: "pack", verb: "viewed", subject: "manolo's collection", detail: null });
    expect(describeAnalyticsEvent(row({ path: "/packs/collections", collectionsTab: "Stats" }))).toEqual({
      kind: "pack",
      verb: "browsed",
      subject: "collections",
      detail: "Stats",
    });
    // Captured before the property existed: the collector is still in the URL.
    expect(
      describeAnalyticsEvent(
        row({ path: "/packs/collections", viewUrl: "https://mania-tracker.com/packs/collections?collector=jakads" }),
      ),
    ).toMatchObject({ subject: "jakads's collection" });
  });

  it("reads a move inside a shelf as the state it landed on", () => {
    expect(
      describeAnalyticsEvent(
        row({
          event: "packs_collections_shelf",
          path: "/packs/collections",
          collectionsCollector: "manolo",
          collectionsTier: "GOAT",
          collectionsSort: "newest first",
          collectionsPage: "2",
        }),
      ),
    ).toEqual({
      kind: "pack",
      verb: "filtered",
      subject: "manolo's shelf",
      detail: "GOAT · newest first · page 2",
    });
    // A search inside somebody's shelf is a search, so it buckets with them.
    expect(
      describeAnalyticsEvent(
        row({
          event: "packs_collections_shelf",
          path: "/packs/collections",
          collectionsCollector: "manolo",
          collectionsQuery: "jakads",
        }),
      ),
    ).toMatchObject({ kind: "search", subject: '"jakads"', detail: "in manolo's shelf" });
  });

  it("names a card by its player and the shelf it came off", () => {
    expect(
      describeAnalyticsEvent(
        row({
          event: "packs_collections_card",
          path: "/packs/collections",
          collectionsCard: "jakads",
          collectionsTier: "Mythic",
          collectionsCollector: "manolo",
        }),
      ),
    ).toEqual({
      kind: "pack",
      verb: "opened",
      subject: "jakads's card",
      detail: "Mythic · on manolo's shelf",
    });
  });

  it("counts the cards a showcase was saved with", () => {
    expect(
      describeAnalyticsEvent(row({ event: "packs_showcase_saved", path: "/packs/collections", collectionsCards: "1" })),
    ).toMatchObject({ subject: "1 card on their showcase" });
    expect(
      describeAnalyticsEvent(row({ event: "packs_showcase_saved", path: "/packs/collections", collectionsCards: "4" })),
    ).toMatchObject({ subject: "4 cards on their showcase" });
  });

  it("names the selected scope on country-scoped pages", () => {
    expect(describeAnalyticsEvent(row({ selectedCountry: "BR" }))).toMatchObject({
      subject: "the tracker",
      detail: "Brazil",
    });
    expect(describeAnalyticsEvent(row({ path: "/", selectedCountry: "GLOBAL" }))).toMatchObject({
      subject: "the home page",
      detail: "Global",
    });
    expect(describeAnalyticsEvent(row({ path: "/rankings", selectedCountry: "R-SEASIA", rankingsPage: "2" }))).toMatchObject({
      subject: "the rankings",
      detail: "Southeast Asia · page 2",
    });
    // Capture stores the scope cut to 8 chars; the truncated region code still
    // resolves ("R-NAMERICA" arrives as "R-NAMERI").
    expect(describeAnalyticsEvent(row({ path: "/top-plays", selectedCountry: "R-NAMERI" }))).toMatchObject({
      subject: "top plays",
      detail: "North America",
    });
    expect(describeAnalyticsEvent(row({ path: "/maps", mapsTab: "popular", selectedCountry: "CR" }))).toMatchObject({
      subject: "Maps · Widely played",
      detail: "Costa Rica",
    });
    // Pages that do not follow the scope stay clean.
    expect(describeAnalyticsEvent(row({ path: "/settings", selectedCountry: "BR" }))).toMatchObject({
      subject: "settings",
      detail: null,
    });
  });

  it("calls a typed maps query a search and keeps the facets as context", () => {
    const activity = describeAnalyticsEvent(row({
      path: "/maps",
      mapsTab: "farmed",
      mapsQuery: "camellia",
      mapsSort: "pp",
      mapsPage: "2",
    }));
    expect(activity.kind).toBe("search");
    expect(activity.verb).toBe("searched");
    expect(activity.subject).toBe('"camellia"');
    expect(activity.detail).toBe("in Maps · Most farmed · sort: pp · page 2");
  });

  it("calls a maps tab without a query browsing", () => {
    const activity = describeAnalyticsEvent(row({ path: "/maps", mapsTab: "popular" }));
    expect(activity).toMatchObject({ kind: "visit", verb: "browsed", subject: "Maps · Widely played" });
  });

  it("names the map a replay_view watched, and who played it", () => {
    const activity = describeAnalyticsEvent(row({
      event: "replay_view",
      path: "/replay",
      replayTitle: "Ghost",
      replayArtist: "Camellia",
      replayDifficulty: "4K Insane",
      replayPlayer: "cheesecake",
    }));
    expect(activity.kind).toBe("replay");
    expect(formatAnalyticsActivityText(activity)).toBe("watched Camellia - Ghost [4K Insane] · by cheesecake");
  });

  it("borrows map details from a sibling event for the bare /replay pageview", () => {
    const rows = [
      row({ path: "/replay", replayScoreId: "999" }),
      row({
        event: "replay_view",
        path: "/replay",
        replayScoreId: "999",
        replayTitle: "Ghost",
        replayArtist: "Camellia",
      }),
    ];
    const index = buildAnalyticsReplayMapIndex(rows);
    expect(describeAnalyticsEvent(rows[0], index).subject).toBe("Camellia - Ghost");
    // Without the index there is nothing to borrow, so it degrades to the id.
    expect(describeAnalyticsEvent(rows[0]).subject).toBe("replay #999");
  });

  it("describes profiles, farm help, packs and skins", () => {
    expect(describeAnalyticsEvent(row({ path: "/player/juan", profileUsername: "juan" }))).toMatchObject({
      kind: "profile",
      verb: "viewed",
      subject: "juan's profile",
    });
    expect(describeAnalyticsEvent(row({ path: "/farm-helper", farmHelperUser: "juan" }))).toMatchObject({
      kind: "farm",
      subject: "farm help for juan",
    });
    expect(describeAnalyticsEvent(row({ event: "pack_open", packType: "elite", packUsername: "juan" }))).toMatchObject({
      kind: "pack",
      verb: "opened",
      subject: "an Elite pack",
      detail: "as juan",
    });
    expect(describeAnalyticsEvent(row({ event: "pack_cut", packType: "standard", packUsername: "juan" }))).toMatchObject({
      kind: "pack",
      verb: "cut through",
      subject: "a Standard pack",
      detail: "as juan",
    });
    expect(describeAnalyticsEvent(row({ event: "skin_download", skinName: "Freedom Dive" }))).toMatchObject({
      kind: "skin",
      verb: "downloaded",
      subject: "Freedom Dive",
    });
    expect(describeAnalyticsEvent(row({ event: "skin_file_updated", skinName: "Freedom Dive", skinKeymodes: "4K/7K" }))).toMatchObject({
      kind: "skin",
      verb: "shipped a new build of",
      subject: "Freedom Dive",
      detail: "4K/7K",
    });
  });

  it("keeps the skins facets as context, on a search and on a plain browse", () => {
    expect(
      describeAnalyticsEvent(row({
        path: "/skins",
        skinsQuery: "arrow",
        skinsKeys: "7K",
        skinsFilters: "circles · lane cover",
        skinsSort: "most downloaded",
      })),
    ).toEqual({
      kind: "search",
      verb: "searched",
      subject: '"arrow"',
      detail: "in Skins · 7K · circles · lane cover · sort: most downloaded",
    });
    expect(describeAnalyticsEvent(row({ path: "/skins", skinsFilters: "lazer · their uploads" }))).toEqual({
      kind: "skin",
      verb: "browsed",
      subject: "Skins",
      detail: "lazer · their uploads",
    });
  });

  it("describes the Discord server directory", () => {
    expect(describeAnalyticsEvent(row({ path: "/communities" }))).toMatchObject({
      kind: "community",
      verb: "browsed",
      subject: "Discord servers",
      detail: null,
    });
    expect(
      describeAnalyticsEvent(row({ path: "/communities", communitiesCountry: "France", communitiesTag: "7k" })),
    ).toMatchObject({
      kind: "community",
      subject: "Discord servers",
      detail: "France · 7k",
    });
    expect(
      describeAnalyticsEvent(row({ path: "/communities", communitiesQuery: "vsrg", communitiesLanguage: "French" })),
    ).toMatchObject({
      kind: "search",
      verb: "searched",
      subject: '"vsrg"',
      detail: "in Discord servers · French",
    });
    expect(describeAnalyticsEvent(row({ path: "/communities/review" }))).toMatchObject({
      kind: "community",
      subject: "the server review queue",
    });
  });

  it("names the server a detail page or an invite click is about", () => {
    expect(
      describeAnalyticsEvent(row({ path: "/communities/abc-123", communityId: "abc-123", communityName: "7K VSRG FR" })),
    ).toMatchObject({
      kind: "community",
      verb: "opened",
      subject: "7K VSRG FR",
      detail: null,
    });
    // A shared link with nothing stashed: the uuid is context, not a title.
    expect(describeAnalyticsEvent(row({ path: "/communities/2b0f1c8e-9a1d-4f2b" }))).toMatchObject({
      kind: "community",
      subject: "a Discord server",
      detail: "#2b0f1c8e",
    });
    expect(
      describeAnalyticsEvent(row({ event: "community_join", communityId: "abc-123", communityName: "7K GLOBAL" })),
    ).toMatchObject({
      kind: "community",
      verb: "opened the invite for",
      subject: "7K GLOBAL",
    });
  });

  it("tells the submit funnel steps apart", () => {
    expect(describeAnalyticsEvent(row({ event: "community_post_start" }))).toMatchObject({
      kind: "community",
      verb: "opened",
      subject: "the post-a-server form",
    });
    expect(describeAnalyticsEvent(row({ event: "community_post_connect" }))).toMatchObject({
      kind: "community",
      subject: "Continue with Discord",
    });
    expect(describeAnalyticsEvent(row({ event: "community_post_no_servers" }))).toMatchObject({
      kind: "community",
      subject: "no servers they can post",
    });
    expect(describeAnalyticsEvent(row({ event: "community_post_details", communityName: "7K VSRG FR" }))).toMatchObject({
      kind: "community",
      verb: "started describing",
      subject: "7K VSRG FR",
    });
    expect(
      describeAnalyticsEvent(row({ event: "community_post_submitted", communityId: "abc-123", communityName: "7K GLOBAL" })),
    ).toMatchObject({
      kind: "community",
      verb: "submitted",
      subject: "7K GLOBAL",
    });
  });

  it("buckets failures as errors", () => {
    expect(describeAnalyticsEvent(row({ event: "replay_watch_crash" })).kind).toBe("error");
    expect(describeAnalyticsEvent(row({ event: "route_error", path: "/maps" }))).toMatchObject({
      kind: "error",
      subject: "a page error",
      detail: "/maps",
    });
    expect(describeAnalyticsEvent(row({ event: "skin_upload_failed", skinUploadError: "too big" }))).toMatchObject({
      kind: "error",
      detail: "too big",
    });
  });

  it("falls back to the raw path for pages it has no phrasing for", () => {
    expect(describeAnalyticsEvent(row({ path: "/something-new" }))).toMatchObject({
      verb: "visited",
      subject: "/something-new",
    });
  });
});

describe("buildAnalyticsSessions", () => {
  it("groups by visitor, keeps arrival order and measures the session", () => {
    const rows = [
      row({ distinctId: "a", ts: NOW - 10_000, path: "/maps" }),
      row({ distinctId: "b", ts: NOW - 30_000, path: "/tracker", country: null, deviceKind: "unknown" }),
      row({ distinctId: "a", ts: NOW - 120_000, path: "/", referrer: "google.com" }),
      row({ distinctId: "b", ts: NOW - 40 * 60_000, path: "/snipes", country: "DE", deviceKind: "mobile" }),
    ];
    const sessions = buildAnalyticsSessions(rows, NOW);
    expect(sessions.map((session) => session.distinctId)).toEqual(["a", "b"]);
    expect(sessions[0]).toMatchObject({ label: "V1", slot: 0, online: true, referrer: "google.com" });
    expect(sessions[0].durationMs).toBe(110_000);
    expect(sessions[0].events).toHaveLength(2);
    // Later rows backfill the fields the newest event was missing.
    expect(sessions[1]).toMatchObject({ label: "V2", country: "DE", deviceKind: "mobile", online: true });
  });

  it("marks a visitor whose last event aged out as offline", () => {
    const sessions = buildAnalyticsSessions([row({ ts: NOW - 20 * 60_000 })], NOW);
    expect(sessions[0].online).toBe(false);
  });

  it("never claims a visitor is online when the rows carry no epoch timestamp", () => {
    const sessions = buildAnalyticsSessions([row({ ts: undefined as unknown as number })], NOW);
    expect(sessions[0].online).toBe(false);
    expect(sessions[0].durationMs).toBe(0);
  });
});

describe("clock formatting", () => {
  it("ages events compactly", () => {
    expect(formatAnalyticsAgo(1_000)).toBe("now");
    expect(formatAnalyticsAgo(42_000)).toBe("42s");
    expect(formatAnalyticsAgo(7 * 60_000)).toBe("7m");
    expect(formatAnalyticsAgo(3 * 3_600_000 + 20 * 60_000)).toBe("3h 20m");
    expect(formatAnalyticsAgo(2 * 24 * 3_600_000)).toBe("2d");
    expect(formatAnalyticsAgo(-5)).toBe("now");
    // A backend too old to send epoch timestamps must not read as "just now".
    expect(formatAnalyticsAgo(Number.NaN)).toBe("—");
  });

  it("spells out session durations", () => {
    expect(formatAnalyticsDuration(0)).toBe("0s");
    expect(formatAnalyticsDuration(95_000)).toBe("1m 35s");
    expect(formatAnalyticsDuration(120_000)).toBe("2m");
    expect(formatAnalyticsDuration(3 * 3_600_000)).toBe("3h");
  });
});
