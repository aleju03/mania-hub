import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay player suggestion banners", () => {
  it("uses ranking user cover urls as dim card backgrounds", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");
    const osuSource = fs.readFileSync(path.resolve(__dirname, "../lib/osu.ts"), "utf8");
    const typesSource = fs.readFileSync(path.resolve(__dirname, "../lib/types.ts"), "utf8");

    expect(typesSource).toContain("cover_url: string");
    expect(osuSource).toContain('cover_url: raw.user.cover?.url ?? raw.user.cover_url ?? ""');
    expect(osuSource).toContain("rankings:v4");
    expect(routeSource).toContain("cover_url: entry.user.cover_url");
    expect(routeSource).toContain("backgroundImage: `url(${p.cover_url})`");
    expect(routeSource).toContain("bg-osu-b4/80");
  });
});
