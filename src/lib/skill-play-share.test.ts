import { expect, it } from "vitest";
import { parseSharedSkillPlaySearch, skillPlaySharePath } from "./skill-play-share";

it("round-trips score identity, keymode and dan/MSD context", () => {
  for (const rating of ["dan:rc", "dan:ln", "Overall", "Technical", "JackSpeed", "pattern:ln", "pattern:stream", "Stream"]) {
    const path = skillPlaySharePath("a player", 123, 4, rating)!;
    const url = new URL(path, "https://mania-tracker.com");
    expect(url.pathname).toBe("/player/a%20player/skills");
    expect(parseSharedSkillPlaySearch(Object.fromEntries(url.searchParams))).toEqual({ score: 123, keys: 4, rating });
  }
});

it("keeps the link short", () => {
  expect(skillPlaySharePath("Player", 7452379892, 4, "Overall")).toBe("/player/Player/skills?play=4k-7452379892");
  expect(skillPlaySharePath("Player", 7452379892, 7, "dan:ln")).toBe("/player/Player/skills?play=7k-7452379892-ln-dan");
  expect(skillPlaySharePath("Player", 7452379892, 4, "Technical")).toBe("/player/Player/skills?play=4k-7452379892-technical");
});

it("still opens links in the older format", () => {
  expect(parseSharedSkillPlaySearch({ score: "7452379892", keys: "4", map: "1941077", rating: "Overall" }))
    .toEqual({ score: 7452379892, keys: 4, map: 1941077, rating: "Overall" });
});

it("does not share an anonymous play or accept arbitrary ratings from a link", () => {
  expect(skillPlaySharePath("player", null, 4, "Overall")).toBeNull();
  expect(parseSharedSkillPlaySearch({ score: 123, keys: 4, map: 101, rating: "fake:40" })).toEqual({});
  expect(parseSharedSkillPlaySearch({ score: "Infinity", keys: 4, map: 101 })).toEqual({});
  expect(parseSharedSkillPlaySearch({ play: "4k-123-fake" })).toEqual({});
  expect(parseSharedSkillPlaySearch({ play: "4k-Infinity" })).toEqual({});
});
