export const CARD_TEXTURE_WIDTH = 1000;
export const CARD_TEXTURE_HEIGHT = 1400;
export const CARD_ASPECT = CARD_TEXTURE_WIDTH / CARD_TEXTURE_HEIGHT;

export type StarSegment = "full" | "half" | "empty";
export type ShaderQuality = "medium" | "high";
export type IdleMotion = "off" | "continuous" | "wake-on-input";

export interface QualityInput {
  mobile: boolean;
  reducedMotion: boolean;
  devicePixelRatio: number;
}

export interface QualityProfile {
  pixelRatio: number;
  textureScale: number;
  antialias: boolean;
  adaptiveIdle: boolean;
  shaderQuality: ShaderQuality;
  idleMotion: IdleMotion;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function truncateToWidth(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
) {
  if (measure(text) <= maxWidth) return text;
  const ellipsis = "...";
  if (measure(ellipsis) > maxWidth) return "";
  let next = text;
  while (next.length > 0 && measure(`${next}${ellipsis}`) > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next}${ellipsis}`;
}

export function buildStarSegments(value: number, count = Math.min(10, Math.max(1, Math.ceil(value)))): StarSegment[] {
  return Array.from({ length: count }, (_, index) => {
    const remaining = value - index;
    if (remaining >= 1) return "full";
    if (remaining >= 0.5) return "half";
    return "empty";
  });
}

export function resolveQualityProfile(input: QualityInput): QualityProfile {
  if (input.reducedMotion) {
    return {
      pixelRatio: 1,
      textureScale: 0.75,
      antialias: true,
      adaptiveIdle: true,
      shaderQuality: "medium",
      idleMotion: "off",
    };
  }

  if (input.mobile) {
    return {
      pixelRatio: clamp(input.devicePixelRatio, 1, 1.25),
      textureScale: 0.75,
      antialias: false,
      adaptiveIdle: true,
      shaderQuality: "medium",
      idleMotion: "wake-on-input",
    };
  }

  return {
    pixelRatio: clamp(input.devicePixelRatio, 1, 2),
    textureScale: 1,
    antialias: true,
    adaptiveIdle: false,
    shaderQuality: "high",
    idleMotion: "continuous",
  };
}
