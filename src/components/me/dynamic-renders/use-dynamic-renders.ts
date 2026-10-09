import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../../../lib/auth-context";
import {
  disableSignature,
  enableSignature,
  fetchSignatureKeyModes,
  fetchSignatureSettings,
  reportSignatureTimeZone,
  rotateSignatureToken,
  type SignatureSettings,
} from "../../../lib/signature";
import { signatureImagePath, SIGNATURE_TYPES, type SignatureType } from "../../../lib/signature-shared";
import { normalizeSignatureStyleMap, type SignatureStyle, type SignatureStyleMap } from "../../../lib/signature-style";
import { browserTimeZone } from "../../../lib/time-zone";
import { useNoDans } from "../../../store";

/* The state and actions behind /dynamic-renders.

   Local styles lead the stored ones so a drag stays responsive; the debounced
   save is what makes them real and moves the render's version. Copy flushes
   it, so nobody can paste a link for a style that never landed. */
const STYLE_SAVE_DEBOUNCE_MS = 600;

/* Tells the backend what zone this browser is in, when it has something new to
   say. Returns the rewritten row, or null when nothing was worth sending -
   which is the common case, so the caller only sets state on a real change. */
async function syncTimeZone(current: SignatureSettings): Promise<SignatureSettings | null> {
  const zone = browserTimeZone();
  if (zone === current.timeZone) return null;
  const result = await reportSignatureTimeZone({ data: { timeZone: zone } }).catch(() => null);
  return result?.signature ?? null;
}

export function useDynamicRenders() {
  const noDans = useNoDans();
  const { viewer } = useAuth();

  const [settings, setSettings] = useState<SignatureSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [styles, setStyles] = useState<SignatureStyleMap>(() => normalizeSignatureStyleMap(null));
  // Which keymodes this player actually has ratings for, so a picker cannot
  // offer one that would silently fall back to another.
  const [keyModes, setKeyModes] = useState<number[]>([]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* The style a debounced save is holding. Kept in a ref so Copy can force it
     out ahead of schedule without re-deriving what was pending. */
  const pendingStyles = useRef<SignatureStyleMap | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchSignatureSettings();
      setSettings(result.signature);
      if (result.signature) setStyles(result.signature.styles);
      /* The insights render prints the day a top play was set in the OWNER's
         zone, and this page is where the owner's browser gets to say what that
         is. Sent on every load so the zone follows someone who moved. Fire and
         forget: the backend no-ops when the value already matches. */
      if (result.signature) {
        void syncTimeZone(result.signature).then((updated) => {
          if (!updated) return;
          /* This may land after a publish, disable or rotation that started
             later, so it only takes the fields it owns. */
          setSettings((current) => current?.userId === updated.userId
            ? {
                ...current,
                timeZone: updated.timeZone,
                updatedAt: Math.max(current.updatedAt, updated.updatedAt),
              }
            : current);
        });
      }
    } catch {
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!viewer) {
      setLoading(false);
      return;
    }
    void load();
    void fetchSignatureKeyModes().then((result) => setKeyModes(result.keyCounts)).catch(() => setKeyModes([]));
  }, [viewer, load]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const enabledTypes = useMemo(() => settings?.enabledTypes ?? [], [settings]);
  const visibleTypes = useMemo(
    () => SIGNATURE_TYPES.filter((entry) => !noDans || entry !== "dan"),
    [noDans],
  );
  const isLive = Boolean(settings?.enabled && settings.token);
  const skillsKeyCount = settings?.skillsKeyCount ?? null;

  /* The write, on its own schedule. Nothing visible waits on it - what it
     protects is the link: a style that is only in this component is not what
     the pasted URL will draw. */
  const saveStyles = useCallback(async () => {
    const next = pendingStyles.current;
    if (!next) return;
    pendingStyles.current = null;
    const result = await enableSignature({
      data: {
        types: enabledTypes.length > 0 ? enabledTypes : [SIGNATURE_TYPES[0]],
        skillsKeyCount,
        styles: next,
        timeZone: browserTimeZone(),
      },
    }).catch(() => null);
    if (result?.signature) setSettings(result.signature);
  }, [enabledTypes, skillsKeyCount]);

  const flushStyles = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await saveStyles();
  }, [saveStyles]);

  const act = useCallback(async (run: () => Promise<{ signature: SignatureSettings | null }>) => {
    setBusy(true);
    try {
      /* Any of these replaces the local styles with the server's copy, so a
         debounced edit still in flight has to land first or it would be
         quietly undone. */
      await flushStyles();
      const result = await run();
      if (result.signature) {
        setSettings(result.signature);
        setStyles(result.signature.styles);
      } else {
        await load();
      }
    } finally {
      setBusy(false);
    }
  }, [flushStyles, load]);

  /* The zone rides along with the very first enable, which is what mints the
     row - so a new signature is dated in the player's own day from its first
     render rather than after a second visit. */
  const setUp = useCallback(() => act(() => enableSignature({
    data: { types: [SIGNATURE_TYPES[0]], skillsKeyCount: null, timeZone: browserTimeZone() },
  })), [act]);

  /** Publishing only ever adds: a type's pasted URLs stop loading the moment
      it is unpublished, so no view does that as a side effect. */
  const publish = useCallback((target: SignatureType) => {
    if (enabledTypes.includes(target)) return;
    void act(() => enableSignature({
      data: { types: [...enabledTypes, target], skillsKeyCount, timeZone: browserTimeZone() },
    }));
  }, [act, enabledTypes, skillsKeyCount]);

  const unpublish = useCallback((target: SignatureType) => {
    const next = enabledTypes.filter((entry) => entry !== target);
    if (next.length === 0) return;
    void act(() => enableSignature({
      data: { types: next, skillsKeyCount, timeZone: browserTimeZone() },
    }));
  }, [act, enabledTypes, skillsKeyCount]);

  const patchStyle = useCallback((target: SignatureType, patch: Partial<SignatureStyle>) => {
    // Computed out here rather than inside the setStyles updater: an updater
    // has to stay pure, and scheduling the save from within one would queue it
    // twice under StrictMode's double invocation.
    const next: SignatureStyleMap = { ...styles, [target]: { ...styles[target], ...patch } };
    setStyles(next);
    pendingStyles.current = next;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveStyles(); }, STYLE_SAVE_DEBOUNCE_MS);
  }, [saveStyles, styles]);

  const urlFor = useCallback((target: SignatureType, design: number) => {
    if (!settings?.token) return "";
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return `${origin}${signatureImagePath(settings.token, target, design)}`;
  }, [settings?.token]);

  /* Copy is the moment the link stops being a preview and starts being
     something pasted somewhere permanent, so it is also what publishes the
     types being copied, and the debounced save is forced out with it. Browsing
     a type publishes nothing. Clipboard first, since browsers only allow the
     write inside the gesture it came from. Resolves false when the clipboard
     is unavailable. */
  const copy = useCallback(async (text: string, types: SignatureType[] = []) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Insecure context: the caller leaves the text selectable.
    }
    const missing = types.filter((entry, index) => !enabledTypes.includes(entry) && types.indexOf(entry) === index);
    if (missing.length > 0) {
      await act(() => enableSignature({
        data: { types: [...enabledTypes, ...missing], skillsKeyCount, timeZone: browserTimeZone() },
      }));
    } else {
      await flushStyles();
    }
    return ok;
  }, [act, enabledTypes, flushStyles, skillsKeyCount]);

  return {
    viewer,
    settings,
    loading,
    busy,
    isLive,
    styles,
    keyModes,
    enabledTypes,
    visibleTypes,
    skillsKeyCount,
    setUp,
    publish,
    unpublish,
    patchStyle,
    urlFor,
    copy,
    disable: () => act(() => disableSignature()),
    rotate: () => act(() => rotateSignatureToken()),
  };
}

export type DynamicRenders = ReturnType<typeof useDynamicRenders>;
