import { createFileRoute } from "@tanstack/react-router";

import source from "../../scripts/companella-test-client.mjs?raw";

// The reference client, linked from /companella/docs so a client author can
// read working proof signing without access to this repository.
export const Route = createFileRoute("/companella_/docs_/reference-client.mjs")({
  server: {
    handlers: {
      GET: async () =>
        new Response(source, {
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Content-Disposition": 'inline; filename="companella-reference-client.mjs"',
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
