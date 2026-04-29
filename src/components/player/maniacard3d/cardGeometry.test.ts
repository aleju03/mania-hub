import { describe, expect, test } from "vitest";
import { ExtrudeGeometry, PlaneGeometry } from "three";
import {
  CARD_WORLD_THICKNESS,
  FACE_Z_OFFSET,
  OVERLAY_Z_OFFSET,
  createCardBodyGeometry,
  createCardFaceGeometry,
} from "./cardGeometry";
import { CARD_ASPECT } from "./layout";

describe("card geometry", () => {
  test("creates a thin 5:7 card body", () => {
    const geometry = createCardBodyGeometry(3.5);

    expect(geometry).toBeInstanceOf(ExtrudeGeometry);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) throw new Error("expected bounding box");
    expect(box.max.x - box.min.x).toBeCloseTo(3.5 * CARD_ASPECT, 3);
    expect(box.max.y - box.min.y).toBeCloseTo(3.5, 3);
    expect(box.max.z - box.min.z).toBeCloseTo(0.08, 3);
  });

  test("creates face planes just above the card body", () => {
    const front = createCardFaceGeometry(3.5);

    expect(front).toBeInstanceOf(PlaneGeometry);
    front.computeBoundingBox();
    const box = front.boundingBox;
    if (!box) throw new Error("expected bounding box");
    expect(box.max.x - box.min.x).toBeCloseTo(3.5 * CARD_ASPECT, 3);
    expect(box.max.y - box.min.y).toBeCloseTo(3.5, 3);
  });

  test("keeps rendered layers above the card body", () => {
    expect(FACE_Z_OFFSET).toBeGreaterThan(CARD_WORLD_THICKNESS / 2);
    expect(OVERLAY_Z_OFFSET).toBeGreaterThan(FACE_Z_OFFSET);
  });
});
