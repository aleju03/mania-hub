/*
 * Mania Bridge release info, read by /bridge and served to the app as /bridge/latest.json.
 * Bump the version when a new build is out; the app compares it with its own to offer the update.
 */
export const MANIA_BRIDGE_VERSION = "0.1.0";

/** Release builds and source. Null until the repository is public, which hides the links on /bridge. */
export const MANIA_BRIDGE_DOWNLOAD_URL: string | null = null;
export const MANIA_BRIDGE_SOURCE_URL: string | null = null;
