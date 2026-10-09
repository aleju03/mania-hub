/*
 * Hashi release info, read by /bridge and served to the app as /bridge/latest.json.
 * Bump the version when a new build is published on GitHub; the site then serves that release's update file
 * and its installers, and the app offers the update.
 */
export const MANIA_BRIDGE_VERSION = "0.1.0";

export const MANIA_BRIDGE_REPO = "aleju03/mania-bridge";
export const MANIA_BRIDGE_SOURCE_URL = `https://github.com/${MANIA_BRIDGE_REPO}`;

/** The installers of the current release, by system. Null where the release has none. */
export interface ManiaBridgeDownloads {
  windows: string | null;
  appImage: string | null;
  deb: string | null;
  rpm: string | null;
}
