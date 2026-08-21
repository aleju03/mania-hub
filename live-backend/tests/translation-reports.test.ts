import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import {
  TRANSLATION_REPORT_PER_REPORTER_PER_DAY,
  clearReviewedTranslationReports,
  createTranslationReport,
  deleteTranslationReport,
  getTranslationReport,
  listTranslationReports,
  updateTranslationReport,
} from "../src/features/translation-reports.js";

let dir = "";
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mania-translation-reports-"));
  db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function submit(overrides: Record<string, unknown> = {}) {
  return createTranslationReport(db, {
    locale: "zh-CN",
    sourceText: "段位",
    suggestion: "段位估算",
    reporterKey: "user:7",
    userId: 7,
    username: "reporter",
    pagePath: "/rankings",
    ...overrides,
  });
}

describe("translation reports", () => {
  it("stores a report with normalized fields and a new status", async () => {
    const result = await submit({ pagePath: "/rankings?country=CR&page=2", note: "  reads odd  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicate).toBe(false);
    expect(result.report.status).toBe("new");
    expect(result.report.note).toBe("reads odd");
    // Query strings are dropped: they carry the reporter's own filters and the
    // path alone answers "where did you see it".
    expect(result.report.pagePath).toBe("/rankings");
    expect(result.report.reviewedAt).toBeNull();

    const stored = await getTranslationReport(db, result.report.id);
    expect(stored?.sourceText).toBe("段位");
    expect(stored?.userId).toBe(7);
    expect(stored?.username).toBe("reporter");
  });

  it("accepts a signed-out report and refuses one with no text", async () => {
    const anon = await createTranslationReport(db, { locale: "zh-CN", sourceText: "卡包" });
    expect(anon.ok).toBe(true);
    if (anon.ok) expect(anon.report.userId).toBeNull();

    const empty = await createTranslationReport(db, { locale: "zh-CN", sourceText: "   " });
    expect(empty).toEqual({ ok: false, reason: "invalid_report" });
    const badLocale = await createTranslationReport(db, { locale: "not a locale!", sourceText: "x" });
    expect(badLocale).toEqual({ ok: false, reason: "invalid_report" });
  });

  it("returns the stored row instead of a second copy for a repeated submit", async () => {
    const first = await submit();
    const again = await submit();
    expect(again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.duplicate).toBe(true);
    expect(again.report.id).toBe(first.report.id);

    // A different suggestion for the same string is a different report.
    const changed = await submit({ suggestion: "段位评估" });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.report.id).not.toBe(first.report.id);
  });

  it("caps one reporter per day and lets a different reporter through", async () => {
    for (let i = 0; i < TRANSLATION_REPORT_PER_REPORTER_PER_DAY; i++) {
      const result = await submit({ sourceText: `string ${i}` });
      expect(result.ok).toBe(true);
    }
    const overCap = await submit({ sourceText: "one too many" });
    expect(overCap).toEqual({ ok: false, reason: "too_many_reports" });

    const other = await submit({ reporterKey: "ip:abc", userId: null, sourceText: "one too many" });
    expect(other.ok).toBe(true);
  });

  it("frees a reporter's budget once their reports age out of the window", async () => {
    const result = await submit();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60_000;
    await exec(db, "update translation_reports set created_at = ? where id = ?", [twoDaysAgo, result.report.id]);

    // Same text, but outside the duplicate window: a fresh row, not the old one.
    const later = await submit();
    expect(later.ok).toBe(true);
    if (later.ok) {
      expect(later.duplicate).toBe(false);
      expect(later.report.id).not.toBe(result.report.id);
    }
  });

  it("filters, counts and searches the admin board", async () => {
    const a = await submit({ sourceText: "首页", suggestion: "主页" });
    await submit({ sourceText: "回放", locale: "es", reporterKey: "ip:1" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await updateTranslationReport(db, { id: a.report.id, status: "resolved", adminNote: "fixed in the po" });

    const all = await listTranslationReports(db);
    expect(all.total).toBe(2);
    expect(all.counts).toEqual({ new: 1, resolved: 1, dismissed: 0, total: 2 });

    const open = await listTranslationReports(db, { status: "new" });
    expect(open.reports).toHaveLength(1);
    expect(open.reports[0]?.sourceText).toBe("回放");
    // Counts stay whole-table so the status tabs keep their totals while one is selected.
    expect(open.counts.total).toBe(2);

    const zh = await listTranslationReports(db, { locale: "zh-CN" });
    expect(zh.reports).toHaveLength(1);

    const found = await listTranslationReports(db, { search: "主页" });
    expect(found.reports[0]?.id).toBe(a.report.id);
    expect((await listTranslationReports(db, { search: "nothing here" })).reports).toHaveLength(0);
  });

  it("does not let a wildcard in the search string match everything", async () => {
    await submit({ sourceText: "plain" });
    const wildcard = await listTranslationReports(db, { search: "%" });
    expect(wildcard.reports).toHaveLength(0);
  });

  it("stamps reviewedAt on triage and clears it on reopen", async () => {
    const created = await submit();
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const dismissed = await updateTranslationReport(db, { id: created.report.id, status: "dismissed" });
    expect(dismissed?.status).toBe("dismissed");
    expect(dismissed?.reviewedAt).toBeGreaterThan(0);

    const reopened = await updateTranslationReport(db, { id: created.report.id, status: "new" });
    expect(reopened?.reviewedAt).toBeNull();
    // An untouched field keeps its stored value.
    const noted = await updateTranslationReport(db, { id: created.report.id, adminNote: "ask the donor" });
    expect(noted?.status).toBe("new");
    expect(noted?.adminNote).toBe("ask the donor");

    expect(await updateTranslationReport(db, { id: "missing", status: "resolved" })).toBeNull();
  });

  it("deletes one report and clears only the triaged ones", async () => {
    const first = await submit({ sourceText: "one" });
    const second = await submit({ sourceText: "two" });
    const third = await submit({ sourceText: "three" });
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;

    expect(await deleteTranslationReport(db, first.report.id)).toBe(true);
    expect(await deleteTranslationReport(db, first.report.id)).toBe(false);

    await updateTranslationReport(db, { id: second.report.id, status: "resolved" });
    expect(await clearReviewedTranslationReports(db)).toBe(1);
    const left = await listTranslationReports(db);
    expect(left.reports.map((report) => report.id)).toEqual([third.report.id]);
  });
});
