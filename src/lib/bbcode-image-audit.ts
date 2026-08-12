// Server-only audit of the images the BBCode editor uploaded to R2, answering
// the one question that decides whether a file can be deleted: is anybody's
// osu! profile still pointing at it?
//
// There is no database behind these uploads. The object's own `uploaded-by`
// metadata is the only record that they happened (see public-image-store.ts),
// and osu! profiles are the only place the URLs live. So the audit matches both
// sides: every object under bbcode/, against the raw BBCode of the profiles
// that uploaded them.
//
// Reading those profiles is the expensive half. The whole site shares an osu!
// budget of ~45 calls/minute, so this module never reads a profile on its own
// initiative: listing the bucket costs no osu! budget and happens on view,
// while each profile read is one call an admin asked for, one at a time. What a
// check buys expires (PROFILE_READ_TTL_MS), so evidence is always recent.
//
// Two properties matter more than completeness here, because the output is used
// to delete files that have no second copy:
//
//   - Objects are content-addressed, so one file can be embedded by several
//     people while `uploaded-by` names only whoever uploaded it last. "Unused"
//     therefore has to mean "no profile we read embeds it", not "its uploader
//     doesn't embed it" - which is why it takes every uploader being checked.
//   - A profile that was not read, failed to read, or was read too long ago
//     proves nothing. Its images stay `unknown` rather than `unused`, so no
//     gap in the evidence can present a live image as safe to delete.

import { osuFetch } from "./api";
import { scanR2AdminPrefixWithMetadata, deleteR2AdminObject } from "./r2-cache";
import { getPublicBucketBaseUrl } from "./public-image-store";
import type { OsuUser } from "./types";

const BBCODE_PREFIX = "bbcode/";
const BUCKET_ID = "public";
/** Far above the ~dozens of images this prefix holds; a stop, not a page size. */
const MAX_OBJECTS = 5000;
/**
 * How long a profile read counts as evidence.
 *
 * Deleting is gated on the same window, so this is really the answer to "how
 * stale may a page be when we delete a file on its say-so?". Long enough to
 * check a handful of uploaders and then decide; short enough that nobody has
 * plausibly rebuilt their profile since.
 */
const PROFILE_READ_TTL_MS = 15 * 60_000;
/** The R2 listing costs no osu! budget, so this is only about not re-listing. */
const SCAN_CACHE_TTL_MS = 60_000;

export type BbcodeImageStatus = "in-use" | "unused" | "unknown";

export interface BbcodeImageRow {
  key: string;
  fileName: string;
  url: string | null;
  sizeBytes: number;
  lastModified: string | null;
  contentType: string | null;
  /** osu! user id parsed out of the `uploaded-by` metadata, when it names one. */
  uploaderId: number | null;
  /** The raw metadata value, for uploads that predate or sidestep that format. */
  uploadedBy: string | null;
  /** Ids of the profiles that were checked and found to embed this image. */
  usedBy: number[];
  status: BbcodeImageStatus;
}

export type BbcodeUploaderState = "unchecked" | "checked" | "expired" | "failed";

export interface BbcodeUploader {
  userId: number;
  /** Only known once the profile has been read at least once. */
  username: string | null;
  state: BbcodeUploaderState;
  checkedAt: string | null;
  error: string | null;
  /** Objects whose metadata names them as the uploader. */
  uploadCount: number;
  /** Objects their page was found to embed, when the read is current. */
  usedCount: number;
}

export interface BbcodeImageAudit {
  configured: boolean;
  scannedAt: string;
  truncated: boolean;
  objects: BbcodeImageRow[];
  uploaders: BbcodeUploader[];
  /** Current profile reads out of uploaders that need one. */
  coverage: { checked: number; total: number };
  totals: { objects: number; bytes: number; unusedObjects: number; unusedBytes: number };
}

interface ProfileRead {
  userId: number;
  username: string | null;
  ok: boolean;
  error: string | null;
  raw: string;
  readAt: number;
}

/**
 * What has been checked, and when. Process-local and deliberately not durable:
 * it is evidence with a short shelf life, not a record of anything.
 */
const profileReads = new Map<number, ProfileRead>();

function isCurrent(read: ProfileRead | undefined, now: number): read is ProfileRead {
  return read !== undefined && read.ok && now - read.readAt < PROFILE_READ_TTL_MS;
}

/** `user:12345` -> 12345. Anything else (e.g. `local-dev`) has no id. */
function parseUploaderId(uploadedBy: string | null): number | null {
  const match = /^user:(\d+)$/.exec(uploadedBy ?? "");
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Reads a profile's BBCode source straight from osu!, deliberately uncached.
 *
 * The cached reader would happily answer with a page from before the user
 * pasted the image in, and this answer is used to delete files.
 */
async function fetchProfileSource(userId: number): Promise<ProfileRead> {
  const readAt = Date.now();
  try {
    const user = await osuFetch<OsuUser>(`/users/${userId}/mania`, undefined, {
      caller: "bbcodeImageAudit",
    });
    return {
      userId,
      username: user.username ?? null,
      ok: true,
      error: null,
      raw: user.page?.raw ?? "",
      readAt,
    };
  } catch (error) {
    return {
      userId,
      username: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      raw: "",
      readAt,
    };
  }
}

/**
 * Whether a profile's BBCode embeds this object.
 *
 * Matches on the file name rather than the full URL: the name is a sha256 of
 * the bytes, so it cannot collide by accident, and it stays a hit whether the
 * page uses [img], an [imagemap], a bare [url], the CDN host or some proxy of
 * it that kept the path.
 */
function profileEmbeds(raw: string, fileName: string): boolean {
  return raw.includes(fileName);
}

interface StagedObject {
  key: string;
  fileName: string;
  url: string | null;
  sizeBytes: number;
  lastModified: string | null;
  contentType: string | null;
  uploadedBy: string | null;
  uploaderId: number | null;
}

interface Listing {
  configured: boolean;
  scannedAt: string;
  truncated: boolean;
  staged: StagedObject[];
}

let cachedListing: { startedAt: number; listing: Promise<Listing> } | null = null;

/**
 * The bucket side of the audit: one LIST plus a HEAD per object that changed.
 *
 * Shared for a minute so a reload or a second tab does not re-walk the prefix,
 * and re-read from scratch when it is about to be acted on.
 */
async function listBbcodeObjects(fresh: boolean): Promise<Listing> {
  if (!fresh && cachedListing && Date.now() - cachedListing.startedAt < SCAN_CACHE_TTL_MS) {
    return cachedListing.listing;
  }
  const listing = runListing(fresh);
  cachedListing = { startedAt: Date.now(), listing };
  listing.catch(() => {
    if (cachedListing?.listing === listing) cachedListing = null;
  });
  return listing;
}

async function runListing(fresh: boolean): Promise<Listing> {
  const scannedAt = new Date().toISOString();
  const scan = await scanR2AdminPrefixWithMetadata({
    bucket: BUCKET_ID,
    prefix: BBCODE_PREFIX,
    maxObjects: MAX_OBJECTS,
    // The metadata names the uploader whose profile decides "unused", so a
    // listing that is about to be deleted from re-reads it rather than trusting
    // an unchanged-looking key.
    useMetadataCache: !fresh,
  });

  if (!scan.configured) {
    return { configured: false, scannedAt, truncated: false, staged: [] };
  }

  const baseUrl = getPublicBucketBaseUrl();
  const staged = scan.objects.map((object) => {
    const uploadedBy = object.metadata["uploaded-by"] ?? null;
    return {
      key: object.key,
      fileName: object.key.slice(BBCODE_PREFIX.length),
      url: baseUrl ? `${baseUrl}/${object.key}` : null,
      sizeBytes: object.sizeBytes,
      lastModified: object.lastModified,
      contentType: object.contentType,
      uploadedBy,
      uploaderId: parseUploaderId(uploadedBy),
    };
  });

  return { configured: true, scannedAt, truncated: scan.truncated, staged };
}

/** Drops the shared listing, so the next read re-walks the prefix. */
export function invalidateBbcodeImageListing(): void {
  cachedListing = null;
}

/** Forgets every profile read. Exported for tests. */
export function clearBbcodeProfileReads(): void {
  profileReads.clear();
}

function buildAudit(listing: Listing): BbcodeImageAudit {
  const now = Date.now();
  if (!listing.configured) {
    return {
      configured: false,
      scannedAt: listing.scannedAt,
      truncated: false,
      objects: [],
      uploaders: [],
      coverage: { checked: 0, total: 0 },
      totals: { objects: 0, bytes: 0, unusedObjects: 0, unusedBytes: 0 },
    };
  }

  const uploaderIds = [
    ...new Set(listing.staged.map((row) => row.uploaderId).filter((id): id is number => id !== null)),
  ];
  // "Unused" is a claim about every profile that could be embedding a shared
  // file, so it takes a current read of all of them - not just this file's own
  // uploader, and not a read from an hour ago.
  const fullyCovered = uploaderIds.every((id) => isCurrent(profileReads.get(id), now));
  const usedCounts = new Map<number, number>();

  const objects: BbcodeImageRow[] = listing.staged.map((row) => {
    const usedBy = uploaderIds.filter((id) => {
      const read = profileReads.get(id);
      return isCurrent(read, now) && profileEmbeds(read.raw, row.fileName);
    });
    for (const id of usedBy) usedCounts.set(id, (usedCounts.get(id) ?? 0) + 1);

    // An upload whose metadata names nobody has no profile that could vouch for
    // it, so no amount of checking makes it deletable.
    const status: BbcodeImageStatus = usedBy.length > 0
      ? "in-use"
      : fullyCovered && row.uploaderId !== null
        ? "unused"
        : "unknown";

    return { ...row, usedBy, status };
  });

  const uploaders: BbcodeUploader[] = uploaderIds
    .map((userId) => {
      const read = profileReads.get(userId);
      const current = isCurrent(read, now);
      const state: BbcodeUploaderState = read === undefined
        ? "unchecked"
        : !read.ok
          ? "failed"
          : current
            ? "checked"
            : "expired";
      return {
        userId,
        username: read?.username ?? null,
        state,
        checkedAt: read ? new Date(read.readAt).toISOString() : null,
        error: read?.ok === false ? read.error : null,
        uploadCount: listing.staged.filter((row) => row.uploaderId === userId).length,
        usedCount: current ? usedCounts.get(userId) ?? 0 : 0,
      };
    })
    .sort((a, b) => b.uploadCount - a.uploadCount || a.userId - b.userId);

  const unused = objects.filter((object) => object.status === "unused");
  return {
    configured: true,
    scannedAt: listing.scannedAt,
    truncated: listing.truncated,
    objects: objects.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? "")),
    uploaders,
    coverage: {
      checked: uploaderIds.filter((id) => isCurrent(profileReads.get(id), now)).length,
      total: uploaderIds.length,
    },
    totals: {
      objects: objects.length,
      bytes: objects.reduce((sum, object) => sum + object.sizeBytes, 0),
      unusedObjects: unused.length,
      unusedBytes: unused.reduce((sum, object) => sum + object.sizeBytes, 0),
    },
  };
}

/**
 * The bucket as it stands, judged against whatever profile reads are current.
 *
 * Spends no osu! budget at all: everything here is R2 plus what earlier checks
 * already established. On a page with nothing checked yet, every image is
 * `unknown` and nothing is deletable, which is the accurate answer.
 */
export async function auditBbcodeImages(
  options: { fresh?: boolean } = {},
): Promise<BbcodeImageAudit> {
  return buildAudit(await listBbcodeObjects(options.fresh === true));
}

/**
 * Reads exactly one profile, then re-judges the listing against it.
 *
 * This is the only place the audit spends osu! budget, and it costs a single
 * call, made because somebody asked for it. Checking several uploaders is the
 * caller repeating this one at a time rather than a burst.
 */
export async function checkBbcodeUploaderProfile(userId: number): Promise<BbcodeImageAudit> {
  const listing = await listBbcodeObjects(false);
  const known = listing.staged.some((row) => row.uploaderId === userId);
  // Only ids the bucket itself names, so this cannot be driven as a general
  // "fetch me any osu! profile" endpoint.
  if (!known) {
    throw new Error(`No bbcode/ upload names user ${userId}.`);
  }

  profileReads.set(userId, await fetchProfileSource(userId));
  return buildAudit(listing);
}

export interface BbcodeImageDeleteResult {
  deleted: string[];
  refused: Array<{ key: string; reason: string }>;
  freedBytes: number;
}

/**
 * Deletes the given objects, but only the ones a fresh listing still calls
 * unused - which takes a current read of every uploader's profile.
 *
 * The re-check is the point. The list the admin clicked was rendered from a
 * scan that may be minutes old, and in between someone can paste the image into
 * their profile; these files have no second copy, so the check that matters is
 * the one taken at the moment of deletion, server side, against keys the client
 * does not get to label for itself.
 */
export async function deleteUnusedBbcodeImages(keys: string[]): Promise<BbcodeImageDeleteResult> {
  const wanted = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  const result: BbcodeImageDeleteResult = { deleted: [], refused: [], freedBytes: 0 };
  if (wanted.length === 0) return result;

  const audit = buildAudit(await listBbcodeObjects(true));
  const byKey = new Map(audit.objects.map((object) => [object.key, object]));

  for (const key of wanted) {
    const object = byKey.get(key);
    if (!object) {
      result.refused.push({ key, reason: "not found in the bbcode/ prefix" });
      continue;
    }
    if (object.status === "in-use") {
      const who = object.usedBy.join(", ");
      result.refused.push({ key, reason: `still embedded on ${who ? `profile ${who}` : "a profile"}` });
      continue;
    }
    if (object.status === "unknown") {
      const missing = audit.coverage.total - audit.coverage.checked;
      result.refused.push({
        key,
        reason: missing > 0
          ? `${missing} uploader profile${missing > 1 ? "s" : ""} still unchecked`
          : "no uploader profile can vouch for it",
      });
      continue;
    }
    await deleteR2AdminObject(BUCKET_ID, key);
    result.deleted.push(key);
    result.freedBytes += object.sizeBytes;
  }

  // The listing this ran against still holds what was just deleted, and the
  // reload that follows would otherwise be served exactly that.
  if (result.deleted.length > 0) invalidateBbcodeImageListing();
  return result;
}
