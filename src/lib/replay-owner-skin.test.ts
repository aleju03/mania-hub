import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appliedCommunityReplaySkinKey,
  canUseReplaySkinImport,
  dehydrateReplaySkinSettings,
  readAppliedCommunityReplaySkin,
  rehydrateOwnerReplaySkinSettings,
  replaySkinSettingsEmbedAssets,
  writeAppliedCommunityReplaySkin,
} from "./replay-owner-skin";
import { ANONYMOUS_AUTH_STATE } from "./auth-shared";
import type { SkinSummary } from "./skins";
import { loadOskImageAssetByPath, openOskArchive } from "./replay-skin-import";
import { DEFAULT_REPLAY_SKIN_PROFILE, DEFAULT_REPLAY_SKIN_SETTINGS, EMPTY_REPLAY_SKIN_STAGE_ASSETS, normalizeReplaySkinSettings } from "./replay-skin";
import type { ReplaySkinImageAsset, ReplaySkinSettings } from "./replay-skin";

// 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function importedAsset(name: string, path: string): ReplaySkinImageAsset {
  return {
    name,
    path,
    src: `data:image/png;base64,${PNG_BASE64}`,
    width: 64,
    height: 32,
    scale: 2,
  };
}

function settingsWithAssets(): ReplaySkinSettings {
  return normalizeReplaySkinSettings({
    ...DEFAULT_REPLAY_SKIN_SETTINGS,
    style: "bars",
    keymodeProfiles: {
      4: {
        ...DEFAULT_REPLAY_SKIN_PROFILE,
        assets: {
          columns: [
            { tap: importedAsset("note1.png", "mania/note1.png"), receptor: importedAsset("key1.png", "mania/key1.png") },
            { tap: importedAsset("note2.png", "mania/note2.png") },
            {},
            {},
          ],
          judgements: { hit300: importedAsset("hit300.png", "hit300.png") },
          combo: null,
          stage: {
            ...EMPTY_REPLAY_SKIN_STAGE_ASSETS,
            hint: importedAsset("stage-hint.png", "mania-stage-hint.png"),
            scorebarColour: importedAsset("scorebar-colour.png", "scorebar-colour.png"),
          },
        },
      },
    },
  });
}

async function buildArchive(paths: string[]): Promise<Awaited<ReturnType<typeof openOskArchive>>> {
  const zip = new JSZip();
  const bytes = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
  for (const path of paths) zip.file(path, bytes);
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  return openOskArchive(buffer);
}

describe("owner replay skin dehydrate/rehydrate", () => {
  it("strips embedded data URLs down to paths and keeps everything else", () => {
    const payload = dehydrateReplaySkinSettings(settingsWithAssets()) as {
      v: number;
      settings: { style: string; keymodeProfiles: Record<string, { assets: { columns: Array<Record<string, { src: string; path: string }>>; judgements: Record<string, { src: string; path: string }>; stage: Record<string, { src?: string; path?: string }> } }> };
    };
    expect(payload.v).toBe(1);
    expect(payload.settings.style).toBe("bars");
    const assets = payload.settings.keymodeProfiles["4"].assets;
    expect(assets.columns[0].tap).toMatchObject({ src: "", path: "mania/note1.png", width: 64, height: 32, scale: 2 });
    expect(assets.columns[0].receptor.src).toBe("");
    expect(assets.judgements.hit300.path).toBe("hit300.png");
    expect(assets.stage.scorebarColour?.path).toBe("scorebar-colour.png");
    expect(JSON.stringify(payload)).not.toContain("data:image/");
  });

  it("drops embedded assets that carry no source path", () => {
    const settings = settingsWithAssets();
    const pathless = { ...importedAsset("orphan.png", ""), path: undefined };
    settings.keymodeProfiles["4"].assets.columns[1].lnHead = pathless;
    const payload = dehydrateReplaySkinSettings(settings) as {
      settings: { keymodeProfiles: Record<string, { assets: { columns: Array<Record<string, unknown>> } }> };
    };
    expect(payload.settings.keymodeProfiles["4"].assets.columns[1].lnHead).toBeUndefined();
  });

  it("rehydrates paths back into decodable assets and drops missing files", async () => {
    const payload = dehydrateReplaySkinSettings(settingsWithAssets());
    const archive = await buildArchive([
      "mania/note1.png",
      "mania/key1.png",
      "mania/note2.png",
      "mania-stage-hint.png",
      "scorebar-colour.png",
      // hit300.png deliberately missing from the rebuilt archive.
    ]);
    const settings = await rehydrateOwnerReplaySkinSettings(payload, archive);
    expect(settings).not.toBeNull();
    const profile = settings!.keymodeProfiles["4"];
    expect(profile.assets.columns[0].tap?.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(profile.assets.columns[0].tap?.path).toBe("mania/note1.png");
    expect(profile.assets.columns[1].tap?.src).toContain("base64");
    expect(profile.assets.stage.hint?.src).toContain("base64");
    expect(profile.assets.stage.scorebarColour?.name).toBe("scorebar-colour.png");
    // The missing file fell away instead of surviving as an empty src.
    expect(profile.assets.judgements.hit300).toBeUndefined();
  });

  it("decodes each archive path once and shares the result", async () => {
    const archive = await buildArchive(["mania/note1.png"]);
    const [first, second] = await Promise.all([
      loadOskImageAssetByPath(archive, "mania/note1.png"),
      loadOskImageAssetByPath(archive, "MANIA/NOTE1.PNG"),
    ]);
    expect(first).toBeDefined();
    // Same object, not just equal: rehydration references the same file once
    // per keymode/column, and re-decoding every reference stalls the page.
    expect(second).toBe(first);
  });

  it("rejects unknown payload shapes", async () => {
    const archive = await buildArchive([]);
    expect(await rehydrateOwnerReplaySkinSettings(null, archive)).toBeNull();
    expect(await rehydrateOwnerReplaySkinSettings({ v: 2, settings: {} }, archive)).toBeNull();
    expect(await rehydrateOwnerReplaySkinSettings({ v: 1, settings: "nope" }, archive)).toBeNull();
  });

  it("gates the import feature to admins and local dev", () => {
    expect(canUseReplaySkinImport(null)).toBe(false);
    expect(canUseReplaySkinImport({ ...ANONYMOUS_AUTH_STATE })).toBe(false);
    // A signed-in non-admin is still locked out.
    expect(canUseReplaySkinImport({
      ...ANONYMOUS_AUTH_STATE,
      viewer: { id: 7, username: "someone", avatarUrl: "", countryCode: "CR" },
    })).toBe(false);
    expect(canUseReplaySkinImport({ ...ANONYMOUS_AUTH_STATE, canUseAdminFeatures: true })).toBe(true);
  });

  it("detects embedded assets in settings", () => {
    expect(replaySkinSettingsEmbedAssets(settingsWithAssets())).toBe(true);
    expect(replaySkinSettingsEmbedAssets(normalizeReplaySkinSettings(DEFAULT_REPLAY_SKIN_SETTINGS))).toBe(false);
  });
});

describe("applied community replay skin pointer", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the pointer and clears it", () => {
    const skin = { id: "sk_9", name: "pl0x" } as SkinSummary;
    const payload = { v: 1, settings: { style: "bars" } };
    const written = writeAppliedCommunityReplaySkin({ skin, payload });
    expect(written).not.toBeNull();

    const read = readAppliedCommunityReplaySkin();
    expect(read?.skin.id).toBe("sk_9");
    expect(read?.payload).toEqual(payload);
    expect(appliedCommunityReplaySkinKey(read!)).toBe(appliedCommunityReplaySkinKey(written!));

    writeAppliedCommunityReplaySkin(null);
    expect(readAppliedCommunityReplaySkin()).toBeNull();
  });

  it("rejects malformed stored pointers", () => {
    window.localStorage.setItem("mania-hub-replay-skin-community-v1", JSON.stringify({ skin: {}, payload: {} }));
    expect(readAppliedCommunityReplaySkin()).toBeNull();
    window.localStorage.setItem("mania-hub-replay-skin-community-v1", "{nope");
    expect(readAppliedCommunityReplaySkin()).toBeNull();
  });
});
