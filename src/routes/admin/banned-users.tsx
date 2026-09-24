import { Link, createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Film, RefreshCw, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { CountryFlag } from "../../components/ui/CountryFlag";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { GradeImg } from "../../components/ui/GradeImg";
import { Skeleton } from "../../components/ui/LoadingSkeleton";
import { ModBadge } from "../../components/ui/ModBadge";
import { Pagination } from "../../components/ui/Pagination";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import {
  clearBannedUserDisplayName,
  getRestrictedPpPlays,
  listBannedUsers,
  markBannedUsersReviewed,
  setRestrictedPpPlaysRemoved,
  type BannedUser,
  type BannedUsersFilter,
  type RestrictedPpAdminPlay,
  type RestrictedPpAdminView,
  type RestrictedPpRemovalScope,
} from "../../lib/banned-users";
import { publishBannedUsersAlert } from "../../lib/banned-users-alert";
import { formatAccuracy, formatNumber, formatTimeAgo } from "../../lib/format";
import {
  previewLiveBackendUserWipe,
  setLiveBackendUserActive,
  wipeLiveBackendUserData,
  type LiveBackendUserWipePreview,
} from "../../lib/live-backend";

/* Accounts osu! stopped serving: restricted (osu! said so when they signed in)
 * or missing (osu! 404s the id, which is also what a deleted account looks
 * like). The backend only ever deactivates them. Their profile still loads,
 * frozen, and a restricted player can keep adding plays through Companella.
 *
 * Removing someone's content is decided here, one account at a time, through
 * the same preview and purge as the Monitoring page's wipe card. That purge
 * still refuses accounts with login-owned data (goals, packs, skins, Companella
 * imports and the rest), because those are the player's own, not tracking.
 *
 * While osu! has them gone, their Companella imports on ranked maps price into
 * a simulated pp that ranks like anyone's. The Plays panel is where a play
 * leaves it: removal is the ordinary review hold, so Restore undoes it.
 *
 * Rows open one at a time; opening one loads its removal preview and plays.
 */

export const Route = createFileRoute("/admin/banned-users")({
  // The tab and page live in the URL, so coming back from a profile lands on the same list.
  validateSearch: (search: Record<string, unknown>): { filter?: BannedUsersFilter; page?: number } => {
    const filter = search.filter === "restricted" || search.filter === "all" ? search.filter : undefined;
    const page = Number(search.page);
    return { filter, page: Number.isInteger(page) && page > 1 ? page : undefined };
  },
  head: () => ({
    meta: [
      { title: "Banned users - admin" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  beforeLoad: ({ context }) => {
    if (!canUseAdminFeatures(context.auth)) {
      throw notFound();
    }
    return undefined as never;
  },
  component: BannedUsersAdminPage,
});

const PAGE_SIZE = 50;
const PLAYS_PAGE_SIZE = 10;
// Clears the fixed site nav when an opened row is scrolled back into view.
const NAV_CLEARANCE = 72;

const FILTERS: { value: BannedUsersFilter; label: string }[] = [
  { value: "new", label: "New" },
  { value: "restricted", label: "Restricted" },
  { value: "all", label: "All" },
];

type PlaysFilter = "all" | "counted" | "removed" | "flagged";

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] sm:py-1 sm:text-[11px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";

const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;

const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;

// Icon-only on phones, where a row has no room for two labelled buttons beside the chart.
const PLAY_BUTTON_CLASS = "h-8 w-8 px-0 sm:h-auto sm:w-auto sm:px-2.5";

/* Undefined while loading; "error" when the fetch failed. */
type Loadable<T> = T | "error" | undefined;

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function plural(count: number, noun: string): string {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/* The worker writes "<job>: osu! API 404 for /users/<id>/..."; the job name is
   the only part worth reading. */
function readableReason(reason: string | null): string | null {
  if (!reason) return null;
  const job = /^([a-z_]+): osu! API 404/.exec(reason);
  return job ? `404 during ${job[1].replace(/_/g, " ")}` : reason;
}

// Removing every play drops the simulated pp to nothing, so the panel stays reachable through the imports.
function hasPlays(entry: BannedUser): boolean {
  return entry.simulatedPp != null || entry.companellaPlays > 0;
}

function When({ iso, prefix }: { iso: string; prefix: string }) {
  return <span title={formatWhen(iso)}>{prefix} {formatTimeAgo(iso)}</span>;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-osu-f1">{children}</h3>;
}

function Retry({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-osu-red-light">
      <span>{text}</span>
      <button onClick={onRetry} className={ACTION_CLASS}>Retry</button>
    </div>
  );
}

function BannedUserRow({
  entry,
  open,
  busy,
  preview,
  plays,
  onToggle,
  onSeen,
  onReactivate,
  onClearName,
  onWipe,
  onChangePlays,
  onRetry,
}: {
  entry: BannedUser;
  open: boolean;
  busy: boolean;
  preview: Loadable<LiveBackendUserWipePreview>;
  /* Null when nothing is priced. */
  plays: Loadable<RestrictedPpAdminView | null>;
  onToggle: () => void;
  onSeen: () => void;
  onReactivate: () => void;
  onClearName: () => void;
  onWipe: () => void;
  onChangePlays: (scope: RestrictedPpRemovalScope, restore: boolean, play?: RestrictedPpAdminPlay) => void;
  onRetry: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const isNew = entry.reviewedAt == null;
  const reason = readableReason(entry.reason);

  /* Opening a row closes the one above it, which can pull this one up past
     the top of the screen. Bring its header back into view. */
  useLayoutEffect(() => {
    if (!open || !rowRef.current) return;
    const top = rowRef.current.getBoundingClientRect().top;
    if (top < NAV_CLEARANCE) window.scrollBy({ top: top - NAV_CLEARANCE });
  }, [open]);

  return (
    <div ref={rowRef} className={open ? "bg-osu-b4/25" : undefined}>
      <div
        onClick={onToggle}
        className={`flex cursor-pointer items-start gap-3 px-3 py-3 transition-colors duration-[120ms] sm:items-center ${open ? "" : "hover:bg-osu-b4/20"}`}
      >
        <div className="relative flex-shrink-0">
          {entry.avatarUrl ? (
            <img src={entry.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
          ) : (
            <span className="block h-9 w-9 rounded-full bg-osu-b4" />
          )}
          {isNew ? (
            <span className="absolute -left-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-osu-b5 bg-osu-pink" title="New" />
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link
              to="/player/$username"
              // A first-seen row only knows "User <id>"; the id resolves where that name would not.
              params={{ username: entry.hasProfile ? entry.username : String(entry.userId) }}
              onClick={(event) => event.stopPropagation()}
              className="min-w-0 truncate text-[14px] font-semibold text-white hover:text-osu-pink-light"
            >
              {entry.username}
            </Link>
            {entry.countryCode ? <CountryFlag code={entry.countryCode} size="xs" decorative /> : null}
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                entry.status === "restricted" ? "bg-osu-red/15 text-osu-red-light" : "bg-osu-b4/80 text-osu-f1"
              }`}
            >
              {entry.status}
            </span>
            {entry.siteLastSeenAt ? (
              <span
                className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300"
                title={`Signed in on Mania Tracker, last ${formatTimeAgo(entry.siteLastSeenAt)}`}
              >
                site user
              </span>
            ) : null}
            {entry.displayName ? <span className="text-[12px] text-osu-l2">as {entry.displayName}</span> : null}
            <span className="font-mono text-[11px] text-osu-f1">#{entry.userId}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-osu-f1">
            {entry.pp != null ? <span className="tabular-nums text-osu-l2">{formatNumber(Math.round(entry.pp))}pp</span> : null}
            {entry.simulatedPp != null ? (
              <span className="tabular-nums text-osu-l2" title={`From ${plural(entry.simulatedPlays, "ranked play")}`}>
                {formatNumber(Math.round(entry.simulatedPp))}pp simulated
              </span>
            ) : null}
            {entry.companellaPlays > 0 ? <span className="text-osu-l2">{plural(entry.companellaPlays, "Companella play")}</span> : null}
            {entry.deactivatedAt ? <When iso={entry.deactivatedAt} prefix="deactivated" /> : null}
            {reason ? <span>{reason}</span> : null}
            {entry.lastLoginAt ? <When iso={entry.lastLoginAt} prefix="signed in" /> : null}
            {entry.siteLastSeenAt ? <When iso={entry.siteLastSeenAt} prefix="on site" /> : null}
            {!entry.hasProfile ? <span>no stored profile</span> : null}
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
          {isNew ? (
            <button disabled={busy} onClick={onSeen} className={ACTION_CLASS}>
              <Check size={13} />
              Seen
            </button>
          ) : null}
          <button
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? "Close" : "Open"}
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-osu-f1 transition-colors duration-[120ms] hover:bg-osu-b4/60 hover:text-white"
          >
            <ChevronDown size={16} className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {open ? (
        <div className="space-y-5 px-3 pb-4 sm:pl-[60px]">
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={busy} onClick={onReactivate} className={ACTION_CLASS}>Reactivate</button>
            {entry.displayName ? <button disabled={busy} onClick={onClearName} className={ACTION_CLASS}>Clear name</button> : null}
            <a href={`https://osu.ppy.sh/users/${entry.userId}`} target="_blank" rel="noreferrer" className={ACTION_CLASS}>
              osu! page
              <ExternalLink size={12} />
            </a>
          </div>

          {hasPlays(entry) ? (
            <RestrictedPpPanel userId={entry.userId} view={plays} busy={busy} onChange={onChangePlays} onRetry={onRetry} />
          ) : null}

          <RemovalPanel preview={preview} busy={busy} onWipe={onWipe} onRetry={onRetry} />
        </div>
      ) : null}
    </div>
  );
}

function RestrictedPpPanel({
  userId,
  view,
  busy,
  onChange,
  onRetry,
}: {
  userId: number;
  view: Loadable<RestrictedPpAdminView | null>;
  busy: boolean;
  onChange: (scope: RestrictedPpRemovalScope, restore: boolean, play?: RestrictedPpAdminPlay) => void;
  onRetry: () => void;
}) {
  const [show, setShow] = useState<PlaysFilter>("all");
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  if (view === undefined) {
    return (
      <section className="space-y-2">
        <SectionHeading>Simulated pp</SectionHeading>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex items-center gap-2.5 py-1">
            <Skeleton className="h-9 w-[52px] rounded" />
            <Skeleton className="h-[14px] w-[200px] rounded" />
          </div>
        ))}
      </section>
    );
  }
  if (view === "error") {
    return (
      <section className="space-y-2">
        <SectionHeading>Simulated pp</SectionHeading>
        <Retry text="Could not load the plays." onRetry={onRetry} />
      </section>
    );
  }
  if (!view || view.plays.length === 0) {
    return (
      <section className="space-y-2">
        <SectionHeading>Simulated pp</SectionHeading>
        <p className="text-[12px] text-osu-f1">No priced plays.</p>
      </section>
    );
  }

  const counted = view.plays.filter((play) => play.reviewState === "clear");
  const removed = view.plays.length - counted.length;
  const flaggedCounted = counted.filter((play) => play.rateSuspicious).length;
  const flagged = view.plays.filter((play) => play.rateSuspicious).length;
  const shown = view.plays.filter((play) => {
    if (show === "counted") return play.reviewState === "clear";
    if (show === "removed") return play.reviewState !== "clear";
    if (show === "flagged") return play.rateSuspicious;
    return true;
  });
  const pages = Math.max(1, Math.ceil(shown.length / PLAYS_PAGE_SIZE));
  // A removal can shrink the filtered list under the current page.
  const current = Math.min(page, pages - 1);
  const slice = shown.slice(current * PLAYS_PAGE_SIZE, (current + 1) * PLAYS_PAGE_SIZE);

  const goTo = (next: number) => {
    setPage(next);
    const top = listRef.current?.getBoundingClientRect().top;
    if (top != null && top < NAV_CLEARANCE) window.scrollBy({ top: top - NAV_CLEARANCE });
  };

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <SectionHeading>Simulated pp</SectionHeading>
          <span className="text-[12px] text-osu-l2">
            <span className="font-semibold tabular-nums text-white">{formatNumber(Math.round(view.pp))}pp</span>
            {" "}from {plural(view.rankedPlays, "ranked play")}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {flaggedCounted > 0 ? (
            <button disabled={busy} onClick={() => onChange("flagged", false)} className={DANGER_CLASS}>
              Remove {formatNumber(flaggedCounted)} flagged
            </button>
          ) : null}
          {counted.length > 0 ? (
            <button disabled={busy} onClick={() => onChange("all", false)} className={DANGER_CLASS}>Remove all</button>
          ) : null}
          {removed > 0 ? (
            <button disabled={busy} onClick={() => onChange("all", true)} className={ACTION_CLASS}>Restore all</button>
          ) : null}
        </div>
      </div>

      {removed > 0 || flagged > 0 ? (
        <SegmentedControl
          id={`plays-${userId}`}
          value={show}
          onChange={(value) => { setShow(value); setPage(0); }}
          options={[
            { value: "all", label: <>All <Count value={view.plays.length} /></> },
            { value: "counted", label: <>Counted <Count value={counted.length} /></> },
            ...(removed > 0 ? [{ value: "removed" as const, label: <>Removed <Count value={removed} /></> }] : []),
            ...(flagged > 0 ? [{ value: "flagged" as const, label: <>Flagged <Count value={flagged} /></> }] : []),
          ]}
        />
      ) : null}

      <div ref={listRef} className="divide-y divide-osu-b3/15">
        {slice.length === 0 ? <p className="py-3 text-[12px] text-osu-f1">No plays here.</p> : null}
        {slice.map((play) => (
          <PlayRow key={play.scoreId} play={play} busy={busy} onChange={onChange} />
        ))}
      </div>

      {pages > 1 ? (
        <div className="flex items-center justify-between gap-3 pt-1 text-[11px] text-osu-f1 sm:justify-start">
          <button disabled={current === 0} onClick={() => goTo(current - 1)} className={ACTION_CLASS} aria-label="Previous plays">
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {current * PLAYS_PAGE_SIZE + 1}-{Math.min((current + 1) * PLAYS_PAGE_SIZE, shown.length)} of {formatNumber(shown.length)}
          </span>
          <button disabled={current >= pages - 1} onClick={() => goTo(current + 1)} className={ACTION_CLASS} aria-label="Next plays">
            <ChevronRight size={14} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Count({ value }: { value: number }) {
  return <span className="ml-1 tabular-nums opacity-70">{formatNumber(value)}</span>;
}

function PlayRow({
  play,
  busy,
  onChange,
}: {
  play: RestrictedPpAdminPlay;
  busy: boolean;
  onChange: (scope: RestrictedPpRemovalScope, restore: boolean, play?: RestrictedPpAdminPlay) => void;
}) {
  const isRemoved = play.reviewState !== "clear";
  const title = play.title || `Beatmap ${play.beatmapId}`;
  const fullName = [play.artist, play.title].filter(Boolean).join(" - ") || title;
  return (
    <div className="flex items-center gap-2.5 py-2">
      <div className={`flex min-w-0 flex-1 items-center gap-2.5 ${isRemoved ? "opacity-50" : ""}`}>
        <div className="relative h-9 w-[52px] flex-shrink-0 overflow-hidden rounded bg-osu-b3/40">
          {play.beatmapsetId ? (
            <img
              src={`https://assets.ppy.sh/beatmaps/${play.beatmapsetId}/covers/list.jpg`}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : null}
          <span className="absolute left-0.5 top-0.5">
            <GradeImg grade={play.grade} size={16} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <a
            href={`https://osu.ppy.sh/beatmaps/${play.beatmapId}`}
            target="_blank"
            rel="noreferrer"
            title={play.version ? `${fullName} [${play.version}]` : fullName}
            className="block truncate text-[12px] font-semibold text-white hover:text-osu-pink-light"
          >
            {title}
          </a>
          {play.version ? <div className="truncate text-[11px] text-osu-f1">[{play.version}]</div> : null}
          <div className="mt-0.5 flex min-h-[13px] flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
            {play.mods.length ? (
              play.mods.map((mod) => <ModBadge key={mod} mod={mod} size={0.7} />)
            ) : (
              <span className="text-osu-f1">NM</span>
            )}
            {play.rateSuspicious ? <span className="text-osu-red-light">Speed unconfirmed</span> : null}
            {isRemoved ? <span className="text-amber-300">Removed</span> : null}
          </div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="text-[13px] font-bold tabular-nums text-white" title={`${play.pp.toFixed(2)}pp`}>
            {formatNumber(Math.round(play.pp))}pp
          </div>
          <div className="text-[11px] tabular-nums text-osu-f1">{formatAccuracy(play.accuracy)}</div>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        {isRemoved ? (
          // Held plays have no public replay; the spacer keeps the buttons in one column.
          <span aria-hidden className={`${ACTION_CLASS} ${PLAY_BUTTON_CLASS} invisible`}>
            <Film size={13} />
            <span className="hidden sm:inline">Replay</span>
          </span>
        ) : (
          <Link
            to="/replay"
            search={{ importId: play.scoreId }}
            target="_blank"
            rel="noreferrer"
            aria-label="Replay"
            className={`${ACTION_CLASS} ${PLAY_BUTTON_CLASS}`}
          >
            <Film size={13} />
            <span className="hidden sm:inline">Replay</span>
          </Link>
        )}
        <button
          disabled={busy}
          onClick={() => onChange("plays", isRemoved, play)}
          aria-label={isRemoved ? "Restore" : "Remove"}
          className={`${isRemoved ? ACTION_CLASS : DANGER_CLASS} ${PLAY_BUTTON_CLASS} sm:min-w-[76px]`}
        >
          {isRemoved ? <RotateCcw size={13} /> : <X size={13} />}
          <span className="hidden sm:inline">{isRemoved ? "Restore" : "Remove"}</span>
        </button>
      </div>
    </div>
  );
}

function RemovalPanel({
  preview,
  busy,
  onWipe,
  onRetry,
}: {
  preview: Loadable<LiveBackendUserWipePreview>;
  busy: boolean;
  onWipe: () => void;
  onRetry: () => void;
}) {
  return (
    <section className="space-y-2 border-t border-osu-b3/20 pt-4">
      <SectionHeading>Tracked content</SectionHeading>
      {preview === undefined ? (
        <Skeleton className="h-[16px] w-[260px] max-w-full rounded" />
      ) : preview === "error" ? (
        <Retry text="Could not load what removal would delete." onRetry={onRetry} />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:flex sm:flex-wrap sm:gap-x-5">
            <Stat label="tracker scores" value={preview.impact.trackerScores} />
            <Stat label="snipes" value={preview.impact.snipeEvents} />
            <Stat label="map rows" value={preview.impact.mapRows} />
            <Stat label="card holdings" value={preview.impact.packHoldings} />
            <Stat label="card owners" value={preview.impact.packOwners} />
          </dl>
          <div className="sm:ml-auto">
            {preview.canWipe ? (
              <button disabled={busy} onClick={onWipe} className={DANGER_CLASS}>Remove content</button>
            ) : (
              <span className="text-[12px] text-osu-red-light">
                Can't remove: {plural(preview.impact.accountDataRows, "login-owned row")}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="order-2 text-osu-f1">{label}</dt>
      <dd className={`order-1 font-semibold tabular-nums ${value > 0 ? "text-white" : "text-osu-f1"}`}>{formatNumber(value)}</dd>
    </div>
  );
}

function BannedUsersAdminPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const filter: BannedUsersFilter = search.filter ?? "new";
  const offset = ((search.page ?? 1) - 1) * PAGE_SIZE;
  const [entries, setEntries] = useState<BannedUser[] | null>(null);
  const [total, setTotal] = useState(0);
  // Each tab's last known count, so a tab switch never shows one list's count on another's tab.
  const [totals, setTotals] = useState<Partial<Record<BannedUsersFilter, number>>>({});
  const [unreviewed, setUnreviewed] = useState(0);
  const [busyId, setBusyId] = useState<number | "all" | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [previews, setPreviews] = useState<Record<number, Loadable<LiveBackendUserWipePreview>>>({});
  const [playViews, setPlayViews] = useState<Record<number, Loadable<RestrictedPpAdminView | null>>>({});
  const [wipeAsk, setWipeAsk] = useState<LiveBackendUserWipePreview | null>(null);
  const [playsAsk, setPlaysAsk] = useState<{ entry: BannedUser; scope: "flagged" | "all"; count: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const page = await listBannedUsers({ data: { filter, limit: PAGE_SIZE, offset } });
      if (request !== requestRef.current) return;
      setEntries(page.entries);
      setTotal(page.total);
      setTotals((current) => ({ ...current, [filter]: page.total }));
      setUnreviewed(page.unreviewed);
      publishBannedUsersAlert(page.unreviewed);
      setError(null);
    } catch {
      if (request !== requestRef.current) return;
      setEntries([]);
      setError("Could not load banned users.");
    }
  }, [filter, offset]);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (id: number | "all", run: () => Promise<unknown>, done?: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      await run();
      if (done) setMessage(done);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through.");
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const loadPreview = async (userId: number) => {
    try {
      const result = await previewLiveBackendUserWipe({ data: { query: `#${userId}` } });
      setPreviews((current) => ({ ...current, [userId]: result }));
    } catch {
      setPreviews((current) => ({ ...current, [userId]: "error" }));
    }
  };

  const loadPlays = async (userId: number) => {
    try {
      const view = await getRestrictedPpPlays({ data: { userId } });
      setPlayViews((current) => ({ ...current, [userId]: view }));
    } catch {
      setPlayViews((current) => ({ ...current, [userId]: "error" }));
    }
  };

  const loadDetails = (entry: BannedUser) => {
    // Stale numbers stay up while the fresh ones load; only failures are cleared first.
    setPreviews((current) => current[entry.userId] === "error" ? { ...current, [entry.userId]: undefined } : current);
    setPlayViews((current) => current[entry.userId] === "error" ? { ...current, [entry.userId]: undefined } : current);
    void loadPreview(entry.userId);
    if (hasPlays(entry)) void loadPlays(entry.userId);
  };

  const toggle = (entry: BannedUser) => {
    if (openId === entry.userId) {
      setOpenId(null);
      return;
    }
    setOpenId(entry.userId);
    loadDetails(entry);
  };

  const changeFilter = (next: BannedUsersFilter) => {
    void navigate({ search: { filter: next === "new" ? undefined : next, page: undefined }, replace: true });
    setOpenId(null);
  };

  const changePage = (page: number) => {
    void navigate({ search: (current) => ({ ...current, page: page > 0 ? page + 1 : undefined }), replace: true });
    setOpenId(null);
    window.scrollTo({ top: 0 });
  };

  const refresh = () => {
    void load();
    const open = entries?.find((entry) => entry.userId === openId);
    if (open) loadDetails(open);
  };

  const changePlays = (entry: BannedUser, scope: RestrictedPpRemovalScope, restore: boolean, play?: RestrictedPpAdminPlay) =>
    act(entry.userId, async () => {
      const changed = await setRestrictedPpPlaysRemoved({
        data: { userId: entry.userId, scope, scoreIds: play ? [play.scoreId] : undefined, restore },
      });
      if (!play) {
        setMessage(restore
          ? `Restored ${plural(changed, "play")} to ${entry.username}'s simulated pp.`
          : `Removed ${plural(changed, "play")} from ${entry.username}'s simulated pp.`);
      }
      await loadPlays(entry.userId);
    });

  const askChangePlays = (entry: BannedUser, scope: RestrictedPpRemovalScope, restore: boolean, play?: RestrictedPpAdminPlay) => {
    if (scope === "plays" || restore) {
      void changePlays(entry, scope, restore, play);
      return;
    }
    const view = playViews[entry.userId];
    const counted = (view && view !== "error" ? view.plays : []).filter((item) => item.reviewState === "clear");
    const count = scope === "flagged" ? counted.filter((item) => item.rateSuspicious).length : counted.length;
    setPlaysAsk({ entry, scope, count });
  };

  const filterOptions = FILTERS.map((option) => {
    const count = option.value === "new" ? unreviewed : totals[option.value];
    return {
      value: option.value,
      label: <>{option.label}{count ? <Count value={count} /> : null}</>,
    };
  });

  return (
    <div className="flex-1">
      <div className="bg-osu-d5 border-b border-osu-b3/40">
        <div className="max-w-[1000px] mx-auto px-4 sm:px-5 py-3 flex items-center gap-3">
          <div className="relative flex-shrink-0">
            <span className="block w-2.5 h-2.5 rounded-full bg-osu-red-light" />
            {entries === null || busyId ? (
              <span className="absolute inset-0 rounded-full bg-osu-red-light animate-ping opacity-75" />
            ) : null}
          </div>
          <h2 className="text-[13px] sm:text-[15px] font-medium text-osu-c2">Banned users</h2>
          <div className="ml-auto flex items-center gap-2">
            {unreviewed > 0 ? (
              <button
                disabled={busyId !== null}
                onClick={() => void act("all", async () => { publishBannedUsersAlert(await markBannedUsersReviewed({ data: { all: true } })); })}
                className={ACTION_CLASS}
              >
                <Check size={13} />
                Mark all seen
              </button>
            ) : null}
            <button onClick={refresh} className={`${ACTION_CLASS} h-8 w-8 px-0 sm:h-auto sm:w-auto sm:px-2.5`} aria-label="Refresh">
              <RefreshCw size={13} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1000px] mx-auto px-3 sm:px-5 py-4 sm:py-5 space-y-3">
          <SegmentedControl id="banned-users-filter" value={filter} options={filterOptions} onChange={changeFilter} />

          {error ? <Notice text={error} tone="error" onDismiss={() => setError(null)} /> : null}
          {message ? <Notice text={message} onDismiss={() => setMessage(null)} /> : null}

          {entries === null ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 divide-y divide-osu-b3/20">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="px-3 py-3 flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <Skeleton className="h-[15px] w-[220px] max-w-[60%] rounded" />
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 px-3 py-6 text-center text-[12px] text-osu-f1">
              {filter === "new" ? "Nobody new." : "Nobody here."}
            </div>
          ) : (
            <>
              <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 overflow-hidden divide-y divide-osu-b3/20">
                {entries.map((entry) => (
                  <BannedUserRow
                    key={entry.userId}
                    entry={entry}
                    open={openId === entry.userId}
                    busy={busyId === entry.userId || busyId === "all"}
                    preview={previews[entry.userId]}
                    plays={playViews[entry.userId]}
                    onToggle={() => toggle(entry)}
                    onSeen={() => void act(entry.userId, async () => {
                      publishBannedUsersAlert(await markBannedUsersReviewed({ data: { userIds: [entry.userId] } }));
                    })}
                    onReactivate={() => void act(
                      entry.userId,
                      async () => {
                        await setLiveBackendUserActive({ data: { userId: entry.userId, active: true } });
                        setOpenId(null);
                      },
                      `${entry.username} is active again and back in tracking. If osu! still 404s them, the next refresh deactivates them again.`,
                    )}
                    onClearName={() => void act(
                      entry.userId,
                      () => clearBannedUserDisplayName({ data: { userId: entry.userId } }),
                      `Cleared ${entry.username}'s display name. They can pick a new one when their week is up.`,
                    )}
                    onWipe={() => {
                      const preview = previews[entry.userId];
                      if (preview && preview !== "error") setWipeAsk(preview);
                    }}
                    onChangePlays={(scope, restore, play) => askChangePlays(entry, scope, restore, play)}
                    onRetry={() => loadDetails(entry)}
                  />
                ))}
              </div>

              <Pagination page={Math.floor(offset / PAGE_SIZE)} totalPages={Math.ceil(total / PAGE_SIZE)} onPageChange={changePage} />
            </>
          )}
        </div>
      </div>

      {wipeAsk ? (
        <ConfirmModal
          title={`Remove ${wipeAsk.username}'s content?`}
          body={`Deletes their tracked scores, snipes, map rows, profile, activity, skills and every card of them (#${wipeAsk.userId}). This cannot be undone, and they stay deactivated for good.`}
          confirmLabel="Remove"
          danger
          onConfirm={() => void act(
            wipeAsk.userId,
            async () => {
              await wipeLiveBackendUserData({
                data: { userId: wipeAsk.userId, expectedUsername: wipeAsk.username, confirmation: `WIPE ${wipeAsk.userId}` },
              });
              await loadPreview(wipeAsk.userId);
            },
            `Removed ${wipeAsk.username}'s content.`,
          )}
          onClose={() => setWipeAsk(null)}
        />
      ) : null}

      {playsAsk ? (
        <ConfirmModal
          title={playsAsk.scope === "flagged"
            ? `Remove ${plural(playsAsk.count, "flagged play")} from ${playsAsk.entry.username}'s simulated pp?`
            : `Remove all ${plural(playsAsk.count, "play")} from ${playsAsk.entry.username}'s simulated pp?`}
          body="They leave the pp, the rankings and the public replays. Restore puts them back."
          confirmLabel="Remove"
          danger
          onConfirm={() => void changePlays(playsAsk.entry, playsAsk.scope, false)}
          onClose={() => setPlaysAsk(null)}
        />
      ) : null}
    </div>
  );
}

function Notice({ text, tone, onDismiss }: { text: string; tone?: "error"; onDismiss: () => void }) {
  return (
    <div className={`flex items-start gap-2 text-[12px] ${tone === "error" ? "text-osu-red-light" : "text-osu-l2"}`}>
      <p className="min-w-0 flex-1 pt-0.5">{text}</p>
      <button onClick={onDismiss} aria-label="Dismiss" className="grid h-6 w-6 flex-shrink-0 cursor-pointer place-items-center rounded text-osu-f1 hover:bg-osu-b4/60 hover:text-white">
        <X size={13} />
      </button>
    </div>
  );
}
