import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay player suggestion banners", () => {
  it("uses ranking user cover urls as dim card backgrounds", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const browseSource = fs.readFileSync(path.resolve(__dirname, "../components/replay/ReplayBrowseView.tsx"), "utf8");
    const mapperSource = fs.readFileSync(path.resolve(__dirname, "../lib/osu/mappers.ts"), "utf8");
    const rankingsSource = fs.readFileSync(path.resolve(__dirname, "../lib/osu/rankings.ts"), "utf8");
    const typesSource = fs.readFileSync(path.resolve(__dirname, "../lib/types.ts"), "utf8");

    expect(typesSource).toContain("cover_url: string");
    expect(mapperSource).toContain('cover_url: raw.user.cover?.url ?? raw.user.cover_url ?? ""');
    expect(rankingsSource).toContain("rankings:v4");
    expect(routeSource).toContain("cover_url: entry.user.cover_url");
    expect(browseSource).toContain("backgroundImage: `url(${player.cover_url})`");
    expect(browseSource).toContain("via-osu-b4/80");
  });
});
