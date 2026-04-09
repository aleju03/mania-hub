import { createFileRoute } from "@tanstack/react-router";
import { extractBeatmapArchiveFile } from "#/lib/beatmap-archive";

function getMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
}

export const Route = createFileRoute("/api/background")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const beatmapsetId = url.searchParams.get("beatmapsetId");
        const filename = url.searchParams.get("filename");

        if (!beatmapsetId) {
          return new Response("Missing beatmapsetId", { status: 400 });
        }

        if (!filename) {
          return new Response("Missing filename", { status: 400 });
        }

        try {
          const buffer = await extractBeatmapArchiveFile(beatmapsetId, filename);
          return new Response(buffer, {
            status: 200,
            headers: {
              "Content-Type": getMimeType(filename),
              "Content-Length": String(buffer.length),
              "Cache-Control": "public, max-age=3600",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown background extraction error";
          return new Response(message, { status: 404 });
        }
      },
    },
  },
});
