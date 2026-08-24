import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* The Eternal reveal is the one cue on the site that plays a file instead of a
   synth patch, and the file has to stay in step with the ceremony it scores:
   its impact is mixed to land at 0.95s, on the same frame as the burst's
   flash, and it runs the length of ETERNAL_CEREMONY_MS. A silent drift here
   (an asset moved, a re-render at a different length) shows up once per
   collector, on the one card they cannot be dealt again, which is exactly the
   place nobody is going to catch it by playing the game. */

const SAMPLE_PATH = "public/audio/packs/eternal-pull.mp3";
const CEREMONY_MS = 4_400;

/* Duration straight out of the MPEG frame headers. Cheaper than pulling in a
   decoder for one assertion, and it fails loudly on a file that is not an
   MP3 at all rather than guessing. */
function mp3DurationMs(bytes: Buffer): number {
  const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const SAMPLE_RATES_V1 = [44100, 48000, 32000, 0];
  let offset = 0;
  // Skip an ID3v2 tag if one is present.
  if (bytes.length > 10 && bytes.toString("latin1", 0, 3) === "ID3") {
    const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    offset = 10 + size;
  }
  let frames = 0;
  let sampleRate = 0;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const bitrate = BITRATES_V1_L3[(bytes[offset + 2] >> 4) & 0x0f];
    sampleRate = SAMPLE_RATES_V1[(bytes[offset + 2] >> 2) & 0x03];
    if (!bitrate || !sampleRate) {
      offset += 1;
      continue;
    }
    const padding = (bytes[offset + 2] >> 1) & 0x01;
    const frameLength = Math.floor((144000 * bitrate) / sampleRate) + padding;
    if (frameLength <= 0) break;
    frames += 1;
    offset += frameLength;
  }
  // 1152 samples per MPEG-1 Layer III frame.
  return sampleRate ? (frames * 1152 * 1000) / sampleRate : 0;
}

describe("the Eternal reveal cue", () => {
  it("ships, and runs the length of the ceremony", () => {
    const root = path.resolve(__dirname, "../../..");
    const file = path.join(root, SAMPLE_PATH);
    expect(fs.existsSync(file), `${SAMPLE_PATH} is missing`).toBe(true);

    const bytes = fs.readFileSync(file);
    // Small enough that a collector never waits on it, big enough that a
    // truncated or placeholder file is obvious.
    expect(bytes.byteLength).toBeGreaterThan(20_000);
    expect(bytes.byteLength).toBeLessThan(400_000);

    const durationMs = mp3DurationMs(bytes);
    // Within a tenth of a second of the burst's own length: the visual holds
    // the card for CEREMONY_MS and the two are cut to the same clock.
    expect(durationMs).toBeGreaterThan(CEREMONY_MS - 150);
    expect(durationMs).toBeLessThan(CEREMONY_MS + 150);
  });
});
