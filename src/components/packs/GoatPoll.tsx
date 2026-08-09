import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ExternalLink, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "#/lib/auth-context";
import { canUseAdminFeatures } from "#/lib/auth-shared";
import {
  castGoatPollVote,
  fetchGoatPollBoardAsAdmin,
  fetchMyGoatPollVotes,
  nominateGoatPollPlayer,
  removeGoatPollNominee,
  type GoatPollWriteStatus,
} from "#/lib/goat-poll";
import { HONORARY_PLAYERS } from "#/lib/honorary-players";
import { fetchGoatPollBoard, type GoatPollBoard, type GoatPollNominee } from "#/lib/live-backend";
import { searchPlayers } from "#/lib/player-search";
import { useDocumentVisible } from "#/lib/window-activity";
import { avatarImageSrc } from "#/components/ui/Avatar";
import { CountryFlag } from "#/components/ui/CountryFlag";
import { SearchInput } from "#/components/ui/SearchInput";

/* The temporary community vote for the next GOAT card: a timed window where
   players put names up and vote them up or down.

   Deliberately chrome-less. The packs page is already a wall of cards competing
   for the eye, and a bordered panel in the gutter read as another one; this sits
   in the same quiet register as PackPulse's fun fact, one shade above the
   background, and lets the pie be the only thing that moves.

   There is no switch in this file on purpose. The poll's dates and its on/off
   flag live in ONE place, GOAT_POLL in live-backend/src/features/goat-poll.ts,
   and this widget renders nothing at all when the board read comes back empty —
   which is what a retired poll returns. Two switches would mean two things to
   remember to flip. */

const REFRESH_MS = 20_000;
// Nominating a banned or deleted account needs proof it existed, because osu!'s
// search cannot return a restricted user and we would otherwise be taking the
// nominator's word for a name nobody can look up.
const PROOF_HINT = "web.archive.org link to their osu! profile";
// Rows shown before the list is cut off. Past this the board stops being
// something you read and starts being something you scroll past, which on a
// phone means scrolling past it to reach the packs.
const VISIBLE_ROWS = 8;
/* Expanded, the list scrolls inside a fixed height rather than running down the
   page. It is absolutely positioned in the rail, so an uncapped board does not
   lengthen the page — it paints over it, and 500 nominees is 16,000px of that. */
const EXPANDED_HEIGHT = "max-h-[min(60vh,420px)]";
/* Past this many rows the layout animation comes off. framer-motion measures
   every row on every render to animate reordering, and this board re-renders on
   each 20s refresh and each vote — which is fine for a list you can read and
   ruinous for hundreds. */
const ANIMATED_ROWS_MAX = 40;
// Everyone the poll cannot put up, because they are the thing being voted for.
const HONORARY_IDS: ReadonlySet<number> = new Set(HONORARY_PLAYERS.map((player) => player.id));

/* Above this the widget floats into the page's right gutter; below it stacks in
   flow, collapsed to a single line until tapped. Written twice — Tailwind needs
   the literal in the class string, the matchMedia hook needs the number — so
   keep the two in step. */
const RAIL_MIN_WIDTH = 1650;
const RAIL_LAYOUT = "min-[1650px]:absolute min-[1650px]:left-[calc(50%+500px)] min-[1650px]:top-[176px] min-[1650px]:mb-0 min-[1650px]:w-[280px] min-[1650px]:border-0 min-[1650px]:pt-0";

const STATUS_MESSAGES: Partial<Record<GoatPollWriteStatus, string>> = {
  already_nominated: "Already on the board.",
  already_honorary: "They're already a GOAT.",
  cap_reached: "You've used all your nominations.",
  invalid_username: "That username doesn't look right.",
  invalid_proof: `Needs a ${PROOF_HINT}.`,
  poll_closed: "The vote just closed.",
  unavailable: "Couldn't reach the server.",
};

/* True once the viewport has room for the gutter rail. Nothing here renders
   during SSR (the board is fetched in the browser), so starting at false and
   correcting in an effect costs no hydration mismatch. */
function useRailWidth(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${RAIL_MIN_WIDTH}px)`);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return wide;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "closed";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/* The osu! replay progress pie, in DOM. Same four layers drawStack uses in
   ReplayCanvas.drawProgressPie: a dark disc, a wedge filling clockwise from 12
   o'clock, an outline, and a centre dot. A wedge rather than a stroked ring
   because the replay pie fills as a solid sector, and that is what was asked
   for. */
function wedgePath(cx: number, cy: number, radius: number, progress: number): string {
  if (progress <= 0) return "";
  // A full circle cannot be drawn as a single arc (start and end coincide), so
  // anything effectively complete becomes two half-arcs.
  if (progress >= 0.9999) {
    return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx} ${cy + radius} A ${radius} ${radius} 0 1 1 ${cx} ${cy - radius} Z`;
  }
  const angle = -Math.PI / 2 + progress * Math.PI * 2;
  const x = cx + Math.cos(angle) * radius;
  const y = cy + Math.sin(angle) * radius;
  return `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${progress > 0.5 ? 1 : 0} 1 ${x} ${y} Z`;
}

/* Ticks once a second against the deadline rather than counting down from a
   duration, so a throttled or slept tab comes back showing the truth. Writes
   straight to refs: over 30 hours a re-render per second is 108,000 renders for
   a shape that moves 0.003 degrees each time.

   `offset` is the browser's error against the backend's clock. Everything here
   is measured in the server's time, so two people voting from opposite sides of
   the world — or one of them with a system clock set to last Tuesday — watch
   the same wedge and get the same answer as the deadline the backend enforces
   on their vote. */
function PollPie({
  opensAt,
  closesAt,
  offset,
  onExpire,
  size = 30,
}: {
  opensAt: number;
  closesAt: number;
  offset: number;
  /* Called the first tick past the deadline. The rest of the widget reads
     `closed` at render time, and nothing else here re-renders — so without this
     the countdown would read 0s next to a still-open nominate box until the
     20-second board refresh caught up. */
  onExpire: () => void;
  size?: number;
}) {
  const pathRef = useRef<SVGPathElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const visible = useDocumentVisible();
  const radius = size / 2 - 2.5;
  const center = size / 2;
  const span = Math.max(1, closesAt - opensAt);

  useEffect(() => {
    const paint = () => {
      const remaining = closesAt - (Date.now() + offset);
      const progress = Math.max(0, Math.min(1, 1 - remaining / span));
      if (pathRef.current) pathRef.current.setAttribute("d", wedgePath(center, center, radius, progress));
      if (labelRef.current) labelRef.current.textContent = formatRemaining(remaining);
      if (remaining <= 0) onExpire();
    };
    paint();
    if (!visible) return;
    const timer = setInterval(paint, 1000);
    return () => clearInterval(timer);
  }, [closesAt, span, center, radius, visible, offset, onExpire]);

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0">
        <circle cx={center} cy={center} r={radius} fill="#000000" fillOpacity={0.28} />
        <path ref={pathRef} d="" fill="#f0f0f0" fillOpacity={0.5} />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#f0f0f0"
          strokeOpacity={0.75}
          strokeWidth={Math.max(1.1, radius * 0.11)}
        />
        <circle cx={center} cy={center} r={Math.max(1.5, radius * 0.16)} fill="#f0f0f0" fillOpacity={0.75} />
      </svg>
      <span ref={labelRef} className="text-[11px] font-bold tabular-nums text-osu-c1/85">
        {formatRemaining(closesAt - (Date.now() + offset))}
      </span>
    </span>
  );
}

function NomineeRow({
  nominee,
  vote,
  disabled,
  animated,
  moderation,
  onVote,
}: {
  nominee: GoatPollNominee;
  vote: number;
  disabled: boolean;
  animated: boolean;
  /* Set only for a true admin: moderation lives on the row, next to the thing
     being moderated, like the streak board's — and asks twice on the row
     rather than through a browser dialog, because this sits in the quiet
     corner of a page that is mostly a card game. */
  moderation?: {
    armed: boolean;
    busy: boolean;
    onArm: () => void;
    onCancel: () => void;
    onRemove: () => void;
  };
  onVote: (nomineeId: string, next: number) => void;
}) {
  // Clicking the arrow you already picked clears the vote, so undoing does not
  // need a third control.
  const cast = (value: number) => onVote(nominee.id, vote === value ? 0 : value);
  return (
    <motion.li layout={animated} className="flex items-center gap-2 py-1">
      {nominee.avatarUrl ? (
        <img
          src={nominee.osuUserId ? avatarImageSrc(nominee.avatarUrl, nominee.osuUserId) : nominee.avatarUrl}
          alt=""
          className="h-6 w-6 shrink-0 rounded-full object-cover"
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-osu-b3/70">
          <CountryFlag code={nominee.countryCode ?? ""} size="xs" decorative />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[11px] font-semibold text-osu-c1/85">{nominee.username}</span>
          {nominee.countryCode && <CountryFlag code={nominee.countryCode} size="xs" />}
        </span>
        {nominee.banned && nominee.proofUrl && (
          <a
            href={nominee.proofUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-[0.1em] text-osu-f1/50 transition-colors hover:text-osu-pink"
          >
            banned · proof
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </span>
      {/* Armed, the row asks in place: the vote arrows stand down and the two
          answers take their spot, so nothing jumps and there is no dialog. */}
      {moderation?.armed ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={moderation.busy}
            onClick={moderation.onRemove}
            className="cursor-pointer rounded bg-osu-red px-1.5 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-osu-red-light disabled:opacity-50"
          >
            {moderation.busy ? "..." : "remove"}
          </button>
          <button
            type="button"
            disabled={moderation.busy}
            onClick={moderation.onCancel}
            className="cursor-pointer text-[10px] text-osu-f1 transition-colors hover:text-white disabled:opacity-50"
          >
            no
          </button>
        </span>
      ) : (
      <span className="flex shrink-0 items-center gap-0.5">
        {moderation && (
          <button
            type="button"
            onClick={moderation.onArm}
            aria-label={`Remove ${nominee.username} from the poll`}
            title={`Remove ${nominee.username} from the poll`}
            className="grid h-6 w-6 cursor-pointer place-items-center rounded p-0.5 text-osu-f1/40 transition-colors hover:bg-osu-red/20 hover:text-osu-red-light"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => cast(1)}
          aria-label={`Vote for ${nominee.username}`}
          aria-pressed={vote === 1}
          className={`grid h-6 w-6 place-items-center rounded transition-colors ${
            disabled ? "cursor-default text-osu-f1/20" : "cursor-pointer hover:text-osu-c1"
          } ${vote === 1 ? "text-osu-pink" : "text-osu-f1/40"}`}
        >
          <ChevronDown className="h-3.5 w-3.5 rotate-180" />
        </button>
        <span
          className={`w-5 text-center text-[11px] font-bold tabular-nums ${
            nominee.net > 0 ? "text-osu-c1/85" : nominee.net < 0 ? "text-osu-f1/40" : "text-osu-f1/70"
          }`}
        >
          {nominee.net}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => cast(-1)}
          aria-label={`Vote against ${nominee.username}`}
          aria-pressed={vote === -1}
          className={`grid h-6 w-6 place-items-center rounded transition-colors ${
            disabled ? "cursor-default text-osu-f1/20" : "cursor-pointer hover:text-osu-c1"
          } ${vote === -1 ? "text-osu-pink" : "text-osu-f1/40"}`}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </span>
      )}
    </motion.li>
  );
}

export function GoatPoll() {
  const auth = useAuth();
  const visible = useDocumentVisible();
  const wide = useRailWidth();
  const [board, setBoard] = useState<GoatPollBoard | null>(null);
  const [votes, setVotes] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  // True while the collapsible panel is mid-slide; see where it is used below.
  const [sliding, setSliding] = useState(true);
  // The row an admin has armed for removal, and the one being removed.
  const [armed, setArmed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [manualName, setManualName] = useState("");
  const [manualProof, setManualProof] = useState("");
  const [busy, setBusy] = useState(false);

  // An unreleased poll 404s on the public endpoint, so an admin reads it through
  // the bridge instead. Everyone else gets null and this renders nothing, which
  // is also what a retired poll does.
  const admin = canUseAdminFeatures(auth);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void (admin ? fetchGoatPollBoardAsAdmin() : fetchGoatPollBoard()).then((next) => {
        // receivedAt is stamped here rather than in either fetcher: the clock
        // that matters is the browser's at the moment the answer landed, and one
        // of those two paths comes back through a server fn.
        if (!cancelled && next) setBoard({ ...next, receivedAt: Date.now() });
      });
    };
    load();
    // A hidden tab still takes the one load above (so returning to it shows the
    // truth immediately) but stops paying for the interval.
    const timer = visible ? setInterval(load, REFRESH_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [visible, admin]);

  useEffect(() => {
    if (!auth.viewer) return;
    void fetchMyGoatPollVotes().then(setVotes).catch(() => {});
  }, [auth.viewer?.id]);

  /* How far this browser's clock is from the backend's, rounded to a second so
     the number is stable across refreshes and does not restart the pie's timer
     every 20s over a few milliseconds of jitter. */
  const clockOffset = useMemo(() => {
    if (!board) return 0;
    return Math.round((board.serverNow - board.receivedAt) / 1000) * 1000;
  }, [board]);

  /* Set by the pie the moment it ticks past the deadline, so the widget closes
     itself on the second rather than on the next board refresh. Keyed to the
     deadline so re-arming the poll (a new closesAt) re-opens it. */
  const [expiredAt, setExpiredAt] = useState<number | null>(null);
  const markExpired = useCallback(() => setExpiredAt(board?.closesAt ?? null), [board?.closesAt]);

  const closed =
    board != null && (expiredAt === board.closesAt || Date.now() + clockOffset >= board.closesAt);
  const canVote = Boolean(auth.viewer) && !closed;

  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof castGoatPollVote>>) => {
      if (result.nominees) setBoard((prev) => (prev ? { ...prev, nominees: result.nominees! } : prev));
      if (result.votes) setVotes(result.votes);
      setMessage(result.ok ? null : STATUS_MESSAGES[result.status] ?? null);
    },
    [],
  );

  const handleVote = useCallback(
    (nomineeId: string, next: number) => {
      if (!canVote) return;
      const previous = votes[nomineeId] ?? 0;
      // Optimistic: the arrow and the number move under the cursor, then the
      // server's tally replaces both. A refusal snaps back with the real board.
      setVotes((prev) => ({ ...prev, [nomineeId]: next }));
      setBoard((prev) =>
        prev
          ? {
              ...prev,
              nominees: prev.nominees.map((nominee) =>
                nominee.id === nomineeId ? { ...nominee, net: nominee.net - previous + next } : nominee,
              ),
            }
          : prev,
      );
      void castGoatPollVote({ data: { nomineeId, value: next } }).then(applyResult).catch(() => {});
    },
    [canVote, votes, applyResult],
  );

  const handleNominate = useCallback(
    async (input: { osuUserId?: number | null; username: string; countryCode?: string | null; avatarUrl?: string | null; banned: boolean; proofUrl?: string | null }) => {
      if (!canVote || busy) return;
      setBusy(true);
      setMessage(null);
      try {
        applyResult(await nominateGoatPollPlayer({ data: input }));
      } catch {
        setMessage(STATUS_MESSAGES.unavailable ?? null);
      } finally {
        setBusy(false);
      }
    },
    [canVote, busy, applyResult],
  );

  /* Moderation is true-admin only — `admin` above is the wider dev-access flag
     that decides who can *see* an unreleased poll, and deleting other people's
     nominations is a narrower thing than that. Two clicks on the row: the first
     arms it, the second does it. */
  const moderationFor = useCallback(
    (nominee: GoatPollNominee) => ({
      armed: armed === nominee.id,
      busy: removing === nominee.id,
      onArm: () => { setArmed(nominee.id); setMessage(null); },
      onCancel: () => setArmed(null),
      onRemove: () => {
        setRemoving(nominee.id);
        void removeGoatPollNominee({ data: { nomineeId: nominee.id } })
          .then((result) => {
            if (result.nominees) setBoard((prev) => (prev ? { ...prev, nominees: result.nominees! } : prev));
            if (!result.ok) setMessage("Couldn't remove that nominee.");
          })
          .catch(() => setMessage("Couldn't remove that nominee."))
          .finally(() => { setRemoving(null); setArmed(null); });
      },
    }),
    [armed, removing],
  );

  const nominees = useMemo(() => board?.nominees ?? [], [board]);

  if (!board) return null;

  const open = wide || expanded;
  const shown = showAll ? nominees : nominees.slice(0, VISIBLE_ROWS);
  const animatedRows = shown.length <= ANIMATED_ROWS_MAX;
  // The deadline in the reader's own timezone, for anyone who wants to plan
  // around it rather than watch a countdown. Same instant everywhere.
  const endsLabel = new Date(board.closesAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const heading = (
    <>
      <PollPie opensAt={board.opensAt} closesAt={board.closesAt} offset={clockOffset} onExpire={markExpired} />
      {/* Past the deadline there is nothing left to choose, and the board below
          has stopped being a ballot and become the answer. */}
      <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-osu-c1/85">
        {closed ? "The new GOAT" : "Choose a new GOAT"}
      </span>
    </>
  );

  return (
    <section
      className={`mb-6 border-t border-osu-b3/30 pt-2.5 ${RAIL_LAYOUT}`}
      aria-label="Community vote for a new GOAT"
    >
      {wide ? (
        <div className="flex items-center gap-2" title={`Ends ${endsLabel}`}>
          {heading}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex w-full cursor-pointer items-center gap-2 text-left"
          title={`Ends ${endsLabel}`}
        >
          {heading}
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-osu-f1/50 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      )}

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={wide ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            onAnimationStart={() => setSliding(true)}
            onAnimationComplete={() => setSliding(false)}
            /* overflow-hidden is what keeps the panel's contents inside the
               height animation, but it also crops the search box's dropdown to
               the panel — so it is only on while the panel is actually moving.
               In the rail there is no open/close animation at all. */
            className={wide || !sliding ? undefined : "overflow-hidden"}
          >
            <p className="mt-2 text-[10px] leading-snug text-osu-f1/80">
              {closed
                ? "Voting's closed. Thanks for the picks."
                : "Vote for as many players as you want. Whoever finishes first will get added to the GOAT tier."}
            </p>

            {!closed && (
              <div className="mt-2.5">
                {auth.viewer ? (
                  <>
                    <SearchInput
                      onSearch={(q) => searchPlayers(q)}
                      onSelect={(user) =>
                        void handleNominate({
                          osuUserId: user.id,
                          username: user.username,
                          countryCode: user.country_code,
                          avatarUrl: user.avatar_url,
                          banned: false,
                        })
                      }
                      // Someone already on the roster shows up greyed with the
                      // reason on the row, so the refusal is visible before the
                      // click rather than as a message after it. The server fn
                      // still checks: this is the explanation, not the gate.
                      disabledIds={HONORARY_IDS}
                      disabledNote="already a GOAT"
                      placeholder="nominate a player..."
                      className="w-full"
                    />
                    <button
                      type="button"
                      onClick={() => setManualOpen((value) => !value)}
                      className="mt-1.5 flex cursor-pointer items-center gap-1 text-[10px] text-osu-f1/60 transition-colors hover:text-osu-c1"
                      aria-expanded={manualOpen}
                    >
                      <TriangleAlert className="h-2.5 w-2.5" />
                      for banned or deleted
                    </button>
                    <AnimatePresence initial={false}>
                      {manualOpen && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.18 }}
                          className="overflow-hidden"
                        >
                          <div className="mt-2 flex flex-col gap-1.5">
                            <input
                              value={manualName}
                              onChange={(event) => setManualName(event.target.value)}
                              placeholder="username"
                              className="w-full rounded-md border border-osu-b3/40 bg-osu-b4/60 px-2.5 py-1.5 text-[12px] text-osu-c1 placeholder:text-osu-f1 focus:border-osu-h1/40 focus:outline-none"
                            />
                            <input
                              value={manualProof}
                              onChange={(event) => setManualProof(event.target.value)}
                              placeholder={PROOF_HINT}
                              className="w-full rounded-md border border-osu-b3/40 bg-osu-b4/60 px-2.5 py-1.5 text-[12px] text-osu-c1 placeholder:text-osu-f1 focus:border-osu-h1/40 focus:outline-none"
                            />
                            <button
                              type="button"
                              disabled={busy || manualName.trim().length < 2 || manualProof.trim().length === 0}
                              onClick={() => {
                                void handleNominate({
                                  username: manualName.trim(),
                                  banned: true,
                                  proofUrl: manualProof.trim(),
                                }).then(() => {
                                  setManualName("");
                                  setManualProof("");
                                });
                              }}
                              className="cursor-pointer self-start rounded-full bg-osu-pink/90 px-3 py-1 text-[11px] font-bold text-white transition hover:brightness-110 disabled:cursor-default disabled:opacity-40"
                            >
                              Nominate
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </>
                ) : (
                  <a
                    href={`/api/auth/osu?next=${encodeURIComponent("/packs")}`}
                    className="text-[11px] font-semibold text-osu-pink transition-colors hover:text-osu-pink-light"
                  >
                    Sign in to vote →
                  </a>
                )}
              </div>
            )}

            {message && <div className="mt-2 text-[10px] font-semibold text-osu-pink-light">{message}</div>}

            {nominees.length > 0 && (
              <>
                <motion.ul
                  layout={animatedRows}
                  className={`mt-2.5 border-t border-osu-b3/25 pt-1 ${
                    showAll ? `${EXPANDED_HEIGHT} overflow-y-auto overscroll-contain pr-1` : ""
                  }`}
                >
                  {shown.map((nominee) => (
                    <NomineeRow
                      key={nominee.id}
                      nominee={nominee}
                      vote={votes[nominee.id] ?? 0}
                      disabled={!canVote}
                      animated={animatedRows}
                      moderation={auth.isAdmin ? moderationFor(nominee) : undefined}
                      onVote={handleVote}
                    />
                  ))}
                </motion.ul>
                {nominees.length > VISIBLE_ROWS && (
                  <button
                    type="button"
                    onClick={() => setShowAll((value) => !value)}
                    className="mt-1 cursor-pointer text-[10px] text-osu-f1/60 transition-colors hover:text-osu-c1"
                  >
                    {showAll ? "show fewer" : "show all"}
                  </button>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
