import { describe, expect, it } from "vitest";
import { detectManiaPatterns } from "./mania-patterns";

describe("detectManiaPatterns", () => {
  it("does not treat bare speed in beatmapset tags as a speed pattern", () => {
    const patterns = detectManiaPatterns(
      "baby laugh jersey funk cut ver ishowspeed i show speed meme",
      ["4K Hard"],
      "BABY LAUGH JERSEY FUNK (CUT VER.)",
    );

    expect(patterns).not.toContain("speed");
  });

  it("still detects specific speedjack tags", () => {
    expect(detectManiaPatterns("speedjack stamina", ["4K Hard"])).toEqual(["speedjack", "stamina"]);
  });

  it("detects speed from difficulty labels", () => {
    expect(detectManiaPatterns("", ["[4K] Speed"], "Example Song")).toEqual(["speed"]);
  });

  it("detects speed from pack titles", () => {
    expect(detectManiaPatterns("", ["At the Speed of Light"], "Speed Pack")).toEqual(["speed"]);
  });
});
