import { describe, expect, it } from "vitest";
import { findSkinDeadWeight } from "./skin-dead-weight";

const INI = [
  "[General]",
  "Name: Test",
  "[Fonts]",
  "ScorePrefix: fonts\\score",
  "[Mania]",
  "Keys: 4",
  "NoteImage0: 4K/note",
  "NoteImage0L: 4K/tail",
  "StageLeft: stage\\left@2x",
  "Hit300: judge/300",
  "LightingN: lights\\/glow",
].join("\n");

function entries(paths: Array<[string, number]>) {
  return paths.map(([path, bytes]) => ({ path, bytes }));
}

function flagged(paths: Array<[string, number]>, texts: Record<string, string> = { "skin.ini": INI }) {
  return findSkinDeadWeight(entries(paths), texts).files.map((file) => [file.path, file.kind]);
}

describe("findSkinDeadWeight", () => {
  it("keeps every file skin.ini points at, with @2x, frames and font glyphs", () => {
    expect(flagged([
      ["skin.ini", 1],
      ["4K/note.png", 1],
      ["4K/note@2x.png", 1],
      ["4K/tail-0.png", 1],
      ["4K/tail-1@2x.png", 1],
      ["stage/left@2x.png", 1],
      ["judge/300@2x.png", 1],
      ["judge/300-0.png", 1],
      ["lights/glow-0.png", 1],
      ["fonts/score-0.png", 1],
      ["fonts/score-comma@2x.png", 1],
      ["mania-hit300.png", 1],
      ["applause.wav", 1],
    ])).toEqual([]);
  });

  it("flags subfolder files skin.ini never names, such as a copy of the skin inside itself", () => {
    expect(flagged([
      ["skin.ini", 1],
      ["4K/note.png", 1],
      ["4K/note-old.png", 5],
      ["assets/skin.ini", 1],
      ["assets/mania-hit300.png", 9],
      ["judge/alt/300.png", 3],
    ])).toEqual([
      ["assets/mania-hit300.png", "unreferenced"],
      ["4K/note-old.png", "unreferenced"],
      ["judge/alt/300.png", "unreferenced"],
      ["assets/skin.ini", "unreferenced"],
    ]);
  });

  it("flags nested archives, editor leftovers and copy-named root files", () => {
    expect(flagged([
      ["skin.ini", 1],
      ["old version.osk", 50],
      ["stage.psd", 20],
      ["applause.pkf", 4],
      ["Thumbs.db", 2],
      ["mania-hit300.png~", 2],
      ["ranking-panel@2x (1).png", 10],
      ["ranking-panel@2x(2).png", 9],
      ["normal-hitclap - Copy.wav", 3],
      ["ranking-panel@2x.png", 8],
    ])).toEqual([
      ["old version.osk", "archive"],
      ["stage.psd", "leftover"],
      ["ranking-panel@2x (1).png", "copy"],
      ["ranking-panel@2x(2).png", "copy"],
      ["applause.pkf", "leftover"],
      ["normal-hitclap - Copy.wav", "copy"],
      ["Thumbs.db", "leftover"],
      ["mania-hit300.png~", "leftover"],
    ]);
  });

  it("keeps every format of a root sound, since a 0-byte copy can be a silencer", () => {
    expect(flagged([
      ["skin.ini", 1],
      ["failsound.wav", 0],
      ["failsound.mp3", 6],
      ["applause.wav", 25],
      ["applause.ogg", 2],
    ])).toEqual([]);
  });

  it("reads the skin from its folder when the archive wraps it in one", () => {
    const result = findSkinDeadWeight(entries([
      ["My Skin/skin.ini", 1],
      ["My Skin/4K/note.png", 1],
      ["My Skin/extras/note.png", 7],
      ["readme.txt", 1],
    ]), { "My Skin/skin.ini": INI });
    expect(result.files.map((file) => file.path)).toEqual(["My Skin/extras/note.png", "readme.txt"]);
    expect(result.bytes).toBe(8);
  });

  it("keeps sprites a lazer layout names, and flags nothing without a skin.ini", () => {
    expect(flagged(
      [["skin.ini", 1], ["skininfo.json", 1], ["custom/sprite.png", 4]],
      { "skin.ini": INI, "skininfo.json": "{\"Lookup\": \"custom/sprite\"}" },
    )).toEqual([]);
    expect(flagged([["assets/a.png", 4], ["x.osk", 9]], {})).toEqual([]);
  });
});
