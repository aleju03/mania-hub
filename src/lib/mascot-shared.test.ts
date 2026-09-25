import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findMascotAction,
  findMascotPose,
  MASCOT_ACTION_KINDS,
  MASCOT_CHARACTERS,
  MASCOT_CHARACTER_LIST,
  MASCOT_SPRINT_SPEED,
  MASCOT_WALK_SPEED,
  MASCOT_MAX_WIDTH_RATIO,
  MASCOT_NARROW_WIDTH,
  directionalMascotFrame,
  fitMascotScale,
  followMascotCamera,
  mascotAtlasCols,
  mascotAtlasRows,
  mascotAtlasUrl,
  mascotCharacter,
  mascotClipBounds,
  mascotHitboxRect,
  mascotMoveStep,
  mascotBubbleLift,
  mascotSpeechDurationMs,
  mascotWrapDelta,
  isMascotClip,
  isMascotGait,
  isLoopingMascotPose,
  matchesMascotRoute,
  normalizeMascotRoute,
  resolveMascotClip,
  shouldFlipMascotClip,
  walkClipFor,
  wrapMascotX,
  type MascotCharacter,
} from "./mascot-shared";

const RALSEI = MASCOT_CHARACTERS.ralsei;
const STARWALKER = MASCOT_CHARACTERS.starwalker;
const DOG = MASCOT_CHARACTERS.dog;

function atlasBytes(character: MascotCharacter): Buffer {
  return readFileSync(fileURLToPath(new URL(`../../public/images/mascot/${character.atlas.file}`, import.meta.url)));
}

/* Route folding is duplicated in live-backend/src/live/mascot.ts on purpose (the
   two services share no code), so these cases are the contract between them: if
   one side folds a path differently, a session silently reaches nobody. */
describe("mascot route normalization", () => {
  it("folds a location down to a comparable route", () => {
    expect(normalizeMascotRoute("/player/Jakads?tab=recent#top")).toBe("/player/jakads");
    expect(normalizeMascotRoute("/rankings/")).toBe("/rankings");
    expect(normalizeMascotRoute("https://mania-tracker.com/maps")).toBe("/maps");
    expect(normalizeMascotRoute("tracker")).toBe("/tracker");
    expect(normalizeMascotRoute("//maps//")).toBe("/maps");
    expect(normalizeMascotRoute("/")).toBe("/");
  });

  it("keeps wildcards and rejects anything that is not a path", () => {
    expect(normalizeMascotRoute("/player/*")).toBe("/player/*");
    expect(normalizeMascotRoute("/*")).toBe("/*");
    expect(normalizeMascotRoute("")).toBeNull();
    expect(normalizeMascotRoute(null)).toBeNull();
    expect(normalizeMascotRoute("/player/<script>")).toBeNull();
    expect(normalizeMascotRoute(`/${"a".repeat(400)}`)).toBeNull();
  });

  it("matches exact routes and wildcard sections", () => {
    expect(matchesMascotRoute("/player/jakads", "/player/jakads")).toBe(true);
    expect(matchesMascotRoute("/player/jakads", "/player/other")).toBe(false);
    expect(matchesMascotRoute("/player/*", "/player/jakads")).toBe(true);
    expect(matchesMascotRoute("/player/*", "/playersomething")).toBe(false);
    expect(matchesMascotRoute("/*", "/anything/deep")).toBe(true);
  });
});

/* One atlas per character, each a plain grid the manifest below describes. A
   sheet and its table drifting apart is the failure that renders as sprite
   fragments, so both are pinned per character rather than for Ralsei alone. */
describe("mascot roster", () => {
  const DIGESTS: Record<string, string> = {
    ralsei: "f7f4df106498",
    starwalker: "cfe35aaf7405",
    dog: "8e5871d2ea98",
  };

  it("forces a fresh fetch when any character's art changes", () => {
    // The service worker caches /images/* cache-first and never expires it, so a
    // same-URL atlas swap garbles the sprite for everyone who has been here
    // before. These digests fail the moment a picture changes: bump the
    // character's atlas.version with it.
    for (const character of MASCOT_CHARACTER_LIST) {
      const digest = createHash("sha256").update(atlasBytes(character)).digest("hex").slice(0, 12);
      expect(`${character.id} ${digest}`).toBe(`${character.id} ${DIGESTS[character.id]}`);
      expect(mascotAtlasUrl(character)).toBe(`/images/mascot/${character.atlas.file}?v=${character.atlas.version}`);
    }
  });

  it("describes the atlas that actually shipped", () => {
    for (const character of MASCOT_CHARACTER_LIST) {
      const png = atlasBytes(character);
      // PNG IHDR: width and height are big-endian uint32 at bytes 16 and 20.
      expect(`${character.id} ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(
        `${character.id} ${mascotAtlasCols(character) * character.frame.w}x${mascotAtlasRows(character) * character.frame.h}`,
      );
      expect(character.anchor.x).toBeLessThan(character.frame.w);
      expect(character.anchor.y).toBeLessThanOrEqual(character.frame.h);
    }
  });

  it("gives every clip its own row, inside the frame, with bounds to match", () => {
    for (const character of MASCOT_CHARACTER_LIST) {
      const rows = Object.values(character.clips).map((clip) => clip.row);
      expect(new Set(rows).size).toBe(rows.length);
      for (const [name, clip] of Object.entries(character.clips)) {
        expect(clip.frames).toBeLessThanOrEqual(mascotAtlasCols(character));
        const bounds = character.bounds[name];
        expect(`${character.id}.${name} bounds`).toBe(bounds ? `${character.id}.${name} bounds` : "missing");
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.w).toBeLessThanOrEqual(character.frame.w);
        expect(bounds.y + bounds.h).toBeLessThanOrEqual(character.frame.h);
      }
    }
  });

  it("only names clips that exist, for every character", () => {
    for (const character of MASCOT_CHARACTER_LIST) {
      expect(isMascotClip(character, character.idle)).toBe(true);
      for (const action of character.actions) expect(isMascotClip(character, action.clip)).toBe(true);
      for (const pose of character.poses) {
        if (pose.clip) expect(isMascotClip(character, pose.clip)).toBe(true);
      }
      for (const facing of ["up", "down", "left", "right"] as const) {
        expect(isMascotClip(character, walkClipFor(character, facing))).toBe(true);
      }
      // Every roster entry can be parked on the walk cycle it arrived with.
      expect(findMascotPose(character, "auto")?.clip).toBeNull();
      expect(isMascotClip(character, "nope")).toBe(false);
    }
  });

  it("falls back rather than drawing a row that is not there", () => {
    // The wire carries plain strings, and a tick can still be carrying the old
    // character's clip for a frame after a switch.
    expect(mascotCharacter("dog").id).toBe("dog");
    expect(mascotCharacter("nobody").id).toBe("ralsei");
    expect(mascotCharacter(undefined).id).toBe("ralsei");
    expect(resolveMascotClip(DOG, "pacify")).toBe(DOG.idle);
    expect(resolveMascotClip(DOG, "sleep")).toBe("sleep");
    expect(mascotClipBounds(STARWALKER, "squashed")).toEqual(mascotClipBounds(STARWALKER, STARWALKER.idle));
    // The dog has no actions at all, so nothing resolves for him.
    expect(findMascotAction(DOG, "heal")).toBeNull();
    expect(DOG.actions).toHaveLength(0);
    expect(findMascotAction(STARWALKER, "shine")?.clip).toBe("idle");
  });

  it("keeps every action kind on the roster playable by the sound layer", () => {
    for (const character of MASCOT_CHARACTER_LIST) {
      for (const action of character.actions) expect(MASCOT_ACTION_KINDS).toContain(action.kind);
    }
    // Shared kinds are shared on purpose: every vanish sounds like a vanish.
    expect(MASCOT_ACTION_KINDS.filter((kind) => kind === "vanish")).toHaveLength(1);
  });

  it("stays inside the size ceiling the backend clamps to", () => {
    // mergeVisual in live-backend/src/live/mascot.ts clamps scale to 1..12. A
    // character whose slider went past that would send sizes the backend
    // silently trims, which reads as a stuck slider.
    for (const character of MASCOT_CHARACTER_LIST) {
      expect(character.scale.max).toBeLessThanOrEqual(12);
      expect(character.scale.min).toBeGreaterThanOrEqual(1);
      expect(character.scale.default).toBeGreaterThanOrEqual(character.scale.min);
      expect(character.scale.default).toBeLessThanOrEqual(character.scale.max);
    }
  });
});

describe("mascot clip drawing", () => {
  it("uses the visible drawing instead of the transparent frame as its hitbox", () => {
    expect(mascotHitboxRect(RALSEI, "idle", 3, false)).toEqual({ x: -36, y: -129, w: 69, h: 129 });
    expect(mascotHitboxRect(RALSEI, "idle", 3, true)).toEqual({ x: -33, y: -129, w: 69, h: 129 });
    expect(mascotHitboxRect(RALSEI, "sleep", 3, false)).toEqual({ x: -84, y: -222, w: 165, h: 222 });
  });

  it("never mirrors a walk cycle that already has both sides drawn", () => {
    // Row 3 of Ralsei's sheet is the left-facing walk and row 4 the right-facing
    // one. Getting these backwards is invisible in a still and obvious in
    // motion, so it is pinned here: he walked backwards for a whole build.
    expect(RALSEI.clips["walk-left"]).toMatchObject({ row: 3, native: "left" });
    expect(RALSEI.clips["walk-right"]).toMatchObject({ row: 4, native: "right" });
    expect(walkClipFor(RALSEI, "left")).toBe("walk-left");
    expect(walkClipFor(RALSEI, "right")).toBe("walk-right");
    expect(shouldFlipMascotClip(RALSEI, "walk-left", "left")).toBe(false);
    expect(shouldFlipMascotClip(RALSEI, "walk-right", "right")).toBe(false);
  });

  it("mirrors a one-sided clip only when it faces the wrong way", () => {
    // Ralsei's battle clips are all drawn facing right, so they flip going left.
    expect(shouldFlipMascotClip(RALSEI, "heal", "left")).toBe(true);
    expect(shouldFlipMascotClip(RALSEI, "heal", "right")).toBe(false);
    expect(shouldFlipMascotClip(RALSEI, "stand", "right")).toBe(true);
    expect(shouldFlipMascotClip(RALSEI, "stand", "left")).toBe(false);
    // Front and back views read the same either way.
    expect(shouldFlipMascotClip(RALSEI, "idle", "left")).toBe(false);
    expect(shouldFlipMascotClip(RALSEI, "walk-up", "left")).toBe(false);
  });

  it("walks the dog on one drawn side and mirrors the other", () => {
    // Only the left side is drawn, and the front and back are their own clips,
    // so the mirror must apply to the side view and to nothing else.
    expect(walkClipFor(DOG, "left")).toBe("walk-left");
    expect(walkClipFor(DOG, "right")).toBe("walk-left");
    expect(shouldFlipMascotClip(DOG, "walk-left", "right")).toBe(true);
    expect(shouldFlipMascotClip(DOG, "walk-left", "left")).toBe(false);
    expect(shouldFlipMascotClip(DOG, "walk-down", "right")).toBe(false);
    expect(shouldFlipMascotClip(DOG, "walk-up", "left")).toBe(false);
  });

  it("points every direction at the one animation a flat star has", () => {
    for (const facing of ["up", "down", "left", "right"] as const) {
      expect(walkClipFor(STARWALKER, facing)).toBe("walk");
      // Nothing to mirror: he is drawn face-on and has no side art to flip to.
      expect(shouldFlipMascotClip(STARWALKER, "walk", facing)).toBe(false);
    }
  });

  it("loops the multi-frame poses and holds the single-frame one", () => {
    expect(isLoopingMascotPose(RALSEI, "sleep")).toBe(true);
    expect(isLoopingMascotPose(RALSEI, "hide")).toBe(true);
    expect(isLoopingMascotPose(RALSEI, "down")).toBe(false);
    // Not a pose at all: an action clip must never idle-loop underneath him.
    expect(isLoopingMascotPose(RALSEI, "pacify")).toBe(false);
    // The dog shakes his maracas standing still, so that one loops; sleeping
    // is a single frame, and the stilts are steps (see the gait test below).
    expect(isLoopingMascotPose(DOG, "maracas")).toBe(true);
    expect(isLoopingMascotPose(DOG, "sleep")).toBe(false);
    expect(isLoopingMascotPose(DOG, "stilts")).toBe(false);
  });

  it("takes a stride per step rather than marching on the spot", () => {
    // A gait's frames only advance while he moves. Getting this wrong is what
    // made him walk on stilts while standing still.
    for (const clip of ["stilts", "stilts-long", "car"]) {
      expect(`${clip} gait`).toBe(isMascotGait(DOG, clip) ? `${clip} gait` : `${clip} not`);
      expect(isLoopingMascotPose(DOG, clip)).toBe(false);
    }
    // Everything else animates on its own or holds a single frame.
    expect(isMascotGait(DOG, "maracas")).toBe(false);
    expect(isMascotGait(DOG, "sleep")).toBe(false);
    expect(isMascotGait(RALSEI, "sleep")).toBe(false);
    expect(isMascotGait(RALSEI, "walk-left")).toBe(false);
  });

  it("treats the squash's two drawings as sides, not as an animation", () => {
    // They are an exact mirror pair from the sheet, right first. Cycling them
    // makes him flip back and forth on the spot instead of lying still.
    expect(isLoopingMascotPose(RALSEI, "squashed")).toBe(false);
    expect(directionalMascotFrame(RALSEI, "squashed", "right")).toBe(0);
    expect(directionalMascotFrame(RALSEI, "squashed", "down")).toBe(0);
    expect(directionalMascotFrame(RALSEI, "squashed", "left")).toBe(1);
    // Both sides are drawn, so it must never be mirrored on top of that.
    expect(shouldFlipMascotClip(RALSEI, "squashed", "left")).toBe(false);
    // Everything else animates on the clock.
    expect(directionalMascotFrame(RALSEI, "sleep", "left")).toBeNull();
    expect(directionalMascotFrame(DOG, "walk-down", "left")).toBeNull();
  });
});

describe("mascot camera", () => {
  const view = 800;
  const page = 4000;

  it("holds still while he stays inside the band", () => {
    expect(followMascotCamera(0, 400, view, page)).toBe(0);
    expect(followMascotCamera(1000, 1400, view, page)).toBe(1000);
  });

  it("follows him past either edge of the band", () => {
    // Walking down: the camera trails him by the band width.
    expect(followMascotCamera(0, 700, view, page)).toBe(700 - view + 240);
    // Walking back up: it leads him by the same band.
    expect(followMascotCamera(1000, 1100, view, page)).toBe(1100 - 240);
  });

  it("never scrolls past the ends of the page", () => {
    expect(followMascotCamera(0, -50, view, page)).toBe(0);
    expect(followMascotCamera(3000, page, view, page)).toBe(page - view);
    // A page that fits on one screen never moves at all.
    expect(followMascotCamera(0, 700, view, 600)).toBe(0);
  });
});

describe("mascot pacing", () => {
  const page = { viewWidth: 1536, pageHeight: 4000 };

  it("covers the same pixels going down as going right", () => {
    // The axes use different denominators, so this is the one that broke: he
    // walked down at the screen aspect and slower still on a long page.
    const right = mascotMoveStep({ dx: 1, dy: 0 }, { ...page, sprinting: false, dt: 1 });
    const down = mascotMoveStep({ dx: 0, dy: 1 }, { ...page, sprinting: false, dt: 1 });
    expect(right.dx * page.viewWidth).toBeCloseTo(down.dy * page.pageHeight, 6);
    // And a page twice as long does not halve how fast he walks down it.
    const longer = mascotMoveStep({ dx: 0, dy: 1 }, { ...page, pageHeight: 8000, sprinting: false, dt: 1 });
    expect(longer.dy * 8000).toBeCloseTo(down.dy * page.pageHeight, 6);
  });

  it("keeps a diagonal at one speed rather than adding the axes", () => {
    const straight = mascotMoveStep({ dx: 1, dy: 0 }, { ...page, sprinting: false, dt: 1 });
    const diagonal = mascotMoveStep({ dx: 1, dy: 1 }, { ...page, sprinting: false, dt: 1 });
    const travelled = Math.hypot(diagonal.dx * page.viewWidth, diagonal.dy * page.pageHeight);
    expect(travelled).toBeCloseTo(straight.dx * page.viewWidth, 6);
  });

  it("runs about twice as fast as it walks", () => {
    const walk = mascotMoveStep({ dx: 1, dy: 0 }, { ...page, sprinting: false, dt: 1 });
    const run = mascotMoveStep({ dx: 1, dy: 0 }, { ...page, sprinting: true, dt: 1 });
    expect(run.dx / walk.dx).toBeCloseTo(MASCOT_SPRINT_SPEED / MASCOT_WALK_SPEED, 6);
    expect(MASCOT_SPRINT_SPEED).toBeGreaterThan(MASCOT_WALK_SPEED * 1.8);
    expect(MASCOT_SPRINT_SPEED).toBeLessThan(MASCOT_WALK_SPEED * 3);
  });
});

/* The scale on the wire is one number for every viewer, in raw sprite pixels,
   so the same 3x that reads as a character on a desktop was two thirds of a
   phone's width. Each viewer caps it against their own screen. */
describe("mascot scale fitting", () => {
  it("leaves a desktop alone and cuts a phone down", () => {
    expect(fitMascotScale(RALSEI, 3, 1536)).toBe(3);
    const phone = fitMascotScale(RALSEI, 3, 390);
    expect(phone).toBeLessThan(3);
    expect(RALSEI.frame.w * phone).toBeLessThanOrEqual(390 * MASCOT_MAX_WIDTH_RATIO);
  });

  it("never scales him below his own pixels, however narrow the screen", () => {
    expect(fitMascotScale(RALSEI, 6, 120)).toBe(1);
  });

  it("holds the cap at every size the panel can send, for every character", () => {
    for (const character of MASCOT_CHARACTER_LIST) {
      for (const scale of [character.scale.min, character.scale.default, character.scale.max]) {
        for (const width of [320, 390, MASCOT_NARROW_WIDTH, 1024, 1536, 2560]) {
          const fitted = fitMascotScale(character, scale, width);
          expect(fitted).toBeLessThanOrEqual(scale);
          expect(character.frame.w * fitted)
            .toBeLessThanOrEqual(Math.max(character.frame.w, width * MASCOT_MAX_WIDTH_RATIO));
        }
      }
    }
  });

  it("lets a small character carry a bigger number for the same drawn height", () => {
    // The scale is raw sprite pixels, so the 19px dog and the 43px Ralsei only
    // stand comparably tall because their defaults differ.
    const dogArt = mascotClipBounds(DOG, DOG.idle).h * DOG.scale.default;
    const ralseiArt = mascotClipBounds(RALSEI, RALSEI.idle).h * RALSEI.scale.default;
    expect(dogArt).toBeGreaterThan(ralseiArt / 2);
    expect(dogArt).toBeLessThan(ralseiArt);
  });
});

/* The frame is 100 tall and he is painted in the bottom half of it, so a bubble
   cleared of the frame floats half a sprite above his head. */
describe("mascot bubble lift", () => {
  it("clears the drawn pixels of every clip, not the padding above them", () => {
    for (const character of MASCOT_CHARACTER_LIST) {
      for (const name of Object.keys(character.bounds)) {
        const head = character.anchor.y - character.bounds[name].y;
        const lift = mascotBubbleLift(character, name, 1);
        expect(lift).toBeGreaterThan(head);
        // A gap, not a chasm: lifting by the frame instead of the drawing is the
        // thing being fixed, and the frame is mostly transparent ceiling.
        expect(lift - head).toBeLessThanOrEqual(6);
      }
    }
  });

  it("scales with him", () => {
    expect(mascotBubbleLift(RALSEI, "idle", 3)).toBeCloseTo(mascotBubbleLift(RALSEI, "idle", 1) * 3, 6);
  });

  it("follows a pose that changes how tall he is", () => {
    // Asleep he is a tall sprite, knocked out he is a heap on the floor.
    expect(mascotBubbleLift(RALSEI, "sleep", 3)).toBeGreaterThan(mascotBubbleLift(RALSEI, "down", 3));
    // And it sits low over a dog lying down, not where a standing one's head was.
    expect(mascotBubbleLift(DOG, "sleep", 3)).toBeLessThan(mascotBubbleLift(DOG, "idle", 3));
  });
});

describe("mascot horizontal wrap", () => {
  it("brings him back on the other side", () => {
    expect(wrapMascotX(1.02)).toBeCloseTo(0.02, 6);
    expect(wrapMascotX(-0.02)).toBeCloseTo(0.98, 6);
    expect(wrapMascotX(1)).toBe(0);
    expect(wrapMascotX(0.4)).toBe(0.4);
  });

  it("crosses the edge rather than walking back across the page", () => {
    // Off the right edge and onto the left: a short hop, not a long slide.
    expect(mascotWrapDelta(0.98, 0.02)).toBeCloseTo(0.04, 6);
    expect(mascotWrapDelta(0.02, 0.98)).toBeCloseTo(-0.04, 6);
    // Ordinary moves are untouched.
    expect(mascotWrapDelta(0.2, 0.5)).toBeCloseTo(0.3, 6);
  });
});

describe("mascot speech", () => {
  it("keeps a bubble up long enough to read and not forever", () => {
    expect(mascotSpeechDurationMs("hi")).toBe(3_500);
    expect(mascotSpeechDurationMs("a".repeat(240))).toBe(16_000);
    expect(mascotSpeechDurationMs("a".repeat(60))).toBeGreaterThan(mascotSpeechDurationMs("a".repeat(20)));
  });
});
