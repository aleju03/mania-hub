import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetReplayStoryboardUnavailable,
  isReplayStoryboardKnownUnavailable,
  rememberReplayStoryboardUnavailable,
} from "./replay-storyboard";

describe("replay storyboard negative cache", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remembers a known-negative set for seven days", () => {
    const now = 1_000_000_000;
    rememberReplayStoryboardUnavailable(42, now);
    expect(isReplayStoryboardKnownUnavailable(42, now + 6 * 24 * 60 * 60 * 1000)).toBe(true);
    expect(isReplayStoryboardKnownUnavailable(42, now + 8 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("forgets a set when a later response contains a storyboard", () => {
    rememberReplayStoryboardUnavailable(42, 1_000);
    forgetReplayStoryboardUnavailable(42);
    expect(isReplayStoryboardKnownUnavailable(42, 1_001)).toBe(false);
  });
});
