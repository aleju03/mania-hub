import { useEffect } from "react";

import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

/*
 * The site's "are you sure", in place of window.confirm.
 *
 * A native dialog is a different piece of software wearing the browser's
 * chrome: it names the origin ("localhost:3000 says"), it cannot say which
 * button is the dangerous one, it is unstyleable, and on some platforms it is
 * modal to the whole tab. Every other overlay here is ours; this is the one
 * that was not.
 *
 * Deliberately small. It asks one question, it offers exactly two answers, and
 * the destructive one is the one that looks destructive. Anything that needs
 * a form is not a confirmation and belongs in its own modal.
 */
export function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  /** One line of consequence. Skip it when the title already says it all. */
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Paints the confirm button as the destructive one it is. */
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useBodyScrollLock(true);

  /* Focus lands on Cancel, not on the action. window.confirm defaults to OK,
     which makes a stray Enter destructive; here the safe answer is the one
     under the cursor and under the keyboard. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/70 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-4 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto w-full max-w-sm rounded-xl border border-osu-b3/30 bg-osu-b5 px-4 py-4">
        <h2 className="text-[14.5px] font-bold text-white">{title}</h2>
        {body ? <p className="mt-2 text-[12.5px] leading-5 text-osu-f1">{body}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3.5 py-2 text-[12.5px] font-bold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3/40 hover:text-white"
            autoFocus
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={`rounded-lg px-3.5 py-2 text-[12.5px] font-bold transition-colors cursor-pointer ${
              danger
                ? "border border-osu-red-light/45 bg-osu-red-light/15 text-osu-red-light hover:bg-osu-red-light/25 hover:text-white"
                : "border border-osu-pink/50 bg-osu-pink/15 text-osu-pink-light hover:bg-osu-pink/25 hover:text-white"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
