/* A soft osu-style hit sound for toggling pattern chips, synthesized with
   WebAudio (no assets), mirroring the pack SFX approach. The context is created
   lazily inside the click gesture so autoplay policies never block it. */

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

function ensureAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) {
    try {
      context = new Ctor();
    } catch {
      return null;
    }
    master = context.createGain();
    master.gain.value = 0.4;
    master.connect(context.destination);
  }
  if (context.state === "suspended") void context.resume();
  return master ? context : null;
}

function getNoise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    const length = Math.floor(ctx.sampleRate * 0.2);
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

// Selecting is a brighter, higher hit than deselecting, so on vs off feel distinct.
export function playPatternHit(selected: boolean): void {
  const ctx = ensureAudio();
  if (!ctx || !master) return;
  const t = ctx.currentTime;

  const source = ctx.createBufferSource();
  source.buffer = getNoise(ctx);
  source.loop = true;
  source.playbackRate.value = 0.9 + Math.random() * 0.2;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = selected ? 1750 : 1200;
  filter.Q.value = 1.1;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, t);
  noiseGain.gain.exponentialRampToValueAtTime(0.16, t + 0.005);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  source.connect(filter).connect(noiseGain).connect(master);
  source.start(t, Math.random() * 0.1);
  source.stop(t + 0.08);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  const freq = selected ? 560 : 400;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * (selected ? 1.25 : 0.8), t + 0.06);
  const toneGain = ctx.createGain();
  toneGain.gain.setValueAtTime(0.0001, t);
  toneGain.gain.exponentialRampToValueAtTime(0.09, t + 0.006);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  osc.connect(toneGain).connect(master);
  osc.start(t);
  osc.stop(t + 0.12);
}
