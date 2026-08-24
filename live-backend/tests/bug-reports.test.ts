import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  BUG_REPORT_MAX_SCREENSHOTS,
  BUG_REPORT_MESSAGES_PER_REPORTER_PER_DAY,
  BUG_REPORT_PER_REPORTER_PER_DAY,
  BUG_REPORT_SHARED_ANON_PER_DAY,
  addAdminBugReportMessage,
  addReporterBugReportMessage,
  attachBugReportScreenshot,
  authorizeBugReportScreenshot,
  clearClosedBugReports,
  createBugReport,
  deleteBugReport,
  getBugReport,
  linkBugReportTodo,
  listBugReports,
  listBugReportsForUser,
  promoteBugReportToTodo,
  updateBugReport,
} from "../src/features/bug-reports.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-bug-reports-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function submit(overrides: Record<string, unknown> = {}) {
  return createBugReport(db, {
    body: "The tracker stops updating after I switch country twice.",
    reporterKey: "user:7",
    userId: 7,
    username: "reporter",
    pagePath: "/tracker",
    ...overrides,
  });
}

describe("bug reports", () => {
  it("stores a report with normalized fields and a new status", async () => {
    const result = await submit({
      pagePath: "/tracker?country=CR&page=2",
      context: { userAgent: "  Firefox  ", viewport: "1920x1080", dpr: 2, junk: { nested: true } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicate).toBe(false);
    expect(result.report.status).toBe("new");
    // Query strings are dropped: they carry the reporter's own filters and the
    // path alone answers "where did it happen".
    expect(result.report.pagePath).toBe("/tracker");
    expect(result.report.resolvedAt).toBeNull();
    expect(result.report.reply).toBeNull();
    // Scalars survive, a nested object does not.
    expect(result.report.context).toEqual({ userAgent: "Firefox", viewport: "1920x1080", dpr: 2 });

    const stored = await getBugReport(db, result.report.id);
    expect(stored?.userId).toBe(7);
    expect(stored?.username).toBe("reporter");
    expect(stored?.screenshotKeys).toEqual([]);
  });

  it("accepts a signed-out report and refuses one with nothing to act on", async () => {
    const anon = await createBugReport(db, { body: "Skins page is blank on my phone." });
    expect(anon.ok).toBe(true);
    if (anon.ok) expect(anon.report.userId).toBeNull();

    expect(await createBugReport(db, { body: "   " })).toEqual({ ok: false, reason: "invalid_report" });
    expect(await createBugReport(db, { body: "broken" })).toEqual({ ok: false, reason: "invalid_report" });
  });

  it("returns the stored row instead of a second copy for a repeated submit", async () => {
    const first = await submit();
    const again = await submit();
    expect(again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.report.id).toBe(first.report.id);

    const different = await submit({ body: "A different thing is broken entirely." });
    expect(different.ok).toBe(true);
    if (different.ok) expect(different.report.id).not.toBe(first.report.id);
  });

  it("keeps duplicate and reporter ceilings under concurrent submissions", async () => {
    const duplicates = await Promise.all(Array.from({ length: 10 }, () => submit()));
    expect(new Set(duplicates.filter((result) => result.ok).map((result) => result.ok ? result.report.id : "")))
      .toHaveLength(1);
    expect(Number((await exec(db, "select count(*) as n from bug_reports")).rows[0]?.n)).toBe(1);

    const attempts = await Promise.all(Array.from({ length: BUG_REPORT_PER_REPORTER_PER_DAY }, (_, index) => submit({
      body: `Concurrent distinct report ${index} contains enough detail.`,
    })));
    // The duplicate already consumed one slot, so exactly cap-1 distinct rows land.
    expect(attempts.filter((result) => result.ok)).toHaveLength(BUG_REPORT_PER_REPORTER_PER_DAY - 1);
    expect(Number((await exec(db, "select count(*) as n from bug_reports")).rows[0]?.n))
      .toBe(BUG_REPORT_PER_REPORTER_PER_DAY);
  });

  it("hands a repeated submit the live upload ticket so its screenshots still land", async () => {
    const first = await submit({ screenshotCount: 1 });
    const again = await submit({ screenshotCount: 1 });
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.uploadToken).toBe(first.uploadToken);
  });

  it("mints or refreshes a ticket when a duplicate now has screenshots to upload", async () => {
    const withoutImages = await submit();
    expect(withoutImages.ok).toBe(true);
    if (!withoutImages.ok) return;
    expect(withoutImages.uploadToken).toBeNull();

    const withImages = await submit({ screenshotCount: 1 });
    expect(withImages.ok).toBe(true);
    if (!withImages.ok) return;
    expect(withImages.duplicate).toBe(true);
    expect(withImages.uploadToken).toBeTruthy();

    await exec(db, "update bug_reports set token_expires_at = ? where id = ?", [Date.now() - 1, withImages.report.id]);
    const refreshed = await submit({ screenshotCount: 1 });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.uploadToken).toBeTruthy();
    expect(refreshed.uploadToken).not.toBe(withImages.uploadToken);
  });

  it("caps one reporter per day and lets a different reporter through", async () => {
    for (let i = 0; i < BUG_REPORT_PER_REPORTER_PER_DAY; i++) {
      expect((await submit({ body: `Something is broken, case number ${i}.` })).ok).toBe(true);
    }
    const overCap = await submit({ body: "One report too many for today." });
    expect(overCap).toEqual({ ok: false, reason: "too_many_reports" });

    const other = await submit({ reporterKey: "ip:abc", userId: null, body: "One report too many for today." });
    expect(other.ok).toBe(true);
  });

  it("frees a reporter's budget once their reports age out of the window", async () => {
    const result = await submit();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60_000;
    await exec(db, "update bug_reports set created_at = ? where id = ?", [twoDaysAgo, result.report.id]);

    const later = await submit();
    expect(later.ok).toBe(true);
    if (later.ok) {
      expect(later.duplicate).toBe(false);
      expect(later.report.id).not.toBe(result.report.id);
    }
  });

  it("caps the shared anonymous bucket without treating it as one reporter's smaller ceiling", async () => {
    for (let i = 0; i < BUG_REPORT_SHARED_ANON_PER_DAY; i++) {
      const result = await createBugReport(db, {
        body: `Anonymous shared report number ${i} has enough detail.`,
        reporterKey: "anon",
      });
      expect(result.ok).toBe(true);
    }
    expect(await createBugReport(db, {
      body: "This anonymous report is one past the shared ceiling.",
      reporterKey: "anon",
    })).toEqual({ ok: false, reason: "too_many_reports" });
  });

  describe("screenshots", () => {
    it("records keys against a live ticket and stops at the cap", async () => {
      const created = await submit({ screenshotCount: 3 });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.uploadToken) return;
      const { id } = created.report;
      const token = created.uploadToken;

      for (let i = 0; i < BUG_REPORT_MAX_SCREENSHOTS; i++) {
        const attached = await attachBugReportScreenshot(db, { id, token, key: `bug-reports/${id}/${i}.png` });
        expect(attached.ok).toBe(true);
      }
      // Re-sending one already recorded is idempotent, a fourth is refused.
      const repeat = await attachBugReportScreenshot(db, { id, token, key: `bug-reports/${id}/0.png` });
      expect(repeat.ok).toBe(true);
      if (repeat.ok) expect(repeat.screenshotKeys).toHaveLength(BUG_REPORT_MAX_SCREENSHOTS);

      // The key regex only allows indexes under the cap, so an over-cap upload
      // is refused on its key before the count is even consulted.
      const overCap = await attachBugReportScreenshot(db, { id, token, key: `bug-reports/${id}/3.png` });
      expect(overCap).toEqual({ ok: false, reason: "invalid_key" });
    });

    it("authorizes before storage and treats one logical index as idempotent across extensions", async () => {
      const created = await submit({ screenshotCount: 2 });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.uploadToken) return;
      const { id } = created.report;
      const token = created.uploadToken;
      const png = `bug-reports/${id}/0.png`;

      expect(await authorizeBugReportScreenshot(db, { id, token, key: png }))
        .toEqual({ ok: true, alreadyAttached: false });
      await attachBugReportScreenshot(db, { id, token, key: png });
      expect(await authorizeBugReportScreenshot(db, { id, token, key: `bug-reports/${id}/0.jpg` }))
        .toEqual({ ok: true, alreadyAttached: true });

      await exec(db, "update bug_reports set token_expires_at = ? where id = ?", [Date.now() - 1, id]);
      expect(await authorizeBugReportScreenshot(db, { id, token, key: `bug-reports/${id}/1.png` }))
        .toEqual({ ok: false, reason: "invalid_token" });
    });

    it("keeps all keys when attachments arrive concurrently", async () => {
      const created = await submit({ screenshotCount: 3 });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.uploadToken) return;
      const { id } = created.report;
      await Promise.all(Array.from({ length: 3 }, (_, index) => attachBugReportScreenshot(db, {
        id,
        token: created.uploadToken,
        key: `bug-reports/${id}/${index}.png`,
      })));
      expect((await getBugReport(db, id))?.screenshotKeys).toHaveLength(3);
    });

    it("refuses a key pointing anywhere but this report's own prefix", async () => {
      const created = await submit({ screenshotCount: 1 });
      const other = await createBugReport(db, {
        body: "A separate report by somebody else entirely.",
        reporterKey: "ip:zzz",
      });
      expect(created.ok && other.ok).toBe(true);
      if (!created.ok || !other.ok || !created.uploadToken) return;
      const { id } = created.report;
      const token = created.uploadToken;

      for (
        const key of [
          "replay-cache/uploads/secret.osr",
          `bug-reports/${other.report.id}/0.png`,
          `bug-reports/${id}/0.osr`,
          `bug-reports/${id}/../0.png`,
        ]
      ) {
        expect(await attachBugReportScreenshot(db, { id, token, key })).toEqual({ ok: false, reason: "invalid_key" });
      }
    });

    it("refuses a wrong, missing or expired ticket", async () => {
      const created = await submit({ screenshotCount: 1 });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.uploadToken) return;
      const { id } = created.report;
      const key = `bug-reports/${id}/0.png`;

      expect(await attachBugReportScreenshot(db, { id, token: "nope", key }))
        .toEqual({ ok: false, reason: "invalid_token" });
      expect(await attachBugReportScreenshot(db, { id: "missing", token: created.uploadToken, key }))
        .toEqual({ ok: false, reason: "report_not_found" });

      await exec(db, "update bug_reports set token_expires_at = ? where id = ?", [Date.now() - 1, id]);
      expect(await attachBugReportScreenshot(db, { id, token: created.uploadToken, key }))
        .toEqual({ ok: false, reason: "invalid_token" });
    });

    it("mints no ticket for a report that said it had no screenshots", async () => {
      const created = await submit();
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.uploadToken).toBeNull();
    });
  });

  it("filters, counts and searches the admin board", async () => {
    const a = await submit({ body: "Rankings table renders twice on mobile." });
    await submit({ body: "Snipes feed never loads for me.", reporterKey: "ip:1", userId: null, pagePath: "/snipes" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await updateBugReport(db, { id: a.report.id, status: "fixed", adminNote: "shipped" });

    const all = await listBugReports(db);
    expect(all.total).toBe(2);
    expect(all.counts).toEqual({ new: 1, investigating: 0, fixed: 1, wontfix: 0, duplicate: 0, total: 2 });

    const open = await listBugReports(db, { status: "new" });
    expect(open.reports).toHaveLength(1);
    expect(open.reports[0]?.pagePath).toBe("/snipes");
    // Counts stay whole-table so the status tabs keep their totals while one is selected.
    expect(open.counts.total).toBe(2);

    expect((await listBugReports(db, { search: "renders twice" })).reports[0]?.id).toBe(a.report.id);
    expect((await listBugReports(db, { search: "/snipes" })).reports).toHaveLength(1);
    expect((await listBugReports(db, { search: "nothing here" })).reports).toHaveLength(0);
  });

  it("does not let a wildcard in the search string match everything", async () => {
    await submit();
    expect((await listBugReports(db, { search: "%" })).reports).toHaveLength(0);
  });

  it("keeps a two-way append-only conversation and exposes it to both sides", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id } = created.report;

    expect((await addAdminBugReportMessage(db, { id, body: "Can you try that once more?" })).ok).toBe(true);
    expect((await addReporterBugReportMessage(db, {
      id,
      userId: 7,
      body: "It still breaks after a hard refresh.",
    })).ok).toBe(true);
    expect((await addAdminBugReportMessage(db, { id, body: "Found it. I am shipping the fix." })).ok).toBe(true);

    const stored = await getBugReport(db, id);
    expect(stored?.messages.map(({ author, body }) => ({ author, body }))).toEqual([
      { author: "admin", body: "Can you try that once more?" },
      { author: "reporter", body: "It still breaks after a hard refresh." },
      { author: "admin", body: "Found it. I am shipping the fix." },
    ]);
    expect(stored?.reply).toBe("Found it. I am shipping the fix.");
    expect((await listBugReportsForUser(db, 7))[0]?.messages).toEqual(stored?.messages);
    expect((await listBugReports(db, { search: "hard refresh" })).reports[0]?.id).toBe(id);
  });

  it("authorizes reporter follow-ups by stored owner and leaves anonymous reports one-way", async () => {
    const created = await submit();
    const anonymous = await createBugReport(db, { body: "The page is blank for an anonymous visitor." });
    expect(created.ok && anonymous.ok).toBe(true);
    if (!created.ok || !anonymous.ok) return;

    expect(await addReporterBugReportMessage(db, {
      id: created.report.id,
      userId: 8,
      body: "I should not be able to write here.",
    })).toEqual({ ok: false, reason: "not_owner" });
    expect(await addReporterBugReportMessage(db, {
      id: anonymous.report.id,
      userId: 7,
      body: "Nobody owns this report.",
    })).toEqual({ ok: false, reason: "anonymous_report" });
    expect(await addAdminBugReportMessage(db, {
      id: anonymous.report.id,
      body: "There is nobody verified to read this.",
    })).toEqual({ ok: false, reason: "anonymous_report" });
  });

  it("does not let a reporter reopen a report, even through a crafted input", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const fixed = await updateBugReport(db, { id: created.report.id, status: "fixed" });
    const crafted = {
      id: created.report.id,
      userId: 7,
      body: "This is happening again.",
      reopen: true,
    } as Parameters<typeof addReporterBugReportMessage>[1];
    const followedUp = await addReporterBugReportMessage(db, crafted);
    expect(followedUp.ok).toBe(true);
    if (!followedUp.ok) return;
    expect(followedUp.report.status).toBe("fixed");
    expect(followedUp.report.resolvedAt).toBe(fixed?.resolvedAt);
  });

  it("keeps a closed report closed for an ordinary thank-you", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const fixed = await updateBugReport(db, { id: created.report.id, status: "fixed" });

    const thanked = await addReporterBugReportMessage(db, {
      id: created.report.id,
      userId: 7,
      body: "Thank you, that fixed it!",
    });
    expect(thanked.ok).toBe(true);
    if (!thanked.ok) return;
    expect(thanked.report.status).toBe("fixed");
    expect(thanked.report.resolvedAt).toBe(fixed?.resolvedAt);
  });

  it("caps reporter follow-ups per report and day", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    for (let index = 0; index < BUG_REPORT_MESSAGES_PER_REPORTER_PER_DAY; index++) {
      expect((await addReporterBugReportMessage(db, {
        id: created.report.id,
        userId: 7,
        body: `Follow-up ${index}`,
      })).ok).toBe(true);
    }
    expect(await addReporterBugReportMessage(db, {
      id: created.report.id,
      userId: 7,
      body: "One too many follow-ups.",
    })).toEqual({ ok: false, reason: "too_many_messages" });
  });

  it("backfills the old mutable reply into the thread exactly once", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await exec(db, "update bug_reports set reply = 'Legacy answer', replied_at = 123 where id = ?", [created.report.id]);

    await migrate(db);
    await migrate(db);
    const stored = await getBugReport(db, created.report.id);
    expect(stored?.messages).toMatchObject([
      { author: "admin", body: "Legacy answer", createdAt: 123 },
    ]);
  });

  it("stamps resolvedAt only when closed, clears it on reopen, and dates a reply when it changes", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id } = created.report;

    const investigating = await updateBugReport(db, { id, status: "investigating" });
    expect(investigating?.resolvedAt).toBeNull();

    const fixed = await updateBugReport(db, { id, status: "fixed" });
    expect(fixed?.status).toBe("fixed");
    expect(fixed?.resolvedAt).toBeGreaterThan(0);
    expect(fixed?.repliedAt).toBeNull();

    const reopened = await updateBugReport(db, { id, status: "new" });
    expect(reopened?.resolvedAt).toBeNull();

    const replied = await updateBugReport(db, { id, reply: "Fixed on the next deploy." });
    expect(replied?.reply).toBe("Fixed on the next deploy.");
    expect(replied?.repliedAt).toBeGreaterThan(0);
    // An untouched field keeps its stored value, and an unchanged reply keeps its date.
    const noted = await updateBugReport(db, { id, adminNote: "reproduced on firefox" });
    expect(noted?.reply).toBe("Fixed on the next deploy.");
    expect(noted?.repliedAt).toBe(replied?.repliedAt);
    // Clearing the reply clears the date with it.
    expect((await updateBugReport(db, { id, reply: "" }))?.repliedAt).toBeNull();

    expect(await updateBugReport(db, { id: "missing", status: "fixed" })).toBeNull();
  });

  it("does not let concurrent partial updates revert each other", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { id } = created.report;
    await Promise.all([
      updateBugReport(db, { id, status: "fixed" }),
      updateBugReport(db, { id, adminNote: "saved while the status button was clicked" }),
      updateBugReport(db, { id, reply: "These fields should all survive." }),
    ]);
    const stored = await getBugReport(db, id);
    expect(stored?.status).toBe("fixed");
    expect(stored?.adminNote).toBe("saved while the status button was clicked");
    expect(stored?.reply).toBe("These fields should all survive.");
  });

  it("gives a reporter their own reports without the private triage fields", async () => {
    const mine = await submit({ screenshotCount: 1 });
    await submit({ reporterKey: "ip:1", userId: null, body: "Somebody else's report entirely." });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    await updateBugReport(db, { id: mine.report.id, status: "investigating", adminNote: "private", reply: "Looking." });

    const rows = await listBugReportsForUser(db, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reply).toBe("Looking.");
    expect(rows[0]?.status).toBe("investigating");
    expect(rows[0]).not.toHaveProperty("adminNote");
    expect(rows[0]).not.toHaveProperty("username");

    // Anonymous reports have no account to hang a reply on, so nothing matches.
    expect(await listBugReportsForUser(db, 0)).toEqual([]);
  });

  it("remembers the todo a report was promoted into", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const linked = await linkBugReportTodo(db, created.report.id, "todo-1");
    expect(linked?.todoId).toBe("todo-1");
    expect((await getBugReport(db, created.report.id))?.todoId).toBe("todo-1");
    expect(await linkBugReportTodo(db, "missing", "todo-2")).toBeNull();
  });

  it("promotes into one real todo atomically, even when two requests race", async () => {
    const created = await submit({ body: "First line becomes the title\nMore detail for the todo." });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [first, second] = await Promise.all([
      promoteBugReportToTodo(db, created.report.id),
      promoteBugReportToTodo(db, created.report.id),
    ]);
    expect(first?.report.todoId).toBeTruthy();
    expect(second?.report.todoId).toBe(first?.report.todoId);
    const rows = await exec(db, "select id, title, category, seq from admin_todos");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.id).toBe(first?.report.todoId);
    expect(rows.rows[0]?.title).toBe("First line becomes the title");
    expect(rows.rows[0]?.category).toBe("bug");
    expect(Number(rows.rows[0]?.seq)).toBeGreaterThan(0);
    expect((await getBugReport(db, created.report.id))?.todoSeq).toBe(Number(rows.rows[0]?.seq));
  });

  it("hands back screenshot keys when a report is deleted or cleared", async () => {
    const first = await submit({ body: "First broken thing.", screenshotCount: 1 });
    const second = await submit({ body: "Second broken thing." });
    const third = await submit({ body: "Third broken thing." });
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok || !first.uploadToken) return;

    const key = `bug-reports/${first.report.id}/0.png`;
    await attachBugReportScreenshot(db, { id: first.report.id, token: first.uploadToken, key });
    await addAdminBugReportMessage(db, { id: first.report.id, body: "Closing the first thread." });
    await addAdminBugReportMessage(db, { id: second.report.id, body: "Closing the second thread." });
    await updateBugReport(db, { id: first.report.id, status: "duplicate" });
    await updateBugReport(db, { id: second.report.id, status: "investigating" });

    // Clearing takes the closed ones only, and returns their objects so the
    // caller can remove them from R2.
    const cleared = await clearClosedBugReports(db);
    expect(cleared.cleared).toBe(1);
    expect(cleared.screenshotKeys).toEqual([key]);

    expect((await deleteBugReport(db, second.report.id)).deleted).toBe(true);
    expect(await deleteBugReport(db, second.report.id)).toEqual({ deleted: false, screenshotKeys: [] });
    expect((await listBugReports(db)).reports.map((report) => report.id)).toEqual([third.report.id]);
    expect(Number((await exec(db, "select count(*) as n from bug_report_messages")).rows[0]?.n)).toBe(0);
  });
});
