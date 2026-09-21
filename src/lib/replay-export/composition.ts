type Size = { width: number; height: number };

/** The preset is picture height; width follows the captured stage's aspect ratio. */
export function replayExportDimensions(viewport: Size, preset: Size): Size {
  const scale = preset.height / viewport.height;
  // Even dimensions work with the 4:2:0 encoders on both codec paths.
  return {
    width: Math.max(2, Math.round(viewport.width * scale / 2) * 2),
    height: preset.height,
  };
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
