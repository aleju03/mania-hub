import { describe, expect, it } from "vitest";

import type { ReplayHitsoundSchedule } from "../../replay-types";
import type { ReplayExportAudioSpec } from "../render-spec";
import { createExportTimeline } from "../timeline";
import { HitsoundMixer, MAX_CONCURRENT_VOICES, buildHitsoundVoices } from "./hitsounds";

const timeline = createExportTimeline({
  startMs: 1_000,
  endMs: 11_000,
  rate: 1,
  fps: 60,
  sampleRate: 48_000,
});

const audioSpec: ReplayExportAudioSpec = {
  songEnabled: false,
  songVolume: 1,
  hitsoundsEnabled: true,
  beatmapHitsounds: true,
  beatmapHitsoundVolume: 0.5,
  keypressHitsounds: true,
  keypressHitsoundVolume: 0.25,
  comboBreakSound: true,
};

/** A DC sample: every frame is 1, so gain and placement read directly. */
function flatSample(frames: number): Float32Array[] {
  return [new Float32Array(frames).fill(1), new Float32Array(frames).fill(1)];
}

function decoder(frames = 480) {
  return async () => flatSample(frames);
}

function press(timeMs: number, overrides: Partial<{ volume: number; filename: string; bank: "normal" | "soft" | "drum" }> = {}) {
  return {
    timeMs,
    plays: [{
      name: "hitnormal" as const,
      bank: overrides.bank ?? ("normal" as const),
      index: 0,
      volume: overrides.volume ?? 100,
      ...(overrides.filename ? { filename: overrides.filename } : {}),
    }],
  };
}

const samples = new Map<string, ArrayBuffer>([
  ["default:normal-hitnormal", new ArrayBuffer(8)],
  ["default:combobreak", new ArrayBuffer(8)],
  ["skin:normal-hitnormal", new ArrayBuffer(8)],
  ["beatmap:keysound", new ArrayBuffer(8)],
]);

async function build(schedule: ReplayHitsoundSchedule, spec = audioSpec, frames = 480) {
  return buildHitsoundVoices({ schedule, spec, timeline, samples, decode: decoder(frames) });
}

describe("buildHitsoundVoices", () => {
  it("places a press at its exact output sample, not at a frame boundary", async () => {
    const { voices } = await build({ presses: [press(1_500.5)], comboBreakTimesMs: [] });
    expect(voices).toHaveLength(1);
    // 500.5 ms after the clip start, at 48 kHz.
    expect(voices[0].startFrame).toBe(24_024);
  });

  it("keeps a sample that started before the clip and still rings inside it", async () => {
    const { voices } = await build({ presses: [press(995)], comboBreakTimesMs: [] });
    expect(voices).toHaveLength(1);
    expect(voices[0].startFrame).toBeLessThan(0);
    expect(voices[0].endFrame).toBeGreaterThan(0);
  });

  it("drops a sample that finished before the clip started", async () => {
    const { voices } = await build({ presses: [press(900)], comboBreakTimesMs: [] });
    expect(voices).toHaveLength(0);
  });

  it("drops a press past the end of the clip", async () => {
    const { voices } = await build({ presses: [press(11_500)], comboBreakTimesMs: [] });
    expect(voices).toHaveLength(0);
  });

  it("applies the mapped sample volume and the channel gain", async () => {
    const { voices } = await build({ presses: [press(2_000, { volume: 80 })], comboBreakTimesMs: [] });
    // Skin/default samples ride the key press channel.
    expect(voices[0].gain).toBeCloseTo(0.8 * 0.25, 6);
  });

  it("floors a silent sample at osu!'s minimum volume", async () => {
    const { voices } = await build({ presses: [press(2_000, { volume: 0 })], comboBreakTimesMs: [] });
    expect(voices[0].gain).toBeCloseTo(0.05 * 0.25, 6);
  });

  it("routes a beatmap keysound through the beatmap channel", async () => {
    const { voices } = await build({
      presses: [press(2_000, { filename: "keysound.wav" })],
      comboBreakTimesMs: [],
    });
    expect(voices[0].gain).toBeCloseTo(1 * 0.5, 6);
  });

  it("silences key press feedback without silencing the map's own samples", async () => {
    const spec = { ...audioSpec, keypressHitsounds: false };
    const { voices } = await build({
      presses: [press(2_000), press(2_100, { filename: "keysound.wav" })],
      comboBreakTimesMs: [],
    }, spec);
    expect(voices).toHaveLength(1);
    expect(voices[0].gain).toBeCloseTo(0.5, 6);
  });

  it("emits combo breaks only when their toggle is on", async () => {
    const withBreaks = await build({ presses: [], comboBreakTimesMs: [2_000, 4_000] });
    expect(withBreaks.voices).toHaveLength(2);
    const without = await build({ presses: [], comboBreakTimesMs: [2_000] }, { ...audioSpec, comboBreakSound: false });
    expect(without.voices).toHaveLength(0);
  });

  it("produces nothing at all when hitsounds are off", async () => {
    const { voices } = await build({ presses: [press(2_000)], comboBreakTimesMs: [1_500] }, {
      ...audioSpec,
      hitsoundsEnabled: false,
    });
    expect(voices).toHaveLength(0);
  });

  it("reports samples it could not decode instead of dropping them quietly", async () => {
    const result = await buildHitsoundVoices({
      schedule: { presses: [press(2_000)], comboBreakTimesMs: [] },
      spec: audioSpec,
      timeline,
      samples,
      decode: async () => null,
    });
    expect(result.voices).toHaveLength(0);
    // The skin copy outranks the bundled default, so that is the key that fails.
    expect(result.missingKeys).toContain("skin:normal-hitnormal");
  });

  it("steals the oldest voice at the polyphony cap rather than dropping the new one", async () => {
    // Long samples so nothing ends naturally, all stacked inside one second.
    const presses = Array.from({ length: MAX_CONCURRENT_VOICES + 4 }, (_, i) => press(2_000 + i));
    const { voices } = await build({ presses, comboBreakTimesMs: [] }, audioSpec, 48_000);
    expect(voices).toHaveLength(MAX_CONCURRENT_VOICES + 4);
    // The first four were cut short; the newest ones play out in full.
    expect(voices[0].endFrame).toBeLessThan(voices[0].startFrame + 48_000);
    expect(voices.at(-1)?.endFrame).toBe((voices.at(-1)?.startFrame ?? 0) + 48_000);
  });
});

describe("HitsoundMixer", () => {
  it("adds a voice into the block it overlaps", async () => {
    const { voices } = await build({ presses: [press(1_100)], comboBreakTimesMs: [] });
    const mixer = new HitsoundMixer(voices);
    const out = [new Float32Array(48_000), new Float32Array(48_000)];
    mixer.mix(out, 0, 48_000);
    const start = voices[0].startFrame;
    expect(out[0][start - 1]).toBe(0);
    expect(out[0][start]).toBeCloseTo(voices[0].gain, 6);
    expect(out[0][start + 479]).toBeCloseTo(voices[0].gain, 6);
    expect(out[0][start + 480]).toBe(0);
  });

  it("carries a voice across a block boundary without a gap", async () => {
    const { voices } = await build({ presses: [press(1_000 + (47_900 / 48))], comboBreakTimesMs: [] }, audioSpec, 480);
    const mixer = new HitsoundMixer(voices);
    const first = [new Float32Array(48_000), new Float32Array(48_000)];
    mixer.mix(first, 0, 48_000);
    const second = [new Float32Array(48_000), new Float32Array(48_000)];
    mixer.mix(second, 48_000, 96_000);
    expect(first[0][47_999]).toBeCloseTo(voices[0].gain, 6);
    expect(second[0][0]).toBeCloseTo(voices[0].gain, 6);
  });

  it("mixes the part of a pre-clip tail that falls inside the clip", async () => {
    const { voices } = await build({ presses: [press(995)], comboBreakTimesMs: [] });
    const mixer = new HitsoundMixer(voices);
    const out = [new Float32Array(1_000), new Float32Array(1_000)];
    mixer.mix(out, 0, 1_000);
    expect(out[0][0]).toBeCloseTo(voices[0].gain, 6);
    expect(out[0][voices[0].endFrame]).toBe(0);
  });
});
