import { describe, expect, it } from "vitest";
import { compress } from "lzma-js-simple-v2";

import { readLazerReplayMods } from "./replay-lazer-score";

const LAZER_VERSION = 30000019;
const STABLE_VERSION = 20231019;
const DT_BIT = 1 << 6;

function osuString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length: number[] = [];
  let remaining = bytes.length;
  do {
    const byte = remaining & 0x7f;
    remaining >>>= 7;
    length.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  return Buffer.concat([Buffer.from([0x0b, ...length]), bytes]);
}

function lzma(payload: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    compress(payload, 1, (result, error) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(Buffer.from(Uint8Array.from(result, (byte) => byte & 0xff)));
    });
  });
}

/** A .osr laid out exactly as osu! writes one, with an optional lazer tail. */
async function buildReplay(options: {
  version?: number;
  mods?: number;
  tail?: Buffer | null;
} = {}): Promise<ArrayBuffer> {
  const header = Buffer.alloc(4);
  header.writeInt32LE(options.version ?? LAZER_VERSION);

  const counts = Buffer.alloc(2 * 6 + 4 + 2 + 1 + 4);
  counts.writeInt32LE(options.mods ?? DT_BIT, 2 * 6 + 4 + 2 + 1);

  const frames = await lzma("0|256|-500|0,");
  const frameLength = Buffer.alloc(4);
  frameLength.writeInt32LE(frames.length);

  const tail = options.tail;
  const tailLength = Buffer.alloc(4);
  tailLength.writeInt32LE(tail ? tail.length : 0);

  // Buffer.concat allocates from the shared pool, so hand back a standalone
  // ArrayBuffer rather than a view into whatever else the pool holds.
  const replay = Buffer.concat([
    Buffer.from([3]), // mania
    header,
    osuString("a4f4c3302b0695beefebfce620d14d1d"),
    osuString("Pekkya"),
    osuString("b9411639f405664e76de0e196d66b87c"),
    counts,
    osuString("0|1,"), // life bar graph
    Buffer.alloc(8), // timestamp
    frameLength,
    frames,
    Buffer.alloc(8), // legacy online score id
    ...(tail ? [tailLength, tail] : [tailLength]),
  ]);
  return replay.buffer.slice(replay.byteOffset, replay.byteOffset + replay.byteLength) as ArrayBuffer;
}

describe("readLazerReplayMods", () => {
  it("reads a custom rate the legacy mod bitfield cannot express", async () => {
    const replay = await buildReplay({
      tail: await lzma(JSON.stringify({
        client_version: "2026.807.0-tachyon",
        rank: "S",
        mods: [
          { acronym: "DT", settings: { speed_change: 1.1, adjust_pitch: true } },
          { acronym: "DA", settings: { overall_difficulty: 9.0 } },
        ],
      })),
    });

    // The header says a plain 1.5x DT and knows nothing about DA.
    expect(await readLazerReplayMods(replay)).toEqual([
      { acronym: "DT", settings: { speed_change: 1.1, adjust_pitch: true } },
      { acronym: "DA", settings: { overall_difficulty: 9 } },
    ]);
  });

  it("reads mods that carry no settings", async () => {
    const replay = await buildReplay({
      tail: await lzma(JSON.stringify({ mods: [{ acronym: "DT" }, { acronym: "CL", settings: {} }] })),
    });

    expect(await readLazerReplayMods(replay)).toEqual([{ acronym: "DT" }, { acronym: "CL" }]);
  });

  it("distinguishes a lazer no-mod play from a replay with no block", async () => {
    const noMods = await buildReplay({ mods: 0, tail: await lzma(JSON.stringify({ mods: [] })) });
    expect(await readLazerReplayMods(noMods)).toEqual([]);

    const stable = await buildReplay({ version: STABLE_VERSION, tail: null });
    expect(await readLazerReplayMods(stable)).toBeNull();
  });

  it("returns null for a lazer replay whose block is absent or unreadable", async () => {
    expect(await readLazerReplayMods(await buildReplay({ tail: null }))).toBeNull();
    expect(await readLazerReplayMods(await buildReplay({ tail: Buffer.from("not lzma at all") }))).toBeNull();
    expect(await readLazerReplayMods(await buildReplay({ tail: await lzma("{not json") }))).toBeNull();
    expect(await readLazerReplayMods(await buildReplay({ tail: await lzma('{"mods":"DT"}') }))).toBeNull();
    expect(await readLazerReplayMods(new ArrayBuffer(4))).toBeNull();
  });

  it("refuses a block that declares an implausible decompressed size", async () => {
    const tail = await lzma(JSON.stringify({ mods: [{ acronym: "DT" }] }));
    tail.writeBigUInt64LE(64n * 1024n * 1024n, 5);
    expect(await readLazerReplayMods(await buildReplay({ tail }))).toBeNull();

    const unknownSize = await lzma(JSON.stringify({ mods: [{ acronym: "DT" }] }));
    unknownSize.writeBigUInt64LE(0xffffffffffffffffn, 5);
    expect(await readLazerReplayMods(await buildReplay({ tail: unknownSize }))).toBeNull();
  });

  it("drops setting values that are not scalars", async () => {
    const replay = await buildReplay({
      tail: await lzma(JSON.stringify({ mods: [{ acronym: "FL", settings: { size: [1, 2], combo_based_size: false } }] })),
    });

    expect(await readLazerReplayMods(replay)).toEqual([{ acronym: "FL", settings: { combo_based_size: false } }]);
  });
});
