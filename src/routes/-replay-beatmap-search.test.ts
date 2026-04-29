import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay beatmap search", () => {
  it("requests relevance-ranked beatmaps for the interactive search UI", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(source).toContain('searchBeatmaps({ data: { query: beatmapQuery, sort: "relevance_desc" } })');
  });
});
