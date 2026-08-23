// Server handler for /api/bug-report-upload, kept out of the route file so it
// can be tested with plain Request objects (no TanStack server context).
//
// A screenshot attached to a bug report goes browser -> here -> R2, then the
// key is recorded on the report in the live backend. The credential is the
// upload ticket minted when the report row was created, not a login: the whole
// point of /report is that a signed-out visitor can file one, and the ticket
// already names exactly one report and expires in minutes.
//
// The bytes are checked before they are stored: capped at the shared image
// limit, and typed by magic bytes rather than by whatever Content-Type the
// browser claimed. The key is built here from (report id, index, sniffed
// extension), and the backend refuses to record anything that does not match
// that shape, so a ticket holder cannot point a report at some other object in
// the private bucket.

import { getAppRateLimitClientIp } from "./app-client-ip";
import { MAX_IMAGE_UPLOAD_BYTES, TOO_LARGE_MESSAGE } from "./catbox-upload";
import { imageMimeExtension, sniffImageMime } from "./image-sniff";
import { getServerLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";
import { isSameOriginRequest } from "./origin";
import {
  deleteBugReportScreenshots,
  getBugReportScreenshotKey,
  putBugReportScreenshot,
  type BugReportImageExt,
} from "./r2-cache";
import { createFixedWindowLimiter, readCappedBody } from "./upload-guards";

const MAX_SCREENSHOTS = 3;
const RATE_WINDOW_MS = 60_000;
// Three images per report, and a handful of retries on a bad connection.
const UPLOAD_RATE_LIMIT_PER_WINDOW = 12;

const rateLimiter = createFixedWindowLimiter(RATE_WINDOW_MS);

export interface BugReportUploadTestSeams {
  backendUrl?: string;
  fetchFn?: typeof fetch;
  putScreenshot?: typeof putBugReportScreenshot;
  deleteScreenshots?: typeof deleteBugReportScreenshots;
}

export async function handleBugReportUploadPost(
  request: Request,
  seams: BugReportUploadTestSeams = {},
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") ?? "").trim();
  const token = (url.searchParams.get("token") ?? "").trim();
  const index = Number(url.searchParams.get("index"));
  if (!id || !token || !Number.isInteger(index) || index < 0 || index >= MAX_SCREENSHOTS) {
    return Response.json({ error: "Bad upload request." }, { status: 400 });
  }

  // Keyed on the report as well as the address: an address the deployment
  // cannot see collapses to one bucket, and the ticket already bounds that to
  // one report's worth of uploads.
  const rateKey = `${id}:${getAppRateLimitClientIp(request)}`;
  if (rateLimiter.isRateLimited(rateKey, UPLOAD_RATE_LIMIT_PER_WINDOW)) {
    return Response.json({ error: "Too many uploads. Try again in a minute." }, { status: 429 });
  }

  const buffer = await readCappedBody(request, MAX_IMAGE_UPLOAD_BYTES);
  if (!buffer) return Response.json({ error: TOO_LARGE_MESSAGE }, { status: 413 });

  const mime = sniffImageMime(buffer);
  if (!mime) return Response.json({ error: "That file is not an image." }, { status: 415 });

  const base = seams.backendUrl ?? getServerLiveBackendUrl();
  if (!base) return Response.json({ error: "Uploads are unavailable right now." }, { status: 503 });
  const fetchFn = seams.fetchFn ?? fetch;
  const putScreenshot = seams.putScreenshot ?? putBugReportScreenshot;
  const deleteScreenshots = seams.deleteScreenshots ?? deleteBugReportScreenshots;

  const key = getBugReportScreenshotKey(id, index, imageMimeExtension(mime) as BugReportImageExt);
  // Check the ticket before R2 sees a write. The report id is not treated as a
  // secret, and a stale request must not be able to overwrite/delete an object
  // merely because it knows the deterministic index key.
  let authorization: { ok?: boolean; alreadyAttached?: boolean; error?: string } = {};
  try {
    const response = await fetchFn(`${base}/api/bug-reports/authorize-screenshot`, {
      method: "POST",
      headers: { ...bridgeAuthHeaders(true), connection: "close" },
      body: JSON.stringify({ id, token, key }),
    });
    authorization = await response.json().catch(() => ({})) as typeof authorization;
    if (!response.ok || authorization.ok !== true) {
      const status = authorization.error === "invalid_token" || authorization.error === "report_not_found" ? 403 : 400;
      return Response.json({ error: "That upload was not accepted." }, { status });
    }
    // The browser is replaying an upload whose index is already on the report.
    // Treat it as success without touching the existing object.
    if (authorization.alreadyAttached) return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Could not authorize that image." }, { status: 503 });
  }

  let stored: "stored" | "exists" | "unavailable" = "unavailable";
  try {
    stored = await putScreenshot(key, buffer, mime);
  } catch {
    stored = "unavailable";
  }
  if (stored === "exists") {
    return Response.json({ error: "That image index is already being uploaded. Try again." }, { status: 409 });
  }
  if (stored !== "stored") return Response.json({ error: "Could not store that image." }, { status: 503 });

  // Record last: an object nobody has a link to is a smaller problem than a
  // report pointing at one that never arrived. A definite rejection removes
  // the new object; an ambiguous network failure keeps it in case the row write
  // committed before the response was lost.
  try {
    const response = await fetchFn(`${base}/api/bug-reports/attach`, {
      method: "POST",
      headers: { ...bridgeAuthHeaders(true), connection: "close" },
      body: JSON.stringify({ id, token, key }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; screenshotKeys?: string[] };
    if (!response.ok) {
      await deleteScreenshots([key]);
      const status = payload.error === "invalid_token" || payload.error === "report_not_found" ? 403 : 400;
      return Response.json({ error: "That upload was not accepted." }, { status });
    }
    // A concurrent upload may have claimed this logical index with a different
    // extension between authorization and attach. Its object wins; remove ours.
    if (Array.isArray(payload.screenshotKeys) && !payload.screenshotKeys.includes(key)) {
      await deleteScreenshots([key]);
    }
  } catch {
    // The attach request may have committed before its response connection
    // failed. Keep the object: at worst it is an unreachable orphan covered by
    // the lifecycle rule; deleting it could strand a row that did commit.
    return Response.json({ error: "Could not attach that image." }, { status: 503 });
  }

  return Response.json({ ok: true });
}
