// @vitest-environment node
/* The two site backdrops are generated rather than fetched, which makes one
   property load-bearing: they have to be deterministic. A render is stored
   under a key derived from the player's data and style, so art that scattered
   itself differently on each call would make the stored image disagree with
   the preview that produced it, and nothing downstream could tell. */
import { describe, expect, it } from "vitest";

import { cosmicStarsDataUrl, planNoteRain, signatureArtLayers, tierFlecksDataUrl, trianglesArtDataUrl } from "./api/signature/-art";
import { canHoldNote, NOTE_SPRITES } from "../lib/note-sprites";
import { normalizeSignatureStyle } from "../lib/signature-style";

const style = (patch: Record<string, unknown>) => normalizeSignatureStyle({ color: "#2d1b4e", ...patch });

function decode(url: string): string {
  return Buffer.from(url.split(",")[1]!, "base64").toString("utf8");
}

describe("trianglesArtDataUrl", () => {
  it("draws the field as an svg data url at the card's size", () => {
    const url = trianglesArtDataUrl(style({ background: "triangles" }), 880, 200);
    expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = decode(url);
    expect(svg).toContain('width="880"');
    expect(svg).toContain('height="200"');
  });

  it("draws the same field every time", () => {
    const input = style({ background: "triangles" });
    expect(trianglesArtDataUrl(input, 880, 200)).toBe(trianglesArtDataUrl(input, 880, 200));
  });

  /* The colour and the brightness slider are the only controls this has, so
     both have to actually reach the output. */
  it("takes its colour and brightness from the style", () => {
    const a = trianglesArtDataUrl(style({ background: "triangles", color: "#2d1b4e" }), 880, 200);
    const b = trianglesArtDataUrl(style({ background: "triangles", color: "#1e6f5c" }), 880, 200);
    const dim = trianglesArtDataUrl(style({ background: "triangles", brightness: 40 }), 880, 200);
    expect(a).not.toBe(b);
    expect(a).not.toBe(dim);
  });

  it("emits well-formed svg with no unescaped colour junk", () => {
    const svg = decode(trianglesArtDataUrl(style({ background: "triangles" }), 600, 140));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    // Every fill this draws comes from mixHex, so anything else in there would
    // mean a colour reached the markup without being normalized.
    for (const fill of svg.match(/fill="[^"]*"/g) ?? []) {
      expect(fill).toMatch(/^fill="(#[0-9a-f]{6}|none)"$/);
    }
  });
});

describe("planNoteRain", () => {
  const rain = (width: number, height: number, patch: Record<string, unknown> = {}) =>
    planNoteRain(style({ background: "notes", ...patch }), width, height);

  it("scatters the same rain every time", () => {
    expect(rain(880, 200)).toEqual(rain(880, 200));
  });

  /* Coverage per area rather than a fixed count, so a 300x300 badge gets a
     finer rain instead of a banner's worth crammed into it. */
  it("scales the rain to the size of the card", () => {
    expect(rain(880, 200).length).toBeGreaterThan(rain(300, 300).length);
    expect(rain(420, 588).length).toBeGreaterThan(rain(600, 140).length);
  });

  /* Placement is a jittered grid rather than free random precisely so there is
     no bare quarter. Sizing the grid from a target and then stopping at that
     target left the last row half filled, which on a three-row banner is a
     visibly empty bottom-right corner. */
  it.each([[880, 200], [600, 140], [420, 588], [300, 300]])("covers the whole of a %ix%i card", (width, height) => {
    const notes = rain(width, height);
    const bare: string[] = [];
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 2; row += 1) {
        const hit = notes.some((note) =>
          note.x >= (column * width) / 4 && note.x < ((column + 1) * width) / 4
          && note.y >= (row * height) / 2 && note.y < ((row + 1) * height) / 2);
        if (!hit) bare.push(`${column},${row}`);
      }
    }
    expect(bare).toEqual([]);
  });

  /* Depth is the whole reason a still of a moving rain works, and it is two
     things: a real spread of sizes, and brighter notes in front. */
  it("gives the rain depth rather than one plane of notes", () => {
    const notes = rain(880, 200);
    const sizes = notes.map((note) => note.size);
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThan(2);

    // Sorted back to front, the way SKINS_OG_NOTES is listed by hand.
    const opacities = notes.map((note) => note.opacity);
    expect(opacities).toEqual([...opacities].sort((a, b) => a - b));
    expect(Math.max(...opacities)).toBeGreaterThan(Math.min(...opacities) * 2);
  });

  /* The overhang is how far a note's centre may sit past the edge, so it has
     to be measured against the smallest note the rain can draw. Sized to the
     largest, a small note in the outer ring lands wholly off the card and
     costs a sprite draw for nothing. */
  it("runs off the edges without placing a note that never lands", () => {
    const notes = rain(880, 200);
    const missed = notes.filter((note) =>
      note.x + note.size / 2 <= 0 || note.x - note.size / 2 >= 880
      || note.y + note.size / 2 <= 0 || note.y - note.size / 2 >= 200);
    expect(missed).toEqual([]);
    expect(notes.some((note) => note.x - note.size / 2 < 0 || note.x + note.size / 2 > 880)).toBe(true);
    expect(notes.some((note) => note.y - note.size / 2 < 0 || note.y + note.size / 2 > 200)).toBe(true);
  });

  it("dims the whole rain with the brightness slider", () => {
    const bright = rain(880, 200, { brightness: 140 });
    const dim = rain(880, 200, { brightness: 40 });
    expect(Math.max(...dim.map((note) => note.opacity)))
      .toBeLessThan(Math.max(...bright.map((note) => note.opacity)));
    // Only the opacity moves; the scatter itself is the same picture.
    expect(dim.map((note) => [note.x, note.y, note.size])).toEqual(bright.map((note) => [note.x, note.y, note.size]));
  });

  it("drops only sprites the rain actually has", () => {
    const names = new Set(NOTE_SPRITES.map((sprite) => sprite.name));
    expect(rain(420, 588).filter((note) => !names.has(note.sprite.name))).toEqual([]);
  });

  /* Holds are the rare accent they are in ManiaRain, and never on an up or
     down arrow: the body would run out of the arrow's back. A hold's head also
     stays upright so the body lines up under it. */
  it("holds sparingly, upright, and never on an arrow that cannot carry one", () => {
    const notes = rain(420, 588);
    const holds = notes.filter((note) => note.hold > 0);
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.length).toBeLessThan(notes.length * 0.15);
    expect(holds.filter((note) => !canHoldNote(note.sprite))).toEqual([]);
    expect(holds.filter((note) => note.rotate !== 0)).toEqual([]);
  });

  it("tilts the taps without spinning them onto their side", () => {
    const taps = rain(880, 200).filter((note) => note.hold === 0);
    expect(taps.filter((note) => Math.abs(note.rotate) > 45)).toEqual([]);
    expect(taps.some((note) => note.rotate < 0)).toBe(true);
    expect(taps.some((note) => note.rotate > 0)).toBe(true);
  });
});

describe("signatureArtLayers", () => {
  const request = new Request("https://mania-tracker.com/api/signature/x/maniacard-1.png");

  it("draws nothing for a background that is not artwork", async () => {
    for (const background of ["none", "solid", "gradient", "cover", "custom"]) {
      expect(await signatureArtLayers(request, style({ background }), 880, 200)).toBeNull();
    }
  });
});

describe("tierFlecksDataUrl", () => {
  it("draws the card's fleck field as a transparent overlay", () => {
    const svg = decode(tierFlecksDataUrl(880, 200));
    expect(svg).toContain("<polygon");
    // No background rect: this rides on top of the tier gradient, which is a
    // satori layer rather than part of this image.
    expect(svg).not.toContain("<rect");
  });

  it("draws the same field every time", () => {
    expect(tierFlecksDataUrl(880, 200)).toBe(tierFlecksDataUrl(880, 200));
  });

  it("keeps fleck size to the card rather than the count", () => {
    const count = (url: string) => (decode(url).match(/<polygon/g) ?? []).length;
    expect(count(tierFlecksDataUrl(880, 200))).toBeGreaterThan(count(tierFlecksDataUrl(300, 300)));
  });
});

/* Flecks and stars set their alpha per shape rather than inheriting it from a
   group, which matters: resvg, the rasterizer these actually render through,
   does not carry an inherited fill-opacity down to a group's children. */
describe("cosmicStarsDataUrl", () => {
  it("varies its stars rather than laying down a uniform field", () => {
    const svg = decode(cosmicStarsDataUrl(880, 200, ["255, 255, 255", "148, 163, 255"]));
    const alphas = [...svg.matchAll(/fill-opacity="([\d.]+)"/g)].map(([, value]) => Number(value));
    expect(alphas.length).toBeGreaterThan(18);
    expect(Math.max(...alphas)).toBeGreaterThan(Math.min(...alphas) * 3);
    expect(svg).toContain("rgb(148, 163, 255)");
  });

  it("draws the same field every time", () => {
    const colors = ["255, 255, 255"];
    expect(cosmicStarsDataUrl(880, 200, colors)).toBe(cosmicStarsDataUrl(880, 200, colors));
  });
});
