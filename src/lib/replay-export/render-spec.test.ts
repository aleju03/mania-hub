import { describe, expect, it } from "vitest";

import { DEFAULT_REPLAY_OVERLAY_SETTINGS } from "../replay-overlays";
import { DEFAULT_REPLAY_SKIN_SETTINGS } from "../replay-skin";
import {
  REPLAY_EXPORT_RENDERER_REVISION,
  canonicalReplayExportSpecJson,
  cloneReplayExportSpec,
  parseReplayExportSpec,
  type ReplayExportSpecV1,
} from "./render-spec";

function makeSpec(): ReplayExportSpecV1 {
  return {
    schemaVersion: 1,
    rendererRevision: REPLAY_EXPORT_RENDERER_REVISION,
    appVersion: "v2.176",
    source: {
      scoreId: 4242,
      beatmapId: 99,
      beatmapsetId: 7,
      beatmapChecksum: "abc",
      uploadId: null,
      playerName: "someone",
    },
    ruleset: {
      keyCount: 4,
      isConvert: false,
      isLazer: true,
      legacyReplayFrameRounding: false,
      od: 8,
      mods: [{ acronym: "DT", settings: { speed_change: 1.4 } }, { acronym: "HD" }],
      modRate: 1.4,
      userSpeed: 1,
    },
    range: { startMs: 1000, endMs: 31_000 },
    playback: { rate: 1.4, pitchPolicy: "preserved" },
    output: {
      container: "mp4",
      width: 1280,
      height: 720,
      fps: 60,
      videoCodec: "avc",
      videoBitrate: 6_000_000,
      audioCodec: "aac",
      audioBitrate: 128_000,
      sampleRate: 48_000,
      channels: 2,
    },
    visual: {
      bgDim: 70,
      blackPlayfield: false,
      scrollSpeed: 22,
      showInputOverlay: true,
      inputOverlayOnly: false,
      inputOverlayColor: "#a855f7",
      inputOverlayKeyHistory: true,
      missThumbHand: "right",
      storyboardEnabled: false,
      leaderboardVisible: true,
      skinSettings: DEFAULT_REPLAY_SKIN_SETTINGS,
      overlaySettings: DEFAULT_REPLAY_OVERLAY_SETTINGS,
    },
    audio: {
      songEnabled: true,
      songVolume: 0.5,
      hitsoundsEnabled: true,
      beatmapHitsounds: true,
      beatmapHitsoundVolume: 0.5,
      keypressHitsounds: true,
      keypressHitsoundVolume: 0.4,
      comboBreakSound: true,
    },
    assets: [
      { role: "replay", id: "score:4242" },
      { role: "beatmap", id: "md5:abc" },
      { role: "song", id: "song:score:4242" },
    ],
    locale: "en",
    filename: "someone-map-diff-4242.mp4",
  };
}

describe("replay export spec", () => {
  it("survives a JSON round trip unchanged", () => {
    const spec = makeSpec();
    const parsed = parseReplayExportSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed).toEqual(spec);
    expect(cloneReplayExportSpec(spec)).toEqual(spec);
  });

  it("keeps mod settings rather than flattening to acronyms", () => {
    const parsed = cloneReplayExportSpec(makeSpec());
    expect(parsed.ruleset.mods[0]).toEqual({ acronym: "DT", settings: { speed_change: 1.4 } });
  });

  it("refuses a locator where an asset identity belongs", () => {
    const spec = makeSpec() as unknown as Record<string, unknown>;
    spec.assets = [{ role: "song", id: "blob:https://mania-tracker.com/abc" }];
    expect(() => parseReplayExportSpec(spec)).toThrow(/locator/);
  });

  it("refuses an unknown schema version", () => {
    const spec = { ...makeSpec(), schemaVersion: 2 };
    expect(() => parseReplayExportSpec(spec)).toThrow(/schemaVersion/);
  });

  it("refuses a loosely typed settings bag on a mod", () => {
    const spec = makeSpec() as unknown as { ruleset: { mods: unknown[] } };
    spec.ruleset.mods = [{ acronym: "DT", settings: { callback: { nested: true } } }];
    expect(() => parseReplayExportSpec(spec)).toThrow(/settings/);
  });

  it("refuses a range that does not move forward", () => {
    const spec = makeSpec();
    spec.range = { startMs: 5, endMs: 5 };
    expect(() => parseReplayExportSpec(spec)).toThrow(/range.endMs/);
  });

  it("hashes independently of key order and of the build label", () => {
    const spec = makeSpec();
    const reordered = JSON.parse(JSON.stringify({
      ...spec,
      appVersion: "v9.999",
      audio: Object.fromEntries(Object.entries(spec.audio).reverse()),
    })) as ReplayExportSpecV1;
    expect(canonicalReplayExportSpecJson(parseReplayExportSpec(reordered)))
      .toBe(canonicalReplayExportSpecJson(spec));
  });

  it("changes its hash when something output-affecting changes", () => {
    const spec = makeSpec();
    const other = { ...spec, output: { ...spec.output, fps: 30 } };
    expect(canonicalReplayExportSpecJson(other)).not.toBe(canonicalReplayExportSpecJson(spec));
  });

  it("pins an exact renderer revision rather than a moving label", () => {
    expect(REPLAY_EXPORT_RENDERER_REVISION).not.toMatch(/latest/i);
    expect(canonicalReplayExportSpecJson(makeSpec())).toContain(REPLAY_EXPORT_RENDERER_REVISION);
  });

  it("validates viewport dimensions and includes them in rendering identity", () => {
    const spec = makeSpec();
    spec.visual.viewport = { width: 2040, height: 930, fullscreen: false, fullHeight: false, coarsePointer: false };
    const other = structuredClone(spec);
    other.visual.viewport!.height = 1080;
    expect(canonicalReplayExportSpecJson(other)).not.toBe(canonicalReplayExportSpecJson(spec));
    for (const invalid of [0, -1, NaN, Infinity]) {
      other.visual.viewport!.height = invalid;
      expect(() => parseReplayExportSpec(other)).toThrow(/viewport/);
    }
  });

  it("pins the AV1 quality setting in the serialized intent", () => {
    const spec = makeSpec();
    spec.output.videoCodec = "av1";
    spec.output.videoQuantizer = 96;
    const parsed = parseReplayExportSpec(spec);
    expect(parsed.output.videoQuantizer).toBe(96);
    const changed = { ...parsed, output: { ...parsed.output, videoQuantizer: 112 } };
    expect(canonicalReplayExportSpecJson(changed)).not.toBe(canonicalReplayExportSpecJson(parsed));
    for (const invalid of [-1, 256, 1.5, NaN]) {
      expect(() => parseReplayExportSpec({ ...spec, output: { ...spec.output, videoQuantizer: invalid } })).toThrow(/videoQuantizer/);
    }
    expect(() => parseReplayExportSpec({ ...spec, output: { ...spec.output, videoCodec: "avc" } })).toThrow(/videoQuantizer/);
  });
});
