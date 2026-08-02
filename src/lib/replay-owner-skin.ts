import { createServerFn } from "@tanstack/react-start";

import { getLiveBackendUrl } from "./live-backend";
import { normalizeReplaySkinSettings } from "./replay-skin";
import type { ReplaySkinImageAsset, ReplaySkinSettings, ReplaySkinStageAssets } from "./replay-skin";
import { extractSkinSoundsFromArchive, hasAnyImportedAssets, loadOskImageAssetByPath, openOskArchive } from "./replay-skin-import";
import type { OskArchive } from "./replay-skin-import";
import { skinOskFileUrl } from "./skins";
import type { SkinSummary } from "./skins";

// A player's "replay skin": one published community skin (/skins) plus their
// customized ReplaySkinSettings, stored server-side so anyone opening their
// replay can watch with it. The stored settings never embed image data - every
// imported asset is stripped down to its path inside the skin's .osk, and the
// viewer re-extracts the pixels from the same archive the catalog already
// hosts. That keeps the payload a few KB and the skin bytes stored exactly
// once.

export const OWNER_REPLAY_SKIN_PAYLOAD_MAX_CHARS = 1_000_000;

export interface OwnerReplaySkinRecord {
  skin: SkinSummary;
  // Dehydrated payload as stored; run through rehydrateOwnerReplaySkinSettings
  // with the skin's archive before use.
  settings: unknown;
  updatedAt: string;
}

interface OwnerReplaySkinPayloadV1 {
  v: 1;
  settings: unknown;
}

const COLUMN_ASSET_KEYS = ["tap", "lnHead", "lnBody", "lnTail", "receptor", "receptorPressed"] as const;
const JUDGEMENT_ASSET_KEYS = ["hit0", "hit50", "hit100", "hit200", "hit300", "hit300g"] as const;
const STAGE_ASSET_KEYS = [
  "left",
  "right",
  "bottom",
  "hint",
  "light",
  "lighting",
  "scorebarBg",
  "scorebarColour",
  "scorebarMarker",
  "pauseOverlay",
  "pauseContinue",
  "pauseRetry",
  "pauseBack",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Imported assets carry base64 data URLs; the wire format keeps only the path
// so the payload stays small. Built-in assets (plain /images/... paths) pass
// through untouched, and an embedded asset without a source path has nothing
// to rehydrate from, so it drops.
function dehydrateAsset(asset: ReplaySkinImageAsset | undefined | null): Record<string, unknown> | undefined {
  if (!asset) return undefined;
  if (!asset.src.startsWith("data:") && !asset.src.startsWith("blob:")) return { ...asset };
  if (!asset.path) return undefined;
  const out: Record<string, unknown> = { name: asset.name, src: "", path: asset.path };
  if (asset.width) out.width = asset.width;
  if (asset.height) out.height = asset.height;
  if (asset.scale) out.scale = asset.scale;
  return out;
}

export function dehydrateReplaySkinSettings(settings: ReplaySkinSettings): OwnerReplaySkinPayloadV1 {
  const normalized = normalizeReplaySkinSettings(settings);
  const keymodeProfiles: Record<string, unknown> = {};
  for (const [key, profile] of Object.entries(normalized.keymodeProfiles)) {
    const columns = profile.assets.columns.map((column) => {
      const out: Record<string, unknown> = {};
      for (const assetKey of COLUMN_ASSET_KEYS) {
        const dehydrated = dehydrateAsset(column[assetKey]);
        if (dehydrated) out[assetKey] = dehydrated;
      }
      return out;
    });
    const judgements: Record<string, unknown> = {};
    for (const assetKey of JUDGEMENT_ASSET_KEYS) {
      const dehydrated = dehydrateAsset(profile.assets.judgements[assetKey]);
      if (dehydrated) judgements[assetKey] = dehydrated;
    }
    const combo = profile.assets.combo
      ? {
          prefix: profile.assets.combo.prefix,
          overlap: profile.assets.combo.overlap,
          digits: profile.assets.combo.digits.map((digit) => dehydrateAsset(digit) ?? null),
          x: dehydrateAsset(profile.assets.combo.x),
        }
      : null;
    const stage: Record<string, unknown> = {
      lightingWidths: profile.assets.stage.lightingWidths,
      lightColors: profile.assets.stage.lightColors,
    };
    for (const assetKey of STAGE_ASSET_KEYS) {
      const dehydrated = dehydrateAsset(profile.assets.stage[assetKey]);
      if (dehydrated) stage[assetKey] = dehydrated;
    }
    keymodeProfiles[key] = { ...profile, assets: { columns, judgements, combo, stage } };
  }
  return { v: 1, settings: { ...normalized, keymodeProfiles } };
}

// Walks the stored payload and swaps every path reference back to a decoded
// asset from the archive. The payload is untrusted JSON, so everything is
// guarded; assets whose path no longer resolves (the .osk was replaced with a
// build that dropped the file) fall away and the renderer falls back to flat
// shapes for that element. Normalization runs last, once the data URLs it
// requires are back in place.
export async function rehydrateOwnerReplaySkinSettings(
  payload: unknown,
  archive: OskArchive,
): Promise<ReplaySkinSettings | null> {
  if (!isRecord(payload) || payload.v !== 1 || !isRecord(payload.settings)) return null;
  const settings = structuredClone(payload.settings);
  const loads: Promise<void>[] = [];
  const loadInto = (holder: Record<string, unknown>, key: string) => {
    const raw = holder[key];
    if (!isRecord(raw)) return;
    if (raw.src !== "" || typeof raw.path !== "string" || !raw.path) return;
    const path = raw.path;
    loads.push(loadOskImageAssetByPath(archive, path).then((asset) => {
      holder[key] = asset ?? undefined;
    }));
  };

  const profiles = isRecord(settings.keymodeProfiles) ? settings.keymodeProfiles : {};
  for (const profile of Object.values(profiles)) {
    if (!isRecord(profile) || !isRecord(profile.assets)) continue;
    const assets = profile.assets;
    if (Array.isArray(assets.columns)) {
      for (const column of assets.columns) {
        if (!isRecord(column)) continue;
        for (const assetKey of COLUMN_ASSET_KEYS) loadInto(column, assetKey);
      }
    }
    if (isRecord(assets.judgements)) {
      for (const assetKey of JUDGEMENT_ASSET_KEYS) loadInto(assets.judgements, assetKey);
    }
    if (isRecord(assets.combo)) {
      const combo = assets.combo;
      if (Array.isArray(combo.digits)) {
        for (let index = 0; index < combo.digits.length; index += 1) {
          loadInto(combo.digits as unknown as Record<string, unknown>, String(index));
        }
      }
      loadInto(combo, "x");
    }
    if (isRecord(assets.stage)) {
      for (const assetKey of STAGE_ASSET_KEYS) loadInto(assets.stage, assetKey);
    }
  }

  await Promise.all(loads);
  await fillGlobalStageAssets(settings, archive);
  const rehydrated = normalizeReplaySkinSettings(settings);
  // The renderer only draws imported art under the "bars" style, so a payload
  // saved while the note shape said circles or arrows would rebuild every
  // texture and then show none of them. The importer forces bars for the same
  // reason; stored settings have to be held to it too.
  const hasArt = Object.values(rehydrated.keymodeProfiles).some((profile) => hasAnyImportedAssets(profile.assets));
  return hasArt && rehydrated.style !== "bars"
    ? normalizeReplaySkinSettings({ ...rehydrated, style: "bars" })
    : rehydrated;
}

// Skin elements that live under fixed filenames rather than a skin.ini key.
// A payload saved before the viewer understood one of these never mentions it,
// so the element is looked up in the archive instead of being lost until the
// owner re-saves their skin.
const GLOBAL_STAGE_ASSET_FILES: ReadonlyArray<readonly [Extract<keyof ReplaySkinStageAssets, string>, string]> = [
  ["pauseOverlay", "pause-overlay"],
  ["pauseContinue", "pause-continue"],
  ["pauseRetry", "pause-retry"],
  ["pauseBack", "pause-back"],
];

async function fillGlobalStageAssets(settings: Record<string, unknown>, archive: OskArchive): Promise<void> {
  const profiles = isRecord(settings.keymodeProfiles) ? settings.keymodeProfiles : {};
  const stages = Object.values(profiles)
    .map((profile) => (isRecord(profile) && isRecord(profile.assets) && isRecord(profile.assets.stage) ? profile.assets.stage : null))
    .filter((stage): stage is Record<string, unknown> => stage != null);
  if (stages.length === 0) return;

  const { resolveOskAssetByName } = await import("./replay-skin-import");
  await Promise.all(GLOBAL_STAGE_ASSET_FILES.map(async ([key, file]) => {
    const missing = stages.filter((stage) => !isRecord(stage[key]));
    if (missing.length === 0) return;
    const asset = await resolveOskAssetByName(archive, file);
    if (!asset) return;
    for (const stage of missing) stage[key] = asset;
  }));
}

// The same settings with every embedded image reduced to its path. This is
// what goes in the settings key while the pointer holds what rebuilds it;
// writing the decoded copy there blows the localStorage quota, and the failed
// write used to revert the apply on the next read.
export function replaySkinSettingsWithoutAssets(settings: ReplaySkinSettings): ReplaySkinSettings {
  return normalizeReplaySkinSettings(dehydrateReplaySkinSettings(settings).settings);
}

// Whether any keymode profile embeds decoded image data. Settings that do are
// too large for localStorage and must persist through a dehydrated pointer.
export function replaySkinSettingsEmbedAssets(settings: ReplaySkinSettings): boolean {
  const embeds = (asset?: { src: string } | null) => Boolean(asset && asset.src.startsWith("data:"));
  return Object.values(settings.keymodeProfiles).some((profile) => {
    const assets = profile.assets;
    return assets.columns.some((column) => COLUMN_ASSET_KEYS.some((key) => embeds(column[key])))
      || JUDGEMENT_ASSET_KEYS.some((key) => embeds(assets.judgements[key]))
      || STAGE_ASSET_KEYS.some((key) => embeds(assets.stage[key]))
      || Boolean(assets.combo && (assets.combo.digits.some((digit) => embeds(digit)) || embeds(assets.combo.x)));
  });
}

// ---- applied community skin (the viewer's own persisted pick) ---------------

// Applied settings that embed a whole skin's art serialize to many MB, which
// localStorage rejects; a failed write used to silently revert the apply on
// the next focus re-read. So the settings key stores only the asset-free
// copy, and this pointer (skin + dehydrated payload, a few KB) rebuilds the
// full art from the catalog .osk on page load.
export const APPLIED_COMMUNITY_REPLAY_SKIN_STORAGE_KEY = "mania-hub-replay-skin-community-v1";

export interface AppliedCommunityReplaySkin {
  skin: SkinSummary;
  payload: unknown;
  savedAt: number;
}

// What the settings modal hands the replay page on Apply when the draft
// embeds community-skin art.
export interface AppliedCommunitySkinDraft {
  skin: SkinSummary;
  payload: unknown;
  // The same settings with the embedded art stripped: what goes into the
  // regular settings key so every consumer keeps working offline.
  assetFree: ReplaySkinSettings;
}

export function appliedCommunityReplaySkinKey(applied: AppliedCommunityReplaySkin): string {
  return `${applied.skin.id}:${applied.savedAt}`;
}

export function readAppliedCommunityReplaySkin(): AppliedCommunityReplaySkin | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(APPLIED_COMMUNITY_REPLAY_SKIN_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.skin) || typeof parsed.skin.id !== "string" || !parsed.skin.id) return null;
    if (parsed.payload == null || typeof parsed.payload !== "object") return null;
    return {
      skin: parsed.skin as unknown as SkinSummary,
      payload: parsed.payload,
      savedAt: Number(parsed.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function writeAppliedCommunityReplaySkin(
  value: { skin: SkinSummary; payload: unknown } | null,
): AppliedCommunityReplaySkin | null {
  if (typeof window === "undefined") return null;
  try {
    if (!value) {
      window.localStorage.removeItem(APPLIED_COMMUNITY_REPLAY_SKIN_STORAGE_KEY);
      return null;
    }
    const applied: AppliedCommunityReplaySkin = { skin: value.skin, payload: value.payload, savedAt: Date.now() };
    window.localStorage.setItem(APPLIED_COMMUNITY_REPLAY_SKIN_STORAGE_KEY, JSON.stringify(applied));
    return applied;
  } catch {
    return null;
  }
}

export async function loadAppliedCommunityReplaySkinSettings(
  applied: AppliedCommunityReplaySkin,
): Promise<ReplaySkinSettings | null> {
  const archive = await fetchSkinArchive(applied.skin);
  if (!archive) return null;
  return rehydrateOwnerReplaySkinSettings(applied.payload, archive);
}

// ---- viewer side -----------------------------------------------------------

export interface LoadedOwnerReplaySkin {
  record: OwnerReplaySkinRecord;
  settings: ReplaySkinSettings;
  sounds: Record<string, ArrayBuffer>;
  // The open .osk, kept for the customization UI's asset picker.
  archive: OskArchive;
}

// Public, cacheable read straight from the browser: the owner id is already on
// the page (the score's user), and the backend caches the response briefly.
export async function fetchUserReplaySkin(userId: number, init?: RequestInit): Promise<OwnerReplaySkinRecord | null> {
  const base = getLiveBackendUrl();
  if (!base || !Number.isInteger(userId) || userId <= 0) return null;
  try {
    const response = await fetch(`${base}/api/replay-skin?userId=${userId}`, { credentials: "omit", ...init });
    if (!response.ok) return null;
    const body = (await response.json()) as { replaySkin?: OwnerReplaySkinRecord | null };
    return body.replaySkin ?? null;
  } catch {
    return null;
  }
}

// Opened archives, by .osk URL. The route effect that loads a player's skin
// re-runs a couple of times per page (the owner id arrives after the score),
// and a skin is several MB to fetch and unzip; without this each run pays for
// it again. Small because a viewer sees one or two skins in a session, and an
// entry only holds the zip plus whatever assets have been decoded from it.
const skinArchiveCache = new Map<string, Promise<OskArchive | null>>();
const SKIN_ARCHIVE_CACHE_MAX = 3;

// Downloads the .osk through the catalog's CORS-safe streaming endpoint (which
// does not count as a download). The archive rides HTTP caching too: the
// endpoint serves immutable cache headers.
export function fetchSkinArchive(skin: SkinSummary, init?: RequestInit): Promise<OskArchive | null> {
  const url = skinOskFileUrl(skin);
  if (!url) return Promise.resolve(null);
  const cached = skinArchiveCache.get(url);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetch(url, { credentials: "omit", ...init });
    if (!response.ok) return null;
    return await openOskArchive(await response.arrayBuffer());
  })().catch(() => null).then((archive) => {
    // A failed load must not stick, or a retry would keep serving the null.
    if (!archive) skinArchiveCache.delete(url);
    return archive;
  });

  skinArchiveCache.set(url, promise);
  if (skinArchiveCache.size > SKIN_ARCHIVE_CACHE_MAX) {
    const oldest = skinArchiveCache.keys().next().value;
    if (oldest != null && oldest !== url) skinArchiveCache.delete(oldest);
  }
  return promise;
}

// Rebuilds the full settings + gameplay sounds for a player's replay skin.
export async function loadOwnerReplaySkin(
  record: OwnerReplaySkinRecord,
  init?: RequestInit,
): Promise<LoadedOwnerReplaySkin | null> {
  try {
    const archive = await fetchSkinArchive(record.skin, init);
    if (!archive) return null;
    const settings = await rehydrateOwnerReplaySkinSettings(record.settings, archive);
    if (!settings) return null;
    const sounds = await extractSkinSoundsFromArchive(archive);
    return { record, settings, sounds, archive };
  } catch {
    return null;
  }
}

// What the stage needs from a player's skin: no archive, so a cached load can
// skip the .osk entirely. The customization UI keeps using loadOwnerReplaySkin,
// which hands back the open archive for its asset picker.
export interface CachedOwnerReplaySkin {
  record: OwnerReplaySkinRecord;
  settings: ReplaySkinSettings;
  sounds: Record<string, ArrayBuffer>;
}

// Same load, served from IndexedDB when this browser has already decoded that
// exact skin (see replay-skin-cache for why that is worth caching).
export async function loadOwnerReplaySkinCached(
  record: OwnerReplaySkinRecord,
  init?: RequestInit,
): Promise<CachedOwnerReplaySkin | null> {
  const { readCachedReplaySkin, writeCachedReplaySkin } = await import("./replay-skin-cache");
  const key = `owner:${record.skin.id}:${record.updatedAt}`;
  const cached = await readCachedReplaySkin(key).catch(() => null);
  if (cached) return { record, settings: normalizeReplaySkinSettings(cached.settings), sounds: cached.sounds };

  const loaded = await loadOwnerReplaySkin(record, init);
  if (!loaded) return null;
  void writeCachedReplaySkin(key, { settings: loaded.settings, sounds: loaded.sounds }, Date.now()).catch(() => {});
  return { record: loaded.record, settings: loaded.settings, sounds: loaded.sounds };
}

// The viewer's own applied skin, with its art. localStorage only keeps the
// asset-free copy while a community skin is on (the pointer split), so every
// surface that draws the viewer's skin has to rebuild it; memoized per pointer
// so the several stages on a page decode once between them, and cached on disk
// so the next visit skips the .osk entirely.
let appliedFullSettings: { key: string; promise: Promise<ReplaySkinSettings | null> } | null = null;

export function loadAppliedReplaySkinSettings(): Promise<ReplaySkinSettings | null> {
  const applied = readAppliedCommunityReplaySkin();
  if (!applied) {
    appliedFullSettings = null;
    return Promise.resolve(null);
  }
  const key = appliedCommunityReplaySkinKey(applied);
  if (appliedFullSettings?.key !== key) {
    appliedFullSettings = {
      key,
      promise: (async () => {
        const { readCachedReplaySkin, writeCachedReplaySkin } = await import("./replay-skin-cache");
        const cacheKey = `applied:${key}`;
        const cached = await readCachedReplaySkin(cacheKey).catch(() => null);
        if (cached) return normalizeReplaySkinSettings(cached.settings);
        const settings = await loadAppliedCommunityReplaySkinSettings(applied);
        if (!settings) return null;
        void writeCachedReplaySkin(cacheKey, { settings, sounds: {} }, Date.now()).catch(() => {});
        return settings;
      })().catch(() => null),
    };
  }
  return appliedFullSettings.promise;
}

// ---- owner side (auth-cookie server fns, the goals bridge) ------------------

interface OwnerSkinBackend {
  base: string;
  headers: HeadersInit;
  userId: number;
}

async function resolveOwnerSkinBackend(): Promise<OwnerSkinBackend | null> {
  const { readCurrentAuth } = await import("./auth-server");
  const auth = await readCurrentAuth();
  if (!auth.viewer) return null;
  const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL)?.trim().replace(/\/$/, "");
  if (!base) return null;
  const headers: HeadersInit = { "content-type": "application/json" };
  if (process.env.LIVE_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.LIVE_ADMIN_TOKEN}`;
  return { base, headers, userId: auth.viewer.id };
}

// Server-fn boundary: the customized settings ride as a JSON string (the
// pack-wallet pattern) because the serializer refuses `unknown` payloads.
export interface OwnerReplaySkinRecordWire {
  skin: SkinSummary;
  settingsJson: string;
  updatedAt: string;
}

export function parseOwnerReplaySkinRecordWire(wire: OwnerReplaySkinRecordWire): OwnerReplaySkinRecord | null {
  try {
    return { skin: wire.skin, settings: JSON.parse(wire.settingsJson), updatedAt: wire.updatedAt };
  } catch {
    return null;
  }
}

export const getMyReplaySkin = createServerFn({ method: "GET" })
  .handler(async (): Promise<OwnerReplaySkinRecordWire | null> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveOwnerSkinBackend();
    if (!cfg) return null;
    try {
      const response = await fetch(`${cfg.base}/api/replay-skin?userId=${cfg.userId}`, { cache: "no-store" });
      if (!response.ok) return null;
      const body = (await response.json()) as { replaySkin?: OwnerReplaySkinRecord | null };
      if (!body.replaySkin) return null;
      return {
        skin: body.replaySkin.skin,
        settingsJson: JSON.stringify(body.replaySkin.settings ?? null),
        updatedAt: body.replaySkin.updatedAt,
      };
    } catch {
      return null;
    }
  });

export type SetMyReplaySkinResult =
  | { ok: true }
  | { ok: false; error: "not_logged_in" | "skin_not_found" | "payload_too_large" | "unavailable" };

export const setMyReplaySkin = createServerFn({ method: "POST" })
  .validator((data: { skinId?: unknown; settingsJson?: unknown }) => {
    const skinId = typeof data.skinId === "string" ? data.skinId.trim() : "";
    if (!skinId || skinId.length > 64) throw new Error("Invalid skin id.");
    const settingsJson = typeof data.settingsJson === "string" ? data.settingsJson : "";
    if (!settingsJson) throw new Error("Invalid settings payload.");
    return { skinId, settingsJson };
  })
  .handler(async ({ data }): Promise<SetMyReplaySkinResult> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveOwnerSkinBackend();
    if (!cfg) return { ok: false, error: "not_logged_in" };
    if (data.settingsJson.length > OWNER_REPLAY_SKIN_PAYLOAD_MAX_CHARS) return { ok: false, error: "payload_too_large" };
    let settings: unknown;
    try {
      settings = JSON.parse(data.settingsJson);
    } catch {
      return { ok: false, error: "unavailable" };
    }
    if (!settings || typeof settings !== "object") return { ok: false, error: "unavailable" };
    try {
      const response = await fetch(`${cfg.base}/api/replay-skin/set`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId, skinId: data.skinId, settings }),
      });
      if (response.ok) return { ok: true };
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === "skin_not_found") return { ok: false, error: "skin_not_found" };
      if (body?.error === "payload_too_large" || response.status === 413) return { ok: false, error: "payload_too_large" };
      return { ok: false, error: "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  });

export const clearMyReplaySkin = createServerFn({ method: "POST" })
  .handler(async (): Promise<{ ok: boolean }> => {
    const { setResponseHeader } = await import("@tanstack/react-start/server");
    setResponseHeader("Cache-Control", "private, no-store");
    const cfg = await resolveOwnerSkinBackend();
    if (!cfg) return { ok: false };
    try {
      const response = await fetch(`${cfg.base}/api/replay-skin/clear`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({ userId: cfg.userId }),
      });
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  });
