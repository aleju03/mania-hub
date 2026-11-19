import { describe, expect, it } from "vitest";

import { signPlayCard } from "./play-card";
import { profileCardHeight, readProfileCard, signProfileCard } from "./profile-card";

function signed(data: unknown, key = "secret"): [string, string] {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return [payload, signProfileCard(payload, key)];
}

const play = [978, 97.34, "s", "dc,MR,<b>", "Some song", "[7K] Some difficulty", 60];
const profile = {
  u: 7, n: "Some_Player", cc: "cr", pp: 16595, gr: 571, cr: 3, pc: 54406, a: 95.25, pt: 1526, pk: 472,
  rh: [677, 2, -4, -104], rd: 90,
  p: [play, play, play, play, play],
  k: [[7, 30.75, "10+", "gamma-"], [8, 20.82, "", ""], [99, 1, "", ""]],
};

describe("readProfileCard", () => {
  it("reads the backend's profile", () => {
    const [payload, signature] = signed(profile);
    const data = readProfileCard(payload, signature, "secret");
    expect(data).toMatchObject({
      userId: 7, username: "Some_Player", countryCode: "CR", pp: 16595, globalRank: 571, countryRank: 3, playCount: 54406,
      accuracy: 95.25, hoursPlayed: 1526, peakRank: 472, history: [677, 679, 675, 571], historyDays: 90,
    });
    expect(data?.plays).toHaveLength(4);
    expect(data?.plays[0]).toEqual({ pp: 978, accuracy: 97.34, grade: "S", mods: ["dc", "mr"], title: "Some song", version: "[7K] Some difficulty", beatmapsetId: 60 });
    expect(data?.modes).toEqual([
      { keyCount: 7, overall: 30.75, rice: "10+", ln: "gamma-" },
      { keyCount: 8, overall: 20.82, rice: null, ln: null },
    ]);
  });

  it("draws nothing another key signed, another picture's signature opens, or nobody signed", () => {
    const [payload, signature] = signed(profile);
    expect(readProfileCard(payload, signature, "other")).toBeNull();
    expect(readProfileCard(payload, signPlayCard(payload, "secret"), "secret")).toBeNull();
    expect(readProfileCard(payload, null, "secret")).toBeNull();
    expect(readProfileCard(payload, signature, undefined)).toBeNull();
    const [edited] = signed({ ...profile, n: "Someone else" });
    expect(readProfileCard(edited, signature, "secret")).toBeNull();
  });

  it("leaves out a rank history that is not one", () => {
    const [payload, signature] = signed({ ...profile, rh: [10, -20, 5] });
    expect(readProfileCard(payload, signature, "secret")).toMatchObject({ history: [], historyDays: null });
  });
});

describe("profileCardHeight", () => {
  it("adds a line for every three keymodes and shrinks a profile with little on it", () => {
    const read = (data: unknown) => readProfileCard(...signed(data), "secret")!;
    const modes = (count: number) => Array.from({ length: count }, (_, index) => [index + 4, 20, "", ""]);
    expect(profileCardHeight(read({ ...profile, k: [] }))).toBe(540);
    expect(profileCardHeight(read({ ...profile, k: modes(3) }))).toBe(640);
    expect(profileCardHeight(read({ ...profile, k: modes(4) }))).toBe(716);
    expect(profileCardHeight(read({ u: 7, n: "Someone", p: [play], k: [] }))).toBeLessThan(200);
  });
});
