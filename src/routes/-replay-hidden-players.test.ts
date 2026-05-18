import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("replay hidden players", () => {
  it("filters hidden users from replay browse suggestions and beatmap score lists", () => {
    const routeSource = fs.readFileSync(path.resolve(__dirname, "replay.tsx"), "utf8");

    expect(routeSource).toContain("useHiddenUserIds");
    expect(routeSource).toContain(".filter((entry) => !hiddenUserIds.has(entry.user.id))");
    expect(routeSource).toContain("scores.filter((score) => !hiddenUserIds.has(score.user_id))");
  });
});
