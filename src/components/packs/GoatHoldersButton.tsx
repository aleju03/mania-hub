import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { CountryFlag } from "../ui/CountryFlag";
import { useAuth } from "../../lib/auth-context";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import { HONORARY_PLAYERS, type HonoraryPlayer } from "../../lib/honorary-players";
import {
  fetchLiveBackendHonoraryPulls,
  type LiveBackendHonoraryCardPulls,
  type LiveBackendHonoraryPulls,
} from "../../lib/live-backend";

/* Admin-only readout of how the honorary roster has actually landed. It sits on
   the packs page rather than the backend admin page because it is about the
   packs economy, not the server.

   Ordered by the questions it gets asked: how much of the roster the community
   has found, what the newest GOAT was, who holds the most, and only then the
   card-by-card breakdown. The undiscovered half of the roster is a single
   wrapped line, since fifteen "never pulled" rows is most of a phone screen
   spent saying nothing.

   The button renders nothing for everyone else, and the data is only fetched
   once the modal opens, so a normal visit costs nothing. */
export function GoatHoldersButton() {
  const canSee = useAuth().canUseAdminFeatures;
  const [open, setOpen] = useState(false);

  if (!canSee) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-osu-b3/40 px-3 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:border-amber-300/40 hover:text-amber-200 cursor-pointer"
      >
        GOAT holders
      </button>
      <AnimatePresence>{open && <GoatHoldersModal onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function timeAgo(at: number | null | undefined): string | null {
  return at && at > 0 ? formatTimeAgo(new Date(at).toISOString()) : null;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">{children}</div>;
}

function GoatHoldersModal({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<LiveBackendHonoraryPulls | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One card open at a time: a popular card's holder list is long enough that
  // two of them expanded would bury the rest of the roster.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showUndiscovered, setShowUndiscovered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchLiveBackendHonoraryPulls();
        if (cancelled) return;
        setUnsupported(result === null);
        setReport(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Found cards carry their holders; the rest of the roster is just a list of
  // names, so the two are laid out differently.
  const { found, undiscovered } = useMemo(() => {
    const byCard = new Map((report?.cards ?? []).map((card) => [card.cardUserId, card]));
    const found: Array<{ player: HonoraryPlayer; pulls: LiveBackendHonoraryCardPulls }> = [];
    const undiscovered: HonoraryPlayer[] = [];
    for (const player of HONORARY_PLAYERS) {
      const pulls = byCard.get(player.id);
      if (pulls) found.push({ player, pulls });
      else undiscovered.push(player);
    }
    found.sort((a, b) => (b.pulls.lastPulledAt ?? 0) - (a.pulls.lastPulledAt ?? 0));
    return { found, undiscovered };
  }, [report]);

  const latest = report?.latest ?? null;
  const collectors = report?.collectors ?? [];

  return (
    <motion.div
      className="fixed inset-0 z-[130] flex items-end justify-center bg-black/80 sm:items-center sm:p-4 sm:backdrop-blur-sm cursor-pointer"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* A bottom sheet on phones (thumb reach, full width) and a centered
          card from sm up. translate="no": all names, counts and time-agos —
          auto-translate's <font> rewrites crash React commits over them. */}
      <motion.div
        translate="no"
        className="modal-card-mobile-safe relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-osu-b3/20 bg-osu-b4 shadow-[0_12px_60px_rgba(0,0,0,0.7)] sm:max-h-[85vh] sm:w-[520px] sm:rounded-2xl cursor-default"
        onClick={(event) => event.stopPropagation()}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 16 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 z-20 flex h-8 w-8 items-center justify-center rounded-full text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5 [scrollbar-gutter:stable]">
          <SectionLabel>GOATs discovered</SectionLabel>
          {error ? (
            <div className="mt-3 text-[12px] text-osu-red-light">{error}</div>
          ) : unsupported ? (
            <div className="mt-3 text-[12px] text-osu-f1">This is not available yet. Check back soon.</div>
          ) : report === null ? (
            <div className="py-10 text-center text-[12px] text-osu-f1">Loading...</div>
          ) : (
            <>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-4xl font-bold tabular-nums text-white">
                  {formatNumber(report.pulledCards)}
                  <span className="text-osu-f1">/{formatNumber(HONORARY_PLAYERS.length)}</span>
                </span>
                <span className="text-[11px] text-osu-f1">
                  {formatNumber(report.distinctOwners)} collector{report.distinctOwners === 1 ? "" : "s"}
                  {" · "}
                  {formatNumber(report.totalCopies)} cop{report.totalCopies === 1 ? "y" : "ies"}
                </span>
              </div>

              {latest ? (
                <div className="mt-4">
                  <SectionLabel>Latest</SectionLabel>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[15px] leading-snug">
                    <Link
                      to="/pull/$ownerId/$cardId"
                      params={{ ownerId: String(latest.ownerUserId), cardId: String(latest.cardUserId) }}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-bold text-white underline-offset-2 hover:underline"
                    >
                      {latest.ownerUsername}
                    </Link>
                    <span className="text-[13px] text-osu-f1">pulled</span>
                    <span className="font-bold text-amber-200">
                      {honoraryLabel(latest.cardUserId) ?? latest.cardUsername ?? `#${latest.cardUserId}`}
                    </span>
                    <span className="text-[13px] text-osu-f1">{timeAgo(latest.pulledAt)}</span>
                  </div>
                </div>
              ) : null}

              {collectors.length > 0 ? (
                <div className="mt-4">
                  <SectionLabel>Collectors</SectionLabel>
                  <div className="mt-1">
                    {collectors.map((collector) => (
                      <div
                        key={collector.userId}
                        className="flex items-center gap-2 border-b border-osu-b3/15 py-1.5 last:border-b-0"
                      >
                        <Link
                          to="/player/$username"
                          params={{ username: collector.username }}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 flex-1 truncate text-[13px] font-bold text-white underline-offset-2 hover:underline"
                        >
                          {collector.username}
                        </Link>
                        {collector.copies > collector.cards ? (
                          <span className="flex-shrink-0 text-[11px] text-osu-f1">
                            {formatNumber(collector.copies)} copies
                          </span>
                        ) : null}
                        <span className="flex-shrink-0 text-[13px] font-bold tabular-nums text-amber-200">
                          {formatNumber(collector.cards)}
                          <span className="text-osu-f1">/{formatNumber(HONORARY_PLAYERS.length)}</span>
                        </span>
                      </div>
                    ))}
                    {report.distinctOwners > collectors.length ? (
                      <div className="pt-1.5 text-[11px] text-osu-f1">
                        +{formatNumber(report.distinctOwners - collectors.length)} more collector
                        {report.distinctOwners - collectors.length === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {found.length > 0 ? (
                <div className="mt-4">
                  <SectionLabel>Cards found</SectionLabel>
                  <div className="mt-1">
                    {found.map(({ player, pulls }) => (
                      <GoatHolderRow
                        key={player.id}
                        player={player}
                        pulls={pulls}
                        ownersPerCard={report.ownersPerCard}
                        expanded={expandedId === player.id}
                        onToggle={() => setExpandedId(expandedId === player.id ? null : player.id)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {undiscovered.length > 0 ? (
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setShowUndiscovered(!showUndiscovered)}
                    className="flex w-full items-center gap-1.5 text-left cursor-pointer"
                    aria-expanded={showUndiscovered}
                  >
                    <SectionLabel>Still out there ({formatNumber(undiscovered.length)})</SectionLabel>
                    <ChevronRight
                      className={`h-3 w-3 text-osu-f1 transition-transform ${showUndiscovered ? "rotate-90" : ""}`}
                      aria-hidden="true"
                    />
                  </button>
                  {showUndiscovered ? (
                    <div className="mt-1 text-[12px] leading-relaxed text-osu-l2/80">
                      {undiscovered.map((player, index) => (
                        <Fragment key={player.id}>
                          {index > 0 ? <span className="text-osu-f1"> &middot; </span> : null}
                          <span>{player.cardName ?? player.username}</span>
                        </Fragment>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function honoraryLabel(userId: number): string | null {
  const player = HONORARY_PLAYERS.find((entry) => entry.id === userId);
  return player ? player.cardName ?? player.username : null;
}

/* Collapsed by default: the found cards read as a scannable list of counts, and
   the names (which can run to hundreds on a popular card) only unfold when
   asked for, into their own bounded scroll area. */
function GoatHolderRow({
  player,
  pulls,
  ownersPerCard,
  expanded,
  onToggle,
}: {
  player: HonoraryPlayer;
  pulls: LiveBackendHonoraryCardPulls;
  ownersPerCard: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const owners = pulls.owners;
  const hidden = pulls.ownerCount - owners.length;
  const label = player.cardName ?? player.username;

  return (
    <div className="border-b border-osu-b3/15 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 py-2 text-left cursor-pointer hover:text-white"
      >
        <ChevronRight
          className={`h-3 w-3 flex-shrink-0 text-osu-f1 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <CountryFlag code={player.countryCode} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-white">{label}</span>
        {/* The timestamp is the first thing to go when the row gets tight; it
            reappears per holder once the row is open. */}
        <span className="hidden flex-shrink-0 text-[11px] text-osu-f1 sm:inline">{timeAgo(pulls.lastPulledAt)}</span>
        <span className="flex-shrink-0 text-[11px] text-osu-f1">
          <span className="text-[14px] font-bold tabular-nums text-amber-200">{formatNumber(pulls.ownerCount)}</span>{" "}
          holder{pulls.ownerCount === 1 ? "" : "s"}
          {pulls.copies > pulls.ownerCount ? ` · ${formatNumber(pulls.copies)} copies` : ""}
        </span>
      </button>
      {expanded ? (
        // Oldest first, so the name at the front is whoever pulled it first.
        // Each name opens that holder's own pull permalink, which is public
        // and addressable from the two ids anyway.
        <div className="max-h-44 overflow-y-auto overscroll-contain pb-2 pl-[22px] pr-1 [scrollbar-gutter:stable]">
          {owners.map((owner) => (
            <div key={owner.userId} className="flex items-center gap-2 py-0.5 text-[12px]">
              <Link
                to="/pull/$ownerId/$cardId"
                params={{ ownerId: String(owner.userId), cardId: String(player.id) }}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open ${owner.username}'s pull of ${label}`}
                className="min-w-0 flex-1 truncate text-osu-l2/80 underline-offset-2 transition-colors hover:text-white hover:underline"
              >
                {owner.username}
                {owner.copies > 1 ? ` x${owner.copies}` : ""}
              </Link>
              <span className="flex-shrink-0 text-[11px] text-osu-f1">{timeAgo(owner.firstPulledAt)}</span>
            </div>
          ))}
          {hidden > 0 ? (
            <div className="pt-1 text-[11px] text-osu-f1">
              +{formatNumber(hidden)} more (list capped at {formatNumber(ownersPerCard)})
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
