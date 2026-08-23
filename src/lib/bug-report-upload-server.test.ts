import { describe, expect, it, vi } from "vitest";

import { handleBugReportUploadPost, type BugReportUploadTestSeams } from "./bug-report-upload-server";

const ORIGIN = "https://mania-tracker.com";
const BACKEND = "http://127.0.0.1:7227";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);

let requestId = 0;

function uploadRequest(id = `report-${requestId += 1}`): Request {
  return new Request(`${ORIGIN}/api/bug-report-upload?id=${id}&token=ticket&index=0`, {
    method: "POST",
    headers: { "content-type": "image/webp", "sec-fetch-site": "same-origin" },
    body: PNG_BYTES as unknown as BodyInit,
  });
}

function seams(fetchFn: typeof fetch): BugReportUploadTestSeams {
  return {
    backendUrl: BACKEND,
    fetchFn,
    putScreenshot: vi.fn(async (): Promise<"stored"> => "stored"),
    deleteScreenshots: vi.fn(async () => undefined),
  };
}

describe("bug report screenshot upload", () => {
  it("refuses an invalid ticket before attempting an R2 write", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: "invalid_token" }, { status: 400 }));
    const testSeams = seams(fetchFn);
    const response = await handleBugReportUploadPost(uploadRequest(), testSeams);

    expect(response.status).toBe(403);
    expect(testSeams.putScreenshot).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("/api/bug-reports/authorize-screenshot");
  });

  it("stores only after authorization and records the sniffed key", async () => {
    const id = `report-${requestId += 1}`;
    const key = `bug-reports/${id}/0.png`;
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, alreadyAttached: false }))
      .mockResolvedValueOnce(Response.json({ ok: true, screenshotKeys: [key] }));
    const testSeams = seams(fetchFn);
    const response = await handleBugReportUploadPost(uploadRequest(id), testSeams);

    expect(response.status).toBe(200);
    expect(testSeams.putScreenshot).toHaveBeenCalledWith(key, PNG_BYTES, "image/png");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[1]?.[0])).toContain("/api/bug-reports/attach");
    expect(testSeams.deleteScreenshots).not.toHaveBeenCalled();
  });

  it("treats a replayed logical index as success without replacing its object", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ ok: true, alreadyAttached: true }));
    const testSeams = seams(fetchFn);
    const response = await handleBugReportUploadPost(uploadRequest(), testSeams);

    expect(response.status).toBe(200);
    expect(testSeams.putScreenshot).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("removes a newly written object when the final attach fails", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, alreadyAttached: false }))
      .mockResolvedValueOnce(Response.json({ error: "invalid_token" }, { status: 400 }));
    const testSeams = seams(fetchFn);
    const response = await handleBugReportUploadPost(uploadRequest(), testSeams);

    expect(response.status).toBe(403);
    expect(testSeams.deleteScreenshots).toHaveBeenCalledTimes(1);
  });

  it("keeps the object when the attach response is ambiguous", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, alreadyAttached: false }))
      .mockRejectedValueOnce(new Error("connection closed after commit"));
    const testSeams = seams(fetchFn);
    const response = await handleBugReportUploadPost(uploadRequest(), testSeams);

    expect(response.status).toBe(503);
    expect(testSeams.deleteScreenshots).not.toHaveBeenCalled();
  });

  it("does not attach over an object won by a concurrent conditional write", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ ok: true, alreadyAttached: false }));
    const testSeams = seams(fetchFn);
    testSeams.putScreenshot = vi.fn(async (): Promise<"exists"> => "exists");
    const response = await handleBugReportUploadPost(uploadRequest(), testSeams);

    expect(response.status).toBe(409);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(testSeams.deleteScreenshots).not.toHaveBeenCalled();
  });
});
