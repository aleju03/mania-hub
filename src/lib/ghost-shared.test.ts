import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findGhostAction,
  GHOST_ACTIONS,
  GHOST_ANCHOR,
  GHOST_ATLAS_COLS,
  GHOST_ATLAS_ROWS,
  GHOST_ATLAS_URL,
  GHOST_ATLAS_VERSION,
  GHOST_CLIP_BOUNDS,
  GHOST_CLIPS,
  GHOST_FRAME,
  GHOST_POSES,
  GHOST_SPRINT_SPEED,
  GHOST_WALK_SPEED,
  directionalGhostFrame,
  followGhostCamera,
  ghostHitboxRect,
  ghostMoveStep,
  ghostSpeechDurationMs,
  isGhostClip,
  isLoopingGhostPose,
  matchesGhostRoute,
  normalizeGhostRoute,
  shouldFlipGhostClip,
  walkClipFor,
} from "./ghost-shared";

/* Route folding is duplicated in live-backend/src/live/ghost.ts on purpose (the
   two services share no code), so these cases are the contract between them: if
   one side folds a path differently, a session silently reaches nobody. */
describe("ghost route normalization", () => {
  it("folds a location down to a comparable route", () => {
    expect(normalizeGhostRoute("/player/Jakads?tab=recent#top")).toBe("/player/jakads");
    expect(normalizeGhostRoute("/rankings/")).toBe("/rankings");
    expect(normalizeGhostRoute("https://mania-tracker.com/maps")).toBe("/maps");
    expect(normalizeGhostRoute("tracker")).toBe("/tracker");
    expect(normalizeGhostRoute("//maps//")).toBe("/maps");
    expect(normalizeGhostRoute("/")).toBe("/");
  });

  it("keeps wildcards and rejects anything that is not a path", () => {
    expect(normalizeGhostRoute("/player/*")).toBe("/player/*");
    expect(normalizeGhostRoute("/*")).toBe("/*");
    expect(normalizeGhostRoute("")).toBeNull();
    expect(normalizeGhostRoute(null)).toBeNull();
    expect(normalizeGhostRoute("/player/<script>")).toBeNull();
    expect(normalizeGhostRoute(`/${"a".repeat(400)}`)).toBeNull();
  });

  it("matches exact routes and wildcard sections", () => {
    expect(matchesGhostRoute("/player/jakads", "/player/jakads")).toBe(true);
    expect(matchesGhostRoute("/player/jakads", "/player/other")).toBe(false);
    expect(matchesGhostRoute("/player/*", "/player/jakads")).toBe(true);
    expect(matchesGhostRoute("/player/*", "/playersomething")).toBe(false);
    expect(matchesGhostRoute("/*", "/anything/deep")).toBe(true);
  });
});

describe("ghost sprite manifest", () => {
  it("forces a fresh fetch when the art changes", () => {
    // The service worker caches /images/* cache-first and never expires it, so a
    // same-URL atlas swap garbles the sprite for everyone who has been here
    // before. This digest fails the moment the picture changes: bump it and
    // GHOST_ATLAS_VERSION together.
    const png = readFileSync(fileURLToPath(new URL("../../public/images/ghost/ralsei.png", import.meta.url)));
    expect(createHash("sha256").update(png).digest("hex").slice(0, 12)).toBe("f7f4df106498");
    expect(GHOST_ATLAS_URL).toContain(`?v=${GHOST_ATLAS_VERSION}`);
  });

  it("describes the atlas that actually shipped", () => {
    const png = readFileSync(fileURLToPath(new URL("../../public/images/ghost/ralsei.png", import.meta.url)));
    // PNG IHDR: width and height are big-endian uint32 at bytes 16 and 20.
    expect(png.readUInt32BE(16)).toBe(GHOST_ATLAS_COLS * GHOST_FRAME.w);
    expect(png.readUInt32BE(20)).toBe(GHOST_ATLAS_ROWS * GHOST_FRAME.h);
    expect(GHOST_ANCHOR.x).toBeLessThan(GHOST_FRAME.w);
    expect(GHOST_ANCHOR.y).toBeLessThanOrEqual(GHOST_FRAME.h);
  });

  it("uses the visible drawing instead of the transparent frame as its hitbox", () => {
    expect(ghostHitboxRect("idle", 3, false)).toEqual({ x: -36, y: -129, w: 69, h: 129 });
    expect(ghostHitboxRect("idle", 3, true)).toEqual({ x: -33, y: -129, w: 69, h: 129 });
    expect(ghostHitboxRect("sleep", 3, false)).toEqual({ x: -84, y: -222, w: 165, h: 222 });

    for (const bounds of Object.values(GHOST_CLIP_BOUNDS)) {
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.w).toBeLessThanOrEqual(GHOST_FRAME.w);
      expect(bounds.y + bounds.h).toBeLessThanOrEqual(GHOST_FRAME.h);
    }
  });

  it("gives every clip its own row", () => {
    const rows = Object.values(GHOST_CLIPS).map((clip) => clip.row);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it("never mirrors a walk cycle that already has both sides drawn", () => {
    // Row 3 of the sheet is the left-facing walk and row 4 the right-facing one.
    // Getting these backwards is invisible in a still and obvious in motion, so
    // it is pinned here: he walked backwards for a whole build.
    expect(GHOST_CLIPS["walk-left"]).toMatchObject({ row: 3, native: "left" });
    expect(GHOST_CLIPS["walk-right"]).toMatchObject({ row: 4, native: "right" });
    expect(walkClipFor("left")).toBe("walk-left");
    expect(walkClipFor("right")).toBe("walk-right");
    expect(shouldFlipGhostClip("walk-left", "left")).toBe(false);
    expect(shouldFlipGhostClip("walk-right", "right")).toBe(false);
  });

  it("mirrors a one-sided clip only when it faces the wrong way", () => {
    // The battle clips are all drawn facing right, so they flip going left.
    expect(shouldFlipGhostClip("heal", "left")).toBe(true);
    expect(shouldFlipGhostClip("heal", "right")).toBe(false);
    expect(shouldFlipGhostClip("stand", "right")).toBe(true);
    expect(shouldFlipGhostClip("stand", "left")).toBe(false);
    // Front and back views read the same either way.
    expect(shouldFlipGhostClip("idle", "left")).toBe(false);
    expect(shouldFlipGhostClip("walk-up", "left")).toBe(false);
  });

  it("loops the multi-frame poses and holds the single-frame one", () => {
    expect(isLoopingGhostPose("sleep")).toBe(true);
    expect(isLoopingGhostPose("hide")).toBe(true);
    expect(isLoopingGhostPose("down")).toBe(false);
    // Not a pose at all: an action clip must never idle-loop underneath him.
    expect(isLoopingGhostPose("pacify")).toBe(false);
  });

  it("treats the squash's two drawings as sides, not as an animation", () => {
    // They are an exact mirror pair from the sheet, right first. Cycling them
    // makes him flip back and forth on the spot instead of lying still.
    expect(isLoopingGhostPose("squashed")).toBe(false);
    expect(directionalGhostFrame("squashed", "right")).toBe(0);
    expect(directionalGhostFrame("squashed", "down")).toBe(0);
    expect(directionalGhostFrame("squashed", "left")).toBe(1);
    // Both sides are drawn, so it must never be mirrored on top of that.
    expect(shouldFlipGhostClip("squashed", "left")).toBe(false);
    // Everything else animates on the clock.
    expect(directionalGhostFrame("sleep", "left")).toBeNull();
    expect(directionalGhostFrame("walk-down", "left")).toBeNull();
  });

  it("only names clips that exist", () => {
    for (const action of GHOST_ACTIONS) expect(isGhostClip(action.clip)).toBe(true);
    for (const pose of GHOST_POSES) {
      if (pose.clip) expect(isGhostClip(pose.clip)).toBe(true);
    }
    for (const facing of ["up", "down", "left", "right"] as const) {
      expect(isGhostClip(walkClipFor(facing))).toBe(true);
    }
    expect(isGhostClip("nope")).toBe(false);
    expect(findGhostAction("heal")?.clip).toBe("heal");
    expect(findGhostAction("nope")).toBeNull();
  });
});

describe("ghost camera", () => {
  const view = 800;
  const page = 4000;

  it("holds still while he stays inside the band", () => {
    expect(followGhostCamera(0, 400, view, page)).toBe(0);
    expect(followGhostCamera(1000, 1400, view, page)).toBe(1000);
  });

  it("follows him past either edge of the band", () => {
    // Walking down: the camera trails him by the band width.
    expect(followGhostCamera(0, 700, view, page)).toBe(700 - view + 240);
    // Walking back up: it leads him by the same band.
    expect(followGhostCamera(1000, 1100, view, page)).toBe(1100 - 240);
  });

  it("never scrolls past the ends of the page", () => {
    expect(followGhostCamera(0, -50, view, page)).toBe(0);
    expect(followGhostCamera(3000, page, view, page)).toBe(page - view);
    // A page that fits on one screen never moves at all.
    expect(followGhostCamera(0, 700, view, 600)).toBe(0);
  });
});

describe("ghost pacing", () => {
  const page = { viewWidth: 1536, pageHeight: 4000 };

  it("covers the same pixels going down as going right", () => {
    // The axes use different denominators, so this is the one that broke: he
    // walked down at the screen aspect and slower still on a long page.
    const right = ghostMoveStep({ dx: 1, dy: 0 }, { ...page, sprinting: false, dt: 1 });
    const down = ghostMoveStep({ dx: 0, dy: 1 }, { ...page, sprinting: false, dt: 1 });
    expect(right.dx * page.viewWidth).toBeCloseTo(down.dy * page.pageHeight, 6);
    // And a page twice as long does not halve how fast he walks down it.
    const longer = ghostMoveStep({ dx: 0, dy: 1 }, { ...page, pageHeight: 8000, sprinting: false, dt: 1 });
    expect(longer.dy * 8000).toBeCloseTo(down.dy * page.pageHeight, 6);
  });

  it("keeps a diagonal at one speed rather than adding the axes", () => {
    const straight = ghostMoveStep({ dx: 1, dy: 0 }, { ...page, sprinting: false, dt: 1 });
    const diagonal = ghostMoveStep({ dx: 1, dy: 1 }, { ...page, sprinting: false, dt: 1 });
    const travelled = Math.hypot(diagonal.dx * page.viewWidth, diagonal.dy * page.pageHeight);
    expect(travelled).toBeCloseTo(straight.dx * page.viewWidth, 6);
  });

  it("runs about twice as fast as it walks", () => {
    const walk = ghostMoveStep({ dx: 1, dy: 0 }, { ...page, sprinting: false, dt: 1 });
    const run = ghostMoveStep({ dx: 1, dy: 0 }, { ...page, sprinting: true, dt: 1 });
    expect(run.dx / walk.dx).toBeCloseTo(GHOST_SPRINT_SPEED / GHOST_WALK_SPEED, 6);
    expect(GHOST_SPRINT_SPEED).toBeGreaterThan(GHOST_WALK_SPEED * 1.8);
    expect(GHOST_SPRINT_SPEED).toBeLessThan(GHOST_WALK_SPEED * 3);
  });
});

describe("ghost speech", () => {
  it("keeps a bubble up long enough to read and not forever", () => {
    expect(ghostSpeechDurationMs("hi")).toBe(3_500);
    expect(ghostSpeechDurationMs("a".repeat(240))).toBe(16_000);
    expect(ghostSpeechDurationMs("a".repeat(60))).toBeGreaterThan(ghostSpeechDurationMs("a".repeat(20)));
  });
});
