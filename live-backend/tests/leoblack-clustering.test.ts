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

  it("keeps sub-10ms-gap windows from giving the sentinel's non-mixed pool a BPM", () => {
    // The shape the mixed-pool fix missed (prod chart 5609748): a non-mixed
    // pool of inverse sentinels plus a few windows whose row gaps are real but
    // tiny (LN tails landing 1ms before the next head, MsPerBeat = gap x 4).
    // Those voted, and 60000 / 4 read as "15000BPM Inverse" on /maps.
    const windows = [
      ...Array.from({ length: 20 }, (_, i) => windowAt(i, { Mixed: false })),
      windowAt(20, { SpecificType: null, Mixed: false, MsPerBeat: 4 }),
      windowAt(21, { SpecificType: null, Mixed: false, MsPerBeat: 4 }),
    ];

    const clusters = calculateClusteredPatterns(windows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].BPM).toBe(0);
    expect(clusters[0].Importance).toBe(0);
  });

  it("keeps an all-tiny-gap pool BPM-less for sentinel-free patterns too", () => {
    // No sentinel involved: grace/stacked rows give Jacks windows 3-10ms
    // MsPerBeat, which used to store labels like "15000BPM Jacks".
    const windows = Array.from({ length: 6 }, (_, i) =>
      windowAt(i, { Pattern: "Jacks", SpecificType: "Longjacks", Mixed: false, MsPerBeat: 4 + (i % 3) }),
    );

    const clusters = calculateClusteredPatterns(windows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].BPM).toBe(0);
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
