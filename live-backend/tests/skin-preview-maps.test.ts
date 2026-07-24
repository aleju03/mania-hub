import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

// The endpoint's only network dependency is the R2 audio probe; stub it so every
// candidate counts as cached and the test exercises the memo layers instead.
vi.mock("../src/audio/beatmap-audio.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/audio/beatmap-audio.js")>();
  return {
    ...original,
    getCachedBeatmapAudioMetadata: vi.fn(async (_config: unknown, beatmapsetId: string, filename: string) => ({
      buffer: null,
      mimeType: "audio/mpeg",
      sizeBytes: 1,
      publicUrl: `https://cdn.test/${beatmapsetId}/${filename}`,
      mp3InMp4: false,
    })),
  };
});

import type { Config } from "../src/config.js";
import { createDb, execBatch, migrate, type Db, type DbStatement } from "../src/db.js";
import { listSkinPreviewMaps, type SkinPreviewMap } from "../src/skins/preview-maps.js";

// One search token yields exactly one full page, so each call memoizes 40 filenames
// and 40 audio-state keys. 105 pages overflow the 4,000-entry caps in preview-maps.ts.
const PAGE_SIZE = 40;
const PAGE_COUNT = 105;

const config = {} as unknown as Config;

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

function pageToken(page: number): string {
  return `bt${String(page).padStart(3, "0")}`;
}

function audioFilenameFor(beatmapId: number): string {
  return `audio-${beatmapId}.mp3`;
}

async function seedDb(): Promise<Db> {
  dir = await mkdtemp(join(tmpdir(), "mania-skin-preview-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);

  const now = new Date().toISOString();
  const statements: DbStatement[] = [];
  for (let page = 0; page < PAGE_COUNT; page += 1) {
    for (let slot = 0; slot < PAGE_SIZE; slot += 1) {
      const beatmapId = 100_000 + page * PAGE_SIZE + slot;
      const beatmapsetId = 900_000 + page * PAGE_SIZE + slot;
      const osu = `osu file format v14\n\n[General]\nAudioFilename: ${audioFilenameFor(beatmapId)}\nMode: 3\n`;
      const raw = Buffer.from(osu, "utf8");
      const compressed = gzipSync(raw);
      statements.push({
        sql: `insert into maps_beatmapsets (beatmapset_id, title, artist, creator, status, global_play_count, updated_at)
              values (?, ?, 'Composer', 'Mapper', 'ranked', ?, ?)`,
        args: [beatmapsetId, `${pageToken(page)} track ${beatmapId}`, 1_000_000 - beatmapId, now],
      });
      statements.push({
        sql: `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, total_length, version, updated_at)
              values (?, ?, 'mania', 'ranked', 4, 4.2, 120, 'Normal', ?)`,
        args: [beatmapId, beatmapsetId, now],
      });
      statements.push({
        sql: `insert into beatmap_osu_files (beatmap_id, beatmapset_id, compression, content_blob, content,
                raw_bytes, compressed_bytes, source, fetched_at, last_used_at)
              values (?, ?, 'gzip', ?, '', ?, ?, 'test', ?, ?)`,
        args: [beatmapId, beatmapsetId, compressed, raw.byteLength, compressed.byteLength, now, now],
      });
    }
  }
  await execBatch(db, statements);
  return db;
}

function expectPage(results: SkinPreviewMap[], page: number): void {
  expect(results).toHaveLength(PAGE_SIZE);
  for (const entry of results) {
    expect(entry.audioFilename).toBe(audioFilenameFor(entry.beatmapId));
    expect(entry.title).toBe(`${pageToken(page)} track ${entry.beatmapId}`);
    expect(entry.keys).toBe(4);
  }
}

describe("skin preview maps", () => {
  it("keeps results correct once the filename and audio-state memos overflow their caps", async () => {
    const db = await seedDb();

    // Walking every page pushes 4,200 beatmaps through both memos.
    for (let page = 0; page < PAGE_COUNT; page += 1) {
      expectPage(await listSkinPreviewMaps(db, config, { q: pageToken(page), limit: PAGE_SIZE }), page);
    }

    // The earliest pages have been evicted by now; re-resolving them from the DB
    // must yield the same rows, never another beatmap's audio filename.
    for (const page of [0, 1, 2]) {
      expectPage(await listSkinPreviewMaps(db, config, { q: pageToken(page), limit: PAGE_SIZE }), page);
    }
    // A page that is still memoized must also be served unchanged.
    expectPage(await listSkinPreviewMaps(db, config, { q: pageToken(PAGE_COUNT - 1), limit: PAGE_SIZE }), PAGE_COUNT - 1);
  }, 120_000);

  it("keeps a negative filename lookup cached without dropping the map into results", async () => {
    const db = await seedDb();
    // A beatmap whose cached .osu carries no AudioFilename header must stay out of
    // the listing on both the miss and the memoized hit.
    const raw = Buffer.from("osu file format v14\n\n[General]\nMode: 3\n", "utf8");
    const compressed = gzipSync(raw);
    const now = new Date().toISOString();
    await execBatch(db, [
      {
        sql: "insert into maps_beatmapsets (beatmapset_id, title, artist, creator, status, global_play_count, updated_at) values (?, ?, 'Composer', 'Mapper', 'ranked', ?, ?)",
        args: [10, "zzq silent set", 5_000_000, now],
      },
      {
        sql: "insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, total_length, version, updated_at) values (?, ?, 'mania', 'ranked', 4, 4.2, 120, 'Normal', ?)",
        args: [10, 10, now],
      },
      {
        sql: `insert into beatmap_osu_files (beatmap_id, beatmapset_id, compression, content_blob, content,
                raw_bytes, compressed_bytes, source, fetched_at, last_used_at)
              values (?, ?, 'gzip', ?, '', ?, ?, 'test', ?, ?)`,
        args: [10, 10, compressed, raw.byteLength, compressed.byteLength, now, now],
      },
    ]);

    expect(await listSkinPreviewMaps(db, config, { q: "zzq" })).toEqual([]);
    expect(await listSkinPreviewMaps(db, config, { q: "zzq" })).toEqual([]);
  });
});
