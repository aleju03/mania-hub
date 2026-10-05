// The map info card's audio wave. The backend works out a song's spectrum
// once per distinct song (live-backend/src/audio/audio-wave.ts) and stores it
// beside the song's audio; the viewer only fetches that table and reads the
// levels at the replay's time.

export interface ReplayAudioWave {
  fps: number;
  bands: number;
  /** frames x bands levels, 0 to 255, low bands first. */
  data: Uint8Array;
}

const HEADER_BYTES = 12;

/** Reads the backend's "MHW1" table: magic, fps, bands, reserved, frame count, levels. */
export function decodeReplayAudioWave(bytes: Uint8Array): ReplayAudioWave | null {
  if (bytes.length < HEADER_BYTES || String.fromCharCode(...bytes.subarray(0, 4)) !== "MHW1") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fps = view.getUint8(4);
  const bands = view.getUint8(5);
  const frames = view.getUint32(8, true);
  if (!fps || !bands || bytes.length !== HEADER_BYTES + frames * bands) return null;
  return { fps, bands, data: bytes.subarray(HEADER_BYTES) };
}

/** Levels at a song time, blended between the two nearest frames. */
export function sampleReplayAudioWave(wave: ReplayAudioWave, timeMs: number, out: Float32Array): Float32Array {
  const frames = wave.data.length / wave.bands;
  const position = Math.max(0, timeMs / 1000 * wave.fps);
  const first = Math.min(frames - 1, Math.floor(position));
  const second = Math.min(frames - 1, first + 1);
  const t = position - Math.floor(position);
  for (let band = 0; band < wave.bands; band++) {
    if (first < 0) {
      out[band] = 0;
      continue;
    }
    const a = wave.data[first * wave.bands + band];
    const b = wave.data[second * wave.bands + band];
    out[band] = (a + (b - a) * t) / 255;
  }
  return out;
}

export async function loadReplayAudioWave(url: string, signal?: AbortSignal): Promise<ReplayAudioWave> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Audio wave ${response.status}`);
  const wave = decodeReplayAudioWave(new Uint8Array(await response.arrayBuffer()));
  if (!wave) throw new Error("Unreadable audio wave");
  return wave;
}
