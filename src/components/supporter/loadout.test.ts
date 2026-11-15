import { describe, expect, it } from "vitest";
import { withSlot, type Loadout } from "./loadout";

describe("withSlot", () => {
  it("starts another theme with no dim or blur, and keeps them on the same theme", () => {
    const loadout = { theme: "galaxy", themeOptions: { rows: true, dim: 0.5, blur: 0.2 } } as unknown as Loadout;
    expect(withSlot(loadout, "theme", "aurora").themeOptions).toEqual({ rows: true });
    expect(withSlot(loadout, "theme", "galaxy").themeOptions).toEqual({ rows: true, dim: 0.5, blur: 0.2 });
    expect(withSlot(loadout, "frame", null).themeOptions).toEqual({ rows: true, dim: 0.5, blur: 0.2 });
  });
});
