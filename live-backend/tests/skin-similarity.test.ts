import { describe, expect, it } from "vitest";
import {
  normalizeSkinVisualSignature,
  SKIN_SIMILARITY_FLOOR,
  skinSimilarity,
  skinSimilarityMatch,
  type SkinKeymodeVisual,
  type SkinSimilarityFacts,
  type SkinVisualSignature,
} from "../src/skins/similarity.js";

const BASE: SkinSimilarityFacts = { author: "sona", keymodes: [4], accentColor: "#ff66aa", visual: null };

// A wide bar note: full 8x8 mask, 4:1 aspect.
const BAR_ART: SkinKeymodeVisual = { aspect: 4, mask: "9".repeat(64), colors: ["#ffffff", "#66ccff"], accents: ["#66ccff"], sat: 0.4 };
// A round note: square aspect, corners empty.
const CIRCLE_ART: SkinKeymodeVisual = { aspect: 1, mask: circleMask(), colors: ["#ffffff", "#66ccff"], accents: ["#66ccff"], sat: 0.4 };

const BAR: SkinVisualSignature = { v: 3, keymodes: { "4": BAR_ART } };
const CIRCLE: SkinVisualSignature = { v: 3, keymodes: { "4": CIRCLE_ART } };

function circleMask(): string {
  let mask = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      mask += Math.hypot(x - 3.5, y - 3.5) <= 3.5 ? "9" : "0";
    }
  }
  return mask;
}

describe("skinSimilarity with note-art signatures", () => {
  it("scores a signature twin at the top of the scale", () => {
    expect(skinSimilarity({ ...BASE, visual: BAR }, { ...BASE, visual: BAR })).toBeCloseTo(1);
  });

  it("gates on note shape: circles are never lookalikes of bars", () => {
    // Identical palettes, identical keymodes - the exact failure this exists
    // for: a circle skin sharing colours with a bar skin must stay under the
    // floor, whatever else agrees.
    const barVsCircle = skinSimilarity(
      { ...BASE, author: "sona", visual: BAR },
      { ...BASE, author: "nova", visual: CIRCLE },
    );
    expect(barVsCircle).toBeLessThan(SKIN_SIMILARITY_FLOOR);

    // Two bar skins with slightly different proportions stay well above it.
    const barVsBar = skinSimilarity(
      { ...BASE, author: "sona", visual: BAR },
      { ...BASE, author: "nova", visual: { v: 3, keymodes: { "4": { ...BAR_ART, aspect: 2.8 } } } },
    );
    expect(barVsBar).toBeGreaterThan(SKIN_SIMILARITY_FLOOR);
    expect(barVsBar).toBeGreaterThan(barVsCircle);
  });

  it("judges keymode against its own keymode, so one agreeable one cannot carry a pair", () => {
    // Both ship 1K and 4K. The 1K arts are identical (they nearly always are -
    // one sprite in one column), the 4K arts are bars against circles. Scoring
    // by the best pairing called these lookalikes and fronted the strip with
    // 1K renders; scoring shared keymodes by weight does not.
    const bars: SkinSimilarityFacts = {
      author: "sona", keymodes: [1, 4], accentColor: null,
      visual: { v: 3, keymodes: { "1": BAR_ART, "4": BAR_ART } },
    };
    const circles: SkinSimilarityFacts = {
      author: "nova", keymodes: [1, 4], accentColor: null,
      visual: { v: 3, keymodes: { "1": BAR_ART, "4": CIRCLE_ART } },
    };
    const match = skinSimilarityMatch(bars, circles);
    expect(match.score).toBeLessThan(SKIN_SIMILARITY_FLOOR);
    // And what the strip would front is the keymode a skin is judged by, not
    // the 1K render the old rule matched through.
    expect(match.matchKeys).toBe(4);
  });

  it("weights 4K and 7K over the keymodes nobody judges a skin by", () => {
    const agreeAt4K: SkinSimilarityFacts = {
      author: "nova", keymodes: [3, 4], accentColor: null,
      visual: { v: 3, keymodes: { "3": CIRCLE_ART, "4": BAR_ART } },
    };
    const agreeAt3K: SkinSimilarityFacts = {
      author: "nova", keymodes: [3, 4], accentColor: null,
      visual: { v: 3, keymodes: { "3": BAR_ART, "4": CIRCLE_ART } },
    };
    const target: SkinSimilarityFacts = {
      author: "sona", keymodes: [3, 4], accentColor: null,
      visual: { v: 3, keymodes: { "3": BAR_ART, "4": BAR_ART } },
    };
    expect(skinSimilarity(target, agreeAt4K)).toBeGreaterThan(skinSimilarity(target, agreeAt3K));
  });

  it("falls back to the closest arts when the two share no keymode at all", () => {
    // A 6K-only skin against a 4K-only one: nothing to compare like with like,
    // so the closest pairing stands in and names the candidate's keymode.
    const sixKeyBars: SkinSimilarityFacts = {
      author: "sona", keymodes: [6], accentColor: null,
      visual: { v: 3, keymodes: { "6": BAR_ART } },
    };
    const fourKeyBars: SkinSimilarityFacts = { author: "nova", keymodes: [4], accentColor: null, visual: BAR };
    const match = skinSimilarityMatch(sixKeyBars, fourKeyBars);
    expect(match.matchKeys).toBe(4);
    expect(match.score).toBeGreaterThan(SKIN_SIMILARITY_FLOOR);
  });

  it("answers for one keymode when the page says which, ignoring the rest of the range", () => {
    // A skin that ships bars at 7K and arrows at 4K: a real pattern, and the
    // reason the strip has to be asked per keymode. Against a bar skin it is a
    // lookalike on the 7K page and a stranger on the 4K one.
    const mixed: SkinSimilarityFacts = {
      author: "nova", keymodes: [4, 7], accentColor: null,
      visual: { v: 3, keymodes: { "4": CIRCLE_ART, "7": BAR_ART } },
    };
    const bars: SkinSimilarityFacts = {
      author: "sona", keymodes: [4, 7], accentColor: null,
      visual: { v: 3, keymodes: { "4": BAR_ART, "7": BAR_ART } },
    };
    const at7K = skinSimilarityMatch(bars, mixed, { keys: 7 });
    expect(at7K.score).toBeGreaterThan(SKIN_SIMILARITY_FLOOR);
    expect(at7K.matchKeys).toBe(7);
    expect(skinSimilarityMatch(bars, mixed, { keys: 4 }).score).toBeLessThan(SKIN_SIMILARITY_FLOOR);
  });

  it("drops a candidate that does not ship the keymode being viewed", () => {
    const fourOnly: SkinSimilarityFacts = {
      author: "nova", keymodes: [4], accentColor: null, visual: BAR,
    };
    const alsoSeven: SkinSimilarityFacts = {
      author: "nova", keymodes: [4, 7], accentColor: null,
      visual: { v: 3, keymodes: { "4": BAR_ART, "7": BAR_ART } },
    };
    // Nothing to compare on the 7K page, so it cannot be recommended there
    // however alike the two are at 4K.
    expect(skinSimilarityMatch(alsoSeven, fourOnly, { keys: 7 }).score).toBeLessThan(SKIN_SIMILARITY_FLOOR);
    expect(skinSimilarityMatch(alsoSeven, fourOnly, { keys: 4 }).score).toBeGreaterThan(SKIN_SIMILARITY_FLOOR);
  });

  it("carries no match keymode on the accent fallback", () => {
    expect(skinSimilarityMatch(BASE, { ...BASE }).matchKeys).toBeNull();
    expect(skinSimilarityMatch({ ...BASE, visual: BAR }, { ...BASE }).matchKeys).toBeNull();
  });

  it("ranks matching colours over clashing ones at equal shape", () => {
    const matching = skinSimilarity({ ...BASE, visual: BAR }, { ...BASE, visual: BAR });
    // Same blue notes against orange ones. The accents are what decides, so
    // this is where the difference has to live: the whole-sprite averages are
    // only consulted for art with no saturated colour at all.
    const clashing = skinSimilarity(
      { ...BASE, visual: BAR },
      { ...BASE, visual: { v: 3, keymodes: { "4": { ...BAR_ART, accents: ["#ff9933"], colors: ["#ff9933"] } } } },
    );
    expect(matching).toBeGreaterThan(clashing);
    // But shape agreement alone keeps the pair over the floor: two bar skins
    // in different colourways are still each other's closest kin.
    expect(clashing).toBeGreaterThan(SKIN_SIMILARITY_FLOOR);
  });

  it("matches palettes by best pairing, not column position", () => {
    const swapped = skinSimilarity(
      { ...BASE, visual: { v: 3, keymodes: { "4": { ...BAR_ART, accents: ["#66ccff", "#ff9933"] } } } },
      { ...BASE, visual: { v: 3, keymodes: { "4": { ...BAR_ART, accents: ["#ff9933", "#66ccff"] } } } },
    );
    expect(swapped).toBeCloseTo(skinSimilarity({ ...BASE, visual: BAR }, { ...BASE, visual: BAR }));
  });
});

describe("skinSimilarity accent fallback (no signatures)", () => {
  it("orders candidates by accent colour distance", () => {
    const nearPink = skinSimilarity(BASE, { ...BASE, accentColor: "#ff5599" });
    const cyan = skinSimilarity(BASE, { ...BASE, accentColor: "#66ffff" });
    const blackOnWhite = skinSimilarity(
      { ...BASE, accentColor: "#000000" },
      { ...BASE, accentColor: "#ffffff" },
    );
    expect(nearPink).toBeGreaterThan(cyan);
    expect(cyan).toBeGreaterThan(blackOnWhite);
  });

  it("caps what colour alone can claim: an accent twin scores under a signature twin", () => {
    expect(skinSimilarity(BASE, { ...BASE })).toBeCloseTo(0.825);
  });

  it("treats a missing accent as unknown, not as clashing", () => {
    const unknown = skinSimilarity(BASE, { ...BASE, accentColor: null });
    expect(unknown).toBeGreaterThan(skinSimilarity(BASE, { ...BASE, accentColor: "#66ffff" }));
    expect(unknown).toBeLessThan(skinSimilarity(BASE, { ...BASE }));
  });

  it("gives keymode overlap partial credit", () => {
    const full = skinSimilarity(BASE, { ...BASE });
    const half = skinSimilarity(BASE, { ...BASE, keymodes: [4, 7] });
    const none = skinSimilarity(BASE, { ...BASE, keymodes: [7] });
    expect(full).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(none);
    expect(full - none).toBeCloseTo(0.15);
  });

  it("credits a shared author case-insensitively, and never a missing one", () => {
    expect(skinSimilarity(BASE, { ...BASE, author: "SONA" })).toBeCloseTo(0.825);
    // Two skins with no author on file share nothing; that must not read as
    // the same (absent) hand.
    expect(skinSimilarity({ ...BASE, author: null }, { ...BASE, author: null })).toBeCloseTo(0.675);
  });

  it("keeps an unrelated skin under the floor and a plain lookalike above it", () => {
    // Different keymode, different hand, far colour: the junk the floor trims.
    const unrelated = skinSimilarity(BASE, { author: "nova", keymodes: [10], accentColor: "#113322", visual: null });
    expect(unrelated).toBeLessThan(SKIN_SIMILARITY_FLOOR);
    // Same keymode alone, accents unknown: still worth a slot.
    const plain = skinSimilarity(
      { author: null, keymodes: [4], accentColor: null, visual: null },
      { author: "nova", keymodes: [4], accentColor: null, visual: null },
    );
    expect(plain).toBeGreaterThan(SKIN_SIMILARITY_FLOOR);
  });
});

describe("normalizeSkinVisualSignature", () => {
  it("round-trips a well-formed signature", () => {
    const multi: SkinVisualSignature = { v: 3, keymodes: { "4": CIRCLE_ART, "6": BAR_ART } };
    expect(normalizeSkinVisualSignature(JSON.parse(JSON.stringify(multi)))).toEqual(multi);
  });

  it("reads anything malformed as no signature at all, earlier formats included", () => {
    expect(normalizeSkinVisualSignature(null)).toBeNull();
    // The formats earlier deploys wrote: one keymode with no colour detail
    // (v1), then every keymode but still no accents (v2). The bumped backfill
    // replaces these, and until then the row scores by accent.
    expect(normalizeSkinVisualSignature({ v: 1, ...BAR_ART })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 2, keymodes: { "4": { aspect: 4, mask: "9".repeat(64), colors: ["#ffffff"] } } })).toBeNull();
    // A v3 entry missing the colour fields is not a v3 entry.
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: { "4": { aspect: 4, mask: "9".repeat(64), colors: ["#ffffff"] } } })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: { "4": { ...BAR_ART, sat: 1.4 } } })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: { "4": { ...BAR_ART, accents: ["nope"] } } })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: {} })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: { "11": BAR_ART } })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: { "4": { ...BAR_ART, aspect: 0 } } })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: { "4": { ...BAR_ART, mask: "9".repeat(63) } } })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: { "4": { ...BAR_ART, colors: [] } } })).toBeNull();
    expect(normalizeSkinVisualSignature({ v: 3, keymodes: { "4": { ...BAR_ART, colors: ["#ffffff", "white"] } } })).toBeNull();
  });
});
