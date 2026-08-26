import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { communityInviteExpiryLabel, type CommunitySummary } from "../../lib/communities-shared";

/*
 * Where a listing stands, for the person who posted it.
 *
 * Only the owner's copy of a listing carries a status at all, so this draws
 * nothing for everyone else. It is on the card itself rather than in a panel of
 * its own: a listing waiting for approval, or one whose invite stopped working
 * and has dropped off the page until a fresh one is pasted, are things only its
 * owner can act on, and they belong on the thing they are about.
 */
export function CommunityStatusNote({ community }: { community: CommunitySummary }) {
  const { t } = useLingui();
  if (!community.status) return null;

  if (community.inviteOk === false) {
    return (
      <Note tone="warn">
        {t`This invite stopped working, so your server is hidden. Paste a new link to put it back.`}
      </Note>
    );
  }
  if (community.status === "pending") {
    return <Note tone="muted">{t`Waiting for approval.`}</Note>;
  }
  if (community.status === "rejected") {
    // Moderators type the reason as a fragment as often as a sentence, so give
    // it the full stop it needs rather than running it into the next line.
    const reason = community.rejectReason?.trim();
    const said = reason ? `: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}` : ".";
    // A listing that was live and is not anymore was flagged by somebody
    // reading the directory, not picked out by the site: say so, because the
    // two are the same status and only one of them is about the owner's
    // submission. The moderator is never named either way - that is between
    // them and the queue.
    //
    // No offer to edit on this one. Editing still sends a rejected listing back
    // to pending, whatever put it there - but a server taken down over what
    // happens inside it is not something a rewritten pitch answers, and saying
    // so here reads as an invitation to try again with better wording.
    if (community.wasApproved) {
      return (
        <Note tone="bad">
          <Trans>Someone reported your server and it got taken down for the following reason{said}</Trans>
        </Note>
      );
    }
    return <Note tone="bad"><Trans>Turned down{said} Editing it sends it back for approval.</Trans></Note>;
  }
  if (community.status === "hidden") {
    return <Note tone="muted">{t`Taken down by a moderator.`}</Note>;
  }
  // A listing posted with an expiring invite is fine until it is not, and the
  // date is the one thing its owner cannot see anywhere else. Said here while
  // it can still be fixed, rather than by the sweep once the link is dead.
  const expiry = communityInviteExpiryLabel(community.inviteExpiresAt);
  if (expiry) {
    return (
      <Note tone="warn">
        <Trans>This invite expires on {expiry}. When it does, your server gets hidden until you paste a new link.</Trans>
      </Note>
    );
  }
  return null;
}

/* An approved, working listing says nothing on the card: it looks exactly like
   what everyone else sees, which is the whole message. The edit button is the
   only thing marking it as yours. */

function Note({ tone, children }: { tone: "muted" | "warn" | "bad"; children: ReactNode }) {
  const color = tone === "warn" ? "text-amber-300" : tone === "bad" ? "text-osu-pink-light" : "text-osu-f1";
  return (
    <p className={`flex items-start gap-1.5 text-[11.5px] leading-relaxed ${color}`}>
      {tone !== "muted" && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {children}
    </p>
  );
}
