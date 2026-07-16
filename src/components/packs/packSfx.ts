/* Synthesized sound effects for the pack opening flow. Everything is
   generated with WebAudio (no audio assets shipped): short filtered-noise
   bursts for the tactile sounds and small harmonic chimes for the reveals.
   The context is created lazily on the first call, which always happens
   inside a user gesture, so autoplay policies never block it. */

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

function ensureAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) {
    try {
      context = new Ctor();
    } catch {
      return null;
    }
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);
  }
  if (context.state === "suspended") void context.resume();
  return master ? context : null;
}

function getNoise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    const length = Math.floor(ctx.sampleRate);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

interface NoiseOptions {
  at?: number;
  duration: number;
  gain: number;
  startFreq: number;
  endFreq?: number;
  q?: number;
}

function playNoise(ctx: AudioContext, options: NoiseOptions) {
  if (!master) return;
  const t = ctx.currentTime + (options.at ?? 0);
  const source = ctx.createBufferSource();
  source.buffer = getNoise(ctx);
  source.loop = true;
  // Random offset so back-to-back bursts never sound like the same sample.
  source.playbackRate.value = 0.9 + Math.random() * 0.2;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(options.startFreq, t);
  if (options.endFreq) {
    filter.frequency.exponentialRampToValueAtTime(options.endFreq, t + options.duration);
  }
  filter.Q.value = options.q ?? 1.4;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(options.gain, t + Math.min(0.012, options.duration * 0.3));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + options.duration);
  source.connect(filter).connect(gain).connect(master);
  source.start(t, Math.random() * 0.5);
  source.stop(t + options.duration + 0.05);
}

interface ToneOptions {
  at?: number;
  freq: number;
  endFreq?: number;
  duration: number;
  gain: number;
  type?: OscillatorType;
}

function playTone(ctx: AudioContext, options: ToneOptions) {
  if (!master) return;
  const t = ctx.currentTime + (options.at ?? 0);
  const osc = ctx.createOscillator();
  osc.type = options.type ?? "triangle";
  osc.frequency.setValueAtTime(options.freq, t);
  if (options.endFreq) {
    osc.frequency.exponentialRampToValueAtTime(options.endFreq, t + options.duration);
  }
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(options.gain, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + options.duration);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + options.duration + 0.05);
}

let lastTickAt = 0;

/* Zipper tick as the blade tears another stretch of foil; the pitch climbs
   with cut coverage so the slash audibly builds toward the rip. */
export function playSlashTick(progress: number) {
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (now - lastTickAt < 26) return;
  lastTickAt = now;
  const ctx = ensureAudio();
  if (!ctx) return;
  playNoise(ctx, {
    duration: 0.032,
    gain: 0.14,
    startFreq: 2100 + progress * 2400 + Math.random() * 420,
    q: 8,
  });
}

/* The pack gives: a bright snap, the tear itself, and a low thump. */
export function playPackRip() {
  const ctx = ensureAudio();
  if (!ctx) return;
  playNoise(ctx, { duration: 0.05, gain: 0.2, startFreq: 3400, q: 2.5 });
  playNoise(ctx, { duration: 0.26, gain: 0.32, startFreq: 1500, endFreq: 380, q: 0.9 });
  playTone(ctx, { freq: 150, endFreq: 52, duration: 0.2, gain: 0.26, type: "sine" });
}

/* Soft card slide when a draw starts. */
export function playCardDraw() {
  const ctx = ensureAudio();
  if (!ctx) return;
  playNoise(ctx, { duration: 0.13, gain: 0.07, startFreq: 520, endFreq: 2100, q: 1.1 });
}

/* Riser that tracks the flip: an airy lowpassed swell that crests as the
   card turns front-side-out, then falls away. playNoise can't express this
   (it attacks instantly and decays for its whole duration, reading as a
   zip), so the envelope is shaped here. */
export function playFlipWhoosh(durationMs: number) {
  const ctx = ensureAudio();
  if (!ctx || !master) return;
  const duration = Math.max(0.18, (durationMs / 1000) * 0.72);
  // Audible from the first degrees of the turn, cresting mid-flip.
  const crest = duration * 0.42;
  const t = ctx.currentTime;
  const source = ctx.createBufferSource();
  source.buffer = getNoise(ctx);
  source.loop = true;
  source.playbackRate.value = 0.9 + Math.random() * 0.2;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(480, t);
  filter.frequency.exponentialRampToValueAtTime(2400, t + crest);
  filter.frequency.exponentialRampToValueAtTime(900, t + duration);
  filter.Q.value = 0.4;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.035, t + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.11, t + crest);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  source.connect(filter).connect(gain).connect(master);
  source.start(t, Math.random() * 0.5);
  source.stop(t + duration + 0.05);
}

/* Tension riser under a high-tier flip: an airy swell plus two slowly
   climbing detuned partials that crest right as the card faces out. Unlike
   the whoosh (which peaks mid-flip and falls away), this keeps building to
   the end - the "something good is coming" cue. Layered, not a replacement. */
export function playHypeRiser(durationMs: number, intensity: number) {
  const ctx = ensureAudio();
  if (!ctx || !master) return;
  const level = Math.max(0, Math.min(1, intensity));
  const duration = Math.max(0.3, durationMs / 1000);
  const t = ctx.currentTime;

  const source = ctx.createBufferSource();
  source.buffer = getNoise(ctx);
  source.loop = true;
  source.playbackRate.value = 0.9 + Math.random() * 0.2;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(650, t);
  filter.frequency.exponentialRampToValueAtTime(2800 + level * 2200, t + duration);
  filter.Q.value = 1.6;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.028 + level * 0.05, t + duration * 0.9);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.15);
  source.connect(filter).connect(noiseGain).connect(master);
  source.start(t, Math.random() * 0.5);
  source.stop(t + duration + 0.2);

  for (const [freq, gainPeak] of [
    [196, 0.05 + level * 0.035],
    [294.5, 0.028 + level * 0.02],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * (1.6 + level * 0.6), t + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(gainPeak, t + duration * 0.85);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.12);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + duration + 0.2);
  }
}

const CHIME_NOTES = [784, 988, 1175, 1568, 1976];

/* Landing chime when the card faces out. Intensity (0..1, from the tier)
   adds notes and shimmer; a first-copy pull gets one extra high sparkle. */
export function playRevealChime(intensity: number, isNew: boolean) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const level = Math.max(0, Math.min(1, intensity));
  const count = 1 + Math.round(level * 3);
  for (let i = 0; i < count; i += 1) {
    const freq = CHIME_NOTES[Math.min(i, CHIME_NOTES.length - 1)];
    const at = i * 0.075;
    // Sine fundamental + octave partial reads as a small bell; triangle
    // waves here sounded like a chiptune arpeggio.
    playTone(ctx, { at, freq, duration: 0.55 + level * 0.4, gain: 0.11, type: "sine" });
    playTone(ctx, { at, freq: freq * 2, duration: 0.4 + level * 0.3, gain: 0.032, type: "sine" });
  }
  if (level > 0.5) playNoise(ctx, { duration: 0.5, gain: 0.05, startFreq: 6800, q: 0.7 });
  if (isNew) {
    playTone(ctx, { at: count * 0.075 + 0.04, freq: 2349, duration: 0.5, gain: 0.065, type: "sine" });
  }
}

/* Shard clinks when cards are recycled; a bigger haul jingles longer. */
export function playRecycleClink(gained: number) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const count = Math.max(2, Math.min(5, 2 + Math.floor(Math.log2(Math.max(1, gained)))));
  playNoise(ctx, { duration: 0.16, gain: 0.06, startFreq: 1900, endFreq: 700, q: 1 });
  for (let i = 0; i < count; i += 1) {
    const at = i * 0.045 + Math.random() * 0.012;
    const freq = 1800 + Math.random() * 1100;
    playTone(ctx, { at, freq, duration: 0.07, gain: 0.08 });
    // Inharmonic partial that makes the tick read as metal instead of a beep.
    playTone(ctx, { at, freq: freq * 2.51, duration: 0.05, gain: 0.028, type: "sine" });
  }
}
