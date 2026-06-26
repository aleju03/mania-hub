import type { CSSProperties } from "react";
import { MOD_GLYPHS } from "./mod-glyphs";

// Renders a mod icon as a single inline SVG vector recolored through currentColor.
// This replaces the old CSS mask-image + color-mix approach, where every icon
// (one per player-avatar-with-a-mod, plus the per-card dominant-mod badge) became
// its own GPU-composited layer. On the farmed grid that was ~118 layers; inline
// vectors paint into the normal layer instead, so the maps page stops pegging the GPU.
export function ModGlyph({
  file,
  color,
  className,
  style,
}: {
  file: string;
  color: string;
  className?: string;
  style?: CSSProperties;
}) {
  const glyph = MOD_GLYPHS[file];
  if (!glyph) return null;
  return (
    <svg
      viewBox={glyph.viewBox}
      // fill="none" keeps stroke-only icons (hidden, fade-in) as strokes; filled
      // icons set fill="currentColor" on their own paths and override this.
      fill="none"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      className={className}
      style={{ color, ...style }}
      dangerouslySetInnerHTML={{ __html: glyph.inner }}
    />
  );
}
