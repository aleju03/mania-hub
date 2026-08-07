// Plain-English names for the osu! API pressure panel on /admin/live-backend.
//
// Every osu! call is logged with a `caller` tag (the job that made it, the
// backend endpoint serving a page, or the server function behind a click) and
// the raw path it hit. Both are internal strings: `job:refresh_user_top_scores`
// and `/users/22217613/scores/best?mode=mania&limit=100&offset=0` say nothing
// about which page or which action is spending the budget. This turns them into
// a title, a sentence about what triggers the call, and an origin bucket, so
// "why is the rate above target right now" is answerable without a code read.
//
// Unknown tags degrade to a prettified version of the raw string instead of
// disappearing: a caller added tomorrow still shows up in the panel, just with a
// rougher label.

export type OsuCallOrigin = "page" | "job" | "ingest" | "admin" | "other";

export type OsuCallOriginInfo = {
  id: OsuCallOrigin;
  label: string;
  blurb: string;
};

/* Display order, biggest-to-smallest interest: a spike caused by visitors means
   something different from one caused by the backend's own upkeep. */
export const OSU_CALL_ORIGINS: readonly OsuCallOriginInfo[] = [
  { id: "page", label: "People browsing", blurb: "A visitor's page load or click needed something the backend does not store." },
  { id: "job", label: "Background jobs", blurb: "The backend keeping its own projections fresh, on its own schedule." },
  { id: "ingest", label: "Score ingest", blurb: "Picking up scores the live oSC feed did not deliver." },
  { id: "admin", label: "Admin tools", blurb: "Calls started from the admin pages." },
  { id: "other", label: "Unlabelled", blurb: "Calls whose tag has no description written for it yet." },
];

export type OsuCallerLabel = {
  /** Short human title, e.g. "Top plays refresh". */
  title: string;
  /** One sentence: what the call does and what makes it happen. */
  detail: string;
  origin: OsuCallOrigin;
  /** The site surface it feeds, when there is one obvious answer. */
  surface?: string;
};

const page = (title: string, detail: string, surface?: string): OsuCallerLabel => ({ title, detail, origin: "page", surface });
const job = (title: string, detail: string, surface?: string): OsuCallerLabel => ({ title, detail, origin: "job", surface });
const ingest = (title: string, detail: string, surface?: string): OsuCallerLabel => ({ title, detail, origin: "ingest", surface });
const admin = (title: string, detail: string, surface?: string): OsuCallerLabel => ({ title, detail, origin: "admin", surface });

const CALLERS: Record<string, OsuCallerLabel> = {
  // ── Background jobs (live-backend/src/workers.ts and features/*) ──────────
  "job:refresh_user_top_scores": job(
    "Top plays refresh",
    "A tracked player set a score, so their top 100 is re-read to see whether it landed.",
    "Top plays",
  ),
  "job:refresh_user_top_scores:pp_gain": job(
    "Top plays: pp gain lookup",
    "Reads the player's older scores on that map to work out how much pp the new one actually gained.",
    "Top plays",
  ),
  "job:refresh_country_roster": job(
    "Country roster refresh",
    "Re-reads a country's ranking pages so the tracked player list stays current.",
  ),
  "job:enrich_user": job(
    "New player lookup",
    "A score arrived from a player with nothing stored yet; this fetches their name, avatar and rank.",
  ),
  "job:enrich_beatmap": job(
    "New map lookup",
    "A score arrived on a map the backend has never seen; this fetches its metadata.",
  ),
  "job:reconcile_user_recent_scores": job(
    "Recent plays re-check",
    "Re-reads one player's recent plays to catch scores the live feed missed or delivered incomplete.",
    "Tracker",
  ),
  "job:osu_recent_fallback": ingest(
    "Recent plays catch-up (feed down)",
    "The same re-check, running as the ingest path because the oSC feed is unavailable.",
    "Tracker",
  ),
  "job:seed_snipe_board": job(
    "Snipe board seeding",
    "Builds a map's country leaderboard the first time anyone needs it.",
    "Snipes",
  ),
  "job:refresh_user_maps_farmed_scores": job(
    "Farmed maps refresh (one player)",
    "Re-reads a player's top scores so the maps board knows which maps their country farms.",
    "Maps",
  ),
  "job:refresh_country_maps:farmed": job(
    "Country maps: farmed scores",
    "Walks a country's roster reading top scores to rebuild the farmed-maps board.",
    "Maps",
  ),
  "job:refresh_country_maps:most_played": job(
    "Country maps: most played",
    "Reads roster players' most-played maps for the country maps board.",
    "Maps",
  ),
  "job:refresh_country_maps:favourites": job(
    "Country maps: favourites",
    "Reads roster players' favourited mapsets for the country maps board.",
    "Maps",
  ),
  "job:refresh_qualified_maps:search": job(
    "Qualified maps watch",
    "Searches osu! for newly qualified mania mapsets.",
    "Maps",
  ),
  "job:refresh_qualified_maps:resolve": job(
    "Qualified maps watch: details",
    "Fetches the mapsets that search turned up.",
    "Maps",
  ),
  "job:reconcile_settled_sets:resolve": job(
    "Ranked status re-check",
    "Re-reads mapsets whose ranked/loved status may have changed since they were stored.",
    "Maps",
  ),
  "job:compute_dan_estimate": job(
    "Dan estimate",
    "Downloads a map's .osu file so the dan estimator can rate it.",
    "Dan",
  ),
  "job:analyze_activity_beatmap": job(
    "Activity analysis",
    "Downloads a map's .osu file to score the patterns behind a player's day of scores.",
    "My stats",
  ),
  "job:analyze_beatmap_chart": job(
    "Chart analysis",
    "Downloads a map's .osu file for the pattern classifier (LN, jack, stream tagging).",
    "Maps",
  ),
  "job:compute_player_skills": job(
    "Skill ratings",
    "Downloads the .osu files behind a player's top plays to compute their skillset ratings.",
    "My stats",
  ),
  "job:backfill_beatmap_osu_files": job(
    "Map file backfill",
    "Slow sweep downloading .osu files for maps that have none cached yet.",
  ),
  "job:refresh_profile_user": job(
    "Profile metadata refresh",
    "Someone has that profile page open; this re-reads the player's osu! profile behind the stored snapshot.",
    "Profiles",
  ),
  "job:refresh_profile_snapshot": job(
    "Profile snapshot refresh",
    "Re-fetches a stored profile snapshot that went stale.",
    "Profiles",
  ),
  "job:refresh_profile_snapshot:best": job(
    "Profile snapshot: top 100",
    "The top-100 half of that stored profile refresh.",
    "Profiles",
  ),
  "job:warm_pack_player": job(
    "Pack card warm-up",
    "Pre-loads a card pool player's profile so opening a pack never waits on osu!.",
    "Packs",
  ),
  "job:osc_backfill": ingest(
    "oSC catch-up",
    "Pulls score pages from oSC's JSON API to repair a gap in the live feed.",
  ),

  // ── Ingest ────────────────────────────────────────────────────────────────
  osu_scores_fallback: ingest(
    "Score feed fallback poller",
    "The oSC live feed is unusable, so the backend polls osu!'s global recent scores instead.",
    "Tracker",
  ),
  osc_json_backfill: ingest(
    "oSC JSON catch-up",
    "Pages through oSC's JSON scores endpoint after a socket outage.",
  ),

  // ── Backend endpoints serving a page (live-backend/src/http) ──────────────
  "api:profile_snapshot": page(
    "Profile page load",
    "Someone opened a player profile the backend had no fresh snapshot for.",
    "Profiles",
  ),
  "api:profile_snapshot:best": page(
    "Profile page load: top 100",
    "The top-100 half of minting that profile on the spot.",
    "Profiles",
  ),
  "api:profile_about": page(
    "Profile page: about me",
    "Fetching the bbcode 'me' section of a profile someone opened.",
    "Profiles",
  ),
  "api:profile_recent:optional": page(
    "Profile page: recent plays",
    "Filling the recent-plays strip on a profile someone opened.",
    "Profiles",
  ),
  "api:dan_estimates": page(
    "Dan estimates request",
    "A page asked for dan ratings on maps that were not cached yet.",
    "Dan",
  ),
  refresh_country_roster: page(
    "Country activation",
    "Someone visited a cold country, which builds its roster from the osu! ranking pages.",
  ),

  // ── Server functions behind the site (src/lib/osu/*) ──────────────────────
  getRankings: page(
    "Ranking list",
    "A visitor loaded the rankings page, the home page, or a player picker.",
    "Rankings",
  ),
  getUser: page(
    "Player lookup",
    "A page asked for one player's osu! profile by name or id.",
    "Profiles",
  ),
  "getUserScores:best": page(
    "Player's top plays list",
    "Someone opened a player's top plays (replay browser, profile tabs).",
    "Replay browser",
  ),
  "getUserScores:recent": page(
    "Player's recent plays list",
    "Someone opened a player's recent plays.",
    "Replay browser",
  ),
  "getUserScores:firsts": page(
    "Player's #1 scores list",
    "Someone opened a player's first-place scores.",
    "Replay browser",
  ),
  "getUserScores:pinned": page(
    "Player's pinned scores list",
    "Someone opened a player's pinned scores.",
    "Replay browser",
  ),
  getUserRankHistory: page(
    "Rank history",
    "Drawing the rank graph on a profile.",
    "Profiles",
  ),
  getBeatmapUserScoresAll: page(
    "Player's scores on one map",
    "Listing every score a player has on a map (score picker, pp-gain views).",
  ),
  getBeatmapScores: page(
    "Map leaderboard",
    "Someone is browsing a map's global leaderboard.",
    "Replay browser",
  ),
  getBeatmapUserScore: page(
    "Player's score on a map",
    "Looking up one player's score on a specific map.",
  ),
  getBeatmapset: page(
    "Mapset details",
    "A page needed a mapset's metadata.",
  ),
  getBeatmapsetForBeatmap: page(
    "Map to mapset lookup",
    "Resolving a difficulty to its mapset for cover art and metadata.",
  ),
  "getBeatmapsetForBeatmap:beatmapset": page(
    "Map to mapset lookup: mapset",
    "The mapset half of that lookup.",
  ),
  searchBeatmaps: page(
    "Map search",
    "Someone typed in a map search box (replay browser, farm helper).",
    "Maps",
  ),
  "searchBeatmapsByMappers:user": page(
    "Map search by mapper: player",
    "Resolving the mapper name someone searched for.",
    "Maps",
  ),
  "searchBeatmapsByMappers:beatmapsets": page(
    "Map search by mapper: mapsets",
    "Listing that mapper's mapsets.",
    "Maps",
  ),
  searchUsers: page(
    "Player search",
    "Someone typed in a player search box (nav bar, replay browser).",
  ),
  "getScore:modern": page(
    "Score lookup",
    "Opening a replay: resolving the score id on the current osu! endpoint.",
    "Replay viewer",
  ),
  "getScore:legacy": page(
    "Score lookup (legacy id)",
    "Opening a replay whose id only exists on the old scores endpoint.",
    "Replay viewer",
  ),
  "getReplayParsed:modern": page(
    "Replay download",
    "Downloading a .osr replay so someone can watch it.",
    "Replay viewer",
  ),
  "getReplayParsed:legacy": page(
    "Replay download (legacy id)",
    "Downloading a .osr replay from the old scores endpoint.",
    "Replay viewer",
  ),
  lookupBeatmapByChecksum: page(
    "Map lookup by checksum",
    "An uploaded replay names its map by md5; this finds which map that is.",
    "Replay viewer",
  ),
  fetchBeatmapFile: page(
    "Map file download",
    "Fetching a .osu file the replay viewer needs to draw the chart.",
    "Replay viewer",
  ),
  describeUploadedReplay: page(
    "Uploaded replay description",
    "Naming the map and player behind a replay someone uploaded.",
    "Replay viewer",
  ),

  // ── Admin tools ───────────────────────────────────────────────────────────
  dan_classifier_admin: admin(
    "Dan classifier tool",
    "The admin dan classifier page asked osu! for a chart it had not cached.",
  ),
};

/* Suffixes that qualify a known base caller, so `…:best` reads as a phase of the
   call rather than as an unrelated tag. */
const SUFFIX_LABELS: Record<string, string> = {
  best: "top 100",
  beatmapset: "mapset",
  user: "player lookup",
  search: "search",
  resolve: "details",
  optional: "optional extra",
  pp_gain: "pp gain",
  farmed: "farmed scores",
  most_played: "most played",
  favourites: "favourites",
  modern: "current endpoint",
  legacy: "legacy endpoint",
};

const BEST_SCORES_PAGE = /^fetchUserBestScoresWindow:p(\d+)$/;

export function describeOsuCaller(caller: string): OsuCallerLabel {
  const raw = (caller ?? "").trim();
  if (!raw || raw === "unknown") {
    return { title: "Untagged call", detail: "The call went out without a caller tag, so its source is unknown.", origin: "other" };
  }
  const known = CALLERS[raw];
  if (known) return known;

  const pageMatch = BEST_SCORES_PAGE.exec(raw);
  if (pageMatch) {
    return page(
      `Player's top scores, page ${pageMatch[1]}`,
      "Paging through a player's top scores, 100 at a time (farm helper, snipes, my stats).",
    );
  }

  // A known base with an unlisted suffix keeps the base's meaning: `…:foo` is a
  // phase of the same call, not a different one.
  const cut = raw.lastIndexOf(":");
  if (cut > 0) {
    const base = CALLERS[raw.slice(0, cut)];
    if (base) {
      const suffix = raw.slice(cut + 1);
      return { ...base, title: `${base.title} (${SUFFIX_LABELS[suffix] ?? humanizeTag(suffix)})` };
    }
  }

  if (raw.startsWith("job:")) {
    return job(humanizeTag(raw.slice(4)), "A background job with no description written for it yet.");
  }
  if (raw.startsWith("api:")) {
    return page(humanizeTag(raw.slice(4)), "A backend endpoint serving a page, with no description written for it yet.");
  }
  if (raw.startsWith("admin:")) {
    return admin(humanizeTag(raw.slice(6)), "An admin action with no description written for it yet.");
  }
  if (/^(get|search|fetch|lookup)/.test(raw)) {
    return page(humanizeTag(raw), "A page-driven fetch with no description written for it yet.");
  }
  return { title: humanizeTag(raw), detail: "No description written for this caller yet.", origin: "other" };
}

/* `refresh_user_top_scores` / `getUserScores:pinned` -> "Refresh user top
   scores" / "Get user scores: pinned". Deliberately dumb: it only has to beat
   showing the raw tag. */
function humanizeTag(raw: string): string {
  const words = raw
    .replace(/[:_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : raw;
}

/** Names the backend resolved for the ids that appear in logged paths. */
export type OsuEntityNames = {
  users?: Record<string, string>;
  beatmaps?: Record<string, string>;
  beatmapsets?: Record<string, string>;
};

export type OsuPathLabel = {
  /** What was asked of osu!, e.g. "Top 100 scores". */
  title: string;
  /** Who or what it was about, resolved to a name where the backend knows one. */
  subject?: string;
};

/* osu! paths are regular enough to read structurally, so this stays a switch
   over the segments rather than a table of every path the codebase builds. */
export function describeOsuPath(path: string, names?: OsuEntityNames): OsuPathLabel {
  const raw = (path ?? "").trim();
  if (!raw) return { title: "Unknown request" };
  // catboy:/osu/123 and web:/… mark a non-API source; keep the marker visible.
  const sourceCut = raw.indexOf(":/");
  const source = sourceCut > 0 ? raw.slice(0, sourceCut) : null;
  const withoutSource = source ? raw.slice(sourceCut + 1) : raw;
  const [pathname] = withoutSource.split("?");
  const parts = pathname.split("/").filter(Boolean);
  const label = describePathParts(parts, withoutSource, names);
  return source ? { ...label, title: `${label.title} (${source})` } : label;
}

function describePathParts(parts: string[], full: string, names?: OsuEntityNames): OsuPathLabel {
  const [head, ...rest] = parts;
  switch (head) {
    case "users": {
      const subject = userName(rest[0], names);
      if (rest[1] === "scores") return { title: scoreListTitle(rest[2]), subject };
      if (rest[1] === "beatmapsets") {
        return { title: rest[2] === "favourite" ? "Favourite maps" : "Most played maps", subject };
      }
      return { title: "Player profile", subject };
    }
    case "beatmaps": {
      if (rest[0] === "lookup") return { title: "Map lookup by checksum" };
      const subject = beatmapName(rest[0], names);
      if (rest[1] === "scores") {
        return rest[2] === "users"
          ? { title: `Scores of ${userName(rest[3], names)} on a map`, subject }
          : { title: "Map leaderboard", subject };
      }
      if (rest[1] === "attributes") return { title: "Difficulty attributes", subject };
      return { title: "Map details", subject };
    }
    case "beatmapsets": {
      if (rest[0] === "search") return { title: "Map search", subject: searchQuery(full) };
      return { title: "Mapset details", subject: beatmapsetName(rest[0], names) };
    }
    case "scores": {
      // /scores/{id}, /scores/{mode}/{id}, either optionally + /download.
      if (parts.length === 1) return { title: "Global recent scores (feed fallback)" };
      const download = parts[parts.length - 1] === "download";
      const id = download ? parts[parts.length - 2] : parts[parts.length - 1];
      return { title: download ? "Replay download" : "Score details", subject: id ? `score ${id}` : undefined };
    }
    case "rankings":
      return { title: "Ranking page", subject: rankingScope(full) };
    case "osu":
      return { title: "Map file (.osu)", subject: beatmapName(rest[0], names) };
    case "search":
      return { title: "Player search", subject: searchQuery(full) };
    case "api":
      return { title: "oSC score feed" };
    default:
      return { title: full };
  }
}

function scoreListTitle(type: string | undefined): string {
  switch (type) {
    case "best": return "Top 100";
    case "recent": return "Recent plays";
    case "firsts": return "#1 scores";
    case "pinned": return "Pinned scores";
    default: return "Scores";
  }
}

function userName(id: string | undefined, names?: OsuEntityNames): string | undefined {
  if (!id) return undefined;
  const key = decodeURIComponent(id);
  return names?.users?.[key] ?? (/^\d+$/.test(key) ? `player ${key}` : key);
}

function beatmapName(id: string | undefined, names?: OsuEntityNames): string | undefined {
  if (!id) return undefined;
  return names?.beatmaps?.[id] ?? `map ${id}`;
}

function beatmapsetName(id: string | undefined, names?: OsuEntityNames): string | undefined {
  if (!id) return undefined;
  return names?.beatmapsets?.[id] ?? `mapset ${id}`;
}

function queryParams(full: string): URLSearchParams | null {
  const cut = full.indexOf("?");
  if (cut < 0) return null;
  try {
    return new URLSearchParams(full.slice(cut + 1));
  } catch {
    return null;
  }
}

function searchQuery(full: string): string | undefined {
  const params = queryParams(full);
  const query = params?.get("q") ?? params?.get("query");
  return query ? `"${query}"` : undefined;
}

function rankingScope(full: string): string | undefined {
  const params = queryParams(full);
  const country = params?.get("country");
  const page = params?.get("page");
  return [country ?? "global", page ? `page ${page}` : null].filter(Boolean).join(", ");
}
