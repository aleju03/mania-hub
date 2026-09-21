import type { ReplayViewportSnapshot } from "../replay-types";

type Size = { width: number; height: number };

/** Video presets always mean standard 16:9 pixel dimensions. */
export function replayExportDimensions(_viewport: Size, preset: Size): Size {
  return { width: preset.width, height: preset.height };
}

/** Use the same layout as a fullscreen viewport at the viewer's width. */
export function replayExportViewport(viewport: ReplayViewportSnapshot, output: Size): ReplayViewportSnapshot {
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
