/* Hydrates an archived player's recovered top plays into a real profile
   snapshot.

   Accounts that no longer exist (deleted, or wiped to 0pp) can't be fetched
   from the osu! API, but the *beatmaps* they played still can. This reads a
   recovered top-100 file, pulls live beatmap + beatmapset data for every map,
   and emits a snapshot in the exact shape `profile_snapshots` stores, so the
   profile page and the maniacard render from real difficulty numbers rather
   than invented ones.

   Usage:
     npx tsx scripts/archive/hydrate-archived-player.ts jakads

   Reads  live-backend/seeds/archived-players/<slug>.source.json
   Writes live-backend/seeds/archived-players/<slug>.snapshot.json
*/
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SEED_DIR = resolve(ROOT, "live-backend/seeds/archived-players");

interface SourceScore {
  rank: number;
  pp: number;
  mods: string[];
  accuracy: number;
  max_combo: number;
  misses: number;
  rank_grade: string;
  score: number;
  artist: string;
  title: string;
  version: string;
  stars: number;
  beatmap_id: number;
  beatmapset_id: number;
  score_id: number;
  date: string;
  status: string;
  source: string;
  confidence: string;
}

interface SourceFile {
  user: {
    id: number;
    username: string;
    country_code: string;
    avatar_url: string;
    join_date: string;
    last_visit: string | null;
    is_active: boolean;
    title?: string | null;
    about_html?: string | null;
    about_raw?: string | null;
    statistics: {
      pp: number;
      global_rank: number | null;
      country_rank: number | null;
      hit_accuracy: number;
      ranked_score: number;
      play_count: number;
      play_time?: number;
      total_score?: number;
      total_hits?: number;
      count_300?: number;
      count_100?: number;
      count_50?: number;
      count_miss?: number;
      level?: { current: number; progress: number };
      replays_watched_by_others?: number;
      maximum_combo?: number;
      grade_counts: { ss: number; ssh: number; s: number; sh: number; a: number };
    };
    peak_rank?: { rank: number; date: string } | null;
    scores_first_count?: number;
    archived_note: string;
  };
  scores: SourceScore[];
}

function requireEnv(): { base: string; token: string } {
  const base = process.env.LIVE_BACKEND_URL ?? "http://localhost:7227";
  const token = process.env.LIVE_ADMIN_TOKEN;
  if (!token) throw new Error("LIVE_ADMIN_TOKEN is required (source live-backend/.env).");
  return { base, token };
}

async function osuGet<T>(path: string): Promise<T> {
  const { base, token } = requireEnv();
  const response = await fetch(`${base}/api/osu/v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ path, caller: "archive-hydrate" }),
  });
  if (!response.ok) throw new Error(`osu proxy ${response.status} for ${path}`);
  return response.json() as Promise<T>;
}

interface ApiBeatmap {
  id: number;
  beatmapset_id: number;
  difficulty_rating: number;
  mode: string;
  status: string;
  total_length: number;
  cs: number;
  drain: number;
  accuracy: number;
  ar: number;
  bpm: number;
  convert: boolean;
  count_circles: number;
  count_sliders: number;
  count_spinners: number;
  max_combo?: number;
  checksum?: string | null;
  version: string;
  url: string;
  beatmapset?: Record<string, unknown>;
}

/* mania accuracy from the recovered acc% and miss count is not recoverable
   per-judgement, so statistics carry only what the archive actually recorded:
   the miss count. Everything downstream reads accuracy off the score itself. */
function buildStatistics(source: SourceScore, beatmap: ApiBeatmap) {
  const objects = beatmap.count_circles + beatmap.count_sliders;
  const misses = Math.min(source.misses, objects);
  return { count_miss: misses, miss: misses };
}

function toMods(mods: string[]) {
  return mods
    .flatMap((mod) => mod.split("+"))
    .map((acronym) => acronym.trim())
    .filter(Boolean)
    .map((acronym) => ({ acronym }));
}

async function main() {
  const slug = process.argv[2];
  if (!slug) throw new Error("Usage: hydrate-archived-player.ts <slug>");

  const sourcePath = resolve(SEED_DIR, `${slug}.source.json`);
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as SourceFile;

  const beatmapIds = [...new Set(source.scores.map((score) => score.beatmap_id))];
  console.log(`hydrating ${source.user.username}: ${source.scores.length} scores, ${beatmapIds.length} beatmaps`);

  const beatmaps = new Map<number, ApiBeatmap>();
  const missing: number[] = [];
  for (const [index, id] of beatmapIds.entries()) {
    try {
      const beatmap = await osuGet<ApiBeatmap>(`/beatmaps/${id}`);
      beatmaps.set(id, beatmap);
    } catch (error) {
      missing.push(id);
      console.warn(`  beatmap ${id} unavailable: ${(error as Error).message}`);
    }
    if ((index + 1) % 10 === 0) console.log(`  ${index + 1}/${beatmapIds.length}`);
  }

  const scores = source.scores
    .map((score) => {
      const beatmap = beatmaps.get(score.beatmap_id);
      if (!beatmap) return null;
      const set = (beatmap.beatmapset ?? {}) as Record<string, unknown>;
      return {
        id: score.score_id,
        legacy_score_id: score.score_id,
        user_id: source.user.id,
        accuracy: score.accuracy / 100,
        beatmap_id: score.beatmap_id,
        mods: toMods(score.mods),
        score: score.score,
        legacy_total_score: score.score,
        max_combo: score.max_combo,
        passed: true,
        ranked: score.status === "ranked",
        rank: score.rank_grade,
        statistics: buildStatistics(score, beatmap),
        pp: score.pp,
        beatmap: {
          id: beatmap.id,
          beatmapset_id: beatmap.beatmapset_id,
          difficulty_rating: beatmap.difficulty_rating,
          mode: beatmap.mode,
          status: beatmap.status,
          total_length: beatmap.total_length,
          cs: beatmap.cs,
          drain: beatmap.drain,
          accuracy: beatmap.accuracy,
          ar: beatmap.ar,
          bpm: beatmap.bpm,
          convert: beatmap.convert,
          count_circles: beatmap.count_circles,
          count_sliders: beatmap.count_sliders,
          count_spinners: beatmap.count_spinners,
          max_combo: beatmap.max_combo,
          checksum: beatmap.checksum ?? null,
          version: beatmap.version,
          url: beatmap.url,
        },
        beatmapset: {
          id: beatmap.beatmapset_id,
          title: (set.title as string) ?? score.title,
          artist: (set.artist as string) ?? score.artist,
          creator: (set.creator as string) ?? "",
          covers: (set.covers as Record<string, string>) ?? {},
        },
        user: {
          id: source.user.id,
          username: source.user.username,
          avatar_url: source.user.avatar_url,
          country_code: source.user.country_code,
        },
        ended_at: `${score.date}T00:00:00+00:00`,
        created_at: `${score.date}T00:00:00+00:00`,
        // The archive records neither replay availability nor the lazer/stable
        // origin, and guessing either would show up as a wrong badge.
        has_replay: false,
        type: "solo_score",
      };
    })
    .filter((score): score is NonNullable<typeof score> => score !== null)
    .sort((a, b) => (b.pp ?? 0) - (a.pp ?? 0));

  // osu! weights the top-100 at 0.95^index; the archive's pp are raw values.
  const withWeights = scores.map((score, index) => ({
    ...score,
    weight: { percentage: Math.pow(0.95, index) * 100, pp: (score.pp ?? 0) * Math.pow(0.95, index) },
  }));

  const user = {
    id: source.user.id,
    username: source.user.username,
    avatar_url: source.user.avatar_url,
    country_code: source.user.country_code,
    country: { code: source.user.country_code, name: "" },
    join_date: source.user.join_date,
    last_visit: source.user.last_visit,
    is_active: source.user.is_active,
    is_bot: false,
    is_deleted: false,
    is_online: false,
    is_supporter: false,
    playmode: "mania",
    title: source.user.title ?? null,
    cover: {},
    page: source.user.about_html || source.user.about_raw
      ? { html: source.user.about_html ?? "", raw: source.user.about_raw ?? "" }
      : { html: "", raw: "" },
    statistics: {
      pp: source.user.statistics.pp,
      global_rank: source.user.statistics.global_rank,
      country_rank: source.user.statistics.country_rank,
      rank: { country: source.user.statistics.country_rank },
      hit_accuracy: source.user.statistics.hit_accuracy,
      accuracy: source.user.statistics.hit_accuracy / 100,
      ranked_score: source.user.statistics.ranked_score,
      play_count: source.user.statistics.play_count,
      play_time: source.user.statistics.play_time ?? null,
      total_score: source.user.statistics.total_score ?? 0,
      total_hits: source.user.statistics.total_hits ?? 0,
      count_300: source.user.statistics.count_300 ?? 0,
      count_100: source.user.statistics.count_100 ?? 0,
      count_50: source.user.statistics.count_50 ?? 0,
      count_miss: source.user.statistics.count_miss ?? 0,
      level: source.user.statistics.level ?? { current: 0, progress: 0 },
      replays_watched_by_others: source.user.statistics.replays_watched_by_others ?? 0,
      maximum_combo: source.user.statistics.maximum_combo ?? 0,
      grade_counts: source.user.statistics.grade_counts,
      is_ranked: false,
    },
    rank_highest: source.user.peak_rank
      ? { rank: source.user.peak_rank.rank, updated_at: `${source.user.peak_rank.date}T00:00:00+00:00` }
      : null,
    scores_first_count: source.user.scores_first_count ?? 0,
    scores_best_count: scores.length,
    // Marks the snapshot as reconstructed so refresh paths skip the osu! API
    // instead of 404ing and overwriting it.
    archived: true,
    archived_note: source.user.archived_note,
  };

  const snapshot = {
    user_id: source.user.id,
    username_key: source.user.username.toLowerCase(),
    user,
    best_scores: withWeights,
    best_scores_limit: withWeights.length,
    archived: true,
  };

  await mkdir(SEED_DIR, { recursive: true });
  const outPath = resolve(SEED_DIR, `${slug}.snapshot.json`);
  await writeFile(outPath, `${JSON.stringify(snapshot, null, 1)}\n`, "utf8");

  console.log(`wrote ${outPath}`);
  console.log(`  scores hydrated: ${withWeights.length}/${source.scores.length}`);
  if (missing.length > 0) console.log(`  beatmaps unavailable: ${missing.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
