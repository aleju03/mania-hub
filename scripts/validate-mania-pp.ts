// Validates src/lib/mania-pp.ts (+ the mania-star-rating port it depends on)
// against osu!'s official pp values: pulls real leaderboard scores through the
// live backend's /api/osu/v2 proxy, recomputes each score's pp fully locally
// (local star rating + local performance formula + the score's own judgement
// counts), and diffs against the API's pp. Run after osu! ships a mania SR/PP
// rework to check whether either port needs updating.
//
//   npm run validate:mania-pp [-- beatmapId beatmapId...]
//
// Needs LIVE_BACKEND_URL (or VITE_LIVE_BACKEND_URL) and LIVE_ADMIN_TOKEN in
// the root .env. Default ids cover 4K/7K, LN-heavy charts, and std converts.
import { parseManiaBeatmap } from "../src/lib/beatmap-parser";
import { calculateManiaPp, getManiaPpModMultiplier } from "../src/lib/mania-pp";
import { calculateManiaStarRating } from "../src/lib/mania-star-rating";
import { getModAcronyms, getScoreRate } from "../src/lib/score";
import type { OsuMod } from "../src/lib/types";

const DEFAULT_BEATMAP_IDS = [
  941426, // 4K Normal (Sora no Senritsu)
  941428, // 7K Hard (Sora no Senritsu)
  3497635, // 4K LN (FELT LN Collection - Lost in the Abyss)
  2545327, // 7K LN dan (LN Dan Phase III 10th)
  75, // std convert (disco prince)
  129891, // std convert (Freedom Dive)
];

// Local SR is float64 while the official pipeline stores float32-rounded
// attributes, and pp scales with ~SR^2.2; allow a small absolute floor plus a
// relative band before calling something a real drift.
const ABS_TOLERANCE = 0.5;
const REL_TOLERANCE = 0.004;

const KEYMOD_KEYCOUNTS: Record<string, number> = {
  "1K": 1, "2K": 2, "3K": 3, "4K": 4, "5K": 5, "6K": 6, "7K": 7, "8K": 8, "9K": 9, "10K": 10,
};

interface ApiScore {
  id?: number;
  pp?: number | null;
  mods?: OsuMod[];
  user?: { username?: string };
  statistics?: Record<string, number | null | undefined>;
}

const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL || "").replace(/\/+$/, "");
const token = process.env.LIVE_ADMIN_TOKEN ?? "";
if (!base || !token) {
  console.error("LIVE_BACKEND_URL and LIVE_ADMIN_TOKEN are required.");
  process.exit(1);
}

async function proxyJson<T>(path: string, caller: string): Promise<T> {
  const res = await fetch(`${base}/api/osu/v2`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ path, caller, kind: "json" }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function fetchBeatmapFile(beatmapId: number): Promise<string> {
  const res = await fetch(`${base}/api/osu/beatmap-file?beatmapId=${beatmapId}&caller=validate-mania-pp`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`beatmap-file ${beatmapId}: ${res.status}`);
  return res.text();
}

// The proxy can return either legacy (count_geki/...) or lazer-shaped
// (perfect/great/...) statistics depending on score origin; accept both.
function getCounts(statistics: ApiScore["statistics"]) {
  const stat = (lazerKey: string, legacyKey: string) =>
    Math.max(0, Number(statistics?.[lazerKey] ?? statistics?.[legacyKey] ?? 0)) || 0;
  return {
    perfect: stat("perfect", "count_geki"),
    great: stat("great", "count_300"),
    good: stat("good", "count_katu"),
    ok: stat("ok", "count_100"),
    meh: stat("meh", "count_50"),
    miss: stat("miss", "count_miss"),
  };
}

async function main() {
  const argIds = process.argv.slice(2).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const beatmapIds = argIds.length ? argIds : DEFAULT_BEATMAP_IDS;
  let worstAbs = 0;
  let mismatches = 0;
  let checked = 0;

  for (const beatmapId of beatmapIds) {
    const content = await fetchBeatmapFile(beatmapId);
    const parsedByKeyCount = new Map<number | null, ReturnType<typeof parseManiaBeatmap>>();
    const parseWithKeyCount = (keyCount: number | null) => {
      let parsed = parsedByKeyCount.get(keyCount);
      if (!parsed) {
        parsed = parseManiaBeatmap(content, keyCount != null ? { keyCount } : undefined);
        parsedByKeyCount.set(keyCount, parsed);
      }
      return parsed;
    };
    const baseBeatmap = parseWithKeyCount(null);

    const payload = await proxyJson<{ scores?: ApiScore[] }>(`/beatmaps/${beatmapId}/scores?mode=mania`, "validate-mania-pp");
    const scores = (payload.scores ?? []).filter((score) => score.pp != null);
    if (scores.length === 0) {
      console.log(`${beatmapId}: no pp-bearing scores returned, skipping`);
      continue;
    }

    for (const score of scores) {
      const acronyms = getModAcronyms(score.mods);
      // Key mods re-column converts; on mania-specific maps they are unranked
      // (pp would be null), so a keymod score here implies the convert path.
      const keymod = acronyms.find((acronym) => KEYMOD_KEYCOUNTS[acronym] != null);
      const beatmap = keymod && baseBeatmap.isConvert ? parseWithKeyCount(KEYMOD_KEYCOUNTS[keymod]) : baseBeatmap;

      const rate = getScoreRate(score.mods ?? []);
      const starRating = calculateManiaStarRating(beatmap.notes, beatmap.keyCount, rate);
      const local = calculateManiaPp({
        starRating,
        counts: getCounts(score.statistics),
        modMultiplier: getManiaPpModMultiplier(acronyms),
      });

      const official = Number(score.pp);
      const diff = Math.abs(official - local);
      const allowed = Math.max(ABS_TOLERANCE, official * REL_TOLERANCE);
      checked++;
      worstAbs = Math.max(worstAbs, diff);
      if (diff > allowed) mismatches++;
      console.log(
        `${beatmapId} ${beatmap.keyCount}K ${(score.user?.username ?? "?").padEnd(15)} ` +
          `[${acronyms.join(",") || "NM"}] official=${official.toFixed(2)}pp local=${local.toFixed(2)}pp ` +
          `diff=${diff.toFixed(3)}${diff > allowed ? "  <-- MISMATCH" : ""}`,
      );
    }
  }

  console.log(`worst diff: ${worstAbs.toFixed(4)}pp (${mismatches} mismatches over ${checked} scores)`);
  // Explicit exit: vite-node keeps its module server alive otherwise.
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
