import { describe, expect, it } from "vitest";
import { avatarImageSrc } from "./Avatar";

describe("avatarImageSrc", () => {
  it("returns the versioned direct a.ppy.sh URL by default", () => {
    expect(avatarImageSrc("https://a.ppy.sh/12345?1.jpeg", 12345)).toBe(
      "https://a.ppy.sh/12345?1.jpeg",
    );
  });

  it("returns the versioned proxy URL when proxy: true is set (canvas/Three.js)", () => {
    expect(avatarImageSrc("https://a.ppy.sh/12345?1.jpeg", 12345, { proxy: true })).toBe(
      "/api/avatar?u=12345&v=1.jpeg",
    );
  });

  it("derives the user id from the URL when no userId is provided", () => {
    expect(avatarImageSrc("https://a.ppy.sh/9999?2.jpeg")).toBe("https://a.ppy.sh/9999?2.jpeg");
  });

  it("falls through to the original url when no user id can be resolved", () => {
    expect(avatarImageSrc("https://example.com/x.png")).toBe("https://example.com/x.png");
  });
});
