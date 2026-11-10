import { useEffect, useRef, useState } from "react";

import { PROFILE_THEME_LOOKS, type HighwayChart, type HighwayNotes, type HighwayPlay, type SupporterProfileThemeId } from "../../lib/supporter-profile-themes";
import { customThemeKey, hideBrokenImage, isCustomThemeBadHere } from "../../lib/custom-themes";
import type { BackdropTheme, ProfileBackdrop } from "../../lib/profile-theme-gl";
import { queueGpuWork } from "../../lib/gpu-queue";
import { useWebGlSlot } from "../../lib/gl-budget";

/* A profile theme's living backdrop, filling the box it is given. Shows the
   theme's flat colour until the shader (loaded on demand) draws, and fades
   from one theme to the next by keeping the canvas and swapping its program.
   A supporter's own theme shows its still instead when it may only show that,
   has crashed on this device, or proves too slow here. */
export function ProfileThemeBackdrop({ theme, notes = null, chart = null, play = null, scroll = false, maxPixels, className }: {
  theme: BackdropTheme;
  /** A player's replay skin notes, for the Note highway. */
  notes?: HighwayNotes | null;
  /** A real chart for the Note highway to play. */
  chart?: HighwayChart | null;
  /** A visitor playing the Note highway (use-highway-play.ts). */
  play?: HighwayPlay | null;
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
  const playRef = useRef(play);
  playRef.current = play;
  // a context only while it holds a slot (gl-budget.ts); the flat colour shows otherwise
  const glSlot = useWebGlSlot(hostRef);
  /* The custom theme revision that fell back to its still here, if any. */
  const [fellBack, setFellBack] = useState<string | null>(null);
  const custom = typeof theme === "string" ? null : theme;
  const customKey = custom ? customThemeKey(custom) : null;
  // read after hydration: the server can't know what crashed on this device
  const [badHere, setBadHere] = useState(false);
  useEffect(() => {
    setBadHere(custom ? isCustomThemeBadHere(custom) : false);
  }, [customKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const stillOnly = custom !== null && (custom.compiled === null || fellBack === customKey || badHere);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !glSlot || stillOnly) return;
    let cancelled = false;
    let unqueue: (() => void) | undefined;
    // a new WebGL context is heavy, so it waits for a quiet moment (gpu-queue.ts)
    void import("../../lib/profile-theme-gl").then(({ mountProfileBackdrop }) => {
      if (cancelled) return;
      unqueue = queueGpuWork(() => {
        if (cancelled) return;
        backdropRef.current = mountProfileBackdrop(host, themeRef.current, { scroll, maxPixels, onFallback: (fallen) => setFellBack(customThemeKey(fallen)) });
        backdropRef.current?.setNotes(notesRef.current);
        backdropRef.current?.setChart(chartRef.current);
        backdropRef.current?.setPlay(playRef.current);
      });
    });
    return () => {
      cancelled = true;
      unqueue?.();
      backdropRef.current?.dispose();
      backdropRef.current = null;
    };
  }, [scroll, maxPixels, glSlot, stillOnly]);

  useEffect(() => {
    backdropRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    backdropRef.current?.setNotes(notes);
  }, [notes]);

  useEffect(() => {
    backdropRef.current?.setChart(chart);
  }, [chart]);

  useEffect(() => {
    backdropRef.current?.setPlay(play);
  }, [play]);

  const base = custom ? custom.look.base : PROFILE_THEME_LOOKS[theme as SupporterProfileThemeId].base;
  return (
    <div ref={hostRef} aria-hidden className={className} style={{ backgroundColor: base }}>
      {/* A custom theme's still sits under the live canvas, which fades in over
          it once its first full-size frame is drawn: no blank wait while the
          program compiles, its pictures load and its cost is measured. */}
      {custom && <img src={custom.stillUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" onError={hideBrokenImage} />}
    </div>
  );
}

/* A frame of each theme rendered ahead of time (320x200, from the real
   backdrop a few seconds in), so a still tile shows at once and shows the
   theme as it really looks, not a first frame its shader has barely begun. */
export function profileThemeThumb(theme: SupporterProfileThemeId): string {
  return `/images/profile-themes/thumbs/${theme}.webp?v=${THEME_THUMB_VERSION}`;
}

/* The thumb fading in from clear on the left, for the banner behind a list
   row (made from the thumbs by foundry/designs/row-banner/make_strips.py). */
export function profileThemeStrip(theme: SupporterProfileThemeId): string {
  return `/images/profile-themes/strips/${theme}.webp?v=${THEME_THUMB_VERSION}`;
}

/* Bump after re-rendering a thumb (and its strip): /images/ is served cache-first by the
   service worker, so a changed file needs a new URL. */
const THEME_THUMB_VERSION = 17;

/* A thumbnail of a theme's backdrop, for the drawer and the slot: the
   rendered still, or live while `still` is off, over that same still until
   its shader draws. */
export function ProfileThemeSwatch({ theme, still = false, className }: { theme: SupporterProfileThemeId; still?: boolean; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || still) return;
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
      if (!cancelled) cleanup = mountThemeSwatch(canvas, theme, false);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [theme, still]);
  const backing = PROFILE_THEME_LOOKS[theme].swatch;
  if (still) return <img src={profileThemeThumb(theme)} alt="" aria-hidden draggable={false} className={`object-cover ${className ?? ""}`} style={{ background: backing }} />;
  return <canvas ref={canvasRef} aria-hidden className={className} style={{ background: `url(${profileThemeThumb(theme)}) center / cover, ${backing}` }} />;
}
