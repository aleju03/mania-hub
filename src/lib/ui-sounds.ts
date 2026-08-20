// Small synthesized UI sounds (no shipped audio assets). Everything is best-effort: browsers cap
// live AudioContexts and require a user gesture before playback, so a blocked or failing context
// silently skips the sound - a missing chime is never worth surfacing.

let audioCtx: AudioContext | null = null;

function withAudioContext(play: (ctx: AudioContext) => void): void {
  if (typeof window === "undefined") return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = audioCtx ?? new Ctor();
    if (audioCtx.state === "suspended") void audioCtx.resume().catch(() => {});
    play(audioCtx);
  } catch {
    // no audio, no problem
  }
}

/**
 * "Goal cleared": a short rise that lands on a bell-like open fifth (A5 + E6 + A6) with a faint
 * noise sparkle - one bright "ta-da" hit rather than a melody. ~0.8s, quiet; it accompanies the
 * celebration toast, it isn't the celebration.
 */
export function playGoalClearedSound(): void {
  withAudioContext((ctx) => {
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);

    // Upward sweep into the hit.
    const sweep = ctx.createOscillator();
    sweep.type = "sine";
    sweep.frequency.setValueAtTime(330, t0);
    sweep.frequency.exponentialRampToValueAtTime(880, t0 + 0.09);
    const sweepGain = ctx.createGain();
    sweepGain.gain.setValueAtTime(0.0001, t0);
    sweepGain.gain.exponentialRampToValueAtTime(0.5, t0 + 0.05);
    sweepGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    sweep.connect(sweepGain);
    sweepGain.connect(master);
    sweep.start(t0);
    sweep.stop(t0 + 0.14);

    // The landing: sine partials at the root, fifth, and octave decay together like a struck bell.
    const hit = t0 + 0.09;
    const partials: Array<[number, number]> = [[880, 1], [1318.5, 0.55], [1760, 0.3]];
    for (const [frequency, level] of partials) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = frequency;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, hit);
      gain.gain.exponentialRampToValueAtTime(level, hit + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, hit + 0.75);
      osc.connect(gain);
      gain.connect(master);
      osc.start(hit);
      osc.stop(hit + 0.8);
    }

    // Faint high-passed noise burst for sparkle on the hit.
    const sparkleSeconds = 0.22;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * sparkleSeconds), ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 6000;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.2, hit);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, hit + sparkleSeconds);
    noise.connect(highpass);
    highpass.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(hit);
  });
}

/**
 * "Tracking started": two quick rising sine notes (E5 then B5, each with a quiet octave partial),
 * the second ringing out - a soft "you're connected" chime, warmer and smaller than the
 * goal-cleared ta-da. ~0.6s.
 */
export function playTrackingStartedSound(): void {
  withAudioContext((ctx) => {
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = 0.13;
    master.connect(ctx.destination);

    const notes: Array<{ frequency: number; offset: number; ring: number }> = [
      { frequency: 659.25, offset: 0, ring: 0.18 },
      { frequency: 987.77, offset: 0.11, ring: 0.55 },
    ];
    for (const note of notes) {
      const start = t0 + note.offset;
      for (const [mult, level] of [[1, 0.6], [2, 0.16]] as const) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = note.frequency * mult;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(level, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + note.ring);
        osc.connect(gain);
        gain.connect(master);
        osc.start(start);
        osc.stop(start + note.ring + 0.05);
      }
    }
  });
}

/**
 * "Goal deleted": a short airy "puff" - band-passed noise sweeping down with a faint descending
 * tick on top, ~0.12s. Deliberately no low end (nothing below ~500Hz): an earlier sine-blip take
 * reached 150Hz and read as a physical thud instead of a dismissal.
 */
export function playGoalDeletedSound(): void {
  withAudioContext((ctx) => {
    const t0 = ctx.currentTime + 0.01;
    const master = ctx.createGain();
    master.gain.value = 0.09;
    master.connect(ctx.destination);

    const seconds = 0.12;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.setValueAtTime(2600, t0);
    bandpass.frequency.exponentialRampToValueAtTime(1200, t0 + seconds);
    bandpass.Q.value = 1.2;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.9, t0);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
    noise.connect(bandpass);
    bandpass.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(t0);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(820, t0);
    osc.frequency.exponentialRampToValueAtTime(520, t0 + 0.09);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.5, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.12);
  });
}

/**
 * "Write landed" for the admin desks: two quick rising sine notes (B5 then F#6) with a short ring -
 * a plain confirmation tick, smaller and drier than the goal-cleared ta-da, since granting a card
 * is a chore being done rather than a milestone. ~0.3s.
 */
export function playAdminActionSound(): void {
  withAudioContext((ctx) => {
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = 0.11;
    master.connect(ctx.destination);

    const notes: Array<{ frequency: number; offset: number; ring: number }> = [
      { frequency: 987.77, offset: 0, ring: 0.1 },
      { frequency: 1479.98, offset: 0.07, ring: 0.28 },
    ];
    for (const note of notes) {
      const start = t0 + note.offset;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = note.frequency;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.5, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.ring);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + note.ring + 0.05);
    }
  });
}

/**
 * "Write refused": the same two notes falling instead of rising (F#5 then C#5), the second held a
 * little longer. Quiet and short - it marks a failed action, it is not an alarm. ~0.35s.
 */
export function playAdminActionFailedSound(): void {
  withAudioContext((ctx) => {
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = 0.1;
    master.connect(ctx.destination);

    const notes: Array<{ frequency: number; offset: number; ring: number }> = [
      { frequency: 739.99, offset: 0, ring: 0.12 },
      { frequency: 554.37, offset: 0.09, ring: 0.32 },
    ];
    for (const note of notes) {
      const start = t0 + note.offset;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = note.frequency;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.45, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + note.ring);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + note.ring + 0.05);
    }
  });
}
