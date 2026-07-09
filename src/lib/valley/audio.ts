// All sound is synthesized with WebAudio (no assets): a gentle chiptune loop,
// ambient birds/crickets/rain and small UI/game SFX. The AudioContext is only
// created on the first user gesture (autoplay policy).

export type SfxName =
  | "splash"
  | "harvest"
  | "plant"
  | "cluck"
  | "thunder"
  | "bubble"
  | "well"
  | "blip"
  | "open"
  | "close"
  | "door";

// note name -> frequency
function freq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const N = {
  C2: 36, G2: 43, A2: 45, F2: 41,
  C4: 60, D4: 62, E4: 64, G4: 67, A4: 69,
  C5: 72, D5: 74, E5: 76, G5: 79, A5: 81,
} as const;

// 8 bars x 8 eighth-slots, 80bpm. [slot, midi, durSlots]
const MELODY: Array<[number, number, number]> = [
  [0, N.E4, 2], [2, N.G4, 2], [4, N.C5, 2], [6, N.A4, 1], [7, N.G4, 1],
  [8, N.A4, 2], [10, N.C5, 2], [12, N.E5, 1], [13, N.D5, 1], [14, N.C5, 2],
  [16, N.D5, 2], [18, N.C5, 2], [20, N.A4, 2], [22, N.G4, 2],
  [24, N.G4, 1], [25, N.A4, 1], [26, N.G4, 2], [28, N.E4, 2], [30, N.D4, 2],
  [32, N.C4, 2], [34, N.E4, 1], [35, N.G4, 1], [36, N.C5, 2], [38, N.G4, 2],
  [40, N.A4, 2], [42, N.E5, 2], [44, N.D5, 2], [46, N.C5, 2],
  [48, N.A4, 1], [49, N.C5, 1], [50, N.D5, 2], [52, N.C5, 2], [54, N.A4, 1], [55, N.G4, 1],
  [56, N.G4, 2], [58, N.D4, 1], [59, N.E4, 1], [60, N.G4, 3],
];
const BASS_ROOTS = [N.C2, N.A2 - 12, N.F2, N.G2, N.C2, N.A2 - 12, N.F2, N.G2];
const SLOTS = 64;
const SLOT_DUR = 60 / 80 / 2; // eighth note at 80bpm

export class ValleyAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private schedTimer: ReturnType<typeof setInterval> | null = null;
  private nextSlotTime = 0;
  private slot = 0;
  private ambientCooldown = 0;
  private _muted = false;
  private rainOn = false;

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  get muted(): boolean {
    return this._muted;
  }

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.55;
    this.master.connect(ctx.destination);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.5;
    this.musicGain.connect(this.master);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = 0.9;
    this.sfxGain.connect(this.master);

    // shared noise buffer
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    // rain loop (gain 0 until enabled)
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = buf;
    rainSrc.loop = true;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = "lowpass";
    rainFilter.frequency.value = 850;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(rainFilter).connect(this.rainGain).connect(this.master);
    rainSrc.start();
    if (this.rainOn) this.rainGain.gain.setTargetAtTime(0.07, ctx.currentTime, 1.2);

    // music scheduler
    this.nextSlotTime = ctx.currentTime + 0.1;
    this.slot = 0;
    this.schedTimer = setInterval(() => this.schedule(), 120);
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }
  }

  setRain(on: boolean): void {
    if (on === this.rainOn) return;
    this.rainOn = on;
    if (this.ctx && this.rainGain) {
      this.rainGain.gain.setTargetAtTime(on ? 0.07 : 0, this.ctx.currentTime, 1.2);
    }
  }

  destroy(): void {
    if (this.schedTimer) clearInterval(this.schedTimer);
    this.schedTimer = null;
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
  }

  // ------------------------------------------------------------------ music

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicGain) return;
    const horizon = ctx.currentTime + 0.35;
    while (this.nextSlotTime < horizon) {
      const slot = this.slot % SLOTS;
      const when = this.nextSlotTime;
      // melody
      for (const [s, midi, dur] of MELODY) {
        if (s === slot) this.tone(when, freq(midi), dur * SLOT_DUR * 0.92, "triangle", 0.11, this.musicGain);
      }
      // bass on beats 0 and 4 of each bar
      const bar = Math.floor(slot / 8);
      const inBar = slot % 8;
      if (inBar === 0 || inBar === 4) {
        this.tone(when, freq(BASS_ROOTS[bar]), SLOT_DUR * 3.4, "triangle", 0.1, this.musicGain);
      }
      // soft pad fifth on bar start
      if (inBar === 0) {
        this.tone(when, freq(BASS_ROOTS[bar] + 19), SLOT_DUR * 7, "sine", 0.028, this.musicGain);
        this.tone(when, freq(BASS_ROOTS[bar] + 24), SLOT_DUR * 7, "sine", 0.02, this.musicGain);
      }
      // brushed hat on offbeats
      if (inBar === 2 || inBar === 6) this.noiseHit(when, 0.03, 5200, 0.018);
      this.slot++;
      this.nextSlotTime += SLOT_DUR;
    }
  }

  private tone(
    when: number,
    frequency: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    dest: AudioNode,
    glideTo?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, when);
    if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(30, glideTo), when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    osc.connect(g).connect(dest);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  private noiseHit(when: number, dur: number, filterHz: number, gain: number, type: BiquadFilterType = "highpass"): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer || !this.sfxGain || !this.musicGain) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterHz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    src.connect(filter).connect(g).connect(this.master!);
    src.start(when, Math.random());
    src.stop(when + dur + 0.05);
  }

  // ------------------------------------------------------------------ sfx

  play(name: SfxName): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;
    const now = ctx.currentTime;
    const sfx = this.sfxGain;
    switch (name) {
      case "blip":
        this.tone(now, 560 + Math.random() * 120, 0.045, "square", 0.045, sfx);
        break;
      case "open":
        this.tone(now, 440, 0.06, "square", 0.05, sfx);
        this.tone(now + 0.07, 660, 0.08, "square", 0.05, sfx);
        break;
      case "close":
        this.tone(now, 660, 0.06, "square", 0.04, sfx);
        this.tone(now + 0.06, 440, 0.08, "square", 0.04, sfx);
        break;
      case "splash":
        this.noiseHit(now, 0.22, 1400, 0.05, "lowpass");
        this.tone(now, 420, 0.18, "sine", 0.06, sfx, 140);
        break;
      case "well":
        this.tone(now, 260, 0.14, "sine", 0.07, sfx, 520);
        this.tone(now + 0.1, 380, 0.12, "sine", 0.05, sfx, 620);
        break;
      case "harvest":
        this.tone(now, freq(N.C5 + 12), 0.07, "triangle", 0.09, sfx);
        this.tone(now + 0.06, freq(N.E5 + 12), 0.07, "triangle", 0.09, sfx);
        this.tone(now + 0.12, freq(N.G5 + 12), 0.12, "triangle", 0.09, sfx);
        break;
      case "plant":
        this.tone(now, 190, 0.1, "sine", 0.07, sfx, 90);
        break;
      case "cluck":
        this.tone(now, 780 + Math.random() * 160, 0.05, "square", 0.028, sfx, 420);
        this.noiseHit(now, 0.04, 1800, 0.02, "bandpass");
        break;
      case "bubble":
        this.tone(now, 880, 0.05, "sine", 0.045, sfx, 1180);
        break;
      case "thunder":
        this.noiseHit(now, 1.6, 140, 0.16, "lowpass");
        this.noiseHit(now + 0.18, 1.1, 90, 0.12, "lowpass");
        break;
      case "door":
        // wooden creak-thunk
        this.tone(now, 180, 0.07, "square", 0.05, sfx, 130);
        this.noiseHit(now + 0.05, 0.09, 420, 0.035, "lowpass");
        this.tone(now + 0.1, 130, 0.09, "square", 0.045, sfx, 95);
        break;
    }
  }

  // ambient chirps by time of day; called every frame with dt
  tick(dt: number, hour: number, storming: boolean): void {
    const ctx = this.ctx;
    if (!ctx || this._muted || storming) return;
    this.ambientCooldown -= dt;
    if (this.ambientCooldown > 0) return;
    const day = hour >= 6.5 && hour < 19;
    const night = hour >= 20.5 || hour < 5;
    if (day && Math.random() < 0.3) {
      // bird chirp: two rising slides
      const now = ctx.currentTime;
      const base = 2500 + Math.random() * 900;
      this.tone(now, base, 0.06, "sine", 0.02, this.sfxGain!, base + 700);
      this.tone(now + 0.09, base + 300, 0.05, "sine", 0.016, this.sfxGain!, base + 900);
      this.ambientCooldown = 2.5 + Math.random() * 6;
      return;
    }
    if (night && Math.random() < 0.4) {
      // cricket: pulsed high blips
      const now = ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        this.tone(now + i * 0.07, 4300, 0.03, "triangle", 0.012, this.sfxGain!);
      }
      this.ambientCooldown = 1.8 + Math.random() * 4;
      return;
    }
    this.ambientCooldown = 1;
  }
}
