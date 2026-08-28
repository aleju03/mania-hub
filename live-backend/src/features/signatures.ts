// Dynamic renders: per-user signature images embedded by URL on osu! profiles.
//
// Two things live here. The opt-in record (a token that addresses a player's
// renders, plus which types they published), and the *version* that decides
// when a render is stale.
//
// The version is the whole design. A signature sits behind a URL the player
// pasted once and never edits, so freshness cannot ride in the URL the way
// OG_IMAGE_VERSION does. Instead every render is keyed by a version derived
// from stamps the ingest pipeline already writes, which means a re-render
// happens exactly once per real data change instead of on a timer. Nothing
// here adds bookkeeping to a write path; every column read below is one that
// already exists and is already maintained.

import { randomBytes, createHash } from "node:crypto";

import type { Db } from "../db.js";
import { exec } from "../db.js";
import type { JobQueue } from "../jobs/queue.js";
import {
  PROFILE_SNAPSHOT_REFRESH_JOB,
  PROFILE_SNAPSHOT_REFRESH_PRIORITY,
  PROFILE_USER_REFRESH_JOB,
  PROFILE_USER_REFRESH_PRIORITY,
} from "./player-profiles.js";

export const SIGNATURE_TYPES = ["insights", "goals", "skills", "dan", "maniacard"] as const;
export type SignatureType = (typeof SIGNATURE_TYPES)[number];

export interface SignatureRecord {
  userId: number;
  token: string;
  enabled: boolean;
  enabledTypes: SignatureType[];
  skillsKeyCount: number | null;
  /** Per-type look, owned and validated by the frontend. Opaque here. */
  styles: Record<string, unknown> | null;
  /** The player's own IANA zone, or null when their browser has never said.
      Null renders in UTC, which is what every row did before this existed. */
  timeZone: string | null;
  /** Set from the admin page. The player cannot clear it. */
  blockedAt: number | null;
  createdAt: number;
  updatedAt: number;
  rotatedAt: number | null;
}

/** One row of the moderation list. Deliberately carries no token: a moderator
    judges the background by its source url, and handing out the capability
    that addresses someone's renders is not part of that job. */
export interface SignatureAdminRow {
  userId: number;
  username: string;
  enabled: boolean;
  blockedAt: number | null;
  enabledTypes: SignatureType[];
  /** Every distinct player-supplied image url on the row, deduped. */
  customImageUrls: string[];
  /** How many times an admin has taken a background off this row. */
  clearedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedSignature {
  userId: number;
  username: string;
  enabledTypes: SignatureType[];
  skillsKeyCount: number | null;
  styles: Record<string, unknown> | null;
  timeZone: string | null;
  versions: Record<SignatureType, string>;
}

export type SignatureProfileRefreshKind = "snapshot" | "user";

// Match the normal country-roster cadence: a signature owner outside the
// ranked roster gets the same worst-case PP/rank freshness as a top-N member,
// without letting anonymous image traffic turn into an unbounded osu! poller.
export const SIGNATURE_PROFILE_REFRESH_MAX_AGE_MS = 6 * 60 * 60_000;

function nowMs(): number {
  return Date.now();
}

/* 24 random bytes, base64url. Not randomUUID: the dashes and the recognisable
   shape buy nothing, and this ends up in a URL people paste by hand. */
function mintToken(): string {
  return randomBytes(24).toString("base64url");
}

function parseTypes(raw: unknown): SignatureType[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is SignatureType =>
      typeof entry === "string" && (SIGNATURE_TYPES as readonly string[]).includes(entry));
  } catch {
    return [];
  }
}

export function normalizeSignatureTypes(input: unknown): SignatureType[] {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<SignatureType>();
  for (const entry of list) {
    if (typeof entry === "string" && (SIGNATURE_TYPES as readonly string[]).includes(entry)) {
      seen.add(entry as SignatureType);
    }
  }
  return SIGNATURE_TYPES.filter((type) => seen.has(type));
}

/* An IANA zone name, or null. Validated rather than trusted: this reaches a
   toLocaleDateString call in the render, and Intl throws a RangeError on a
   name it does not know - which would turn one bad string into a permanently
   failing image instead of a wrong date. Node carries the full tz database, so
   asking Intl whether it accepts the name IS the allowlist.

   Not stored uppercase or otherwise touched: the zone that comes back out has
   to be the one Intl was willing to take. */
export function normalizeTimeZone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  // Long enough for "America/Argentina/Buenos_Aires", short of anything that
  // is not a zone name.
  if (!value || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function parseStyles(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function rowToRecord(row: Record<string, unknown>): SignatureRecord {
  return {
    userId: Number(row.user_id),
    token: String(row.token),
    enabled: Number(row.enabled ?? 0) === 1,
    enabledTypes: parseTypes(row.enabled_types_json),
    skillsKeyCount: row.skills_key_count == null ? null : Number(row.skills_key_count),
    styles: parseStyles(row.style_json),
    timeZone: normalizeTimeZone(row.time_zone),
    blockedAt: row.blocked_at == null ? null : Number(row.blocked_at),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    rotatedAt: row.rotated_at == null ? null : Number(row.rotated_at),
  };
}

/** Pulls every player-supplied background url out of a stored style map. */
function customImageUrls(styles: Record<string, unknown> | null): string[] {
  if (!styles) return [];
  const found = new Set<string>();
  for (const value of Object.values(styles)) {
    const style = value as { background?: unknown; imageUrl?: unknown } | null;
    if (style?.background === "custom" && typeof style.imageUrl === "string" && style.imageUrl) {
      found.add(style.imageUrl);
    }
  }
  return [...found];
}

export async function getUserSignature(db: Db, userId: number): Promise<SignatureRecord | null> {
  const row = (await exec(db, "select * from user_signatures where user_id = ?", [userId])).rows[0];
  return row ? rowToRecord(row as Record<string, unknown>) : null;
}

/* Enabling is idempotent and keeps the existing token: a player who turns
   signatures off and on again gets the same URL back, so an embed already
   pasted into a profile starts working again instead of silently staying
   broken. Rotating is the deliberate break. */
export async function enableUserSignature(
  db: Db,
  userId: number,
  types: SignatureType[],
  skillsKeyCount: number | null,
  // undefined leaves the stored style alone, so publishing a type does not
  // silently reset how every render looks. Only an explicit string writes.
  styleJson?: string | null,
  /* Same rule: undefined leaves the stored zone alone. Only the page sends one
     (the browser is the only thing that knows it), so a call that came from
     anywhere else must not blank it out. */
  timeZone?: string | null,
): Promise<SignatureRecord> {
  const existing = await getUserSignature(db, userId);
  const now = nowMs();
  const token = existing?.token ?? mintToken();
  const typesJson = JSON.stringify(types);
  if (existing) {
    /* Built rather than branched: with style and zone each independently
       present-or-absent, spelling out the four statements was already the
       longer way to write it at two. */
    const sets = ["enabled = 1", "enabled_types_json = ?", "skills_key_count = ?"];
    const params: (string | number | null)[] = [typesJson, skillsKeyCount];
    if (styleJson !== undefined) {
      sets.push("style_json = ?");
      params.push(styleJson);
    }
    if (timeZone !== undefined) {
      sets.push("time_zone = ?");
      params.push(timeZone);
    }
    sets.push("updated_at = ?");
    params.push(now, userId);
    await exec(db, `update user_signatures set ${sets.join(", ")} where user_id = ?`, params);
  } else {
    await exec(
      db,
      `insert into user_signatures (user_id, token, enabled, enabled_types_json, skills_key_count, style_json, time_zone, created_at, updated_at)
       values (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [userId, token, typesJson, skillsKeyCount, styleJson ?? null, timeZone ?? null, now, now],
    );
  }
  return (await getUserSignature(db, userId))!;
}

/* The zone on its own, for the page telling us what the browser reports rather
   than the player changing anything. Separate from enableUserSignature because
   it must not touch `enabled`: a player who turned their signature off and
   then opened the page would otherwise have it turned back on by a background
   write they never asked for.

   No-ops when the stored value already matches, so the common case (opening
   the page again from the same country) is a read and nothing else - and,
   more to the point, does not move updated_at and re-render an identical image. */
export async function setUserSignatureTimeZone(
  db: Db,
  userId: number,
  timeZone: string | null,
): Promise<SignatureRecord | null> {
  const existing = await getUserSignature(db, userId);
  if (!existing) return null;
  if (existing.timeZone === timeZone) return existing;
  await exec(
    db,
    "update user_signatures set time_zone = ?, updated_at = ? where user_id = ?",
    [timeZone, nowMs(), userId],
  );
  return await getUserSignature(db, userId);
}

export async function disableUserSignature(db: Db, userId: number): Promise<boolean> {
  const result = await exec(
    db,
    "update user_signatures set enabled = 0, updated_at = ? where user_id = ?",
    [nowMs(), userId],
  );
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function rotateUserSignatureToken(db: Db, userId: number): Promise<SignatureRecord | null> {
  const existing = await getUserSignature(db, userId);
  if (!existing) return null;
  const now = nowMs();
  await exec(
    db,
    "update user_signatures set token = ?, rotated_at = ?, updated_at = ? where user_id = ?",
    [mintToken(), now, now, userId],
  );
  return await getUserSignature(db, userId);
}

/* The moderation surface. Newest first, because what a moderator wants is what
   changed since they last looked. Bounded rather than paged: this lists opted-in
   players, not scores, and a cap keeps one query from ever being the expensive
   thing on the box. */
export async function listSignaturesForAdmin(
  db: Db,
  options: { customOnly?: boolean; limit?: number } = {},
): Promise<SignatureAdminRow[]> {
  const limit = Math.min(500, Math.max(1, options.limit ?? 200));
  const result = await exec(
    db,
    `select s.user_id, s.enabled, s.enabled_types_json, s.style_json, s.blocked_at,
            s.cleared_count, s.created_at, s.updated_at, u.username
       from user_signatures s
       left join users u on u.user_id = s.user_id
      -- user_id breaks the tie: several rows can share a millisecond, and an
      -- arbitrary order there makes the list reshuffle between refreshes.
      order by s.updated_at desc, s.user_id desc
      limit ?`,
    [limit],
  );
  const rows = result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      userId: Number(row.user_id),
      username: String(row.username ?? ""),
      enabled: Number(row.enabled ?? 0) === 1,
      blockedAt: row.blocked_at == null ? null : Number(row.blocked_at),
      enabledTypes: parseTypes(row.enabled_types_json),
      customImageUrls: customImageUrls(parseStyles(row.style_json)),
      clearedCount: Number(row.cleared_count ?? 0),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };
  });
  return options.customOnly ? rows.filter((row) => row.customImageUrls.length > 0) : rows;
}

/* What a caller needs to erase a signature's live copies: the token addresses
   the URLs an edge cache holds, and the versions address the stored renders in
   R2. Read BEFORE a change that moves versions, or it names the wrong objects.

   This is the one place a token leaves the moderation path, and it goes to the
   frontend server function only - never to a browser, and never onto the
   admin list, which stays token-free. */
export interface SignaturePurgeTarget {
  token: string;
  versions: Record<SignatureType, string>;
}

export async function getSignaturePurgeTarget(db: Db, userId: number): Promise<SignaturePurgeTarget | null> {
  const record = await getUserSignature(db, userId);
  if (!record) return null;
  return { token: record.token, versions: await buildVersions(db, userId, record.styles, record.timeZone) };
}

/** The kill switch. Blocking does not touch `enabled`, so unblocking restores
    whatever the player had rather than silently turning their signature on. */
export async function setSignatureBlocked(db: Db, userId: number, blocked: boolean): Promise<boolean> {
  const result = await exec(
    db,
    "update user_signatures set blocked_at = ?, updated_at = ? where user_id = ?",
    [blocked ? nowMs() : null, nowMs(), userId],
  );
  return Number(result.rowsAffected ?? 0) > 0;
}

/* The proportionate action for a bad background: the signature itself is
   usually fine, one picture is not. Dropping the url moves every affected
   type's version, so the stored renders are superseded rather than lingering
   until something else about the player changes. */
export async function clearSignatureImages(db: Db, userId: number): Promise<boolean> {
  const existing = await getUserSignature(db, userId);
  if (!existing?.styles) return false;
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [type, value] of Object.entries(existing.styles)) {
    const style = { ...(value as Record<string, unknown>) };
    if (style.background === "custom") {
      style.background = "none";
      changed = true;
    }
    if (style.imageUrl) {
      style.imageUrl = null;
      changed = true;
    }
    next[type] = style;
  }
  if (!changed) return false;
  await exec(
    db,
    "update user_signatures set style_json = ?, cleared_count = cleared_count + 1, updated_at = ? where user_id = ?",
    [JSON.stringify(next), nowMs(), userId],
  );
  return true;
}

function hashVersion(parts: unknown[]): string {
  return createHash("sha1").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex").slice(0, 12);
}

/* Key-sorted so two identical styles cannot hash differently and re-render for
   nothing. The frontend already serializes in a fixed order; this makes the
   version independent of that rather than dependent on it. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/* A type's own style is part of its version, so changing a background
   supersedes that render the same way a new score does - and only that one.
   Hashing the whole map into every type would re-render all four because the
   goals background moved. */
function styleStamp(styles: Record<string, unknown> | null, type: SignatureType): string {
  return canonicalJson(styles?.[type] ?? null);
}

/* Version derivation. Each type reads only the stamps its own image draws
   from, so a goal edit does not invalidate a maniacard render.

   The stamps are hashed rather than passed through: the frontend only ever
   compares versions for equality, and an opaque fixed-length token keeps
   internal timestamps off a public wire. */
async function buildVersions(
  db: Db,
  userId: number,
  styles: Record<string, unknown> | null,
  timeZone: string | null,
): Promise<Record<SignatureType, string>> {
  // No global_rank: nothing on a signature draws a rank any more, and rank
  // moves for an active player constantly, so keeping it here would re-render
  // images whose pixels cannot change. pp stays because card power is computed
  // from it.
  const userRow = (await exec(
    db,
    "select updated_at, top_scores_refreshed_at, pp from users where user_id = ?",
    [userId],
  )).rows[0] as Record<string, unknown> | undefined;

  const snapshotRow = (await exec(
    db,
    "select updated_at from profile_snapshots where user_id = ?",
    [userId],
  )).rows[0] as Record<string, unknown> | undefined;

  // computed_at, not updated_at: computePlayerSkillsJob stamps updated_at when
  // it flips status to 'running', which would bump the version with no new
  // data behind it and re-render the identical image.
  const skillsRow = (await exec(
    db,
    "select status, computed_at, updated_at from player_skill_ratings where user_id = ? order by analysis_version desc limit 1",
    [userId],
  )).rows[0] as Record<string, unknown> | undefined;

  // GoalProgress is computed live by listUserGoalsWithProgress and never
  // written back, so max(user_goals.updated_at) alone would never move when a
  // player's pp climbs and a progress bar advances. The play-side stamps are
  // what make a goals render actually track its own bars. Completed rows stay
  // in the picture as history, so the row stamp covers every status.
  const goalRow = (await exec(
    db,
    "select count(*) as goal_count, max(updated_at) as newest from user_goals where user_id = ?",
    [userId],
  )).rows[0] as Record<string, unknown> | undefined;

  const lastScoreRow = (await exec(
    db,
    "select ended_at from score_events where user_id = ? order by ended_at desc limit 1",
    [userId],
  )).rows[0] as Record<string, unknown> | undefined;

  const userStamp = String(userRow?.updated_at ?? "");
  const topScoresStamp = String(userRow?.top_scores_refreshed_at ?? "");
  // getCachedPlayerProfileSnapshot falls back to stored top scores when there
  // is no snapshot row, which is the normal state for an opted-in player who
  // is not on a tracked roster, so both sources belong in the maniacard key.
  const maniacard = hashVersion([
    "m", snapshotRow?.updated_at, userStamp, topScoresStamp, userRow?.pp,
    styleStamp(styles, "maniacard"),
  ]);
  const skillsStamp = skillsRow?.computed_at ?? skillsRow?.updated_at;
  const skills = hashVersion(["s", skillsRow?.status, skillsStamp, styleStamp(styles, "skills")]);
  // Dan reads the same rating row as skills but is styled on its own, so it
  // cannot simply reuse the skills version any more.
  const dan = hashVersion(["d", skillsRow?.status, skillsStamp, styleStamp(styles, "dan")]);
  const goals = hashVersion([
    "g", goalRow?.goal_count, goalRow?.newest, userStamp, topScoresStamp, lastScoreRow?.ended_at,
    styleStamp(styles, "goals"), timeZone,
  ]);
  /* Same top-play window the maniacard reads, plus the last score event. The
     card power a maniacard prints is a slow aggregate, but an insights render
     names the player's NEWEST top play - and projectTopPlays overlays live
     score events onto the stored window, so that line can be right before the
     snapshot itself is rewritten. Without the event stamp the one reading the
     image exists to show would be the last to move. No pp: nothing here is
     computed from it. */
  /* The zone is in here because the insights card prints a play date, and the
     goals card now prints completion dates. The same instant is a different
     day either side of midnight, so each dated render owns the zone stamp. */
  const insights = hashVersion([
    "i", snapshotRow?.updated_at, userStamp, topScoresStamp, lastScoreRow?.ended_at,
    styleStamp(styles, "insights"), timeZone,
  ]);

  return { maniacard, goals, skills, dan, insights };
}

export async function resolveSignatureToken(db: Db, token: string): Promise<ResolvedSignature | null> {
  const row = (await exec(
    db,
    "select user_id, enabled, enabled_types_json, skills_key_count, style_json, time_zone, blocked_at from user_signatures where token = ?",
    [token],
  )).rows[0] as Record<string, unknown> | undefined;
  // A blocked row is indistinguishable from an unknown token from here on: the
  // route turns a null resolve into the same 404 it gives a guessed one.
  if (!row || Number(row.enabled ?? 0) !== 1 || row.blocked_at != null) return null;

  const userId = Number(row.user_id);
  const userRow = (await exec(db, "select username from users where user_id = ?", [userId])).rows[0] as
    Record<string, unknown> | undefined;
  const styles = parseStyles(row.style_json);
  const timeZone = normalizeTimeZone(row.time_zone);

  return {
    userId,
    username: String(userRow?.username ?? ""),
    enabledTypes: parseTypes(row.enabled_types_json),
    skillsKeyCount: row.skills_key_count == null ? null : Number(row.skills_key_count),
    styles,
    timeZone,
    versions: await buildVersions(db, userId, styles, timeZone),
  };
}

/**
 * Dynamic-render freshness for tracked players outside the ranked roster.
 *
 * A valid signature resolve is the cheapest demand signal available: if no
 * browser or embed asks for the image, stale pixels cost nothing and neither
 * should osu! calls. The read only enqueues existing profile jobs, and the
 * per-user job key collapses requests from multiple variants/edges.
 *
 * Insights and maniacards need the authoritative best-200 as well as the user
 * payload, so they receive a full snapshot refresh. A goals-only signature
 * needs one cheap /users call, and only while a stat-shaped goal is open.
 * Skills and dan already refresh from the tracked session pipeline.
 */
export async function enqueueSignatureProfileRefreshIfDue(
  db: Db,
  queue: Pick<JobQueue, "enqueue">,
  signature: Pick<ResolvedSignature, "userId" | "enabledTypes">,
  options: { maxAgeMs?: number; nowMs?: number } = {},
): Promise<SignatureProfileRefreshKind | null> {
  const userId = Math.floor(Number(signature.userId));
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;

  const row = (await exec(
    db,
    `select
       ps.fetched_at,
       ps.user_fetched_at,
       exists(
         select 1 from country_rosters tracked
         where tracked.user_id = subject.user_id
           and tracked.is_tracked = 1
           and tracked.rank is null
       ) as is_tracked_unranked,
       exists(
         select 1 from country_rosters ranked
         where ranked.user_id = subject.user_id
           and ranked.is_tracked = 1
           and ranked.rank is not null
       ) as is_ranked,
       exists(
         select 1 from user_goals goal
         where goal.user_id = subject.user_id
           and goal.status = 'open'
           and goal.kind in ('reach_pp', 'reach_rank')
       ) as has_open_stat_goal
     from (select ? as user_id) subject
     left join profile_snapshots ps on ps.user_id = subject.user_id`,
    [userId],
  )).rows[0];

  // Ranked members already get roster and top-play refreshes. A rank-null row
  // is the deliberate personal-tracking scope (manual opt-in or score-sourced).
  if (!Number(row?.is_tracked_unranked) || Number(row?.is_ranked)) return null;

  const maxAgeInput = Number(options.maxAgeMs ?? SIGNATURE_PROFILE_REFRESH_MAX_AGE_MS);
  const maxAgeMs = Number.isFinite(maxAgeInput)
    ? Math.max(60_000, Math.floor(maxAgeInput))
    : SIGNATURE_PROFILE_REFRESH_MAX_AGE_MS;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const isDue = (stamp: unknown): boolean => {
    if (typeof stamp !== "string" || !stamp) return true;
    const at = Date.parse(stamp);
    return !Number.isFinite(at) || nowMs - at >= maxAgeMs;
  };

  const needsFullSnapshot = signature.enabledTypes.includes("insights")
    || signature.enabledTypes.includes("maniacard");
  const hasSnapshot = typeof row?.fetched_at === "string" && row.fetched_at.length > 0;
  if (needsFullSnapshot && (!hasSnapshot || isDue(row.fetched_at) || isDue(row.user_fetched_at))) {
    await queue.enqueue(
      PROFILE_SNAPSHOT_REFRESH_JOB,
      `${PROFILE_SNAPSHOT_REFRESH_JOB}:${userId}`,
      { userId },
      { priority: PROFILE_SNAPSHOT_REFRESH_PRIORITY, replaceDone: true },
    );
    return "snapshot";
  }

  const needsStatGoalRefresh = signature.enabledTypes.includes("goals")
    && Number(row?.has_open_stat_goal) === 1;
  if (needsStatGoalRefresh && (!hasSnapshot || isDue(row.user_fetched_at))) {
    // The user-only worker requires a stored snapshot row. A cold owner needs
    // the full mint once; subsequent stat refreshes stay on the one-call path.
    const type = hasSnapshot ? PROFILE_USER_REFRESH_JOB : PROFILE_SNAPSHOT_REFRESH_JOB;
    const priority = hasSnapshot ? PROFILE_USER_REFRESH_PRIORITY : PROFILE_SNAPSHOT_REFRESH_PRIORITY;
    await queue.enqueue(
      type,
      `${type}:${userId}`,
      { userId },
      { priority, replaceDone: true },
    );
    return hasSnapshot ? "user" : "snapshot";
  }

  return null;
}
