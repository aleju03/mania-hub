import { createFileRoute } from "@tanstack/react-router";

import { MANIA_BRIDGE_VERSION } from "../lib/mania-bridge";
import { readManiaBridgeManifest } from "../lib/mania-bridge-release";

// The Mania Bridge update check. The app's helper reads only the version and Tauri's updater the whole release
// file, so this serves that file as published, or the bare version while there is none. Answered directly with no
// redirect, since the app's client does not follow them, and kept short-lived so a bump reaches it on its next check.
export const Route = createFileRoute("/bridge_/latest.json")({
  server: {
    handlers: {
      GET: async () => {
        const manifest = await readManiaBridgeManifest();
        return new Response(JSON.stringify(manifest ?? { version: MANIA_BRIDGE_VERSION }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
          },
        });
      },
    },
  },
});
