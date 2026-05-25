export const MANIA_HIDDEN_MIN_COVERAGE = 160;
export const MANIA_HIDDEN_MAX_COVERAGE = 400;
export const MANIA_HIDDEN_COVERAGE_PER_COMBO = 0.5;
export const MANIA_HIDDEN_COVERAGE_HALF_TIME_MS = 25;
export const MANIA_HIDDEN_FADE_HEIGHT_RATIO = 0.25;
export const MANIA_FLASHLIGHT_DEFAULT_HEIGHT = 50;
export const MANIA_FLASHLIGHT_EDGE_SMOOTHNESS = 1.1;
export const MANIA_FLASHLIGHT_DIM_ALPHA = 1;

export interface ManiaHiddenCoverageInput {
  combo: number;
  hitPosition: number;
  playfieldHeight: number;
  referenceHeight: number;
}

export interface ManiaHiddenAlphaInput {
  coveragePx: number;
  fadePx: number;
  judgmentY: number;
  upscroll: boolean;
  y: number;
}

export interface ManiaHiddenCoverageReferenceInput {
  coverageReference: number;
  hitPosition: number;
  playfieldHeight: number;
  referenceHeight: number;
}

export interface ManiaFlashlightBandInput {
  combo?: number;
  comboBasedSize?: boolean;
  playfieldHeight: number;
  referenceHeight: number;
  sizeReference?: number;
  sizeMultiplier?: number;
}

export interface ManiaFlashlightBand {
  bottom: number;
  edgeFade: number;
  top: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function getManiaHiddenCoverageReference(combo: number): number {
  const comboCoverage = Math.max(0, Math.floor(combo)) * MANIA_HIDDEN_COVERAGE_PER_COMBO;
  return Math.min(MANIA_HIDDEN_MAX_COVERAGE, MANIA_HIDDEN_MIN_COVERAGE + comboCoverage);
}

export function getManiaHiddenCoveragePx(input: ManiaHiddenCoverageInput): number {
  return getManiaHiddenCoverageReferencePx({
    coverageReference: getManiaHiddenCoverageReference(input.combo),
    hitPosition: input.hitPosition,
    playfieldHeight: input.playfieldHeight,
    referenceHeight: input.referenceHeight,
  });
}

export function getManiaHiddenCoverageReferencePx(input: ManiaHiddenCoverageReferenceInput): number {
  const referenceHeight = Math.max(1, input.referenceHeight);
  const playfieldHeight = Math.max(1, input.playfieldHeight);
  const hitPosition = Math.max(0, Math.min(referenceHeight - 1, input.hitPosition));
  const availableReferenceHeight = Math.max(1, referenceHeight - hitPosition);

  return playfieldHeight * Math.max(0, input.coverageReference) / availableReferenceHeight;
}

export function dampManiaHiddenCoverageReference(current: number, target: number, elapsedMs: number): number {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target)) return current;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return current;

  const amount = 1 - Math.pow(0.5, elapsedMs / MANIA_HIDDEN_COVERAGE_HALF_TIME_MS);
  return current + (target - current) * amount;
}

export function getManiaHiddenFadePx(playfieldHeight: number): number {
  return Math.max(1, playfieldHeight * MANIA_HIDDEN_FADE_HEIGHT_RATIO);
}

export function getManiaHiddenAlphaAtY(input: ManiaHiddenAlphaInput): number {
  const distanceBeforeHit = input.upscroll
    ? input.y - input.judgmentY
    : input.judgmentY - input.y;

  return clamp01((distanceBeforeHit - input.coveragePx) / Math.max(1, input.fadePx));
}

export function getManiaFlashlightBand(input: ManiaFlashlightBandInput): ManiaFlashlightBand {
  const referenceHeight = Math.max(1, input.referenceHeight);
  const playfieldHeight = Math.max(1, input.playfieldHeight);
  const sizeReference = getManiaFlashlightSizeReference(input);
  const height = playfieldHeight * sizeReference / referenceHeight;
  const centerY = playfieldHeight / 2;

  return {
    top: centerY - height / 2,
    bottom: centerY + height / 2,
    edgeFade: Math.max(1, height * MANIA_FLASHLIGHT_EDGE_SMOOTHNESS),
  };
}

export function getManiaFlashlightSizeReference(input: Pick<ManiaFlashlightBandInput, "combo" | "comboBasedSize" | "sizeMultiplier" | "sizeReference">): number {
  const base = Math.max(1, input.sizeReference ?? MANIA_FLASHLIGHT_DEFAULT_HEIGHT);
  const sizeMultiplier = Number.isFinite(input.sizeMultiplier) && Number(input.sizeMultiplier) > 0
    ? Number(input.sizeMultiplier)
    : 1;
  const combo = Math.max(0, Math.floor(input.combo ?? 0));
  const comboScale = input.comboBasedSize
    ? combo >= 200
      ? 0.625
      : combo >= 100
        ? 0.8125
        : 1
    : 1;

  return base * sizeMultiplier * comboScale;
}
