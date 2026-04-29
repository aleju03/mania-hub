import { describe, expect, test } from "vitest";
import {
  createInteractionState,
  orientationToRotation,
  pointerToLight,
  pointerToRotation,
  settleRotation,
} from "./interactions";

describe("pointerToRotation", () => {
  test("maps pointer delta into bounded card rotation", () => {
    expect(pointerToRotation({ deltaX: 100, deltaY: -100 })).toEqual({
      x: -22,
      y: 35,
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
