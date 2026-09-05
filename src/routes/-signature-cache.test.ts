// @vitest-environment node
/* A dynamic render sits behind a URL a player pasted into an osu! profile and
   will never edit, so the two things that keep it both fresh and cheap are the
   data version inside the cache key and the ETag derived from it. If those come
   apart, an embed either freezes or re-rasterizes on every profile view. */
import { describe, expect, it } from "vitest";

import { etagMatches, signatureCacheKey, SIGNATURE_CACHE_HEADER } from "./api/signature/$token/$variant";
import { signatureImageDigest } from "../lib/r2-cache";
import { SIGNATURE_RENDER_VERSION } from "../lib/signature-shared";

describe("signatureCacheKey", () => {
  it("is stable for the same inputs", () => {
    expect(signatureCacheKey(42, "maniacard", 1, "abc123"))
      .toBe(signatureCacheKey(42, "maniacard", 1, "abc123"));
  });

  it("changes when the data version moves, which is what re-renders an embed", () => {
    const before = signatureCacheKey(42, "goals", 1, "abc123");
    const after = signatureCacheKey(42, "goals", 1, "def456");
    expect(after).not.toBe(before);
    expect(signatureImageDigest(after)).not.toBe(signatureImageDigest(before));
  });

  it("carries the render version, so a layout change supersedes stored renders", () => {
    expect(signatureCacheKey(42, "skills", 2, "abc123")).toContain(`r${SIGNATURE_RENDER_VERSION}`);
  });

  it("separates users, types and designs", () => {
    const base = signatureCacheKey(42, "skills", 1, "v1");
    expect(signatureCacheKey(43, "skills", 1, "v1")).not.toBe(base);
    expect(signatureCacheKey(42, "dan", 1, "v1")).not.toBe(base);
    expect(signatureCacheKey(42, "skills", 2, "v1")).not.toBe(base);
  });
});

describe("etagMatches", () => {
  const etag = '"0123456789abcdef0123456789abcdef"';

  it("matches an identical strong tag", () => {
    expect(etagMatches(etag, etag)).toBe(true);
  });

  /* Cloudflare downgrades strong ETags to weak when it transforms a response,
     so a weak echo of our own tag still has to revalidate into a 304. */
  it("matches the weak form of the same tag", () => {
    expect(etagMatches(`W/${etag}`, etag)).toBe(true);
  });

  it("matches inside a comma-separated list", () => {
    expect(etagMatches(`"other", W/${etag}`, etag)).toBe(true);
  });

  it("matches the wildcard", () => {
    expect(etagMatches("*", etag)).toBe(true);
  });

  it("does not match a different tag, an empty header, or a missing one", () => {
    expect(etagMatches('"deadbeef"', etag)).toBe(false);
    expect(etagMatches("", etag)).toBe(false);
    expect(etagMatches(null, etag)).toBe(false);
  });

  /* A prefix must not pass: otherwise a stale render could be served forever
     under a tag that merely starts the same way. */
  it("does not match a prefix of the tag", () => {
    expect(etagMatches('"0123456789abcdef"', etag)).toBe(false);
  });
});

describe("SIGNATURE_CACHE_HEADER", () => {
  it("gives the edge a five minute copy", () => {
    expect(SIGNATURE_CACHE_HEADER).toContain("max-age=300");
  });

  /* The trap this header keeps stepping around: RFC 9111 gives `s-maxage` the
     semantics of `proxy-revalidate`, so pairing it with stale-while-revalidate
     means the edge may never serve the stale copy - Cloudflare ignores the
     directive outright. The two must not appear together, and the symptom if
     they do is invisible: every expiry silently becomes a blocking origin
     fetch for whoever arrives first. */
  it("does not pair s-maxage with stale-while-revalidate", () => {
    expect(SIGNATURE_CACHE_HEADER).toContain("stale-while-revalidate=86400");
    expect(SIGNATURE_CACHE_HEADER).not.toContain("s-maxage");
  });

  it("keeps serving a render through an origin outage", () => {
    expect(SIGNATURE_CACHE_HEADER).toContain("stale-if-error=");
  });
});
