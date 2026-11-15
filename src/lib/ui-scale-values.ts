/* The UI Scaling range, shared by the setting (ui-scale.ts) and the build step
   that scales the stylesheet's px lengths and breakpoints
   (scripts/ui-scale-postcss.ts). No imports: the Vite config loads it.

   The slider runs like lazer's, 0.8x to 1.6x in 0.05 steps, and sizes follow
   it exactly through --ui-scale. Breakpoints cannot read a variable, so the
   build copies each width query once per UI_SCALE_BREAKPOINTS step and the
   page uses the copy nearest the slider (data-ui-scale). */
export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.6;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_BREAKPOINTS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6] as const;

export function normalizeUiScale(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, number));
  return Number((Math.round(clamped / UI_SCALE_STEP) * UI_SCALE_STEP).toFixed(2));
}

/* The breakpoint copy a scale uses: the nearest prepared step. */
export function breakpointScale(scale: number): number {
  let best: number = UI_SCALE_BREAKPOINTS[0];
  for (const step of UI_SCALE_BREAKPOINTS) if (Math.abs(step - scale) < Math.abs(best - scale)) best = step;
  return best;
}

/* A px length that follows UI Scaling, for sizes set inline from a number
   (an avatar's `size`), which the stylesheet build never sees. */
export function scaledPx(px: number): string {
  return px === 0 ? "0px" : `calc(${px}px * var(--ui-scale, 1))`;
}

/* A width or height media query moved by the current breakpoint step, for the
   checks made in script (matchMedia), so they switch where the stylesheet's
   breakpoints do. Read when called: a check made before the scale changes
   keeps its old threshold until it runs again. */
export function scaledMediaQuery(query: string): string {
  if (typeof document === "undefined") return query;
  const scale = Number(document.documentElement.getAttribute("data-ui-scale")) || 1;
  if (scale === 1 || !/(width|height)/.test(query)) return query;
  return query.replace(/(\d*\.?\d+)(px|rem|em)\b/g, (_match, number: string, unit: string) => `${Number((Number(number) * scale).toFixed(4))}${unit}`);
}
