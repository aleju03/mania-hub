import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";

import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

/*
 * Full-size look at an image that is only a thumbnail on the page.
 *
 * A bug report screenshot is the whole point of attaching one, and a 80x56
 * tile shows nothing. Opening it in a tab works but throws away the page, and
 * for a private screenshot it hands out the signed URL as a visible address.
 * This keeps the look inside the page.
 *
 * The caller owns the index so the arrows can walk a set without this
 * remembering anything between opens.
 */
export function ImageLightbox({
  urls,
  index,
  onIndex,
  onClose,
}: {
  urls: string[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  useBodyScrollLock(true);

  const count = urls.length;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (count < 2) return;
      if (event.key === "ArrowRight") onIndex((index + 1) % count);
      if (event.key === "ArrowLeft") onIndex((index - 1 + count) % count);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [count, index, onClose, onIndex]);

  const url = urls[index];
  if (typeof document === "undefined" || !url) return null;

  // The arrows sit against the viewport, not against the image: a small
  // screenshot would otherwise have them landing on top of the thing being
  // looked at.
  const arrowClass =
    "absolute top-1/2 z-10 -translate-y-1/2 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white/80 transition-colors duration-[120ms] cursor-pointer hover:bg-white/20 hover:text-white";

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t`Screenshot`}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t`Close`}
        className="absolute right-3 top-3 cursor-pointer rounded p-1.5 text-white/70 transition-colors duration-[120ms] hover:text-white"
      >
        <X className="h-5 w-5" />
      </button>

      {count > 1 ? (
        <>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onIndex((index - 1 + count) % count); }}
            aria-label={t`Previous`}
            className={`${arrowClass} left-3`}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onIndex((index + 1) % count); }}
            aria-label={t`Next`}
            className={`${arrowClass} right-3`}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] tabular-nums text-white/80">
            {index + 1} / {count}
          </span>
        </>
      ) : null}

      <img
        src={url}
        alt=""
        onClick={(event) => event.stopPropagation()}
        className="max-h-[86vh] max-w-full rounded-lg object-contain"
      />
    </div>,
    document.body,
  );
}
