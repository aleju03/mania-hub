import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Flag, Loader2, RefreshCw, Users } from "lucide-react";
import { CountryFlag } from "../components/ui/CountryFlag";
import { formatTimeAgo } from "../lib/format";
import {
  COMMUNITY_INTERNATIONAL,
  canModerateCommunities,
  clearCommunitiesCache,
  communityInviteExpiryLabel,
  communityReportReasonLabel,
  countCommunityQueue,
  describeAccessScopes,
  communityLanguageLabel,
  fetchCommunityQueue,
  refreshCommunityInvites,
  reviewCommunity,
  type CommunityQueue,
  type CommunityReport,
  type CommunitySummary,
} from "../lib/communities";
import { pageSeo } from "../lib/seo";

/*
 * The /communities review queue.
 *
 * Deliberately not an /admin page. Reviewing here is a per-feature moderator
 * list the owner keeps by hand (COMMUNITY_MODERATOR_USER_IDS), reached from the
 * directory itself, so being trusted with servers implies nothing else on the
 * site. Every review server function re-checks that same list, which makes this
 * gate the courtesy and that one the lock.
 *
 * Three lists: servers someone flagged, servers waiting for a first decision,
 * and servers that were already approved and have been edited since. The last
 * one is the whole point of letting edits go live immediately - it is how a
 * listing approved with a clean pitch and then rewritten into something else
 * gets noticed. The first is what the people reading the directory noticed.
 *
 * Any decision on a listing clears the reports against it, including "looks
 * fine": approving one is a moderator's answer to whoever flagged it.
 */

export const Route = createFileRoute("/communities_/review")({
  beforeLoad: ({ context }) => {
    if (!canModerateCommunities(context.auth)) throw notFound();
  },
  head: ({ match }) => pageSeo({
    title: "Community review",
    description: "Review submitted Discord servers.",
    path: "/communities/review",
    origin: match.context.origin,
    noindex: true,
  }),
  component: CommunityReviewPage,
});

function ReviewCard({
  community,
  reports,
  onAction,
  busy,
}: {
  community: CommunitySummary;
  reports: CommunityReport[];
  onAction: (id: string, action: string, reason?: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const language = communityLanguageLabel(community.language);
  /*
   * Every button says what happens to the listing, which depends on whether it
   * is public yet. Approving something nobody can see is putting it up;
   * approving something already up is leaving it there, and those are different
   * enough sentences that one label for both read as a riddle.
   *
   * There is no hide button. Hiding puts a listing somewhere this page cannot
   * reach it again, and turning it down with a reason does the same job while
   * telling the owner why and leaving them a way to fix it.
   */
  const live = community.status === "approved";

  return (
    <div className="group relative rounded-xl border border-osu-b3/20 bg-osu-b4 p-3 transition-colors hover:border-osu-b3/50">
      {/* The card opens the listing's page, the same way one on the directory
          does, through a link laid over it rather than wrapped around it: the
          decision buttons and the invite cannot sit inside an anchor. They all
          carry z-10 to stay on top of it. A moderator reads a pitch here and
          then wants the whole thing, and retyping the URL was the only way. */}
      <Link
        to="/communities/$id"
        params={{ id: community.id }}
        aria-label={community.name}
        className="absolute inset-0 z-0 rounded-xl"
      />
      <div className="flex items-start gap-2.5">
        {community.iconUrl ? (
          <img src={community.iconUrl} alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-2xl object-cover" />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-osu-b3/40 text-[15px] font-bold text-osu-l2">
            {community.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 truncate text-[14px] font-bold text-white">{community.name}</h3>
            {community.countryCode && community.countryCode !== COMMUNITY_INTERNATIONAL && (
              <CountryFlag code={community.countryCode} size="sm" />
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-osu-f1 tabular-nums">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3 w-3" aria-hidden="true" />
              {community.memberCount.toLocaleString()}
            </span>
            {community.onlineCount > 0 && <span>{community.onlineCount.toLocaleString()} online</span>}
            {language && <span>{language}</span>}
            {/* Worth knowing before approving: a listing whose invite lapses
                next week will quietly drop off the directory then. */}
            {communityInviteExpiryLabel(community.inviteExpiresAt) && (
              <span className="text-amber-300">
                invite expires {communityInviteExpiryLabel(community.inviteExpiresAt)}
              </span>
            )}
            {community.countryCode === COMMUNITY_INTERNATIONAL && <span>international</span>}
            {/* A listing only some of the directory can join, and whether the
                rest can even see it. Both are the owner's call, but a moderator
                approving it should know which one they are approving. */}
            {describeAccessScopes(community.accessScopes) && (
              <span>
                {describeAccessScopes(community.accessScopes)}
                {community.accessHidden ? ", hidden from everyone else" : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* In full, with its line breaks: this is the text being approved, so it
          is not the place to fold it away. */}
      <p className="mt-2.5 whitespace-pre-line text-[12px] leading-relaxed text-osu-l2">{community.pitch}</p>

      {/* Tags are free text, so they are user content a moderator has to see. */}
      {community.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {community.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-osu-b3/45 px-2 py-0.5 text-[10.5px] font-semibold text-osu-l2">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Who is vouching for this, on both sides of the proof. */}
      <p className="mt-2.5 text-[11px] text-osu-f1/70">
        posted by {community.ownerUsername}, Discord {community.discordUsername ?? "unknown"}
        {community.isGuildOwner ? " (server owner)" : " (manages the server)"}
      </p>

      {/* What the people reading the directory said about it. Names are here
          because a report is signed, and a moderator weighing one wants to know
          whether it is the same person flagging everything. */}
      {reports.length > 0 && (
        <div className="mt-3 space-y-2.5 border-t border-osu-b3/20 pt-3">
          <h4 className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-osu-red-light">
            <Flag className="h-3 w-3" aria-hidden="true" />
            {reports.length === 1 ? "1 report" : `${reports.length} reports`}
          </h4>
          {reports.map((report) => (
            <div key={report.id}>
              <p className="text-[12px] font-semibold text-osu-l2">
                {communityReportReasonLabel(report.reason)}
              </p>
              {report.details && (
                <p className="mt-0.5 whitespace-pre-line text-[12px] leading-relaxed text-osu-l2">
                  {report.details}
                </p>
              )}
              <p className="mt-0.5 text-[11px] text-osu-f1/70">
                {report.reporterUsername || `user ${report.reporterUserId}`}, {formatTimeAgo(report.createdAt)}
              </p>
            </div>
          ))}
        </div>
      )}

      {rejecting ? (
        <div className="relative z-10 mt-3 space-y-2">
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value.slice(0, 200))}
            placeholder="Why, in a sentence. The person sees this."
            className="w-full rounded-lg border border-osu-b3/30 bg-osu-b5 px-3 py-2 text-[12.5px] text-osu-l1 placeholder:text-osu-f1/55 focus:border-osu-pink/50 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onAction(community.id, "reject", reason)}
              disabled={busy}
              className="rounded-full bg-osu-red px-4 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:opacity-40"
            >
              {live ? "Take it down" : "Turn it down"}
            </button>
            <button
              type="button"
              onClick={() => setRejecting(false)}
              className="text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white"
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="relative z-10 mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onAction(community.id, "approve")}
            disabled={busy}
            className="rounded-full bg-emerald-500 px-4 py-1.5 text-[12.5px] font-bold text-white transition cursor-pointer hover:brightness-110 disabled:opacity-40"
          >
            {live ? "Leave it up" : "Put it up"}
          </button>
          {/* Taking something down is not destroying it: the person is told why
              and can fix it and send it back, so it gets the site's soft red and
              a pill smaller than the green one rather than the alarm delete
              carries. */}
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="rounded-full bg-osu-red/15 px-3 py-1 text-[12px] font-semibold text-osu-red-light transition-colors cursor-pointer hover:bg-osu-red/25 disabled:opacity-40"
          >
            {live ? "take it down" : "turn it down"}
          </button>
          {/* Asked for in the card rather than through window.confirm, which is
              the browser's chrome rather than the site's, and which nothing else
              here uses. Same two-step shape as the skin delete. */}
          {confirmingDelete ? (
            <span className="flex items-center gap-2.5 text-[12px]">
              <span className="text-osu-f1">Delete for good?</span>
              <button
                type="button"
                onClick={() => onAction(community.id, "delete")}
                disabled={busy}
                className="font-bold text-osu-red transition-colors cursor-pointer hover:brightness-125 disabled:opacity-40"
              >
                delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
                className="font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white disabled:opacity-40"
              >
                keep it
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
              className="text-[12px] font-semibold text-osu-red transition-colors cursor-pointer hover:brightness-125 disabled:opacity-40"
            >
              delete
            </button>
          )}
          {/* Joining is part of deciding, so the invite stays one click away
              rather than living on the server's name, which now opens its page
              like every other card on the site. */}
          {community.inviteUrl && (
            <a
              href={community.inviteUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1.5 text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              open invite
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function CommunityReviewPage() {
  const [queue, setQueue] = useState<CommunityQueue>({ pending: [], edited: [], reported: [], reports: {} });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setQueue(await fetchCommunityQueue());
    } catch {
      setNote("Could not load the queue.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAction = async (id: string, action: string, reason?: string) => {
    setBusyId(id);
    setNote(null);
    try {
      const result = await reviewCommunity({ data: { id, action, reason } });
      if (!result.ok) {
        setNote("That did not go through.");
        return;
      }
      // An approval or a takedown changes what the directory lists, so the
      // pages it is holding go too rather than repainting the old grid.
      clearCommunitiesCache();
      // Whatever the decision, the listing leaves every queue, and the reports
      // against it go with it: the backend resolved them on the same call.
      setQueue((prev) => {
        const reports = { ...prev.reports };
        delete reports[id];
        return {
          pending: prev.pending.filter((row) => row.id !== id),
          edited: prev.edited.filter((row) => row.id !== id),
          reported: prev.reported.filter((row) => row.id !== id),
          reports,
        };
      });
    } catch {
      setNote("That did not go through.");
    } finally {
      setBusyId(null);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setNote(null);
    try {
      const result = await refreshCommunityInvites();
      // The sweep drops dead invites and moves the counts, so the directory's
      // held pages are out of date either way.
      if (result.ok) clearCommunitiesCache();
      setNote(result.ok
        ? `Checked ${result.checked ?? 0} listings, ${result.hidden ?? 0} dropped off.`
        : "Could not run the check.");
    } catch {
      setNote("Could not run the check.");
    } finally {
      setRefreshing(false);
    }
  };

  // The same count the directory's Review button carries, so "nothing waiting"
  // here and no badge there are one answer rather than two.
  const empty = countCommunityQueue(queue) === 0;

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-6 sm:px-5">
      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          to="/communities"
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-osu-f1 transition-colors cursor-pointer hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Discord servers
        </Link>
        {/* On a phone the title was squeezed between the link and the button and
            broke across two lines; on its own line below them it fits. */}
        <h1 className="order-last w-full text-[16px] font-bold text-white sm:order-none sm:w-auto sm:flex-1">
          Community review
        </h1>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="ml-auto inline-flex items-center gap-2 rounded-full bg-osu-b4 px-3.5 py-1.5 text-[12px] font-semibold text-osu-l2 transition-colors cursor-pointer hover:bg-osu-b3 disabled:opacity-40"
        >
          {refreshing
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          Check invites now
        </button>
      </div>

      {note && <p className="mb-4 text-[12px] text-osu-l2">{note}</p>}

      {loading ? (
        <p className="py-10 text-center text-[12.5px] text-osu-f1">Loading.</p>
      ) : empty ? (
        <p className="py-10 text-center text-[12.5px] text-osu-f1">Nothing waiting.</p>
      ) : (
        <div className="space-y-6">
          {/* First, because these are already public and somebody says there is
              something wrong with them. */}
          {queue.reported.length > 0 && (
            <section>
              <h2 className="mb-1 text-[13px] font-bold text-white">
                Reported ({queue.reported.length})
              </h2>
              <p className="mb-2 text-[11.5px] text-osu-f1">
                Already listed. Leaving one up clears the reports on it too.
              </p>
              <div className="space-y-2">
                {queue.reported.map((community) => (
                  <ReviewCard
                    key={community.id}
                    community={community}
                    reports={queue.reports[community.id] ?? []}
                    onAction={handleAction}
                    busy={busyId === community.id}
                  />
                ))}
              </div>
            </section>
          )}

          {queue.pending.length > 0 && (
            <section>
              <h2 className="mb-2 text-[13px] font-bold text-white">
                Waiting for review ({queue.pending.length})
              </h2>
              <div className="space-y-2">
                {queue.pending.map((community) => (
                  <ReviewCard
                    key={community.id}
                    community={community}
                    reports={queue.reports[community.id] ?? []}
                    onAction={handleAction}
                    busy={busyId === community.id}
                  />
                ))}
              </div>
            </section>
          )}

          {queue.edited.length > 0 && (
            <section>
              <h2 className="mb-1 text-[13px] font-bold text-white">
                Edited since approval ({queue.edited.length})
              </h2>
              <p className="mb-2 text-[11.5px] text-osu-f1">
                Already live. Leaving one up just clears it off this list.
              </p>
              <div className="space-y-2">
                {queue.edited.map((community) => (
                  <ReviewCard
                    key={community.id}
                    community={community}
                    reports={queue.reports[community.id] ?? []}
                    onAction={handleAction}
                    busy={busyId === community.id}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
