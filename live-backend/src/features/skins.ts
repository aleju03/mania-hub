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

// What an upload ticket minted against an already published skin unlocks.
// 'previews' is the backdrop re-render editor; 'replace' also accepts a newer
// .osk, which is how an uploader ships an update without republishing.
export type SkinTokenScope = "previews" | "replace";

// Who a published skin is for. 'public' is the catalog skin: browsable on
// /skins, downloadable by anyone. 'private' is the uploader's own copy - it
// never enters the list, only its owner reads its page or its .osk, and the
// only thing anyone else ever gets is the filtered asset bundle a replay of
// theirs needs to draw. Independent of status, which stays the publish and
// moderation axis.
export type SkinVisibility = "public" | "private";

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
  // Keymodes whose layout is really (N-1)+1, e.g. [8] on a 7K+1 skin; always
  // a subset of keymodes. Derived from skin.ini alongside them.
  specialKeymodes: number[];
  // True once the owner has corrected specialKeymodes by hand
  // (setSkinSpecialKeymodes); detection then keeps its hands off the list.
  specialKeymodesManual: boolean;
  accentColor: string | null;
  downloadCount: number;
  status: "pending" | "published" | "hidden";
  visibility: SkinVisibility;
  // Capability behind a private skin's stored objects: part of every R2 key it
  // writes and the ?t= the file endpoint demands. Null on public skins.
  privateSecret: string | null;
  uploadToken: string | null;
  tokenExpiresAt: string | null;
  tokenScope: SkinTokenScope | null;
  oskKey: string | null;
  oskUrl: string | null;
  oskSizeBytes: number | null;
  oskSha256: string | null;
  // When the .osk was last replaced with a newer build; null while the skin
  // still carries the file it was published with.
  oskUpdatedAt: string | null;
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
  specialKeymodes: number[];
  accentColor: string | null;
  // Public: every reader sees every skin's count, the same number the
  // downloads sort orders by.
  downloadCount: number;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  previews: Array<{ keys: number; url: string; width: number | null; height: number | null }>;
  screenshots: Array<{ url: string; width: number | null; height: number | null }>;
  oskUrl: string | null;
  oskSizeBytes: number | null;
  oskSha256: string | null;
  oskUpdatedAt: string | null;
  status: "pending" | "published" | "hidden";
  visibility: SkinVisibility;
  publishedAt: string | null;
}

// Enough to point the uploader at the skin that already carries these bytes.
export interface DuplicateSkinRef {
  id: string;
  slug: string | null;
  name: string;
  ownerUsername: string;
}

export type CreatePendingSkinResult =
  | { ok: true; id: string; token: string; expiresAt: string }
  | { ok: false; error: "invalid_name" | "pending_limit" | "skin_limit" }
  | { ok: false; error: "duplicate"; duplicate: DuplicateSkinRef };

// Byte-identical .osk lookup, the duplicate-upload guard. Published rows only:
// pending rows are half-finished attempts (often the uploader's own retry) and
// hidden ones are a moderation state that must not leak through a public
// upload error. An owner who deletes a skin frees its hash with the row.
// Private rows are excluded on both sides of the check: the answer names the
// skin holding the bytes, which would expose a private upload to a stranger,
// and a private copy of a skin already on the catalog is a legitimate thing to
// keep (see the caller, which skips the check entirely for private uploads).
export async function findPublishedSkinByOskSha256(
  db: Db,
  sha256: string,
  excludeId?: string,
): Promise<DuplicateSkinRef | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const row = (await exec(
    db,
    `select id, slug, name, owner_username from skins
     where osk_sha256 = ? and status = 'published' and visibility = 'public' and id != ?
     order by published_at asc limit 1`,
    [sha256, excludeId ?? ""],
  )).rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    slug: textOrNull(row.slug),
    name: String(row.name ?? ""),
    ownerUsername: String(row.owner_username ?? ""),
  };
}

export async function createPendingSkin(
  db: Db,
  input: {
    ownerUserId: number;
    ownerUsername: string;
    name: string;
    author?: string | null;
    description?: string | null;
    // Client-computed hash of the .osk about to be uploaded. Advisory: it
    // saves the uploader a pointless 50MB transfer, and the same check runs
    // again on the server-computed hash when the archive actually lands.
    oskSha256?: string | null;
    // Set only by the admin bulk uploader, which seeds the site with a whole
    // collection at once: the per-user caps exist to keep a visitor from
    // filling storage, and they would stop a seeding run at 30. The duplicate
    // guard still applies.
    bypassLimits?: boolean;
    // 'private' keeps the finished skin off the catalog entirely; chosen in the
    // upload form and changeable later from the skin's own page.
    visibility?: SkinVisibility;
  },
): Promise<CreatePendingSkinResult> {
  const name = cleanText(input.name, SKIN_NAME_MAX_LENGTH);
  if (!name) return { ok: false, error: "invalid_name" };
  const ownerUsername = cleanText(input.ownerUsername, 32) || `user ${input.ownerUserId}`;
  const author = cleanText(input.author ?? "", SKIN_AUTHOR_MAX_LENGTH) || null;
  const description = cleanMultilineText(input.description ?? "", SKIN_DESCRIPTION_MAX_LENGTH) || null;

  const visibility: SkinVisibility = input.visibility === "private" ? "private" : "public";

  // Keeping your own copy of a skin the catalog already carries is the point of
  // a private upload, so the duplicate guard only stands in front of public
  // ones.
  if (input.oskSha256 && visibility === "public") {
    const duplicate = await findPublishedSkinByOskSha256(db, input.oskSha256.toLowerCase());
    if (duplicate) return { ok: false, error: "duplicate", duplicate };
  }

  if (!input.bypassLimits) {
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
  }

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString("base64url");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + SKIN_TOKEN_TTL_MS).toISOString();
  await exec(
    db,
    `insert into skins (
       id, owner_user_id, owner_username, name, author, description, search_text,
       status, visibility, private_secret, upload_token, token_expires_at, created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [id, input.ownerUserId, ownerUsername, name, author, description, buildSearchText(name, ownerUsername, author),
     visibility, visibility === "private" ? newPrivateSkinSecret() : null, token, expiresAt, now, now],
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
  patch: { key: string; url: string; sizeBytes: number; sha256: string; keymodes: number[]; specialKeymodes: number[]; accentColor: string | null; iniAuthor: string | null },
): Promise<void> {
  // An author typed in the upload form wins; skin.ini's Author fills the gap.
  const author = skin.author ?? (cleanText(patch.iniAuthor ?? "", SKIN_AUTHOR_MAX_LENGTH) || null);
  await exec(
    db,
    `update skins set
       osk_key = ?, osk_url = ?, osk_size_bytes = ?, osk_sha256 = ?,
       keymodes_json = ?, special_keymodes_json = ?, accent_color = coalesce(accent_color, ?),
       author = ?, search_text = ?, updated_at = ?
     where id = ?`,
    [patch.key, patch.url, patch.sizeBytes, patch.sha256, JSON.stringify(patch.keymodes), JSON.stringify(normalizeKeymodes(patch.specialKeymodes)), patch.accentColor,
     author, buildSearchText(skin.name, skin.ownerUsername, author), nowIso(), skin.id],
  );
}

// Swaps a published skin's .osk for a newer build. Unlike attachSkinOsk this
// overwrites the keymodes outright (the new archive decides which ones the
// skin ships) and stamps osk_updated_at, which is what the skin page reads
// back as "Updated". The accent is left alone: the re-rendered cover preview
// that lands right after this carries the colour sampled from the new notes.
export async function replaceSkinOsk(
  db: Db,
  skin: SkinRow,
  patch: { key: string; url: string; sizeBytes: number; sha256: string; keymodes: number[]; specialKeymodes: number[]; iniAuthor: string | null },
): Promise<void> {
  const author = skin.author ?? (cleanText(patch.iniAuthor ?? "", SKIN_AUTHOR_MAX_LENGTH) || null);
  const now = nowIso();
  const keymodes = normalizeKeymodes(patch.keymodes);
  // An owner-corrected 7K+1 list survives the new build (minus keymodes the
  // archive no longer ships); otherwise the new skin.ini decides.
  const specialKeymodes = skin.specialKeymodesManual
    ? skin.specialKeymodes.filter((keys) => keymodes.includes(keys))
    : normalizeKeymodes(patch.specialKeymodes);
  await exec(
    db,
    `update skins set
       osk_key = ?, osk_url = ?, osk_size_bytes = ?, osk_sha256 = ?,
       keymodes_json = ?, special_keymodes_json = ?, author = ?, search_text = ?, osk_updated_at = ?, updated_at = ?
     where id = ?`,
    [patch.key, patch.url, patch.sizeBytes, patch.sha256, JSON.stringify(keymodes),
     JSON.stringify(specialKeymodes),
     author, buildSearchText(skin.name, skin.ownerUsername, author), now, now, skin.id],
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

export type UpsertPreviewResult =
  // The entry this one displaced, when there was one: its stored object is now
  // unreferenced, so the caller deletes it from R2.
  | { ok: true; replaced: SkinKeymodePreview | null }
  | { ok: false; error: "preview_limit" | "not_found" };

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
  const replaced = row.previews.find((preview) => preview.keys === entry.keys) ?? null;
  const next = [...row.previews.filter((preview) => preview.keys !== entry.keys), entry]
    .sort((a, b) => a.keys - b.keys);
  if (next.length > 10) return { ok: false, error: "preview_limit" };
  await exec(
    db,
    "update skins set previews_json = ?, updated_at = ? where id = ?",
    [JSON.stringify(next), nowIso(), id],
  );
  // A re-render of the keymode that already fronts the card keeps fronting it:
  // the cover columns point at the object being replaced, so they have to move
  // with it or the card would show a key that is about to be deleted.
  if (isCover || (replaced && row.previewKey === replaced.key)) await attachSkinPreview(db, id, entry);
  return { ok: true, replaced };
}

export type SetSkinCoverResult =
  | { ok: true; skin: SkinSummary }
  | { ok: false; error: "not_found" | "forbidden" | "no_preview" };

// Repoints the card cover at an already-rendered keymode preview. No image
// work: the previews are all stored, this only picks which one fronts the
// skin. ownerUserId null is the admin path, which skips the ownership check.
export async function setSkinCoverKeymode(
  db: Db,
  id: string,
  keys: number,
  ownerUserId: number | null,
): Promise<SetSkinCoverResult> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  const entry = row.previews.find((preview) => preview.keys === keys);
  if (!entry) return { ok: false, error: "no_preview" };
  await attachSkinPreview(db, id, entry);
  const updated = await getSkin(db, id);
  return updated ? { ok: true, skin: toSkinSummary(updated, { asOwner: true }) } : { ok: false, error: "not_found" };
}

export type SetSkinSpecialKeymodesResult =
  | { ok: true; skin: SkinSummary }
  | { ok: false; error: "not_found" | "forbidden" | "invalid_keymodes" };

// The owner's correction for the 7K+1 detection: skinners routinely ship an
// (N-1)+1 layout without the skin.ini separator the detector reads, so the
// catalog mislabels the skin as plain NK (and vice versa). The list replaces
// the detected one outright and flips the manual flag, which tells .osk
// replacements and backfill re-scans to leave it alone from here on.
// ownerUserId null is the admin path, which skips the ownership check.
export async function setSkinSpecialKeymodes(
  db: Db,
  id: string,
  rawSpecialKeymodes: number[],
  ownerUserId: number | null,
): Promise<SetSkinSpecialKeymodesResult> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  const specialKeymodes = normalizeKeymodes(rawSpecialKeymodes);
  // Special means (N-1)+1, so 1K cannot be one, and a keymode the skin does
  // not ship cannot be labelled at all.
  if (specialKeymodes.some((keys) => keys < 2 || !row.keymodes.includes(keys))) {
    return { ok: false, error: "invalid_keymodes" };
  }
  await exec(
    db,
    "update skins set special_keymodes_json = ?, special_keymodes_manual = 1, updated_at = ? where id = ?",
    [JSON.stringify(specialKeymodes), nowIso(), id],
  );
  const updated = await getSkin(db, id);
  return updated ? { ok: true, skin: toSkinSummary(updated, { asOwner: true }) } : { ok: false, error: "not_found" };
}

export type RenameSkinResult =
  | { ok: true; skin: SkinSummary }
  | { ok: false; error: "not_found" | "forbidden" | "invalid_name" };

// Retitles a published skin. The slug deliberately stays as it was published:
// it is what every shared link points at, and a rename must not 404 them. The
// stored .osk keeps the filename it was uploaded under for the same reason -
// its key is baked into osk_url, which browser and edge caches already hold.
// ownerUserId null is the admin path, which skips the ownership check.
export async function renameSkin(
  db: Db,
  id: string,
  rawName: string,
  ownerUserId: number | null,
): Promise<RenameSkinResult> {
  const name = cleanText(rawName, SKIN_NAME_MAX_LENGTH);
  if (!name) return { ok: false, error: "invalid_name" };
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  await exec(
    db,
    "update skins set name = ?, search_text = ?, updated_at = ? where id = ?",
    [name, buildSearchText(name, row.ownerUsername, row.author), nowIso(), id],
  );
  const updated = await getSkin(db, id);
  return updated ? { ok: true, skin: toSkinSummary(updated, { asOwner: true }) } : { ok: false, error: "not_found" };
}

export type StartSkinEditResult =
  | { ok: true; id: string; token: string; expiresAt: string; scope: SkinTokenScope }
  | { ok: false; error: "not_found" | "forbidden" };

// Mints an upload ticket against an already published skin so its owner can
// re-render the keymode previews (a different backdrop, say) or ship a newer
// .osk without republishing. Same token column as the publish flow, but the
// row keeps its status, so retention - which only sweeps pending rows - leaves
// it alone. The scope is what the upload endpoint checks each part against.
export async function startSkinEdit(
  db: Db,
  id: string,
  ownerUserId: number | null,
  scope: SkinTokenScope = "previews",
): Promise<StartSkinEditResult> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + SKIN_TOKEN_TTL_MS).toISOString();
  await exec(
    db,
    "update skins set upload_token = ?, token_expires_at = ?, token_scope = ?, updated_at = ? where id = ?",
    [token, expiresAt, scope, nowIso(), id],
  );
  return { ok: true, id, token, expiresAt, scope };
}

// The edit-ticket counterpart of getSkinForUpload: published (or hidden) rows
// only, so an edit ticket can never be mistaken for a publish ticket. What the
// ticket may touch is on the row as tokenScope.
export async function getSkinForEdit(db: Db, id: string, token: string): Promise<SkinRow | null> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending" || !row.uploadToken || !row.tokenExpiresAt) return null;
  if (!tokenMatches(row.uploadToken, token)) return null;
  if (row.tokenExpiresAt <= new Date().toISOString()) return null;
  return row;
}

export type FinishSkinEditResult =
  // Preview objects the row no longer points at, for the caller to delete from
  // R2: a replaced .osk can drop keymodes the old build shipped.
  | { ok: true; skin: SkinSummary; staleKeys: string[] }
  | { ok: false; error: "not_found" };

export async function finishSkinEdit(db: Db, id: string, token: string): Promise<FinishSkinEditResult> {
  const row = await getSkinForEdit(db, id, token);
  if (!row) return { ok: false, error: "not_found" };
  const staleKeys = row.tokenScope === "replace" ? await pruneOrphanedPreviews(db, row) : [];
  await exec(
    db,
    "update skins set upload_token = null, token_expires_at = null, token_scope = null, updated_at = ? where id = ?",
    [nowIso(), id],
  );
  const updated = await getSkin(db, id);
  return updated ? { ok: true, skin: toSkinSummary(updated, { asOwner: true }), staleKeys } : { ok: false, error: "not_found" };
}

// Drops the keymode previews of a skin whose new .osk no longer ships those
// keymodes, and moves the card cover off one of them if that is where it sat.
// Returns the storage keys nothing points at any more. A row that would be
// left with no previews at all keeps what it has: an update that failed to
// re-render is better than a skin with no images.
async function pruneOrphanedPreviews(db: Db, row: SkinRow): Promise<string[]> {
  const kept = row.previews.filter((preview) => row.keymodes.includes(preview.keys));
  if (kept.length === row.previews.length || kept.length === 0) return [];
  const dropped = row.previews.filter((preview) => !row.keymodes.includes(preview.keys));
  await exec(db, "update skins set previews_json = ?, updated_at = ? where id = ?", [JSON.stringify(kept), nowIso(), row.id]);
  if (row.previewKey && dropped.some((preview) => preview.key === row.previewKey)) {
    // 4K is the keymode a skin is recognised by, so it takes the card when the
    // cover's own keymode is gone.
    await attachSkinPreview(db, row.id, kept.find((preview) => preview.keys === 4) ?? kept[0]);
  }
  return dropped.map((preview) => preview.key);
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
  // The ticket holder is the uploader, so a private skin comes back whole -
  // its own publish confirmation needs the page link and the file.
  return published
    ? { ok: true, skin: toSkinSummary(published, { asOwner: true }) }
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
  // Refines a keymode filter by layout: "special" keeps only skins whose
  // keymode block is really (N-1)+1 (the 7K+1 filter, with keymode 8), and
  // "regular" excludes those (so 8K means actual 8K). Ignored without keymode.
  keymodeVariant?: "special" | "regular" | null;
  page?: number;
  pageSize?: number;
  includeHidden?: boolean;
  sort?: "newest" | "downloads";
  // Whose private skins this list may carry. The browse grid passes nothing
  // and stays public; the "your private skins" shelf passes the signed-in
  // viewer, which the endpoint only trusts from an admin-token request.
  privateOwnerUserId?: number | null;
  // Restricts the list to that owner's private skins (the shelf itself).
  onlyPrivate?: boolean;
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

  // Visibility gate. Without an owner the list is the public catalog; with one
  // their private skins join it (or are all of it, for the shelf).
  const privateOwner = Number.isInteger(query.privateOwnerUserId) && Number(query.privateOwnerUserId) > 0
    ? Number(query.privateOwnerUserId)
    : null;
  if (query.onlyPrivate) {
    if (privateOwner == null) return { skins: [], total: 0, page, pageSize };
    where.push("visibility = 'private' and owner_user_id = ?");
    args.push(privateOwner);
  } else if (privateOwner != null) {
    where.push("(visibility = 'public' or owner_user_id = ?)");
    args.push(privateOwner);
  } else {
    where.push("visibility = 'public'");
  }

  const q = query.q?.trim().toLowerCase() ?? "";
  if (q) {
    where.push("search_text like ? escape '\\'");
    args.push(`%${escapeLike(q.slice(0, SKIN_NAME_MAX_LENGTH))}%`);
  }
  const keymode = query.keymode != null && Number.isInteger(query.keymode) ? query.keymode : null;
  if (keymode != null) {
    where.push("exists (select 1 from json_each(skins.keymodes_json) je where je.value = ?)");
    args.push(keymode);
    if (query.keymodeVariant === "special") {
      where.push("exists (select 1 from json_each(skins.special_keymodes_json) js where js.value = ?)");
      args.push(keymode);
    } else if (query.keymodeVariant === "regular") {
      where.push("not exists (select 1 from json_each(skins.special_keymodes_json) js where js.value = ?)");
      args.push(keymode);
    }
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
    // A private row is only ever in here because it belongs to the viewer the
    // caller vouched for, so it serializes with its capability URLs attached -
    // stated as an ownership check rather than inherited from the query, so a
    // future filter cannot quietly widen who gets the whole skin.
    skins: rows.map((row) => {
      const skin = rowToSkin(row as Record<string, unknown>);
      return toSkinSummary(skin, { asOwner: privateOwner != null && skin.ownerUserId === privateOwner });
    }),
    total: Number(totalRow?.total) || 0,
    page,
    pageSize,
  };
}

// Counts a download and hands back the redirect target. Only published public
// skins count (and resolve): hidden, pending or private ones return null so the
// endpoint 404s. A private skin has no counted download at all - its owner
// fetches the file through the capability URL on their own page.
export async function recordSkinDownload(db: Db, id: string): Promise<string | null> {
  const row = await getSkin(db, id);
  if (!row || row.status !== "published" || row.visibility !== "public" || !row.oskUrl) return null;
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

// A private skin's objects live under a key segment nobody can guess, and the
// same string is the ?t= that unlocks them. 24 random bytes, rotated on every
// turn to private so a secret handed out before a public spell stops working.
export function newPrivateSkinSecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export type SetSkinVisibilityResult =
  | { ok: true; skin: SkinRow; changed: boolean }
  | { ok: false; error: "not_found" | "forbidden" };

// Flips a published skin between the catalog and the uploader's own shelf.
// Turning private mints a fresh secret; the caller then moves the .osk onto a
// key built from it (moveSkinOskKey) so the object a public URL already
// pointed at stops resolving. ownerUserId null is the admin path.
export async function setSkinVisibility(
  db: Db,
  id: string,
  visibility: SkinVisibility,
  ownerUserId: number | null,
): Promise<SetSkinVisibilityResult> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  if (row.visibility === visibility) return { ok: true, skin: row, changed: false };
  const secret = visibility === "private" ? newPrivateSkinSecret() : null;
  await exec(
    db,
    "update skins set visibility = ?, private_secret = ?, updated_at = ? where id = ?",
    [visibility, secret, nowIso(), id],
  );
  const updated = await getSkin(db, id);
  return updated ? { ok: true, skin: updated, changed: true } : { ok: false, error: "not_found" };
}

// Records the .osk's new home after the caller has moved the object in R2.
// Only the storage columns move: the file is the same build, so keymodes,
// hash and osk_updated_at all stay as they were.
export async function moveSkinOskKey(db: Db, id: string, patch: { key: string; url: string }): Promise<void> {
  await exec(
    db,
    "update skins set osk_key = ?, osk_url = ?, updated_at = ? where id = ?",
    [patch.key, patch.url, nowIso(), id],
  );
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

// The wire shape of a skin. A private skin only ever leaves the server whole
// for its uploader (asOwner), who gets its images and .osk carrying the ?t=
// capability their browser needs to fetch them back. For everyone else a
// private row is stripped down to what a replay credit shows - name, author,
// keymodes, accent - with every URL and every download-shaped field dropped,
// so the redaction lives here rather than in each endpoint that serves a skin.
export function toSkinSummary(row: SkinRow, options?: { asOwner?: boolean }): SkinSummary {
  const previews = row.previews.map(({ keys, url, width, height }) => ({ keys, url, width, height }));
  const screenshots = row.screenshots.map(({ url, width, height }) => ({ url, width, height }));
  const summary: SkinSummary = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    author: row.author,
    description: row.description,
    ownerUserId: row.ownerUserId,
    ownerUsername: row.ownerUsername,
    keymodes: row.keymodes,
    specialKeymodes: row.specialKeymodes,
    accentColor: row.accentColor,
    downloadCount: row.downloadCount,
    previewUrl: row.previewUrl,
    previewWidth: row.previewWidth,
    previewHeight: row.previewHeight,
    previews,
    screenshots,
    oskUrl: row.oskUrl,
    oskSizeBytes: row.oskSizeBytes,
    oskSha256: row.oskSha256,
    oskUpdatedAt: row.oskUpdatedAt,
    status: row.status,
    visibility: row.visibility,
    publishedAt: row.publishedAt,
  };
  if (row.visibility !== "private") return summary;
  if (options?.asOwner) {
    const sign = (url: string | null) => signPrivateSkinUrl(url, row.privateSecret);
    return {
      ...summary,
      previewUrl: sign(summary.previewUrl),
      previews: previews.map((preview) => ({ ...preview, url: sign(preview.url) ?? preview.url })),
      screenshots: screenshots.map((shot) => ({ ...shot, url: sign(shot.url) ?? shot.url })),
      oskUrl: sign(summary.oskUrl),
    };
  }
  return {
    ...summary,
    // A private skin has no page to link to and no bytes to hand out, so
    // nothing that addresses either travels with it.
    slug: null,
    description: null,
    downloadCount: 0,
    previewUrl: null,
    previewWidth: null,
    previewHeight: null,
    previews: [],
    screenshots: [],
    oskUrl: null,
    oskSizeBytes: null,
    oskSha256: null,
  };
}

// Appends the private skin's capability to a URL the backend itself serves.
// Public-bucket URLs never appear on a private skin (its objects are written
// under a secret key prefix through the streaming endpoint), so a URL that is
// not ours is left alone rather than leaking the secret to another origin.
function signPrivateSkinUrl(url: string | null, secret: string | null): string | null {
  if (!url || !secret) return url;
  if (!url.includes("/api/skins/file/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(secret)}`;
}

// Whether a request carrying this ?t= may read a private skin's stored
// objects. Public skins have no secret and need no capability.
export function privateSkinSecretMatches(row: SkinRow, provided: string | null): boolean {
  if (row.visibility !== "private") return true;
  if (!row.privateSecret || !provided) return false;
  return tokenMatches(row.privateSecret, provided);
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
    specialKeymodes: normalizeKeymodes(parseJson<unknown>(String(row.special_keymodes_json ?? "[]"), [])),
    specialKeymodesManual: Number(row.special_keymodes_manual) === 1,
    accentColor: textOrNull(row.accent_color),
    downloadCount: Math.max(0, Math.floor(Number(row.download_count) || 0)),
    status,
    visibility: row.visibility === "private" ? "private" : "public",
    privateSecret: textOrNull(row.private_secret),
    uploadToken: textOrNull(row.upload_token),
    tokenExpiresAt: textOrNull(row.token_expires_at),
    tokenScope: row.token_scope === "replace" ? "replace" : row.token_scope === "previews" ? "previews" : null,
    oskKey: textOrNull(row.osk_key),
    oskUrl: textOrNull(row.osk_url),
    oskSizeBytes: numberOrNull(row.osk_size_bytes),
    oskSha256: textOrNull(row.osk_sha256),
    oskUpdatedAt: textOrNull(row.osk_updated_at),
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
