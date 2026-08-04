import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { formatNumber, formatTimeAgo } from "../../lib/format";
import { MANIA_TIER_STYLES, type ManiaCardTier } from "../../lib/maniacard";
import {
  fetchServerPackCardCollectors,
  type ServerPackCardCollector,
  type ServerPackCardCollectors,
} from "../../lib/pack-wallet-sync";

/* "Who has my card": the names behind the owners count on the packs page.
   The count is public, this list is not - the server function resolves the
   card from the login cookie, so you only ever see the collectors of your own
   card.

   Names only, as one run of text that wraps like a sentence. A row carrying a
   serial, a date, a copy count and a tier is four columns to align at every
   width and three of them repeat down the whole list; a hundred names are a
   paragraph. Order is mint order, so the run starts with whoever found you
   first. Point at a name and the pinned footer says the rest about them, which
   keeps the detail one line long and off the list itself. */

function timeAgo(at: number): string | null {
  return at > 0 ? formatTimeAgo(new Date(at).toISOString()) : null;
}

function tierStyle(tier: ManiaCardTier | null): { label: string; rgb: string } | null {
  if (!tier || !(tier in MANIA_TIER_STYLES)) return null;
  const style = MANIA_TIER_STYLES[tier];
  const match = style.badgeHalo.match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  return { label: style.label, rgb: match ? `${match[1]}, ${match[2]}, ${match[3]}` : "148, 163, 184" };
}

/* Wraps the trigger so the packs page does not have to own the open state. */
export function CardCollectorsButton({ className, children }: { className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {children}
      </button>
      <AnimatePresence>{open && <CardCollectorsModal onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

/* Past this many names, finding one specific person by eye stops working. */
const FILTER_THRESHOLD = 24;

function CardCollectorsModal({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<ServerPackCardCollectors | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Nobody is named until you point at someone: a name lit on open would read
  // as a pick you did not make. Hover previews and click sticks, and the last
  // name you looked at stays named after the pointer leaves, so the footer
  // appears once rather than flickering in and out along the run.
  const [lastActiveId, setLastActiveId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchServerPackCardCollectors();
        if (cancelled) return;
        setSignedOut(result === null);
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

  const collectors = report?.collectors ?? [];
  const hidden = report ? Math.max(0, report.owners - collectors.length) : 0;
  // Your card is one rarity for as long as your rank sits still, so the tier
  // is the same word for everyone and a word you already know: it is your own
  // card. It is only worth naming when a rank move means people hold you at
  // different tiers.
  const mixedTiers = useMemo(
    () => collectors.length > 1 && collectors.some((collector) => collector.tier !== collectors[0].tier),
    [collectors],
  );
  const trimmedQuery = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      trimmedQuery
        ? collectors.filter((collector) => collector.username.toLowerCase().includes(trimmedQuery))
        : collectors,
    [collectors, trimmedQuery],
  );
  const active =
    shown.find((collector) => collector.userId === hoveredId) ??
    shown.find((collector) => collector.userId === lastActiveId) ??
    null;

  return (
    <motion.div
      className="pointer-events-auto fixed inset-0 z-[130] flex items-end justify-center bg-black/80 sm:items-center sm:p-4 sm:backdrop-blur-sm cursor-pointer"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="modal-card-mobile-safe relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-osu-b3/20 bg-osu-b4 shadow-[0_12px_60px_rgba(0,0,0,0.7)] sm:max-h-[85vh] sm:w-[460px] sm:rounded-2xl cursor-default"
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

        <div className="flex-shrink-0 px-4 pt-4 sm:px-5 sm:pt-5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-osu-f1">Who has your card</div>
          {report && report.owners > 0 ? (
            <>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-4xl font-bold leading-none tabular-nums text-white">
                  {formatNumber(report.owners)}
                </span>
                <span className="text-[11px] text-osu-f1">
                  collector{report.owners === 1 ? "" : "s"}
                  {/* Only worth saying when someone holds a duplicate;
                      otherwise it repeats the number above it. */}
                  {report.copies > report.owners
                    ? ` · ${formatNumber(report.copies)} cop${report.copies === 1 ? "y" : "ies"}`
                    : ""}
                </span>
              </div>
              {collectors.length > FILTER_THRESHOLD ? (
                <div className="relative mt-3">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-osu-f1" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="find a collector..."
                    className="w-full rounded-lg border border-osu-b3/40 bg-osu-b4/40 py-1.5 pl-8 pr-3 text-[12px] text-white placeholder:text-osu-f1/70 outline-none transition-colors focus:border-osu-pink/40"
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5 [scrollbar-gutter:stable]">
          {error ? (
            <div className="text-[12px] text-osu-red-light">{error}</div>
          ) : signedOut ? (
            <div className="text-[12px] text-osu-f1">Sign in with osu! to see who has pulled your card.</div>
          ) : report === null ? (
            <div className="py-10 text-center text-[12px] text-osu-f1">Loading...</div>
          ) : report.owners === 0 ? (
            <div className="text-[12px] text-osu-f1">Nobody has pulled your card yet.</div>
          ) : shown.length === 0 ? (
            <div className="text-[12px] text-osu-f1">Nobody here by that name.</div>
          ) : (
            <>
              {/* One run of names, wrapping like a sentence. No rows to align,
                  so it is the same shape at 320px and 460px, and a hundred
                  collectors are a paragraph instead of a scroll. */}
              <div className="text-[13px] leading-relaxed">
                {shown.map((collector, index) => (
                  <Fragment key={collector.userId}>
                    {index > 0 ? <span className="text-osu-f1/40"> · </span> : null}
                    <CollectorName
                      collector={collector}
                      // Until a name is being read the whole run is at full
                      // strength; dimming only means "not this one".
                      dimmed={active !== null && active.userId !== collector.userId}
                      onPick={() => setLastActiveId(collector.userId)}
                      onHover={(hovering) => {
                        setHoveredId(hovering ? collector.userId : null);
                        if (hovering) setLastActiveId(collector.userId);
                      }}
                    />
                  </Fragment>
                ))}
                {hidden > 0 && !trimmedQuery ? (
                  <span className="text-[11px] text-osu-f1">
                    {" "}
                    and {formatNumber(hidden)} more
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>

        {/* Slides in the first time you point at a name and then stays, so the
            list keeps its full height until you ask it a question. */}
        <AnimatePresence initial={false}>
          {active && report ? (
            <motion.div
              className="flex-shrink-0 overflow-hidden"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <CollectorFooter collector={active} cardUserId={report.userId} showTier={mixedTiers} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

/* One name in the run. Everything about this collector other than their name
   is in the footer, which is the whole point: the list stays a list of people
   and never becomes a table. */
function CollectorName({
  collector,
  dimmed,
  onPick,
  onHover,
}: {
  collector: ServerPackCardCollector;
  dimmed: boolean;
  onPick: () => void;
  onHover: (hovering: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      onFocus={onPick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={`cursor-pointer font-bold outline-none transition-colors ${
        dimmed ? "text-white/40" : "text-white"
      }`}
    >
      {collector.username}
    </button>
  );
}

/* The readout for whichever name is under the pointer. Pinned below the run
   rather than inside it, so scrolling a hundred names never scrolls away the
   line that says who you are looking at. */
function CollectorFooter({
  collector,
  cardUserId,
  showTier,
}: {
  collector: ServerPackCardCollector;
  cardUserId: number;
  showTier: boolean;
}) {
  const tier = tierStyle(collector.tier);
  const pulled = timeAgo(collector.firstPulledAt);
  const meta: string[] = [];
  // The serial they hold you at, so the run doubles as the mint order of your
  // own card. Missing on a holding older than the serial registry.
  if (collector.serial !== null) meta.push(`#${formatNumber(collector.serial)}`);
  if (pulled) meta.push(pulled);
  if (collector.copies > 1) meta.push(`${formatNumber(collector.copies)} copies`);

  return (
    <div className="flex flex-shrink-0 items-center gap-3 border-t border-osu-b3/15 px-4 py-3 sm:px-5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[14px] font-bold leading-tight text-white">{collector.username}</span>
          {/* Pulling your own card out of a pack is rare enough to name. */}
          {collector.userId === cardUserId ? (
            <span className="flex-shrink-0 text-[10px] leading-tight text-osu-f1">you</span>
          ) : null}
        </span>
        <span className="truncate text-[11px] leading-tight text-osu-f1 tabular-nums">
          {meta.join(" · ")}
          {showTier && tier ? (
            <span style={{ color: `rgba(${tier.rgb}, 0.9)` }}>
              {meta.length > 0 ? " · " : ""}
              <span className="font-bold uppercase tracking-wide">{tier.label}</span>
            </span>
          ) : null}
        </span>
      </span>
      <Link
        to="/pull/$ownerId/$cardId"
        params={{ ownerId: String(collector.userId), cardId: String(cardUserId) }}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-shrink-0 rounded-full border border-osu-b3/40 px-3 py-1 text-[11px] font-semibold text-osu-f1 transition-colors hover:border-osu-pink/50 hover:text-white"
      >
        Their copy
      </Link>
    </div>
  );
}
