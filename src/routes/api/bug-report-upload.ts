import { createFileRoute } from "@tanstack/react-router";
import { handleBugReportUploadPost } from "#/lib/bug-report-upload-server";

// Screenshot uploads for a bug report filed on /report. The handler logic
// (ticket check, same-origin, rate limits, size cap, magic-byte check, R2
// write and the attach call back to the live backend) lives in
// src/lib/bug-report-upload-server.ts so it can be tested with plain Request
// objects.

export const Route = createFileRoute("/api/bug-report-upload")({
  server: {
    handlers: {
      POST: ({ request }) => handleBugReportUploadPost(request),
    },
  },
});
