import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";

import { useLocale } from "../../lib/locale-context";
import {
  TRANSLATION_REPORT_NOTE_MAX,
  TRANSLATION_REPORT_SOURCE_MAX,
  TRANSLATION_REPORT_SUGGESTION_MAX,
  submitTranslationReport,
  type TranslationReportFailReason,
} from "../../lib/translation-reports";

/*
 * Telling the owner that a translated string reads wrong, from the same place
 * the language was picked. Shown only while the site is in a translated locale:
 * in English there is nothing to report, the strings are the source.
 *
 * No login is asked for. The people best placed to catch a bad translation are
 * the ones reading in that language, signed in or not, and a report says
 * nothing about the reporter's account either way. The page they were on rides
 * along so a string can be found again without a description of where it was.
 */

const FIELD_CLASS =
  "w-full resize-y rounded-lg border border-osu-b3/40 bg-osu-b5/70 px-3 py-2 text-[13px] text-osu-l1 transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none";

type Phase = "closed" | "open" | "sent";

export function TranslationReportForm() {
  const { t } = useLingui();
  const locale = useLocale();
  const [phase, setPhase] = useState<Phase>("closed");
  const [sourceText, setSourceText] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failMessage = (reason: TranslationReportFailReason): string => {
    if (reason === "invalid_report") return t`Add the text that reads wrong.`;
    if (reason === "too_many_reports") return t`That is a lot of reports for one day. Try again tomorrow.`;
    if (reason === "rate_limited") return t`Too many reports just now. Try again in a bit.`;
    return t`Could not send that. Try again.`;
  };

  const reset = () => {
    setSourceText("");
    setSuggestion("");
    setNote("");
    setError(null);
  };

  const send = async () => {
    if (!sourceText.trim()) {
      setError(t`Add the text that reads wrong.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await submitTranslationReport({
        data: {
          locale,
          sourceText,
          suggestion,
          note,
          pagePath: typeof window === "undefined" ? undefined : window.location.pathname,
        },
      });
      if (!result.ok) {
        setError(failMessage(result.reason));
        return;
      }
      reset();
      setPhase("sent");
    } catch {
      setError(t`Could not send that. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  if (phase === "closed" || phase === "sent") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            reset();
            setPhase("open");
          }}
          className="cursor-pointer text-[12px] font-semibold text-osu-pink-light transition-colors hover:text-white"
        >
          <Trans>Report a translation</Trans>
        </button>
        {phase === "sent" ? (
          <span className="text-[12px] text-osu-f1">
            <Trans>Sent, thanks.</Trans>
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <label className="block space-y-1.5">
        <span className="block text-[11px] font-semibold text-osu-l1">
          <Trans>Text that reads wrong</Trans>
        </span>
        <textarea
          value={sourceText}
          onChange={(event) => setSourceText(event.target.value.slice(0, TRANSLATION_REPORT_SOURCE_MAX))}
          rows={2}
          autoFocus
          className={FIELD_CLASS}
        />
      </label>

      <label className="block space-y-1.5">
        <span className="block text-[11px] font-semibold text-osu-l1">
          <Trans>How it should read</Trans>
        </span>
        <textarea
          value={suggestion}
          onChange={(event) => setSuggestion(event.target.value.slice(0, TRANSLATION_REPORT_SUGGESTION_MAX))}
          rows={2}
          placeholder={t`optional`}
          className={FIELD_CLASS}
        />
      </label>

      <label className="block space-y-1.5">
        <span className="block text-[11px] font-semibold text-osu-l1">
          <Trans>Anything else</Trans>
        </span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value.slice(0, TRANSLATION_REPORT_NOTE_MAX))}
          rows={2}
          placeholder={t`optional`}
          className={FIELD_CLASS}
        />
      </label>

      {error ? <p className="text-[11.5px] text-osu-pink-light">{error}</p> : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={send}
          disabled={busy}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-osu-pink px-4 py-1.5 text-[12.5px] font-bold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          <Trans>Send report</Trans>
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setPhase("closed");
          }}
          className="cursor-pointer text-[12px] font-semibold text-osu-f1 transition-colors hover:text-white"
        >
          <Trans>Cancel</Trans>
        </button>
      </div>
    </div>
  );
}
