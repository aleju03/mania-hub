import type { CSSProperties, SyntheticEvent } from "react";
import { getLiveBackendUrl } from "./live-backend";

/* A supporter's own profile theme as a profile draws it (backend
   features/custom-themes.ts). `compiled` is the guarded GLSL the backend made
   on save (custom-themes/source.ts): the prelude, CUSTOM_THEME_INPUTS and the
   built-ins' main wrap it the same way they wrap a built-in theme
   (profile-theme-gl.ts). It is null while the theme may only show its still:
   hidden after crashes, or every custom theme switched off. */
export interface CustomTheme {
  themeId: number;
  rev: number;
  name: string;
  author: { id: number; username: string };
  format: "theme" | "shadertoy";
  compiled: string | null;
  assets: string[];
  look: { hue: number; sat: number; base: string };
  stillUrl: string;
  rowUrl: string | null;
  /** Listed in the gallery right now, where it can be reported. */
  inGallery?: boolean;
}

const ASSET_URL = /^https:\/\/cdn\.mania-tracker\.com\/theme-assets\/[a-f0-9]{64}\.webp$/;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

export function parseCustomTheme(value: unknown): CustomTheme | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const look = raw.look as Record<string, unknown> | undefined;
  const author = raw.author as Record<string, unknown> | undefined;
  const themeId = Number(raw.themeId);
  const rev = Number(raw.rev);
  if (!Number.isSafeInteger(themeId) || themeId <= 0 || !Number.isSafeInteger(rev) || rev <= 0) return null;
  if (!look || typeof look.hue !== "number" || typeof look.sat !== "number" || typeof look.base !== "string" || !HEX_COLOUR.test(look.base)) return null;
  if (typeof raw.stillUrl !== "string" || !ASSET_URL.test(raw.stillUrl)) return null;
  const assets = Array.isArray(raw.assets) ? raw.assets.filter((url): url is string => typeof url === "string" && ASSET_URL.test(url)).slice(0, 4) : [];
  return {
    themeId,
    rev,
    name: typeof raw.name === "string" ? raw.name : "",
    author: { id: Number(author?.id) || 0, username: typeof author?.username === "string" ? author.username : "" },
    format: raw.format === "shadertoy" ? "shadertoy" : "theme",
    compiled: typeof raw.compiled === "string" && raw.compiled ? raw.compiled : null,
    assets,
    look: { hue: Math.min(360, Math.max(0, look.hue)), sat: Math.min(1, Math.max(0, look.sat)), base: look.base },
    stillUrl: raw.stillUrl,
    rowUrl: typeof raw.rowUrl === "string" && ASSET_URL.test(raw.rowUrl) ? raw.rowUrl : null,
    inGallery: raw.inGallery === true,
  };
}

/* How strongly the player's cover shows in the hero over a custom theme (a built-in sets its own). */
export const CUSTOM_THEME_COVER = 0.2;

/* One program per revision: a new save is a new key. */
export function customThemeKey(theme: CustomTheme): string {
  return `custom:${theme.themeId}@${theme.rev}`;
}

/* The site's colours on a profile wearing it, as profileThemeStyle does for a built-in. */
export function customThemeStyle(theme: CustomTheme): CSSProperties {
  return { "--theme-hue": String(theme.look.hue), "--theme-sat": String(theme.look.sat), "--theme-surface": "3" } as CSSProperties;
}

/* --- Themes that crashed on this device --------------------------------- */

/* Revisions that lost the WebGL context here: they show their still on this
   device from then on, whatever the backend says. */
const BAD_THEMES_KEY = "mania-hub-bad-custom-themes";
const BAD_THEMES_MAX = 50;

function readBadThemes(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(BAD_THEMES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

export function isCustomThemeBadHere(theme: CustomTheme): boolean {
  return typeof window !== "undefined" && readBadThemes().includes(customThemeKey(theme));
}

/* Remembers the crash here and tells the backend, which hides the theme to
   its still once enough different visitors report one. Once per revision. */
export function reportCustomThemeCrash(theme: CustomTheme): void {
  if (typeof window === "undefined") return;
  const key = customThemeKey(theme);
  const bad = readBadThemes();
  if (bad.includes(key)) return;
  try {
    window.localStorage.setItem(BAD_THEMES_KEY, JSON.stringify([...bad, key].slice(-BAD_THEMES_MAX)));
  } catch {
    // storage full or off: the report still goes
  }
  // A signed-in viewer's report goes through the bridge, where it counts
  // toward hiding the theme; a signed-out one is only a hint for the admin.
  void import("./custom-theme-reports")
    .then(({ reportCustomThemeCrashSignedIn }) => reportCustomThemeCrashSignedIn({ data: { themeId: theme.themeId, rev: theme.rev } }))
    .then((sent) => {
      if (!sent) sendAnonymousCrash(theme);
    })
    .catch(() => sendAnonymousCrash(theme));
}

function sendAnonymousCrash(theme: CustomTheme): void {
  const base = getLiveBackendUrl();
  if (!base) return;
  const url = `${base}/api/supporters/themes/${theme.themeId}/crash`;
  // a plain-text beacon needs no preflight and survives the tab closing
  const body = JSON.stringify({ rev: theme.rev });
  if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(url, body)) return;
  void fetch(url, { method: "POST", body, keepalive: true, mode: "no-cors" }).catch(() => {});
}

/* A theme's still that failed to load leaves the tile's base colour showing, not a broken image. */
export function hideBrokenImage(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.visibility = "hidden";
}
