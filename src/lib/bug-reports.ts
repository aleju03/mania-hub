import { createServerFn } from "@tanstack/react-start";

import { adminAuthHeaders, bridgeAuthHeaders } from "./live-backend-tokens";
import { getServerLiveBackendUrl } from "./live-backend";
import { reporterKeyFor } from "./reporter-key";

/* Bug reports filed on /report and triaged on /admin/bug-reports. The rows live
   in the live backend (bug_reports); everything here is the bridge.

   Filing is open to signed-out visitors: whoever hit the bug is the person
   worth hearing from. So the browser never names a reporter - this resolves the
   viewer from the login cookie server-side when there is one, and otherwise
   sends nothing. Two things bound the spam that opens up: the visitor's address
   is forwarded so the backend's per-IP window keys on the reporter rather than
   on this server, and the reporter key gives the backend a stable per-reporter
   bucket for its daily cap without ever storing an address.

   The conversation is where the anonymous case stops. A thread needs a
   verified owner to read and write it; "your reports" on /report is therefore
   signed-in only, and the form says so before it is submitted rather than
   after. */

export type BugReportStatus =
  | "new"
  | "investigating"
  | "pending"
  | "fixed"
  | "wontfix"
  | "duplicate"
  | "notabug";

export const BUG_REPORT_STATUSES: readonly BugReportStatus[] = [
  "new",
  "investigating",
  "pending",
  "fixed",
  "wontfix",
  "duplicate",
  "notabug",
];

export const BUG_REPORT_BODY_MAX = 4000;
export const BUG_REPORT_MESSAGE_MAX = 4000;
/** Matches the backend cap; the form refuses a fourth image before uploading it. */
export const BUG_REPORT_MAX_SCREENSHOTS = 3;

export interface BugReportContext {
  [key: string]: string | number | boolean | null;
}

export type BugReportMessageAuthor = "reporter" | "admin";

interface BugReportMessageBase {
  id: string;
  author: BugReportMessageAuthor;
  body: string;
  createdAt: number;
  /** Set when the owner corrected the message after sending it. */
  editedAt: number | null;
}

/** As the admin board reads a message: the keys, so a row can ask for signed URLs. */
export interface BugReportMessage extends BugReportMessageBase {
  screenshotKeys: string[];
}

/** As the reporter reads their own: the count, like the report body's images. */
export interface MyBugReportMessage extends BugReportMessageBase {
  screenshotCount: number;
}

export interface BugReport {
  id: string;
  status: BugReportStatus;
  body: string;
  pagePath: string | null;
  context: BugReportContext | null;
  userId: number | null;
  username: string | null;
  screenshotKeys: string[];
  adminNote: string | null;
  reply: string | null;
  repliedAt: number | null;
  messages: BugReportMessage[];
  /** When the board last read this report; null until it has. */
  adminSeenAt: number | null;
  todoId: string | null;
  todoSeq: number | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

/** What a reporter may read back about their own report. */
export interface MyBugReport {
  id: string;
  status: BugReportStatus;
  body: string;
  pagePath: string | null;
  screenshotCount: number;
  reply: string | null;
  repliedAt: number | null;
  messages: MyBugReportMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface BugReportCounts {
  new: number;
  investigating: number;
  pending: number;
  fixed: number;
  wontfix: number;
  duplicate: number;
  notabug: number;
  total: number;
}

// "invalid_report" means the form was empty or too short after trimming,
// "too_many_reports" is the backend's daily per-reporter cap, "rate_limited"
// its per-IP window, "failed" anything else (backend down or unconfigured).
export type BugReportFailReason = "invalid_report" | "too_many_reports" | "rate_limited" | "failed";

export type SubmitBugReportResult =
  | { ok: true; id: string; duplicate: boolean; uploadToken: string | null }
  | { ok: false; reason: BugReportFailReason };

export type BugReportReplyFailReason = "invalid_message" | "too_many_messages" | "not_found" | "failed";

export type ReplyToBugReportResult =
  | { ok: true; report: MyBugReport; messageId: string; uploadToken: string | null }
  | { ok: false; reason: BugReportReplyFailReason };

/** Rolling deployments can briefly pair a new frontend with a backend that
 *  still exposes only the old single reply. Turn that value into one synthetic
 *  message until the message-table migration is serving the real history. */
export function bugReportThreadMessages<T extends BugReportMessageBase>(
  report: { messages: T[]; reply: string | null; repliedAt: number | null },
): T[] {
  if (Array.isArray(report.messages) && report.messages.length) return report.messages;
  if (!report.reply) return [];
  // The synthetic row carries both screenshot shapes so it reads as either
  // side's message type; a legacy reply never had images of its own.
  return [{
    id: "legacy-admin-reply",
    author: "admin",
    body: report.reply,
    createdAt: report.repliedAt ?? 0,
    editedAt: null,
    screenshotKeys: [],
    screenshotCount: 0,
  } as unknown as T];
}

/** Whether the reporter's side of the thread has said something since the board
 *  last read the row. The same rule the backend counts on, so a card's mark and
 *  the nav dot cannot disagree. */
export function bugReportHasUnreadReporterActivity(report: BugReport): boolean {
  const lastReporterMessage = report.messages.reduce(
    (newest, message) => (message.author === "reporter" ? Math.max(newest, message.createdAt) : newest),
    0,
  );
  return Math.max(report.createdAt, lastReporterMessage) > (report.adminSeenAt ?? 0);
}

export const submitBugReport = createServerFn({ method: "POST" })
  .validator((data: {
    body: string;
    pagePath?: string;
    context?: BugReportContext;
    screenshotCount?: number;
  }) => data)
  .handler(async ({ data }): Promise<SubmitBugReportResult> => {
    const { getRequest, setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const base = getServerLiveBackendUrl();
    if (!base) return { ok: false, reason: "failed" };

    const { readCurrentAuth } = await import("./auth-server");
    const viewer = (await readCurrentAuth()).viewer;
    const request = getRequest();
    const headers: Record<string, string> = { ...bridgeAuthHeaders(true) };
    // Lets the backend's per-IP window key on the visitor instead of on this
    // server, the same way country activation forwards it.
    const forwardedFor = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for");
    if (forwardedFor) headers["x-forwarded-for"] = forwardedFor;

    try {
      const response = await fetch(`${base}/api/bug-reports/submit`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          body: data.body,
          pagePath: data.pagePath ?? null,
          context: data.context ?? null,
          screenshotCount: Math.min(Math.max(0, Math.floor(data.screenshotCount ?? 0)), BUG_REPORT_MAX_SCREENSHOTS),
          userId: viewer?.id ?? null,
          username: viewer?.username ?? null,
          reporterKey: await reporterKeyFor(request, viewer?.id ?? null),
        }),
      });
      if (response.status === 429) return { ok: false, reason: "rate_limited" };
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        id?: string;
        duplicate?: boolean;
        uploadToken?: string | null;
        error?: string;
      };
      if (response.ok && payload.ok === true && payload.id) {
        return {
          ok: true,
          id: payload.id,
          duplicate: payload.duplicate === true,
          uploadToken: payload.uploadToken ?? null,
        };
      }
      if (payload.error === "too_many_reports" || payload.error === "invalid_report") {
        return { ok: false, reason: payload.error };
      }
      return { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "failed" };
    }
  });

/** The signed-in reporter's own reports. Returns an empty list when signed out. */
export const listMyBugReports = createServerFn({ method: "GET" }).handler(async (): Promise<MyBugReport[]> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const base = getServerLiveBackendUrl();
  if (!base) return [];

  const { readCurrentAuth } = await import("./auth-server");
  const viewer = (await readCurrentAuth()).viewer;
  if (!viewer) return [];

  try {
    const response = await fetch(`${base}/api/bug-reports/mine?userId=${viewer.id}`, {
      headers: { ...bridgeAuthHeaders(), connection: "close" },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { reports?: MyBugReport[] };
    return payload.reports ?? [];
  } catch {
    return [];
  }
});

/** Append to one of the signed-in viewer's own report threads. The browser
 *  names only the report and words; the verified osu! id is injected here and
 *  checked against the stored owner again by the backend. */
export const replyToMyBugReport = createServerFn({ method: "POST" })
  .validator((data: { id: string; body: string; screenshotCount?: number }) => ({
    id: String(data?.id ?? ""),
    body: String(data?.body ?? "").trim().slice(0, BUG_REPORT_MESSAGE_MAX),
    screenshotCount: Math.min(Math.max(0, Math.floor(Number(data?.screenshotCount ?? 0))), BUG_REPORT_MAX_SCREENSHOTS),
  }))
  .handler(async ({ data }): Promise<ReplyToBugReportResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const base = getServerLiveBackendUrl();
    if (!base) return { ok: false, reason: "failed" };
    const { readCurrentAuth } = await import("./auth-server");
    const viewer = (await readCurrentAuth()).viewer;
    if (!viewer) return { ok: false, reason: "not_found" };

    try {
      const response = await fetch(`${base}/api/bug-reports/reply`, {
        method: "POST",
        headers: bridgeAuthHeaders(true),
        body: JSON.stringify({
          id: data.id,
          body: data.body,
          userId: viewer.id,
          screenshotCount: data.screenshotCount,
        }),
      });
      const payload = await response.json().catch(() => ({})) as {
        report?: MyBugReport;
        messageId?: string;
        uploadToken?: string | null;
        error?: string;
      };
      if (response.ok && payload.report) {
        return {
          ok: true,
          report: payload.report,
          messageId: payload.messageId ?? "",
          uploadToken: payload.uploadToken ?? null,
        };
      }
      if (payload.error === "invalid_message") return { ok: false, reason: "invalid_message" };
      if (payload.error === "too_many_messages") return { ok: false, reason: "too_many_messages" };
      if (response.status === 404) return { ok: false, reason: "not_found" };
      return { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "failed" };
    }
  });

/* ------------------------------------------------------------------ admin */

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getServerLiveBackendUrl();
  if (!base) throw new Error("LIVE_BACKEND_URL is not configured.");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...adminAuthHeaders(init.method === "POST"), connection: "close", ...(init.headers ?? {}) },
  });
}

export interface BugReportPage {
  reports: BugReport[];
  counts: BugReportCounts;
  total: number;
}

export const listBugReports = createServerFn({ method: "GET" })
  .validator((data: { status?: string; search?: string; limit?: number; offset?: number } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<BugReportPage> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Bug reports list");
    const query = new URLSearchParams();
    if (data.status) query.set("status", data.status);
    if (data.search) query.set("search", data.search);
    if (data.limit != null) query.set("limit", String(data.limit));
    if (data.offset != null) query.set("offset", String(data.offset));
    const suffix = query.toString();
    const response = await adminFetch(`/api/admin/bug-reports${suffix ? `?${suffix}` : ""}`);
    if (!response.ok) throw new Error(`Bug reports list failed (${response.status}).`);
    return await response.json() as BugReportPage;
  });

export const updateBugReport = createServerFn({ method: "POST" })
  .validator((data: { id: string; status?: BugReportStatus; adminNote?: string | null; reply?: string | null }) => data)
  .handler(async ({ data }): Promise<{ report: BugReport }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Bug report update");
    const response = await adminFetch("/api/admin/bug-reports/update", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Bug report update failed (${response.status}).`);
    return await response.json() as { report: BugReport };
  });

export const replyToBugReportAsAdmin = createServerFn({ method: "POST" })
  .validator((data: { id: string; body: string; screenshotCount?: number }) => ({
    id: String(data?.id ?? ""),
    body: String(data?.body ?? "").trim().slice(0, BUG_REPORT_MESSAGE_MAX),
    screenshotCount: Math.min(Math.max(0, Math.floor(Number(data?.screenshotCount ?? 0))), BUG_REPORT_MAX_SCREENSHOTS),
  }))
  .handler(async ({ data }): Promise<{
    report: BugReport;
    messageId: string;
    uploadToken: string | null;
  }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Bug report reply");
    const response = await adminFetch("/api/admin/bug-reports/reply", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Bug report reply failed (${response.status}).`);
    const payload = await response.json() as {
      report: BugReport;
      messageId?: string;
      uploadToken?: string | null;
    };
    return {
      report: payload.report,
      messageId: payload.messageId ?? "",
      uploadToken: payload.uploadToken ?? null,
    };
  });

/** Fix an already sent answer. The backend stamps the row as edited and only
 *  accepts the owner's own messages, so a reporter's words stay theirs. */
export const editBugReportMessageAsAdmin = createServerFn({ method: "POST" })
  .validator((data: { id: string; messageId: string; body: string }) => ({
    id: String(data?.id ?? ""),
    messageId: String(data?.messageId ?? ""),
    body: String(data?.body ?? "").trim().slice(0, BUG_REPORT_MESSAGE_MAX),
  }))
  .handler(async ({ data }): Promise<{ report: BugReport }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Bug report message edit");
    const response = await adminFetch("/api/admin/bug-reports/edit-message", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Bug report message edit failed (${response.status}).`);
    return await response.json() as { report: BugReport };
  });

export interface BugReportAlert {
  /** Reports carrying reporter words the board has not been shown yet. */
  count: number;
  latestAt: number | null;
  /** The same rows per status, so the board marks the tab they sit behind. */
  byStatus: Record<BugReportStatus, number>;
}

function emptyUnreadByStatus(): Record<BugReportStatus, number> {
  return { new: 0, investigating: 0, pending: 0, fixed: 0, wontfix: 0, duplicate: 0, notabug: 0 };
}

const NO_ALERT: BugReportAlert = { count: 0, latestAt: null, byStatus: emptyUnreadByStatus() };

function toAlert(payload: Partial<BugReportAlert> | undefined): BugReportAlert {
  return {
    count: Number(payload?.count ?? 0),
    latestAt: payload?.latestAt ?? null,
    byStatus: { ...emptyUnreadByStatus(), ...(payload?.byStatus ?? {}) },
  };
}

/** Backs the red dot in the nav. Polled from every page an admin is on, so it
 *  answers with zero rather than throwing when the backend is unreachable or
 *  the viewer is not an admin: a dot is not worth an error boundary. */
export const getBugReportAlert = createServerFn({ method: "GET" }).handler(async (): Promise<BugReportAlert> => {
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const { readCurrentAuth } = await import("./auth-server");
  if (!(await readCurrentAuth()).canUseAdminFeatures) return NO_ALERT;
  try {
    const response = await adminFetch("/api/admin/bug-reports/unseen");
    if (!response.ok) return NO_ALERT;
    return toAlert(await response.json() as Partial<BugReportAlert>);
  } catch {
    return NO_ALERT;
  }
});

/** Stamp the reports the board just showed as read. `all` is the explicit
 *  "clear the queue" the board offers when what is waiting sits outside the
 *  filter being looked at. */
export const markBugReportsSeen = createServerFn({ method: "POST" })
  .validator((data: { ids?: string[]; all?: boolean } | undefined) => ({
    ids: Array.isArray(data?.ids) ? data.ids.map((id) => String(id)).slice(0, 200) : [],
    all: data?.all === true,
  }))
  .handler(async ({ data }): Promise<BugReportAlert> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Bug reports seen");
    if (!data.all && !data.ids.length) return NO_ALERT;
    const response = await adminFetch("/api/admin/bug-reports/seen", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Bug reports seen failed (${response.status}).`);
    const payload = await response.json() as { alert?: Partial<BugReportAlert> };
    return toAlert(payload.alert);
  });

/* Deleting takes the row first and the images after: an orphaned object nobody
   holds a link to is a smaller problem than a report row pointing at a
   screenshot that is already gone. */
export const deleteBugReport = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Bug report delete");
    const response = await adminFetch("/api/admin/bug-reports/delete", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Bug report delete failed (${response.status}).`);
    const payload = await response.json() as { ok: boolean; screenshotKeys?: string[] };
    await removeScreenshots(payload.screenshotKeys ?? []);
    return { ok: payload.ok };
  });

export const clearClosedBugReports = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ cleared: number }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Bug reports clear");
    const response = await adminFetch("/api/admin/bug-reports/clear-closed", { method: "POST", body: "{}" });
    if (!response.ok) throw new Error(`Bug reports clear failed (${response.status}).`);
    const payload = await response.json() as { cleared: number; screenshotKeys?: string[] };
    await removeScreenshots(payload.screenshotKeys ?? []);
    return { cleared: payload.cleared };
  },
);

export const promoteBugReportToTodo = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; todoId: string | null; todoSeq: number | null }> => {
    const { requireAdminAccess } = await import("./auth");
    await requireAdminAccess("Bug report promote");
    const response = await adminFetch("/api/admin/bug-reports/promote-to-todo", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const payload = await response.json().catch(() => ({})) as {
      ok?: boolean;
      todo?: { id?: string; seq?: number };
      todoId?: string;
      todoSeq?: number;
      error?: string;
    };
    // Already promoted is not a failure worth throwing over: the board only
    // wants to end up showing the todo either way.
    if (response.status === 409) {
      return { ok: true, todoId: payload.todoId ?? null, todoSeq: payload.todoSeq ?? null };
    }
    if (!response.ok) throw new Error(`Bug report promote failed (${response.status}).`);
    return {
      ok: payload.ok === true,
      todoId: payload.todo?.id ?? null,
      todoSeq: payload.todo?.seq ?? null,
    };
  });

/**
 * Signed, short-lived URLs for one report's screenshots. Admins get any
 * report's; a signed-in reporter gets their own. Nobody else gets a URL at all,
 * and no screenshot ever has a public one.
 */
export const getBugReportScreenshotUrls = createServerFn({ method: "GET" })
  .validator((data: { id: string; messageId?: string }) => ({
    id: String(data?.id ?? ""),
    messageId: data?.messageId ? String(data.messageId) : null,
  }))
  .handler(async ({ data }): Promise<string[]> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const base = getServerLiveBackendUrl();
    if (!base) return [];

    const { readCurrentAuth } = await import("./auth-server");
    const auth = await readCurrentAuth();
    const keys = auth.canUseAdminFeatures
      ? await adminScreenshotKeys(data.id, data.messageId)
      : await ownScreenshotKeys(base, data.id, auth.viewer?.id ?? null, data.messageId);
    if (!keys.length) return [];

    const { getBugReportScreenshotUrl } = await import("./r2-cache");
    const urls = await Promise.all(keys.map((key) => getBugReportScreenshotUrl(key)));
    return urls.filter((url): url is string => Boolean(url));
  });

async function adminScreenshotKeys(id: string, messageId: string | null): Promise<string[]> {
  try {
    const response = await adminFetch(`/api/admin/bug-reports/get?id=${encodeURIComponent(id)}`);
    if (!response.ok) return [];
    const payload = await response.json() as { report?: BugReport };
    if (!messageId) return payload.report?.screenshotKeys ?? [];
    return payload.report?.messages.find((message) => message.id === messageId)?.screenshotKeys ?? [];
  } catch {
    return [];
  }
}

// The backend matches the report's stored user id against this one, so an
// anonymous report answers to nobody and an account cannot ask for another's.
async function ownScreenshotKeys(
  base: string,
  id: string,
  userId: number | null,
  messageId: string | null,
): Promise<string[]> {
  if (!userId) return [];
  const message = messageId ? `&messageId=${encodeURIComponent(messageId)}` : "";
  try {
    const response = await fetch(
      `${base}/api/bug-reports/screenshots?id=${encodeURIComponent(id)}&userId=${userId}${message}`,
      { headers: { ...bridgeAuthHeaders(), connection: "close" } },
    );
    if (!response.ok) return [];
    const payload = await response.json() as { screenshotKeys?: string[] };
    return payload.screenshotKeys ?? [];
  } catch {
    return [];
  }
}

async function removeScreenshots(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const { deleteBugReportScreenshots } = await import("./r2-cache");
  await deleteBugReportScreenshots(keys);
}
