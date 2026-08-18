import { describe, expect, it } from "vitest";
import { parseDan, srToRawDan } from "../src/dan/dan-estimator/labels.js";
import { parseLnDan } from "../src/dan/dan-estimator/ln.js";

describe("dan label calibration", () => {
  it("can bypass family SR calibration for dan course mapping", () => {
    const calibrated = srToRawDan(8.45, "tech");
    const courseRaw = srToRawDan(8.45, "tech", { calibrate: false });

    expect(courseRaw).toBeGreaterThan(calibrated);
    expect(parseDan(courseRaw).label).toBe("epsilon");
  });

  it("keeps negative variants from firing on small offsets", () => {
    expect(parseDan(12.76).displayName).toBe("gamma");
    expect(parseDan(12.54).displayName).toBe("gamma--");
  });

  it("recognizes ratings beyond the 4K LN course ceiling as 15+", () => {
    expect(parseLnDan(15.44).displayName).toBe("LN 15");
    expect(parseLnDan(15.45).displayName).toBe("LN 15+");
    expect(parseLnDan(16).displayName).toBe("LN 15+");
  });
});
