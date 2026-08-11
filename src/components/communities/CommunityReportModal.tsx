import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
  COMMUNITY_REPORT_DETAILS_MAX_LENGTH,
  COMMUNITY_REPORT_REASONS,
  COMMUNITY_REPORT_REASON_LABELS,
  communityErrorMessage,
  type CommunityReportReason,
  type CommunitySummary,
} from "../../lib/communities-shared";
import { reportCommunity } from "../../lib/communities";
import { useBodyScrollLock } from "../../lib/use-body-scroll-lock";

/*
 * Flagging a listing, from its own page.
 *
 * Short on purpose: pick what is wrong, add a line if there is more to it, send.
 * A report is a message to a moderator, so the only thing worth asking for is
 * what they should go and look at.
 *
 * Nothing here changes what anyone sees. It puts the listing back in front of a
 * moderator, and whatever they decide is what does.
 */

export function CommunityReportModal({
  community,
  onSent,
  onClose,
}: {
  community: CommunitySummary;
  onSent: () => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<CommunityReportReason>("misleading");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await reportCommunity({ data: { id: community.id, reason, details } });
      if (!result.ok) {
        setError(communityErrorMessage(result.error));
        return;
      }
      onSent();
      onClose();
    } catch {
      setError("Could not send that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/70 py-3 pl-3 pr-[calc(0.75rem+var(--modal-scrollbar-compensation,0px))] sm:py-4 sm:pl-4 sm:pr-[calc(1rem+var(--modal-scrollbar-compensation,0px))]"
      role="dialog"
      aria-modal="true"
      aria-label={`Report ${community.name}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto w-full max-w-md rounded-xl border border-osu-b3/30 bg-osu-b5">
        <div className="flex items-center gap-2.5 border-b border-osu-b3/30 px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-bold text-white">Report {community.name}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-osu-f1 transition-colors cursor-pointer hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5 px-4 py-4">
          {/* One column of plain rows rather than a radio list: the label is the
              whole choice, so the row is the thing to click. */}
          <div className="space-y-1.5">
            {COMMUNITY_REPORT_REASONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setReason(option)}
                aria-pressed={reason === option}
                className={`block w-full rounded-lg px-3 py-2 text-left text-[12.5px] font-semibold transition-colors cursor-pointer ${
                  reason === option
                    ? "bg-osu-pink/15 text-white"
                    : "bg-osu-b4 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
                }`}
              >
                {COMMUNITY_REPORT_REASON_LABELS[option]}
              </button>
            ))}
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-osu-f1/55">
              Anything else
            </span>
            <textarea
              value={details}
              onChange={(event) => setDetails(event.target.value.slice(0, COMMUNITY_REPORT_DETAILS_MAX_LENGTH))}
              rows={3}
              placeholder="optional"
              className="w-full resize-y rounded-lg border border-osu-b3/30 bg-osu-b4 px-3 py-2 text-[13px] text-osu-l1 transition-colors placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none"
            />
          </label>

          {error && <p className="text-[11.5px] text-osu-pink-light">{error}</p>}

          <button
            type="button"
            onClick={send}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-osu-pink px-4 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:cursor-default disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Send report
          </button>
        </div>
      </div>
    </div>
  );
}
