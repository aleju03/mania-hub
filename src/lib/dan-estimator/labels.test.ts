import { describe, expect, it } from "vitest";
import { parseDan, srToRawDan } from "./labels";

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
});
