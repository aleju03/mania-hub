import { describe, expect, it } from "vitest";
import { GHOST_CHARACTER_LIST, ghostClipBounds, walkClipFor, type GhostCharacter } from "../lib/ghost-shared";
import { GHOST_TILE, fitClipToTile } from "./admin/ghost";

// The ghost panel's poses and moves are sprite tiles rather than named pills, so
// the fit is the label: a clip parked off the edge of its tile is a control with
// nothing written on it. Every frame draws itself up and left of its anchor (the
// feet), which is the part that is easy to get backwards, and the roster spans a
// 19px dog, a 43px Ralsei and one 220px pose, so nothing here is theoretical.

/** Where the clip's own drawing actually lands inside the tile. */
function drawnBox(character: GhostCharacter, clip: string) {
  const bounds = ghostClipBounds(character, clip);
  const fit = fitClipToTile(character, clip);
  return {
    left: fit.left - (character.anchor.x - bounds.x) * fit.scale,
    top: fit.top - (character.anchor.y - bounds.y) * fit.scale,
    w: bounds.w * fit.scale,
    h: bounds.h * fit.scale,
  };
}

/** Every clip the bar can show: the poses (walk included) and the one-shots. */
function tiledClips(character: GhostCharacter): string[] {
  return [
    character.idle,
    ...character.poses.map((pose) => pose.clip ?? walkClipFor(character, "down")),
    ...character.actions.map((action) => action.clip),
  ];
}

describe("ghost panel clip tiles", () => {
  it("centres every clip on the roster inside its tile", () => {
    for (const character of GHOST_CHARACTER_LIST) {
      for (const clip of tiledClips(character)) {
        const box = drawnBox(character, clip);
        const where = `${character.id}/${clip}`;
        // Centred: the room left over is split evenly on both sides.
        expect(`${where}: ${box.left.toFixed(3)}`).toBe(`${where}: ${((GHOST_TILE - box.w) / 2).toFixed(3)}`);
        expect(`${where}: ${box.top.toFixed(3)}`).toBe(`${where}: ${((GHOST_TILE - box.h) / 2).toFixed(3)}`);
        // And inside it, so nothing is cropped by the tile's own overflow.
        expect(`${where}: ${box.w <= GHOST_TILE && box.h <= GHOST_TILE}`).toBe(`${where}: true`);
      }
    }
  });

  it("draws at whole-number scales wherever the clip fits at 1x", () => {
    for (const character of GHOST_CHARACTER_LIST) {
      for (const clip of tiledClips(character)) {
        const { scale } = fitClipToTile(character, clip);
        const where = `${character.id}/${clip}`;
        expect(`${where}: ${scale > 0}`).toBe(`${where}: true`);
        // A pixel sprite at 1.7x is a smeared pixel sprite. Only a clip too big
        // to fit at 1x at all (the dog's long stilts) takes a fraction.
        if (scale >= 1) expect(`${where}: ${scale}`).toBe(`${where}: ${Math.floor(scale)}`);
      }
    }
  });

  it("shrinks a clip that cannot fit at 1x rather than cropping it", () => {
    const dog = GHOST_CHARACTER_LIST.find((entry) => entry.id === "dog")!;
    // 19x220: the one clip on the roster taller than any sane tile.
    const bounds = ghostClipBounds(dog, "stilts-long");
    expect(bounds.h).toBeGreaterThan(GHOST_TILE);
    const { scale } = fitClipToTile(dog, "stilts-long");
    expect(scale).toBeLessThan(1);
    expect(bounds.h * scale).toBeCloseTo(GHOST_TILE, 5);
  });
});
