import { createServerFn } from "@tanstack/react-start";

import type { ManiaBridgeDownloads } from "./mania-bridge";
import { maniaBridgeDownloads, readManiaBridgeManifest } from "./mania-bridge-release";

/** The current release's installers for /bridge, or null while there is no published release. */
export const fetchManiaBridgeDownloads = createServerFn({ method: "GET" })
  .handler(async (): Promise<ManiaBridgeDownloads | null> => maniaBridgeDownloads(await readManiaBridgeManifest()));
