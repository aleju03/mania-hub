import { createFileRoute } from "@tanstack/react-router";
import { extractBeatmapArchiveFile } from "#/lib/beatmap-archive";

const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"] as const;

function isAllowedImageFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

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

        if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
          return new Response("Invalid beatmapsetId", { status: 400 });
        }

        if (!filename || !isAllowedImageFilename(filename)) {
          return new Response("Invalid filename", { status: 400 });
        }

        try {
          const buffer = await extractBeatmapArchiveFile(beatmapsetId, filename);
          return new Response(buffer as unknown as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": getMimeType(filename),
              "Content-Length": String(buffer.length),
              "Cache-Control": "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
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
