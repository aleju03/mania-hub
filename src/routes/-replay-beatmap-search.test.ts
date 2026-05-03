import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay beatmap search", () => {
  it("requests relevance-ranked beatmaps for the interactive search UI", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");

    expect(source).toContain('searchBeatmaps({ data: { query: beatmapQuery, sort: "relevance_desc" } })');
    expect(browseSource).toContain('searchBeatmaps({ data: { query: normalizedQuery, sort: "relevance_desc" } })');
  });

  it("keeps selected player identity for per-player beatmap lookup", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");

    expect(routeSource).toContain("const [playerLookupUserId, setPlayerLookupUserId] = useState<number | null>(null)");
    expect(routeSource).toContain("setPlayerLookupUserId(user.id)");
    expect(routeSource).toContain("setPlayerLookupUserId(match.id)");
    expect(routeSource).toContain("playerLookupUserId={playerLookupUserId}");
    expect(browseSource).toContain("if (playerLookupUserId) return playerLookupUserId");
  });

  it("fetches all mania scores for a selected player and beatmap difficulty", () => {
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
    const osuSource = fs.readFileSync(path.resolve(__dirname, "../lib/osu.ts"), "utf8");

    expect(browseSource).toContain("const searchRequestRef = useRef(0)");
    expect(browseSource).toContain("const scoreRequestRef = useRef(0)");
    expect(browseSource).toContain("const PLAYER_BEATMAP_SEARCH_MIN_LENGTH = 3");
    expect(browseSource).toContain("const PLAYER_BEATMAP_SEARCH_DEBOUNCE_MS = 650");
    expect(browseSource).toContain('query.trim().replace(/\\s+/g, " ")');
    expect(browseSource).toContain("if (normalizedQuery === lastSearchedQueryRef.current) return");
    expect(browseSource).toContain("getUserBeatmapScores({ data: { beatmapId, userId } })");
    expect(osuSource).toContain("/beatmaps/${beatmapId}/scores/users/${userId}/all");
    expect(osuSource).toContain('ruleset: "mania"');
  });
});
