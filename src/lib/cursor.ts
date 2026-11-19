import { normalizeEditableHex } from "./replay-preferences";

export const CURSOR_SETTINGS_STORAGE_KEY = "mania-hub-cursor-v1";

export interface CursorSettings {
  enabled: boolean;
  /** #rrggbb tint for the cursor glow. */
  color: string;
  /** Size percent, 50-200. */
  size: number;
  /** Outer glow extent percent, 0 (none) to 100. */
  glow: number;
  trail: boolean;
  /** #rrggbb tint for the cursor trail. */
  trailColor: string;
  /** Trail thickness percent, 25-200. */
  trailThickness: number;
}

export const DEFAULT_CURSOR_SETTINGS: CursorSettings = {
  enabled: false,
  color: "#ff66ab",
  size: 100,
  glow: 35,
  trail: true,
  trailColor: "#ff66ab",
  trailThickness: 100,
};

export const CURSOR_COLOR_PRESETS: { label: string; value: string }[] = [
  { label: "Pink", value: "#ff66ab" },
  { label: "White", value: "#f5f5fa" },
  { label: "Blue", value: "#66baff" },
  { label: "Green", value: "#a6e478" },
  { label: "Purple", value: "#b892ff" },
  { label: "Yellow", value: "#ffd673" },
];

export const CURSOR_SIZE_MIN = 50;
export const CURSOR_SIZE_MAX = 200;
export const CURSOR_GLOW_MIN = 0;
export const CURSOR_GLOW_MAX = 100;
export const CURSOR_TRAIL_THICKNESS_MIN = 25;
export const CURSOR_TRAIL_THICKNESS_MAX = 200;

export function normalizeCursorSettings(value: unknown): CursorSettings {
  if (value == null || typeof value !== "object") return { ...DEFAULT_CURSOR_SETTINGS };
  const raw = value as Partial<Record<keyof CursorSettings, unknown>>;
  const size = typeof raw.size === "number" && Number.isFinite(raw.size)
    ? Math.min(CURSOR_SIZE_MAX, Math.max(CURSOR_SIZE_MIN, Math.round(raw.size)))
    : DEFAULT_CURSOR_SETTINGS.size;
  const glow = typeof raw.glow === "number" && Number.isFinite(raw.glow)
    ? Math.min(CURSOR_GLOW_MAX, Math.max(CURSOR_GLOW_MIN, Math.round(raw.glow)))
    : DEFAULT_CURSOR_SETTINGS.glow;
  const color =
    normalizeEditableHex(typeof raw.color === "string" ? raw.color : "") ?? DEFAULT_CURSOR_SETTINGS.color;
  return {
    enabled: raw.enabled === true,
    color,
    size,
    glow,
    trail: raw.trail !== false,
    // Older stored settings had no trail color; follow the cursor color then.
    trailColor: normalizeEditableHex(typeof raw.trailColor === "string" ? raw.trailColor : "") ?? color,
    trailThickness: typeof raw.trailThickness === "number" && Number.isFinite(raw.trailThickness)
      ? Math.min(CURSOR_TRAIL_THICKNESS_MAX, Math.max(CURSOR_TRAIL_THICKNESS_MIN, Math.round(raw.trailThickness)))
      : DEFAULT_CURSOR_SETTINGS.trailThickness,
  };
}

type CursorSettingsListener = (settings: CursorSettings) => void;
const listeners = new Set<CursorSettingsListener>();

export function readCursorSettings(): CursorSettings {
  if (typeof window === "undefined") return { ...DEFAULT_CURSOR_SETTINGS };
  try {
    const stored = window.localStorage.getItem(CURSOR_SETTINGS_STORAGE_KEY);
    return normalizeCursorSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_CURSOR_SETTINGS };
  }
}

export function writeCursorSettings(settings: CursorSettings): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeCursorSettings(settings);
  try {
    window.localStorage.setItem(CURSOR_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Quota or privacy mode; the in-memory listeners still get the update.
  }
  for (const listener of listeners) listener(normalized);
}

export function subscribeCursorSettings(listener: CursorSettingsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* Smoke (hold C to draw, like osu!'s in-play smoke): strokes hold at full
   strength for a moment, then fade out. */
export const SMOKE_HOLD_MS = 4000;
export const SMOKE_FADE_MS = 1500;
export const SMOKE_LIFETIME_MS = SMOKE_HOLD_MS + SMOKE_FADE_MS;

export function smokeAlpha(ageMs: number): number {
  if (ageMs <= SMOKE_HOLD_MS) return 1;
  if (ageMs >= SMOKE_LIFETIME_MS) return 0;
  return 1 - (ageMs - SMOKE_HOLD_MS) / SMOKE_FADE_MS;
}

/** True when the segment (ax,ay)-(bx,by) passes within `radius` of (cx,cy). */
export function segmentHitsCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = 0;
  if (lengthSq > 0) {
    t = ((cx - ax) * dx + (cy - ay) * dy) / lengthSq;
    t = Math.min(1, Math.max(0, t));
  }
  const nearestX = ax + dx * t;
  const nearestY = ay + dy * t;
  return Math.hypot(cx - nearestX, cy - nearestY) <= radius;
}

/* Pointer motion, for drawing the cursor effects where the native cursor will
   be when the frame is shown. */
export interface PointerMotion {
  /** Smoothed velocity in px/ms. */
  vx: number;
  vy: number;
  /** Smoothed turn rate in rad/ms. */
  turn: number;
  /** How far the smoothed velocity's direction trails the pointer's own. */
  lagMs: number;
  /** When the last move was measured. */
  at: number;
}

const MOTION_SMOOTHING = 0.6;
const TURN_SMOOTHING = 0.5;
const MAX_LEAD_TURN = Math.PI / 2;

export function resetPointerMotion(motion: PointerMotion, now: number): void {
  motion.vx = 0;
  motion.vy = 0;
  motion.turn = 0;
  motion.lagMs = 0;
  motion.at = now;
}

/** Fold a move of (dx, dy) over `elapsed` ms into the motion. */
export function trackPointerMotion(motion: PointerMotion, dx: number, dy: number, elapsed: number, now: number): void {
  const prevVx = motion.vx;
  const prevVy = motion.vy;
  motion.vx += (dx / elapsed - prevVx) * MOTION_SMOOTHING;
  motion.vy += (dy / elapsed - prevVy) * MOTION_SMOOTHING;
  if ((prevVx !== 0 || prevVy !== 0) && (motion.vx !== 0 || motion.vy !== 0)) {
    const angle = Math.atan2(prevVx * motion.vy - prevVy * motion.vx, prevVx * motion.vx + prevVy * motion.vy);
    motion.turn += (angle / elapsed - motion.turn) * TURN_SMOOTHING;
  } else {
    motion.turn = 0;
  }
  // A move's velocity is its direction half an interval ago, and the
  // smoothing adds the weighted age of the moves before it.
  motion.lagMs = elapsed * (0.5 + (1 - MOTION_SMOOTHING) / MOTION_SMOOTHING);
  motion.at = now;
}

/* Where the pointer will be `ms` after its last move. It follows the arc the
   pointer is turning along: a straight line leaves a fast circle along the
   tangent. */
export function pointerLead(motion: PointerMotion, ms: number): { x: number; y: number } {
  if (ms <= 0) return { x: 0, y: 0 };
  const clampTurn = (angle: number) => Math.min(MAX_LEAD_TURN, Math.max(-MAX_LEAD_TURN, angle));
  const turned = clampTurn(motion.turn * ms);
  const chord = Math.abs(turned) < 1e-6 ? 1 : Math.sin(turned / 2) / (turned / 2);
  const angle = clampTurn(motion.turn * motion.lagMs) + turned / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: (motion.vx * cos - motion.vy * sin) * ms * chord,
    y: (motion.vx * sin + motion.vy * cos) * ms * chord,
  };
}
