import { describe, expect, it } from "vitest";
import { teamImageProxyUrl, userCoverProxyUrl } from "./team-image";

const hash = "a".repeat(64);

describe("userCoverProxyUrl", () => {
  it("proxies osu!'s content-hashed profile covers and presets", () => {
    expect(userCoverProxyUrl(`https://assets.ppy.sh/user-profile-covers/39828/${hash}.jpeg`))
      .toBe(`/api/team-image?path=${encodeURIComponent(`user-profile-covers/39828/${hash}.jpeg`)}`);
    expect(userCoverProxyUrl(`https://assets.ppy.sh/user-cover-presets/4/${hash}.jpeg`)).not.toBeNull();
  });

  it("refuses anything else", () => {
    expect(userCoverProxyUrl(`https://assets.ppy.sh/user-profile-covers/39828/short.jpeg`)).toBeNull();
    expect(userCoverProxyUrl(`https://example.com/user-cover-presets/4/${hash}.jpeg`)).toBeNull();
    expect(userCoverProxyUrl(`https://assets.ppy.sh/teams/flag/1/${hash}.png`)).toBeNull();
    expect(teamImageProxyUrl(`https://assets.ppy.sh/teams/flag/1/${hash}.png`)).not.toBeNull();
  });
});
