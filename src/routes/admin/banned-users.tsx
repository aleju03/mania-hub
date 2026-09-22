import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { CountryFlag } from "../../components/ui/CountryFlag";
import { ConfirmModal } from "../../components/ui/ConfirmModal";
import { Skeleton } from "../../components/ui/LoadingSkeleton";
import { canUseAdminFeatures } from "../../lib/auth-shared";
import {
  clearBannedUserDisplayName,
  listBannedUsers,
  markBannedUsersReviewed,
  type BannedUser,
  type BannedUsersFilter,
} from "../../lib/banned-users";
import { publishBannedUsersAlert } from "../../lib/banned-users-alert";
import { formatNumber } from "../../lib/format";
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
  onPreview,
  onWipe,
  onReactivate,
  onSeen,
  onClearName,
}: {
  entry: BannedUser;
  busy: boolean;
  preview: LiveBackendUserWipePreview | null;
  onPreview: () => void;
  onWipe: () => void;
  onReactivate: () => void;
  onSeen: () => void;
  onClearName: () => void;
}) {
  const isNew = entry.reviewedAt == null;
  const reason = readableReason(entry.reason);
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
            {!entry.hasProfile ? <span>no stored profile</span> : null}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          {isNew ? <button disabled={busy} onClick={onSeen} className={ACTION_CLASS}>Seen</button> : null}
          {entry.displayName ? <button disabled={busy} onClick={onClearName} className={ACTION_CLASS}>Clear name</button> : null}
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
    </div>
  );
}
