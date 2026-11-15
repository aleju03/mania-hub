import { createFileRoute } from "@tanstack/react-router";
import { handleThemeAssetUpload } from "#/lib/supporter-theme-asset-upload-server";

// An image for a supporter's own profile theme: a texture, its still or its
// banner row. The handler lives in src/lib/supporter-theme-asset-upload-server.ts.

export const Route = createFileRoute("/api/supporter-theme-asset")({
  server: {
    handlers: {
      POST: ({ request }) => handleThemeAssetUpload(request),
    },
  },
});
