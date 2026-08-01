// Hitsound playback for the mania replay viewer.
//
// Mirrors osu!(lazer)'s gameplay sample semantics:
// - Every key press plays the samples of the column's "most valid" object
//   (the earliest not-yet-judged note, gated to twice the miss window before
//   its start time), whether or not the press actually hit something.
// - A miss itself is silent; the only miss feedback is the combo break
//   sample, which fires when combo drops to 0 from more than 20 (plus always
//   on the first break of the play), so stacked misses produce one sound.
// - Mania-native maps mute "layered" hitnormals (additions present without
//   the Normal bit); converts play them.
// - Sample resolution order: beatmap folder (keysounds / custom sample index
//   >= 1, when beatmap hitsounds are enabled) -> skin -> bundled defaults.

import type { ManiaNoteSample, ManiaSampleBank } from "./beatmap-parser";

export type HitsoundSampleName = "hitnormal" | "hitwhistle" | "hitfinish" | "hitclap";

export interface HitsoundSamplePlay {
  name: HitsoundSampleName;
  bank: ManiaSampleBank;
  index: number;
  volume: number; // 0-100 mapped volume
  filename?: string; // keysound file inside the beatmap folder, replaces the bank lookup
}

export interface HitsoundAnchor {
  time: number; // hitobject start time, used for the proximity gate
  judgedTime: number; // when this anchor stops being the press target
  plays: HitsoundSamplePlay[];
}

export interface ReplayHitsoundTrigger {
  playSamples(plays: HitsoundSamplePlay[]): void;
  playComboBreak(): void;
}

interface AnchorSourceNote {
  column: number;
  time: number;
  endTime: number;
  isHold: boolean;
  sample?: ManiaNoteSample;
}

interface AnchorSourceNoteState {
  headTime: number;
  releaseTime: number;
  tailTime: number | null;
}

// osu! floors mapped sample volume at 5% so fully silent hitsounds still tick.
export const HITSOUND_MINIMUM_VOLUME = 5;
// combobreak plays when combo drops to 0 from strictly more than this.
export const COMBO_BREAK_MIN_COMBO = 20;

const FALLBACK_SAMPLE: ManiaNoteSample = {
  bank: "normal",
  additionBank: "normal",
  index: 0,
  volume: 100,
  additions: 0,
  normalIsLayered: false,
};

export function getNoteSamplePlays(sample: ManiaNoteSample | undefined, isConvert: boolean): HitsoundSamplePlay[] {
  const resolved = sample ?? FALLBACK_SAMPLE;
  const plays: HitsoundSamplePlay[] = [];

  if (resolved.filename) {
    plays.push({
      name: "hitnormal",
      bank: resolved.bank,
      index: Math.max(1, resolved.index),
      volume: resolved.volume,
      filename: resolved.filename,
    });
  } else if (!resolved.normalIsLayered || isConvert) {
    plays.push({ name: "hitnormal", bank: resolved.bank, index: resolved.index, volume: resolved.volume });
  }

  if (resolved.additions & 2) plays.push({ name: "hitwhistle", bank: resolved.additionBank, index: resolved.index, volume: resolved.volume });
  if (resolved.additions & 4) plays.push({ name: "hitfinish", bank: resolved.additionBank, index: resolved.index, volume: resolved.volume });
  if (resolved.additions & 8) plays.push({ name: "hitclap", bank: resolved.additionBank, index: resolved.index, volume: resolved.volume });

  return plays;
}

export function buildHitsoundAnchorsByColumn(
  notes: AnchorSourceNote[],
  noteStates: ArrayLike<AnchorSourceNoteState | undefined> | null,
  keyCount: number,
  missWindow: number,
  isConvert: boolean,
): HitsoundAnchor[][] {
  const columns: HitsoundAnchor[][] = Array.from({ length: keyCount }, () => []);

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (note.column < 0 || note.column >= keyCount) continue;
    const state = noteStates?.[i];

    const headJudgedTime = state && Number.isFinite(state.headTime)
      ? state.headTime
      : note.time + missWindow;
    const anchors = columns[note.column];
    anchors.push({ time: note.time, judgedTime: headJudgedTime, plays: getNoteSamplePlays(note.sample, isConvert) });

    if (note.isHold) {
      // While a hold is in flight (head judged, tail pending), ghost presses
      // target the tail, which carries no samples in mania-native maps.
      const tailCandidates = [state?.tailTime, state?.releaseTime, note.endTime + missWindow * 1.5]
        .filter((value): value is number => value != null && Number.isFinite(value));
      const tailJudgedTime = Math.max(headJudgedTime, ...tailCandidates);
      anchors.push({ time: note.time, judgedTime: tailJudgedTime, plays: [] });
    }
  }

  for (const anchors of columns) {
    anchors.sort((a, b) => a.judgedTime - b.judgedTime || a.time - b.time);
  }
  return columns;
}

export function selectHitsoundAnchor(
  anchors: HitsoundAnchor[],
  pressTime: number,
  missWindow: number,
): HitsoundAnchor | null {
  if (anchors.length === 0) return null;

  // First anchor that hasn't been judged by the press time.
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].judgedTime < pressTime) lo = mid + 1;
    else hi = mid;
  }

  // Past the last object: keep replaying the final note's sound.
  if (lo >= anchors.length) return anchors[anchors.length - 1];

  const candidate = anchors[lo];
  // Only switch to an upcoming note once the press is within twice the miss
  // window of its start; otherwise stay on the previous (just judged) note.
  if (candidate.time - missWindow * 2 > pressTime && lo > 0) return anchors[lo - 1];
  return candidate;
}

export function buildComboBreakSoundTimes(
  comboEvents: ReadonlyArray<{ kind: "break" | "hit"; time: number }>,
  initialCombo = 0,
): number[] {
  const times: number[] = [];
  let combo = Math.max(0, initialCombo);
  let firstBreakPlayed = false;

  for (const event of comboEvents) {
    if (event.kind === "hit") {
      combo++;
      continue;
    }
    // Combo already at 0: no change, no sound (stacked misses stay silent).
    if (combo === 0) continue;
    if (combo > COMBO_BREAK_MIN_COMBO || !firstBreakPlayed) times.push(event.time);
    firstBreakPlayed = true;
    combo = 0;
  }

  return times;
}

export interface HitsoundSampleData {
  data: ArrayBuffer;
}

export type HitsoundSampleSource = "beatmap" | "skin" | "default";

const DEFAULT_SAMPLE_FILES = [
  "normal-hitnormal.wav",
  "normal-hitwhistle.wav",
  "normal-hitfinish.wav",
  "normal-hitclap.wav",
  "soft-hitnormal.wav",
  "soft-hitwhistle.wav",
  "soft-hitfinish.wav",
  "soft-hitclap.wav",
  "drum-hitnormal.wav",
  "drum-hitwhistle.wav",
  "drum-hitfinish.wav",
  "drum-hitclap.wav",
  "combobreak.mp3",
];
const DEFAULT_SAMPLE_BUNDLE_URL = "/assets/replay-default-hitsounds-v1.zip";

// Polyphony cap. The default samples carry long reverb tails (~0.8-1.2s), so
// dense chords keep many voices alive at once; hitting the cap steals the
// oldest (quietest) voice rather than dropping the new sound.
const MAX_CONCURRENT_SOURCES = 48;

function normalizeSampleKey(name: string): string {
  return name
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/\.(wav|ogg|mp3|flac|m4a)$/, "");
}

function sampleBaseName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

interface ActiveVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

// Two independent output channels: samples resolved from the beatmap folder
// (keysounds, custom banks) vs press feedback from the skin/default samples.
export type HitsoundChannel = "beatmap" | "keypress";

export class ReplayHitsoundPlayer {
  private context: AudioContext | null = null;
  private channelGains: Record<HitsoundChannel, GainNode> | null = null;
  private raw = new Map<string, ArrayBuffer>();
  private decoded = new Map<string, AudioBuffer | null>();
  private decoding = new Set<string>();
  private activeVoices: ActiveVoice[] = [];
  private enabled = true;
  private muted = false;
  private comboBreakEnabled = true;
  private useBeatmapSamples = true;
  private keypressSoundsEnabled = true;
  private channelVolumes: Record<HitsoundChannel, number> = { beatmap: 0.5, keypress: 0.5 };
  private defaultsLoaded: Promise<void> | null = null;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // Follows the transport mute so silencing the player silences hitsounds too.
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setComboBreakEnabled(enabled: boolean): void {
    this.comboBreakEnabled = enabled;
  }

  setUseBeatmapSamples(use: boolean): void {
    this.useBeatmapSamples = use;
  }

  setKeypressSoundsEnabled(enabled: boolean): void {
    this.keypressSoundsEnabled = enabled;
  }

  setChannelVolume(channel: HitsoundChannel, volume: number): void {
    this.channelVolumes[channel] = Math.max(0, Math.min(1, volume));
    if (this.channelGains) this.channelGains[channel].gain.value = this.channelVolumes[channel];
  }

  loadDefaultSamples(): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve();
    if (!this.defaultsLoaded) {
      this.defaultsLoaded = this.loadDefaultSampleBundle()
        // Deployment skew or an old cached frontend must not make hitsounds
        // disappear. The individual files are a failure-only fallback.
        .catch(() => this.loadDefaultSampleFiles())
        .then(() => {
          this.decodeAllLoaded();
        });
    }
    return this.defaultsLoaded;
  }

  private async loadDefaultSampleBundle(): Promise<void> {
    const response = await fetch(DEFAULT_SAMPLE_BUNDLE_URL);
    if (!response.ok) throw new Error(`Default hitsound bundle failed (${response.status})`);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const samples = await Promise.all(DEFAULT_SAMPLE_FILES.map(async (file) => {
      const entry = zip.file(file);
      if (!entry) throw new Error(`Default hitsound bundle is missing ${file}`);
      return [file, await entry.async("arraybuffer")] as const;
    }));
    for (const [file, data] of samples) this.addSample("default", file, data);
  }

  private async loadDefaultSampleFiles(): Promise<void> {
    await Promise.all(DEFAULT_SAMPLE_FILES.map(async (file) => {
      try {
        const response = await fetch(`/audio/hitsounds/${file}`);
        if (!response.ok) return;
        this.addSample("default", file, await response.arrayBuffer());
      } catch {
        // Missing defaults degrade to silence for that sample.
      }
    }));
  }

  setSkinSamples(samples: ReadonlyMap<string, ArrayBuffer> | null): void {
    this.removeSource("skin");
    if (samples) {
      for (const [name, data] of samples) this.addSample("skin", name, data);
    }
    this.decodeAllLoaded();
  }

  setBeatmapSamples(samples: ReadonlyMap<string, ArrayBuffer> | null): void {
    this.removeSource("beatmap");
    if (samples) {
      for (const [name, data] of samples) this.addSample("beatmap", name, data);
      // Also register basename aliases so keysound references resolve when the
      // archive nests files in a folder the .osu path doesn't mention.
      for (const [name, data] of samples) {
        const base = sampleBaseName(normalizeSampleKey(name));
        if (!this.raw.has(`beatmap:${base}`)) this.addSample("beatmap", base, data);
      }
    }
    this.decodeAllLoaded();
  }

  // Must be called from a user gesture so the AudioContext is allowed to run.
  resume(): void {
    const context = this.ensureContext();
    if (context && context.state === "suspended") {
      void context.resume().catch(() => {});
    }
    this.decodeAllLoaded();
  }

  playSamples(plays: HitsoundSamplePlay[]): void {
    if (!this.enabled || this.muted || plays.length === 0) return;
    for (const play of plays) {
      const key = this.resolvePlayKey(play);
      if (!key) continue;
      const channel: HitsoundChannel = key.startsWith("beatmap:") ? "beatmap" : "keypress";
      // "Key press hitsounds off" silences skin/default feedback while the
      // map's own samples keep playing.
      if (channel === "keypress" && !this.keypressSoundsEnabled) continue;
      const mappedVolume = Math.max(play.volume, HITSOUND_MINIMUM_VOLUME) / 100;
      this.playBuffer(key, mappedVolume, channel);
    }
  }

  playComboBreak(): void {
    if (!this.enabled || this.muted || !this.comboBreakEnabled) return;
    const key = this.resolveSampleKey("combobreak", null);
    // Gated only by its own toggle, but it rides the key press channel volume
    // since it is feedback, not part of the map's sound design.
    if (key) this.playBuffer(key, 1, "keypress");
  }

  destroy(): void {
    this.raw.clear();
    this.decoded.clear();
    this.decoding.clear();
    this.activeVoices = [];
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
      this.channelGains = null;
    }
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.context) {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.context = new Ctor({ latencyHint: "interactive" });
      const makeChannel = (volume: number) => {
        const gain = this.context!.createGain();
        gain.gain.value = volume;
        gain.connect(this.context!.destination);
        return gain;
      };
      this.channelGains = {
        beatmap: makeChannel(this.channelVolumes.beatmap),
        keypress: makeChannel(this.channelVolumes.keypress),
      };
    }
    return this.context;
  }

  private addSample(source: HitsoundSampleSource, name: string, data: ArrayBuffer): void {
    const key = `${source}:${normalizeSampleKey(name)}`;
    this.raw.set(key, data);
    this.decoded.delete(key);
  }

  private removeSource(source: HitsoundSampleSource): void {
    const prefix = `${source}:`;
    for (const key of [...this.raw.keys()]) {
      if (key.startsWith(prefix)) this.raw.delete(key);
    }
    for (const key of [...this.decoded.keys()]) {
      if (key.startsWith(prefix)) this.decoded.delete(key);
    }
  }

  private decodeAllLoaded(): void {
    const context = this.context;
    if (!context) return;
    for (const key of this.raw.keys()) {
      if (this.decoded.has(key) || this.decoding.has(key)) continue;
      this.decoding.add(key);
      const data = this.raw.get(key);
      if (!data) {
        this.decoding.delete(key);
        continue;
      }
      // decodeAudioData detaches the buffer, so decode a copy in case the
      // same ArrayBuffer instance is ever re-registered.
      context.decodeAudioData(data.slice(0)).then(
        (buffer) => {
          this.decoded.set(key, buffer);
          this.decoding.delete(key);
        },
        () => {
          this.decoded.set(key, null);
          this.decoding.delete(key);
        },
      );
    }
  }

  private hasSample(key: string): boolean {
    return this.raw.has(key);
  }

  private resolvePlayKey(play: HitsoundSamplePlay): string | null {
    if (play.filename && this.useBeatmapSamples) {
      const normalized = normalizeSampleKey(play.filename);
      const candidates = [`beatmap:${normalized}`, `beatmap:${sampleBaseName(normalized)}`];
      for (const key of candidates) {
        if (this.hasSample(key)) return key;
      }
      // Keysound file is missing: fall back to the bank hitnormal.
    }
    return this.resolveSampleKey(`${play.bank}-${play.name}`, play);
  }

  private resolveSampleKey(bankedName: string, play: HitsoundSamplePlay | null): string | null {
    const candidates: string[] = [];
    if (play && this.useBeatmapSamples && play.index >= 2) candidates.push(`beatmap:${bankedName}${play.index}`);
    if (!play || (this.useBeatmapSamples && play.index >= 1)) candidates.push(`beatmap:${bankedName}`);
    candidates.push(`skin:${bankedName}`);
    if (play) candidates.push(`skin:${play.name}`);
    candidates.push(`default:${bankedName}`);
    for (const key of candidates) {
      if (this.hasSample(key)) return key;
    }
    return null;
  }

  private playBuffer(key: string, volume: number, channel: HitsoundChannel): void {
    const context = this.ensureContext();
    const channelGain = this.channelGains?.[channel];
    if (!context || !channelGain || context.state !== "running") return;

    const buffer = this.decoded.get(key);
    if (buffer === undefined) {
      this.decodeAllLoaded();
      return;
    }
    if (buffer === null) return;

    // At the polyphony cap, steal the oldest voice (short fade to avoid a
    // click) instead of dropping the new sound; skipping new hitsounds makes
    // dense charts pulse audibly.
    while (this.activeVoices.length >= MAX_CONCURRENT_SOURCES) {
      const oldest = this.activeVoices.shift();
      if (!oldest) break;
      try {
        oldest.gain.gain.setTargetAtTime(0, context.currentTime, 0.005);
        oldest.source.stop(context.currentTime + 0.03);
      } catch {
        // Already stopped; its onended cleanup has run or will run.
      }
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(channelGain);
    const voice: ActiveVoice = { source, gain };
    this.activeVoices.push(voice);
    source.onended = () => {
      const index = this.activeVoices.indexOf(voice);
      if (index !== -1) this.activeVoices.splice(index, 1);
      source.disconnect();
      gain.disconnect();
    };
    try {
      source.start();
    } catch {
      const index = this.activeVoices.indexOf(voice);
      if (index !== -1) this.activeVoices.splice(index, 1);
    }
  }
}
