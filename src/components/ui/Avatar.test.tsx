import { describe, expect, it } from "vitest";
import { getAvatarFallbackSrc } from "./Avatar";

describe("Avatar", () => {
  it("falls back from a proxied avatar to the original avatar URL", () => {
    expect(getAvatarFallbackSrc("/api/avatar?u=12345", "https://a.ppy.sh/12345?1.jpeg")).toBe(
      "https://a.ppy.sh/12345?1.jpeg",
    );
  });
});
