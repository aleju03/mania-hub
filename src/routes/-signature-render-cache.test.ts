// @vitest-environment node
/* The process-local copy of a finished render sits ABOVE the token resolve, so
   it is the one cache that can answer for a signature that has since been
   turned off. Everything here is about the two things that keeps honest: it
   expires on its own, and every write that revokes or moves a signature drops
   it. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSignatureRenderCache,
  forgetSignatureRenders,
  readSignatureRender,
  signatureRenderCacheStats,
  signatureRenderKey,
  storeSignatureRender,
} from "../lib/signature-render-cache";

const TOKEN = "abcdefghijklmnop";
const OTHER = "ponmlkjihgfedcba";

function key(token = TOKEN, type = "maniacard", design = 1): string {
  return signatureRenderKey(token, type, design);
}

afterEach(() => {
  vi.useRealTimers();
  clearSignatureRenderCache();
});

describe("signatureRenderKey", () => {
  it("separates layouts of the same token", () => {
    expect(key(TOKEN, "skills", 1)).not.toBe(key(TOKEN, "skills", 2));
    expect(key(TOKEN, "skills", 1)).not.toBe(key(TOKEN, "dan", 1));
  });

  /* Invalidating one player is a prefix scan, so the token has to lead - a key
     shaped the other way would make forgetSignatureRenders wrong rather than
     slow. */
  it("leads with the token", () => {
    expect(key()).toMatch(/^abcdefghijklmnop:/);
  });
});

describe("storeSignatureRender", () => {
  it("hands the same bytes and etag back", () => {
    const buffer = Buffer.from("render");
    storeSignatureRender(key(), buffer, '"tag"');
    expect(readSignatureRender(key())).toMatchObject({ buffer, etag: '"tag"' });
  });

  it("misses for a key that was never written", () => {
    expect(readSignatureRender(key(OTHER))).toBeNull();
  });

  /* A failed render is never stored anywhere else either; an empty body served
     from here would be a blank embed under a fixed url. */
  it("refuses an empty buffer", () => {
    storeSignatureRender(key(), Buffer.alloc(0), '"tag"');
    expect(readSignatureRender(key())).toBeNull();
  });

  it("expires on its own, without anyone dropping it", () => {
    vi.useFakeTimers();
    storeSignatureRender(key(), Buffer.from("render"), '"tag"');
    vi.advanceTimersByTime(29_000);
    expect(readSignatureRender(key())).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(readSignatureRender(key())).toBeNull();
  });

  it("keeps its byte count straight when a key is overwritten", () => {
    storeSignatureRender(key(), Buffer.alloc(1000), '"one"');
    storeSignatureRender(key(), Buffer.alloc(10), '"two"');
    expect(signatureRenderCacheStats()).toEqual({ entries: 1, bytes: 10 });
  });

  it("evicts rather than growing without bound", () => {
    for (let index = 0; index < 600; index += 1) {
      storeSignatureRender(key(TOKEN, "skills", index), Buffer.alloc(64), `"${index}"`);
    }
    expect(signatureRenderCacheStats().entries).toBeLessThanOrEqual(512);
    // The newest write survives the eviction it triggered.
    expect(readSignatureRender(key(TOKEN, "skills", 599))).not.toBeNull();
  });
});

describe("invalidation", () => {
  it("drops every layout of one token and leaves the rest", () => {
    storeSignatureRender(key(TOKEN, "skills", 1), Buffer.from("a"), '"a"');
    storeSignatureRender(key(TOKEN, "dan", 2), Buffer.from("b"), '"b"');
    storeSignatureRender(key(OTHER, "skills", 1), Buffer.from("c"), '"c"');

    forgetSignatureRenders(TOKEN);

    expect(readSignatureRender(key(TOKEN, "skills", 1))).toBeNull();
    expect(readSignatureRender(key(TOKEN, "dan", 2))).toBeNull();
    expect(readSignatureRender(key(OTHER, "skills", 1))).not.toBeNull();
  });

  /* A token is a prefix of nothing else, but the separator is what guarantees
     that: without it, forgetting one token would take any token that starts
     the same way with it. */
  it("does not take a token that merely starts the same way", () => {
    storeSignatureRender(key(`${TOKEN}extra`), Buffer.from("a"), '"a"');
    forgetSignatureRenders(TOKEN);
    expect(readSignatureRender(key(`${TOKEN}extra`))).not.toBeNull();
  });

  it("ignores an empty token rather than clearing everything", () => {
    storeSignatureRender(key(), Buffer.from("a"), '"a"');
    forgetSignatureRenders("");
    expect(readSignatureRender(key())).not.toBeNull();
  });

  /* Disable and rotate cannot name the old token - it is not in the response -
     so the revoke path takes the whole map. */
  it("clears everything, and resets the byte count with it", () => {
    storeSignatureRender(key(TOKEN), Buffer.alloc(100), '"a"');
    storeSignatureRender(key(OTHER), Buffer.alloc(100), '"b"');
    clearSignatureRenderCache();
    expect(signatureRenderCacheStats()).toEqual({ entries: 0, bytes: 0 });
  });
});
