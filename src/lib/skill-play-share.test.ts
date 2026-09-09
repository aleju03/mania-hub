import { expect, it } from "vitest";
import { parseSharedSkillPlaySearch, skillPlaySharePath } from "./skill-play-share";

it("round-trips score identity, chart, keymode and dan/MSD context", () => {
  for (const rating of ["dan:rc", "dan:ln", "Overall", "Technical", "pattern:ln"]) {
    const path = skillPlaySharePath("a player", 123, 4, 101, rating)!;
    const url = new URL(path, "https://mania-tracker.com");
    expect(url.pathname).toBe("/player/a%20player/skills");
    expect(parseSharedSkillPlaySearch(Object.fromEntries(url.searchParams))).toEqual({ score: 123, keys: 4, map: 101, rating });
  }
});

it("does not share an anonymous play or accept arbitrary ratings from a link", () => {
  expect(skillPlaySharePath("player", null, 4, 101, "Overall")).toBeNull();
  expect(parseSharedSkillPlaySearch({ score: 123, keys: 4, map: 101, rating: "fake:40" })).toEqual({});
  expect(parseSharedSkillPlaySearch({ score: "Infinity", keys: 4, map: 101 })).toEqual({});
});
