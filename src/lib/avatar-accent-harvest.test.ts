import { describe, expect, it } from "vitest";
import { collectAvatarAccentsFromPayload } from "./avatar-accent-harvest";

describe("collectAvatarAccentsFromPayload", () => {
  it("collects camelCase and snake_case pairs anywhere in the payload", () => {
    const payload = {
      ranking: [
        { avatarUrl: "https://a.ppy.sh/1?a.jpeg", avatarAccent: "#ff8899", username: "one" },
        { user: { avatar_url: "https://a.ppy.sh/2?b.jpeg", avatar_accent: "#88ff99" } },
      ],
      nested: { deeper: [{ scores: [{ user: { avatar_url: "https://a.ppy.sh/3?c.jpeg", avatar_accent: "#9988ff" } }] }] },
    };
    const pairs = collectAvatarAccentsFromPayload(payload);
    expect(Object.fromEntries(pairs)).toEqual({
      "https://a.ppy.sh/1?a.jpeg": "#ff8899",
      "https://a.ppy.sh/2?b.jpeg": "#88ff99",
      "https://a.ppy.sh/3?c.jpeg": "#9988ff",
    });
  });

  it("ignores urls with a null or missing accent", () => {
    const payload = [
      { avatarUrl: "https://a.ppy.sh/1?a.jpeg", avatarAccent: null },
      { avatarUrl: "https://a.ppy.sh/2?b.jpeg" },
      { avatar_url: "https://a.ppy.sh/3?c.jpeg", avatar_accent: "" },
    ];
    expect(collectAvatarAccentsFromPayload(payload).size).toBe(0);
  });

  it("handles primitives and empty payloads without throwing", () => {
    expect(collectAvatarAccentsFromPayload(null).size).toBe(0);
    expect(collectAvatarAccentsFromPayload("text").size).toBe(0);
    expect(collectAvatarAccentsFromPayload(42).size).toBe(0);
    expect(collectAvatarAccentsFromPayload({}).size).toBe(0);
  });
});
