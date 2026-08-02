import { createFileRoute } from "@tanstack/react-router";
import { responseStartsWithZipArchive } from "#/lib/beatmap-archive-probe";
import { mirrorOrderFor, type BeatmapMirrorName } from "#/lib/beatmap-mirrors";

// Redirect target for the "osz" download buttons. Mirrors ratelimit and go
// down independently, and a plain cross-origin download link cannot see the
// failure, so this route probes the mirrors (small range request) and 302s
// to the first one that is actually serving archives. The osz bytes never
// pass through this function.

const PROBE_TIMEOUT_MS = 3500;
const MIRROR_COOLDOWN_MS = 5 * 60 * 1000;

// Per-instance, like the archive layer's cooldowns: a mirror that answered
// ratelimited/erroring is skipped for a while instead of re-probed per click.
const mirrorCooldowns = new Map<BeatmapMirrorName, number>();

type ProbeResult = "healthy" | "unhealthy" | "ratelimited";

async function probeMirror(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Range: "bytes=0-3" },
      signal: controller.signal,
    });
    if (response.status === 200 || response.status === 206) {
      // Some mirrors answer with resolver JSON while claiming both an archive
      // content type and an .osz filename. Verify the ZIP signature too.
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("json") || type.includes("html")) {
        await response.body?.cancel().catch(() => {});
        return "unhealthy";
      }
      return await responseStartsWithZipArchive(response) ? "healthy" : "unhealthy";
    }
    await response.body?.cancel().catch(() => {});
    // 404s are per-set (the mirror may just not carry it); ratelimits and
    // server errors are per-mirror and worth a cooldown.
    return response.status === 403 || response.status === 429 || response.status >= 500
      ? "ratelimited"
      : "unhealthy";
  } catch {
    return "ratelimited";
  } finally {
    clearTimeout(timeout);
  }
}

function redirectTo(target: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      "Cache-Control": "no-store",
    },
  });
}

export const Route = createFileRoute("/api/osz")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const beatmapsetId = url.searchParams.get("beatmapsetId");
        if (!beatmapsetId || !/^\d+$/.test(beatmapsetId)) {
          return new Response("Invalid beatmapsetId", { status: 400 });
        }

        const order = mirrorOrderFor(Number(beatmapsetId));
        const now = Date.now();
        let browserFallback: string | null = null;
        for (const mirror of order) {
          const target = mirror.url(beatmapsetId);
          if ((mirrorCooldowns.get(mirror.name) ?? 0) > now) {
            // Cooldowns reflect the server's IP. A browser may still be able
            // to reach this mirror if every server-side probe fails.
            browserFallback ??= target;
            continue;
          }
          const result = await probeMirror(target);
          if (result === "healthy") return redirectTo(target);
          if (result === "ratelimited") {
            browserFallback ??= target;
            mirrorCooldowns.set(mirror.name, Date.now() + MIRROR_COOLDOWN_MS);
          }
        }

        // Only retry a mirror whose failure may be specific to the server's
        // IP. Never redirect to a response we already proved was not a ZIP.
        if (browserFallback) return redirectTo(browserFallback);
        return new Response("No beatmap mirror is serving a valid .osz", {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": "30",
          },
        });
      },
    },
  },
});
