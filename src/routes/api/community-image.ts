import { createFileRoute } from "@tanstack/react-router";
import { readCurrentAuth } from "#/lib/auth-server";

/*
 * A /communities listing's icon or banner, served by us instead of by Discord.
 *
 * Discord keeps both under the server's guild id, and a restricted listing
 * withholds that id on purpose: Discord answers /guilds/<id>/widget.json to
 * anyone, and for a server with its widget on that answer carries a permanent
 * invite (it is how our own submit form finds one). Hotlinking the CDN on a
 * locked card would therefore hand out, in an image URL, the thing the Join
 * button is refusing to hand out.
 *
 * So the card points here instead. The backend resolves the id from the listing
 * id and hands back the CDN link, this fetches it, and the browser gets nothing
 * but the bytes. Unrestricted listings still hotlink Discord directly; the
 * backend's toCommunitySummary picks between the two.
 *
 * Not an open image host either: the backend re-checks that this viewer may see
 * this listing at all, with the same country the page was drawn for, so a
 * listing nobody may see has no pictures to fetch here.
 */

// Discord serves png/webp/gif here. Checked so a wrong answer from anywhere in
// the chain cannot turn this route into something that echoes back arbitrary
// bytes under a content type of its choosing.
const ALLOWED_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const CDN_PREFIX = "https://cdn.discordapp.com/";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 8_000;

// One answer for every refusal. Whether a listing exists, whether it has a
// banner, and whether you may see it are all things this route declines to tell
// apart, matching the 404 its backend counterpart gives.
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const Route = createFileRoute("/api/community-image")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const id = url.searchParams.get("id") ?? "";
        const kind = url.searchParams.get("kind") === "banner" ? "banner" : "icon";
        // Listing ids are uuids; anything else never reaches the backend.
        if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return notFound();

        const auth = await readCurrentAuth();

        const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
        if (!base) return notFound();
        const headers: Record<string, string> = {};
        if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;

        // Who is asking, off the osu!-verified viewer and never off the request:
        // the country is what decides whether this listing is even visible, so
        // it is read here the same way the directory's own reads read it. A
        // signed-out reader forwards neither, which is what the backend already
        // treats as a stranger.
        const query = new URLSearchParams({ id, kind });
        if (auth.viewer) {
          query.set("viewerUserId", String(auth.viewer.id));
          if (auth.viewer.countryCode) query.set("viewerCountry", auth.viewer.countryCode);
        }

        let source: string;
        try {
          const lookup = await fetch(`${base}/api/communities/image-url?${query.toString()}`, {
            headers,
            signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
          });
          if (!lookup.ok) return notFound();
          const body = (await lookup.json()) as { ok?: boolean; url?: string };
          if (body.ok !== true || typeof body.url !== "string") return notFound();
          source = body.url;
        } catch {
          return notFound();
        }
        // The backend is trusted, and this still checks: a bug on either side
        // should cost a missing picture, not a route that fetches anything a
        // caller can steer it at.
        if (!source.startsWith(CDN_PREFIX)) return notFound();

        let upstream: Response;
        try {
          upstream = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        } catch {
          return notFound();
        }
        if (!upstream.ok) return notFound();

        const contentType = (upstream.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.has(contentType)) return notFound();

        const buffer = Buffer.from(await upstream.arrayBuffer());
        if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return notFound();

        return new Response(buffer as unknown as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(buffer.length),
            // Private, because who may see this depends on who asked: no shared
            // cache in front of us may keep a copy and hand it to the next
            // person. An hour is well inside the six-hour refresh sweep, so a
            // server that changes its icon is at worst an hour stale here.
            "Cache-Control": "private, max-age=3600",
          },
        });
      },
    },
  },
});
