import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_REPLAY_OVERLAY_SETTINGS } from "../../replay-overlays";
import { DEFAULT_REPLAY_SKIN_SETTINGS } from "../../replay-skin";
import type { ReplayHitsoundSchedule } from "../../replay-types";
import type { ReplayExportSpecV1 } from "../render-spec";
import { createExportTimeline } from "../timeline";
import { ReplayExportAudioPipeline } from "./pipeline";
import * as songDecode from "./decode";
import { SlidingPcmWindow } from "./pcm-window";

afterEach(() => vi.restoreAllMocks());

// Song decoding needs WebCodecs, which Node does not have, so these cover the
// parts that do run here: block cursors, hitsound placement, and the refusal
// to call a musicless export successful when music was asked for.

function makeSpec(overrides: Partial<ReplayExportSpecV1["audio"]> = {}): ReplayExportSpecV1 {
  return {
    schemaVersion: 1,
    rendererRevision: "test",
    appVersion: "test",
    source: {
      scoreId: null,
      beatmapId: null,
      beatmapsetId: null,
      beatmapChecksum: null,
      uploadId: null,
      playerName: "p",
    },
    ruleset: {
      keyCount: 4,
      isConvert: false,
      isLazer: false,
      legacyReplayFrameRounding: true,
      od: 8,
      mods: [],
      modRate: 1,
      userSpeed: 1,
    },
    range: { startMs: 0, endMs: 2_000 },
    playback: { rate: 1, pitchPolicy: "follows-rate" },
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
      scrollSpeed: 20,
      showInputOverlay: false,
      inputOverlayOnly: false,
      inputOverlayColor: "#a855f7",
      inputOverlayKeyHistory: false,
      missThumbHand: "right",
      storyboardEnabled: false,
      leaderboardVisible: false,
      skinSettings: DEFAULT_REPLAY_SKIN_SETTINGS,
      overlaySettings: DEFAULT_REPLAY_OVERLAY_SETTINGS,
    },
    audio: {
      songEnabled: false,
      songVolume: 1,
      hitsoundsEnabled: true,
      beatmapHitsounds: true,
      beatmapHitsoundVolume: 1,
      keypressHitsounds: true,
      keypressHitsoundVolume: 1,
      comboBreakSound: false,
      ...overrides,
    },
    assets: [],
    locale: "en",
    filename: "out.mp4",
  };
}

const timeline = createExportTimeline({
  startMs: 0,
  endMs: 2_000,
  rate: 1,
  fps: 60,
  sampleRate: 48_000,
});

const emptySchedule: ReplayHitsoundSchedule = { presses: [], comboBreakTimesMs: [] };

async function drain(pipeline: ReplayExportAudioPipeline) {
  const blocks = [];
  for (;;) {
    const block = await pipeline.next();
    if (!block) break;
    blocks.push(block);
  }
  return blocks;
}

describe("ReplayExportAudioPipeline", () => {
  it.each([0.75, 1.5])("bounds both PCM windows throughout a pitch-preserved %sx export", async (rate) => {
    const sampleRate = 8000;
    const outputSeconds = 60;
    const sourceFrames = Math.ceil(outputSeconds * rate * sampleRate) + 4096;
    let cursor = 0;
    const sourceWindow = new SlidingPcmWindow(2, async () => {
      if (cursor >= sourceFrames) return null;
      const startFrame = cursor;
      cursor += 4096;
      return { startFrame, data: [new Float32Array(4096).fill(0.25), new Float32Array(4096).fill(0.125)] };
    });
    vi.spyOn(songDecode, "openSongPcmSource").mockResolvedValue({
      window: sourceWindow, sampleRate, channels: 2, startFrame: 0, estimatedBytes: 0,
      close: async () => sourceWindow.release(),
    });
    const windows = new Set<SlidingPcmWindow>();
    const ensure = SlidingPcmWindow.prototype.ensure;
    vi.spyOn(SlidingPcmWindow.prototype, "ensure").mockImplementation(async function (this: SlidingPcmWindow, until) {
      windows.add(this);
      await ensure.call(this, until);
    });
    const spec = makeSpec({ songEnabled: true, hitsoundsEnabled: false });
    spec.output.sampleRate = sampleRate;
    spec.playback = { rate, pitchPolicy: "preserved" };
    const pipeline = await ReplayExportAudioPipeline.create({
      spec,
      timeline: createExportTimeline({ startMs: 0, endMs: outputSeconds * rate * 1000, rate, fps: 60, sampleRate }),
      songFile: new Blob(), schedule: emptySchedule, samples: new Map(), memoryBudgetBytes: 1 << 28,
    });
    let frames = 0;
    try {
      for (;;) {
        const block = await pipeline.next();
        if (!block) break;
        frames += block.length;
        expect(block.data[0][block.length - 1]).toBeCloseTo(0.25, 5);
        expect(block.data[1][block.length - 1]).toBeCloseTo(0.125, 5);
        for (const window of windows) expect(window.bufferedFrames).toBeLessThanOrEqual(8192);
      }
      expect(windows.size).toBe(2);
      expect(frames).toBe(outputSeconds * sampleRate);
    } finally {
      await pipeline.close();
    }
    for (const window of windows) expect(window.bufferedFrames).toBe(0);
  });

  it("covers the whole output timeline with one continuous cursor", async () => {
    const pipeline = await ReplayExportAudioPipeline.create({
      spec: makeSpec(),
      timeline,
      songFile: null,
      schedule: emptySchedule,
      samples: new Map(),
      memoryBudgetBytes: 1 << 28,
    });
    const blocks = await drain(pipeline);
    expect(blocks[0].startFrame).toBe(0);
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].startFrame).toBe(blocks[i - 1].startFrame + blocks[i - 1].length);
    }
    const total = blocks.reduce((sum, block) => sum + block.length, 0);
    expect(total).toBe(timeline.totalAudioFrames);
    await pipeline.close();
  });

  it("emits stereo planes at the output channel count", async () => {
    const pipeline = await ReplayExportAudioPipeline.create({
      spec: makeSpec(),
      timeline,
      songFile: null,
      schedule: emptySchedule,
      samples: new Map(),
      memoryBudgetBytes: 1 << 28,
    });
    const block = await pipeline.next();
    expect(block?.data).toHaveLength(2);
    expect(block?.data[0].length).toBe(block?.length);
    await pipeline.close();
  });

  it("refuses a music export with no song file instead of shipping silence", async () => {
    await expect(ReplayExportAudioPipeline.create({
      spec: makeSpec({ songEnabled: true }),
      timeline,
      songFile: null,
      schedule: emptySchedule,
      samples: new Map(),
      memoryBudgetBytes: 1 << 28,
    })).rejects.toMatchObject({ code: "asset_load_failed" });
  });

  it("flags hitsound samples it could not decode", async () => {
    const pipeline = await ReplayExportAudioPipeline.create({
      spec: makeSpec(),
      timeline,
      songFile: null,
      schedule: {
        presses: [{
          timeMs: 500,
          plays: [{ name: "hitnormal", bank: "normal", index: 0, volume: 100 }],
        }],
        comboBreakTimesMs: [],
      },
      // Present but undecodable here: Node has no OfflineAudioContext.
      samples: new Map([["default:normal-hitnormal", new ArrayBuffer(8)]]),
      memoryBudgetBytes: 1 << 28,
    });
    expect(pipeline.warnings).toContain("hitsound-samples-missing");
    await pipeline.close();
  });

  it("is silent when nothing is enabled, rather than undefined", async () => {
    const pipeline = await ReplayExportAudioPipeline.create({
      spec: makeSpec({ hitsoundsEnabled: false }),
      timeline,
      songFile: null,
      schedule: emptySchedule,
      samples: new Map(),
      memoryBudgetBytes: 1 << 28,
    });
    const block = await pipeline.next();
    expect(block?.data[0].every((value) => value === 0)).toBe(true);
    await pipeline.close();
  });

  it("stops handing out blocks once it is closed", async () => {
    const pipeline = await ReplayExportAudioPipeline.create({
      spec: makeSpec(),
      timeline,
      songFile: null,
      schedule: emptySchedule,
      samples: new Map(),
      memoryBudgetBytes: 1 << 28,
    });
    await pipeline.close();
    expect(await pipeline.next()).toBeNull();
  });
});
