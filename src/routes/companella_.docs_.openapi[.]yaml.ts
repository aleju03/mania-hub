import { createFileRoute } from "@tanstack/react-router";

import spec from "../../docs/companella-api.openapi.yaml?raw";

// The Companella API spec, linked from /companella/docs. Bundled at build
// time so the served copy is always the one in docs/.
export const Route = createFileRoute("/companella_/docs_/openapi.yaml")({
  server: {
    handlers: {
      GET: async () =>
        new Response(spec, {
          headers: {
            "Content-Type": "application/yaml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
