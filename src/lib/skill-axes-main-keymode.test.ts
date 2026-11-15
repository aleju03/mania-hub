import { describe, expect, it } from "vitest";

import { withMainKeymodeFirst } from "./skill-axes";

describe("withMainKeymodeFirst", () => {
  const modes = [{ keyCount: 7 }, { keyCount: 4 }, { keyCount: 6 }];

  it("moves the chosen keymode to the front and keeps the rest in order", () => {
    expect(withMainKeymodeFirst(modes, 6).map((mode) => mode.keyCount)).toEqual([6, 7, 4]);
  });

  it("leaves the order alone with no choice, or one without ratings", () => {
    expect(withMainKeymodeFirst(modes, null)).toBe(modes);
    expect(withMainKeymodeFirst(modes, 8)).toBe(modes);
    expect(withMainKeymodeFirst(modes, 7)).toBe(modes);
  });
});
