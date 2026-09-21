import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { compactScoresForStorage, hydrateScoresDisplayMetadata, persistScoresDisplayMetadata } from "../src/shared/score-storage.js";
import type { OscScore } from "../src/shared/types.js";

let db: Db;
const at = "2026-09-20T12:00:00.000Z";
function score(maxCombo: number | null | undefined): OscScore {
  return {
    id: 1, user_id: 99, pp: 200, accuracy: 0.99, max_combo: 900, statistics: { count_geki: 890, count_300: 10 },
    mods: [], score: 990000, passed: true, rank: "S", type: "score", created_at: at,
    beatmap: { id: 7, beatmapset_id: 7, mode: "mania", difficulty_rating: 6, cs: 4, bpm: 180, accuracy: 8, drain: 6,
      total_length: 120, count_circles: 900, count_sliders: 100, version: "4K", url: "https://osu.ppy.sh/beatmaps/7",
      ...(maxCombo === undefined ? {} : { max_combo: maxCombo as number }) },
    beatmapset: { id: 7, title: "Song", artist: "Artist", covers: {} },
  } as OscScore;
}

beforeEach(async () => {
  db = await createDb({ databaseUrl: ":memory:" });
  await migrate(db);
});
afterEach(() => db.close());

describe("beatmap max_combo storage", () => {
  it("keeps a stored max_combo when an osu! score payload carries null, and fills it back in on hydration", async () => {
    await persistScoresDisplayMetadata(db, [score(1200)], at);
    await persistScoresDisplayMetadata(db, [score(null)], at);
    expect((await exec(db, "select max_combo from beatmaps where beatmap_id = 7")).rows[0].max_combo).toBe(1200);

    const [fresh] = await hydrateScoresDisplayMetadata(db, [score(null)]);
    expect(fresh.beatmap?.max_combo).toBe(1200);
    const [stored] = await hydrateScoresDisplayMetadata(db, compactScoresForStorage([score(null)]));
    expect(stored.beatmap?.max_combo).toBe(1200);
  });

  it("does not override a payload that carries its own max_combo", async () => {
    await persistScoresDisplayMetadata(db, [score(1200)], at);
    const [hydrated] = await hydrateScoresDisplayMetadata(db, [score(1300)]);
    expect(hydrated.beatmap?.max_combo).toBe(1300);
  });
});
