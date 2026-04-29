import { BoxGeometry, PlaneGeometry } from "three";
import { CARD_ASPECT } from "./layout";

export const CARD_WORLD_HEIGHT = 3.5;
export const CARD_WORLD_THICKNESS = 0.08;
export const FACE_Z_OFFSET = CARD_WORLD_THICKNESS / 2 + 0.003;
export const OVERLAY_Z_OFFSET = CARD_WORLD_THICKNESS / 2 + 0.009;

export function createCardBodyGeometry(height = CARD_WORLD_HEIGHT) {
  return new BoxGeometry(height * CARD_ASPECT, height, CARD_WORLD_THICKNESS, 4, 4, 1);
}

export function createCardFaceGeometry(height = CARD_WORLD_HEIGHT) {
  return new PlaneGeometry(height * CARD_ASPECT, height, 1, 1);
}
