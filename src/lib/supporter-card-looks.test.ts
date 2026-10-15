import { describe, expect, it } from "vitest";
import { packFinishSvg } from "./card-finish-art";
import { cardMotifImageSrc, parseCardMotif } from "./card-motif";
import { cardMotifDataUrl } from "./maniacard-art";
import {
  DEFAULT_SUPPORTER_MOTIF,
  SUPPORTER_MOTIFS,
  SUPPORTER_MOTIF_IDS,
  SUPPORTER_FOILS,
  effectiveCardLook,
  parseSupporterLook,
  supporterLookMotif,
  supporterLookSignature,
} from "./supporter-card-looks";
import { SUPPORTER_MOTIF_SVGS, supporterMotifUrl } from "./supporter-motif-art";

describe("parseSupporterLook", () => {
  it("reads a look from an object or its JSON", () => {
    expect(parseSupporterLook({ motif: "petals", foil: "sunburst" })).toEqual({ motif: "petals", foil: "sunburst" });
    expect(parseSupporterLook('{"motif":"notes","foil":"glitter"}')).toEqual({ motif: "notes", foil: "glitter" });
  });

  it("is null when there is no look", () => {
    for (const value of [null, undefined, "", "not json", 7, [], "[]"]) expect(parseSupporterLook(value)).toBeNull();
  });

  it("still marks a supporter when the fields are unknown to this build", () => {
    expect(parseSupporterLook({ motif: "comets", foil: "neon" })).toEqual({ motif: DEFAULT_SUPPORTER_MOTIF, foil: "holo" });
    expect(parseSupporterLook({})).toEqual({ motif: "stars", foil: "holo" });
  });

  it("drops a palette stored before foils, so a card keeps its tier's colours", () => {
    expect(parseSupporterLook({ motif: "stars", palette: "gold" })).toEqual({ motif: "stars", foil: "holo" });
    expect(supporterLookMotif({ motif: "stars", palette: "gold" } as never)?.palette).toBeUndefined();
  });
});

describe("supporterLookMotif", () => {
  it("maps every motif to a code-native sprite every renderer can draw", async () => {
    expect(SUPPORTER_MOTIFS.map((motif) => motif.id)).toEqual([...SUPPORTER_MOTIF_IDS]);
    for (const id of SUPPORTER_MOTIF_IDS) {
      const motif = supporterLookMotif({ motif: id, foil: "holo" })!;
      expect(motif.url).toBe(supporterMotifUrl(id));
      expect(motif.palette).toBeUndefined();
      // It survives the motif parser that every stored and dealt motif goes through.
      expect(parseCardMotif(motif)).toEqual(motif);
      expect(packFinishSvg(motif.url)).toBe(SUPPORTER_MOTIF_SVGS[id]);
      expect(cardMotifImageSrc(motif)).toMatch(/^data:image\/svg\+xml/);
      const inlined = await cardMotifDataUrl(motif);
      expect(Buffer.from(inlined!.dataUrl.split(",")[1], "base64").toString()).toBe(SUPPORTER_MOTIF_SVGS[id]);
    }
  });

  it("is null without a look", () => {
    expect(supporterLookMotif(null)).toBeNull();
  });

  it("does not resolve a lookalike URL", () => {
    expect(packFinishSvg("https://example.com/images/supporter-motifs/stars.svg")).toBeNull();
  });
});

describe("supporterLookSignature", () => {
  it("is empty without a look and distinct per motif and foil", () => {
    expect(supporterLookSignature(null)).toBe("");
    const signatures = new Set<string>();
    for (const motif of SUPPORTER_MOTIF_IDS) {
      for (const foil of SUPPORTER_FOILS) signatures.add(supporterLookSignature({ motif, foil }));
    }
    expect(signatures.size).toBe(SUPPORTER_MOTIF_IDS.length * SUPPORTER_FOILS.length);
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
    expect(effectiveCardLook(null, { motif: "feathers", foil: "scanline" })).toEqual({
      motif: supporterLookMotif({ motif: "feathers", foil: "scanline" }),
      foil: "scanline",
    });
  });

  it("lets the holding's motif win and still foils it", () => {
    expect(effectiveCardLook(granted, { motif: "hearts", foil: "note-rain" })).toEqual({ motif: granted, foil: "note-rain" });
  });
});

describe("custom supporter images", () => {
  const url = `https://cdn.mania-tracker.com/supporter-motifs/${"ab".repeat(32)}.webp`;

  it("floats the supporter's converted upload at their size and strength", () => {
    expect(parseSupporterLook({ motif: "custom", foil: "aurora", url, scale: 9, opacity: 0 })).toEqual({ motif: "custom", foil: "aurora", url, scale: 3, opacity: 0.2 });
    expect(supporterLookMotif({ motif: "custom", foil: "holo", url, scale: 1.5, opacity: 0.6 })).toEqual({ url, scale: 1.5, opacity: 0.6 });
    expect(cardMotifImageSrc({ url, scale: 1, opacity: 1 })).toBe(`/api/card-motif?src=${encodeURIComponent(url)}`);
  });

  it("falls back to the default motif for any image that is not our own upload", () => {
    for (const bad of ["https://evil.example/x.webp", `https://cdn.mania-tracker.com/bbcode/${"ab".repeat(32)}.webp`, `http://cdn.mania-tracker.com/supporter-motifs/${"ab".repeat(32)}.webp`, undefined]) {
      expect(parseSupporterLook({ motif: "custom", foil: "holo", url: bad })).toEqual({ motif: "stars", foil: "holo" });
    }
  });

  it("gives every upload, size and strength its own signature", () => {
    const a = supporterLookSignature({ motif: "custom", foil: "holo", url, scale: 1, opacity: 1 });
    expect(a).toMatch(/^custom\.abababababababab\.1\.1:holo$/);
    expect(supporterLookSignature({ motif: "custom", foil: "holo", url, scale: 2, opacity: 1 })).not.toBe(a);
    expect(a.split(":")).toHaveLength(2);
  });
});
