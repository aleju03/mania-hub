import { clamp } from "./layout";

export interface Rotation2D {
  x: number;
  y: number;
}

export interface Light2D {
  x: number;
  y: number;
}

export interface InteractionState {
  dragging: boolean;
  flipped: boolean;
  rotation: Rotation2D;
  targetRotation: Rotation2D;
  light: Light2D;
  lastInputAt: number;
}

export function createInteractionState(): InteractionState {
  return {
    dragging: false,
    flipped: false,
    rotation: { x: 0, y: 0 },
    targetRotation: { x: 0, y: 0 },
    light: { x: 0.5, y: 0.38 },
    lastInputAt: 0,
  };
}

export function pointerToRotation(delta: { deltaX: number; deltaY: number }): Rotation2D {
  return {
    x: Math.round(clamp(delta.deltaY * 0.22, -24, 24)),
    y: Math.round(delta.deltaX * 0.35),
  };
}

export function addRotation(base: Rotation2D, delta: Rotation2D): Rotation2D {
  return {
    x: Math.round(clamp(base.x + delta.x, -24, 24)),
    y: Math.round(base.y + delta.y),
  };
}

export function orientationToRotation(input: { beta: number; gamma: number; restBeta: number }): Rotation2D {
  return {
    x: Math.round(clamp(-(input.beta - input.restBeta), -24, 24)),
    y: Math.round(clamp(-input.gamma, -24, 24)),
  };
}

export function pointerToLight(rotation: Rotation2D): Light2D {
  const wrappedY = wrapDegrees(rotation.y);
  return {
    x: Number(clamp(0.5 - wrappedY * 0.004, 0.08, 0.92).toFixed(2)),
    y: Number(clamp(0.38 + rotation.x * 0.02, 0.1, 0.9).toFixed(2)),
  };
}

function wrapDegrees(degrees: number) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

export function settleRotation(rotation: Rotation2D, factor: number): Rotation2D {
  return {
    x: Number((rotation.x * (1 - factor)).toFixed(3)),
    y: Number((rotation.y * (1 - factor)).toFixed(3)),
  };
}
