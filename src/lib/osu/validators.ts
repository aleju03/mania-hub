import { isSupportedCountryCode } from "../country";
import {
  BEATMAP_SORTS,
  BEATMAP_STATUSES,
  MAX_BATCH_USERS,
  MAX_BEST_WINDOW_LIMIT,
  MAX_CURSOR_LENGTH,
  MAX_HOME_USERS,
  MAX_OSU_ID,
  MAX_OSU_SCORE_ID,
  MAX_QUERY_LENGTH,
  MAX_SCORE_LIMIT,
  MAX_SCORE_OFFSET,
  RANKING_TYPES,
  REPLAY_MODES
} from "./constants";
import type { PopoffWindow } from "./constants";
import type {
  HomePreviewPlayer,
  TrackerUserSummary
} from "./internal-types";

export function asInputRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

export function parseBoundedInt(
  value: unknown,
  label: string,
  options: { min: number; max: number; fallback?: number },
): number {
  if (value == null || value === "") {
    if (options.fallback != null) return options.fallback;
    throw new Error(`Missing ${label}.`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < options.min || n > options.max) {
    throw new Error(`Invalid ${label}.`);
  }
  return n;
}

export function parseOptionalBoundedInt(
  value: unknown,
  label: string,
  options: { min: number; max: number },
): number | undefined {
  if (value == null || value === "") return undefined;
  return parseBoundedInt(value, label, options);
}

export function parseOsuId(value: unknown, label: string): number {
  return parseBoundedInt(value, label, { min: 1, max: MAX_OSU_ID });
}

export function parseOsuScoreId(value: unknown, label: string): number {
  return parseBoundedInt(value, label, { min: 1, max: MAX_OSU_SCORE_ID });
}

export function parseString(value: unknown, label: string, maxLength: number, fallback?: string): string {
  if (value == null) {
    if (fallback != null) return fallback;
    throw new Error(`Missing ${label}.`);
  }
  const text = String(value).trim();
  if (!text || text.length > maxLength) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

export function parseOptionalCountry(value: unknown): string | undefined {
  if (value == null || String(value).trim() === "") return undefined;
  const country = String(value).trim().toUpperCase();
  if (!isSupportedCountryCode(country)) {
    throw new Error("Invalid country.");
  }
  return country;
}

export function parsePopoffWindow(value: unknown): PopoffWindow {
  if (value == null || value === "") return "30d";
  if (value === "24h" || value === "3d" || value === "7d" || value === "30d") return value;
  throw new Error("Invalid popoff window.");
}

export function parseUserIds(value: unknown, max = MAX_BATCH_USERS): number[] {
  if (!Array.isArray(value)) throw new Error("Invalid userIds payload.");
  if (value.length > max) throw new Error(`User list is limited to ${max} users.`);
  return [...new Set(value.map((id) => parseOsuId(id, "user id")))];
}


export function parseHomePlayers(value: unknown, max = MAX_HOME_USERS): HomePreviewPlayer[] {
  if (!Array.isArray(value)) throw new Error("Invalid players payload.");
  if (value.length > max) throw new Error(`Player list is limited to ${max} users.`);

  const seen = new Set<number>();
  const players: HomePreviewPlayer[] = [];
  for (const raw of value) {
    const input = asInputRecord(raw);
    const id = parseOsuId(input.id, "player id");
    if (seen.has(id)) continue;
    seen.add(id);
    players.push({
      id,
      username: parseString(input.username, "username", 64, "Unknown"),
      avatar_url: String(input.avatar_url ?? "").slice(0, 512),
    });
  }
  return players;
}

export function parseTrackerUsers(value: unknown, max = MAX_BATCH_USERS): TrackerUserSummary[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Invalid users payload.");
  if (value.length > max) throw new Error(`User list is limited to ${max} users.`);

  const seen = new Set<number>();
  const users: TrackerUserSummary[] = [];
  for (const raw of value) {
    const input = asInputRecord(raw);
    const id = parseOsuId(input.id, "user id");
    if (seen.has(id)) continue;
    seen.add(id);
    users.push({
      id,
      username: parseString(input.username, "username", 64, "Unknown"),
      avatar_url: String(input.avatar_url ?? "").slice(0, 512),
      country_code: String(input.country_code ?? "").trim().toUpperCase().slice(0, 2),
    });
  }
  return users;
}

export function normalizeUserKeyPayload(data: unknown): { key: string } {
  const input = asInputRecord(data);
  return { key: parseString(input.key, "user key", 64) };
}

export function normalizeUserIdPayload(data: unknown): { userId: number } {
  const input = asInputRecord(data);
  return { userId: parseOsuId(input.userId, "user id") };
}

export function normalizeScoreListPayload(data: unknown): {
  userId: number;
  limit?: number;
  offset?: number;
  include_fails?: boolean;
} {
  const input = asInputRecord(data);
  return {
    userId: parseOsuId(input.userId, "user id"),
    limit: parseOptionalBoundedInt(input.limit, "limit", { min: 1, max: MAX_SCORE_LIMIT }),
    offset: parseOptionalBoundedInt(input.offset, "offset", { min: 0, max: MAX_SCORE_OFFSET }),
    include_fails: input.include_fails === true,
  };
}

export function normalizeBestWindowPayload(data: unknown): { userId: number; totalLimit?: number; parallel?: boolean } {
  const input = asInputRecord(data);
  return {
    userId: parseOsuId(input.userId, "user id"),
    totalLimit: parseBoundedInt(input.totalLimit, "totalLimit", {
      min: 1,
      max: MAX_BEST_WINDOW_LIMIT,
      fallback: 200,
    }),
    parallel: input.parallel === true,
  };
}

export function normalizeRankingsPayload(data: unknown): { type?: string; page?: number; country?: string } {
  const input = asInputRecord(data);
  const type = input.type == null || input.type === "" ? "performance" : String(input.type);
  if (!RANKING_TYPES.has(type)) throw new Error("Invalid ranking type.");
  return {
    type,
    page: parseBoundedInt(input.page, "page", { min: 1, max: 200, fallback: 1 }),
    country: parseOptionalCountry(input.country),
  };
}

export function normalizeCountryPayload(data: unknown): { country?: string } {
  const input = asInputRecord(data);
  return { country: parseOptionalCountry(input.country) };
}

export function normalizeHomeRecentScoresPayload(data: unknown): { userIds: number[] } {
  const input = asInputRecord(data);
  return { userIds: parseUserIds(input.userIds, MAX_HOME_USERS) };
}

export function normalizeHomePopoffsPayload(data: unknown): { players: HomePreviewPlayer[] } {
  const input = asInputRecord(data);
  return { players: parseHomePlayers(input.players, MAX_HOME_USERS) };
}

export function normalizeCountryPopoffsPayload(data: unknown): {
  country?: string;
  players: HomePreviewPlayer[];
  window?: PopoffWindow;
  refresh?: boolean;
} {
  const input = asInputRecord(data);
  return {
    country: parseOptionalCountry(input.country),
    players: parseHomePlayers(input.players, MAX_BATCH_USERS),
    window: parsePopoffWindow(input.window),
    refresh: input.refresh !== false,
  };
}

export function normalizeRankHistoryPayload(data: unknown): { userIds: number[] } {
  const input = asInputRecord(data);
  return { userIds: parseUserIds(input.userIds, MAX_BATCH_USERS) };
}

export function normalizeBeatmapSearchPayload(data: unknown): {
  query?: string;
  sort?: string;
  cursor_string?: string;
  status?: string;
} {
  const input = asInputRecord(data);
  const sort = input.sort == null || input.sort === "" ? "ranked_desc" : String(input.sort);
  const status = input.status == null || input.status === "" ? undefined : String(input.status);
  if (!BEATMAP_SORTS.has(sort)) throw new Error("Invalid beatmap sort.");
  if (status && !BEATMAP_STATUSES.has(status)) throw new Error("Invalid beatmap status.");
  return {
    query: input.query == null ? undefined : String(input.query).trim().slice(0, MAX_QUERY_LENGTH),
    sort,
    cursor_string: input.cursor_string == null
      ? undefined
      : String(input.cursor_string).slice(0, MAX_CURSOR_LENGTH),
    status,
  };
}

export function normalizeMapperSearchPayload(data: unknown): { usernames?: string[] } {
  const input = asInputRecord(data);
  const usernames = Array.isArray(input.usernames)
    ? input.usernames.map((username) => String(username).trim()).filter(Boolean).slice(0, 3)
    : [];
  return { usernames };
}

export function normalizeBeatmapsetPayload(data: unknown): { beatmapsetId: number } {
  const input = asInputRecord(data);
  return { beatmapsetId: parseOsuId(input.beatmapsetId, "beatmapset id") };
}

export function normalizeBeatmapPayload(data: unknown): { beatmapId: number } {
  const input = asInputRecord(data);
  return { beatmapId: parseOsuId(input.beatmapId, "beatmap id") };
}

export function normalizeBeatmapChecksumPayload(data: unknown): { checksum: string } {
  const input = asInputRecord(data);
  const checksum = String(input.checksum ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(checksum)) {
    throw new Error("Invalid beatmap checksum.");
  }
  return { checksum };
}

export function normalizeBeatmapScoresPayload(data: unknown): { beatmapId: number; country?: string; page: number } {
  const input = asInputRecord(data);
  const page = parseBoundedInt(input.page, "page", { min: 1, max: 2, fallback: 1 });
  return {
    beatmapId: parseOsuId(input.beatmapId, "beatmap id"),
    country: parseOptionalCountry(input.country),
    page,
  };
}

export function normalizeSearchUsersPayload(data: unknown): { query: string } {
  const input = asInputRecord(data);
  return { query: parseString(input.query, "query", 64) };
}

export function normalizeCountryRecentScoresPayload(data: unknown): {
  userIds: number[];
  users: TrackerUserSummary[];
  batchSize?: number;
  batchIndex?: number;
  recentLimit?: number;
  source?: "backfill" | "live";
} {
  const input = asInputRecord(data);
  const source = input.source == null || input.source === "" ? undefined : String(input.source);
  if (source != null && source !== "backfill" && source !== "live") {
    throw new Error("Invalid tracker score source.");
  }
  return {
    userIds: parseUserIds(input.userIds, MAX_BATCH_USERS),
    users: parseTrackerUsers(input.users, MAX_BATCH_USERS),
    batchSize: parseBoundedInt(input.batchSize, "batchSize", { min: 1, max: 50, fallback: 5 }),
    batchIndex: parseBoundedInt(input.batchIndex, "batchIndex", { min: 0, max: 500, fallback: 0 }),
    recentLimit: parseBoundedInt(input.recentLimit, "recentLimit", { min: 1, max: 100, fallback: 20 }),
    source: source as "backfill" | "live" | undefined,
  };
}

export function normalizeReplayParsedPayload(data: unknown): { scoreId: number; mode: string; keyCount?: number } {
  const input = asInputRecord(data);
  const mode = String(input.mode ?? "mania");
  if (!REPLAY_MODES.has(mode)) throw new Error("Invalid replay mode.");
  const keyCount = input.keyCount == null || input.keyCount === ""
    ? undefined
    : parseBoundedInt(input.keyCount, "keyCount", { min: 1, max: 18 });
  return {
    scoreId: parseOsuScoreId(input.scoreId, "score id"),
    mode,
    keyCount,
  };
}

export function normalizeScorePayload(data: unknown): { scoreId: number; mode?: string } {
  const input = asInputRecord(data);
  const mode = input.mode == null || input.mode === "" ? "mania" : String(input.mode);
  if (!REPLAY_MODES.has(mode)) throw new Error("Invalid score mode.");
  return { scoreId: parseOsuScoreId(input.scoreId, "score id"), mode };
}
