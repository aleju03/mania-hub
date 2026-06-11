import {
  Color,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import type { Texture } from "three";
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH, type ShaderQuality } from "./layout";
import { cardOverlayFragmentShader, cardOverlayVertexShader } from "./cardShaders";
import type { FaceLayout } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

export function createEdgeMaterial(data: ManiaCardReadyData) {
  return new MeshStandardMaterial({
    color: new Color(data.edgeColor.r / 255, data.edgeColor.g / 255, data.edgeColor.b / 255),
    roughness: 0.36,
    metalness: 0.18,
  });
}

export function createFaceMaterial(texture: Texture) {
  return new MeshBasicMaterial({
    map: texture,
    transparent: true,
    toneMapped: false,
  });
}

export function createOverlayMaterial(
  data: ManiaCardReadyData,
  layout: FaceLayout,
  shaderQuality: ShaderQuality = "high",
) {
  const avatar = layout.masks.avatar;
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    defines: {
      MC_MEDIUM: shaderQuality === "medium" ? 1 : 0,
    },
    vertexShader: cardOverlayVertexShader,
    fragmentShader: cardOverlayFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.88 },
      // Common cards keep the triangle sparkle but drop the holo/foil sheen.
      uFoil: { value: data.tier === "common" ? 0 : 1 },
      // World Class trades the triangle sparkle for a drifting starfield.
      uStarfield: { value: data.tier === "worldClass" ? 1 : 0 },
      uLight: { value: new Vector2(0.5, 0.38) },
      uTierColor: { value: new Vector3(data.glowColor.r / 255, data.glowColor.g / 255, data.glowColor.b / 255) },
      uAvatarMask: {
        value: new Vector4(
          avatar.x / CARD_TEXTURE_WIDTH,
          1 - (avatar.y + avatar.height) / CARD_TEXTURE_HEIGHT,
          avatar.width / CARD_TEXTURE_WIDTH,
          avatar.height / CARD_TEXTURE_HEIGHT,
        ),
      },
      uTextureSize: { value: new Vector2(CARD_TEXTURE_WIDTH, CARD_TEXTURE_HEIGHT) },
      uAvatarRadius: { value: layout.front.avatar.radius },
    },
  });
}
