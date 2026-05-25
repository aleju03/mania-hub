import type { ReplayFrame } from "./types";
import { normalizeReplayScrollSpeed } from "./replay-scroll-speed";

export const MANIA_REPLAY_KEY_MASK = (1 << 20) - 1;
const STABLE_MANIA_SCROLL_SPEED_BPM_SCALE = 100;

export type RawReplayFrameLike = {
  buttonState?: number;
  mouseX?: number;
  mouseY?: number;
  position?: {
    x?: number;
    y?: number;
  };
  startTime?: number;
  time?: number;
};

type NormalizedReplayFrame = ReplayFrame & {
  x: number;
  y: number;
};

function replayFrameTime(frame: RawReplayFrameLike): number {
  return Math.round(Number(frame.startTime ?? frame.time ?? 0));
}

function replayFrameX(frame: RawReplayFrameLike): number {
  return Number(frame.mouseX ?? frame.position?.x ?? frame.buttonState ?? 0);
}

function replayFrameY(frame: RawReplayFrameLike): number {
  return Number(frame.mouseY ?? frame.position?.y ?? 0);
}

function isStableDummyStartupFrame(frame: NormalizedReplayFrame): boolean {
  return Math.round(frame.x) === 256 && Math.round(frame.y) === -500;
}

export function getStableManiaReplayKeyState(frame: RawReplayFrameLike): number {
  return Math.round(replayFrameX(frame)) & MANIA_REPLAY_KEY_MASK;
}

export function getStableManiaReplayScrollSpeedScale(rawFrames: RawReplayFrameLike[]): number | null {
  for (const frame of rawFrames) {
    const x = replayFrameX(frame);
    const y = replayFrameY(frame);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.round(x) === 256 && Math.round(y) === -500) continue;
    if (y <= 0) continue;
    return y;
  }

  return null;
}

export function resolveStableManiaReplayScrollSpeed(scale: number | null | undefined, bpm: number | null | undefined): number | null {
  if (scale == null || bpm == null) return null;
  const scrollSpeed = scale * bpm / STABLE_MANIA_SCROLL_SPEED_BPM_SCALE;
  if (!Number.isFinite(scrollSpeed) || scrollSpeed < 1 || scrollSpeed > 40) return null;
  return normalizeReplayScrollSpeed(scrollSpeed);
}

export function decodeStableManiaReplayFrames(rawFrames: RawReplayFrameLike[]): ReplayFrame[] {
  const frames = rawFrames
    .map((frame): NormalizedReplayFrame => {
      const x = replayFrameX(frame);
      const y = replayFrameY(frame);
      return {
        keyState: Math.round(x) & MANIA_REPLAY_KEY_MASK,
        time: replayFrameTime(frame),
        x,
        y,
      };
    })
    .filter((frame) => Number.isFinite(frame.time) && Number.isFinite(frame.x) && Number.isFinite(frame.y));

  // Mirrored from lazer's LegacyScoreDecoder, which cites stable's
  // ReplayWatcher.cs at e53980dd76857ee899f66ce519ba1597e7874f28.
  if (frames.length >= 2 && frames[1].time < frames[0].time) {
    frames[1].time = frames[0].time;
    frames[0].time = 0;
  }

  if (frames.length >= 3 && frames[0].time > frames[2].time) {
    frames[0].time = frames[2].time;
    frames[1].time = frames[2].time;
  }

  if (frames.length >= 2 && isStableDummyStartupFrame(frames[1])) {
    frames.splice(1, 1);
  }

  if (frames.length >= 1 && isStableDummyStartupFrame(frames[0])) {
    frames.splice(0, 1);
  }

  const output: ReplayFrame[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    if (frame.time < previousTime) continue;
    output.push({ time: frame.time, keyState: frame.keyState });
    previousTime = frame.time;
  }

  return output;
}

// Server returns frames as two base64-packed typed arrays (Int32 times, Uint32 keys).
// Unpack into the ReplayFrame[] shape every consumer already expects.
export function unpackReplayFrames(packed: { count: number; times: string; keys: string }): ReplayFrame[] {
  const timesBytes = base64ToBytes(packed.times);
  const keysBytes = base64ToBytes(packed.keys);
  const timesBuf = new ArrayBuffer(timesBytes.byteLength);
  new Uint8Array(timesBuf).set(timesBytes);
  const keysBuf = new ArrayBuffer(keysBytes.byteLength);
  new Uint8Array(keysBuf).set(keysBytes);
  const times = new Int32Array(timesBuf, 0, packed.count);
  const keys = keysBytes.byteLength >= packed.count * Uint32Array.BYTES_PER_ELEMENT
    ? new Uint32Array(keysBuf, 0, packed.count)
    : new Uint16Array(keysBuf, 0, packed.count);
  const out = new Array<ReplayFrame>(packed.count);
  for (let i = 0; i < packed.count; i++) {
    out[i] = { time: times[i], keyState: keys[i] };
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i);
  return out;
}
