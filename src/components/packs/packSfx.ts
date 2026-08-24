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
  /* Seconds to reach full gain. The default is a near-instant 8ms, which is
     what makes the small chimes read as struck; a slower attack is what turns
     a saw stack into a horn swell instead of a stab. */
  attack?: number;
  /* Runs the oscillator through a saturator before the envelope. A clean saw
     stack stays polite however loud it is played; drive is what makes one
     sound like it is being pushed, which is the whole character of the
     Eternal fanfare's low end. */
  drive?: boolean;
  /* Fraction of the duration the pitch slide takes, for percussive drops that
     should land well before the tail ends (a kick, not a siren). */
  glideFraction?: number;
}

/* Soft-clip curve for the drive option above; built once and shared. */
let driveCurve: Float32Array<ArrayBuffer> | null = null;

function getDriveCurve(): Float32Array<ArrayBuffer> {
  if (!driveCurve) {
    const size = 1024;
    driveCurve = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      const x = (index / (size - 1)) * 2 - 1;
      driveCurve[index] = Math.tanh(x * 3.4);
    }
  }
  return driveCurve;
}

function playTone(ctx: AudioContext, options: ToneOptions) {
  if (!master) return;
  const t = ctx.currentTime + (options.at ?? 0);
  const osc = ctx.createOscillator();
  osc.type = options.type ?? "triangle";
  osc.frequency.setValueAtTime(options.freq, t);
  if (options.endFreq) {
    osc.frequency.exponentialRampToValueAtTime(
      options.endFreq,
      t + options.duration * (options.glideFraction ?? 1),
    );
  }
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(options.gain, t + Math.max(0.004, options.attack ?? 0.008));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + options.duration);
  if (options.drive) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = getDriveCurve();
    shaper.oversample = "2x";
    osc.connect(shaper).connect(gain).connect(master);
  } else {
    osc.connect(gain).connect(master);
  }
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
    gain: 0.42,
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

/* The blade going through the pack's middle: card stock, not foil. Drier and
   lower than the tear along the perforation, so a cut that ruins the cards
   never sounds like a clean open. Intensity scales it down for the flip of a
   single sliced card, where it plays instead of the reveal chime. */
export function playCardSlice(intensity = 1) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const level = Math.max(0.15, Math.min(1, intensity));
  playNoise(ctx, { duration: 0.09, gain: 0.26 * level, startFreq: 2600, endFreq: 700, q: 1.6 });
  playNoise(ctx, { at: 0.02, duration: 0.2, gain: 0.15 * level, startFreq: 900, endFreq: 240, q: 0.8 });
  playTone(ctx, { freq: 120, endFreq: 46, duration: 0.24, gain: 0.11 * level, type: "sine" });
}

/* Soft card slide when a draw starts. */
export function playCardDraw() {
  const ctx = ensureAudio();
  if (!ctx) return;
  playNoise(ctx, { duration: 0.13, gain: 0.07, startFreq: 520, endFreq: 2100, q: 1.1 });
}

/* Soft whisk for each pass of the shuffle loop while the pack's players are
   still being drawn. Deliberately quieter than the card-draw slide: it can
   repeat for a few seconds, so it has to sit under attention, not demand it. */
export function playShuffleWhisk() {
  const ctx = ensureAudio();
  if (!ctx) return;
  playNoise(ctx, { duration: 0.09, gain: 0.035, startFreq: 850, endFreq: 2500, q: 1.2 });
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

/* Paper page turn for the card album: the sheet lifting with an airy
   swish, then settling. Quiet by design: it plays on every flip. */
export function playPageTurn() {
  const ctx = ensureAudio();
  if (!ctx) return;
  playNoise(ctx, { duration: 0.16, gain: 0.05, startFreq: 900, endFreq: 2600, q: 0.8 });
  playNoise(ctx, { at: 0.15, duration: 0.09, gain: 0.06, startFreq: 2300, endFreq: 850, q: 1.2 });
}

/* Building the context and filling the one-second noise buffer costs real
   time, and on the very first page turn it landed inside the flip engine's
   animation-end callback. Call this from the gesture that opens an album --
   still a user gesture, so autoplay policy is satisfied -- and the first turn
   is already warm. */
export function warmPackAudio(): void {
  const ctx = ensureAudio();
  if (ctx) getNoise(ctx);
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

// A major triad walking up two octaves: the reveal chime's notes are a scale
// fragment, so a triad reads as "different event", not "louder chime".
const GOAT_FANFARE_NOTES = [392, 494, 587, 784, 988, 1175, 1568];

/* The GOAT pull. Longer and fuller than playRevealChime by design - this tier
   drops at most 3% of the time in the best pack, so it gets a fanfare rather
   than a bigger bell: a low swell under a rising triad, then a struck bell. */
export function playGoatFanfare() {
  const ctx = ensureAudio();
  if (!ctx) return;

  // Low swell that opens the moment and carries under the arpeggio.
  playTone(ctx, { freq: 98, endFreq: 196, duration: 1.6, gain: 0.075, type: "sine" });
  playTone(ctx, { freq: 147, duration: 1.4, gain: 0.045, type: "sine" });
  playNoise(ctx, { duration: 1.1, gain: 0.05, startFreq: 400, endFreq: 7200, q: 0.6 });

  GOAT_FANFARE_NOTES.forEach((freq, index) => {
    const at = 0.1 + index * 0.085;
    playTone(ctx, { at, freq, duration: 0.9, gain: 0.1, type: "sine" });
    playTone(ctx, { at, freq: freq * 2, duration: 0.6, gain: 0.03, type: "sine" });
    playTone(ctx, { at, freq: freq * 3, duration: 0.35, gain: 0.012, type: "sine" });
  });

  // Struck bell on the landing, with a shimmer tail.
  const landing = 0.1 + GOAT_FANFARE_NOTES.length * 0.085;
  playTone(ctx, { at: landing, freq: 2093, duration: 1.8, gain: 0.085, type: "sine" });
  playTone(ctx, { at: landing, freq: 3136, duration: 1.4, gain: 0.03, type: "sine" });
  playNoise(ctx, { at: landing, duration: 1.2, gain: 0.035, startFreq: 9000, q: 0.8 });
}

/* A chord voiced the way this file's other sounds are not: detuned sawtooth
   copies per note, driven into a saturator, which is what gives a synth stack
   its horn-like bite and body. A sine at the same gain reads as a polite
   beep; the whole point of the Eternal fanfare is that it does not. */
function playChordStack(
  ctx: AudioContext,
  options: {
    at: number;
    freqs: readonly number[];
    duration: number;
    gain: number;
    detune?: number;
    attack?: number;
    /* Doubles the stack an octave down, driven hard. This is the "braaam":
       the sub octave is where the weight lives, and without it a saw chord is
       just bright. */
    sub?: boolean;
  },
) {
  const detune = options.detune ?? 0.008;
  const { at, duration, gain, attack } = options;
  for (const freq of options.freqs) {
    playTone(ctx, { at, freq, duration, gain, type: "sawtooth", drive: true, attack });
    playTone(ctx, { at, freq: freq * (1 + detune), duration, gain: gain * 0.7, type: "sawtooth", drive: true, attack });
    playTone(ctx, { at, freq: freq * (1 - detune), duration, gain: gain * 0.7, type: "sawtooth", drive: true, attack });
    // A square an octave down thickens the body without adding brightness.
    playTone(ctx, { at, freq: freq / 2, duration, gain: gain * 0.5, type: "square", drive: true, attack });
    if (options.sub) {
      playTone(ctx, { at, freq: freq / 4, duration: duration * 1.15, gain: gain * 0.62, type: "sine", attack });
    }
  }
}

/* The hit under everything: a kick with a fast pitch drop, its click, and a
   sub tail that rings on after it. Percussion is what a fanfare is missing
   when it sounds thin no matter how loud the chords get. */
function playImpactHit(ctx: AudioContext, at: number, options: { gain: number; tail: number }) {
  // Body: pitched drop, landing almost immediately so it thumps.
  playTone(ctx, { at, freq: 200, endFreq: 42, duration: 0.5, gain: options.gain, type: "sine", glideFraction: 0.16, attack: 0.004 });
  playTone(ctx, { at, freq: 120, endFreq: 38, duration: 0.42, gain: options.gain * 0.75, type: "triangle", drive: true, glideFraction: 0.2, attack: 0.004 });
  // Click, so it cuts through on small speakers where the sub is inaudible.
  playNoise(ctx, { at, duration: 0.045, gain: options.gain * 0.5, startFreq: 2600, endFreq: 700, q: 0.7 });
  // Sub tail.
  if (options.tail > 0) {
    playTone(ctx, { at: at + 0.01, freq: 41, duration: options.tail, gain: options.gain * 0.85, type: "sine", attack: 0.02 });
  }
}

/* The Eternal card: the one-time 100%-completion reward, the opener's own
   card, and the last card a collector will ever be dealt for finishing.

   Not the GOAT fanfare transposed. That one is a bright bell triad over a
   swell, about half a second of lead-in and gone in under two. This is built
   like a trailer cue and runs about four seconds: a riser winding up, a real
   impact (sub drop plus crash) on the downbeat, three brass chords climbing
   out of it, then the resolve chord held with a bell and a long sub tail.
   It is deliberately the loudest thing in the pack flow. */
const ETERNAL_IMPACT_AT = 0.95;
const ETERNAL_CLIMB_AT = ETERNAL_IMPACT_AT + 0.42;
const ETERNAL_CLIMB_STEP = 0.34;
/* D minor stabs landing on a D major braaam: the climb is dark and the
   landing is not, which is the shape of the whole moment in one chord change.
   Voiced low, because the weight is the point. */
const ETERNAL_CLIMB_CHORDS = [
  [73.42, 110, 146.83],
  [87.31, 130.81, 174.61],
  [98, 146.83, 196],
];
const ETERNAL_RESOLVE_CHORD = [73.42, 110, 146.83, 220, 293.66];

/* The recorded cue, and the one place this file uses an asset at all.
   Everything else here is synthesized because a synth is the right instrument
   for a UI click or a reveal chime; for a four second cinematic hit it is not,
   and the WebAudio version below reads as artificial next to the moment it is
   marking. See public/audio/packs/README.md for the sources and the license
   (both CC0).

   null means "asked and cannot have it" (missing, blocked, undecodable), which
   pins the synth fallback rather than refetching on every play. */
const ETERNAL_SAMPLE_URL = "/audio/packs/eternal-pull.mp3";
let eternalBuffer: AudioBuffer | null = null;
let eternalBufferLoad: Promise<void> | null = null;

function loadEternalSample(ctx: AudioContext): Promise<void> {
  if (!eternalBufferLoad) {
    eternalBufferLoad = (async () => {
      try {
        const response = await fetch(ETERNAL_SAMPLE_URL);
        if (!response.ok) return;
        eternalBuffer = await ctx.decodeAudioData(await response.arrayBuffer());
      } catch {
        // Left null: the synthesized cue below covers it.
      }
    })();
  }
  return eternalBufferLoad;
}

/* Called as soon as a dealt hand is known to contain the Eternal card, which
   is a few seconds of reveal before it is needed. Decoding on demand at the
   flip would risk the ceremony starting silent and the sound arriving late,
   and this card is dealt once per collector, so there is no second chance to
   get it right. Safe to call repeatedly and before any user gesture: a
   suspended context still decodes. */
export function prefetchEternalFanfare(): void {
  const ctx = ensureAudio();
  if (!ctx || eternalBuffer) return;
  void loadEternalSample(ctx);
}

export function playEternalFanfare() {
  const ctx = ensureAudio();
  if (!ctx || !master) return;

  if (eternalBuffer) {
    const source = ctx.createBufferSource();
    source.buffer = eternalBuffer;
    const gain = ctx.createGain();
    // The file is already mastered to sit above the rest of the pack flow, so
    // this only trims it under the shared master rather than shaping it.
    gain.gain.value = 0.9;
    source.connect(gain).connect(master);
    source.start();
    return;
  }

  /* Not loaded (yet, or at all): the synthesized cue. Same shape and the same
     4.4 seconds, so the burst stays in step with whichever one plays. */
  void loadEternalSample(ctx);
  playSynthesizedEternalFanfare(ctx);
}

function playSynthesizedEternalFanfare(ctx: AudioContext) {
  /* Wind-up. A rising noise sweep, a driven low rumble underneath it, and two
     warning thumps, so the impact lands on something instead of on silence. */
  playNoise(ctx, { duration: ETERNAL_IMPACT_AT, gain: 0.085, startFreq: 240, endFreq: 9500, q: 0.6 });
  playTone(ctx, { freq: 36, endFreq: 66, duration: ETERNAL_IMPACT_AT, gain: 0.16, type: "sawtooth", drive: true, attack: 0.4 });
  playImpactHit(ctx, 0.36, { gain: 0.13, tail: 0 });
  playImpactHit(ctx, 0.66, { gain: 0.18, tail: 0 });

  /* The impact. Kick, crash, and a driven low braaam on the same instant:
     this is the frame the card lands on, and it is the loudest thing in the
     pack flow on purpose. */
  playImpactHit(ctx, ETERNAL_IMPACT_AT, { gain: 0.42, tail: 1.7 });
  playNoise(ctx, { at: ETERNAL_IMPACT_AT, duration: 1.5, gain: 0.15, startFreq: 9000, endFreq: 500, q: 0.4 });
  playChordStack(ctx, { at: ETERNAL_IMPACT_AT, freqs: [36.71, 55], duration: 1.25, gain: 0.1, attack: 0.03, sub: true });

  /* Three stabs climbing out of it, each with its own kick so the run drives
     instead of drifting. Short and gated, not held. */
  ETERNAL_CLIMB_CHORDS.forEach((chord, index) => {
    const at = ETERNAL_CLIMB_AT + index * ETERNAL_CLIMB_STEP;
    playChordStack(ctx, { at, freqs: chord, duration: 0.3, gain: 0.085 + index * 0.014, attack: 0.006 });
    playImpactHit(ctx, at, { gain: 0.26 + index * 0.03, tail: 0 });
    playNoise(ctx, { at, duration: 0.22, gain: 0.06, startFreq: 4200, endFreq: 800, q: 0.6 });
  });

  /* The landing: the full chord held with its sub octave, a kick under it,
     and a bell over the top so the low end has something to resolve to. */
  const landing = ETERNAL_CLIMB_AT + ETERNAL_CLIMB_CHORDS.length * ETERNAL_CLIMB_STEP;
  playImpactHit(ctx, landing, { gain: 0.44, tail: 2.6 });
  playChordStack(ctx, { at: landing, freqs: ETERNAL_RESOLVE_CHORD, duration: 2.2, gain: 0.095, detune: 0.006, attack: 0.02, sub: true });
  playTone(ctx, { at: landing, freq: 1174.66, duration: 2.3, gain: 0.085, type: "sine" });
  playTone(ctx, { at: landing, freq: 1760, duration: 1.7, gain: 0.038, type: "sine" });
  playNoise(ctx, { at: landing, duration: 1.0, gain: 0.1, startFreq: 9500, endFreq: 3500, q: 0.5 });
  // Shimmer tail, the last thing left in the room.
  playNoise(ctx, { at: landing + 0.55, duration: 1.9, gain: 0.03, startFreq: 11000, q: 0.9 });
}

/* A pentatonic ladder for the higher-or-lower game: no two rungs can clash, so
   a run of right answers reads as one climbing phrase however long it gets. */
const STREAK_LADDER = [523.25, 587.33, 659.25, 783.99, 880];

/* The note a given streak lands on. Each correct guess climbs a rung, and the
   ladder jumps an octave every time it wraps, so a good run audibly builds
   instead of repeating one ding. Capped two octaves up, past which it stops
   sounding like a reward and starts sounding like a smoke alarm. */
export function streakChimeFrequency(streak: number): number {
  const step = Math.max(0, Math.floor(streak) - 1);
  const octave = Math.min(2, Math.floor(step / STREAK_LADDER.length));
  return STREAK_LADDER[step % STREAK_LADDER.length] * 2 ** octave;
}

/* Right answer. */
export function playStreakCorrect(streak: number) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const freq = streakChimeFrequency(streak);
  playTone(ctx, { freq, duration: 0.34, gain: 0.1, type: "sine" });
  // A fifth above, a beat late: enough body that the note reads as struck
  // rather than beeped.
  playTone(ctx, { at: 0.05, freq: freq * 1.5, duration: 0.26, gain: 0.042, type: "sine" });
  playNoise(ctx, { duration: 0.09, gain: 0.02, startFreq: 5600, q: 0.9 });
}

/* Wrong answer, which is also the end of the run: the climb gives way to two
   notes falling, over a thud. */
export function playStreakWrong() {
  const ctx = ensureAudio();
  if (!ctx) return;
  playTone(ctx, { freq: 330, endFreq: 262, duration: 0.26, gain: 0.085, type: "triangle" });
  playTone(ctx, { at: 0.15, freq: 247, endFreq: 156, duration: 0.44, gain: 0.075, type: "triangle" });
  playTone(ctx, { freq: 110, endFreq: 55, duration: 0.5, gain: 0.085, type: "sine" });
}

/* Every fifth in a row, where the bonus is. Lands just after the note for the
   guess that earned it, so the two read as one flourish. */
export function playStreakMilestone() {
  const ctx = ensureAudio();
  if (!ctx) return;
  [1046.5, 1318.5, 1568].forEach((freq, index) => {
    const at = 0.14 + index * 0.07;
    playTone(ctx, { at, freq, duration: 0.5, gain: 0.075, type: "sine" });
    playTone(ctx, { at, freq: freq * 2, duration: 0.32, gain: 0.02, type: "sine" });
  });
  playNoise(ctx, { at: 0.14, duration: 0.4, gain: 0.03, startFreq: 7200, q: 0.7 });
}

/* Dice, for a guess nobody wanted to make. A handful of dry knocks at falling
   intervals so it lands rather than rattling forever, then the settle: two
   clacks close together, the way a die does when it stops caring. Wooden on
   purpose - the shard clink next to it is metal, and these two should never be
   mistaken for each other. */
export function playDiceRoll() {
  const ctx = ensureAudio();
  if (!ctx) return;
  let at = 0;
  for (let knock = 0; knock < 6; knock += 1) {
    // Each gap a little longer than the last: a die slowing down.
    at += 0.045 + knock * 0.016 + Math.random() * 0.01;
    playNoise(ctx, { at, duration: 0.05, gain: 0.055, startFreq: 900 + Math.random() * 700, q: 2.4 });
    playTone(ctx, { at, freq: 220 + Math.random() * 90, duration: 0.045, gain: 0.03, type: "triangle" });
  }
  playNoise(ctx, { at: at + 0.09, duration: 0.06, gain: 0.05, startFreq: 700, endFreq: 420, q: 2 });
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
