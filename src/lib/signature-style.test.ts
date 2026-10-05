import { describe, expect, it } from "vitest";

import {
  accentHex,
  normalizeHexColor,
  normalizeSignatureStyle,
  normalizeSignatureStyleMap,
  serializeSignatureStyleMap,
  shadeHex,
  signatureBackgroundsFor,
  styleArt,
  stylePaintedBackground,
  styleNeedsProfileImage,
  styleUsesImage,
  styleUsesTier,
  DEFAULT_SIGNATURE_STYLE,
  SIGNATURE_ACCENTS,
  SIGNATURE_BACKGROUNDS,
  SIGNATURE_BLUR_RANGE,
  SIGNATURE_BRIGHTNESS_RANGE,
  SIGNATURE_KEY_COUNTS,
  SIGNATURE_OPACITY_RANGE,
  SIGNATURE_STYLE_MAX_JSON,
} from "./signature-style";
import { SIGNATURE_TYPES } from "./signature-shared";

/* A signature's style is stored per player and folded into that type's data
   version, so this normalizer is doing two jobs at once: it is the allowlist
   that bounds how many distinct renders a player can mint, and it is the
   guarantee that a stored id which later disappears degrades to a default look
   rather than to a blank image on someone's osu! profile. */

describe("normalizeSignatureStyle", () => {
  it("keeps a valid style as-is", () => {
    const style = {
      background: "cover", accent: "#3fd4d0", color: "#112233",
      opacity: 40, blur: 12, brightness: 80, imageUrl: null, keyCount: 7, lnKeyCount: 4,
      watermark: false,
    };
    expect(normalizeSignatureStyle(style)).toEqual(style);
  });

  /* The site's name is on by default, so a style written before the toggle
     existed - and one that simply omits the key - has to come back with it on
     rather than silently stripping the mark from every render on the site. */
  it("keeps the site name on unless it was explicitly turned off", () => {
    expect(normalizeSignatureStyle({}).watermark).toBe(true);
    expect(normalizeSignatureStyle({ watermark: undefined }).watermark).toBe(true);
    expect(normalizeSignatureStyle({ watermark: false }).watermark).toBe(false);
    // And it survives the round trip the backend hashes into the version.
    const map = normalizeSignatureStyleMap({ goals: { watermark: false } });
    expect(JSON.parse(serializeSignatureStyleMap(map)).goals.watermark).toBe(false);
    expect(JSON.parse(serializeSignatureStyleMap(map)).skills.watermark).toBe(true);
  });

  it("falls back to the default for a background outside the allowlist", () => {
    const style = normalizeSignatureStyle({ background: "https://evil.example/x.png" });
    expect(style.background).toBe(DEFAULT_SIGNATURE_STYLE.background);
  });

  /* The maniacard has tier art to open on and the others do not, so "the
     layout's own look" is a different id per type. A background only one type
     can draw must not survive on the others either. */
  it("defaults and filters the background per type", () => {
    expect(normalizeSignatureStyle({}, "maniacard").background).toBe("tier");
    expect(normalizeSignatureStyle({}, "goals").background).toBe("none");
    expect(normalizeSignatureStyle({ background: "tier" }, "maniacard").background).toBe("tier");
    expect(normalizeSignatureStyle({ background: "tier" }, "skills").background).toBe("none");
    expect(signatureBackgroundsFor("goals").map((entry) => entry.id)).not.toContain("tier");
    expect(signatureBackgroundsFor("maniacard").map((entry) => entry.id)).toContain("tier");
  });

  it("clamps the sliders into range instead of trusting them", () => {
    expect(normalizeSignatureStyle({ opacity: 5000, blur: -40, brightness: 9000 })).toMatchObject({
      opacity: SIGNATURE_OPACITY_RANGE.max,
      blur: SIGNATURE_BLUR_RANGE.min,
      brightness: SIGNATURE_BRIGHTNESS_RANGE.max,
    });
    expect(normalizeSignatureStyle({ opacity: 0, blur: 999, brightness: -12 })).toMatchObject({
      opacity: SIGNATURE_OPACITY_RANGE.min,
      blur: SIGNATURE_BLUR_RANGE.max,
      brightness: SIGNATURE_BRIGHTNESS_RANGE.min,
    });
  });

  it("rounds fractional slider values so equal styles hash equal", () => {
    expect(normalizeSignatureStyle({ opacity: 55.4, blur: 6.7 })).toMatchObject({ opacity: 55, blur: 7 });
  });

  it.each([null, undefined, "nonsense", 42, []])("survives %p", (input) => {
    expect(normalizeSignatureStyle(input)).toEqual(DEFAULT_SIGNATURE_STYLE);
  });
});

describe("normalizeSignatureStyleMap", () => {
  it("always returns every type, so no renderer has to handle a gap", () => {
    const map = normalizeSignatureStyleMap({ goals: { background: "gradient" } });
    expect(Object.keys(map).sort()).toEqual([...SIGNATURE_TYPES].sort());
    expect(map.goals.background).toBe("gradient");
    expect(map.skills).toEqual(DEFAULT_SIGNATURE_STYLE);
  });

  it("parses the stored JSON string form", () => {
    const map = normalizeSignatureStyleMap(JSON.stringify({ dan: { accent: "#ffc24d" } }));
    expect(map.dan.accent).toBe("#ffc24d");
  });

  it("treats a null column as that type's defaults", () => {
    const map = normalizeSignatureStyleMap(null);
    for (const type of SIGNATURE_TYPES) {
      expect(map[type]).toEqual({
        ...DEFAULT_SIGNATURE_STYLE,
        background: type === "maniacard" ? "tier" : DEFAULT_SIGNATURE_STYLE.background,
      });
    }
  });

  /* The backend hashes this string into the version. Two runs of the same
     style must produce the same bytes, or every page load would look like a
     change and re-render. */
  it("serializes deterministically", () => {
    const a = serializeSignatureStyleMap(normalizeSignatureStyleMap({ skills: { background: "solid", blur: 3 } }));
    const b = serializeSignatureStyleMap(normalizeSignatureStyleMap({ skills: { blur: 3, background: "solid" } }));
    expect(a).toBe(b);
  });

  /* Anything that changes what a render looks like has to reach the version
     hash, and the hash is taken over exactly this string. A field added to the
     style but forgotten here would be a setting that saves and never redraws -
     which is how keyCount managed to do nothing at all. */
  it("carries every field of the style", () => {
    const map = normalizeSignatureStyleMap(null);
    for (const key of Object.keys(DEFAULT_SIGNATURE_STYLE)) {
      expect(serializeSignatureStyleMap(map)).toContain(`"${key}":`);
    }
  });

  it("stays well inside the size the backend will store", () => {
    const full = normalizeSignatureStyleMap(null);
    expect(serializeSignatureStyleMap(full).length).toBeLessThan(SIGNATURE_STYLE_MAX_JSON);
  });
});

describe("style helpers", () => {
  it("marks exactly the three fetched backgrounds as images", () => {
    const images = SIGNATURE_BACKGROUNDS.filter((entry) => entry.image).map((entry) => entry.id);
    expect(images).toEqual(["cover", "map", "custom"]);
    expect(styleUsesImage(normalizeSignatureStyle({ background: "cover" }))).toBe(true);
    expect(styleUsesImage(normalizeSignatureStyle({ background: "solid" }))).toBe(false);
    expect(styleUsesImage(normalizeSignatureStyle({ background: "none" }))).toBe(false);
  });

  /* The tier wash used to be painted whenever no picture was set, so "None"
     still produced one. It is a background like any other now, which means
     nothing but the tier background may claim it. */
  it("only draws tier art for the tier background", () => {
    expect(styleUsesTier(normalizeSignatureStyle({ background: "tier" }, "maniacard"))).toBe(true);
    for (const background of ["none", "solid", "gradient", "cover", "custom"]) {
      expect(styleUsesTier(normalizeSignatureStyle({ background }, "maniacard"))).toBe(false);
    }
  });

  it("paints a solid as a flat colour and a gradient as stops of it", () => {
    const solid = stylePaintedBackground(normalizeSignatureStyle({ background: "solid", color: "#204080" }));
    expect(solid).toBe("#204080");
    const gradient = stylePaintedBackground(normalizeSignatureStyle({ background: "gradient", color: "#204080" }));
    expect(gradient).toContain("linear-gradient");
    expect(gradient).toContain("#");
  });

  it("paints nothing for a background that is not painted", () => {
    for (const background of ["none", "tier", "cover", "map", "custom"]) {
      expect(stylePaintedBackground(normalizeSignatureStyle({ background }, "maniacard"))).toBeNull();
    }
  });

  /* The two site backdrops draw their own base, so they answer styleArt and
     the renderer takes that branch instead of painting a colour under them. */
  it("names the site artwork backgrounds and nothing else", () => {
    expect(styleArt(normalizeSignatureStyle({ background: "triangles" }))).toBe("triangles");
    expect(styleArt(normalizeSignatureStyle({ background: "notes" }))).toBe("notes");
    for (const background of ["none", "solid", "gradient", "cover", "custom"]) {
      expect(styleArt(normalizeSignatureStyle({ background }))).toBeNull();
    }
  });

  /* The brightness slider is the only thing that moves a painted background,
     so the colour it produces has to actually change with it - and stop at
     black and white rather than wrapping into nonsense. */
  it("shades a colour by brightness and clamps at both ends", () => {
    const style = (brightness: number) => normalizeSignatureStyle({ background: "solid", color: "#808080", brightness });
    expect(stylePaintedBackground(style(50))).toBe("#404040");
    expect(stylePaintedBackground(style(100))).toBe("#808080");
    expect(stylePaintedBackground(style(140))).toBe("#b3b3b3");
    expect(shadeHex("#808080", 0)).toBe("#000000");
    expect(shadeHex("#808080", 99)).toBe("#ffffff");
  });

  it("resolves auto to the layout's own colour and a pick to itself", () => {
    expect(accentHex(normalizeSignatureStyle({ accent: "auto" }), "#123456")).toBe("#123456");
    expect(accentHex(normalizeSignatureStyle({ accent: "#abcdef" }), "#123456")).toBe("#abcdef");
  });

  /* Accents were an eight-id allowlist before the colour picker. Those ids are
     still in stored rows, and a style that silently reset to Auto on load
     would look like the setting had been forgotten. */
  it("still accepts the preset ids a stored style may carry", () => {
    expect(accentHex(normalizeSignatureStyle({ accent: "gold" }), "#123456")).toBe("#ffc24d");
    expect(normalizeSignatureStyle({ accent: "nonsense" }).accent).toBe("auto");
  });

  it("takes any hex the picker can produce and refuses anything else", () => {
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
    expect(normalizeHexColor("#A1B2C3")).toBe("#a1b2c3");
    for (const bad of ["#gggggg", "red", "rgb(1,2,3)", "#12345", "", null, 42]) {
      expect(normalizeHexColor(bad)).toBeNull();
    }
  });

  it("has exactly one auto entry and gives every other accent a hex", () => {
    const auto = SIGNATURE_ACCENTS.filter((entry) => entry.hex === null);
    expect(auto).toHaveLength(1);
    expect(auto[0]!.id).toBe("auto");
    for (const entry of SIGNATURE_ACCENTS) {
      if (entry.hex) expect(entry.hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

/* Both of these are per type and both ride in the version hash, which is what
   makes changing them actually redraw a stored image. keyCount in particular
   used to live on a per-player column that the version never looked at, so
   switching keymode changed nothing at all. */
describe("keyCount and imageUrl", () => {
  it("accepts the keymodes the backend allows and rejects the rest", () => {
    for (const keys of SIGNATURE_KEY_COUNTS) {
      expect(normalizeSignatureStyle({ keyCount: keys }).keyCount).toBe(keys);
      expect(normalizeSignatureStyle({ lnKeyCount: keys }).lnKeyCount).toBe(keys);
    }
    for (const bad of [5, 8, 0, -4, "nope", null, undefined, Number.NaN]) {
      expect(normalizeSignatureStyle({ keyCount: bad }).keyCount).toBeNull();
      expect(normalizeSignatureStyle({ lnKeyCount: bad }).lnKeyCount).toBeNull();
    }
  });

  /* The two dan ladders are picked separately, so the LN one has to be its own
     stored value - and its own entry in the serialized form, or choosing it
     would save and never redraw. */
  it("keeps the LN keymode independent of the rice one", () => {
    const style = normalizeSignatureStyle({ keyCount: 7, lnKeyCount: 4 });
    expect(style).toMatchObject({ keyCount: 7, lnKeyCount: 4 });
    const a = serializeSignatureStyleMap(normalizeSignatureStyleMap({ dan: { keyCount: 7, lnKeyCount: 4 } }));
    const b = serializeSignatureStyleMap(normalizeSignatureStyleMap({ dan: { keyCount: 7, lnKeyCount: 7 } }));
    expect(a).not.toBe(b);
  });

  it("defaults the LN keymode to null, meaning the rice one", () => {
    expect(DEFAULT_SIGNATURE_STYLE.lnKeyCount).toBeNull();
  });

  it("defaults keyCount to null, meaning the player's strongest keymode", () => {
    expect(DEFAULT_SIGNATURE_STYLE.keyCount).toBeNull();
  });

  it("carries both fields into the serialized form the version hashes", () => {
    const map = normalizeSignatureStyleMap({
      skills: { keyCount: 4 },
      maniacard: { background: "custom", imageUrl: "https://example.com/a.png" },
    });
    const encoded = serializeSignatureStyleMap(map);
    expect(encoded).toContain('"keyCount":4');
    expect(encoded).toContain('"imageUrl":"https://example.com/a.png"');
  });

  it("changes the serialized form when only the keymode moves", () => {
    const a = serializeSignatureStyleMap(normalizeSignatureStyleMap({ skills: { keyCount: 4 } }));
    const b = serializeSignatureStyleMap(normalizeSignatureStyleMap({ skills: { keyCount: 7 } }));
    expect(a).not.toBe(b);
  });

  it("stays inside the stored cap with four full-length urls", () => {
    const long = `https://images.example.com/${"a".repeat(340)}.png`;
    const map = normalizeSignatureStyleMap(Object.fromEntries(
      SIGNATURE_TYPES.map((type) => [type, { background: "custom", imageUrl: long }]),
    ));
    for (const type of SIGNATURE_TYPES) expect(map[type].imageUrl).toBe(long);
    expect(serializeSignatureStyleMap(map).length).toBeLessThan(SIGNATURE_STYLE_MAX_JSON);
  });

  it("treats custom as an image background, so the sliders still apply", () => {
    expect(styleUsesImage(normalizeSignatureStyle({ background: "custom" }))).toBe(true);
  });

  /* A custom url needs no profile read: the address is already in the style,
     and fetching a profile to ignore it would be a backend call per render. */
  it("only asks for profile data when the picture comes from osu!", () => {
    expect(styleNeedsProfileImage(normalizeSignatureStyle({ background: "cover" }))).toBe(true);
    expect(styleNeedsProfileImage(normalizeSignatureStyle({ background: "map" }))).toBe(true);
    expect(styleNeedsProfileImage(normalizeSignatureStyle({ background: "custom" }))).toBe(false);
    expect(styleNeedsProfileImage(normalizeSignatureStyle({ background: "none" }))).toBe(false);
  });
});
