// Type-only: sanitize-html (and its htmlparser2/postcss graph) loads on demand
// inside sanitizeProfilePageHtml — only About-page fetches need it, not boot.
import type sanitizeHtml from "sanitize-html";
import type { Db } from "../db.js";
import { exec, json, parseJson, writeVariantPps } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import { errorContext, logWarn } from "../logger.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { calculateWeightedPpTotal, getScoreIdentity, getScoreTimestamp, nowIso, scoreHasPublicLeaderboard } from "../shared/score.js";
import { compactScoresForStorage, hydrateScoresDisplayMetadata, persistScoresDisplayMetadata, selectRowsByIntegerSet } from "../shared/score-storage.js";
import { packJson, unpackJson } from "../shared/compressed-json.js";
import { readNoteBpms } from "./chart-analysis.js";
import type { OscScore, OsuMod, OsuScoreStatistics } from "../shared/types.js";

const PROFILE_SNAPSHOT_TTL_MS = 24 * 60 * 60_000;
const PROFILE_USER_TTL_MS = 10 * 60_000;
const PROFILE_USER_RECENT_TOP_PLAY_TTL_MS = 2 * 60_000;
const PROFILE_RECENT_TOP_PLAY_WINDOW_MS = 24 * 60 * 60_000;
const PROFILE_SECTION_TTL_MS = 2 * 60_000;
const PROFILE_TRACKED_RECENT_LIMIT = 100;
const PROFILE_TRACKED_RECENT_SCAN_LIMIT = 400;
const PROFILE_TRACKED_OVERLAY_LIMIT = 50;
// Exported for the farm helper: whether a best-scores snapshot filled the whole
// window decides if a keymode's play list can be truncated from below.
export const PROFILE_BEST_SCORES_LIMIT = 200;

// Opening a profile serves the stored snapshot and queues the osu! work instead
// of paying for it inline. Two job types because the two refreshes cost very
// different amounts and only one of them has someone waiting on it: the user
// payload is a single call the page's stale-metadata retry is polling for, the
// full snapshot is a user + best-200 window (~3 calls) nobody is blocked on
// because the stored top scores already rendered.
export const PROFILE_USER_REFRESH_JOB = "refresh_profile_user";
export const PROFILE_SNAPSHOT_REFRESH_JOB = "refresh_profile_snapshot";
// Above ingest enrichment (100): a viewer is on the page right now.
const PROFILE_USER_REFRESH_PRIORITY = 120;
const PROFILE_SNAPSHOT_REFRESH_PRIORITY = 80;
// Floor between full snapshot refreshes for one player, so a profile being
// hammered (or a projection that keeps asking to be baked in) can't turn views
// into a stream of best-200 fetches.
const PROFILE_SNAPSHOT_MIN_REFRESH_MS = 60_000;
/**
 * A tracked play this recent means the player is mid-session, which is what the
 * profile's green dot reports now that presence never costs an osu! call. Kept
 * in step with the client's RECENT_PLAY_ONLINE_WINDOW_MS.
 */
const PROFILE_SESSION_ACTIVE_WINDOW_MS = 10 * 60_000;

type ProfileScoreProvenance = "osu_snapshot" | "live_top_play_event" | "tracked_recent_score";
type ProfileLookupMode = "auto" | "userId";

export interface PlayerProfileSnapshot {
  user: Record<string, unknown>;
  bestScores: OscScore[];
  fetchedAt: string;
  userFetchedAt: string;
  isStale: boolean;
  projection: {
    appliedTopPlayEvents: number;
    appliedRecentScores: number;
    projectedPp: number | null;
    basePp: number | null;
    provenanceByScoreId: Record<number, ProfileScoreProvenance>;
  };
}

export interface PlayerProfileSection {
  userId: number;
  section: "about" | "recent";
  payload: unknown;
  fetchedAt: string;
  isStale: boolean;
}

interface ProfileSnapshotRow {
  user_id: number;
  username_key: string;
  // Plain JSON text on legacy rows, gzipped blob on rows written since the
  // storage compression — always read through unpackJson.
  user_json: string | Uint8Array | ArrayBuffer;
  best_scores_json: string | Uint8Array | ArrayBuffer;
  fetched_at: string;
  user_fetched_at?: string | null;
}

/* Seeded reconstructions of deleted osu! accounts carry `archived: true` on the
   stored user. See archived-players.ts for why they never refresh. */
function isArchivedProfileRow(row: ProfileSnapshotRow): boolean {
  const user = unpackJson<Record<string, unknown>>(row.user_json, {});
  return user.archived === true;
}

/* The recovered about-me of an archived player, or null for everyone else. */
async function readArchivedProfilePage(
  db: Db,
  userId: number,
): Promise<{ html: string | null; raw: string | null } | null> {
  const row = (await exec(db, "select user_json from profile_snapshots where user_id = ? limit 1", [userId])).rows[0];
  if (!row) return null;
  const user = unpackJson<Record<string, unknown>>(row.user_json as string | Uint8Array, {});
  if (user.archived !== true) return null;
  const page = readRecord(user.page);
  return {
    html: typeof page?.html === "string" && page.html ? page.html : null,
    raw: typeof page?.raw === "string" && page.raw ? page.raw : null,
  };
}

const PROFILE_PAGE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "b", "br", "blockquote", "center", "code", "del", "div", "em", "h1",
    "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre",
    "s", "span", "strike", "strong", "u", "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel", "target", "class", "style"],
    img: ["src", "alt", "title", "width", "height", "class", "loading", "style"],
    span: ["class", "style", "title"],
    div: ["class", "style"],
    "*": ["class"],
  },
  allowedStyles: {
    "*": {
      color: [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/],
      "text-align": [/^left$/, /^right$/, /^center$/, /^justify$/],
      "font-size": [/^\d+(\.\d+)?(%|px|em|rem|pt)$/],
      height: [/^\d+(\.\d+)?(px|%|em|rem)$/],
      left: [/^\d+(\.\d+)?(px|%|em|rem)$/],
      top: [/^\d+(\.\d+)?(px|%|em|rem)$/],
      width: [/^\d+(\.\d+)?(px|%|em|rem)$/],
      "max-width": [/^\d+(\.\d+)?(px|%|em|rem)$/],
      "aspect-ratio": [/^[\d.\s/]+$/],
    },
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: (tagName, attribs) => {
      const cls = typeof attribs.class === "string" ? attribs.class : "";
      if (cls.includes("js-spoilerbox__link")) {
        const { href: _href, target: _target, ...rest } = attribs;
        void _href;
        void _target;
        return { tagName, attribs: rest };
      }
      if (attribs.href === "#") return { tagName, attribs };
      return {
        tagName,
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      };
    },
  },
};

export async function getPlayerProfileSnapshot(
  db: Db,
  // Only the cold mint is left on this path; every refresh of an already stored
  // profile goes through the queue.
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  rawKey: string,
  options: { queue?: JobQueue | null; lookupMode?: ProfileLookupMode } = {},
): Promise<PlayerProfileSnapshot> {
  const key = normalizeProfileKey(rawKey);
  const lookupMode = options.lookupMode ?? "auto";
  const row = await getStoredProfileSnapshot(db, key, lookupMode);
  if (row) {
    // Archived players have no live osu! account, so every refresh path would
    // 404 and stamp refresh_error over a reconstruction that will never get
    // fresher. Serve the seeded row as-is.
    if (isArchivedProfileRow(row)) {
      return buildServedSnapshot(db, row, false, []);
    }
    const snapshotExpired = isExpired(row.fetched_at, PROFILE_SNAPSHOT_TTL_MS);
    const trackedRecentScores = await getTrackedProfileRecentScores(db, row.user_id, PROFILE_TRACKED_OVERLAY_LIMIT);
    const snapshot = await buildServedSnapshot(db, row, snapshotExpired, trackedRecentScores);
    // Serve what we stored, then let the workers catch it up. The page renders
    // off this response either way and its stale-metadata retry picks the fresh
    // numbers up a beat later.
    const queue = options.queue ?? null;
    if (queue && !await isUserKnownMissing(db, row.user_id)) {
      // A full re-mint rewrites user_json and user_fetched_at on its way to the
      // best-200, so queueing both would spend two /users calls on one profile.
      if (snapshotExpired || snapshot.projection.appliedRecentScores > 0) {
        enqueueProfileRefresh(queue, PROFILE_SNAPSHOT_REFRESH_JOB, row.user_id, PROFILE_SNAPSHOT_REFRESH_PRIORITY);
      } else if (await isProfileUserRefreshDue(db, row)) {
        enqueueProfileRefresh(queue, PROFILE_USER_REFRESH_JOB, row.user_id, PROFILE_USER_REFRESH_PRIORITY);
      }
    }
    return snapshot;
  }

  // Nothing stored at all (someone searched a player we have never seen), so
  // there is no snapshot to serve and the mint has to happen inline.
  const fetchedRow = await fetchAndStoreProfileSnapshotShared(db, osu, key, lookupMode);
  return buildServedSnapshot(
    db,
    fetchedRow,
    false,
    await getTrackedProfileRecentScores(db, fetchedRow.user_id, PROFILE_TRACKED_OVERLAY_LIMIT),
  );
}

/* Best-effort by contract: a queue write must never fail or delay a page load,
   and a dropped enqueue only costs this viewer a beat of staleness. */
function enqueueProfileRefresh(queue: JobQueue, type: string, userId: number, priority: number): void {
  void queue
    .enqueue(type, `${type}:${userId}`, { userId }, { priority, replaceDone: true })
    .catch((error) => {
      logWarn("profile_refresh_enqueue_failed", { job_type: type, user_id: userId, ...errorContext(error) });
    });
}

async function isProfileUserRefreshDue(db: Db, row: ProfileSnapshotRow): Promise<boolean> {
  return isExpired(row.user_fetched_at ?? row.fetched_at, await getProfileUserTtlMs(db, row.user_id));
}

/* A deleted or banned account 404s on every refresh. The worker's missing-user
   handling already flips users.is_active to 0 and drops the queued jobs, but the
   profile_snapshots row stays (it is the last known state, and still served), so
   without this check each later view would queue another doomed /users call.
   Same predicate as isUserKnownInactive in users.ts, inlined to keep this module
   off the users.ts -> farm-helper.ts -> here import cycle. */
async function isUserKnownMissing(db: Db, userId: number): Promise<boolean> {
  const row = (await exec(db, "select is_active from users where user_id = ? limit 1", [userId])).rows[0];
  return row != null && Number(row.is_active ?? 1) === 0;
}

// Read-only by contract: callers that receive no snapshot (or an empty top-score
// projection) may follow with the blocking snapshot endpoint. Starting osu! work
// here would race that request and duplicate a cold mint.
export async function getCachedPlayerProfileSnapshot(
  db: Db,
  rawKey: string,
  options: { lookupMode?: ProfileLookupMode } = {},
): Promise<PlayerProfileSnapshot | null> {
  const key = normalizeProfileKey(rawKey);
  const lookupMode = options.lookupMode ?? "auto";
  const row = await getStoredProfileSnapshot(db, key, lookupMode);
  if (row) {
    return buildServedSnapshot(
      db,
      row,
      isExpired(row.fetched_at, PROFILE_SNAPSHOT_TTL_MS),
      await getTrackedProfileRecentScores(db, row.user_id, PROFILE_TRACKED_OVERLAY_LIMIT),
    );
  }

  const userRow = await getStoredProfileUser(db, key, lookupMode);
  if (!userRow) return null;

  const fetchedAt = typeof userRow.updated_at === "string" ? userRow.updated_at : nowIso();
  const user = buildCachedProfileUser(userRow);
  // No warm here even when there are no stored top scores: this endpoint's
  // callers fall through to /snapshot, which mints the player inline.
  const bestScores = await getStoredUserTopScores(db, Number(userRow.user_id));
  return buildServedSnapshot(db, {
    user_id: Number(userRow.user_id),
    username_key: normalizeProfileKey(String(user.username ?? userRow.username)),
    user_json: json(user),
    best_scores_json: json(bestScores),
    fetched_at: fetchedAt,
    user_fetched_at: fetchedAt,
  }, true, await getTrackedProfileRecentScores(db, Number(userRow.user_id), PROFILE_TRACKED_OVERLAY_LIMIT));
}

/* Pack card view of a profile snapshot. The maniacard pipeline consumes up to
   200 best scores, but per score it reads only pp/mods/statistics, the score's
   own combo/accuracy/lazer-detection fields, and a handful of beatmap
   difficulty numbers; from the user it reads name/id/avatar plus
   statistics.pp. The full snapshot re-attaches beatmapset covers and per-score
   users and carries the whole projection envelope, none of which the card
   renders, so this projection cuts the payload to roughly a tenth. */
export interface PackCardScore {
  id: number;
  legacy_score_id?: number | null;
  user_id: number;
  accuracy: number;
  mods: OsuMod[];
  score: number;
  total_score?: number;
  legacy_total_score?: number;
  max_combo: number;
  passed: boolean;
  rank: string;
  statistics: OsuScoreStatistics;
  pp: number | null;
  type?: string;
  beatmap?: {
    id: number;
    difficulty_rating: number;
    cs: number;
    bpm: number;
    accuracy?: number;
    drain?: number;
    total_length?: number;
    count_circles?: number;
    count_sliders?: number;
    max_combo?: number;
  };
}

export interface PackCardProfileSnapshot {
  view: "card";
  user: Record<string, unknown>;
  bestScores: PackCardScore[];
  fetchedAt: string;
  userFetchedAt: string;
  isStale: boolean;
}

/* The stored halves a card is built from. Deliberately NOT a
   PlayerProfileSnapshot: see getCachedPackCardSnapshots. */
interface PackCardSource {
  userId: number;
  user: Record<string, unknown>;
  scores: OscScore[];
  fetchedAt: string;
  userFetchedAt: string;
  isStale: boolean;
}

/* One dealt hand's worth of players. The endpoint clamps to this so a public
   caller cannot turn one request into an arbitrarily wide read. */
export const PACK_CARD_SNAPSHOT_MAX_IDS = 10;

/**
 * Cached pack-card reads, straight off the stored rows.
 *
 * Minting a card needs two things: the player's identity numbers and their
 * best scores with each map's difficulty fields. It does not need presence,
 * projected pp, provenance, per-score user rows, beatmapset covers or note
 * BPMs — all of which getCachedPlayerProfileSnapshot computes before this view
 * throws them away. A ten-card hand paid for ten of those, which is what made
 * a pack open read like a burst of profile loads. The one thing it does keep
 * is the live overlay on the stored window (applyPackCardScoreOverlays), which
 * a mint's accuracy depends on.
 *
 * Batched because local libsql runs queries synchronously on the event loop:
 * ten concurrent single-card requests interleave rather than parallelize, and
 * a hand's players share farm maps, so one beatmap read over the union beats
 * ten overlapping ones.
 */
export async function getCachedPackCardSnapshots(
  db: Db,
  userIds: readonly number[],
): Promise<PackCardProfileSnapshot[]> {
  const ids = [...new Set(userIds.map((id) => Math.floor(Number(id))).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const sources = new Map<number, PackCardSource>();
  const snapshotRows = await selectRowsByIntegerSet(
    db,
    // Named columns, not `select *`: the compressed blobs are most of the row,
    // and best_scores_limit/refresh_error/updated_at are not part of a card.
    "select user_id, user_json, best_scores_json, fetched_at, user_fetched_at from profile_snapshots where user_id in",
    ids,
  );
  for (const row of snapshotRows) {
    const userId = Number(row.user_id);
    if (!Number.isSafeInteger(userId) || userId <= 0) continue;
    const fetchedAt = String(row.fetched_at ?? "");
    sources.set(userId, {
      userId,
      user: unpackJson<Record<string, unknown>>(row.user_json, {}),
      scores: unpackJson<OscScore[]>(row.best_scores_json, []),
      fetchedAt,
      userFetchedAt: readString(row.user_fetched_at) ?? fetchedAt,
      isStale: isExpired(fetchedAt, PROFILE_SNAPSHOT_TTL_MS),
    });
  }

  // Players with no snapshot row can still have the user_top_scores projection
  // (ingest wrote it, nobody has opened their profile). Same contract as
  // getCachedPlayerProfileSnapshot: read what is stored, warm nothing.
  const missing = ids.filter((id) => !sources.has(id));
  if (missing.length > 0) {
    const userRows = await selectRowsByIntegerSet(
      db,
      // Only what a card prints: the full cached profile (cover, badges, rank
      // history) would be built and then trimmed away.
      "select user_id, username, avatar_url, country_code, pp, global_rank, updated_at from users where user_id in",
      missing,
    );
    const topScores = await readStoredTopScoresByUser(db, userRows.map((row) => Number(row.user_id)));
    for (const row of userRows) {
      const userId = Number(row.user_id);
      const scores = topScores.get(userId);
      if (!scores?.length) continue;
      const fetchedAt = readString(row.updated_at) ?? nowIso();
      sources.set(userId, {
        userId,
        user: {
          id: userId,
          username: readString(row.username) ?? `User ${userId}`,
          avatar_url: readString(row.avatar_url) ?? "",
          country_code: readString(row.country_code) ?? "",
          statistics: { pp: readNumber(row.pp), global_rank: readInteger(row.global_rank) },
        },
        scores,
        fetchedAt,
        userFetchedAt: fetchedAt,
        // No snapshot row means nothing has ever baked this player's window;
        // the caller's cold path owns freshness from here.
        isStale: true,
      });
    }
  }

  return buildPackCardSnapshots(db, ids.flatMap((id) => {
    const source = sources.get(id);
    return source ? [source] : [];
  }));
}

export async function getCachedPackCardSnapshot(
  db: Db,
  rawKey: string,
  options: { lookupMode?: ProfileLookupMode } = {},
): Promise<PackCardProfileSnapshot | null> {
  const key = normalizeProfileKey(rawKey);
  const lookupMode = options.lookupMode ?? "auto";
  const numericKey = Number(key);
  if (lookupMode === "userId" && Number.isInteger(numericKey) && numericKey > 0) {
    return (await getCachedPackCardSnapshots(db, [numericKey]))[0] ?? null;
  }
  // Username lookups resolve the id first, then take the same batched path.
  const row = await getStoredProfileSnapshot(db, key, lookupMode) ?? await getStoredProfileUser(db, key, lookupMode);
  const userId = Number(row?.user_id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return (await getCachedPackCardSnapshots(db, [userId]))[0] ?? null;
}

async function buildPackCardSnapshots(db: Db, sources: PackCardSource[]): Promise<PackCardProfileSnapshot[]> {
  await applyPackCardScoreOverlays(db, sources);
  const beatmaps = await readPackCardBeatmaps(
    db,
    sources.flatMap((source) => source.scores.map((score) => score.beatmap_id ?? score.beatmap?.id ?? 0)),
  );
  return sources.map((source) => ({
    view: "card",
    user: buildPackCardUser(source.user),
    bestScores: source.scores.map((score) => toPackCardScore(score, beatmaps)),
    fetchedAt: source.fetchedAt,
    userFetchedAt: source.userFetchedAt,
    isStale: source.isStale,
  }));
}

/**
 * Brings each stored best-play window up to date, the way the profile page's
 * projection does: top-play events confirmed since the snapshot was baked,
 * then tracked scores newer than it that would enter the top 200.
 *
 * A card mints from this window, so skipping it would under-rate any player
 * whose snapshot has aged (a stored window is 12 days old on average, and the
 * session-end bake never touches a player who stops playing). Only the score
 * list matters here — the projection's pp/provenance bookkeeping is for the
 * profile page.
 *
 * Two queries for the whole hand, each with the player's own cutoff inline:
 * both tables are indexed on (user_id, time), and the cutoff is what keeps
 * this cheap — for a player who has not played since their snapshot, both
 * reads return nothing.
 */
async function applyPackCardScoreOverlays(db: Db, sources: PackCardSource[]): Promise<void> {
  const dated = sources.filter((source) => Number.isFinite(Date.parse(source.fetchedAt)));
  if (dated.length === 0) return;
  const cutoffs = dated.flatMap((source) => [source.userId, source.fetchedAt]);
  const perUser = dated.map(() => "(user_id = ? and %COL% > ?)").join(" or ");

  const topPlayRows = (await exec(
    db,
    `select user_id, payload_json from top_play_events
     where ${perUser.replaceAll("%COL%", "detected_at")}
     order by user_id asc, detected_at asc`,
    cutoffs,
  )).rows;
  const eventsByUser = new Map<number, OscScore[]>();
  for (const row of topPlayRows) {
    const score = parseJson<{ score?: OscScore }>(row.payload_json, {}).score;
    if (!score) continue;
    const userId = Number(row.user_id);
    const existing = eventsByUser.get(userId);
    if (existing) existing.push(score);
    else eventsByUser.set(userId, [score]);
  }

  const recentRows = (await exec(
    db,
    `select user_id, score_json from score_events
     where ruleset_id = 3 and (${perUser.replaceAll("%COL%", "ended_at")})
     order by user_id asc, ended_at desc`,
    cutoffs,
  )).rows;
  const recentByUser = new Map<number, OscScore[]>();
  for (const row of recentRows) {
    const userId = Number(row.user_id);
    const kept = recentByUser.get(userId) ?? [];
    // Same window the profile overlay takes, newest first.
    if (kept.length >= PROFILE_TRACKED_OVERLAY_LIMIT) continue;
    const score = parseJson<OscScore | null>(row.score_json, null);
    if (!score) continue;
    kept.push(score);
    recentByUser.set(userId, kept);
  }

  for (const source of dated) {
    let scores = dedupeScores(source.scores);
    let applied = false;
    for (const eventScore of eventsByUser.get(source.userId) ?? []) {
      if (eventScore.user_id !== source.userId || eventScore.pp == null || eventScore.pp <= 0) continue;
      const next = applyTopPlayEvent(scores, eventScore);
      if (next === scores) continue;
      scores = next;
      applied = true;
    }
    for (const recentScore of dedupeScores(recentByUser.get(source.userId) ?? []).sort(compareScoresByTimeAsc)) {
      if (!isProfileRecentTopScoreCandidate(recentScore, source.userId) || !isScoreAfter(recentScore, source.fetchedAt)) continue;
      const next = applyTopPlayEvent(scores, recentScore);
      if (next === scores) continue;
      scores = next;
      applied = true;
    }
    if (applied) source.scores = rankBestScores(scores);
  }
}

/* One chunked read of every top-200 the callers asked for. Rows come back
   ordered per player so the per-user slice keeps mint order. */
async function readStoredTopScoresByUser(db: Db, userIds: number[]): Promise<Map<number, OscScore[]>> {
  const byUser = new Map<number, OscScore[]>();
  if (userIds.length === 0) return byUser;
  const rows = await selectRowsByIntegerSet(
    db,
    "select user_id, score_json from user_top_scores where user_id in",
    userIds,
    `and position <= ${PROFILE_BEST_SCORES_LIMIT} order by user_id asc, position asc`,
  );
  for (const row of rows) {
    const userId = Number(row.user_id);
    const score = parseJson<OscScore | null>(row.score_json, null);
    if (!score || !Number.isSafeInteger(userId) || userId <= 0) continue;
    const existing = byUser.get(userId);
    if (existing) existing.push(score);
    else byUser.set(userId, [score]);
  }
  return byUser;
}

/* The card's slice of the beatmaps table: difficulty numbers only, no
   beatmapset join (covers, title and artist are not on a card) and no
   per-score user rows (a card has exactly one player, already in user_json). */
async function readPackCardBeatmaps(db: Db, beatmapIds: number[]): Promise<Map<number, PackCardScore["beatmap"]>> {
  const rows = await selectRowsByIntegerSet(
    db,
    "select beatmap_id, difficulty_rating, cs, bpm, max_combo, metadata_json from beatmaps where beatmap_id in",
    beatmapIds,
  );
  const byId = new Map<number, PackCardScore["beatmap"]>();
  for (const row of rows) {
    const id = Number(row.beatmap_id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    // OD, HP, length and note counts live only in the stored osu! payload.
    const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
    byId.set(id, {
      id,
      difficulty_rating: readNumber(row.difficulty_rating) ?? readNumber(metadata.difficulty_rating) ?? 0,
      cs: readNumber(row.cs) ?? readNumber(metadata.cs) ?? 0,
      bpm: readNumber(row.bpm) ?? readNumber(metadata.bpm) ?? 0,
      accuracy: readNumber(metadata.accuracy) ?? undefined,
      drain: readNumber(metadata.drain) ?? undefined,
      total_length: readNumber(metadata.total_length) ?? undefined,
      count_circles: readNumber(metadata.count_circles) ?? undefined,
      count_sliders: readNumber(metadata.count_sliders) ?? undefined,
      max_combo: readNumber(row.max_combo) ?? readNumber(metadata.max_combo) ?? undefined,
    });
  }
  return byId;
}

function buildPackCardUser(user: Record<string, unknown>): Record<string, unknown> {
  const statistics = readRecord(user.statistics);
  return {
    id: user.id,
    username: user.username,
    avatar_url: user.avatar_url,
    country_code: user.country_code,
    statistics: {
      pp: readNumber(statistics?.pp),
      global_rank: readInteger(statistics?.global_rank),
    },
  };
}

function toPackCardScore(score: OscScore, beatmaps: Map<number, PackCardScore["beatmap"]>): PackCardScore {
  /* Stored scores are compacted (no inline beatmap), so the difficulty numbers
     come from readPackCardBeatmaps. Scores that do carry a beatmap (the seeded
     archived players, which are also the GOAT pool) are merged field by field,
     not object by object: `beatmaps.max_combo` is null for most rows, and the
     score's own copy is often the only place that number exists. */
  const inline = score.beatmap as (NonNullable<OscScore["beatmap"]> & Record<string, unknown>) | undefined;
  const beatmapId = score.beatmap_id ?? inline?.id;
  const stored = beatmapId == null ? undefined : beatmaps.get(beatmapId);
  const beatmap = stored || inline
    ? {
      id: stored?.id ?? Number(inline?.id),
      difficulty_rating: stored?.difficulty_rating || readNumber(inline?.difficulty_rating) || 0,
      cs: stored?.cs || readNumber(inline?.cs) || 0,
      bpm: stored?.bpm || readNumber(inline?.bpm) || 0,
      accuracy: stored?.accuracy ?? readNumber(inline?.accuracy) ?? undefined,
      drain: stored?.drain ?? readNumber(inline?.drain) ?? undefined,
      total_length: stored?.total_length ?? readNumber(inline?.total_length) ?? undefined,
      count_circles: stored?.count_circles ?? readNumber(inline?.count_circles) ?? undefined,
      count_sliders: stored?.count_sliders ?? readNumber(inline?.count_sliders) ?? undefined,
      max_combo: stored?.max_combo ?? readNumber(inline?.max_combo) ?? undefined,
    }
    : undefined;
  return {
    id: score.id,
    legacy_score_id: score.legacy_score_id ?? null,
    user_id: score.user_id,
    accuracy: score.accuracy,
    mods: score.mods,
    score: score.score,
    total_score: score.total_score,
    legacy_total_score: score.legacy_total_score,
    max_combo: score.max_combo,
    passed: score.passed,
    rank: score.rank,
    statistics: score.statistics,
    pp: score.pp,
    type: score.type,
    beatmap,
  };
}

export async function getPlayerRecentScores(
  db: Db,
  userId: number,
): Promise<PlayerProfileSection> {
  const fetchedAt = nowIso();
  return {
    userId,
    section: "recent",
    payload: await getTrackedProfileRecentScores(db, userId, PROFILE_TRACKED_RECENT_LIMIT),
    fetchedAt,
    isStale: false,
  };
}

export async function getPlayerRecentScoresFromOsu(
  db: Db,
  osu: Pick<OsuApiClient, "getUserRecentScores">,
  userId: number,
  options: {
    /**
     * Called with the untrimmed osu! response, and only when this call actually
     * hit the API -- a cache hit carries nothing new to act on. Lets the caller
     * reuse a payload it has already paid for (see the profile recent handler).
     */
    onFreshScores?: (scores: OscScore[]) => void;
  } = {},
): Promise<PlayerProfileSection> {
  let freshScores: OscScore[] | null = null;
  const section = await getProfileSection(
    db,
    "recent",
    userId,
    async () => {
      const scores = await osu.getUserRecentScores(userId, "api:profile_recent:optional");
      freshScores = scores;
      return scores;
    },
  );
  if (freshScores) options.onFreshScores?.(freshScores);
  return {
    ...section,
    payload: filterProfileRecentScoresToWindow(readProfileRecentScores(section.payload)),
  };
}

export async function getPlayerAbout(
  db: Db,
  osu: Pick<OsuApiClient, "getUser">,
  userId: number,
): Promise<PlayerProfileSection> {
  // An archived player's about text is part of their seeded snapshot; the osu!
  // API has nothing to serve for them.
  const archivedPage = await readArchivedProfilePage(db, userId);
  if (archivedPage) {
    return {
      userId,
      section: "about",
      payload: {
        html: archivedPage.html ? await sanitizeProfilePageHtml(archivedPage.html) : null,
        raw: archivedPage.raw,
      },
      fetchedAt: nowIso(),
      isStale: false,
    };
  }

  return getProfileSection(db, "about", userId, async () => {
    const user = await osu.getUser(userId, "api:profile_about");
    const page = readRecord(user.page);
    const html = typeof page?.html === "string" ? await sanitizeProfilePageHtml(page.html) : null;
    const raw = typeof page?.raw === "string" ? page.raw : null;
    return { html, raw };
  });
}

async function getProfileSection(
  db: Db,
  section: "about" | "recent",
  userId: number,
  fetchPayload: () => Promise<unknown>,
): Promise<PlayerProfileSection> {
  const cacheKey = `${section}:${userId}`;
  const row = (await exec(db, "select payload_json, fetched_at from profile_section_cache where cache_key = ?", [cacheKey])).rows[0];
  if (row && typeof row.fetched_at === "string" && !isExpired(row.fetched_at, PROFILE_SECTION_TTL_MS)) {
    return {
      userId,
      section,
      payload: parseJson(String(row.payload_json), null),
      fetchedAt: row.fetched_at,
      isStale: false,
    };
  }

  const fetchedAt = nowIso();
  const payload = await fetchPayload();
  await exec(
    db,
    `insert into profile_section_cache (cache_key, user_id, section, payload_json, fetched_at, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(cache_key) do update set
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at`,
    [cacheKey, userId, section, json(payload), fetchedAt, fetchedAt],
  );
  return { userId, section, payload, fetchedAt, isStale: false };
}

function readProfileRecentScores(payload: unknown): OscScore[] {
  return Array.isArray(payload)
    ? payload.filter((score): score is OscScore => !!score && typeof score === "object" && !Array.isArray(score))
    : [];
}

function filterProfileRecentScoresToWindow(scores: OscScore[], now = Date.now()): OscScore[] {
  const cutoff = now - PROFILE_RECENT_TOP_PLAY_WINDOW_MS;
  return scores
    .filter((score) => {
      const playedAt = Date.parse(getScoreTimestamp(score));
      return Number.isFinite(playedAt) && playedAt >= cutoff;
    })
    .sort((a, b) => Date.parse(getScoreTimestamp(b)) - Date.parse(getScoreTimestamp(a)));
}

async function getTrackedProfileRecentScores(
  db: Db,
  userId: number,
  limit: number,
): Promise<OscScore[]> {
  const rows = (await exec(
    db,
    `select score_json
     from score_events
     where user_id = ? and ruleset_id = 3
     order by ended_at desc
     limit ?`,
    [userId, Math.min(PROFILE_TRACKED_RECENT_SCAN_LIMIT, Math.max(limit, limit * 2))],
  )).rows;
  const scores: OscScore[] = [];
  const identities = new Set<string>();
  for (const row of rows) {
    const score = parseJson<OscScore | null>(row.score_json, null);
    if (!score) continue;
    const identity = getScoreIdentity(score);
    if (identities.has(identity)) continue;
    identities.add(identity);
    scores.push(score);
    if (scores.length >= limit) break;
  }
  return hydrateScoresDisplayMetadata(db, scores);
}

async function getStoredProfileSnapshot(db: Db, key: string, lookupMode: ProfileLookupMode = "auto"): Promise<ProfileSnapshotRow | null> {
  const numericKey = Number(key);
  let row: Record<string, unknown> | undefined;
  if (Number.isInteger(numericKey) && numericKey > 0 && lookupMode === "userId") {
    row = (await exec(db, "select * from profile_snapshots where user_id = ?", [numericKey])).rows[0];
  } else {
    row = (await exec(db, "select * from profile_snapshots where username_key = ?", [key])).rows[0];
    if (!row && Number.isInteger(numericKey) && numericKey > 0) {
      row = (await exec(db, "select * from profile_snapshots where user_id = ?", [numericKey])).rows[0];
    }
  }
  return row ? row as unknown as ProfileSnapshotRow : null;
}

async function getStoredProfileUser(db: Db, key: string, lookupMode: ProfileLookupMode = "auto"): Promise<Record<string, unknown> | null> {
  const numericKey = Number(key);
  let row: Record<string, unknown> | undefined;
  if (Number.isInteger(numericKey) && numericKey > 0 && lookupMode === "userId") {
    row = (await exec(db, "select * from users where user_id = ?", [numericKey])).rows[0];
  } else {
    row = (await exec(db, "select * from users where lower(username) = ?", [key])).rows[0];
    if (!row && Number.isInteger(numericKey) && numericKey > 0) {
      row = (await exec(db, "select * from users where user_id = ?", [numericKey])).rows[0];
    }
  }
  return row ? row as Record<string, unknown> : null;
}

async function getStoredUserTopScores(db: Db, userId: number): Promise<OscScore[]> {
  const rows = (await exec(
    db,
    `select score_json from user_top_scores
     where user_id = ?
     order by position asc
     limit ?`,
    [userId, PROFILE_BEST_SCORES_LIMIT],
  )).rows;
  return hydrateScoresDisplayMetadata(db, rows
    .map((row) => parseJson<OscScore | null>(row.score_json, null))
    .filter((score): score is OscScore => !!score));
}

async function hasStoredUserTopScores(db: Db, userId: number): Promise<boolean> {
  const row = (await exec(db, "select 1 from user_top_scores where user_id = ? limit 1", [userId])).rows[0];
  return !!row;
}

/* Session-end freshness for maniacards. When a player's play session ends, the
   skills job calls this to materialize their stored profile_snapshots row from
   the already-ingested user_top_scores projection - the SAME osu! best-200 a
   mint fetches, which confirmTopPlay already paid for this session (top-plays
   writes user_top_scores + users.top_scores_refreshed_at). Zero osu! calls in
   the common case; it is the durable, event-driven replacement for the pack
   warm path's 24h-TTL re-mint. Rules:
   - Never blank a cold player: an empty projection is left to the skills job's
     own mint fallback (loadTopPlaysSnapshot), which owns the ~3-call authority.
   - Never downgrade a fresher row: skip when a mint/confirmTopPlay already
     refreshed at/after the snapshot's fetched_at (nothing newer to write).
   - Never touch the users row (that upsert is a SQLITE_BUSY pressure point).
   Best-effort by contract: callers ignore failures so a profile-write hiccup
   can never fail or delay the skill-rating write. */
export async function persistSessionProfileSnapshot(db: Db, userId: number): Promise<"written" | "skipped"> {
  if (!Number.isInteger(userId) || userId <= 0) return "skipped";
  const key = normalizeProfileKey(String(userId));
  const existing = await getStoredProfileSnapshot(db, key, "userId");
  const userRow = await getStoredProfileUser(db, key, "userId");
  if (!userRow) return "skipped";
  const projectionRefreshedAt = readString(userRow.top_scores_refreshed_at);
  if (existing && (!projectionRefreshedAt || projectionRefreshedAt <= existing.fetched_at)) return "skipped";
  const bestScores = await getStoredUserTopScores(db, userId);
  if (bestScores.length === 0) return "skipped";
  const username = readString(userRow.username) ?? String(userId);
  const usernameKey = normalizeProfileKey(username);
  // Used only when this is a first insert (no prior snapshot); on conflict the
  // existing authoritative user_json is kept - we only refresh the scores.
  const user = buildCachedProfileUser(userRow);
  const fetchedAt = nowIso();
  const userFetchedAt = existing?.user_fetched_at ?? fetchedAt;
  await persistScoresDisplayMetadata(db, bestScores, fetchedAt);
  await exec(
    db,
    `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at, refresh_error)
     values (?, ?, ?, ?, ?, ?, ?, ?, null)
     on conflict(user_id) do update set
       best_scores_json = excluded.best_scores_json,
       best_scores_limit = excluded.best_scores_limit,
       fetched_at = excluded.fetched_at,
       updated_at = excluded.updated_at,
       refresh_error = null`,
    [userId, usernameKey, packJson(user), packJson(compactScoresForStorage(bestScores)), PROFILE_BEST_SCORES_LIMIT, fetchedAt, userFetchedAt, fetchedAt],
  );
  return "written";
}

/* In-flight snapshot fetches keyed by profile key. A pack warm and the
   reveal's snapshot request for the same cold player share one osu! API
   fetch instead of doubling it; two visitors landing on the same cold
   profile coalesce the same way. */
const inflightSnapshotFetches = new Map<string, Promise<ProfileSnapshotRow>>();

export function fetchAndStoreProfileSnapshotShared(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  key: string,
  lookupMode: ProfileLookupMode = "auto",
  caller = "api:profile_snapshot",
): Promise<ProfileSnapshotRow> {
  // Coalesce across callers (a pack warm and the skills-job refresh for the
  // same cold player share one fetch); the first caller's lane label wins.
  const inflightKey = `${lookupMode}:${key}`;
  const existing = inflightSnapshotFetches.get(inflightKey);
  if (existing) return existing;
  const promise = fetchAndStoreProfileSnapshot(db, osu, key, lookupMode, caller).finally(() => {
    inflightSnapshotFetches.delete(inflightKey);
  });
  inflightSnapshotFetches.set(inflightKey, promise);
  return promise;
}

/* Pack deals call this with the drawn user ids so cold players' snapshots
   are usually stored by the time their card is flipped. Fresh snapshots are
   skipped; cold ones fetch in the background, one player at a time IN PACK
   ORDER: the osu! limiter queue is FIFO, so fetching all five concurrently
   would put card 1's best-score pages behind every other player's user
   lookup and make the first reveal the slowest when the API budget is
   tight. Returns how many fetches were started. */
export async function warmProfileSnapshots(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  userIds: number[],
): Promise<{ warming: number }> {
  const coldKeys: string[] = [];
  for (const userId of userIds) {
    const key = normalizeProfileKey(String(userId));
    // A stored snapshot (even stale) or a populated top-score projection already
    // serves the card via getCachedPlayerProfileSnapshot, so only a genuinely
    // never-seen player needs a mint here. Active players' snapshots stay fresh
    // via the session-end refresh (persistSessionProfileSnapshot), so warm no
    // longer re-mints on the 24h TTL - that TTL re-mint is what let a burst of
    // pack opens stampede the interactive osu! lane.
    if (await getStoredProfileSnapshot(db, key, "userId")) continue;
    if (await hasStoredUserTopScores(db, userId)) continue;
    coldKeys.push(key);
  }
  void (async () => {
    for (const key of coldKeys) {
      try {
        await fetchAndStoreProfileSnapshotShared(db, osu, key, "userId");
      } catch {
        // Skip to the next player; the reveal's own request retries this one.
      }
    }
  })();
  return { warming: coldKeys.length };
}

async function fetchAndStoreProfileSnapshot(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  key: string,
  lookupMode: ProfileLookupMode,
  caller = "api:profile_snapshot",
): Promise<ProfileSnapshotRow> {
  const user = await fetchProfileUserByKey(osu, key, lookupMode, caller);
  const userId = Number(user.id);
  const username = typeof user.username === "string" ? user.username : key;
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("osu! profile response was missing a user id");

  const storedUser = stripProfilePage(user);
  const bestScores = await osu.getUserBestScoresWindow(userId, PROFILE_BEST_SCORES_LIMIT, `${caller}:best`);
  const fetchedAt = nowIso();
  const usernameKey = normalizeProfileKey(username);
  await persistScoresDisplayMetadata(db, bestScores, fetchedAt);
  await exec(
    db,
    `insert into profile_snapshots (user_id, username_key, user_json, best_scores_json, best_scores_limit, fetched_at, user_fetched_at, updated_at, refresh_error)
     values (?, ?, ?, ?, ?, ?, ?, ?, null)
     on conflict(user_id) do update set
       username_key = excluded.username_key,
       user_json = excluded.user_json,
       best_scores_json = excluded.best_scores_json,
       best_scores_limit = excluded.best_scores_limit,
       fetched_at = excluded.fetched_at,
       user_fetched_at = excluded.user_fetched_at,
       updated_at = excluded.updated_at,
       refresh_error = null`,
    [userId, usernameKey, packJson(storedUser), packJson(compactScoresForStorage(bestScores)), PROFILE_BEST_SCORES_LIMIT, fetchedAt, fetchedAt, fetchedAt],
  );
  await upsertDisplayUser(db, userId, username, storedUser, fetchedAt);
  const row = await getStoredProfileSnapshot(db, usernameKey);
  if (!row) throw new Error("Failed to store profile snapshot");
  return row;
}

async function fetchProfileUserByKey(
  osu: Pick<OsuApiClient, "getUserByKey">,
  key: string,
  lookupMode: ProfileLookupMode,
  caller: string,
): Promise<Record<string, unknown>> {
  if (lookupMode === "userId") return osu.getUserByKey(key, caller, "id");
  if (!isNumericProfileKey(key)) return osu.getUserByKey(key, caller, "username");

  try {
    return await osu.getUserByKey(key, caller, "username");
  } catch (error) {
    if (error instanceof OsuApiError && error.status === 404) {
      return osu.getUserByKey(key, caller, "id");
    }
    throw error;
  }
}

/**
 * PROFILE_USER_REFRESH_JOB: re-fetch the osu! user payload (stats, avatar,
 * supporter status) behind a profile view. One call, and the only refresh a
 * viewer is actually waiting on, which is why it outranks ingest enrichment.
 *
 * Idempotent on the TTL, so a job that lands after a mint or a duplicate
 * enqueue already refreshed the row costs nothing.
 */
export async function runProfileUserRefreshJob(
  db: Db,
  osu: Pick<OsuApiClient, "getUser">,
  userId: number,
): Promise<void> {
  const row = await getStoredProfileSnapshot(db, String(userId), "userId");
  // Archived reconstructions have no live osu! account to refresh from, and
  // neither do accounts we already know are gone.
  if (!row || isArchivedProfileRow(row)) return;
  if (await isUserKnownMissing(db, userId)) return;
  if (!await isProfileUserRefreshDue(db, row)) return;

  try {
    const user = await osu.getUser(row.user_id, "job:refresh_profile_user");
    const fetchedUserId = Number(user.id);
    const username = typeof user.username === "string" ? user.username : unpackJson<Record<string, unknown>>(row.user_json, {}).username;
    if (fetchedUserId !== row.user_id || typeof username !== "string") return;

    const storedUser = stripProfilePage(user);
    const fetchedAt = nowIso();
    await exec(
      db,
      `update profile_snapshots
       set username_key = ?, user_json = ?, user_fetched_at = ?, updated_at = ?, refresh_error = null
       where user_id = ?`,
      [normalizeProfileKey(username), packJson(storedUser), fetchedAt, fetchedAt, row.user_id],
    );
    await upsertDisplayUser(db, row.user_id, username, storedUser, fetchedAt);
  } catch (error) {
    await recordProfileRefreshError(db, row.user_id, error);
    // Rethrown so the queue applies its own backoff, and so a 404 reaches the
    // worker's missing-user handling instead of being swallowed here.
    throw error;
  }
}

/**
 * PROFILE_SNAPSHOT_REFRESH_JOB: re-mint the whole snapshot (user + best-200).
 * Runs behind the user refresh because the page already rendered the stored top
 * scores; this only decides how soon they stop being a day old.
 */
export async function runProfileSnapshotRefreshJob(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  userId: number,
): Promise<void> {
  const row = await getStoredProfileSnapshot(db, String(userId), "userId");
  if (row && isArchivedProfileRow(row)) return;
  if (row && !isExpired(row.fetched_at, PROFILE_SNAPSHOT_MIN_REFRESH_MS)) return;
  if (await isUserKnownMissing(db, userId)) return;

  try {
    await fetchAndStoreProfileSnapshotShared(db, osu, String(userId), "userId", "job:refresh_profile_snapshot");
  } catch (error) {
    await recordProfileRefreshError(db, userId, error);
    throw error;
  }
}

/* Recording the failure must never itself throw: when the refresh died to
   writer saturation (SQLITE_BUSY past the retry budget) this bookkeeping write
   tends to hit the same wall, and the job's own last_error already carries the
   reason. */
async function recordProfileRefreshError(db: Db, userId: number, error: unknown): Promise<void> {
  await exec(db, "update profile_snapshots set refresh_error = ?, updated_at = ? where user_id = ?", [
    error instanceof Error ? error.message : String(error),
    nowIso(),
    userId,
  ]).catch((recordError) => {
    logWarn("profile_refresh_error_record_failed", { user_id: userId, ...errorContext(recordError) });
  });
}

async function getProfileUserTtlMs(db: Db, userId: number): Promise<number> {
  const row = (await exec(
    db,
    "select max(detected_at) as detected_at from top_play_events where user_id = ?",
    [userId],
  )).rows[0];
  const detectedAt = typeof row?.detected_at === "string" ? Date.parse(row.detected_at) : NaN;
  if (Number.isFinite(detectedAt) && Date.now() - detectedAt < PROFILE_RECENT_TOP_PLAY_WINDOW_MS) {
    return PROFILE_USER_RECENT_TOP_PLAY_TTL_MS;
  }
  return PROFILE_USER_TTL_MS;
}

async function upsertDisplayUser(
  db: Db,
  userId: number,
  username: string,
  storedUser: Record<string, unknown>,
  updatedAt: string,
): Promise<void> {
  await exec(
    db,
    `insert into users (user_id, username, avatar_url, country_code, profile_json, updated_at, pp, global_rank, country_rank)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(user_id) do update set
       username = excluded.username,
       avatar_url = excluded.avatar_url,
       country_code = excluded.country_code,
       profile_json = excluded.profile_json,
       updated_at = excluded.updated_at,
       pp = excluded.pp,
       global_rank = excluded.global_rank,
       country_rank = excluded.country_rank`,
    [
      userId,
      username,
      typeof storedUser.avatar_url === "string" ? storedUser.avatar_url : "",
      typeof storedUser.country_code === "string" ? storedUser.country_code : null,
      json(storedUser),
      updatedAt,
      readNumber(readRecord(storedUser.statistics)?.pp),
      readInteger(readRecord(storedUser.statistics)?.global_rank),
      readInteger(readRecord(storedUser.statistics)?.country_rank),
    ],
  );
  await writeVariantPps(db, userId, storedUser.statistics);
}

async function buildServedSnapshot(db: Db, row: ProfileSnapshotRow, forceStale: boolean, recentScores: OscScore[] = []): Promise<PlayerProfileSnapshot> {
  const storedUser = unpackJson<Record<string, unknown>>(row.user_json, {});
  const userFetchedAt = row.user_fetched_at ?? row.fetched_at;
  const user = applyProfilePresence(storedUser, await getLatestTrackedPlayAt(db, row.user_id), userFetchedAt);
  const rawBestScores = await hydrateScoresDisplayMetadata(db, unpackJson<OscScore[]>(row.best_scores_json, []));
  const projectionBaselineAt = latestValidTimestamp(row.fetched_at, userFetchedAt);
  const projection = await projectTopPlays(db, row.user_id, rawBestScores, row.fetched_at, projectionBaselineAt, recentScores);
  await attachNoteBpms(db, projection.scores);
  const basePp = readNumber(readRecord(user.statistics)?.pp);
  const projectedPp = calculateProjectedUserPp(basePp, projection.ppBaselineScores, projection.scores);

  return {
    user,
    bestScores: projection.scores,
    fetchedAt: row.fetched_at,
    userFetchedAt,
    isStale: forceStale || isExpired(row.fetched_at, PROFILE_SNAPSHOT_TTL_MS),
    projection: {
      appliedTopPlayEvents: projection.appliedTopPlayEvents,
      appliedRecentScores: projection.appliedRecentScores,
      projectedPp,
      basePp,
      provenanceByScoreId: projection.provenanceByScoreId,
    },
  };
}

/**
 * osu!'s last_visit reflects Bancho/site presence and can stay stale while a
 * player is actively setting scores. A tracked score proves they were present
 * at least that recently, so profile responses use the newer timestamp without
 * rewriting the authoritative cached osu! payload.
 *
 * Activity refs outlive raw score_events; score_events cover the small window
 * before a freshly ingested score has reached the activity projection.
 *
 * @see applyProfilePresence for how far the stored osu! payload is trusted.
 */
async function getLatestTrackedPlayAt(db: Db, userId: number): Promise<string | null> {
  const row = (await exec(
    db,
    `select coalesce(max(activity_at, event_at), activity_at, event_at) as played_at
     from (
       select
         (select ended_at
          from player_activity_score_refs
          where user_id = ?
          order by ended_at desc
          limit 1) as activity_at,
         (select ended_at
          from score_events
          where user_id = ? and ruleset_id = 3
          order by ended_at desc
          limit 1) as event_at
     )`,
    [userId, userId],
  )).rows[0];
  const playedAt = readString(row?.played_at);
  return playedAt && Number.isFinite(Date.parse(playedAt)) ? playedAt : null;
}

/**
 * Presence for the profile hero (green dot, "Last seen X ago") without spending
 * an osu! call on it.
 *
 * The green dot means one thing here: a tracked play inside the session window,
 * so the player is mid-session right now. osu!'s own `is_online` is deliberately
 * ignored, because it also counts someone idling in the client or reading the
 * website, and a stored copy of it would pin a permanent dot on a player who
 * logged off hours ago. Rankings still show osu! presence; that list is built
 * from a live call and says something different on purpose.
 *
 * Last seen is the newest thing we can stand behind: the last tracked play, or
 * the payload's `last_visit` while the payload is inside its refresh TTL (a
 * profile searched cold minted seconds ago and still reads live). A player we
 * have never ingested a score for and whose payload has aged out gets no last
 * seen at all rather than a timestamp we can't stand behind.
 *
 * Archived players are exempt: their reconstructions never refresh by design,
 * so their seeded last_visit is the only presence they will ever have.
 */
function applyProfilePresence(
  user: Record<string, unknown>,
  trackedPlayAt: string | null,
  userFetchedAt: string,
): Record<string, unknown> {
  if (user.archived === true) return user;
  const payloadIsLive = !isExpired(userFetchedAt, PROFILE_USER_TTL_MS);
  const lastSeenAt = newerTimestamp(trackedPlayAt, payloadIsLive ? readString(user.last_visit) : null);
  const isOnline = trackedPlayAt != null && !isExpired(trackedPlayAt, PROFILE_SESSION_ACTIVE_WINDOW_MS);
  return { ...user, last_visit: lastSeenAt, is_online: isOnline };
}

function newerTimestamp(a: string | null, b: string | null): string | null {
  const aMs = a ? Date.parse(a) : NaN;
  const bMs = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(aMs)) return Number.isFinite(bMs) ? b : null;
  if (!Number.isFinite(bMs)) return a;
  return aMs >= bMs ? a : b;
}

// Attaches the note-weighted song tempo from chart analysis onto each served
// score's beatmap (one indexed IN lookup over the snapshot's <=~250 beatmap
// pks). Profile BPM stats prefer it over the nominal osu! bpm field, which
// misreads marathons and BPM-gimmick charts. Best-effort: unanalyzed charts
// simply stay without note_bpm and the client falls back to nominal.
async function attachNoteBpms(db: Db, scores: OscScore[]): Promise<void> {
  const beatmapIds = scores.map((score) => score.beatmap?.id ?? 0).filter((id) => id > 0);
  if (beatmapIds.length === 0) return;
  const noteBpms = await readNoteBpms(db, beatmapIds).catch(() => new Map<number, number>());
  if (noteBpms.size === 0) return;
  for (const score of scores) {
    const noteBpm = score.beatmap ? noteBpms.get(score.beatmap.id) : undefined;
    if (score.beatmap && noteBpm != null) {
      score.beatmap = { ...score.beatmap, note_bpm: noteBpm };
    }
  }
}

async function projectTopPlays(
  db: Db,
  userId: number,
  rawBestScores: OscScore[],
  snapshotFetchedAt: string,
  ppProjectionBaselineAt: string,
  recentScores: OscScore[] = [],
): Promise<{ scores: OscScore[]; ppBaselineScores: OscScore[]; appliedTopPlayEvents: number; appliedRecentScores: number; provenanceByScoreId: Record<number, ProfileScoreProvenance> }> {
  const rows = (await exec(
    db,
    "select payload_json, detected_at from top_play_events where user_id = ? and detected_at > ? order by detected_at asc",
    [userId, snapshotFetchedAt],
  )).rows;
  const provenanceByScoreId: Record<number, ProfileScoreProvenance> = {};
  let scores = dedupeScores(rawBestScores);
  let ppBaselineScores = scores;
  for (const score of scores) provenanceByScoreId[score.id] = "osu_snapshot";
  let appliedTopPlayEvents = 0;
  let appliedRecentScores = 0;
  const rawTopPlayScores = rows.map((row) => parseJson<{ score?: OscScore }>(row.payload_json, {}).score ?? null);
  const topPlayScores = await hydrateScoresDisplayMetadata(db, rawTopPlayScores.filter((score): score is OscScore => !!score));
  let topPlayScoreIndex = 0;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    const eventScore = rawTopPlayScores[rowIndex] ? topPlayScores[topPlayScoreIndex++] : null;
    if (!eventScore || eventScore.user_id !== userId || eventScore.pp == null || eventScore.pp <= 0) continue;
    const nextScores = applyTopPlayEvent(scores, eventScore);
    if (nextScores === scores) continue;
    scores = nextScores;
    if (isAtOrBefore(row.detected_at, ppProjectionBaselineAt)) ppBaselineScores = scores;
    provenanceByScoreId[eventScore.id] = "live_top_play_event";
    appliedTopPlayEvents += 1;
  }

  for (const recentScore of recentScores.sort(compareScoresByTimeAsc)) {
    if (!isProfileRecentTopScoreCandidate(recentScore, userId) || !isScoreAfter(recentScore, snapshotFetchedAt)) continue;
    const nextScores = applyTopPlayEvent(scores, recentScore);
    if (nextScores === scores) continue;
    scores = nextScores;
    if (isAtOrBefore(getScoreTimestamp(recentScore), ppProjectionBaselineAt)) ppBaselineScores = applyTopPlayEvent(ppBaselineScores, recentScore);
    provenanceByScoreId[recentScore.id] = "tracked_recent_score";
    appliedRecentScores += 1;
  }

  ppBaselineScores = rankBestScores(ppBaselineScores);
  scores = rankBestScores(scores);

  return { scores, ppBaselineScores, appliedTopPlayEvents, appliedRecentScores, provenanceByScoreId };
}

function compareScoresByTimeAsc(a: OscScore, b: OscScore): number {
  return Date.parse(getScoreTimestamp(a)) - Date.parse(getScoreTimestamp(b));
}

function isProfileRecentTopScoreCandidate(score: OscScore, userId: number): boolean {
  return score.user_id === userId
    && score.id > 0
    && isProfileRecentScoreBestOnMap(score)
    && score.passed === true
    && score.pp != null
    && score.pp > 0
    && (score.beatmap?.mode === "mania" || score.ruleset_id === 3)
    && scoreHasPublicLeaderboard(score);
}

function isProfileRecentScoreBestOnMap(score: OscScore): boolean {
  if (score.best_id == null || score.best_id <= 0) return true;
  const officialId = score.legacy_score_id != null && score.legacy_score_id > 0 ? score.legacy_score_id : score.id;
  return score.best_id === score.id || score.best_id === officialId;
}

function isScoreAfter(score: OscScore, cutoff: string): boolean {
  const scoreTime = Date.parse(getScoreTimestamp(score));
  const cutoffTime = Date.parse(cutoff);
  return Number.isFinite(scoreTime) && Number.isFinite(cutoffTime) && scoreTime > cutoffTime;
}

function applyTopPlayEvent(scores: OscScore[], eventScore: OscScore): OscScore[] {
  const identity = getScoreIdentity(eventScore);
  const existingIndex = scores.findIndex((score) => getScoreIdentity(score) === identity || score.id === eventScore.id);
  if (existingIndex >= 0) {
    const next = [...scores];
    next[existingIndex] = eventScore;
    return next;
  }

  const sameBeatmapScores = scores.filter((score) => isSameBeatmapScore(score, eventScore));
  if (sameBeatmapScores.length === 0) return [...scores, eventScore];
  if (sameBeatmapScores.some((score) => !isReplacedSameBeatmapScore(score, eventScore))) return scores;
  return [...scores.filter((score) => !isSameBeatmapScore(score, eventScore)), eventScore];
}

function rankBestScores(scores: OscScore[]): OscScore[] {
  return dedupeScores(scores)
    .sort(compareBestScores)
    .slice(0, PROFILE_BEST_SCORES_LIMIT)
    .map((score, index) => score.pp != null && score.pp > 0
      ? { ...score, weight: { percentage: 0.95 ** index * 100, pp: score.pp * 0.95 ** index } }
      : score);
}

function latestValidTimestamp(a: string, b: string): string {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (!Number.isFinite(aTime)) return b;
  if (!Number.isFinite(bTime)) return a;
  return bTime > aTime ? b : a;
}

function isAtOrBefore(value: unknown, cutoff: string): boolean {
  if (typeof value !== "string") return false;
  const valueTime = Date.parse(value);
  const cutoffTime = Date.parse(cutoff);
  return Number.isFinite(valueTime) && Number.isFinite(cutoffTime) && valueTime <= cutoffTime;
}

function isReplacedSameBeatmapScore(score: OscScore, eventScore: OscScore): boolean {
  if (!isSameBeatmapScore(score, eventScore)) return false;
  if (score.id === eventScore.id) return true;
  const scorePp = score.pp ?? 0;
  const eventPp = eventScore.pp ?? 0;
  if (eventPp !== scorePp) return eventPp > scorePp;
  const scoreTime = Date.parse(getScoreTimestamp(score));
  const eventTime = Date.parse(getScoreTimestamp(eventScore));
  if (Number.isFinite(scoreTime) && Number.isFinite(eventTime)) return eventTime >= scoreTime;
  return true;
}

function isSameBeatmapScore(score: OscScore, eventScore: OscScore): boolean {
  const beatmapId = score.beatmap_id ?? score.beatmap?.id;
  const eventBeatmapId = eventScore.beatmap_id ?? eventScore.beatmap?.id;
  if (!beatmapId || beatmapId !== eventBeatmapId) return false;
  return true;
}

function dedupeScores(scores: OscScore[]): OscScore[] {
  const seen = new Set<string>();
  const result: OscScore[] = [];
  for (const score of scores) {
    const identity = getScoreIdentity(score);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(score);
  }
  return result;
}

function compareBestScores(a: OscScore, b: OscScore): number {
  const ppDiff = (b.pp ?? 0) - (a.pp ?? 0);
  if (ppDiff !== 0) return ppDiff;
  return Date.parse(getScoreTimestamp(b)) - Date.parse(getScoreTimestamp(a));
}

function calculateProjectedUserPp(basePp: number | null, rawScores: OscScore[], projectedScores: OscScore[]): number | null {
  if (basePp == null) return null;
  const rawWeighted = calculateWeightedPpTotal(rawScores);
  const projectedWeighted = calculateWeightedPpTotal(projectedScores);
  if (!Number.isFinite(rawWeighted) || !Number.isFinite(projectedWeighted)) return basePp;
  return Math.max(0, basePp + projectedWeighted - rawWeighted);
}

async function sanitizeProfilePageHtml(html: string | null | undefined): Promise<string | null> {
  if (!html) return null;
  const { default: sanitize } = await import("sanitize-html");
  const cleaned = sanitize(html, PROFILE_PAGE_SANITIZE_OPTIONS);
  return cleaned.trim() || null;
}

function stripProfilePage(user: Record<string, unknown>): Record<string, unknown> {
  if (!readRecord(user.page)) return user;
  return {
    ...user,
    page: null,
  };
}

function normalizeProfileKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  if (!normalized || normalized.length > 120) throw new Error("Invalid profile key");
  return normalized;
}

function isNumericProfileKey(key: string): boolean {
  const numericKey = Number(key);
  return Number.isInteger(numericKey) && numericKey > 0;
}

function isExpired(fetchedAt: string, ttlMs: number): boolean {
  const fetched = Date.parse(fetchedAt);
  return !Number.isFinite(fetched) || Date.now() - fetched >= ttlMs;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function buildCachedProfileUser(row: Record<string, unknown>): Record<string, unknown> {
  const profile = readRecord(parseJson(row.profile_json, {})) ?? {};
  const userId = readInteger(row.user_id) ?? readInteger(profile.id) ?? 0;
  const username = readString(row.username) ?? readString(profile.username) ?? `User ${userId}`;
  const avatarUrl = readString(row.avatar_url) ?? readString(profile.avatar_url) ?? "";
  const countryCode = readString(row.country_code) ?? readString(profile.country_code) ?? "";
  const cover = readRecord(profile.cover);
  const coverUrl = readString(cover?.url) ?? readString(profile.cover_url) ?? avatarUrl;

  return stripProfilePage({
    ...profile,
    id: userId,
    username,
    avatar_url: avatarUrl,
    cover_url: coverUrl,
    cover: {
      custom_url: readString(cover?.custom_url),
      url: coverUrl,
      id: readString(cover?.id),
    },
    country_code: countryCode,
    country: readRecord(profile.country) ?? { code: countryCode, name: countryCode },
    join_date: readString(profile.join_date) ?? "",
    last_visit: readString(profile.last_visit),
    is_active: readBoolean(profile.is_active) ?? readBoolean(row.is_active) ?? true,
    is_online: readBoolean(profile.is_online) ?? false,
    is_supporter: readBoolean(profile.is_supporter) ?? false,
    statistics: buildCachedProfileStatistics(readRecord(profile.statistics), row),
    rank_history: readRecord(profile.rank_history),
    rank_highest: readRecord(profile.rank_highest),
    badges: Array.isArray(profile.badges) ? profile.badges : [],
    user_achievements: Array.isArray(profile.user_achievements) ? profile.user_achievements : [],
    follower_count: readInteger(profile.follower_count) ?? 0,
    mapping_follower_count: readInteger(profile.mapping_follower_count) ?? 0,
    previous_usernames: Array.isArray(profile.previous_usernames) ? profile.previous_usernames : [],
    playmode: readString(profile.playmode) ?? "mania",
    playstyle: Array.isArray(profile.playstyle) ? profile.playstyle : null,
    post_count: readInteger(profile.post_count) ?? 0,
    comments_count: readInteger(profile.comments_count) ?? 0,
  });
}

function buildCachedProfileStatistics(
  stats: Record<string, unknown> | null,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const globalRank = readInteger(row.global_rank) ?? readInteger(stats?.global_rank);
  const countryRank = readInteger(row.country_rank) ?? readInteger(stats?.country_rank);
  const pp = readNumber(row.pp) ?? readNumber(stats?.pp) ?? 0;
  const gradeCounts = readRecord(stats?.grade_counts);
  const level = readRecord(stats?.level);
  return {
    count_300: readInteger(stats?.count_300) ?? 0,
    count_100: readInteger(stats?.count_100) ?? 0,
    count_50: readInteger(stats?.count_50) ?? 0,
    count_miss: readInteger(stats?.count_miss) ?? 0,
    global_rank: globalRank,
    country_rank: countryRank,
    pp,
    ranked_score: readInteger(stats?.ranked_score) ?? 0,
    hit_accuracy: readNumber(stats?.hit_accuracy) ?? 0,
    play_count: readInteger(stats?.play_count) ?? 0,
    play_time: readInteger(stats?.play_time),
    total_score: readInteger(stats?.total_score) ?? 0,
    total_hits: readInteger(stats?.total_hits) ?? 0,
    maximum_combo: readInteger(stats?.maximum_combo) ?? 0,
    replays_watched_by_others: readInteger(stats?.replays_watched_by_others) ?? 0,
    is_ranked: readBoolean(stats?.is_ranked) ?? (globalRank != null || pp > 0),
    grade_counts: {
      ss: readInteger(gradeCounts?.ss) ?? 0,
      ssh: readInteger(gradeCounts?.ssh) ?? 0,
      s: readInteger(gradeCounts?.s) ?? 0,
      sh: readInteger(gradeCounts?.sh) ?? 0,
      a: readInteger(gradeCounts?.a) ?? 0,
    },
    level: {
      current: readInteger(level?.current) ?? 1,
      progress: readInteger(level?.progress) ?? 0,
    },
    variants: Array.isArray(stats?.variants) ? stats.variants : undefined,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  return null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
