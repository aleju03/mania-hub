import type { ReplayViewportSnapshot } from "../replay-types";

type Size = { width: number; height: number };

export type ReplayExportLayout = "current" | "fullscreen";
export const DEFAULT_REPLAY_EXPORT_LAYOUT: ReplayExportLayout = "current";

/** Fit the current view inside the preset's pixel budget, or use exact 16:9. */
export function replayExportDimensions(viewport: Size, preset: Size, layout: ReplayExportLayout = DEFAULT_REPLAY_EXPORT_LAYOUT): Size {
  if (layout === "fullscreen") return { width: preset.width, height: preset.height };
  const scale = Math.min(preset.width / viewport.width, preset.height / viewport.height);
  // Video codecs need even dimensions. Keep the logical viewport untouched;
  // composition handles the subpixel difference at the edges.
  return {
    width: Math.max(2, Math.round(viewport.width * scale / 2) * 2),
    height: Math.max(2, Math.round(viewport.height * scale / 2) * 2),
  };
}

/** Preserve the captured layout unless fullscreen reframing was requested. */
export function replayExportViewport(viewport: ReplayViewportSnapshot, output: Size, layout: ReplayExportLayout = DEFAULT_REPLAY_EXPORT_LAYOUT): ReplayViewportSnapshot {
  if (layout === "current") return { ...viewport };
  return { ...viewport, height: viewport.width * output.height / output.width, fullscreen: true };
}

/** Fit the entire captured stage with one transform, preserving every gap and proportion. */
export function fitReplayComposition(viewport: Size, output: Size) {
  const scale = Math.min(output.width / viewport.width, output.height / viewport.height);
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  const matchesAspect = Math.abs(viewport.height * output.width / viewport.width - output.height) <= 1
    || Math.abs(viewport.width * output.height / viewport.height - output.width) <= 1;
  if (matchesAspect) {
    // Rasterize all the way to the edges. Even-pixel rounding can otherwise
    // leave a fractional black seam; this only adjusts codec alignment,
    // never crops the composition or changes its logical layout.
    return { x: 0, y: 0, width: output.width, height: output.height, scale };
  }
  return { x: (output.width - width) / 2, y: (output.height - height) / 2, width, height, scale };
}
