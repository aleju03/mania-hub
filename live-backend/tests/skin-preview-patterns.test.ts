import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, exec, migrate } from "../src/db.js";
import { parseManiaBeatmap } from "../src/dan/beatmap-parser.js";
import { storeCachedBeatmapFile } from "../src/osu/beatmap-file-cache.js";
import {
  drawPreviewPatterns,
  extractShowcaseSnippet,
  resetPreviewPatternCaches,
  SNIPPET_SPAN_MS,
} from "../src/skins/preview-patterns.js";

afterEach(() => {
  resetPreviewPatternCaches();
});

describe("extractShowcaseSnippet", () => {
  it("cuts the busiest stretch out of a chart and anchors it on a note", () => {
    // Sparse for four seconds, then a burst: the snippet has to land on the
    // burst rather than on the first note it meets.
    const quiet = Array.from({ length: 8 }, (_, index) => tap(index % 4, 1000 + index * 500));
    const burst = Array.from({ length: 40 }, (_, index) => tap(index % 4, 6000 + index * 90));
    const snippet = extractShowcaseSnippet(parseManiaBeatmap(chart([...quiet, ...burst])));

    expect(snippet).not.toBeNull();
    expect(snippet?.keys).toBe(4);
    // Times are relative to the frozen instant, and the note being hit sits
    // exactly on it.
    expect(snippet?.notes.some((note) => note.time === 0)).toBe(true);
    expect(Math.min(...(snippet?.notes.map((note) => note.time) ?? []))).toBe(0);
    expect(snippet?.notes.length).toBeGreaterThan(8);
  });

  it("freezes on a hold that is still being held, so the receptor reads pressed", () => {
    const notes = [
      ...Array.from({ length: 12 }, (_, index) => tap(index % 3, 2000 + index * 250)),
      hold(3, 2400, 4200),
      ...Array.from({ length: 12 }, (_, index) => tap(index % 3, 5200 + index * 250)),
    ];
    const snippet = extractShowcaseSnippet(parseManiaBeatmap(chart(notes)));

    expect(snippet).not.toBeNull();
    const held = snippet?.notes.filter((note) => note.time <= 0 && note.endTime > 0) ?? [];
    expect(held).toHaveLength(1);
    expect(held[0].column).toBe(3);
  });

  it("drops what has already scrolled past and keeps the snippet inside its span", () => {
    const notes = Array.from({ length: 60 }, (_, index) => tap(index % 4, 1000 + index * 120));
    const snippet = extractShowcaseSnippet(parseManiaBeatmap(chart(notes)));

    expect(snippet).not.toBeNull();
    for (const note of snippet?.notes ?? []) {
      // Only a held hold may start before the instant; a tap never does.
      if (note.endTime === note.time) expect(note.time).toBeGreaterThanOrEqual(0);
      else expect(note.endTime).toBeGreaterThan(0);
      expect(note.time).toBeLessThanOrEqual(SNIPPET_SPAN_MS);
      expect(note.column).toBeGreaterThanOrEqual(0);
      expect(note.column).toBeLessThan(4);
    }
  });

  it("prefers a stream over a wall of chords that fills as much of the frame", () => {
    // Sixteen 4-note chords against a single-note stream twice as fast: the
    // chords put more notes on the card, the stream puts more of a pattern.
    const chords = Array.from({ length: 16 }, (_, row) =>
      [0, 1, 2, 3].map((column) => tap(column, 2000 + row * 120))).flat();
    const stream = Array.from({ length: 64 }, (_, index) => tap(index % 4, 8000 + index * 60));
    const snippet = extractShowcaseSnippet(parseManiaBeatmap(chart([...chords, ...stream])));

    const times = snippet?.notes.map((note) => note.time) ?? [];
    expect(new Set(times).size).toBe(times.length);
  });

  it("returns nothing for a chart with almost no notes", () => {
    expect(extractShowcaseSnippet(parseManiaBeatmap(chart([tap(0, 1000), tap(1, 1500)])))).toBeNull();
  });
});

describe("drawPreviewPatterns", () => {
  it("deals snippets for the asked keymode from cached charts only", async () => {
    const { db, cleanup } = await setupDb();
    try {
      await seedChart(db, 1001, 4, 6.2, "Artist One", "Song One", "[4K] Insane");
      await seedChart(db, 1002, 4, 5.4, "Artist Two", "Song Two", "[4K] Extra");
      // A 7K chart in the catalog with no cached .osu is not a candidate.
      await seedMeta(db, 1003, 7, 6.9, "Artist Three", "Song Three", "[7K] Extra");

      const drawn = await drawPreviewPatterns(db, { keys: 4, count: 8 });
      expect(drawn.map((snippet) => snippet.beatmapId).sort()).toEqual([1001, 1002]);
      expect(drawn[0].keys).toBe(4);
      expect(drawn[0].notes.length).toBeGreaterThan(0);
      expect(drawn.map((snippet) => snippet.label)).toContain("Artist One - Song One [[4K] Insane]");

      resetPreviewPatternCaches();
      expect(await drawPreviewPatterns(db, { keys: 7, count: 8 })).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("leaves out the charts already on offer", async () => {
    const { db, cleanup } = await setupDb();
    try {
      await seedChart(db, 2001, 4, 6.2, "A", "One", "[4K] a");
      await seedChart(db, 2002, 4, 6.3, "B", "Two", "[4K] b");

      const drawn = await drawPreviewPatterns(db, { keys: 4, count: 8, exclude: [2001] });
      expect(drawn.map((snippet) => snippet.beatmapId)).toEqual([2002]);
    } finally {
      await cleanup();
    }
  });

  it("falls back past the star floor when a keymode has nothing above it", async () => {
    const { db, cleanup } = await setupDb();
    try {
      // 9K barely exists ranked, and a keymode with an empty pool would send
      // the picker back to the one synthetic layout.
      await seedChart(db, 3001, 9, 4.1, "C", "Nine", "[9K] mid", "graveyard");

      const drawn = await drawPreviewPatterns(db, { keys: 9, count: 4 });
      expect(drawn.map((snippet) => snippet.beatmapId)).toEqual([3001]);
    } finally {
      await cleanup();
    }
  });
});

async function setupDb(): Promise<{ db: Awaited<ReturnType<typeof createDb>>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mania-live-preview-patterns-"));
  const db = await createDb({ databaseUrl: `file:${join(dir, "test.db")}` });
  await migrate(db);
  return { db, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function seedMeta(
  db: Awaited<ReturnType<typeof createDb>>,
  beatmapId: number,
  keys: number,
  stars: number,
  artist: string,
  title: string,
  version: string,
  status = "ranked",
): Promise<void> {
  await exec(
    db,
    `insert into maps_beatmapsets (beatmapset_id, title, artist, status, updated_at)
     values (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    [beatmapId, title, artist, status],
  );
  await exec(
    db,
    `insert into maps_beatmaps (beatmap_id, beatmapset_id, mode, status, cs, difficulty_rating, version, updated_at)
     values (?, ?, 'mania', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    [beatmapId, beatmapId, status, keys, stars, version],
  );
}

async function seedChart(
  db: Awaited<ReturnType<typeof createDb>>,
  beatmapId: number,
  keys: number,
  stars: number,
  artist: string,
  title: string,
  version: string,
  status = "ranked",
): Promise<void> {
  await seedMeta(db, beatmapId, keys, stars, artist, title, version, status);
  const notes = Array.from({ length: 80 }, (_, index) => tap(index % keys, 1000 + index * 130, keys));
  notes.push(hold(keys - 1, 3000, 4200, keys));
  await storeCachedBeatmapFile(db, beatmapId, chart(notes, keys), { beatmapsetId: beatmapId, source: "test" });
}

function tap(column: number, time: number, keys = 4): string {
  return `${columnX(column, keys)},192,${time},1,0,0:0:0:0:`;
}

function hold(column: number, time: number, endTime: number, keys = 4): string {
  return `${columnX(column, keys)},192,${time},128,0,${endTime}:0:0:0:0:`;
}

function columnX(column: number, keys: number): number {
  return Math.floor(((column + 0.5) * 512) / keys);
}

function chart(notes: string[], keys = 4): string {
  return `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Metadata]
Title: Snippet Test
Artist: Test
Creator: Mapper
Version: ${keys}K

[Difficulty]
CircleSize:${keys}
OverallDifficulty:8

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${notes.join("\n")}
`;
}
