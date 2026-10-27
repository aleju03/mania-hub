import { useLingui } from "@lingui/react/macro";
import { Flag } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { ConfirmModal } from "../ui/ConfirmModal";
import { takeDownAdminCustomTheme } from "../../lib/admin-custom-themes";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import { useAuth } from "../../lib/auth-context";
import type { CustomTheme } from "../../lib/custom-themes";
import { CUSTOM_THEME_REPORT_NOTE_MAX, reportCustomTheme, type CustomThemeReportKind } from "../../lib/custom-theme-reports";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

/* The line under a profile wearing a supporter's own theme: its name and
   maker, a Report for anyone signed in (about its content or its rights),
   and for the admin a Take down that pulls it off every profile at once
   (backend features/custom-themes.ts). Themes go live without review, so
   this is how a bad one gets seen. */
export function CustomThemeCredit({ theme, ownerId }: { theme: CustomTheme; ownerId: number }) {
  const { t } = useLingui();
  const auth = useAuth();
  const [reporting, setReporting] = useState(false);
  const [takingDown, setTakingDown] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const admin = canUseAdminFeatures(auth);
  const canReport = !!auth.viewer && auth.viewer.id !== theme.author.id && auth.viewer.id !== ownerId;
  const byAuthor = theme.author.id !== ownerId && theme.author.username;

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 px-4 py-4 text-[11.5px] text-osu-f1">
      <span>
        {byAuthor ? t`Theme: ${theme.name} by ${theme.author.username}` : t`Theme: ${theme.name}`}
      </span>
      {canReport ? (
        <>
          <span aria-hidden className="h-3 w-px bg-white/15" />
          <button type="button" onClick={() => setReporting(true)} className="inline-flex cursor-pointer items-center gap-1 hover:text-white">
            <Flag size={11} />
            {t`Report`}
          </button>
        </>
      ) : null}
      {admin ? (
        <>
          <span aria-hidden className="h-3 w-px bg-white/15" />
          <button type="button" onClick={() => setTakingDown(true)} className="cursor-pointer text-osu-red-light/80 hover:text-osu-red-light">
            Take down
          </button>
        </>
      ) : null}
      {status ? <span className="w-full text-center text-osu-l2">{status}</span> : null}

      {reporting ? (
        <ReportModal
          onClose={() => setReporting(false)}
          onSend={async (kind, note) => {
            await reportCustomTheme({ data: { themeId: theme.themeId, rev: theme.rev, kind, note } });
            setStatus(t`Thanks, the report was sent.`);
          }}
        />
      ) : null}
      {takingDown ? (
        <ConfirmModal
          title={`Take down ${theme.name}?`}
          body="Comes off every profile wearing it and out of the gallery, and its code and images can't be saved again. Restore is in the admin Themes tab."
          confirmLabel="Take down"
          danger
          onConfirm={() => {
            void takeDownAdminCustomTheme({ data: { themeId: theme.themeId } })
              .then(() => setStatus("Taken down. It goes away on the next load."))
              .catch((cause: unknown) => setStatus(cause instanceof Error ? cause.message : String(cause)));
          }}
          onClose={() => setTakingDown(false)}
        />
      ) : null}
    </div>
  );
}

function ReportModal({ onClose, onSend }: { onClose: () => void; onSend: (kind: CustomThemeReportKind, note: string) => Promise<void> }) {
  const { t } = useLingui();
  const [kind, setKind] = useState<CustomThemeReportKind>("content");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const options: { id: CustomThemeReportKind; label: string }[] = [
    { id: "content", label: t`It shows something that shouldn't be here` },
    { id: "rights", label: t`It uses my work without permission` },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[140] flex justify-center overflow-y-auto bg-black/70 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-4 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      role="dialog"
      aria-modal="true"
      aria-label={t`Report this theme`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="my-auto w-full max-w-sm rounded-xl border border-osu-b3/30 bg-osu-b5 px-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSending(true);
          setError(null);
          onSend(kind, note)
            .then(onClose)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setSending(false));
        }}
      >
        <h2 className="text-[14.5px] font-bold text-white">{t`Report this theme`}</h2>
        <div className="mt-3 space-y-1.5">
          {options.map((option) => (
            <label key={option.id} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-osu-l2">
              <input type="radio" name="kind" checked={kind === option.id} onChange={() => setKind(option.id)} className="accent-osu-pink" />
              {option.label}
            </label>
          ))}
        </div>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value.slice(0, CUSTOM_THEME_REPORT_NOTE_MAX))}
          placeholder={kind === "rights" ? t`Which work is yours, and where can it be seen?` : t`What's wrong with it? (optional)`}
          rows={3}
          className="mt-3 w-full resize-none rounded-lg border border-osu-b3/30 bg-osu-b6 px-2.5 py-2 text-[12.5px] text-white placeholder:text-osu-f1 focus:border-osu-pink/50 focus:outline-none"
        />
        {error ? <p className="mt-2 text-[12px] text-osu-red-light">{error}</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="cursor-pointer rounded-lg px-3.5 py-2 text-[12.5px] font-bold text-osu-l2 transition-colors hover:bg-osu-b3/40 hover:text-white">
            {t`Cancel`}
          </button>
          <button
            type="submit"
            disabled={sending}
            className="cursor-pointer rounded-lg border border-osu-pink/50 bg-osu-pink/15 px-3.5 py-2 text-[12.5px] font-bold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white disabled:cursor-default disabled:opacity-60"
          >
            {sending ? t`Sending...` : t`Send report`}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
