import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fetchGoatPollVoters, type GoatPollVoter } from "#/lib/goat-poll";
import type { GoatPollNominee } from "#/lib/live-backend";
import { formatTimeAgo } from "#/lib/format";
import { avatarImageSrc } from "#/components/ui/Avatar";
import { CountryFlag } from "#/components/ui/CountryFlag";

/* Who voted for one nominee, and which way.
 *
 * Admin-only, and the only place on the site where a vote has a name attached:
 * the board shows everyone a net number on purpose, because a poll that names
 * your downvotes is a poll people vote on differently. What this is for is the
 * one person who has to decide what the result meant, and cannot tell +8 built
 * out of one player's friends from +8 the community agreed on until they read
 * the names.
 *
 * Read on open rather than kept fresh: it is a moment's look at a row, not
 * another live surface, and the vote arriving while it is open is on the board
 * behind it anyway.
 */

function VoterRow({ voter, nominator }: { voter: GoatPollVoter; nominator: boolean }) {
  const up = voter.value > 0;
  return (
    <li className="flex items-center gap-2 px-3 py-1.5">
      <ChevronDown
        className={`h-3.5 w-3.5 shrink-0 ${up ? "rotate-180 text-osu-pink" : "text-osu-red-light/80"}`}
        aria-label={up ? "voted for" : "voted against"}
      />
      {voter.avatarUrl ? (
        <img
          src={avatarImageSrc(voter.avatarUrl, voter.userId)}
          alt=""
          className="h-6 w-6 shrink-0 rounded-full object-cover"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span className="h-6 w-6 shrink-0 rounded-full bg-osu-b3/70" />
      )}
      <a
        href={`https://osu.ppy.sh/users/${voter.userId}`}
        target="_blank"
        rel="noreferrer noopener"
        translate="no"
        className="min-w-0 truncate text-[12px] font-semibold text-osu-c1/85 transition-colors hover:text-osu-pink"
      >
        {/* No name anywhere the backend can look means an account that has never
            browsed signed in and is on no tracked roster — rare, and the id is
            still the voter, so it stands in rather than blanking the row. */}
        {voter.username ?? `user ${voter.userId}`}
      </a>
      {voter.countryCode && <CountryFlag code={voter.countryCode} size="xs" />}
      {nominator && (
        <span className="shrink-0 rounded bg-osu-b3/60 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-osu-f1/70">
          nominator
        </span>
      )}
      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-osu-f1/50">
        {formatTimeAgo(new Date(voter.votedAt).toISOString())}
      </span>
    </li>
  );
}

export function GoatPollVotersModal({
  nominee,
  onClose,
}: {
  /* The row being inspected, or null when nothing is open. Kept as the whole
     nominee rather than an id so the header can name them and show the tallies
     the list is supposed to explain. */
  nominee: GoatPollNominee | null;
  onClose: () => void;
}) {
  const open = nominee != null;
  const [voters, setVoters] = useState<GoatPollVoter[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!nominee) return;
    let cancelled = false;
    setVoters(null);
    setFailed(false);
    void fetchGoatPollVoters({ data: { nomineeId: nominee.id } })
      .then((rows) => {
        if (cancelled) return;
        if (rows) setVoters(rows);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [nominee?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [open]);

  if (typeof document === "undefined") return null;

  const ups = voters?.filter((voter) => voter.value > 0) ?? [];
  const downs = voters?.filter((voter) => voter.value < 0) ?? [];

  return createPortal(
    <AnimatePresence>
      {nominee ? (
        <div className="fixed inset-0 z-[140] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 bg-black/65"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Votes for ${nominee.username}`}
            // This dialog used to carry translate="no" as crash armor against
            // auto-translate's <font> rewrites; dom-translate-guard.ts absorbs
            // that now, so the status prose translates and only the name spans
            // opt out.
            initial={{ opacity: 0, y: 8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.99 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="modal-card-mobile-safe relative z-10 flex max-h-[min(560px,calc(100vh-2rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-osu-b2/70 bg-osu-b4 shadow-2xl"
          >
            <div className="flex items-center gap-2.5 border-b border-osu-b3/50 px-4 py-3">
              {nominee.avatarUrl ? (
                <img
                  src={nominee.osuUserId ? avatarImageSrc(nominee.avatarUrl, nominee.osuUserId) : nominee.avatarUrl}
                  alt=""
                  className="h-7 w-7 shrink-0 rounded-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-osu-b3/70">
                  <CountryFlag code={nominee.countryCode ?? ""} size="xs" decorative />
                </span>
              )}
              <span className="flex min-w-0 flex-col leading-tight">
                <span translate="no" className="truncate text-sm font-bold text-white">{nominee.username}</span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">
                  {nominee.up} up · {nominee.down} down
                </span>
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="ml-auto cursor-pointer rounded-md p-1 text-osu-f1 transition-colors hover:bg-osu-b3/60 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
              {failed ? (
                <div className="px-4 py-6 text-center text-[12px] text-osu-f1">Couldn&apos;t read the votes.</div>
              ) : voters == null ? (
                <div className="px-4 py-6 text-center text-[12px] text-osu-f1">Reading the ballot...</div>
              ) : voters.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-osu-f1">Nobody has voted on this row.</div>
              ) : (
                <>
                  {ups.length > 0 && (
                    <ul>
                      {ups.map((voter) => (
                        <VoterRow key={voter.userId} voter={voter} nominator={voter.userId === nominee.nominatedBy} />
                      ))}
                    </ul>
                  )}
                  {downs.length > 0 && (
                    <ul className={ups.length > 0 ? "mt-1 border-t border-osu-b3/30 pt-1" : undefined}>
                      {downs.map((voter) => (
                        <VoterRow key={voter.userId} voter={voter} nominator={voter.userId === nominee.nominatedBy} />
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
