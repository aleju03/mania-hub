import { createServerFn } from "@tanstack/react-start";

import type { CustomThemeSourceError } from "#custom-themes/source";
import type { LayerDoc } from "./custom-theme-layers";
import { getLiveBackendUrl } from "./live-backend";
import { bridgeAuthHeaders } from "./live-backend-tokens";
import { requireViewer } from "./supporter-look-settings";

/* The supporter's own themes behind /supporter/themes (backend
   features/custom-themes.ts): list, open, save, publish, delete and wear,
   through the bridge with the viewer from the login cookie. The gallery is
   public and read straight from the backend. */

export type CustomThemeVisibility = "private" | "gallery";
export type CustomThemeState = "live" | "auto_hidden" | "taken_down";

export interface CustomThemeLook {
  hue: number;
  sat: number;
  base: string;
}

export interface CustomThemeSummary {
  id: number;
  name: string;
  author: { id: number; username: string };
  visibility: CustomThemeVisibility;
  state: CustomThemeState;
  credits: string | null;
  remixedFrom: number | null;
  liveRevision: number | null;
  publishedRevision: number | null;
  stillUrl: string | null;
  rowUrl: string | null;
  look: CustomThemeLook | null;
  wearers: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

export interface CustomThemeDraft extends CustomThemeSummary {
  kind: "code" | "layers";
  source: string;
  /** As saved: read it through parseLayerDoc before trusting it. */
  layers: LayerDoc | null;
  generatorVersion: number | null;
  assets: string[];
  costRatio: number | null;
}

export interface OwnCustomThemes {
  themes: CustomThemeSummary[];
  worn: { themeId: number; rows: boolean } | null;
  disabled: boolean;
}

export interface CustomThemeSaveInput {
  themeId: number | null;
  name: string;
  visibility: CustomThemeVisibility;
  credits: string;
  remixedFrom: number | null;
  source: string;
  assets: string[];
  look: CustomThemeLook;
  stillUrl: string;
  rowUrl: string;
  costRatio: number;
  rightsConfirmed: boolean;
  kind: "code" | "layers";
  /** A layer theme's document (custom-theme-layers.ts); `source` is the code it makes. */
  layers?: LayerDoc;
  generatorVersion?: number;
}

/* A save the backend turned down: its reason, and the code's errors when the checker found some. */
export class CustomThemeSaveError extends Error {
  constructor(readonly code: string, readonly errors: CustomThemeSourceError[] = []) {
    super(code);
  }
}

const SIGNED_OUT = "Sign in to make themes.";

async function readError(response: Response): Promise<{ error: string; errors?: CustomThemeSourceError[] }> {
  const body = await response.json().catch(() => null) as { error?: unknown; errors?: unknown } | null;
  return {
    error: typeof body?.error === "string" ? body.error : `server_${response.status}`,
    errors: Array.isArray(body?.errors) ? (body.errors as CustomThemeSourceError[]) : undefined,
  };
}

const readThemeId = (value: unknown): number => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Pick a theme.");
  return id;
};

export const fetchOwnCustomThemes = createServerFn({ method: "GET" }).handler(async (): Promise<OwnCustomThemes | null> => {
  const viewer = await requireViewer();
  if (!viewer) return null;
  const { setResponseHeader } = await import("@tanstack/react-start/server");
  setResponseHeader("Cache-Control", "private, no-store");
  const response = await fetch(`${viewer.base}/api/supporters/self/themes?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
  if (!response.ok) throw new Error((await readError(response)).error);
  const body = await response.json() as OwnCustomThemes;
  return { themes: body.themes ?? [], worn: body.worn ?? null, disabled: body.disabled === true };
});

export const fetchOwnCustomTheme = createServerFn({ method: "GET" })
  .validator((data: { themeId?: unknown }) => ({ themeId: readThemeId(data?.themeId) }))
  .handler(async ({ data }): Promise<CustomThemeDraft | null> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error(SIGNED_OUT);
    const response = await fetch(`${viewer.base}/api/supporters/self/themes/${data.themeId}?userId=${viewer.userId}`, { headers: bridgeAuthHeaders() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error((await readError(response)).error);
    return ((await response.json()) as { theme: CustomThemeDraft }).theme;
  });

/* Saves a new revision, live at once. A refusal comes back as a value, not a
   throw, so the checker's errors reach the editor intact. */
export const saveOwnCustomTheme = createServerFn({ method: "POST" })
  .validator((data: CustomThemeSaveInput) => data)
  .handler(async ({ data }): Promise<{ ok: true; theme: CustomThemeDraft } | { ok: false; error: string; errors: CustomThemeSourceError[] }> => {
    const viewer = await requireViewer();
    if (!viewer) return { ok: false, error: "signed_out", errors: [] };
    const response = await fetch(`${viewer.base}/api/supporters/self/themes`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ ...data, userId: viewer.userId }),
    });
    if (!response.ok) {
      const failure = await readError(response);
      return { ok: false, error: failure.error, errors: failure.errors ?? [] };
    }
    return { ok: true, theme: ((await response.json()) as { theme: CustomThemeDraft }).theme };
  });

export const setOwnCustomThemeVisibility = createServerFn({ method: "POST" })
  .validator((data: { themeId?: unknown; visibility?: unknown }) => ({
    themeId: readThemeId(data?.themeId),
    visibility: data?.visibility === "gallery" ? "gallery" as const : "private" as const,
  }))
  .handler(async ({ data }): Promise<CustomThemeSummary> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error(SIGNED_OUT);
    const response = await fetch(`${viewer.base}/api/supporters/self/themes/visibility`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    });
    if (!response.ok) throw new Error((await readError(response)).error);
    return ((await response.json()) as { theme: CustomThemeSummary }).theme;
  });

export const deleteOwnCustomTheme = createServerFn({ method: "POST" })
  .validator((data: { themeId?: unknown }) => ({ themeId: readThemeId(data?.themeId) }))
  .handler(async ({ data }): Promise<void> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error(SIGNED_OUT);
    const response = await fetch(`${viewer.base}/api/supporters/self/themes/delete`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    });
    if (!response.ok) throw new Error((await readError(response)).error);
  });

/* Puts a theme (theirs, or one from the gallery) on the viewer's profile, or takes it off (null). */
export const wearCustomTheme = createServerFn({ method: "POST" })
  .validator((data: { themeId?: unknown; rows?: unknown }) => ({
    themeId: data?.themeId == null ? null : readThemeId(data.themeId),
    rows: data?.rows === true,
  }))
  .handler(async ({ data }): Promise<void> => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error(SIGNED_OUT);
    const response = await fetch(`${viewer.base}/api/supporters/self/custom-theme`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    });
    if (!response.ok) throw new Error((await readError(response)).error);
  });

/* --- The gallery (public) ------------------------------------------------ */

export interface GalleryCustomTheme {
  themeId: number;
  rev: number;
  name: string;
  author: { id: number; username: string };
  format: "theme" | "shadertoy";
  compiled: string | null;
  assets: string[];
  look: CustomThemeLook;
  stillUrl: string;
  rowUrl: string | null;
  source: string;
  kind: "code" | "layers";
  layers: LayerDoc | null;
  credits: string | null;
  remixedFrom: number | null;
}

export async function fetchCustomThemeGallery(sort: "new" | "worn", offset = 0): Promise<CustomThemeSummary[]> {
  const base = getLiveBackendUrl();
  if (!base) return [];
  const response = await fetch(`${base}/api/supporters/themes?sort=${sort}&offset=${offset}`);
  if (!response.ok) throw new Error(`Server ${response.status}`);
  return ((await response.json()) as { themes: CustomThemeSummary[] }).themes ?? [];
}

export async function fetchGalleryCustomTheme(themeId: number): Promise<GalleryCustomTheme | null> {
  const base = getLiveBackendUrl();
  if (!base) return null;
  const response = await fetch(`${base}/api/supporters/themes/${themeId}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Server ${response.status}`);
  return ((await response.json()) as { theme: GalleryCustomTheme }).theme;
}
