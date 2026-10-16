import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ConfirmModal } from "../../ui/ConfirmModal";
import { Skeleton } from "../../ui/LoadingSkeleton";
import { SearchInput } from "../../ui/SearchInput";
import { formatNumber, formatTimeAgo } from "../../../lib/format";
import { searchPlayers, searchPlayersOnOsu } from "../../../lib/player-search";
import {
  listOwnerTakedowns,
  previewOwnerTakedown,
  restoreOwnerTakedown,
  runOwnerTakedown,
  type OwnerTakedownPreview,
  type TakenDownUser,
} from "../../../lib/owner-takedown";

/* The Takedowns tab of /admin/players: a player asked for their data to come
 * down (lib/owner-takedown.ts). Their tracked history, every card of them,
 * their Companella imports, uploaded replays and our copies of their osu!
 * replays are deleted, their profile is a 404 everywhere, and nothing tracks
 * them again. Their account keeps working: sign-in, the packs they own, goals,
 * skins. Unlike the banned-account wipe it can be undone: Restore turns
 * tracking back on and the profile rebuilds from what osu! still serves.
 * Confirm the request came from the account's owner before running it. */

const BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] sm:py-1 sm:text-[11px] transition-colors duration-[120ms] disabled:opacity-50 disabled:cursor-default cursor-pointer";
const ACTION_CLASS = `${BUTTON_CLASS} border-osu-b3/30 bg-osu-b4/60 text-osu-l2 hover:bg-osu-b3/60 hover:text-white`;
const DANGER_CLASS = `${BUTTON_CLASS} border-osu-red/40 bg-osu-red/10 text-osu-red-light hover:bg-osu-red/20`;

type Ask =
  | { kind: "takedown"; preview: OwnerTakedownPreview }
  | { kind: "restore"; user: TakenDownUser };

function plural(count: number, noun: string): string {
  return `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

export function TakedownsPanel() {
  const [users, setUsers] = useState<TakenDownUser[] | null>(null);
  const [preview, setPreview] = useState<OwnerTakedownPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsers(await listOwnerTakedowns());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setUsers((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await action());
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const lookUp = (rawQuery: string) => {
    const query = rawQuery.trim();
    if (!query) return;
    void run(async () => {
      setPreview(null);
      setPreview(await previewOwnerTakedown({ data: { query } }));
      return "";
    });
  };

  return (
    <div className="space-y-5">
      <SearchInput
        className="w-full"
        placeholder="find player..."
        onSearch={(q) => searchPlayers(q)}
        onSearchOsu={searchPlayersOnOsu}
        onSelect={(user) => lookUp(`#${user.id}`)}
        onSubmit={lookUp}
      />

      {error ? <Notice text={error} tone="error" onDismiss={() => setError(null)} /> : null}
      {message ? <Notice text={message} onDismiss={() => setMessage(null)} /> : null}

      {preview ? (
        <section className="space-y-3 rounded-md border border-osu-b3/20 bg-osu-b4/30 p-3">
          <div className="flex flex-wrap items-center gap-3">
            {preview.avatarUrl ? (
              <img src={preview.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
            ) : (
              <span className="h-9 w-9 rounded-full bg-osu-b4" />
            )}
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-white">{preview.username}</div>
              <div className="text-[11px] text-osu-f1">
                #{preview.userId}
                {preview.countryCode ? ` · ${preview.countryCode}` : ""}
                {preview.takenDown ? " · taken down" : preview.wiped ? " · wiped" : preview.active ? " · active" : " · inactive"}
              </div>
            </div>
            <div className="ml-auto">
              {preview.wiped ? (
                <span className="text-[12px] text-osu-f1">Already purged by the banned-account wipe.</span>
              ) : (
                <button disabled={busy} onClick={() => setAsk({ kind: "takedown", preview })} className={DANGER_CLASS}>
                  {preview.takenDown ? "Run again" : "Take down"}
                </button>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:flex sm:flex-wrap sm:gap-x-5">
            <Stat label="tracker scores" value={preview.impact.trackerScores} />
            <Stat label="activity plays" value={preview.impact.activityPlays} />
            <Stat label="top plays" value={preview.impact.topScores} />
            <Stat label="card holdings" value={preview.impact.packHoldings} />
            <Stat label="card owners" value={preview.impact.packOwners} />
            <Stat label="Companella imports" value={preview.impact.companellaImports} />
            <Stat label="uploaded replays" value={preview.impact.uploadedReplays} />
          </dl>
        </section>
      ) : null}

      <section className="space-y-2">
        <div className="flex items-center gap-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-osu-f1">Taken down</h3>
          <button onClick={() => void refresh()} className={`${ACTION_CLASS} ml-auto`} aria-label="Refresh">
            <RefreshCw size={13} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
        {users === null ? (
          <Skeleton className="h-[16px] w-[260px] max-w-full rounded" />
        ) : users.length === 0 ? (
          <div className="py-4 text-center text-[12px] text-osu-f1">No account is taken down.</div>
        ) : (
          <div className="divide-y divide-white/[0.07]">
            {users.map((user) => (
              <div key={user.userId} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-white">{user.username}</div>
                  <div className="text-[11px] text-osu-f1">
                    #{user.userId} · <span title={user.takenDownAt}>{formatTimeAgo(user.takenDownAt)}</span>
                    {user.companellaBlocked ? " · Companella blocked by the takedown" : ""}
                  </div>
                </div>
                <button disabled={busy} onClick={() => setAsk({ kind: "restore", user })} className={`${ACTION_CLASS} ml-auto`}>
                  Restore
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {ask?.kind === "takedown" ? (
        <ConfirmModal
          title={`Take down ${ask.preview.username}?`}
          body={`Deletes their tracked scores, activity, skills, every card of them (${plural(ask.preview.impact.packOwners, "collector")}), ${plural(ask.preview.impact.companellaImports, "Companella import")}, ${plural(ask.preview.impact.uploadedReplays, "uploaded replay")} and our copies of their osu! replays (#${ask.preview.userId}). Their profile becomes a 404 and nothing tracks them again. Their account keeps working. Restore turns tracking back on, but what is deleted stays deleted.`}
          confirmLabel="Take down"
          danger
          onConfirm={() => {
            const target = ask.preview;
            setAsk(null);
            void run(async () => {
              const result = await runOwnerTakedown({
                data: { userId: target.userId, expectedUsername: target.username, confirmation: `TAKEDOWN ${target.userId}` },
              });
              setPreview(await previewOwnerTakedown({ data: { query: `#${target.userId}` } }).catch(() => null));
              const failures = [
                result.uploadsFailed ? plural(result.uploadsFailed, "upload") : "",
                result.replayScoresFailed ? plural(result.replayScoresFailed, "replay cache") : "",
              ].filter(Boolean);
              return `Took down ${result.username}: ${plural(result.companellaImportsDeleted, "import")}, ${plural(result.uploadsDeleted, "upload")} and ${plural(result.replayObjectsDeleted, "replay object")} deleted.`
                + (failures.length ? ` Could not delete ${failures.join(" and ")}; run it again.` : "");
            });
          }}
          onClose={() => setAsk(null)}
        />
      ) : ask?.kind === "restore" ? (
        <ConfirmModal
          title={`Restore ${ask.user.username}?`}
          body="Their profile shows again and tracking starts over from what osu! still serves. Nothing the takedown deleted comes back."
          confirmLabel="Restore"
          onConfirm={() => {
            const target = ask.user;
            setAsk(null);
            void run(async () => {
              const result = await restoreOwnerTakedown({ data: { userId: target.userId, confirmation: `RESTORE ${target.userId}` } });
              return `Restored ${result.username || target.username}.`;
            });
          }}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </div>
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

function Notice({ text, tone, onDismiss }: { text: string; tone?: "error"; onDismiss: () => void }) {
  if (!text) return null;
  return (
    <div className={`flex items-start gap-2 text-[12px] ${tone === "error" ? "text-osu-red-light" : "text-osu-l2"}`}>
      <p className="min-w-0 flex-1 pt-0.5">{text}</p>
      <button onClick={onDismiss} aria-label="Dismiss" className="grid h-6 w-6 flex-shrink-0 cursor-pointer place-items-center rounded text-osu-f1 hover:bg-osu-b4/60 hover:text-white">
        <X size={13} />
      </button>
    </div>
  );
}
