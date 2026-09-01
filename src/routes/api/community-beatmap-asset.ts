import { createFileRoute } from "@tanstack/react-router";
import {
  handleCommunityBeatmapAssetGet,
  handleCommunityBeatmapAssetHead,
  handleCommunityBeatmapAssetPost,
} from "#/lib/community-beatmap-asset-server";

// Thin wrapper: handler logic lives in src/lib/community-beatmap-asset-server.ts.
export const Route = createFileRoute("/api/community-beatmap-asset")({
  server: {
    handlers: {
      HEAD: async ({ request }) => handleCommunityBeatmapAssetHead(request),
      GET: async ({ request }) => handleCommunityBeatmapAssetGet(request),
      POST: async ({ request }) => handleCommunityBeatmapAssetPost(request),
    },
  },
});
