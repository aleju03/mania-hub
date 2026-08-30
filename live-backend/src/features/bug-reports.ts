import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { exec, execBatch } from "../db.js";
import { getAdminTodo, type AdminTodo } from "./admin-todos.js";

// Player-filed bug reports: someone hits something broken on the site and says
// so from /report. Open to signed-out visitors, same reasoning as the
// translation reports next door (features/translation-reports.ts, which this
// module is modelled on): the person who found the bug is not necessarily the
// person with a login cookie, and a report says nothing about an account.
//
// What identity a row carries is whatever the frontend could verify: the osu!
// viewer id when there is a login cookie, nothing otherwise. That is also the
// line the conversation feature draws. Only a signed-in reporter can read and
// append to a thread, because a report with no account behind it has nobody to
// authenticate; anonymous reports are filed and answered on the board alone.
//
// The HTTP layer keys its per-IP rate limit on the forwarded visitor address;
// the caps here are the second line, bounding how much one reporter can leave
// in the table regardless of how the request arrived.
//
// Triage is admin-only (/admin/bug-reports). The table is durable: retention
// never prunes it.

export type BugReportStatus = "new" | "investigating" | "fixed" | "wontfix" | "duplicate";

export const BUG_REPORT_STATUSES: readonly BugReportStatus[] = [
  "new",
  "investigating",
  "fixed",
  "wontfix",
  "duplicate",
];

/** Statuses that mean the report is off the owner's plate. */
export const BUG_REPORT_CLOSED_STATUSES: readonly BugReportStatus[] = ["fixed", "wontfix", "duplicate"];

const BODY_MAX = 4000;
const PAGE_PATH_MAX = 200;
const CONTEXT_MAX = 2000;
const USERNAME_MAX = 60;
const REPORTER_KEY_MAX = 120;
const ADMIN_NOTE_MAX = 5000;
const REPLY_MAX = 4000;
const TODO_ID_MAX = 64;
const MESSAGE_MAX = 4000;

const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 100;

/** A report needs enough words to act on; one angry syllable is not a report. */
const BODY_MIN = 10;

export const BUG_REPORT_MAX_SCREENSHOTS = 3;
/** How long an upload ticket stays good. Long enough for three 5 MB images on a bad connection. */
export const BUG_REPORT_UPLOAD_TOKEN_TTL_MS = 10 * 60_000;

// How much one reporter may leave behind, on the same 24h window the duplicate
// guard uses, so a reporter who fills it waits a day rather than losing the
// ability to report forever.
export const BUG_REPORT_PER_REPORTER_PER_DAY = 30;
// Reporters the frontend could not tell apart (no login, and no client address
// to key on) share one bucket. Capping that at the per-reporter number would
// let one spammer spend every anonymous visitor's budget, so it gets its own
// much larger ceiling: a bound on how much junk can land, not a per-person
// quota.
export const BUG_REPORT_SHARED_ANON_PER_DAY = 200;
const SHARED_REPORTER_KEY = "anon";
const REPORTER_WINDOW_MS = 24 * 60 * 60_000;
export const BUG_REPORT_MESSAGES_PER_REPORTER_PER_DAY = 30;

/**
 * Screenshot keys are built by the frontend (it owns the R2 client) and sent
 * here to be recorded, so this is the one place that decides what a legitimate
 * key looks like. Anything else would let a ticket holder register an
 * arbitrary object key in the private bucket and then get a signed URL for it,
 * which is a read of somebody else's replay.
 */
const SCREENSHOT_KEY_EXTS = ["png", "jpg", "gif", "webp", "bmp", "avif"] as const;

export interface BugReportContext {
  [key: string]: string | number | boolean | null;
}

export type BugReportMessageAuthor = "reporter" | "admin";

export interface BugReportMessage {
  id: string;
  author: BugReportMessageAuthor;
  body: string;
  createdAt: number;
  /** Set when the message was corrected after it was sent; null otherwise. */
  editedAt: number | null;
}

export interface BugReport {
  id: string;
  status: BugReportStatus;
  /** What the reporter wrote, verbatim. */
  body: string;
  /** Path they were on when they opened the form; query string stripped. */
  pagePath: string | null;
  /** Auto-captured browser/site context, as the frontend collected it. */
  context: BugReportContext | null;
  userId: number | null;
  username: string | null;
  screenshotKeys: string[];
  /** Private triage scratch. Never leaves the admin board. */
  adminNote: string | null;
  /** Newest admin message, retained for rolling-deploy compatibility. */
  reply: string | null;
  repliedAt: number | null;
  /** Append-only conversation after the original report body. */
  messages: BugReportMessage[];
  /** The admin_todos row this was promoted into, if it was. */
  todoId: string | null;
  /** Human-readable admin todo number, when the linked todo still exists. */
  todoSeq: number | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

/** The subset a reporter may read about their own report. */
export interface BugReportForReporter {
  id: string;
  status: BugReportStatus;
  body: string;
  pagePath: string | null;
  screenshotCount: number;
  reply: string | null;
  repliedAt: number | null;
  messages: BugReportMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface BugReportInput {
  body?: unknown;
  pagePath?: unknown;
  context?: unknown;
  userId?: unknown;
  username?: unknown;
  /** Opaque per-reporter bucket ("user:123" / "ip:<hash>"), never shown to admins. */
  reporterKey?: unknown;
  /** How many screenshots the client intends to upload; mints a ticket when above zero. */
  screenshotCount?: unknown;
}

export type CreateBugReportResult =
  | { ok: true; report: BugReport; duplicate: boolean; uploadToken: string | null }
  | { ok: false; reason: "invalid_report" | "too_many_reports" };

export type AttachBugReportScreenshotResult =
  | { ok: true; screenshotKeys: string[] }
  | { ok: false; reason: "report_not_found" | "invalid_token" | "invalid_key" | "too_many_screenshots" };

export type AuthorizeBugReportScreenshotResult =
  | { ok: true; alreadyAttached: boolean }
  | { ok: false; reason: "report_not_found" | "invalid_token" | "invalid_key" | "too_many_screenshots" };

export type AddBugReportMessageResult =
  | { ok: true; report: BugReport }
  | { ok: false; reason: "report_not_found" | "not_owner" | "anonymous_report" | "invalid_message" | "too_many_messages" };

export type EditBugReportMessageResult =
  | { ok: true; report: BugReport }
  | { ok: false; reason: "report_not_found" | "message_not_found" | "invalid_message" };

export interface BugReportCounts {
  new: number;
  investigating: number;
  fixed: number;
  wontfix: number;
  duplicate: number;
  total: number;
}

export interface ListBugReportsOptions {
  status?: unknown;
  limit?: unknown;
  offset?: unknown;
  search?: unknown;
}

export interface BugReportPage {
  reports: BugReport[];
  counts: BugReportCounts;
  /** Rows matching the active filters, before limit/offset. */
  total: number;
}

export function normalizeBugReportStatus(value: unknown): BugReportStatus | null {
  return BUG_REPORT_STATUSES.includes(value as BugReportStatus) ? (value as BugReportStatus) : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length ? trimmed : null;
}

// Only the path is kept: a query string can carry a user's own filters and
// nothing about "where the bug was" needs it.
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

/**
 * The context blob is whatever the frontend chose to capture (route, user
 * agent, viewport, locale, country scope, site version). It is stored as sent
 * rather than schema-checked, because the useful field tomorrow is one nobody
 * has thought of today; what is enforced is that it stays a flat object of
 * scalars and stays small.
 */
function normalizeContext(value: unknown): BugReportContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: BugReportContext = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (out[key] !== undefined) continue;
    const name = key.trim().slice(0, 40);
    if (!name) continue;
    if (typeof raw === "string") out[name] = raw.trim().slice(0, 300);
    else if (typeof raw === "number" && Number.isFinite(raw)) out[name] = raw;
    else if (typeof raw === "boolean" || raw === null) out[name] = raw;
    if (JSON.stringify(out).length > CONTEXT_MAX) {
      delete out[name];
      break;
    }
  }
  return Object.keys(out).length ? out : null;
}

function parseContext(value: unknown): BugReportContext | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeContext(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseScreenshotKeys(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, BUG_REPORT_MAX_SCREENSHOTS);
  } catch {
    return [];
  }
}

function parseMessages(value: unknown): BugReportMessage[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): BugReportMessage[] => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      const author = row.author === "reporter" || row.author === "admin" ? row.author : null;
      const body = typeof row.body === "string" ? row.body : "";
      const createdAt = Number(row.createdAt);
      if (!author || !body || !Number.isFinite(createdAt)) return [];
      const editedAt = Number(row.editedAt);
      return [{
        id: String(row.id ?? ""),
        author,
        body,
        createdAt,
        editedAt: row.editedAt == null || !Number.isFinite(editedAt) ? null : editedAt,
      }];
    });
  } catch {
    return [];
  }
}

export function isBugReportScreenshotKey(id: string, key: unknown): key is string {
  if (typeof key !== "string" || !id) return false;
  const exts = SCREENSHOT_KEY_EXTS.join("|");
  return new RegExp(`^bug-reports/${id.replace(/[^A-Za-z0-9-]/g, "")}/[0-${BUG_REPORT_MAX_SCREENSHOTS - 1}]\\.(${exts})$`)
    .test(key);
}

const STORED_COLUMNS =
  "id, status, body, page_path, context_json, user_id, username, screenshot_keys, admin_note, reply, replied_at, todo_id, created_at, updated_at, resolved_at";
const SELECT_COLUMNS = `${STORED_COLUMNS}, (
  select seq from admin_todos where admin_todos.id = bug_reports.todo_id
) as todo_seq, (
  select coalesce(json_group_array(json_object(
    'id', message.id,
    'author', message.author_role,
    'body', message.body,
    'createdAt', message.created_at,
    'editedAt', message.edited_at
  )), '[]')
  from (
    select id, author_role, body, created_at, edited_at, rowid as insertion_order
      from bug_report_messages
     where report_id = bug_reports.id
     order by created_at, insertion_order
  ) as message
) as messages_json`;

function rowToReport(row: Record<string, unknown>): BugReport {
  return {
    id: String(row.id),
    status: normalizeBugReportStatus(row.status) ?? "new",
    body: String(row.body ?? ""),
    pagePath: row.page_path == null ? null : String(row.page_path),
    context: parseContext(row.context_json),
    userId: row.user_id == null ? null : Number(row.user_id),
    username: row.username == null ? null : String(row.username),
    screenshotKeys: parseScreenshotKeys(row.screenshot_keys),
    adminNote: row.admin_note == null ? null : String(row.admin_note),
    reply: row.reply == null ? null : String(row.reply),
    repliedAt: row.replied_at == null ? null : Number(row.replied_at),
    messages: parseMessages(row.messages_json),
    todoId: row.todo_id == null ? null : String(row.todo_id),
    todoSeq: row.todo_seq == null ? null : Number(row.todo_seq),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
  };
}

export function toBugReportForReporter(report: BugReport): BugReportForReporter {
  return {
    id: report.id,
    status: report.status,
    body: report.body,
    pagePath: report.pagePath,
    screenshotCount: report.screenshotKeys.length,
    reply: report.reply,
    repliedAt: report.repliedAt,
    messages: report.messages,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

async function getById(db: Db, id: string): Promise<BugReport | null> {
  if (!id) return null;
  const row = (await exec(db, `select ${SELECT_COLUMNS} from bug_reports where id = ? limit 1`, [id])).rows[0];
  return row ? rowToReport(row as Record<string, unknown>) : null;
}

export async function getBugReport(db: Db, id: string): Promise<BugReport | null> {
  return getById(db, id);
}

/**
 * File one report. The written body is the only required field: the auto
 * context is collected for the reporter, not by them, and a report with no
 * screenshot is still a report.
 *
 * Re-posting the same (reporter, body) within a day returns the stored row
 * with `duplicate: true` instead of a second copy, so a double-clicked submit
 * is idempotent. It hands back the stored upload ticket too when that is still
 * good, so the screenshots the second click was about to send still land on
 * the one row. Past BUG_REPORT_PER_REPORTER_PER_DAY rows in that window a new
 * report is refused; duplicates stay exempt because they add nothing.
 */
export async function createBugReport(db: Db, input: BugReportInput): Promise<CreateBugReportResult> {
  const body = text(input.body, BODY_MAX);
  if (!body || body.length < BODY_MIN) return { ok: false, reason: "invalid_report" };

  const userId = normalizeUserId(input.userId);
  const reporterKey = text(input.reporterKey, REPORTER_KEY_MAX) ?? (userId ? `user:${userId}` : SHARED_REPORTER_KEY);
  const now = Date.now();
  const windowStart = now - REPORTER_WINDOW_MS;
  const wantsScreenshots = Number(input.screenshotCount) > 0;

  const findDuplicate = async () => (await exec(
    db,
    `select ${SELECT_COLUMNS}, upload_token, token_expires_at from bug_reports
      where reporter_key = ? and body = ? and created_at >= ?
      order by created_at desc limit 1`,
    [reporterKey, body, windowStart],
  )).rows[0] as Record<string, unknown> | undefined;
  const duplicateResult = async (row: Record<string, unknown>): Promise<CreateBugReportResult> => {
    const expiresAt = row.token_expires_at == null ? 0 : Number(row.token_expires_at);
    const storedToken = row.upload_token == null ? null : String(row.upload_token);
    const hasCapacity = parseScreenshotKeys(row.screenshot_keys).length < BUG_REPORT_MAX_SCREENSHOTS;
    let duplicateUploadToken = hasCapacity && storedToken && expiresAt > now ? storedToken : null;
    if (wantsScreenshots && hasCapacity && !duplicateUploadToken) {
      duplicateUploadToken = randomUUID();
      await exec(
        db,
        "update bug_reports set upload_token = ?, token_expires_at = ?, updated_at = ? where id = ?",
        [duplicateUploadToken, now + BUG_REPORT_UPLOAD_TOKEN_TTL_MS, now, String(row.id)],
      );
      row.updated_at = now;
    }
    return {
      ok: true,
      report: rowToReport(row),
      duplicate: true,
      uploadToken: duplicateUploadToken,
    };
  };

  const existingRow = await findDuplicate();
  if (existingRow) {
    return duplicateResult(existingRow);
  }

  const recent = (await exec(
    db,
    "select count(*) as n from bug_reports where reporter_key = ? and created_at >= ?",
    [reporterKey, windowStart],
  )).rows[0];
  const cap = reporterKey === SHARED_REPORTER_KEY ? BUG_REPORT_SHARED_ANON_PER_DAY : BUG_REPORT_PER_REPORTER_PER_DAY;
  if (Number(recent?.n ?? 0) >= cap) return { ok: false, reason: "too_many_reports" };

  const uploadToken = wantsScreenshots ? randomUUID() : null;
  const tokenExpiresAt = uploadToken ? now + BUG_REPORT_UPLOAD_TOKEN_TTL_MS : null;

  const report: BugReport = {
    id: randomUUID(),
    status: "new",
    body,
    pagePath: normalizePagePath(input.pagePath),
    context: normalizeContext(input.context),
    userId,
    username: text(input.username, USERNAME_MAX),
    screenshotKeys: [],
    adminNote: null,
    reply: null,
    repliedAt: null,
    messages: [],
    todoId: null,
    todoSeq: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  };
  const inserted = await exec(
    db,
    `insert into bug_reports (${STORED_COLUMNS}, reporter_key, upload_token, token_expires_at)
     select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      where not exists (
        select 1 from bug_reports where reporter_key = ? and body = ? and created_at >= ?
      ) and (
        select count(*) from bug_reports where reporter_key = ? and created_at >= ?
      ) < ?`,
    [
      report.id,
      report.status,
      report.body,
      report.pagePath,
      report.context ? JSON.stringify(report.context) : null,
      report.userId,
      report.username,
      "[]",
      report.adminNote,
      report.reply,
      report.repliedAt,
      report.todoId,
      report.createdAt,
      report.updatedAt,
      report.resolvedAt,
      reporterKey,
      uploadToken,
      tokenExpiresAt,
      reporterKey,
      body,
      windowStart,
      reporterKey,
      windowStart,
      cap,
    ],
  );
  if ((inserted.rowsAffected ?? 0) === 0) {
    const racedDuplicate = await findDuplicate();
    if (racedDuplicate) return duplicateResult(racedDuplicate);
    return { ok: false, reason: "too_many_reports" };
  }
  return { ok: true, report, duplicate: false, uploadToken };
}

function screenshotIndex(key: string): number | null {
  const match = /\/(\d+)\.[a-z0-9]+$/i.exec(key);
  const index = Number(match?.[1]);
  return Number.isInteger(index) ? index : null;
}

function hasScreenshotIndex(keys: string[], key: string): boolean {
  const index = screenshotIndex(key);
  return index != null && keys.some((existing) => screenshotIndex(existing) === index);
}

/**
 * Validate a ticket and reserve no state. The frontend upload route calls this
 * before writing bytes to R2, so an expired or forged ticket never gets a write
 * attempt. `alreadyAttached` makes a replayed browser request idempotent without
 * overwriting the image that is already on the report.
 */
export async function authorizeBugReportScreenshot(
  db: Db,
  input: { id?: unknown; token?: unknown; key?: unknown },
): Promise<AuthorizeBugReportScreenshotResult> {
  const id = typeof input.id === "string" ? input.id : "";
  const token = typeof input.token === "string" ? input.token : "";
  if (!id || !token) return { ok: false, reason: "invalid_token" };

  const row = (await exec(
    db,
    "select screenshot_keys, upload_token, token_expires_at from bug_reports where id = ? limit 1",
    [id],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!row) return { ok: false, reason: "report_not_found" };
  const storedToken = row.upload_token == null ? "" : String(row.upload_token);
  const expiresAt = row.token_expires_at == null ? 0 : Number(row.token_expires_at);
  if (!storedToken || storedToken !== token || expiresAt <= Date.now()) return { ok: false, reason: "invalid_token" };
  if (!isBugReportScreenshotKey(id, input.key)) return { ok: false, reason: "invalid_key" };

  const keys = parseScreenshotKeys(row.screenshot_keys);
  if (keys.includes(input.key) || hasScreenshotIndex(keys, input.key)) {
    return { ok: true, alreadyAttached: true };
  }
  if (keys.length >= BUG_REPORT_MAX_SCREENSHOTS) return { ok: false, reason: "too_many_screenshots" };
  return { ok: true, alreadyAttached: false };
}

/**
 * Record one screenshot against a report. The ticket minted at submit is the
 * credential here, the same shape the skin upload uses: the row it resolves to
 * decides which report the image belongs to, so nothing the caller says about
 * ownership is trusted.
 */
export async function attachBugReportScreenshot(
  db: Db,
  input: { id?: unknown; token?: unknown; key?: unknown },
): Promise<AttachBugReportScreenshotResult> {
  const id = typeof input.id === "string" ? input.id : "";
  const token = typeof input.token === "string" ? input.token : "";
  if (!id || !token) return { ok: false, reason: "invalid_token" };

  // Multiple uploads can arrive together despite the ordinary browser sending
  // them serially. Compare the raw JSON value on update and retry a changed row
  // so two requests cannot both read [] and have the last writer erase the
  // first one's key.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = (await exec(
      db,
      "select screenshot_keys, upload_token, token_expires_at from bug_reports where id = ? limit 1",
      [id],
    )).rows[0] as Record<string, unknown> | undefined;
    if (!row) return { ok: false, reason: "report_not_found" };

    const storedToken = row.upload_token == null ? "" : String(row.upload_token);
    const expiresAt = row.token_expires_at == null ? 0 : Number(row.token_expires_at);
    if (!storedToken || storedToken !== token || expiresAt <= Date.now()) return { ok: false, reason: "invalid_token" };
    if (!isBugReportScreenshotKey(id, input.key)) return { ok: false, reason: "invalid_key" };

    const keys = parseScreenshotKeys(row.screenshot_keys);
    if (keys.includes(input.key) || hasScreenshotIndex(keys, input.key)) {
      return { ok: true, screenshotKeys: keys };
    }
    if (keys.length >= BUG_REPORT_MAX_SCREENSHOTS) return { ok: false, reason: "too_many_screenshots" };

    const rawKeys = typeof row.screenshot_keys === "string" ? row.screenshot_keys : null;
    const next = [...keys, input.key];
    const updated = await exec(
      db,
      `update bug_reports set screenshot_keys = ?, updated_at = ?
        where id = ? and upload_token = ? and token_expires_at > ?
          and ${rawKeys == null ? "screenshot_keys is null" : "screenshot_keys = ?"}`,
      rawKeys == null
        ? [JSON.stringify(next), Date.now(), id, token, Date.now()]
        : [JSON.stringify(next), Date.now(), id, token, Date.now(), rawKeys],
    );
    if ((updated.rowsAffected ?? 0) > 0) return { ok: true, screenshotKeys: next };
  }
  return { ok: false, reason: "too_many_screenshots" };
}

export async function countBugReports(db: Db): Promise<BugReportCounts> {
  const rows = (await exec(db, "select status, count(*) as n from bug_reports group by status")).rows;
  const counts: BugReportCounts = { new: 0, investigating: 0, fixed: 0, wontfix: 0, duplicate: 0, total: 0 };
  for (const row of rows) {
    const status = normalizeBugReportStatus(row.status);
    const n = Number(row.n ?? 0);
    if (status) counts[status] += n;
    counts.total += n;
  }
  return counts;
}

/**
 * The admin board: newest first, filtered by status and an optional substring
 * match over the report and thread. `counts` is always over the whole table
 * (the status tabs need their totals even while one is selected), `total` is
 * over the active filters.
 */
export async function listBugReports(db: Db, options: ListBugReportsOptions = {}): Promise<BugReportPage> {
  const status = normalizeBugReportStatus(options.status);
  const searchRaw = text(options.search, 100);
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), LIST_LIMIT_MAX)
    : LIST_LIMIT_DEFAULT;
  const offsetRaw = Number(options.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  const where: string[] = [];
  const args: (string | number)[] = [];
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (searchRaw) {
    // escape wildcards so a literal % or _ in the quoted text stays literal
    const pattern = `%${searchRaw.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(
      `(body like ? escape '\\' or ifnull(page_path, '') like ? escape '\\' or ifnull(username, '') like ? escape '\\'
        or exists (
          select 1 from bug_report_messages
           where bug_report_messages.report_id = bug_reports.id and bug_report_messages.body like ? escape '\\'
        ))`,
    );
    args.push(pattern, pattern, pattern, pattern);
  }
  const clause = where.length ? `where ${where.join(" and ")}` : "";

  const totalRow = (await exec(db, `select count(*) as n from bug_reports ${clause}`, args)).rows[0];
  const rows = (await exec(
    db,
    `select ${SELECT_COLUMNS} from bug_reports ${clause} order by updated_at desc limit ? offset ?`,
    [...args, limit, offset],
  )).rows;

  return {
    reports: rows.map((row) => rowToReport(row as Record<string, unknown>)),
    counts: await countBugReports(db),
    total: Number(totalRow?.n ?? 0),
  };
}

/**
 * One reporter's own reports, for the "your reports" list on /report. Signed-in
 * callers only, by construction: an anonymous report has no user_id to match.
 */
export async function listBugReportsForUser(db: Db, userId: unknown, limit = 20): Promise<BugReportForReporter[]> {
  const id = normalizeUserId(userId);
  if (!id) return [];
  const rows = (await exec(
    db,
    `select ${SELECT_COLUMNS} from bug_reports where user_id = ? order by updated_at desc limit ?`,
    [id, Math.min(Math.max(1, Math.floor(limit)), 50)],
  )).rows;
  return rows.map((row) => toBugReportForReporter(rowToReport(row as Record<string, unknown>)));
}

function normalizeMessageBody(value: unknown): string | null {
  return text(value, MESSAGE_MAX);
}

/** Append a verified reporter's follow-up without changing triage state. Only
 *  an admin can reopen a closed report; the guarded insert keeps the per-report
 *  daily ceiling atomic when one client submits the same composer more than
 *  once concurrently. */
export async function addReporterBugReportMessage(
  db: Db,
  input: { id?: unknown; userId?: unknown; body?: unknown },
): Promise<AddBugReportMessageResult> {
  const id = typeof input.id === "string" ? input.id : "";
  const userId = normalizeUserId(input.userId);
  const body = normalizeMessageBody(input.body);
  if (!body) return { ok: false, reason: "invalid_message" };
  const report = await getById(db, id);
  if (!report) return { ok: false, reason: "report_not_found" };
  if (!report.userId) return { ok: false, reason: "anonymous_report" };
  if (!userId || report.userId !== userId) return { ok: false, reason: "not_owner" };

  const messageId = randomUUID();
  const now = Date.now();
  const windowStart = now - REPORTER_WINDOW_MS;
  const [inserted] = await execBatch(db, [
    {
      sql: `insert into bug_report_messages (id, report_id, author_role, body, created_at, legacy_reply)
        select ?, ?, 'reporter', ?, ?, 0
         where (
           select count(*) from bug_report_messages
            where report_id = ? and author_role = 'reporter' and created_at >= ?
         ) < ?`,
      args: [messageId, id, body, now, id, windowStart, BUG_REPORT_MESSAGES_PER_REPORTER_PER_DAY],
    },
    {
      sql: `update bug_reports
               set updated_at = ?
             where id = ? and exists (select 1 from bug_report_messages where id = ?)`,
      args: [now, id, messageId],
    },
  ]);
  if ((inserted?.rowsAffected ?? 0) === 0) return { ok: false, reason: "too_many_messages" };
  const updated = await getById(db, id);
  return updated ? { ok: true, report: updated } : { ok: false, reason: "report_not_found" };
}

/** Append an owner response. `reply`/`replied_at` keep the newest answer in the
 *  old columns for rolling-deploy compatibility; the message row is the
 *  durable history the new clients render. */
export async function addAdminBugReportMessage(
  db: Db,
  input: { id?: unknown; body?: unknown },
): Promise<AddBugReportMessageResult> {
  const id = typeof input.id === "string" ? input.id : "";
  const body = normalizeMessageBody(input.body);
  if (!body) return { ok: false, reason: "invalid_message" };
  const report = await getById(db, id);
  if (!report) return { ok: false, reason: "report_not_found" };
  if (!report.userId) return { ok: false, reason: "anonymous_report" };

  const messageId = randomUUID();
  const now = Date.now();
  await execBatch(db, [
    {
      sql: `insert into bug_report_messages (id, report_id, author_role, body, created_at, legacy_reply)
            values (?, ?, 'admin', ?, ?, 0)`,
      args: [messageId, id, body, now],
    },
    {
      sql: "update bug_reports set reply = ?, replied_at = ?, updated_at = ? where id = ?",
      args: [body, now, now, id],
    },
  ]);
  const updated = await getById(db, id);
  return updated ? { ok: true, report: updated } : { ok: false, reason: "report_not_found" };
}

/** Correct one of the owner's own messages in place. A reporter has usually
 *  read it already, so the row keeps an `edited_at` stamp rather than changing
 *  silently. Reporter messages are not editable here: their side of the thread
 *  stays their words. When the edited row is the newest admin message, the
 *  `reply`/`replied_at` compatibility mirror follows it. */
export async function editAdminBugReportMessage(
  db: Db,
  input: { id?: unknown; messageId?: unknown; body?: unknown },
): Promise<EditBugReportMessageResult> {
  const id = typeof input.id === "string" ? input.id : "";
  const messageId = typeof input.messageId === "string" ? input.messageId : "";
  const body = normalizeMessageBody(input.body);
  if (!body) return { ok: false, reason: "invalid_message" };
  const report = await getById(db, id);
  if (!report) return { ok: false, reason: "report_not_found" };

  const now = Date.now();
  const edited = await exec(
    db,
    `update bug_report_messages set body = ?, edited_at = ?
      where id = ? and report_id = ? and author_role = 'admin'`,
    [body, now, messageId, id],
  );
  if ((edited.rowsAffected ?? 0) === 0) return { ok: false, reason: "message_not_found" };

  const newest = (await exec(
    db,
    `select body, created_at from bug_report_messages
      where report_id = ? and author_role = 'admin'
      order by created_at desc, rowid desc limit 1`,
    [id],
  )).rows[0];
  await exec(db, "update bug_reports set reply = ?, replied_at = ?, updated_at = ? where id = ?", [
    newest?.body == null ? null : String(newest.body),
    newest?.created_at == null ? null : Number(newest.created_at),
    now,
    id,
  ]);

  const updated = await getById(db, id);
  return updated ? { ok: true, report: updated } : { ok: false, reason: "report_not_found" };
}

export interface UpdateBugReportInput {
  id?: unknown;
  status?: unknown;
  adminNote?: unknown;
  reply?: unknown;
}

/**
 * Triage one report. Fields left undefined keep their stored value, so a
 * status flip needs only `{ id, status }`. `resolvedAt` follows the status:
 * stamped only for fixed/wontfix/duplicate, cleared for new/investigating.
 * `reply` is retained as a rolling-deploy compatibility input. A changed,
 * non-empty value appends an admin message instead of replacing history.
 */
export async function updateBugReport(db: Db, input: UpdateBugReportInput): Promise<BugReport | null> {
  const id = typeof input.id === "string" ? input.id : "";
  const existing = await getById(db, id);
  if (!existing) return null;

  const now = Date.now();
  const assignments: string[] = [];
  const args: Array<string | number | null> = [];

  if (input.status !== undefined) {
    const status = normalizeBugReportStatus(input.status);
    if (status) {
      assignments.push("status = ?", BUG_REPORT_CLOSED_STATUSES.includes(status)
        ? "resolved_at = coalesce(resolved_at, ?)"
        : "resolved_at = null");
      args.push(status);
      if (BUG_REPORT_CLOSED_STATUSES.includes(status)) args.push(now);
    }
  }
  if (input.adminNote !== undefined) {
    assignments.push("admin_note = ?");
    args.push(text(input.adminNote, ADMIN_NOTE_MAX));
  }
  if (assignments.length) {
    assignments.push("updated_at = ?");
    args.push(now, id);
    await exec(db, `update bug_reports set ${assignments.join(", ")} where id = ?`, args);
  }

  if (input.reply !== undefined) {
    const reply = text(input.reply, REPLY_MAX);
    if (reply && reply !== existing.reply) {
      const result = await addAdminBugReportMessage(db, { id, body: reply });
      return result.ok ? result.report : getById(db, id);
    }
    // Old clients could clear the mutable reply. Keep that compatibility field
    // honest without deleting append-only history already shown to either side.
    if (!reply && existing.reply) {
      await exec(db, "update bug_reports set reply = null, replied_at = null, updated_at = ? where id = ?", [now, id]);
    }
  }
  return getById(db, id);
}

/** Remember which todo a report was promoted into, so it cannot be promoted twice. */
export async function linkBugReportTodo(db: Db, id: string, todoId: string): Promise<BugReport | null> {
  const existing = await getById(db, id);
  if (!existing) return null;
  const linked = text(todoId, TODO_ID_MAX);
  const now = Date.now();
  await exec(db, "update bug_reports set todo_id = ?, updated_at = ? where id = ?", [linked, now, id]);
  return getById(db, id);
}

export type PromoteBugReportResult = {
  report: BugReport;
  todo: AdminTodo | null;
  created: boolean;
};

/** Atomically claim a report and create exactly one ordinary bug todo for it. */
export async function promoteBugReportToTodo(db: Db, id: string): Promise<PromoteBugReportResult | null> {
  const existing = await getById(db, id);
  if (!existing) return null;
  if (existing.todoId) {
    return { report: existing, todo: await getAdminTodo(db, existing.todoId), created: false };
  }

  const todoId = randomUUID();
  const now = Date.now();
  const title = existing.body.split("\n")[0]!.trim().slice(0, 500);
  const notes = [existing.pagePath ? `Page: ${existing.pagePath}` : "", `Bug report ${existing.id}`, existing.body]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 5000);
  const metaAt = new Date(now).toISOString();

  await execBatch(db, [
    {
      sql: "update bug_reports set todo_id = ?, updated_at = ? where id = ? and todo_id is null",
      args: [todoId, now, id],
    },
    {
      sql: `insert into admin_todos
        (id, title, notes, category, priority, status, created_at, updated_at, done_at, position, seq)
        select ?, ?, ?, 'bug', 'normal', 'open', ?, ?, null,
          coalesce((select min(position) - 1000 from admin_todos where status = 'open'), 0),
          max(
            coalesce((select cast(value_json as integer) from live_meta where key = 'admin_todos_seq'), 0),
            coalesce((select max(seq) from admin_todos), 0)
          ) + 1
        where exists (select 1 from bug_reports where id = ? and todo_id = ?)`,
      args: [todoId, title, notes || null, now, now, id, todoId],
    },
    {
      sql: `insert into live_meta (key, value_json, updated_at)
        select 'admin_todos_seq', cast(seq as text), ? from admin_todos where id = ?
        on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
      args: [metaAt, todoId],
    },
  ]);

  const report = await getById(db, id);
  if (!report) return null;
  if (report.todoId !== todoId) {
    return { report, todo: report.todoId ? await getAdminTodo(db, report.todoId) : null, created: false };
  }
  return { report, todo: await getAdminTodo(db, todoId), created: true };
}

/**
 * Deleting a report leaves its screenshots behind in R2 unless the caller
 * removes them, so the keys come back with the verdict rather than the caller
 * having to read the row first.
 */
export async function deleteBugReport(db: Db, id: string): Promise<{ deleted: boolean; screenshotKeys: string[] }> {
  const existing = await getById(db, id);
  if (!existing) return { deleted: false, screenshotKeys: [] };
  const [, result] = await execBatch(db, [
    { sql: "delete from bug_report_messages where report_id = ?", args: [id] },
    { sql: "delete from bug_reports where id = ?", args: [id] },
  ]);
  return { deleted: (result?.rowsAffected ?? 0) > 0, screenshotKeys: existing.screenshotKeys };
}

/** Drop everything already closed (fixed + wontfix + duplicate). "new" and "investigating" are untouched. */
export async function clearClosedBugReports(db: Db): Promise<{ cleared: number; screenshotKeys: string[] }> {
  const placeholders = BUG_REPORT_CLOSED_STATUSES.map(() => "?").join(", ");
  const rows = (await exec(
    db,
    `select screenshot_keys from bug_reports where status in (${placeholders})`,
    [...BUG_REPORT_CLOSED_STATUSES],
  )).rows;
  const screenshotKeys = rows.flatMap((row) => parseScreenshotKeys((row as Record<string, unknown>).screenshot_keys));
  const [, result] = await execBatch(db, [
    {
      sql: `delete from bug_report_messages where report_id in (
        select id from bug_reports where status in (${placeholders})
      )`,
      args: [...BUG_REPORT_CLOSED_STATUSES],
    },
    {
      sql: `delete from bug_reports where status in (${placeholders})`,
      args: [...BUG_REPORT_CLOSED_STATUSES],
    },
  ]);
  return { cleared: result?.rowsAffected ?? 0, screenshotKeys };
}
