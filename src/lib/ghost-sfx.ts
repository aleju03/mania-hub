// Sound for the ghost's actions and for his talking blip.
//
// Two tiers, in that order: a real sample from public/audio/ghost/ when one has
// been dropped in, and a synthesized cue when it has not. The repo ships no
// audio for this, so the folder starts empty and every action still makes a
// noise; drop <kind>.ogg next to the others and it takes over from then on.
//
// Same rules as the site's other sfx (src/lib/todo-sfx.ts, packSfx.ts): entirely
// best effort. A blocked AudioContext, a missing file or a decode failure is
// silence, never something the visitor is told about.

import { GHOST_ACTIONS } from "./ghost-shared";

/** Every action, plus the per-character blip his speech bubble types with. */
export type GhostSfxName = (typeof GHOST_ACTIONS)[number]["kind"] | "speech";

const SAMPLE_DIR = "/audio/ghost";

/* What each cue is called on disk. Change the extension here if your files are
   .wav or .mp3 instead; nothing else cares what the container is. */
export const GHOST_SAMPLE_FILES: Record<GhostSfxName, string> = {
  heal: "heal.ogg",
  pacify: "pacify.ogg",
  cheer: "cheer.ogg",
  sing: "sing.ogg",
  spin: "spin.ogg",
  scarf: "scarf.ogg",
  dark: "dark.ogg",
  appear: "appear.ogg",
  vanish: "vanish.ogg",
  speech: "speech.ogg",
};

/* The fallback: a short figure of notes, a pitch sweep, or a noise burst. These
   are stand-ins so an empty folder is not a silent feature, not imitations of
   anything in particular. */
interface GhostCue {
  notes?: number[];
  sweep?: [number, number];
  noise?: boolean;
  wave: OscillatorType;
  /** Seconds per note, or the length of the sweep or burst. */
  step: number;
  gain: number;
}

const CUES: Record<GhostSfxName, GhostCue> = {
  heal: { notes: [523.25, 659.25, 783.99, 1046.5], wave: "sine", step: 0.09, gain: 0.14 },
  pacify: { notes: [659.25, 523.25, 392], wave: "sine", step: 0.15, gain: 0.12 },
  cheer: { notes: [587.33, 739.99, 880], wave: "square", step: 0.07, gain: 0.06 },
  sing: { notes: [523.25, 587.33, 698.46, 587.33, 466.16], wave: "triangle", step: 0.16, gain: 0.1 },
  spin: { sweep: [320, 880], wave: "sawtooth", step: 0.3, gain: 0.05 },
  scarf: { noise: true, wave: "square", step: 0.22, gain: 0.11 },
  dark: { sweep: [220, 65], wave: "sine", step: 1.1, gain: 0.14 },
  appear: { sweep: [300, 780], wave: "square", step: 0.26, gain: 0.05 },
  vanish: { sweep: [780, 220], wave: "square", step: 0.3, gain: 0.05 },
  speech: { notes: [620], wave: "square", step: 0.05, gain: 0.025 },
};

let context: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
// null = no file there, or it would not decode: fall back to the cue instead of
// asking for it again on every action.
const buffers = new Map<GhostSfxName, AudioBuffer | null>();
const loading = new Map<GhostSfxName, Promise<void>>();

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) {
    try {
      context = new Ctor({ latencyHint: "interactive" });
    } catch {
      return null;
    }
    master = context.createGain();
    master.gain.value = 0.6;
    master.connect(context.destination);
  }
  if (context.state === "suspended") void context.resume().catch(() => {});
  return master ? context : null;
}

function loadSample(ctx: AudioContext, name: GhostSfxName): Promise<void> {
  const pending = loading.get(name);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const response = await fetch(`${SAMPLE_DIR}/${GHOST_SAMPLE_FILES[name]}`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      // decodeAudioData works on a suspended context, so this can run before the
      // page has been touched.
      buffers.set(name, await ctx.decodeAudioData(await response.arrayBuffer()));
    } catch {
      buffers.set(name, null);
    } finally {
      loading.delete(name);
    }
  })();
  loading.set(name, promise);
  return promise;
}

function startBuffer(ctx: AudioContext, buffer: AudioBuffer, gain: number): void {
  if (!master || ctx.state !== "running") return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const level = ctx.createGain();
  level.gain.value = gain;
  source.connect(level).connect(master);
  source.onended = () => {
    source.disconnect();
    level.disconnect();
  };
  try {
    source.start();
  } catch {
    // Already started or the context died; skip.
  }
}

function synthesize(ctx: AudioContext, name: GhostSfxName): void {
  if (!master || ctx.state !== "running") return;
  const cue = CUES[name];
  const now = ctx.currentTime;
  if (cue.noise) {
    const frames = Math.floor(ctx.sampleRate * cue.step);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Fades across the burst, which is what makes it a whip rather than a hiss.
    for (let index = 0; index < frames; index += 1) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / frames) ** 2;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1_800, now);
    filter.frequency.exponentialRampToValueAtTime(600, now + cue.step);
    const level = ctx.createGain();
    level.gain.value = cue.gain;
    source.connect(filter).connect(level).connect(master);
    source.start(now);
    return;
  }

  const oscillator = ctx.createOscillator();
  const level = ctx.createGain();
  oscillator.type = cue.wave;
  oscillator.connect(level).connect(master);

  if (cue.sweep) {
    const [from, to] = cue.sweep;
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(to, now + cue.step);
    level.gain.setValueAtTime(cue.gain, now);
    level.gain.exponentialRampToValueAtTime(0.0001, now + cue.step);
    oscillator.start(now);
    oscillator.stop(now + cue.step + 0.02);
    return;
  }

  const notes = cue.notes ?? [];
  level.gain.setValueAtTime(0.0001, now);
  notes.forEach((frequency, index) => {
    const at = now + index * cue.step;
    oscillator.frequency.setValueAtTime(frequency, at);
    // Each note gets its own attack and decay, so the figure reads as separate
    // notes rather than one tone changing pitch.
    level.gain.setValueAtTime(cue.gain, at);
    level.gain.exponentialRampToValueAtTime(0.0001, at + cue.step * 0.9);
  });
  oscillator.start(now);
  oscillator.stop(now + notes.length * cue.step + 0.05);
}

function play(name: GhostSfxName, gain: number): void {
  if (muted) return;
  const ctx = ensureContext();
  if (!ctx) return;
  const buffer = buffers.get(name);
  if (buffer === undefined) {
    /* Fired before the preload landed: cover this one with the cue rather than
       going quiet, and let the sample take over from the next. */
    synthesize(ctx, name);
    void loadSample(ctx, name);
    return;
  }
  if (buffer === null) {
    synthesize(ctx, name);
    return;
  }
  startBuffer(ctx, buffer, gain);
}

/** Fetch and decode every sample up front, so the first action is not late.
    Call from a page effect; repeat calls are free. */
export function preloadGhostSfx(): void {
  if (typeof window === "undefined") return;
  const ctx = ensureContext();
  if (!ctx) return;
  for (const name of Object.keys(GHOST_SAMPLE_FILES) as GhostSfxName[]) {
    if (!buffers.has(name)) void loadSample(ctx, name);
  }
}

/** One of his actions firing. Unknown kinds are silent rather than guessed at. */
export function playGhostActionSfx(kind: string): void {
  if (!(kind in GHOST_SAMPLE_FILES) || kind === "speech") return;
  play(kind as GhostSfxName, 0.9);
}

/** One character of a speech bubble typing itself out. */
export function playGhostSpeechSfx(character: string): void {
  if (character === "" || character === " " || character === "\n") return;
  play("speech", 0.5);
}

/** Local mute, for the control panel's own preview of what it is firing. */
export function setGhostSfxMuted(next: boolean): void {
  muted = next;
}
