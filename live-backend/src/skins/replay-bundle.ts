import crypto from "node:crypto";
// Type-only: jszip's runtime is loaded on demand inside buildBundle, like the
// .osk validator does, so the library stays out of the serving process's boot
// module graph.
import type JSZip from "jszip";
import { logInfo, logWarn } from "../logger.js";
import { readSkinObject, type SkinStorageConfig } from "./r2.js";

// The bundle behind a private skin's replays. A public skin lets the viewer
// download the whole .osk and unzip it in the browser; a private one must not,
// so the backend opens the archive itself and hands back a zip holding only
// what that player's stored settings actually draw: the images their payload
// names, the mania hitsounds, and skin.ini. Everything else in the skin - the
// art they did not map to anything, the menu backgrounds, the other keymodes'
// leftovers - never leaves the server.
//
// What this cannot do is hide the pixels that end up on screen. A viewer's
// browser has to hold the notes it is drawing, so a determined person can pull
// those out of devtools. The guarantee is narrower and worth stating plainly:
// there is no .osk to download, no skin page to open, and no way to get the
// parts of the skin a replay does not render.

const BUNDLE_MAX_BYTES = 24 * 1024 * 1024;
const BUNDLE_MAX_ENTRIES = 400;
// Matches the client's own cap in replay-skin-import: a sample past this is
// skipped there, so shipping it would only waste the transfer.
const MAX_SOUND_BYTES = 1.5 * 1024 * 1024;

const SOUND_NAMES = [
  ...["normal", "soft", "drum"].flatMap((bank) =>
    ["hitnormal", "hitwhistle", "hitfinish", "hitclap"].map((name) => `${bank}-${name}`),
  ),
  "combobreak",
];
const SOUND_EXTENSIONS = ["wav", "ogg", "mp3"];

// Elements the stored payload never names because the viewer resolves them by
// filename at load time (replay-owner-skin's fillGlobalStageAssets). Without
// them in the bundle a private skin would quietly lose its pause screen.
const NAMED_ASSET_FILES = ["pause-overlay", "pause-continue", "pause-retry", "pause-back"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"];

// A bundle is only rebuilt when the skin's file or the player's settings
// change, and a player's replays are watched in bursts, so a couple of them in
// memory covers the traffic. Deliberately not persisted: a derived artifact in
// R2 would need its own cleanup on every settings change, skin update and
// delete, and rebuilding one costs a single .osk read.
const CACHE_MAX_ENTRIES = 3;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;

interface CacheEntry {
  bytes: Buffer;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Buffer | null>>();
// Builds hold a whole .osk in memory, so they run one at a time however many
// viewers arrive at once.
let buildChain: Promise<unknown> = Promise.resolve();

// Identifies the bytes a bundle would hold, so the browser can cache one
// forever and a settings change or a newer .osk lands on a different URL.
export function replaySkinBundleVersion(input: {
  oskKey: string | null;
  oskSha256: string | null;
  settingsUpdatedAt: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(`${input.oskKey ?? ""}|${input.oskSha256 ?? ""}|${input.settingsUpdatedAt}`)
    .digest("hex")
    .slice(0, 16);
}

// Every asset path a stored replay-skin payload references. Dehydration writes
// each imported asset as { name, src: "", path }, so the paths are exactly the
// "path" strings anywhere in the tree; walking for them rather than mirroring
// the settings shape keeps this working as the settings grow new asset slots.
export function collectReplaySkinAssetPaths(payload: unknown): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (paths.size >= BUNDLE_MAX_ENTRIES || depth > 12) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "path" && typeof entry === "string") {
        const clean = cleanZipPath(entry);
        if (clean) paths.add(clean);
      } else {
        visit(entry, depth + 1);
      }
    }
  };
  visit(payload, 0);
  return [...paths];
}

export interface ReplaySkinBundleRequest {
  skinId: string;
  oskKey: string;
  version: string;
  payload: unknown;
  oskMaxBytes: number;
}

export async function getReplaySkinBundle(
  config: SkinStorageConfig,
  request: ReplaySkinBundleRequest,
): Promise<Buffer | null> {
  const cacheKey = `${request.skinId}:${request.version}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.bytes;
  if (cached) cache.delete(cacheKey);

  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    // Queued behind any build already running, so two cold skins cannot hold
    // two .osk buffers at once.
    const run = buildChain.then(() => buildBundle(config, request));
    buildChain = run.catch(() => {});
    const bytes = await run;
    if (bytes) rememberBundle(cacheKey, bytes);
    return bytes;
  })().catch((error) => {
    logWarn("replay_skin_bundle_failed", { skinId: request.skinId, error: String(error) });
    return null;
  }).finally(() => {
    inflight.delete(cacheKey);
  });

  inflight.set(cacheKey, promise);
  return promise;
}

// Test seam and a restart-equivalent for the admin reset paths.
export function clearReplaySkinBundleCache(): void {
  cache.clear();
}

async function buildBundle(
  config: SkinStorageConfig,
  request: ReplaySkinBundleRequest,
): Promise<Buffer | null> {
  const archive = await readSkinObject(config, request.oskKey, request.oskMaxBytes);
  if (!archive) return null;

  const { default: JSZipRuntime } = await import("jszip");
  let zip: JSZip;
  try {
    zip = await JSZipRuntime.loadAsync(archive);
  } catch {
    return null;
  }

  const lookup = new Map<string, JSZip.JSZipObject>();
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    lookup.set(cleanZipPath(file.name).toLowerCase(), file);
  }

  const wanted = new Map<string, JSZip.JSZipObject>();
  const want = (file: JSZip.JSZipObject | undefined) => {
    if (file && wanted.size < BUNDLE_MAX_ENTRIES) wanted.set(file.name, file);
  };

  for (const [key, file] of lookup) {
    if (key === "skin.ini" || key.endsWith("/skin.ini")) want(file);
  }
  for (const path of collectReplaySkinAssetPaths(request.payload)) {
    want(lookup.get(path.toLowerCase()));
  }
  for (const name of NAMED_ASSET_FILES) {
    for (const candidate of [name, `${name}-0`]) {
      for (const ext of IMAGE_EXTENSIONS) {
        want(findByFilename(lookup, `${candidate}@2x.${ext}`));
        want(findByFilename(lookup, `${candidate}.${ext}`));
      }
    }
  }
  for (const name of SOUND_NAMES) {
    for (const ext of SOUND_EXTENSIONS) {
      const file = findByFilename(lookup, `${name}.${ext}`);
      if (file) {
        want(file);
        break;
      }
    }
  }

  const out = new JSZipRuntime();
  let total = 0;
  let dropped = 0;
  for (const [name, file] of wanted) {
    let data: Buffer;
    try {
      data = Buffer.from(await file.async("nodebuffer"));
    } catch {
      dropped += 1;
      continue;
    }
    const isSound = SOUND_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(`.${ext}`));
    if (isSound && data.length > MAX_SOUND_BYTES) {
      dropped += 1;
      continue;
    }
    if (total + data.length > BUNDLE_MAX_BYTES) {
      dropped += 1;
      continue;
    }
    total += data.length;
    out.file(name, data);
  }

  // The art inside is already compressed; deflating it again would cost the
  // serving process CPU for nothing.
  const bytes = await out.generateAsync({ type: "nodebuffer", compression: "STORE" });
  logInfo("replay_skin_bundle_built", {
    skinId: request.skinId,
    entries: wanted.size - dropped,
    dropped,
    bytes: bytes.length,
  });
  return bytes;
}

// The client resolves sounds by bare filename anywhere in the archive (skins
// often nest everything one folder deep), so the bundle has to match that.
function findByFilename(lookup: Map<string, JSZip.JSZipObject>, filename: string): JSZip.JSZipObject | undefined {
  const direct = lookup.get(filename);
  if (direct) return direct;
  for (const [key, file] of lookup) {
    if (key.endsWith(`/${filename}`)) return file;
  }
  return undefined;
}

function rememberBundle(cacheKey: string, bytes: Buffer): void {
  cache.set(cacheKey, { bytes, expiresAt: Date.now() + CACHE_TTL_MS });
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes.length;
  while (cache.size > CACHE_MAX_ENTRIES || (total > CACHE_MAX_BYTES && cache.size > 1)) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    total -= cache.get(oldest.value)?.bytes.length ?? 0;
    cache.delete(oldest.value);
  }
}

function cleanZipPath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").trim();
  return clean.includes("..") ? "" : clean;
}
