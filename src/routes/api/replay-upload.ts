import { createFileRoute } from "@tanstack/react-router";
import { normalizeUploadedReplayId, readUploadedReplay, saveUploadedReplay } from "#/lib/uploaded-replay-store";

const MAX_UPLOAD_REPLAY_BYTES = 25 * 1024 * 1024;

function getShareUrl(request: Request, id: string): string {
  const url = new URL(request.url);
  url.pathname = "/replay";
  url.search = "";
  url.searchParams.set("uploadId", id);
  return url.toString();
}

export const Route = createFileRoute("/api/replay-upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const buffer = Buffer.from(await request.arrayBuffer());
        const originalFilename = decodeURIComponent(request.headers.get("x-replay-filename") ?? "").trim() || undefined;
        if (buffer.length === 0) {
          return Response.json({ error: "Replay file is empty." }, { status: 400 });
        }
        if (buffer.length > MAX_UPLOAD_REPLAY_BYTES) {
          return Response.json({ error: "Replay file is too large." }, { status: 413 });
        }

        try {
          const saved = await saveUploadedReplay(buffer, originalFilename);
          return Response.json({
            id: saved.id,
            url: getShareUrl(request, saved.id),
            storage: saved.storage,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to save replay upload.";
          return Response.json({ error: message }, { status: 500 });
        }
      },
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const id = normalizeUploadedReplayId(url.searchParams.get("id"));
        if (!id) {
          return new Response("Invalid upload id", { status: 400 });
        }

        const stored = await readUploadedReplay(id);
        if (!stored) {
          return new Response("Replay upload not found", { status: 404 });
        }

        return new Response(stored.buffer as unknown as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(stored.buffer.length),
            "Content-Disposition": `inline; filename="${stored.originalFilename || `${id}.osr`}"`,
            ...(stored.originalFilename ? { "X-Replay-Filename": encodeURIComponent(stored.originalFilename) } : {}),
            "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
          },
        });
      },
    },
  },
});
