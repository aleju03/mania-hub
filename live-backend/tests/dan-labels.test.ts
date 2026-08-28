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

  it("labels the extra-level LN courses as themselves", () => {
    // 16 is Yokaze and 17 is Yeehee, both real courses, so neither folds into
    // the level below it.
    expect(parseLnDan(16).displayName).toBe("LN 16");
    expect(parseLnDan(17).displayName).toBe("LN 17");
  });

  it("uses parseDan's variant bands, unlike the earlier plain-and-plus labeler", () => {
    // 13.62 is a player average under 14, and prints that way now.
    expect(parseLnDan(13.62).displayName).toBe("LN 14-");
    expect(parseLnDan(13.52).displayName).toBe("LN 14--");
    expect(parseLnDan(13.2).displayName).toBe("LN 13+");
    expect(parseLnDan(13.3).displayName).toBe("LN 13++");
  });

  it("recognizes ratings beyond the 4K LN course ceiling", () => {
    expect(parseLnDan(17.44).displayName).toBe("LN 17++");
    expect(parseLnDan(19).displayName).toBe("LN 17++");
  });
});
