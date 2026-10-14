import { describe, expect, it } from "vitest";
import { packFinishSvg } from "./card-finish-art";
import { cardMotifImageSrc, parseCardMotif } from "./card-motif";
import { cardMotifDataUrl } from "./maniacard-art";
import {
  DEFAULT_SUPPORTER_MOTIF,
  SUPPORTER_MOTIFS,
  SUPPORTER_MOTIF_IDS,
  SUPPORTER_PALETTES,
  effectiveCardLook,
  parseSupporterLook,
  supporterLookMotif,
  supporterLookSignature,
} from "./supporter-card-looks";
import { SUPPORTER_MOTIF_SVGS, supporterMotifUrl } from "./supporter-motif-art";

describe("parseSupporterLook", () => {
  it("reads a look from an object or its JSON", () => {
    expect(parseSupporterLook({ motif: "petals", palette: "aurora" })).toEqual({ motif: "petals", palette: "aurora" });
    expect(parseSupporterLook('{"motif":"notes","palette":null}')).toEqual({ motif: "notes", palette: null });
  });

  it("is null when there is no look", () => {
    for (const value of [null, undefined, "", "not json", 7, [], "[]"]) expect(parseSupporterLook(value)).toBeNull();
  });

  it("still marks a supporter when the fields are unknown to this build", () => {
    expect(parseSupporterLook({ motif: "comets", palette: "neon" })).toEqual({ motif: DEFAULT_SUPPORTER_MOTIF, palette: null });
    expect(parseSupporterLook({})).toEqual({ motif: "stars", palette: null });
  });
});

describe("supporterLookMotif", () => {
  it("maps every motif to a code-native sprite every renderer can draw", async () => {
    expect(SUPPORTER_MOTIFS.map((motif) => motif.id)).toEqual([...SUPPORTER_MOTIF_IDS]);
    for (const id of SUPPORTER_MOTIF_IDS) {
      const motif = supporterLookMotif({ motif: id, palette: null })!;
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

  it("carries the palette when the supporter picked one", () => {
    for (const palette of SUPPORTER_PALETTES) {
      expect(supporterLookMotif({ motif: "stars", palette })?.palette).toBe(palette);
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
  it("is empty without a look and distinct per motif and palette", () => {
    expect(supporterLookSignature(null)).toBe("");
    const signatures = new Set<string>();
    for (const motif of SUPPORTER_MOTIF_IDS) {
      for (const palette of [null, ...SUPPORTER_PALETTES]) signatures.add(supporterLookSignature({ motif, palette }));
    }
    expect(signatures.size).toBe(SUPPORTER_MOTIF_IDS.length * (SUPPORTER_PALETTES.length + 1));
  });
});

describe("effectiveCardLook", () => {
  const granted = { url: "https://e.com/a.png", scale: 1, opacity: 1 };

  it("is the plain card without a look or a motif", () => {
    expect(effectiveCardLook(null, null)).toEqual({ motif: null, foil: false });
  });

  it("keeps a holding's own motif, palette included, and does not foil it alone", () => {
    const milestone = { ...granted, palette: "gold" as const };
    expect(effectiveCardLook(milestone, null)).toEqual({ motif: milestone, foil: false });
  });

  it("uses the supporter's motif and palette when the holding has none", () => {
    expect(effectiveCardLook(null, { motif: "feathers", palette: "ember" })).toEqual({
      motif: supporterLookMotif({ motif: "feathers", palette: "ember" }),
      foil: true,
    });
  });

  it("lets the holding's motif win and still foils it", () => {
    expect(effectiveCardLook(granted, { motif: "hearts", palette: "prismatic" })).toEqual({ motif: granted, foil: true });
  });
});

describe("custom supporter images", () => {
  const url = `https://cdn.mania-tracker.com/supporter-motifs/${"ab".repeat(32)}.webp`;

  it("floats the supporter's converted upload at their size and strength", () => {
    expect(parseSupporterLook({ motif: "custom", palette: "aurora", url, scale: 9, opacity: 0 })).toEqual({ motif: "custom", palette: "aurora", url, scale: 3, opacity: 0.2 });
    expect(supporterLookMotif({ motif: "custom", palette: null, url, scale: 1.5, opacity: 0.6 })).toEqual({ url, scale: 1.5, opacity: 0.6 });
    expect(cardMotifImageSrc({ url, scale: 1, opacity: 1 })).toBe(`/api/card-motif?src=${encodeURIComponent(url)}`);
  });

  it("falls back to the default motif for any image that is not our own upload", () => {
    for (const bad of ["https://evil.example/x.webp", `https://cdn.mania-tracker.com/bbcode/${"ab".repeat(32)}.webp`, `http://cdn.mania-tracker.com/supporter-motifs/${"ab".repeat(32)}.webp`, undefined]) {
      expect(parseSupporterLook({ motif: "custom", palette: null, url: bad })).toEqual({ motif: "stars", palette: null });
    }
  });

  it("gives every upload, size and strength its own signature", () => {
    const a = supporterLookSignature({ motif: "custom", palette: null, url, scale: 1, opacity: 1 });
    expect(a).toMatch(/^custom\.abababababababab\.1\.1:-$/);
    expect(supporterLookSignature({ motif: "custom", palette: null, url, scale: 2, opacity: 1 })).not.toBe(a);
    expect(a.split(":")).toHaveLength(2);
  });
});
