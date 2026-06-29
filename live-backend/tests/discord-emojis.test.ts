import { afterEach, describe, expect, it } from "vitest";
import {
  emojiCatalog,
  emojiRef,
  gradeEmoji,
  hasEmojis,
  modsEmoji,
  modsLabel,
  setEmojiRegistry,
} from "../src/discord/emojis.js";

// Every test starts from a clean (unregistered) registry so the fallback path is
// the default, matching a fresh deploy.
afterEach(() => setEmojiRegistry([]));

describe("discord emoji registry", () => {
  it("lists grades then mods in the catalog", () => {
    const catalog = emojiCatalog();
    expect(catalog).toContain("grade_x");
    expect(catalog).toContain("grade_f");
    expect(catalog).toContain("mod_dt");
    expect(catalog).toContain("mod_4k");
    // No duplicates.
    expect(new Set(catalog).size).toBe(catalog.length);
  });

  it("falls back to text glyphs when nothing is registered", () => {
    expect(hasEmojis()).toBe(false);
    expect(gradeEmoji("X")).toBe("`X`");
    expect(gradeEmoji("sh")).toBe("`SH`");
    expect(gradeEmoji(null)).toBe("`?`");
    expect(modsEmoji(["HD", "DT"])).toBe("+HDDT");
    expect(modsEmoji([])).toBe("NM");
    expect(modsLabel(["DT"])).toBe("+DT");
    expect(emojiRef("grade_x")).toBeNull();
  });

  it("renders registered grades and mods as inline emoji references", () => {
    setEmojiRegistry([
      { name: "grade_x", emojiId: "111", animated: false },
      { name: "mod_dt", emojiId: "222", animated: false },
      { name: "mod_hd", emojiId: "333", animated: false },
    ]);
    expect(hasEmojis()).toBe(true);
    expect(gradeEmoji("X")).toBe("<:grade_x:111>");
    // All mods registered -> tight run of icons.
    expect(modsEmoji(["DT", "HD"])).toBe("<:mod_dt:222><:mod_hd:333>");
  });

  it("falls back to full text when any mod in the set is missing", () => {
    setEmojiRegistry([{ name: "mod_dt", emojiId: "222", animated: false }]);
    // FL has no registered emoji, so the whole set degrades to text rather than
    // mixing an icon with a letter.
    expect(modsEmoji(["DT", "FL"])).toBe("+DTFL");
  });

  it("falls back to the grade text when a grade is unregistered", () => {
    setEmojiRegistry([{ name: "mod_dt", emojiId: "222", animated: false }]);
    expect(gradeEmoji("S")).toBe("`S`");
  });
});
