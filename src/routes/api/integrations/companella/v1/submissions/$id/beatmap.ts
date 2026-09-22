import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// The single exact .osu, and only when the server asked for it. Raw bytes for
// the same reason as the replay: the MD5 in the .osr header is over them.
export const Route = createFileRoute("/api/integrations/companella/v1/submissions/$id/beatmap")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => forwardNativeRequest(request, "submissionBeatmap", { id: params.id }),
    },
  },
});
