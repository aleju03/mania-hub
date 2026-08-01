import { createFileRoute } from "@tanstack/react-router";
import { mirrorOrderFor, type BeatmapMirrorName } from "#/lib/beatmap-mirrors";

// Redirect target for the "osz" download buttons. Mirrors ratelimit and go
// down independently, and a plain cross-origin download link cannot see the
// failure, so this route probes the mirrors (1-byte range request) and 302s
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
      headers: { Range: "bytes=0-0" },
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.status === 200 || response.status === 206) {
      // Some mirrors answer 200 with a JSON error payload while ratelimited;
      // only an archive-looking content type counts as healthy.
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      return type.includes("json") || type.includes("html") ? "unhealthy" : "healthy";
    }
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
        for (const mirror of order) {
          if ((mirrorCooldowns.get(mirror.name) ?? 0) > now) continue;
          const target = mirror.url(beatmapsetId);
          const result = await probeMirror(target);
          if (result === "healthy") return redirectTo(target);
          if (result === "ratelimited") {
            mirrorCooldowns.set(mirror.name, Date.now() + MIRROR_COOLDOWN_MS);
          }
        }

        // Every mirror looked unhealthy from here, but ratelimits are per IP:
        // the browser may still succeed where this function's IP did not, so
        // fall back to the set's preferred mirror instead of failing hard.
        return redirectTo(order[0].url(beatmapsetId));
      },
    },
  },
});
