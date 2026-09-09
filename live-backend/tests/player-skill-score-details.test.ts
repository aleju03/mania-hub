import { afterEach, expect, it } from "vitest";
import { createDb, exec, migrate, type Db } from "../src/db.js";
import { loadPlayerSkillScoreDetails, playerSkillScoreDetails } from "../src/features/player-skill-score-details.js";
import { getPlayerSkillPlays, PLAYER_SKILLS_VERSION } from "../src/features/player-skills.js";
import type { OscScore } from "../src/shared/types.js";

let db: Db;
afterEach(() => db?.close());

async function setup() {
  db = await createDb({ databaseUrl: "file::memory:" });
  await migrate(db);
  return db;
}

it("serves archived judgments after raw scores are gone, scoped to the correct player and map", async () => {
  await setup();
  const statistics = { count_geki: 3228, count_300: 1501, count_katu: 196, count_100: 13, count_50: 6, count_miss: 19 };
  await exec(db, `insert into player_activity_maps
    (country, user_id, day, beatmap_id, best_score_id, best_solo_score_id, best_statistics_json, best_max_combo, best_total_score, best_rank, updated_at)
    values ('CR', 99, '2025-01-01', 101, 123, 4567891234, ?, 1173, 895710, 'S', '2025-01-01')`, [JSON.stringify(statistics)]);
  const plays = [{ identity: "official:123", beatmapId: 101 }];
  const details = await loadPlayerSkillScoreDetails(db, 99, plays);
  expect(details.get("official:123")).toEqual({ statistics, maxCombo: 1173, totalScore: 895710, rank: "S", scoreUrl: "https://osu.ppy.sh/scores/4567891234" });
  expect((await loadPlayerSkillScoreDetails(db, 100, plays)).size).toBe(0);
  expect((await loadPlayerSkillScoreDetails(db, 99, [{ ...plays[0], beatmapId: 102 }])).size).toBe(0);
});

it("keeps a rated play's compact details even when every other copy has expired", async () => {
  await setup();
  const score = { statistics: { perfect: 900, great: 100 }, maxCombo: 1000, totalScore: 990000, rank: "S", scoreUrl: "https://osu.ppy.sh/scores/4567891234" };
  const plays = Array.from({ length: 205 }, (_, index) => ({
    identity: `official:${index + 1}`, beatmapId: index + 101, keyCount: 4, rate: 1.5,
    goal: 0.96, accuracy: 0.97, pp: 0, values: { Overall: 30 - index / 100, Stream: 25 }, patterns: [], score,
  }));
  await exec(db, `insert into player_skill_ratings (user_id, analysis_version, status, plays_json, updated_at)
    values (99, ?, 'ready', ?, '2026-09-09')`, [PLAYER_SKILLS_VERSION, JSON.stringify({ plays })]);
  expect((await getPlayerSkillPlays(db, 99, 4, "Overall")).total).toBe(200);
  const shared = await getPlayerSkillPlays(db, 99, 4, "Overall", { scoreId: 205 });
  expect(shared.items).toHaveLength(1);
  expect(shared.items[0]).toMatchObject({ scoreId: 205, score, skillRatings: plays[204].values });
  expect((await getPlayerSkillPlays(db, 100, 4, "Overall", { scoreId: 205 })).items).toEqual([]);
});

it("preserves the score URL namespace for modern stable and legacy payloads", () => {
  const modern = { id: 4567891234, type: "solo_score", legacy_score_id: 123, legacy_total_score: 990000, max_combo: 1000, statistics: { perfect: 900, great: 100 }, rank: "S" } as OscScore;
  expect(playerSkillScoreDetails(modern)).toMatchObject({ totalScore: 990000, scoreUrl: "https://osu.ppy.sh/scores/4567891234" });
  expect(playerSkillScoreDetails({ ...modern, id: 123, type: "score" }).scoreUrl).toBe("https://osu.ppy.sh/scores/mania/123");
  expect(playerSkillScoreDetails({ ...modern, type: undefined }).scoreUrl).toBeNull();
});
