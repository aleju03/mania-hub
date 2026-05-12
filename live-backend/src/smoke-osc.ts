import { readConfig } from "./config.js";

const config = readConfig();
const url = new URL("/api/scores", config.oscBaseUrl);
url.searchParams.set("mode", "mania");
url.searchParams.set("limit", "10");

const response = await fetch(url);
if (!response.ok) throw new Error(`oSC smoke failed with ${response.status}`);
const body = await response.json() as Array<{ id: number; ruleset_id?: number; user_id: number; beatmap_id?: number }> | { scores?: Array<{ id: number; ruleset_id?: number; user_id: number; beatmap_id?: number }> };
const scores = Array.isArray(body) ? body : body.scores ?? [];
console.log(JSON.stringify({
  ok: true,
  count: scores.length,
  maniaCount: scores.filter((score) => score.ruleset_id === 3 || score.ruleset_id == null).length,
  sample: scores.slice(0, 3),
}, null, 2));
