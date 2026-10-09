import { useEffect, useMemo, useRef, useState } from "react";

import type { SignatureType } from "../../../lib/signature-shared";
import type { SignatureStyle } from "../../../lib/signature-style";
import { useViewerTimeZone } from "../../../lib/use-viewer-time-zone";

/* One live picture of a render, drawn by /api/signature-preview straight from
   the style in the request. The signature URL itself cannot do that - its look
   lives on the player's row - so previewing through it meant a save, a version
   bump and a cache round trip between moving a slider and seeing it.

   Short enough to feel like the slider, long enough that a drag is a handful
   of renders rather than one per pixel. Each in-flight preview is aborted when
   the next one starts, so this bounds concurrency as well as count. */
const PREVIEW_DEBOUNCE_MS = 110;

export type SignaturePreviewState = "loading" | "ready" | "error";

export function useSignaturePreview({
  type,
  design,
  style,
  skillsKeyCount,
  enabled = true,
  debounceMs = PREVIEW_DEBOUNCE_MS,
}: {
  type: SignatureType;
  design: number;
  style: SignatureStyle;
  skillsKeyCount: number | null;
  enabled?: boolean;
  debounceMs?: number;
}): { imageUrl: string | null; state: SignaturePreviewState } {
  const viewerTimeZone = useViewerTimeZone();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [state, setState] = useState<SignaturePreviewState>("loading");
  const objectUrl = useRef<string | null>(null);

  useEffect(() => () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  /* Holding the last frame is right while a style is being tuned - it is the
     same picture, one setting older. It is wrong the moment the layout
     changes: that frame is a different picture at a different shape, and it
     would be stretched into the new layout's ratio. */
  useEffect(() => {
    setImageUrl(null);
    setState("loading");
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  }, [type, design]);

  /* Exactly what the render depends on, serialized so an equal style is not a
     new request and reused verbatim as the request body. The browser's zone
     comes through the hook, which is "UTC" until hydration and the real zone
     after, so a body computed during SSR is dropped. */
  const body = useMemo(() => JSON.stringify({
    type,
    design,
    style,
    skillsKeyCount,
    timeZone: viewerTimeZone,
  }), [design, skillsKeyCount, style, type, viewerTimeZone]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/signature-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const next = URL.createObjectURL(await response.blob());

        /* Decoded before it is shown, so the swap is a single frame with a
           whole image in it rather than a blank flash. */
        const image = new Image();
        image.src = next;
        await image.decode().catch(() => undefined);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(next);
          return;
        }

        const previous = objectUrl.current;
        objectUrl.current = next;
        setImageUrl(next);
        setState("ready");
        if (previous) URL.revokeObjectURL(previous);
      } catch {
        // A failed render leaves the last good frame up. Only the very first
        // one has nothing to fall back to.
        if (!controller.signal.aborted) {
          setState((current) => (current === "ready" ? "ready" : "error"));
        }
      }
    }, debounceMs);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [body, debounceMs, enabled]);

  return { imageUrl, state };
}
