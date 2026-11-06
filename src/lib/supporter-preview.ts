import { setSupporterLookPreview, type SupporterProfileLook } from "#/lib/live-backend";
import type { SupporterCompanion } from "#/lib/supporter-companions";

/* "Preview on my profile" (/supporter): what the viewer has on in the
   loadout, worn on their own profile in this browser only. Anyone can, so
   someone who has not supported yet sees their page as it would be.
   Nothing is saved: it lives in this tab's session storage, so a reload
   keeps it, and leaving the profile ends it (PlayerDefaultRoute). */

const KEY = "supporter-profile-preview:v1";

/* Only the parts tried on: the rest of the profile keeps its own look. */
export type SupporterPreviewLook = Partial<Pick<
  SupporterProfileLook,
  "look" | "frame" | "nameStyle" | "nameFont" | "profileTheme" | "profileThemeOptions" | "customTheme" | "packStyle" | "companion" | "runStartedAt"
>>;

interface StoredPreview {
  userId: number;
  look: SupporterPreviewLook;
}

function read(): StoredPreview | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null") as StoredPreview | null;
    return parsed && typeof parsed.userId === "number" && parsed.look && typeof parsed.look === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/* Starts the preview: the look cache wears it at once, before the profile mounts. */
export function startSupporterProfilePreview(userId: number, look: SupporterPreviewLook): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ userId, look } satisfies StoredPreview));
  } catch {
    // private mode: it still runs until the next reload
  }
  setSupporterLookPreview(userId, look);
}

/* The preview this tab was showing for `userId`, for a reload of the profile. */
export function storedSupporterProfilePreview(userId: number): SupporterPreviewLook | null {
  const stored = read();
  return stored?.userId === userId ? stored.look : null;
}

export function endSupporterProfilePreview(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
  setSupporterLookPreview(0, null);
}

/* A mascot picked at /supporter by someone who can't save one: kept for the
   preview, in the same session. */
const MASCOT_KEY = "supporter-preview-mascot:v1";

export function rememberPreviewMascot(companion: SupporterCompanion | null): void {
  try {
    if (companion) window.sessionStorage.setItem(MASCOT_KEY, JSON.stringify(companion));
    else window.sessionStorage.removeItem(MASCOT_KEY);
  } catch {
    // private mode
  }
}

export function previewMascot(): SupporterCompanion | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(window.sessionStorage.getItem(MASCOT_KEY) ?? "null") as SupporterCompanion | null;
  } catch {
    return null;
  }
}
