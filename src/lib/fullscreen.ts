/* The native Fullscreen API with its WebKit prefixes, shared by the replay
   stages. Every call reports whether it actually did anything: iPhone Safari
   has no element fullscreen at all, so the callers fall back to their own
   viewport-covering overlay instead of assuming they got the screen. */

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenTarget = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape" | "portrait" | "any") => Promise<void>;
};

export function getNativeFullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const doc = document as FullscreenDocument;
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export async function requestNativeFullscreen(element: HTMLElement): Promise<boolean> {
  const target = element as FullscreenTarget;
  if (target.requestFullscreen) {
    await target.requestFullscreen({ navigationUI: "hide" } as FullscreenOptions);
    return true;
  }
  if (target.webkitRequestFullscreen) {
    await target.webkitRequestFullscreen();
    return true;
  }
  return false;
}

export async function exitNativeFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  const doc = document as FullscreenDocument;
  if (document.exitFullscreen) {
    await document.exitFullscreen();
  } else if (doc.webkitExitFullscreen) {
    await doc.webkitExitFullscreen();
  }
}

/* Orientation locking only works while a fullscreen element is active, and only
   on Android-class browsers; iOS rejects it outright. Both helpers swallow that
   so a stage can ask for landscape without branching on the platform. */
export async function lockLandscapeOrientation(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const orientation = window.screen?.orientation as LockableOrientation | undefined;
  if (!orientation?.lock) return false;
  try {
    await orientation.lock("landscape");
    return true;
  } catch {
    return false;
  }
}

export function unlockOrientation(): void {
  if (typeof window === "undefined") return;
  try {
    window.screen?.orientation?.unlock?.();
  } catch {
    // Never locked, or the browser has no orientation lock at all.
  }
}
