import { describe, expect, it } from "vitest";
import { hasOsuFileHeader, isLikelyBeatmapFile } from "./osu-file-shape";

describe("osu file shape", () => {
  it("accepts converted charts that open with comment lines", () => {
    const file = "// This map was converted using qua2osu\r\n\r\nosu file format v14\r\n\r\n[HitObjects]\r\n64,192,1000,1,0,0:0:0:0:\r\n";
    expect(hasOsuFileHeader(file)).toBe(true);
    expect(isLikelyBeatmapFile(file)).toBe(true);
    expect(isLikelyBeatmapFile("﻿osu file format v14\n[HitObjects]\n")).toBe(true);
  });

  it("still rejects pages that are not beatmaps", () => {
    expect(isLikelyBeatmapFile("<!DOCTYPE html>\n[HitObjects]")).toBe(false);
    expect(isLikelyBeatmapFile("// comment\n<html>[HitObjects]")).toBe(false);
    expect(isLikelyBeatmapFile("osu file format v14\n[General]\n")).toBe(false);
  });
});
