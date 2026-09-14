import { describe, expect, it } from "vitest";
import { msdHeadline } from "../src/dan/msd-headline.js";

describe("msdHeadline", () => {
  it("headlines the LN value when it is the hardest axis of a 4K LN chart", () => {
    expect(msdHeadline({ Overall: 21.4, Stamina: 21.01, LN: 22.29 }, 4, true)).toBe(22.29);
  });

  it("keeps Overall when it is above the LN value", () => {
    expect(msdHeadline({ Overall: 23, LN: 22.29 }, 4, true)).toBe(23);
  });

  it("ignores a diagnostic LN value on a chart without LN identity", () => {
    expect(msdHeadline({ Overall: 21.4, LN: 22.29 }, 4, false)).toBe(21.4);
  });

  it("leaves rice charts and other keymodes on Overall", () => {
    expect(msdHeadline({ Overall: 21.4, LN: 0 }, 4, true)).toBe(21.4);
    expect(msdHeadline({ Overall: 21.4, LN: 22.29 }, 7, true)).toBe(21.4);
  });
});
