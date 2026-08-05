import { describe, expect, it } from "vitest";
import { keyContext, readableName } from "./r2-admin-labels";

describe("readableName", () => {
  it("shortens content-hash filenames to their ends", () => {
    expect(readableName("3ce6ddc2e7a65c42c8a5fc2b442f23cedf57b11d3e1b4a7fdd81b8cfca371566.jpg"))
      .toBe("3ce6ddc2…371566.jpg");
    expect(readableName("f216100c6acac4482a22571bfb4ddfac41008f0efaabd0bf7b045eb4479ecee6.jpg"))
      .toBe("f216100c…9ecee6.jpg");
  });

  it("leaves names that say something alone", () => {
    expect(readableName("12345678.osr")).toBe("12345678.osr");
    expect(readableName("preview-4k.webp")).toBe("preview-4k.webp");
    expect(readableName("Kalibration [4K].osk")).toBe("Kalibration [4K].osk");
    expect(readableName("2043401-mania-4.json.gz")).toBe("2043401-mania-4.json.gz");
  });

  it("keeps hyphenated ids readable rather than treating them as hashes", () => {
    expect(readableName("04fa8bd2-8806-4a1d-b158-7aec5b7e7db6.osk"))
      .toBe("04fa8bd2-8806-4a1d-b158-7aec5b7e7db6.osk");
  });
});

describe("keyContext", () => {
  it("reads the owner out of a maniacard thumbnail key", () => {
    expect(keyContext("maniacards/v2/2043401/abc123.webp")).toBe("v2 · user 2043401");
  });

  it("reads the beatmapset out of a cached asset key", () => {
    expect(keyContext("replay-cache/audio/123456/deadbeef-audio.mp4")).toBe("set 123456");
    expect(keyContext("replay-cache/background/987/deadbeef-bg.jpg")).toBe("set 987");
  });

  it("has nothing to say about flat content-hash keys", () => {
    expect(keyContext("bbcode/3ce6ddc2.jpg")).toBeNull();
    expect(keyContext("maniacards/abc123.webp")).toBeNull();
    expect(keyContext("replay-cache/blob/background/deadbeef.jpg")).toBeNull();
  });
});
