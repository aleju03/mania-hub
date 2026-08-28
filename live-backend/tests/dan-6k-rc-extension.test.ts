import { describe, expect, it } from "vitest";
import { danTableCeilingFor, danTableLabelFor, danTableLevelForLabel } from "../src/dan/chart-classifier.js";
import { DAN_INDEX } from "../vendor/leoblack/estimator/intervals/index.js";

const rc6K = DAN_INDEX[6].RC.default;

function lookup(sr: number): string | null {
  const row = rc6K.find(([lower, upper]) => lower <= sr && sr <= upper);
  return row ? row[2] : null;
}

// Sunny stars of Arkman's official course marathons at the 2026-08-28
// calibration (the [Regular] diffs; Terra/Celestial from the unsubmitted .osz
// files, the rest from the ranked Part I-III sets). The extension was built so
// every course keeps landing in its own level's "mid" band; if the Sunny
// engine moves under these charts, the table needs recalibrating, not the test.
const COURSE_ANCHORS: Array<[number, string]> = [
  [7.7926, "Regular 9 mid"],
  [8.0101, "Regular Terra mid"],
  [8.3777, "Regular Celestial mid"],
];

describe("6K RC table extension (10th-14th)", () => {
  it("is contiguous and strictly increasing through Finish high", () => {
    expect(rc6K[rc6K.length - 1][2]).toBe("Regular Finish high");
    for (let i = 0; i < rc6K.length; i++) {
      const [lower, upper] = rc6K[i];
      expect(upper).toBeGreaterThan(lower);
      if (i > 0) expect(lower).toBe(rc6K[i - 1][1]);
    }
  });

  it("keeps every official course in its level's mid band", () => {
    for (const [sr, expected] of COURSE_ANCHORS) {
      expect(lookup(sr)).toBe(expected);
    }
  });

  it("numbers the named levels 10-14 and moves the ceiling to 14.5", () => {
    expect(danTableLevelForLabel("terra", "rc", 6)).toBe(10);
    expect(danTableLevelForLabel("celestial", "rc", 6)).toBe(11);
    expect(danTableLevelForLabel("mystery", "rc", 6)).toBe(12);
    expect(danTableLevelForLabel("nihility", "rc", 6)).toBe(13);
    expect(danTableLevelForLabel("finish", "rc", 6)).toBe(14);
    expect(danTableCeilingFor("rc", 6)).toBe(14.5);
    expect(danTableLabelFor(10, "rc", 6)).toBe("terra");
    expect(danTableLabelFor(14, "rc", 6)).toBe("finish");
  });
});
