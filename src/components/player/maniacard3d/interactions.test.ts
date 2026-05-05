import { describe, expect, test } from "vitest";
import {
  addRotation,
  createInteractionState,
  orientationToRotation,
  pointerToLight,
  pointerToRotation,
  settleRotation,
  subtractRotation,
} from "./interactions";

describe("pointerToRotation", () => {
  test("maps pointer delta into bounded card rotation", () => {
    expect(pointerToRotation({ deltaX: 100, deltaY: -100 })).toEqual({
      x: -22,
      y: 35,
    });
  });
});

describe("addRotation", () => {
  test("applies pointer deltas from the current card pose", () => {
    expect(addRotation({ x: 8, y: 30 }, { x: 5, y: -12 })).toEqual({
      x: 13,
      y: 18,
    });
  });

  test("keeps vertical tilt bounded while allowing full horizontal spins", () => {
    expect(addRotation({ x: 20, y: 170 }, { x: 20, y: 30 })).toEqual({
      x: 24,
      y: 200,
    });
  });

  test("keeps accumulating through multiple full rotations", () => {
    expect(addRotation({ x: 0, y: 720 }, { x: 0, y: 95 })).toEqual({
      x: 0,
      y: 815,
    });
  });
});

describe("subtractRotation", () => {
  test("keeps a manually posed card stable when removing gyro offset", () => {
    expect(subtractRotation({ x: 12, y: 84 }, { x: -3, y: 10 })).toEqual({
      x: 15,
      y: 74,
    });
  });
});

describe("pointerToLight", () => {
  test("maps rotation into normalized shader light coordinates", () => {
    expect(pointerToLight({ x: -22, y: 35 })).toEqual({
      x: 0.36,
      y: 0.1,
    });
  });

  test("wraps horizontal rotation before mapping light", () => {
    expect(pointerToLight({ x: -22, y: 395 })).toEqual({
      x: 0.36,
      y: 0.1,
    });
  });
});

describe("orientationToRotation", () => {
  test("maps device orientation into bounded card rotation", () => {
    expect(orientationToRotation({ beta: 55, gamma: 8, restBeta: 45 })).toEqual({
      x: -10,
      y: -8,
    });
  });
});

describe("settleRotation", () => {
  test("eases rotation toward rest", () => {
    expect(settleRotation({ x: 10, y: -10 }, 0.5)).toEqual({ x: 5, y: -5 });
  });
});

describe("createInteractionState", () => {
  test("starts at rest on the front side", () => {
    expect(createInteractionState()).toEqual({
      dragging: false,
      flipped: false,
      rotation: { x: 0, y: 0 },
      targetRotation: { x: 0, y: 0 },
      light: { x: 0.5, y: 0.38 },
      lastInputAt: 0,
    });
  });
});
