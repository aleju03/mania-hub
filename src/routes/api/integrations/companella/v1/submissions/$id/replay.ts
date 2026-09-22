import { createFileRoute } from "@tanstack/react-router";

import { forwardNativeRequest } from "#/lib/companella-integration/proxy-server";

// Raw .osr bytes. Not base64, not gzipped, not rewritten: the digest in the
// manifest was taken over exactly these bytes.
export const Route = createFileRoute("/api/integrations/companella/v1/submissions/$id/replay")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => forwardNativeRequest(request, "submissionReplay", { id: params.id }),
    },
  },
});
