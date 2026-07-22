/* The cover's drift lives in CSS, so the guard has to be a stylesheet
   contract. Pausing the animation on touch is the tempting shape and it is the
   bug: a paused animation still renders whichever frame its animation-delay
   selects, so on a phone the inline delay WAS the picture -- every restamp
   teleported the field, and two covers mounted moments apart (the stand-in and
   the book's own cover face) picked different frames. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");

function mediaBlock(query: string): string {
  const start = css.indexOf(query);
  expect(start, `${query} missing from styles.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open, index);
    }
  }
  throw new Error(`unterminated block for ${query}`);
}

describe("album cover drift on touch", () => {
  const touch = mediaBlock("@media (hover: none), (pointer: coarse) {\n  /* Touch devices");

  it("drops the triangle animation rather than pausing it", () => {
    expect(touch).toMatch(/\.album-tri-layer\s*\{\s*animation:\s*none;/);
    expect(touch).not.toMatch(/animation-play-state:\s*paused/);
  });

  it("covers the shelf as well as the open book", () => {
    // A selector scoped to .album-cover-live would leave the shelf's covers
    // paused-with-a-delay, which jump for exactly the same reason.
    expect(touch).not.toMatch(/album-cover-live|album-cover-hover/);
  });

  it("pairs the touch query with pointer: coarse, like the rest of the file", () => {
    // Plenty of Android devices report (hover: hover); the bare query misses
    // them, and FlipBook's shadow gate is matched to this one.
    expect(css).not.toMatch(/@media \(hover: none\)\s*\{/);
  });
});
