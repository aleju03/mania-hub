import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectReports, saveExport, shellQuote } from "./fetch-prod-bug-reports.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("fetches subsequent pages, collapses duplicate IDs, and keeps pending/notabug open", async () => {
  const paths = [];
  const pages = [
    { total: 5, reports: [{ id: "a", status: "fixed" }, { id: "b", status: "pending" }, { id: "c", status: "new" }] },
    { total: 5, reports: [{ id: "c", status: "investigating" }, { id: "d", status: "notabug" }] },
  ];
  const result = await collectReports({ status: "open", search: "some user & issue" }, async (path) => {
    paths.push(new URL(path, "http://localhost"));
    return pages.shift();
  });
  expect(paths[1].searchParams.get("offset")).toBe("3");
  expect(paths[0].searchParams.get("search")).toBe("some user & issue");
  expect(paths[0].searchParams.has("status")).toBe(false);
  expect(result.reports.map((r) => [r.id, r.status])).toEqual([["b", "pending"], ["c", "investigating"], ["d", "notabug"]]);
});

test("single report fetch ignores the open filter", async () => {
  const result = await collectReports({ id: "a/b", status: "open" }, async (path) => {
    expect(path).toBe("/api/admin/bug-reports/get?id=a%2Fb");
    return { report: { id: "a/b", status: "fixed" } };
  });
  expect(result.reports).toHaveLength(1);
});

test("incomplete pagination fails explicitly", async () => {
  await expect(collectReports({ status: "all" }, async () => ({ total: 1, reports: [] })))
    .rejects.toThrow("pagination stopped");
});

test("exports original and reply images, preserves failed downloads, and never saves signed URLs", async () => {
  const output = await mkdtemp(join(tmpdir(), "bug-reports-test-"));
  directories.push(output);
  const secret = "https://private.example/image?X-Amz-Signature=secret";
  const payload = {
    fetchedAt: "2026-09-15T00:00:00.000Z",
    reports: [{
      id: "../../untrusted-id", username: "Reporter", userId: 123, status: "new",
      body: "The issue\n<script>bad()</script>", pagePath: "/packs", createdAt: 0, updatedAt: 1,
      screenshotKeys: ["bug-reports/a/0.png"],
      messages: [{ id: "reply", author: "reporter", body: "More details", createdAt: 2,
        screenshotKeys: ["bug-reports/a/m/reply/0.webp", "bug-reports/a/m/reply/1.jpg"] }],
    }],
    attachments: {
      "bug-reports/a/0.png": secret,
      "bug-reports/a/m/reply/0.webp": `${secret}2`,
      "bug-reports/a/m/reply/1.jpg": `${secret}3`,
    },
  };
  let requests = 0;
  const failures = await saveExport(payload, output, async () => {
    requests++;
    if (requests === 3) throw new Error(`Failure fetching ${secret}`);
    return new Response(new Uint8Array([1, 2, 3]));
  });
  expect(failures).toBe(1);
  const json = await readFile(join(output, "reports.json"), "utf8");
  const saved = JSON.parse(json);
  expect(json).not.toContain(secret);
  expect(saved.attachments).toBeUndefined();
  expect(saved.reports[0].images[0].path).toBe("report-0001/image-1.png");
  expect(saved.reports[0].messages[0].images[0].path).toBe("report-0001/image-2.webp");
  expect(saved.reports[0].messages[0].images[1].error).toBe("Image download failed");
  expect(await readFile(join(output, saved.reports[0].images[0].path))).toEqual(Buffer.from([1, 2, 3]));
  const markdown = await readFile(join(output, saved.reports[0].localPath), "utf8");
  expect(markdown).toContain("osu! ID 123");
  expect(markdown).toContain("![Submitted image](image-2.webp)");
  expect(markdown).not.toContain("<script>");
  expect(markdown).toContain("Image unavailable: Image download failed");
});

test("quotes shell metacharacters as literal path contents", () => {
  expect(shellQuote("it's $(a) `b`\nnext")).toBe("'it'\\''s $(a) `b`\nnext'");
});
