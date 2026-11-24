import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, Link2, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { track } from "../../lib/analytics";
import { FoilPreview } from "./FoilPreview";

/* The corner card a supporter with an unused gift code sees once when their
   time is about to run out (SupporterWelcome decides when): the gift
   ticket's stub, the date, and the same Copy link as /supporter. */

export function GiftCodeReminder({ code, expiresAt, onDone }: { code: string; expiresAt: number; onDone: () => void }) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const until = new Date(expiresAt).toLocaleDateString(i18n.locale, { month: "short", day: "numeric" });

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    track("supporter_gift_copied");
    void navigator.clipboard?.writeText(`${window.location.origin}/gift/${code}`).then(() => setCopied(true)).catch(() => undefined);
  };

  return (
    <AnimatePresence onExitComplete={onDone}>
      {open && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="fixed bottom-4 right-4 z-[90] flex w-[min(21rem,calc(100vw-2rem))] overflow-hidden rounded-xl bg-osu-b3 text-white shadow-2xl"
        >
          <div className="relative w-[72px] shrink-0 overflow-hidden bg-[#2a2440]">
            <FoilPreview foil="holo" className="absolute inset-0 h-full w-full" />
            <div className="relative flex h-full flex-col items-center justify-center text-center">
              <div className="text-[30px] font-black leading-none tabular-nums [text-shadow:0_2px_8px_rgba(0,0,0,0.35)]">7</div>
              <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.18em] text-white/90">{t`days`}</div>
            </div>
          </div>
          <div className="min-w-0 flex-1 py-3 pl-4 pr-3">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-[13px] font-semibold leading-snug">
                {t`Your supporter ends on ${until}. You still have a week of supporter to give a friend.`}
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t`Close`}
                className="-mr-1 -mt-0.5 shrink-0 cursor-pointer rounded p-1 text-osu-f1 transition hover:text-white"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <button
              type="button"
              onClick={copy}
              className="mt-2.5 inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full bg-osu-pink px-3.5 text-[12px] font-semibold text-white transition hover:brightness-110"
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
              {copied ? t`Link copied` : t`Copy link`}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
