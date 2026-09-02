import { useCallback, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";

import { addSelfToRoster, type RosterSelfTrackResult } from "../../lib/roster-self-track";
import { showTrackingStartedToast } from "../me/TrackingToasts";

// The Skills tab has useful top-play ratings before a player is tracked, which
// made it easy to mistake signing in (and seeing those ratings) for enabling
// tracking. Keep the opt-in beside that evidence, and only offer it when the
// verified viewer owns the profile. The server function independently derives
// the same owner from the signed login cookie; it never trusts a profile id
// supplied by the browser.
export function SkillsUntrackedNotice({
  username,
  isOwner,
  onTracked,
  performAction,
}: {
  username: string;
  isOwner: boolean;
  onTracked?: () => void;
  // Dev previews can exercise the exact component without changing a roster.
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

  const done = isOwner && status === "done";

  return (
    <div className="flex flex-col gap-2 border-b border-osu-b3/50 pb-3 text-[12.5px] leading-relaxed sm:flex-row sm:items-center sm:gap-4">
      <p className="min-w-0 flex-1 text-osu-l3">
        {done
          ? <Trans><span className="font-semibold text-osu-green">Tracking is on.</span> Your recent plays are being pulled in and will be rated here in a few minutes.</Trans>
          : isOwner
            ? <Trans><span className="font-semibold text-osu-l1">Your plays are not being tracked yet.</span> Signing in does not start tracking. Turn it on to include new loved and graveyard plays in your skill rating.</Trans>
            : <Trans><span className="font-semibold text-osu-l1">{username} isn't tracked</span>, so only their ranked plays are rated here. Loved and graveyard plays only reach this site through tracking, or when someone adds them with Add a missing score.</Trans>}
        {message ? <span className="block text-osu-red-light">{message}</span> : null}
      </p>

      {isOwner && !done ? (
        <button
          type="button"
          onClick={handleTrack}
          disabled={status === "pending"}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 self-start rounded-full bg-osu-pink/20 px-3.5 py-1.5 text-[11.5px] font-semibold text-osu-pink-light transition-colors hover:bg-osu-pink/35 hover:text-white disabled:cursor-default disabled:opacity-60"
        >
          {status === "pending" ? <Trans>Adding you…</Trans> : <Trans>Track my plays</Trans>}
        </button>
      ) : null}
    </div>
  );
}
