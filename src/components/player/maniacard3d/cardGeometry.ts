import { ExtrudeGeometry, PlaneGeometry, Shape } from "three";
import { CARD_ASPECT } from "./layout";

export const CARD_WORLD_HEIGHT = 4.2;
export const CARD_WORLD_THICKNESS = 0.08;
export const FACE_Z_OFFSET = CARD_WORLD_THICKNESS / 2 + 0.003;
export const OVERLAY_Z_OFFSET = CARD_WORLD_THICKNESS / 2 + 0.009;

export function createCardBodyGeometry(height = CARD_WORLD_HEIGHT) {
  const width = height * CARD_ASPECT;
  const radius = height * 0.055;
  const x = -width / 2;
  const y = -height / 2;
  const shape = new Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);

  const geometry = new ExtrudeGeometry(shape, {
    depth: CARD_WORLD_THICKNESS,
    bevelEnabled: false,
  });
  geometry.translate(0, 0, -CARD_WORLD_THICKNESS / 2);
  return geometry;
}

export function createCardFaceGeometry(height = CARD_WORLD_HEIGHT) {
  return new PlaneGeometry(height * CARD_ASPECT, height, 1, 1);
}
