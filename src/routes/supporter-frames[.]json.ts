import { createFileRoute } from "@tanstack/react-router";
import { getServerLiveBackendUrl } from "../lib/live-backend";
import { getCanonicalOrigin } from "../lib/origin";
import { buildFramesManifest, readWorkshopFrames } from "../lib/supporter-frames-manifest";
import type { WorkshopFrameArt } from "../lib/supporter-avatar-frames";

// Every avatar frame's files and geometry, for apps that draw them outside the
// site (Hashi). The built-in frames' geometry lives in the frontend
// (supporter-avatar-frames.ts), the workshop frames' art in the backend, so it
// is put together here (src/lib/supporter-frames-manifest.ts).

const WORKSHOP_TTL_MS = 60_000;
let workshop: { at: number; frames: Record<string, WorkshopFrameArt> } | null = null;
let pending: Promise<Record<string, WorkshopFrameArt>> | null = null;

async function workshopFrames(): Promise<Record<string, WorkshopFrameArt> | null> {
  if (workshop && Date.now() - workshop.at < WORKSHOP_TTL_MS) return workshop.frames;
  const base = getServerLiveBackendUrl();
  if (!base) return workshop?.frames ?? null;
  pending ??= readWorkshopFrames(base).finally(() => { pending = null; });
  try {
    const frames = await pending;
    workshop = { at: Date.now(), frames };
    return frames;
  } catch {
    // the built-in frames still answer; a stale workshop list beats none
    return workshop?.frames ?? null;
  }
}

export const Route = createFileRoute("/supporter-frames.json")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const frames = await workshopFrames();
        return new Response(JSON.stringify(buildFramesManifest(getCanonicalOrigin(request), frames ?? {})), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            // short while the workshop list could not be read
            "Cache-Control": frames ? "public, max-age=60" : "public, max-age=10",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
