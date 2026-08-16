import { describe, expect, it } from "vitest";
import { calculateClusteredPatterns, type LeoBlackFoundPattern } from "../vendor/leoblack/patterns/clustering.js";

// Density/Inverse windows carry MsPerBeat 0 as a "no meaningful tempo"
// sentinel (resolvedMspb in findPatterns.js). The mixed-BPM pool used to
// average those zeros in with real windows, which is how a 148 BPM inverse
// chart's cluster read "~1327BPM Mixed Inverse" on /maps.
const BPM_148_MSPB = 60000 / 148;

function windowAt(index: number, overrides: Partial<LeoBlackFoundPattern>): LeoBlackFoundPattern {
  return {
    Pattern: "Density",
    SpecificType: "Inverse",
    Mixed: true,
    Start: index * 1000,
    End: index * 1000 + 500,
    MsPerBeat: 0,
    ...overrides,
  };
}

describe("LeoBlack pattern clustering", () => {
  it("keeps inverse zero-tempo sentinels from diluting a mixed cluster's BPM", () => {
    // Nine inverse windows (sentinel 0) plus one real chordstream-density
    // window at 148 BPM. Averaging all ten used to yield 60000 / 40.5 = 1481.
    const windows = [
      ...Array.from({ length: 9 }, (_, i) => windowAt(i, {})),
      windowAt(9, { SpecificType: "DCS Density", MsPerBeat: BPM_148_MSPB }),
    ];

    const clusters = calculateClusteredPatterns(windows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].BPM).toBe(148);
    expect(clusters[0].format(1)).toBe("~148BPM Mixed Inverse");
  });

  it("keeps an all-sentinel mixed cluster BPM-less", () => {
    const windows = Array.from({ length: 5 }, (_, i) => windowAt(i, {}));

    const clusters = calculateClusteredPatterns(windows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].BPM).toBe(0);
    // Importance is amount x multiplier x BPM, so a BPM-less cluster cannot
    // outrank real ones - the pre-fix failure was the opposite.
    expect(clusters[0].Importance).toBe(0);
  });

  it("leaves ordinary non-mixed clusters untouched", () => {
    const windows = [
      windowAt(0, { SpecificType: "JS Density", Mixed: false, MsPerBeat: BPM_148_MSPB }),
      windowAt(1, { SpecificType: "JS Density", Mixed: false, MsPerBeat: BPM_148_MSPB + 1 }),
    ];

    const clusters = calculateClusteredPatterns(windows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].BPM).toBe(148);
    expect(clusters[0].Mixed).toBe(false);
  });
});
