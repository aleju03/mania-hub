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
    expect(parseSignatureVariant("maniacard-nonsense.png")).toBeNull();
    // A slug is namespaced by its type: the maniacard's card front must not
    // answer on the goals path just because both parse.
    expect(parseSignatureVariant("goals-card-front.png")).toBeNull();
  });

  /* The url a player pasted into an osu! profile is never edited, so every
     address minted before layouts were named has to keep resolving to the
     same layout - including the one whose id no longer matches its position. */
  it("still resolves the numbered urls it used to mint", () => {
    for (const type of SIGNATURE_TYPES) {
      for (const design of signatureDesigns(type)) {
        expect(parseSignatureVariant(`${type}-${design.design}.png`))
          .toEqual({ type, design: design.design });
      }
    }
    expect(parseSignatureVariant("maniacard-4.png")).toEqual({ type: "maniacard", design: 4 });
  });

  it("mints names rather than ids, so the first layout is not 'maniacard-4'", () => {
    expect(signatureVariantSlug("maniacard", 4)).toBe("maniacard-card-front.png");
    expect(signatureImagePath("Kf3q9xZAbCdEfGhIjKlM", "insights", 4))
      .toBe("/api/signature/Kf3q9xZAbCdEfGhIjKlM/insights-pp-distribution.png");
  });

  it("gives every layout a slug that is unique within its type", () => {
    for (const type of SIGNATURE_TYPES) {
      const slugs = signatureDesigns(type).map((entry) => entry.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const slug of slugs) expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
    }
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
    expect(slug).toBe("skills-bars.png");
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

  it("gives each type a handful of designs with unique numbers", () => {
    for (const type of SIGNATURE_TYPES) {
      const designs = SIGNATURE_DESIGNS[type];
      expect(designs.length).toBeGreaterThanOrEqual(2);
      // parseSignatureVariant reads a single digit, so nine is the ceiling.
      expect(designs.length).toBeLessThanOrEqual(9);
      expect(new Set(designs.map((entry) => entry.design)).size).toBe(designs.length);
    }
  });
});

describe("signatureBBCode", () => {
  it("wraps the url in an img tag", () => {
    expect(signatureBBCode("https://mania-tracker.com/a.png")).toBe("[img]https://mania-tracker.com/a.png[/img]");
  });
});
