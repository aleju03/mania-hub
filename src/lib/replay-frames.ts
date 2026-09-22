import type { ReplayFrame } from "./types";
import { normalizeReplayScrollSpeed } from "./replay-scroll-speed.ts";

// Decoding the raw .osr rows is shared with the backend, which judges
// Companella replays with the same reader the viewer uses.
export {
  MANIA_REPLAY_KEY_MASK,
  decodeStableManiaReplayFrames,
  getStableManiaReplayKeyState,
  getStableManiaReplayScrollSpeedScale,
  type RawReplayFrameLike,
} from "#replay-judge/stable-frames.ts";

const STABLE_MANIA_SCROLL_SPEED_BPM_SCALE = 100;

// Stable normalizes the frame-embedded scroll marker by the EFFECTIVE bpm,
// so rate mods matter: a DT play divides the setting by 1.5x the bpm and an
// HT play by 0.75x. Recovering the player's 1-40 setting has to multiply the
// same rate back in, or an HT replay reads ~33% too fast (a speed-29 HT play
// on a 193bpm map decodes as 39 without it).
export function resolveStableManiaReplayScrollSpeed(
  scale: number | null | undefined,
  bpm: number | null | undefined,
  rate: number = 1,
): number | null {
  if (scale == null || bpm == null || !(rate > 0)) return null;
  const scrollSpeed = scale * bpm * rate / STABLE_MANIA_SCROLL_SPEED_BPM_SCALE;
  if (!Number.isFinite(scrollSpeed) || scrollSpeed < 1 || scrollSpeed > 40) return null;
  return normalizeReplayScrollSpeed(scrollSpeed);
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
