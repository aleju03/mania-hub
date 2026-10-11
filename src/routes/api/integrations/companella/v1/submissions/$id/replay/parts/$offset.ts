import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// One piece of the replay, raw bytes from `offset`, for a client whose network
// stalls a whole upload.
export const Route = createFileRoute("/api/integrations/companella/v1/submissions/$id/replay/parts/$offset")({
  server: {
    handlers: {
      PUT: async ({ request, params }) =>
        forwardNativeRequest(request, "submissionReplayPart", { id: params.id, offset: params.offset }),
    },
  },
});
