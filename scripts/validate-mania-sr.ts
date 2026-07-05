// Validates src/lib/mania-star-rating.ts (the lazer mania diffcalc port)
// against osu!'s official star ratings from the API attributes endpoint,
// routed through the live backend's /api/osu/v2 proxy. Run this after osu!
// ships a mania difficulty rework to check whether the port needs updating
// (the ported calculator Version is noted in the module header).
//
//   npm run validate:mania-sr [-- beatmapId beatmapId...]
//
// Needs LIVE_BACKEND_URL (or VITE_LIVE_BACKEND_URL) and LIVE_ADMIN_TOKEN in
// the root .env. Default ids cover 4K/7K, LN-heavy charts, and std converts.
import { parseManiaBeatmap } from "../src/lib/beatmap-parser";
import { calculateManiaStarRating } from "../src/lib/mania-star-rating";

const DEFAULT_BEATMAP_IDS = [
  941426, // 4K Normal (Sora no Senritsu)
  941428, // 7K Hard (Sora no Senritsu)
  3497635, // 4K LN (FELT LN Collection - Lost in the Abyss)
  2545327, // 7K LN dan (LN Dan Phase III 10th)
  75, // std convert (disco prince)
  129891, // std convert (Freedom Dive)
];

const CASES: Array<{ mods: string[]; rate: number }> = [
  { mods: [], rate: 1 },
  { mods: ["DT"], rate: 1.5 },
  { mods: ["HT"], rate: 0.75 },
];

// The API returns float32-rounded values; anything past ~1e-4 is a real drift.
const TOLERANCE = 0.005;

const base = (process.env.LIVE_BACKEND_URL || process.env.VITE_LIVE_BACKEND_URL || "").replace(/\/+$/, "");
const token = process.env.LIVE_ADMIN_TOKEN ?? "";
if (!base || !token) {
  console.error("LIVE_BACKEND_URL and LIVE_ADMIN_TOKEN are required.");
  process.exit(1);
}

async function fetchAttributesStarRating(beatmapId: number, mods: string[]): Promise<number> {
  const res = await fetch(`${base}/api/osu/v2`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      path: `/beatmaps/${beatmapId}/attributes`,
      caller: "validate-mania-sr",
      kind: "json",
      body: { mods, ruleset: "mania" },
    }),
  });
  if (!res.ok) throw new Error(`attributes ${beatmapId} [${mods.join(",")}]: ${res.status} ${await res.text()}`);
  const data = await res.json() as { attributes?: { star_rating?: number } };
  const starRating = Number(data.attributes?.star_rating);
  if (!Number.isFinite(starRating)) throw new Error(`attributes ${beatmapId}: no star_rating in response`);
  return starRating;
}

async function fetchBeatmapFile(beatmapId: number): Promise<string> {
  const res = await fetch(`${base}/api/osu/beatmap-file?beatmapId=${beatmapId}&caller=validate-mania-sr`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`beatmap-file ${beatmapId}: ${res.status}`);
  return res.text();
}

async function main() {
  const argIds = process.argv.slice(2).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const beatmapIds = argIds.length ? argIds : DEFAULT_BEATMAP_IDS;
  let worst = 0;
  let mismatches = 0;

  for (const beatmapId of beatmapIds) {
    const beatmap = parseManiaBeatmap(await fetchBeatmapFile(beatmapId));
    for (const testCase of CASES) {
      const official = await fetchAttributesStarRating(beatmapId, testCase.mods);
      const local = calculateManiaStarRating(beatmap.notes, beatmap.keyCount, testCase.rate);
      const diff = Math.abs(official - local);
      worst = Math.max(worst, diff);
      if (diff > TOLERANCE) mismatches++;
      console.log(
        `${beatmapId} ${beatmap.keyCount}K rate=${testCase.rate} official=${official.toFixed(4)} local=${local.toFixed(4)} diff=${diff.toFixed(5)}${diff > TOLERANCE ? "  <-- MISMATCH" : ""}`,
      );
    }
  }

  console.log(`worst diff: ${worst.toFixed(6)} (${mismatches} mismatches over ${beatmapIds.length * CASES.length} checks)`);
  // Explicit exit: vite-node keeps its module server alive otherwise.
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
