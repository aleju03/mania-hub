import { describe, expect, it } from "vitest";
import { shouldKeepPackStageMounted } from "./packs";

describe("pack opening stage", () => {
  it("keeps a committed pack mounted after its purchase makes the next one unaffordable", () => {
    expect(shouldKeepPackStageMounted(true, false)).toBe(true);

    // The server has returned the spent wallet, but PackStage's rip timer has
    // not handed the already-bought cards to RevealStage yet.
    expect(shouldKeepPackStageMounted(false, true)).toBe(true);

    // With no opening in flight, the ordinary unaffordable/countdown screen
    // takes the stage again.
    expect(shouldKeepPackStageMounted(false, false)).toBe(false);
  });
});
