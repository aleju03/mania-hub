import {
  Color,
  DataTexture,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import type { Texture } from "three";
import { CARD_TEXTURE_HEIGHT, CARD_TEXTURE_WIDTH, type ShaderQuality } from "./layout";
import { cardOverlayFragmentShader, cardOverlayVertexShader } from "./cardShaders";
import { getCosmicTierPalette, type PreparedCardMotif } from "./cardTexture";
import type { FaceLayout } from "./textureLayout";
import type { ManiaCardReadyData } from "./types";

export function createEdgeMaterial(data: ManiaCardReadyData) {
  return new MeshStandardMaterial({
    color: new Color(data.edgeColor.r / 255, data.edgeColor.g / 255, data.edgeColor.b / 255),
    roughness: 0.36,
    metalness: 0.18,
  });
}

/* Bound to uMotif on every card that has no motif of its own. A sampler must
   point at something, and one shared transparent pixel is cheaper than making
   the shader branch on a texture that is never read. */
let emptyMotifTexture: DataTexture | null = null;

function getEmptyMotifTexture(): DataTexture {
  if (!emptyMotifTexture) {
    emptyMotifTexture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, RGBAFormat);
    emptyMotifTexture.needsUpdate = true;
  }
  return emptyMotifTexture;
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
  /* The motif this card's front drew, already uploaded as a texture and sized
     in grid cells. Null keeps the tier's own drifting layer, which is what
     every un-granted card wants. */
  motif: PreparedCardMotif | null = null,
) {
  const avatar = layout.masks.avatar;
  const cosmic = getCosmicTierPalette(data.tier, data.motif);
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
      // Cosmic tiers trade the triangle sparkle for a drifting starfield.
      uStarfield: { value: cosmic ? 1 : 0 },
      uLight: { value: new Vector2(0.5, 0.38) },
      uTierColor: { value: new Vector3(data.glowColor.r / 255, data.glowColor.g / 255, data.glowColor.b / 255) },
      uStarTint: { value: new Vector3(...(cosmic?.starTint ?? [0.78, 1.0, 0.9])) },
      uMotif: { value: motif?.texture ?? getEmptyMotifTexture() },
      uMotifOn: { value: motif ? 1 : 0 },
      uMotifSize: { value: new Vector2(motif?.cellWidth ?? 0.34, motif?.cellHeight ?? 0.34) },
      uMotifOpacity: { value: motif?.opacity ?? 1 },
      uRainbow: { value: cosmic?.rainbow ?? 1 },
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
