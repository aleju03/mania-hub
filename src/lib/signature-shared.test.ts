/* The variant allowlist is a security boundary, not a convenience: the render
   route validates against it before it resolves a token or touches R2, and
   that check is what bounds how many distinct PNGs a caller can make us store
   and rasterize. */
import { describe, expect, it } from "vitest";

import {
  parseSignatureVariant,
  signatureBBCode,
  signatureDesigns,
  signatureImagePath,
  signatureVariantSlug,
  SIGNATURE_DESIGNS,
  SIGNATURE_MAX_WIDTH,
  SIGNATURE_TYPES,
} from "./signature-shared";

describe("parseSignatureVariant", () => {
  it("accepts every declared variant", () => {
    for (const type of SIGNATURE_TYPES) {
      for (const design of signatureDesigns(type)) {
        expect(parseSignatureVariant(signatureVariantSlug(type, design.design)))
          .toEqual({ type, design: design.design });
      }
    }
  });

  it("refuses a design the type does not declare", () => {
    expect(parseSignatureVariant("maniacard-9.png")).toBeNull();
    // Every type currently stops at 3, so 4 is past the end rather than junk.
    expect(parseSignatureVariant("goals-4.png")).toBeNull();
  });

  it("refuses anything that is not an exact variant slug", () => {
    expect(parseSignatureVariant("maniacard-1")).toBeNull();
    expect(parseSignatureVariant("MANIACARD-1.png")).toBeNull();
    expect(parseSignatureVariant("maniacard-1.png?x=1")).toBeNull();
    expect(parseSignatureVariant("maniacard-1.PNG")).toBeNull();
    expect(parseSignatureVariant("../../etc/passwd")).toBeNull();
    expect(parseSignatureVariant("unknown-1.png")).toBeNull();
    expect(parseSignatureVariant("")).toBeNull();
    expect(parseSignatureVariant("maniacard-0.png")).toBeNull();
  });

  it("round-trips through the published image path", () => {
    const path = signatureImagePath("Kf3q9xZAbCdEfGhIjKlM", "skills", 2);
    const slug = path.split("/").pop()!;
    expect(parseSignatureVariant(slug)).toEqual({ type: "skills", design: 2 });
  });
});

describe("design dimensions", () => {
  /* osu! renders an [img] at the file's intrinsic width and caps at the
     profile column, so anything wider is silently scaled down and stops
     matching what the preview promised. */
  it("never exceeds the osu! profile column", () => {
    for (const type of SIGNATURE_TYPES) {
      for (const design of SIGNATURE_DESIGNS[type]) {
        expect(design.width).toBeLessThanOrEqual(SIGNATURE_MAX_WIDTH);
        expect(design.height).toBeGreaterThan(0);
      }
    }
  });

  it("gives each type two or three designs with unique numbers", () => {
    for (const type of SIGNATURE_TYPES) {
      const designs = SIGNATURE_DESIGNS[type];
      expect(designs.length).toBeGreaterThanOrEqual(2);
      expect(designs.length).toBeLessThanOrEqual(3);
      expect(new Set(designs.map((entry) => entry.design)).size).toBe(designs.length);
    }
  });
});

describe("signatureBBCode", () => {
  it("wraps the url in an img tag", () => {
    expect(signatureBBCode("https://mania-tracker.com/a.png")).toBe("[img]https://mania-tracker.com/a.png[/img]");
  });
});
