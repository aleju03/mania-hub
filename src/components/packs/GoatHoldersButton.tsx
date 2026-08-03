import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { CountryFlag } from "../ui/CountryFlag";
import { useAuth } from "../../lib/auth-context";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import { HONORARY_PLAYERS, type HonoraryPlayer } from "../../lib/honorary-players";
import {
  fetchLiveBackendHonoraryPulls,
  type LiveBackendHonoraryCardPulls,
  type LiveBackendHonoraryPulls,
} from "../../lib/live-backend";

/* Admin-only readout of how the honorary roster has actually landed: who holds
   each GOAT card and since when. It sits on the packs page rather than the
   backend admin page because it is about the packs economy, not the server.

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

function GoatHoldersModal({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<LiveBackendHonoraryPulls | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Every roster member gets a row, holders first: which cards have never
  // landed is half of what this answers.
  const rows = useMemo(() => {
    const byCard = new Map((report?.cards ?? []).map((card) => [card.cardUserId, card]));
    return HONORARY_PLAYERS
      .map((player) => ({ player, pulls: byCard.get(player.id) ?? null }))
      .sort((a, b) => (b.pulls?.ownerCount ?? 0) - (a.pulls?.ownerCount ?? 0));
  }, [report]);

  return (
    <motion.div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/80 p-4 sm:backdrop-blur-sm cursor-pointer"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="modal-card-mobile-safe relative bg-osu-b4 border border-osu-b3/20 rounded-2xl w-[520px] max-w-full max-h-[85vh] overflow-hidden shadow-[0_12px_60px_rgba(0,0,0,0.7)] cursor-default"
        onClick={(event) => event.stopPropagation()}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 z-20 flex h-7 w-7 items-center justify-center rounded-full text-osu-f1 transition-colors hover:bg-osu-b3/50 hover:text-white cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M1 1l12 12M13 1L1 13" />
          </svg>
        </button>
        <div className="max-h-[85vh] overflow-y-auto p-5 [scrollbar-gutter:stable]">
          <div className="text-[10px] uppercase tracking-wider text-osu-f1 font-semibold">GOAT holders</div>
          {error ? (
            <div className="mt-3 text-[12px] text-osu-red-light">{error}</div>
          ) : unsupported ? (
            <div className="mt-3 text-[12px] text-osu-f1">The backend does not expose this yet (deploy pending).</div>
          ) : report === null ? (
            <div className="py-10 text-center text-[12px] text-osu-f1">Loading...</div>
          ) : (
            <>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-bold tabular-nums text-white">
                  {formatNumber(report.pulledCards)}/{formatNumber(HONORARY_PLAYERS.length)}
                </span>
                <span className="text-[11px] text-osu-f1">
                  pulled &middot; {formatNumber(report.distinctOwners)} collector
                  {report.distinctOwners === 1 ? "" : "s"} &middot; {formatNumber(report.totalCopies)} copies
                </span>
              </div>
              {/* Counted from synced collections, so a card pulled out of the
                  ranked pool before the player joined the roster counts too. */}
              <div className="mt-1 text-[11px] text-osu-f1">
                Holders of each card, including copies pulled before the player joined the roster.
              </div>
              <div className="mt-4 space-y-1.5">
                {rows.map(({ player, pulls }) => (
                  <GoatHolderRow
                    key={player.id}
                    player={player}
                    pulls={pulls}
                    ownersPerCard={report.ownersPerCard}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function GoatHolderRow({
  player,
  pulls,
  ownersPerCard,
}: {
  player: HonoraryPlayer;
  pulls: LiveBackendHonoraryCardPulls | null;
  ownersPerCard: number;
}) {
  const owners = pulls?.owners ?? [];
  const hidden = (pulls?.ownerCount ?? 0) - owners.length;
  return (
    <div className={`rounded-lg bg-osu-b5/60 px-3 py-2 ${pulls ? "" : "opacity-50"}`}>
      <div className="flex items-center gap-2 min-w-0">
        <CountryFlag code={player.countryCode} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-white">
          {player.cardName ?? player.username}
        </span>
        {pulls ? (
          <>
            <span className="flex-shrink-0 text-[13px] font-bold tabular-nums text-amber-200">
              {formatNumber(pulls.ownerCount)}
            </span>
            <span className="flex-shrink-0 text-[11px] text-osu-f1">
              holder{pulls.ownerCount === 1 ? "" : "s"} &middot; {formatNumber(pulls.copies)} copies
            </span>
          </>
        ) : (
          <span className="flex-shrink-0 text-[11px] text-osu-f1">never pulled</span>
        )}
        {pulls?.firstPulledAt ? (
          <span
            className="flex-shrink-0 text-[11px] text-osu-f1"
            title={new Date(pulls.firstPulledAt).toLocaleString()}
          >
            first {formatTimeAgo(new Date(pulls.firstPulledAt).toISOString())}
          </span>
        ) : null}
      </div>
      {owners.length > 0 ? (
        // Oldest first, so the name at the front is whoever pulled it first.
        <div className="mt-1 text-[11px] text-osu-l2/80 break-words">
          {owners.map((owner) => `${owner.username}${owner.copies > 1 ? ` x${owner.copies}` : ""}`).join(" · ")}
          {hidden > 0 ? ` · +${formatNumber(hidden)} more (capped at ${formatNumber(ownersPerCard)})` : ""}
        </div>
      ) : null}
    </div>
  );
}
