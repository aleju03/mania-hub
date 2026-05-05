import type { ReplayFrame } from "./types";

// Server returns frames as two base64-packed typed arrays (Int32 times, Uint16 keys).
// Unpack into the ReplayFrame[] shape every consumer already expects.
export function unpackReplayFrames(packed: { count: number; times: string; keys: string }): ReplayFrame[] {
  const timesBytes = base64ToBytes(packed.times);
  const keysBytes = base64ToBytes(packed.keys);
  const timesBuf = new ArrayBuffer(timesBytes.byteLength);
  new Uint8Array(timesBuf).set(timesBytes);
  const keysBuf = new ArrayBuffer(keysBytes.byteLength);
  new Uint8Array(keysBuf).set(keysBytes);
  const times = new Int32Array(timesBuf, 0, packed.count);
  const keys = new Uint16Array(keysBuf, 0, packed.count);
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
