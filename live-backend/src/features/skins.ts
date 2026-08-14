import crypto from "node:crypto";
import type { InValue } from "@libsql/client";
import type { Db } from "../db.js";
import { exec, parseJson } from "../db.js";
import { nowIso } from "../shared/score.js";
import { classifyKeymodeNoteShape, classifySkinNoteShape, isSkinNoteShape, type SkinArchiveMeta, type SkinNoteShape } from "../skins/archive-meta.js";
import { normalizeSkinVisualSignature, skinSimilarityMatch, SKIN_SIMILARITY_FLOOR, type SkinSimilarityFacts, type SkinVisualSignature } from "../skins/similarity.js";
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
export const SKIN_SCREENSHOT_LABEL_MAX_LENGTH = 40;
const SKIN_LIST_MAX_PAGE_SIZE = 50;

// One stored image on a skin: where it lives, and what it measures.
export interface SkinImage {
  key: string;
  url: string;
  width: number | null;
  height: number | null;
}

export interface SkinScreenshot extends SkinImage {
  // What the uploader called this shot ("Score screen"). Null is unnamed, which
  // the skin page numbers instead.
  label: string | null;
}

export interface SkinPreviewRecipeNote {
  column: number;
  time: number;
  endTime: number;
}

export interface SkinPreviewRecipePattern {
  beatmapId: number;
  keys: number;
  label: string;
  stars: number;
  notes: SkinPreviewRecipeNote[];
}

// Everything needed to draw the same flattened preview again. This lives
// beside the image in previews_json, but only travels to the owner: catalog
// cards need the PNG, not several charts' worth of note coordinates.
export interface SkinPreviewRecipe {
  backdrop: number | "flat";
  pattern: SkinPreviewRecipePattern | null;
}

export interface SkinKeymodePreview extends SkinImage {
  keys: number;
  recipe?: SkinPreviewRecipe;
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
  // Digest of the note art inside the .osk (shape mask, aspect, palette),
  // computed at upload and compared by the similar-skins scoring. Null when
  // the archive ships no digestible note images; never serialized to clients.
  visual: SkinVisualSignature | null;
  // Archive facts for the catalog filters (src/skins/archive-meta.ts), null
  // while a row has not been analyzed: the .osk ships a lane cover, ships its
  // own mania stage art, carries lazer-only modification files.
  laneCover: boolean | null;
  maniaStage: boolean | null;
  lazer: boolean | null;
  // What the tap notes are, classified from the visual signature.
  noteShape: SkinNoteShape | null;
  // The uploader's word on what resolution the skin is made for ("1920x1080",
  // normalized by normalizeSkinResolution). Optional, never derived.
  resolution: string | null;
  downloadCount: number;
  viewCount: number;
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
  // The filterable archive facts and labels, same nullability as the row:
  // null is "not analyzed" (or, for resolution, "the uploader never said").
  laneCover: boolean | null;
  maniaStage: boolean | null;
  lazer: boolean | null;
  noteShape: SkinNoteShape | null;
  // Only list responses filtered by note shape set this: the keymode preview
  // that visually proves the match, so a mixed skin does not show its
  // uploader-chosen circle cover under the Bars filter.
  filterKeys?: number | null;
  resolution: string | null;
  // Public: every reader sees every skin's count, the same number the
  // downloads sort orders by.
  downloadCount: number;
  // Also public. Counted per visitor per 6h from the skin's own page, so it
  // runs well ahead of downloads: opening a skin to look at it is the common
  // act, grabbing the .osk is the rare one.
  viewCount: number;
  previewUrl: string | null;
  previewWidth: number | null;
  previewHeight: number | null;
  previews: Array<{ keys: number; url: string; width: number | null; height: number | null; recipe?: SkinPreviewRecipe }>;
  screenshots: Array<{ url: string; width: number | null; height: number | null; label: string | null }>;
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
    // What resolution the skin is made for, the uploader's optional word.
    // Anything normalizeSkinResolution cannot read is simply not an answer.
    resolution?: string | null;
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
       id, owner_user_id, owner_username, name, author, description, resolution, search_text,
       status, visibility, private_secret, upload_token, token_expires_at, created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [id, input.ownerUserId, ownerUsername, name, author, description, normalizeSkinResolution(input.resolution),
     buildSearchText(name, ownerUsername, author),
     visibility, visibility === "private" ? newPrivateSkinSecret() : null, token, expiresAt, now, now],
  );
  return { ok: true, id, token, expiresAt };
}

// The uploader's "made for 1920x1080" note, normalized to WxH so the filter
// can match it exactly. Accepts x or the multiplication sign with optional
// spaces; anything else is no answer rather than an error.
export function normalizeSkinResolution(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d{3,5})\s*[x×*]\s*(\d{3,5})\s*$/i.exec(value);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 240 || width > 16384 || height < 240 || height > 16384) return null;
  return `${width}x${height}`;
}

// How big a normalized resolution is, for ordering the filter row.
function resolutionPixels(value: string): number {
  const [width, height] = value.split("x");
  return (Number(width) || 0) * (Number(height) || 0);
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
  patch: { key: string; url: string; sizeBytes: number; sha256: string; keymodes: number[]; specialKeymodes: number[]; accentColor: string | null; iniAuthor: string | null; visual?: SkinVisualSignature | null; archive?: SkinArchiveMeta | null },
): Promise<void> {
  // An author typed in the upload form wins; skin.ini's Author fills the gap.
  const author = skin.author ?? (cleanText(patch.iniAuthor ?? "", SKIN_AUTHOR_MAX_LENGTH) || null);
  await exec(
    db,
    `update skins set
       osk_key = ?, osk_url = ?, osk_size_bytes = ?, osk_sha256 = ?,
       keymodes_json = ?, special_keymodes_json = ?, accent_color = coalesce(accent_color, ?),
       visual_json = ?, lane_cover = ?, mania_stage = ?, lazer = ?, note_shape = ?,
       author = ?, search_text = ?, updated_at = ?
     where id = ?`,
    [patch.key, patch.url, patch.sizeBytes, patch.sha256, JSON.stringify(patch.keymodes), JSON.stringify(normalizeKeymodes(patch.specialKeymodes)), patch.accentColor,
     patch.visual ? JSON.stringify(patch.visual) : null, ...archiveMetaColumns(patch.archive, patch.visual),
     author, buildSearchText(skin.name, skin.ownerUsername, author), nowIso(), skin.id],
  );
}

// The filter columns an .osk decides: the archive flags as analyzed (null when
// the analysis failed, which is "unknown" rather than "no"), and the note
// shape classified from the same visual signature being stored.
function archiveMetaColumns(
  archive: SkinArchiveMeta | null | undefined,
  visual: SkinVisualSignature | null | undefined,
): [number | null, number | null, number | null, string | null] {
  return [
    archive ? (archive.laneCover ? 1 : 0) : null,
    archive ? (archive.maniaStage ? 1 : 0) : null,
    archive ? (archive.lazer ? 1 : 0) : null,
    classifySkinNoteShape(visual ?? null),
  ];
}

// Swaps a published skin's .osk for a newer build. Unlike attachSkinOsk this
// overwrites the keymodes outright (the new archive decides which ones the
// skin ships) and stamps osk_updated_at, which is what the skin page reads
// back as "Updated". The accent is left alone: the re-rendered cover preview
// that lands right after this carries the colour sampled from the new notes.
export async function replaceSkinOsk(
  db: Db,
  skin: SkinRow,
  patch: { key: string; url: string; sizeBytes: number; sha256: string; keymodes: number[]; specialKeymodes: number[]; iniAuthor: string | null; visual?: SkinVisualSignature | null; archive?: SkinArchiveMeta | null },
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
       keymodes_json = ?, special_keymodes_json = ?, visual_json = ?,
       lane_cover = ?, mania_stage = ?, lazer = ?, note_shape = ?,
       author = ?, search_text = ?, osk_updated_at = ?, updated_at = ?
     where id = ?`,
    [patch.key, patch.url, patch.sizeBytes, patch.sha256, JSON.stringify(keymodes),
     JSON.stringify(specialKeymodes), patch.visual ? JSON.stringify(patch.visual) : null,
     ...archiveMetaColumns(patch.archive, patch.visual),
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
  // staleKey is the object the cover just moved off when nothing else on the
  // row lists it, for the caller to delete from storage.
  | { ok: true; skin: SkinSummary; staleKey: string | null }
  | { ok: false; error: "not_found" | "forbidden" | "no_preview" };

// Which stored image fronts the browse card: a keymode's rendered playfield, or
// one of the screenshots the uploader attached themselves.
export type SkinCoverTarget =
  | { kind: "keymode"; keys: number }
  | { kind: "screenshot"; index: number };

// Repoints the card cover at another stored image. No image work: every
// candidate is already in storage, this only picks which one fronts the skin.
// ownerUserId null is the admin path, which skips the ownership check.
export async function setSkinCover(
  db: Db,
  id: string,
  target: SkinCoverTarget,
  ownerUserId: number | null,
): Promise<SetSkinCoverResult> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  const entry: SkinImage | undefined = target.kind === "keymode"
    ? row.previews.find((preview) => preview.keys === target.keys)
    : row.screenshots[target.index];
  if (!entry) return { ok: false, error: "no_preview" };
  // Every candidate is listed on the row except one: the standalone preview of
  // a skin published before per-keymode renders existed, which only the cover
  // columns ever pointed at. Moving the card off that orphans it.
  const referenced = new Set([
    ...row.previews.map((preview) => preview.key),
    ...row.screenshots.map((shot) => shot.key),
    entry.key,
  ]);
  const staleKey = row.previewKey && !referenced.has(row.previewKey) ? row.previewKey : null;
  await attachSkinPreview(db, id, entry);
  const updated = await getSkin(db, id);
  return updated
    ? { ok: true, skin: toSkinSummary(updated, { asOwner: true, includePreviewRecipes: true }), staleKey }
    : { ok: false, error: "not_found" };
}

export type SetSkinScreenshotLabelsResult =
  | { ok: true; skin: SkinSummary }
  | { ok: false; error: "not_found" | "forbidden" };

// Renames the attached screenshots in place, by position: "Score screen" rather
// than "Shot 2". An empty label puts a shot back to being numbered, and a list
// shorter than the row's leaves the screenshots past its end alone.
// ownerUserId null is the admin path, which skips the ownership check.
export async function setSkinScreenshotLabels(
  db: Db,
  id: string,
  labels: Array<string | null>,
  ownerUserId: number | null,
): Promise<SetSkinScreenshotLabelsResult> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  const next = row.screenshots.map((shot, index) => (
    index < labels.length
      ? { ...shot, label: cleanText(labels[index] ?? "", SKIN_SCREENSHOT_LABEL_MAX_LENGTH) || null }
      : shot
  ));
  await exec(
    db,
    "update skins set screenshots_json = ?, updated_at = ? where id = ?",
    [JSON.stringify(next), nowIso(), id],
  );
  const updated = await getSkin(db, id);
  return updated ? { ok: true, skin: toSkinSummary(updated, { asOwner: true, includePreviewRecipes: true }) } : { ok: false, error: "not_found" };
}

export type RemoveSkinScreenshotResult =
  // staleKey is the removed shot's stored object once nothing on the row
  // points at it any more, for the caller to delete from storage.
  | { ok: true; skin: SkinSummary; staleKey: string | null }
  | { ok: false; error: "not_found" | "forbidden" | "no_screenshot" };

// Drops one attached screenshot by position, for the shot that has nothing to
// do with the skin. Screenshots only ever arrive on publish tickets, so the
// list never grows back post-publish and a removed position is never
// re-filled. A shot that fronted the card hands the cover to a keymode render
// (4K first, the keymode a skin is recognised by) or, failing that, another
// screenshot; a row that would be left with no image at all keeps the shot as
// cover and reports nothing stale, so the card never goes blank.
// ownerUserId null is the admin path, which skips the ownership check. The
// keymodeModerator option is the trusted-corrector path (also ownerUserId
// null): same skip, but only over public skins, since a private skin is a 404
// for anyone but its uploader.
export async function removeSkinScreenshot(
  db: Db,
  id: string,
  index: number,
  ownerUserId: number | null,
  options?: { keymodeModerator?: boolean },
): Promise<RemoveSkinScreenshotResult> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  if (options?.keymodeModerator && row.visibility !== "public") return { ok: false, error: "not_found" };
  const shot = Number.isInteger(index) && index >= 0 ? row.screenshots[index] : undefined;
  if (!shot) return { ok: false, error: "no_screenshot" };
  const next = row.screenshots.filter((_, position) => position !== index);
  await exec(
    db,
    "update skins set screenshots_json = ?, updated_at = ? where id = ?",
    [JSON.stringify(next), nowIso(), id],
  );
  let coverStaysOnShot = false;
  if (row.previewKey === shot.key) {
    const fallback = row.previews.find((preview) => preview.keys === 4) ?? row.previews[0] ?? next[0];
    if (fallback) await attachSkinPreview(db, id, fallback);
    else coverStaysOnShot = true;
  }
  const updated = await getSkin(db, id);
  return updated
    ? {
        ok: true,
        skin: toSkinSummary(updated, {
          asOwner: !options?.keymodeModerator,
          includePreviewRecipes: !options?.keymodeModerator,
        }),
        staleKey: coverStaysOnShot ? null : shot.key,
      }
    : { ok: false, error: "not_found" };
}

export type SetSkinSpecialKeymodesResult =
  | { ok: true; skin: SkinSummary }
  | { ok: false; error: "not_found" | "forbidden" | "invalid_keymodes" };

// The owner's correction for the 7K+1 detection: skinners routinely ship an
// (N-1)+1 layout without the skin.ini separator the detector reads, so the
// catalog mislabels the skin as plain NK (and vice versa). The list replaces
// the detected one outright and flips the manual flag, which tells .osk
// replacements and backfill re-scans to leave it alone from here on.
// ownerUserId null is the admin path, which skips the ownership check. The
// keymodeModerator option is the trusted-corrector path (also ownerUserId
// null): same skip, but only over public skins, since a private skin is a 404
// for anyone but its uploader, and its summary never carries owner-only URLs.
export async function setSkinSpecialKeymodes(
  db: Db,
  id: string,
  rawSpecialKeymodes: number[],
  ownerUserId: number | null,
  options?: { keymodeModerator?: boolean },
): Promise<SetSkinSpecialKeymodesResult> {
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  if (options?.keymodeModerator && row.visibility !== "public") return { ok: false, error: "not_found" };
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
  return updated
    ? { ok: true, skin: toSkinSummary(updated, {
        asOwner: !options?.keymodeModerator,
        includePreviewRecipes: !options?.keymodeModerator,
      }) }
    : { ok: false, error: "not_found" };
}

export type UpdateSkinDetailsResult =
  | { ok: true; skin: SkinSummary }
  | { ok: false; error: "not_found" | "forbidden" | "invalid_name" };

// Retitles a published skin and rewrites the blurb under its title. The slug
// deliberately stays as it was published: it is what every shared link points
// at, and a rename must not 404 them. The stored .osk keeps the filename it was
// uploaded under for the same reason - its key is baked into osk_url, which
// browser and edge caches already hold. An omitted description leaves the one
// on the row alone; an empty one clears it.
// ownerUserId null is the admin path, which skips the ownership check.
export async function updateSkinDetails(
  db: Db,
  id: string,
  input: { name: string; description?: string | null; resolution?: string | null },
  ownerUserId: number | null,
): Promise<UpdateSkinDetailsResult> {
  const name = cleanText(input.name, SKIN_NAME_MAX_LENGTH);
  if (!name) return { ok: false, error: "invalid_name" };
  const row = await getSkin(db, id);
  if (!row || row.status === "pending") return { ok: false, error: "not_found" };
  if (ownerUserId != null && row.ownerUserId !== ownerUserId) return { ok: false, error: "forbidden" };
  const description = input.description === undefined
    ? row.description
    : cleanMultilineText(input.description ?? "", SKIN_DESCRIPTION_MAX_LENGTH) || null;
  // Same omission semantics as the description: leaving resolution out keeps
  // what the row holds, sending one replaces it (an unreadable value clears
  // it, since the only thing worth storing is the normalized form).
  const resolution = input.resolution === undefined ? row.resolution : normalizeSkinResolution(input.resolution);
  await exec(
    db,
    "update skins set name = ?, description = ?, resolution = ?, search_text = ?, updated_at = ? where id = ?",
    [name, description, resolution, buildSearchText(name, row.ownerUsername, row.author), nowIso(), id],
  );
  const updated = await getSkin(db, id);
  return updated ? { ok: true, skin: toSkinSummary(updated, { asOwner: true, includePreviewRecipes: true }) } : { ok: false, error: "not_found" };
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
  | { ok: false; error: "not_found" | "invalid_recipes" };

export async function finishSkinEdit(db: Db, id: string, token: string, recipes?: unknown): Promise<FinishSkinEditResult> {
  const row = await getSkinForEdit(db, id, token);
  if (!row) return { ok: false, error: "not_found" };
  const normalizedRecipes = normalizeSkinPreviewRecipeUpdates(recipes);
  if (!normalizedRecipes) return { ok: false, error: "invalid_recipes" };
  // Validate recipe targets against the previews that will survive a replace
  // before pruning anything. A malformed finish request must leave both the
  // row and its still-valid edit ticket untouched.
  const matchingPreviews = row.tokenScope === "replace"
    ? row.previews.filter((preview) => row.keymodes.includes(preview.keys))
    : row.previews;
  const finalPreviews = matchingPreviews.length > 0 ? matchingPreviews : row.previews;
  if (normalizedRecipes.some((entry) => !finalPreviews.some((preview) => preview.keys === entry.keys))) {
    return { ok: false, error: "invalid_recipes" };
  }
  const staleKeys = row.tokenScope === "replace" ? await pruneOrphanedPreviews(db, row) : [];
  if (!await mergeSkinPreviewRecipes(db, id, normalizedRecipes)) return { ok: false, error: "invalid_recipes" };
  await exec(
    db,
    "update skins set upload_token = null, token_expires_at = null, token_scope = null, updated_at = ? where id = ?",
    [nowIso(), id],
  );
  const updated = await getSkin(db, id);
  return updated ? { ok: true, skin: toSkinSummary(updated, { asOwner: true, includePreviewRecipes: true }), staleKeys } : { ok: false, error: "not_found" };
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
  const label = cleanText(entry.label ?? "", SKIN_SCREENSHOT_LABEL_MAX_LENGTH) || null;
  const next = [...row.screenshots, { ...entry, label }];
  await exec(
    db,
    "update skins set screenshots_json = ?, updated_at = ? where id = ?",
    [JSON.stringify(next), nowIso(), id],
  );
  return { ok: true, index: next.length - 1 };
}

export type FinishSkinResult =
  | { ok: true; skin: SkinSummary }
  | { ok: false; error: "not_found" | "missing_osk" | "missing_preview" | "invalid_recipes" };

export async function finishSkin(db: Db, id: string, token: string, recipes?: unknown): Promise<FinishSkinResult> {
  const row = await getSkinForUpload(db, id, token);
  if (!row) return { ok: false, error: "not_found" };
  if (!row.oskKey || !row.oskUrl) return { ok: false, error: "missing_osk" };
  if (!row.previewKey || !row.previewUrl) return { ok: false, error: "missing_preview" };
  const normalizedRecipes = normalizeSkinPreviewRecipeUpdates(recipes);
  if (!normalizedRecipes || !await mergeSkinPreviewRecipes(db, id, normalizedRecipes)) {
    return { ok: false, error: "invalid_recipes" };
  }
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
    ? { ok: true, skin: toSkinSummary(published, { asOwner: true, includePreviewRecipes: true }) }
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

// v2: v1 reconstructed page opens only, which read as nonsense next to the
// download column - the grid's own download button has outnumbered page opens
// since the day skins shipped, so the busiest skins showed more downloads than
// views. v2 counts historical skin_download clicks as the views they were and
// floors every skin at its download count.
const VIEW_BACKFILL_META_KEY = "skin_view_count_backfill:v2";

// Seeds view_count for the catalog that existed before the counter did. The
// numbers come from the analytics store's own rows, which have carried
// props.skin_ref for every skin page and download click all along - so the
// counts arrive with history rather than every skin sitting at zero on deploy
// day. That store is a separate database pruned at ANALYTICS_RETENTION_DAYS,
// so this reaches back about that far and no further.
//
// One-shot via live_meta, marker written only after the work, same as
// backfillSkinSlugs. Only rows still at zero take a reconstructed number, so a
// marker bump re-seeds skins nobody has opened since without stacking on top
// of anything the live counter has already earned; the download floor is
// monotonic, so re-running it can only lift.
export async function backfillSkinViewCounts(
  db: Db,
  readCounts: () => Promise<Map<string, number>>,
): Promise<number> {
  const done = (await exec(db, "select 1 from live_meta where key = ? limit 1", [VIEW_BACKFILL_META_KEY])).rows[0];
  if (done) return 0;
  const counts = await readCounts();
  let updated = 0;
  for (const [ref, views] of counts) {
    // The ref is whatever the URL carried, so it matches on either column -
    // pre-slug links are raw ids and both point at one row.
    const result = await exec(
      db,
      "update skins set view_count = ? where (id = ? or slug = ?) and view_count = 0",
      [views, ref, ref],
    );
    updated += result.rowsAffected ?? 0;
  }
  // Whatever analytics never saw - grabs from browsers that block the capture,
  // from agents that run no JS, from before a rename orphaned the old slug's
  // events - still moved download_count on the server, where nothing can hide.
  // Every counted download was a visitor looking at the skin, so downloads
  // floor the views; recordSkinDownload keeps that invariant live from here on.
  const floored = await exec(db, "update skins set view_count = download_count where download_count > view_count");
  await exec(
    db,
    "insert or replace into live_meta (key, value_json, updated_at) values (?, ?, ?)",
    [VIEW_BACKFILL_META_KEY, JSON.stringify({ seeded: updated, refs: counts.size, floored: floored.rowsAffected ?? 0 }), nowIso()],
  );
  return updated;
}

// Detail-page lookup: accepts the slug from a pretty URL or a raw id from a
// pre-slug link, so old shared URLs keep resolving.
export async function getSkinByRef(db: Db, ref: string): Promise<SkinRow | null> {
  const row = (await exec(db, "select * from skins where id = ? or slug = ? limit 1", [ref, ref])).rows[0];
  return row ? rowToSkin(row as Record<string, unknown>) : null;
}

export type SkinsListSort = "newest" | "oldest" | "downloads" | "downloads-asc" | "size" | "size-asc";

// A row with no stored .osk and one never published carry a null in the column
// being sorted on. Null orders below every value in SQLite, so descending drops
// them to the bottom by itself and only the ascending halves need the null test
// to keep them off the top.
const SKINS_ORDER_SQL: Record<SkinsListSort, string> = {
  newest: "published_at desc, created_at desc",
  oldest: "published_at is null, published_at asc, created_at asc",
  downloads: "download_count desc, published_at desc, created_at desc",
  "downloads-asc": "download_count asc, published_at desc, created_at desc",
  size: "osk_size_bytes desc, published_at desc, created_at desc",
  "size-asc": "osk_size_bytes is null, osk_size_bytes asc, published_at desc, created_at desc",
};

/** The list sort a query string asked for; anything unknown means newest. */
export function parseSkinsListSort(value: string | null | undefined): SkinsListSort {
  return value != null && value in SKINS_ORDER_SQL ? value as SkinsListSort : "newest";
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
  // Three orderings, each with both directions (the browse page toggles them).
  sort?: SkinsListSort;
  // Whose private skins this list may carry. The browse grid passes nothing
  // and stays public; the "your private skins" shelf passes the signed-in
  // viewer, which the endpoint only trusts from an admin-token request.
  privateOwnerUserId?: number | null;
  // Restricts the list to that owner's private skins (the shelf itself).
  onlyPrivate?: boolean;
  // Narrows the list to one uploader, the browse page's "uploader: you" filter.
  // Public information (every summary carries its uploader), so this needs no
  // vouched-for viewer and leaves the list as cacheable as it was: the
  // visibility gate above still decides which of that uploader's skins show.
  ownerUserId?: number | null;
  // Widens the shelf to every uploader's private skins: the moderation view a
  // true admin gets, the same read /api/skins/get already grants them on a
  // single private skin. Only meaningful together with onlyPrivate.
  adminAllPrivate?: boolean;
  // The trait filters, each narrowing to skins the archive analysis said yes
  // about. Rows not analyzed yet (null columns) never match a yes.
  laneCover?: boolean;
  maniaStage?: boolean;
  // Skins with uploader-attached screenshots in the gallery.
  screenshots?: boolean;
  // "lazer" keeps skins carrying lazer-only modifications; "stable" keeps the
  // rest, unanalyzed rows included - a skin without lazer files is a stable
  // skin, and that is what nearly the whole catalog is.
  client?: "lazer" | "stable" | null;
  noteShape?: SkinNoteShape | null;
  // Exact match on the normalized uploader-provided resolution.
  resolution?: string | null;
}

export interface SkinsListResult {
  skins: SkinSummary[];
  total: number;
  page: number;
  pageSize: number;
  // Every resolution an uploader has actually claimed within the rest of this
  // query, smallest first, so the page offers only values with skins behind
  // them instead of a hardcoded ladder that matches nothing.
  resolutions: string[];
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
  // An admin shelf reads every uploader's private skins; the flag is only ever
  // set by an admin-token request that said so explicitly.
  const adminAllPrivate = query.onlyPrivate === true && query.adminAllPrivate === true;
  if (query.onlyPrivate) {
    if (adminAllPrivate) {
      where.push("visibility = 'private'");
    } else if (privateOwner == null) {
      return { skins: [], total: 0, page, pageSize, resolutions: [] };
    } else {
      where.push("visibility = 'private' and owner_user_id = ?");
      args.push(privateOwner);
    }
  } else if (privateOwner != null) {
    where.push("(visibility = 'public' or owner_user_id = ?)");
    args.push(privateOwner);
  } else {
    where.push("visibility = 'public'");
  }

  const ownerFilter = Number.isInteger(query.ownerUserId) && Number(query.ownerUserId) > 0
    ? Number(query.ownerUserId)
    : null;
  if (ownerFilter != null) {
    where.push("owner_user_id = ?");
    args.push(ownerFilter);
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
  if (query.laneCover) where.push("lane_cover = 1");
  if (query.maniaStage) where.push("mania_stage = 1");
  if (query.screenshots) where.push("json_array_length(coalesce(screenshots_json, '[]')) > 0");
  if (query.client === "lazer") where.push("lazer = 1");
  else if (query.client === "stable") where.push("coalesce(lazer, 0) = 0");
  const noteShape = query.noteShape && isSkinNoteShape(query.noteShape) ? query.noteShape : null;
  if (noteShape) {
    where.push("note_shape = ?");
    args.push(noteShape);
  }
  // The resolution facet is read from the query as it stands here, before its
  // own predicate joins it, so picking a resolution does not collapse the row
  // to the one that was picked.
  const facetWhereSql = where.join(" and ");
  const facetArgs = [...args];
  const resolution = normalizeSkinResolution(query.resolution);
  if (resolution) {
    where.push("resolution = ?");
    args.push(resolution);
  }
  const whereSql = where.join(" and ");

  const orderSql = SKINS_ORDER_SQL[query.sort ?? "newest"] ?? SKINS_ORDER_SQL.newest;
  const totalRow = (await exec(db, `select count(*) as total from skins where ${whereSql}`, args)).rows[0];
  const rows = (await exec(
    db,
    `select * from skins where ${whereSql}
     order by ${orderSql}
     limit ? offset ?`,
    [...args, pageSize, page * pageSize],
  )).rows;
  const resolutionRows = (await exec(
    db,
    `select distinct resolution from skins where ${facetWhereSql} and resolution is not null and resolution <> ''`,
    facetArgs,
  )).rows;
  // Ordered by how big the display is rather than by how many skins claim it,
  // so the row reads as a ladder.
  const resolutions = resolutionRows
    .map((row) => String(row.resolution))
    .sort((a, b) => resolutionPixels(a) - resolutionPixels(b) || a.localeCompare(b));

  return {
    // A private row is only ever in here because it belongs to the viewer the
    // caller vouched for, or because a true admin asked for the moderation
    // shelf, so it serializes with its capability URLs attached - stated as an
    // ownership check rather than inherited from the query, so a future filter
    // cannot quietly widen who gets the whole skin.
    skins: rows.map((row) => {
      const skin = rowToSkin(row as Record<string, unknown>);
      const summary = toSkinSummary(skin, { asOwner: adminAllPrivate || (privateOwner != null && skin.ownerUserId === privateOwner) });
      return noteShape ? { ...summary, filterKeys: noteShapeFilterPreviewKeys(skin, noteShape) } : summary;
    }),
    total: Number(totalRow?.total) || 0,
    page,
    pageSize,
    resolutions,
  };
}

// Which stored render makes a note-shape result honest at a glance. Keep the
// uploader's starred keymode when it already matches. Otherwise the two modes
// people judge skins by are alternates: a mismatching 4K cover searches around
// 7K, and a mismatching 7K cover searches around 4K. A special 8K layout is
// 7K+1, so it sits at 7 for distance purposes; regular 7K wins an exact tie.
function noteShapeFilterPreviewKeys(row: SkinRow, shape: SkinNoteShape): number | null {
  if (!row.visual) return null;
  const matching = row.previews
    .map((preview) => {
      const art = row.visual?.keymodes[String(preview.keys)];
      if (!art || classifyKeymodeNoteShape(art.aspect, art.mask, art.arrowLayout === true) !== shape) return null;
      return preview.keys;
    })
    .filter((keys): keys is number => keys != null);
  if (matching.length === 0) return null;

  const coverKeys = row.previews.find((preview) => preview.key === row.previewKey)?.keys ?? null;
  if (coverKeys != null && matching.includes(coverKeys)) return coverKeys;

  const target = coverKeys === 4 ? 7 : 4;
  const effectiveKeys = (keys: number) => row.specialKeymodes.includes(keys) ? keys - 1 : keys;
  return [...matching].sort((a, b) => {
    const distance = Math.abs(effectiveKeys(a) - target) - Math.abs(effectiveKeys(b) - target);
    if (distance !== 0) return distance;
    // 7K before 7K+1 when both prove the filter; the special layout is the
    // fallback when regular 7K does not, as in the Argefangirl skin.
    const exact = Number(b === target) - Number(a === target);
    return exact || b - a;
  })[0] ?? null;
}

// A similar-skins entry: the summary plus which of the candidate's keymodes
// the visual match was made on, so the strip fronts the render that actually
// matched rather than whatever cover the uploader chose. Null when the score
// came from the accent fallback.
export type SimilarSkinSummary = SkinSummary & { matchKeys: number | null };

// A scored candidate before it is worth hydrating: the four facts similarity
// reads plus the tiebreakers, and nothing that costs a kilobyte to parse.
interface SimilarSkinCandidate {
  id: string;
  downloadCount: number;
  publishedAt: string | null;
  facts: SkinSimilarityFacts;
}

// Both halves of the strip are cached in the serving process, because the work
// is a scan of the whole public catalog and the catalog changes far less often
// than skin pages are opened: the parsed candidate facts (shared by every
// skin's strip, so a burst of different skin pages parses the catalog once
// between uploads) and the finished strips themselves, one per skin and
// keymode asked for.
//
// Keyed by a catalog version - how many public published skins there are and
// the newest updated_at among them - so a publish, delete, rename, moderation
// action or .osk replacement drops both. Download counts deliberately do not
// bump updated_at, so the finished strips also carry a TTL: it keeps the
// counts on the cards no more stale than the endpoint's own cache header
// already promises, without making every download invalidate the catalog.
const SIMILAR_ANSWER_TTL_MS = 5 * 60_000;
const SIMILAR_ANSWER_MAX_ENTRIES = 100;

let similarCatalogVersion: string | null = null;
let similarCandidates: SimilarSkinCandidate[] | null = null;
const similarAnswers = new Map<string, { skins: SimilarSkinSummary[]; expiresAt: number }>();

// Test seam, and a restart-equivalent for the admin reset paths.
export function clearSimilarSkinsCache(): void {
  similarCatalogVersion = null;
  similarCandidates = null;
  similarAnswers.clear();
}

async function skinCatalogVersion(db: Db): Promise<string> {
  const row = (await exec(
    db,
    "select count(*) as total, max(updated_at) as newest from skins where status = 'published' and visibility = 'public'",
  )).rows[0];
  return `${Number(row?.total) || 0}|${String(row?.newest ?? "")}`;
}

async function loadSimilarCandidates(db: Db): Promise<SimilarSkinCandidate[]> {
  // Narrow on purpose: a whole row carries the previews and screenshots JSON
  // (over a kilobyte apiece) that only the handful of winners ever serialize.
  const rows = (await exec(
    db,
    `select id, author, keymodes_json, accent_color, visual_json, download_count, published_at
     from skins where status = 'published' and visibility = 'public'`,
  )).rows;
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      downloadCount: Math.max(0, Math.floor(Number(row.download_count) || 0)),
      publishedAt: textOrNull(row.published_at),
      facts: {
        author: textOrNull(row.author),
        keymodes: normalizeKeymodes(parseJson<unknown>(String(row.keymodes_json ?? "[]"), [])),
        accentColor: textOrNull(row.accent_color),
        visual: normalizeSkinVisualSignature(parseJson<unknown>(String(row.visual_json ?? "null"), null)),
      },
    };
  });
}

// The detail page's "similar skins" strip: the public catalog scored against
// the skin being viewed (src/skins/similarity.ts says what similar means),
// junk below the floor dropped, ties broken toward what people download.
// Candidates are public rows only, so what comes back is exactly what
// /api/skins/list would show anyone, and the target skin never recommends
// itself. Only the winners are read back in full, by id.
export async function listSimilarSkins(db: Db, skin: SkinRow, limit = 6, keys?: number | null): Promise<SimilarSkinSummary[]> {
  const capped = Math.max(1, Math.min(12, Math.floor(limit)));
  // The keymode the viewer has open, when the page said: the answer to "what
  // looks like this" is genuinely different per keymode, since skins change
  // note shape across their range.
  const atKeys = Number.isInteger(keys) && Number(keys) >= 1 && Number(keys) <= 10 ? Number(keys) : null;
  const version = await skinCatalogVersion(db);
  if (version !== similarCatalogVersion) {
    similarCatalogVersion = version;
    similarCandidates = null;
    similarAnswers.clear();
  }
  const answerKey = `${skin.id}|${capped}|${atKeys ?? "any"}`;
  const cached = similarAnswers.get(answerKey);
  if (cached && cached.expiresAt > Date.now()) return cached.skins;

  similarCandidates ??= await loadSimilarCandidates(db);
  const winners = similarCandidates
    .filter((candidate) => candidate.id !== skin.id)
    .map((candidate) => ({ candidate, match: skinSimilarityMatch(skin, candidate.facts, { keys: atKeys }) }))
    .filter((entry) => entry.match.score >= SKIN_SIMILARITY_FLOOR)
    .sort((a, b) => b.match.score - a.match.score
      || b.candidate.downloadCount - a.candidate.downloadCount
      || (b.candidate.publishedAt ?? "").localeCompare(a.candidate.publishedAt ?? ""))
    .slice(0, capped);

  let skins: SimilarSkinSummary[] = [];
  if (winners.length > 0) {
    const full = new Map<string, SkinRow>();
    for (const raw of (await exec(
      db,
      `select * from skins where id in (${winners.map(() => "?").join(", ")})`,
      winners.map((entry) => entry.candidate.id),
    )).rows) {
      const row = rowToSkin(raw as Record<string, unknown>);
      full.set(row.id, row);
    }
    // A row that vanished between the two queries (deleted mid-request) drops
    // out rather than showing up half-built.
    skins = winners
      .map((entry) => {
        const row = full.get(entry.candidate.id);
        return row ? { ...toSkinSummary(row), matchKeys: entry.match.matchKeys } : null;
      })
      .filter((entry): entry is SimilarSkinSummary => entry != null);
  }

  // Oldest out first: the map keeps insertion order, and a strip nobody is
  // asking for any more is the one worth dropping.
  similarAnswers.set(answerKey, { skins, expiresAt: Date.now() + SIMILAR_ANSWER_TTL_MS });
  while (similarAnswers.size > SIMILAR_ANSWER_MAX_ENTRIES) {
    const oldest = similarAnswers.keys().next();
    if (oldest.done) break;
    similarAnswers.delete(oldest.value);
  }
  return skins;
}

// One counted hit per visitor per skin per window. The counters are the
// catalog's popularity signals (the downloads sort, the two numbers on the
// card), and while downloads incremented unconditionally two people clicked
// one skin to 1.4k in an hour - well inside the publicApi rate limit, so only
// dedup stops it. In memory on purpose: the serving process is the only
// writer, and the worst a restart forgives is one extra count per visitor per
// skin.
const DEDUP_MAX_ENTRIES = 100_000;

function createVisitorDedup(ttlMs: number) {
  const counted = new Map<string, number>();
  return {
    shouldCount(skinId: string, visitor: string): boolean {
      const now = Date.now();
      const key = `${skinId}:${visitor}`;
      const countedUntil = counted.get(key);
      if (countedUntil !== undefined && countedUntil > now) return false;
      // Delete before set so a lapsed key re-enters at the back, keeping the
      // map's insertion order the eviction order when the cap trims the front.
      counted.delete(key);
      counted.set(key, now + ttlMs);
      while (counted.size > DEDUP_MAX_ENTRIES) {
        const oldest = counted.keys().next();
        if (oldest.done) break;
        counted.delete(oldest.value);
      }
      return true;
    },
    clear(): void {
      counted.clear();
    },
  };
}

const downloadDedup = createVisitorDedup(24 * 60 * 60_000);
// Shorter than a download's window: opening a skin page is the cheap, frequent
// act, so somebody coming back to it in the evening is a second view while
// somebody reloading it as they read is not.
const viewDedup = createVisitorDedup(6 * 60 * 60_000);

// Test seams.
export function clearSkinDownloadDedup(): void {
  downloadDedup.clear();
}

export function clearSkinViewDedup(): void {
  viewDedup.clear();
}

// Counts a download and hands back the redirect target. Only published public
// skins count (and resolve): hidden, pending or private ones return null so the
// endpoint 404s. A private skin has no counted download at all - its owner
// fetches the file through the capability URL on their own page. The visitor
// is the caller's IP: a repeat grab within a day still resolves so the file
// arrives, it just doesn't count again.
export async function recordSkinDownload(db: Db, id: string, visitor: string): Promise<string | null> {
  const row = await getSkin(db, id);
  if (!row || row.status !== "published" || row.visibility !== "public" || !row.oskUrl) return null;
  // A grab is a look: every counted download also moves the view count,
  // through the same dedup views use everywhere else, so the pair can never
  // drift into the "1 download, 0 views" reading no matter how the .osk was
  // fetched - the grid button, a shared link, an agent that runs no JS. A
  // visitor whose page open already counted the view inside its window adds
  // only the download here.
  const countDownload = downloadDedup.shouldCount(row.id, visitor);
  const countView = viewDedup.shouldCount(row.id, visitor);
  if (countDownload || countView) {
    await exec(
      db,
      "update skins set download_count = download_count + ?, view_count = view_count + ? where id = ?",
      [countDownload ? 1 : 0, countView ? 1 : 0, row.id],
    );
  }
  return row.oskUrl;
}

// Counts one open of a skin's page. Mirrors recordSkinDownload: only a
// published public skin has a public number to move, so a hidden, pending or
// private one answers false and the page renders exactly as before. The ref is
// the slug from the pretty URL or a raw row id, matching /api/skins/get, and
// the visitor is the caller's IP - which is why this is its own browser-facing
// endpoint rather than a side effect of the page fetch, that one arrives from
// the frontend server and would put every reader in one bucket.
export async function recordSkinView(db: Db, ref: string, visitor: string): Promise<boolean> {
  const row = await getSkinByRef(db, ref);
  if (!row || row.status !== "published" || row.visibility !== "public") return false;
  if (viewDedup.shouldCount(row.id, visitor)) {
    await exec(db, "update skins set view_count = view_count + 1 where id = ?", [row.id]);
  }
  return true;
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
export function toSkinSummary(row: SkinRow, options?: { asOwner?: boolean; includePreviewRecipes?: boolean }): SkinSummary {
  const previews = row.previews.map(({ keys, url, width, height, recipe }) => ({
    keys,
    url,
    width,
    height,
    ...(options?.includePreviewRecipes && recipe ? { recipe } : {}),
  }));
  const screenshots = row.screenshots.map(({ url, width, height, label }) => ({ url, width, height, label }));
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
    laneCover: row.laneCover,
    maniaStage: row.maniaStage,
    lazer: row.lazer,
    noteShape: row.noteShape,
    resolution: row.resolution,
    downloadCount: row.downloadCount,
    viewCount: row.viewCount,
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
    viewCount: 0,
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
    visual: normalizeSkinVisualSignature(parseJson<unknown>(String(row.visual_json ?? "null"), null)),
    laneCover: boolOrNull(row.lane_cover),
    maniaStage: boolOrNull(row.mania_stage),
    lazer: boolOrNull(row.lazer),
    noteShape: isSkinNoteShape(row.note_shape) ? row.note_shape : null,
    resolution: textOrNull(row.resolution),
    downloadCount: Math.max(0, Math.floor(Number(row.download_count) || 0)),
    viewCount: Math.max(0, Math.floor(Number(row.view_count) || 0)),
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
      const label = typeof raw.label === "string"
        ? cleanText(raw.label, SKIN_SCREENSHOT_LABEL_MAX_LENGTH) || null
        : null;
      return { key, url, width: numberOrNull(raw.width), height: numberOrNull(raw.height), label };
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
      const recipe = normalizeSkinPreviewRecipe(raw.recipe, keys);
      return {
        keys,
        key,
        url,
        width: numberOrNull(raw.width),
        height: numberOrNull(raw.height),
        ...(recipe ? { recipe } : {}),
      };
    })
    .filter((entry): entry is SkinKeymodePreview => Boolean(entry))
    .sort((a, b) => a.keys - b.keys);
}

interface NormalizedSkinPreviewRecipeUpdate {
  keys: number;
  recipe: SkinPreviewRecipe;
}

const SKIN_PREVIEW_RECIPE_MAX_NOTES = 512;
const SKIN_PREVIEW_RECIPE_MAX_TIME = 86_400_000;

function normalizeSkinPreviewRecipe(value: unknown, expectedKeys: number): SkinPreviewRecipe | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const backdropNumber = Math.round(Number(raw.backdrop));
  const backdrop = raw.backdrop === "flat"
    ? "flat"
    : Number.isSafeInteger(backdropNumber) && backdropNumber > 0 && backdropNumber <= 2_147_483_647
      ? backdropNumber
      : null;
  if (backdrop == null) return null;
  if (raw.pattern == null) return { backdrop, pattern: null };
  if (typeof raw.pattern !== "object") return null;
  const patternRaw = raw.pattern as Record<string, unknown>;
  const beatmapId = Math.round(Number(patternRaw.beatmapId));
  const keys = Math.round(Number(patternRaw.keys));
  const stars = Number(patternRaw.stars);
  if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0 || keys !== expectedKeys || !Number.isFinite(stars) || stars < 0 || stars > 100) {
    return null;
  }
  if (!Array.isArray(patternRaw.notes) || patternRaw.notes.length === 0 || patternRaw.notes.length > SKIN_PREVIEW_RECIPE_MAX_NOTES) {
    return null;
  }
  const notes: SkinPreviewRecipeNote[] = [];
  for (const entry of patternRaw.notes) {
    if (!entry || typeof entry !== "object") return null;
    const note = entry as Record<string, unknown>;
    const column = Math.round(Number(note.column));
    const time = Math.round(Number(note.time));
    const endTime = Math.round(Number(note.endTime));
    if (!Number.isInteger(column) || column < 0 || column >= keys
      || !Number.isSafeInteger(time) || !Number.isSafeInteger(endTime)
      || Math.abs(time) > SKIN_PREVIEW_RECIPE_MAX_TIME || Math.abs(endTime) > SKIN_PREVIEW_RECIPE_MAX_TIME
      || endTime < time) {
      return null;
    }
    notes.push({ column, time, endTime });
  }
  return {
    backdrop,
    pattern: {
      beatmapId,
      keys,
      label: cleanText(typeof patternRaw.label === "string" ? patternRaw.label : "", 200),
      stars: Math.round(stars * 100) / 100,
      notes,
    },
  };
}

function normalizeSkinPreviewRecipeUpdates(value: unknown): NormalizedSkinPreviewRecipeUpdate[] | null {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10) return null;
  const updates: NormalizedSkinPreviewRecipeUpdate[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const raw = entry as Record<string, unknown>;
    const keys = Math.round(Number(raw.keys));
    if (!Number.isInteger(keys) || keys < 1 || keys > 10 || seen.has(keys)) return null;
    const recipe = normalizeSkinPreviewRecipe(raw.recipe, keys);
    if (!recipe) return null;
    seen.add(keys);
    updates.push({ keys, recipe });
  }
  return updates;
}

async function mergeSkinPreviewRecipes(
  db: Db,
  id: string,
  updates: NormalizedSkinPreviewRecipeUpdate[],
): Promise<boolean> {
  if (updates.length === 0) return true;
  const row = await getSkin(db, id);
  if (!row) return false;
  const recipes = new Map(updates.map((entry) => [entry.keys, entry.recipe]));
  if ([...recipes.keys()].some((keys) => !row.previews.some((preview) => preview.keys === keys))) return false;
  const previews = row.previews.map((preview) => {
    const recipe = recipes.get(preview.keys);
    return recipe ? { ...preview, recipe } : preview;
  });
  await exec(db, "update skins set previews_json = ?, updated_at = ? where id = ?", [JSON.stringify(previews), nowIso(), id]);
  return true;
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

// Nullable 0/1 column: null stays "not analyzed" rather than collapsing to no.
function boolOrNull(value: unknown): boolean | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed !== 0 : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
