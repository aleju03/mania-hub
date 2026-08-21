import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec } from "../db.js";

// Reader-submitted reports about the site's own UI translations: someone
// browsing in a non-English locale hits a string that reads wrong and says so
// from the settings panel's language tab. Submissions are open to signed-out
// visitors too (a translation reader is not necessarily a logged-in player), so
// the only identity a row carries is whatever the frontend could verify: the
// osu! viewer id when there is a login cookie, nothing otherwise. The HTTP
// layer keys its per-IP rate limit on the forwarded visitor address; the caps
// here are the second line, bounding how much one reporter can leave in the
// table regardless of how the request arrived.
//
// Reading, triaging and deleting is admin-only (/admin/translation-reports).
// The table is durable: retention never prunes it.

export type TranslationReportStatus = "new" | "resolved" | "dismissed";

export const TRANSLATION_REPORT_STATUSES: readonly TranslationReportStatus[] = ["new", "resolved", "dismissed"];

const LOCALE_MAX = 20;
const SOURCE_TEXT_MAX = 600;
const SUGGESTION_MAX = 600;
const NOTE_MAX = 2000;
const PAGE_PATH_MAX = 300;
const USERNAME_MAX = 60;
const REPORTER_KEY_MAX = 120;
const ADMIN_NOTE_MAX = 5000;

const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 100;

// How much one reporter may leave behind. The window is the same 24h the
// duplicate guard uses, so a reporter who fills it waits a day rather than
// losing the ability to report forever.
export const TRANSLATION_REPORT_PER_REPORTER_PER_DAY = 30;
// A reporter the frontend could not tell apart from any other (no login, and
// no client address to key on because the deployment does not trust proxy
// headers) lands in one shared "anon" bucket. Capping that at the per-reporter
// number would let a single spammer spend every anonymous visitor's budget for
// the day, so the shared bucket gets its own, much larger ceiling: still a
// bound on how much junk can land, not a per-person quota.
export const TRANSLATION_REPORT_SHARED_ANON_PER_DAY = 200;
const SHARED_REPORTER_KEY = "anon";
const REPORTER_WINDOW_MS = 24 * 60 * 60_000;

export interface TranslationReport {
  id: string;
  locale: string;
  status: TranslationReportStatus;
  /** The string as the reporter saw it on screen (their words, their locale). */
  sourceText: string;
  suggestion: string | null;
  note: string | null;
  /** Path the reporter was on when they opened the form; query string stripped. */
  pagePath: string | null;
  userId: number | null;
  username: string | null;
  adminNote: string | null;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
}

export interface TranslationReportInput {
  locale?: unknown;
  sourceText?: unknown;
  suggestion?: unknown;
  note?: unknown;
  pagePath?: unknown;
  userId?: unknown;
  username?: unknown;
  /** Opaque per-reporter bucket ("user:123" / "ip:<hash>"), never shown to admins. */
  reporterKey?: unknown;
}

export type CreateTranslationReportResult =
  | { ok: true; report: TranslationReport; duplicate: boolean }
  | { ok: false; reason: "invalid_report" | "too_many_reports" };

export interface TranslationReportCounts {
  new: number;
  resolved: number;
  dismissed: number;
  total: number;
}

export interface ListTranslationReportsOptions {
  status?: unknown;
  locale?: unknown;
  limit?: unknown;
  offset?: unknown;
  search?: unknown;
}

export interface TranslationReportPage {
  reports: TranslationReport[];
  counts: TranslationReportCounts;
  /** Rows matching the active filters, before limit/offset. */
  total: number;
}

export function normalizeTranslationReportStatus(value: unknown): TranslationReportStatus | null {
  return TRANSLATION_REPORT_STATUSES.includes(value as TranslationReportStatus)
    ? (value as TranslationReportStatus)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length ? trimmed : null;
}

// Locales arrive from the browser, so they are shape-checked rather than
// matched against a list: the backend has no copy of the frontend's supported
// locales, and a tag it does not recognize is still worth filing.
function normalizeLocale(value: unknown): string | null {
  const raw = text(value, LOCALE_MAX);
  if (!raw) return null;
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/.test(raw) ? raw : null;
}

// Only the path is kept: a query string can carry a user's own filters and
// nothing about "where the wrong string was" needs it.
function normalizePagePath(value: unknown): string | null {
  const raw = text(value, PAGE_PATH_MAX + 200);
  if (!raw) return null;
  const path = raw.split("?")[0].split("#")[0].trim();
  if (!path.startsWith("/")) return null;
  return path.slice(0, PAGE_PATH_MAX);
}

function normalizeUserId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const SELECT_COLUMNS =
  "id, locale, status, source_text, suggestion, note, page_path, user_id, username, admin_note, created_at, updated_at, reviewed_at";

function rowToReport(row: Record<string, unknown>): TranslationReport {
  return {
    id: String(row.id),
    locale: String(row.locale ?? ""),
    status: normalizeTranslationReportStatus(row.status) ?? "new",
    sourceText: String(row.source_text ?? ""),
    suggestion: row.suggestion == null ? null : String(row.suggestion),
    note: row.note == null ? null : String(row.note),
    pagePath: row.page_path == null ? null : String(row.page_path),
    userId: row.user_id == null ? null : Number(row.user_id),
    username: row.username == null ? null : String(row.username),
    adminNote: row.admin_note == null ? null : String(row.admin_note),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
  };
}

async function getById(db: Db, id: string): Promise<TranslationReport | null> {
  if (!id) return null;
  const row = (await exec(db, `select ${SELECT_COLUMNS} from translation_reports where id = ? limit 1`, [id])).rows[0];
  return row ? rowToReport(row as Record<string, unknown>) : null;
}

export async function getTranslationReport(db: Db, id: string): Promise<TranslationReport | null> {
  return getById(db, id);
}

/**
 * File one report. `sourceText` is the only required field: a reporter who can
 * quote the bad string has said the useful part, and demanding a suggestion
 * from someone who only knows it reads wrong would lose the report.
 *
 * Re-posting the same (reporter, locale, text, suggestion) within a day returns
 * the stored row with `duplicate: true` instead of a second copy, so a
 * double-clicked submit is idempotent. Past
 * TRANSLATION_REPORT_PER_REPORTER_PER_DAY rows in that window a new report is
 * refused; duplicates stay exempt because they add nothing.
 */
export async function createTranslationReport(
  db: Db,
  input: TranslationReportInput,
): Promise<CreateTranslationReportResult> {
  const locale = normalizeLocale(input.locale);
  const sourceText = text(input.sourceText, SOURCE_TEXT_MAX);
  if (!locale || !sourceText) return { ok: false, reason: "invalid_report" };

  const suggestion = text(input.suggestion, SUGGESTION_MAX);
  const note = text(input.note, NOTE_MAX);
  const userId = normalizeUserId(input.userId);
  const reporterKey = text(input.reporterKey, REPORTER_KEY_MAX) ?? (userId ? `user:${userId}` : SHARED_REPORTER_KEY);
  const now = Date.now();
  const windowStart = now - REPORTER_WINDOW_MS;

  const existing = (await exec(
    db,
    `select ${SELECT_COLUMNS} from translation_reports
      where reporter_key = ? and locale = ? and source_text = ?
        and ifnull(suggestion, '') = ? and created_at >= ?
      order by created_at desc limit 1`,
    [reporterKey, locale, sourceText, suggestion ?? "", windowStart],
  )).rows[0];
  if (existing) return { ok: true, report: rowToReport(existing as Record<string, unknown>), duplicate: true };

  const recent = (await exec(
    db,
    "select count(*) as n from translation_reports where reporter_key = ? and created_at >= ?",
    [reporterKey, windowStart],
  )).rows[0];
  const cap = reporterKey === SHARED_REPORTER_KEY
    ? TRANSLATION_REPORT_SHARED_ANON_PER_DAY
    : TRANSLATION_REPORT_PER_REPORTER_PER_DAY;
  if (Number(recent?.n ?? 0) >= cap) {
    return { ok: false, reason: "too_many_reports" };
  }

  const report: TranslationReport = {
    id: randomUUID(),
    locale,
    status: "new",
    sourceText,
    suggestion,
    note,
    pagePath: normalizePagePath(input.pagePath),
    userId,
    username: text(input.username, USERNAME_MAX),
    adminNote: null,
    createdAt: now,
    updatedAt: now,
    reviewedAt: null,
  };
  await exec(
    db,
    `insert into translation_reports (${SELECT_COLUMNS}, reporter_key)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      report.id,
      report.locale,
      report.status,
      report.sourceText,
      report.suggestion,
      report.note,
      report.pagePath,
      report.userId,
      report.username,
      report.adminNote,
      report.createdAt,
      report.updatedAt,
      report.reviewedAt,
      reporterKey,
    ],
  );
  return { ok: true, report, duplicate: false };
}

export async function countTranslationReports(db: Db): Promise<TranslationReportCounts> {
  const rows = (await exec(db, "select status, count(*) as n from translation_reports group by status")).rows;
  const counts: TranslationReportCounts = { new: 0, resolved: 0, dismissed: 0, total: 0 };
  for (const row of rows) {
    const status = normalizeTranslationReportStatus(row.status);
    const n = Number(row.n ?? 0);
    if (status) counts[status] += n;
    counts.total += n;
  }
  return counts;
}

/**
 * The admin board: newest first, filtered by status/locale and an optional
 * substring match over the reporter's own words. `counts` is always over the
 * whole table (the status tabs need their totals even while one is selected),
 * `total` is over the active filters.
 */
export async function listTranslationReports(
  db: Db,
  options: ListTranslationReportsOptions = {},
): Promise<TranslationReportPage> {
  const status = normalizeTranslationReportStatus(options.status);
  const locale = normalizeLocale(options.locale);
  const searchRaw = text(options.search, 100);
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), LIST_LIMIT_MAX) : LIST_LIMIT_DEFAULT;
  const offsetRaw = Number(options.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  const where: string[] = [];
  const args: (string | number)[] = [];
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (locale) {
    where.push("locale = ?");
    args.push(locale);
  }
  if (searchRaw) {
    // escape wildcards so a literal % or _ in the quoted string stays literal
    const pattern = `%${searchRaw.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(source_text like ? escape '\\' or ifnull(suggestion, '') like ? escape '\\' or ifnull(note, '') like ? escape '\\' or ifnull(username, '') like ? escape '\\')");
    args.push(pattern, pattern, pattern, pattern);
  }
  const clause = where.length ? `where ${where.join(" and ")}` : "";

  const totalRow = (await exec(db, `select count(*) as n from translation_reports ${clause}`, args)).rows[0];
  const rows = (await exec(
    db,
    `select ${SELECT_COLUMNS} from translation_reports ${clause} order by created_at desc limit ? offset ?`,
    [...args, limit, offset],
  )).rows;

  return {
    reports: rows.map((row) => rowToReport(row as Record<string, unknown>)),
    counts: await countTranslationReports(db),
    total: Number(totalRow?.n ?? 0),
  };
}

export interface UpdateTranslationReportInput {
  id?: unknown;
  status?: unknown;
  adminNote?: unknown;
}

/**
 * Triage one report. Fields left undefined keep their stored value, so a status
 * flip needs only `{ id, status }`. `reviewedAt` follows the status: stamped on
 * the move out of "new", cleared on the move back into it.
 */
export async function updateTranslationReport(
  db: Db,
  input: UpdateTranslationReportInput,
): Promise<TranslationReport | null> {
  const id = typeof input.id === "string" ? input.id : "";
  const existing = await getById(db, id);
  if (!existing) return null;

  const status = input.status === undefined ? existing.status : (normalizeTranslationReportStatus(input.status) ?? existing.status);
  const adminNote = input.adminNote === undefined ? existing.adminNote : text(input.adminNote, ADMIN_NOTE_MAX);
  const now = Date.now();
  const reviewedAt = status === "new" ? null : (existing.status === "new" ? now : existing.reviewedAt ?? now);

  await exec(
    db,
    "update translation_reports set status = ?, admin_note = ?, updated_at = ?, reviewed_at = ? where id = ?",
    [status, adminNote, now, reviewedAt, id],
  );
  return { ...existing, status, adminNote, updatedAt: now, reviewedAt };
}

export async function deleteTranslationReport(db: Db, id: string): Promise<boolean> {
  if (!id) return false;
  const result = await exec(db, "delete from translation_reports where id = ?", [id]);
  return (result.rowsAffected ?? 0) > 0;
}

/** Drop everything already triaged (resolved + dismissed). "new" is untouched. */
export async function clearReviewedTranslationReports(db: Db): Promise<number> {
  const result = await exec(db, "delete from translation_reports where status in ('resolved', 'dismissed')");
  return result.rowsAffected ?? 0;
}
