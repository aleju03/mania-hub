import { useEffect, useRef } from "react";

import { PROFILE_THEME_LOOKS, type HighwayChart, type HighwayNotes, type SupporterProfileThemeId } from "../../lib/supporter-profile-themes";
import type { ProfileBackdrop } from "../../lib/profile-theme-gl";

/* A profile theme's living backdrop, filling the box it is given. Shows the
   theme's flat colour until the shader (loaded on demand) draws, and fades
   from one theme to the next by keeping the canvas and swapping its program. */
export function ProfileThemeBackdrop({ theme, notes = null, chart = null, scroll = false, maxPixels, className }: {
  theme: SupporterProfileThemeId;
  /** A player's replay skin notes, for the Note highway. */
  notes?: HighwayNotes | null;
  /** A real chart for the Note highway to play. */
  chart?: HighwayChart | null;
  /** Follow the page's scroll, for a backdrop behind a whole page. */
  scroll?: boolean;
  maxPixels?: number;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<ProfileBackdrop | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const chartRef = useRef(chart);
  chartRef.current = chart;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    void import("../../lib/profile-theme-gl").then(({ mountProfileBackdrop }) => {
      if (cancelled) return;
      backdropRef.current = mountProfileBackdrop(host, themeRef.current, { scroll, maxPixels });
      backdropRef.current?.setNotes(notesRef.current);
      backdropRef.current?.setChart(chartRef.current);
    });
    return () => {
      cancelled = true;
      backdropRef.current?.dispose();
      backdropRef.current = null;
    };
  }, [scroll, maxPixels]);

  useEffect(() => {
    backdropRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    backdropRef.current?.setNotes(notes);
  }, [notes]);

  useEffect(() => {
    backdropRef.current?.setChart(chart);
  }, [chart]);

  return <div ref={hostRef} aria-hidden className={className} style={{ backgroundColor: PROFILE_THEME_LOOKS[theme].base }} />;
}

/* A live thumbnail of a theme's backdrop, for the drawer and the slot. */
export function ProfileThemeSwatch({ theme, still = false, className }: { theme: SupporterProfileThemeId; still?: boolean; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    // Setting a canvas's size wipes it even to the same size, which flashed the
    // placeholder behind it every time a swatch went live on hover.
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void import("../../lib/profile-theme-gl").then(({ mountThemeSwatch }) => {
      if (!cancelled) cleanup = mountThemeSwatch(canvas, theme, still);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [theme, still]);
  return <canvas ref={canvasRef} aria-hidden className={className} style={{ background: PROFILE_THEME_LOOKS[theme].swatch }} />;
}
