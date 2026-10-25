import { describe, expect, it } from "vitest";

import { readWebpSize } from "./pack-card-thumbnails";

// 240x336 WebPs, one per chunk layout (lossy, lossless, extended with alpha)
const LOSSY = "UklGRtoAAABXRUJQVlA4IM4AAAAwFACdASrwAFABPm02mUmkIqKhICgAgA2JaW7hd2EbQAtLZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5DeAAD+/5fv/Ox7g///9QZ//qDP/9QZ+n/BhdYhQAAAAAAAAAAAAA==";
const LOSSLESS = "UklGRiYAAABXRUJQVlA4TBoAAAAv78BTAAdQs/5Xtf8BAUnS//9hRP8z/vN/sA==";
const EXTENDED = "UklGRggBAABXRUJQVlA4WAoAAAAQAAAA7wAATwEAQUxQSBQAAAABB1DAiAgISJL+/w8j+p/xn/+DBVZQOCDOAAAAMBQAnQEq8ABQAT5tNplJpCKioSAoAIANiWlu4XdhG0ALS2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ3gAA/v+X7/zse4P///UGf/6gz//UGfp/wYXWIUAAAAAAAAAAAAA=";

describe("readWebpSize", () => {
  it("reads every WebP layout", () => {
    for (const data of [LOSSY, LOSSLESS, EXTENDED]) {
      expect(readWebpSize(Buffer.from(data, "base64"))).toEqual({ width: 240, height: 336 });
    }
  });

  it("refuses anything that is not a WebP", () => {
    expect(readWebpSize(Buffer.from("not an image at all, just some bytes"))).toBeNull();
    const png = Buffer.alloc(40);
    png.write("\x89PNG\r\n\x1a\n", "latin1");
    expect(readWebpSize(png)).toBeNull();
  });
});
