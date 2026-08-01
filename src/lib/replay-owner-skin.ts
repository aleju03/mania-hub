import { createServerFn } from "@tanstack/react-start";

import { canUseAdminFeatures } from "./auth-shared";
import type { AuthState } from "./auth-shared";
import { getLiveBackendUrl } from "./live-backend";
import { normalizeReplaySkinSettings } from "./replay-skin";
import type { ReplaySkinImageAsset, ReplaySkinSettings } from "./replay-skin";
import { extractSkinSoundsFromArchive, loadOskImageAssetByPath, openOskArchive } from "./replay-skin-import";
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

// The whole .osk import pipeline (community skins in the replay settings
// modal, the per-player replay skin, the asset picker) stays admin/dev only
// while it is unfinished: the parser still has known gaps against the game
// (key-area sizing, oversized LN body textures, lazer HUD scale overrides),
// so the public would get a broken-looking stage. Gate every surface on this
// one predicate, including the viewer side - nobody should have another
// player's skin applied to their replay until this ships properly.
export function canUseReplaySkinImport(auth: AuthState | undefined | null): boolean {
  return canUseAdminFeatures(auth);
}

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
  return normalizeReplaySkinSettings(settings);
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

// Downloads the .osk through the catalog's CORS-safe streaming endpoint (which
// does not count as a download). The archive rides HTTP caching: the endpoint
// serves immutable cache headers, so repeat fetches cost no re-transfer.
export async function fetchSkinArchive(skin: SkinSummary, init?: RequestInit): Promise<OskArchive | null> {
  const url = skinOskFileUrl(skin);
  if (!url) return null;
  try {
    const response = await fetch(url, { credentials: "omit", ...init });
    if (!response.ok) return null;
    return await openOskArchive(await response.arrayBuffer());
  } catch {
    return null;
  }
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
