import { createFileRoute } from "@tanstack/react-router";

import { maniaBridgeLatestResponse } from "../lib/mania-bridge-release";

// The Hashi update check. The app's helper reads only the version and Tauri's updater the whole release
// file, so this serves that file as published, or the bare version while there is none. Answered directly with no
// redirect, since the app's client does not follow them, and kept short-lived so a bump reaches it on its next check.
export const Route = createFileRoute("/hashi_/latest.json")({
  server: {
    handlers: {
      GET: () => maniaBridgeLatestResponse(),
    },
  },
});
