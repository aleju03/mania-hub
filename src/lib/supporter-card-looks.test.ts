import { describe, expect, it } from "vitest";
import {
  SUPPORTER_FOILS,
  effectiveCardLook,
  parseSupporterLook,
  supporterLookMotif,
  supporterLookSignature,
} from "./supporter-card-looks";
import { cardMotifImageSrc } from "./card-motif";
import { supporterMotifPathForUrl } from "./supporter-motif-art";

const CUSTOM_URL = `https://cdn.mania-tracker.com/supporter-motifs/${"ab".repeat(32)}.webp`;

describe("parseSupporterLook", () => {
  it("reads a look from an object or its JSON", () => {
    expect(parseSupporterLook({ motif: "none", foil: "sunburst" })).toEqual({ motif: "none", foil: "sunburst" });
    expect(parseSupporterLook('{"motif":"none","foil":"glitter"}')).toEqual({ motif: "none", foil: "glitter" });
  });

  it("is null when there is no look", () => {
    for (const value of [null, undefined, "", "not json", 7, [], "[]"]) expect(parseSupporterLook(value)).toBeNull();
  });

  it("still marks a supporter when the fields are unknown to this build", () => {
    expect(parseSupporterLook({ motif: "comets", foil: "neon" })).toEqual({ motif: "none", foil: "holo" });
    expect(parseSupporterLook({})).toEqual({ motif: "none", foil: "holo" });
  });

  it("drops a palette stored before foils, so a card keeps its tier's colours", () => {
    expect(parseSupporterLook({ motif: "none", palette: "gold" })).toEqual({ motif: "none", foil: "holo" });
  });
});

describe("supporterLookMotif", () => {
  it("reads a retired preset doodle as no art, keeping the foil", () => {
    for (const motif of ["stars", "hearts", "notes", "petals", "headphones", "keys", "stellium"]) {
      expect(parseSupporterLook({ motif, foil: "glitter" })).toEqual({ motif: "none", foil: "glitter" });
      expect(supporterLookMotif({ motif, foil: "glitter" } as never)).toBeNull();
    }
  });

  it("is null without a look", () => {
    expect(supporterLookMotif(null)).toBeNull();
  });

  it("floats nothing for no art, and keeps the foil", () => {
    expect(parseSupporterLook({ motif: "none", foil: "glitter" })).toEqual({ motif: "none", foil: "glitter" });
    expect(supporterLookMotif({ motif: "none", foil: "glitter" })).toBeNull();
    expect(effectiveCardLook(null, { motif: "none", foil: "glitter" })).toEqual({ motif: null, foil: "glitter" });
    // No foil keeps the art and lays no light over it.
    const custom = { motif: "custom" as const, url: CUSTOM_URL, foil: "none" as const };
    expect(parseSupporterLook(custom)?.motif).toBe("custom");
    expect(effectiveCardLook(null, custom).foil).toBeNull();
  });

  it("does not resolve a lookalike URL", () => {
    expect(supporterMotifPathForUrl("https://example.com/images/supporter-motifs/stars-2.png")).toBeNull();
  });
});

describe("supporterLookSignature", () => {
  it("is empty without a look and distinct per image and foil", () => {
    expect(supporterLookSignature(null)).toBe("");
    const signatures = new Set<string>();
    for (const foil of SUPPORTER_FOILS) {
      signatures.add(supporterLookSignature({ motif: "none", foil }));
      signatures.add(supporterLookSignature({ motif: "custom", url: CUSTOM_URL, scale: 1, opacity: 0.85, foil }));
    }
    expect(signatures.size).toBe(2 * SUPPORTER_FOILS.length);
  });
});

describe("effectiveCardLook", () => {
  const granted = { url: "https://e.com/a.png", scale: 1, opacity: 1 };

  it("is the plain card without a look or a motif", () => {
    expect(effectiveCardLook(null, null)).toEqual({ motif: null, foil: null });
  });

  it("keeps a holding's own motif, palette included, and does not foil it alone", () => {
    const milestone = { ...granted, palette: "gold" as const };
    expect(effectiveCardLook(milestone, null)).toEqual({ motif: milestone, foil: null });
  });

  it("uses the supporter's motif and foil when the holding has none", () => {
    expect(effectiveCardLook(null, { motif: "custom", url: CUSTOM_URL, foil: "scanline" })).toEqual({
      motif: supporterLookMotif({ motif: "custom", url: CUSTOM_URL, foil: "scanline" }),
      foil: "scanline",
    });
  });

  it("lets the holding's motif win and still foils it", () => {
    expect(effectiveCardLook(granted, { motif: "none", foil: "note-rain" })).toEqual({ motif: granted, foil: "note-rain" });
  });
});

describe("custom supporter images", () => {
  const url = `https://cdn.mania-tracker.com/supporter-motifs/${"ab".repeat(32)}.webp`;

  it("floats the supporter's converted upload at their size and strength", () => {
    expect(parseSupporterLook({ motif: "custom", foil: "aurora", url, scale: 9, opacity: 0 })).toEqual({ motif: "custom", foil: "aurora", url, scale: 3, opacity: 0.2 });
    expect(supporterLookMotif({ motif: "custom", foil: "holo", url, scale: 1.5, opacity: 0.6 })).toEqual({ url, scale: 1.5, opacity: 0.6 });
    expect(cardMotifImageSrc({ url, scale: 1, opacity: 1 })).toBe(`/api/card-motif?src=${encodeURIComponent(url)}`);
  });

  it("reads any image that is not our own upload as no art", () => {
    for (const bad of ["https://evil.example/x.webp", `https://cdn.mania-tracker.com/bbcode/${"ab".repeat(32)}.webp`, `http://cdn.mania-tracker.com/supporter-motifs/${"ab".repeat(32)}.webp`, undefined]) {
      expect(parseSupporterLook({ motif: "custom", foil: "holo", url: bad })).toEqual({ motif: "none", foil: "holo" });
    }
  });

  it("gives every upload, size and strength its own signature", () => {
    const a = supporterLookSignature({ motif: "custom", foil: "holo", url, scale: 1, opacity: 1 });
    expect(a).toMatch(/^custom\.abababababababab\.1\.1:holo$/);
    expect(supporterLookSignature({ motif: "custom", foil: "holo", url, scale: 2, opacity: 1 })).not.toBe(a);
    expect(a.split(":")).toHaveLength(2);
  });
});
