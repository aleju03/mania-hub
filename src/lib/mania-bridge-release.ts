import { MANIA_BRIDGE_REPO, MANIA_BRIDGE_VERSION, type ManiaBridgeDownloads } from "./mania-bridge";

/*
 * The current Hashi release's update file, the latest.json the release workflow uploads (Tauri's updater
 * format: version, notes, and a signed installer URL per platform). Server only. Fetched from GitHub and kept for
 * five minutes, a failure included; null while there is no published release (or the repository is private), when
 * /hashi/latest.json falls back to the bare version and the app offers its Download button instead of Update.
 * The app installs only builds signed with its own key, so this only decides when an update is offered.
 */

const CACHE_MS = 5 * 60_000;
const MAX_BYTES = 64 * 1024;
const RELEASE_PREFIX = `https://github.com/${MANIA_BRIDGE_REPO}/releases/download/`;

export interface ManiaBridgeManifest {
  version: string;
  platforms: Record<string, { url: string; signature: string }>;
  [key: string]: unknown;
}

let cached: { at: number; version: string; manifest: ManiaBridgeManifest | null } | null = null;

function parseManifest(text: string): ManiaBridgeManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.version !== "string" || manifest.version.replace(/^v/, "") !== MANIA_BRIDGE_VERSION) return null;
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object") return null;
  // Every installer must be this repository's own release asset, so the page never links anywhere else.
  for (const entry of Object.values(platforms as Record<string, unknown>)) {
    const platform = entry as { url?: unknown; signature?: unknown } | null;
    if (typeof platform?.url !== "string" || !platform.url.startsWith(RELEASE_PREFIX) || typeof platform.signature !== "string") return null;
  }
  return manifest as ManiaBridgeManifest;
}

export async function readManiaBridgeManifest(): Promise<ManiaBridgeManifest | null> {
  const now = Date.now();
  if (cached && cached.version === MANIA_BRIDGE_VERSION && now - cached.at < CACHE_MS) return cached.manifest;
  let manifest: ManiaBridgeManifest | null = null;
  try {
    const response = await fetch(`${RELEASE_PREFIX}v${MANIA_BRIDGE_VERSION}/latest.json`, { signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      const text = await response.text();
      if (text.length <= MAX_BYTES) manifest = parseManifest(text);
    }
  } catch {
    manifest = null;
  }
  cached = { at: now, version: MANIA_BRIDGE_VERSION, manifest };
  return manifest;
}

export function maniaBridgeDownloads(manifest: ManiaBridgeManifest | null): ManiaBridgeDownloads | null {
  if (!manifest) return null;
  const url = (...keys: string[]) => keys.map((key) => manifest.platforms[key]?.url).find((value) => typeof value === "string") ?? null;
  const downloads: ManiaBridgeDownloads = {
    windows: url("windows-x86_64-nsis", "windows-x86_64"),
    appImage: url("linux-x86_64-appimage", "linux-x86_64"),
    deb: url("linux-x86_64-deb"),
    rpm: url("linux-x86_64-rpm"),
  };
  return downloads.windows || downloads.appImage || downloads.deb || downloads.rpm ? downloads : null;
}

/** The update check's answer: the release file as published, or the bare version while there is none. */
export async function maniaBridgeLatestResponse(): Promise<Response> {
  const manifest = await readManiaBridgeManifest();
  return new Response(JSON.stringify(manifest ?? { version: MANIA_BRIDGE_VERSION }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
