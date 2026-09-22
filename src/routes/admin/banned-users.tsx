import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { CountryFlag } from "../../components/ui/CountryFlag";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { GradeImg } from "../../components/ui/GradeImg";
import { Skeleton } from "../../components/ui/LoadingSkeleton";
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
import { formatAccuracy, formatNumber } from "../../lib/format";
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
 */

export const Route = createFileRoute("/admin/banned-users")({
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

const FILTERS: { value: BannedUsersFilter; label: string }[] = [
  { value: "new", label: "New" },
  { value: "restricted", label: "Restricted" },
  { value: "all", label: "All" },
];

const ACTION_CLASS =
  "px-2.5 py-1 rounded-md bg-osu-b4/60 border border-osu-b3/30 text-[11px] text-osu-l2 hover:bg-osu-b3/60 hover:text-white transition-colors duration-[120ms] disabled:opacity-50 cursor-pointer";

const DANGER_CLASS =
  "px-2.5 py-1 rounded-md border border-osu-red/40 bg-osu-red/10 text-[11px] text-osu-red-light hover:bg-osu-red/20 transition-colors duration-[120ms] disabled:opacity-50 cursor-pointer";

function chipClass(active: boolean): string {
  return `px-2.5 py-1 rounded-md border text-[12px] transition-colors duration-[120ms] cursor-pointer ${
    active
      ? "border-osu-pink/50 bg-osu-pink/15 text-osu-pink-light"
      : "border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white"
  }`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function plural(count: number, noun: string): string {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function playChartText(play: RestrictedPpAdminPlay): string {
  const name = [play.artist, play.title].filter(Boolean).join(" - ") || `Beatmap ${play.beatmapId}`;
  return play.version ? `${name} [${play.version}]` : name;
}

/* The worker writes "<job>: osu! API 404 for /users/<id>/..."; the job name is
   the only part worth reading. */
function readableReason(reason: string | null): string | null {
  if (!reason) return null;
  const job = /^([a-z_]+): osu! API 404/.exec(reason);
  return job ? `404 during ${job[1].replace(/_/g, " ")}` : reason;
}

function BannedUserRow({
  entry,
  busy,
  preview,
  plays,
  onPreview,
  onWipe,
  onReactivate,
  onSeen,
  onClearName,
  onTogglePlays,
  onChangePlays,
}: {
  entry: BannedUser;
  busy: boolean;
  preview: LiveBackendUserWipePreview | null;
  /* Undefined while the panel is closed; null when nothing is priced. */
  plays: RestrictedPpAdminView | null | undefined;
  onPreview: () => void;
  onWipe: () => void;
  onReactivate: () => void;
  onSeen: () => void;
  onClearName: () => void;
  onTogglePlays: () => void;
  onChangePlays: (scope: RestrictedPpRemovalScope, restore: boolean, play?: RestrictedPpAdminPlay) => void;
}) {
  const isNew = entry.reviewedAt == null;
  const reason = readableReason(entry.reason);
  // Removing every play drops the simulated pp to nothing, so the panel stays reachable through the imports.
  const hasPlays = entry.simulatedPp != null || entry.companellaPlays > 0;
  return (
    <div className="px-3 py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {entry.avatarUrl ? (
          <img src={entry.avatarUrl} alt="" className="h-9 w-9 flex-shrink-0 rounded-full object-cover" />
        ) : (
          <span className="h-9 w-9 flex-shrink-0 rounded-full bg-osu-b4" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {isNew ? <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-osu-pink" title="New" /> : null}
            <Link
              to="/player/$username"
              // A first-seen row only knows "User <id>"; the id resolves where that name would not.
              params={{ username: entry.hasProfile ? entry.username : String(entry.userId) }}
              className="truncate text-[14px] font-semibold text-white hover:text-osu-pink-light"
            >
              {entry.username}
            </Link>
            {entry.displayName ? <span className="text-[13px] text-osu-l2">as {entry.displayName}</span> : null}
            <span className="font-mono text-[11px] text-osu-f1">#{entry.userId}</span>
            {entry.countryCode ? <CountryFlag code={entry.countryCode} size="xs" decorative /> : null}
            <span className={entry.status === "restricted" ? "text-[11px] font-semibold text-osu-red-light" : "text-[11px] text-osu-f1"}>
              {entry.status === "restricted" ? "restricted" : "missing"}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-osu-f1">
            {entry.pp != null ? <span className="text-osu-l2">{formatNumber(Math.round(entry.pp))}pp</span> : null}
            {entry.deactivatedAt ? <span>deactivated {formatWhen(entry.deactivatedAt)}</span> : null}
            {reason ? <span>{reason}</span> : null}
            {entry.lastLoginAt ? <span>signed in {formatWhen(entry.lastLoginAt)}</span> : null}
            {entry.companellaPlays > 0 ? <span className="text-osu-l2">{formatNumber(entry.companellaPlays)} Companella plays</span> : null}
            {entry.simulatedPp != null ? (
              <span className="text-osu-l2">
                {formatNumber(Math.round(entry.simulatedPp))}pp simulated from {plural(entry.simulatedPlays, "ranked play")}
              </span>
            ) : null}
            {!entry.hasProfile ? <span>no stored profile</span> : null}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          {isNew ? <button disabled={busy} onClick={onSeen} className={ACTION_CLASS}>Seen</button> : null}
          {entry.displayName ? <button disabled={busy} onClick={onClearName} className={ACTION_CLASS}>Clear name</button> : null}
          {hasPlays ? (
            <button disabled={busy} onClick={onTogglePlays} className={ACTION_CLASS}>
              {plays === undefined ? "Plays" : "Hide plays"}
            </button>
          ) : null}
          <button disabled={busy} onClick={onReactivate} className={ACTION_CLASS}>Reactivate</button>
          <button disabled={busy} onClick={onPreview} className={DANGER_CLASS}>Preview removal</button>
        </div>
      </div>

      {preview ? (
        <div className="ml-12 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-osu-f1/85">
          <span>tracker: {formatNumber(preview.impact.trackerScores)}</span>
          <span>snipes: {formatNumber(preview.impact.snipeEvents)}</span>
          <span>map rows: {formatNumber(preview.impact.mapRows)}</span>
          <span>card holdings: {formatNumber(preview.impact.packHoldings)}</span>
          <span>card owners: {formatNumber(preview.impact.packOwners)}</span>
          {preview.canWipe ? (
            <button disabled={busy} onClick={onWipe} className={`${DANGER_CLASS} font-sans`}>
              Remove content
            </button>
          ) : (
            <span className="font-sans text-osu-red-light">
              Can't remove: {formatNumber(preview.impact.accountDataRows)} login-owned row{preview.impact.accountDataRows === 1 ? "" : "s"}
            </span>
          )}
        </div>
      ) : null}

      {plays !== undefined ? <RestrictedPpPanel view={plays} busy={busy} onChange={onChangePlays} /> : null}
    </div>
  );
}

function RestrictedPpPanel({
  view,
  busy,
  onChange,
}: {
  view: RestrictedPpAdminView | null;
  busy: boolean;
  onChange: (scope: RestrictedPpRemovalScope, restore: boolean, play?: RestrictedPpAdminPlay) => void;
}) {
  if (!view || view.plays.length === 0) {
    return <p className="ml-12 text-[11px] text-osu-f1">No priced plays.</p>;
  }
  const counted = view.plays.filter((play) => play.reviewState === "clear");
  const removed = view.plays.length - counted.length;
  const flagged = counted.filter((play) => play.rateSuspicious).length;
  return (
    <div className="ml-12 space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-osu-f1">
        <span>{formatNumber(counted.length)} counted</span>
        {removed > 0 ? <span>{formatNumber(removed)} removed</span> : null}
        {flagged > 0 ? <span className="text-osu-red-light">{formatNumber(flagged)} speed unconfirmed</span> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button disabled={busy || flagged === 0} onClick={() => onChange("flagged", false)} className={DANGER_CLASS}>Remove flagged</button>
          <button disabled={busy || counted.length === 0} onClick={() => onChange("all", false)} className={DANGER_CLASS}>Remove all</button>
          <button disabled={busy || removed === 0} onClick={() => onChange("all", true)} className={ACTION_CLASS}>Restore all</button>
        </div>
      </div>
      <div className="divide-y divide-osu-b3/15">
        {view.plays.map((play) => {
          const isRemoved = play.reviewState !== "clear";
          return (
            <div key={play.scoreId} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className={`min-w-0 flex-1 flex items-center gap-2.5 ${isRemoved ? "opacity-60" : ""}`}>
                <GradeImg grade={play.grade} size={22} className="flex-shrink-0" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="truncate text-[12px] text-osu-l2">{playChartText(play)}</div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-osu-f1">
                    <span className="rounded bg-osu-b4/80 px-1.5 py-0.5 font-semibold text-osu-l2">
                      {play.mods.length ? play.mods.join("") : "NM"}
                    </span>
                    <span className="text-white">{play.pp.toFixed(2)}pp</span>
                    <span>{formatAccuracy(play.accuracy)}</span>
                    {play.rateSuspicious ? <span className="text-osu-red-light">Speed unconfirmed</span> : null}
                    {isRemoved ? <span className="text-amber-300">Removed</span> : null}
                  </div>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {!isRemoved ? (
                  <Link to="/replay" search={{ importId: play.scoreId }} target="_blank" rel="noreferrer" className={ACTION_CLASS}>
                    Replay
                  </Link>
                ) : null}
                <button
                  disabled={busy}
                  onClick={() => onChange("plays", isRemoved, play)}
                  className={isRemoved ? ACTION_CLASS : DANGER_CLASS}
                >
                  {isRemoved ? "Restore" : "Remove"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BannedUsersAdminPage() {
  const [filter, setFilter] = useState<BannedUsersFilter>("new");
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<BannedUser[] | null>(null);
  const [total, setTotal] = useState(0);
  const [unreviewed, setUnreviewed] = useState(0);
  const [busyId, setBusyId] = useState<number | "all" | null>(null);
  const [previews, setPreviews] = useState<Record<number, LiveBackendUserWipePreview>>({});
  const [wipeAsk, setWipeAsk] = useState<LiveBackendUserWipePreview | null>(null);
  // Present while a row's Plays panel is open.
  const [playViews, setPlayViews] = useState<Record<number, RestrictedPpAdminView | null>>({});
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
  useEffect(() => { setOffset(0); }, [filter]);

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

  const preview = (entry: BannedUser) => act(entry.userId, async () => {
    const result = await previewLiveBackendUserWipe({ data: { query: `#${entry.userId}` } });
    setPreviews((current) => ({ ...current, [entry.userId]: result }));
  });

  const loadPlays = async (userId: number) => {
    const view = await getRestrictedPpPlays({ data: { userId } });
    setPlayViews((current) => ({ ...current, [userId]: view }));
  };

  const togglePlays = (entry: BannedUser) => {
    if (entry.userId in playViews) {
      setPlayViews((current) => {
        const next = { ...current };
        delete next[entry.userId];
        return next;
      });
      return;
    }
    void act(entry.userId, () => loadPlays(entry.userId));
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
    const counted = (playViews[entry.userId]?.plays ?? []).filter((item) => item.reviewState === "clear");
    const count = scope === "flagged" ? counted.filter((item) => item.rateSuspicious).length : counted.length;
    setPlaysAsk({ entry, scope, count });
  };

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

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
          <div className="ml-auto flex items-center gap-3 text-[11px] text-osu-f1">
            <span>{unreviewed} new</span>
            <button
              disabled={unreviewed === 0 || busyId !== null}
              onClick={() => void act("all", async () => { publishBannedUsersAlert(await markBannedUsersReviewed({ data: { all: true } })); })}
              className={ACTION_CLASS}
            >
              Mark all seen
            </button>
            <button onClick={() => void load()} className={ACTION_CLASS}>Refresh</button>
          </div>
        </div>
      </div>

      <div className="bg-osu-b5 min-h-[calc(100vh-60px)]">
        <div className="max-w-[1000px] mx-auto px-4 sm:px-5 py-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((option) => (
              <button key={option.value} onClick={() => setFilter(option.value)} className={chipClass(filter === option.value)}>
                {option.label}
              </button>
            ))}
          </div>

          {error ? <p className="text-[12px] text-osu-red-light">{error}</p> : null}
          {message ? <p className="text-[12px] text-osu-l2">{message}</p> : null}

          {entries === null ? (
            <div className="rounded-md border border-osu-b3/20 bg-osu-b5/60 divide-y divide-osu-b3/20">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="px-3 py-3 flex items-center gap-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <Skeleton className="h-[15px] w-[220px] rounded" />
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
                    busy={busyId === entry.userId || busyId === "all"}
                    preview={previews[entry.userId] ?? null}
                    plays={playViews[entry.userId]}
                    onPreview={() => void preview(entry)}
                    onWipe={() => setWipeAsk(previews[entry.userId] ?? null)}
                    onReactivate={() => void act(
                      entry.userId,
                      () => setLiveBackendUserActive({ data: { userId: entry.userId, active: true } }),
                      `${entry.username} is active again and back in tracking. If osu! still 404s them, the next refresh deactivates them again.`,
                    )}
                    onClearName={() => void act(
                      entry.userId,
                      () => clearBannedUserDisplayName({ data: { userId: entry.userId } }),
                      `Cleared ${entry.username}'s display name. They can pick a new one when their week is up.`,
                    )}
                    onSeen={() => void act(entry.userId, async () => {
                      publishBannedUsersAlert(await markBannedUsersReviewed({ data: { userIds: [entry.userId] } }));
                    })}
                    onTogglePlays={() => togglePlays(entry)}
                    onChangePlays={(scope, restore, play) => askChangePlays(entry, scope, restore, play)}
                  />
                ))}
              </div>

              {total > PAGE_SIZE ? (
                <div className="flex items-center gap-3 text-[11px] text-osu-f1">
                  <span>{from}-{to} of {total}</span>
                  <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className={ACTION_CLASS}>
                    Previous
                  </button>
                  <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)} className={ACTION_CLASS}>
                    Next
                  </button>
                </div>
              ) : null}
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
              setPreviews((current) => {
                const next = { ...current };
                delete next[wipeAsk.userId];
                return next;
              });
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
