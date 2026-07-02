import { createFileRoute } from "@tanstack/react-router";
import { extractBeatmapArchiveFile } from "#/lib/beatmap-archive";
import { getCachedBeatmapAssetUrl, isR2ReplayCacheConfigured, putBeatmapAssetAndGetUrl } from "#/lib/r2-cache";

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
        const inline = url.searchParams.get("inline") === "1";

        if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
          return new Response("Invalid beatmapsetId", { status: 400 });
        }

        if (!filename) {
          // fullsize is the original map background (good for canvas work,
          // e.g. skin preview backdrops); the default stays the wide banner.
          const coverFile = url.searchParams.get("cover") === "fullsize" ? "fullsize.jpg" : "cover@2x.jpg";
          const target = `${OSU_COVER_BASE}/${beatmapsetId}/covers/${coverFile}`;
          if (inline) {
            const response = await fetch(target);
            if (!response.ok) {
              return new Response("Background cover not found", { status: response.status });
            }
            const contentType = response.headers.get("Content-Type") || "image/jpeg";
            const buffer = Buffer.from(await response.arrayBuffer());
            return new Response(buffer as unknown as BodyInit, {
              status: 200,
              headers: {
                "Content-Type": contentType,
                "Content-Length": String(buffer.length),
                "Cache-Control":
                  "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
              },
            });
          }
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

        const cacheHeaders = {
          "Cache-Control":
            "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
        };

        if (!inline && isR2ReplayCacheConfigured()) {
          const cached = await getCachedBeatmapAssetUrl("background", beatmapsetId, filename);
          if (cached) {
            return new Response(null, {
              status: 302,
              headers: {
                ...cacheHeaders,
                Location: cached.signedUrl,
              },
            });
          }
        }

        let buffer: Buffer;
        try {
          buffer = await extractBeatmapArchiveFile(beatmapsetId, filename);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown background extraction error";
          return new Response(message, { status: 404 });
        }

        const mimeType = getMimeType(filename);
        if (!inline && isR2ReplayCacheConfigured()) {
          try {
            const cached = await putBeatmapAssetAndGetUrl("background", beatmapsetId, filename, mimeType, buffer);
            if (cached) {
              return new Response(null, {
                status: 302,
                headers: {
                  ...cacheHeaders,
                  Location: cached.signedUrl,
                },
              });
            }
          } catch {
            // Fall through to the legacy in-process response so the background still loads.
          }
        }

        return new Response(buffer as unknown as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(buffer.length),
            "Cache-Control":
              "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, immutable",
          },
        });
      },
    },
  },
});
