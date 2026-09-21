// Offline hitsound mixing.
//
// The viewer fires a sound when its clock crosses a press; an export has to
// know every sound up front and place it at an exact output sample. The
// schedule itself comes from the renderer (`getHitsoundSchedule`), so sample
// precedence, layered-sample rules, combo-break logic, and stable/lazer
// differences are the viewer's, not a second implementation of them.
//
// A sound whose sample started before the clip begins is still audible inside
// it, so voices with a negative start frame are kept and mixed from the right
// offset rather than dropped.

import {
  COMBO_BREAK_SAMPLE_NAME,
  HITSOUND_MINIMUM_VOLUME,
  hitsoundChannelForKey,
  resolveHitsoundPlayKey,
  resolveHitsoundSampleKey,
  type HitsoundChannel,
} from "../../replay-hitsounds";
import type { ReplayHitsoundSchedule } from "../../replay-types";
import type { ReplayExportAudioSpec } from "../render-spec";
import type { ReplayExportTimeline } from "../timeline";
import { sourceMsToAudioFrame } from "../timeline";
import { decodeShortSample } from "./decode";

/** Matches the viewer's live polyphony cap so dense charts sound the same. */
export const MAX_CONCURRENT_VOICES = 48;
/** A stolen voice is faded out over this long rather than cut. */
const STEAL_FADE_SECONDS = 0.03;

export type HitsoundVoice = {
  /** Output PCM frame the sample starts at. Negative before the clip. */
  startFrame: number;
  /** Exclusive end frame after any polyphony truncation. */
  endFrame: number;
  /** Frame the steal fade begins at; equal to `endFrame` when not stolen. */
  fadeFromFrame: number;
  gain: number;
  data: Float32Array[];
};

type PendingVoice = {
  startFrame: number;
  gain: number;
  key: string;
};

function channelGain(channel: HitsoundChannel, spec: ReplayExportAudioSpec): number {
  return channel === "beatmap" ? spec.beatmapHitsoundVolume : spec.keypressHitsoundVolume;
}

/**
 * Resolves the schedule into concrete, gain-applied voices at output sample
 * positions. Returns the keys that could not be decoded so the caller can
 * report them instead of silently dropping the sound.
 */
export async function buildHitsoundVoices(options: {
  schedule: ReplayHitsoundSchedule;
  spec: ReplayExportAudioSpec;
  timeline: ReplayExportTimeline;
  samples: ReadonlyMap<string, ArrayBuffer>;
  /** Overridable so the mixer can be tested without an audio context. */
  decode?: (bytes: ArrayBuffer, sampleRate: number) => Promise<Float32Array[] | null>;
}): Promise<{ voices: HitsoundVoice[]; missingKeys: string[] }> {
  const { schedule, spec, timeline, samples, decode = decodeShortSample } = options;
  if (!spec.hitsoundsEnabled) return { voices: [], missingKeys: [] };

  const resolution = {
    useBeatmapSamples: spec.beatmapHitsounds,
    has: (key: string) => samples.has(key),
  };

  const pending: PendingVoice[] = [];

  for (const press of schedule.presses) {
    const startFrame = sourceMsToAudioFrame(timeline, press.timeMs);
    for (const play of press.plays) {
      const key = resolveHitsoundPlayKey(play, resolution);
      if (!key) continue;
      const channel = hitsoundChannelForKey(key);
      // "Key press hitsounds off" silences skin/default feedback while the
      // map's own samples keep playing, exactly as in the viewer.
      if (channel === "keypress" && !spec.keypressHitsounds) continue;
      const mappedVolume = Math.max(play.volume, HITSOUND_MINIMUM_VOLUME) / 100;
      pending.push({ startFrame, key, gain: mappedVolume * channelGain(channel, spec) });
    }
  }

  if (spec.comboBreakSound) {
    const key = resolveHitsoundSampleKey(COMBO_BREAK_SAMPLE_NAME, null, resolution);
    if (key) {
      // Combo break rides the key press channel volume: it is feedback, not
      // part of the map's sound design.
      const gain = channelGain("keypress", spec);
      for (const timeMs of schedule.comboBreakTimesMs) {
        pending.push({ startFrame: sourceMsToAudioFrame(timeline, timeMs), key, gain });
      }
    }
  }

  pending.sort((a, b) => a.startFrame - b.startFrame);

  const decoded = new Map<string, Float32Array[] | null>();
  const missingKeys: string[] = [];
  for (const key of new Set(pending.map((voice) => voice.key))) {
    const bytes = samples.get(key);
    const planes = bytes ? await decode(bytes, timeline.sampleRate) : null;
    decoded.set(key, planes);
    if (!planes) missingKeys.push(key);
  }

  const voices: HitsoundVoice[] = [];
  for (const entry of pending) {
    const data = decoded.get(entry.key);
    if (!data || data.length === 0) continue;
    const length = data[0].length;
    const endFrame = entry.startFrame + length;
    // Entirely before the clip, or entirely after it: nothing to mix.
    if (endFrame <= 0 || entry.startFrame >= timeline.totalAudioFrames) continue;
    voices.push({
      startFrame: entry.startFrame,
      endFrame,
      fadeFromFrame: endFrame,
      gain: entry.gain,
      data,
    });
  }

  applyPolyphonyLimit(voices, timeline.sampleRate);
  return { voices, missingKeys };
}

/**
 * Steals the oldest voice once the cap is reached, mirroring live playback:
 * dropping the *new* sound instead makes dense charts pulse audibly.
 */
function applyPolyphonyLimit(voices: HitsoundVoice[], sampleRate: number): void {
  const fadeFrames = Math.max(1, Math.round(STEAL_FADE_SECONDS * sampleRate));
  const active: HitsoundVoice[] = [];
  for (const voice of voices) {
    for (let index = active.length - 1; index >= 0; index--) {
      if (active[index].endFrame <= voice.startFrame) active.splice(index, 1);
    }
    while (active.length >= MAX_CONCURRENT_VOICES) {
      const oldest = active.shift();
      if (!oldest) break;
      const stopAt = voice.startFrame + fadeFrames;
      if (stopAt < oldest.endFrame) {
        oldest.fadeFromFrame = voice.startFrame;
        oldest.endFrame = stopAt;
      }
    }
    active.push(voice);
  }
}

/**
 * Adds every voice overlapping `[blockStart, blockEnd)` into `out`. Voices
 * are kept sorted, so each block advances one cursor and touches only the
 * sounds that are actually ringing.
 */
export class HitsoundMixer {
  private cursor = 0;
  private active: HitsoundVoice[] = [];

  constructor(private readonly voices: HitsoundVoice[]) {}

  get voiceCount(): number {
    return this.voices.length;
  }

  mix(out: Float32Array[], blockStart: number, blockEnd: number): void {
    while (this.cursor < this.voices.length && this.voices[this.cursor].startFrame < blockEnd) {
      this.active.push(this.voices[this.cursor]);
      this.cursor++;
    }
    for (let index = this.active.length - 1; index >= 0; index--) {
      if (this.active[index].endFrame <= blockStart) this.active.splice(index, 1);
    }

    for (const voice of this.active) {
      const from = Math.max(blockStart, voice.startFrame);
      const to = Math.min(blockEnd, voice.endFrame);
      if (to <= from) continue;
      const fadeSpan = voice.endFrame - voice.fadeFromFrame;
      for (let channel = 0; channel < out.length; channel++) {
        const plane = voice.data[Math.min(channel, voice.data.length - 1)];
        const target = out[channel];
        for (let frame = from; frame < to; frame++) {
          const offset = frame - voice.startFrame;
          const value = plane[offset];
          if (value === undefined) continue;
          let gain = voice.gain;
          if (fadeSpan > 0 && frame >= voice.fadeFromFrame) {
            gain *= 1 - (frame - voice.fadeFromFrame) / fadeSpan;
          }
          target[frame - blockStart] += value * gain;
        }
      }
    }
  }
}
