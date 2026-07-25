import crypto from "node:crypto";
import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { nowIso } from "../shared/score.js";
import { slugifySkinName } from "../skins/slug.js";

// Community skin uploads. The upload ticket is the pending row itself:
// createPendingSkin mints upload_token + token_expires_at, the browser attaches
// the .osk / preview / screenshots against that token, and finishSkin publishes.
// Keymodes and the accent colour come from server-side skin.ini validation.

export const SKIN_MAX_PER_USER = 30;
export const SKIN_MAX_PENDING_PER_USER = 2;
export const SKIN_MAX_SCREENSHOTS = 4;
export const SKIN_TOKEN_TTL_MS = 30 * 60_000;
export const SKIN_NAME_MAX_LENGTH = 80;
export const SKIN_AUTHOR_MAX_LENGTH = 64;
export const SKIN_DESCRIPTION_MAX_LENGTH = 500;
const SKIN_LIST_MAX_PAGE_SIZE = 50;

export interface SkinScreenshot {
  key: string;
  url: string;
  width: number | null;
  height: number | null;
}

export interface SkinKeymodePreview extends SkinScreenshot {
  keys: number;
}

export interface SkinRow {
  id: string;
  slug: string | null;
  ownerUserId: number;
  ownerUsername: string;
  name: string;
  // Who made the skin (skin.ini Author or uploader-provided); distinct from
  // the uploader.
  author: string | null;
  description: string | null;
  keymodes: number[];
  accentColor: string | null;
  downloadCount: number;
  status: "pending" | "published" | "hidden";
  uploadToken: string | null;
  tokenExpiresAt: string | null;
  oskKey: string | null;
  oskUrl: string | null;
  oskSizeBytes: number | null;
  oskSha256: string | null;
  previewKey: string | null;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  previews: SkinKeymodePreview[];
  screenshots: SkinScreenshot[];
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface SkinSummary {
  id: string;
  slug: string | null;
  name: string;
  author: string | null;
  description: string | null;
  ownerUserId: number;
  ownerUsername: string;
  keymodes: number[];
  accentColor: string | null;
  downloadCount: number;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  previews: Array<{ keys: number; url: string; width: number | null; height: number | null }>;
  screenshots: Array<{ url: string; width: number | null; height: number | null }>;
  oskUrl: string | null;
  oskSizeBytes: number | null;
  oskSha256: string | null;
  status: "pending" | "published" | "hidden";
  publishedAt: string | null;
}

export type CreatePendingSkinResult =
  | { ok: true; id: string; token: string; expiresAt: string }
  | { ok: false; error: "invalid_name" | "pending_limit" | "skin_limit" };

export async function createPendingSkin(
  db: Db,
  input: { ownerUserId: number; ownerUsername: string; name: string; author?: string | null; description?: string | null },
): Promise<CreatePendingSkinResult> {
  const name = cleanText(input.name, SKIN_NAME_MAX_LENGTH);
  if (!name) return { ok: false, error: "invalid_name" };
  const ownerUsername = cleanText(input.ownerUsername, 32) || `user ${input.ownerUserId}`;
  const author = cleanText(input.author ?? "", SKIN_AUTHOR_MAX_LENGTH) || null;
  const description = cleanMultilineText(input.description ?? "", SKIN_DESCRIPTION_MAX_LENGTH) || null;

  const counts = (await exec(
    db,
    `select
       count(*) as total,
       sum(case when status = 'pending' then 1 else 0 end) as pending
     from skins where owner_user_id = ?`,
    [input.ownerUserId],
  )).rows[0];
  if (Number(counts?.pending ?? 0) >= SKIN_MAX_PENDING_PER_USER) return { ok: false, error: "pending_limit" };
  if (Number(counts?.total ?? 0) >= SKIN_MAX_PER_USER) return { ok: false, error: "skin_limit" };

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString("base64url");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + SKIN_TOKEN_TTL_MS).toISOString();
  await exec(
    db,
    `insert into skins (
       id, owner_user_id, owner_username, name, author, description, search_text,
       status, upload_token, token_expires_at, created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [id, input.ownerUserId, ownerUsername, name, author, description, buildSearchText(name, ownerUsername, author), token, expiresAt, now, now],
  );
  return { ok: true, id, token, expiresAt };
}

export async function getSkinForUpload(db: Db, id: string, token: string): Promise<SkinRow | null> {
  const row = await getSkin(db, id);
  if (!row || row.status !== "pending" || !row.uploadToken || !row.tokenExpiresAt) return null;
  if (!tokenMatches(row.uploadToken, token)) return null;
  if (row.tokenExpiresAt <= new Date().toISOString()) return null;
  return row;
}

// accent_color coalesces: the .osk uploads last, and its skin.ini colour must
// not clobber a sampled accent already set by the preview upload.
export async function attachSkinOsk(
  db: Db,
  skin: SkinRow,
  patch: { key: string; url: string; sizeBytes: number; sha256: string; keymodes: number[]; accentColor: string | null; iniAuthor: string | null },
): Promise<void> {
  // An author typed in the upload form wins; skin.ini's Author fills the gap.
  const author = skin.author ?? (cleanText(patch.iniAuthor ?? "", SKIN_AUTHOR_MAX_LENGTH) || null);
  await exec(
    db,
    `update skins set
       osk_key = ?, osk_url = ?, osk_size_bytes = ?, osk_sha256 = ?,
       keymodes_json = ?, accent_color = coalesce(accent_color, ?),
       author = ?, search_text = ?, updated_at = ?
     where id = ?`,
    [patch.key, patch.url, patch.sizeBytes, patch.sha256, JSON.stringify(patch.keymodes), patch.accentColor,
     author, buildSearchText(skin.name, skin.ownerUsername, author), nowIso(), skin.id],
  );
}

export async function attachSkinPreview(
  db: Db,
  id: string,
  patch: { key: string; url: string; width: number | null; height: number | null },
): Promise<void> {
  await exec(
    db,
    "update skins set preview_key = ?, preview_url = ?, preview_width = ?, preview_height = ?, updated_at = ? where id = ?",
    [patch.key, patch.url, patch.width, patch.height, nowIso(), id],
  );
}

// The uploader samples the accent from the note art while rendering previews;
// that beats the skin.ini colours attachSkinOsk parses (often black or wrong).
export async function setSkinAccent(db: Db, id: string, accentColor: string): Promise<void> {
  if (!/^#[0-9a-f]{6}$/i.test(accentColor)) return;
  await exec(
    db,
    "update skins set accent_color = ?, updated_at = ? where id = ?",
    [accentColor.toLowerCase(), nowIso(), id],
  );
}

export type UpsertPreviewResult = { ok: true } | { ok: false; error: "preview_limit" | "not_found" };

// One playfield preview per keymode; re-uploading the same keymode replaces
// its entry. When isCover is set the entry also becomes the card cover.
export async function upsertSkinKeymodePreview(
  db: Db,
  id: string,
  entry: SkinKeymodePreview,
  isCover: boolean,
): Promise<UpsertPreviewResult> {
  const row = await getSkin(db, id);
  if (!row) return { ok: false, error: "not_found" };
  const next = [...row.previews.filter((preview) => preview.keys !== entry.keys), entry]
    .sort((a, b) => a.keys - b.keys);
  if (next.length > 10) return { ok: false, error: "preview_limit" };
  await exec(
    db,
    "update skins set previews_json = ?, updated_at = ? where id = ?",
    [JSON.stringify(next), nowIso(), id],
  );
  if (isCover) await attachSkinPreview(db, id, entry);
  return { ok: true };
}

export type AppendScreenshotResult =
  | { ok: true; index: number }
  | { ok: false; error: "screenshot_limit" | "not_found" };

export async function appendSkinScreenshot(db: Db, id: string, entry: SkinScreenshot): Promise<AppendScreenshotResult> {
  const row = await getSkin(db, id);
  if (!row) return { ok: false, error: "not_found" };
  if (row.screenshots.length >= SKIN_MAX_SCREENSHOTS) return { ok: false, error: "screenshot_limit" };
  const next = [...row.screenshots, entry];
  await exec(
    db,
    "update skins set screenshots_json = ?, updated_at = ? where id = ?",
    [JSON.stringify(next), nowIso(), id],
  );
  return { ok: true, index: next.length - 1 };
}

export type FinishSkinResult =
  | { ok: true; skin: SkinSummary }
  | { ok: false; error: "not_found" | "missing_osk" | "missing_preview" };

export async function finishSkin(db: Db, id: string, token: string): Promise<FinishSkinResult> {
  const row = await getSkinForUpload(db, id, token);
  if (!row) return { ok: false, error: "not_found" };
  if (!row.oskKey || !row.oskUrl) return { ok: false, error: "missing_osk" };
  if (!row.previewKey || !row.previewUrl) return { ok: false, error: "missing_preview" };
  const now = nowIso();
  const slug = row.slug ?? await uniqueSkinSlug(db, row.name, id);
  await exec(
    db,
    `update skins set
       status = 'published', slug = ?, published_at = ?, upload_token = null, token_expires_at = null, updated_at = ?
     where id = ?`,
    [slug, now, now, id],
  );
  const published = await getSkin(db, id);
  return published
    ? { ok: true, skin: toSkinSummary(published) }
    : { ok: false, error: "not_found" };
}

// Slugs are assigned once, at publish time, so abandoned pending uploads never
// reserve names. Collisions get -2, -3, ...; the short-id fallback is only a
// backstop against pathological name reuse.
async function uniqueSkinSlug(db: Db, name: string, excludeId: string): Promise<string> {
  const base = slugifySkinName(name);
  let candidate = base;
  for (let suffix = 2; suffix <= 50; suffix += 1) {
    const clash = (await exec(
      db,
      "select id from skins where slug = ? and id != ? limit 1",
      [candidate, excludeId],
    )).rows[0];
    if (!clash) return candidate;
    candidate = `${base}-${suffix}`;
  }
  return `${base}-${excludeId.slice(0, 8)}`;
}

const SLUG_BACKFILL_META_KEY = "skin_slug_backfill:v1";

// One-time boot backfill for rows published before slugs existed. server.ts is
// the only caller and no scheduler stands behind it, so it carries its own
// one-shot marker: the "where slug is null" scan (slug has no index covering
// nulls) stops running on every boot, and because the marker is written only
// after the work succeeds, a boot that loses this to SQLITE_BUSY re-runs it on
// the next one instead of leaving pre-slug skins slugless until someone notices.
export async function backfillSkinSlugs(db: Db): Promise<number> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [SLUG_BACKFILL_META_KEY])).rows[0];
  if (done) return 0;
  const rows = (await exec(
    db,
    "select id, name from skins where slug is null and status != 'pending'",
  )).rows;
  for (const row of rows) {
    const id = String(row.id);
    const slug = await uniqueSkinSlug(db, String(row.name ?? ""), id);
    await exec(db, "update skins set slug = ? where id = ?", [slug, id]);
  }
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [SLUG_BACKFILL_META_KEY, JSON.stringify({ backfilled: rows.length }), nowIso()],
  );
  return rows.length;
}

// Detail-page lookup: accepts the slug from a pretty URL or a raw id from a
// pre-slug link, so old shared URLs keep resolving.
export async function getSkinByRef(db: Db, ref: string): Promise<SkinRow | null> {
  const row = (await exec(db, "select * from skins where id = ? or slug = ? limit 1", [ref, ref])).rows[0];
  return row ? rowToSkin(row as Record<string, unknown>) : null;
}

export interface SkinsListQuery {
  q?: string | null;
  keymode?: number | null;
  page?: number;
  pageSize?: number;
  includeHidden?: boolean;
  sort?: "newest" | "downloads";
}

export interface SkinsListResult {
  skins: SkinSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listSkins(db: Db, query: SkinsListQuery): Promise<SkinsListResult> {
  const page = Math.max(0, Math.floor(query.page ?? 0));
  const pageSize = Math.min(SKIN_LIST_MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 24)));
  const where = query.includeHidden ? ["status in ('published', 'hidden')"] : ["status = 'published'"];
  const args: InValue[] = [];

  const q = query.q?.trim().toLowerCase() ?? "";
  if (q) {
    where.push("search_text like ? escape '\\'");
    args.push(`%${escapeLike(q.slice(0, SKIN_NAME_MAX_LENGTH))}%`);
  }
  const keymode = query.keymode != null && Number.isInteger(query.keymode) ? query.keymode : null;
  if (keymode != null) {
    where.push("exists (select 1 from json_each(skins.keymodes_json) je where je.value = ?)");
    args.push(keymode);
  }
  const whereSql = where.join(" and ");

  const orderSql = query.sort === "downloads"
    ? "download_count desc, published_at desc, created_at desc"
    : "published_at desc, created_at desc";
  const totalRow = (await exec(db, `select count(*) as total from skins where ${whereSql}`, args)).rows[0];
  const rows = (await exec(
    db,
    `select * from skins where ${whereSql}
     order by ${orderSql}
     limit ? offset ?`,
    [...args, pageSize, page * pageSize],
  )).rows;

  return {
    skins: rows.map((row) => toSkinSummary(rowToSkin(row as Record<string, unknown>))),
    total: Number(totalRow?.total) || 0,
    page,
    pageSize,
  };
}

// Counts a download and hands back the redirect target. Only published skins
// count (and resolve): hidden or pending ones return null so the endpoint 404s.
export async function recordSkinDownload(db: Db, id: string): Promise<string | null> {
  const row = await getSkin(db, id);
  if (!row || row.status !== "published" || !row.oskUrl) return null;
  await exec(db, "update skins set download_count = download_count + 1 where id = ?", [id]);
  return row.oskUrl;
}

export async function getSkin(db: Db, id: string): Promise<SkinRow | null> {
  const row = (await exec(db, "select * from skins where id = ?", [id])).rows[0];
  return row ? rowToSkin(row as Record<string, unknown>) : null;
}

export async function deleteSkin(db: Db, id: string): Promise<{ keys: string[] } | null> {
  const row = await getSkin(db, id);
  if (!row) return null;
  await exec(db, "delete from skins where id = ?", [id]);
  return { keys: storageKeysOf(row) };
}

export async function setSkinHidden(db: Db, id: string, hidden: boolean): Promise<boolean> {
  const result = await exec(
    db,
    `update skins set status = ?, updated_at = ? where id = ? and status in ('published', 'hidden')`,
    [hidden ? "hidden" : "published", nowIso(), id],
  );
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function listExpiredPendingSkins(db: Db, cutoffIso: string): Promise<Array<{ id: string; keys: string[] }>> {
  const rows = (await exec(
    db,
    "select * from skins where status = 'pending' and token_expires_at < ?",
    [cutoffIso],
  )).rows;
  return rows.map((raw) => {
    const row = rowToSkin(raw as Record<string, unknown>);
    return { id: row.id, keys: storageKeysOf(row) };
  });
}

export function toSkinSummary(row: SkinRow): SkinSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    author: row.author,
    description: row.description,
    ownerUserId: row.ownerUserId,
    ownerUsername: row.ownerUsername,
    keymodes: row.keymodes,
    accentColor: row.accentColor,
    downloadCount: row.downloadCount,
    previewUrl: row.previewUrl,
    previewWidth: row.previewWidth,
    previewHeight: row.previewHeight,
    previews: row.previews.map(({ keys, url, width, height }) => ({ keys, url, width, height })),
    screenshots: row.screenshots.map(({ url, width, height }) => ({ url, width, height })),
    oskUrl: row.oskUrl,
    oskSizeBytes: row.oskSizeBytes,
    oskSha256: row.oskSha256,
    status: row.status,
    publishedAt: row.publishedAt,
  };
}

function storageKeysOf(row: SkinRow): string[] {
  return [row.oskKey, row.previewKey, ...row.previews.map((preview) => preview.key), ...row.screenshots.map((shot) => shot.key)]
    .filter((key): key is string => Boolean(key));
}

function rowToSkin(row: Record<string, unknown>): SkinRow {
  const status = row.status === "published" || row.status === "hidden" ? row.status : "pending";
  return {
    id: String(row.id),
    slug: textOrNull(row.slug),
    ownerUserId: Number(row.owner_user_id) || 0,
    ownerUsername: String(row.owner_username ?? ""),
    name: String(row.name ?? ""),
    author: textOrNull(row.author),
    description: textOrNull(row.description),
    keymodes: normalizeKeymodes(parseJson<unknown>(String(row.keymodes_json ?? "[]"), [])),
    accentColor: textOrNull(row.accent_color),
    downloadCount: Math.max(0, Math.floor(Number(row.download_count) || 0)),
    status,
    uploadToken: textOrNull(row.upload_token),
    tokenExpiresAt: textOrNull(row.token_expires_at),
    oskKey: textOrNull(row.osk_key),
    oskUrl: textOrNull(row.osk_url),
    oskSizeBytes: numberOrNull(row.osk_size_bytes),
    oskSha256: textOrNull(row.osk_sha256),
    previewKey: textOrNull(row.preview_key),
    previewUrl: textOrNull(row.preview_url),
    previewWidth: numberOrNull(row.preview_width),
    previewHeight: numberOrNull(row.preview_height),
    previews: normalizeKeymodePreviews(parseJson<unknown>(String(row.previews_json ?? "[]"), [])),
    screenshots: normalizeScreenshots(parseJson<unknown>(String(row.screenshots_json ?? "[]"), [])),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    publishedAt: textOrNull(row.published_at),
  };
}

function normalizeKeymodes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((entry) => Math.round(Number(entry)))
      .filter((keys) => Number.isInteger(keys) && keys >= 1 && keys <= 10),
  )].sort((a, b) => a - b);
}

function normalizeScreenshots(value: unknown): SkinScreenshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const key = textOrNull(raw.key);
      const url = textOrNull(raw.url);
      if (!key || !url) return null;
      return { key, url, width: numberOrNull(raw.width), height: numberOrNull(raw.height) };
    })
    .filter((entry): entry is SkinScreenshot => Boolean(entry));
}

function normalizeKeymodePreviews(value: unknown): SkinKeymodePreview[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const raw = entry as Record<string, unknown>;
      const keys = Math.round(Number(raw.keys));
      const key = textOrNull(raw.key);
      const url = textOrNull(raw.url);
      if (!key || !url || !Number.isInteger(keys) || keys < 1 || keys > 10) return null;
      return { keys, key, url, width: numberOrNull(raw.width), height: numberOrNull(raw.height) };
    })
    .filter((entry): entry is SkinKeymodePreview => Boolean(entry))
    .sort((a, b) => a.keys - b.keys);
}

function buildSearchText(name: string, ownerUsername: string, author: string | null): string {
  return [name, author ?? "", ownerUsername].join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function cleanText(value: string, maxLength: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength).trim();
}

// Like cleanText but keeps line breaks (capped at one blank line in a row) so
// descriptions can hold short paragraphs.
function cleanMultilineText(value: string, maxLength: number): string {
  return value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength)
    .trim();
}


function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
