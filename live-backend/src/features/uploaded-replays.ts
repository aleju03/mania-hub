import type { Db } from "../db.js";
import { exec } from "../db.js";

// The owner index for .osr files uploaded through the frontend's
// /api/replay-upload. The file itself lives in R2 (the frontend owns that
// bucket) and every human-readable field is still derived from the .osr on
// demand; this table only answers "who uploaded this, and when", which the R2
// object's own metadata cannot be queried for.
//
// Rows are written best-effort after the upload succeeds, so a row can be
// missing for an upload that exists (an index outage, or an upload made before
// this table did). The R2 prefix stays the truth about which files exist -
// /admin/r2 browses it - and backfillUploadedReplayOwners on the frontend
// re-attaches old objects to their uploaders from that same metadata.

export interface UploadedReplayRow {
  id: string;
  ownerUserId: number;
  ownerUsername: string;
  originalFilename: string | null;
  uploadedAt: string;
}

function toRow(row: Record<string, unknown>): UploadedReplayRow {
  return {
    id: String(row.id ?? ""),
    ownerUserId: Number(row.owner_user_id ?? 0),
    ownerUsername: String(row.owner_username ?? ""),
    originalFilename: row.original_filename == null ? null : String(row.original_filename),
    uploadedAt: String(row.uploaded_at ?? ""),
  };
}

// Idempotent: the frontend may retry the record call after a transient failure,
// and a re-recorded id keeps its original upload time.
export async function recordUploadedReplay(db: Db, entry: UploadedReplayRow): Promise<void> {
  await exec(
    db,
    `insert into uploaded_replays (id, owner_user_id, owner_username, original_filename, uploaded_at)
     values (?, ?, ?, ?, ?)
     on conflict(id) do update set
       owner_user_id = excluded.owner_user_id,
       -- The backfill knows the uploader id from R2 metadata but not their
       -- name, so an empty name must never blank out one we already have.
       owner_username = coalesce(nullif(excluded.owner_username, ''), uploaded_replays.owner_username),
       original_filename = coalesce(excluded.original_filename, uploaded_replays.original_filename)`,
    [entry.id, entry.ownerUserId, entry.ownerUsername, entry.originalFilename, entry.uploadedAt],
  );
}

export async function getUploadedReplayRow(db: Db, id: string): Promise<UploadedReplayRow | null> {
  // Same name fill as the list: a backfilled row stores an id but no name.
  const row = (await exec(
    db,
    `select r.id, r.owner_user_id, r.original_filename, r.uploaded_at,
            coalesce(nullif(r.owner_username, ''), u.username, '') as owner_username
       from uploaded_replays r
       left join users u on u.user_id = r.owner_user_id
      where r.id = ?`,
    [id],
  )).rows[0];
  return row ? toRow(row as Record<string, unknown>) : null;
}

export interface UploadedReplayListOptions {
  /** Null only together with allOwners: nobody's shelf is "everyone's". */
  ownerUserId: number | null;
  allOwners: boolean;
  page: number;
  pageSize: number;
}

export interface UploadedReplayList {
  uploads: UploadedReplayRow[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export async function listUploadedReplays(db: Db, options: UploadedReplayListOptions): Promise<UploadedReplayList> {
  const pageSize = Math.max(1, Math.min(60, Math.floor(options.pageSize)));
  const page = Math.max(0, Math.floor(options.page));
  if (!options.allOwners && (options.ownerUserId == null || options.ownerUserId <= 0)) {
    return { uploads: [], total: 0, page, pageSize, hasMore: false };
  }

  const where = options.allOwners ? "" : "where r.owner_user_id = ?";
  const args = options.allOwners ? [] : [options.ownerUserId as number];
  const total = Number(
    (await exec(db, `select count(*) as n from uploaded_replays r ${where}`, args)).rows[0]?.n ?? 0,
  );
  // The join fills in the uploader's name for rows the backfill wrote, which
  // recovers an id from R2 metadata and has no name to go with it.
  const rows = (await exec(
    db,
    `select r.id, r.owner_user_id, r.original_filename, r.uploaded_at,
            coalesce(nullif(r.owner_username, ''), u.username, '') as owner_username
       from uploaded_replays r
       left join users u on u.user_id = r.owner_user_id
       ${where}
      order by r.uploaded_at desc, r.id desc
      limit ? offset ?`,
    [...args, pageSize, page * pageSize],
  )).rows.map((row) => toRow(row as Record<string, unknown>));

  return { uploads: rows, total, page, pageSize, hasMore: (page + 1) * pageSize < total };
}

/** Returns the deleted row, or null when the id was never indexed. */
export async function deleteUploadedReplayRow(db: Db, id: string): Promise<UploadedReplayRow | null> {
  const existing = await getUploadedReplayRow(db, id);
  if (!existing) return null;
  await exec(db, "delete from uploaded_replays where id = ?", [id]);
  return existing;
}
