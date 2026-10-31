import { createFileRoute } from "@tanstack/react-router";
import { sanitizeReplayFilename } from "#/lib/replay-share";
import { REPLAY_FILE_MISSING_ERROR } from "#/lib/replay-score-availability";

// The .osr behind the replay viewer's Download button: a score's cached copy
// (the one the viewer itself parsed) or an uploaded file. Uploads are
// unlisted, so whoever holds the link can already watch it; this hands out
// the same bytes.

function osrResponse(buffer: Buffer, filename: string): Response {
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      // Private: an owner takedown deletes the cached copy, and a shared
      // cache would keep handing it out.
      "Cache-Control": "private, max-age=3600",
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Cache-Control": "no-store" } });
}

export const Route = createFileRoute("/api/replay-file")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const name = url.searchParams.get("name");
        const uploadId = url.searchParams.get("uploadId");
        const scoreIdParam = url.searchParams.get("scoreId");

        if (uploadId) {
          const { readUploadedReplay } = await import("#/lib/uploaded-replay-store");
          const stored = await readUploadedReplay(uploadId).catch(() => null);
          if (!stored) return errorResponse("Replay not found", 404);
          return osrResponse(stored.buffer, sanitizeReplayFilename(name || stored.originalFilename || `${stored.id}.osr`));
        }

        if (!scoreIdParam || !/^\d{1,15}$/.test(scoreIdParam)) return errorResponse("Invalid scoreId", 400);
        const scoreId = Number(scoreIdParam);
        const { getReplayBuffer } = await import("#/lib/osu/replay");
        try {
          const buffer = await getReplayBuffer({ scoreId, mode: "mania" });
          return osrResponse(buffer, sanitizeReplayFilename(name || `${scoreId}.osr`));
        } catch (error) {
          const missing = error instanceof Error && error.message === REPLAY_FILE_MISSING_ERROR;
          return errorResponse(missing ? "osu! has no replay file for this score" : "Replay download failed", missing ? 404 : 502);
        }
      },
    },
  },
});
