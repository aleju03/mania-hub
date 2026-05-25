#!/usr/bin/env node
// Read-only inspector for osu!stable scores.db.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

interface CliOptions {
  hashes: Set<string>;
  legacyScoreId?: bigint;
  scoreValues: Set<number>;
  scoresDbPath: string;
  versions: Set<number>;
}

export interface StableScoresDb {
  beatmapCount: number;
  dbVersion: number;
  endOffset: number;
  rows: StableScoreRow[];
  totalScores: number;
}

export interface StableScoreRow {
  beatmapHash: string;
  count100: number;
  count300: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  maxCombo: number;
  mode: number;
  mods: number;
  perfect: boolean;
  player: string;
  replayHash: string;
  score: number;
  scoreIndex: number;
  timestamp: bigint;
  unknownScoreId: number;
  legacyScoreId: bigint;
  trailerHex: string;
  version: number;
}

class Reader {
  private readonly buffer: Buffer;
  private offset = 0;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get position(): number {
    return this.offset;
  }

  int32(): number {
    const value = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  int64(): bigint {
    const value = this.buffer.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  byte(): number {
    return this.buffer[this.offset++];
  }

  uint16(): number {
    const value = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  bytes(length: number): Buffer {
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  string(): string {
    const marker = this.byte();
    if (marker === 0) return "";
    if (marker !== 0x0b) {
      throw new Error(`Unexpected string marker 0x${marker.toString(16)} at ${this.offset - 1}`);
    }
    const length = this.uleb128();
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private uleb128(): number {
    let result = 0;
    let shift = 0;

    while (true) {
      const byte = this.byte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  }
}

export async function parseStableScoresDb(scoresDbPath: string): Promise<StableScoresDb> {
  const reader = new Reader(await readFile(scoresDbPath));
  const dbVersion = reader.int32();
  const beatmapCount = reader.int32();
  const rows: StableScoreRow[] = [];
  let totalScores = 0;

  for (let beatmapIndex = 0; beatmapIndex < beatmapCount; beatmapIndex++) {
    const groupHash = reader.string().toLowerCase();
    const scoreCount = reader.int32();

    for (let scoreIndex = 0; scoreIndex < scoreCount; scoreIndex++) {
      const row = parseScoreRow(reader, scoreIndex);
      totalScores++;
      if (row.beatmapHash !== groupHash) {
        throw new Error(`Score hash ${row.beatmapHash} did not match group hash ${groupHash}`);
      }
      rows.push(row);
    }
  }

  return {
    beatmapCount,
    dbVersion,
    endOffset: reader.position,
    rows,
    totalScores,
  };
}

function usage(exitCode = 2): never {
  const output = [
    "Usage: node scripts/stable-scores-db-inspect.ts --scores-db FILE [--hash MD5] [--score N]",
    "",
    "Examples:",
    "  node scripts/stable-scores-db-inspect.ts --scores-db /mnt/c/Users/me/AppData/Local/osu!/scores.db --hash c8c4...",
    "  node scripts/stable-scores-db-inspect.ts --scores-db scores.db --score 696441",
  ].join("\n");
  if (exitCode === 0) console.log(output);
  else console.error(output);
  process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    hashes: new Set(),
    scoreValues: new Set(),
    scoresDbPath: "",
    versions: new Set(),
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--hash") {
      const value = argv[++index]?.toLowerCase();
      if (!value) usage();
      options.hashes.add(value);
    } else if (arg === "--score") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value)) usage();
      options.scoreValues.add(value);
    } else if (arg === "--legacy-score-id") {
      const value = BigInt(argv[++index] ?? "");
      options.legacyScoreId = value;
    } else if (arg === "--scores-db") {
      options.scoresDbPath = argv[++index] ?? "";
      if (!options.scoresDbPath) usage();
    } else if (arg === "--version") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value)) usage();
      options.versions.add(value);
    } else if (arg.startsWith("--")) {
      usage();
    } else if (!options.scoresDbPath) {
      options.scoresDbPath = arg;
    } else {
      usage();
    }
  }

  if (!options.scoresDbPath) usage();
  return options;
}

function rowMatches(row: StableScoreRow, options: CliOptions): boolean {
  if (options.hashes.size > 0 && !options.hashes.has(row.beatmapHash)) return false;
  if (options.scoreValues.size > 0 && !options.scoreValues.has(row.score)) return false;
  if (options.versions.size > 0 && !options.versions.has(row.version)) return false;
  if (options.legacyScoreId != null && row.legacyScoreId !== options.legacyScoreId) return false;
  return true;
}

function parseScoreRow(reader: Reader, scoreIndex: number): StableScoreRow {
  const mode = reader.byte();
  const version = reader.int32();
  const beatmapHash = reader.string().toLowerCase();
  const player = reader.string();
  const replayHash = reader.string().toLowerCase();
  const count300 = reader.uint16();
  const count100 = reader.uint16();
  const count50 = reader.uint16();
  const countGeki = reader.uint16();
  const countKatu = reader.uint16();
  const countMiss = reader.uint16();
  const score = reader.int32();
  const maxCombo = reader.uint16();
  const perfect = reader.byte() !== 0;
  const mods = reader.int32();
  reader.string(); // life bar graph; unused here.
  const timestamp = reader.int64();

  // Modern stable scores.db rows end with a 32-bit id slot followed by the
  // legacy score id as a 64-bit value. Local-only rows commonly use -1 first.
  const unknownScoreId = reader.int32();
  const legacyScoreId = reader.int64();
  const trailerHex = Buffer.alloc(12);
  trailerHex.writeInt32LE(unknownScoreId, 0);
  trailerHex.writeBigInt64LE(legacyScoreId, 4);

  return {
    beatmapHash,
    count100,
    count300,
    count50,
    countGeki,
    countKatu,
    countMiss,
    maxCombo,
    mode,
    mods,
    perfect,
    player,
    replayHash,
    score,
    scoreIndex,
    timestamp,
    unknownScoreId,
    legacyScoreId,
    trailerHex: trailerHex.toString("hex"),
    version,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await parseStableScoresDb(options.scoresDbPath);
  const matches = db.rows.filter((row) => rowMatches(row, options));

  console.log(
    `scores.db version ${db.dbVersion}, beatmaps ${db.beatmapCount}, scores ${db.totalScores}, `
    + `matched ${matches.length}, end offset ${db.endOffset}`,
  );

  for (const row of matches) {
    console.log(
      [
        row.beatmapHash,
        `score=${row.score}`,
        `counts=${row.countGeki}/${row.count300}/${row.countKatu}/${row.count100}/${row.count50}/${row.countMiss}`,
        `player=${row.player}`,
        `version=${row.version}`,
        `mods=${row.mods}`,
        `maxCombo=${row.maxCombo}`,
        `replayHash=${row.replayHash}`,
        `timestamp=${row.timestamp}`,
        `unknownScoreId=${row.unknownScoreId}`,
        `legacyScoreId=${row.legacyScoreId}`,
        `trailer=${row.trailerHex}`,
      ].join(" "),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
