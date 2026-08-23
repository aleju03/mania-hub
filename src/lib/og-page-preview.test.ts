// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  cacheBustOgPreviewImage,
  parseOgPagePreview,
  sitePreviewRequestUrl,
} from "./og-page-preview";

const ORIGIN = "http://localhost:3000";

describe("sitePreviewRequestUrl", () => {
  it("maps local, production, and relative site URLs onto the current origin", () => {
    expect(sitePreviewRequestUrl("/maps?tab=search", ORIGIN)?.toString())
      .toBe("http://localhost:3000/maps?tab=search");
    expect(sitePreviewRequestUrl("https://mania-tracker.com/replay?uploadId=abc", ORIGIN)?.toString())
      .toBe("http://localhost:3000/replay?uploadId=abc");
    expect(sitePreviewRequestUrl("http://localhost:4173/player/peppy", ORIGIN)?.toString())
      .toBe("http://localhost:3000/player/peppy");
  });

  it("rejects non-site and malformed values", () => {
    expect(sitePreviewRequestUrl("https://example.com/replay", ORIGIN)).toBeNull();
    expect(sitePreviewRequestUrl("not a url", ORIGIN)).toBeNull();
  });
});

describe("parseOgPagePreview", () => {
  it("reads the exact social metadata and resolves a relative image", () => {
    const parsed = parseOgPagePreview(`<!doctype html><html><head>
      <title>Fallback title</title>
      <meta property="og:url" content="http://localhost:3000/replay?scoreId=1">
      <meta property="og:title" content="A replay - Mania Tracker">
      <meta property="og:description" content="Replay description">
      <meta property="og:image" content="/api/og?kind=replay&amp;scoreId=1">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    </head></html>`, `${ORIGIN}/replay?scoreId=1`);

    expect(parsed).toEqual({
      pageUrl: "http://localhost:3000/replay?scoreId=1",
      imageUrl: "http://localhost:3000/api/og?kind=replay&scoreId=1",
      title: "A replay - Mania Tracker",
      description: "Replay description",
      imageWidth: 1200,
      imageHeight: 630,
    });
  });

  it("returns null when the page has no social image", () => {
    expect(parseOgPagePreview("<title>No card</title>", `${ORIGIN}/empty`)).toBeNull();
  });
});

describe("cacheBustOgPreviewImage", () => {
  it("adds a browser cache buster without changing the OG identity fields", () => {
    expect(cacheBustOgPreviewImage(`${ORIGIN}/api/og?kind=replay&scoreId=1`, ORIGIN, 42))
      .toBe("/api/og?kind=replay&scoreId=1&t=42");
  });
});
