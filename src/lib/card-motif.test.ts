import { describe, expect, it } from "vitest";
import {
  cardMotifImageSrc,
  cardMotifSignature,
  CARD_MOTIF_URL_MAX_CHARS,
  normalizeCardMotifUrl,
  parseCardMotif,
  serializeCardMotif,
} from "./card-motif";

describe("parseCardMotif", () => {
  it("takes an https image with its knobs, filling in the defaults", () => {
    expect(parseCardMotif({ url: "https://example.com/heart.png" })).toEqual({
      url: "https://example.com/heart.png",
      scale: 1,
      opacity: 1,
    });
    expect(parseCardMotif({ url: "https://example.com/a.png", scale: 2.5, opacity: 0.4 })).toEqual({
      url: "https://example.com/a.png",
      scale: 2.5,
      opacity: 0.4,
    });
  });

  it("reads the JSON a row stores", () => {
    expect(parseCardMotif('{"url":"https://example.com/a.png","scale":2,"opacity":0.5}')).toEqual({
      url: "https://example.com/a.png",
      scale: 2,
      opacity: 0.5,
    });
  });

  it("clamps the knobs instead of drawing a card at 400x", () => {
    expect(parseCardMotif({ url: "https://e.com/a.png", scale: 400 })?.scale).toBe(4);
    expect(parseCardMotif({ url: "https://e.com/a.png", scale: -3 })?.scale).toBe(0.25);
    expect(parseCardMotif({ url: "https://e.com/a.png", opacity: 9 })?.opacity).toBe(1);
    expect(parseCardMotif({ url: "https://e.com/a.png", opacity: 0 })?.opacity).toBe(0.05);
    // A knob that is not a number leaves the default rather than NaN.
    expect(parseCardMotif({ url: "https://e.com/a.png", scale: "big" })?.scale).toBe(1);
  });

  it("refuses anything that is not an https URL", () => {
    expect(parseCardMotif({ url: "http://example.com/a.png" })).toBeNull();
    expect(parseCardMotif({ url: "javascript:alert(1)" })).toBeNull();
    expect(parseCardMotif({ url: "data:image/png;base64,AAAA" })).toBeNull();
    expect(parseCardMotif({ url: "example.com/a.png" })).toBeNull();
    expect(parseCardMotif({ url: "" })).toBeNull();
    expect(parseCardMotif({})).toBeNull();
    expect(parseCardMotif(null)).toBeNull();
    expect(parseCardMotif("not json")).toBeNull();
    expect(parseCardMotif([{ url: "https://e.com/a.png" }])).toBeNull();
  });

  it("refuses a URL longer than the column will hold", () => {
    const long = `https://example.com/${"a".repeat(CARD_MOTIF_URL_MAX_CHARS)}.png`;
    expect(normalizeCardMotifUrl(long)).toBeNull();
    expect(parseCardMotif({ url: long })).toBeNull();
  });

  it("round-trips through the stored text", () => {
    const motif = parseCardMotif({ url: "https://e.com/a.png", scale: 1.5, opacity: 0.75 });
    expect(parseCardMotif(serializeCardMotif(motif))).toEqual(motif);
    expect(serializeCardMotif(null)).toBeNull();
  });
});

describe("cardMotifImageSrc", () => {
  it("points at the proxy rather than the source, so the card canvas stays readable", () => {
    const motif = parseCardMotif({ url: "https://example.com/a b.png?v=1" })!;
    expect(cardMotifImageSrc(motif)).toBe("/api/card-motif?src=https%3A%2F%2Fexample.com%2Fa%20b.png%3Fv%3D1");
  });
});

describe("cardMotifSignature", () => {
  it("changes with every knob, so a re-granted motif misses the thumbnail cache", () => {
    const base = parseCardMotif({ url: "https://e.com/a.png", scale: 1, opacity: 1 })!;
    const scaled = parseCardMotif({ url: "https://e.com/a.png", scale: 2, opacity: 1 })!;
    const faded = parseCardMotif({ url: "https://e.com/a.png", scale: 1, opacity: 0.5 })!;
    const other = parseCardMotif({ url: "https://e.com/b.png", scale: 1, opacity: 1 })!;
    const signatures = [base, scaled, faded, other].map(cardMotifSignature);
    expect(new Set(signatures).size).toBe(4);
    expect(cardMotifSignature(null)).toBe("");
    expect(cardMotifSignature(undefined)).toBe("");
  });
});
