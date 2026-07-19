import sanitizeHtml from "sanitize-html";
import type { Db } from "../db.js";
import { exec, json, parseJson, writeVariantPps } from "../db.js";
import { errorContext, logWarn } from "../logger.js";
import { OsuApiError, type OsuApiClient } from "../osu/client.js";
import { calculateWeightedPpTotal, getScoreIdentity, getScoreTimestamp, nowIso, scoreHasPublicLeaderboard } from "../shared/score.js";
import { compactScoresForStorage, hydrateScoresDisplayMetadata, persistScoresDisplayMetadata } from "../shared/score-storage.js";
import { packJson, unpackJson } from "../shared/compressed-json.js";
import { readNoteBpms } from "./chart-analysis.js";
import type { OscScore } from "../shared/types.js";

const PROFILE_SNAPSHOT_TTL_MS = 24 * 60 * 60_000;
const PROFILE_USER_TTL_MS = 10 * 60_000;
const PROFILE_USER_RECENT_TOP_PLAY_TTL_MS = 2 * 60_000;
const PROFILE_RECENT_TOP_PLAY_WINDOW_MS = 24 * 60 * 60_000;
const PROFILE_SECTION_TTL_MS = 2 * 60_000;
const PROFILE_BEST_SCORES_LIMIT = 200;
const PROFILE_USER_INLINE_REFRESH_BUDGET_MS = 150;
const PROFILE_RECENT_OVERLAY_INLINE_REFRESH_BUDGET_MS = 150;

type ProfileScoreProvenance = "osu_snapshot" | "live_top_play_event" | "profile_recent_score";
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
  osu: Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow"> & Partial<Pick<OsuApiClient, "getUserRecentScores">>,
  rawKey: string,
): Promise<PlayerProfileSnapshot> {
  const key = normalizeProfileKey(rawKey);
  const row = await getStoredProfileSnapshot(db, key);
  if (row) {
    const snapshotExpired = isExpired(row.fetched_at, PROFILE_SNAPSHOT_TTL_MS);
    const servedRow = await refreshProfileUserForServe(db, osu, row);
    if (snapshotExpired) {
      refreshProfileSnapshotInBackground(db, osu, key, servedRow);
      return buildServedSnapshot(db, servedRow, true, await getProfileRecentScoresForOverlay(db, osu, servedRow.user_id));
    }
    const snapshot = await buildServedSnapshot(db, servedRow, false, await getProfileRecentScoresForOverlay(db, osu, servedRow.user_id));
    if (snapshot.projection.appliedRecentScores > 0) refreshProfileSnapshotInBackground(db, osu, key, servedRow);
    return snapshot;
  }

  return buildServedSnapshot(db, await fetchAndStoreProfileSnapshotShared(db, osu, key), false);
}

// First-ever profile views used to wait for the browser to hydrate and call
// the live snapshot endpoint before any osu! API work started. When the cached
// endpoint can only serve a known user with no stored top scores, start the
// real snapshot fetch in the background so the data is ready (for this visitor
// and everyone after) by the time the client asks. Guarded to known users only
// (crawler requests for junk usernames never reach this) and rate-limited per
// key so repeated misses cannot drain the osu! API budget.
const FALLBACK_WARM_COOLDOWN_MS = 10 * 60_000;
const FALLBACK_WARM_MAX_TRACKED_KEYS = 1_000;
const fallbackWarmLastAttempt = new Map<string, number>();

function warmProfileSnapshotInBackground(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  key: string,
): void {
  const now = Date.now();
  const last = fallbackWarmLastAttempt.get(key);
  if (last != null && now - last < FALLBACK_WARM_COOLDOWN_MS) return;
  if (fallbackWarmLastAttempt.size >= FALLBACK_WARM_MAX_TRACKED_KEYS) {
    const oldest = fallbackWarmLastAttempt.keys().next().value;
    if (oldest != null) fallbackWarmLastAttempt.delete(oldest);
  }
  fallbackWarmLastAttempt.delete(key);
  fallbackWarmLastAttempt.set(key, now);
  void fetchAndStoreProfileSnapshotShared(db, osu, key).catch(() => {});
}

export async function getCachedPlayerProfileSnapshot(
  db: Db,
  rawKey: string,
  osu?: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
): Promise<PlayerProfileSnapshot | null> {
  const key = normalizeProfileKey(rawKey);
  const row = await getStoredProfileSnapshot(db, key);
  if (row) {
    return buildServedSnapshot(db, row, isExpired(row.fetched_at, PROFILE_SNAPSHOT_TTL_MS), await getCachedProfileRecentScores(db, row.user_id));
  }

  const userRow = await getStoredProfileUser(db, key);
  if (!userRow) return null;

  const fetchedAt = typeof userRow.updated_at === "string" ? userRow.updated_at : nowIso();
  const user = buildCachedProfileUser(userRow);
  const bestScores = await getStoredUserTopScores(db, Number(userRow.user_id));
  if (osu && bestScores.length === 0) warmProfileSnapshotInBackground(db, osu, key);
  return buildServedSnapshot(db, {
    user_id: Number(userRow.user_id),
    username_key: normalizeProfileKey(String(user.username ?? userRow.username)),
    user_json: json(user),
    best_scores_json: json(bestScores),
    fetched_at: fetchedAt,
    user_fetched_at: fetchedAt,
  }, true, await getCachedProfileRecentScores(db, Number(userRow.user_id)));
}

export async function getPlayerRecentScores(
  db: Db,
  osu: Pick<OsuApiClient, "getUserRecentScores">,
  userId: number,
): Promise<PlayerProfileSection> {
  return getProfileSection(db, "recent", userId, async () => osu.getUserRecentScores(userId, "api:profile_recent"));
}

export async function getPlayerAbout(
  db: Db,
  osu: Pick<OsuApiClient, "getUser">,
  userId: number,
): Promise<PlayerProfileSection> {
  return getProfileSection(db, "about", userId, async () => {
    const user = await osu.getUser(userId, "api:profile_about");
    const page = readRecord(user.page);
    const html = typeof page?.html === "string" ? sanitizeProfilePageHtml(page.html) : null;
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

async function getProfileRecentScoresForOverlay(
  db: Db,
  osu: Partial<Pick<OsuApiClient, "getUserRecentScores">>,
  userId: number,
): Promise<OscScore[]> {
  if (!osu.getUserRecentScores) return getCachedProfileRecentScores(db, userId);
  const cached = await getCachedProfileRecentScores(db, userId);
  const refresh = getProfileSection(db, "recent", userId, async () => osu.getUserRecentScores!(userId, "api:profile_snapshot:recent_overlay"))
    .then((section) => readProfileRecentScores(section.payload))
    .catch(() => cached);
  return withInlineRefreshBudget(refresh, cached, PROFILE_RECENT_OVERLAY_INLINE_REFRESH_BUDGET_MS);
}

async function getCachedProfileRecentScores(db: Db, userId: number): Promise<OscScore[]> {
  const row = (await exec(db, "select payload_json from profile_section_cache where cache_key = ?", [`recent:${userId}`])).rows[0];
  return readProfileRecentScores(parseJson(row?.payload_json, null));
}

function readProfileRecentScores(payload: unknown): OscScore[] {
  return Array.isArray(payload)
    ? payload.filter((score): score is OscScore => !!score && typeof score === "object" && !Array.isArray(score))
    : [];
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
): Promise<ProfileSnapshotRow> {
  const inflightKey = `${lookupMode}:${key}`;
  const existing = inflightSnapshotFetches.get(inflightKey);
  if (existing) return existing;
  const promise = fetchAndStoreProfileSnapshot(db, osu, key, lookupMode).finally(() => {
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
    const row = await getStoredProfileSnapshot(db, key, "userId");
    if (row && !isExpired(row.fetched_at, PROFILE_SNAPSHOT_TTL_MS)) continue;
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
): Promise<ProfileSnapshotRow> {
  const user = await fetchProfileUserByKey(osu, key, lookupMode);
  const userId = Number(user.id);
  const username = typeof user.username === "string" ? user.username : key;
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("osu! profile response was missing a user id");

  const storedUser = stripProfilePage(user);
  const bestScores = await osu.getUserBestScoresWindow(userId, PROFILE_BEST_SCORES_LIMIT, "api:profile_snapshot:best");
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
): Promise<Record<string, unknown>> {
  if (lookupMode === "userId") return osu.getUserByKey(key, "api:profile_snapshot", "id");
  if (!isNumericProfileKey(key)) return osu.getUserByKey(key, "api:profile_snapshot", "username");

  try {
    return await osu.getUserByKey(key, "api:profile_snapshot", "username");
  } catch (error) {
    if (error instanceof OsuApiError && error.status === 404) {
      return osu.getUserByKey(key, "api:profile_snapshot", "id");
    }
    throw error;
  }
}

function refreshProfileSnapshotInBackground(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  key: string,
  row: ProfileSnapshotRow,
): void {
  void fetchAndStoreProfileSnapshotShared(db, osu, key).catch(async (error) => {
    // Recording the failure must never itself throw: when the refresh died to
    // writer saturation (SQLITE_BUSY past the retry budget) this bookkeeping
    // write tends to hit the same wall, and a rejection escaping this voided
    // chain is an unhandled rejection that kills the whole process.
    await exec(db, "update profile_snapshots set refresh_error = ?, updated_at = ? where user_id = ?", [
      error instanceof Error ? error.message : String(error),
      nowIso(),
      row.user_id,
    ]).catch((recordError) => {
      logWarn("profile_refresh_error_record_failed", { user_id: row.user_id, ...errorContext(recordError) });
    });
  });
}

async function refreshProfileUserForServe(
  db: Db,
  osu: Pick<OsuApiClient, "getUser">,
  row: ProfileSnapshotRow,
): Promise<ProfileSnapshotRow> {
  return withInlineRefreshBudget(refreshProfileUserIfDue(db, osu, row), row, PROFILE_USER_INLINE_REFRESH_BUDGET_MS);
}

async function withInlineRefreshBudget<T>(
  refresh: Promise<T>,
  fallbackValue: T,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const fallback = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallbackValue), timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([refresh, fallback]);
  } finally {
    if (timeout) clearTimeout(timeout);
    void refresh.catch(() => {});
  }
}

async function refreshProfileUserIfDue(
  db: Db,
  osu: Pick<OsuApiClient, "getUser">,
  row: ProfileSnapshotRow,
): Promise<ProfileSnapshotRow> {
  const ttlMs = await getProfileUserTtlMs(db, row.user_id);
  const userFetchedAt = row.user_fetched_at ?? row.fetched_at;
  if (!isExpired(userFetchedAt, ttlMs)) return row;

  try {
    const user = await osu.getUser(row.user_id, "api:profile_snapshot:user");
    const userId = Number(user.id);
    const username = typeof user.username === "string" ? user.username : unpackJson<Record<string, unknown>>(row.user_json, {}).username;
    if (userId !== row.user_id || typeof username !== "string") return row;

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
    return await getStoredProfileSnapshot(db, String(row.user_id)) ?? row;
  } catch (error) {
    await exec(db, "update profile_snapshots set refresh_error = ?, updated_at = ? where user_id = ?", [
      error instanceof Error ? error.message : String(error),
      nowIso(),
      row.user_id,
    ]);
    return row;
  }
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
  const user = unpackJson<Record<string, unknown>>(row.user_json, {});
  const rawBestScores = await hydrateScoresDisplayMetadata(db, unpackJson<OscScore[]>(row.best_scores_json, []));
  const userFetchedAt = row.user_fetched_at ?? row.fetched_at;
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
    provenanceByScoreId[recentScore.id] = "profile_recent_score";
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

function sanitizeProfilePageHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const cleaned = sanitizeHtml(html, PROFILE_PAGE_SANITIZE_OPTIONS);
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
