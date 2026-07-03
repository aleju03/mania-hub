import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { md5Hex } from "./md5";

function nodeMd5(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

describe("md5Hex", () => {
  it("matches the RFC 1321 test vectors", () => {
    const encoder = new TextEncoder();
    const vectors: Array<[string, string]> = [
      ["", "d41d8cd98f00b204e9800998ecf8427e"],
      ["a", "0cc175b9c0f1b6a831c399e269772661"],
      ["abc", "900150983cd24fb0d6963f7d28e17f72"],
      ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
      ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
      [
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        "d174ab98d277d9f5a5611c2c9f419d9f",
      ],
      [
        "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
        "57edf4a22be3c955ac49da2e2107b67a",
      ],
    ];
    for (const [input, expected] of vectors) {
      expect(md5Hex(encoder.encode(input))).toBe(expected);
    }
  });

  it("handles block-boundary lengths", () => {
    for (const length of [55, 56, 63, 64, 65, 119, 120, 128]) {
      const bytes = new Uint8Array(length).fill(0x41);
      expect(md5Hex(bytes)).toBe(nodeMd5(bytes));
    }
  });

  it("matches node:crypto on random binary input", () => {
    for (const length of [1, 17, 1024, 70000]) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(md5Hex(bytes)).toBe(nodeMd5(bytes));
    }
  });
});
