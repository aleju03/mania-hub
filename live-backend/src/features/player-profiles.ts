import sanitizeHtml from "sanitize-html";
import type { Db } from "../db.js";
import { exec, json, parseJson } from "../db.js";
import type { OsuApiClient } from "../osu/client.js";
import { calculateWeightedPpTotal, getScoreIdentity, getScoreTimestamp, nowIso } from "../shared/score.js";
import type { OscScore } from "../shared/types.js";

const PROFILE_SNAPSHOT_TTL_MS = 24 * 60 * 60_000;
const PROFILE_USER_TTL_MS = 10 * 60_000;
const PROFILE_USER_RECENT_TOP_PLAY_TTL_MS = 2 * 60_000;
const PROFILE_RECENT_TOP_PLAY_WINDOW_MS = 24 * 60 * 60_000;
const PROFILE_SECTION_TTL_MS = 2 * 60_000;
const PROFILE_BEST_SCORES_LIMIT = 200;

export interface PlayerProfileSnapshot {
  user: Record<string, unknown>;
  bestScores: OscScore[];
  fetchedAt: string;
  userFetchedAt: string;
  isStale: boolean;
  projection: {
    appliedTopPlayEvents: number;
    projectedPp: number | null;
    basePp: number | null;
    provenanceByScoreId: Record<number, "osu_snapshot" | "live_top_play_event">;
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
  user_json: string;
  best_scores_json: string;
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
  osu: Pick<OsuApiClient, "getUser" | "getUserByKey" | "getUserBestScoresWindow">,
  rawKey: string,
): Promise<PlayerProfileSnapshot> {
  const key = normalizeProfileKey(rawKey);
  const row = await getStoredProfileSnapshot(db, key);
  if (row && !isExpired(row.fetched_at, PROFILE_SNAPSHOT_TTL_MS)) {
    return buildServedSnapshot(db, await refreshProfileUserIfDue(db, osu, row), false);
  }

  if (row) {
    try {
      return buildServedSnapshot(db, await fetchAndStoreProfileSnapshot(db, osu, key), false);
    } catch (error) {
      await exec(db, "update profile_snapshots set refresh_error = ?, updated_at = ? where user_id = ?", [
        error instanceof Error ? error.message : String(error),
        nowIso(),
        row.user_id,
      ]);
      return buildServedSnapshot(db, row, true);
    }
  }

  return buildServedSnapshot(db, await fetchAndStoreProfileSnapshot(db, osu, key), false);
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
    return { html };
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

async function getStoredProfileSnapshot(db: Db, key: string): Promise<ProfileSnapshotRow | null> {
  const numericKey = Number(key);
  const row = Number.isInteger(numericKey) && numericKey > 0
    ? (await exec(db, "select * from profile_snapshots where user_id = ?", [numericKey])).rows[0]
    : (await exec(db, "select * from profile_snapshots where username_key = ?", [key])).rows[0];
  return row ? row as unknown as ProfileSnapshotRow : null;
}

async function fetchAndStoreProfileSnapshot(
  db: Db,
  osu: Pick<OsuApiClient, "getUserByKey" | "getUserBestScoresWindow">,
  key: string,
): Promise<ProfileSnapshotRow> {
  const user = await osu.getUserByKey(key, "api:profile_snapshot");
  const userId = Number(user.id);
  const username = typeof user.username === "string" ? user.username : key;
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("osu! profile response was missing a user id");

  const storedUser = stripProfilePage(user);
  const bestScores = await osu.getUserBestScoresWindow(userId, PROFILE_BEST_SCORES_LIMIT, "api:profile_snapshot:best");
  const fetchedAt = nowIso();
  const usernameKey = normalizeProfileKey(username);
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
    [userId, usernameKey, json(storedUser), json(bestScores), PROFILE_BEST_SCORES_LIMIT, fetchedAt, fetchedAt, fetchedAt],
  );
  await upsertDisplayUser(db, userId, username, storedUser, fetchedAt);
  const row = await getStoredProfileSnapshot(db, usernameKey);
  if (!row) throw new Error("Failed to store profile snapshot");
  return row;
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
    const username = typeof user.username === "string" ? user.username : parseJson<Record<string, unknown>>(row.user_json, {}).username;
    if (userId !== row.user_id || typeof username !== "string") return row;

    const storedUser = stripProfilePage(user);
    const fetchedAt = nowIso();
    await exec(
      db,
      `update profile_snapshots
       set username_key = ?, user_json = ?, user_fetched_at = ?, updated_at = ?, refresh_error = null
       where user_id = ?`,
      [normalizeProfileKey(username), json(storedUser), fetchedAt, fetchedAt, row.user_id],
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
}

async function buildServedSnapshot(db: Db, row: ProfileSnapshotRow, forceStale: boolean): Promise<PlayerProfileSnapshot> {
  const user = parseJson<Record<string, unknown>>(row.user_json, {});
  const rawBestScores = parseJson<OscScore[]>(row.best_scores_json, []);
  const projection = await projectTopPlays(db, row.user_id, rawBestScores, row.fetched_at);
  const basePp = readNumber(readRecord(user.statistics)?.pp);
  const projectedPp = calculateProjectedUserPp(basePp, rawBestScores, projection.scores);
  const projectedUser = applyProjectedPp(user, projectedPp);

  return {
    user: projectedUser,
    bestScores: projection.scores,
    fetchedAt: row.fetched_at,
    userFetchedAt: row.user_fetched_at ?? row.fetched_at,
    isStale: forceStale || isExpired(row.fetched_at, PROFILE_SNAPSHOT_TTL_MS),
    projection: {
      appliedTopPlayEvents: projection.appliedTopPlayEvents,
      projectedPp,
      basePp,
      provenanceByScoreId: projection.provenanceByScoreId,
    },
  };
}

async function projectTopPlays(
  db: Db,
  userId: number,
  rawBestScores: OscScore[],
  snapshotFetchedAt: string,
): Promise<{ scores: OscScore[]; appliedTopPlayEvents: number; provenanceByScoreId: Record<number, "osu_snapshot" | "live_top_play_event"> }> {
  const rows = (await exec(
    db,
    "select payload_json from top_play_events where user_id = ? and detected_at > ? order by detected_at asc",
    [userId, snapshotFetchedAt],
  )).rows;
  const provenanceByScoreId: Record<number, "osu_snapshot" | "live_top_play_event"> = {};
  let scores = dedupeScores(rawBestScores);
  for (const score of scores) provenanceByScoreId[score.id] = "osu_snapshot";
  let appliedTopPlayEvents = 0;

  for (const row of rows) {
    const payload = parseJson<{ score?: OscScore }>(row.payload_json, {});
    const eventScore = payload.score;
    if (!eventScore || eventScore.user_id !== userId || eventScore.pp == null || eventScore.pp <= 0) continue;
    const identity = getScoreIdentity(eventScore);
    const existingIndex = scores.findIndex((score) => getScoreIdentity(score) === identity || score.id === eventScore.id);
    if (existingIndex >= 0) {
      scores[existingIndex] = eventScore;
    } else {
      scores = scores.filter((score) => !isReplacedSameBeatmapScore(score, eventScore));
      scores.push(eventScore);
    }
    provenanceByScoreId[eventScore.id] = "live_top_play_event";
    appliedTopPlayEvents += 1;
  }

  scores = dedupeScores(scores)
    .sort(compareBestScores)
    .slice(0, PROFILE_BEST_SCORES_LIMIT)
    .map((score, index) => score.pp != null && score.pp > 0
      ? { ...score, weight: { percentage: 0.95 ** index * 100, pp: score.pp * 0.95 ** index } }
      : score);

  return { scores, appliedTopPlayEvents, provenanceByScoreId };
}

function isReplacedSameBeatmapScore(score: OscScore, eventScore: OscScore): boolean {
  const beatmapId = score.beatmap_id ?? score.beatmap?.id;
  const eventBeatmapId = eventScore.beatmap_id ?? eventScore.beatmap?.id;
  if (!beatmapId || beatmapId !== eventBeatmapId) return false;
  if (score.id === eventScore.id) return true;
  const scoreTime = Date.parse(getScoreTimestamp(score));
  const eventTime = Date.parse(getScoreTimestamp(eventScore));
  if (Number.isFinite(scoreTime) && Number.isFinite(eventTime) && scoreTime > eventTime) return false;
  return (score.pp ?? 0) <= (eventScore.pp ?? 0);
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

function applyProjectedPp(user: Record<string, unknown>, projectedPp: number | null): Record<string, unknown> {
  if (projectedPp == null) return user;
  const statistics = readRecord(user.statistics);
  if (!statistics) return user;
  return {
    ...user,
    statistics: {
      ...statistics,
      pp: projectedPp,
    },
  };
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

function isExpired(fetchedAt: string, ttlMs: number): boolean {
  const fetched = Date.parse(fetchedAt);
  return !Number.isFinite(fetched) || Date.now() - fetched >= ttlMs;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
