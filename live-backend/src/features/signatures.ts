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

export const SIGNATURE_TYPES = ["maniacard", "goals", "skills", "dan"] as const;
export type SignatureType = (typeof SIGNATURE_TYPES)[number];

export interface SignatureRecord {
  userId: number;
  token: string;
  enabled: boolean;
  enabledTypes: SignatureType[];
  skillsKeyCount: number | null;
  /** Per-type look, owned and validated by the frontend. Opaque here. */
  styles: Record<string, unknown> | null;
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
  versions: Record<SignatureType, string>;
}

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
): Promise<SignatureRecord> {
  const existing = await getUserSignature(db, userId);
  const now = nowMs();
  const token = existing?.token ?? mintToken();
  const typesJson = JSON.stringify(types);
  if (existing) {
    if (styleJson === undefined) {
      await exec(
        db,
        "update user_signatures set enabled = 1, enabled_types_json = ?, skills_key_count = ?, updated_at = ? where user_id = ?",
        [typesJson, skillsKeyCount, now, userId],
      );
    } else {
      await exec(
        db,
        "update user_signatures set enabled = 1, enabled_types_json = ?, skills_key_count = ?, style_json = ?, updated_at = ? where user_id = ?",
        [typesJson, skillsKeyCount, styleJson, now, userId],
      );
    }
  } else {
    await exec(
      db,
      `insert into user_signatures (user_id, token, enabled, enabled_types_json, skills_key_count, style_json, created_at, updated_at)
       values (?, ?, 1, ?, ?, ?, ?, ?)`,
      [userId, token, typesJson, skillsKeyCount, styleJson ?? null, now, now],
    );
  }
  return (await getUserSignature(db, userId))!;
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
  return { token: record.token, versions: await buildVersions(db, userId, record.styles) };
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
  // what make a goals render actually track its own bars.
  const goalRow = (await exec(
    db,
    "select count(*) as open_count, max(updated_at) as newest from user_goals where user_id = ? and status = 'open'",
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
    "g", goalRow?.open_count, goalRow?.newest, userStamp, topScoresStamp, lastScoreRow?.ended_at,
    styleStamp(styles, "goals"),
  ]);

  return { maniacard, goals, skills, dan };
}

export async function resolveSignatureToken(db: Db, token: string): Promise<ResolvedSignature | null> {
  const row = (await exec(
    db,
    "select user_id, enabled, enabled_types_json, skills_key_count, style_json, blocked_at from user_signatures where token = ?",
    [token],
  )).rows[0] as Record<string, unknown> | undefined;
  // A blocked row is indistinguishable from an unknown token from here on: the
  // route turns a null resolve into the same 404 it gives a guessed one.
  if (!row || Number(row.enabled ?? 0) !== 1 || row.blocked_at != null) return null;

  const userId = Number(row.user_id);
  const userRow = (await exec(db, "select username from users where user_id = ?", [userId])).rows[0] as
    Record<string, unknown> | undefined;
  const styles = parseStyles(row.style_json);

  return {
    userId,
    username: String(userRow?.username ?? ""),
    enabledTypes: parseTypes(row.enabled_types_json),
    skillsKeyCount: row.skills_key_count == null ? null : Number(row.skills_key_count),
    styles,
    versions: await buildVersions(db, userId, styles),
  };
}
