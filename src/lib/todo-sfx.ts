// Hitsound playback for the /admin/todos playfield, using the stock osu! samples already shipped
// for the replay viewer (public/audio/hitsounds/). Everything is best-effort: a blocked
// AudioContext or failed fetch silently skips the sound, never surfaces.
//
// Sample mapping:
// - hitting a note        -> normal-hitnormal (+ normal-hitfinish layered on a MAX)
// - deleting an open note -> combobreak (the MISS)
// - adding a note         -> soft-hitnormal, quiet (note placed on the field)
// - undo from results     -> soft-hitwhistle (the note comes back)
// - drag-drop reorder     -> drum-hitnormal, very quiet tick

const SAMPLE_FILES = {
  hit: "normal-hitnormal.wav",
  finish: "normal-hitfinish.wav",
  place: "soft-hitnormal.wav",
  whistle: "soft-hitwhistle.wav",
  tick: "drum-hitnormal.wav",
  combobreak: "combobreak.mp3",
} as const;

type SampleName = keyof typeof SAMPLE_FILES;

let context: AudioContext | null = null;
let master: GainNode | null = null;
// null = fetch/decode failed, stay silent for that sample instead of retrying every click.
const buffers = new Map<SampleName, AudioBuffer | null>();
const loading = new Map<SampleName, Promise<void>>();

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) {
    try {
      context = new Ctor({ latencyHint: "interactive" });
    } catch {
      return null;
    }
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);
  }
  if (context.state === "suspended") void context.resume().catch(() => {});
  return master ? context : null;
}

function loadSample(ctx: AudioContext, name: SampleName): Promise<void> {
  const pending = loading.get(name);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const response = await fetch(`/audio/hitsounds/${SAMPLE_FILES[name]}`);
      if (!response.ok) throw new Error(`status ${response.status}`);
      // decodeAudioData works on a suspended context, so preloading before any gesture is fine.
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

function play(name: SampleName, gain: number): void {
  const ctx = ensureContext();
  if (!ctx || !master) return;
  const buffer = buffers.get(name);
  if (buffer === undefined) {
    // Not decoded yet (first interaction beat the preload): play as soon as it lands, the delay
    // is one network round-trip at worst.
    void loadSample(ctx, name).then(() => {
      const late = buffers.get(name);
      if (late) startBuffer(ctx, late, gain);
    });
    return;
  }
  if (buffer === null) return;
  startBuffer(ctx, buffer, gain);
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
    // Already started or context died; skip.
  }
}

/** Fetch + decode every sample up front so the first hit isn't late. Call from a page effect. */
export function preloadTodoSfx(): void {
  if (typeof window === "undefined") return;
  const ctx = ensureContext();
  if (!ctx) return;
  for (const name of Object.keys(SAMPLE_FILES) as SampleName[]) {
    if (!buffers.has(name)) void loadSample(ctx, name);
  }
}

/** Note hit: the stock hitnormal, with the finish cymbal layered on top for a MAX. */
export function playTodoHit(judgement: "MAX" | "300" | "200" | "100" | "50"): void {
  play("hit", 0.55);
  if (judgement === "MAX") play("finish", 0.4);
}

/** Deleting an open note is a MISS: the combo break. */
export function playTodoMiss(): void {
  play("combobreak", 0.5);
}

/** New note placed on the field. */
export function playTodoPlace(): void {
  play("place", 0.35);
}

/** A cleared note sent back to the field from results. */
export function playTodoReturn(): void {
  play("whistle", 0.3);
}

/** Drag-drop reorder committed. */
export function playTodoDropTick(): void {
  play("tick", 0.22);
}
