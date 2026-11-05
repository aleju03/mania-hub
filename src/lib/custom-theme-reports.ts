import { createServerFn } from "@tanstack/react-start";

import { bridgeAuthHeaders } from "./live-backend-tokens";
import { requireViewer } from "./supporter-look-settings";

/* A signed-in player's report on a custom theme they saw on a profile, about
   its content or its rights (backend features/custom-themes.ts). It puts the
   theme back at the top of the admin's Themes tab. Crashes report themselves
   (custom-themes.ts). */

export type CustomThemeReportKind = "content" | "rights";

export const CUSTOM_THEME_REPORT_NOTE_MAX = 500;

export const reportCustomTheme = createServerFn({ method: "POST" })
  .validator((data: { themeId?: unknown; rev?: unknown; kind?: unknown; note?: unknown }) => {
    const themeId = Number(data?.themeId);
    const rev = Number(data?.rev);
    if (!Number.isSafeInteger(themeId) || themeId <= 0 || !Number.isSafeInteger(rev) || rev <= 0) throw new Error("Pick a theme.");
    const kind: CustomThemeReportKind = data?.kind === "rights" ? "rights" : "content";
    const note = typeof data?.note === "string" ? data.note.trim().slice(0, CUSTOM_THEME_REPORT_NOTE_MAX) : "";
    return { themeId, rev, kind, note };
  })
  .handler(async ({ data }) => {
    const viewer = await requireViewer();
    if (!viewer) throw new Error("Sign in to report a theme.");
    const response = await fetch(`${viewer.base}/api/supporters/self/themes/report`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(String(body?.error ?? `Server ${response.status}`));
    }
    return { ok: true as const };
  });

/* A custom theme that crashed or proved too slow on a signed-in viewer's
   device: only these count toward hiding a theme, since an anonymous beacon
   can come from anywhere. False when signed out, for the anonymous path. */
export const reportCustomThemeCrashSignedIn = createServerFn({ method: "POST" })
  .validator((data: { themeId?: unknown; rev?: unknown }) => {
    const themeId = Number(data?.themeId);
    const rev = Number(data?.rev);
    if (!Number.isSafeInteger(themeId) || themeId <= 0 || !Number.isSafeInteger(rev) || rev <= 0) throw new Error("Pick a theme.");
    return { themeId, rev };
  })
  .handler(async ({ data }): Promise<boolean> => {
    const viewer = await requireViewer();
    if (!viewer) return false;
    await fetch(`${viewer.base}/api/supporters/self/themes/crash`, {
      method: "POST",
      headers: bridgeAuthHeaders(true),
      body: JSON.stringify({ userId: viewer.userId, ...data }),
    }).catch(() => null);
    return true;
  });
