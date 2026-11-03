import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import { SKIN_REPORT_PREFIX, submitBugReport, type BugReportFailReason } from "../../lib/bug-reports";
import type { SkinSummary } from "../../lib/skins";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

// A skin report is a feedback report on the owner's board, filed against the
// skin's page, so it lands in the inbox that is already watched. The header
// line is written in English for the board.
const NOTE_MAX = 1000;

export function skinReportBody(skin: Pick<SkinSummary, "name" | "ownerUsername">, note: string): string {
  return `${SKIN_REPORT_PREFIX}${skin.name} (uploaded by ${skin.ownerUsername})\n\n${note.trim()}`;
}

export function SkinReportModal({ skin, open, onClose }: { skin: SkinSummary; open: boolean; onClose: () => void }) {
  const { t } = useLingui();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bodyLockActive, setBodyLockActive] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNote("");
    setSent(false);
    setError(null);
  }, [open]);

  const handleDismiss = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleDismiss]);

  useLayoutEffect(() => {
    if (open) setBodyLockActive(true);
  }, [open]);
  useBodyScrollLock(bodyLockActive);

  const failMessage = (failure: BugReportFailReason): string =>
    failure === "rate_limited" || failure === "too_many_reports"
      ? t`You have sent too many reports today. Try again tomorrow.`
      : t`The report could not be sent. Try again.`;

  const submit = async () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await submitBugReport({
      data: {
        kind: "feedback",
        body: skinReportBody(skin, note),
        pagePath: `/skins/${skin.slug ?? skin.id}`,
      },
    }).catch(() => ({ ok: false as const, reason: "failed" as const }));
    setBusy(false);
    if (result.ok) setSent(true);
    else setError(failMessage(result.reason));
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence onExitComplete={() => setBodyLockActive(false)}>
      {open && (
        <motion.div
          key="skin-report"
          className="fixed inset-0 z-[120] flex items-center justify-center py-3 pl-3 sm:py-6 sm:pl-6 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:pr-[calc(1.5rem+var(--modal-scrollbar-compensation,0px))]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          <div className="absolute inset-0 bg-black/85" onClick={handleDismiss} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t`Report ${skin.name}`}
            className="modal-card-mobile-safe relative isolate z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[400px] flex-col overflow-hidden rounded-2xl bg-osu-b5 ring-1 ring-white/10 shadow-2xl sm:max-h-[calc(100dvh-3rem)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 sm:px-5">
              <span className="min-w-0 truncate text-[15px] font-bold text-white">
                <Trans>Report {skin.name}</Trans>
              </span>
              <button
                type="button"
                onClick={handleDismiss}
                aria-label={t`Close`}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-osu-f1 transition-colors cursor-pointer hover:bg-osu-b3/50 hover:text-white"
              >
                <X className="h-4 w-4" strokeWidth={2.4} />
              </button>
            </div>

            {sent ? (
              <div className="px-4 pb-5 pt-3 sm:px-5">
                <p className="text-[13px] text-osu-l2"><Trans>Report sent.</Trans></p>
                <button
                  type="button"
                  onClick={onClose}
                  className="mt-4 inline-flex w-full items-center justify-center rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110"
                >
                  <Trans>Done</Trans>
                </button>
              </div>
            ) : (
              <form
                className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-3 sm:px-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value.slice(0, NOTE_MAX))}
                  disabled={busy}
                  rows={4}
                  placeholder={t`What's wrong with this skin?`}
                  autoFocus
                  className="w-full resize-none rounded-lg bg-osu-b4 px-3 py-2 text-[13px] text-osu-l1 outline-none placeholder:text-osu-f1/70 focus:ring-1 focus:ring-osu-pink/50 disabled:opacity-50"
                />
                {error && <p className="mt-2 text-[12px] font-semibold text-osu-red-light">{error}</p>}
                <button
                  type="submit"
                  disabled={!note.trim() || busy}
                  className="mt-3 inline-flex w-full items-center justify-center rounded-full bg-osu-pink px-5 py-2 text-[13px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? <Trans>Sending…</Trans> : <Trans>Send report</Trans>}
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
