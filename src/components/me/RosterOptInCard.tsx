import { useCallback, useState } from "react";

import { addSelfToRoster } from "../../lib/roster-self-track";

// Offer a logged-in but untracked player the chance to add their own osu! account to their
// country's roster, after which the ingest pipeline starts recording their plays (and goals can
// complete). Reuses the same server bridge the profile page uses.

export function RosterOptInCard({
  title = "Start tracking your plays",
  description = "Plays are recorded automatically for the top 100 of each country. You're not in it yet, but you can add yourself to the tracker.",
  onTracked,
}: {
  title?: string;
  description?: string;
  onTracked?: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleTrack = useCallback(async () => {
    setStatus("pending");
    setMessage(null);
    try {
      const result = await addSelfToRoster();
      if (result.ok) {
        setStatus("done");
        onTracked?.();
        return;
      }
      setStatus("error");
      setMessage(
        result.status === "country_not_tracked"
          ? "Your country isn't tracked yet, so there's nothing to record your plays against."
          : result.status === "country_full"
            ? "This country's opt-in list is full right now. Check back later."
            : "Couldn't turn on tracking right now. Try again in a moment.",
      );
    } catch {
      setStatus("error");
      setMessage("Couldn't turn on tracking right now. Try again in a moment.");
    }
  }, [onTracked]);

  if (status === "done") {
    return (
      <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
        <div className="text-sm font-semibold text-osu-l2">You're being tracked now</div>
        <div className="mt-1.5 text-[13px] text-osu-f1">
          Your recent plays are being pulled in. This page fills in within a minute or two, and keeps updating as you play.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-osu-b3/20 bg-osu-b4 p-6 text-center">
      <div className="text-sm font-semibold text-osu-l2">{title}</div>
      <div className="mt-1.5 text-[13px] text-osu-f1">{description}</div>
      <button
        type="button"
        onClick={handleTrack}
        disabled={status === "pending"}
        className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-osu-pink/40 bg-osu-pink/15 text-[12px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/25 hover:text-white cursor-pointer disabled:opacity-60 disabled:cursor-default"
      >
        {status === "pending" ? "Adding you…" : "Track my plays"}
      </button>
      {message ? <div className="mt-3 text-[12px] text-osu-f1">{message}</div> : null}
    </div>
  );
}
