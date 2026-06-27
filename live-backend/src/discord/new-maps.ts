import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { nowIso } from "../shared/score.js";

// "New farm map" detection. A map qualifies when a recently ranked beatmap
// starts producing confirmed PP gains for multiple distinct tracked players.
// We read the ranked date from stored beatmapset metadata (the osu! API
// beatmapset object carries `ranked_date`); when it is missing we skip rather
// than guess, so the alert never fires on an old map.

const HOUR_MS = 60 * 60 * 1000;
const TOP_PLAY_BEATMAP_ID_EXPR = "cast(case when json_valid(payload_json) then coalesce(json_extract(payload_json, '$.score.beatmap_id'), json_extract(payload_json, '$.score.beatmap.id')) end as integer)";

// Parses the ranked date for a beatmapset from its stored metadata. Returns the
// epoch milliseconds, or null when unknown / unparseable.
export async function getBeatmapsetRankedAt(db: Db, beatmapsetId: number): Promise<number | null> {
  if (!Number.isFinite(beatmapsetId) || beatmapsetId <= 0) return null;
  const result = await exec(db, "select metadata_json from beatmapsets where beatmapset_id = ?", [beatmapsetId]);
  const meta = parseJson(result.rows[0]?.metadata_json, null) as { ranked_date?: unknown } | null;
  const raw = meta?.ranked_date;
  if (typeof raw !== "string" || !raw) return null;
  return parseTimestamp(raw);
}

export interface BeatmapRankedInfo {
  beatmapsetId: number;
  status: string | null;
  rankedAtMs: number | null;
  title: string | null;
  artist: string | null;
  version: string | null;
  difficultyRating: number | null;
  cs: number | null;
  coverUrl: string | null;
}

// Beatmap status plus the beatmapset ranked date, used to decide whether a
// freshly farmed map qualifies as a "new farm map". Event-log top_play payloads
// may be compact, so this helper also returns display metadata from the DB.
export async function getBeatmapRankedInfo(db: Db, beatmapId: number, beatmapsetId: number): Promise<BeatmapRankedInfo | null> {
  if (!Number.isFinite(beatmapId) || beatmapId <= 0) return null;
  const result = await exec(
    db,
    `select
       b.beatmapset_id,
       b.status,
       b.metadata_json,
       b.cs,
       b.difficulty_rating,
       b.version,
       s.title,
       s.artist,
       s.status as beatmapset_status,
       s.covers_json,
       s.metadata_json as beatmapset_metadata_json
     from beatmaps b
     left join beatmapsets s on s.beatmapset_id = b.beatmapset_id
     where b.beatmap_id = ?`,
    [beatmapId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const meta = parseJson(row?.metadata_json, null) as { status?: unknown } | null;
  const resolvedBeatmapsetId = Number.isFinite(beatmapsetId) && beatmapsetId > 0
    ? beatmapsetId
    : Number(row?.beatmapset_id ?? 0);
  const status = typeof meta?.status === "string" && meta.status
    ? meta.status
    : row?.status == null ? row?.beatmapset_status == null ? null : String(row.beatmapset_status) : String(row.status);
  const setMeta = parseJson(row?.beatmapset_metadata_json, null) as { ranked_date?: unknown } | null;
  const rawRankedDate = setMeta?.ranked_date;
  const rankedAtMs = typeof rawRankedDate === "string" && rawRankedDate
    ? parseTimestamp(rawRankedDate)
    : await getBeatmapsetRankedAt(db, resolvedBeatmapsetId);
  const covers = parseJson<Record<string, string | undefined>>(row?.covers_json, {});
  return {
    beatmapsetId: resolvedBeatmapsetId,
    status,
    rankedAtMs,
    title: row?.title == null ? null : String(row.title),
    artist: row?.artist == null ? null : String(row.artist),
    version: row?.version == null ? null : String(row.version),
    difficultyRating: finiteNumber(row?.difficulty_rating),
    cs: finiteNumber(row?.cs),
    coverUrl: covers["cover@2x"] ?? covers.cover ?? covers["card@2x"] ?? covers.card ?? null,
  };
}

export function isWithinRecency(rankedAtMs: number | null, nowMs: number, windowDays: number): boolean {
  if (rankedAtMs == null) return false;
  if (rankedAtMs > nowMs + 24 * 60 * 60 * 1000) return false; // guard clock skew / bad data
  return nowMs - rankedAtMs <= windowDays * 24 * 60 * 60 * 1000;
}

export interface FarmMapSignalOptions {
  windowHours: number;
  minUsers: number;
  minPpGain: number;
  nowMs?: number;
}

export interface FarmMapSignal {
  beatmapId: number;
  userCount: number;
  playCount: number;
  totalPpGain: number;
  maxPp: number | null;
  latestDetectedAt: string | null;
  qualifies: boolean;
}

export async function getFarmMapSignal(db: Db, beatmapId: number, options: FarmMapSignalOptions): Promise<FarmMapSignal> {
  const empty = emptyFarmMapSignal(beatmapId);
  if (!Number.isFinite(beatmapId) || beatmapId <= 0) return empty;
  const rawWindowHours = Number(options.windowHours);
  const rawMinUsers = Number(options.minUsers);
  const windowHours = Number.isFinite(rawWindowHours) ? Math.max(1, Math.floor(rawWindowHours)) : 1;
  const minUsers = Number.isFinite(rawMinUsers) ? Math.max(1, Math.floor(rawMinUsers)) : 1;
  const rawMinPpGain = Number(options.minPpGain);
  const minPpGain = Number.isFinite(rawMinPpGain) ? Math.max(0, rawMinPpGain) : 0;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const cutoff = new Date(nowMs - windowHours * HOUR_MS).toISOString();
  const result = await exec(
    db,
    `select
       count(distinct user_id) as user_count,
       count(*) as play_count,
       coalesce(sum(pp_gain), 0) as total_pp_gain,
       max(pp) as max_pp,
       max(detected_at) as latest_detected_at
     from top_play_events
     where detected_at >= ?
       and pp_gain >= ?
       and ${TOP_PLAY_BEATMAP_ID_EXPR} = ?`,
    [cutoff, minPpGain, beatmapId],
  );
  const row = result.rows[0] ?? {};
  const userCount = Number(row.user_count ?? 0);
  return {
    beatmapId,
    userCount,
    playCount: Number(row.play_count ?? 0),
    totalPpGain: Number(row.total_pp_gain ?? 0),
    maxPp: row.max_pp == null ? null : Number(row.max_pp),
    latestDetectedAt: row.latest_detected_at == null ? null : String(row.latest_detected_at),
    qualifies: userCount >= minUsers,
  };
}

// Records that we alerted on a beatmap. Returns true only the first time, so
// each newly ranked difficulty fires at most one alert across all destinations.
export async function claimMapAlert(db: Db, beatmapId: number): Promise<boolean> {
  const result = await exec(
    db,
    "insert or ignore into discord_alerted_maps (beatmap_id, alerted_at) values (?, ?)",
    [beatmapId, nowIso()],
  );
  return Number(result.rowsAffected ?? 0) > 0;
}

function parseTimestamp(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function emptyFarmMapSignal(beatmapId: number): FarmMapSignal {
  return {
    beatmapId,
    userCount: 0,
    playCount: 0,
    totalPpGain: 0,
    maxPp: null,
    latestDetectedAt: null,
    qualifies: false,
  };
}
