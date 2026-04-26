import { createFileRoute } from "@tanstack/react-router";
import { extractBeatmapArchiveFile } from "#/lib/beatmap-archive";

const OSU_COVER_BASE = "https://assets.ppy.sh/beatmaps";
const MAX_IMAGE_FILENAME_LENGTH = 260;
const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"] as const;

function isAllowedImageFilename(filename: string): boolean {
  if (filename.length > MAX_IMAGE_FILENAME_LENGTH || filename.includes("\0")) {
    return false;
  }
  const lower = filename.toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function getMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
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

        if (!filename) {
          const target = `${OSU_COVER_BASE}/${beatmapsetId}/covers/cover@2x.jpg`;
          return new Response(null, {
            status: 302,
            headers: {
              Location: target,
              "Cache-Control":
                "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
            },
          });
        }

        if (!isAllowedImageFilename(filename)) {
          return new Response("Invalid filename", { status: 400 });
        }

        let buffer: Buffer;
        try {
          buffer = await extractBeatmapArchiveFile(beatmapsetId, filename);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown background extraction error";
          return new Response(message, { status: 404 });
        }

        return new Response(buffer as unknown as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": getMimeType(filename),
            "Content-Length": String(buffer.length),
            "Cache-Control":
              "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
          },
        });
      },
    },
  },
});
