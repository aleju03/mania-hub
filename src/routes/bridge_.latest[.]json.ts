import { createFileRoute } from "@tanstack/react-router";

import { maniaBridgeLatestResponse } from "../lib/mania-bridge-release";

// Hashi 0.1.0's update check, from before the page moved to /hashi. The app does not follow redirects, so this
// answers the same as /hashi/latest.json.
export const Route = createFileRoute("/bridge_/latest.json")({
  server: {
    handlers: {
      GET: () => maniaBridgeLatestResponse(),
    },
  },
});
