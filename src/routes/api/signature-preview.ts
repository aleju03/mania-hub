import { createFileRoute } from "@tanstack/react-router";

import { getServerLiveBackendUrl } from "../../lib/live-backend";
import { pngResponse } from "../../lib/og-render";
import type { ResolvedSignature } from "../../lib/signature-resolve";
import { parseSignatureVariant, signatureVariantSlug, type SignatureType } from "../../lib/signature-shared";
import { normalizeSignatureStyle } from "../../lib/signature-style";
import { normalizeTimeZone } from "../../lib/time-zone";
import { createFixedWindowLimiter } from "../../lib/upload-guards";
import { renderSignature } from "./signature/-renderers";

/* The picture behind the /dynamic-renders editor, and nothing else.
 *
 * The signature route proper cannot serve this. Its whole design is that the
 * URL is fixed forever and the style lives on the player's row, so seeing a
 * change there means: save the style, move the version, drop the resolve memo,
 * re-render, store it in R2. That is the right shape for an image pasted into
 * an osu! profile and the wrong shape for a slider - it put a save, a write
 * and a cache round trip between the drag and the picture.
 *
 * So this renders straight from a style in the request body. It can afford to
 * because it stores nothing: no R2 object, no version, no cache entry, and a
 * no-store response. The cardinality argument that keeps style out of the
 * signature URL does not apply to a render that leaves nothing behind.
 *
 * The player's own data is still read the normal way - only the look comes
 * from the request. Ordinary callers can only draw themselves. The admin
 * moderation page may name another player after resolving them through the
 * live backend; that path is checked against the admin bit from the signed
 * session here, not merely hidden in the page.
 */

// A drag with the page's debounce in front of it lands well under this; it is
// here so a script pointing at the route cannot turn one session into a render
// queue. The gate below is the actual CPU bound.
const previewLimiter = createFixedWindowLimiter(60_000);
const PREVIEWS_PER_MINUTE = 120;

// A style map is a few hundred bytes. Anything near this is not one.
const MAX_BODY_BYTES = 8 * 1024;

interface PreviewTargetInput {
  targetUserId?: unknown;
  targetUsername?: unknown;
}

export function resolveSignaturePreviewTarget(
  viewer: { id: number; username: string },
  canUseAdminFeatures: boolean,
  input: PreviewTargetInput,
): { userId: number; username: string } | { status: 400 | 403 } {
  const targetsAnotherPlayer = input.targetUserId !== undefined || input.targetUsername !== undefined;
  if (!targetsAnotherPlayer) return { userId: viewer.id, username: viewer.username };
  if (!canUseAdminFeatures) return { status: 403 };

  const userId = Number(input.targetUserId);
  const username = typeof input.targetUsername === "string"
    ? input.targetUsername.trim().slice(0, 64)
    : "";
  if (!Number.isInteger(userId) || userId <= 0 || !username) return { status: 400 };
  return { userId, username };
}

/* A supporter's own stat cards and play, as the stored render gets them from
   its resolve, read here from their public look so the preview matches. */
async function readPreviewInsightsPicks(userId: number): Promise<ResolvedSignature["insightsPicks"]> {
  const base = getServerLiveBackendUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/api/supporters/look/${userId}`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const look = await response.json() as { profileStats?: unknown; profileStatsData?: unknown; profilePlays?: unknown };
    const play = Array.isArray(look.profilePlays) ? look.profilePlays[0] ?? null : null;
    if (look.profileStats == null && play == null) return null;
    return { stats: look.profileStats, data: look.profileStatsData, play };
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/signature-preview")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { readCurrentAuth } = await import("../../lib/auth-server");
        const auth = await readCurrentAuth();
        // Signed in only: ordinary previews are tied to the caller, and the
        // admin override below is still anchored to a verified session.
        if (!auth.viewer) return new Response(null, { status: 401 });

        const declared = Number(request.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          return new Response(null, { status: 413 });
        }

        let body: {
          type?: unknown;
          design?: unknown;
          style?: unknown;
          skillsKeyCount?: unknown;
          timeZone?: unknown;
          targetUserId?: unknown;
          targetUsername?: unknown;
        };
        try {
          body = await request.json();
        } catch {
          return new Response(null, { status: 400 });
        }

        // Through the same allowlist the image route uses, so a preview can
        // never draw a size or type the real thing would refuse.
        const variant = typeof body.type === "string"
          ? parseSignatureVariant(signatureVariantSlug(body.type as SignatureType, Number(body.design)))
          : null;
        if (!variant) return new Response(null, { status: 400 });

        if (previewLimiter.isRateLimited(String(auth.viewer.id), PREVIEWS_PER_MINUTE)) {
          return new Response(null, { status: 429 });
        }

        const target = resolveSignaturePreviewTarget(auth.viewer, auth.canUseAdminFeatures, body);
        if ("status" in target) return new Response(null, { status: target.status });

        /* Everything the layouts read about the player, and nothing they do
           not. Versions and enabled types belong to the stored-render path;
           a preview has no key to compose and publishes nothing. */
        const resolved: ResolvedSignature = {
          userId: target.userId,
          username: target.username,
          enabledTypes: [variant.type],
          // Carried through so the preview and the stored render agree on
          // keymode when the style leaves it unset.
          skillsKeyCount: Number(body.skillsKeyCount) || null,
          styles: null,
          // Sent by the page rather than read from the row, so the preview
          // dates a play the same way the stored render will - including on a
          // first visit, before the row has been told the zone at all.
          timeZone: normalizeTimeZone(body.timeZone),
          versions: {} as Record<SignatureType, string>,
          insightsPicks: variant.type === "insights" ? await readPreviewInsightsPicks(target.userId) : null,
        };

        try {
          const buffer = await renderSignature({
            request,
            resolved,
            type: variant.type,
            design: variant.design,
            style: normalizeSignatureStyle(body.style, variant.type),
          });
          return pngResponse(buffer, "private, no-store");
        } catch {
          // No placeholder image: the page keeps the last good frame on screen
          // rather than replacing it with something that is not the answer.
          return new Response(null, { status: 503 });
        }
      },
    },
  },
});
