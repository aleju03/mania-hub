import { useCallback, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";

import { addSelfToRoster, type RosterSelfTrackResult } from "../../lib/roster-self-track";
import { showTrackingStartedToast } from "./TrackingToasts";

// Offer a logged-in but untracked player the chance to add their own osu! account to their
// country's roster, after which the ingest pipeline starts recording their plays (and goals can
// complete). Reuses the same server bridge the profile page uses.

export function RosterOptInCard({
  title,
  description,
  onTracked,
  performAction,
}: {
  // Both default to the generic wording below; a caller that passes its own
  // copy owns translating it (the dev preview route deliberately does not).
  title?: string;
  description?: string;
  onTracked?: () => void;
  // Dev previews inject a fake action so the card can be exercised without touching the backend.
  performAction?: () => Promise<RosterSelfTrackResult>;
}) {
  const { t } = useLingui();
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleTrack = useCallback(async () => {
    setStatus("pending");
    setMessage(null);
    try {
      const result = await (performAction ?? addSelfToRoster)();
      if (result.ok) {
        setStatus("done");
        showTrackingStartedToast();
        onTracked?.();
        return;
      }
      setStatus("error");
      setMessage(
        result.status === "country_not_tracked"
          ? t`Your country isn't tracked yet, so there's nothing to record your plays against.`
          : result.status === "country_full"
            ? t`This country's opt-in list is full right now. Check back later.`
            : t`Couldn't turn on tracking right now. Try again in a moment.`,
      );
    } catch {
      setStatus("error");
      setMessage(t`Couldn't turn on tracking right now. Try again in a moment.`);
    }
  }, [onTracked, performAction, t]);

  if (status === "done") {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2"><Trans>You're being tracked now</Trans></div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          <Trans>Your recent plays are being pulled in. This page fills in within a minute or two, and keeps updating as you play.</Trans>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
      <div className="text-sm font-semibold text-osu-l2">{title ?? t`Start tracking your plays`}</div>
      <div className="mt-1.5 text-[13px] text-osu-f1">
        {description ?? t`Plays are recorded automatically for the top 100 of each country. You're not in it yet, but you can add yourself to the tracker.`}
      </div>
      <button
        type="button"
        onClick={handleTrack}
        disabled={status === "pending"}
        className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white cursor-pointer disabled:opacity-60 disabled:cursor-default"
      >
        {status === "pending" ? t`Adding you…` : t`Track my plays`}
      </button>
      {message ? <div className="mt-3 text-[12px] text-osu-f1">{message}</div> : null}
    </div>
  );
}
